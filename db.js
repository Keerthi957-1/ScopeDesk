const path = require('path');

// Database: SQLite via Node's built-in `node:sqlite` (Node 22.13+). No external DB needed.
// Where the data lives. On Railway the container's own disk is wiped on EVERY deploy and restart, so the database must be on a
// Railway Volume. Attaching a volume is enough: Railway tells the app where it is mounted (RAILWAY_VOLUME_MOUNT_PATH).
// Or point DB_PATH at any file you like.
const hosted = process.env.NODE_ENV === 'production' || !!(process.env.RAILWAY_ENVIRONMENT_NAME || process.env.RAILWAY_ENVIRONMENT || process.env.RAILWAY_PROJECT_ID);
const dataDir = process.env.RAILWAY_VOLUME_MOUNT_PATH || __dirname;
const dbPath = process.env.DB_PATH || path.join(dataDir, 'scopedesk.db');
if (hosted && !process.env.DB_PATH && !process.env.RAILWAY_VOLUME_MOUNT_PATH) {
  console.warn('[DB] WARNING: no persistent storage. All accounts and tasks will be LOST on every redeploy or restart. In Railway: add a Volume to this service (mount path e.g. /data); the app will use it automatically.');
}
try { require('fs').mkdirSync(path.dirname(dbPath), { recursive: true }); } catch (_) { /* opening the database will report a real problem */ }

let sqliteDb;
try {
  const { DatabaseSync } = require('node:sqlite');
  sqliteDb = new DatabaseSync(dbPath);
  console.log(`[DB] Connected to SQLite database: ${dbPath}`);
} catch (err) {
  console.error('[DB] Could not open SQLite. You need Node.js 22.13 or newer.', err.message);
  process.exit(1);
}

function initSqliteTables() {
  sqliteDb.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL UNIQUE COLLATE NOCASE,
      email TEXT NOT NULL UNIQUE COLLATE NOCASE,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('client', 'vendor')),
      organization TEXT,
      is_active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS vendors (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      client_id INTEGER,
      vendor_user_id INTEGER,
      name TEXT NOT NULL,
      email TEXT NOT NULL,
      organization TEXT NOT NULL,
      specialization TEXT DEFAULT 'General IT & System Support',
      status TEXT NOT NULL DEFAULT 'Active',
      rating REAL DEFAULT 4.9,
      tasks_completed INTEGER DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      client_id INTEGER NOT NULL,
      vendor_id INTEGER,
      vendor_name TEXT,
      title TEXT NOT NULL,
      description TEXT,
      target_process TEXT NOT NULL,
      target_window TEXT,
      duration_minutes INTEGER NOT NULL DEFAULT 30,
      token TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'active', 'completed', 'expired', 'terminated')),
      window_start TEXT NOT NULL,
      window_end TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS remote_sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id INTEGER NOT NULL,
      client_id INTEGER NOT NULL,
      vendor_id INTEGER,
      vendor_name TEXT,
      token TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'completed', 'terminated', 'expired')),
      started_at TEXT NOT NULL DEFAULT (datetime('now')),
      ended_at TEXT,
      end_reason TEXT
    );

    CREATE TABLE IF NOT EXISTS intrusion_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id INTEGER,
      task_id INTEGER NOT NULL,
      event_type TEXT NOT NULL,
      process_name TEXT,
      details TEXT,
      severity TEXT NOT NULL DEFAULT 'critical',
      action_taken TEXT NOT NULL DEFAULT 'alert_only',
      occurred_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- NEW: password recovery. Only a SHA-256 hash of the reset token is stored.
    CREATE TABLE IF NOT EXISTS password_resets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      token_hash TEXT NOT NULL UNIQUE,
      expires_at TEXT NOT NULL,
      used INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER,
      action TEXT NOT NULL,
      details TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- NEW: a client can end a vendor's access (per-client block) and report vendors
    CREATE TABLE IF NOT EXISTS client_vendor_blocks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      client_id INTEGER NOT NULL,
      vendor_user_id INTEGER NOT NULL,
      reason TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE (client_id, vendor_user_id)
    );

    CREATE TABLE IF NOT EXISTS vendor_reports (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      client_id INTEGER NOT NULL,
      vendor_user_id INTEGER NOT NULL,
      reason TEXT NOT NULL,
      details TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_tasks_client ON tasks (client_id);
    CREATE INDEX IF NOT EXISTS idx_sessions_task ON remote_sessions (task_id);
    CREATE INDEX IF NOT EXISTS idx_events_task ON intrusion_events (task_id);
  `);

  // Migration for databases created by earlier versions: which vendor ACCOUNT a task request was sent to
  const taskCols = sqliteDb.prepare('PRAGMA table_info(tasks)').all().map((c) => c.name);
  if (!taskCols.includes('assigned_vendor_user_id')) {
    sqliteDb.exec('ALTER TABLE tasks ADD COLUMN assigned_vendor_user_id INTEGER');
  }
  // Task type (e.g. "Billing"): the host agent looks it up in agent/policies.json to learn which apps and folders are allowed
  if (!taskCols.includes('task_type')) {
    sqliteDb.exec("ALTER TABLE tasks ADD COLUMN task_type TEXT NOT NULL DEFAULT ''");
  }
  // Custom scope chosen by the Client when creating the ticket (JSON arrays, '' = none). Added on top of the task type's policy.
  if (!taskCols.includes('allowed_paths')) sqliteDb.exec("ALTER TABLE tasks ADD COLUMN allowed_paths TEXT NOT NULL DEFAULT ''");
  if (!taskCols.includes('allowed_apps')) sqliteDb.exec("ALTER TABLE tasks ADD COLUMN allowed_apps TEXT NOT NULL DEFAULT ''");
  sqliteDb.exec('CREATE INDEX IF NOT EXISTS idx_tasks_assigned ON tasks (assigned_vendor_user_id)');

  // Seed demo users on a brand-new database only
  const userCount = sqliteDb.prepare('SELECT COUNT(*) as count FROM users').get().count;
  if (userCount === 0) {
    const bcrypt = require('bcryptjs');
    const defaultPasswordHash = bcrypt.hashSync('Password123!', 10);

    const insertUser = sqliteDb.prepare(`
      INSERT INTO users (username, email, password_hash, role, organization)
      VALUES (?, ?, ?, ?, ?)
    `);

    insertUser.run('office_admin', 'admin@mapleoffice.com', defaultPasswordHash, 'client', 'Maple & Co. Financial Office');
    insertUser.run('it_vendor', 'mayo@northstar-it.com', defaultPasswordHash, 'vendor', 'Northstar IT Solutions');
    insertUser.run('tech_alpha', 'thao@helpworks.io', defaultPasswordHash, 'vendor', 'HelpWorks Managed Services');
    insertUser.run('secure_net', 'theo@securenet.tech', defaultPasswordHash, 'vendor', 'SecureNet Tech Partners');

    console.log('[DB] Pre-seeded demo accounts (password for all: Password123!)');
    console.log('     Client: office_admin');
    console.log('     Vendor: it_vendor');
  }

  const vendorCount = sqliteDb.prepare('SELECT COUNT(*) as count FROM vendors').get().count;
  if (vendorCount === 0) {
    const insertVendor = sqliteDb.prepare(`
      INSERT INTO vendors (client_id, vendor_user_id, name, email, organization, specialization, status, rating, tasks_completed)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    insertVendor.run(1, 2, 'Mayo Patel', 'mayo@northstar-it.com', 'Northstar IT Solutions', 'ERP & Accounting Systems', 'Active', 4.9, 14);
    insertVendor.run(1, 3, 'Thao Tran', 'thao@helpworks.io', 'HelpWorks Managed Services', 'Network & Diagnostic Routines', 'Active', 4.8, 8);
    insertVendor.run(1, 4, 'Theo Grant', 'theo@securenet.tech', 'SecureNet Tech Partners', 'Database & Lab Software Support', 'Active', 5.0, 19);
  }

  const taskCount = sqliteDb.prepare('SELECT COUNT(*) as count FROM tasks').get().count;
  if (taskCount === 0) {
    const insertTask = sqliteDb.prepare(`
      INSERT INTO tasks (client_id, vendor_id, assigned_vendor_user_id, vendor_name, title, description, target_process, duration_minutes, token, status, window_start, window_end)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const start = new Date();
    const end30 = new Date(start.getTime() + 30 * 60000);
    const end45 = new Date(start.getTime() + 45 * 60000);

    insertTask.run(
      1, 2, 2, 'Northstar IT Solutions (it_vendor)',
      'Fix Billing Software Invoice PDF Export Engine Error',
      'Diagnose stuck export queue in Billing Manager v4 without touching payroll sheets',
      'billing_manager.exe', 30, 'SCD-1042-XP8B', 'pending',
      start.toISOString(), end30.toISOString()
    );
    insertTask.run(
      1, 4, 4, 'SecureNet Tech Partners (secure_net)',
      'Configure Split-Tunnel OpenVPN Gateway Routings',
      'Update gateway route configurations for dental workstation tunnel',
      'openvpn_gui.exe', 45, 'SCD-3091-ZN72', 'pending',
      start.toISOString(), end45.toISOString()
    );
  }
}

initSqliteTables();

// Small async wrapper so the rest of the app can use `await db.get(...)`
const db = {
  driver: 'sqlite',
  async all(sql, params = []) { return sqliteDb.prepare(sql).all(...params); },
  async get(sql, params = []) { return sqliteDb.prepare(sql).get(...params); },
  async run(sql, params = []) {
    const result = sqliteDb.prepare(sql).run(...params);
    return { lastInsertRowid: Number(result.lastInsertRowid), changes: result.changes };
  },
  async exec(sql) { return sqliteDb.exec(sql); }
};

module.exports = db;

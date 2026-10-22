// Friendly check: this app needs Node.js 22.13+ (built-in SQLite). Older Node crashes right away and the page shows "server not running".
{
  const [maj, min] = process.versions.node.split('.').map(Number);
  if (maj < 22 || (maj === 22 && min < 13)) {
    console.error(`\n[START] You have Node.js ${process.versions.node}. ScopeDesk needs 22.13 or newer. Install the LTS version from https://nodejs.org and run this again.\n`);
    process.exit(1);
  }
}
const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

// Load settings (SMTP email etc.) from a .env file next to server.js, if you created one
try { process.loadEnvFile(path.join(__dirname, '.env')); } catch (_) { /* no .env file: that is fine */ }

const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { Server } = require('socket.io');
const db = require('./db');
const createSessionTimers = require('./server/session-timers');
const createRemoteControl = require('./server/remote-control');
const { buildRtcConfig } = require('./server/rtc-config');

const app = express();
const server = http.createServer(app);
// Allow the UI to be opened from localhost on another port (e.g. VS Code Live Server) during development
function corsOrigin(origin, cb) {
  const ok = !origin || (origin === 'null' && !IS_PRODUCTION) || /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin) || origin === process.env.CORS_ORIGIN;
  cb(null, ok);
}
const io = new Server(server, { cors: { origin: corsOrigin } });

const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const IS_PRODUCTION = process.env.NODE_ENV === 'production';
const APP_URL = process.env.APP_URL || `http://localhost:${PORT}`;

// ================= EMAIL (SMTP) =================
// Real emails are sent when SMTP_HOST, SMTP_USER and SMTP_PASS are set in .env. Without them the reset link is printed in this console.
let mailer = null;
const MAIL_FROM = process.env.MAIL_FROM || `ScopeDesk <${process.env.SMTP_USER || 'no-reply@scopedesk.local'}>`;

(function setupMailer() {
  const { SMTP_HOST, SMTP_USER } = process.env;
  if (!SMTP_HOST || !SMTP_USER || !process.env.SMTP_PASS) {
    console.warn('[MAIL] Email is NOT set up, so password-reset emails cannot be sent. Run "npm run setup-email" once to fix this.');
    return;
  }
  let nodemailer;
  try {
    nodemailer = require('nodemailer');
  } catch (_) {
    console.warn('[MAIL] The "nodemailer" package is missing. Run "npm install" in the project folder, then restart.');
    return;
  }
  const port = Number(process.env.SMTP_PORT || 587);
  // Gmail shows app passwords as 4 groups separated by spaces; the spaces are not part of the password
  const pass = /gmail\.com$/i.test(SMTP_HOST) ? process.env.SMTP_PASS.replace(/\s+/g, '') : process.env.SMTP_PASS;
  mailer = nodemailer.createTransport({ host: SMTP_HOST, port, secure: port === 465, auth: { user: SMTP_USER, pass } });
  mailer.verify()
    .then(() => console.log(`[MAIL] Email is ready (${SMTP_HOST}). Reset emails are sent from ${MAIL_FROM}`))
    .catch((err) => console.warn(`[MAIL] Could not log in to the email server: ${err.message}\n       Check SMTP_USER / SMTP_PASS in .env (Gmail needs an App Password).`));
})();

const escapeHtml = (v) => String(v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function sendResetEmail(to, username, link) {
  return mailer.sendMail({
    from: MAIL_FROM,
    to,
    subject: 'Reset your ScopeDesk password',
    text: `Hi ${username},\n\nWe received a request to reset your ScopeDesk password. Open this link within 30 minutes to choose a new one:\n\n${link}\n\nIf you did not ask for this, you can ignore this email. Your password will not change.\n\n- ScopeDesk`,
    html: `<div style="font-family:Arial,sans-serif;max-width:480px;margin:auto;color:#112933">
      <h2 style="color:#00875f">ScopeDesk</h2>
      <p>Hi ${escapeHtml(username)},</p>
      <p>We received a request to reset your ScopeDesk password. This link works for <strong>30 minutes</strong>.</p>
      <p><a href="${escapeHtml(link)}" style="display:inline-block;background:#00875f;color:#fff;text-decoration:none;padding:12px 22px;border-radius:6px;font-weight:bold">Reset my password</a></p>
      <p style="font-size:13px;color:#555">Or paste this into your browser:<br>${escapeHtml(link)}</p>
      <p style="font-size:13px;color:#555">If you did not ask for this, ignore this email. Your password will not change.</p>
    </div>`
  });
}

// ================= CONSTANTS =================
const DUPLICATE_ACCOUNT_MSG = 'An account with this email/username already exists. Please Sign In instead.';
const SHORT_PASSWORD_MSG = 'Password must be at least 8 characters long.';
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const USERNAME_RE = /^[A-Za-z0-9._-]{3,50}$/;

// JWT secret: from env, else a random secret generated once and saved to .jwt_secret
function loadJwtSecret() {
  if (process.env.JWT_SECRET) return process.env.JWT_SECRET;
  const file = path.join(__dirname, '.jwt_secret');
  try {
    return fs.readFileSync(file, 'utf8').trim();
  } catch (_) {
    const secret = crypto.randomBytes(48).toString('hex');
    fs.writeFileSync(file, secret, { mode: 0o600 });
    console.log('[AUTH] Generated a new JWT secret in .jwt_secret (keep it private).');
    return secret;
  }
}
const JWT_SECRET = loadJwtSecret();

// ================= MIDDLEWARE =================
app.use(cors({ origin: corsOrigin, exposedHeaders: ['X-New-Token'] }));
app.use(express.json({ limit: '50kb' }));
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  next();
});
app.get('/api/health', (req, res) => res.json({ app: 'scopedesk', ok: true }));
// IMPORTANT: serve ONLY the /public folder (never the project root, which holds the database and secrets)
// no-cache: the browser must re-check files on every load, so an old cached script.js can never run against a new server
app.use('/api', (req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); });
app.use(express.static(path.join(__dirname, 'public'), {
  etag: true,
  setHeaders: (res) => res.setHeader('Cache-Control', 'no-cache')
}));

// ================= HELPERS =================
const TOKEN_LIFETIME = '7d';
const TOKEN_REFRESH_AFTER_MS = 30 * 60 * 1000; // active users get a fresh token every 30 min (sliding login)
const AUTH_MESSAGES = {
  NO_TOKEN: 'Please sign in to continue.',
  TOKEN_EXPIRED: 'Your login expired. Please sign in again.',
  TOKEN_INVALID: 'Your login is no longer valid on this server (it may have been reset). Please sign in again.'
};

function issueToken(user) {
  return jwt.sign(
    { userId: user.userId, username: user.username, role: user.role, organization: user.organization || null },
    JWT_SECRET,
    { algorithm: 'HS256', expiresIn: TOKEN_LIFETIME }
  );
}

function readToken(token) {
  if (!token) return { code: 'NO_TOKEN' };
  try {
    return { payload: jwt.verify(token, JWT_SECRET, { algorithms: ['HS256'] }) };
  } catch (err) {
    return { code: err.name === 'TokenExpiredError' ? 'TOKEN_EXPIRED' : 'TOKEN_INVALID' };
  }
}

function verifyToken(token) {
  return readToken(token).payload || null;
}

function authenticateToken(req, res, next) {
  const header = req.headers['authorization'];
  const { payload, code } = readToken(header && header.split(' ')[1]);
  if (!payload) {
    console.warn(`[AUTH] ${req.method} ${req.originalUrl} rejected: ${code}`);
    return res.status(401).json({ error: AUTH_MESSAGES[code], code });
  }
  if (payload.scope === 'agent') return res.status(403).json({ error: 'Host-agent tokens cannot call this API.' });
  req.user = { ...payload, userId: Number(payload.userId) };

  // Sliding login: while you are active, quietly hand the browser a fresh token so you are never logged out mid-work
  if (Date.now() - (payload.iat || 0) * 1000 > TOKEN_REFRESH_AFTER_MS) {
    res.setHeader('X-New-Token', issueToken(req.user));
  }
  next();
}

function requireRole(role) {
  return (req, res, next) => {
    if (req.user.role !== role) {
      return res.status(403).json({ error: `Only ${role} accounts can do this.` });
    }
    next();
  };
}

// SQLite's datetime('now') has no timezone; treat those values as UTC.
function parseDbDate(value) {
  if (!value) return new Date(NaN);
  const s = String(value);
  if (s.includes('T') || s.endsWith('Z')) return new Date(s);
  return new Date(s.replace(' ', 'T') + 'Z');
}

const sha256 = (text) => crypto.createHash('sha256').update(text).digest('hex');

function logAudit(userId, action, details) {
  return db.run('INSERT INTO audit_log (user_id, action, details) VALUES (?, ?, ?)',
    [userId || null, action, JSON.stringify(details || {})]).catch(() => {});
}

// Simple in-memory brute-force limiter (resets on server restart)
const attempts = new Map(); // key -> { count, resetAt }
function isLimited(key, max) {
  const entry = attempts.get(key);
  return !!entry && entry.resetAt > Date.now() && entry.count >= max;
}
function recordAttempt(key, windowMs) {
  const entry = attempts.get(key);
  if (!entry || entry.resetAt <= Date.now()) {
    attempts.set(key, { count: 1, resetAt: Date.now() + windowMs });
  } else {
    entry.count += 1;
  }
}
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of attempts) if (v.resetAt <= now) attempts.delete(k);
}, 60000).unref();

function validatePassword(password) {
  if (typeof password !== 'string' || password.length < 8) return SHORT_PASSWORD_MSG;
  if (Buffer.byteLength(password, 'utf8') > 72) return 'Password must be 72 bytes or fewer.';
  return null;
}

const DUMMY_HASH = bcrypt.hashSync('not-a-real-password', 10); // keeps login timing equal for unknown users

// ================= SOCKET.IO: CONNECTION REGISTRY =================
// userId -> Set of socket ids. A user may have several tabs/devices connected.
const userSockets = new Map();

function addSocket(userId, socketId) {
  if (!userSockets.has(userId)) userSockets.set(userId, new Set());
  userSockets.get(userId).add(socketId);
}
function removeSocket(userId, socketId) {
  const set = userSockets.get(userId);
  if (!set) return;
  set.delete(socketId);
  if (set.size === 0) userSockets.delete(userId);
}

// Sends an event ONLY to the sockets that belong to this user id. Returns how many sockets got it.
function emitToUser(userId, event, payload) {
  const ids = userSockets.get(Number(userId));
  if (!ids || ids.size === 0) return 0;
  ids.forEach((socketId) => io.to(socketId).emit(event, payload));
  return ids.size;
}

// Socket handshake authentication: identity comes from the signed JWT, never from client-sent fields.
io.use((socket, next) => {
  const payload = verifyToken(socket.handshake.auth && socket.handshake.auth.token);
  if (!payload) return next(new Error('Authentication required'));
  socket.data.user = { userId: Number(payload.userId), username: payload.username, role: payload.role };
  if (payload.scope === 'agent') socket.data.agent = { taskId: Number(payload.taskId) }; // host agent: may only do agent things
  next();
});

// ================= SESSION LIFECYCLE (shared by REST + sockets) =================
async function getVendorUserIds(taskId) {
  const rows = await db.all('SELECT DISTINCT vendor_id FROM remote_sessions WHERE task_id = ? AND vendor_id IS NOT NULL', [taskId]);
  return rows.map((r) => r.vendor_id);
}

// Ends a task. Pushes `force-terminate` to the vendor's sockets and `session-ended` to the client's sockets.
async function terminateTask(taskId, { reason, message, actorId, finalStatus = 'terminated', sessionStatus = 'terminated' }) {
  const task = await db.get('SELECT * FROM tasks WHERE id = ?', [taskId]);
  if (!task) return { ok: false, error: 'Task not found.' };
  if (!['pending', 'active'].includes(task.status)) {
    return { ok: false, error: `This task is already ${task.status}.` };
  }

  const now = new Date().toISOString();
  await db.run("UPDATE remote_sessions SET status = ?, ended_at = ?, end_reason = ? WHERE task_id = ? AND status = 'active'",
    [sessionStatus, now, reason, taskId]);
  await db.run('UPDATE tasks SET status = ? WHERE id = ?', [finalStatus, taskId]);
  await logAudit(actorId, 'SESSION_' + finalStatus.toUpperCase(), { taskId, reason });

  const payload = { taskId, title: task.title, reason, message, status: finalStatus };
  for (const vendorId of await getVendorUserIds(taskId)) emitToUser(vendorId, 'force-terminate', payload);
  emitToUser(task.client_id, 'session-ended', payload);
  timers.cancel(taskId);
  remoteControl.halt(taskId, 'ended');
  cutStream(taskId, reason, message);
  return { ok: true, task };
}

async function expireOverdueTasks() {
  const rows = await db.all("SELECT id, window_end FROM tasks WHERE status IN ('pending', 'active')");
  const now = Date.now();
  for (const row of rows) {
    if (parseDbDate(row.window_end).getTime() <= now) {
      await terminateTask(row.id, {
        reason: 'time_expired',
        message: 'The approved time window has ended. Session closed.',
        actorId: null,
        finalStatus: 'expired',
        sessionStatus: 'expired'
      });
    }
  }
}
setInterval(() => expireOverdueTasks().catch((e) => console.error('[EXPIRY]', e.message)), 15000).unref();

// ================= WEBRTC SIGNALING HELPERS =================
// One Socket.IO room per task: "task:<id>". Only that task's Client and its active Vendor may join.
const rtcRoom = (taskId) => `task:${taskId}`;

// Instantly tells both peers to close their RTCPeerConnection, then removes everyone from the room.
function cutStream(taskId, reason, message) {
  const room = rtcRoom(taskId);
  io.to(room).emit('webrtc-close', { taskId, reason, message: message || 'The remote connection was closed.' });
  io.in(room).socketsLeave(room);
}

// Returns 'client' | 'vendor' if this user may use the task's stream, otherwise null.
async function authorizeRtc(user, taskId) {
  if (!Number.isInteger(taskId)) return null;
  const task = await db.get('SELECT client_id, status FROM tasks WHERE id = ?', [taskId]);
  if (!task || task.status !== 'active') return null;
  if (user.role === 'client') return task.client_id === user.userId ? 'client' : null;
  const session = await db.get("SELECT id FROM remote_sessions WHERE task_id = ? AND vendor_id = ? AND status = 'active'", [taskId, user.userId]);
  return session ? 'vendor' : null;
}

// Sends an event to the task's Client and to every Vendor who has a session on it
async function emitToTask(taskId, event, payload) {
  const task = await db.get('SELECT client_id FROM tasks WHERE id = ?', [taskId]);
  if (!task) return;
  emitToUser(task.client_id, event, payload);
  for (const vendorId of await getVendorUserIds(taskId)) emitToUser(vendorId, event, payload);
}

// Per-task countdown: when the approved window ends the task is terminated, both peers are told to hang up, input stops.
const timers = createSessionTimers({
  db, parseDbDate,
  onExpire: (taskId) => terminateTask(taskId, {
    reason: 'time_expired', message: 'The approved time window has ended. Session closed.',
    actorId: null, finalStatus: 'expired', sessionStatus: 'expired'
  })
});
const remoteControl = createRemoteControl({ io, db, authorizeRtc, emitToTask, verifyToken });

// Set AUTO_CUT_STREAM=false in .env to keep the stream alive until the Client presses "Terminate Session Now".
const AUTO_CUT_STREAM = process.env.AUTO_CUT_STREAM !== 'false';

// The Client's PC is where the vendor's actions really happen, so the trusted monitor (agent/client-agent.js)
// runs there and reports with this event. The task and client come from the database, never from the payload.
async function handleHostViolation(user, payload, socket) {
  if (user.role !== 'client') return { ok: false, error: 'Only the host agent (client account) can report this.' };
  const taskId = Number(payload && payload.taskId);
  if (!Number.isInteger(taskId)) return { ok: false, error: 'taskId is required.' };
  if (socket.data.agent && socket.data.agent.taskId !== taskId) return { ok: false, error: 'This agent is paired with a different task.' };

  const session = await db.get(`
    SELECT rs.id, rs.client_id, rs.vendor_name, t.title
    FROM remote_sessions rs JOIN tasks t ON t.id = rs.task_id
    WHERE rs.task_id = ? AND rs.client_id = ? AND rs.status = 'active' AND t.status = 'active'
    ORDER BY rs.id DESC LIMIT 1
  `, [taskId, user.userId]);
  if (!session) return { ok: false, error: 'No active session for this task.' };

  const processName = String((payload && payload.processName) || 'unknown').replace(/[^\w .\-\\/()]/g, '').slice(0, 255) || 'unknown';
  const occurredAt = new Date().toISOString();
  const insert = await db.run(`
    INSERT INTO intrusion_events (session_id, task_id, event_type, process_name, details, severity, action_taken, occurred_at)
    VALUES (?, ?, 'unapproved_process', ?, ?, 'critical', 'client_notified', ?)
  `, [session.id, taskId, processName, `Host agent saw ${processName} in the foreground`, occurredAt]);

  remoteControl.halt(taskId, 'violation'); // vendor input stops at once, whatever AUTO_CUT_STREAM says
  if (AUTO_CUT_STREAM) cutStream(taskId, 'security_violation', `Security violation: ${processName} is not allowed for this task.`);
  emitToUser(session.client_id, 'violation-alert', {
    message: 'Vendor accessed unauthorized data!', taskId, taskTitle: session.title, processName,
    vendor: session.vendor_name, eventId: insert.lastInsertRowid, occurredAt
  });
  await logAudit(user.userId, 'HOST_VIOLATION_REPORTED', { taskId, processName, streamCut: AUTO_CUT_STREAM });
  return { ok: true, streamCut: AUTO_CUT_STREAM };
}

// Violations are reported ONLY by the host agent on the Client's PC (handleHostViolation above).
// The old vendor-side report path was removed: a vendor's own browser must not be what polices the vendor.

// If the client was offline when a violation happened, show it as soon as they reconnect
async function deliverPendingAlerts(user, socket) {
  const pending = await db.all(`
    SELECT e.id, e.task_id, e.process_name, e.occurred_at, t.title
    FROM intrusion_events e
    JOIN tasks t ON t.id = e.task_id
    WHERE t.client_id = ? AND t.status = 'active' AND e.action_taken = 'pending_client'
    ORDER BY e.id ASC
  `, [user.userId]);
  for (const e of pending) {
    socket.emit('violation-alert', {
      message: 'Vendor accessed unauthorized data!',
      taskId: e.task_id,
      taskTitle: e.title,
      processName: e.process_name,
      eventId: e.id,
      occurredAt: e.occurred_at
    });
    await db.run("UPDATE intrusion_events SET action_taken = 'client_notified' WHERE id = ?", [e.id]);
  }
}

io.on('connection', (socket) => {
  const user = socket.data.user;
  addSocket(user.userId, socket.id);

  // HOST AGENT sockets get a tiny, fixed set of abilities and nothing else
  if (socket.data.agent) {
    remoteControl.registerAgent(socket);
    const lastHost = new Map();
    socket.on('host-violation', async (payload, ack) => {
      const reply = (b) => { if (typeof ack === 'function') ack(b); };
      try {
        const key = `${payload && payload.taskId}|${payload && payload.processName}`;
        if (Date.now() - (lastHost.get(key) || 0) < 3000) return reply({ ok: true, throttled: true });
        lastHost.set(key, Date.now());
        reply(await handleHostViolation(user, payload, socket));
      } catch (err) { console.error('[WS] host-violation error:', err.message); reply({ ok: false, error: 'Server error.' }); }
    });
    socket.on('disconnect', () => removeSocket(user.userId, socket.id));
    return;
  }
  remoteControl.registerBrowser(socket, user);

  const respond = (ack, body) => { if (typeof ack === 'function') ack(body); };

  // ---- WebRTC signaling (the server only relays; video never passes through it) ----
  socket.data.rtc = new Set();
  socket.on('webrtc-join', async (payload, ack) => {
    try {
      const taskId = Number(payload && payload.taskId);
      const wantedRole = payload && payload.role;
      const role = await authorizeRtc(user, taskId);
      if (!role || (wantedRole && wantedRole !== role)) return respond(ack, { ok: false, error: 'You are not allowed to use the stream for this task (it must be active and yours).' });
      const room = rtcRoom(taskId);
      const peers = [...(await io.in(room).fetchSockets())].filter((s) => s.id !== socket.id).map((s) => s.data.user.role);
      socket.join(room);
      socket.data.rtc.add(taskId);
      socket.to(room).emit('webrtc-peer-joined', { role });
      respond(ack, { ok: true, role, peers });
    } catch (err) {
      console.error('[WS] webrtc-join error:', err.message);
      respond(ack, { ok: false, error: 'Server error.' });
    }
  });

  socket.on('webrtc-signal', (msg) => {
    const taskId = Number(msg && msg.taskId);
    if (!socket.data.rtc.has(taskId)) return; // must have joined this task's room first
    if (!['offer', 'answer', 'candidate'].includes(msg.type)) return;
    if (JSON.stringify(msg).length > 20000) return;
    const { type, offer, answer, candidate } = msg;
    socket.to(rtcRoom(taskId)).emit('webrtc-signal', { taskId, type, offer, answer, candidate });
  });

  socket.on('webrtc-leave', (payload) => {
    const taskId = Number(payload && payload.taskId);
    socket.leave(rtcRoom(taskId));
    socket.data.rtc.delete(taskId);
    socket.to(rtcRoom(taskId)).emit('webrtc-peer-left', { role: user.role });
  });

  // CLIENT -> SERVER (the "Terminate Session Now" button). Server then sends `force-terminate` to the vendor.
  socket.on('terminate-session', async (payload, ack) => {
    try {
      if (user.role !== 'client') return respond(ack, { ok: false, error: 'Only clients can terminate sessions.' });
      const taskId = Number(payload && payload.taskId);
      const task = Number.isInteger(taskId) ? await db.get('SELECT client_id FROM tasks WHERE id = ?', [taskId]) : null;
      // Ownership check: you can only terminate tasks YOU created
      if (!task || task.client_id !== user.userId) return respond(ack, { ok: false, error: 'Task not found.' });

      respond(ack, await terminateTask(taskId, {
        reason: 'client_terminated',
        message: 'The client ended this session.',
        actorId: user.userId
      }));
    } catch (err) {
      console.error('[WS] terminate-session error:', err.message);
      respond(ack, { ok: false, error: 'Server error.' });
    }
  });

  // CLIENT -> SERVER ("Resume session" in the alert dialog): lifts a violation halt. Ownership checked.
  socket.on('resume-after-violation', async (payload, ack) => {
    const taskId = Number(payload && payload.taskId);
    const task = Number.isInteger(taskId) ? await db.get('SELECT client_id, status FROM tasks WHERE id = ?', [taskId]) : null;
    const ok = !!task && user.role === 'client' && task.client_id === user.userId && task.status === 'active' && remoteControl.resume(taskId);
    if (typeof ack === 'function') ack({ ok });
  });

  socket.on('disconnect', () => removeSocket(user.userId, socket.id));

  if (user.role === 'client') deliverPendingAlerts(user, socket).catch((e) => console.error('[WS] pending alerts:', e.message));
});

// ================= AUTHENTICATION ROUTES =================
async function registerHandler(req, res) {
  try {
    const body = req.body || {};
    const cleanUsername = String(body.username || '').trim();
    const cleanEmail = String(body.email || '').trim().toLowerCase();
    const password = body.password;
    const role = body.role;
    const organization = body.organization ? String(body.organization).trim().slice(0, 150) : null;

    if (!cleanUsername || !cleanEmail || !password || !role) {
      return res.status(400).json({ error: 'Username, email, password, and role are required.' });
    }
    if (!USERNAME_RE.test(cleanUsername)) {
      return res.status(400).json({ error: 'Username must be 3-50 characters using only letters, numbers, dot, dash or underscore (no @ or spaces). Put your email in the Email field.' });
    }
    if (!EMAIL_RE.test(cleanEmail)) {
      return res.status(400).json({ error: 'Please enter a valid email address.' });
    }
    if (!['client', 'vendor'].includes(role)) {
      return res.status(400).json({ error: 'Role must be either client or vendor.' });
    }
    const passwordError = validatePassword(password);
    if (passwordError) return res.status(400).json({ error: passwordError });

    // De-duplication: username OR email (both columns are case-insensitive)
    const existing = await db.get('SELECT id FROM users WHERE username = ? OR email = ?', [cleanUsername, cleanEmail]);
    if (existing) return res.status(409).json({ error: DUPLICATE_ACCOUNT_MSG });

    const passwordHash = await bcrypt.hash(password, 12);
    let result;
    try {
      result = await db.run(
        'INSERT INTO users (username, email, password_hash, role, organization) VALUES (?, ?, ?, ?, ?)',
        [cleanUsername, cleanEmail, passwordHash, role, organization]
      );
    } catch (err) {
      // Two people registering at the same instant: the UNIQUE constraint is the final safety net
      if (String(err.message).includes('UNIQUE')) return res.status(409).json({ error: DUPLICATE_ACCOUNT_MSG });
      throw err;
    }

    if (role === 'vendor') {
      await db.run(
        'INSERT INTO vendors (vendor_user_id, name, email, organization, specialization) VALUES (?, ?, ?, ?, ?)',
        [result.lastInsertRowid, cleanUsername, cleanEmail, organization || 'Independent Support Vendor', 'General Remote Diagnostics']
      );
    }
    await logAudit(result.lastInsertRowid, 'REGISTER', { username: cleanUsername, role });

    res.status(201).json({ success: true, message: 'Account created successfully. Please sign in.', userId: result.lastInsertRowid });
  } catch (err) {
    console.error('Registration error:', err);
    res.status(500).json({ error: 'Internal server error during registration.' });
  }
}
app.post('/api/auth/register', registerHandler);
app.post('/api/auth/signup', registerHandler); // alias (the old alias used a removed Express 4 API and crashed)

// Live check used by the sign-up form: is this username / email already taken?
app.get('/api/auth/availability', async (req, res) => {
  const limitKey = `avail|${req.ip}`;
  if (isLimited(limitKey, 60)) return res.status(429).json({ error: 'Too many checks. Please slow down.' });
  recordAttempt(limitKey, 60 * 1000);

  const username = String(req.query.username || '').trim();
  const email = String(req.query.email || '').trim().toLowerCase();
  const out = {};
  if (username) out.usernameTaken = !!(await db.get('SELECT id FROM users WHERE username = ?', [username]));
  if (email) out.emailTaken = !!(await db.get('SELECT id FROM users WHERE email = ?', [email]));
  res.json(out);
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const body = req.body || {};
    const identifier = String(body.username || body.email || '').trim();
    const password = typeof body.password === 'string' ? body.password : '';

    if (!identifier || !password) {
      return res.status(400).json({ error: 'Username (or email) and password are required.' });
    }

    const limitKey = `login|${req.ip}|${identifier.toLowerCase()}`;
    if (isLimited(limitKey, 5)) {
      return res.status(429).json({ error: 'Too many failed attempts. Please try again in 15 minutes.' });
    }

    const user = await db.get(
      'SELECT id, username, email, password_hash, role, organization, is_active FROM users WHERE username = ? OR email = ?',
      [identifier, identifier.toLowerCase()]
    );

    const matches = await bcrypt.compare(password, user ? user.password_hash : DUMMY_HASH);
    if (!user || !matches) {
      recordAttempt(limitKey, 15 * 60 * 1000);
      return res.status(401).json({ error: 'Invalid username or password.' });
    }
    if (!user.is_active) {
      return res.status(403).json({ error: 'This account has been deactivated. Contact administration.' });
    }

    attempts.delete(limitKey);
    const token = issueToken({ userId: user.id, username: user.username, role: user.role, organization: user.organization });
    await logAudit(user.id, 'LOGIN', { username: user.username, role: user.role });

    res.json({
      success: true,
      message: 'Login successful.',
      token,
      user: { id: user.id, username: user.username, email: user.email, role: user.role, organization: user.organization }
    });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: 'Internal server error during login.' });
  }
});

app.get('/api/auth/me', authenticateToken, async (req, res) => {
  const user = await db.get(
    'SELECT id, username, email, role, organization, is_active, created_at FROM users WHERE id = ?',
    [req.user.userId]
  );
  if (!user || !user.is_active) return res.status(401).json({ error: 'Account not available.' });
  res.json({ user });
});

// ---- Forgot password (mock mailer: the reset link is printed in the server console) ----
app.post('/api/auth/forgot-password', async (req, res) => {
  try {
    const email = String((req.body && req.body.email) || '').trim().toLowerCase();
    if (!EMAIL_RE.test(email)) return res.status(400).json({ error: 'Please enter a valid email address.' });

    const limitKey = `forgot|${req.ip}`;
    if (isLimited(limitKey, 5)) return res.status(429).json({ error: 'Too many requests. Please try again later.' });
    recordAttempt(limitKey, 15 * 60 * 1000);

    // Same response whether or not the email exists, so attackers cannot probe for accounts
    const response = {
      success: true,
      emailConfigured: !!mailer,
      message: mailer
        ? 'If an account exists for that email, a password reset link has been sent. Check your inbox (and spam folder).'
        : 'Email sending is not set up on this server yet, so no email was sent. Run "npm run setup-email" once to turn it on.'
    };

    const user = await db.get('SELECT id, username FROM users WHERE email = ? AND is_active = 1', [email]);
    if (user) {
      const rawToken = crypto.randomBytes(32).toString('hex');
      await db.run('UPDATE password_resets SET used = 1 WHERE user_id = ? AND used = 0', [user.id]); // invalidate older links
      await db.run('INSERT INTO password_resets (user_id, token_hash, expires_at) VALUES (?, ?, ?)',
        [user.id, sha256(rawToken), new Date(Date.now() + 30 * 60000).toISOString()]);

      const link = `${APP_URL}/?reset=${rawToken}`;
      await logAudit(user.id, 'PASSWORD_RESET_REQUESTED', {});

      if (mailer) {
        // Not awaited on purpose: the reply takes the same time whether or not the account exists
        sendResetEmail(email, user.username, link)
          .then(() => console.log(`[MAIL] Password reset email sent to ${email}`))
          .catch((err) => console.error(`[MAIL] Could not send the reset email to ${email}: ${err.message}`));
      } else {
        console.log(`[MOCK EMAIL] Email is not set up, so nothing was sent. Reset link for ${email} (valid 30 min):\n             ${link}`);
        if (!IS_PRODUCTION) response.devResetLink = link; // development only, and only while SMTP is not configured
      }
    }
    res.json(response);
  } catch (err) {
    console.error('Forgot-password error:', err);
    res.status(500).json({ error: 'Could not process the request.' });
  }
});

app.post('/api/auth/reset-password', async (req, res) => {
  try {
    const { token, password } = req.body || {};
    const passwordError = validatePassword(password);
    if (passwordError) return res.status(400).json({ error: passwordError });
    if (typeof token !== 'string' || token.length < 20) {
      return res.status(400).json({ error: 'This reset link is invalid or has expired.' });
    }

    const reset = await db.get('SELECT id, user_id, expires_at FROM password_resets WHERE token_hash = ? AND used = 0', [sha256(token)]);
    if (!reset || new Date(reset.expires_at).getTime() < Date.now()) {
      return res.status(400).json({ error: 'This reset link is invalid or has expired.' });
    }

    await db.run('UPDATE users SET password_hash = ? WHERE id = ?', [await bcrypt.hash(password, 12), reset.user_id]);
    await db.run('UPDATE password_resets SET used = 1 WHERE id = ?', [reset.id]);
    await logAudit(reset.user_id, 'PASSWORD_RESET_COMPLETED', {});
    res.json({ success: true, message: 'Password updated. Please sign in with your new password.' });
  } catch (err) {
    console.error('Reset-password error:', err);
    res.status(500).json({ error: 'Could not reset password.' });
  }
});

// ================= VENDOR ACCOUNTS (clients only) =================
const REPORT_REASONS = ['Accessed unauthorized data', 'Unprofessional conduct', 'Did not do the agreed work', 'Suspicious activity', 'Other'];

async function isVendorBlocked(clientId, vendorUserId) {
  return !!(await db.get('SELECT id FROM client_vendor_blocks WHERE client_id = ? AND vendor_user_id = ?', [clientId, vendorUserId]));
}

async function findVendorUser(id) {
  const vendorId = Number(id);
  if (!Number.isInteger(vendorId)) return null;
  return db.get("SELECT id, username, organization FROM users WHERE id = ? AND role = 'vendor' AND is_active = 1", [vendorId]);
}

// Every active vendor ACCOUNT, with this client's own block/report status
app.get('/api/vendors', authenticateToken, requireRole('client'), async (req, res) => {
  const vendors = await db.all(`
    SELECT u.id AS user_id, u.username, u.organization,
           COALESCE(v.specialization, 'General Remote Diagnostics') AS specialization,
           COALESCE(v.rating, 5.0) AS rating,
           COALESCE(v.tasks_completed, 0) AS tasks_completed,
           CASE WHEN b.id IS NULL THEN 0 ELSE 1 END AS blocked,
           b.reason AS blocked_reason,
           (SELECT COUNT(*) FROM vendor_reports r WHERE r.vendor_user_id = u.id AND r.client_id = ?) AS my_reports
    FROM users u
    LEFT JOIN vendors v ON v.vendor_user_id = u.id
    LEFT JOIN client_vendor_blocks b ON b.vendor_user_id = u.id AND b.client_id = ?
    WHERE u.role = 'vendor' AND u.is_active = 1
    ORDER BY blocked ASC, rating DESC, u.username COLLATE NOCASE
  `, [req.user.userId, req.user.userId]);
  res.json({ vendors });
});

// Report a vendor (saved for administrator review; does not block them)
app.post('/api/vendors/:id/report', authenticateToken, requireRole('client'), async (req, res) => {
  const vendor = await findVendorUser(req.params.id);
  if (!vendor) return res.status(404).json({ error: 'Vendor account not found.' });

  const reason = String((req.body && req.body.reason) || '');
  if (!REPORT_REASONS.includes(reason)) return res.status(400).json({ error: 'Please choose a reason for the report.' });
  const details = String((req.body && req.body.details) || '').trim().slice(0, 1000);

  const limitKey = `report|${req.user.userId}`;
  if (isLimited(limitKey, 10)) return res.status(429).json({ error: 'Too many reports. Please try again later.' });
  recordAttempt(limitKey, 60 * 60 * 1000);

  await db.run('INSERT INTO vendor_reports (client_id, vendor_user_id, reason, details) VALUES (?, ?, ?, ?)',
    [req.user.userId, vendor.id, reason, details]);
  await logAudit(req.user.userId, 'VENDOR_REPORTED', { vendorUserId: vendor.id, reason });
  res.status(201).json({ success: true, message: `Report about ${vendor.username} submitted.` });
});

// "Terminate" a vendor for THIS client: ends their live sessions, revokes their pending requests,
// and stops them from connecting to or being assigned this client's tasks. Other clients are unaffected.
app.post('/api/vendors/:id/terminate', authenticateToken, requireRole('client'), async (req, res) => {
  const vendor = await findVendorUser(req.params.id);
  if (!vendor) return res.status(404).json({ error: 'Vendor account not found.' });

  const reason = String((req.body && req.body.reason) || 'Access ended by client').trim().slice(0, 300);
  await db.run('INSERT OR IGNORE INTO client_vendor_blocks (client_id, vendor_user_id, reason) VALUES (?, ?, ?)',
    [req.user.userId, vendor.id, reason]);

  const tasks = await db.all(`
    SELECT id FROM tasks
    WHERE client_id = ? AND status IN ('pending', 'active')
      AND (assigned_vendor_user_id = ?
           OR id IN (SELECT task_id FROM remote_sessions WHERE vendor_id = ? AND status = 'active'))
  `, [req.user.userId, vendor.id, vendor.id]);

  for (const t of tasks) {
    await terminateTask(t.id, {
      reason: 'vendor_removed',
      message: 'The client has ended your access.',
      actorId: req.user.userId
    });
  }
  await logAudit(req.user.userId, 'VENDOR_TERMINATED', { vendorUserId: vendor.id, tasksEnded: tasks.length });
  res.json({ success: true, tasksEnded: tasks.length, message: `${vendor.username}'s access has been terminated.` });
});

app.post('/api/vendors/:id/restore', authenticateToken, requireRole('client'), async (req, res) => {
  const vendorId = Number(req.params.id);
  if (!Number.isInteger(vendorId)) return res.status(400).json({ error: 'Invalid vendor.' });
  await db.run('DELETE FROM client_vendor_blocks WHERE client_id = ? AND vendor_user_id = ?', [req.user.userId, vendorId]);
  await logAudit(req.user.userId, 'VENDOR_RESTORED', { vendorUserId: vendorId });
  res.json({ success: true });
});

// ================= SUPPORT TASKS =================
// Clients see only their own tasks. Vendors see only tasks they have connected to (and never the token).
app.get('/api/tasks', authenticateToken, async (req, res) => {
  let tasks;
  if (req.user.role === 'client') {
    tasks = await db.all(`
      SELECT t.*,
             (SELECT COUNT(*) FROM intrusion_events e WHERE e.task_id = t.id) AS intrusion_count
      FROM tasks t WHERE t.client_id = ? ORDER BY t.id DESC
    `, [req.user.userId]);
  } else {
    // Requests sent to this vendor account + tasks they have worked on. The token is never included.
    tasks = await db.all(`
      SELECT t.id, t.title, t.description, t.target_process, t.duration_minutes, t.status,
             t.window_start, t.window_end, t.assigned_vendor_user_id, u.organization AS client_org,
             (SELECT r.id FROM remote_sessions r WHERE r.task_id = t.id AND r.vendor_id = ? ORDER BY r.id DESC LIMIT 1) AS session_id,
             (SELECT r.status FROM remote_sessions r WHERE r.task_id = t.id AND r.vendor_id = ? ORDER BY r.id DESC LIMIT 1) AS session_status
      FROM tasks t
      LEFT JOIN users u ON u.id = t.client_id
      WHERE t.assigned_vendor_user_id = ?
         OR t.id IN (SELECT task_id FROM remote_sessions WHERE vendor_id = ?)
      ORDER BY t.id DESC
    `, [req.user.userId, req.user.userId, req.user.userId, req.user.userId]);
  }
  res.json({ tasks, serverTime: Date.now() });
});

app.post('/api/tasks', authenticateToken, requireRole('client'), async (req, res) => {
  const { title, description, target_process, assigned_vendor_user_id, duration_minutes } = req.body || {};
  if (!title || !target_process) {
    return res.status(400).json({ error: 'Task title and target process are required.' });
  }

  // Optional: send the request to one specific vendor account
  let assignedVendor = null;
  if (assigned_vendor_user_id) {
    assignedVendor = await findVendorUser(assigned_vendor_user_id);
    if (!assignedVendor) return res.status(400).json({ error: 'The selected vendor account was not found.' });
    if (await isVendorBlocked(req.user.userId, assignedVendor.id)) {
      return res.status(403).json({ error: 'You terminated this vendor\'s access. Restore them in the vendor list first.' });
    }
  }
  const vendorLabel = assignedVendor
    ? `${assignedVendor.organization || 'Independent Vendor'} (${assignedVendor.username})`
    : 'Any vendor with the token';

  const duration = Math.min(Math.max(parseInt(duration_minutes, 10) || 30, 5), 480);
  const token = `SCD-${crypto.randomInt(1000, 10000)}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
  const now = new Date();
  const windowEnd = new Date(now.getTime() + duration * 60000);

  const result = await db.run(`
    INSERT INTO tasks (client_id, vendor_id, assigned_vendor_user_id, vendor_name, title, description, target_process, duration_minutes, token, status, window_start, window_end)
    VALUES (?, NULL, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)
  `, [
    req.user.userId,
    assignedVendor ? assignedVendor.id : null,
    vendorLabel,
    String(title).trim().slice(0, 200),
    description || 'Task-bounded remote support session with strict process isolation',
    String(target_process).trim().slice(0, 255),
    duration,
    token,
    now.toISOString(),
    windowEnd.toISOString()
  ]);

  const task = await db.get('SELECT * FROM tasks WHERE id = ?', [result.lastInsertRowid]);
  timers.schedule(task.id, windowEnd.getTime());
  await logAudit(req.user.userId, 'TASK_CREATED', { taskId: task.id, duration, assignedTo: assignedVendor ? assignedVendor.id : null });
  if (assignedVendor) {
    emitToUser(assignedVendor.id, 'task-request', {
      taskId: task.id, title: task.title, client: req.user.organization || req.user.username, duration
    });
  }
  res.status(201).json({ success: true, task });
});

// ================= REMOTE SESSIONS =================
app.post('/api/sessions/connect', authenticateToken, requireRole('vendor'), async (req, res) => {
  const body = req.body || {};
  let task;
  let cleanToken;

  if (body.task_id !== undefined && body.task_id !== null) {
    // Accepting a request that was sent directly to this vendor account (no token typing needed)
    task = Number.isInteger(Number(body.task_id)) ? await db.get('SELECT * FROM tasks WHERE id = ?', [Number(body.task_id)]) : null;
    if (!task || task.assigned_vendor_user_id !== req.user.userId) {
      return res.status(404).json({ error: 'Request not found.' });
    }
    cleanToken = task.token;
  } else {
    cleanToken = String(body.token || '').trim().toUpperCase();
    if (!cleanToken) return res.status(400).json({ error: 'Session token is required.' });

    const limitKey = `connect|${req.user.userId}`;
    if (isLimited(limitKey, 10)) return res.status(429).json({ error: 'Too many attempts. Please wait a few minutes.' });

    task = await db.get('SELECT * FROM tasks WHERE token = ?', [cleanToken]);
    if (!task) {
      recordAttempt(limitKey, 10 * 60 * 1000);
      return res.status(404).json({ error: 'Access token not found in ScopeDesk registries.' });
    }
    if (task.assigned_vendor_user_id && task.assigned_vendor_user_id !== req.user.userId) {
      return res.status(403).json({ error: 'This task was assigned to a different vendor.' });
    }
  }

  if (await isVendorBlocked(task.client_id, req.user.userId)) {
    return res.status(403).json({ error: 'This client has ended your access.' });
  }
  if (task.status === 'completed') return res.status(400).json({ error: 'This task session has already completed.' });
  if (task.status === 'terminated') return res.status(403).json({ error: 'This session was terminated due to a boundary violation or client revocation.' });
  if (task.status === 'expired') return res.status(403).json({ error: 'This token has expired past its allocated time interval.' });

  const windowEnd = parseDbDate(task.window_end);
  const now = new Date();
  if (now > windowEnd) {
    await terminateTask(task.id, { reason: 'time_expired', message: 'Time window ended.', actorId: null, finalStatus: 'expired', sessionStatus: 'expired' });
    return res.status(403).json({ error: 'This token has expired past its allocated time interval.' });
  }

  let session = null;
  if (task.status === 'active') {
    session = await db.get("SELECT * FROM remote_sessions WHERE task_id = ? AND status = 'active' ORDER BY id DESC LIMIT 1", [task.id]);
    if (session && session.vendor_id !== req.user.userId) {
      return res.status(409).json({ error: 'This task is already being worked on by another vendor.' });
    }
  }

  const isReconnect = !!session;
  if (!session) {
    await db.run("UPDATE tasks SET status = 'active' WHERE id = ?", [task.id]);
    const sessionRes = await db.run(`
      INSERT INTO remote_sessions (task_id, client_id, vendor_id, vendor_name, token, status, started_at)
      VALUES (?, ?, ?, ?, ?, 'active', ?)
    `, [task.id, task.client_id, req.user.userId, req.user.username, cleanToken, now.toISOString()]);
    session = await db.get('SELECT * FROM remote_sessions WHERE id = ?', [sessionRes.lastInsertRowid]);
    await logAudit(req.user.userId, 'SESSION_STARTED', { taskId: task.id });
    timers.schedule(task.id, windowEnd.getTime());
    emitToUser(task.client_id, 'session-connected', {
      taskId: task.id, vendor: req.user.username, targetProcess: task.target_process,
      windowEnd: windowEnd.getTime(), serverTime: Date.now()
    });
  }

  const { token: _hidden, ...safeTask } = task; // never echo the token back
  res.json({
    success: true,
    reconnect: isReconnect,
    session,
    task: { ...safeTask, status: 'active' },
    windowEnd: windowEnd.getTime(),
    serverTime: Date.now(),
    remainingMinutes: Math.max(1, Math.round((windowEnd - now) / 60000))
  });
});

// REST version of terminate (the UI uses the socket event, this is a fallback). Owning client only.
app.post('/api/sessions/:id/terminate', authenticateToken, requireRole('client'), async (req, res) => {
  const session = await db.get('SELECT * FROM remote_sessions WHERE id = ?', [req.params.id]);
  if (!session || session.client_id !== req.user.userId) return res.status(404).json({ error: 'Session not found' });

  const result = await terminateTask(session.task_id, {
    reason: 'client_terminated', message: 'The client ended this session.', actorId: req.user.userId
  });
  if (!result.ok) return res.status(400).json({ error: result.error });
  res.json({ success: true, message: 'Session terminated and remote pipe severed.' });
});

// Vendor (or owning client) ends the session normally
app.post('/api/sessions/:id/complete', authenticateToken, async (req, res) => {
  const session = await db.get('SELECT * FROM remote_sessions WHERE id = ?', [req.params.id]);
  const isParticipant = session && (session.vendor_id === req.user.userId || session.client_id === req.user.userId);
  if (!isParticipant) return res.status(404).json({ error: 'Session not found' });
  if (session.status !== 'active') return res.status(400).json({ error: `Session is already ${session.status}.` });

  const now = new Date().toISOString();
  await db.run("UPDATE remote_sessions SET status = 'completed', ended_at = ?, end_reason = 'completed' WHERE id = ?", [now, session.id]);
  await db.run("UPDATE tasks SET status = 'completed' WHERE id = ?", [session.task_id]);
  if (session.vendor_id) {
    await db.run('UPDATE vendors SET tasks_completed = tasks_completed + 1 WHERE vendor_user_id = ?', [session.vendor_id]);
  }
  await logAudit(req.user.userId, 'SESSION_COMPLETED', { sessionId: session.id });

  const payload = { taskId: session.task_id, reason: 'completed', message: 'Session completed.', status: 'completed' };
  emitToUser(session.client_id, 'session-ended', payload);
  if (session.vendor_id) emitToUser(session.vendor_id, 'session-ended', payload);
  res.json({ success: true, message: 'Session marked as completed successfully.' });
});

// ================= WEBRTC CONFIG + HOST AGENT PAIRING =================
// ICE servers for the task (TURN credentials expire exactly when the task window ends)
app.get('/api/rtc-config', authenticateToken, async (req, res) => {
  const taskId = Number(req.query.taskId);
  if (!(await authorizeRtc(req.user, taskId))) return res.status(403).json({ error: 'No active session for this task.' });
  const task = await db.get('SELECT window_end FROM tasks WHERE id = ?', [taskId]);
  res.json(buildRtcConfig({ userId: req.user.userId, expiresAtMs: parseDbDate(task.window_end).getTime() }));
});

// The Client asks for a pairing token for the agent on their PC. It is valid for ONE task only, expires when the
// window ends, and is refused by every normal API route, so it cannot be used to log in as the Client.
app.post('/api/tasks/:id/agent-token', authenticateToken, requireRole('client'), async (req, res) => {
  const task = await db.get('SELECT * FROM tasks WHERE id = ?', [Number(req.params.id)]);
  if (!task || task.client_id !== req.user.userId) return res.status(404).json({ error: 'Task not found.' });
  if (!['pending', 'active'].includes(task.status)) return res.status(400).json({ error: `This task is already ${task.status}.` });
  const secondsLeft = Math.floor((parseDbDate(task.window_end).getTime() - Date.now()) / 1000);
  if (secondsLeft < 5) return res.status(400).json({ error: 'The time window has already ended.' });
  const agentToken = jwt.sign(
    { userId: req.user.userId, username: req.user.username, role: 'client', scope: 'agent', taskId: task.id },
    JWT_SECRET, { algorithm: 'HS256', expiresIn: secondsLeft }
  );
  await logAudit(req.user.userId, 'AGENT_TOKEN_ISSUED', { taskId: task.id });
  res.json({ agentToken, taskId: task.id, expiresInSeconds: secondsLeft });
});

// ================= ALERTS & HISTORY (scoped to the owning client) =================
app.get('/api/alerts', authenticateToken, requireRole('client'), async (req, res) => {
  const alerts = await db.all(`
    SELECT e.*, t.title AS task_title
    FROM intrusion_events e JOIN tasks t ON e.task_id = t.id
    WHERE t.client_id = ? ORDER BY e.id DESC LIMIT 50
  `, [req.user.userId]);
  res.json({ alerts });
});

app.get('/api/history', authenticateToken, requireRole('client'), async (req, res) => {
  const history = await db.all(`
    SELECT t.id AS task_id, t.title AS task_title, t.target_process, t.duration_minutes, t.status AS task_status,
           t.vendor_name, t.window_start, t.window_end, t.created_at,
           (SELECT COUNT(*) FROM intrusion_events ie WHERE ie.task_id = t.id) AS intrusion_count
    FROM tasks t WHERE t.client_id = ? ORDER BY t.id DESC
  `, [req.user.userId]);
  res.json({ history });
});

// ================= ERROR HANDLING =================
app.use((err, req, res, next) => {
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid JSON in request.' });
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'Unexpected server error.' });
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') console.error(`\n[START] Port ${PORT} is already in use. Close the other ScopeDesk window (or whatever uses it), or set PORT=3001 in .env and open http://localhost:3001\n`);
  else console.error('[START] Server failed to start:', err.message);
  process.exit(1);
});

server.listen(PORT, HOST, () => {
  timers.restoreAll().then((n) => console.log(`[TIMER] Re-armed ${n} open task(s)`)).catch((e) => console.error('[TIMER]', e.message));
  console.log('====================================================');
  console.log(' ScopeDesk Secure Task-Bounded Remote Support Engine');
  console.log(` Open:      http://localhost:${PORT}`);
  console.log(` Realtime:  Socket.IO on the same port`);
  console.log(` Database:  ${db.driver}`);
  console.log('====================================================');
});

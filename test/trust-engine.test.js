'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

// production mode: no demo seed, so the database starts empty
process.env.NODE_ENV = 'production';
process.env.DB_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'scopedesk-')), 'test.db');
const db = require('../db');

async function user(name, role) {
  return (await db.run('INSERT INTO users (username, email, password_hash, role, organization) VALUES (?,?,?,?,?)', [name, name + '@x.io', 'h', role, name + ' Org'])).lastInsertRowid;
}
async function task(clientId, vendorId, token) {
  const now = new Date().toISOString();
  return (await db.run(`INSERT INTO tasks (client_id, vendor_id, assigned_vendor_user_id, vendor_name, title, target_process, duration_minutes, token, status, window_start, window_end)
    VALUES (?,?,?,?,?,?,?,?, 'active', ?, ?)`, [clientId, vendorId, vendorId, 'v', 'T', 'Excel', 30, token, now, now])).lastInsertRowid;
}
const rating = (clientId, vendorId) => db.get('SELECT rating, tasks_completed FROM vendors WHERE client_id = ? AND vendor_user_id = ?', [clientId, vendorId]);

test('completion adds +1 inside that client directory only, once per task', async () => {
  const c1 = await user('c1', 'client'), c2 = await user('c2', 'client'), v = await user('v1', 'vendor');
  await db.run("INSERT INTO vendors (client_id, vendor_user_id, name, email, organization, rating, tasks_completed) VALUES (?,?,?,?,?,?,?)", [c1, v, 'v1', 'v1@x.io', 'Org', 4.9, 3]);
  await db.run("INSERT INTO vendors (client_id, vendor_user_id, name, email, organization, rating, tasks_completed) VALUES (?,?,?,?,?,?,?)", [c2, v, 'v1', 'v1@x.io', 'Org', 2, 0]);

  const t = await task(c1, v, 'SCD-1');
  await db.run("UPDATE tasks SET status = 'completed' WHERE id = ?", [t]);
  assert.deepEqual({ ...(await rating(c1, v)) }, { rating: 5.9, tasks_completed: 4 });
  assert.deepEqual({ ...(await rating(c2, v)) }, { rating: 2, tasks_completed: 0 });   // other client untouched

  await db.run("UPDATE tasks SET status = 'completed' WHERE id = ?", [t]);              // repeat write: no second point
  assert.equal((await rating(c1, v)).rating, 5.9);
});

test('first completed task creates the directory row (0 -> 1)', async () => {
  const c = await user('c3', 'client'), v = await user('v2', 'vendor');
  assert.equal(await rating(c, v), undefined);
  await db.run("UPDATE tasks SET status = 'completed' WHERE id = ?", [await task(c, v, 'SCD-2')]);
  assert.deepEqual({ ...(await rating(c, v)) }, { rating: 1, tasks_completed: 1 });
  await db.run("UPDATE tasks SET status = 'completed' WHERE id = ?", [await task(c, v, 'SCD-3')]);
  assert.equal((await rating(c, v)).rating, 2);
});

test('terminated / expired tasks and tasks with a violation earn nothing', async () => {
  const c = await user('c4', 'client'), v = await user('v3', 'vendor');
  await db.run("UPDATE tasks SET status = 'terminated' WHERE id = ?", [await task(c, v, 'SCD-4')]);
  await db.run("UPDATE tasks SET status = 'expired' WHERE id = ?", [await task(c, v, 'SCD-5')]);
  const bad = await task(c, v, 'SCD-6');
  await db.run("INSERT INTO intrusion_events (task_id, event_type, details) VALUES (?, 'unapproved_process', 'x')", [bad]);
  await db.run("UPDATE tasks SET status = 'completed' WHERE id = ?", [bad]);
  assert.equal(await rating(c, v), undefined);
});

test('alerts_enabled defaults to on', async () => {
  const c = await user('c5', 'client'), v = await user('v4', 'vendor');
  const t = await task(c, v, 'SCD-7');
  assert.equal((await db.get('SELECT alerts_enabled FROM tasks WHERE id = ?', [t])).alerts_enabled, 1);
});

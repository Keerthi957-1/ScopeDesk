'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const taskScope = require('../server/task-scope');
const createSessionTimers = require('../server/session-timers');
const createRemoteControl = require('../server/remote-control');

const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));

test('checkPathScope: inside / outside / unknown, whole segments only, ".." cannot escape', () => {
  const a = ['C:\\Clients\\Acme'];
  assert.equal(taskScope.checkPathScope('C:\\Clients\\Acme', a), 'inside');
  assert.equal(taskScope.checkPathScope('c:\\clients\\ACME\\Invoices\\2026', a), 'inside');   // Windows paths ignore case
  assert.equal(taskScope.checkPathScope('C:\\Clients\\Acme\\Invoices', a), 'inside');
  assert.equal(taskScope.checkPathScope('C:\\Clients\\Acme2', a), 'outside');
  assert.equal(taskScope.checkPathScope('C:\\Clients\\Acme\\..\\Other', a), 'outside');
  assert.equal(taskScope.checkPathScope('C:\\Windows', a), 'outside');
  assert.equal(taskScope.checkPathScope('C:\\anything', []), 'unknown');                       // no folders named: the agent decides
  assert.equal(taskScope.checkPathScope('C:\\x', ['%USERPROFILE%\\Docs']), 'unknown');         // only the Client's PC can expand variables
  assert.equal(taskScope.checkPathScope('C:\\Clients\\Acme\\a', ['%USERPROFILE%\\Docs', a[0]]), 'inside');
  assert.equal(taskScope.checkPathScope('/home/u/proj/src', ['/home/u/proj']), 'inside');
  assert.equal(taskScope.checkPathScope('/home/u/proj2', ['/home/u/proj']), 'outside');
});

function fakeDb(task) {
  return { get: async (sql) => (/FROM tasks/.test(sql) ? task : null), all: async () => [] };
}

test('session timers: ensure() arms the countdown from the database once, and expiry fires', async () => {
  const expired = [];
  const task = { window_end: new Date(Date.now() + 60).toISOString(), status: 'active' };
  const timers = createSessionTimers({ db: fakeDb(task), parseDbDate: (v) => new Date(v), onExpire: (id) => expired.push(id) });
  assert.equal(timers.has(7), false);
  assert.equal(await timers.ensure(7), true);
  assert.equal(timers.has(7), true);
  assert.equal(await timers.ensure(7), true);            // already armed: no second timer
  await tick(150);
  assert.deepEqual(expired, [7]);
  const done = createSessionTimers({ db: fakeDb({ window_end: task.window_end, status: 'expired' }), parseDbDate: (v) => new Date(v), onExpire() {} });
  assert.equal(await done.ensure(8), false);             // a finished task never gets a timer
});

function rig({ allowedPaths = ['C:\\Clients\\Acme'], role = 'vendor' } = {}) {
  const handlers = {}; const emitted = []; const disconnected = []; const breaches = []; const cancelled = [];
  const db = {
    get: async (sql) => {
      if (/allowed_paths, window_end/.test(sql)) return { allowed_paths: JSON.stringify(allowedPaths), window_end: new Date(Date.now() + 60000).toISOString() };
      return { id: 1, title: 't', target_process: '', task_type: '', allowed_paths: '[]', allowed_apps: '[]', window_end: new Date().toISOString(), status: 'active' };
    }
  };
  const agentSock = { id: 'agent1', data: { agent: { taskId: 5 }, user: { userId: 1 } }, on(ev, fn) { handlers['agent:' + ev] = fn; } };
  const io = {
    to: (id) => ({ emit: (ev, p) => emitted.push({ id, ev, p }) }),
    sockets: { sockets: new Map([['agent1', { disconnect: (v) => disconnected.push(v) }]]) }
  };
  const rc = createRemoteControl({
    io, db, authorizeRtc: async () => role, emitToTask: async () => {}, verifyToken: () => null,
    timers: { cancel: (id) => cancelled.push(id), ensure: async () => true },
    onBreach: (b) => breaches.push(b)
  });
  const browser = { on(ev, fn) { handlers[ev] = fn; } };
  rc.registerBrowser(browser, { userId: 9, role });
  return { rc, handlers, emitted, disconnected, breaches, cancelled, agentSock };
}

test('an out-of-scope folder request ends in a breach: nothing reaches the PC, input is halted', async () => {
  const r = rig();
  await r.handlers['remote-input']({ taskId: 5, e: { t: 'open', p: 'C:\\Clients\\Acme\\Invoices' } });
  assert.equal(r.breaches.length, 0);
  await r.handlers['remote-input']({ taskId: 5, e: { t: 'open', p: 'C:\\Users\\Boss\\Documents' } });
  await tick();
  assert.equal(r.breaches.length, 1);
  assert.equal(r.breaches[0].kind, 'path');
  assert.equal(r.breaches[0].taskId, 5);
  assert.equal(r.rc.isHalted(5), true);
  const before = r.emitted.length;
  await r.handlers['remote-input']({ taskId: 5, e: { t: 'move', x: 0.5, y: 0.5 } });   // anything after the breach is dropped
  assert.equal(r.emitted.length, before);
});

test('an unknown scope (no folders named) does not kill the session: the agent decides', async () => {
  const r = rig({ allowedPaths: [] });
  await r.handlers['remote-input']({ taskId: 5, e: { t: 'open', p: 'D:\\whatever' } });
  assert.equal(r.breaches.length, 0); assert.equal(r.rc.isHalted(5), false);
});

test('a client can never push input; vendors only', async () => {
  const r = rig({ role: 'client' });
  await r.handlers['remote-input']({ taskId: 5, e: { t: 'open', p: 'D:\\x' } });
  assert.equal(r.breaches.length, 0);
});

test('teardown: halts, cancels the countdown, drops the agent socket, is safe to repeat', async () => {
  const r = rig();
  r.rc.registerAgent(r.agentSock);
  let helloReply;
  await r.handlers['agent:agent-hello']({}, (x) => { helloReply = x; });
  assert.equal(helloReply.ok, true); assert.equal(r.rc.agentOnline(5), true);
  r.rc.teardown(5, 'time_expired');
  r.rc.teardown(5, 'time_expired');
  assert.equal(r.rc.isHalted(5), true);
  assert.equal(r.rc.agentOnline(5), false);
  assert.ok(r.cancelled.includes(5));
  assert.ok(r.emitted.some((e) => e.ev === 'control-halt' && e.p.reason === 'ended' && e.p.endReason === 'time_expired'));
  await tick(300);
  assert.deepEqual(r.disconnected, [true]);              // the agent's socket was closed (once)
});

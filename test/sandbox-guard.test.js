'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createSandboxGuard, canonicalPath, lockCommand } = require('../agent/sandbox-guard');
const { validateTaskRequest, extractPaths } = require('../server/task-scope');
const { cleanAppName, isAppAllowed } = require('../agent/app-catalog');

const identity = (p) => p;   // pretend nothing is a symlink
function make(overrides = {}) {
  const calls = { closed: 0, locked: 0, reports: [] };
  const guard = createSandboxGuard({
    taskId: 7, platform: 'win32', env: { SystemRoot: 'C:\\Windows', USERPROFILE: 'C:\\Users\\Ann' }, realpath: identity,
    allowedApps: ['Excel', 'Billing Manager'], allowedPaths: ['C:\\Clients\\Acme', '%USERPROFILE%\\Reports'],
    closeConnections: async () => { calls.closed++; },
    lockWorkstation: async () => { calls.locked++; },
    reportViolation: async (v) => { calls.reports.push(v); return { ok: true }; },
    ...overrides
  });
  return { guard, calls };
}

test('approved app and in-scope folder pass, and are sanitized', async () => {
  const { guard, calls } = make();
  const r = await guard.handlePayload({ type: 'launch', app: 'C:\\Program Files\\Office\\EXCEL.EXE' });
  assert.equal(r.ok, true);
  assert.equal(r.payload.app, 'EXCEL');
  const p = await guard.handlePayload(JSON.stringify({ type: 'open', path: 'C:/Clients/Acme/Invoices/2026' }));
  assert.equal(p.ok, true);
  assert.equal(p.payload.path, 'c:\\clients\\acme\\invoices\\2026');
  assert.equal(calls.locked, 0);
});

test('catalog alias: "Billing Manager" approves billing_manager.exe', async () => {
  assert.equal(isAppAllowed('billing_manager.exe', ['Billing Manager']), true);
  assert.equal(isAppAllowed('notepad.exe', ['Billing Manager']), false);
});

test('unapproved app => full lockdown in order: close, then lock + report', async () => {
  const order = [];
  const { guard, calls } = make({
    closeConnections: async () => { order.push('close'); },
    lockWorkstation: async () => { order.push('lock'); },
    reportViolation: async (v) => { order.push('report'); calls_reports.push(v); return { ok: true }; }
  });
  const calls_reports = [];
  const r = await guard.handlePayload({ type: 'launch', app: 'notepad.exe' });
  assert.equal(r.breach, true);
  assert.equal(order[0], 'close');
  assert.deepEqual(order.slice(1).sort(), ['lock', 'report']);
  assert.equal(calls_reports[0].kind, 'app');
  assert.equal(calls_reports[0].taskId, 7);
  assert.equal(guard.isLockedDown(), true);
  assert.equal((await guard.handlePayload({ type: 'mouse', x: 1, y: 2 })).reason, 'locked');   // nothing passes afterwards
});

test('shells are never approved, even if the Client somehow listed them', async () => {
  const { guard } = make({ allowedApps: ['cmd', 'PowerShell'] });
  assert.equal((await guard.handlePayload({ app: 'cmd.exe' })).breach, true);
});

test('path traversal, sibling-prefix, other drive, UNC, device path, ADS all breach', async () => {
  for (const bad of [
    'C:\\Clients\\Acme\\..\\Payroll', 'C:\\Clients\\AcmeEvil', 'D:\\Clients\\Acme', 'C:\\Clients',
    '\\\\server\\share\\x', '\\\\?\\C:\\Windows', 'C:\\Clients\\Acme\\file.txt:secret', 'C:\\Windows\\System32'
  ]) {
    const { guard, calls } = make();
    const r = await guard.handlePayload({ type: 'open', path: bad });
    assert.equal(r.breach, true, `should breach: ${bad}`);
    assert.equal(calls.locked, 1, bad);
  }
});

test('Windows quirks: case, trailing dots/spaces and env vars resolve inside the scope', async () => {
  const { guard } = make();
  for (const good of ['c:\\CLIENTS\\acme\\x', 'C:\\Clients\\Acme.\\x', 'C:\\Clients\\Acme \\x', '%USERPROFILE%\\Reports\\q1']) {
    assert.equal((await guard.handlePayload({ path: good })).ok, true, good);
  }
});

test('symlink inside an approved folder pointing outside is a breach', async () => {
  const realpath = (p) => p.replace(/^c:\\clients\\acme\\link/i, 'C:\\Secrets');
  const { guard } = make({ realpath });
  assert.equal((await guard.handlePayload({ path: 'C:\\Clients\\Acme\\link\\x.txt' })).breach, true);
});

test('paths that do not exist yet are still judged lexically (realpath throws)', async () => {
  const { guard } = make({ realpath: () => { throw new Error('ENOENT'); } });
  assert.equal((await guard.handlePayload({ path: 'C:\\Clients\\Acme\\new\\file.txt' })).ok, true);
  assert.equal((await make({ realpath: () => { throw new Error('ENOENT'); } }).guard.handlePayload({ path: 'C:\\Clients\\Acme\\..\\x' })).breach, true);
});

test('field-based gating: renamed command types are still checked', async () => {
  const { guard } = make();
  assert.equal((await guard.handlePayload({ type: 'totally-new-cmd', exe: 'regedit.exe' })).breach, true);
});

test('command line: only the program is judged, quoted paths work', async () => {
  const { guard } = make();
  assert.equal((await guard.handlePayload({ command: '"C:\\Apps\\Billing Manager.exe" /safe' })).ok, true);
  assert.equal((await guard.handlePayload({ command: 'powershell -enc AAAA' })).breach, true);
});

test('malformed payloads are dropped without lockdown', async () => {
  const { guard, calls } = make();
  for (const m of ['not json', '[]', 'null', JSON.stringify({ app: 5 }), JSON.stringify({ path: 'relative\\x' }), 'x'.repeat(9000)]) {
    assert.equal((await guard.handlePayload(m)).ok, false);
  }
  assert.equal(calls.locked, 0);
  assert.equal(guard.isLockedDown(), false);
});

test('no approved folders => every folder request is a breach', async () => {
  const { guard } = make({ allowedPaths: [] });
  assert.equal((await guard.handlePayload({ path: 'C:\\Clients\\Acme' })).breach, true);
});

test('lockdown still reports when the lock command fails, and is idempotent', async () => {
  const { guard, calls } = make({ lockWorkstation: async () => { throw new Error('boom'); } });
  const r = await guard.handlePayload({ app: 'notepad' });
  assert.equal(r.lockdown.locked, false);
  assert.equal(r.lockdown.reported, true);
  const again = await guard.lockdown({ kind: 'app', processName: 'x', detail: 'y' });
  assert.equal(again, r.lockdown);
  assert.equal(calls.reports.length, 1);
});

test('report is retried', async () => {
  let n = 0;
  const { guard } = make({ reportViolation: async () => { if (++n < 3) throw new Error('offline'); return { ok: true }; } });
  const r = await guard.handlePayload({ app: 'notepad' });
  assert.equal(r.lockdown.reported, true);
  assert.equal(n, 3);
});

test('lock command per platform', () => {
  assert.deepEqual(lockCommand('win32', { SystemRoot: 'C:\\Windows' }), { file: 'C:\\Windows\\System32\\rundll32.exe', args: ['user32.dll,LockWorkStation'] });
  assert.equal(lockCommand('darwin', {}).file, '/usr/bin/pmset');
  assert.equal(lockCommand('linux', {}).file, 'loginctl');
});

test('posix guard works too', async () => {
  const { guard } = make({ platform: 'darwin', env: { HOME: '/Users/ann' }, allowedApps: ['Numbers'], allowedPaths: ['/Users/ann/Reports'] });
  assert.equal((await guard.handlePayload({ app: 'Numbers.app', path: '/Users/ann/Reports/q1.numbers' })).ok, true);
  const { guard: g2 } = make({ platform: 'darwin', env: { HOME: '/Users/ann' }, allowedApps: ['Numbers'], allowedPaths: ['/Users/ann/Reports'] });
  assert.equal((await g2.handlePayload({ path: '/Users/ann/Reports/../.ssh/id_rsa' })).breach, true);
});

test('server-side task validation', () => {
  const ok = validateTaskRequest({ vendor_id: 2, task: 'Fix the export in "C:\\Clients\\Acme Corp\\Invoices"', duration_minutes: 30, allowed_apps: ['Billing.EXE', 'excel.app'], alerts_enabled: true });
  assert.deepEqual(ok.value.allowedApps, ['Billing', 'Excel']);
  assert.deepEqual(ok.value.allowedPaths, ['C:\\Clients\\Acme Corp\\Invoices']);
  const base = { vendor_id: 2, task: 'Billing fix', duration_minutes: 30, allowed_apps: ['Excel'], alerts_enabled: false };
  assert.ok(validateTaskRequest({ ...base, vendor_id: null }).error);
  assert.ok(validateTaskRequest({ ...base, allowed_apps: [] }).error);
  assert.ok(validateTaskRequest({ ...base, allowed_apps: ['cmd.exe'] }).error);
  assert.ok(validateTaskRequest({ ...base, duration_minutes: 31 }).error);
  assert.ok(validateTaskRequest({ ...base, alerts_enabled: 'yes' }).error);
  assert.ok(validateTaskRequest({ ...base, task: 'open C:\\' }).error);
  assert.ok(validateTaskRequest({ ...base, task: 'open C:\\a\\..\\b' }).error);
  assert.equal(cleanAppName('Excel.app'), 'Excel');
  assert.deepEqual(extractPaths('no folders here'), []);
});

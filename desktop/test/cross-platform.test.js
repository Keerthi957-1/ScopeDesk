'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const rtc = require('../server/rtc-config');
const { translate, blockedKeyReason } = require('../agent/input-executor');
const { defaultLockWorkstation, lockCommands } = require('../agent/sandbox-guard');
const { createForegroundMonitor } = require('../agent/foreground-monitor');

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const kd = (code, key, mods = {}) => ({ v: 1, t: 'kd', code, key, shift: false, ctrl: false, alt: false, meta: false, ...mods });
const freshState = () => ({ held: new Set(), keys: new Set(), x: 0.5, y: 0.5 });

test('rtc-config: TURN_URL / TURN_PASSWORD aliases, bare turn: URL gets UDP and TCP, username label in minted credentials', async () => {
  const s = rtc.readIceSettings({ TURN_URL: 'turn:t.example.com:3478', TURN_USERNAME: 'u', TURN_PASSWORD: 'p' });
  assert.equal(s.turnReady, true);
  assert.deepEqual(s.turnUrls, ['turn:t.example.com:3478?transport=udp', 'turn:t.example.com:3478?transport=tcp']);
  assert.equal(s.credential, 'p');

  const keep = rtc.readIceSettings({ TURN_URLS: 'turns:t.example.com:5349?transport=tcp,turn:t.example.com:3478?transport=udp', TURN_SECRET: 'x' });
  assert.equal(keep.turnUrls.length, 2);                                   // already specific: untouched

  const now = 1_800_000_000_000;
  const cfg = await rtc.buildRtcConfig({ userId: 4, expiresAtMs: now + 600000 }, { TURN_URL: 'turn:t.example.com:3478', TURN_USERNAME: 'maple co!', TURN_SECRET: 's' }, now);
  assert.match(cfg.iceServers[1].username, /^\d+:mapleco-4$/);
  assert.equal(cfg.relay, true);
});

test('input-executor: Windows vendor Ctrl+C copies on a Mac host, and Ctrl+Q still cannot quit', () => {
  assert.deepEqual(translate(kd('ControlLeft', 'Control', { ctrl: true }), 'darwin', freshState()).commands, [{ op: 'key', kc: 55, down: true }]);
  assert.deepEqual(translate(kd('KeyC', 'c', { ctrl: true }), 'darwin', freshState()).commands, [{ op: 'key', kc: 8, down: true }]);
  assert.ok(blockedKeyReason(kd('KeyQ', 'q', { ctrl: true }), 'darwin'));
  assert.ok(blockedKeyReason(kd('Space', ' ', { ctrl: true }), 'darwin'));
  assert.ok(blockedKeyReason(kd('Tab', 'Tab', { ctrl: true }), 'darwin'));
});

test('input-executor: Mac vendor Cmd+C copies on a Windows host, other Meta use stays blocked', () => {
  const st = freshState();
  const down = translate(kd('KeyC', 'c', { meta: true }), 'win32', st).commands;
  assert.deepEqual(down, [{ op: 'key', vk: 0xA2, ext: false, down: true }, { op: 'key', vk: 0x43, ext: false, down: true }]);
  const up = translate({ ...kd('KeyC', 'c', { meta: true }), t: 'ku' }, 'win32', st).commands;
  assert.deepEqual(up, [{ op: 'key', vk: 0x43, ext: false, down: false }, { op: 'key', vk: 0xA2, ext: false, down: false }]);
  assert.ok(blockedKeyReason(kd('KeyR', 'r', { meta: true }), 'win32'));
  assert.ok(blockedKeyReason(kd('MetaLeft', 'Meta', { meta: true }), 'win32'));
});

test('lock: macOS tries CGSession first and falls back to pmset; Windows uses rundll32', async () => {
  assert.equal(lockCommands('darwin', {}).length, 2);
  const calls = [];
  await defaultLockWorkstation({ platform: 'darwin', env: {}, exec: (file, args, opts, cb) => { calls.push(file); cb(calls.length === 1 ? new Error('missing') : null); } });
  assert.match(calls[0], /CGSession$/);
  assert.equal(calls[1], '/usr/bin/pmset');

  const win = [];
  await defaultLockWorkstation({ platform: 'win32', env: { SystemRoot: 'C:\\Windows' }, exec: (file, args, opts, cb) => { win.push([file, args]); cb(null); } });
  assert.deepEqual(win, [['C:\\Windows\\System32\\rundll32.exe', ['user32.dll,LockWorkStation']]]);

  await assert.rejects(defaultLockWorkstation({ platform: 'darwin', env: {}, exec: (f, a, o, cb) => cb(new Error('nope')) }));
});

function fakeSource() {
  let cb = null;
  return { start(fn) { cb = fn; }, stop() { cb = null; }, push(sample) { if (cb) cb(sample); } };
}

test('foreground monitor (Windows): Explorer in an approved folder is fine, a system folder is a path breach', async () => {
  const source = fakeSource();
  const breaches = [];
  const m = createForegroundMonitor({
    platform: 'win32', env: {}, allowedApps: ['Notepad'], allowedPaths: ['C:\\Users\\ann\\Reports'], realpath: (p) => { throw new Error('nonexistent'); },
    confirmMs: 10, source, onBreach: (v) => breaches.push(v)
  });
  m.start();
  source.push({ name: 'explorer', pid: 1, title: 'Reports', path: 'C:\\Users\\ann\\Reports\\2026' });
  source.push({ name: 'explorer', pid: 1, title: 'Quick access', path: '::{679F85CB-0220-4080-B29B-5540CC05AAB6}' });
  source.push({ name: 'explorer', pid: 1, title: 'This PC', path: '' });
  await wait(40);
  assert.equal(breaches.length, 0);
  source.push({ name: 'explorer', pid: 1, title: 'System32', path: 'C:\\Windows\\System32' });
  await wait(40);
  assert.equal(breaches.length, 1);
  assert.equal(breaches[0].kind, 'path');
  assert.match(breaches[0].detail, /outside the approved folders/);
  m.stop();
});

test('foreground monitor (Windows): a quick pass through a folder (shorter than the confirm time) is not a breach', async () => {
  const source = fakeSource();
  const breaches = [];
  const m = createForegroundMonitor({
    platform: 'win32', env: {}, allowedApps: [], allowedPaths: ['C:\\Users\\ann\\Reports'], realpath: () => { throw new Error('x'); },
    confirmMs: 80, source, onBreach: (v) => breaches.push(v)
  });
  m.start();
  source.push({ name: 'explorer', pid: 1, title: 'Users', path: 'C:\\Users' });
  await wait(10);
  source.push({ name: 'explorer', pid: 1, title: 'Reports', path: 'C:\\Users\\ann\\Reports' });
  await wait(120);
  assert.equal(breaches.length, 0);
  m.stop();
});

test('foreground monitor (macOS): Finder outside the approved folder breaches; an unapproved app is still an app breach', async () => {
  const mk = () => {
    const source = fakeSource(); const breaches = [];
    const m = createForegroundMonitor({ platform: 'darwin', env: { HOME: '/Users/ann' }, allowedApps: ['Numbers'], allowedPaths: ['/Users/ann/Reports'], realpath: (p) => p, confirmMs: 10, source, onBreach: (v) => breaches.push(v) });
    m.start();
    return { source, breaches, m };
  };
  const a = mk();
  a.source.push({ name: 'Finder', pid: 5, title: '', path: '/Users/ann/Reports/Q3' });
  await wait(40);
  assert.equal(a.breaches.length, 0);
  a.source.push({ name: 'Finder', pid: 5, title: '', path: '/System/Library' });
  await wait(40);
  assert.equal(a.breaches[0].kind, 'path');

  const b = mk();
  b.source.push({ name: 'Terminal', pid: 9, title: '', path: '' });
  await wait(40);
  assert.equal(b.breaches[0].kind, 'app');
  const c = mk();
  c.source.push({ name: 'Numbers', pid: 7, title: '', path: '' });
  c.source.push({ name: 'Finder', pid: 5, title: '', path: '' });         // Finder with no readable path (permission not granted): app check only
  await wait(40);
  assert.equal(c.breaches.length, 0);
});

test('foreground monitor: with no approved folders there is no folder policy, so Explorer is only checked as an app', async () => {
  const source = fakeSource(); const breaches = [];
  const m = createForegroundMonitor({ platform: 'win32', env: {}, allowedApps: [], allowedPaths: [], confirmMs: 10, source, onBreach: (v) => breaches.push(v) });
  m.start();
  source.push({ name: 'explorer', pid: 1, title: 'System32', path: 'C:\\Windows\\System32' });
  await wait(40);
  assert.equal(breaches.length, 0);
  m.stop();
});

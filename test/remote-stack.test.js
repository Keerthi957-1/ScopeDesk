'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const IC = require('../public/remote-input-channel');
const { translate, createInputExecutor, blockedKeyReason } = require('../agent/input-executor');
const { createForegroundMonitor } = require('../agent/foreground-monitor');
const { createHostRuntime } = require('../agent/host-runtime');
const rtc = require('../server/rtc-config');

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const kd = (code, key, mods = {}) => ({ v: 1, t: 'kd', code, key, shift: false, ctrl: false, alt: false, meta: false, ...mods });

// ---------- ICE / TURN ----------
test('rtc-config: public STUN by default, TURN with expiring credentials when configured', async () => {
  const stunOnly = await rtc.buildRtcConfig({ userId: 7, expiresAtMs: Date.now() + 3600000 }, {});
  assert.equal(stunOnly.relay, false);
  assert.ok(stunOnly.iceServers[0].urls.includes('stun:stun.l.google.com:19302'));
  assert.equal(stunOnly.iceServers.length, 1);
  assert.match(rtc.describeIceSetup({}), /STUN only/);

  const env = { TURN_URLS: 'turn:t.example.com:3478?transport=udp,turns:t.example.com:5349?transport=tcp,junk', TURN_SECRET: 's3cret', ICE_TRANSPORT_POLICY: 'relay' };
  const now = 1_800_000_000_000;
  const cfg = await rtc.buildRtcConfig({ userId: 7, expiresAtMs: now + 1800000 }, env, now);
  assert.equal(cfg.relay, true);
  assert.equal(cfg.iceTransportPolicy, 'relay');
  const turn = cfg.iceServers[1];
  assert.equal(turn.urls.length, 2);
  const [expiry] = turn.username.split(':');
  assert.equal(Number(expiry), Math.ceil((now + 1800000) / 1000) + 60);
  assert.equal(turn.credential, crypto.createHmac('sha1', 's3cret').update(turn.username).digest('base64'));
  assert.ok(!JSON.stringify(rtc.describeIceSetup(env)).includes('s3cret'));

  // "relay" is ignored without a TURN server, otherwise nothing could ever connect
  assert.equal((await rtc.buildRtcConfig({}, { ICE_TRANSPORT_POLICY: 'relay' })).iceTransportPolicy, 'all');
  assert.equal(rtc.relayConfigured({ TURN_URLS: 'turn:x:3478', TURN_USERNAME: 'u', TURN_CREDENTIAL: 'p' }), true);
  assert.equal(rtc.relayConfigured({ TURN_URLS: 'turn:x:3478' }), false);
});

// ---------- protocol ----------
test('parseInputMessage accepts the protocol and rejects everything else', () => {
  assert.deepEqual(IC.parseInputMessage(JSON.stringify({ v: 1, t: 'mm', x: 2, y: -1, extra: 'x' })), { v: 1, t: 'mm', x: 1, y: 0 });
  assert.equal(IC.parseInputMessage(JSON.stringify({ v: 1, t: 'md', x: 0.5, y: 0.5, b: 3 })), null);
  assert.equal(IC.parseInputMessage(JSON.stringify({ v: 2, t: 'mm', x: 0, y: 0 })), null);
  assert.equal(IC.parseInputMessage('{not json'), null);
  assert.equal(IC.parseInputMessage(JSON.stringify({ v: 1, t: 'mm', x: 'a', y: 0 })), null);
  assert.equal(IC.parseInputMessage(JSON.stringify({ v: 1, t: 'kd', code: 'Key A; rm -rf', key: 'a' })), null);
  assert.equal(IC.parseInputMessage(JSON.stringify({ v: 1, t: 'kd', code: 'KeyA', key: 'a&&calc.exe' })), null);
  assert.equal(IC.parseInputMessage('x'.repeat(2000)), null);
  assert.equal(IC.parseInputMessage(JSON.stringify({ v: 1, t: 'wh', dx: 0, dy: 99999 })).dy, 2000);
  assert.deepEqual(IC.parseInputMessage(kd('Enter', 'Enter')), { v: 1, t: 'kd', code: 'Enter', key: 'Enter', shift: false, ctrl: false, alt: false, meta: false });
});

test('mapPointer scales to the real screen picture, even when the video is letter-boxed', () => {
  const rect = { left: 100, top: 50, width: 1000, height: 1000 };      // square element, 1920x1080 picture -> bars above and below
  const centre = IC.mapPointer(600, 550, rect, 1920, 1080);
  assert.ok(Math.abs(centre.x - 0.5) < 1e-9 && Math.abs(centre.y - 0.5) < 1e-9);
  assert.equal(IC.mapPointer(600, 60, rect, 1920, 1080), null);          // on the black bar
  const topLeft = IC.mapPointer(100, 50 + (1000 - 562.5) / 2, rect, 1920, 1080);
  assert.ok(topLeft.x < 1e-9 && topLeft.y < 1e-9);
  assert.equal(IC.mapPointer(10, 10, rect, 0, 0), null);
});

test('createCapture sends clicks, throttled moves, wheel and key strings; releases keys on blur', () => {
  const handlers = {};
  const mk = () => ({ addEventListener: (n, f) => { handlers[n] = f; }, removeEventListener: (n) => { delete handlers[n]; }, setAttribute() {}, focus() {} });
  const surface = mk(); surface.ownerDocument = mk();
  const docHandlers = handlers; // shared map is fine for this test
  const video = { videoWidth: 1920, videoHeight: 1080, getBoundingClientRect: () => ({ left: 0, top: 0, width: 960, height: 540 }) };
  const sent = [];
  let t = 1000;
  const cap = IC.createCapture({ surface, video, send: (m, kind) => { sent.push({ m: JSON.parse(m), kind }); return true; }, now: () => t, moveIntervalMs: 16 });
  const ev = (o) => ({ preventDefault() {}, ...o });

  handlers.mousemove(ev({ clientX: 480, clientY: 270 }));
  assert.deepEqual(sent[0], { m: { v: 1, t: 'mm', x: 0.5, y: 0.5 }, kind: 'pointer' });
  handlers.mousedown(ev({ clientX: 96, clientY: 54, button: 0 }));
  assert.deepEqual(sent[1].m, { v: 1, t: 'md', x: 0.1, y: 0.1, b: 0 });
  assert.equal(sent[1].kind, 'reliable');
  handlers.mouseup(ev({ clientX: 96, clientY: 54, button: 0 }));
  assert.equal(sent[2].m.t, 'mu');
  handlers.wheel(ev({ clientX: 480, clientY: 270, deltaX: 0, deltaY: 100, deltaMode: 0 }));
  assert.deepEqual(sent[3].m, { v: 1, t: 'wh', dx: 0, dy: 100 });
  handlers.keydown(ev({ code: 'KeyA', key: 'a', shiftKey: false, ctrlKey: false, altKey: false, metaKey: false }));
  assert.equal(sent[4].m.code, 'KeyA');
  handlers.blur();
  assert.equal(sent[5].m.t, 'ku');          // the held key is released
  assert.equal(sent[6].m.t, 'rel');
  cap.detach();
  assert.equal(handlers.mousemove, undefined);
  assert.ok(sent.every((s) => IC.parseInputMessage(s.m)), 'everything the vendor sends passes the host validator');
});

// ---------- translation to native input ----------
test('translate: Windows scales to 0..65535 and types printable characters layout-independently', () => {
  const state = { held: new Set(), keys: new Set(), x: 0, y: 0 };
  assert.deepEqual(translate({ v: 1, t: 'mm', x: 0.5, y: 1 }, 'win32', state).commands, [{ op: 'move', x: 32768, y: 65535 }]);
  assert.deepEqual(translate({ v: 1, t: 'md', x: 0, y: 0, b: 2 }, 'win32', state).commands, [{ op: 'move', x: 0, y: 0 }, { op: 'btn', b: 2, down: true }]);
  assert.deepEqual(translate(kd('KeyZ', 'y'), 'win32', state).commands, [{ op: 'char', cp: 121, down: true }]);
  assert.deepEqual(translate(kd('KeyC', 'c', { ctrl: true }), 'win32', state).commands, [{ op: 'key', vk: 0x43, ext: false, down: true }]);
  assert.deepEqual(translate(kd('ArrowLeft', 'ArrowLeft'), 'win32', state).commands, [{ op: 'key', vk: 0x25, ext: true, down: true }]);
  assert.deepEqual(translate({ v: 1, t: 'wh', dx: 0, dy: 100 }, 'win32', state).commands, [{ op: 'wheel', dx: 0, dy: -120 }]);
});

test('translate: macOS and Linux use their own key tables', () => {
  const s1 = { held: new Set(), keys: new Set(), x: 0, y: 0 };
  assert.deepEqual(translate(kd('KeyA', 'a'), 'darwin', s1).commands, [{ op: 'key', kc: 0, down: true }]);
  const s2 = { held: new Set(), keys: new Set(), x: 0, y: 0 };
  assert.deepEqual(translate(kd('Enter', 'Enter'), 'linux', s2).commands, [{ op: 'key', sym: 'Return', down: true }]);
  assert.deepEqual(translate(kd('KeyQ', 'q'), 'linux', s2).commands, [{ op: 'text', ch: 'q', down: true }]);
  assert.equal(translate(kd('F99', 'F99'), 'linux', s2).dropped, 'Unknown key F99.');
});

test('dangerous shortcuts are never injected', () => {
  assert.ok(blockedKeyReason(kd('MetaLeft', 'Meta', { meta: true }), 'win32'));
  assert.ok(blockedKeyReason(kd('KeyR', 'r', { meta: true }), 'win32'));
  assert.ok(blockedKeyReason(kd('Tab', 'Tab', { alt: true }), 'win32'));
  assert.ok(blockedKeyReason(kd('F4', 'F4', { alt: true }), 'linux'));
  assert.ok(blockedKeyReason(kd('Escape', 'Escape', { ctrl: true, shift: true }), 'win32'));
  assert.ok(blockedKeyReason(kd('KeyQ', 'q', { meta: true }), 'darwin'));
  assert.ok(blockedKeyReason(kd('Space', ' ', { meta: true }), 'darwin'));
  assert.equal(blockedKeyReason(kd('KeyC', 'c', { meta: true }), 'darwin'), null);   // Cmd+C is fine
  assert.equal(blockedKeyReason(kd('KeyC', 'c', { ctrl: true }), 'win32'), null);
});

test('executor: sends to the backend, drops blocked keys, releases everything on close, rate limits moves', () => {
  const sent = [];
  let t = 0;
  const ex = createInputExecutor({ platform: 'win32', backend: { send: (c) => sent.push(c), close() { sent.push('closed'); } }, now: () => t });
  assert.equal(ex.execute(JSON.stringify({ v: 1, t: 'md', x: 0.5, y: 0.5, b: 0 })).ok, true);
  assert.equal(ex.execute(kd('ShiftLeft', 'Shift')).ok, true);
  assert.equal(ex.execute(kd('MetaLeft', 'Meta', { meta: true })).ok, false);
  assert.equal(ex.execute('garbage').reason, 'invalid-message');
  assert.ok(ex.lastInputAt() >= 0);
  let accepted = 0;
  for (let i = 0; i < 1000; i++) if (ex.execute({ v: 1, t: 'mm', x: 0.1, y: 0.1 }).ok) accepted++;
  assert.ok(accepted < 450, `moves are rate limited (accepted ${accepted})`);
  sent.length = 0;
  ex.close();
  assert.ok(sent.some((c) => c.op === 'btn' && c.down === false), 'the held button is released');
  assert.ok(sent.some((c) => c.op === 'key' && c.vk === 0xA0 && c.down === false), 'the held key is released');
  assert.equal(sent[sent.length - 1], 'closed');
  assert.equal(ex.execute({ v: 1, t: 'mm', x: 0, y: 0 }).ok, false);
});

test('executor refuses Wayland sessions instead of pretending', () => {
  const ex = createInputExecutor({ platform: 'linux', env: { XDG_SESSION_TYPE: 'wayland' } });
  assert.match(ex.execute({ v: 1, t: 'mm', x: 0, y: 0 }).reason, /Wayland/);
});

// ---------- foreground monitor ----------
function fakeSource() {
  let cb = null; const s = { started: false, stopped: false };
  return { start(fn) { cb = fn; s.started = true; }, stop() { s.stopped = true; }, emit: (name, title = '') => cb && cb({ name, pid: 1, title }), s };
}

test('monitor: allowed apps (filemanager, calculator, whatsapp, notepad) never trigger; a terminal does', async () => {
  const src = fakeSource(); const breaches = [];
  const m = createForegroundMonitor({ allowedApps: ['filemanager', 'calculator', 'whatsapp', 'notepad'], source: src, confirmMs: 20, onBreach: (v) => breaches.push(v) });
  m.start();
  for (const name of ['explorer', 'CalculatorApp', 'WhatsApp', 'notepad', '', 'TextInputHost', 'ApplicationFrameHost']) { src.emit(name); await wait(40); }
  assert.equal(breaches.length, 0);
  src.emit('WindowsTerminal', 'Administrator: PowerShell');
  await wait(60);
  assert.equal(breaches.length, 1);
  assert.equal(breaches[0].kind, 'app');
  assert.equal(breaches[0].processName, 'WindowsTerminal');
  assert.match(breaches[0].detail, /not in the approved applications/);
  assert.equal(src.s.stopped, true);
  src.emit('cmd'); await wait(60);
  assert.equal(breaches.length, 1, 'a breach is reported exactly once');
});

test('monitor: a window that flickers past is not a breach, cmd is never allowed even if listed', async () => {
  const src = fakeSource(); const breaches = [];
  const m = createForegroundMonitor({ allowedApps: ['notepad', 'cmd'], source: src, confirmMs: 50, onBreach: (v) => breaches.push(v) });
  m.start();
  src.emit('chrome'); await wait(15); src.emit('notepad'); await wait(80);
  assert.equal(breaches.length, 0);
  src.emit('cmd'); await wait(90);
  assert.equal(breaches[0].processName, 'cmd');
});

test('monitor: ScopeDesk itself is fine for the Client but a breach right after vendor input', async () => {
  const src = fakeSource(); const breaches = [];
  let lastInput = 0;
  const m = createForegroundMonitor({ allowedApps: ['notepad'], source: src, confirmMs: 20, getLastInputAt: () => lastInput, onBreach: (v) => breaches.push(v) });
  m.start();
  src.emit('ScopeDesk'); await wait(40);
  assert.equal(breaches.length, 0);
  lastInput = Date.now();
  src.emit('ScopeDesk'); await wait(60);
  assert.equal(breaches.length, 1);
});

test('monitor stops at the end of the approved window', async () => {
  const src = fakeSource();
  const m = createForegroundMonitor({ allowedApps: [], source: src, endsAt: Date.now() + 30, confirmMs: 5, onBreach() { assert.fail('no breach after the window'); } });
  m.start();
  await wait(70);
  assert.equal(m.isRunning(), false);
  assert.equal(src.s.stopped, true);
});

// ---------- the full breach sequence ----------
test('breach sequence: tracks cut, PC locked, server told, input stops, in that order', async () => {
  const order = [];
  const src = fakeSource();
  const rt = createHostRuntime({
    scope: { taskId: 42, allowedApps: ['filemanager', 'calculator', 'whatsapp', 'notepad'], allowedPaths: [], endsAt: Date.now() + 60000 },
    platform: 'win32', confirmMs: 20, monitorSource: src,
    executor: { lastInputAt: () => 0, close: () => order.push('input-closed'), execute: () => ({ ok: true }) },
    closeConnections: async () => { order.push('connections-closed'); },
    lockWorkstation: async () => { order.push('locked'); },
    reportViolation: async (v) => { order.push('reported:' + v.processName); return { ok: true }; },
    onLockdown: (v) => order.push('alert:' + v.kind)
  });
  rt.start();
  src.emit('WindowsTerminal'); await wait(120);
  assert.deepEqual(order.slice(0, 2), ['input-closed', 'connections-closed']);
  assert.ok(order.includes('locked') && order.includes('reported:WindowsTerminal'));
  assert.equal(order[order.length - 1], 'alert:app');
  assert.equal(rt.isLockedDown(), true);
  // after the lockdown nothing the vendor sends is executed
  assert.equal((await rt.handleChannelMessage(JSON.stringify({ v: 1, t: 'mm', x: 0, y: 0 }))).ok, false);
});

test('runtime: data-channel input is guarded; an execution request for an unapproved app is a breach', async () => {
  const executed = []; let reported = null;
  const rt = createHostRuntime({
    scope: { taskId: 5, allowedApps: ['notepad'], allowedPaths: [] }, platform: 'linux', monitorSource: fakeSource(),
    executor: { lastInputAt: () => 0, close() {}, execute: (m) => { executed.push(m); return { ok: true }; } },
    closeConnections: async () => {}, lockWorkstation: async () => {}, reportViolation: async (v) => { reported = v; return { ok: true }; }
  });
  assert.equal((await rt.handleChannelMessage(JSON.stringify({ v: 1, t: 'mm', x: 0.2, y: 0.3 }))).ok, true);
  assert.equal(executed.length, 1);
  const r = await rt.handleChannelMessage(JSON.stringify({ v: 1, t: 'kd', code: 'KeyA', key: 'a', cmd: 'powershell.exe' }));
  assert.equal(r.breach, true);
  assert.equal(reported.kind, 'app');
  assert.equal(executed.length, 1);
});

// ---------- Electron glue (fake Electron) ----------
test('electron glue: start fetches the scope, input is guarded, lockdown cuts the page and alerts', async () => {
  const { registerHostIpc, exposeHostApi, CHANNELS } = require('../agent/electron-glue');
  const handlers = {}; const listeners = {}; const sentToPage = []; const notes = [];
  const ipcMain = { handle: (c, f) => { handlers[c] = f; }, on: (c, f) => { listeners[c] = f; } };
  const win = { isDestroyed: () => false, webContents: { isDestroyed: () => false, send: (c, p) => sentToPage.push([c, p]) }, isMinimized: () => false, restore() {}, show() {}, setAlwaysOnTop() {}, setFullScreen() {}, focus() {} };
  const reports = [];
  const socket = { once(ev, f) { if (ev === 'connect') setImmediate(f); }, timeout: () => ({ emitWithAck: async (n, v) => { reports.push([n, v]); return { ok: true }; } }), disconnect() {} };
  class Notif { constructor(o) { notes.push(o); } show() {} }
  const glue = registerHostIpc({
    ipcMain, getWindow: () => win, serverUrl: 'http://srv', Notification: Notif, io: () => () => socket,
    fetch: async (url, o) => ({ ok: true, status: 200, json: async () => ({ taskId: 9, allowedApps: ['Notepad'], allowedPaths: [], alertsEnabled: true, endsAt: Date.now() + 60000 }) })
  });
  const bad = await handlers[CHANNELS.start]({}, { taskId: 'x', agentToken: '' });
  assert.equal(bad.ok, false);
  const r = await handlers[CHANNELS.start]({}, { taskId: 9, agentToken: 'tok' });
  assert.equal(r.ok, true);
  assert.equal(glue.isRunning(), true);
  // an out-of-scope execution request arrives over the data channel
  listeners[CHANNELS.input]({}, JSON.stringify({ v: 1, t: 'mm', x: 0, y: 0, run: 'powershell.exe' }));
  await wait(900);   // the glue gives the page 400 ms to stop its tracks before the alert
  assert.ok(sentToPage.some(([c]) => c === CHANNELS.closeRtc), 'the page is told to stop every track');
  assert.ok(sentToPage.some(([c]) => c === CHANNELS.lockdown), 'the page shows the full-screen alert');
  assert.equal(notes[0].timeoutType, 'never');
  assert.equal(reports[0][0], 'host-violation');
  await handlers[CHANNELS.stop]();
  assert.equal(glue.isRunning(), false);

  const exposed = {};
  exposeHostApi({ contextBridge: { exposeInMainWorld: (k, v) => { exposed[k] = v; } }, ipcRenderer: { invoke() {}, send() {}, on() {} } });
  assert.deepEqual(Object.keys(exposed.scopedeskHost).sort(), ['hostInput', 'hostStart', 'hostStop', 'listInstalledApps', 'onCloseRtc', 'onLockdown']);
});

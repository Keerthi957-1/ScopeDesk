'use strict';
// Remote-control lifecycle on the SERVER (server/remote-control.js with a fake Socket.IO + database) and in the BROWSER
// (public/webrtc.js and public/desktop-bridge.js in a VM with fake RTCPeerConnection / data channels / desktop bridge).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const createRemoteControl = require('../server/remote-control');

const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- server ----------------------------------------------------------
function server({ taskStatus = 'active' } = {}) {
  const delivered = [];                                   // what each socket id received
  const toTask = [];                                      // emitToTask(...)
  const audit = [];
  const logs = [];
  const sockets = new Map();
  const io = { to: (id) => ({ emit: (ev, p) => delivered.push({ id, ev, p }) }), sockets: { sockets } };
  const db = { get: async () => ({ id: 7, title: 't', target_process: 'Word', task_type: '', allowed_paths: '[]', allowed_apps: '["Word"]', window_end: new Date(Date.now() + 60000).toISOString(), status: taskStatus }) };
  const authorizeRtc = async (user, taskId) => (taskId !== 7 ? null : user.role === 'client' && user.userId === 1 ? 'client' : user.role === 'vendor' && user.userId === 2 ? 'vendor' : null);
  const rc = createRemoteControl({
    io, db, authorizeRtc, verifyToken: () => null, timers: { ensure: async () => true, cancel() {} },
    emitToTask: async (taskId, ev, p) => { toTask.push({ taskId, ev, p }); },
    onControlChange: (c) => audit.push(c), log: (m) => logs.push(m)
  });
  const mk = (id, data, user) => {
    const h = {}; const out = [];
    const s = { id, data: { ...data, user }, on: (ev, fn) => { h[ev] = fn; }, emit: (ev, p) => out.push({ ev, p }), disconnect() { if (h.disconnect) h.disconnect('server'); } };
    sockets.set(id, s);
    return { s, h, out, call: (ev, p) => new Promise((resolve) => { const r = h[ev](p, resolve); if (r && r.then && h[ev].length < 2) r.then(resolve); }) };
  };
  const client = mk('c1', {}, { userId: 1, role: 'client' }); rc.registerBrowser(client.s, client.s.data.user);
  const vendor = mk('v1', {}, { userId: 2, role: 'vendor' }); rc.registerBrowser(vendor.s, vendor.s.data.user);
  const agent = () => { const a = mk('a' + sockets.size, { agent: { taskId: 7 } }, { userId: 1, role: 'client' }); rc.registerAgent(a.s); return a; };
  const input = async (e) => { vendor.h['remote-input']({ taskId: 7, e }); await tick(); };
  const agentInputs = (a) => delivered.filter((d) => d.id === a.s.id && d.ev === 'remote-input');
  return { rc, client, vendor, agent, input, agentInputs, delivered, toTask, audit, logs };
}

test('server: start then stop. Input flows while started, is refused at once after Stop, the agent is told, the reason is recorded', async () => {
  const S = server();
  const a = S.agent();
  assert.equal((await S.client.call('remote-control', { taskId: 7, action: 'start' })).ok, true);
  assert.equal((await a.call('agent-hello', {})).ok, true);
  await S.input({ t: 'down', x: 0.5, y: 0.5, b: 0 });
  await S.input({ t: 'key', k: 'KeyA', d: true });
  assert.deepEqual(S.agentInputs(a).map((d) => d.p.t), ['down', 'key']);

  const stop = await S.client.call('remote-control', { taskId: 7, action: 'stop' });
  assert.equal(stop.ok, true);
  assert.ok(S.delivered.some((d) => d.id === a.s.id && d.ev === 'control-halt' && d.p.reason === 'revoked'));
  await S.input({ t: 'down', x: 0.5, y: 0.5, b: 0 });
  assert.equal(S.agentInputs(a).length, 2);                                       // nothing after Stop
  assert.deepEqual(S.toTask.filter((e) => e.ev === 'control-state').map((e) => e.p.active), [true, false]);
  assert.deepEqual(S.audit.map((x) => x.reason), ['client_started', 'client_stopped']);
  // an old agent that reconnects after Stop is refused
  assert.equal((await S.agent().call('agent-hello', {})).ok, false);
  // privacy: the diagnostics never contain an input event
  assert.ok(S.logs.every((l) => !/KeyA|0\.5/.test(l)), S.logs.join('\n'));
});

test('server: duplicate Start / Stop requests are idempotent (no second announcement, no second audit row)', async () => {
  const S = server();
  await S.client.call('remote-control', { taskId: 7, action: 'start' });
  const again = await S.client.call('remote-control', { taskId: 7, action: 'start' });
  assert.equal(again.unchanged, true);
  await S.client.call('remote-control', { taskId: 7, action: 'stop' });
  await S.client.call('remote-control', { taskId: 7, action: 'stop' });
  assert.equal(S.toTask.filter((e) => e.ev === 'control-state').length, 2);
  assert.equal(S.audit.length, 2);
});

test('server: only the owning Client of an active task may start/stop; a vendor cannot', async () => {
  const S = server();
  assert.equal((await S.vendor.call('remote-control', { taskId: 7, action: 'start' })).ok, false);
  assert.equal((await S.client.call('remote-control', { taskId: 8, action: 'start' })).ok, false);
  assert.equal((await S.client.call('remote-control', { taskId: 7, action: 'reboot' })).ok, false);
});

test('server: host agent disconnected -> the vendor is told the input was not delivered (never silent)', async () => {
  const S = server();
  const a = S.agent();
  await a.call('agent-hello', {});
  a.s.disconnect();
  await S.input({ t: 'down', x: 0.1, y: 0.1, b: 0 });
  assert.ok(S.vendor.out.some((o) => o.ev === 'input-undeliverable'));
  assert.ok(S.toTask.some((e) => e.ev === 'agent-status' && e.p.online === false));
});

test('server: session expiry / termination (teardown) halts input and a later Start is refused', async () => {
  const S = server();
  const a = S.agent();
  await S.client.call('remote-control', { taskId: 7, action: 'start' });
  await a.call('agent-hello', {});
  S.rc.teardown(7, 'time_expired');
  assert.ok(S.delivered.some((d) => d.id === a.s.id && d.ev === 'control-halt' && d.p.reason === 'ended' && d.p.endReason === 'time_expired'));
  await S.input({ t: 'move', x: 0.2, y: 0.2 });
  assert.equal(S.agentInputs(a).length, 0);
  assert.equal((await S.client.call('remote-control', { taskId: 7, action: 'start' })).ok, false);
  assert.ok(S.logs.some((l) => /session closed: time_expired/.test(l)));
});

test('server: host agent sockets are not registered as the Client user (other tasks\' events must not reach them)', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const conn = src.slice(src.indexOf("io.on('connection'"), src.indexOf("remoteControl.registerBrowser(socket, user);"));
  const agentBranch = conn.indexOf('if (socket.data.agent)');
  const add = conn.indexOf('addSocket(user.userId, socket.id)');
  assert.ok(agentBranch > 0 && add > agentBranch, 'addSocket must come after the agent branch returns');
});

// ---------------------------------------------------------------- browser ---------------------------------------------------------
const RTC_SRC = fs.readFileSync(path.join(__dirname, '..', 'public', 'webrtc.js'), 'utf8');
const CFG = { iceServers: [{ urls: ['stun:stun.l.google.com:19302'] }], iceTransportPolicy: 'all', relay: false };

function browser({ role, desktop = null, agentStatusAck = { ok: true, online: true, state: 'armed' } }) {
  const peers = []; const sent = []; const handlers = {}; const views = [];
  class FakeChannel {
    constructor(label) { this.label = label; this.readyState = 'connecting'; this.out = []; }
    send(m) { if (this.readyState !== 'open') throw new Error('not open'); this.out.push(m); }
    close() { this.readyState = 'closed'; if (this.onclose) this.onclose(); }
    open() { this.readyState = 'open'; if (this.onopen) this.onopen(); }
  }
  class FakePC {
    constructor() { this.connectionState = 'new'; this.signalingState = 'stable'; this.channels = []; peers.push(this); }
    addTrack() { return { track: { kind: 'video' }, getParameters: () => ({}), setParameters: async () => {} }; }
    createDataChannel(label) { const c = new FakeChannel(label); this.channels.push(c); return c; }
    async createOffer() { return { type: 'offer', sdp: 'v=0\na=fingerprint:sha-256 H' }; }
    async createAnswer() { return { type: 'answer', sdp: 'v=0\na=fingerprint:sha-256 V' }; }
    async setLocalDescription(d) { this.localDescription = d; this.signalingState = d.type === 'offer' ? 'have-local-offer' : 'stable'; }
    async setRemoteDescription(d) { this.remoteDescription = d; }
    async addIceCandidate() {}
    setConfiguration() {} getStats() { return Promise.resolve(new Map()); }
    close() { this.connectionState = 'closed'; }
  }
  let pendingAgentAck = null;
  const socket = {
    connected: true, volatile: null,
    on: (ev, fn) => { handlers[ev] = fn; },
    emit: (ev, payload, ack) => {
      sent.push({ ev, payload });
      if (ev === 'webrtc-join' && ack) ack({ ok: true, peers: role === 'host' ? ['vendor'] : ['client'] });
      else if (ev === 'agent-status' && ack) { if (agentStatusAck === 'defer') pendingAgentAck = ack; else ack(agentStatusAck); }
    }
  };
  socket.volatile = socket;
  const stream = { getTracks: () => [{ kind: 'video', stop() {} }], getVideoTracks: () => [{ contentHint: '', getSettings: () => ({ displaySurface: 'monitor' }) }] };
  const win = { addEventListener() {}, scopedeskDesktop: desktop };
  win.ScopeDeskInput = { attach: (o) => { win.__send = o.send; return () => { win.__send = null; }; } };   // remote-input.js stand-in
  const ctx = vm.createContext({ window: win, navigator: { mediaDevices: { getDisplayMedia: async () => stream } }, console: { log() {} }, RTCPeerConnection: FakePC, setTimeout, clearTimeout, setInterval: (f, ms) => { const t = setInterval(f, ms); if (t.unref) t.unref(); return t; }, clearInterval, Promise, JSON, Date, Math, Object, Array, String, Number });
  vm.runInContext(RTC_SRC, ctx);
  const rtc = win.ScopeDeskRTC;
  rtc.init({ api: async () => CFG, onChange: (v) => views.push(v) });
  rtc.bindSocket(socket);
  return { rtc, peers, sent, handlers, views, view: () => views[views.length - 1], FakeChannel, send: (e, vol) => win.__send(e, vol), releaseAgentAck: (a) => pendingAgentAck && pendingAgentAck(a) };
}
const stage = { addEventListener() {}, removeEventListener() {}, focus() {}, setPointerCapture() {} };

test('browser/vendor: data channel never opens -> input uses the server relay; once open + bridge ready -> the channel', async () => {
  const B = browser({ role: 'viewer' });
  await B.rtc.startViewer(7, { video: {}, stage, rtcConfig: CFG });
  assert.equal(B.view().input, 'relay');                                          // armed agent, no channel: server relay
  B.send({ t: 'down', x: 0.5, y: 0.5, b: 0 });
  assert.equal(B.sent.filter((m) => m.ev === 'remote-input').length, 1);

  // the Client's offer brings 'ctl' + 'mv'; they open, the host says its bridge is ready
  B.handlers['webrtc-signal']({ taskId: 7, type: 'offer', offer: { type: 'offer', sdp: 'v=0\na=fingerprint:sha-256 H' } });
  await tick(20);
  const pc = B.peers[B.peers.length - 1];
  const ctl = new B.FakeChannel('ctl'); const mv = new B.FakeChannel('mv');
  pc.ondatachannel({ channel: ctl }); pc.ondatachannel({ channel: mv });
  ctl.open(); mv.open();
  ctl.onmessage({ data: JSON.stringify({ t: 'bridge', ready: true }) });
  assert.equal(B.view().input, 'channel');
  B.send({ t: 'key', k: 'KeyA', d: true });
  B.send({ t: 'move', x: 0.1, y: 0.1 }, true);
  assert.equal(ctl.out.length, 1); assert.equal(mv.out.length, 1);
  assert.equal(B.sent.filter((m) => m.ev === 'remote-input').length, 1);          // nothing more went through the relay

  // the channel fails mid-session: back to the relay, never a silent drop
  ctl.close();
  assert.equal(B.view().input, 'relay');
  B.send({ t: 'key', k: 'KeyA', d: false });
  assert.equal(B.sent.filter((m) => m.ev === 'remote-input').length, 2);
});

test('browser/vendor: Client stops remote control -> nothing is sent on any path; Start re-enables it', async () => {
  const B = browser({ role: 'viewer' });
  await B.rtc.startViewer(7, { video: {}, stage, rtcConfig: CFG });
  B.handlers['control-state']({ taskId: 7, active: false, reason: 'client_stopped' });
  assert.equal(B.view().stopped, true);
  assert.equal(B.view().input, 'none');
  assert.equal(B.send({ t: 'down', x: 0.5, y: 0.5, b: 0 }), false);
  assert.equal(B.sent.filter((m) => m.ev === 'remote-input').length, 0);
  B.handlers['control-state']({ taskId: 8, active: true });                      // another task: ignored
  assert.equal(B.view().stopped, true);
  B.handlers['control-state']({ taskId: 7, active: true, reason: 'client_started' });
  assert.equal(B.view().input, 'relay');
});

test('browser/vendor: a slow agent-status reply cannot overwrite a newer live agent-state (stale status event)', async () => {
  const B = browser({ role: 'viewer', agentStatusAck: 'defer' });
  const started = B.rtc.startViewer(7, { video: {}, stage, rtcConfig: CFG });
  await tick();
  B.handlers['agent-state']({ taskId: 7, state: 'armed', policy: 'p' });          // live event arrives first
  B.releaseAgentAck({ ok: true, online: true, state: 'waiting' });                 // older snapshot arrives later
  await started;
  assert.equal(B.view().agent, 'armed');
});

test('browser/client: frames are forwarded to the agent only while it is running + input-ready; stale desktop status is ignored; Stop cuts it', async () => {
  const forwarded = []; const listeners = [];
  const desktop = {
    isDesktop: true,
    onAgentStatus: (cb) => listeners.push(cb),
    getAgentStatus: () => new Promise(() => {}),
    onLockout() {},
    sendInput: (f) => forwarded.push(f)
  };
  const push = (s) => listeners.forEach((cb) => cb(s));
  const B = browser({ role: 'host', desktop });
  await B.rtc.startHost(7);
  await tick(20);
  const pc = B.peers[0];
  const ctl = pc.channels.find((c) => c.label === 'ctl');
  const mv = pc.channels.find((c) => c.label === 'mv');
  ctl.open(); mv.open();
  ctl.onmessage({ data: '{"t":"down","x":0.5,"y":0.5,"b":0}' });
  assert.equal(forwarded.length, 0);                                               // agent not running yet: nothing forwarded
  push({ seq: 3, phase: 'running', inputReady: true });
  assert.equal(JSON.parse(ctl.out[ctl.out.length - 1]).ready, true);              // the vendor is told the bridge is ready
  mv.onmessage({ data: '{"t":"move","x":0.5,"y":0.5}' });
  ctl.onmessage({ data: '{"t":"key","k":"KeyA","d":true}' });
  assert.equal(forwarded.length, 2);
  push({ seq: 2, phase: 'stopped', inputReady: false });                           // late, older status: ignored
  ctl.onmessage({ data: '{"t":"key","k":"KeyA","d":false}' });
  assert.equal(forwarded.length, 3);
  B.handlers['control-state']({ taskId: 7, active: false, reason: 'client_stopped' });
  assert.equal(JSON.parse(ctl.out[ctl.out.length - 1]).ready, false);
  ctl.onmessage({ data: '{"t":"key","k":"KeyB","d":true}' });
  assert.equal(forwarded.length, 3);                                               // refused after Stop
  push({ seq: 4, phase: 'stopped', inputReady: false });
  B.handlers['webrtc-close']({ taskId: 7, reason: 'client_terminated' });         // session terminated: channels closed, capture stopped
  assert.equal(ctl.readyState, 'closed');
  assert.equal(B.rtc.current().role, null);
});

test('browser/desktop-bridge: one authoritative status, older sequence numbers never flip it back', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'desktop-bridge.js'), 'utf8');
  let cb = null;
  const win = { scopedeskDesktop: { isDesktop: true, onAgentStatus: (f) => { cb = f; }, getAgentStatus: () => Promise.resolve(null) } };
  vm.runInContext(src, vm.createContext({ window: win, console: { log() {} }, Promise }));
  const seen = [];
  win.ScopeDeskDesktop.onStatus((s) => seen.push(s.phase));
  cb({ seq: 5, phase: 'running', taskId: 7 });
  cb({ seq: 4, phase: 'stopped', taskId: 7 });        // stale reply
  cb({ seq: 5, phase: 'stopped', taskId: 7 });        // duplicate
  assert.deepEqual(seen, ['running']);
  assert.equal(win.ScopeDeskDesktop.getStatus().phase, 'running');
});

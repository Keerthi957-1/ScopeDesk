'use strict';
// The browser side of remote control (public/webrtc.js, remote-input.js, desktop-bridge.js) run in a vm sandbox with fake sockets,
// fake WebRTC and a fake desktop app. Nothing here touches a real network or operating system, so it proves the routing and the
// state rules, not that a real mouse moves (see the manual test in the README for that).
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('vm');
const fs = require('fs');
const path = require('path');

const PUB = path.join(__dirname, '..', 'public');
const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));

function fakeSocket() {
  const handlers = {}; const sent = [];
  const s = {
    connected: true, sent, handlers,
    on(ev, fn) { (handlers[ev] = handlers[ev] || []).push(fn); return s; },
    emit(ev, payload, ack) {
      sent.push({ ev, payload });
      if (typeof ack === 'function') {
        if (ev === 'webrtc-join') ack({ ok: true, peers: s.peers || [] });
        else if (ev === 'agent-status') ack({ ok: true, online: s.agentOnline !== false, state: s.agentState || 'armed', halted: null });
        else ack({ ok: true });
      }
    },
    volatile: null,
    trigger(ev, data) { (handlers[ev] || []).forEach((fn) => fn(data)); }
  };
  s.volatile = { emit: (ev, p) => s.emit(ev, p) };
  return s;
}

function fakeChannel(label, open = true) {
  return { label, readyState: open ? 'open' : 'connecting', sent: [], send(d) { if (this.readyState !== 'open') throw new Error('not open'); this.sent.push(d); }, close() { this.readyState = 'closed'; if (this.onclose) this.onclose(); } };
}

function fakePeerClass(made) {
  return class FakePC {
    constructor() { this.connectionState = 'new'; this.signalingState = 'stable'; this.channels = []; made.push(this); }
    addTrack(t) { return { track: t, getParameters: () => ({}), setParameters: () => Promise.resolve() }; }
    createDataChannel(label) { const c = fakeChannel(label); this.channels.push(c); return c; }
    async createOffer() { return { type: 'offer', sdp: 'v=0\r\na=fingerprint:sha-256 AA:BB\r\n' }; }
    async createAnswer() { return { type: 'answer', sdp: 'v=0\r\na=fingerprint:sha-256 CC:DD\r\n' }; }
    async setLocalDescription(d) { this.localDescription = d; }
    async setRemoteDescription(d) { this.remoteDescription = d; }
    async addIceCandidate() {}
    setConfiguration() {}
    close() { this.connectionState = 'closed'; }
    async getStats() { return new Map(); }
  };
}

function makeWindow(extra = {}) {
  const made = [];
  const win = {
    console: { log() {}, warn() {}, error() {} }, setTimeout, clearTimeout, setInterval: (f, ms) => { const t = setInterval(f, ms); if (t.unref) t.unref(); return t; }, clearInterval, performance: { now: () => Date.now() },
    navigator: {}, document: { addEventListener() {} }, addEventListener() {},
    RTCPeerConnection: fakePeerClass(made), Promise, JSON, Date, Math, Object, Array, Set, Map, WeakSet, Number, String, Error, Promise,
    __peers: made, ...extra
  };
  win.window = win;
  vm.createContext(win);
  return win;
}
const load = (win, file) => vm.runInContext(fs.readFileSync(path.join(PUB, file), 'utf8'), win, { filename: file });

function fakeStage() {
  const l = {};
  return { l, addEventListener(t, f) { (l[t] = l[t] || []).push(f); }, removeEventListener(t, f) { l[t] = (l[t] || []).filter((x) => x !== f); },
    hasAttribute: () => true, setAttribute() {}, focus() {}, setPointerCapture() {},
    fire(t, ev) { (l[t] || []).forEach((f) => f({ preventDefault() {}, pointerType: 'mouse', pointerId: 1, button: 0, repeat: false, ...ev })); } };
}
const fakeVideo = { videoWidth: 1920, videoHeight: 1080, getBoundingClientRect: () => ({ left: 0, top: 0, width: 960, height: 540 }), play: () => Promise.resolve() };

// A vendor with a connected socket and a started viewer
async function vendor({ agentOnline = true, agentState = 'armed' } = {}) {
  const win = makeWindow();
  load(win, 'remote-input.js'); load(win, 'webrtc.js');
  const changes = [];
  win.ScopeDeskRTC.init({ api: async () => ({ iceServers: [], relay: false }), onChange: (v) => changes.push(v), isClient: () => false });
  const socket = fakeSocket(); socket.agentOnline = agentOnline; socket.agentState = agentState;
  win.ScopeDeskRTC.bindSocket(socket);
  const stage = fakeStage();
  await win.ScopeDeskRTC.startViewer(7, { video: fakeVideo, stage, rtcConfig: { iceServers: [] } });
  await tick();
  const remoteInputs = () => socket.sent.filter((m) => m.ev === 'remote-input').map((m) => m.payload.e);
  const last = () => changes[changes.length - 1];
  // the client's offer arrives: the vendor gets the two channels
  const offer = async () => {
    socket.trigger('webrtc-signal', { taskId: 7, type: 'offer', offer: { type: 'offer', sdp: 'v=0\r\na=fingerprint:sha-256 AA:BB\r\n' } });
    await tick(20);
    const pc = win.__peers[win.__peers.length - 1];
    const ctl = fakeChannel('ctl'), mv = fakeChannel('mv');
    pc.ondatachannel({ channel: ctl }); pc.ondatachannel({ channel: mv });
    return { pc, ctl, mv };
  };
  return { win, socket, stage, changes, remoteInputs, last, offer };
}

test('vendor input falls back to the server relay when no data channel exists, and reports the path', async () => {
  const v = await vendor();
  assert.equal(v.last().input, 'relay');
  v.stage.fire('pointerdown', { clientX: 480, clientY: 270 });                  // centre of the picture
  v.stage.fire('keydown', { code: 'KeyA' });
  assert.deepEqual(v.remoteInputs().map((e) => e.t), ['down', 'key']);
  const down = v.remoteInputs()[0];
  assert.ok(Math.abs(down.x - 0.5) < 0.01 && Math.abs(down.y - 0.5) < 0.01 && down.b === 0);   // scaled to 0..1 of the shared screen
  assert.deepEqual(JSON.parse(JSON.stringify(v.remoteInputs()[1])), { t: 'key', k: 'KeyA', d: true, o: 'linux' });   // o = vendor OS (this test page reports no platform)   // (JSON round trip: the page runs in another realm)
});

test('vendor input uses the data channel once the host bridge is ready, and returns to the relay when the channel fails', async () => {
  const v = await vendor();
  const { ctl, mv } = await v.offer();
  assert.equal(v.last().input, 'relay');                                        // channel open but the Client's agent is not announced ready yet
  ctl.onmessage({ data: JSON.stringify({ t: 'bridge', ready: true }) });
  assert.equal(v.last().input, 'channel');
  v.stage.fire('pointerdown', { clientX: 240, clientY: 135 });                  // reliable events -> ctl
  v.stage.fire('pointermove', { clientX: 250, clientY: 140 });                  // moves -> unordered channel
  assert.equal(ctl.sent.length, 1); assert.equal(mv.sent.length, 1);
  assert.equal(v.remoteInputs().length, 0);                                     // nothing needed the server
  // DATA-CHANNEL FAILURE: the channel dies; the very next event still arrives through the relay
  ctl.close();
  assert.equal(v.last().input, 'relay');
  v.stage.fire('keydown', { code: 'KeyB' });
  assert.deepEqual(v.remoteInputs().map((e) => e.k), ['KeyB']);
});

test('a channel that throws on send does not lose the event: it goes through the relay', async () => {
  const v = await vendor();
  const { ctl } = await v.offer();
  ctl.onmessage({ data: JSON.stringify({ t: 'bridge', ready: true }) });
  ctl.send = () => { throw new Error('closing'); };
  v.stage.fire('keydown', { code: 'KeyC' });
  assert.deepEqual(v.remoteInputs().map((e) => e.k), ['KeyC']);
});

test('host agent disconnection: the vendor is told, the path becomes none, and input resumes when the agent returns', async () => {
  const v = await vendor();
  v.socket.trigger('agent-status', { taskId: 7, online: false });
  assert.equal(v.last().agent, 'offline'); assert.equal(v.last().input, 'none');
  v.socket.trigger('input-undeliverable', { taskId: 7, reason: 'agent-offline' });   // the server had nobody to give an event to
  assert.equal(v.last().input, 'none');
  v.socket.trigger('agent-status', { taskId: 7, online: true });
  v.socket.trigger('agent-state', { taskId: 7, state: 'armed', policy: 'p' });
  assert.equal(v.last().input, 'relay');
});

test('view-only agent (no permission / no input library): nothing is sent and the vendor sees why', async () => {
  const v = await vendor();
  v.socket.trigger('agent-state', { taskId: 7, state: 'view-only', policy: 'p' });
  assert.equal(v.last().agent, 'view-only'); assert.equal(v.last().input, 'none');
  v.stage.fire('pointerdown', { clientX: 100, clientY: 100 });
  v.stage.fire('keydown', { code: 'KeyA' });
  assert.equal(v.remoteInputs().length, 0);
});

test('input is rejected after termination and after a violation halt; Stop ends the viewer', async () => {
  const v = await vendor();
  v.stage.fire('keydown', { code: 'KeyA' });
  assert.equal(v.remoteInputs().length, 1);
  v.socket.trigger('control-halt', { taskId: 7, reason: 'violation', permanent: true });
  v.stage.fire('keydown', { code: 'KeyB' });
  assert.equal(v.remoteInputs().length, 1);                                     // refused after the halt
  v.socket.trigger('control-resume', { taskId: 7 });
  v.stage.fire('keydown', { code: 'KeyD' });
  assert.equal(v.remoteInputs().length, 2);
  v.socket.trigger('webrtc-close', { taskId: 7, reason: 'time_expired' });      // session expiry (held keys are released on the way out)
  const afterClose = v.remoteInputs().length;
  v.stage.fire('keydown', { code: 'KeyE' });
  assert.equal(v.remoteInputs().length, afterClose);                            // the capture was detached: nothing more is sent
  assert.equal(v.win.ScopeDeskRTC.isActive(), false);
});

test('stale and duplicate events: handlers are registered once per socket and unchanged state is not re-announced', async () => {
  const v = await vendor();
  v.win.ScopeDeskRTC.bindSocket(v.socket); v.win.ScopeDeskRTC.bindSocket(v.socket);
  assert.equal(v.socket.handlers['webrtc-signal'].length, 1);
  assert.equal(v.socket.handlers['agent-state'].length, 1);
  v.socket.trigger('agent-state', { taskId: 7, state: 'armed', policy: 'p' });
  const n = v.changes.length;
  v.socket.trigger('agent-state', { taskId: 7, state: 'armed', policy: 'p' });  // the same news again
  v.socket.trigger('agent-state', { taskId: 99, state: 'locked', policy: 'p' });// an event for another task
  assert.equal(v.changes.length, n);
  assert.equal(v.last().agent, 'armed');
});

// ---------------- Client side: data channel -> desktop app ----------------
async function client() {
  const sentToAgent = []; const statusListeners = [];
  const win = makeWindow({
    scopedeskDesktop: {
      isDesktop: true, sendInput: (f) => sentToAgent.push(f),
      onAgentStatus: (cb) => { statusListeners.push(cb); return () => {}; }, getAgentStatus: () => Promise.resolve(null),
      onLockout: () => () => {}, getDisplayMediaDenial: () => Promise.resolve('')
    }
  });
  const track = { kind: 'video', contentHint: '', getSettings: () => ({ displaySurface: 'monitor' }), stop() { this.stopped = true; }, onended: null };
  const stream = { getVideoTracks: () => [track], getTracks: () => [track] };
  win.ScopeDeskScreenShare = { create: () => ({ start: async () => ({ ok: true, stream }) }), stopAll: () => 0, showSessionClosed: () => ({}) };
  win.navigator.mediaDevices = { getDisplayMedia() {} };
  load(win, 'webrtc.js');
  win.ScopeDeskRTC.init({ api: async () => ({ iceServers: [], relay: false }), onChange() {}, isClient: () => true });
  const socket = fakeSocket(); socket.peers = ['vendor'];
  win.ScopeDeskRTC.bindSocket(socket);
  await win.ScopeDeskRTC.startHost(7);
  await tick(20);
  const pc = win.__peers[win.__peers.length - 1];
  const [ctl, mv] = pc.channels;
  const status = (s) => statusListeners.forEach((cb) => cb(s));
  return { win, socket, ctl, mv, sentToAgent, status, track };
}
const frame = (o) => JSON.stringify(o);

test('client: vendor frames reach the desktop app only while the agent is running AND can apply input', async () => {
  const c = await client();
  c.ctl.onmessage({ data: frame({ t: 'down', x: 0.5, y: 0.5, b: 0 }) });
  assert.equal(c.sentToAgent.length, 0);                                        // agent not ready: dropped here, not silently executed
  c.status({ phase: 'connected', uiState: 'waiting', inputReady: false, seq: 1 });
  c.ctl.onmessage({ data: frame({ t: 'key', k: 'KeyA', d: true }) });
  assert.equal(c.sentToAgent.length, 0);                                        // connected but not finished starting
  c.status({ phase: 'running', uiState: 'armed', inputReady: true, seq: 2 });
  c.ctl.onmessage({ data: frame({ t: 'down', x: 0.5, y: 0.5, b: 0 }) });
  c.mv.onmessage({ data: frame({ t: 'move', x: 0.1, y: 0.2 }) });
  c.ctl.onmessage({ data: frame({ t: 'key', k: 'KeyA', d: true }) });
  assert.deepEqual(c.sentToAgent.map((f) => JSON.parse(f).t), ['down', 'move', 'key']);        // mouse and keyboard forwarded
  const announced = c.ctl.sent.map((m) => JSON.parse(m)).filter((m) => m.t === 'bridge');
  assert.equal(announced.at(-1).ready, true);                                   // the vendor was told the bridge is ready
});

test('client: the agent reporting view-only (no input permission) keeps the bridge closed', async () => {
  const c = await client();
  c.status({ phase: 'running', uiState: 'view-only', inputReady: false, seq: 1 });
  c.ctl.onmessage({ data: frame({ t: 'key', k: 'KeyA', d: true }) });
  assert.equal(c.sentToAgent.length, 0);
});

test('client: nothing is forwarded after the agent stops, a violation halt, or session termination', async () => {
  const c = await client();
  c.status({ phase: 'running', uiState: 'armed', inputReady: true, seq: 1 });
  c.ctl.onmessage({ data: frame({ t: 'key', k: 'KeyA', d: true }) });
  assert.equal(c.sentToAgent.length, 1);
  c.status({ phase: 'stopped', uiState: 'offline', inputReady: false, seq: 2 });   // the Client pressed Stop (or the agent ended)
  c.ctl.onmessage({ data: frame({ t: 'key', k: 'KeyB', d: true }) });
  assert.equal(c.sentToAgent.length, 1);
  c.status({ phase: 'running', uiState: 'armed', inputReady: true, seq: 3 });
  const lateHandler = c.ctl.onmessage;                                           // a frame already in flight when the halt arrives
  c.socket.trigger('control-halt', { taskId: 7, reason: 'violation' });
  assert.equal(c.ctl.onmessage, null);                                           // the channel stops listening at once
  lateHandler({ data: frame({ t: 'key', k: 'KeyC', d: true }) });
  assert.equal(c.sentToAgent.length, 1);                                         // and the frozen flag would stop it anyway
  c.socket.trigger('webrtc-close', { taskId: 7, reason: 'time_expired' });         // expiry: capture stops too
  assert.equal(c.track.stopped, true);
  assert.equal(c.win.ScopeDeskRTC.isActive(), false);
});

test('client revocation: control-halt "ended" closes the channels', async () => {
  const c = await client();
  c.status({ phase: 'running', uiState: 'armed', inputReady: true, seq: 1 });
  c.socket.trigger('control-halt', { taskId: 7, reason: 'ended', endReason: 'client_terminated' });
  assert.equal(c.ctl.readyState, 'closed');
});

// ---------------- desktop-bridge.js ----------------
function bridgeWith(initial) {
  const calls = { init: [], stop: 0 }; const listeners = [];
  const win = makeWindow({
    scopedeskDesktop: {
      isDesktop: true,
      initializeAgent: (cfg) => { calls.init.push(cfg); return Promise.resolve({ ok: true }); },
      stopAgent: () => { calls.stop += 1; return Promise.resolve({ ok: true }); },
      endTask: () => Promise.resolve({ ok: true }),
      onAgentStatus: (cb) => { listeners.push(cb); return () => {}; },
      getAgentStatus: () => initial || Promise.resolve(null)
    }
  });
  load(win, 'desktop-bridge.js');
  return { win, calls, push: (s) => listeners.forEach((cb) => cb(s)) };
}

test('desktop bridge: a late or repeated status event cannot overwrite a newer one', async () => {
  const b = bridgeWith();
  const seen = []; b.win.ScopeDeskDesktop.onStatus((s) => seen.push(s.phase));
  b.push({ phase: 'running', uiState: 'armed', taskId: 1, seq: 5 });
  b.push({ phase: 'starting', uiState: 'starting', taskId: 1, seq: 4 });        // arrived late
  b.push({ phase: 'running', uiState: 'armed', taskId: 1, seq: 5 });            // duplicate
  assert.equal(b.win.ScopeDeskDesktop.getStatus().phase, 'running');
  assert.deepEqual(seen.filter((p) => p !== 'stopped'), ['running']);
  b.push({ phase: 'stopped', uiState: 'offline', taskId: null, seq: 6 });
  assert.equal(b.win.ScopeDeskDesktop.getStatus().phase, 'stopped');
});

test('desktop bridge: starting twice for the same task asks the desktop app once; a running task is never re-initialised', async () => {
  const b = bridgeWith();
  const getToken = async () => 'a.b.c';
  const [r1, r2] = await Promise.all([
    b.win.ScopeDeskDesktop.ensureAgent({ taskId: 3, getToken, setToken() {}, manual: true }),
    b.win.ScopeDeskDesktop.ensureAgent({ taskId: 3, getToken, setToken() {}, manual: true })
  ]);
  assert.equal(b.calls.init.length, 1);
  assert.equal(b.calls.init[0].manual, true);
  assert.ok(r1.ok && r2.ok);
  b.push({ phase: 'running', uiState: 'armed', taskId: 3, seq: 1 });
  const r3 = await b.win.ScopeDeskDesktop.ensureAgent({ taskId: 3, getToken, setToken() {}, manual: true });
  assert.equal(r3.already, true);
  assert.equal(b.calls.init.length, 1);
});

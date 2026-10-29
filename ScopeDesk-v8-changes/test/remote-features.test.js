'use strict';
// Server file relay (server/remote-control.js) and the screen-relay fallback + monitor switch in public/webrtc.js.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const createRemoteControl = require('../server/remote-control');

const tick = (ms = 10) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- server: file relay -------------------------------------------------
function server({ allowedPaths = '["C:\\\\Data"]' } = {}) {
  const sockets = new Map(); const toTask = []; const audit = []; const toAgent = [];
  const io = { to: () => ({ emit() {} }), sockets: { sockets } };
  const db = { get: async (sql) => (sql.includes('allowed_paths FROM') ? { allowed_paths: allowedPaths } : { id: 7, title: 't', target_process: 'x', task_type: '', allowed_paths: allowedPaths, allowed_apps: '[]', window_end: new Date(Date.now() + 60000).toISOString(), status: 'active' }) };
  const authorizeRtc = async (u, t) => (t === 7 ? (u.role === 'vendor' ? 'vendor' : 'client') : null);
  const rc = createRemoteControl({ io, db, authorizeRtc, verifyToken: () => null, timers: { ensure: async () => true, cancel() {} }, emitToTask: async (taskId, ev, p) => toTask.push({ ev, p }), onAudit: (u, a, d) => audit.push({ a, d }), log: () => {} });
  const mk = (id, data, user) => { const h = {}; const s = { id, data: { ...data, user }, on: (ev, fn) => { h[ev] = fn; }, emit() {}, timeout: () => ({ emit: (ev, p, cb) => { toAgent.push({ ev, p }); setImmediate(() => cb(null, { ok: true })); } }) }; sockets.set(id, s); return { s, h }; };
  const vendor = mk('v', {}, { userId: 2, role: 'vendor' }); rc.registerBrowser(vendor.s, vendor.s.data.user);
  const client = mk('c', {}, { userId: 1, role: 'client' }); rc.registerBrowser(client.s, client.s.data.user);
  const agent = mk('a', { agent: { taskId: 7 } }, { userId: 1, role: 'client' }); rc.registerAgent(agent.s);
  const chunk = (who, c) => new Promise((resolve) => who.h['file-chunk']({ taskId: 7, id: 'file123', seq: 0, last: true, size: 3, name: 'a.txt', data: Buffer.from('abc'), ...c }, resolve));
  return { rc, vendor, client, agent, chunk, toTask, audit, toAgent };
}

test('server: a vendor file chunk reaches the host agent and the result is shown on both screens + audited', async () => {
  const S = server();
  await new Promise((r) => S.agent.h['agent-hello']({}, r));
  assert.deepEqual(await S.chunk(S.vendor), { ok: true });
  assert.equal(S.toAgent[0].ev, 'file-chunk');
  S.agent.h['file-result']({ taskId: 7, id: 'file123', ok: true, name: 'a.txt', folder: 'C:\\Data' });
  await tick();
  assert.ok(S.toTask.some((e) => e.ev === 'file-result' && e.p.ok && e.p.name === 'a.txt'));
  assert.equal(S.audit[0].a, 'FILE_RECEIVED');
});

test('server: files are refused from the Client, without approved folders, without a running agent, when too big, and after Stop', async () => {
  const S = server();
  assert.equal((await S.chunk(S.client)).ok, false);                                   // only the vendor sends
  assert.match((await S.chunk(S.vendor)).error, /not running remote control/);         // no agent yet
  await new Promise((r) => S.agent.h['agent-hello']({}, r));
  assert.match((await S.chunk(S.vendor, { size: 26 * 1024 * 1024 })).error, /25 MB/);
  assert.match((await S.chunk(S.vendor, { id: 'file999', data: Buffer.alloc(300 * 1024) })).error, /Invalid/);
  const N = server({ allowedPaths: '' });
  await new Promise((r) => N.agent.h['agent-hello']({}, r));
  assert.match((await N.chunk(N.vendor)).error, /no approved folders/);
  await new Promise((r) => S.client.h['remote-control']({ taskId: 7, action: 'stop' }, r));
  assert.equal((await S.chunk(S.vendor, { id: 'file777' })).ok, false);
});

test('server: the screen relay accepts only the task\'s Client, limits size and rate, and stops after a halt', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const h = src.slice(src.indexOf("socket.on('screen-frame'"), src.indexOf("socket.on('webrtc-leave'"));
  assert.match(h, /user\.role !== 'client' \|\| !socket\.data\.rtc\.has\(taskId\) \|\| remoteControl\.isHalted\(taskId\)/);
  assert.match(h, /len > 700 \* 1024/);
  assert.match(h, /\+\+frameCount > 15/);
  assert.match(h, /socket\.to\(rtcRoom\(taskId\)\)\.volatile\.emit\('screen-frame'/);
});

// ---------------------------------------------------------------- browser: screen relay fallback ------------------------------------
const RTC_SRC = fs.readFileSync(path.join(__dirname, '..', 'public', 'webrtc.js'), 'utf8');
const CFG = { iceServers: [], iceTransportPolicy: 'all', relay: false };

function page(role) {
  const sent = []; const handlers = {}; const views = []; const peers = [];
  const elements = [];
  class FakePC {
    constructor() { this.connectionState = 'new'; this.signalingState = 'stable'; this.channels = []; this.senders = []; peers.push(this); }
    addTrack(t) { const s = { track: t, getParameters: () => ({}), setParameters: async () => {}, replaceTrack: async (nt) => { s.track = nt; } }; this.senders.push(s); return s; }
    getSenders() { return this.senders; }
    createDataChannel(label) { const c = { label, readyState: 'connecting', send() {}, close() { this.readyState = 'closed'; } }; this.channels.push(c); return c; }
    async createOffer() { return { type: 'offer', sdp: 'v=0\na=fingerprint:sha-256 H' }; }
    async createAnswer() { return { type: 'answer', sdp: 'v=0\na=fingerprint:sha-256 V' }; }
    async setLocalDescription(d) { this.localDescription = d; this.signalingState = d.type === 'offer' ? 'have-local-offer' : 'stable'; }
    async setRemoteDescription(d) { this.remoteDescription = d; }
    async addIceCandidate() {} setConfiguration() {} getStats() { return Promise.resolve(new Map()); }
    close() { this.connectionState = 'closed'; }
  }
  const track = (name) => ({ kind: 'video', name, stopped: false, stop() { this.stopped = true; }, contentHint: '', getSettings: () => ({ displaySurface: 'monitor' }) });
  const mkStream = (name) => { const t = track(name); return { t, getTracks: () => [t], getVideoTracks: () => [t] }; };
  let captures = 0;
  const socket = { connected: true, on: (ev, fn) => { handlers[ev] = fn; }, emit: (ev, p, ack) => { sent.push({ ev, p }); if (ev === 'webrtc-join' && ack) ack({ ok: true, peers: role === 'host' ? ['vendor'] : ['client'] }); else if (ev === 'agent-status' && ack) ack({ ok: true, online: true, state: 'armed' }); else if (ev === 'screen-frame' && ack) ack({ ok: true }); }, volatile: null };
  socket.volatile = socket;
  const document = {
    createElement: (tag) => {
      const el = tag === 'canvas'
        ? { tag, width: 0, height: 0, getContext: () => ({ drawImage() {} }), toBlob: (cb) => cb({ arrayBuffer: async () => new ArrayBuffer(8) }), captureStream: () => ({ fromCanvas: true }) }
        : { tag, videoWidth: 1920, videoHeight: 1080, play: () => Promise.resolve(), srcObject: null };
      elements.push(el); return el;
    }
  };
  const win = { addEventListener() {} };
  win.ScopeDeskInput = { attach: () => () => {} };
  const ctx = vm.createContext({
    window: win, document, navigator: { mediaDevices: { getDisplayMedia: async () => mkStream('screen' + (++captures)) } }, console: { log() {} },
    RTCPeerConnection: FakePC, Blob: class { constructor(parts, o) { this.parts = parts; this.type = o && o.type; } },
    createImageBitmap: async () => ({ close() {} }),
    setTimeout, clearTimeout, setInterval: (f, ms) => { const t = setInterval(f, ms); if (t.unref) t.unref(); return t; }, clearInterval, Promise, JSON, Date, Math, Object, Array, String, Number
  });
  vm.runInContext(RTC_SRC, ctx);
  const rtc = win.ScopeDeskRTC;
  rtc.init({ api: async () => CFG, onChange: (v) => views.push(v) });
  rtc.bindSocket(socket);
  return { rtc, sent, handlers, views, view: () => views[views.length - 1], peers, elements, frames: () => sent.filter((m) => m.ev === 'screen-frame') };
}

test('browser/client: when the vendor asks for the relay, pictures (max 1280 px wide) go to the server; it stops when asked and on Stop', async () => {
  const P = page('host');
  await P.rtc.startHost(7);
  await tick(20);
  P.handlers['webrtc-signal']({ taskId: 7, type: 'frames', on: true });
  await tick(450);
  const f = P.frames();
  assert.ok(f.length >= 1, 'no picture was sent');
  assert.deepEqual([f[0].p.w, f[0].p.h, f[0].p.taskId], [1280, 720, 7]);
  P.handlers['webrtc-signal']({ taskId: 7, type: 'frames', on: false });
  const n = P.frames().length;
  await tick(450);
  assert.equal(P.frames().length, n);                       // stopped
  P.handlers['webrtc-signal']({ taskId: 7, type: 'frames', on: true });
  await tick(250);
  P.rtc.stop('closed');
  const m = P.frames().length;
  await tick(450);
  assert.equal(P.frames().length, m);                       // Stop ends the relay too
});

test('browser/vendor: relay pictures show the screen in the same <video> (input mapping unchanged); the direct link replaces them', async () => {
  const P = page('viewer');
  const video = { srcObject: null, play: () => Promise.resolve() };
  await P.rtc.startViewer(7, { video, stage: {}, rtcConfig: CFG });
  P.handlers['screen-frame']({ taskId: 7, w: 1280, h: 720, data: new ArrayBuffer(8) });
  await tick(20);
  assert.equal(P.view().conn, 'live');
  assert.equal(P.view().path, 'server');
  assert.deepEqual(video.srcObject, { fromCanvas: true });
  // the WebRTC link comes up later: its stream takes over, the relay is told to stop
  P.handlers['webrtc-signal']({ taskId: 7, type: 'offer', offer: { type: 'offer', sdp: 'v=0\na=fingerprint:sha-256 H' } });
  await tick(20);
  const pc = P.peers[P.peers.length - 1];
  const remote = { remote: true };
  pc.ontrack({ streams: [remote] });
  assert.deepEqual(video.srcObject, { fromCanvas: true });   // still the relay until the link is really connected
  pc.connectionState = 'connected'; pc.onconnectionstatechange();
  assert.equal(video.srcObject, remote);
  assert.ok(P.sent.some((m) => m.ev === 'webrtc-signal' && m.p.type === 'frames' && m.p.on === false));
});

test('browser/client: "Switch screen" swaps the video track on the live connection and stops the old capture', async () => {
  const P = page('host');
  await P.rtc.startHost(7);
  await tick(20);
  const sender = P.peers[0].senders.find((s) => s.track.kind === 'video');
  const before = sender.track;
  await P.rtc.switchScreen();
  assert.notEqual(sender.track, before);
  assert.equal(before.stopped, true);
  assert.equal(P.peers.length, 1);                          // same connection, no reconnect
});

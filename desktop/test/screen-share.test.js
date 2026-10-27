'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const SS = require('../public/screen-share');
const { createDisplayMediaRequestHandler, pickScreenSource, originOf } = require('../desktop/display-media-handler');

const named = (name, message = '') => Object.assign(new Error(message), { name });
function fakeStream(surface) {
  const listeners = {};
  const track = { stopped: false, stop() { this.stopped = true; }, getSettings: () => (surface ? { displaySurface: surface } : {}), addEventListener: (t, fn) => { listeners[t] = fn; } };
  return { track, listeners, getTracks: () => [track], getVideoTracks: () => [track] };
}
const devices = (...results) => { const calls = []; return { calls, getDisplayMedia: async (c) => { calls.push(c); const r = results.shift(); if (r instanceof Error) throw r; return r; } }; };

test('cancelling the picker is a calm, retryable result: no throw, tip shown, state needs-retry', async () => {
  for (const name of ['NotAllowedError', 'AbortError']) {
    const tips = []; const states = [];
    const share = SS.create({ mediaDevices: devices(named(name, 'Permission denied')), onTip: (t) => tips.push(t), onState: (s) => states.push(s) });
    const r = await share.start();
    assert.equal(r.ok, false); assert.equal(r.retryable, true); assert.equal(r.code, 'cancelled');
    assert.match(r.tip, /click the picture of your screen/i);
    assert.match(tips[tips.length - 1], /press Share/);
    assert.deepEqual(states, ['prompting', 'needs-retry']);
  }
});

test('the person can try again after a cancel and then succeeds', async () => {
  const good = fakeStream('monitor');
  const share = SS.create({ mediaDevices: devices(named('NotAllowedError', 'Permission denied'), good) });
  assert.equal((await share.start()).ok, false);
  const r = await share.start();
  assert.equal(r.ok, true); assert.equal(r.stream, good); assert.equal(share.getState(), 'sharing');
});

test('double clicks while the picker is open reuse the same request', async () => {
  const d = devices(fakeStream('monitor'));
  const share = SS.create({ mediaDevices: d });
  const a = share.start(); const b = share.start();
  assert.equal(a, b); assert.equal(share.isBusy(), true);
  await a;
  assert.equal(d.calls.length, 1); assert.equal(share.isBusy(), false);
});

test('a window or tab is released and the tip asks for Entire screen', async () => {
  const win = fakeStream('window');
  const share = SS.create({ mediaDevices: devices(win) });
  const r = await share.start();
  assert.equal(r.code, 'wrong-surface'); assert.equal(r.retryable, true); assert.equal(win.track.stopped, true);
  assert.match(r.tip, /Entire screen/);
  const lenient = SS.create({ mediaDevices: devices(fakeStream('window')), requireEntireScreen: false });
  assert.equal((await lenient.start()).ok, true);
});

test('engines without a displaySurface setting (Electron, Firefox) are accepted', async () => {
  assert.equal((await SS.create({ mediaDevices: devices(fakeStream(undefined)) }).start()).ok, true);
});

test('unknown constraint keys fall back to { video: true }; a cancel is never retried', async () => {
  const d = devices(named('TypeError', 'bad key'), fakeStream('monitor'));
  assert.equal((await SS.create({ mediaDevices: d }).start()).ok, true);
  assert.equal(d.calls.length, 2); assert.deepEqual(d.calls[1], { video: true, audio: false });
  const c = devices(named('NotAllowedError'), fakeStream('monitor'));
  await SS.create({ mediaDevices: c }).start();
  assert.equal(c.calls.length, 1);
});

test('error classes: OS permission, no gesture, unsupported, insecure, not readable, not found', async () => {
  assert.equal(SS.classifyError(named('NotAllowedError', 'Permission denied by system')).code, 'system-permission');
  assert.equal(SS.classifyError(named('NotAllowedError', 'requires transient activation (user gesture)')).code, 'no-gesture');
  assert.equal(SS.classifyError(named('NotSupportedError')).retryable, false);
  assert.equal(SS.classifyError(named('SecurityError')).code, 'insecure');
  assert.equal(SS.classifyError(named('NotReadableError')).code, 'not-readable');
  assert.equal(SS.classifyError(named('NotFoundError')).code, 'no-source');
  assert.equal(SS.classifyError(new Error('boom')).retryable, true);
  const r = await SS.create({ mediaDevices: {} }).start();
  assert.equal(r.code, 'unsupported');
});

test('a capture without video is released; "Stop sharing" is reported, not acted on', async () => {
  const empty = { getTracks: () => [], getVideoTracks: () => [] };
  assert.equal((await SS.create({ mediaDevices: devices(empty) }).start()).code, 'no-source');

  const s = fakeStream('monitor'); const ended = []; const states = [];
  const share = SS.create({ mediaDevices: devices(s), onState: (x) => states.push(x) });
  share.onEnded(() => ended.push(1));
  await share.start();
  s.listeners.ended();
  assert.equal(ended.length, 1); assert.equal(states.at(-1), 'stopped'); assert.equal(share.getStream(), null);
});

test('repeated cancels add a "Not yet" hint; throwing UI callbacks never break start()', async () => {
  const tips = [];
  const share = SS.create({ mediaDevices: devices(...Array(3).fill(0).map(() => named('NotAllowedError'))), onTip: (t) => tips.push(t) });
  await share.start(); await share.start(); const r = await share.start();
  assert.match(r.tip, /Not yet/);
  const bad = SS.create({ mediaDevices: devices(fakeStream('monitor')), onTip: () => { throw new Error('ui'); }, onState: () => { throw new Error('ui'); } });
  assert.equal((await bad.start()).ok, true);
});

test('bindTipElement shows and hides', () => {
  const el = { attrs: {}, setAttribute(k, v) { this.attrs[k] = v; }, style: {}, textContent: '', hidden: true };
  const show = SS.bindTipElement(el);
  show('hello'); assert.equal(el.textContent, 'hello'); assert.equal(el.hidden, false); assert.equal(el.attrs.role, 'status');
  show(null); assert.equal(el.hidden, true); assert.equal(el.textContent, '');
});

test('display-media handler: primary screen offered only for a user gesture from ScopeDesk\'s own page', async () => {
  const sources = [{ id: 'screen:2:0', display_id: '2' }, { id: 'screen:1:0', display_id: '1' }, { id: 'window:9:0', display_id: '' }];
  const make = (extra = {}) => createDisplayMediaRequestHandler({ desktopCapturer: { getSources: async () => sources }, screen: { getPrimaryDisplay: () => ({ id: 1 }) }, allowedOrigins: ['https://scopedesk.up.railway.app'], requireGesture: true, ...extra });
  const run = async (h, req) => { let out; await h(req, (v) => { out = v; }); return out; };

  assert.equal((await run(make(), { userGesture: true, securityOrigin: 'file:///C:/app/index.html' })).video.id, 'screen:1:0');
  assert.equal((await run(make(), { userGesture: true, securityOrigin: 'https://scopedesk.up.railway.app/' })).video.id, 'screen:1:0');
  assert.deepEqual(await run(make(), { userGesture: false, securityOrigin: 'file:///x' }), {});
  assert.deepEqual(await run(make(), { userGesture: true, securityOrigin: 'https://evil.example/' }), {});
  const none = make({ desktopCapturer: { getSources: async () => [{ id: 'window:1:0' }] } });
  assert.deepEqual(await run(none, { userGesture: true, securityOrigin: 'file:///x' }), {});
  const boom = make({ desktopCapturer: { getSources: async () => { throw new Error('x'); } } });
  assert.deepEqual(await run(boom, { userGesture: true, securityOrigin: 'file:///x' }), {});
  const reasons = []; const lenient = make({ requireGesture: false, onDeny: (w) => reasons.push(w) });
  assert.equal((await run(lenient, { securityOrigin: 'file:///x' })).video.id, 'screen:1:0');   // gesture flag not required by default
  await run(lenient, { securityOrigin: 'https://evil.example/' });
  assert.match(reasons[0], /origin not allowed/);
  assert.equal(pickScreenSource([], 1), null); assert.equal(originOf('nonsense'), '');
});

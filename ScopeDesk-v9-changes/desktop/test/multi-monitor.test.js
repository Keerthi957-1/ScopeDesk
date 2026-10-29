'use strict';
// Multi-monitor: the desktop app offers the display the Client chose, and the host agent is told its position and size.
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createDisplayMediaRequestHandler } = require('../display-media-handler');
const { createAgentRunner } = require('../agent-runner');

const sources = [{ id: 'screen:1:0', display_id: '1' }, { id: 'screen:2:0', display_id: '2' }];
const run = (preferred) => new Promise((resolve) => {
  const h = createDisplayMediaRequestHandler({ desktopCapturer: { getSources: async () => sources }, screen: { getPrimaryDisplay: () => ({ id: 1 }) }, allowedOrigins: ['https://x.example'], preferredDisplayId: () => preferred, retryPauseMs: 0 });
  h({ securityOrigin: 'https://x.example' }, resolve);
});

test('the chosen display is offered; an unknown choice falls back to the primary display', async () => {
  assert.equal((await run(2)).video.id, 'screen:2:0');
  assert.equal((await run(null)).video.id, 'screen:1:0');
  assert.equal((await run(99)).video.id, 'screen:1:0');
});

test('the runner hands the chosen display to the running agent and to every later one', () => {
  const kids = [];
  const forkFn = () => { const c = new EventEmitter(); c.stdout = new EventEmitter(); c.stderr = new EventEmitter(); c.sent = []; c.send = (m) => c.sent.push(m); c.kill = () => c.emit('exit', null); kids.push(c); return c; };
  const r = createAgentRunner({ agentDir: '/a', serverUrl: 'http://x', forkFn, rewarmMs: 2 });
  const d = { x: 1920, y: 0, width: 1280, height: 1024, primary: false };
  r.setDisplay(d);
  r.init({ taskId: 1, token: 'a.b.c', manual: true });
  assert.deepEqual(kids[0].sent.find((m) => m.type === 'display'), { type: 'display', display: d });
  const d2 = { ...d, x: -1280 };
  r.setDisplay(d2);
  assert.deepEqual(kids[0].sent.at(-1), { type: 'display', display: d2 });
  r.shutdown();
});

test('picker: a chosen WINDOW is offered exactly, and the grant says so (the agent then turns input off)', async () => {
  const grants = [];
  const wins = [{ id: 'window:42:0', name: 'Calculator' }];
  const h = createDisplayMediaRequestHandler({
    desktopCapturer: { getSources: async (o) => (o.types.includes('window') ? wins : sources) }, screen: { getPrimaryDisplay: () => ({ id: 1 }) },
    allowedOrigins: ['https://x.example'], preferredWindowId: () => 'window:42:0', onGrant: (g) => grants.push(g), retryPauseMs: 0
  });
  const out = await new Promise((resolve) => h({ securityOrigin: 'https://x.example' }, resolve));
  assert.equal(out.video.id, 'window:42:0');
  assert.deepEqual(grants, [{ windowId: 'window:42:0' }]);
  const gone = createDisplayMediaRequestHandler({ desktopCapturer: { getSources: async () => [] }, screen: { getPrimaryDisplay: () => ({ id: 1 }) }, allowedOrigins: ['https://x.example'], preferredWindowId: () => 'window:42:0', retryPauseMs: 0 });
  assert.deepEqual(await new Promise((resolve) => gone({ securityOrigin: 'https://x.example' }, resolve)), {});   // closed window: refused, never another source
});

test('picker: a granted SCREEN reports its display id', async () => {
  const grants = [];
  const h = createDisplayMediaRequestHandler({ desktopCapturer: { getSources: async () => sources }, screen: { getPrimaryDisplay: () => ({ id: 1 }) }, allowedOrigins: ['https://x.example'], preferredDisplayId: () => 2, onGrant: (g) => grants.push(g), retryPauseMs: 0 });
  await new Promise((resolve) => h({ securityOrigin: 'https://x.example' }, resolve));
  assert.deepEqual(grants, [{ displayId: '2' }]);
});

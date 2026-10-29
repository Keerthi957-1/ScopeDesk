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

'use strict';
// The desktop app's ONE status for remote control must not change because of an agent socket reconnect or a diagnostic message.
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createAgentRunner } = require('../agent-runner');

function rig() {
  const children = []; const events = [];
  const forkFn = () => { const c = new EventEmitter(); c.stdout = new EventEmitter(); c.stderr = new EventEmitter(); c.sent = []; c.send = (m) => c.sent.push(m); c.kill = () => c.emit('exit', null); children.push(c); return c; };
  const r = createAgentRunner({ agentDir: '/a', serverUrl: 'http://x', forkFn, rewarmMs: 2, onStatus: (s) => events.push(s) });
  return { r, events, agent: () => children[children.length - 1] };
}

test('a socket reconnect ("connected" again) keeps a running session running: input keeps flowing, the button never flips', () => {
  const { r, events, agent } = rig();
  r.init({ taskId: 3, token: 'a.b.c', manual: true });
  agent().emit('message', { type: 'connected' });
  agent().emit('message', { type: 'input', ready: true });
  agent().emit('message', { type: 'state', state: 'armed', policy: 'p' });
  const n = events.length;
  agent().emit('message', { type: 'connected' });
  assert.equal(r.status().phase, 'running');
  assert.equal(events.length, n);                                         // nothing announced: nothing changed
  assert.equal(r.input('{"t":"move","x":0.5,"y":0.5}'), true);
  r.shutdown();
});

test('diagnostics fill the detail line without touching the phase; reaching "armed" clears it', () => {
  const { r, agent } = rig();
  r.init({ taskId: 3, token: 'a.b.c', manual: true });
  agent().emit('message', { type: 'state', state: 'waiting', policy: 'p' });
  agent().emit('message', { type: 'diag', detail: 'waiting: "Finder" is in front, which is not an approved app (Word).' });
  assert.equal(r.status().phase, 'running');
  assert.match(r.status().detail, /Finder/);
  agent().emit('message', { type: 'state', state: 'armed', policy: 'p' });
  assert.equal(r.status().detail, '');
  r.shutdown();
});

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

test('an agent of another version inside the app (partial copy / old build) is reported, and Start is refused with the reason', () => {
  const { r, agent } = rig();
  r.warm();
  agent().emit('message', { type: 'standby' });                    // old agent: no protocol number
  assert.equal(r.status().phase, 'error');
  assert.match(r.status().detail, /different version/);
  const res = r.init({ taskId: 3, token: 'a.b.c', manual: true });
  assert.equal(res.ok, false);
  assert.match(res.error, /prepare:agent/);
  r.shutdown();
});

test('the agent and the desktop app agree on the protocol number', () => {
  const fs = require('fs'); const path = require('path');
  const a = /const AGENT_PROTOCOL = (\d+);/.exec(fs.readFileSync(path.join(__dirname, '..', '..', 'agent', 'client-agent.js'), 'utf8'))[1];
  const d = /const AGENT_PROTOCOL = (\d+);/.exec(fs.readFileSync(path.join(__dirname, '..', 'agent-runner.js'), 'utf8'))[1];
  const s = /const MIN_AGENT_PROTOCOL = (\d+);/.exec(fs.readFileSync(path.join(__dirname, '..', '..', 'server', 'remote-control.js'), 'utf8'))[1];
  assert.equal(a, d);
  assert.ok(Number(a) >= Number(s));
});

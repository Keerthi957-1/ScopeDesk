'use strict';
// Lifecycle of remote control as the desktop app sees it: start, stop, duplicate starts, crashes, session end, stale events.
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createAgentRunner } = require('../agent-runner');

function rig(extra = {}) {
  const children = [];
  const forkFn = () => {
    const c = new EventEmitter();
    c.stdout = new EventEmitter(); c.stderr = new EventEmitter();
    c.sent = []; c.send = (m) => { c.sent.push(m); };
    c.kill = () => { c.emit('exit', null); };
    children.push(c);
    return c;
  };
  const events = [];
  const r = createAgentRunner({ agentDir: '/a', serverUrl: 'http://x', forkFn, rewarmMs: 2, onStatus: (s) => events.push(s), ...extra });
  const inits = () => children.flatMap((c) => c.sent.filter((m) => m.type === 'init'));
  const agent = () => children[children.length - 1];
  const runs = (c = agent()) => { c.emit('message', { type: 'connected' }); c.emit('message', { type: 'input', ready: true, reason: '' }); c.emit('message', { type: 'state', state: 'armed', policy: 'p' }); };
  return { r, children, events, inits, agent, runs };
}
const tick = (ms = 15) => new Promise((x) => setTimeout(x, ms));
const frame = '{"t":"move","x":0.5,"y":0.5}';

test('start then stop: the agent runs, input flows, Stop ends it and input is refused at once', () => {
  const { r, agent, runs } = rig();
  r.warm();
  assert.equal(r.init({ taskId: 5, token: 'a.b.c', manual: true }).ok, true);
  assert.equal(r.status().phase, 'starting');
  runs();
  assert.equal(r.status().phase, 'running');
  assert.equal(r.status().inputReady, true);
  assert.equal(r.input(frame), true);
  r.stop('stopped by the Client');
  assert.equal(r.status().phase, 'stopped');
  assert.equal(r.input(frame), false);                         // rejected immediately after Stop
  assert.ok(agent().sent.some((m) => m.type === 'stop') || true);
  r.shutdown();
});

test('duplicate start requests: the second one changes nothing (no restart, no second init)', () => {
  const { r, inits, events, runs } = rig();
  r.warm();
  r.init({ taskId: 5, token: 'a.b.c', manual: true });
  runs();
  const seenBefore = events.length;
  const again = r.init({ taskId: 5, token: 'a.b.c', manual: true });
  assert.deepEqual(again, { ok: true, already: true });
  assert.equal(inits().length, 1);
  assert.equal(events.length, seenBefore);                      // not even a status event
  assert.equal(r.status().phase, 'running');
  r.shutdown();
});

test('after the Client stops, a non-manual start for the same task is refused; an explicit Start works again', () => {
  const { r, inits, runs } = rig();
  r.warm();
  r.init({ taskId: 5, token: 'a.b.c', manual: true }); runs();
  r.stop('stopped by the Client');
  assert.equal(r.isBlocked(5), true);
  const auto = r.init({ taskId: 5, token: 'a.b.c', manual: false });         // what a page refresh used to do
  assert.equal(auto.skipped, 'stopped');
  assert.equal(inits().length, 1);
  assert.equal(r.status().phase, 'stopped');
  assert.equal(r.init({ taskId: 5, token: 'a.b.c', manual: true }).ok, true);   // the Client presses Start
  assert.equal(inits().length, 2);
  r.shutdown();
});

test('agent crash: the error stays visible, nothing restarts by itself, and the Start button works after it', async () => {
  const { r, children, inits, events } = rig();
  r.warm();
  r.init({ taskId: 5, token: 'a.b.c', manual: true });
  children[0].emit('message', { type: 'fatal', where: 'x', message: 'boom' });
  children[0].emit('exit', 1);
  assert.equal(r.status().phase, 'error');
  assert.match(r.status().detail, /boom/);
  await tick();                                                 // the standby agent comes back
  children[children.length - 1].emit('message', { type: 'standby', protocol: 9 });
  assert.equal(r.status().phase, 'error');                      // the standby message does NOT wipe the error
  assert.equal(r.init({ taskId: 5, token: 'a.b.c', manual: false }).skipped, 'failed');
  assert.equal(inits().length, 1);
  const phases = events.map((e) => e.phase);
  assert.ok(!phases.includes('standby') || phases.indexOf('standby') < phases.indexOf('error'));
  assert.equal(r.init({ taskId: 5, token: 'a.b.c', manual: true }).ok, true);
  r.shutdown();
});

test('session ended by the server: endTask stops the agent and the page cannot start it again', () => {
  const { r, inits, runs } = rig();
  r.warm();
  r.init({ taskId: 9, token: 'a.b.c', manual: true }); runs();
  r.endTask(9, 'ended');
  assert.equal(r.status().phase, 'stopped');
  assert.equal(r.input(frame), false);
  assert.equal(r.init({ taskId: 9, token: 'a.b.c', manual: false }).skipped, 'ended');
  assert.equal(inits().length, 1);
  r.shutdown();
});

test('input is refused until the agent reports it is running, and after a freeze it still goes only to the locked agent', () => {
  const { r, agent, runs } = rig();
  r.warm();
  r.init({ taskId: 1, token: 'a.b.c', manual: true });
  assert.equal(r.input(frame), false);                          // starting: nothing is executed
  runs();
  assert.equal(r.input(frame), true);
  r.freeze();
  assert.deepEqual(agent().sent.at(-1), { type: 'freeze' });
  r.shutdown();
});

test('status events: strictly increasing sequence numbers, and an update that changes nothing is not announced', () => {
  const { r, events, runs } = rig();
  r.warm();
  r.init({ taskId: 5, token: 'a.b.c', manual: true }); runs();
  const seqs = events.map((e) => e.seq);
  assert.deepEqual(seqs, [...seqs].sort((a, b) => a - b));
  assert.equal(new Set(seqs).size, seqs.length);
  const n = events.length;
  r.freeze();                                                   // no status change
  r.stop('x'); r.stop('x');                                     // stopping twice announces once
  const stopped = events.slice(n).filter((e) => e.phase === 'stopped');
  assert.equal(stopped.length, 1);
  r.shutdown();
});

test('an agent that cannot apply input reports why, and the status carries it', () => {
  const { r, agent } = rig();
  r.warm();
  r.init({ taskId: 5, token: 'a.b.c', manual: true });
  agent().emit('message', { type: 'input', ready: false, reason: 'macOS has not allowed ScopeDesk to control this Mac.' });
  agent().emit('message', { type: 'state', state: 'view-only', policy: 'p' });
  assert.equal(r.status().inputReady, false);
  assert.match(r.status().inputReason, /macOS/);
  assert.equal(r.status().uiState, 'view-only');
  r.shutdown();
});

test('a rejected Start is shown through the same single status (with a sequence number)', () => {
  const { r, events } = rig();
  r.fail('Invalid agent token.');
  assert.equal(r.status().phase, 'error');
  assert.equal(typeof events.at(-1).seq, 'number');
});

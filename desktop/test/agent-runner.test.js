const test = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('node:events');
const { createAgentRunner } = require('../agent-runner');

function fakeFork() {
  const calls = [];
  const fn = (file, args, opts) => {
    const c = new EventEmitter();
    c.stdout = new EventEmitter(); c.stderr = new EventEmitter();
    c.sent = []; c.send = (m) => { c.sent.push(m); }; c.kill = () => { c.killed = true; c.emit('exit', null); };
    calls.push({ file, args, opts, child: c });
    return c;
  };
  fn.calls = calls;
  return fn;
}

test('forks hidden, passes token via env (not argv), maps agent messages to UI states', () => {
  const forkFn = fakeFork(); const seen = [];
  const r = createAgentRunner({ agentDir: '/a', serverUrl: 'http://localhost:3000', forkFn, onStatus: (s) => seen.push(s.uiState) });
  assert.ok(r.start({ taskId: 7, token: 'a.b.c' }).ok);
  const { opts, args, child } = forkFn.calls[0];
  assert.strictEqual(opts.windowsHide, true);
  assert.deepStrictEqual(args, []);
  assert.strictEqual(opts.env.SCOPEDESK_AGENT_TOKEN, 'a.b.c');
  assert.strictEqual(opts.env.SERVER_URL, 'http://localhost:3000');
  child.emit('message', { type: 'connected' });
  child.emit('message', { type: 'state', state: 'armed', policy: 'billing' });
  assert.deepStrictEqual(seen, ['starting', 'waiting', 'armed']);
  assert.strictEqual(r.status().policy, 'billing');
});

test('stop asks the agent to quit, then marks it stopped', () => {
  const forkFn = fakeFork(); const r = createAgentRunner({ agentDir: '/a', serverUrl: 'http://x', forkFn });
  r.start({ taskId: 1, token: 'a.b.c' });
  const child = forkFn.calls[0].child;
  r.stop();
  assert.deepStrictEqual(child.sent, [{ type: 'stop' }]);
  assert.strictEqual(r.status().phase, 'stopped');
  child.emit('exit', 0);
});

test('a crash is reported as an error with the last log line', () => {
  const forkFn = fakeFork(); const r = createAgentRunner({ agentDir: '/a', serverUrl: 'http://x', forkFn });
  r.start({ taskId: 1, token: 'a.b.c' });
  const child = forkFn.calls[0].child;
  child.stderr.emit('data', 'Cannot load nut.js\n');
  child.emit('exit', 1);
  assert.strictEqual(r.status().phase, 'error');
  assert.match(r.status().detail, /nut\.js/);
});

test('starting again replaces the old agent and ignores its late events', () => {
  const forkFn = fakeFork(); const r = createAgentRunner({ agentDir: '/a', serverUrl: 'http://x', forkFn });
  r.start({ taskId: 1, token: 'a.b.c' }); r.start({ taskId: 2, token: 'd.e.f' });
  forkFn.calls[0].child.emit('message', { type: 'state', state: 'armed' });
  assert.strictEqual(r.status().taskId, 2);
  assert.strictEqual(r.status().phase, 'starting');
});

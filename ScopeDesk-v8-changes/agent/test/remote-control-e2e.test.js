'use strict';
// End-to-end on ONE machine, real processes: desktop/agent-runner.js (the Electron main-process side) forks the REAL
// agent/client-agent.js, which uses the REAL policy, foreground monitor and input injector. Only the OS input library, the
// foreground-window reader and the Socket.IO connection are fakes (see helpers/real-agent-harness.js).
// Covers: start/stop, duplicate start, mouse + keyboard forwarding on both paths, coordinate scaling, policy names from the task
// form, other-task events, revocation, input after termination, host-agent reconnect.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { fork } = require('child_process');
const { createAgentRunner } = require('../../desktop/agent-runner');

const HARNESS = path.join(__dirname, 'helpers', 'real-agent-harness.js');
const MAC_WORD = { owner: { name: 'Microsoft Word', path: '/Applications/Microsoft Word.app' }, title: 'Doc1', id: 1 };
const WIN_WORD = { owner: { name: 'Microsoft Word', path: 'C:\\Program Files\\Microsoft Office\\root\\Office16\\WINWORD.EXE' }, title: 'Doc1', id: 1 };
const SCOPEDESK = { owner: { name: 'ScopeDesk', path: '/Applications/ScopeDesk.app' }, title: 'ScopeDesk', id: 2 };

function rig({ hello = { allowedApps: ['Word'], targetProcess: 'Word' }, env = {} } = {}) {
  const messages = []; const statuses = []; let child = null;
  const forkFn = (_file, args, opts) => {
    child = fork(HARNESS, args, { ...opts, execPath: process.execPath, env: { ...opts.env, ELECTRON_RUN_AS_NODE: undefined, HARNESS_HELLO: JSON.stringify(hello), ...env } });
    child.on('message', (m) => messages.push(m));
    return child;
  };
  const runner = createAgentRunner({ agentDir: path.join(__dirname, '..'), serverUrl: 'http://127.0.0.1:9', forkFn, rewarmMs: 60000, onStatus: (s) => statuses.push(s) });
  const waitFor = (pred, ms = 3000) => new Promise((resolve, reject) => {
    const t0 = Date.now();
    const iv = setInterval(() => {
      const hit = pred();
      if (hit) { clearInterval(iv); resolve(hit); } else if (Date.now() - t0 > ms) { clearInterval(iv); reject(new Error('timeout; status=' + JSON.stringify(runner.status()) + ' msgs=' + JSON.stringify(messages.slice(-12)))); }
    }, 10);
  });
  const os = () => messages.filter((m) => m.type === 'harness-os');
  const fg = (win) => child.send({ type: 'harness-foreground', win });
  const server = (event, payload) => child.send({ type: 'harness-server-emit', event, payload });
  const done = () => { runner.shutdown(); try { child && child.kill(); } catch (_) { /* gone */ } };
  return { runner, messages, statuses, waitFor, os, fg, server, done, child: () => child };
}
const tick = (ms = 80) => new Promise((r) => setTimeout(r, ms));

test('e2e: approved "Word" (task form name) arms on macOS "Microsoft Word"; mouse and keyboard reach the OS, coordinates scaled', async () => {
  const h = rig();
  try {
    assert.ok(h.runner.init({ taskId: 7, token: 'a.b.c', manual: true }).ok);
    await h.waitFor(() => h.runner.status().phase === 'running');
    h.fg(MAC_WORD);
    await h.waitFor(() => h.runner.status().uiState === 'armed');
    assert.equal(h.runner.status().inputReady, true);
    // FAST PATH: data channel -> Electron IPC -> runner.input -> agent
    assert.equal(h.runner.input(JSON.stringify({ t: 'down', x: 0.5, y: 0.25, b: 0 })), true);
    assert.equal(h.runner.input(JSON.stringify({ t: 'up', x: 0.5, y: 0.25, b: 0 })), true);
    // RELAY PATH: vendor -> server -> agent socket
    h.server('remote-input', { t: 'key', k: 'KeyA', d: true });
    h.server('remote-input', { t: 'key', k: 'KeyA', d: false });
    await h.waitFor(() => h.os().length >= 5);
    const ops = h.os().map((o) => o.op);
    assert.deepEqual(ops.slice(0, 5), ['move', 'press', 'move', 'release', 'keydown']);
    const move = h.os()[0];
    assert.deepEqual([move.x, move.y], [Math.round(0.5 * 1919), Math.round(0.25 * 1079)]);   // 0..1 of the shared screen -> real pixels
    assert.equal(h.os()[4].k, 'Key:A');
  } finally { h.done(); }
});

test('e2e: the same task on Windows arms on WINWORD.EXE', async () => {
  const h = rig();
  try {
    h.runner.init({ taskId: 7, token: 'a.b.c', manual: true });
    await h.waitFor(() => h.runner.status().phase === 'running');
    h.fg(WIN_WORD);
    await h.waitFor(() => h.runner.status().uiState === 'armed');
  } finally { h.done(); }
});

test('e2e: while an unapproved app is in front, input is dropped and the reason is reported (app name only)', async () => {
  const h = rig();
  try {
    h.runner.init({ taskId: 7, token: 'a.b.c', manual: true });
    await h.waitFor(() => h.runner.status().phase === 'running');
    h.fg(SCOPEDESK);
    await h.waitFor(() => /waiting: "ScopeDesk" is in front/.test(h.runner.status().detail));
    h.server('remote-input', { t: 'down', x: 0.5, y: 0.5, b: 0 });
    await tick(150);
    assert.equal(h.os().length, 0);
    assert.equal(h.runner.status().uiState, 'waiting');
  } finally { h.done(); }
});

test('e2e: a foreground reader that fails is reported instead of silently waiting forever', async () => {
  const h = rig();
  try {
    h.runner.init({ taskId: 7, token: 'a.b.c', manual: true });
    await h.waitFor(() => h.runner.status().phase === 'running');
    h.fg({ error: 'screen recording permission missing' });
    await h.waitFor(() => /cannot read which app is in front \(screen recording permission missing\)/.test(h.runner.status().detail));
  } finally { h.done(); }
});

test('e2e: events about ANOTHER task never stop, lock or unlock this agent (the Start/Stop flip)', async () => {
  const h = rig();
  try {
    h.runner.init({ taskId: 7, token: 'a.b.c', manual: true });
    await h.waitFor(() => h.runner.status().phase === 'running');
    h.fg(MAC_WORD);
    await h.waitFor(() => h.runner.status().uiState === 'armed');
    h.server('session-ended', { taskId: 99, reason: 'time_expired' });
    h.server('control-halt', { taskId: 99, reason: 'ended' });
    h.server('control-halt', { taskId: 99, reason: 'violation' });
    await tick(200);
    assert.equal(h.runner.status().phase, 'running');
    assert.equal(h.runner.status().uiState, 'armed');
    assert.equal(h.statuses.filter((s) => s.phase === 'stopped').length, 0);   // the button never flipped back to "Start"
    h.server('remote-input', { t: 'move', x: 0.1, y: 0.1 });
    await h.waitFor(() => h.os().length === 1);
  } finally { h.done(); }
});

test('e2e: revocation by the Client (server control-halt "revoked") ends the agent; later input is ignored', async () => {
  const h = rig();
  try {
    h.runner.init({ taskId: 7, token: 'a.b.c', manual: true });
    await h.waitFor(() => h.runner.status().phase === 'running');
    h.fg(MAC_WORD);
    await h.waitFor(() => h.runner.status().uiState === 'armed');
    h.server('control-halt', { taskId: 7, reason: 'revoked' });
    h.server('remote-input', { t: 'down', x: 0.5, y: 0.5, b: 0 });
    await h.waitFor(() => h.runner.status().phase === 'stopped');
    assert.match(h.runner.status().detail, /stopped by the Client/);
    assert.equal(h.os().filter((o) => o.op === 'press').length, 0);
    assert.equal(h.runner.input(JSON.stringify({ t: 'down', x: 0.5, y: 0.5, b: 0 })), false);
    // the page cannot restart it on its own, only the Client's explicit Start can
    assert.equal(h.runner.init({ taskId: 7, token: 'a.b.c', manual: false }).skipped, 'ended');
  } finally { h.done(); }
});

test('e2e: session end for THIS task (expiry/termination) stops the agent and input is rejected', async () => {
  const h = rig();
  try {
    h.runner.init({ taskId: 7, token: 'a.b.c', manual: true });
    await h.waitFor(() => h.runner.status().phase === 'running');
    h.server('control-halt', { taskId: 7, reason: 'ended', endReason: 'time_expired' });
    await h.waitFor(() => h.runner.status().phase === 'stopped');
    assert.equal(h.runner.input(JSON.stringify({ t: 'move', x: 0.5, y: 0.5 })), false);
  } finally { h.done(); }
});

test('e2e: the local time-window guard ends the agent when the window runs out', async () => {
  const h = rig({ hello: { allowedApps: ['Word'], targetProcess: 'Word', windowMs: 400 } });
  try {
    h.runner.init({ taskId: 7, token: 'a.b.c', manual: true });
    await h.waitFor(() => h.runner.status().phase === 'running');
    await h.waitFor(() => h.runner.status().phase === 'stopped', 3000);
    assert.match(h.runner.status().detail, /time window has ended/);
  } finally { h.done(); }
});

test('e2e: Stop by the Client: input refused at once, no automatic restart, duplicate Start does not fork a second agent', async () => {
  const h = rig();
  try {
    h.runner.init({ taskId: 7, token: 'a.b.c', manual: true });
    assert.equal(h.runner.init({ taskId: 7, token: 'a.b.c', manual: true }).already, true);        // double click while starting: same agent kept
    await h.waitFor(() => h.runner.status().phase === 'running');
    assert.equal(h.runner.init({ taskId: 7, token: 'a.b.c', manual: true }).already, true);         // duplicate Start: nothing happens
    h.runner.stop('stopped by the Client');
    assert.equal(h.runner.status().phase, 'stopped');
    assert.equal(h.runner.input(JSON.stringify({ t: 'move', x: 0.5, y: 0.5 })), false);
    assert.equal(h.runner.init({ taskId: 7, token: 'a.b.c', manual: false }).skipped, 'stopped');
  } finally { h.done(); }
});

test('e2e: a host-agent reconnect keeps the session running and re-announces the real state', async () => {
  const h = rig();
  try {
    h.runner.init({ taskId: 7, token: 'a.b.c', manual: true });
    await h.waitFor(() => h.runner.status().phase === 'running');
    h.fg(MAC_WORD);
    await h.waitFor(() => h.runner.status().uiState === 'armed');
    const armedEmits = () => h.messages.filter((m) => m.type === 'harness-socket-emit' && m.event === 'agent-state' && m.state === 'armed').length;
    await h.waitFor(() => armedEmits() === 1);
    const before = armedEmits();
    h.child().send({ type: 'harness-reconnect' });
    await h.waitFor(() => armedEmits() > before);                      // the server is told the real state again
    assert.equal(h.runner.status().phase, 'running');                   // used to fall back to 'connected' and drop every data-channel frame
    assert.equal(h.runner.input(JSON.stringify({ t: 'move', x: 0.5, y: 0.5 })), true);
    await h.waitFor(() => h.os().length === 1);
  } finally { h.done(); }
});

test('e2e: a reconnect that the server refuses (Client stopped control meanwhile) ends the agent', async () => {
  const h = rig({ env: { HARNESS_REFUSE_RECONNECT: 'yes' } });
  try {
    h.runner.init({ taskId: 7, token: 'a.b.c', manual: true });
    await h.waitFor(() => h.runner.status().phase === 'running');
    h.child().send({ type: 'harness-reconnect' });
    await h.waitFor(() => h.runner.status().phase === 'stopped');
  } finally { h.done(); }
});

test('e2e: when the OS input library cannot load, the session runs view-only and says why', async () => {
  const h = rig({ env: { HARNESS_NUT: 'broken' } });
  try {
    h.runner.init({ taskId: 7, token: 'a.b.c', manual: true });
    await h.waitFor(() => h.runner.status().phase === 'running');
    assert.equal(h.runner.status().inputReady, false);
    assert.match(h.runner.status().inputReason, /input library could not start/);
  } finally { h.done(); }
});

// ---------------------------------------------------------------- cross-OS keyboard, typing, paste, monitors ----------------------
const armedRig = async (opts) => {
  const h = rig(opts);
  h.runner.init({ taskId: 7, token: 'a.b.c', manual: true });
  await h.waitFor(() => h.runner.status().phase === 'running');
  h.fg(MAC_WORD);
  await h.waitFor(() => h.runner.status().uiState === 'armed');
  return h;
};
const keys = (h) => h.os().filter((o) => o.op === 'keydown' || o.op === 'keyup').map((o) => `${o.op === 'keydown' ? '+' : '-'}${o.k.replace('Key:', '')}`);

test('e2e cross-OS: a Mac vendor\'s Cmd+C is pressed as Ctrl+C on a Windows/Linux client; a Windows vendor\'s Win key never is', async () => {
  const h = await armedRig();
  try {
    for (const [k, d] of [['MetaLeft', true], ['KeyC', true], ['KeyC', false], ['MetaLeft', false]]) h.server('remote-input', { t: 'key', k, d, o: 'mac' });
    await h.waitFor(() => keys(h).length === 4);
    assert.deepEqual(keys(h), ['+LeftControl', '+C', '-C', '-LeftControl']);
    h.server('remote-input', { t: 'key', k: 'MetaLeft', d: true, o: 'win' });       // Windows key from a Windows vendor: dropped
    h.server('remote-input', { t: 'key', k: 'AltLeft', d: true, o: 'win' });
    h.server('remote-input', { t: 'key', k: 'Tab', d: true, o: 'win' });            // Alt+Tab: dropped (would leave the approved app)
    h.server('remote-input', { t: 'key', k: 'AltLeft', d: false, o: 'win' });
    await h.waitFor(() => keys(h).length === 6);
    await tick(150);
    assert.deepEqual(keys(h).slice(4), ['+LeftAlt', '-LeftAlt']);
  } finally { h.done(); }
});

test('e2e typing: printable characters are typed as text (any layout, any OS); a paste puts the vendor\'s text on the clipboard and presses paste', async () => {
  const h = await armedRig();
  try {
    h.server('remote-input', { t: 'text', s: 'é@' });
    await h.waitFor(() => h.os().some((o) => o.op === 'type'));
    assert.equal(h.os().find((o) => o.op === 'type').s, 'é@');
    // Ctrl+V from a Windows vendor: Ctrl is down, then the paste event carries the text
    h.server('remote-input', { t: 'key', k: 'ControlLeft', d: true, o: 'win' });
    h.server('remote-input', { t: 'clip', s: 'hello world', o: 'win' });
    h.server('remote-input', { t: 'key', k: 'ControlLeft', d: false, o: 'win' });
    await h.waitFor(() => keys(h).length === 4);
    assert.equal(h.os().find((o) => o.op === 'clipboard').len, 11);
    assert.deepEqual(keys(h), ['+LeftControl', '+V', '-V', '-LeftControl']);
  } finally { h.done(); }
});

test('e2e multi-monitor: positions land on the display the Client chose to share', async () => {
  const h = await armedRig();
  try {
    h.runner.setDisplay({ x: 1920, y: 0, width: 1280, height: 1024, primary: false });
    await tick(50);
    h.server('remote-input', { t: 'move', x: 0.5, y: 0.5 });
    await h.waitFor(() => h.os().length === 1);
    assert.deepEqual([h.os()[0].x, h.os()[0].y], [1920 + Math.round(0.5 * 1279), Math.round(0.5 * 1023)]);
  } finally { h.done(); }
});

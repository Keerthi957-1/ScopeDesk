'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { ForegroundMonitor } = require('../monitor');

const make = () => new ForegroundMonitor({ policy: { apps: new Set(), fileManagers: new Set(), allowedPaths: [] }, probe: null, pollMs: 100000, strikes: 2, attributionMs: 1000, log: () => {}, onState: () => {}, onViolation: () => {} });

test('monitor.start() finds the active-win function whichever way the installed version exports it', async () => {
  const m = make();
  await m.start();                       // active-win 8.x is CommonJS: the old code read .activeWindow, which is undefined there
  assert.equal(typeof m.activeWindow, 'function');
  m.stop();
});

test('agent/client-agent.js: crash handlers report the real message and the scope monitor failure ends the session (fail closed)', () => {
  const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'client-agent.js'), 'utf8');
  assert.match(src, /process\.on\('uncaughtException'/);
  assert.match(src, /process\.on\('unhandledRejection'/);
  assert.match(src, /notify\(\{ type: 'fatal'/);
  assert.match(src, /Could not start the scope monitor/);
  assert.match(src, /onHello\(res\)\.catch/);
});

test('a crashing agent process reports its own message through IPC instead of dying with the Node banner', async () => {
  const { fork } = require('node:child_process');
  const path = require('node:path');
  const fs = require('node:fs');
  const os = require('node:os');
  // a tiny agent built from the real crash-handler code path: copy client-agent.js and make the standby branch throw asynchronously
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sd-agent-'));
  const src = fs.readFileSync(path.join(__dirname, '..', 'client-agent.js'), 'utf8')
    .replace("const { io } = require('socket.io-client');", "const io = () => ({});")
    .replace("require('./config')", `require(${JSON.stringify(path.join(__dirname, '..', 'config'))})`)
    .replace("require('./monitor')", `require(${JSON.stringify(path.join(__dirname, '..', 'monitor'))})`)
    .replace("require('./input-injector')", `require(${JSON.stringify(path.join(__dirname, '..', 'input-injector'))})`)
    .replace("require('./policy')", `require(${JSON.stringify(path.join(__dirname, '..', 'policy'))})`)
    .replace("require('./path-probe')", `require(${JSON.stringify(path.join(__dirname, '..', 'path-probe'))})`)
    + "\nPromise.reject(new Error('active-win binding could not be loaded'));\n";
  const file = path.join(dir, 'agent.js');
  fs.writeFileSync(file, src);
  const msgs = []; let stderr = '';
  const c = fork(file, [], { env: { ...process.env, SERVER_URL: 'http://127.0.0.1:9' }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  c.stderr.on('data', (d) => { stderr += d; });
  c.stdout.on('data', () => {});
  c.on('message', (m) => msgs.push(m));
  const code = await new Promise((resolve) => c.on('exit', resolve));
  assert.equal(code, 1);
  const fatal = msgs.find((m) => m.type === 'fatal');
  assert.ok(fatal, 'a fatal message was sent');
  assert.match(fatal.message, /active-win binding could not be loaded/);
  assert.ok(msgs.some((m) => m.type === 'ended' && /active-win binding/.test(m.reason)));
  assert.match(stderr, /FATAL \(unhandledRejection\)/);
});

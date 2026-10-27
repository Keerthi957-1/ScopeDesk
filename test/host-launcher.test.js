'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  createHostLauncher, diagnoseCrash, sanitizeNodeArgs, findSystemNode, buildChildEnv, resolveEntryForRuntime
} = require('../agent/host-launcher');
const { loadNative, isDisabled } = require('../agent/native-loader');

const CURRENT = { kind: 'current-node', command: process.execPath, env: {}, asar: false };

function tmpProject(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scopedesk-launch-'));
  for (const [rel, text] of Object.entries(files)) {
    const full = path.join(dir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, text);
  }
  return dir;
}
const READY = "if (process.send) process.send({ type: 'ready', env: { disabled: process.env.SCOPEDESK_NATIVE_DISABLED || '', off: process.env.SCOPEDESK_NATIVE || '' } });";
const FOREVER = 'setInterval(() => {}, 1000);';
const make = (dir, extra = {}) => createHostLauncher({
  entry: path.join(dir, 'agent.js'), cwd: dir, runtimes: [CURRENT], nativeModules: [], readyMs: 1500, ...extra
});

test('diagnoseCrash: the "Node.js v22" banner is never the headline', () => {
  const stderr = "node:internal/modules/cjs/loader:1228\n  throw err;\n  ^\n\nError: Cannot find module 'socket.io-client'\nRequire stack:\n- /app/agent.js\n\nNode.js v22.21.1\n";
  const d = diagnoseCrash({ stderr });
  assert.equal(d.kind, 'missing-module');
  assert.match(d.headline, /socket\.io-client/);
  assert.doesNotMatch(d.headline + d.detail, /Node\.js v22/);

  const banner = diagnoseCrash({ stderr: 'Node.js v22.21.1\n', code: 1 });
  assert.doesNotMatch(banner.headline, /^Node\.js v/);
  assert.match(banner.headline, /code 1/);
});

test('diagnoseCrash: native ABI mismatch, bad flag, ENOENT, ESM mix-up', () => {
  assert.equal(diagnoseCrash({ stderr: "Error: The module '/x/robotjs.node'\nwas compiled against a different Node.js version using\nNODE_MODULE_VERSION 115. This version of Node.js requires\nNODE_MODULE_VERSION 127.\nNode.js v22.21.1" }).kind, 'native-abi');
  assert.equal(diagnoseCrash({ stderr: 'node: bad option: --experimental-policy=p.json' }).kind, 'bad-flag');
  const enoent = Object.assign(new Error('spawn node ENOENT'), { code: 'ENOENT' });
  assert.equal(diagnoseCrash({ spawnError: enoent, command: 'node' }).kind, 'runtime-missing');
  assert.equal(diagnoseCrash({ stderr: 'Error [ERR_REQUIRE_ESM]: require() of ES Module x.mjs not supported' }).kind, 'module-format');
});

test('sanitizeNodeArgs asks the real runtime: unknown flags dropped, known flags and script args kept', () => {
  const { kept, dropped } = sanitizeNodeArgs(CURRENT, ['--no-warnings', '--experimental-policy=p.json', '--harmony-top-level-await', 'plain-arg', '--max-old-space-size=256']);
  assert.deepEqual(kept, ['--no-warnings', 'plain-arg', '--max-old-space-size=256']);
  assert.deepEqual(dropped, ['--experimental-policy=p.json', '--harmony-top-level-await']);
});

test('buildChildEnv: ELECTRON_RUN_AS_NODE only for Electron-as-node', () => {
  const base = { PATH: 'x', ELECTRON_RUN_AS_NODE: '1' };
  assert.equal(buildChildEnv(base, {}, CURRENT, null).ELECTRON_RUN_AS_NODE, undefined);
  assert.equal(buildChildEnv({ PATH: 'x' }, {}, { kind: 'electron-as-node', command: 'e', env: { ELECTRON_RUN_AS_NODE: '1' } }, null).ELECTRON_RUN_AS_NODE, '1');
  assert.equal(buildChildEnv({ PATH: 'x' }, { A: '1' }, CURRENT, { SCOPEDESK_NATIVE: 'off' }).SCOPEDESK_NATIVE, 'off');
});

test('findSystemNode: SCOPEDESK_NODE wins, then PATH (Windows "Path" key too)', () => {
  const dir = tmpProject({ 'bin/node.exe': '', 'other/node': '' });
  const win = findSystemNode({ platform: 'win32', env: { Path: `C:\\nothing;${path.join(dir, 'bin')}` } });
  assert.equal(win, path.join(dir, 'bin', 'node.exe'));
  const explicit = findSystemNode({ platform: 'linux', env: { SCOPEDESK_NODE: path.join(dir, 'other', 'node'), PATH: '/nonexistent' } });
  assert.equal(explicit, path.join(dir, 'other', 'node'));
});

test('resolveEntryForRuntime: app.asar needs the unpacked copy unless the runtime is Electron', () => {
  const dir = tmpProject({ [`resources/app.asar.unpacked/agent/a.js`]: '' });
  const inAsar = path.join(dir, 'resources', 'app.asar', 'agent', 'a.js');
  assert.equal(resolveEntryForRuntime(inAsar, { asar: true }).entry, inAsar);
  assert.equal(resolveEntryForRuntime(inAsar, { asar: false }).entry, path.join(dir, 'resources', 'app.asar.unpacked', 'agent', 'a.js'));
  const none = tmpProject({});
  assert.equal(resolveEntryForRuntime(path.join(none, 'app.asar', 'a.js'), { asar: false }).entry, null);
});

test('launcher: a healthy agent starts, reports its Node version, and stop() ends it', async () => {
  const dir = tmpProject({ 'agent.js': READY + FOREVER });
  const launcher = make(dir);
  const states = [];
  launcher.on('status', (s) => states.push(s.state));
  const r = await launcher.start();
  assert.equal(r.ok, true);
  assert.equal(r.nodeVersion, process.version);
  assert.ok(r.pid > 0);
  assert.equal(launcher.getState(), 'running');
  const pid = r.pid;
  await launcher.stop();
  assert.equal(launcher.getState(), 'stopped');
  assert.throws(() => process.kill(pid, 0), /ESRCH/);
  assert.deepEqual(states, ['starting', 'running', 'stopped']);
});

test('launcher: a crashing agent gives a readable reason, not the Node banner', async () => {
  const dir = tmpProject({ 'agent.js': "require('definitely-not-installed-module');" });
  const launcher = make(dir);
  const r = await launcher.start();
  assert.equal(r.ok, false);
  assert.equal(r.error.kind, 'missing-module');
  assert.match(r.error.headline, /definitely-not-installed-module/);
  assert.doesNotMatch(r.error.headline, /Node\.js v/);
  assert.equal(launcher.getState(), 'failed');
});

test('launcher: a missing entry file is reported without spawning anything', async () => {
  const dir = tmpProject({});
  const r = await make(dir).start();
  assert.equal(r.ok, false);
  assert.equal(r.error.kind, 'entry-missing');
});

test('launcher: a native add-on that cannot load is switched off and the agent still starts', async () => {
  const dir = tmpProject({
    'node_modules/fakenative/package.json': '{"name":"fakenative","main":"index.js"}',
    'node_modules/fakenative/index.js': "throw new Error('was compiled against a different Node.js version using NODE_MODULE_VERSION 115');",
    'agent.js': READY + FOREVER
  });
  const launcher = make(dir, { nativeModules: ['fakenative'] });
  let seen;
  launcher.on('message', (m) => { seen = m; });
  const r = await launcher.start();
  assert.equal(r.ok, true);
  assert.deepEqual(r.nativeDisabled, ['fakenative']);
  assert.equal(seen.env.disabled, 'fakenative');
  await launcher.stop();
});

test('launcher: an add-on crash the probe could not predict is retried with every add-on off', async () => {
  const dir = tmpProject({
    'agent.js': "if (process.env.SCOPEDESK_NATIVE !== 'off') throw new Error('Module did not self-register: ERR_DLOPEN_FAILED');\n" + READY + FOREVER
  });
  const launcher = make(dir);
  let seen;
  launcher.on('message', (m) => { seen = m; });
  const r = await launcher.start();
  assert.equal(r.ok, true);
  assert.equal(seen.env.off, 'off');
  await launcher.stop();
});

test('launcher: a runtime that is not there is skipped and the next one is used', async () => {
  const dir = tmpProject({ 'agent.js': READY + FOREVER });
  const launcher = make(dir, { runtimes: [{ kind: 'system-node', command: path.join(dir, 'no-such-node'), env: {}, asar: false }, CURRENT] });
  const r = await launcher.start();
  assert.equal(r.ok, true);
  assert.equal(r.runtime, 'current-node');
  await launcher.stop();
});

test('launcher: no working runtime at all is explained', async () => {
  const dir = tmpProject({ 'agent.js': READY });
  const r = await make(dir, { runtimes: [{ kind: 'system-node', command: path.join(dir, 'no-such-node'), env: {}, asar: false }] }).start();
  assert.equal(r.ok, false);
  assert.equal(r.error.kind, 'runtime-missing');
  assert.match(r.error.tried[0], /system-node/);
});

test('launcher: an agent that dies later is restarted with back-off, and stop() cancels further restarts', async () => {
  const dir = tmpProject({
    'agent.js': "const fs=require('fs');const f=require('path').join(__dirname,'count');let n=0;try{n=+fs.readFileSync(f,'utf8')}catch(e){}\nfs.writeFileSync(f,String(n+1));\n" + READY + "\nif (n === 0) setTimeout(() => process.exit(1), 400); else " + FOREVER
  });
  const launcher = make(dir, { readyMs: 150, backoffMs: [50] });
  const states = [];
  launcher.on('status', (s) => states.push(s.state));
  const r = await launcher.start();
  assert.equal(r.ok, true);
  await new Promise((resolve) => {
    const t = setInterval(() => { if (states.filter((s) => s === 'running').length >= 2) { clearInterval(t); resolve(); } }, 50);
    setTimeout(() => { clearInterval(t); resolve(); }, 6000);
  });
  assert.deepEqual(states.slice(0, 4), ['starting', 'running', 'restarting', 'running']);
  await launcher.stop();
  assert.equal(launcher.getState(), 'stopped');
});

test('native-loader: disabled, missing and broken add-ons all give null instead of throwing', () => {
  assert.equal(isDisabled('robotjs', { SCOPEDESK_NATIVE: 'off' }), true);
  assert.equal(isDisabled('robotjs', { SCOPEDESK_NATIVE_DISABLED: 'active-win, robotjs' }), true);
  assert.equal(isDisabled('other', { SCOPEDESK_NATIVE_DISABLED: 'robotjs' }), false);
  const logs = [];
  assert.equal(loadNative('robotjs', { env: { SCOPEDESK_NATIVE: 'off' }, log: (l) => logs.push(l) }), null);
  assert.equal(loadNative('no-such-pkg-xyz', { env: {}, log: (l) => logs.push(l) }), null);
  const broken = () => { throw new Error('NODE_MODULE_VERSION 115 mismatch'); };
  assert.equal(loadNative('robotjs', { env: {}, requireFn: broken, log: (l) => logs.push(l) }), null);
  assert.equal(loadNative('robotjs', { env: {}, requireFn: () => ({ ok: 1 }) }).ok, 1);
  assert.equal(logs.length, 3);
});

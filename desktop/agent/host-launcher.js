'use strict';
/**
 * Starts the local host agent process and keeps it honest. Replaces any ad-hoc `spawn('node', [...])` / `exec('node ...')`
 * call that ends in the status text "Host agent: could not start: Node.js v22.x.y".
 *
 * Why that text appears: when a Node process dies on an uncaught error, the LAST line it prints is the banner
 * "Node.js v22.21.1". A launcher that shows only the last stderr line therefore shows the version and hides the real cause
 * (a native add-on built for another ABI, a flag Node 22 no longer knows, a missing module, node not on PATH ...).
 *
 * What this launcher does differently:
 *   1. Picks a runtime that really works: Electron's own Node (ELECTRON_RUN_AS_NODE=1) -> `node` from PATH / well-known
 *      folders (SCOPEDESK_NODE overrides) -> the current Node. Each candidate is probed with `--version` first.
 *   2. Drops Node flags the chosen runtime rejects (exit code 9 "bad option", e.g. --experimental-policy, --harmony-*),
 *      by asking the runtime itself, so the list never goes stale.
 *   3. Probes optional native add-ons (robotjs, active-win ...) one by one in a throw-away process. A broken add-on is
 *      switched off for the agent (SCOPEDESK_NATIVE_DISABLED / SCOPEDESK_NATIVE=off, see agent/native-loader.js), so the agent
 *      uses the built-in PowerShell / osascript / xdotool helpers of agent/input-executor.js instead of crashing.
 *   4. Handles every asynchronous stream failure (child 'error', stdout / stderr 'error', EPIPE), never lets one escape as an
 *      uncaught exception of the launching process, and kills the whole process tree on stop (taskkill /T on Windows).
 *   5. Turns a crash into a readable diagnosis ({ kind, headline, hint, detail }) instead of the Node banner line.
 *   6. Restarts an agent that dies later (back-off, at most `maxRestarts` times) and reports every change as a 'status' event.
 *
 * Usage (Electron main process or plain Node):
 *
 *   const { createHostLauncher } = require('./agent/host-launcher');
 *   const launcher = createHostLauncher({
 *     entry: path.join(__dirname, 'agent', 'client-agent.js'),
 *     env: { SERVER_URL, AGENT_TOKEN },
 *     log: console.log
 *   });
 *   launcher.on('status', (s) => mainWindow.webContents.send('scopedesk:host-status', s));
 *   const result = await launcher.start();      // never throws; { ok, pid, runtime, nodeVersion } or { ok:false, error }
 *   ...
 *   await launcher.stop();
 *
 * Events: 'status' ({ state: starting|running|restarting|failed|stopped, message, ... }), 'message' (object sent by the agent
 * with process.send), 'log' (string line from the agent's stdout / stderr).
 */

const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const childProcess = require('child_process');

const DEFAULT_NATIVE_MODULES = ['robotjs', 'active-win', '@nut-tree/nut-js', '@nut-tree-fork/nut-js', 'node-global-key-listener', 'iohook', 'ffi-napi', 'node-window-manager'];
const MIN_NODE_MAJOR = 18;
const TAIL_BYTES = 16 * 1024;

// ---------------------------------------------------------------- helpers

function tail(text, max = TAIL_BYTES) {
  return text.length > max ? text.slice(text.length - max) : text;
}

function parseMajor(version) {
  const m = /^v?(\d+)\./.exec(String(version || '').trim());
  return m ? Number(m[1]) : 0;
}

function pathKey(env) {
  return Object.keys(env).find((k) => k.toLowerCase() === 'path') || 'PATH';
}

function isFile(fsImpl, p) {
  try { return fsImpl.statSync(p).isFile(); } catch (_) { return false; }
}

/** Finds a system-wide Node binary without spawning anything. */
function findSystemNode({ platform = process.platform, env = process.env, fsImpl = fs } = {}) {
  if (env.SCOPEDESK_NODE && isFile(fsImpl, env.SCOPEDESK_NODE)) return env.SCOPEDESK_NODE;
  const name = platform === 'win32' ? 'node.exe' : 'node';
  const dirs = String(env[pathKey(env)] || '').split(platform === 'win32' ? ';' : ':').filter(Boolean);
  for (const dir of dirs) {
    const candidate = path.join(dir.replace(/^"|"$/g, ''), name);
    if (isFile(fsImpl, candidate)) return candidate;
  }
  const known = platform === 'win32'
    ? [env.ProgramFiles && path.join(env.ProgramFiles, 'nodejs', name), env['ProgramFiles(x86)'] && path.join(env['ProgramFiles(x86)'], 'nodejs', name),
      env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, 'Programs', 'nodejs', name), env.NVM_SYMLINK && path.join(env.NVM_SYMLINK, name)]
    : ['/usr/local/bin/node', '/opt/homebrew/bin/node', '/usr/bin/node'];
  for (const candidate of known.filter(Boolean)) if (isFile(fsImpl, candidate)) return candidate;
  return null;
}

/**
 * Ordered list of runtimes worth trying. Each: { kind, command, env (overrides), asar (can it read app.asar?) }.
 */
function candidateRuntimes({ platform = process.platform, env = process.env, execPath = process.execPath, versions = process.versions, fsImpl = fs } = {}) {
  const list = [];
  if (versions && versions.electron) {
    list.push({ kind: 'electron-as-node', command: execPath, env: { ELECTRON_RUN_AS_NODE: '1' }, asar: true });
  } else {
    list.push({ kind: 'current-node', command: execPath, env: {}, asar: false });
  }
  const system = findSystemNode({ platform, env, fsImpl });
  if (system && path.resolve(system) !== path.resolve(execPath)) list.push({ kind: 'system-node', command: system, env: {}, asar: false });
  return list;
}

/** Environment for the child: base env, caller overrides, runtime overrides. ELECTRON_RUN_AS_NODE only for Electron-as-node. */
function buildChildEnv(baseEnv, extraEnv, runtime, nativeEnv) {
  const env = { ...baseEnv, ...(extraEnv || {}) };
  if (runtime.kind !== 'electron-as-node') delete env.ELECTRON_RUN_AS_NODE;
  delete env.ELECTRON_NO_ATTACH_CONSOLE;
  Object.assign(env, runtime.env || {}, nativeEnv || {});
  return env;
}

/** A packaged app keeps files in app.asar. Only Electron can read inside it; plain node needs the unpacked copy. */
function resolveEntryForRuntime(entry, runtime, fsImpl = fs) {
  const marker = `app.asar${path.sep}`;
  if (runtime.asar || !entry.includes(marker)) return { entry };
  const unpacked = entry.replace(marker, `app.asar.unpacked${path.sep}`);
  if (isFile(fsImpl, unpacked)) return { entry: unpacked };
  return { entry: null, reason: 'The agent script is inside app.asar and has no unpacked copy (add it to asarUnpack).' };
}

// ---------------------------------------------------------------- probes (all synchronous, all time-limited, none can throw)

function probeRuntime(runtime, { env, spawnSync = childProcess.spawnSync } = {}) {
  try {
    const r = spawnSync(runtime.command, ['--version'], { env, timeout: 8000, windowsHide: true, encoding: 'utf8' });
    if (r.error) return { ok: false, reason: `${r.error.code || 'ERROR'}: ${r.error.message}` };
    const version = String(r.stdout || '').trim();
    if (r.status !== 0 || !/^v\d+\./.test(version)) return { ok: false, reason: `exit ${r.status}: ${String(r.stderr || version).trim().slice(0, 200)}` };
    if (parseMajor(version) < MIN_NODE_MAJOR) return { ok: false, reason: `Node.js ${version} is older than ${MIN_NODE_MAJOR}` };
    return { ok: true, version };
  } catch (err) {
    return { ok: false, reason: err.message };
  }
}

/** Does this runtime accept the flag? (Node exits with 9 and "bad option" for flags it does not know.) */
function flagAccepted(runtime, flag, { env, spawnSync = childProcess.spawnSync } = {}) {
  try {
    const r = spawnSync(runtime.command, [flag, '-e', '0'], { env, timeout: 8000, windowsHide: true, encoding: 'utf8' });
    if (r.error) return true;                                   // cannot tell: keep the flag, the launch will report the real error
    return !(r.status === 9 || /bad option/i.test(String(r.stderr || '')));
  } catch (_) {
    return true;
  }
}

/** Removes Node flags the runtime does not know. Script arguments (everything not starting with "-") are never touched. */
function sanitizeNodeArgs(runtime, nodeArgs, probeOptions) {
  const kept = [];
  const dropped = [];
  for (const arg of nodeArgs || []) {
    if (typeof arg !== 'string' || !arg.startsWith('-')) { kept.push(arg); continue; }
    if (flagAccepted(runtime, arg, probeOptions)) kept.push(arg); else dropped.push(arg);
  }
  return { kept, dropped };
}

/** Loads every installed add-on in its own throw-away process; returns the names that fail to load. */
function probeNative(runtime, modules, { env, cwd, spawnSync = childProcess.spawnSync } = {}) {
  const broken = [];
  const checked = [];
  for (const name of modules) {
    let resolved;
    try { resolved = require.resolve(name, { paths: [cwd || process.cwd()] }); } catch (_) { continue; }   // not installed: nothing to break
    checked.push(name);
    try {
      const r = spawnSync(runtime.command, ['-e', 'require(process.env.SCOPEDESK_PROBE_FILE)'], {
        env: { ...env, SCOPEDESK_PROBE_FILE: resolved }, cwd, timeout: 15000, windowsHide: true, encoding: 'utf8'
      });
      if (r.error || r.status !== 0) broken.push({ name, message: firstUsefulLine(String((r.error && r.error.message) || r.stderr || `exit ${r.status}`)) });
    } catch (err) {
      broken.push({ name, message: err.message });
    }
  }
  return { checked, broken };
}

// ---------------------------------------------------------------- crash diagnosis

function cleanStderr(text) {
  return String(text || '').split(/\r?\n/).map((l) => l.replace(/\s+$/, ''))
    .filter((l) => l && !/^Node\.js v\d+\.\d+\.\d+/.test(l)).join('\n');
}

function firstUsefulLine(text) {
  const lines = cleanStderr(text).split('\n');
  return (lines.find((l) => /error|cannot|failed|invalid|bad option|not found|denied/i.test(l)) || lines[0] || '').slice(0, 300);
}

/**
 * Explains why the agent could not start. The "Node.js v22.x" banner line is removed first: it is never the cause.
 * @returns {{ kind:string, headline:string, hint:string, detail:string }}
 */
function diagnoseCrash({ stderr = '', code = null, signal = null, spawnError = null, command = 'node' } = {}) {
  const text = cleanStderr(stderr);
  const detail = text.slice(-1500);
  const make = (kind, headline, hint) => ({ kind, headline, hint, detail });

  if (spawnError) {
    if (spawnError.code === 'ENOENT') return make('runtime-missing', `Could not find the Node.js program (${command}).`, 'Install Node.js 18 or newer, or set SCOPEDESK_NODE to the full path of node.exe.');
    if (spawnError.code === 'EACCES' || spawnError.code === 'EPERM') return make('runtime-permission', `Windows or the OS refused to run ${command}.`, 'Check antivirus / file permissions on that file.');
    return make('spawn-error', `The agent process could not be created: ${spawnError.message}`, 'See the details below.');
  }
  if (/NODE_MODULE_VERSION|compiled against a different Node\.js version|ERR_DLOPEN_FAILED|invalid ELF header|not a valid Win32 application|The specified module could not be found/i.test(text)) {
    return make('native-abi', 'A native add-on was built for a different Node.js / Electron version.', 'ScopeDesk switches such add-ons off automatically. To use one anyway run: npx @electron/rebuild');
  }
  const bad = /bad option:\s*(\S+)/i.exec(text);
  if (bad) return make('bad-flag', `Node.js does not know the option ${bad[1]}.`, 'Remove that flag from the launch arguments (the launcher already drops unknown flags).');
  const missing = /Cannot find module '([^']+)'/.exec(text);
  if (missing) return make('missing-module', `The module "${missing[1]}" is not installed.`, 'Run: npm install (in the ScopeDesk folder).');
  if (/ERR_REQUIRE_ESM|ERR_REQUIRE_ASYNC_MODULE|Cannot use import statement outside a module|ERR_UNKNOWN_FILE_EXTENSION/i.test(text)) {
    return make('module-format', 'A file mixes CommonJS (require) and ES modules (import).', 'Use one style per file, or rename the file to .mjs / .cjs.');
  }
  if (/EADDRINUSE/.test(text)) return make('port-in-use', 'The agent\'s port is already in use.', 'Close the other ScopeDesk instance and try again.');
  if (/EACCES|EPERM/.test(text)) return make('permission', 'The agent was denied access to a file or port.', 'Check the folder permissions and any security software.');
  if (/SyntaxError/.test(text)) return make('syntax', `The agent script has a syntax error: ${firstUsefulLine(text)}`, 'Fix the script shown in the details.');
  const headline = firstUsefulLine(text) || (signal ? `The agent was stopped by signal ${signal}.` : `The agent exited immediately with code ${code}.`);
  return make('crash', headline, 'See the details below.');
}

// ---------------------------------------------------------------- the launcher

/**
 * @param {object} options
 * @param {string}   options.entry          absolute path of the agent script
 * @param {string[]} [options.args]         arguments for the script
 * @param {string[]} [options.nodeArgs]     Node flags (unknown ones are dropped per runtime)
 * @param {object}   [options.env]          extra environment variables for the agent
 * @param {string}   [options.cwd]          working directory (default: project root = parent of agent/)
 * @param {string[]} [options.nativeModules] add-ons to probe (default list covers robotjs, active-win, nut-js ...)
 * @param {number}   [options.readyMs]      the agent counts as started when it sends {type:'ready'} or survives this long (default 2000)
 * @param {number}   [options.maxRestarts]  automatic restarts after a later crash (default 3)
 * @param {number[]} [options.backoffMs]    delays before each restart (default 500, 1500, 4000)
 * @param {Function} [options.log]
 * @param {object[]} [options.runtimes]     override runtime discovery (tests)
 */
function createHostLauncher(options) {
  const opts = options || {};
  const log = opts.log || (() => {});
  const spawn = opts.spawn || childProcess.spawn;
  const spawnSync = opts.spawnSync || childProcess.spawnSync;
  const fsImpl = opts.fsImpl || fs;
  const emitter = new EventEmitter();
  const cwd = opts.cwd || path.resolve(__dirname, '..');
  const readyMs = Number.isFinite(opts.readyMs) ? opts.readyMs : 2000;
  const maxRestarts = Number.isFinite(opts.maxRestarts) ? opts.maxRestarts : 3;
  const backoffMs = opts.backoffMs || [500, 1500, 4000];
  const nativeModules = opts.nativeModules || DEFAULT_NATIVE_MODULES;
  const baseEnv = opts.baseEnv || process.env;

  let state = 'idle';
  let child = null;
  let current = null;           // { runtime, entry, nodeArgs, env, nodeVersion }
  let stopping = false;
  let restarts = 0;
  let startPromise = null;
  let restartTimer = null;

  function setState(next, extra = {}) {
    state = next;
    const status = { state, ...extra };
    log(`[host] ${state}${extra.message ? ': ' + extra.message : ''}`);
    try { emitter.emit('status', status); } catch (err) { log('[host] status listener failed: ' + err.message); }
  }

  /** One spawn. Resolves { ok:true, child } once the agent is up, or { ok:false, spawnError|exit info, stderr }. Never rejects. */
  function attempt(plan) {
    return new Promise((resolve) => {
      let settled = false;
      let stderr = '';
      let timer = null;
      let proc;
      const finish = (result) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        resolve(result);
      };
      try {
        proc = spawn(plan.runtime.command, [...plan.nodeArgs, plan.entry, ...(opts.args || [])], {
          cwd, env: plan.env, stdio: ['ignore', 'pipe', 'pipe', 'ipc'], windowsHide: true, shell: false
        });
      } catch (err) {
        finish({ ok: false, spawnError: err, stderr: '' });
        return;
      }

      const onData = (chunk) => {
        const text = chunk.toString('utf8');
        stderr = tail(stderr + text);
        for (const line of text.split(/\r?\n/)) if (line) { try { emitter.emit('log', line); } catch (_) { /* listener problem */ } }
      };
      // Stream failures (EPIPE, ECONNRESET after the child dies) must never become uncaught exceptions of the launching process.
      for (const stream of [proc.stdout, proc.stderr]) {
        if (!stream) continue;
        stream.on('data', onData);
        stream.on('error', (err) => log('[host] agent stream error: ' + err.message));
      }
      proc.on('error', (err) => {
        log('[host] agent process error: ' + err.message);
        finish({ ok: false, spawnError: err, stderr });
      });
      proc.on('message', (msg) => {
        if (msg && msg.type === 'ready') finish({ ok: true, child: proc, getStderr: () => stderr });
        try { emitter.emit('message', msg); } catch (_) { /* listener problem */ }
      });
      proc.on('exit', (code, signal) => {
        if (!settled) finish({ ok: false, code, signal, stderr });
      });
      timer = setTimeout(() => {
        if (proc.exitCode === null && proc.signalCode === null) finish({ ok: true, child: proc, getStderr: () => stderr });
      }, readyMs);
      if (timer.unref) timer.unref();
    });
  }

  function watch(proc, getStderr) {
    child = proc;
    const startedAt = Date.now();
    proc.on('exit', (code, signal) => {
      if (child === proc) child = null;
      if (stopping) return;
      if (Date.now() - startedAt > 60000) restarts = 0;       // it ran stably for a minute: a new crash gets a fresh budget
      const why = diagnoseCrash({ stderr: getStderr(), code, signal, command: current.runtime.command });
      if (restarts >= maxRestarts) {
        setState('failed', { message: `${why.headline} (gave up after ${restarts} restarts)`, error: why });
        return;
      }
      const delay = backoffMs[Math.min(restarts, backoffMs.length - 1)];
      restarts += 1;
      setState('restarting', { message: `${why.headline} Restarting in ${delay} ms (${restarts}/${maxRestarts}).`, error: why });
      restartTimer = setTimeout(() => { restartTimer = null; if (!stopping) revive(); }, delay);
      if (restartTimer.unref) restartTimer.unref();
    });
  }

  async function revive() {
    const r = await attempt({ runtime: current.runtime, entry: current.entry, nodeArgs: current.nodeArgs, env: current.env });
    if (stopping) { if (r.ok) killTree(r.child); return; }
    if (r.ok) { watch(r.child, r.getStderr); setState('running', { message: 'Host agent restarted.', pid: r.child.pid, runtime: current.runtime.kind, nodeVersion: current.nodeVersion }); return; }
    const err = r.spawnError ? diagnoseCrash({ spawnError: r.spawnError, command: current.runtime.command }) : diagnoseCrash({ stderr: r.stderr, code: r.code, signal: r.signal });
    if (restarts >= maxRestarts) { setState('failed', { message: `${err.headline} (gave up after ${restarts} restarts)`, error: err }); return; }
    const wait = backoffMs[Math.min(restarts, backoffMs.length - 1)];
    restarts += 1;
    setState('restarting', { message: `${err.headline} Restarting in ${wait} ms (${restarts}/${maxRestarts}).`, error: err });
    restartTimer = setTimeout(() => { restartTimer = null; if (!stopping) revive(); }, wait);
    if (restartTimer.unref) restartTimer.unref();
  }

  async function doStart() {
    stopping = false;
    restarts = 0;
    setState('starting', { message: 'Starting the host agent...' });

    const entry = opts.entry;
    if (!entry || !isFile(fsImpl, entry)) {
      const error = { kind: 'entry-missing', headline: `The agent script was not found: ${entry || '(no entry given)'}`, hint: 'Check the path passed to createHostLauncher({ entry }).', detail: '' };
      setState('failed', { message: error.headline, error });
      return { ok: false, error };
    }

    const runtimes = opts.runtimes || candidateRuntimes({ env: baseEnv, fsImpl });
    const tried = [];
    let firstError = null;

    for (const runtime of runtimes) {
      const baseChildEnv = buildChildEnv(baseEnv, opts.env, runtime, null);
      const probe = probeRuntime(runtime, { env: baseChildEnv, spawnSync });
      if (!probe.ok) { tried.push(`${runtime.kind}: ${probe.reason}`); log(`[host] skipping ${runtime.kind}: ${probe.reason}`); continue; }

      const located = resolveEntryForRuntime(entry, runtime, fsImpl);
      if (!located.entry) { tried.push(`${runtime.kind}: ${located.reason}`); continue; }

      const flags = sanitizeNodeArgs(runtime, opts.nodeArgs, { env: baseChildEnv, spawnSync });
      if (flags.dropped.length) log(`[host] ${runtime.kind} does not accept ${flags.dropped.join(' ')}; dropped`);

      const natives = probeNative(runtime, nativeModules, { env: baseChildEnv, cwd, spawnSync });
      const nativeEnv = natives.broken.length ? { SCOPEDESK_NATIVE_DISABLED: natives.broken.map((b) => b.name).join(',') } : {};
      if (natives.broken.length) log(`[host] native add-ons switched off: ${natives.broken.map((b) => `${b.name} (${b.message})`).join('; ')}`);

      let plan = { runtime, entry: located.entry, nodeArgs: flags.kept, env: buildChildEnv(baseEnv, opts.env, runtime, nativeEnv), nodeVersion: probe.version };
      let result = await attempt(plan);

      // The agent died on an add-on the probe did not catch: switch every add-on off and try once more on the same runtime.
      if (!result.ok && !result.spawnError && diagnoseCrash({ stderr: result.stderr }).kind === 'native-abi') {
        log('[host] a native add-on crashed the agent; retrying with all native add-ons off');
        plan = { ...plan, env: buildChildEnv(baseEnv, opts.env, runtime, { SCOPEDESK_NATIVE: 'off' }) };
        const retry = await attempt(plan);
        if (retry.ok) result = retry; else if (!firstError) firstError = result;
      }

      if (result.ok) {
        current = plan;
        watch(result.child, result.getStderr);
        const message = natives.broken.length
          ? `Host agent running on Node.js ${probe.version} (${natives.broken.map((b) => b.name).join(', ')} replaced by built-in helpers).`
          : `Host agent running on Node.js ${probe.version}.`;
        setState('running', { message, pid: result.child.pid, runtime: runtime.kind, nodeVersion: probe.version, nativeDisabled: natives.broken.map((b) => b.name) });
        return { ok: true, pid: result.child.pid, runtime: runtime.kind, nodeVersion: probe.version, nativeDisabled: natives.broken.map((b) => b.name) };
      }
      if (!firstError) firstError = result;
      const why = result.spawnError ? diagnoseCrash({ spawnError: result.spawnError, command: runtime.command }) : diagnoseCrash({ stderr: result.stderr, code: result.code, signal: result.signal });
      tried.push(`${runtime.kind} (${probe.version}): ${why.headline}`);
    }

    const error = firstError
      ? (firstError.spawnError ? diagnoseCrash({ spawnError: firstError.spawnError, command: runtimes[0] && runtimes[0].command }) : diagnoseCrash({ stderr: firstError.stderr, code: firstError.code, signal: firstError.signal }))
      : { kind: 'runtime-missing', headline: 'No working Node.js runtime was found.', hint: 'Install Node.js 18 or newer, or set SCOPEDESK_NODE to the full path of node.exe.', detail: '' };
    error.tried = tried;
    setState('failed', { message: error.headline, error });
    return { ok: false, error };
  }

  function killTree(proc) {
    if (!proc || proc.exitCode !== null || proc.signalCode !== null) return;
    try {
      if (process.platform === 'win32' && proc.pid) {
        const killer = spawn('taskkill', ['/pid', String(proc.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
        killer.on('error', () => { try { proc.kill(); } catch (_) { /* already gone */ } });
      } else {
        proc.kill('SIGTERM');
        const hard = setTimeout(() => { try { proc.kill('SIGKILL'); } catch (_) { /* already gone */ } }, 2000);
        if (hard.unref) hard.unref();
      }
    } catch (_) { /* already gone */ }
  }

  return Object.assign(emitter, {
    /** Starts the agent. Safe to call twice (the second call returns the first result). Never throws. */
    start() {
      if (!startPromise) {
        startPromise = doStart().catch((err) => {
          const error = { kind: 'launcher-bug', headline: `Unexpected launcher error: ${err.message}`, hint: 'Please report this.', detail: String(err.stack || '') };
          setState('failed', { message: error.headline, error });
          return { ok: false, error };
        });
      }
      return startPromise;
    },
    /** Stops the agent and its child processes; resolves when it has exited (at most 3 s). */
    async stop() {
      stopping = true;
      if (restartTimer) { clearTimeout(restartTimer); restartTimer = null; }
      const proc = child;
      if (proc && proc.exitCode === null && proc.signalCode === null) {
        await new Promise((resolve) => {
          const t = setTimeout(resolve, 3000);
          if (t.unref) t.unref();
          proc.once('exit', () => { clearTimeout(t); resolve(); });
          killTree(proc);
        });
      }
      child = null;
      startPromise = null;
      setState('stopped', { message: 'Host agent stopped.' });
    },
    /** Sends an object to the agent (process.send). Returns false when it is not running. */
    send(message) {
      if (!child || !child.connected) return false;
      try { return child.send(message); } catch (_) { return false; }
    },
    getState: () => state,
    getPid: () => (child ? child.pid : null)
  });
}

module.exports = {
  createHostLauncher, diagnoseCrash, candidateRuntimes, findSystemNode, sanitizeNodeArgs, probeNative, probeRuntime,
  resolveEntryForRuntime, buildChildEnv, DEFAULT_NATIVE_MODULES
};

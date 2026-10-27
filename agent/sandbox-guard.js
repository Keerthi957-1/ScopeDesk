'use strict';
/**
 * ScopeDesk zero-trust sandbox guard. Runs ON THE CLIENT'S PC (the host agent / Electron main process).
 *
 * Every payload the vendor sends over the WebRTC data channel must pass through guard.handlePayload() BEFORE
 * anything is executed. Nothing the vendor's browser says is trusted: the approved apps and folders come from the
 * task row (see GET /api/agent/scope) and are fixed for the life of the guard.
 *
 * A payload that asks to run an app that is not approved, or to touch a folder outside the approved folders,
 * triggers an immediate lockdown (see lockdown()):
 *   1. every further payload is refused,
 *   2. all WebRTC peer connections and data channels are closed,
 *   3. the workstation is locked (Windows: rundll32.exe user32.dll,LockWorkStation),
 *   4. the violation is reported so the server terminates the task and pushes the alert overlay to the Client.
 */
const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFile } = require('child_process');
const catalog = require('./app-catalog');

const MAX_PAYLOAD_BYTES = 8 * 1024;

// A payload is an "execution" payload when it carries any of these fields, whatever its `type` says.
// Gating on fields (not on a list of type names) means a renamed or invented command cannot slip past the check.
const APP_FIELDS = ['app', 'application', 'process', 'processName', 'exe', 'program', 'launch', 'run', 'exec', 'command', 'cmd'];
const PATH_FIELDS = ['path', 'folder', 'dir', 'directory', 'file', 'target', 'location', 'openPath', 'cwd'];

const isWin = (platform) => platform === 'win32';

function pickField(msg, names) {
  for (const n of names) if (msg[n] !== undefined && msg[n] !== null && msg[n] !== '') return { field: n, value: msg[n] };
  return null;
}

/** First program name of a command line: `"C:\Apps\Billing.exe" /x` -> `C:\Apps\Billing.exe`. */
function programOf(value) {
  const s = String(value).trim();
  const q = s.match(/^"([^"]+)"/);
  if (q) return q[1];
  // An unquoted path may contain spaces ("C:\Program Files\Office\EXCEL.EXE /safe"): stop at the executable extension.
  const ext = s.match(/^(.+?\.(?:exe|app|msi|bat|cmd|com|lnk|scr|ps1|jar|bin|sh))(?:\s|$)/i);
  return ext ? ext[1] : s.split(/\s+/)[0];
}

// ---------- path handling ----------
function expandEnv(p, platform, env) {
  let out = String(p);
  if (out === '~' || /^~[\\/]/.test(out)) out = path.join(env.USERPROFILE || env.HOME || os.homedir(), out.slice(1));
  out = out.replace(/%([^%\r\n]+)%/g, (whole, name) => {
    const key = Object.keys(env).find((k) => (isWin(platform) ? k.toLowerCase() === name.toLowerCase() : k === name));
    return key ? env[key] : whole;
  });
  return out;
}

/**
 * Canonical, comparable form of an absolute path, or null if it must never be accepted.
 *  - resolves ".." and "." and mixed slashes
 *  - follows symlinks / junctions for the part that exists (so a link inside an approved folder cannot point outside it)
 *  - Windows: rejects \\?\ and \\.\ device paths and alternate data streams, strips trailing dots/spaces, ignores case
 */
function canonicalPath(input, { platform, env, realpath }) {
  const p0 = expandEnv(input, platform, env);
  const api = isWin(platform) ? path.win32 : path.posix;
  if (/[\u0000-\u001f]/.test(p0)) return null;
  if (isWin(platform)) {
    if (/^[\\/]{2}[?.][\\/]/.test(p0)) return null;                        // device namespace
    if (/^[a-zA-Z]:/.test(p0) ? p0.slice(2).includes(':') : p0.includes(':')) return null;   // NTFS alternate data stream
  }
  if (!api.isAbsolute(p0)) return null;

  let resolved = api.normalize(p0);
  if (isWin(platform)) {
    resolved = resolved.split('\\').map((seg, i) => (i === 0 ? seg : seg.replace(/[. ]+$/, ''))).join('\\');
    resolved = api.normalize(resolved);
  }
  // Follow links: realpath the deepest existing ancestor, then re-append the rest.
  let head = resolved;
  const tail = [];
  for (let guard = 0; guard < 64; guard++) {
    try {
      const real = realpath(head);
      resolved = tail.length ? api.join(real, ...tail.reverse()) : real;
      break;
    } catch (_) {
      const parent = api.dirname(head);
      if (parent === head) break;
      tail.push(api.basename(head));
      head = parent;
    }
  }
  resolved = api.normalize(resolved).replace(/[\\/]+$/, '') || api.sep;
  if (isWin(platform)) resolved = resolved.replace(/^\\\\\?\\/, '').toLowerCase();
  return resolved;
}

function isInside(root, target, platform) {
  const api = isWin(platform) ? path.win32 : path.posix;
  const rel = api.relative(root, target);
  if (rel === '') return true;
  return rel !== '..' && !rel.startsWith('..' + api.sep) && !api.isAbsolute(rel);
}

// ---------- workstation lock ----------
function lockCommand(platform, env) {
  if (platform === 'win32') {
    const root = env.SystemRoot || env.windir || 'C:\\Windows';
    return { file: path.win32.join(root, 'System32', 'rundll32.exe'), args: ['user32.dll,LockWorkStation'] };
  }
  if (platform === 'darwin') return { file: '/usr/bin/pmset', args: ['displaysleepnow'] };   // locks when "Require password after sleep" is on
  return { file: 'loginctl', args: ['lock-session'] };
}

/**
 * Every command to try, in order, until one works.
 *   macOS : CGSession -suspend drops to the login window (a real lock, the user session stays alive);
 *           it is not present on every macOS release, so pmset displaysleepnow is the fallback (locks if "Require password" is immediate).
 */
function lockCommands(platform, env) {
  if (platform === 'darwin') {
    return [
      { file: '/System/Library/CoreServices/Menu Extras/User.menu/Contents/Resources/CGSession', args: ['-suspend'] },
      lockCommand(platform, env)
    ];
  }
  return [lockCommand(platform, env)];
}

async function defaultLockWorkstation({ platform = process.platform, env = process.env, exec = execFile, timeoutMs = 5000 } = {}) {
  let lastError = null;
  for (const { file, args } of lockCommands(platform, env)) {
    try {
      await new Promise((resolve, reject) => {
        exec(file, args, { windowsHide: true, timeout: timeoutMs }, (err) => (err ? reject(err) : resolve()));
      });
      return;
    } catch (err) { lastError = err; }
  }
  throw lastError || new Error('no lock command available');
}

/**
 * @param {object} cfg
 * @param {number} cfg.taskId
 * @param {string[]} cfg.allowedApps      clean names from the task ("Excel", "Billing Manager")
 * @param {string[]} cfg.allowedPaths     the approved folders (the file manager may open these and their sub-folders)
 * @param {() => (void|Promise<void>)} cfg.closeConnections   closes EVERY RTCPeerConnection and RTCDataChannel
 * @param {(v:{taskId:number,kind:'app'|'path',processName:string,detail:string}) => Promise<any>} cfg.reportViolation
 *        usually: (v) => socket.emitWithAck('host-violation', v)
 * @param {() => Promise<void>} [cfg.lockWorkstation]   default: the OS lock command
 */
function createSandboxGuard(cfg) {
  const platform = cfg.platform || process.platform;
  const env = cfg.env || process.env;
  const realpath = cfg.realpath || ((p) => fs.realpathSync.native(p));
  const lock = cfg.lockWorkstation || (() => defaultLockWorkstation({ platform, env, exec: cfg.exec }));
  const log = cfg.log || (() => {});
  if (!Number.isInteger(cfg.taskId)) throw new Error('sandbox-guard: taskId is required');
  if (typeof cfg.closeConnections !== 'function') throw new Error('sandbox-guard: closeConnections() is required');
  if (typeof cfg.reportViolation !== 'function') throw new Error('sandbox-guard: reportViolation() is required');

  const allowedApps = Object.freeze([...(cfg.allowedApps || [])].map(String));
  const allowedRoots = Object.freeze(
    (cfg.allowedPaths || []).map((p) => canonicalPath(p, { platform, env, realpath })).filter(Boolean)
  );
  let lockedDown = null;   // result of the lockdown, set once

  function breach(kind, processName, detail) {
    return { ok: false, breach: true, kind, processName, detail };
  }

  /** Checks one payload. Never executes anything. */
  function inspect(raw) {
    if (lockedDown) return { ok: false, reason: 'locked' };

    let msg = raw;
    if (typeof raw === 'string') {
      if (Buffer.byteLength(raw, 'utf8') > MAX_PAYLOAD_BYTES) return { ok: false, reason: 'too-large' };
      try { msg = JSON.parse(raw); } catch (_) { return { ok: false, reason: 'malformed' }; }
    } else if (Buffer.isBuffer(raw) || raw instanceof ArrayBuffer) {
      return inspect(Buffer.from(raw).toString('utf8'));
    }
    if (!msg || typeof msg !== 'object' || Array.isArray(msg)) return { ok: false, reason: 'malformed' };

    const sanitized = { ...msg };

    // ----- application -----
    const appField = pickField(msg, APP_FIELDS);
    if (appField) {
      if (typeof appField.value !== 'string') return { ok: false, reason: 'malformed' };
      const program = programOf(appField.value);
      const clean = catalog.cleanAppName(program);
      if (!clean) return { ok: false, reason: 'malformed' };
      const fileManager = catalog.isFileManager(clean);
      if (!fileManager && !catalog.isAppAllowed(clean, allowedApps)) {
        return breach('app', clean, `tried to run ${clean}, which is not in the approved applications`);
      }
      sanitized[appField.field] = clean;     // the executor receives the clean, approved name, never the raw string
      if (fileManager && !pickField(msg, PATH_FIELDS)) {
        return breach('path', clean, 'tried to open the file manager without an approved folder');
      }
    }

    // ----- folder / file -----
    const pathField = pickField(msg, PATH_FIELDS);
    if (pathField) {
      if (typeof pathField.value !== 'string' || pathField.value.length > 260) return { ok: false, reason: 'malformed' };
      const canon = canonicalPath(pathField.value, { platform, env, realpath });
      if (!canon) {
        const looksAbsolute = (isWin(platform) ? path.win32 : path.posix).isAbsolute(expandEnv(pathField.value, platform, env));
        // A relative path cannot be proven safe: refuse it (not a breach, probably a typo).
        // An absolute path that cannot be canonicalised (device path, stream, control characters) is an evasion attempt.
        if (!looksAbsolute) return { ok: false, reason: 'invalid-path' };
        return breach('path', 'file manager', `tried to open a path that cannot be verified: ${String(pathField.value).slice(0, 120)}`);
      }
      if (!allowedRoots.some((root) => isInside(root, canon, platform))) {
        return breach('path', 'file manager', `tried to open ${String(pathField.value).slice(0, 200)}, outside the approved folders`);
      }
      sanitized[pathField.field] = canon;
    }

    return { ok: true, payload: sanitized, gated: !!(appField || pathField) };
  }

  /** Immediate lockdown. Safe to call twice: the second call returns the first result. */
  async function lockdown(violation) {
    if (lockedDown) return lockedDown;
    const result = { closed: false, locked: false, reported: false, errors: [], violation };
    lockedDown = result;                                   // from this instant inspect() refuses everything

    try { await cfg.closeConnections(); result.closed = true; }
    catch (e) { result.errors.push('close: ' + e.message); }

    const report = (async () => {
      for (let attempt = 1; attempt <= 3 && !result.reported; attempt++) {
        try {
          const ack = await cfg.reportViolation({
            taskId: cfg.taskId, kind: violation.kind, processName: violation.processName, detail: violation.detail
          });
          if (ack && ack.ok === false) throw new Error(ack.error || 'server refused the report');
          result.reported = true;
        } catch (e) {
          result.errors.push(`report#${attempt}: ${e.message}`);
          if (attempt < 3) await new Promise((r) => setTimeout(r, 400 * attempt));
        }
      }
    })();
    const locking = (async () => {
      try { await lock(); result.locked = true; }
      catch (e) { result.errors.push('lock: ' + e.message); }
    })();
    await Promise.allSettled([report, locking]);

    log('[guard] lockdown complete', { ...result, violation: undefined });
    return result;
  }

  /**
   * Use this in the data-channel `onmessage`:
   *   const r = await guard.handlePayload(event.data);
   *   if (r.ok) execute(r.payload);        // only ever run the sanitized payload
   */
  async function handlePayload(raw) {
    const verdict = inspect(raw);
    if (verdict.breach) {
      const outcome = await lockdown({ kind: verdict.kind, processName: verdict.processName, detail: verdict.detail });
      return { ok: false, breach: true, kind: verdict.kind, lockdown: outcome };
    }
    return verdict;
  }

  return { handlePayload, inspect, lockdown, isLockedDown: () => !!lockedDown, scope: { allowedApps, allowedRoots } };
}

module.exports = { createSandboxGuard, canonicalPath, isInside, lockCommand, lockCommands, defaultLockWorkstation, MAX_PAYLOAD_BYTES };

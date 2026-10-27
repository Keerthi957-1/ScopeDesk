'use strict';
/**
 * Foreground-window monitor for the Client's PC.
 *
 * For the whole approved time window it watches which program is in front. If a program that is NOT in the task's allowed_apps
 * stays in front for more than `confirmMs` (default 350 ms, so a pop-up flickering past does not end a session), it calls
 * onBreach({ kind: 'app', processName, detail }) exactly once and stops. The caller (agent/host-runtime.js) answers that with the
 * breach sequence: cut every video track and peer connection, lock the PC, tell the server to end the task.
 *
 * Probes (all report the process behind the window in front, UWP / Store apps included):
 *   Windows  agent/native/windows-foreground.ps1   (long-lived PowerShell, prints one JSON line per change)
 *   macOS    agent/native/macos-foreground.js      (long-lived JXA, NSWorkspace frontmostApplication, no permission needed)
 *   Linux    xdotool getactivewindow, polled every 400 ms (X11)
 *
 * Rules
 *   - the file manager is acceptable only while its front window shows an approved folder (or a sub-folder). The probes report the
 *     folder (Windows: Shell.Application window path; macOS: Finder front window POSIX path). A folder outside allowedPaths, or one that
 *     cannot be verified, is a breach of kind 'path'. Virtual views (This PC, Quick access, Recents) have no path and are ignored
 *     until the vendor opens a real folder. With no allowedPaths at all, no folder policy exists and only the app is checked.
 *   - ScopeDesk's own window is acceptable while the Client is using it, but NOT right after remote input arrived:
 *     a vendor who clicks into the Client's ScopeDesk window is treated as a breach (getLastInputAt tells the difference)
 *   - blocked tools (cmd, PowerShell, Task Manager, regedit ...) are never acceptable, even if someone put them in allowed_apps
 */

const fs = require('fs');
const path = require('path');
const { spawn: nodeSpawn, execFile: nodeExecFile } = require('child_process');
const catalog = require('./app-catalog');
const { canonicalPath, isInside } = require('./sandbox-guard');

const OWN_APPS = new Set(['scopedesk', 'electron', 'scopedesk helper']);
// Parts of the OS that appear in front for a moment without the vendor choosing them
const IGNORED = new Set(['textinputhost', 'lockapp', 'logonui', 'consent', 'credentialuibroker', 'applicationframehost', 'dwm', 'csrss', 'winlogon', 'loginwindow', 'screensaverengine']);

function windowsSource({ spawn, env, log }) {
  const root = env.SystemRoot || env.windir || 'C:\\Windows';
  const powershell = path.win32.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const script = path.join(__dirname, 'native', 'windows-foreground.ps1');
  return lineSource({ spawn, log, file: powershell, args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script] });
}
function macSource({ spawn, log }) {
  return lineSource({ spawn, log, file: '/usr/bin/osascript', args: ['-l', 'JavaScript', path.join(__dirname, 'native', 'macos-foreground.js')] });
}

/** A long-lived child process that prints one JSON sample per line. Restarts itself if it dies. */
function lineSource({ spawn, log, file, args }) {
  let child = null;
  let stopped = true;
  let restartTimer = null;
  return {
    start(onSample) {
      stopped = false;
      const launch = () => {
        if (stopped) return;
        let buf = '';
        child = spawn(file, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
        child.stdout.on('data', (d) => {
          buf += String(d);
          const lines = buf.split(/\r?\n/);
          buf = lines.pop();
          for (const line of lines) {
            if (!line.trim()) continue;
            try { onSample(JSON.parse(line)); } catch (_) { /* partial or noisy line */ }
          }
        });
        child.stderr.on('data', (d) => log('[monitor] probe: ' + String(d).trim().slice(0, 200)));
        child.on('error', (e) => { log('[monitor] probe failed: ' + e.message); });
        child.on('exit', () => { child = null; if (!stopped) restartTimer = setTimeout(launch, 1000); });
      };
      launch();
    },
    stop() {
      stopped = true;
      clearTimeout(restartTimer);
      if (child) { try { child.kill(); } catch (_) { /* gone */ } child = null; }
    }
  };
}

function linuxSource({ execFile, log, intervalMs = 400 }) {
  let timer = null;
  const run = (args) => new Promise((resolve) => execFile('xdotool', args, { timeout: 2000 }, (err, out) => resolve(err ? '' : String(out).trim())));
  return {
    start(onSample) {
      const tick = async () => {
        const pid = Number(await run(['getactivewindow', 'getwindowpid']));
        if (!pid) return onSample({ name: '', pid: 0, title: '' });
        let name = '';
        try { name = fs.readFileSync(`/proc/${pid}/comm`, 'utf8').trim(); } catch (_) { log('[monitor] cannot read process name'); }
        onSample({ name, pid, title: await run(['getactivewindow', 'getwindowname']) });
      };
      timer = setInterval(() => tick().catch(() => {}), intervalMs);
    },
    stop() { clearInterval(timer); timer = null; }
  };
}

/**
 * @param {object} cfg
 * @param {string[]} [cfg.allowedPaths]                  approved folders (same list the sandbox guard uses)
 * @param {(p:string)=>string} [cfg.realpath]            symlink resolver (tests)
 * @param {string[]} cfg.allowedApps                     clean names from the task ("File Manager", "Calculator", "WhatsApp", "Notepad")
 * @param {number} [cfg.endsAt]                          epoch ms; the monitor stops by itself at the end of the approved window
 * @param {(v:{kind:'app',processName:string,detail:string}) => (void|Promise<void>)} cfg.onBreach
 * @param {() => number} [cfg.getLastInputAt]            epoch ms of the last remote input (agent/input-executor.js lastInputAt)
 * @param {{start:Function, stop:Function}} [cfg.source] inject a probe (tests)
 */
function createForegroundMonitor(cfg) {
  if (typeof cfg.onBreach !== 'function') throw new Error('foreground-monitor: onBreach() is required');
  const platform = cfg.platform || process.platform;
  const env = cfg.env || process.env;
  const log = cfg.log || (() => {});
  const spawn = cfg.spawn || nodeSpawn;
  const execFile = cfg.execFile || nodeExecFile;
  const now = cfg.now || (() => Date.now());
  const confirmMs = cfg.confirmMs === undefined ? 350 : cfg.confirmMs;
  const ownAppWindowMs = cfg.ownAppWindowMs === undefined ? 1500 : cfg.ownAppWindowMs;
  const allowedApps = Object.freeze([...(cfg.allowedApps || [])].map(String));
  const realpath = cfg.realpath || ((p) => fs.realpathSync.native(p));
  const allowedRoots = Object.freeze((cfg.allowedPaths || []).map((p) => canonicalPath(p, { platform, env, realpath })).filter(Boolean));
  const pathApi = platform === 'win32' ? path.win32 : path.posix;

  const source = cfg.source || (platform === 'win32' ? windowsSource({ spawn, env, log })
    : platform === 'darwin' ? macSource({ spawn, log })
      : linuxSource({ execFile, log }));

  let running = false;
  let pending = null;       // { key, name, title, timer }
  let endTimer = null;
  let current = null;       // last sample seen, for status
  let breached = false;

  function clearPending() { if (pending) { clearTimeout(pending.timer); pending = null; } }

  /** Folder check for a file-manager window. Returns null if fine, otherwise a reason. */
  function folderVerdict(folder) {
    if (!allowedRoots.length || !folder) return null;                       // no folder policy, or a virtual view without a path
    const looksAbsolute = pathApi.isAbsolute(folder);
    if (!looksAbsolute) return null;                                        // "::{GUID}" style shell locations: nothing to compare yet
    const canon = canonicalPath(folder, { platform, env, realpath });
    if (!canon) return `opened a folder that cannot be verified: ${String(folder).slice(0, 120)}`;
    if (!allowedRoots.some((root) => isInside(root, canon, platform))) return `opened ${String(folder).slice(0, 200)}, outside the approved folders`;
    return null;
  }

  /** Is this program (and, for the file manager, this folder) acceptable to have in front right now? Returns null if yes, otherwise { kind, reason }. */
  function verdict(name, folder) {
    const key = name.toLowerCase();
    if (!key || IGNORED.has(key)) return null;
    if (OWN_APPS.has(key)) {
      const last = cfg.getLastInputAt ? cfg.getLastInputAt() : 0;
      return last && now() - last < ownAppWindowMs ? { kind: 'app', reason: 'the vendor brought ScopeDesk itself to the front' } : null;
    }
    if (catalog.isFileManager(name)) {
      const why = folderVerdict(folder);
      return why ? { kind: 'path', reason: why } : null;
    }
    if (catalog.isAppAllowed(name, allowedApps)) return null;
    return { kind: 'app', reason: 'was brought to the front but is not in the approved applications' };
  }

  async function fire(name, title, v) {
    if (breached || !running) return;
    breached = true;
    stop();
    try {
      await cfg.onBreach({ kind: v.kind, processName: name, detail: `${name} ${v.reason}${title ? ` (window: ${String(title).slice(0, 120)})` : ''}` });
    } catch (err) { log('[monitor] onBreach failed: ' + err.message); }
  }

  function onSample(sample) {
    if (!running || breached || !sample) return;
    const name = catalog.cleanAppName(String(sample.name || '')) || '';
    const folder = typeof sample.path === 'string' ? sample.path.slice(0, 1024) : '';
    current = { name, title: String(sample.title || ''), pid: Number(sample.pid) || 0, path: folder };
    const bad = verdict(name, folder);
    if (!bad) { clearPending(); return; }
    const key = `${name.toLowerCase()}|${folder.toLowerCase()}`;
    if (pending && pending.key === key) return;     // already counting down for this program / folder
    clearPending();
    pending = {
      key,
      timer: setTimeout(() => { pending = null; fire(name, current && current.title, bad); }, confirmMs)
    };
  }

  function start() {
    if (running) return;
    running = true;
    breached = false;
    if (cfg.endsAt) {
      const left = Number(cfg.endsAt) - now();
      if (left <= 0) { stop(); return; }
      endTimer = setTimeout(stop, left);
      if (endTimer.unref) endTimer.unref();
    }
    source.start(onSample);
  }
  function stop() {
    running = false;
    clearPending();
    clearTimeout(endTimer);
    endTimer = null;
    try { source.stop(); } catch (_) { /* already stopped */ }
  }

  return { start, stop, isRunning: () => running, current: () => current, _onSample: onSample };
}

module.exports = { createForegroundMonitor, OWN_APPS, IGNORED };

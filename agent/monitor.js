'use strict';
// PROCESS + PATH SECURITY LOOP.
// Runs on the Client's PC, where the vendor's actions really land, so the vendor cannot tamper with it.
//
// A foreground window is "in scope" when BOTH hold:
//   1. its app is in the task policy's allowedApps (or is the task's approved app), and
//   2. if it is a file manager and the policy has allowedPaths: every folder it shows is inside an allowed path.
//
// States:  waiting -> armed -> locked
//   waiting  nothing in scope has been in front yet. Vendor input is ignored (view-only). The Client opens the app/folder.
//   armed    enforcement is on.
//   locked   a violation was reported (or the server halted control). Nothing is applied until the Client resumes.
//
// Two independent checks, so a fast vendor cannot slip between polls:
//   1. POLL:  every POLL_MS read the foreground. Out of scope + vendor input applied within ATTRIBUTION_MS -> violation
//             (a wrong folder at once, a wrong app after STRIKES polls to ignore Alt+Tab flicker).
//   2. GATE:  before applying any click/key/wheel, check again. Out of scope -> drop the input and report. (Pure mouse moves are
//             dropped but never reported, so the Client can still use their own browser to read the alert.)
const { normalize } = require('./config');

class ForegroundMonitor {
  constructor({ policy, probe, pollMs, strikes, attributionMs, onViolation, onState, log, debug }) {
    this.policy = policy; this.probe = probe;
    this.pollMs = pollMs; this.strikes = strikes; this.attributionMs = attributionMs;
    this.onViolation = onViolation; this.onState = onState; this.log = log; this.debug = !!debug;
    this.state = 'waiting';
    this.bad = 0;
    this.lastInputAt = 0;
    this.lastLabel = null;
    this.cache = { win: undefined, result: { ok: false }, at: 0 };
    this.timer = null;
    this.activeWindow = null;
  }

  setState(next) {
    if (this.state === next) return;
    this.state = next;
    this.bad = 0;
    this.onState(next);
  }

  async start() {
    // active-win v8 is ESM-only, hence import()
    this.activeWindow = (await import('active-win')).activeWindow;
    this.timer = setInterval(() => this.poll().catch((e) => this.log('warn', 'Could not read the active window: ' + e.message)), this.pollMs);
  }
  stop() { clearInterval(this.timer); this.timer = null; if (this.probe) this.probe.close(); }

  // -> { ok } | { ok:false, kind:'app'|'path', name, detail, soft? }   (soft = could not be verified; never reported, input is dropped)
  async evaluate(win) {
    if (!win || !win.owner) return { ok: false, kind: 'app', name: '(no foreground window)' };
    const names = [win.owner.name, win.owner.path ? String(win.owner.path).split(/[\\/]/).pop() : ''].filter(Boolean);
    const norm = names.map(normalize);
    const label = win.owner.name || names[0] || 'unknown';

    if (!norm.some((n) => this.policy.apps.has(n))) return { ok: false, kind: 'app', name: label };

    const fileManager = norm.some((n) => this.policy.fileManagers.has(n));
    if (!fileManager || this.policy.allowedPaths.length === 0) return { ok: true };

    const folders = await this.probe.foldersFor(win);
    if (folders === undefined) return { ok: false, soft: true, kind: 'path', name: label, detail: 'folder could not be read' };
    if (folders.length === 0) {
      // Not a folder window. The desktop and taskbar have no title; a dialog (Properties, Delete...) has one and is allowed.
      const title = (win.title || '').trim();
      return title === '' || title === 'Program Manager' ? { ok: false, kind: 'path', name: label, detail: 'the desktop or taskbar' } : { ok: true };
    }
    const outside = folders.find((f) => !this.policy.pathAllowed(f));
    if (outside) return { ok: false, kind: 'path', name: label, detail: outside.startsWith('::') ? 'This PC or another virtual folder' : outside };
    return { ok: true };
  }

  async read(maxAgeMs = 0) {
    if (Date.now() - this.cache.at <= maxAgeMs) return this.cache;
    const win = await this.activeWindow();
    const result = await this.evaluate(win);
    this.cache = { win, result, at: Date.now() };
    return this.cache;
  }

  async poll() {
    if (this.state === 'locked') return;
    const { win, result } = await this.read();

    if (this.debug) {
      const label = win && win.owner ? `${win.owner.name} | ${win.owner.path} | id ${win.id} | "${win.title}"` : '(no foreground window)';
      const verdict = result.ok ? 'in scope' : `OUT OF SCOPE (${result.kind}: ${result.detail || result.name})`;
      if (label + verdict !== this.lastLabel) { this.lastLabel = label + verdict; this.log('info', `Foreground: ${label}  ->  ${verdict}`); }
    }

    if (this.state === 'waiting') {
      if (result.ok) { this.log('info', 'An in-scope window is in front. Enforcement is ON.'); this.setState('armed'); }
      return;
    }
    if (result.ok || result.soft) { this.bad = 0; return; }
    if (Date.now() - this.lastInputAt > this.attributionMs) { this.bad = 0; return; } // the Client switched windows, not the vendor
    if (result.kind === 'path' || ++this.bad >= this.strikes) this.flag(result);
  }

  flag(result) {
    this.setState('locked');
    this.onViolation({ processName: result.name || 'unknown', kind: result.kind, detail: result.detail || '' });
  }

  // Called by the injector before it applies an event. Returns true if the event may be applied.
  async permit(event) {
    if (this.state !== 'armed') return false;
    const { result } = await this.read(150);
    if (result.ok) {
      if (event.t !== 'move') this.lastInputAt = Date.now();
      return true;
    }
    if (event.t !== 'move' && !result.soft) this.flag(result); // a click/key/scroll aimed at an out-of-scope window
    return false;
  }

  lock() { this.setState('locked'); }
  rearm() { this.setState('waiting'); } // after the Client resumes: wait for an in-scope window to be in front again
}

module.exports = { ForegroundMonitor };

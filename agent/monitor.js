'use strict';
// PROCESS SECURITY LOOP.
// Runs on the Client's PC, where the vendor's actions really land, so the vendor cannot tamper with it.
//
// States:  waiting -> armed -> locked
//   waiting  the approved app has not been in front yet. Vendor input is ignored (view-only). The Client opens the app.
//   armed    enforcement is on. Anything else coming to the front, or a click/keypress aimed at another app, is a violation.
//   locked   a violation was reported (or the server halted control). Nothing is applied until the Client resumes.
//
// Two independent checks, so a fast vendor cannot slip between polls:
//   1. POLL:  every POLL_MS read the focused window. If it is not approved, vendor input was applied within
//             ATTRIBUTION_MS and it stays that way for STRIKES polls -> violation.
//   2. GATE:  before applying any click/key/wheel, check the focused window again. Not approved -> drop the input and
//             report. (Pure mouse moves are dropped but never reported, so the Client can still use their own
//             browser to read the alert without tripping the monitor.)
const path = require('path');
const { normalize } = require('./config');

class ForegroundMonitor {
  constructor({ allowedNames, pollMs, strikes, attributionMs, onViolation, onState, log, debug }) {
    this.debug = !!debug; this.lastLabel = null;
    this.allowed = new Set(allowedNames.map(normalize));
    this.pollMs = pollMs; this.strikes = strikes; this.attributionMs = attributionMs;
    this.onViolation = onViolation; this.onState = onState; this.log = log;
    this.state = 'waiting';
    this.bad = 0;
    this.lastInputAt = 0;
    this.cache = { win: undefined, at: 0 };
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
  stop() { clearInterval(this.timer); this.timer = null; }

  // A window counts as approved if its app name OR its executable file name matches
  isApproved(win) {
    if (!win || !win.owner) return false;
    const names = [win.owner.name, win.owner.path ? path.basename(win.owner.path) : ''];
    return names.some((n) => n && this.allowed.has(normalize(n)));
  }

  async read(maxAgeMs = 0) {
    if (Date.now() - this.cache.at <= maxAgeMs) return this.cache.win;
    const win = await this.activeWindow();
    this.cache = { win, at: Date.now() };
    return win;
  }

  async poll() {
    if (this.state === 'locked') return;
    const win = await this.read();
    if (this.debug) {
      const label = win && win.owner ? `${win.owner.name} | ${win.owner.path}` : '(no foreground window)';
      if (label !== this.lastLabel) { this.lastLabel = label; this.log('info', `Foreground: ${label}  ->  ${this.isApproved(win) ? 'approved' : 'NOT approved'}`); }
    }
    if (this.state === 'waiting') {
      if (this.isApproved(win)) { this.log('info', 'Approved app is in front. Enforcement is ON.'); this.setState('armed'); }
      return;
    }
    if (this.isApproved(win)) { this.bad = 0; return; }   // no foreground window (desktop, minimised) counts as out of scope
    if (Date.now() - this.lastInputAt > this.attributionMs) { this.bad = 0; return; } // the Client switched windows, not the vendor
    if (++this.bad >= this.strikes) this.flag(win);
  }

  flag(win) {
    const name = (win && win.owner && win.owner.name) || 'unknown';
    this.setState('locked');
    this.onViolation(name);
  }

  // Called by the injector before it applies an event. Returns true if the event may be applied.
  async permit(event) {
    if (this.state !== 'armed') return false;
    const win = await this.read(150);
    if (this.isApproved(win)) {
      if (event.t !== 'move') this.lastInputAt = Date.now();
      return true;
    }
    if (event.t !== 'move' && win) this.flag(win); // a click/key/scroll aimed at an unapproved app
    return false;
  }

  lock() { this.setState('locked'); }
  rearm() { this.setState('waiting'); } // after the Client resumes: wait for the approved app to be in front again
}

module.exports = { ForegroundMonitor };

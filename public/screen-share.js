/**
 * ScopeDeskScreenShare: a defensive wrapper around navigator.mediaDevices.getDisplayMedia().
 *
 * The contract that fixes "Screen sharing was cancelled ... click the screen preview first, then press Share":
 *   - start() NEVER throws and NEVER touches the signaling socket, the task, the peer connection or the session timer.
 *     It only reports what happened, so the dialog stays open and the person can press Share again.
 *   - Cancelling the browser / OS picker (NotAllowedError, AbortError), or pressing Share before clicking the screen preview,
 *     is a normal, retryable outcome: a calm tip is shown, nothing is torn down. Whoever calls start() must not call
 *     terminate / hardStop / socket.disconnect on a { ok:false, retryable:true } result.
 *   - If the person picks a window or a tab although the whole screen is required, the capture is stopped and the tip says
 *     what to choose (the browser reports this through track.getSettings().displaySurface).
 *   - Unknown constraint keys (older Chromium / Electron) fall back to the plain { video: true } request.
 *   - Double clicks while the picker is open are ignored (one prompt at a time).
 *
 * Load it BEFORE the script that calls it (plain <script src="screen-share.js"></script>); it also works with require().
 *
 *   const share = ScopeDeskScreenShare.create({
 *     onTip: ScopeDeskScreenShare.bindTipElement(document.getElementById('screenShareError')),
 *     onState: (state, info) => console.log('screen share:', state, info)
 *   });
 *   const result = await share.start();
 *   if (!result.ok) return;                 // keep everything else exactly as it is; the person can try again
 *   attachToPeerConnection(result.stream);  // your existing code
 *   share.onEnded(() => { ... });           // the person pressed "Stop sharing" in the browser bar
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.ScopeDeskScreenShare = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var TIP_PICK_SCREEN = 'In the window that opened, click the picture of your screen first so it is highlighted, then press Share. The Share button stays grey until you pick one.';
  var TIP_ENTIRE_SCREEN = 'Please choose "Entire screen" (not a window or a tab), click the picture of your screen so it is highlighted, then press Share.';

  /**
   * Maps a DOMException (or anything thrown) to a stable result.
   * @returns {{ code:string, retryable:boolean, message:string, tip:string }}
   */
  function classifyError(err) {
    var name = (err && err.name) || '';
    var text = String((err && err.message) || '');

    if (name === 'NotAllowedError' || name === 'AbortError') {
      if (/system|operating system|os-level|screen recording/i.test(text)) {
        return {
          code: 'system-permission', retryable: true, message: 'The operating system blocked screen capture.',
          tip: 'Your computer is blocking screen capture for ScopeDesk. On Mac: System Settings > Privacy & Security > Screen Recording, switch ScopeDesk on, restart the app, then press Share again. On Windows: Settings > Privacy > Screen capture / Graphics capture must allow desktop apps.'
        };
      }
      if (/user gesture|transient activation|user activation/i.test(text)) {
        return { code: 'no-gesture', retryable: true, message: 'The browser needs a fresh click.', tip: 'The browser wants a fresh click. Press the Share my screen button once more.' };
      }
      return { code: 'cancelled', retryable: true, message: 'Screen sharing was cancelled.', tip: TIP_PICK_SCREEN };
    }
    if (name === 'NotFoundError') {
      return { code: 'no-source', retryable: true, message: 'No screen was available to share.', tip: 'No screen was offered to share. Check that a display is connected and press Share my screen again. ' + TIP_PICK_SCREEN };
    }
    if (name === 'NotReadableError' || name === 'TrackStartError') {
      return { code: 'not-readable', retryable: true, message: 'The screen could not be read.', tip: 'Another program may be blocking screen capture. Close other screen-recording or screen-sharing apps and press Share my screen again.' };
    }
    if (name === 'SecurityError') {
      return { code: 'insecure', retryable: false, message: 'Screen sharing is not allowed on this page.', tip: 'Screen sharing only works on a secure (https) page or inside the ScopeDesk desktop app. Open ScopeDesk from its https address.' };
    }
    if (name === 'NotSupportedError') {
      return { code: 'unsupported', retryable: false, message: 'This app or browser cannot share the screen.', tip: 'This version of ScopeDesk or your browser cannot share the screen. Update ScopeDesk, or use a current Chrome, Edge or Firefox.' };
    }
    if (name === 'OverconstrainedError' || name === 'TypeError') {
      return { code: 'bad-constraints', retryable: true, message: 'The screen request was not accepted.', tip: 'The screen request was not accepted. Press Share my screen again.' };
    }
    return { code: 'unknown', retryable: true, message: text || 'Screen sharing failed.', tip: 'Screen sharing did not start. Press Share my screen again. ' + TIP_PICK_SCREEN };
  }

  /** Returns a function(tipText|null) that shows / hides a tip in a DOM element (role=status so screen readers announce it). */
  function bindTipElement(el) {
    return function (tip) {
      if (!el) return;
      if (el.setAttribute) el.setAttribute('role', 'status');
      if (el.setAttribute) el.setAttribute('aria-live', 'polite');
      if (tip) { el.textContent = tip; el.hidden = false; if (el.style) el.style.display = ''; } else { el.textContent = ''; el.hidden = true; if (el.style) el.style.display = 'none'; }
    };
  }

  function create(options) {
    var opts = options || {};
    var log = opts.log || function () {};
    var onTip = opts.onTip || function () {};
    var onState = opts.onState || function () {};
    var requireEntireScreen = opts.requireEntireScreen !== false;
    var mediaDevices = opts.mediaDevices || (typeof navigator !== 'undefined' ? navigator.mediaDevices : null);

    var state = 'idle';
    var inFlight = null;
    var stream = null;
    var attempts = 0;
    var endedHandlers = [];

    function setState(next, info) {
      state = next;
      try { onState(next, info || {}); } catch (err) { log('[screen-share] onState failed: ' + err.message); }
    }
    function tip(text) {
      try { onTip(text || null); } catch (err) { log('[screen-share] onTip failed: ' + err.message); }
    }
    function stopTracks(s) {
      if (!s || !s.getTracks) return;
      s.getTracks().forEach(function (t) { try { t.stop(); } catch (_) { /* already stopped */ } });
    }

    function request() {
      var rich = {
        video: { displaySurface: 'monitor', frameRate: { ideal: 30, max: 30 }, width: { ideal: 1920 }, height: { ideal: 1080 } },
        audio: false,
        selfBrowserSurface: 'exclude',
        surfaceSwitching: 'exclude',
        monitorTypeSurfaces: 'include'
      };
      return mediaDevices.getDisplayMedia(rich).catch(function (err) {
        // Old engines reject unknown keys; the cancel / deny cases must NOT be retried (it would open a second picker).
        var n = err && err.name;
        if (n === 'TypeError' || n === 'OverconstrainedError') return mediaDevices.getDisplayMedia({ video: true, audio: false });
        throw err;
      });
    }

    function fail(err) {
      var c = classifyError(err);
      log('[screen-share] ' + (err && err.name) + ': ' + (err && err.message));
      var extra = attempts >= 3 && c.retryable ? ' If this keeps happening, press "Not yet" and try again in a moment.' : '';
      tip(c.tip + extra);
      setState(c.retryable ? 'needs-retry' : 'failed', { code: c.code, name: err && err.name });
      return { ok: false, code: c.code, retryable: c.retryable, message: c.message, tip: c.tip + extra };
    }

    async function run() {
      attempts += 1;
      tip(null);

      if (!mediaDevices || typeof mediaDevices.getDisplayMedia !== 'function') {
        var e = new Error('getDisplayMedia is not available'); e.name = 'NotSupportedError';
        return fail(e);
      }
      if (typeof window !== 'undefined' && window.isSecureContext === false) {
        var se = new Error('insecure context'); se.name = 'SecurityError';
        return fail(se);
      }
      if (stream) { stopTracks(stream); stream = null; }

      setState('prompting', { attempt: attempts });
      tip('A window will open: click the picture of your screen first, then press Share.');

      var got;
      try {
        got = await request();
      } catch (err) {
        return fail(err);
      }

      var track = got && got.getVideoTracks && got.getVideoTracks()[0];
      if (!track) {
        stopTracks(got);
        var ne = new Error('The capture contained no video'); ne.name = 'NotFoundError';
        return fail(ne);
      }

      var surface;
      try { surface = track.getSettings && track.getSettings().displaySurface; } catch (_) { surface = undefined; }
      if (requireEntireScreen && surface && surface !== 'monitor') {
        stopTracks(got);                                  // the person chose a window or a tab: release it, ask again
        log('[screen-share] wrong surface: ' + surface);
        tip(TIP_ENTIRE_SCREEN);
        setState('needs-retry', { code: 'wrong-surface', surface: surface });
        return { ok: false, code: 'wrong-surface', retryable: true, message: 'A window or tab was shared instead of the entire screen.', tip: TIP_ENTIRE_SCREEN };
      }

      stream = got;
      track.addEventListener('ended', function () {
        // "Stop sharing" in the browser bar, or the display went away. Reported only; ending the session is the caller's decision.
        if (stream !== got) return;
        stream = null;
        setState('stopped', { reason: 'track-ended' });
        endedHandlers.slice().forEach(function (fn) { try { fn(); } catch (err) { log('[screen-share] onEnded handler failed: ' + err.message); } });
      });
      tip(null);
      setState('sharing', { surface: surface || 'unknown' });
      return { ok: true, stream: got, surface: surface || 'unknown' };
    }

    return {
      /** Opens the picker. Resolves { ok:true, stream } or { ok:false, code, retryable, message, tip }. Never rejects. */
      start: function () {
        if (inFlight) return inFlight;                    // ignore double clicks while the picker is open
        inFlight = run().catch(function (err) { return fail(err); }).then(function (r) { inFlight = null; return r; });
        return inFlight;
      },
      /** Stops sharing (normal end of a session). */
      stop: function () {
        var s = stream; stream = null;
        stopTracks(s);
        tip(null);
        setState('idle', { reason: 'stopped' });
      },
      /** Registers a callback for "the person stopped sharing from the browser bar". */
      onEnded: function (fn) { if (typeof fn === 'function') endedHandlers.push(fn); },
      getStream: function () { return stream; },
      getState: function () { return state; },
      isBusy: function () { return inFlight !== null; }
    };
  }

  return { create: create, classifyError: classifyError, bindTipElement: bindTipElement, TIP_PICK_SCREEN: TIP_PICK_SCREEN, TIP_ENTIRE_SCREEN: TIP_ENTIRE_SCREEN };
}));

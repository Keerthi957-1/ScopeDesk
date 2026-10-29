'use strict';
/**
 * Electron main process: answers getDisplayMedia() requests from ScopeDesk's own pages.
 *
 * Electron has no built-in screen picker. Without a handler a renderer's getDisplayMedia() either fails or relies on a
 * picker the person must operate exactly right ("click the preview first, then Share"). The person has already given explicit
 * consent in ScopeDesk's own dialog ("Your vendor is ready to connect ... will see your entire screen"), so after that click
 * the handler offers the PRIMARY screen directly, with no second picker.
 *
 * It only answers when ALL of these hold; every other request is denied:
 *   - the request carries a real user gesture (the Share button click),
 *   - the requesting page belongs to ScopeDesk (file:// pages of the app, or an origin in `allowedOrigins`),
 *   - a screen (never a window) can be found.
 * A denied request surfaces in the renderer as NotAllowedError / NotFoundError, which public/screen-share.js turns into a
 * calm tip while keeping the session open.
 *
 * Wire it once in the main process, after app.whenReady():
 *
 *   const { installDisplayMediaHandler } = require('./display-media-handler');
 *   installDisplayMediaHandler({
 *     session: mainWindow.webContents.session,      // or session.defaultSession
 *     desktopCapturer, screen,                        // from require('electron')
 *     allowedOrigins: [new URL(SERVER_URL).origin],   // the hosted ScopeDesk site, if the window loads it
 *     log: console.log
 *   });
 */

function originOf(url) {
  try {
    const u = new URL(url);
    return u.protocol === 'file:' ? 'file://' : u.origin;
  } catch (_) {
    return '';
  }
}

/**
 * Turns anything that can be thrown into readable text. Electron/Chromium sometimes reject with a plain string, an
 * object without .message, or nothing at all; "error: " + err.message then printed "error: undefined".
 */
function describeError(err) {
  if (err == null) return 'unknown error (no details were provided)';
  if (typeof err === 'string') return err.slice(0, 160) || 'unknown error';
  if (typeof err.message === 'string' && err.message) return err.message.slice(0, 160);
  try {
    const j = JSON.stringify(err);
    if (j && j !== '{}') return j.slice(0, 160);
  } catch (_) { /* circular or unserialisable */ }
  const name = err.name || (err.constructor && err.constructor.name);
  return name && name !== 'Object' ? String(name) : 'unknown error';
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Asks Electron for the screens. The first attempt can fail right after the app starts or while Windows is switching
 * displays, so it tries a few times with different thumbnail sizes before giving up. Never throws: returns { sources, error }.
 */
async function getScreenSources(desktopCapturer, log = () => {}, pauseMs = 150) {
  const sizes = [{ width: 0, height: 0 }, { width: 1, height: 1 }, { width: 150, height: 150 }];
  let lastError = null;
  let threw = false;
  for (let i = 0; i < sizes.length; i += 1) {
    try {
      const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: sizes[i], fetchWindowIcons: false });
      if (sources && sources.length) return { sources, error: null };
      lastError = 'no screens were reported';
      threw = false;
    } catch (err) {
      threw = true;
      lastError = describeError(err);
      log('[display-media] getSources attempt ' + (i + 1) + ' failed: ' + lastError);
    }
    if (i < sizes.length - 1 && pauseMs > 0) await wait(pauseMs);
  }
  return { sources: [], error: lastError, threw };
}

/** Last resort when the capturer cannot list screens: Chromium accepts the primary display by its id. */
function fallbackSource(primaryDisplayId) {
  if (primaryDisplayId === null || primaryDisplayId === undefined) return null;
  return { id: 'screen:' + primaryDisplayId + ':0', name: 'Entire screen', display_id: String(primaryDisplayId) };
}

/** Picks the primary display's source, else the first screen source. Returns null when there is none. */
function pickScreenSource(sources, primaryDisplayId, exact = false) {
  const screens = (sources || []).filter((s) => s && typeof s.id === 'string' && s.id.startsWith('screen:'));
  if (!screens.length) return null;
  const primary = screens.find((s) => String(s.display_id) === String(primaryDisplayId));
  return primary || (exact ? null : screens[0]);
}

/**
 * Builds the request handler (exported separately so it can be tested without Electron).
 * @returns {(request:object, callback:Function) => Promise<void>}
 */
function createDisplayMediaRequestHandler({ desktopCapturer, screen, allowedOrigins = [], log = () => {}, onDeny = () => {}, requireGesture = false, retryPauseMs = 150, preferredDisplayId = () => null }) {
  const allowed = new Set(['file://', ...allowedOrigins.map((o) => originOf(o) || o)]);
  return async function handler(request, callback) {
    const deny = (why) => {
      log('[display-media] denied: ' + why);
      try { onDeny(why); } catch (_) { /* reporting only */ }
      try { callback({}); } catch (err) { log('[display-media] callback failed: ' + describeError(err)); }
    };
    try {
      // Chromium already refuses getDisplayMedia without a fresh click, so a missing flag here is not a reason to deny by default.
      if (requireGesture && (!request || request.userGesture !== true)) return deny('no user gesture');
      const origin = originOf((request && (request.securityOrigin || (request.frame && request.frame.url))) || '');
      if (!allowed.has(origin)) return deny('origin not allowed: ' + (origin || 'unknown'));

      let primaryId = null;
      try { primaryId = screen.getPrimaryDisplay().id; } catch (_) { /* fall back to the first screen */ }
      let wanted = null;
      try { wanted = preferredDisplayId(); } catch (_) { /* primary */ }
      const found = await getScreenSources(desktopCapturer, log, retryPauseMs);
      // The display the Client chose in the share dialog (multi-monitor), else the primary one
      let source = (wanted != null && pickScreenSource(found.sources, wanted, true)) || pickScreenSource(found.sources, primaryId);
      if (!source && found.threw) {            // the capturer itself failed (not "there is no screen"): offer the primary display directly
        source = fallbackSource(primaryId);
        if (source) log('[display-media] using the primary display directly (' + (found.error || 'no source') + ')');
      }
      if (!source) return deny('no screen source: ' + (found.error || 'none found') + ' (on macOS check System Settings > Privacy & Security > Screen Recording)');

      callback({ video: source });                       // video only: audio is never shared
    } catch (err) {
      deny('error: ' + describeError(err));
    }
  };
}

/** Registers the handler on an Electron session. Returns false (and logs) on Electron versions without the API. */
function installDisplayMediaHandler({ session, desktopCapturer, screen, allowedOrigins, log = () => {}, onDeny, requireGesture, preferredDisplayId }) {
  if (!session || typeof session.setDisplayMediaRequestHandler !== 'function') {
    log('[display-media] this Electron version has no setDisplayMediaRequestHandler; screen sharing keeps its default behaviour');
    return false;
  }
  session.setDisplayMediaRequestHandler(createDisplayMediaRequestHandler({ desktopCapturer, screen, allowedOrigins, log, onDeny, requireGesture, preferredDisplayId }), { useSystemPicker: false });
  return true;
}

module.exports = { installDisplayMediaHandler, createDisplayMediaRequestHandler, pickScreenSource, originOf, describeError, getScreenSources, fallbackSource };

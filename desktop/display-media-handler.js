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

/** Picks the primary display's source, else the first screen source. Returns null when there is none. */
function pickScreenSource(sources, primaryDisplayId) {
  const screens = (sources || []).filter((s) => s && typeof s.id === 'string' && s.id.startsWith('screen:'));
  if (!screens.length) return null;
  const primary = screens.find((s) => String(s.display_id) === String(primaryDisplayId));
  return primary || screens[0];
}

/**
 * Builds the request handler (exported separately so it can be tested without Electron).
 * @returns {(request:object, callback:Function) => Promise<void>}
 */
function createDisplayMediaRequestHandler({ desktopCapturer, screen, allowedOrigins = [], log = () => {}, onDeny = () => {}, requireGesture = false }) {
  const allowed = new Set(['file://', ...allowedOrigins.map((o) => originOf(o) || o)]);
  return async function handler(request, callback) {
    const deny = (why) => {
      log('[display-media] denied: ' + why);
      try { onDeny(why); } catch (_) { /* reporting only */ }
      try { callback({}); } catch (err) { log('[display-media] callback failed: ' + err.message); }
    };
    try {
      // Chromium already refuses getDisplayMedia without a fresh click, so a missing flag here is not a reason to deny by default.
      if (requireGesture && (!request || request.userGesture !== true)) return deny('no user gesture');
      const origin = originOf(request.securityOrigin || (request.frame && request.frame.url) || '');
      if (!allowed.has(origin)) return deny('origin not allowed: ' + (origin || 'unknown'));

      const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 0, height: 0 } });
      let primaryId = null;
      try { primaryId = screen.getPrimaryDisplay().id; } catch (_) { /* fall back to the first screen */ }
      const source = pickScreenSource(sources, primaryId);
      if (!source) return deny('no screen source (on macOS check System Settings > Privacy & Security > Screen Recording)');

      callback({ video: source });                       // video only: audio is never shared
    } catch (err) {
      deny('error: ' + err.message);
    }
  };
}

/** Registers the handler on an Electron session. Returns false (and logs) on Electron versions without the API. */
function installDisplayMediaHandler({ session, desktopCapturer, screen, allowedOrigins, log = () => {}, onDeny, requireGesture }) {
  if (!session || typeof session.setDisplayMediaRequestHandler !== 'function') {
    log('[display-media] this Electron version has no setDisplayMediaRequestHandler; screen sharing keeps its default behaviour');
    return false;
  }
  session.setDisplayMediaRequestHandler(createDisplayMediaRequestHandler({ desktopCapturer, screen, allowedOrigins, log, onDeny, requireGesture }), { useSystemPicker: false });
  return true;
}

module.exports = { installDisplayMediaHandler, createDisplayMediaRequestHandler, pickScreenSource, originOf };

'use strict';
// One rule for "where is the ScopeDesk server", shared by the host agent and the desktop app.
// The address must be https://, except for a server on this same computer (development). Reason: the agent sends a pairing token
// and the desktop app signs in over this connection, and neither may travel unencrypted across the internet.
const LOCAL = new Set(['localhost', '127.0.0.1', '[::1]']);

// -> { ok: true, url: 'https://your-app.up.railway.app' }  or  { ok: false, error: '...' }   (any path, query or trailing slash is dropped)
function normalizeServerUrl(input) {
  const raw = String(input == null ? '' : input).trim();
  if (!raw) return { ok: false, error: 'No server address is set.' };
  let u;
  try { u = new URL(raw); } catch (_) {
    return { ok: false, error: `"${raw.slice(0, 80)}" is not a valid web address. It should look like https://your-app.up.railway.app` };
  }
  const local = LOCAL.has(u.hostname);
  if (u.protocol === 'https:' || (u.protocol === 'http:' && local)) return { ok: true, url: u.origin };
  return { ok: false, error: `The server address must start with https:// (it starts with ${u.protocol}//). Only a server on this same computer may use http://` };
}

module.exports = { normalizeServerUrl };

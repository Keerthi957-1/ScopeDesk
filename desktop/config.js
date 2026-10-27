'use strict';
// Which ScopeDesk server does the desktop app talk to? (pure function, unit-tested)
//   1) SCOPEDESK_SERVER_URL environment variable (testing a staging server)
//   2) "serverUrl" in app-config.json (the production Railway address, shared with the web app)
// Plain http:// is accepted only for localhost; every real server must be https://
function resolveServerUrl({ env = {}, readConfigFile }) {
  let raw = String(env.SCOPEDESK_SERVER_URL || '').trim();
  let source = 'SCOPEDESK_SERVER_URL';
  if (!raw) {
    source = 'app-config.json';
    try { raw = String(JSON.parse(readConfigFile()).serverUrl || '').trim(); } catch (_) { raw = ''; }
  }
  if (!raw) return { url: '', error: 'No server address is set. Put your Railway address in public/app-config.json as "serverUrl" (for example https://your-app.up.railway.app), then rebuild or reopen the app.' };
  let u;
  try { u = new URL(raw); } catch (_) { return { url: '', error: `The server address in ${source} is not a valid web address: ${raw}` }; }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && local)) return { url: '', error: `The server address in ${source} must start with https:// (found ${u.protocol}//).` };
  return { url: u.origin, error: null };
}
module.exports = { resolveServerUrl };

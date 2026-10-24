'use strict';
// Agent settings. Everything is an environment variable so nothing secret lives in a file.
//
//   SCOPEDESK_AGENT_TOKEN  required. Copy it from the Client dashboard ("Pair host agent"). Valid for ONE task only and
//                          expires when the task window ends.
//   SERVER_URL             REQUIRED: the live ScopeDesk server, e.g. https://your-app.up.railway.app (https only; http is accepted
//                          only for a server on this same computer). The desktop app sets this for you.
//   POLL_MS                foreground check interval, default 400
//   STRIKES                consecutive bad polls before reporting, default 2 (filters Alt+Tab flicker)
//   ATTRIBUTION_MS         a foreground change is blamed on the vendor only if vendor input was applied this recently, default 2500
//   ALWAYS_ALLOW           comma list of extra app names that may be in front (e.g. "explorer"). Leave empty for strict mode.
//   VIEW_ONLY=true         never apply vendor input; only monitor
//   DEBUG_FOREGROUND=true  log the app name active-win reports, to find the right value for the task's approved app
//   SESSION_CONFIG=file    per-session policy file: {taskId, scope, allowedProcesses, allowedDirectories}. Overrides policies.json
//   BRIDGE_PORT=47600      local port the browser uses to hand data-channel input to this agent
// One normal form for app names: trimmed FIRST (so " Billing.EXE " still loses its extension), Unicode-folded, lower case, no .exe/.app, no spaces
const normalize = (name) => String(name || '').normalize('NFKC').trim().toLowerCase().replace(/\.(exe|app)$/i, '').replace(/\s+/g, '').trim();

module.exports = {
  SERVER_URL: process.env.SERVER_URL || '',
  TOKEN: process.env.SCOPEDESK_AGENT_TOKEN || (process.argv.find((a) => a.startsWith('--token=')) || '').slice(8),
  POLL_MS: Number(process.env.POLL_MS || 400),
  STRIKES: Number(process.env.STRIKES || 2),
  ATTRIBUTION_MS: Number(process.env.ATTRIBUTION_MS || 2500),
  ALWAYS_ALLOW: (process.env.ALWAYS_ALLOW || '').split(',').map((s) => s.trim()).filter(Boolean),
  VIEW_ONLY: process.env.VIEW_ONLY === 'true',
  DEBUG_FOREGROUND: process.env.DEBUG_FOREGROUND === 'true', // print the app name/path active-win sees whenever it changes
  SESSION_CONFIG: process.env.SESSION_CONFIG || '', // optional path to a per-session JSON file (see session.example.json)
  BRIDGE_PORT: Number(process.env.BRIDGE_PORT || 47600),
  ALLOWED_ORIGINS: (process.env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean),
  normalize
};

// ScopeDesk frontend settings. This is the ONLY place a web address may be set for the pages.
//
// API_URL = the address of the live ScopeDesk server, for example "https://your-app.up.railway.app" (no slash at the end).
//
//   * Leave it EMPTY when you open ScopeDesk at its own Railway address. The server there serves the pages AND the API, so the
//     page simply talks to the address it was loaded from. Nothing to set.
//   * Set it if these files are opened from anywhere else (a file on disk, another host). The page then finds the Railway
//     server at this address and continues there.
//
// No local server is needed or expected.
window.SCOPEDESK_CONFIG = { API_URL: '' };

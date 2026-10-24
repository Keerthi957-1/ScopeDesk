// ScopeDesk connection status check. Drop-in file, no dependencies.
// The warning banner stays hidden unless the backend really does not answer.
(function () {
  const BACKEND_URLS = ['http://localhost:3000', 'http://localhost:5000']; // where "npm start" may be listening
  const HEALTH_PATH = '/api/health';   // ScopeDesk's health route: answers { app: 'scopedesk', ok: true }
  const TIMEOUT_MS = 4000;             // no answer within this time counts as a failure
  const RECHECK_MS = 1500;             // quick re-check after a failure, before showing anything
  const FAILS_BEFORE_SHOWING = 2;      // consecutive failed checks needed to show the banner
  const CHECK_EVERY_MS = 10000;        // regular check while the page is open
  let fails = 0;

  function banner() {
    return document.getElementById('serverBanner') || document.querySelector('.server-banner');
  }
  function setBanner(show) {
    const b = banner();
    if (b) b.style.display = show ? 'block' : 'none';
  }

  async function ping(base) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    try {
      const r = await fetch(base + HEALTH_PATH, { cache: 'no-store', signal: ctrl.signal });
      if (!r.ok) return false;
      const d = await r.json();
      return !!(d && d.app === 'scopedesk');
    } catch (_) {
      return false;                    // network error, timeout, or not JSON (e.g. Live Server's own HTML)
    } finally {
      clearTimeout(timer);
    }
  }

  async function serverIsUp() {
    for (const base of ['', ...BACKEND_URLS]) {   // '' = same origin, when ScopeDesk serves the page itself
      if (await ping(base)) return true;
    }
    return false;
  }

  async function check() {
    if (await serverIsUp()) {
      fails = 0;
      setBanner(false);
    } else {
      fails++;
      if (fails >= FAILS_BEFORE_SHOWING) setBanner(true);
      else setTimeout(check, RECHECK_MS);
    }
  }

  function init() {
    setBanner(false);                  // hidden until a real failure
    check();
    setInterval(check, CHECK_EVERY_MS);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();

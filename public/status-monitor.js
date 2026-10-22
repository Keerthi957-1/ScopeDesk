// ScopeDesk server status monitor.
// Watches three signals (failed API calls, the Socket.IO link, a periodic /api/health probe) and shows ONE banner
// in the page itself when the backend is unreachable, with the exact steps to restart it. Nothing is reported via alert().
(function () {
  const BACKOFF = [2, 4, 8, 15];          // seconds between probes while offline
  const S = { online: true, attempt: 0, secondsLeft: 0, wait: null, probing: false, downSince: null };
  const listeners = [];
  let getBase = () => '';
  let liveSession = () => false;
  let banner;

  const isWindows = /Windows/i.test(navigator.userAgent);
  const startHint = isWindows ? 'Double-click start-windows.bat in the ScopeDesk folder.' : 'Run start-mac-linux.command in the ScopeDesk folder.';

  function el(tag, cls, text) { const n = document.createElement(tag); if (cls) n.className = cls; if (text) n.textContent = text; return n; }

  function ensureBanner() {
    if (banner) return banner;
    banner = el('div', 'srv-status hidden');
    banner.setAttribute('role', 'alert');
    banner.setAttribute('aria-live', 'assertive');
    document.body.prepend(banner);
    return banner;
  }

  function render() {
    const b = ensureBanner();
    b.textContent = '';
    if (S.online && !S.justRecovered) { b.classList.add('hidden'); return; }
    b.classList.remove('hidden');
    b.classList.toggle('srv-ok', S.online);
    b.classList.toggle('srv-down', !S.online);

    if (S.online) { b.append(el('strong', '', 'Back online.'), el('span', '', ' Reconnected to the ScopeDesk server.')); return; }

    const text = el('div', 'srv-text');
    text.append(el('strong', '', 'Can\u2019t reach the ScopeDesk server.'));
    text.append(el('p', '', 'Your account and tasks are safe. The page reconnects by itself once the server is running again.'));
    if (liveSession()) {
      text.append(el('p', 'srv-live', 'A live session is open: screen sharing and remote control are paused, and the session timer keeps running on the server.'));
    }
    const steps = el('ol', 'srv-steps');
    [startHint, 'Or open a terminal in the ScopeDesk folder and run: npm start', 'Keep that window open while you use ScopeDesk.']
      .forEach((t) => steps.append(el('li', '', t)));
    text.append(steps);

    const side = el('div', 'srv-side');
    side.append(el('span', 'srv-retry', S.probing ? 'Checking\u2026' : `Retrying in ${S.secondsLeft}s`));
    const btn = el('button', 'srv-btn', 'Retry now');
    btn.type = 'button';
    btn.disabled = S.probing;
    btn.addEventListener('click', () => probe());
    side.append(btn);
    b.append(text, side);
  }

  function emit(online) { listeners.forEach((fn) => { try { fn(online); } catch (_) { /* a listener must not break the monitor */ } }); }

  function reportDown() {
    if (!S.online) return;
    S.online = false; S.attempt = 0; S.downSince = Date.now();
    emit(false);
    scheduleProbe();
    render();
  }

  function reportUp() {
    if (S.online) return;
    clearTimeout(S.wait); clearInterval(S.tick);
    S.online = true; S.justRecovered = true; S.attempt = 0;
    render(); emit(true);
    setTimeout(() => { S.justRecovered = false; render(); }, 3500);
  }

  function scheduleProbe() {
    clearTimeout(S.wait); clearInterval(S.tick);
    S.secondsLeft = BACKOFF[Math.min(S.attempt, BACKOFF.length - 1)];
    S.tick = setInterval(() => { S.secondsLeft = Math.max(0, S.secondsLeft - 1); render(); }, 1000);
    S.wait = setTimeout(probe, S.secondsLeft * 1000);
  }

  async function probe() {
    if (S.probing) return;
    clearTimeout(S.wait); clearInterval(S.tick);
    S.probing = true; render();
    let ok = false;
    try {
      const r = await fetch(getBase() + '/api/health', { cache: 'no-store' });
      ok = (await r.json()).app === 'scopedesk';
    } catch (_) { ok = false; }
    S.probing = false;
    if (ok) return reportUp();
    S.attempt++;
    scheduleProbe(); render();
  }

  // Socket.IO link: connect_error that is not an auth problem, or a dropped connection, means the server is gone
  function attachSocket(socket) {
    socket.on('connect_error', (err) => { if (err && err.message !== 'Authentication required') reportDown(); });
    socket.on('disconnect', (reason) => { if (reason !== 'io client disconnect') reportDown(); });
    socket.on('connect', () => reportUp());
  }

  // Failed fetches and stray rejections about the network become banner state instead of silent failures
  const looksLikeNetwork = (e) => e && (e.name === 'TypeError' || /Failed to fetch|NetworkError|Load failed|Cannot reach/i.test(String(e.message || e)));
  window.addEventListener('unhandledrejection', (ev) => { if (looksLikeNetwork(ev.reason)) { ev.preventDefault(); reportDown(); } });
  window.addEventListener('offline', reportDown);
  window.addEventListener('online', () => { if (!S.online) probe(); });

  window.ScopeDeskStatus = {
    configure(opts) { if (opts.getBase) getBase = opts.getBase; if (opts.liveSession) liveSession = opts.liveSession; },
    attachSocket,
    reportDown,   // call from any failed API request
    reportUp,
    onChange(fn) { listeners.push(fn); },
    isOnline: () => S.online,
    probe
  };

  // First check on load (one request; afterwards the socket and API calls tell us)
  document.addEventListener('DOMContentLoaded', () => { ensureBanner(); probe(); });
})();

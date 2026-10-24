// ScopeDesk desktop bridge (page side). Works only inside the Electron app; in a normal browser it does nothing.
// The preload script exposes window.scopedeskDesktop. This module wraps it for script.js:
//   ScopeDeskDesktop.ensureAgent({ taskId, getToken, setToken })  start the host agent for a task (token never shown or copied)
//   ScopeDeskDesktop.stopAgent()                                  stop it immediately
//   ScopeDeskDesktop.onStatus(fn)                                 live agent status: { phase, uiState, policy, detail, taskId }
(function () {
  const bridge = window.scopedeskDesktop;
  const available = !!(bridge && bridge.isDesktop);
  const ACTIVE = ['starting', 'connected', 'running'];
  let status = { phase: 'stopped', uiState: 'offline', taskId: null, policy: '', detail: '' };
  let startingFor = null;
  const listeners = [];

  function publish(next) {
    status = next || status;
    listeners.forEach((fn) => { try { fn(status); } catch (_) { /* a listener must not break the bridge */ } });
  }

  if (available) {
    bridge.onAgentStatus(publish);
    bridge.getAgentStatus().then((s) => { if (s) publish(s); }).catch(() => {});
    console.log('[ScopeDesk] Desktop bridge ready');
  }

  async function ensureAgent({ taskId, getToken, setToken }) {
    if (!available) return { ok: false, error: 'not-desktop' };
    if (status.taskId === taskId && ACTIVE.includes(status.phase)) return { ok: true, already: true };
    if (startingFor === taskId) return { ok: true, already: true };
    startingFor = taskId;
    try {
      const token = await getToken(taskId);   // fetched from the server into memory only
      setToken(token);                        // so the page can pass the vendor's input to the agent
      return await bridge.initializeAgent({ taskId, token });
    } finally {
      startingFor = null;
    }
  }

  async function stopAgent() {
    if (!available) return { ok: true };
    try { return await bridge.stopAgent(); } catch (_) { return { ok: false }; }
  }

  window.ScopeDeskDesktop = {
    available,
    ensureAgent,
    stopAgent,
    getStatus: () => status,
    onStatus(fn) { listeners.push(fn); if (available && status.phase !== 'stopped') fn(status); }
  };
})();

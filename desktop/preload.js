'use strict';
// The ONLY bridge between the ScopeDesk page and the desktop shell. The page never gets ipcRenderer or Node itself.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('scopedeskDesktop', {
  isDesktop: true,
  // Page -> main: hand over the task id and its short-lived agent token (kept in app memory, never shown or copied)
  initializeAgent: (cfg) => ipcRenderer.invoke('agent:initialize', { taskId: cfg && cfg.taskId, token: cfg && cfg.token, viewOnly: !!(cfg && cfg.viewOnly) }),
  stopAgent: () => ipcRenderer.invoke('agent:stop'),
  getAgentStatus: () => ipcRenderer.invoke('agent:status'),
  // Main -> page: live agent status. Returns a function that unsubscribes.
  onAgentStatus: (cb) => {
    const handler = (_event, status) => { try { cb(status); } catch (_) { /* a listener must not break the bridge */ } };
    ipcRenderer.on('agent:status', handler);
    return () => ipcRenderer.removeListener('agent:status', handler);
  }
});

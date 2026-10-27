'use strict';
/**
 * Two small functions that plug the host runtime into the ScopeDesk desktop (Electron) app.
 *
 *  main process :   const { registerHostIpc } = require('./agent/electron-glue');
 *                   registerHostIpc({ ipcMain, Notification, getWindow: () => mainWindow, serverUrl: SERVER_URL });
 *
 *  preload script: const { exposeHostApi } = require('./agent/electron-glue');
 *                   exposeHostApi({ contextBridge, ipcRenderer });
 *
 * It runs inside Electron's own Node.js, so the installed system Node.js version does not matter.
 * Needs the "socket.io-client" package (npm install socket.io-client), the same one the server's Socket.IO uses.
 *
 * Page API (window.scopedeskHost):
 *   hostStart({ taskId, agentToken }) -> { ok, error? }   fetches the approved scope, connects as the task's agent, starts watching
 *   hostStop()                                             normal end of the session
 *   hostInput(string)                                      one data-channel message (rtc-channel-hub.js calls this)
 *   listInstalledApps() -> string[]                        clean names for the "Allowed applications" picker
 *   onCloseRtc(cb), onLockdown(cb)                         the main process asks the page to cut the stream / shows the breach
 */

const CH = Object.freeze({
  listApps: 'scopedesk:list-apps',
  start: 'scopedesk:host-start',
  stop: 'scopedesk:host-stop',
  input: 'scopedesk:host-input',
  closeRtc: 'scopedesk:host-close-rtc',
  lockdown: 'scopedesk:host-lockdown'
});

function registerHostIpc(opts) {
  const { ipcMain, getWindow, serverUrl } = opts;
  const log = opts.log || ((...a) => console.log(...a));
  const fetchImpl = opts.fetch || (typeof fetch === 'function' ? fetch : null);
  const NotificationCtor = opts.Notification;
  const ioFactory = opts.io || (() => require('socket.io-client').io);
  const { createHostRuntime } = require('./host-runtime');
  const { discoverInstalledApps } = require('./app-discovery');

  let session = null;   // { runtime, socket, endTimer }

  const send = (channel, payload) => {
    const win = getWindow && getWindow();
    if (win && !win.isDestroyed() && win.webContents && !win.webContents.isDestroyed()) win.webContents.send(channel, payload);
  };

  function stopSession() {
    if (!session) return;
    const s = session; session = null;
    clearTimeout(s.endTimer);
    try { s.runtime.stop(); } catch (_) { /* already stopped */ }
    try { s.socket.disconnect(); } catch (_) { /* already closed */ }
  }

  // Step 2 of the breach sequence, on the Client's screen: full-screen alert + persistent system notification.
  // The page also gets the server's "termination-alert" (overlay + browser notification) as soon as the report is delivered.
  function showLocalAlert(scope, violation) {
    const win = getWindow && getWindow();
    const what = violation && violation.detail ? violation.detail : 'The vendor tried to go outside the approved scope.';
    if (scope.alertsEnabled === false) return;
    if (win && !win.isDestroyed()) {
      try {
        if (win.isMinimized()) win.restore();
        win.show();
        win.setAlwaysOnTop(true, 'screen-saver');
        win.setFullScreen(true);
        win.focus();
      } catch (_) { /* window state is best effort */ }
    }
    send(CH.lockdown, { taskId: scope.taskId, kind: violation && violation.kind, processName: violation && violation.processName, detail: violation && violation.detail, what, occurredAt: new Date().toISOString() });
    if (NotificationCtor) {
      try {
        const n = new NotificationCtor({ title: 'ScopeDesk: session terminated', body: what, urgency: 'critical', timeoutType: 'never' });   // stays until the Client dismisses it
        n.show();
      } catch (_) { /* notifications may be disabled by the OS */ }
    }
  }

  ipcMain.handle(CH.listApps, () => discoverInstalledApps());

  ipcMain.handle(CH.start, async (_event, args) => {
    try {
      const taskId = Number(args && args.taskId);
      const agentToken = String((args && args.agentToken) || '');
      if (!Number.isInteger(taskId) || !agentToken) return { ok: false, error: 'taskId and agentToken are required.' };
      if (!fetchImpl) return { ok: false, error: 'This version of Electron has no fetch().' };
      stopSession();

      const res = await fetchImpl(`${serverUrl}/api/agent/scope`, { headers: { Authorization: `Bearer ${agentToken}` } });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) return { ok: false, error: body.error || `The server refused the scope request (${res.status}).` };
      if (Number(body.taskId) !== taskId) return { ok: false, error: 'The scope belongs to a different task.' };
      const scope = { taskId, allowedApps: body.allowedApps || [], allowedPaths: body.allowedPaths || [], alertsEnabled: body.alertsEnabled !== false, endsAt: Number(body.endsAt) || 0 };

      const socket = ioFactory()(serverUrl, { auth: { token: agentToken }, transports: ['websocket', 'polling'], reconnection: true });
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Could not reach the ScopeDesk server.')), 10000);
        socket.once('connect', () => { clearTimeout(timer); resolve(); });
        socket.once('connect_error', (e) => { clearTimeout(timer); reject(new Error(e && e.message ? e.message : 'Connection refused.')); });
      });

      const runtime = createHostRuntime({
        scope, log,
        // Step 1: the page stops every screen-share track and closes every peer connection
        closeConnections: () => new Promise((resolve) => { send(CH.closeRtc, { reason: 'violation' }); setTimeout(resolve, 400); }),
        reportViolation: (v) => socket.timeout(8000).emitWithAck('host-violation', v),
        onLockdown: (violation) => showLocalAlert(scope, violation)
      });
      runtime.start();
      session = { runtime, socket, endTimer: scope.endsAt ? setTimeout(stopSession, Math.max(0, scope.endsAt - Date.now())) : null };
      log(`[host] session guard started for task ${taskId} (${scope.allowedApps.length} approved app(s))`);
      return { ok: true, taskId, allowedApps: scope.allowedApps };
    } catch (err) {
      stopSession();
      return { ok: false, error: err.message };
    }
  });

  ipcMain.on(CH.input, (_event, data) => {
    if (!session || typeof data !== 'string' || data.length > 2048) return;
    session.runtime.handleChannelMessage(data).catch((e) => log('[host] input error: ' + e.message));
  });

  ipcMain.handle(CH.stop, () => { stopSession(); return { ok: true }; });

  return { stop: stopSession, isRunning: () => !!session };
}

function exposeHostApi({ contextBridge, ipcRenderer }) {
  contextBridge.exposeInMainWorld('scopedeskHost', {
    hostStart: (args) => ipcRenderer.invoke(CH.start, { taskId: args && args.taskId, agentToken: args && args.agentToken }),
    hostStop: () => ipcRenderer.invoke(CH.stop),
    hostInput: (data) => ipcRenderer.send(CH.input, String(data)),
    listInstalledApps: () => ipcRenderer.invoke(CH.listApps),
    onCloseRtc: (cb) => ipcRenderer.on(CH.closeRtc, (_e, d) => cb(d)),
    onLockdown: (cb) => ipcRenderer.on(CH.lockdown, (_e, d) => cb(d))
  });
}

module.exports = { registerHostIpc, exposeHostApi, CHANNELS: CH };

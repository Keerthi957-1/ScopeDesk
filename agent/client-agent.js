'use strict';
// ScopeDesk host agent. Runs on the CLIENT's PC for the length of one support session.
//
//   1. cd agent && npm install            (once)
//   2. In the ScopeDesk dashboard click "Pair host agent" on the active task and copy the command it shows.
//      Windows (cmd):   set SCOPEDESK_AGENT_TOKEN=<token> && npm start
//      Mac/Linux:       SCOPEDESK_AGENT_TOKEN=<token> npm start
//
// What it does: applies the vendor's mouse/keyboard input, watches the focused application (monitor.js), and on any
// scope violation reports to the server, which alerts the Client and halts the vendor immediately.
// It exits on its own when the session ends or the task window closes.
const { io } = require('socket.io-client');
const cfg = require('./config');
const { ForegroundMonitor } = require('./monitor');
const { InputInjector } = require('./input-injector');
const { startBridge } = require('./bridge');
const { loadPolicy } = require('./policy');
const { createPathProbe } = require('./path-probe');

const stamp = () => new Date().toLocaleTimeString();
// When the desktop app starts the agent, status messages travel to it over IPC (no-op when run from a terminal)
const notify = (msg) => { if (typeof process.send === 'function') { try { process.send(msg); } catch (_) { /* parent gone */ } } };
const log = (level, msg) => (level === 'warn' || level === 'error' ? console.error : console.log)(`[AGENT ${stamp()}] ${msg}`);

if (!cfg.SERVER_URL) {
  log('error', 'No server address. Set SERVER_URL, or put "serverUrl" in public/app-config.json.');
  process.exit(1);
}
if (!cfg.TOKEN) {
  log('error', 'No agent token. Click "Pair host agent" in the ScopeDesk dashboard and copy the command it shows.');
  process.exit(1);
}

const socket = io(cfg.SERVER_URL, { auth: { token: cfg.TOKEN }, reconnectionDelayMax: 5000 });
let monitor = null, injector = null, bridge = null, taskId = null, expiryTimer = null, started = false;

async function shutdown(code, why) {
  log('info', why);
  try { if (injector) await injector.releaseAll(); if (monitor) monitor.stop(); } catch (_) {}
  notify({ type: 'ended', code, reason: why });
  setTimeout(() => process.exit(code), typeof process.send === 'function' ? 150 : 0); // let the last IPC message out
}
process.on('message', (m) => { if (m && m.type === 'stop') shutdown(0, 'Stopped by the Client.'); });
process.on('SIGINT', () => shutdown(0, 'Stopped by the Client.'));
process.on('SIGTERM', () => shutdown(0, 'Stopped.'));

socket.on('connect', () => {
  log('info', 'Connected to ScopeDesk.');
  notify({ type: 'connected' });
  socket.emit('agent-hello', {}, async (res) => {
    if (!res || !res.ok) return shutdown(1, (res && res.error) || 'The server refused this agent.');
    if (started) return; // reconnect: the monitor is already running
    started = true;
    taskId = res.taskId;

    let policy;
    try { policy = loadPolicy({ taskType: res.taskType, targetProcess: res.targetProcess, taskId: res.taskId, extra: { allowedPaths: res.allowedPaths, allowedApps: res.allowedApps }, sessionConfigFile: cfg.SESSION_CONFIG, log }); }
    catch (e) { return shutdown(1, 'Could not load the security policy: ' + e.message); }
    cfg.ALWAYS_ALLOW.forEach((a) => { policy.apps.add(cfg.normalize(a)); policy.appList.push(a); });
    const probe = createPathProbe(log);
    if (policy.allowedPaths.length && !probe.supported) {
      return shutdown(1, `Policy "${policy.name}" restricts folders, but this operating system cannot report which folder a window shows. Refusing to start (a weaker check would be unsafe).`);
    }
    monitor = new ForegroundMonitor({
      policy, probe, pollMs: cfg.POLL_MS, strikes: cfg.STRIKES, attributionMs: cfg.ATTRIBUTION_MS, log,
      debug: cfg.DEBUG_FOREGROUND,
      onState: (state) => { log('info', `State: ${state}`); notify({ type: 'state', state, policy: policy.name }); socket.emit('agent-state', { taskId, state, policy: policy.name }); if (bridge) bridge.broadcast({ t: 'state', state }); if (state === 'locked') injector.releaseAll(); },
      onViolation: ({ processName, kind, detail }) => {
        log('error', `VIOLATION (${kind}): ${processName}${detail ? ' -> ' + detail : ''}. Input locked, reporting.`);
        notify({ type: 'violation', kind, processName });
        process.stdout.write('\x07'); // audible bell
        if (bridge) bridge.broadcast({ t: 'halt', reason: 'violation', kind, detail }); // the Client's browser drops the WebRTC link NOW, before the server round trip
        socket.emit('host-violation', { taskId, processName, kind, detail }, (ack) => { if (ack && !ack.ok) log('warn', 'Server did not accept the report: ' + ack.error); });
      }
    });
    injector = new InputInjector({ monitor, log, viewOnly: cfg.VIEW_ONLY });
    injector.init();

    // Hop between the Client's browser (data channel) and this agent
    const origins = new Set([new URL(cfg.SERVER_URL).origin, ...cfg.ALLOWED_ORIGINS]);
    const u = new URL(cfg.SERVER_URL);
    if (['localhost', '127.0.0.1'].includes(u.hostname)) ['localhost', '127.0.0.1'].forEach((h) => origins.add(`${u.protocol}//${h}${u.port ? ':' + u.port : ''}`));
    bridge = startBridge({
      port: cfg.BRIDGE_PORT, allowedOrigins: origins, log,
      getState: () => monitor.state,
      onInput: (ev) => injector.handle(ev),
      verifyToken: (token, cb) => socket.emit('bridge-verify', { token }, (r) => cb(!!(r && r.ok)))
    });

    await monitor.start();
    if (res.halted) monitor.lock();
    log('info', `Task #${taskId} "${res.title}". Policy: ${policy.name}. Allowed apps: ${policy.appList.join(', ')}.` + (policy.allowedPaths.length ? ` Allowed folders: ${policy.allowedPaths.join(' | ')}.` : ''));
    log('info', 'Open an allowed app (or an allowed folder in the file manager) so the session can start.');
    socket.emit('agent-state', { taskId, state: monitor.state, policy: policy.name });
    notify({ type: 'state', state: monitor.state, policy: policy.name });

    // Defence in depth: also stop locally when the window ends, even if the server cannot be reached
    const msLeft = Date.parse(res.windowEnd) - (Date.now() + (res.serverTime - Date.now()));
    if (Number.isFinite(msLeft)) expiryTimer = setTimeout(() => shutdown(0, 'The approved time window has ended.'), Math.max(0, msLeft));
  });
});

socket.on('remote-input', (ev) => { if (injector) injector.handle(ev); });
socket.on('control-halt', (d) => { if (bridge) bridge.broadcast({ t: 'halt', reason: d && d.reason }); if (monitor) monitor.lock(); if (d && d.reason === 'ended') shutdown(0, 'Session ended.'); });
socket.on('control-resume', () => { if (monitor) monitor.rearm(); });
socket.on('session-ended', () => shutdown(0, 'Session ended.'));
socket.on('connect_error', (e) => {
  if (e.message === 'Authentication required') return shutdown(1, 'This agent token is expired or invalid. Pair the agent again from the dashboard.');
  log('warn', `Cannot reach ${cfg.SERVER_URL} (${e.message}). Retrying...`);
});
socket.on('disconnect', (reason) => log('warn', `Disconnected (${reason}). Vendor input is paused until the connection returns.`));

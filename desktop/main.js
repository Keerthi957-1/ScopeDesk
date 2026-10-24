'use strict';
// ScopeDesk desktop shell (Electron main process).
// Double-click the app and it: starts the ScopeDesk server in the background (if one is not already running),
// opens the dashboard in a window, and starts/stops the host agent on request of the page. No terminal is shown.
//
// Safety rules built in:
//   * remote control exists only while this window is open: closing the window stops the agent (nothing keeps running hidden)
//   * the window title and a system notification say when remote control is active, and the page has a Stop button
//   * only the ScopeDesk page itself can call the agent IPC channels, and it can only send {taskId, token}
//   * the agent still enforces the task's allowed apps/folders and the time window (agent/policy.js, monitor.js)
const { app, BrowserWindow, ipcMain, session, desktopCapturer, shell, Notification } = require('electron');
const path = require('path');
const fs = require('fs');
const http = require('http');
const crypto = require('crypto');
const { fork, spawn } = require('child_process');
const { createAgentRunner } = require('./agent-runner');
const { validateAgentConfig, isTrustedSender } = require('./validate');

const APP_DIR = path.join(__dirname, '..');
const AGENT_DIR = path.join(APP_DIR.replace('app.asar', 'app.asar.unpacked'), 'agent'); // native modules cannot run from inside an asar
const PORT = Number(process.env.PORT || 3000);
// Point this at a hosted ScopeDesk server to use the app as a pure client (no local server is started then)
const REMOTE_SERVER = process.env.SCOPEDESK_SERVER_URL || '';
const SERVER_URL = (REMOTE_SERVER || `http://localhost:${PORT}`).replace(/\/+$/, '');
const DATA_DIR = path.join(app.getPath('userData'), 'data');

let win = null, serverChild = null, runner = null;

// ---------- helpers ----------
function healthy(url) {
  return new Promise((resolve) => {
    const req = http.get(`${url}/api/health`, { timeout: 1500 }, (res) => {
      let body = '';
      res.on('data', (d) => { body += d; });
      res.on('end', () => { try { resolve(JSON.parse(body).app === 'scopedesk'); } catch (_) { resolve(false); } });
    });
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.on('error', () => resolve(false));
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function persistentSecret() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const file = path.join(DATA_DIR, 'jwt_secret');
  try { return fs.readFileSync(file, 'utf8').trim(); } catch (_) { /* first run */ }
  const secret = crypto.randomBytes(48).toString('hex');
  fs.writeFileSync(file, secret, { mode: 0o600 });
  return secret;
}

// ---------- local server ----------
function launchServer(useSystemNode) {
  const logFd = fs.openSync(path.join(DATA_DIR, 'server.log'), 'a');
  const env = {
    ...process.env, PORT: String(PORT), HOST: process.env.HOST || '127.0.0.1',
    DB_PATH: path.join(DATA_DIR, 'scopedesk.db'), JWT_SECRET: persistentSecret(), CORS_ORIGIN: SERVER_URL
  };
  const serverJs = path.join(APP_DIR, 'server.js');
  let child;
  if (useSystemNode) {
    child = spawn('node', [serverJs], { cwd: APP_DIR, env, windowsHide: true, stdio: ['ignore', logFd, logFd] });
  } else {
    env.ELECTRON_RUN_AS_NODE = '1';
    child = fork(serverJs, [], { cwd: APP_DIR, env, execPath: process.execPath, windowsHide: true, stdio: ['ignore', logFd, logFd, 'ipc'] });
  }
  child.exited = false;
  child.on('exit', () => { child.exited = true; });
  child.on('error', () => { child.exited = true; });
  return child;
}

async function waitHealthy(child, ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await healthy(SERVER_URL)) return true;
    if (child && child.exited) return false;
    await sleep(400);
  }
  return false;
}

async function ensureServer() {
  if (await healthy(SERVER_URL)) return;                      // already running (yours, or a hosted one)
  if (REMOTE_SERVER) throw new Error(`Cannot reach the ScopeDesk server at ${SERVER_URL}. Check your internet connection.`);
  fs.mkdirSync(DATA_DIR, { recursive: true });
  // 1) the runtime bundled inside the app; 2) if that cannot run the server (e.g. no node:sqlite), Node installed on this PC
  for (const useSystemNode of [false, true]) {
    serverChild = launchServer(useSystemNode);
    if (await waitHealthy(serverChild, 20000)) return;
    try { serverChild.kill(); } catch (_) { /* already gone */ }
    serverChild = null;
  }
  throw new Error(`The ScopeDesk server did not start. Details are in ${path.join(DATA_DIR, 'server.log')}`);
}

// ---------- window ----------
function setTitle(active) { if (win && !win.isDestroyed()) win.setTitle(active ? 'ScopeDesk - REMOTE CONTROL ACTIVE' : 'ScopeDesk'); }

function createWindow() {
  win = new BrowserWindow({
    width: 1280, height: 860, minWidth: 980, minHeight: 640, show: false, backgroundColor: '#0b1a24', title: 'ScopeDesk',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true, spellcheck: false }
  });
  win.once('ready-to-show', () => win.show());
  win.on('closed', () => { win = null; });
  win.webContents.setWindowOpenHandler(({ url }) => {
    // The Vendor's full-screen workspace is the one window the page may open (same origin, remote-viewport.html only)
    if (isTrustedSender(url, SERVER_URL) && /\/remote-viewport\.html(\?|$)/.test(url)) {
      return { action: 'allow', overrideBrowserWindowOptions: { width: 1600, height: 900, autoHideMenuBar: true, backgroundColor: '#000000', title: 'ScopeDesk - Remote workspace', webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true } } };
    }
    if (/^https:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('did-create-window', (child) => {
    child.maximize();   // the workspace uses the whole display
    child.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    child.webContents.on('will-navigate', (e, u) => { if (!isTrustedSender(u, SERVER_URL)) e.preventDefault(); });
  });
  win.webContents.on('will-navigate', (e, url) => { if (!url.startsWith('file:') && !isTrustedSender(url, SERVER_URL)) e.preventDefault(); });
  win.loadFile(path.join(__dirname, 'splash.html'));
}

function showError(message) { if (win) win.loadFile(path.join(__dirname, 'splash.html'), { query: { error: message } }); }

function configureSession() {
  const ses = session.defaultSession;
  const allowed = new Set(['notifications', 'display-capture', 'clipboard-sanitized-write']);
  ses.setPermissionRequestHandler((_wc, permission, cb, details) => cb(allowed.has(permission) && isTrustedSender(details.requestingUrl, SERVER_URL)));
  // "Share my screen": the page asks for the screen; the Client has just confirmed in the app's share dialog.
  ses.setDisplayMediaRequestHandler(async (request, callback) => {
    if (!isTrustedSender(request.securityOrigin, SERVER_URL)) return callback({});
    try {
      const sources = await desktopCapturer.getSources({ types: ['screen'] });
      callback(sources.length ? { video: sources[0] } : {});   // primary screen
    } catch (_) { callback({}); }
  }, { useSystemPicker: false });
}

// ---------- agent + IPC ----------
function notify(title, body) { try { if (Notification.isSupported()) new Notification({ title, body }).show(); } catch (_) { /* optional */ } }

function setupAgentIpc() {
  let wasActive = false;
  runner = createAgentRunner({
    agentDir: AGENT_DIR, serverUrl: SERVER_URL,
    onStatus: (s) => {
      const active = ['connected', 'running'].includes(s.phase) || s.phase === 'starting';
      setTitle(active);
      if (active && !wasActive) notify('ScopeDesk', 'Remote control is active for the approved task. Close ScopeDesk or press Stop to end it.');
      if (!active && wasActive) notify('ScopeDesk', 'Remote control has ended.');
      wasActive = active;
      if (win && !win.isDestroyed()) win.webContents.send('agent:status', s);
    }
  });
  const trusted = (event) => isTrustedSender(event.senderFrame ? event.senderFrame.url : '', SERVER_URL);
  ipcMain.handle('agent:initialize', (event, cfg) => {
    if (!trusted(event)) return { ok: false, error: 'Untrusted sender.' };
    const v = validateAgentConfig(cfg);
    if (!v.ok) return v;
    return runner.start(v.value);
  });
  ipcMain.handle('agent:stop', (event) => (trusted(event) ? runner.stop('stopped by the Client') : { ok: false, error: 'Untrusted sender.' }));
  ipcMain.handle('agent:status', (event) => (trusted(event) ? runner.status() : null));
}

// ---------- lifecycle ----------
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });
  app.whenReady().then(async () => {
    configureSession();
    setupAgentIpc();
    createWindow();
    try {
      await ensureServer();
      if (win) await win.loadURL(SERVER_URL);
    } catch (e) {
      showError(e.message);
    }
  });
  app.on('window-all-closed', () => app.quit());       // every platform: closing the window ends everything
  app.on('before-quit', () => {
    if (runner) runner.stop('app closed');
    if (serverChild && !serverChild.exited) { try { serverChild.kill(); } catch (_) { /* ignore */ } }
  });
}

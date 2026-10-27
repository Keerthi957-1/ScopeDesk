'use strict';
/**
 * Installed-application discovery for the Client's PC.
 *
 * Runs on the machine whose programs are being listed (the desktop app / host agent), never on the web server:
 * a cloud server can only see its own programs. Everything returned is a CLEAN display name
 * ("Calculator", "Chrome", "File Manager"): no path, no .exe/.app/.lnk, no duplicates, no shells or system tools.
 *
 * Sources
 *   Windows : Start Menu shortcuts (all users + current user), the "App Paths" registry key (via reg.exe), built-in Windows apps
 *   macOS   : /Applications, /System/Applications, /System/Applications/Utilities, ~/Applications (*.app bundles)
 *   Linux   : *.desktop launchers in the standard applications folders (Name= entry, NoDisplay entries skipped)
 *   Always  : the built-in catalog (agent/app-catalog.js), so the list is NEVER empty even if every native source fails.
 *
 * Use it from Electron main:
 *   ipcMain.handle('scopedesk:list-apps', () => require('./agent/app-discovery').discoverInstalledApps());
 * and from the preload script:
 *   contextBridge.exposeInMainWorld('scopedeskNative', { listInstalledApps: () => ipcRenderer.invoke('scopedesk:list-apps') });
 * The web page already calls window.scopedeskNative.listInstalledApps() when it exists.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const catalog = require('./app-catalog');

const CACHE_MS = 10 * 60 * 1000;
const MAX_APPS = 600;
const MAX_DEPTH = 4;
const MAX_FILES_SCANNED = 5000;

// Start Menu / launcher entries that are not programs a vendor would be asked to use
const JUNK_NAME = /(uninstall|remove|readme|release notes|license|licence|documentation|user guide|manual|\bhelp\b|website|web site|\bfaq\b|changelog|what'?s new|update|updater|setup|installer|repair|crash|report a bug|visit |online|support center|get started)/i;

let cache = { at: 0, apps: null };

function safeReaddir(dir) {
  try { return fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return []; }
}

/** Walks a folder (bounded) and returns files whose name ends with one of the extensions. */
function walk(dir, exts, state = { files: 0 }, depth = 0) {
  const out = [];
  if (depth > MAX_DEPTH) return out;
  for (const entry of safeReaddir(dir)) {
    if (state.files >= MAX_FILES_SCANNED) break;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...walk(full, exts, state, depth + 1));
    } else if (exts.some((e) => entry.name.toLowerCase().endsWith(e))) {
      state.files += 1;
      out.push(entry.name);
    }
  }
  return out;
}

function run(file, args, timeout = 8000) {
  return new Promise((resolve) => {
    try {
      execFile(file, args, { timeout, windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => resolve(err ? '' : String(stdout || '')));
    } catch (_) { resolve(''); }
  });
}

// ---------- Windows ----------
async function fromWindows(env = process.env) {
  const names = [];

  const startMenus = [
    env.ProgramData && path.join(env.ProgramData, 'Microsoft', 'Windows', 'Start Menu', 'Programs'),
    env.APPDATA && path.join(env.APPDATA, 'Microsoft', 'Windows', 'Start Menu', 'Programs')
  ].filter(Boolean);
  for (const dir of startMenus) names.push(...walk(dir, ['.lnk', '.url']));

  // App Paths lists real executables ("chrome.exe", "winword.exe"); the clean stem is mapped back to a catalog name when known
  const exeStems = [];
  for (const hive of ['HKLM', 'HKCU']) {
    const out = await run('reg.exe', ['query', `${hive}\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths`]);
    for (const line of out.split(/\r?\n/)) {
      const m = /App Paths\\([^\\]+?)\s*$/i.exec(line.trim());
      if (m) exeStems.push(m[1]);
    }
  }
  const stemToName = new Map();
  for (const a of catalog.CATALOG) for (const p of a.processes) stemToName.set(p.toLowerCase(), a.name);
  for (const exe of exeStems) {
    const stem = catalog.cleanAppName(exe);
    if (!stem) continue;
    const known = stemToName.get(stem.toLowerCase());
    if (known) names.push(known); // only catalogued executables: App Paths also holds many helper tools with no good display name
  }

  // Programs that ship with Windows and often have no Start Menu shortcut file
  names.push('File Manager', 'Notepad', 'Calculator', 'Paint', 'WordPad', 'Snipping Tool');
  return names;
}

// ---------- macOS ----------
function fromMac() {
  const dirs = ['/Applications', '/System/Applications', '/System/Applications/Utilities', path.join(os.homedir(), 'Applications')];
  const names = ['File Manager'];
  for (const dir of dirs) {
    for (const entry of safeReaddir(dir)) if (entry.name.toLowerCase().endsWith('.app')) names.push(entry.name);
  }
  return names;
}

// ---------- Linux ----------
function desktopEntryName(file) {
  let text = '';
  try { text = fs.readFileSync(file, 'utf8'); } catch (_) { return null; }
  const section = text.split(/\r?\n\[(?!Desktop Entry\])/)[0]; // only the main [Desktop Entry] block
  if (/^\s*(NoDisplay|Hidden)\s*=\s*true\s*$/im.test(section)) return null;
  if (/^\s*Type\s*=\s*(?!Application)/im.test(section)) return null;
  const m = /^\s*Name\s*=\s*(.+?)\s*$/m.exec(section);
  return m ? m[1] : null;
}
function fromLinux() {
  const dirs = ['/usr/share/applications', '/usr/local/share/applications', '/var/lib/flatpak/exports/share/applications',
    '/var/lib/snapd/desktop/applications', path.join(os.homedir(), '.local/share/applications'), path.join(os.homedir(), '.local/share/flatpak/exports/share/applications')];
  const names = ['File Manager'];
  for (const dir of dirs) {
    for (const entry of safeReaddir(dir)) {
      if (!entry.name.endsWith('.desktop')) continue;
      const name = desktopEntryName(path.join(dir, entry.name));
      if (name) names.push(name);
    }
  }
  return names;
}

/** Cleans, de-duplicates and filters raw names. Exported for tests. */
function sanitizeNames(raw) {
  const cleaned = (Array.isArray(raw) ? raw : []).map((n) => {
    const s = String(n == null ? '' : n).replace(/\.(lnk|url|desktop)$/i, '');
    return JUNK_NAME.test(s) && !catalog.CATALOG.some((a) => a.name.toLowerCase() === s.trim().toLowerCase()) ? null : s;
  }).filter(Boolean);
  return catalog.mergeAppLists(cleaned).slice(0, MAX_APPS);
}

/**
 * Returns clean, sorted application names for this computer. Never rejects and never returns an empty list:
 * when the native lookup fails the built-in catalog is returned.
 */
async function discoverInstalledApps({ force = false, platform = process.platform, env = process.env } = {}) {
  if (!force && cache.apps && Date.now() - cache.at < CACHE_MS) return cache.apps.slice();
  let raw = [];
  try {
    if (platform === 'win32') raw = await fromWindows(env);
    else if (platform === 'darwin') raw = fromMac();
    else raw = fromLinux();
  } catch (_) { raw = []; }
  const apps = catalog.mergeAppLists(catalog.listAppNames(), sanitizeNames(raw)).slice(0, MAX_APPS);
  cache = { at: Date.now(), apps };
  return apps.slice();
}

module.exports = { discoverInstalledApps, sanitizeNames, desktopEntryName };

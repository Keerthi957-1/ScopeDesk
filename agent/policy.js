'use strict';
// TASK POLICY: what the vendor may touch for a given task type.
//   allowedApps    app names / executable names that may be in front (the task's own approved app is always added)
//   allowedPaths   folders a FILE MANAGER window may show (the folder itself and everything below it)
//   fileManagers   which allowed apps are file managers whose folder is checked (default: explorer.exe, Finder)
// With no allowedPaths the policy is app-only. Task types are defined in policies.json next to this file.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { normalize: normalizeName } = require('./config');
const catalog = require('./app-catalog');

const DEFAULT_FILE_MANAGERS = ['explorer.exe', 'finder'];
// The file managers agent/path-probe.js can read the folder of (Explorer on Windows, Finder on macOS)
const VERIFIABLE_FILE_MANAGERS = new Set(['explorer', 'fileexplorer', 'finder']);

// Windows 10/11 Calculator is an app-store app: "calc.exe" is only a launcher and the window belongs to CalculatorApp.exe.
// Names in the same group are treated as one app. (Deliberately NOT done for ApplicationFrameHost: that would allow every store app.)
const APP_GROUPS = [['calc', 'calculatorapp', 'calculator']];
function withAliases(names) {
  const set = new Set(names);
  APP_GROUPS.forEach((g) => { if (g.some((n) => set.has(n))) g.forEach((n) => set.add(n)); });
  return set;
}

// Task types and app names are compared in one normalised form: Unicode-folded, trimmed, inner spaces collapsed, lower case.
// "Billing", "billing", "BILLING" and " Billing " are the same task type. (server/policy-catalog.js uses the same rule.)
const normalizeKey = (s) => String(s == null ? '' : s).normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase();

const expand = (p) => String(p).replace(/%([^%]+)%/g, (m, v) => (process.env[v] !== undefined ? process.env[v] : m)).replace(/^~(?=$|[\\/])/, os.homedir());

// Windows-style paths (C:\..., \\server\...) are compared case-insensitively with backslashes; everything else POSIX-style.
function normalizePath(p) {
  const s = expand(p);
  const win = /^[a-zA-Z]:|^\\\\/.test(s);
  const sep = win ? '\\' : '/';
  let n = (win ? path.win32 : path.posix).normalize(s);
  if (win || process.platform === 'darwin') n = n.toLowerCase();
  const isRoot = win ? /^[a-z]:\\$/.test(n) : n === '/';
  if (n.length > 1 && n.endsWith(sep) && !isRoot) n = n.slice(0, -1);
  return { n, sep };
}

// "C:\BillingDataEvil" is NOT inside "C:\BillingData": the check is on whole path segments
function isInside(candidate, allowed) {
  const c = normalizePath(candidate), a = normalizePath(allowed);
  if (c.sep !== a.sep) return false;
  if (c.n === a.n) return true;
  return c.n.startsWith(a.n.endsWith(a.sep) ? a.n : a.n + a.sep);
}

function loadPolicy({ taskType, targetProcess, taskId, extra, sessionConfigFile, file = path.join(__dirname, 'policies.json'), log }) {
  // A per-session file (see session.example.json) wins over policies.json. Its taskId must be the task this agent is paired with.
  if (sessionConfigFile) {
    const cfg = JSON.parse(fs.readFileSync(sessionConfigFile, 'utf8'));
    if (cfg.taskId !== undefined && taskId !== undefined && Number(cfg.taskId) !== Number(taskId)) {
      throw new Error(`SESSION_CONFIG is for task ${cfg.taskId}, but this agent is paired with task ${taskId}.`);
    }
    return buildPolicy(cfg.scope || 'session config', cfg, targetProcess);
  }
  let defs = {};
  try { defs = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { log('warn', `Could not read policies.json (${e.message}). Using app-only mode.`); }

  const custom = {
    paths: ((extra && extra.allowedPaths) || []).map(String).filter(Boolean),
    apps: ((extra && extra.allowedApps) || []).map(String).filter(Boolean)
  };
  const hasCustom = custom.paths.length > 0 || custom.apps.length > 0;
  const names = Object.keys(defs).filter((k) => !k.startsWith('_'));
  const key = taskType ? names.find((k) => normalizeKey(k) === normalizeKey(taskType)) : null;
  const def = key ? defs[key] : null;
  if (taskType && !def && !hasCustom) log('warn', `No policy named "${taskType}" in policies.json (available: ${names.join(', ') || 'none'}). Using app-only mode: ONLY the task's approved app is allowed, so the file manager will count as a violation.`);
  if (!taskType && !hasCustom) log('warn', 'This task has no task type and no custom scope, so only the approved app is allowed. Choose a task type, or add custom folders/apps when creating the task.');
  if (taskType && !def && hasCustom) log('warn', `No policy named "${taskType}" in policies.json: using only the custom scope from the ticket.`);

  // Custom folders/apps typed into the ticket are ADDED to the task type's lists (or stand alone for a custom task)
  const merged = {
    ...(def || {}),
    allowedApps: [...((def && (def.allowedApps || def.allowedProcesses)) || []), ...custom.apps],
    allowedPaths: [...((def && (def.allowedPaths || def.allowedDirectories)) || []), ...custom.paths]
  };
  // Custom folders are only reachable through a file manager, so allow it. Its folder is checked against the lists above.
  if (custom.paths.length) merged.allowedApps.push(...(merged.fileManagers || DEFAULT_FILE_MANAGERS));
  const name = def ? (hasCustom ? `${key} (custom)` : key) : (hasCustom ? 'Custom' : '(app only)');
  return buildPolicy(name, merged, targetProcess);
}

// The task form stores CLEAN app names ("File Manager", "Word", "Chrome", "Excel"), but the foreground monitor sees PROCESS names
// ("explorer"/"Finder", "WINWORD.EXE", "Google Chrome", "Microsoft Excel"). Comparing the two directly never matched, so for most
// approved apps the monitor stayed in "waiting" forever and every vendor click/key was dropped without a word. Each approved name
// is now expanded to the process names the shared catalog (agent/app-catalog.js) lists for it. Unknown names still match only
// themselves, so nothing beyond the approved apps is ever allowed.
function expandApp(name) {
  const keys = new Set([normalizeName(name)]);
  try {
    catalog.processKeysFor(name).forEach((k) => {
      // File managers whose folder this agent cannot verify (Nautilus, Dolphin, third-party "Files"...) are never added by expansion
      if (catalog.isFileManager(k) && !VERIFIABLE_FILE_MANAGERS.has(normalizeName(k))) return;
      keys.add(normalizeName(k));
    });
  } catch (_) { /* unusable name: itself only */ }
  keys.delete('');
  return [...keys];
}

// Accepts both spellings: allowedApps/allowedPaths (policies.json) and allowedProcesses/allowedDirectories (session config)
function buildPolicy(name, def, targetProcess) {
  const apps = [targetProcess, ...((def && (def.allowedApps || def.allowedProcesses)) || [])].filter(Boolean);
  const allowedPaths = ((def && (def.allowedPaths || def.allowedDirectories)) || []).map(String);
  const fileManagers = new Set(((def && def.fileManagers) || DEFAULT_FILE_MANAGERS).map(normalizeName));
  return {
    name,
    apps: withAliases(apps.flatMap(expandApp)),
    appList: apps,
    allowedPaths,
    fileManagers,
    pathAllowed: (folder) => allowedPaths.some((a) => isInside(folder, a))
  };
}

module.exports = { loadPolicy, isInside, normalizePath, normalizeKey };

'use strict';
/**
 * Validation for a new support task. Pure functions (no database, no Express), so the rules are easy to test.
 * The browser form is a convenience only: every rule here is enforced again on the server.
 */
const path = require('path');
const { cleanAppName, canonicalName, appKey, isBlockedApp } = require('../agent/app-catalog');

const DURATION_OPTIONS = [15, 30, 60, 120];     // minutes: exactly what the duration selector offers
const MAX_APPS = 50;
const MAX_PATHS = 10;
const TASK_MIN = 5;
const TASK_MAX = 300;

const stripTrailing = (s) => s.replace(/[.,;:!?)\]]+$/, '');

/**
 * Folders named inside the task text become the file-manager boundary.
 * Quote a folder that contains spaces:  Fix export in "C:\Clients\Acme Corp\Invoices"
 */
function extractPaths(text) {
  const found = [];
  let rest = String(text || '');

  const quoted = /["\u201c\u2018']\s*((?:[A-Za-z]:[\\/]|\\\\|%[A-Za-z_][A-Za-z0-9_]*%[\\/]?|~[\\/]|\/[A-Za-z0-9._-])[^"\u201d\u2019'\r\n]*?)\s*["\u201d\u2019']/g;
  rest = rest.replace(quoted, (_, p) => { found.push(p.trim()); return ' '; });

  const bare = /(?:^|[\s(])((?:[A-Za-z]:[\\/]|\\\\|%[A-Za-z_][A-Za-z0-9_]*%[\\/]|~[\\/])\S*|\/[A-Za-z0-9._-]+(?:\/\S*)+)/g;
  let m;
  while ((m = bare.exec(rest))) found.push(stripTrailing(m[1]));

  return [...new Set(found.filter(Boolean))];
}

/** Returns an error message, or null when the folder is acceptable as a boundary. */
function checkPath(p) {
  if (p.length > 260 || /[\u0000-\u001f]/.test(p)) return `Invalid folder: "${p.slice(0, 40)}".`;
  if (/(^|[\\/])\.\.([\\/]|$)/.test(p)) return `"${p.slice(0, 60)}" contains "..". Use the full folder path.`;
  if (/^(\\\\[?.]\\)/.test(p)) return `"${p.slice(0, 60)}" is a device path and cannot be used as a boundary.`;
  if (/^[a-zA-Z]:[\\/]*$/.test(p) || /^\/+$/.test(p) || /^~[\\/]*$/.test(p) || /^%(USERPROFILE|HOMEDRIVE|SYSTEMDRIVE|SYSTEMROOT|WINDIR)%[\\/]*$/i.test(p)) {
    return `"${p}" is a whole drive or profile. That would allow every folder in it. Name a specific folder.`;
  }
  if (/^[a-zA-Z]:[\\/]+(windows|program files( \(x86\))?|programdata)([\\/]*)$/i.test(p)) return `"${p}" is a system folder and cannot be used as a boundary.`;
  return null;
}

function parseAllowedApps(value) {
  const list = Array.isArray(value) ? value : [];
  if (list.length === 0) return { error: 'Choose at least one allowed application.' };
  if (list.length > MAX_APPS) return { error: `Choose at most ${MAX_APPS} applications.` };
  const seen = new Set();
  const apps = [];
  for (const raw of list) {
    const clean = canonicalName(raw);
    if (!clean) return { error: `"${String(raw).slice(0, 40)}" is not a valid application name.` };
    if (isBlockedApp(clean)) return { error: `"${clean}" cannot be allowed: command shells, script hosts and system tools are never permitted.` };
    const key = appKey(clean);
    if (!seen.has(key)) { seen.add(key); apps.push(clean); }
  }
  return { apps };
}

/**
 * body: { vendor_id, task, duration_minutes, allowed_apps: string[], alerts_enabled: boolean }
 * Returns { error } or { value }.
 */
function validateTaskRequest(body) {
  const b = body && typeof body === 'object' ? body : {};

  const vendorUserId = Number(b.vendor_id);
  if (!Number.isInteger(vendorUserId) || vendorUserId <= 0) return { error: 'Choose the vendor this task is for.' };

  const task = String(b.task == null ? '' : b.task).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').replace(/\s+/g, ' ').trim();
  if (task.length < TASK_MIN) return { error: `Describe the task (at least ${TASK_MIN} characters).` };
  if (task.length > TASK_MAX) return { error: `The task description is too long (maximum ${TASK_MAX} characters).` };

  const duration = Number(b.duration_minutes);
  if (!DURATION_OPTIONS.includes(duration)) return { error: `Duration must be one of: ${DURATION_OPTIONS.join(', ')} minutes.` };

  const apps = parseAllowedApps(b.allowed_apps);
  if (apps.error) return { error: apps.error };

  if (typeof b.alerts_enabled !== 'boolean') return { error: 'Alerts must be switched on or off.' };

  const paths = extractPaths(task);
  if (paths.length > MAX_PATHS) return { error: `At most ${MAX_PATHS} folders can be named in one task.` };
  for (const p of paths) {
    const problem = checkPath(p);
    if (problem) return { error: problem };
  }

  return { value: { vendorUserId, task, durationMinutes: duration, allowedApps: apps.apps, allowedPaths: paths, alertsEnabled: b.alerts_enabled } };
}

/** Safe JSON array reader for the allowed_apps / allowed_paths columns. */
function readList(column) {
  if (!column) return [];
  try { const v = JSON.parse(column); return Array.isArray(v) ? v.map(String) : []; } catch (_) { return []; }
}


// ---------- scope check used while a session is running ----------
const isWinPath = (s) => /^[a-zA-Z]:|^\\\\/.test(s);
const hasPlaceholder = (s) => /^%[A-Za-z_][A-Za-z0-9_]*%|^~/.test(s);

function canonical(p) {
  const s = String(p || '').trim();
  const win = isWinPath(s);
  const api = win ? path.win32 : path.posix;
  let n = api.normalize(s);
  const sep = win ? '\\' : '/';
  if (win) n = n.toLowerCase();
  const root = win ? /^[a-z]:\\$/.test(n) : n === '/';
  if (n.length > 1 && n.endsWith(sep) && !root) n = n.slice(0, -1);
  return { n, sep, win };
}

/**
 * Is `candidate` the same folder as one of `allowedPaths`, or below it? Whole path segments only:
 * "C:\\Data2" is NOT inside "C:\\Data". Returns:
 *   'inside'   definitely inside an approved folder
 *   'outside'  definitely outside every approved folder (this is a breach)
 *   'unknown'  cannot be decided here (no approved folders were named, or one uses %VARIABLES% / ~ that only the
 *              Client's PC can expand). The host agent on the Client's PC makes the final call in that case.
 */
function checkPathScope(candidate, allowedPaths) {
  const list = (Array.isArray(allowedPaths) ? allowedPaths : []).map(String).filter(Boolean);
  if (list.length === 0) return 'unknown';
  const c = String(candidate || '').trim();
  if (!c || hasPlaceholder(c)) return 'unknown';
  const cand = canonical(c);
  let undecidable = false;
  for (const a of list) {
    if (hasPlaceholder(a)) { undecidable = true; continue; }
    const al = canonical(a);
    if (al.sep !== cand.sep) continue;
    if (cand.n === al.n || cand.n.startsWith(al.n.endsWith(al.sep) ? al.n : al.n + al.sep)) return 'inside';
  }
  return undecidable ? 'unknown' : 'outside';
}

module.exports = { checkPathScope, DURATION_OPTIONS, TASK_MIN, TASK_MAX, extractPaths, checkPath, parseAllowedApps, validateTaskRequest, readList };

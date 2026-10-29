'use strict';
// FILE TRANSFER, vendor -> Client only, and only into a folder the task approved.
//
// The vendor's browser sends a file in small chunks through the ScopeDesk server (which checks the vendor, the task, the time window
// and the size). Here, on the Client's PC, the agent:
//   1. accepts it only while the task HAS approved folders, the session is not locked, and the target folder is inside them
//      (same case-insensitive, whole-segment check as everything else: policy.pathAllowed),
//   2. refuses programs and scripts (.exe, .bat, .ps1, .sh, .app, .command, .msi, .dmg ...) whatever the vendor calls them,
//   3. never overwrites: "report.xlsx" becomes "report (1).xlsx",
//   4. writes to a temporary file first and moves it into place only when every byte arrived (size checked).
// Nothing on the Client's PC is ever sent back to the vendor (no download direction: that would let data leave the PC).
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const MAX_FILE_BYTES = 25 * 1024 * 1024;
const MAX_CHUNK_BYTES = 256 * 1024;
const IDLE_MS = 60 * 1000;
const BLOCKED_EXT = new Set(['exe', 'com', 'bat', 'cmd', 'ps1', 'psm1', 'vbs', 'vbe', 'js', 'jse', 'wsf', 'wsh', 'msi', 'msp', 'scr', 'pif',
  'lnk', 'reg', 'hta', 'cpl', 'jar', 'sh', 'bash', 'zsh', 'command', 'app', 'pkg', 'dmg', 'run', 'bin', 'appimage', 'deb', 'rpm', 'apk', 'dll', 'sys', 'scpt']);

/** "../../evil.exe " -> null (blocked); "Report: Q1?.xlsx" -> "Report_ Q1_.xlsx". Returns null when unusable. */
function safeFileName(raw) {
  let n = String(raw || '').normalize('NFKC').split(/[\\/]/).pop().replace(/[\u0000-\u001f\u007f<>:"|?*]/g, '_').trim();
  n = n.replace(/^\.+/, '').replace(/[. ]+$/, '');
  if (!n || n.length > 180) return null;
  if (/^(con|prn|aux|nul|com\d|lpt\d)(\.|$)/i.test(n)) return null;          // Windows device names
  const ext = (n.includes('.') ? n.split('.').pop() : '').toLowerCase();
  if (BLOCKED_EXT.has(ext)) return null;
  return n;
}

function uniquePath(dir, name) {
  const ext = path.extname(name);
  const base = name.slice(0, name.length - ext.length);
  for (let i = 0; i < 1000; i++) {
    const p = path.join(dir, i === 0 ? name : `${base} (${i})${ext}`);
    if (!fs.existsSync(p)) return p;
  }
  return null;
}

/**
 * @param {{ policy, isLocked: () => boolean, log: Function, report: (result:object) => void, tmpDir?: string }} opts
 * report() gets { id, ok, name?, folder?, error? } (names and folders only, never the file's content)
 */
function createFileReceiver({ policy, isLocked, log = () => {}, report = () => {}, tmpDir = os.tmpdir() }) {
  const open = new Map();   // id -> { tmp, fd, size, got, name, folder, timer }

  function fail(id, error) {
    const f = open.get(id);
    if (f) { clearTimeout(f.timer); try { fs.closeSync(f.fd); } catch (_) { /* closed */ } fs.rm(f.tmp, { force: true }, () => {}); open.delete(id); }
    log('warn', `File transfer ${id} refused: ${error}`);
    report({ id, ok: false, error });
  }

  const expand = (p) => String(p).replace(/%([^%]+)%/g, (m, v) => process.env[v] || m).replace(/^~(?=$|[\\/])/, os.homedir());
  const isDir = (p) => { try { return fs.statSync(p).isDirectory(); } catch (_) { return false; } };
  function targetFolder(requested) {
    const wanted = String(requested || '').trim();
    if (wanted) { const w = expand(wanted); return policy.pathAllowed(wanted) && isDir(w) ? w : null; }
    // No folder chosen: the first approved folder that exists on this PC
    return ((policy && policy.allowedPaths) || []).map(expand).find(isDir) || null;
  }

  /** One chunk: { id, seq, name, size, folder?, last, data (Buffer) }. Returns true when accepted. */
  function chunk(c) {
    const id = String((c && c.id) || '').slice(0, 64);
    if (!/^[A-Za-z0-9_-]{6,64}$/.test(id)) return false;
    if (isLocked()) { fail(id, 'the session is locked'); return false; }
    const data = Buffer.isBuffer(c.data) ? c.data : (c.data instanceof Uint8Array || c.data instanceof ArrayBuffer ? Buffer.from(c.data) : null);
    if (!data || data.length > MAX_CHUNK_BYTES) { fail(id, 'invalid chunk'); return false; }

    let f = open.get(id);
    if (!f) {
      if (c.seq !== 0) { fail(id, 'transfer out of order'); return false; }
      if (!policy || !policy.allowedPaths || policy.allowedPaths.length === 0) { fail(id, 'this task has no approved folders, so no file can be received'); return false; }
      const name = safeFileName(c.name);
      if (!name) { fail(id, 'this file type is not allowed (programs and scripts are refused)'); return false; }
      const size = Number(c.size);
      if (!Number.isInteger(size) || size < 0 || size > MAX_FILE_BYTES) { fail(id, `files up to ${MAX_FILE_BYTES / 1024 / 1024} MB only`); return false; }
      const folder = targetFolder(c.folder);
      if (!folder) { fail(id, c.folder ? 'that folder is outside the approved folders' : 'no approved folder exists on this computer'); return false; }
      const tmp = path.join(tmpDir, `scopedesk-${crypto.randomBytes(8).toString('hex')}.part`);
      f = { tmp, fd: fs.openSync(tmp, 'wx', 0o600), size, got: 0, name, folder, next: 0, timer: null };
      open.set(id, f);
      log('info', `Receiving "${name}" (${size} bytes) into ${folder}`);
    }
    if (c.seq !== f.next) { fail(id, 'transfer out of order'); return false; }
    if (f.got + data.length > f.size) { fail(id, 'more data than announced'); return false; }
    fs.writeSync(f.fd, data);
    f.got += data.length; f.next += 1;
    clearTimeout(f.timer);
    f.timer = setTimeout(() => fail(id, 'transfer timed out'), IDLE_MS);
    if (f.timer.unref) f.timer.unref();

    if (c.last) {
      clearTimeout(f.timer);
      fs.closeSync(f.fd);
      open.delete(id);
      if (f.got !== f.size) { fs.rm(f.tmp, { force: true }, () => {}); report({ id, ok: false, error: 'the file arrived incomplete' }); return false; }
      const dest = uniquePath(f.folder, f.name);
      if (!dest || !policy.pathAllowed(path.dirname(dest))) { fs.rm(f.tmp, { force: true }, () => {}); report({ id, ok: false, error: 'could not choose a file name' }); return false; }
      try { fs.copyFileSync(f.tmp, dest, fs.constants.COPYFILE_EXCL); } finally { fs.rm(f.tmp, { force: true }, () => {}); }
      log('info', `Saved "${path.basename(dest)}" in ${f.folder}`);
      report({ id, ok: true, name: path.basename(dest), folder: f.folder });
    }
    return true;
  }

  function closeAll() { for (const id of [...open.keys()]) fail(id, 'the session ended'); }

  return { chunk, closeAll, MAX_FILE_BYTES };
}

module.exports = { createFileReceiver, safeFileName, MAX_FILE_BYTES, MAX_CHUNK_BYTES };

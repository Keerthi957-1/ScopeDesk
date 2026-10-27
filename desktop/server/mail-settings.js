'use strict';
/**
 * Email settings that can be entered inside the app (no terminal, no file editing).
 *
 *  Where they live : mail-settings.json next to server.js (written with owner-only permissions, listed in .gitignore).
 *  Priority        : real environment variables / .env always win over the saved file, so a hosted deployment (Railway ...)
 *                    configured with SMTP_USER / SMTP_PASS is never overridden.
 *  Who may save    : only a request from THIS computer (loopback), never behind a proxy, never in production, and only while email
 *                    is still unconfigured. A hosted server must use environment variables.
 */

const fs = require('fs');
const path = require('path');

const KEYS = ['SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASS', 'SMTP_SECURE', 'MAIL_FROM'];
const DEFAULT_FILE = path.join(__dirname, '..', 'mail-settings.json');

function settingsFile(env = process.env) {
  return env.MAIL_SETTINGS_FILE || DEFAULT_FILE;
}

/** Reads the saved settings. Never throws: a missing or damaged file just means "nothing saved". */
function loadMailSettings(file = settingsFile()) {
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    const out = {};
    for (const k of KEYS) if (typeof data[k] === 'string' && data[k]) out[k] = data[k];
    return out;
  } catch (_) {
    return {};
  }
}

/** Environment first, saved file second. */
function effectiveMailEnv(baseEnv = process.env, file = settingsFile(baseEnv)) {
  const saved = loadMailSettings(file);
  const merged = { ...baseEnv };
  for (const k of KEYS) if (!String(baseEnv[k] || '').trim() && saved[k]) merged[k] = saved[k];
  return merged;
}

/** Writes the file atomically with owner-only permissions. */
function saveMailSettings(settings, file = settingsFile()) {
  const clean = {};
  for (const k of KEYS) if (settings[k] !== undefined && settings[k] !== null && String(settings[k]) !== '') clean[k] = String(settings[k]);
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(clean, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
  try { fs.chmodSync(file, 0o600); } catch (_) { /* Windows: permissions come from the user profile folder */ }
  return clean;
}

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

/**
 * Is this request from the same computer the server runs on? Checks the socket address (not a header the sender controls),
 * refuses anything that passed through a proxy, and checks the Host header so a web page cannot reach this through DNS rebinding.
 */
function isLocalRequest(req) {
  const remote = req.socket && req.socket.remoteAddress;
  if (!remote || !LOOPBACK.has(remote)) return false;
  if (req.headers['x-forwarded-for'] || req.headers['forwarded'] || req.headers['x-real-ip']) return false;
  const host = String(req.headers.host || '').toLowerCase().replace(/:\d+$/, '');
  return host === 'localhost' || host === '127.0.0.1' || host === '[::1]';
}

module.exports = { loadMailSettings, saveMailSettings, effectiveMailEnv, isLocalRequest, settingsFile, KEYS };

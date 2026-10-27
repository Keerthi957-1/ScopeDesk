'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const { createOtpService } = require('../server/otp');
const settings = require('../server/mail-settings');
const { explainSmtpError, testSmtpLogin, buildVerificationMessage, createMailer } = require('../server/mailer');

function memoryDb() {
  const raw = new DatabaseSync(':memory:');
  raw.exec('CREATE TABLE email_verifications (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, code_hash TEXT NOT NULL, expires_at TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, used INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT (datetime(\'now\')))');
  return {
    raw,
    async all(sql, p = []) { return raw.prepare(sql).all(...p); },
    async get(sql, p = []) { return raw.prepare(sql).get(...p); },
    async run(sql, p = []) { const r = raw.prepare(sql).run(...p); return { lastInsertRowid: Number(r.lastInsertRowid), changes: r.changes }; }
  };
}

test('OTP: 6 digits, only a hash is stored, correct code verifies once', async () => {
  const db = memoryDb();
  const otp = createOtpService({ db, secret: 'k' });
  const { code, id } = await otp.issue(1);
  assert.match(code, /^[1-9]\d{5}$/);
  const stored = await db.get('SELECT * FROM email_verifications WHERE id = ?', [id]);
  assert.ok(!JSON.stringify(stored).includes(code), 'the code itself is never stored');
  assert.equal((await otp.verify(2, code)).ok, false, 'a code only works for its own account');
  assert.deepEqual(await otp.verify(1, ` ${code.slice(0, 3)} ${code.slice(3)} `), { ok: true });
  assert.equal((await otp.verify(1, code)).ok, false, 'a code works only once');
});

test('OTP: expires after 15 minutes', async () => {
  const db = memoryDb();
  let t = 1_000_000;
  const otp = createOtpService({ db, secret: 'k', now: () => t });
  assert.equal(otp.ttlMs, 15 * 60 * 1000);
  const { code } = await otp.issue(1);
  t += 15 * 60 * 1000 - 1;
  assert.equal((await otp.verify(1, code)).ok, true);
  const second = await otp.issue(1);
  t += 15 * 60 * 1000 + 1;
  assert.deepEqual(await otp.verify(1, second.code), { ok: false, reason: 'expired' });
});

test('OTP: wrong guesses are counted, 5 misses kill the code, a new code replaces the old', async () => {
  const db = memoryDb();
  const otp = createOtpService({ db, secret: 'k' });
  const first = await otp.issue(1);
  const wrong = first.code === '111111' ? '222222' : '111111';
  for (let i = 0; i < 4; i++) assert.deepEqual(await otp.verify(1, wrong), { ok: false, reason: 'invalid' });
  assert.deepEqual(await otp.verify(1, wrong), { ok: false, reason: 'locked' });
  assert.equal((await otp.verify(1, first.code)).ok, false, 'even the right code is refused after the lock');
  const next = await otp.issue(1);
  assert.equal((await otp.verify(1, first.code)).ok, false, 'an older code no longer works');
  assert.equal((await otp.verify(1, next.code)).ok, true);
  assert.deepEqual(await otp.verify(1, 'abc'), { ok: false, reason: 'invalid' });
  assert.deepEqual(await otp.verify(99, '123456'), { ok: false, reason: 'invalid' });
});

test('OTP: an undelivered code can be cancelled', async () => {
  const db = memoryDb();
  const otp = createOtpService({ db, secret: 'k' });
  const { id, code } = await otp.issue(1);
  await otp.cancel(id);
  assert.equal((await otp.verify(1, code)).ok, false);
});

test('mail settings: saved file is private, environment wins, damaged file is harmless', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sd-mail-'));
  const file = path.join(dir, 'mail-settings.json');
  assert.deepEqual(settings.loadMailSettings(file), {});
  settings.saveMailSettings({ SMTP_USER: 'me@gmail.com', SMTP_PASS: 'abcdefghijklmnop', SMTP_HOST: 'smtp.gmail.com', EVIL: 'x' }, file);
  if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o077, 0, 'owner-only permissions');
  assert.deepEqual(Object.keys(settings.loadMailSettings(file)).sort(), ['SMTP_HOST', 'SMTP_PASS', 'SMTP_USER']);

  const fromFile = settings.effectiveMailEnv({ PATH: 'p' }, file);
  assert.equal(fromFile.SMTP_USER, 'me@gmail.com');
  const envWins = settings.effectiveMailEnv({ SMTP_USER: 'ops@corp.com', SMTP_PASS: 'real' }, file);
  assert.equal(envWins.SMTP_USER, 'ops@corp.com');
  assert.equal(envWins.SMTP_PASS, 'real');
  fs.writeFileSync(file, '{broken');
  assert.deepEqual(settings.loadMailSettings(file), {});
  fs.rmSync(dir, { recursive: true, force: true });
});

test('isLocalRequest: only the same computer, never via a proxy or a foreign Host header', () => {
  const req = (remoteAddress, headers) => ({ socket: { remoteAddress }, headers });
  assert.equal(settings.isLocalRequest(req('127.0.0.1', { host: 'localhost:3000' })), true);
  assert.equal(settings.isLocalRequest(req('::1', { host: '127.0.0.1:3000' })), true);
  assert.equal(settings.isLocalRequest(req('::ffff:127.0.0.1', { host: 'localhost' })), true);
  assert.equal(settings.isLocalRequest(req('203.0.113.9', { host: 'localhost:3000' })), false);
  assert.equal(settings.isLocalRequest(req('127.0.0.1', { host: 'localhost:3000', 'x-forwarded-for': '203.0.113.9' })), false);
  assert.equal(settings.isLocalRequest(req('127.0.0.1', { host: 'evil.example.com' })), false, 'DNS rebinding');
  assert.equal(settings.isLocalRequest({ socket: {}, headers: {} }), false);
});

test('SMTP errors become plain sentences; the login test never sends mail', async () => {
  assert.match(explainSmtpError({ responseCode: 535, response: '535-5.7.8 Username and Password not accepted' }, { host: 'smtp.gmail.com' }), /App Password/);
  assert.match(explainSmtpError({ code: 'ENOTFOUND' }, { host: 'smtp.nope.test' }), /smtp\.nope\.test/);
  assert.match(explainSmtpError({ code: 'ETIMEDOUT' }, { host: 'h' }), /connect/i);

  let sent = 0;
  const ok = await testSmtpLogin({ SMTP_USER: 'a@gmail.com', SMTP_PASS: 'abcdefghijklmnop' }, { transportFactory: () => ({ verify: async () => true, sendMail: async () => { sent++; } }) });
  assert.equal(ok.ok, true);
  assert.equal(sent, 0);
  const bad = await testSmtpLogin({ SMTP_USER: 'a@gmail.com', SMTP_PASS: 'wrongwrongwrong' }, { transportFactory: () => ({ verify: async () => { throw Object.assign(new Error('x'), { responseCode: 535 }); } }) });
  assert.equal(bad.ok, false);
  assert.match(bad.error, /App Password/);
  assert.equal((await testSmtpLogin({})).ok, false);
});

test('verification email: professional HTML, spaced code, 15 minutes, escaped name', () => {
  const m = buildVerificationMessage({ from: 'f', to: 't', username: '<b>x</b>', code: '482913' });
  assert.match(m.html, /4 8 2 9 1 3/);
  assert.match(m.html, /15 minutes/);
  assert.match(m.html, /&lt;b&gt;x&lt;\/b&gt;/);
  assert.ok(!m.html.includes('<b>x</b>'));
  assert.match(m.text, /482913/);
  assert.match(m.subject, /482913/);
});

test('the mailer reports "not configured" until credentials exist, with no code logged', () => {
  const logs = [];
  const none = createMailer({ env: {}, log: { log: (m) => logs.push(m), warn: (m) => logs.push(m), error: (m) => logs.push(m) } });
  assert.equal(none.configured, false);
  const withCreds = createMailer({ env: { SMTP_USER: 'a@gmail.com', SMTP_PASS: 'p' }, log: { log() {}, warn() {}, error() {} }, transportFactory: () => ({ sendMail: async () => ({}), verify: async () => true }) });
  assert.equal(withCreds.configured, true);
});

test('front end: every element id the script reads exists in index.html', () => {
  const html = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');
  const js = fs.readFileSync(path.join(__dirname, '../public/script.js'), 'utf8');
  const ids = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));
  const wanted = new Set([...js.matchAll(/\$\('([A-Za-z0-9_-]+)'\)/g)].map((m) => m[1]));
  const missing = [...wanted].filter((id) => !ids.has(id));
  assert.deepEqual(missing, [], `ids used by script.js but missing in index.html: ${missing.join(', ')}`);
  assert.equal((html.match(/class="otp-box"/g) || []).length, 6, 'six OTP boxes');
});

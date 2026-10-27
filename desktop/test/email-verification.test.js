'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { parseEmail, checkMailDomain, validateEmailAddress } = require('../server/email-check');
const { createMailer, buildVerificationMessage, isPermanentRecipientFailure } = require('../server/mailer');

test('parseEmail accepts normal addresses and normalises case', () => {
  const r = parseEmail('  Keerthi.Bhat+test@Gmail.COM ');
  assert.equal(r.ok, true);
  assert.equal(r.email, 'keerthi.bhat+test@gmail.com');
});

test('parseEmail rejects malformed addresses', () => {
  for (const bad of ['', 'plain', 'a@b', 'a@@b.com', '@b.com', 'a@.com', 'a@b..com', 'a..b@c.com', '.a@c.com', 'a.@c.com', 'a b@c.com', 'a@b.c', 'a@-b.com',
    'a@b-.com', 'a@1.2.3.4', 'a@[1.2.3.4]', '"a"@b.com', 'a@localhost', 'a@b.invalid', 'x'.repeat(65) + '@b.com', 'a@' + 'x'.repeat(64) + '.com', 'a<b>@c.com', null, 42]) {
    assert.equal(parseEmail(bad).ok, false, `should reject ${JSON.stringify(bad)}`);
  }
});

test('parseEmail blocks disposable domains and suggests typo fixes', () => {
  assert.match(parseEmail('a@mailinator.com').error, /disposable/i);
  assert.match(parseEmail('me@gmial.com').error, /me@gmail\.com/);
  assert.equal(parseEmail('a@mailinator.com', { blockDisposable: false }).ok, true);
  assert.match(parseEmail('a@corp-temp.test', { env: { DISPOSABLE_EMAIL_DOMAINS: 'corp-temp.test' } }).error || '', /valid|real/i);
});

test('checkMailDomain: MX ok, A fallback ok, null MX / no records rejected, DNS failure lets people through', async () => {
  const enodata = Object.assign(new Error('x'), { code: 'ENODATA' });
  const notfound = Object.assign(new Error('x'), { code: 'ENOTFOUND' });
  const servfail = Object.assign(new Error('x'), { code: 'ESERVFAIL' });
  const mk = (o) => ({ resolveMx: async () => { throw enodata; }, resolve4: async () => { throw enodata; }, resolve6: async () => { throw enodata; }, ...o });

  assert.deepEqual(await checkMailDomain('a.com', { resolver: mk({ resolveMx: async () => [{ exchange: 'mx.a.com', priority: 10 }] }) }), { ok: true, checked: true });
  assert.equal((await checkMailDomain('a.com', { resolver: mk({ resolve4: async () => ['1.2.3.4'] }) })).ok, true);
  assert.equal((await checkMailDomain('a.com', { resolver: mk({ resolveMx: async () => [{ exchange: '.', priority: 0 }] }) })).ok, false);
  const none = await checkMailDomain('nope.com', { resolver: mk({ resolveMx: async () => { throw notfound; } }) });
  assert.equal(none.ok, false);
  assert.match(none.reason, /cannot receive email/);
  const down = await checkMailDomain('a.com', { resolver: mk({ resolveMx: async () => { throw servfail; } }) });
  assert.deepEqual([down.ok, down.checked], [true, false]);
  const slow = await checkMailDomain('a.com', { timeoutMs: 20, resolver: mk({ resolveMx: () => new Promise(() => {}) }) });
  assert.deepEqual([slow.ok, slow.checked], [true, false]);
});

test('validateEmailAddress combines syntax and DNS', async () => {
  assert.equal((await validateEmailAddress('a@b', { skipDns: true })).ok, false);
  assert.equal((await validateEmailAddress('a@gmail.com', { skipDns: true })).ok, true);
  const res = await validateEmailAddress('a@nodomain-xyz.com', { resolver: { resolveMx: async () => { throw Object.assign(new Error(), { code: 'ENOTFOUND' }); }, resolve4: async () => { throw Object.assign(new Error(), { code: 'ENOTFOUND' }); }, resolve6: async () => { throw Object.assign(new Error(), { code: 'ENOTFOUND' }); } } });
  assert.equal(res.ok, false);
});

test('verification email carries the code and is never logged', async () => {
  const sent = []; const logs = [];
  const log = { log: (m) => logs.push(m), warn: (m) => logs.push(m), error: (m) => logs.push(m) };
  const mailer = createMailer({ env: { SMTP_USER: 'noreply@example.com', SMTP_PASS: 'x' }, log, transportFactory: () => ({ sendMail: async (m) => { sent.push(m); }, verify: async () => true }) });
  await mailer.sendVerificationCode('new@user.com', 'neo', '654321');
  assert.equal(sent[0].to, 'new@user.com');
  assert.match(sent[0].subject, /654321 is your ScopeDesk verification code/);
  assert.match(sent[0].text, /654321/);
  assert.ok(!logs.join('\n').includes('654321'));
  assert.match(buildVerificationMessage({ from: 'f', to: 't', username: '<x>', code: '111111' }).html, /&lt;x&gt;/);
});

test('permanent recipient failures are told apart from temporary ones', () => {
  assert.equal(isPermanentRecipientFailure({ responseCode: 550, response: '550 5.1.1 The email account does not exist' }), true);
  assert.equal(isPermanentRecipientFailure({ rejected: ['a@b.com'] }), true);
  assert.equal(isPermanentRecipientFailure({ responseCode: 535, response: '535 authentication failed' }), false);
  assert.equal(isPermanentRecipientFailure({ responseCode: 421, response: 'try later' }), false);
  assert.equal(isPermanentRecipientFailure(new Error('ETIMEDOUT')), false);
});

test('database: new column and table exist, and old users stay verified', () => {
  const os = require('os'); const path = require('path'); const fs = require('fs');
  const file = path.join(os.tmpdir(), `scopedesk-test-${process.pid}.db`);
  fs.rmSync(file, { force: true });
  const { DatabaseSync } = require('node:sqlite');
  // an "old" database without the column
  const old = new DatabaseSync(file);
  old.exec("CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT NOT NULL UNIQUE, email TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL, role TEXT NOT NULL, organization TEXT, is_active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL DEFAULT (datetime('now')))");
  old.exec("INSERT INTO users (username,email,password_hash,role) VALUES ('old','old@x.com','h','client')");
  old.close();
  const { spawnSync } = require('child_process');
  const r = spawnSync(process.execPath, ['-e', "const db=require('./db'); (async()=>{const u=await db.get('SELECT email_verified FROM users WHERE username=?',['old']); const t=await db.get(\"SELECT name FROM sqlite_master WHERE name='email_verifications'\"); console.log(JSON.stringify({v:u.email_verified,t:!!t}));})()"], { cwd: path.join(__dirname, '..'), env: { ...process.env, DB_PATH: file, NODE_NO_WARNINGS: '1' }, encoding: 'utf8' });
  fs.rmSync(file, { force: true });
  assert.match(r.stdout, /\{"v":1,"t":true\}/, r.stdout + r.stderr);
});

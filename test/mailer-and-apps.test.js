'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createMailer, readSmtpConfig } = require('../server/mailer');
const catalog = require('../agent/app-catalog');
const { sanitizeNames, discoverInstalledApps } = require('../agent/app-discovery');
const { parseAllowedApps } = require('../server/task-scope');

const quiet = { log() {}, warn() {}, error() {} };

test('SMTP config: Gmail defaults, Mailtrap override, missing credentials', () => {
  assert.equal(readSmtpConfig({}), null);
  assert.equal(readSmtpConfig({ SMTP_USER: 'a@b.c' }), null);
  const gmail = readSmtpConfig({ SMTP_USER: 'me@gmail.com', SMTP_PASS: 'abcd efgh ijkl mnop' });
  assert.equal(gmail.host, 'smtp.gmail.com');
  assert.equal(gmail.port, 587);
  assert.equal(gmail.secure, false);
  assert.equal(gmail.auth.pass, 'abcdefghijklmnop');
  const ssl = readSmtpConfig({ SMTP_USER: 'u', SMTP_PASS: 'p', SMTP_PORT: '465' });
  assert.equal(ssl.secure, true);
  const trap = readSmtpConfig({ SMTP_HOST: 'sandbox.smtp.mailtrap.io', SMTP_PORT: '2525', SMTP_USER: 'u', SMTP_PASS: 'p w' });
  assert.equal(trap.host, 'sandbox.smtp.mailtrap.io');
  assert.equal(trap.port, 2525);
  assert.equal(trap.auth.pass, 'p w');
});

test('mailer sends the code to the user address and never logs it', async () => {
  const sent = [];
  const logs = [];
  const log = { log: (m) => logs.push(m), warn: (m) => logs.push(m), error: (m) => logs.push(m) };
  const mailer = createMailer({
    env: { SMTP_USER: 'noreply@example.com', SMTP_PASS: 'secret' },
    log,
    transportFactory: () => ({ sendMail: async (m) => { sent.push(m); return {}; }, verify: async () => true })
  });
  assert.equal(mailer.configured, true);
  await mailer.sendResetCode('user@example.com', 'Keerthi <b>', '482913');
  await mailer.verify();
  assert.equal(sent[0].to, 'user@example.com');
  assert.match(sent[0].text, /482913/);
  assert.ok(sent[0].html.includes('Keerthi &lt;b&gt;'));
  assert.ok(!logs.join('\n').includes('482913'));
});

test('mailer without credentials is unconfigured and refuses to send', async () => {
  const mailer = createMailer({ env: {}, log: quiet });
  assert.equal(mailer.configured, false);
  await assert.rejects(() => mailer.sendResetCode('a@b.co', 'x', '123456'));
});

test('catalog has File Manager / Calculator / Notepad / Paint / Chrome as clean names', () => {
  const names = catalog.listAppNames();
  for (const n of ['File Manager', 'Calculator', 'Notepad', 'Paint', 'Chrome']) assert.ok(names.includes(n), n);
  assert.ok(names.every((n) => !/\.(exe|app|lnk)$/i.test(n)));
  assert.equal(catalog.isFileManager('File Manager'), true);   // selecting it never lifts the folder rule
});

test('mergeAppLists cleans, removes blocked tools and duplicates', () => {
  const out = catalog.mergeAppLists(['Excel.EXE', 'excel', 'C:\\Apps\\Billing.exe', 'cmd.exe', 'PowerShell', 'Foo.app']);
  assert.deepEqual(out, ['Billing', 'Excel', 'Foo']);
});

test('discovery sanitizer drops junk entries and extensions', () => {
  const out = sanitizeNames(['Google Chrome.lnk', 'Uninstall Foo.lnk', 'Foo Readme.lnk', 'Slack.lnk', 'Command Prompt.lnk', 'Calculator']);
  assert.ok(out.includes('Google Chrome') && out.includes('Slack') && out.includes('Calculator'));
  assert.ok(!out.some((n) => /uninstall|readme/i.test(n)));
});

test('discoverInstalledApps never returns an empty list, even when native sources fail', async () => {
  const apps = await discoverInstalledApps({ force: true, platform: 'linux', env: {} });
  assert.ok(apps.includes('File Manager') && apps.includes('Calculator'));
});

test('form accepts many applications at once', () => {
  const many = catalog.listAppNames();
  const r = parseAllowedApps(many);
  assert.ok(r.apps && r.apps.length === many.length, r.error);
});

'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createMailer, readBrevoConfig, parseSender } = require('../server/mailer');

const quiet = { log() {}, warn() {}, error() {} };

test('Brevo config needs a key and a valid sender address', () => {
  assert.equal(readBrevoConfig({}), null);
  assert.equal(readBrevoConfig({ BREVO_API_KEY: 'k' }), null);
  const c = readBrevoConfig({ BREVO_API_KEY: 'k', MAIL_FROM: 'ScopeDesk <me@gmail.com>' });
  assert.deepEqual(c.sender, { name: 'ScopeDesk', email: 'me@gmail.com' });
  assert.equal(readBrevoConfig({ BREVO_API_KEY: 'k', BREVO_SENDER_EMAIL: 'x@y.co' }).sender.email, 'x@y.co');
  assert.deepEqual(parseSender('plain@a.co'), { name: 'ScopeDesk', email: 'plain@a.co' });
});

test('Brevo mailer posts the code over HTTPS and never logs it', async () => {
  const calls = [];
  const logs = [];
  const fetchImpl = async (url, opts) => { calls.push({ url, opts }); return { ok: true, status: 201, json: async () => ({ messageId: '1' }) }; };
  const mailer = createMailer({
    env: { BREVO_API_KEY: 'secret-key', BREVO_SENDER_EMAIL: 'me@gmail.com' },
    log: { log: (m) => logs.push(m), warn: (m) => logs.push(m), error: (m) => logs.push(m) },
    fetchImpl
  });
  assert.equal(mailer.configured, true);
  await mailer.sendVerificationCode('user@example.org', 'Keerthi', '482913');
  const body = JSON.parse(calls[0].opts.body);
  assert.equal(calls[0].url, 'https://api.brevo.com/v3/smtp/email');
  assert.equal(calls[0].opts.headers['api-key'], 'secret-key');
  assert.equal(body.to[0].email, 'user@example.org');
  assert.match(body.textContent, /482913/);
  assert.ok(!logs.join('\n').includes('482913'));
});

test('Brevo errors become plain sentences', async () => {
  const fetchImpl = async () => ({ ok: false, status: 401, json: async () => ({ message: 'Key not found' }) });
  const mailer = createMailer({ env: { BREVO_API_KEY: 'bad', BREVO_SENDER_EMAIL: 'me@gmail.com' }, log: quiet, fetchImpl });
  await assert.rejects(() => mailer.sendResetCode('a@b.co', 'x', '123456'), /API key/);
});

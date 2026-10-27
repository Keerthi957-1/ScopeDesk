'use strict';
/**
 * Real email delivery for ScopeDesk (password-reset codes), built on nodemailer.
 *
 * Settings come from environment variables (or the .env file next to server.js):
 *   SMTP_HOST    default smtp.gmail.com   (Mailtrap: sandbox.smtp.mailtrap.io)
 *   SMTP_PORT    default 587              (Gmail 587 or 465, Mailtrap 2525)
 *   SMTP_USER    required                 (Gmail address, or the Mailtrap username)
 *   SMTP_PASS    required                 (Gmail App Password, or the Mailtrap password)
 *   SMTP_SECURE  optional "true"/"false"; default: true only for port 465
 *   MAIL_FROM    optional, default "ScopeDesk <SMTP_USER>"
 *
 * Two emails: the sign-up verification code and the password-reset code. A code is only ever placed in the email itself:
 * it is never written to a log or to the console.
 */

const DEFAULT_HOST = 'smtp.gmail.com';
const DEFAULT_PORT = 587;

const escapeHtml = (v) => String(v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** Builds the nodemailer transport options from the environment, or null when SMTP_USER / SMTP_PASS are missing. */
function readSmtpConfig(env = process.env) {
  const user = String(env.SMTP_USER || '').trim();
  const rawPass = String(env.SMTP_PASS || '');
  if (!user || !rawPass) return null;

  const host = String(env.SMTP_HOST || '').trim() || DEFAULT_HOST;
  const parsedPort = Number(env.SMTP_PORT);
  const port = Number.isInteger(parsedPort) && parsedPort > 0 && parsedPort < 65536 ? parsedPort : DEFAULT_PORT;
  const secureEnv = String(env.SMTP_SECURE || '').trim().toLowerCase();
  const secure = secureEnv === 'true' ? true : secureEnv === 'false' ? false : port === 465;
  // Gmail shows App Passwords as 4 groups separated by spaces; the spaces are not part of the password
  const pass = /(^|\.)gmail\.com$/i.test(host) ? rawPass.replace(/\s+/g, '') : rawPass;

  return {
    host, port, secure,
    auth: { user, pass },
    connectionTimeout: 15000,
    greetingTimeout: 15000,
    socketTimeout: 20000,
    requireTLS: !secure && port !== 2525 && port !== 25   // STARTTLS is mandatory on 587 (Mailtrap's sandbox port 2525 allows it but does not require it)
  };
}

function codeEmail({ from, to, username, code, subject, heading, intro, minutes, ignoreNote }) {
  const safeName = String(username || 'there');
  const digits = String(code).split('').join(' ');
  return {
    from,
    to,
    subject,
    text: `Hi ${safeName},\n\n${intro}\n\n    ${code}\n\nThis code expires in ${minutes} minutes. ${ignoreNote.enter}\n\n${ignoreNote.ignore}\n\n- The ScopeDesk team`,
    html: `<!doctype html><html><body style="margin:0;padding:0;background:#eef3f2">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#eef3f2;padding:32px 12px">
  <tr><td align="center">
    <table role="presentation" width="480" cellspacing="0" cellpadding="0" style="max-width:480px;width:100%;background:#ffffff;border-radius:14px;overflow:hidden;font-family:Segoe UI,Helvetica,Arial,sans-serif;color:#112933">
      <tr><td style="background:#0f2a35;padding:22px 28px;color:#ffffff;font-size:20px;font-weight:600;letter-spacing:.3px">ScopeDesk</td></tr>
      <tr><td style="padding:30px 28px 8px">
        <h1 style="margin:0 0 12px;font-size:22px;color:#0f2a35">${escapeHtml(heading)}</h1>
        <p style="margin:0 0 6px;font-size:15px;line-height:1.55">Hi ${escapeHtml(safeName)},</p>
        <p style="margin:0 0 20px;font-size:15px;line-height:1.55">${escapeHtml(intro)}</p>
        <div style="text-align:center;margin:22px 0">
          <span style="display:inline-block;background:#e8f7f1;border:2px dashed #00875f;border-radius:12px;padding:14px 26px;font-size:34px;font-weight:700;letter-spacing:6px;color:#006b4b;font-family:Consolas,Menlo,monospace">${escapeHtml(digits)}</span>
        </div>
        <p style="margin:0 0 8px;font-size:14px;line-height:1.55">This code expires in <strong>${minutes} minutes</strong>. ${escapeHtml(ignoreNote.enter)}</p>
        <p style="margin:0 0 24px;font-size:13px;line-height:1.55;color:#5a6b72">${escapeHtml(ignoreNote.ignore)}</p>
      </td></tr>
      <tr><td style="background:#f5f8f7;padding:16px 28px;font-size:12px;color:#7b8a90">Never share this code with anyone. ScopeDesk staff will never ask for it.</td></tr>
    </table>
  </td></tr>
</table></body></html>`
  };
}

/** Password-reset email. The code only ever exists inside this message. */
function buildMessage({ from, to, username, code }) {
  return codeEmail({
    from, to, username, code, minutes: 15,
    subject: 'Your ScopeDesk password reset code',
    heading: 'Reset your password',
    intro: 'Use this 6-digit code to reset your ScopeDesk password:',
    ignoreNote: {
      enter: 'Enter it on the sign-in page together with your new password.',
      ignore: 'If you did not ask for this, ignore this email. Your password will not change.'
    }
  });
}

/** Sign-up email verification. */
function buildVerificationMessage({ from, to, username, code }) {
  return codeEmail({
    from, to, username, code, minutes: 15,
    subject: `${code} is your ScopeDesk verification code`,
    heading: 'Verify your email address',
    intro: 'Use this 6-digit code to verify your email and activate your ScopeDesk account:',
    ignoreNote: {
      enter: 'Enter it on the ScopeDesk sign-up page to activate your account.',
      ignore: 'If you did not create a ScopeDesk account, ignore this email. The account stays disabled and is removed automatically.'
    }
  });
}

/**
 * Logs in to the mail server WITHOUT sending anything. Resolves { ok: true } or { ok: false, error: <plain sentence> }.
 * `transportFactory` is for tests.
 */
async function testSmtpLogin(env, { transportFactory } = {}) {
  const config = readSmtpConfig(env);
  if (!config) return { ok: false, error: 'Enter the email address and the app password.' };
  try {
    const transport = transportFactory ? transportFactory(config) : require('nodemailer').createTransport(config);
    await transport.verify();
    return { ok: true, host: config.host };
  } catch (err) {
    return { ok: false, error: explainSmtpError(err, { host: config.host }) };
  }
}

/** Turns a technical SMTP error into one sentence a non-technical person can act on. */
function explainSmtpError(err, { host = '' } = {}) {
  const code = Number(err && err.responseCode);
  const text = String((err && (err.response || err.message)) || '');
  const gmail = /gmail|google/i.test(host);
  if (code === 535 || code === 534 || /invalid login|authentication|username and password not accepted|application-specific password/i.test(text)) {
    return gmail
      ? 'Gmail rejected the login. Use a Google App Password (16 characters), not your normal password. Create one at myaccount.google.com/apppasswords (2-Step Verification must be on).'
      : 'The mail server rejected the username or password.';
  }
  if (err && (err.code === 'ENOTFOUND' || err.code === 'EDNS')) return `Could not find the mail server "${host}". Check the server name.`;
  if (err && (err.code === 'ETIMEDOUT' || err.code === 'ESOCKET' || err.code === 'ECONNECTION' || err.code === 'ECONNREFUSED')) return `Could not connect to the mail server${host ? ` "${host}"` : ''}. Check your internet connection and that the port is not blocked.`;
  return 'The mail server did not accept these settings.';
}

/**
 * Tells the caller whether a failed send means "this address will never work" (permanent SMTP 5xx about the recipient)
 * or "try again later" (network, timeout, 4xx, authentication).
 */
function isPermanentRecipientFailure(err) {
  if (!err) return false;
  const rejected = Array.isArray(err.rejected) && err.rejected.length > 0;
  const code = Number(err.responseCode);
  const recipientCodes = [550, 551, 553, 501, 511, 512, 513];
  return rejected || (recipientCodes.includes(code) && !/auth|credential|relay|sender|spam|blocked|policy/i.test(String(err.response || err.message || '')));
}

/**
 * Web-based sending through Brevo (https://www.brevo.com), used when BREVO_API_KEY is set.
 * Hosts such as Railway block the normal mail ports (SMTP 587/465), so a hosted server cannot reach Gmail directly.
 * Brevo is called over HTTPS (port 443), which is never blocked.
 *   BREVO_API_KEY       the API key (starts with "xkeysib-")
 *   BREVO_SENDER_EMAIL  an address you verified as a sender in Brevo (falls back to the address inside MAIL_FROM, then SMTP_USER)
 *   MAIL_FROM           optional display name, e.g. "ScopeDesk <you@gmail.com>"
 */
const BREVO_URL = 'https://api.brevo.com/v3/smtp/email';

/** Splits "Name <a@b.c>" or "a@b.c" into { name, email }. */
function parseSender(text) {
  const raw = String(text || '').trim();
  const m = raw.match(/^(.*)<([^<>@\s]+@[^<>@\s]+)>\s*$/);
  if (m) return { name: m[1].trim().replace(/^"|"$/g, '') || 'ScopeDesk', email: m[2].trim() };
  if (/^[^<>@\s]+@[^<>@\s]+$/.test(raw)) return { name: 'ScopeDesk', email: raw };
  return null;
}

/** @returns {{ apiKey: string, sender: { name: string, email: string } } | null} */
function readBrevoConfig(env = process.env) {
  const apiKey = String(env.BREVO_API_KEY || '').trim();
  if (!apiKey) return null;
  const fromEnvEmail = String(env.BREVO_SENDER_EMAIL || '').trim();
  const fromMail = parseSender(env.MAIL_FROM);
  const email = fromEnvEmail || (fromMail && fromMail.email) || String(env.SMTP_USER || '').trim();
  if (!/^[^<>@\s]+@[^<>@\s]+$/.test(email)) return null;
  return { apiKey, sender: { name: (fromMail && fromMail.name) || 'ScopeDesk', email } };
}

/** Plain-language explanation of a Brevo error. */
function explainBrevoError(status, body) {
  const message = String((body && body.message) || '');
  if (status === 401) return 'Brevo rejected the API key. Create a new key in Brevo (SMTP & API, then API Keys) and paste it again.';
  if (/sender|not valid|not verified|unauthorized.*ip/i.test(message)) return 'Brevo does not accept this sender address yet. Verify it in Brevo (Senders, Domains & Dedicated IPs, then Senders).';
  return `Brevo could not send the email (${status}${message ? ': ' + message : ''}).`;
}

/** A transport with the same sendMail(message) shape as nodemailer, but over HTTPS. `fetchImpl` is for tests. */
function createBrevoTransport(config, fetchImpl) {
  const doFetch = fetchImpl || globalThis.fetch;
  if (typeof doFetch !== 'function') throw new Error('This Node.js version has no fetch (need Node 18 or newer).');
  return {
    async sendMail(message) {
      const res = await doFetch(BREVO_URL, {
        method: 'POST',
        headers: { 'api-key': config.apiKey, 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({
          sender: config.sender,
          to: [{ email: message.to }],
          subject: message.subject,
          htmlContent: message.html,
          textContent: message.text
        }),
        signal: typeof AbortSignal !== 'undefined' && AbortSignal.timeout ? AbortSignal.timeout(15000) : undefined
      });
      if (!res.ok) {
        let body = null;
        try { body = await res.json(); } catch (_) { /* no JSON body */ }
        const err = new Error(explainBrevoError(res.status, body));
        err.httpStatus = res.status;
        throw err;
      }
      return res.json().catch(() => ({}));
    },
    async verify() {
      const res = await doFetch('https://api.brevo.com/v3/account', { headers: { 'api-key': config.apiKey, accept: 'application/json' }, signal: typeof AbortSignal !== 'undefined' && AbortSignal.timeout ? AbortSignal.timeout(15000) : undefined });
      if (!res.ok) throw new Error(explainBrevoError(res.status, null));
      return true;
    }
  };
}

/**
 * Creates the mailer. Returns { configured, from, host, sendResetCode(to, username, code), sendVerificationCode(to, username, code), verify() }.
 * `transportFactory` exists so tests can run without a real SMTP server.
 */
function createMailer({ env = process.env, log = console, transportFactory, fetchImpl } = {}) {
  // Web sending (Brevo) wins when its key is set: it works on hosts that block SMTP
  const brevo = readBrevoConfig(env);
  if (brevo) {
    const transport = createBrevoTransport(brevo, fetchImpl);
    const from = `${brevo.sender.name} <${brevo.sender.email}>`;
    const msgFrom = from;
    return {
      configured: true,
      from,
      host: 'api.brevo.com',
      async sendResetCode(to, username, code) { return transport.sendMail(buildMessage({ from: msgFrom, to, username, code })); },
      async sendVerificationCode(to, username, code) { return transport.sendMail(buildVerificationMessage({ from: msgFrom, to, username, code })); },
      async verify() {
        try {
          await transport.verify();
          log.log(`[MAIL] Email is ready (Brevo web API). Codes are sent from ${from}`);
          return true;
        } catch (err) {
          log.warn(`[MAIL] Could not reach Brevo: ${err.message}`);
          return false;
        }
      }
    };
  }

  const config = readSmtpConfig(env);
  const from = String(env.MAIL_FROM || '').trim() || `ScopeDesk <${String(env.SMTP_USER || 'no-reply@scopedesk.local').trim()}>`;

  if (!config) {
    log.warn('[MAIL] Email is NOT set up. Set SMTP_USER and SMTP_PASS (and optionally SMTP_HOST / SMTP_PORT) in .env. Password reset is unavailable until then.');
    return {
      configured: false, from, host: null,
      async sendResetCode() { throw new Error('Email delivery is not configured (SMTP_USER / SMTP_PASS missing).'); },
      async sendVerificationCode() { throw new Error('Email delivery is not configured (SMTP_USER / SMTP_PASS missing).'); },
      async verify() { return false; }
    };
  }

  let transport;
  try {
    transport = transportFactory ? transportFactory(config) : require('nodemailer').createTransport(config);
  } catch (err) {
    log.warn(`[MAIL] Could not start the email transport: ${err.message}. If the "nodemailer" package is missing, run "npm install nodemailer".`);
    return {
      configured: false, from, host: config.host,
      async sendResetCode() { throw new Error('Email transport is unavailable.'); },
      async sendVerificationCode() { throw new Error('Email transport is unavailable.'); },
      async verify() { return false; }
    };
  }

  return {
    configured: true,
    from,
    host: config.host,
    async sendResetCode(to, username, code) {
      return transport.sendMail(buildMessage({ from, to, username, code }));
    },
    async sendVerificationCode(to, username, code) {
      return transport.sendMail(buildVerificationMessage({ from, to, username, code }));
    },
    async verify() {
      try {
        await transport.verify();
        log.log(`[MAIL] Email is ready (${config.host}:${config.port}). Reset emails are sent from ${from}`);
        return true;
      } catch (err) {
        log.warn(`[MAIL] Could not log in to the email server ${config.host}:${config.port}: ${err.message}\n       Check SMTP_HOST / SMTP_PORT / SMTP_USER / SMTP_PASS in .env (Gmail needs an App Password; Mailtrap uses the inbox credentials).`);
        return false;
      }
    }
  };
}

module.exports = { createMailer, readSmtpConfig, readBrevoConfig, createBrevoTransport, parseSender, buildMessage, buildVerificationMessage, isPermanentRecipientFailure, explainSmtpError, testSmtpLogin, DEFAULT_HOST, DEFAULT_PORT };

'use strict';
/**
 * Defensive email address checks used at sign-up and password reset.
 *
 *  1. parseEmail()      strict syntax check (RFC 5321 limits, no consecutive dots, valid domain labels, no IP literals)
 *                       plus blocking of throw-away mail domains and a "did you mean gmail.com?" hint for common typos.
 *  2. checkMailDomain() asks DNS whether the domain can receive mail at all (MX record, or an A/AAAA record as RFC 5321 allows).
 *                       Only a DEFINITIVE "no such domain / no mail" answer rejects the address. A DNS timeout or server error
 *                       never blocks a real person from signing up.
 *
 * Neither step can prove that a particular mailbox exists. That is what the emailed 6-digit code is for.
 */

const dns = require('dns').promises;
const { domainToASCII } = require('url');

const LOCAL_RE = /^[a-z0-9!#$%&'*+/=?^_`{|}~.-]+$/;
const LABEL_RE = /^(?!-)[a-z0-9-]{1,63}(?<!-)$/;
const TLD_RE = /^(?:[a-z]{2,63}|xn--[a-z0-9-]{2,59})$/;

// Common throw-away / temporary inbox providers. Extend with DISPOSABLE_EMAIL_DOMAINS="a.com,b.com" in .env.
const DISPOSABLE = new Set([
  'mailinator.com', 'guerrillamail.com', 'guerrillamail.net', 'guerrillamail.org', 'sharklasers.com', 'grr.la', 'guerrillamailblock.com',
  '10minutemail.com', '10minutemail.net', 'tempmail.com', 'temp-mail.org', 'temp-mail.io', 'tempmail.net', 'throwawaymail.com',
  'yopmail.com', 'yopmail.net', 'yopmail.fr', 'trashmail.com', 'trashmail.net', 'getnada.com', 'nada.email', 'dispostable.com',
  'maildrop.cc', 'fakeinbox.com', 'mintemail.com', 'mohmal.com', 'emailondeck.com', 'spamgourmet.com', 'mailnesia.com',
  'tempinbox.com', 'burnermail.io', 'discard.email', 'mytemp.email', 'tmpmail.org', 'tmpmail.net', 'moakt.com', 'inboxkitten.com',
  'harakirimail.com', 'mailcatch.com', 'spambox.us', 'tempr.email', 'emailfake.com', 'fakemail.net', 'crazymailing.com'
]);

// Typo -> intended domain
const TYPOS = {
  'gmial.com': 'gmail.com', 'gmai.com': 'gmail.com', 'gmail.con': 'gmail.com', 'gmail.co': 'gmail.com', 'gamil.com': 'gmail.com',
  'gnail.com': 'gmail.com', 'gmaill.com': 'gmail.com', 'gmail.cm': 'gmail.com', 'gmal.com': 'gmail.com', 'gmeil.com': 'gmail.com',
  'yaho.com': 'yahoo.com', 'yahooo.com': 'yahoo.com', 'yahoo.con': 'yahoo.com', 'yhoo.com': 'yahoo.com',
  'hotmial.com': 'hotmail.com', 'hotmal.com': 'hotmail.com', 'hotmail.con': 'hotmail.com',
  'outlok.com': 'outlook.com', 'outlook.con': 'outlook.com', 'iclod.com': 'icloud.com', 'icloud.con': 'icloud.com'
};

function disposableSet(env = process.env) {
  const extra = String((env && env.DISPOSABLE_EMAIL_DOMAINS) || '').split(',').map((d) => d.trim().toLowerCase()).filter(Boolean);
  return extra.length ? new Set([...DISPOSABLE, ...extra]) : DISPOSABLE;
}

/**
 * @returns {{ ok: true, email: string, local: string, domain: string } | { ok: false, error: string }}
 */
function parseEmail(raw, { env = process.env, blockDisposable = true } = {}) {
  if (typeof raw !== 'string') return { ok: false, error: 'Please enter a valid email address.' };
  const trimmed = raw.trim();
  if (!trimmed) return { ok: false, error: 'Please enter your email address.' };
  if (/[\u0000-\u001f\u007f\s<>(),;:\\"[\]]/.test(trimmed)) return { ok: false, error: 'The email address contains characters that are not allowed (spaces, quotes or brackets).' };
  if (trimmed.length > 254) return { ok: false, error: 'That email address is too long.' };

  const at = trimmed.lastIndexOf('@');
  if (at <= 0 || at !== trimmed.indexOf('@')) return { ok: false, error: 'An email address needs exactly one "@" (for example name@company.com).' };

  const local = trimmed.slice(0, at).toLowerCase();
  const domainRaw = trimmed.slice(at + 1);
  if (!domainRaw) return { ok: false, error: 'The email address is missing the part after "@".' };

  if (local.length > 64) return { ok: false, error: 'The part before "@" is too long.' };
  if (!LOCAL_RE.test(local) || local.startsWith('.') || local.endsWith('.') || local.includes('..')) {
    return { ok: false, error: 'The part before "@" is not a valid mailbox name.' };
  }

  const domain = domainToASCII(domainRaw.toLowerCase());   // handles internationalised domains; returns '' when invalid
  if (!domain || domain.length > 253) return { ok: false, error: 'The domain after "@" is not valid.' };
  if (/^\d+(\.\d+){3}$/.test(domain) || domain.includes(':')) return { ok: false, error: 'Use an email address with a domain name, not an IP address.' };
  const labels = domain.split('.');
  if (labels.length < 2 || !labels.every((l) => LABEL_RE.test(l)) || !TLD_RE.test(labels[labels.length - 1])) {
    return { ok: false, error: 'The domain after "@" is not valid (for example company.com).' };
  }
  if (['localhost', 'local', 'test', 'invalid', 'example'].includes(labels[labels.length - 1]) || domain === 'example.com' || domain === 'example.org' || domain === 'example.net') {
    return { ok: false, error: 'Please use a real email address that can receive mail.' };
  }
  if (TYPOS[domain]) return { ok: false, error: `Did you mean ${local}@${TYPOS[domain]}?` };
  if (blockDisposable && disposableSet(env).has(domain)) return { ok: false, error: 'Temporary / disposable email addresses cannot be used. Please use your real email address.' };

  return { ok: true, email: `${local}@${domain}`, local, domain };
}

function withTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(Object.assign(new Error('DNS timeout'), { code: 'ETIMEOUT' })), ms); });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

const DEFINITIVE_NO = new Set(['ENOTFOUND', 'ENODATA', 'NXDOMAIN', 'NODATA']);

/**
 * Can this domain receive email?
 * @returns {Promise<{ ok: boolean, checked: boolean, reason?: string }>}  `checked: false` means DNS could not answer (the address is let through).
 */
async function checkMailDomain(domain, { resolver = dns, timeoutMs = 4000 } = {}) {
  try {
    const mx = await withTimeout(resolver.resolveMx(domain), timeoutMs);
    const real = (mx || []).filter((r) => r && r.exchange && r.exchange !== '.');
    if (real.length) return { ok: true, checked: true };
    if ((mx || []).length) return { ok: false, checked: true, reason: 'That domain does not accept email.' };   // "null MX" (RFC 7505)
  } catch (err) {
    if (!DEFINITIVE_NO.has(err && err.code)) return { ok: true, checked: false, reason: 'dns-unavailable' };
  }
  // No MX record: RFC 5321 falls back to the domain's own address record
  for (const lookup of ['resolve4', 'resolve6']) {
    try {
      const addrs = await withTimeout(resolver[lookup](domain), timeoutMs);
      if (addrs && addrs.length) return { ok: true, checked: true };
    } catch (err) {
      if (!DEFINITIVE_NO.has(err && err.code)) return { ok: true, checked: false, reason: 'dns-unavailable' };
    }
  }
  return { ok: false, checked: true, reason: `The domain "${domain}" cannot receive email. Check the spelling after the "@".` };
}

/** Syntax + deliverability in one call. */
async function validateEmailAddress(raw, options = {}) {
  const parsed = parseEmail(raw, options);
  if (!parsed.ok) return parsed;
  if (options.skipDns) return parsed;
  const domain = await checkMailDomain(parsed.domain, options);
  if (!domain.ok) return { ok: false, error: domain.reason };
  return parsed;
}

module.exports = { parseEmail, checkMailDomain, validateEmailAddress, DISPOSABLE };

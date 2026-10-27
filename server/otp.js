'use strict';
/**
 * One-time 6-digit codes for sign-up email verification.
 *
 *  issue(userId)         creates a cryptographically random 6-digit code, stores ONLY a keyed hash of it (valid 15 minutes),
 *                        cancels every older code of that account, and returns the code so the caller can email it.
 *  cancel(id)            invalidates a code that could not be delivered.
 *  verify(userId, code)  constant-time comparison. Every guess is counted BEFORE it is compared, so parallel guessing gets no extra
 *                        tries; after maxWrong misses the code is dead and a new one must be requested.
 *
 * The code itself is never written to the database, a log or the console: it exists only in the email.
 */

const crypto = require('crypto');

const DEFAULT_TTL_MS = 15 * 60 * 1000;
const DEFAULT_MAX_WRONG = 5;

function createOtpService({ db, secret, ttlMs = DEFAULT_TTL_MS, maxWrong = DEFAULT_MAX_WRONG, now = () => Date.now() }) {
  if (!db || !secret) throw new Error('otp: db and secret are required');

  const hash = (userId, code, nonce) => crypto.createHmac('sha256', secret).update(`verify:${userId}:${code}:${nonce}`).digest('hex');

  return {
    ttlMs,
    maxWrong,

    /** @returns {Promise<{ id: number, code: string, expiresAt: number }>} */
    async issue(userId) {
      const code = String(crypto.randomInt(100000, 1000000));    // uniform over 100000..999999, never a leading zero
      const nonce = crypto.randomBytes(8).toString('hex');
      const expiresAt = now() + ttlMs;
      await db.run('UPDATE email_verifications SET used = 1 WHERE user_id = ? AND used = 0', [userId]);
      const row = await db.run('INSERT INTO email_verifications (user_id, code_hash, expires_at, attempts) VALUES (?, ?, ?, 0)',
        [userId, `${nonce}:${hash(userId, code, nonce)}`, new Date(expiresAt).toISOString()]);
      return { id: row.lastInsertRowid, code, expiresAt };
    },

    async cancel(id) {
      await db.run('UPDATE email_verifications SET used = 1 WHERE id = ?', [id]);
    },

    /** @returns {Promise<{ ok: true } | { ok: false, reason: 'invalid' | 'expired' | 'locked' }>} */
    async verify(userId, rawCode) {
      const code = String(rawCode == null ? '' : rawCode).replace(/\s+/g, '');
      if (!/^\d{6}$/.test(code)) return { ok: false, reason: 'invalid' };

      const row = await db.get('SELECT id, code_hash, expires_at FROM email_verifications WHERE user_id = ? AND used = 0 ORDER BY id DESC LIMIT 1', [userId]);
      if (!row) return { ok: false, reason: 'invalid' };
      if (new Date(row.expires_at).getTime() < now()) return { ok: false, reason: 'expired' };

      await db.run('UPDATE email_verifications SET attempts = attempts + 1 WHERE id = ? AND used = 0', [row.id]);
      const fresh = await db.get('SELECT attempts, used FROM email_verifications WHERE id = ?', [row.id]);
      if (!fresh || fresh.used || fresh.attempts > maxWrong) return { ok: false, reason: 'locked' };

      const [nonce, stored] = String(row.code_hash).split(':');
      const given = hash(userId, code, nonce);
      const match = !!stored && stored.length === given.length && crypto.timingSafeEqual(Buffer.from(stored, 'hex'), Buffer.from(given, 'hex'));
      if (!match) {
        if (fresh.attempts >= maxWrong) {
          await db.run('UPDATE email_verifications SET used = 1 WHERE id = ?', [row.id]);
          return { ok: false, reason: 'locked' };
        }
        return { ok: false, reason: 'invalid' };
      }
      await db.run('UPDATE email_verifications SET used = 1 WHERE user_id = ? AND used = 0', [userId]);
      return { ok: true };
    }
  };
}

module.exports = { createOtpService, DEFAULT_TTL_MS, DEFAULT_MAX_WRONG };

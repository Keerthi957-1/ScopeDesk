'use strict';
/**
 * ICE (NAT traversal) configuration handed to both WebRTC peers by GET /api/rtc-config.
 *
 *  STUN  lets each side learn its public address. Free, public, and enough when at least one side has an ordinary home/office NAT.
 *  TURN  relays the stream when a direct path is impossible: symmetric NAT, carrier-grade NAT (many mobile and some fibre ISPs),
 *        corporate firewalls. Different ISPs and Windows <-> macOS machines on different networks hit this all the time.
 *        There is NO free public TURN server that is safe to hard-code, so you run (or rent) one and put it in .env.
 *        Without TURN, "Share my screen" only works when a direct path exists. The server logs a warning at start-up.
 *
 * Environment variables (all optional):
 *   STUN_URLS              comma list, default: Google + Cloudflare public STUN
 *   TURN_URLS / TURN_URL   comma list (TURN_URL is accepted as a one-address alias), e.g. turn:turn.example.com:3478?transport=udp,turns:turn.example.com:5349?transport=tcp
 *                          A bare "turn:host:3478" is expanded to UDP + TCP so strict firewalls still have a path.
 *   TURN_USERNAME / TURN_CREDENTIAL   a fixed TURN account (simple; the credential does not expire). TURN_PASSWORD is accepted as an alias of TURN_CREDENTIAL.
 *   TURN_SECRET            coturn "use-auth-secret" shared secret: ScopeDesk then mints a credential PER REQUEST that stops working
 *                          when the task's time window ends (recommended). Overrides TURN_CREDENTIAL. TURN_USERNAME, if set, becomes the label inside the minted username.
 *   ICE_TRANSPORT_POLICY   "all" (default) or "relay" (force every packet through TURN, hides both IP addresses from each other)
 */

const crypto = require('crypto');

const DEFAULT_STUN = [
  'stun:stun.l.google.com:19302',
  'stun:stun1.l.google.com:19302',
  'stun:stun2.l.google.com:19302',
  'stun:stun3.l.google.com:19302',
  'stun:stun4.l.google.com:19302',
  'stun:stun.cloudflare.com:3478'
];

const URL_RE = /^(stun|stuns|turn|turns):[^\s,]+$/i;

function splitUrls(value) {
  return String(value || '').split(',').map((v) => v.trim()).filter((v) => URL_RE.test(v));
}

/** "turn:host:3478" with no transport becomes UDP + TCP; anything that already names a transport (or is turns:) is kept. */
function expandTurn(urls) {
  const out = [];
  for (const u of urls) {
    if (/^turn:/i.test(u) && !/[?&]transport=/i.test(u)) {
      out.push(`${u}?transport=udp`, `${u}?transport=tcp`);
    } else out.push(u);
  }
  return [...new Set(out)];
}

/** Reads and validates the settings. Pure: takes the environment as an argument so it can be tested. */
function readIceSettings(env = process.env) {
  const stun = splitUrls(env.STUN_URLS);
  const turnUrls = expandTurn(splitUrls(`${env.TURN_URLS || ''},${env.TURN_URL || ''}`).filter((u) => /^turns?:/i.test(u)));
  const secret = String(env.TURN_SECRET || '');
  const username = String(env.TURN_USERNAME || '');
  const credential = String(env.TURN_CREDENTIAL || env.TURN_PASSWORD || '');
  const policy = String(env.ICE_TRANSPORT_POLICY || 'all').toLowerCase() === 'relay' ? 'relay' : 'all';
  const stunUrls = stun.filter((u) => /^stuns?:/i.test(u));
  return {
    stunUrls: stunUrls.length ? stunUrls : DEFAULT_STUN,
    turnUrls,
    secret,
    username,
    credential,
    policy,
    turnReady: turnUrls.length > 0 && (!!secret || (!!username && !!credential))
  };
}

/** coturn REST-API credentials: username "<unix expiry>:<user>", password base64(HMAC-SHA1(secret, username)). */
function mintTurnCredential(secret, userId, expiresAtMs, nowMs = Date.now(), label = '') {
  const minLife = nowMs + 5 * 60 * 1000;                 // never shorter than 5 minutes
  const expiry = Math.ceil(Math.max(Number(expiresAtMs) || 0, minLife) / 1000) + 60;   // 60 s grace after the window
  const tag = String(label || '').replace(/[^A-Za-z0-9_.-]/g, '').slice(0, 32);
  const username = `${expiry}:${tag ? `${tag}-` : 'scopedesk-'}${Number(userId) || 0}`;
  const credential = crypto.createHmac('sha1', secret).update(username).digest('base64');
  return { username, credential, expiresAt: expiry * 1000 };
}

function relayConfigured(env = process.env) {
  return readIceSettings(env).turnReady;
}

/**
 * @param {{ userId?: number, expiresAtMs?: number }} ctx
 * @returns {Promise<{ iceServers: object[], iceTransportPolicy: 'all'|'relay', iceCandidatePoolSize: number, relay: boolean, expiresAt: number|null }>}
 */
async function buildRtcConfig(ctx = {}, env = process.env, nowMs = Date.now()) {
  const cfg = readIceSettings(env);
  const iceServers = [{ urls: cfg.stunUrls }];
  let expiresAt = null;

  if (cfg.turnReady) {
    if (cfg.secret) {
      const minted = mintTurnCredential(cfg.secret, ctx.userId, ctx.expiresAtMs, nowMs, cfg.username);
      expiresAt = minted.expiresAt;
      iceServers.push({ urls: cfg.turnUrls, username: minted.username, credential: minted.credential });
    } else {
      iceServers.push({ urls: cfg.turnUrls, username: cfg.username, credential: cfg.credential });
    }
  }

  return {
    iceServers,
    // "relay" without a TURN server could never connect, so it only applies when TURN is really configured
    iceTransportPolicy: cfg.policy === 'relay' && cfg.turnReady ? 'relay' : 'all',
    iceCandidatePoolSize: 4,        // gather candidates early so the connection starts faster
    relay: cfg.turnReady,
    expiresAt
  };
}

/** One-line start-up report for the server log (never prints credentials). */
function describeIceSetup(env = process.env) {
  const cfg = readIceSettings(env);
  if (cfg.turnReady) return `[RTC] STUN (${cfg.stunUrls.length}) + TURN relay (${cfg.turnUrls.length} URL${cfg.turnUrls.length > 1 ? 's' : ''}, ${cfg.secret ? 'time-limited credentials' : 'fixed account'}). Cross-network streaming is supported.`;
  return '[RTC] STUN only. Screen sharing works when a direct path exists, but fails between some networks (symmetric NAT, mobile/CGNAT, strict firewalls). Set TURN_URLS plus TURN_SECRET (or TURN_USERNAME and TURN_CREDENTIAL) in .env for reliable cross-network streaming.';
}

module.exports = { buildRtcConfig, relayConfigured, readIceSettings, mintTurnCredential, describeIceSetup, DEFAULT_STUN };

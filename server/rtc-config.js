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
 *   CLOUDFLARE_TURN_KEY_ID + CLOUDFLARE_TURN_API_TOKEN   Cloudflare Realtime TURN (free allowance). ScopeDesk asks Cloudflare for credentials
 *                          per session that expire when the task's time window ends. Recommended.
 *   METERED_APP + METERED_API_KEY   Metered TURN (free account). The app name is the part before ".metered.live".
 *   TURN_FORCE_RELAY       "true" sends every packet through the relay (hides both IP addresses); default is hybrid: direct path first, relay as fallback
 *   ICE_TRANSPORT_POLICY   older spelling of the same switch: "relay" = TURN_FORCE_RELAY
 *
 * There is deliberately NO built-in public/free relay: the old "open relay" servers with shared passwords are gone or parked, and a
 * shared password cannot expire when a task ends. With nothing configured the server uses STUN only and /api/health shows "relay": false.
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
const METERED_APP_RE = /^[a-z0-9][a-z0-9-]{0,62}$/i;       // becomes part of a host name: letters, digits and "-" only
const FETCH_TIMEOUT_MS = 5000;

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

const isTrue = (v) => /^(1|true|yes|on)$/i.test(String(v || '').trim());

/** Reads and validates the settings. Pure: takes the environment as an argument so it can be tested. */
function readIceSettings(env = process.env) {
  const stun = splitUrls(env.STUN_URLS);
  const turnUrls = expandTurn(splitUrls(`${env.TURN_URLS || ''},${env.TURN_URL || ''}`).filter((u) => /^turns?:/i.test(u)));
  const secret = String(env.TURN_SECRET || '');
  const username = String(env.TURN_USERNAME || '');
  const credential = String(env.TURN_CREDENTIAL || env.TURN_PASSWORD || '');
  const forceRelay = isTrue(env.TURN_FORCE_RELAY) || String(env.ICE_TRANSPORT_POLICY || '').toLowerCase() === 'relay';
  const stunUrls = stun.filter((u) => /^stuns?:/i.test(u));
  const cfKeyId = String(env.CLOUDFLARE_TURN_KEY_ID || '').trim();
  const cfToken = String(env.CLOUDFLARE_TURN_API_TOKEN || '').trim();
  const meteredApp = String(env.METERED_APP || '').trim();
  const meteredKey = String(env.METERED_API_KEY || '').trim();
  return {
    stunUrls: stunUrls.length ? stunUrls : DEFAULT_STUN,
    turnUrls,
    secret,
    username,
    credential,
    forceRelay,
    policy: forceRelay ? 'relay' : 'all',
    turnReady: turnUrls.length > 0 && (!!secret || (!!username && !!credential)),
    cloudflare: cfKeyId && cfToken ? { keyId: cfKeyId, token: cfToken } : null,
    metered: METERED_APP_RE.test(meteredApp) && meteredKey ? { app: meteredApp.toLowerCase(), key: meteredKey } : null
  };
}

/** coturn REST-API credentials: username "<unix expiry>:<user>", password base64(HMAC-SHA1(secret, username)). */
function mintTurnCredential(secret, userId, expiresAtMs, nowMs = Date.now(), label = '') {
  const minLife = nowMs + 5 * 60 * 1000;                 // never shorter than 5 minutes
  const expiry = Math.ceil(Math.max(Number(expiresAtMs) || 0, minLife) / 1000) + 60;   // 60 s grace after the window
  const tag = String(label || '').replace(/[^A-Za-z0-9_.-]/g, '').slice(0, 32);
  const username = `${expiry}:${tag ? `${tag}-` : ''}${Number(userId) || 0}`;
  const credential = crypto.createHmac('sha1', secret).update(username).digest('base64');
  return { username, credential, expiresAt: expiry * 1000 };
}

/** True when a relay the administrator configured exists (a private coturn, Cloudflare or Metered). */
function relayConfigured(env = process.env) {
  const c = readIceSettings(env);
  return c.turnReady || !!c.cloudflare || !!c.metered;
}

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
const hasTurn = (list) => list.some((s) => s && s.username && s.credential);

/** fetch() with a time limit. fetchFn is injectable for tests. */
async function timedFetch(fetchFn, url, options) {
  const ctl = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = ctl ? setTimeout(() => ctl.abort(), FETCH_TIMEOUT_MS) : null;
  try { return await fetchFn(url, ctl ? { ...options, signal: ctl.signal } : options); } finally { if (timer) clearTimeout(timer); }
}

function asServerList(value) {
  if (Array.isArray(value)) return value;
  if (value && Array.isArray(value.iceServers)) return value.iceServers;
  if (value && value.iceServers && typeof value.iceServers === 'object') return [value.iceServers];
  return [];
}

/** Cloudflare Realtime TURN: credentials that stop working when the task's time window ends. Throws on any failure. */
async function fetchCloudflare(cf, ctx, nowMs, fetchFn) {
  const ttl = clamp(Math.ceil(((Number(ctx.expiresAtMs) || 0) - nowMs) / 1000) + 30, 300, 86400);
  const res = await timedFetch(fetchFn, `https://rtc.live.cloudflare.com/v1/turn/keys/${encodeURIComponent(cf.keyId)}/credentials/generate-ice-servers`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${cf.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ ttl })
  });
  if (!res || !res.ok) throw new Error(`HTTP ${res && res.status}`);
  const servers = asServerList(await res.json()).map((s) => {
    const urls = (Array.isArray(s.urls) ? s.urls : [s.urls]).filter((u) => typeof u === 'string' && !/:53(\?|$)/.test(u));   // port 53 is blocked by browsers
    return { ...s, urls };
  }).filter((s) => s.urls.length);
  if (!hasTurn(servers)) throw new Error('no TURN entry in the answer');
  return { servers, expiresAt: nowMs + ttl * 1000 };
}

/** Metered TURN: the app name was validated in readIceSettings, so the request can only go to <app>.metered.live. Throws on failure. */
async function fetchMetered(m, fetchFn) {
  const res = await timedFetch(fetchFn, `https://${m.app}.metered.live/api/v1/turn/credentials?apiKey=${encodeURIComponent(m.key)}`, {});
  if (!res || !res.ok) throw new Error(`HTTP ${res && res.status}`);
  const servers = asServerList(await res.json()).filter((s) => s && s.urls);
  if (!hasTurn(servers)) throw new Error('no TURN entry in the answer');
  return { servers };
}

/**
 * @param {{ userId?: number, expiresAtMs?: number, env?: object, fetchFn?: Function, now?: number, log?: {error:Function} }} ctx
 * @param {object} [envArg] older call style: environment as the second argument
 * @param {number} [nowArg] older call style: current time as the third argument
 */
async function buildRtcConfig(ctx = {}, envArg, nowArg) {
  const env = envArg || ctx.env || process.env;
  const nowMs = Number.isFinite(nowArg) ? nowArg : (Number.isFinite(ctx.now) ? ctx.now : Date.now());
  const fetchFn = ctx.fetchFn || (typeof fetch === 'function' ? fetch : null);
  const log = ctx.log || console;
  const cfg = readIceSettings(env);
  const iceServers = [{ urls: cfg.stunUrls }];
  let relayKind = null, hardExpiry = false, expiresAt = null;

  const failed = (what, err) => {
    // Only the kind of failure is logged: never a key, token or URL that contains one.
    try { log.error(`[RTC] ${what} credentials unavailable (${(err && err.name === 'AbortError') ? 'timeout' : (err && err.message) || 'error'}); trying the next option`); } catch (_) { /* logging only */ }
  };

  if (cfg.turnReady) {                                    // 1. your own coturn / fixed account
    if (cfg.secret) {
      const minted = mintTurnCredential(cfg.secret, ctx.userId, ctx.expiresAtMs, nowMs, cfg.username);
      expiresAt = minted.expiresAt; hardExpiry = true; relayKind = 'coturn';
      iceServers.push({ urls: cfg.turnUrls, username: minted.username, credential: minted.credential });
    } else {
      relayKind = 'fixed';
      iceServers.push({ urls: cfg.turnUrls, username: cfg.username, credential: cfg.credential });
    }
  } else if (cfg.cloudflare && fetchFn) {                 // 2. Cloudflare
    try {
      const r = await fetchCloudflare(cfg.cloudflare, ctx, nowMs, fetchFn);
      iceServers.push(...r.servers); relayKind = 'cloudflare'; hardExpiry = true; expiresAt = r.expiresAt;
    } catch (err) { failed('Cloudflare TURN', err); }
  }
  if (!relayKind && cfg.metered && fetchFn) {             // 3. Metered
    try {
      const r = await fetchMetered(cfg.metered, fetchFn);
      iceServers.push(...r.servers); relayKind = 'metered';
    } catch (err) { failed('Metered TURN', err); }
  }

  return {
    iceServers,
    // "relay" without a TURN server could never connect, so strict mode only applies when a relay really exists
    iceTransportPolicy: cfg.forceRelay && relayKind ? 'relay' : 'all',
    bundlePolicy: 'max-bundle',
    rtcpMuxPolicy: 'require',
    iceCandidatePoolSize: 4,        // gather candidates early so the connection starts faster
    relay: !!relayKind,
    relayKind,
    hardExpiry,
    expiresAt
  };
}

/** One-line start-up report for the server log (never prints credentials). */
function describeIceSetup(env = process.env) {
  const cfg = readIceSettings(env);
  if (cfg.turnReady) return `[RTC] STUN (${cfg.stunUrls.length}) + TURN relay (${cfg.turnUrls.length} URL${cfg.turnUrls.length > 1 ? 's' : ''}, ${cfg.secret ? 'time-limited credentials' : 'fixed account'}). Cross-network streaming is supported.`;
  if (cfg.cloudflare) return `[RTC] STUN (${cfg.stunUrls.length}) + Cloudflare TURN (credentials created per session and expire with the task). Cross-network streaming is supported.`;
  if (cfg.metered) return `[RTC] STUN (${cfg.stunUrls.length}) + Metered TURN (credentials fetched per session). Cross-network streaming is supported.`;
  return '[RTC] STUN only. Screen sharing works when a direct path exists, but fails between some networks (symmetric NAT, mobile/CGNAT, strict firewalls). Set CLOUDFLARE_TURN_KEY_ID + CLOUDFLARE_TURN_API_TOKEN (free) or METERED_APP + METERED_API_KEY, or TURN_URLS + TURN_SECRET, for reliable cross-network streaming.';
}

module.exports = { buildRtcConfig, relayConfigured, readIceSettings, mintTurnCredential, describeIceSetup, DEFAULT_STUN };

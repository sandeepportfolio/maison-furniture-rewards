/**
 * Guesty token handoff between processes.
 *
 * Guesty's OAuth endpoint hands out 5 tokens per 24h per client, and every
 * process that boots with an empty disk — each Render deploy, each local dev
 * server — used to spend one. Render keeps the previous container serving
 * traffic until the new one is healthy, so a booting process can simply ask the
 * live site for the token it already holds. No third-party service, no extra
 * secret: both ends already have GUESTY_CLIENT_SECRET.
 *
 *   server  — GET /api/internal/guesty-handoff   (handler(), mounted in server.js)
 *   client  — fetchFromPeer(), used by guesty.js before it would call OAuth
 *
 * The request carries an HMAC of a timestamp (never the secret). The response
 * is the token AES-256-GCM encrypted under a key derived from the secret, so
 * only a holder of the secret can read it, and a captured exchange is
 * useless. Anyone holding the secret can already mint tokens, so this exports
 * nothing they could not obtain; it only avoids spending a daily slot.
 *
 * Built to sit beside the guest-facing availability path:
 *  - Consulted only when the process has NO usable token (and by the daily
 *    refresh). A request that already holds a token never touches it.
 *  - Bounded by a 1.5s timeout, never throws, and after a real failure the
 *    peer is skipped for a minute. "Peer has no token" is a normal miss.
 *  - Unauthenticated, stale, replayed and over-rate requests all get a bare 404.
 */

const crypto = require('crypto');

const PATH = '/api/internal/guesty-handoff';
const DEFAULT_PEER = 'https://www.bookwithregent.com';
const TIMEOUT_MS = 1_500;
const FAILURE_COOLDOWN_MS = 60_000;
const SIGNATURE_WINDOW_MS = 60_000;
const MAX_REQUESTS_PER_MINUTE = 20;

let downUntil = 0;
const status = { lastFetch: null, served: 0 };

function secret() { return process.env.GUESTY_CLIENT_SECRET || ''; }
function peerOrigin() { return (process.env.GUESTY_HANDOFF_URL || DEFAULT_PEER).replace(/\/+$/, ''); }
function isConfigured() { return Boolean(process.env.GUESTY_CLIENT_ID && secret()); }

const hmacKey = () => crypto.createHash('sha256').update('guesty-handoff|' + secret()).digest();
const sealKey = () => crypto.createHash('sha256').update('guesty-handoff-seal|' + secret()).digest();
const sign = (ts) => crypto.createHmac('sha256', hmacKey()).update(`${ts}|handoff|v1`).digest('hex');

function seal(payload) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', sealKey(), iv);
  const ct = Buffer.concat([c.update(JSON.stringify(payload), 'utf8'), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), ct]).toString('base64');
}

function open(blob) {
  const raw = Buffer.from(String(blob), 'base64');
  if (raw.length < 29) return null;
  const d = crypto.createDecipheriv('aes-256-gcm', sealKey(), raw.subarray(0, 12));
  d.setAuthTag(raw.subarray(12, 28));
  return JSON.parse(Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString('utf8'));
}

// ── Client ────────────────────────────────────────────────────────────

/** The peer's token as { token, expiry }, or null. Never throws. */
async function fetchFromPeer() {
  if (!isConfigured() || Date.now() < downUntil) return null;
  try {
    const ts = String(Date.now());
    const res = await fetch(peerOrigin() + PATH, {
      headers: { 'x-handoff-ts': ts, 'x-handoff-sig': sign(ts), Accept: 'application/json' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (res.status === 404) { status.lastFetch = 'miss'; return null; } // peer has nothing to share
    if (!res.ok) throw new Error('peer HTTP ' + res.status);
    const body = await res.json();
    let entry = null;
    try { entry = open(body && body.blob); } catch (_) { entry = null; }
    if (!entry || typeof entry.token !== 'string' || !entry.token || !Number.isFinite(entry.expiry)) {
      status.lastFetch = 'miss';
      return null;
    }
    status.lastFetch = 'hit';
    return { token: entry.token, expiry: entry.expiry };
  } catch (err) {
    downUntil = Date.now() + FAILURE_COOLDOWN_MS;
    status.lastFetch = 'error';
    console.warn(`Guesty token handoff failed (${err && err.message ? err.message : err}) — skipping the peer for ${FAILURE_COOLDOWN_MS / 1000}s`);
    return null;
  }
}

// ── Server ────────────────────────────────────────────────────────────

const seen = new Map();   // signature -> expiry, to refuse a replay inside the window
const hits = [];          // timestamps of recent requests, for the rate limit

function authorised(req) {
  const ts = String(req.get('x-handoff-ts') || '');
  const sig = String(req.get('x-handoff-sig') || '');
  if (!/^\d{10,16}$/.test(ts) || !/^[0-9a-f]{64}$/.test(sig)) return false;
  if (Math.abs(Date.now() - Number(ts)) > SIGNATURE_WINDOW_MS) return false;
  const want = Buffer.from(sign(ts), 'hex');
  const got = Buffer.from(sig, 'hex');
  if (want.length !== got.length || !crypto.timingSafeEqual(want, got)) return false;
  const now = Date.now();
  for (const [k, exp] of seen) if (exp < now) seen.delete(k);
  if (seen.has(sig)) return false;
  seen.set(sig, now + 2 * SIGNATURE_WINDOW_MS);
  return true;
}

/**
 * Express handler. `getShareable` returns { token, expiry } for a token that is
 * safe to hand on (real expiry, plenty of life, not rejected by Guesty), or null.
 */
function handler(getShareable) {
  return (req, res) => {
    res.set('Cache-Control', 'no-store');
    const now = Date.now();
    while (hits.length && hits[0] < now - 60_000) hits.shift();
    if (hits.length >= MAX_REQUESTS_PER_MINUTE) return res.status(404).json({ error: 'Not found' });
    hits.push(now);
    if (!isConfigured() || !authorised(req)) return res.status(404).json({ error: 'Not found' });
    let shareable = null;
    try { shareable = getShareable(); } catch (_) { shareable = null; }
    if (!shareable) return res.status(404).json({ error: 'Not found' });
    status.served++;
    res.json({ blob: seal({ token: shareable.token, expiry: shareable.expiry }) });
  };
}

/** Non-secret snapshot for tokenStatus(). */
function describe() {
  return { configured: isConfigured(), paused: Date.now() < downUntil, lastFetch: status.lastFetch, served: status.served };
}

module.exports = { PATH, isConfigured, fetchFromPeer, handler, describe };

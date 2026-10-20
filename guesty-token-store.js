/**
 * Shared Guesty token store (optional).
 *
 * Guesty's OAuth endpoint hands out 5 tokens per 24h per client, and every
 * process that boots with an empty disk — each Render deploy, each local dev
 * server — has to spend one. This module lets all of them share the single
 * live token through a small Redis-over-HTTPS database (Upstash), so a deploy
 * adopts the token the previous container minted instead of minting another.
 *
 * Inert unless configured:
 *   GUESTY_TOKEN_STORE_URL    https://<db>.upstash.io
 *   GUESTY_TOKEN_STORE_TOKEN  the database's REST token
 * (UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN are accepted as aliases.)
 * It also needs GUESTY_CLIENT_ID and GUESTY_CLIENT_SECRET, which every Guesty
 * caller already has.
 *
 * Safety properties — this sits next to the guest-facing availability path:
 *  - It is only ever consulted when the process has NO usable token. A normal
 *    request that already holds a token never touches the network here.
 *  - Every call is bounded by a short timeout and can never throw: any failure
 *    degrades to "no shared token" and the caller carries on exactly as it did
 *    before this module existed.
 *  - After a failure the store is skipped for a minute, so an outage costs one
 *    short delay rather than one per request.
 *  - The token is AES-256-GCM encrypted with a key derived from the client
 *    secret before it leaves the process, so the database only holds
 *    ciphertext. A rotated secret simply makes old entries unreadable.
 */

const crypto = require('crypto');

const TIMEOUT_MS = 1_500;
const FAILURE_COOLDOWN_MS = 60_000;
const KEY_PREFIX = 'regent:guesty:token:v1:';

let downUntil = 0;
const status = { lastLoad: null, lastSave: null, lastClear: null };

function endpoint() {
  const url = process.env.GUESTY_TOKEN_STORE_URL || process.env.UPSTASH_REDIS_REST_URL || '';
  const auth = process.env.GUESTY_TOKEN_STORE_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || '';
  return url && auth ? { url: url.replace(/\/+$/, ''), auth } : null;
}

function isConfigured() {
  return Boolean(
    endpoint() && process.env.GUESTY_CLIENT_ID && process.env.GUESTY_CLIENT_SECRET
  );
}

// One entry per client id, so a different Guesty account never reads this one's token.
function storeKey() {
  const id = String(process.env.GUESTY_CLIENT_ID || '');
  return KEY_PREFIX + crypto.createHash('sha256').update(id).digest('hex').slice(0, 16);
}

function cipherKey() {
  return crypto.createHash('sha256').update('guesty-token-store|' + process.env.GUESTY_CLIENT_SECRET).digest();
}

function seal(payload) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', cipherKey(), iv);
  const ct = Buffer.concat([c.update(JSON.stringify(payload), 'utf8'), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), ct]).toString('base64');
}

function open(blob) {
  const raw = Buffer.from(String(blob), 'base64');
  if (raw.length < 29) return null;
  const d = crypto.createDecipheriv('aes-256-gcm', cipherKey(), raw.subarray(0, 12));
  d.setAuthTag(raw.subarray(12, 28));
  const pt = Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString('utf8');
  return JSON.parse(pt);
}

async function command(args) {
  const ep = endpoint();
  const res = await fetch(ep.url, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + ep.auth, 'Content-Type': 'application/json' },
    body: JSON.stringify(args),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error('store HTTP ' + res.status);
  const json = await res.json();
  if (json && json.error) throw new Error('store error');
  return json ? json.result : null;
}

function available() {
  return isConfigured() && Date.now() >= downUntil;
}

function noteFailure(kind, err) {
  downUntil = Date.now() + FAILURE_COOLDOWN_MS;
  status['last' + kind] = 'error';
  console.warn(`Guesty token store ${kind.toLowerCase()} failed (${err && err.message ? err.message : err}) — skipping the store for ${FAILURE_COOLDOWN_MS / 1000}s`);
}

/** The shared token as { token, expiry }, or null. Never throws. */
async function load() {
  if (!available()) return null;
  try {
    const blob = await command(['GET', storeKey()]);
    if (!blob) { status.lastLoad = 'miss'; return null; }
    let entry = null;
    try { entry = open(blob); } catch (_) { entry = null; } // rotated secret / corrupt entry
    if (!entry || typeof entry.token !== 'string' || !entry.token || !Number.isFinite(entry.expiry)) {
      status.lastLoad = 'miss';
      return null;
    }
    status.lastLoad = 'hit';
    return { token: entry.token, expiry: entry.expiry };
  } catch (err) {
    noteFailure('Load', err);
    return null;
  }
}

/** Publish a freshly minted token. Never throws; resolves true on success. */
async function save(token, expiry) {
  if (!available() || !token || !Number.isFinite(expiry)) return false;
  const ttl = Math.floor((expiry - Date.now()) / 1000);
  if (ttl < 120) return false; // not worth sharing a token that is about to lapse
  try {
    await command(['SET', storeKey(), seal({ token, expiry }), 'EX', ttl]);
    status.lastSave = 'ok';
    return true;
  } catch (err) {
    noteFailure('Save', err);
    return false;
  }
}

// Delete the key only if it still holds exactly the entry we read. Atomic on the
// server, so a fresher token saved between our read and our delete survives.
const COMPARE_AND_DELETE =
  "if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) else return 0 end";

/** Remove the shared token if it is the one Guesty just rejected. Never throws. */
async function clear(token) {
  if (!available() || !token) return false;
  try {
    const blob = await command(['GET', storeKey()]);
    if (!blob) return false;
    let entry = null;
    try { entry = open(blob); } catch (_) { entry = null; }
    if (!entry || entry.token !== token) return false;
    await command(['EVAL', COMPARE_AND_DELETE, 1, storeKey(), blob]);
    status.lastClear = 'ok';
    return true;
  } catch (err) {
    noteFailure('Clear', err);
    return false;
  }
}

/** Non-secret snapshot for tokenStatus(). */
function describe() {
  return {
    configured: isConfigured(),
    paused: Date.now() < downUntil,
    lastLoad: status.lastLoad,
    lastSave: status.lastSave,
    lastClear: status.lastClear,
  };
}

module.exports = { isConfigured, load, save, clear, describe };

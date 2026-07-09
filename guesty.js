/**
 * Guesty Open API client.
 *
 * Uses the OAuth2 client_credentials grant against open-api.guesty.com.
 * Credentials are read from environment variables ONLY:
 *   GUESTY_CLIENT_ID, GUESTY_CLIENT_SECRET
 * They are never logged or returned to clients.
 */

const fs = require('fs');
const path = require('path');

const TOKEN_URL = 'https://open-api.guesty.com/oauth2/token';
const API_BASE = 'https://open-api.guesty.com/v1';
const SCOPE = 'open-api';

// Persist the token across process restarts so frequent cold starts (e.g. on
// Render's free tier) don't re-hit Guesty's token endpoint and trip its rate
// limit. The file lives under db/ which is gitignored — the token never enters
// version control.
const TOKEN_FILE = path.join(__dirname, 'db', 'guesty-token.json');

// ── Allow-listed listings ──────────────────────────────────────────────
// Maps the site's property slugs to their Guesty listing _id. The server
// only ever talks to Guesty about these listings, so the routes can't be
// abused as an open proxy. Slugs match the `data-property` attributes used
// by the front-end gallery/cards.
const LISTINGS = {
  'regent-villa':   { id: '6a3874d5bcc80700147920ca', name: 'Regent Villa' },
  'cozy-designer':  { id: '6a29dcff12cbdd0015a65a7d', name: 'Cozy Designer Suite' },
  'lake-view':      { id: '6a29dcfa14fca300148799c2', name: 'Gorgeous Luxury Lake View Suite' },
  'designer-game':  { id: '6a29dc9862094a0012dfda6f', name: 'Designer Game Suite' },
  'executive':      { id: '6a29dc944052f30019465228', name: 'Luxury Executive Living' },
  'stunning-lake':  { id: '6a29dc8f5f85640014dfe380', name: 'Stunning Lake Views' },
  'regent-skyline': { id: '6a4edd9fab1bbe001491a4e4', name: 'Regent Skyline' },
};

const LISTING_IDS = new Set(Object.values(LISTINGS).map(l => l.id));

function isAllowedListing(id) {
  return LISTING_IDS.has(id);
}

function resolveListingId(slugOrId) {
  if (!slugOrId) return null;
  if (LISTINGS[slugOrId]) return LISTINGS[slugOrId].id;
  if (LISTING_IDS.has(slugOrId)) return slugOrId;
  return null;
}

// ── Token cache ────────────────────────────────────────────────────────
let cachedToken = null;
let tokenExpiry = 0; // epoch ms
let inflight = null;  // de-dupe concurrent token fetches

function loadPersistedToken() {
  try {
    const raw = JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8'));
    if (raw && raw.token && raw.expiry && Date.now() < raw.expiry - 60_000) {
      cachedToken = raw.token;
      tokenExpiry = raw.expiry;
    }
  } catch (_) { /* no/invalid cache file — ignore */ }
}
loadPersistedToken();

function persistToken() {
  try {
    fs.mkdirSync(path.dirname(TOKEN_FILE), { recursive: true });
    fs.writeFileSync(TOKEN_FILE, JSON.stringify({ token: cachedToken, expiry: tokenExpiry }), { mode: 0o600 });
  } catch (_) { /* best-effort cache; ignore write failures */ }
}

async function getToken() {
  const id = process.env.GUESTY_CLIENT_ID;
  const secret = process.env.GUESTY_CLIENT_SECRET;
  if (!id || !secret) {
    throw new Error('Guesty credentials not configured (GUESTY_CLIENT_ID / GUESTY_CLIENT_SECRET)');
  }

  // Reuse the cached token until 60s before it expires.
  if (cachedToken && Date.now() < tokenExpiry - 60_000) {
    return cachedToken;
  }

  // Collapse concurrent refreshes into a single request.
  if (inflight) return inflight;

  inflight = (async () => {
    const res = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Accept': 'application/json' },
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        scope: SCOPE,
        client_id: id,
        client_secret: secret,
      }),
    });

    if (!res.ok) {
      // Do not surface the response body verbatim — it can echo request params.
      const e = new Error(`Guesty auth failed (${res.status})`);
      e.status = res.status;
      throw e;
    }

    const json = await res.json();
    cachedToken = json.access_token;
    tokenExpiry = Date.now() + (json.expires_in || 86400) * 1000;
    persistToken();
    return cachedToken;
  })();

  try {
    return await inflight;
  } finally {
    inflight = null;
  }
}

async function guestyFetch(pathname, { method = 'GET', body } = {}) {
  const token = await getToken();
  const res = await fetch(API_BASE + pathname, {
    method,
    headers: {
      Authorization: 'Bearer ' + token,
      Accept: 'application/json',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  const text = await res.text();
  let json;
  try { json = text ? JSON.parse(text) : {}; } catch { json = { raw: text }; }

  if (!res.ok) {
    const err = new Error('Guesty API error');
    err.status = res.status;
    err.body = json;
    throw err;
  }
  return json;
}

// ── Public operations ──────────────────────────────────────────────────

/** Live listings (cached briefly) with normalized pricing/capacity. */
let listingsCache = null;
let listingsCacheAt = 0;
async function getListings() {
  if (listingsCache && Date.now() - listingsCacheAt < 10 * 60_000) {
    return listingsCache;
  }
  const json = await guestyFetch('/listings?limit=25');
  const results = json.results || [];
  const byId = new Map(results.map(l => [l._id, l]));

  // Return in the order the site declares them, with a normalized shape.
  const out = Object.entries(LISTINGS).map(([slug, meta]) => {
    const l = byId.get(meta.id) || {};
    return {
      slug,
      id: meta.id,
      title: l.title || meta.name,
      nickname: l.nickname,
      city: l.address?.city,
      basePrice: l.prices?.basePrice,
      currency: l.prices?.currency || 'USD',
      minNights: l.terms?.minNights ?? l.defaultMinNights,
      accommodates: l.accommodates,
      bedrooms: l.bedrooms,
      bathrooms: l.bathrooms,
    };
  });
  listingsCache = out;
  listingsCacheAt = Date.now();
  return out;
}

/** Availability calendar for one listing between two dates (YYYY-MM-DD). */
async function getCalendar(listingId, from, to) {
  const days = await guestyFetch(
    `/availability-pricing/api/calendar/listings/${listingId}?startDate=${encodeURIComponent(from)}&endDate=${encodeURIComponent(to)}`
  );
  const arr = Array.isArray(days) ? days : (days.data?.days || days.data || days.results || days.days || []);
  return arr.map(d => ({
    date: d.date,
    status: d.status,                 // 'available' | 'unavailable' | 'booked' | ...
    available: d.status === 'available',
    minNights: d.minNights,
    price: d.price,
    currency: d.currency || 'USD',
    cta: !!d.cta,                     // closed to arrival
    ctd: !!d.ctd,                     // closed to departure
  }));
}

/**
 * Create a price quote by summing nightly rates from the calendar.
 * The Guesty Open API /quotes endpoint requires a higher-tier plan, so we
 * calculate pricing locally from the live calendar data instead.
 */
async function createQuote({ listingId, checkIn, checkOut, guests }) {
  const nights = countNights(checkIn, checkOut);
  if (nights < 1) throw Object.assign(new Error('Invalid date range'), { status: 400 });

  const calendar = await getCalendar(listingId, checkIn, checkOut);
  // We need exactly `nights` stay-night entries (check-out date is departure, not a stay night)
  const stayDays = calendar.slice(0, nights);

  // Verify every stay night is available
  const unavailable = stayDays.filter(d => !d.available);
  if (unavailable.length) {
    const err = new Error('Some dates are not available');
    err.status = 409;
    err.body = { unavailableDates: unavailable.map(d => d.date) };
    throw err;
  }

  // Check minimum nights
  const maxMinNights = Math.max(...stayDays.map(d => d.minNights || 1));
  if (nights < maxMinNights) {
    const err = new Error(`Minimum stay is ${maxMinNights} nights`);
    err.status = 400;
    throw err;
  }

  const accommodation = stayDays.reduce((sum, d) => sum + (d.price || 0), 0);
  const currency = stayDays[0]?.currency || 'USD';
  const perNight = nights ? Math.round(accommodation / nights) : 0;

  // Generate a local quote ID for tracking
  const quoteId = `local-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  return {
    quote: { _id: quoteId, local: true },
    summary: {
      quoteId,
      ratePlanId: null,
      currency,
      nights,
      accommodation,
      cleaningFee: 0,
      taxes: 0,
      total: accommodation,
      perNight,
      invoiceItems: [],
      expiresAt: new Date(Date.now() + 30 * 60_000).toISOString(), // 30 min
    },
  };
}

/**
 * Placeholder — instant reservations require a Guesty plan with
 * /reservations-v3 access. For now all bookings go through the
 * local request-to-book flow (captured in SQLite, host confirms in Guesty).
 */
async function createInstantReservation(/* { quoteId, ratePlanId, guest, ccToken } */) {
  const err = new Error('Instant reservations are not available — booking requests are captured for host confirmation');
  err.status = 501;
  throw err;
}

// ── Helpers ──────────────────────────────────────────────────────────────
function countNights(checkIn, checkOut) {
  const a = new Date(checkIn + 'T00:00:00Z');
  const b = new Date(checkOut + 'T00:00:00Z');
  return Math.round((b - a) / 86_400_000);
}

module.exports = {
  LISTINGS,
  isAllowedListing,
  resolveListingId,
  getListings,
  getCalendar,
  createQuote,
  createInstantReservation,
  countNights,
};

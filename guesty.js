/**
 * Guesty Open API client — with Booking Engine API (BEAPI) integration.
 *
 * Uses the OAuth2 client_credentials grant against open-api.guesty.com.
 * Credentials are read from environment variables ONLY:
 *   GUESTY_CLIENT_ID, GUESTY_CLIENT_SECRET       (Open API)
 *   GUESTY_BE_CLIENT_ID, GUESTY_BE_CLIENT_SECRET  (Booking Engine API — optional)
 *
 * When BEAPI credentials are configured, createQuote() uses the BEAPI for
 * accurate pricing that includes cleaning fees, taxes, promotions, and rate
 * plans. When they are not configured, it falls back to the local calendar-
 * based calculation.
 *
 * Credentials are never logged or returned to clients.
 */

const fs = require('fs');
const path = require('path');

// ── Booking Engine API integration (optional) ─────────────────────────
let beapi;
try {
  beapi = require('./guesty-beapi');
  if (beapi.isConfigured()) {
    console.log('  Guesty BEAPI: credentials detected — quote-based booking enabled');
  } else {
    console.log('  Guesty BEAPI: no credentials — using Open API with local quote calculation');
  }
} catch (e) {
  console.warn('  Guesty BEAPI: module not available —', e.message);
  beapi = null;
}

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
//
// Static fallback data (basePrice, cleaningFee, minNights, etc.) ensures
// the site always works — even when Guesty's API is rate-limited or down.
// These values are overridden by live API data when available.
const LISTINGS = {
  'regent-villa':   { id: '6a3874d5bcc80700147920ca', name: 'Regent Villa',                       basePrice: 485, cleaningFee: 100, minNights: 2, accommodates: 14, bedrooms: 4, bathrooms: 3.5, city: 'Plano',  state: 'Texas' },
  'cozy-designer':  { id: '6a29dcff12cbdd0015a65a7d', name: 'Cozy Designer Suite',                basePrice: 164, cleaningFee: 55,  minNights: 1, accommodates: 6,  bedrooms: 2, bathrooms: 1,   city: 'Plano',  state: 'Texas' },
  'lake-view':      { id: '6a29dcfa14fca300148799c2', name: 'Gorgeous Luxury Lake View Suite',     basePrice: 159, cleaningFee: 55,  minNights: 1, accommodates: 6,  bedrooms: 2, bathrooms: 2,   city: 'Plano',  state: 'Texas' },
  'designer-game':  { id: '6a29dc9862094a0012dfda6f', name: 'Designer Game Suite',                 basePrice: 159, cleaningFee: 55,  minNights: 1, accommodates: 6,  bedrooms: 2, bathrooms: 1,   city: 'Plano',  state: 'Texas' },
  'executive':      { id: '6a29dc944052f30019465228', name: 'Luxury Executive Living',             basePrice: 169, cleaningFee: 55,  minNights: 1, accommodates: 6,  bedrooms: 2, bathrooms: 2,   city: 'Plano',  state: 'Texas' },
  'stunning-lake':  { id: '6a29dc8f5f85640014dfe380', name: 'Stunning Lake Views',                 basePrice: 159, cleaningFee: 55,  minNights: 1, accommodates: 6,  bedrooms: 2, bathrooms: 2,   city: 'Plano',  state: 'Texas' },
  'regent-skyline': { id: '6a4edd9fab1bbe001491a4e4', name: 'Regent Skyline',                      basePrice: 155, cleaningFee: 50,  minNights: 1, accommodates: 5,  bedrooms: 1, bathrooms: 1,   city: 'Dallas', state: 'Texas' },
};

// Build static fallback listing data from LISTINGS — used when both
// API and cache are unavailable (e.g. during prolonged rate limits).
function buildStaticListings() {
  return Object.entries(LISTINGS).map(([slug, meta]) => ({
    slug,
    id: meta.id,
    title: meta.name,
    nickname: null,
    city: meta.city,
    state: meta.state,
    lat: null,
    lng: null,
    address: null,
    basePrice: meta.basePrice,
    cleaningFee: meta.cleaningFee || 0,
    currency: 'USD',
    minNights: meta.minNights || 1,
    accommodates: meta.accommodates,
    bedrooms: meta.bedrooms,
    bathrooms: meta.bathrooms,
    _static: true,  // flag so callers know this is fallback data
  }));
}

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

// ── Rate-limit circuit breaker ────────────────────────────────────────
// When the Guesty auth/API endpoint returns 429, stop retrying for a
// cooldown period. This prevents cascading failures where every incoming
// request triggers another auth attempt, extending the rate limit window.
let rateLimitedUntil = 0;          // epoch ms — don't hit Guesty before this
let rateLimitBackoffMs = 5 * 60_000;   // starts at 5 min, doubles on repeat 429s
const MAX_RATE_LIMIT_BACKOFF = 30 * 60_000; // cap at 30 minutes

function isRateLimited() {
  return Date.now() < rateLimitedUntil;
}

function enterRateLimit() {
  rateLimitedUntil = Date.now() + rateLimitBackoffMs;
  console.warn(`Guesty rate-limited — backing off for ${Math.round(rateLimitBackoffMs / 1000)}s (until ${new Date(rateLimitedUntil).toISOString()})`);
  rateLimitBackoffMs = Math.min(rateLimitBackoffMs * 2, MAX_RATE_LIMIT_BACKOFF);
}

function clearRateLimit() {
  rateLimitedUntil = 0;
  rateLimitBackoffMs = 60_000; // reset backoff on success
}

function parseTokenExpiry(value) {
  if (!value) return 0;
  if (/^\d+$/.test(String(value))) return Number(value);
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? 0 : parsed;
}

function useToken(token, expiry) {
  if (token && expiry && Date.now() < expiry - 60_000) {
    cachedToken = token;
    tokenExpiry = expiry;
    return true;
  }
  return false;
}

function loadBootstrapToken() {
  // Optional deploy-time bootstrap for hosts with ephemeral filesystems. This is
  // especially useful after a Render redeploy because Guesty's OAuth endpoint is
  // aggressively rate-limited; the access token itself still stays server-side.
  const token = process.env.GUESTY_ACCESS_TOKEN;
  const expiry = parseTokenExpiry(process.env.GUESTY_ACCESS_TOKEN_EXPIRES_AT || process.env.GUESTY_TOKEN_EXPIRES_AT);
  return useToken(token, expiry);
}

function loadPersistedToken() {
  try {
    const raw = JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8'));
    if (useToken(raw?.token, raw?.expiry)) return;
  } catch (_) { /* no/invalid cache file — ignore */ }
  loadBootstrapToken();
}
loadPersistedToken();

function persistToken() {
  try {
    fs.mkdirSync(path.dirname(TOKEN_FILE), { recursive: true });
    fs.writeFileSync(TOKEN_FILE, JSON.stringify({ token: cachedToken, expiry: tokenExpiry }), { mode: 0o600 });
  } catch (_) { /* best-effort cache; ignore write failures */ }
}

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

async function requestTokenWithBackoff(id, secret) {
  // If we're in a rate-limit cooldown, fail fast instead of hitting Guesty again.
  if (isRateLimited()) {
    const e = new Error(`Guesty rate-limited — retry after ${new Date(rateLimitedUntil).toISOString()}`);
    e.status = 429;
    throw e;
  }

  // Conservative retry: fewer attempts with longer delays to avoid extending
  // Guesty's rate-limit window. The circuit breaker stops retries on first 429.
  const delays = [0, 3_000, 10_000];
  let lastStatus = null;
  for (let attempt = 0; attempt < delays.length; attempt++) {
    if (delays[attempt]) await sleep(delays[attempt]);
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

    if (res.ok) {
      clearRateLimit(); // success — reset backoff
      return res.json();
    }
    lastStatus = res.status;

    // On 429, activate the circuit breaker and stop retrying immediately.
    if (res.status === 429) {
      enterRateLimit();
      break;
    }
    // Do not surface the response body verbatim — it can echo request params.
    if (![500, 502, 503, 504].includes(res.status)) break;
  }
  const e = new Error(`Guesty auth failed (${lastStatus})`);
  e.status = lastStatus;
  throw e;
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

  // Re-check the server-side env bootstrap before hitting Guesty's rate-limited
  // OAuth endpoint. This keeps cold deploys from failing while a valid token is
  // already available in Render env.
  if (loadBootstrapToken()) return cachedToken;

  // Collapse concurrent refreshes into a single request.
  if (inflight) return inflight;

  inflight = (async () => {
    const json = await requestTokenWithBackoff(id, secret);
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

async function guestyFetch(pathname, { method = 'GET', body, retryOnAuth = true } = {}) {
  // Fail fast if we're in a rate-limit cooldown.
  if (isRateLimited()) {
    const err = new Error(`Guesty rate-limited — retry after ${new Date(rateLimitedUntil).toISOString()}`);
    err.status = 429;
    throw err;
  }

  const token = await getToken();

  if (process.env.GUESTY_DEBUG === 'true') {
    console.log('Guesty request', method, API_BASE + pathname, body ? Object.keys(body) : 'nobody');
  }

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

  // Persisted tokens can become invalid outside their nominal expiry window.
  // Clear cache and retry once on auth failure without logging token contents.
  if ((res.status === 401 || res.status === 403) && retryOnAuth) {
    cachedToken = null;
    tokenExpiry = 0;
    try { fs.rmSync(TOKEN_FILE, { force: true }); } catch (_) {}
    return guestyFetch(pathname, { method, body, retryOnAuth: false });
  }

  // Activate the circuit breaker on 429 to prevent cascading failures.
  if (res.status === 429) {
    enterRateLimit();
    const err = new Error('Guesty rate-limited');
    err.status = 429;
    err.body = json;
    throw err;
  }

  if (!res.ok) {
    const err = new Error('Guesty API error');
    err.status = res.status;
    err.body = json;
    if (process.env.GUESTY_DEBUG === 'true') {
      console.error('Guesty API error', res.status, API_BASE + pathname, JSON.stringify(json));
    }
    throw err;
  }

  clearRateLimit(); // successful API call — reset backoff
  return json;
}

// ── In-flight request deduplication ──────────────────────────────────
// Prevents duplicate API calls when multiple requests arrive for the
// same resource simultaneously (e.g. multiple guests loading the page
// at once). Each key maps to a pending Promise; subsequent callers get
// the same Promise instead of firing a second API request.
const inflightRequests = new Map();

function deduplicatedFetch(key, fetchFn) {
  if (inflightRequests.has(key)) {
    return inflightRequests.get(key);
  }
  const promise = fetchFn().finally(() => {
    inflightRequests.delete(key);
  });
  inflightRequests.set(key, promise);
  return promise;
}

// ── Calendar cache (per-listing, 30 min TTL) ─────────────────────────
// Calendar data changes infrequently — caching it prevents redundant
// API calls from getLowestPrices, createQuote, and direct /calendar
// requests. Key = `${listingId}:${from}:${to}`.
const calendarCache = new Map();
const CALENDAR_CACHE_TTL = 5 * 60_000; // 5 minutes (was 30 min — reduced for faster sync)

function getCalendarCacheKey(listingId, from, to) {
  return `${listingId}:${from}:${to}`;
}

function getCachedCalendar(listingId, from, to) {
  const key = getCalendarCacheKey(listingId, from, to);
  const entry = calendarCache.get(key);
  if (entry && Date.now() - entry.ts < CALENDAR_CACHE_TTL) {
    return entry.data;
  }
  return null;
}

function setCachedCalendar(listingId, from, to, data) {
  const key = getCalendarCacheKey(listingId, from, to);
  calendarCache.set(key, { ts: Date.now(), data });
  // Prune stale entries periodically (keep cache bounded)
  if (calendarCache.size > 100) {
    const now = Date.now();
    for (const [k, v] of calendarCache) {
      if (now - v.ts > CALENDAR_CACHE_TTL) calendarCache.delete(k);
    }
  }
}

// ── Payment provider cache (per-listing, 60 min TTL) ─────────────────
const paymentProviderCache = new Map();
const PAYMENT_PROVIDER_CACHE_TTL = 60 * 60_000; // 60 minutes

// ── Public operations ──────────────────────────────────────────────────

/** Live listings (cached 60 min) with normalized pricing/capacity. */
let listingsCache = null;
let listingsCacheAt = 0;
const LISTINGS_CACHE_TTL = 10 * 60_000; // 10 minutes (was 60 min — reduced for faster sync)

async function getListings() {
  if (listingsCache && Date.now() - listingsCacheAt < LISTINGS_CACHE_TTL) {
    return listingsCache;
  }
  // Return stale cache when rate-limited instead of failing the request.
  if (isRateLimited() && listingsCache) {
    console.log('Guesty rate-limited — returning stale listings cache');
    return listingsCache;
  }
  // If rate-limited and NO cache at all, return static fallback data so the
  // site still shows listings with base prices instead of an error page.
  if (isRateLimited()) {
    console.log('Guesty rate-limited with no cache — returning static listings fallback');
    return buildStaticListings();
  }

  let json;
  try {
    json = await deduplicatedFetch('listings', () => guestyFetch('/listings?limit=25'));
  } catch (err) {
    // If the API call fails (auth error, rate limit, etc.), return static
    // fallback so the site never shows "Could not load listings".
    console.warn('Guesty listings fetch failed:', err.status || '', err.message);
    if (listingsCache) return listingsCache;
    console.log('No listings cache — returning static listings fallback');
    return buildStaticListings();
  }

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
      state: l.address?.state,
      lat: l.address?.lat || null,
      lng: l.address?.lng || null,
      address: l.address?.full || l.address?.street || null,
      basePrice: l.prices?.basePrice,
      cleaningFee: l.prices?.cleaningFee || 0,
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

/** Availability calendar for one listing between two dates (YYYY-MM-DD).
 *  Cached for 30 min per listing+date-range. De-duplicated so concurrent
 *  requests for the same calendar share a single API call. */
async function getCalendar(listingId, from, to) {
  // Check cache first
  const cached = getCachedCalendar(listingId, from, to);
  if (cached) return cached;

  // Return stale cache when rate-limited
  if (isRateLimited()) {
    const stale = calendarCache.get(getCalendarCacheKey(listingId, from, to));
    if (stale) {
      console.log(`Guesty rate-limited — returning stale calendar cache for ${listingId}`);
      return stale.data;
    }
    const err = new Error('Guesty rate-limited — no calendar cache available');
    err.status = 429;
    throw err;
  }

  const fetchKey = `calendar:${listingId}:${from}:${to}`;
  const days = await deduplicatedFetch(fetchKey, () =>
    guestyFetch(
      `/availability-pricing/api/calendar/listings/${listingId}?startDate=${encodeURIComponent(from)}&endDate=${encodeURIComponent(to)}`
    )
  );

  const arr = Array.isArray(days) ? days : (days.data?.days || days.data || days.results || days.days || []);
  const result = arr.map(d => ({
    date: d.date,
    status: d.status,                 // 'available' | 'unavailable' | 'booked' | ...
    available: d.status === 'available',
    minNights: d.minNights,
    price: d.price,
    currency: d.currency || 'USD',
    cta: !!d.cta,                     // closed to arrival
    ctd: !!d.ctd,                     // closed to departure
  }));

  // Cache the processed result
  setCachedCalendar(listingId, from, to, result);
  return result;
}

/**
 * Create a price quote.
 *
 * When BEAPI credentials are configured, uses the Booking Engine API's quote
 * endpoint which returns accurate pricing with cleaning fees, taxes, promotions,
 * and rate plans. Falls back to local calendar-based calculation when BEAPI is
 * not available.
 *
 * @param {Object} opts
 * @param {string} opts.listingId
 * @param {string} opts.checkIn
 * @param {string} opts.checkOut
 * @param {number} opts.guests
 * @param {string} [opts.coupons] - Comma-separated coupon codes (BEAPI only)
 */
async function createQuote({ listingId, checkIn, checkOut, guests, coupons }) {
  const nights = countNights(checkIn, checkOut);
  if (nights < 1) throw Object.assign(new Error('Invalid date range'), { status: 400 });

  // ── Try BEAPI first (gives accurate cleaning fees, taxes, promotions) ──
  if (beapi && beapi.isConfigured()) {
    try {
      const beapiQuote = await beapi.createQuote({
        listingId,
        checkIn,
        checkOut,
        guests,
        coupons,
      });
      const summary = beapi.normalizeQuoteSummary(beapiQuote);
      // Guard: if BEAPI returned 200 but the quote has no rate plans / zero
      // pricing (common when Booking Engine channel isn't configured for a
      // listing), fall through to the local calendar calculation instead of
      // returning a zero-total quote that the route handler rejects as "No
      // price available".
      if (summary.total > 0) {
        return { quote: beapiQuote, summary };
      }
      console.warn(
        'BEAPI returned a quote with total=0 (no rate plans?), falling back to local calculation'
      );
    } catch (beapiErr) {
      // Fall back to local calculation for every BEAPI failure, including 4xx.
      // Booking Engine rate plans are not configured yet, so the BEAPI returns
      // errors like "No price available for those dates" (409) and "All rate
      // plans are not applicable" (400) for stays the local calendar can price.
      // Accommodation-only pricing beats surfacing those errors to the guest.
      console.warn(
        `BEAPI quote failed (status ${beapiErr.status ?? 'n/a'}), falling back to local calculation:`,
        beapiErr.message
      );
    }
  }

  // ── Fallback: local calculation from Open API calendar ──
  let stayDays = null;
  let calendarAvailable = false;
  try {
    const calendar = await getCalendar(listingId, checkIn, checkOut);
    // We need exactly `nights` stay-night entries (check-out date is departure, not a stay night)
    stayDays = calendar.slice(0, nights);
    calendarAvailable = stayDays.length > 0;
  } catch (calErr) {
    console.warn('Calendar fetch failed for local quote, using static base price:', calErr.message);
  }

  if (calendarAvailable) {
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
  }

  // Use calendar prices when available, otherwise fall back to static base price.
  let baseAccommodation;
  let currency = 'USD';
  if (calendarAvailable) {
    baseAccommodation = stayDays.reduce((sum, d) => sum + (d.price || 0), 0);
    currency = stayDays[0]?.currency || 'USD';
  } else {
    // Static base price fallback — find the listing's base price from LISTINGS.
    const listingMeta = Object.values(LISTINGS).find(l => l.id === listingId);
    const staticBase = listingMeta?.basePrice || 0;
    if (!staticBase) {
      throw Object.assign(new Error('Could not get a price for those dates'), { status: 502 });
    }
    baseAccommodation = staticBase * nights;
    console.log(`Using static base price $${staticBase}/night × ${nights} nights = $${baseAccommodation}`);
  }

  // Pull cleaning fee from cached listing data or static LISTINGS.
  let cleaningFee = 0;
  if (listingsCache) {
    const listing = listingsCache.find(l => l.id === listingId);
    if (listing) cleaningFee = listing.cleaningFee || 0;
  }
  if (!cleaningFee) {
    // Fall back to static data
    const listingMeta = Object.values(LISTINGS).find(l => l.id === listingId);
    cleaningFee = listingMeta?.cleaningFee || 0;
  }

  // Apply 5% direct booking discount — matches the "Save 5%" badge on
  // property cards. Round to the nearest cent so the quote total is clean.
  const DIRECT_BOOKING_DISCOUNT_RATE = 0.05;
  const directBookingDiscount = Math.round(baseAccommodation * DIRECT_BOOKING_DISCOUNT_RATE * 100) / 100;
  const accommodation = baseAccommodation;  // keep original for line-item display
  const total = baseAccommodation - directBookingDiscount + cleaningFee;
  const perNight = nights ? Math.round(baseAccommodation / nights) : 0;

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
      cleaningFee,
      taxes: 0,
      directBookingDiscount,
      total,
      perNight,
      invoiceItems: [],
      expiresAt: new Date(Date.now() + 30 * 60_000).toISOString(), // 30 min
      source: 'local',
    },
  };
}

/**
 * Get the payment provider connected to a listing (cached 60 min).
 * Guesty Pay needs the Guesty payment provider ID, not a Stripe publishable
 * key/account ID. The frontend passes this provider ID into Guesty's PCI-safe
 * tokenization iframe.
 */
async function getPaymentProvider(listingId) {
  // Check cache first — payment provider config changes very rarely
  const cached = paymentProviderCache.get(listingId);
  if (cached && Date.now() - cached.ts < PAYMENT_PROVIDER_CACHE_TTL) {
    return cached.data;
  }

  const result = await deduplicatedFetch(`payment-provider:${listingId}`, () =>
    guestyFetch(`/payment-providers/provider-by-listing?listingId=${encodeURIComponent(listingId)}&includeInactiveProviders=false`)
  );

  paymentProviderCache.set(listingId, { ts: Date.now(), data: result });
  return result;
}

function normalizePaymentProvider(provider) {
  const p = Array.isArray(provider) ? provider[0] : (provider?.provider || provider);
  // The provider-by-listing response contains both `_id` and `paymentProviderId`.
  // Guesty's tokenization docs explicitly say `paymentProviderId` is the value
  // to pass into guestyTokenization.render/submit, so prefer it over `_id`.
  const paymentProviderId =
    p?.paymentProviderId ||
    p?.providerId ||
    p?.paymentProvider?.paymentProviderId ||
    p?.paymentProvider?.id ||
    p?.paymentProvider?._id ||
    p?.id ||
    p?._id ||
    null;

  return {
    paymentProviderId,
    provider: p?.paymentProcessorName || p?.provider || p?.providerType || p?.method || 'GuestyPay',
    method: p?.method || p?.paymentProcessorKey || p?.providerType || null,
    status: p?.status || (p?.active === false ? 'INACTIVE' : 'ACTIVE'),
    active: p?.active !== false && p?.status !== 'INACTIVE',
  };
}

/**
 * Create a guest profile in Guesty.
 * Required for attaching payment methods and creating reservations.
 */
async function createGuest({ firstName, lastName, email, phone }) {
  if (!firstName || !lastName || !email) {
    throw Object.assign(new Error('First name, last name, and email are required'), { status: 400 });
  }
  return guestyFetch('/guests-crud', {
    method: 'POST',
    body: {
      firstName,
      lastName,
      email,
      phone: phone || '',
    },
  });
}

/**
 * Attach a Guesty Pay tokenized payment method to an existing guest.
 * `token` is the `_id` returned by Guesty's tokenization SDK/API. Raw card
 * data never touches this server.
 */
async function attachPaymentMethod(guestId, { token, paymentProviderId, reservationId, reuse = true, stripeCardToken, skipSetupIntent }) {
  if (!guestId || (!token && !stripeCardToken) || !paymentProviderId) {
    throw Object.assign(new Error('Guest ID, payment provider ID, and payment token are required'), { status: 400 });
  }

  const body = stripeCardToken
    ? {
        stripeCardToken,
        paymentProviderId,
        ...(reservationId && { reservationId }),
        ...(skipSetupIntent !== undefined && { skipSetupIntent: !!skipSetupIntent }),
        reuse: !!reuse,
      }
    : {
        _id: token,
        paymentProviderId,
        ...(reservationId && { reservationId }),
        reuse: !!reuse,
      };

  return guestyFetch(`/guests/${encodeURIComponent(guestId)}/payment-methods`, {
    method: 'POST',
    body,
  });
}

/**
 * Create a reservation in Guesty. For Guesty Pay we normally create a short
 * `reserved` reservation first, tokenize against that reservation ID, attach
 * the payment method, then confirm the reservation.
 */
async function createReservation({
  listingId,
  checkIn,
  checkOut,
  guests,
  guestId,
  guest,
  paymentMethodId,
  source = 'manual',
  status = 'confirmed',
  reservedUntil,
  money,
}) {
  if (!listingId || !checkIn || !checkOut || (!guestId && !guest)) {
    throw Object.assign(new Error('Missing required reservation fields'), { status: 400 });
  }

  const nights = countNights(checkIn, checkOut);
  if (nights < 1) throw Object.assign(new Error('Invalid date range'), { status: 400 });

  const body = {
    listingId,
    checkInDateLocalized: checkIn,
    checkOutDateLocalized: checkOut,
    status,
    source: source || 'manual',
    ...(guestId ? { guestId } : { guest }),
    guestsCount: guests || 1,
    numberOfGuests: {
      numberOfAdults: guests || 1,
      numberOfChildren: 0,
      numberOfInfants: 0,
      numberOfPets: 0,
    },
    ignoreCalendar: false,
    ignoreTerms: false,
    ignoreBlocks: false,
    ...(status === 'reserved' && reservedUntil !== undefined && { reservedUntil }),
    ...(money?.fareAccommodation !== undefined && { accommodationFare: money.fareAccommodation }),
    ...(paymentMethodId && { paymentMethodId }),
  };

  return guestyFetch('/reservations-v3', { method: 'POST', body });
}

async function updateReservationStatus(reservationId, { status, reservedUntil }) {
  if (!reservationId) {
    throw Object.assign(new Error('Reservation ID is required'), { status: 400 });
  }
  if (!status) {
    throw Object.assign(new Error('Reservation status is required'), { status: 400 });
  }
  return guestyFetch(`/reservations-v3/${encodeURIComponent(reservationId)}/status`, {
    method: 'PUT',
    body: {
      status,
      ...(reservedUntil !== undefined && { reservedUntil }),
    },
  });
}

async function updateReservation(reservationId, body, options = {}) {
  const { retryCount = 0 } = options;
  if (!reservationId) {
    throw Object.assign(new Error('Reservation ID is required'), { status: 400 });
  }

  const encoded = encodeURIComponent(String(reservationId));

  try {
    return await guestyFetch(`/reservations-v3/${encoded}`, {
      method: 'PUT',
      body,
    });
  } catch (err) {
    if (err?.status === 404) {
      try {
        return await guestyFetch(`/reservations/${encoded}`, {
          method: 'PUT',
          body,
        });
      } catch (fallbackErr) {
        if (fallbackErr?.status === 404 && retryCount < 3) {
          const backoffMs = 300 * (retryCount + 1);
          await sleep(backoffMs);
          return updateReservation(reservationId, body, { retryCount: retryCount + 1 });
        }
        throw fallbackErr;
      }
    }
    throw err;
  }
}

// ── Fetch reservations with financial data ─────────────────────────────
/**
 * Fetch reservations from Guesty with financial fields for revenue dashboard.
 * Supports filtering by date range, status, and listing.
 * @param {Object} opts
 * @param {string} [opts.from] - checkIn date filter (YYYY-MM-DD)
 * @param {string} [opts.to]   - checkOut date filter (YYYY-MM-DD)
 * @param {string} [opts.status] - reservation status filter
 * @param {string} [opts.listingId] - filter by listing
 * @param {number} [opts.limit] - max results (default 100)
 * @param {number} [opts.skip]  - offset for pagination
 */
async function getReservationById(reservationId) {
  if (!reservationId) {
    throw Object.assign(new Error('Reservation ID is required'), { status: 400 });
  }

  const encoded = encodeURIComponent(String(reservationId));
  let primary;
  try {
    primary = await guestyFetch(`/reservations-v3/${encoded}`);
  } catch (err) {
    if (err?.status !== 404) throw err;
    primary = await guestyFetch(`/reservations/${encoded}`);
  }

  // Older/mixed Guesty tenants sometimes wrap payload under `reservation` key.
  return primary?.reservation || primary;
}

async function getReservations(opts = {}) {
  const fields = [
    '_id', 'confirmationCode', 'status',
    'checkInDateLocalized', 'checkOutDateLocalized',
    'nightsCount', 'guestsCount', 'source',
    'listing._id', 'listing.title', 'listing.nickname',
    'guest.firstName', 'guest.lastName', 'guest.email', 'guest.phone',
    'money.hostPayout', 'money.totalPaid', 'money.balanceDue',
    'money.fareAccommodation', 'money.currency',
    'money.invoiceItems', 'money.totalTaxes',
    'money.payments.status', 'money.payments.amount', 'money.payments.paidAt',
    'createdAt', 'confirmedAt', 'lastUpdatedAt',
  ].join(' ');

  const params = new URLSearchParams();
  params.set('fields', fields);
  params.set('limit', String(opts.limit || 100));
  params.set('skip', String(opts.skip || 0));
  params.set('sort', '-checkInDateLocalized');

  // Build filters array
  const filters = [];
  if (opts.status) {
    filters.push({ operator: '$eq', field: 'status', value: opts.status });
  }
  if (opts.from && opts.to) {
    filters.push({
      operator: '$between',
      field: 'checkInDateLocalized',
      from: opts.from,
      to: opts.to,
    });
  }
  if (opts.listingId) {
    filters.push({ operator: '$eq', field: 'listingId', value: opts.listingId });
  }
  if (filters.length) {
    params.set('filters', JSON.stringify(filters));
  }

  const result = await guestyFetch(`/reservations?${params.toString()}`);
  // API returns { results: [...], count, limit, skip }
  return {
    reservations: result.results || [],
    count: result.count || 0,
    limit: result.limit || opts.limit || 100,
    skip: result.skip || 0,
  };
}

// ── Lowest available price per listing (cached 2 hours) ──────────────────
let lowestPricesCache = null;
let lowestPricesCacheAt = 0;
const LOWEST_PRICES_TTL = 10 * 60_000; // 10 minutes (was 120 min — reduced for faster sync)

/**
 * Fetch the lowest available nightly rate for each listing by scanning
 * the next 90 days of calendar data. Returns a map of slug → { lowestPrice, currency }.
 *
 * Calendar fetches are SERIALIZED with 2s delays between them to avoid
 * bursting the 120 req/min rate limit. Each individual calendar call is
 * also de-duplicated and cached for 30 min.
 */
async function getLowestPrices() {
  if (lowestPricesCache && Date.now() - lowestPricesCacheAt < LOWEST_PRICES_TTL) {
    return lowestPricesCache;
  }

  // If we're rate-limited, return stale cache or base prices instead of
  // triggering 7 API calls that will all fail with 429.
  if (isRateLimited()) {
    if (lowestPricesCache) {
      console.log('Guesty rate-limited — returning stale lowest prices cache');
      return lowestPricesCache;
    }
    // No cache at all — return base prices from static listing data as fallback.
    // This ensures property cards always show a "From $X" price instead of blank.
    console.log('Guesty rate-limited with no cache — returning static base prices');
    const fallback = {};
    Object.entries(LISTINGS).forEach(([slug, meta]) => {
      fallback[slug] = { lowestPrice: meta.basePrice || null, currency: 'USD' };
    });
    return fallback;
  }

  // Use deduplication so concurrent calls share the same fetch cycle
  return deduplicatedFetch('lowest-prices', async () => {
    const today = new Date();
    const from = today.toISOString().slice(0, 10);
    const future = new Date(today);
    future.setDate(future.getDate() + 90);
    const to = future.toISOString().slice(0, 10);

    const entries = Object.entries(LISTINGS);
    const results = {};
    let successCount = 0;

    // Serialize calendar fetches with 2s delays to avoid rate-limit bursts.
    // Each getCalendar call is itself cached (30 min) and de-duplicated, so
    // if the calendar was recently fetched for a listing, no API call is made.
    for (let i = 0; i < entries.length; i++) {
      const [slug, meta] = entries[i];
      // Add a 2s delay between API calls (skip the first one)
      if (i > 0 && !getCachedCalendar(meta.id, from, to)) {
        await sleep(2_000);
      }
      try {
        const days = await getCalendar(meta.id, from, to);
        const available = days.filter(d => d.available && d.price > 0);
        if (available.length > 0) {
          const lowest = Math.min(...available.map(d => d.price));
          results[slug] = { lowestPrice: lowest, currency: available[0].currency || 'USD' };
        } else {
          results[slug] = { lowestPrice: null, currency: 'USD' };
        }
        successCount++;
      } catch (err) {
        console.warn(`Lowest price fetch failed for ${slug}:`, err.message);
        // If rate-limited mid-batch, stop fetching remaining listings
        if (err.status === 429 || isRateLimited()) {
          console.warn('Rate-limited mid-batch — stopping remaining lowest-price fetches');
          break;
        }
      }
    }

    // Only update cache if we got at least some results.
    if (successCount > 0) {
      lowestPricesCache = results;
      lowestPricesCacheAt = Date.now();
    } else if (lowestPricesCache) {
      console.warn('All lowest-price fetches failed — keeping stale cache');
      return lowestPricesCache;
    }

    return results;
  });
}

// ── Helpers ──────────────────────────────────────────────────────────────
function countNights(checkIn, checkOut) {
  const a = new Date(checkIn + 'T00:00:00Z');
  const b = new Date(checkOut + 'T00:00:00Z');
  return Math.round((b - a) / 86_400_000);
}

// ── BEAPI-specific pass-through functions ──────────────────────────────
// These are only available when BEAPI credentials are configured. The server
// routes check beapiAvailable() before calling them.

function beapiAvailable() {
  return !!(beapi && beapi.isConfigured());
}

async function beapiGetQuote(quoteId) {
  if (!beapi || !beapi.isConfigured()) throw new Error('BEAPI not configured');
  return beapi.getQuote(quoteId);
}

async function beapiCreateInstantReservation(quoteId, opts) {
  if (!beapi || !beapi.isConfigured()) throw new Error('BEAPI not configured');
  return beapi.createInstantReservation(quoteId, opts);
}

async function beapiCreateInquiryReservation(quoteId, opts) {
  if (!beapi || !beapi.isConfigured()) throw new Error('BEAPI not configured');
  return beapi.createInquiryReservation(quoteId, opts);
}

async function beapiUpdateQuoteCoupons(quoteId, coupons) {
  if (!beapi || !beapi.isConfigured()) throw new Error('BEAPI not configured');
  return beapi.updateQuoteCoupons(quoteId, coupons);
}

// ── Background pre-warm with conservative retry ─────────────────────────
// Populate listings + prices cache on startup (non-blocking, staggered).
// ONLY attempts API calls if a valid (non-expired) token is already available
// (from env vars or persisted file). If no valid token exists, skips pre-warm
// entirely and serves static data — this avoids hammering Guesty's rate-limited
// OAuth endpoint on every cold start / redeploy.
//
// If the API is rate-limited despite having a valid token, retries with long
// exponential backoff (5m, 15m, 30m cap) up to 3 times. The delays are
// intentionally long to let Guesty's rate limit window fully expire.
let startupRetryCount = 0;
const STARTUP_MAX_RETRIES = 3;

async function doStartupPrewarm(isRetry = false) {
  // Only attempt pre-warm if we have a valid cached token.
  // If the token is expired or missing, don't hit OAuth — serve static data
  // until a user request naturally triggers a token refresh.
  if (!cachedToken || Date.now() >= tokenExpiry - 60_000) {
    console.log('Startup: no valid token available — serving static data (token refresh will happen on first user request)');
    return;
  }

  try {
    const listings = await getListings();
    const isStatic = listings[0]?._static;
    console.log(`${isRetry ? `Startup retry ${startupRetryCount}` : 'Startup'}: cached ${listings.length} listings (${isStatic ? 'static fallback' : 'live API'})`);

    // If we got static data, the API is still rate-limited — schedule retry
    if (isStatic) {
      scheduleStartupRetry();
      return;
    }

    // Live data — fetch lowest prices too (stagger to avoid burst)
    await sleep(10_000);
    const prices = await getLowestPrices();
    const count = Object.values(prices).filter(p => p.lowestPrice !== null).length;
    console.log(`${isRetry ? `Startup retry ${startupRetryCount}` : 'Startup'}: cached lowest prices for ${count} listings`);
  } catch (err) {
    console.warn(`${isRetry ? `Startup retry ${startupRetryCount}` : 'Startup pre-warm'} failed:`, err.message);
    scheduleStartupRetry();
  }
}

function scheduleStartupRetry() {
  startupRetryCount++;
  if (startupRetryCount > STARTUP_MAX_RETRIES) {
    console.warn(`Startup retry: giving up after ${STARTUP_MAX_RETRIES} attempts — serving static data until a user request triggers recovery`);
    return;
  }
  // Long delays: 5 min, 15 min, 30 min — gives Guesty's rate limit time to fully reset
  const delay = Math.min(5 * 60_000 * Math.pow(3, startupRetryCount - 1), 30 * 60_000);
  console.log(`Startup retry: scheduling attempt ${startupRetryCount}/${STARTUP_MAX_RETRIES} in ${Math.round(delay / 60_000)}m`);
  setTimeout(() => {
    // Reset circuit breaker before retry — the Guesty-side rate limit may have cleared
    clearRateLimit();
    doStartupPrewarm(true);
  }, delay);
}

// Delay startup pre-warm by 10s to let the server fully boot and
// give the token loading (env vars / persisted file) time to settle.
setTimeout(() => doStartupPrewarm(false), 10_000);

/**
 * Clear all caches so the next request fetches fresh data from Guesty.
 * Useful when the property manager changes prices or availability in
 * the Guesty dashboard and wants the website to reflect it immediately.
 */
function clearAllCaches() {
  calendarCache.clear();
  listingsCache = null;
  listingsCacheAt = 0;
  lowestPricesCache = null;
  lowestPricesCacheAt = 0;
  paymentProviderCache.clear();
  console.log('All Guesty caches cleared');
}

module.exports = {
  LISTINGS,
  isAllowedListing,
  resolveListingId,
  getListings,
  getCalendar,
  getLowestPrices,
  getToken,
  createQuote,
  getPaymentProvider,
  normalizePaymentProvider,
  createGuest,
  attachPaymentMethod,
  createReservation,
  updateReservationStatus,
  updateReservation,
  getReservationById,
  getReservations,
  countNights,
  isRateLimited,
  clearAllCaches,
  // BEAPI extensions
  beapiAvailable,
  beapiGetQuote,
  beapiCreateInstantReservation,
  beapiCreateInquiryReservation,
  beapiUpdateQuoteCoupons,
};

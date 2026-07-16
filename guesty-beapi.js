/**
 * Guesty Booking Engine API (BEAPI) client.
 *
 * Separate from the Open API client — the BEAPI uses its own OAuth2
 * credentials and token endpoint. It provides proper quote-based booking
 * with full price breakdowns (cleaning fees, taxes, promotions, rate plans).
 *
 * Credentials (read from environment variables ONLY):
 *   GUESTY_BE_CLIENT_ID, GUESTY_BE_CLIENT_SECRET
 *
 * If these are not set, all functions throw so the caller can fall back
 * to the Open API.
 */

const fs = require('fs');
const path = require('path');

const BE_TOKEN_URL = 'https://booking.guesty.com/oauth2/token';
const BE_API_BASE  = 'https://booking.guesty.com/api';
const BE_SCOPE     = 'booking_engine:api';

// Persist BEAPI token separately from Open API token.
const BE_TOKEN_FILE = path.join(__dirname, 'db', 'guesty-be-token.json');

// ── Token cache ────────────────────────────────────────────────────────
let cachedToken = null;
let tokenExpiry = 0;
let inflight = null;

function isConfigured() {
  return !!(process.env.GUESTY_BE_CLIENT_ID && process.env.GUESTY_BE_CLIENT_SECRET);
}

function loadPersistedToken() {
  try {
    const raw = JSON.parse(fs.readFileSync(BE_TOKEN_FILE, 'utf8'));
    if (raw?.token && raw?.expiry && Date.now() < raw.expiry - 60_000) {
      cachedToken = raw.token;
      tokenExpiry = raw.expiry;
    }
  } catch (_) { /* no/invalid cache file — ignore */ }
}
// Attempt to load a persisted token on startup.
loadPersistedToken();

function persistToken() {
  try {
    fs.mkdirSync(path.dirname(BE_TOKEN_FILE), { recursive: true });
    fs.writeFileSync(BE_TOKEN_FILE, JSON.stringify({ token: cachedToken, expiry: tokenExpiry }), { mode: 0o600 });
  } catch (_) { /* best-effort */ }
}

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

async function requestTokenWithBackoff(clientId, clientSecret) {
  const delays = [0, 2_000, 5_000, 10_000];
  let lastStatus = null;
  for (let attempt = 0; attempt < delays.length; attempt++) {
    if (delays[attempt]) await sleep(delays[attempt]);
    const res = await fetch(BE_TOKEN_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Accept': 'application/json',
        'Cache-Control': 'no-cache',
      },
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        scope: BE_SCOPE,
        client_id: clientId,
        client_secret: clientSecret,
      }),
    });
    if (res.ok) return res.json();
    lastStatus = res.status;
    if (![429, 500, 502, 503, 504].includes(res.status)) break;
  }
  const e = new Error(`BEAPI auth failed (${lastStatus})`);
  e.status = lastStatus;
  throw e;
}

async function getToken() {
  if (!isConfigured()) {
    throw new Error('BEAPI credentials not configured (GUESTY_BE_CLIENT_ID / GUESTY_BE_CLIENT_SECRET)');
  }
  if (cachedToken && Date.now() < tokenExpiry - 60_000) {
    return cachedToken;
  }
  if (inflight) return inflight;

  inflight = (async () => {
    const json = await requestTokenWithBackoff(
      process.env.GUESTY_BE_CLIENT_ID,
      process.env.GUESTY_BE_CLIENT_SECRET,
    );
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

/**
 * Generic fetch wrapper for the Booking Engine API.
 */
async function beapiFetch(pathname, { method = 'GET', body, query, retryOnAuth = true } = {}) {
  const token = await getToken();
  let url = BE_API_BASE + pathname;
  if (query) {
    const qs = new URLSearchParams(query).toString();
    if (qs) url += (url.includes('?') ? '&' : '?') + qs;
  }

  const res = await fetch(url, {
    method,
    headers: {
      Authorization: 'Bearer ' + token,
      Accept: 'application/json; charset=utf-8',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  const text = await res.text();
  let json;
  try { json = text ? JSON.parse(text) : {}; } catch { json = { raw: text }; }

  // Retry once on auth failure.
  if ((res.status === 401 || res.status === 403) && retryOnAuth) {
    cachedToken = null;
    tokenExpiry = 0;
    try { fs.rmSync(BE_TOKEN_FILE, { force: true }); } catch (_) {}
    return beapiFetch(pathname, { method, body, query, retryOnAuth: false });
  }

  if (!res.ok) {
    const err = new Error(json?.error?.message || json?.message || `BEAPI error ${res.status}`);
    err.status = res.status;
    err.body = json;
    throw err;
  }
  return json;
}

// ── Public operations ──────────────────────────────────────────────────

/**
 * Get all listings connected to this Booking Engine API instance.
 * Supports optional availability filtering via checkIn/checkOut.
 */
async function getListings({ checkIn, checkOut, guests, limit } = {}) {
  const query = {};
  if (checkIn) query.checkIn = checkIn;
  if (checkOut) query.checkOut = checkOut;
  if (guests) query.minOccupancy = guests;
  if (limit) query.limit = limit;
  return beapiFetch('/listings', { query });
}

/**
 * Get the calendar for a listing. BEAPI path mirrors the Open API pattern.
 * Returns day-by-day availability and pricing.
 */
async function getCalendar(listingId, from, to) {
  const query = {};
  if (from) query.startDate = from;
  if (to) query.endDate = to;
  return beapiFetch(`/listings/${encodeURIComponent(listingId)}/calendar`, { query });
}

/**
 * Create a reservation quote. This is the main improvement over the Open API —
 * it returns full pricing with cleaning fees, taxes, promotions, and rate plans.
 *
 * @param {Object} opts
 * @param {string} opts.listingId
 * @param {string} opts.checkIn   - YYYY-MM-DD
 * @param {string} opts.checkOut  - YYYY-MM-DD
 * @param {number} opts.guests
 * @param {string} [opts.coupons] - Comma-separated coupon codes
 * @param {Object} [opts.guest]   - { guestId, firstName, lastName, phone, email }
 * @returns {Object} Quote with rate plans, pricing breakdown
 */
async function createQuote({ listingId, checkIn, checkOut, guests, coupons, guest }) {
  const body = {
    listingId,
    checkInDateLocalized: checkIn,
    checkOutDateLocalized: checkOut,
    guestsCount: guests || 1,
  };
  if (coupons) body.coupons = coupons;
  if (guest) body.guest = guest;

  return beapiFetch('/reservations/quotes', { method: 'POST', body });
}

/**
 * Retrieve an existing quote by ID.
 */
async function getQuote(quoteId) {
  return beapiFetch(`/reservations/quotes/${encodeURIComponent(quoteId)}`);
}

/**
 * Update coupons on an existing quote.
 */
async function updateQuoteCoupons(quoteId, coupons) {
  return beapiFetch(`/reservations/quotes/${encodeURIComponent(quoteId)}/coupons`, {
    method: 'PUT',
    body: { coupons },
  });
}

/**
 * Create an instant reservation from a quote (confirmed immediately).
 * Requires a payment token (ccToken).
 *
 * @param {string} quoteId
 * @param {Object} opts
 * @param {string} opts.ratePlanId - From the quote's rate plans
 * @param {string} opts.ccToken    - Stripe pm_ token or GuestyPay token
 * @param {Object} opts.guest      - { firstName, lastName, phone, email }
 * @param {Object} [opts.policy]   - Cancellation policy acceptance
 */
async function createInstantReservation(quoteId, { ratePlanId, ccToken, guest, policy }) {
  const body = { ratePlanId };
  if (ccToken) body.ccToken = ccToken;
  if (guest) body.guest = guest;
  if (policy) body.policy = policy;
  return beapiFetch(`/reservations/quotes/${encodeURIComponent(quoteId)}/instant`, {
    method: 'POST',
    body,
  });
}

/**
 * Create an inquiry/request-to-book reservation from a quote.
 * No payment token needed.
 *
 * @param {string} quoteId
 * @param {Object} opts
 * @param {string} opts.ratePlanId
 * @param {Object} opts.guest
 * @param {Object} [opts.policy]
 */
async function createInquiryReservation(quoteId, { ratePlanId, guest, policy }) {
  const body = { ratePlanId };
  if (guest) body.guest = guest;
  if (policy) body.policy = policy;
  return beapiFetch(`/reservations/quotes/${encodeURIComponent(quoteId)}/inquiry`, {
    method: 'POST',
    body,
  });
}

/**
 * Get the payment provider for a listing.
 */
async function getPaymentProvider(listingId) {
  return beapiFetch(`/listings/${encodeURIComponent(listingId)}/payment-provider`);
}

/**
 * Retrieve reservation details (quote-based reservations).
 */
async function getReservation(reservationId) {
  return beapiFetch(`/reservations/${encodeURIComponent(reservationId)}/details`);
}

/**
 * Retrieve the payout schedule for a listing stay.
 */
async function getPayoutSchedule({ listingId, checkIn, checkOut, total, bookingType }) {
  return beapiFetch('/reservations/payouts/list', {
    query: {
      listingId,
      checkIn,
      checkOut,
      total,
      bookingType: bookingType || 'INQUIRY',
    },
  });
}

/**
 * Normalize a BEAPI quote response into the summary shape the frontend expects.
 * The BEAPI quote has a `rates.ratePlans[]` array; we pick the first (default)
 * rate plan and extract its money breakdown.
 */
function normalizeQuoteSummary(beapiQuote) {
  const quoteId = beapiQuote._id;
  const ratePlans = beapiQuote.rates?.ratePlans || [];
  const defaultPlan = ratePlans[0] || {};
  const money = defaultPlan.money || {};
  const days = defaultPlan.days || [];
  const nights = days.length;

  const accommodation = money.fareAccommodation || 0;
  const cleaningFee = money.fareCleaning || 0;
  const totalFees = money.totalFees || 0;
  const totalTaxes = money.totalTaxes || 0;
  const subTotal = money.subTotalPrice || 0;
  const hostPayout = money.hostPayout || 0;
  const currency = money.currency || days[0]?.currency || 'USD';
  const invoiceItems = money.invoiceItems || [];
  const perNight = nights > 0 ? Math.round(accommodation / nights) : 0;

  // Total = subTotal if present, otherwise sum components
  const total = subTotal || (accommodation + cleaningFee + totalFees + totalTaxes);

  // Extract promotion/coupon adjustments
  const promotions = beapiQuote.promotions || null;
  const coupons = beapiQuote.coupons || [];

  // Calculate promotion/coupon discount total
  let promotionDiscount = 0;
  if (promotions?.adjustment) promotionDiscount += Math.abs(promotions.adjustment);
  coupons.forEach(c => { if (c.adjustment) promotionDiscount += Math.abs(c.adjustment); });

  return {
    quoteId,
    ratePlanId: defaultPlan._id || null,
    ratePlanName: defaultPlan.name || 'Standard',
    currency,
    nights,
    accommodation,
    cleaningFee,
    totalFees,
    taxes: totalTaxes,
    total,
    perNight,
    hostPayout,
    invoiceItems,
    promotions,
    coupons,
    promotionDiscount,
    // All rate plans (for multi-rate-plan support)
    ratePlans: ratePlans.map(rp => ({
      _id: rp._id,
      name: rp.name,
      type: rp.type,
      money: rp.money,
      days: rp.days,
      mealPlans: rp.mealPlans,
      cancellationPolicy: rp.cancellationPolicy,
    })),
    guestId: beapiQuote.guestId || null,
    expiresAt: beapiQuote.expiresAt || new Date(Date.now() + 24 * 60 * 60_000).toISOString(),
    source: 'beapi',
  };
}

module.exports = {
  isConfigured,
  getToken,
  beapiFetch,
  getListings,
  getCalendar,
  createQuote,
  getQuote,
  updateQuoteCoupons,
  createInstantReservation,
  createInquiryReservation,
  getPaymentProvider,
  getReservation,
  getPayoutSchedule,
  normalizeQuoteSummary,
};

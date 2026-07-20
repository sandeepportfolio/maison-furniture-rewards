const express = require('express');
const multer = require('multer');
const path = require('path');
const crypto = require('crypto');
const fs = require('fs');
const Database = require('better-sqlite3');

// ── Load .env locally (Render sets these in the dashboard) ──
// Minimal loader so we don't add a dependency. Existing env vars win, so
// Render's dashboard values always take precedence over any committed file.
(function loadDotEnv() {
  try {
    const envPath = path.join(__dirname, '.env');
    if (!fs.existsSync(envPath)) return;
    for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (m && process.env[m[1]] === undefined) {
        process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
      }
    }
  } catch (_) { /* ignore */ }
})();

const guesty = require('./guesty');

const app = express();
const PORT = process.env.PORT || 3456;
// Ensure directories
['db', 'uploads'].forEach(d => { if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); });

// Database
const db = new Database('./db/reviews.db');
db.pragma('journal_mode = WAL');
db.exec(`
  CREATE TABLE IF NOT EXISTS submissions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT DEFAULT '',
    email TEXT NOT NULL,
    platform TEXT DEFAULT 'google',
    proof_filename TEXT,
    status TEXT DEFAULT 'pending' CHECK(status IN ('pending','approved','sent','rejected')),
    notes TEXT DEFAULT '',
    created_at TEXT DEFAULT (datetime('now')),
    processed_at TEXT
  )
`);

// Booking requests captured from the Guesty-powered booking flow.
db.exec(`
  CREATE TABLE IF NOT EXISTS booking_requests (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    listing_id TEXT NOT NULL,
    listing_name TEXT DEFAULT '',
    guest_name TEXT DEFAULT '',
    guest_email TEXT NOT NULL,
    guest_phone TEXT DEFAULT '',
    check_in TEXT NOT NULL,
    check_out TEXT NOT NULL,
    guests INTEGER DEFAULT 1,
    nights INTEGER DEFAULT 0,
    total REAL,
    currency TEXT DEFAULT 'USD',
    quote_id TEXT,
    guesty_reservation_id TEXT,
    status TEXT DEFAULT 'requested' CHECK(status IN ('requested','confirmed','failed','cancelled')),
    message TEXT DEFAULT '',
    created_at TEXT DEFAULT (datetime('now'))
  )
`);

// Messages / contact form submissions.
db.exec(`
  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT DEFAULT '',
    email TEXT NOT NULL,
    phone TEXT DEFAULT '',
    property TEXT DEFAULT '',
    message TEXT NOT NULL,
    status TEXT DEFAULT 'unread' CHECK(status IN ('unread','read','replied','archived')),
    reply TEXT DEFAULT '',
    created_at TEXT DEFAULT (datetime('now')),
    replied_at TEXT
  )
`);

// Migration: add subject column if not already present.
try { db.exec("ALTER TABLE messages ADD COLUMN subject TEXT DEFAULT ''"); } catch (e) { /* column already exists */ }

// ── Admin sessions ──
db.exec(`
  CREATE TABLE IF NOT EXISTS admin_sessions (
    token TEXT PRIMARY KEY,
    username TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now')),
    expires_at TEXT NOT NULL
  )
`);

// ── Reviews ──
db.exec(`
  CREATE TABLE IF NOT EXISTS reviews (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    guest_name TEXT NOT NULL,
    guest_email TEXT DEFAULT '',
    property_slug TEXT DEFAULT '',
    rating INTEGER DEFAULT 5 CHECK(rating BETWEEN 1 AND 5),
    review_text TEXT DEFAULT '',
    photo_path TEXT DEFAULT '',
    gift_card_sent INTEGER DEFAULT 0,
    gift_card_amount REAL DEFAULT 0,
    gift_card_type TEXT DEFAULT '',
    gift_card_date TEXT DEFAULT '',
    created_at TEXT DEFAULT (datetime('now'))
  )
`);

// ── Price overrides ──
db.exec(`
  CREATE TABLE IF NOT EXISTS price_overrides (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    property_slug TEXT NOT NULL,
    override_price REAL NOT NULL,
    start_date TEXT NOT NULL,
    end_date TEXT NOT NULL,
    label TEXT DEFAULT '',
    created_at TEXT DEFAULT (datetime('now'))
  )
`);

// ── Property display overrides ──
db.exec(`
  CREATE TABLE IF NOT EXISTS property_overrides (
    property_slug TEXT PRIMARY KEY,
    display_name TEXT DEFAULT '',
    description TEXT DEFAULT '',
    tagline TEXT DEFAULT '',
    featured_amenities TEXT DEFAULT '',
    category_badge TEXT DEFAULT '',
    sort_order INTEGER DEFAULT 0,
    visible INTEGER DEFAULT 1,
    updated_at TEXT DEFAULT (datetime('now'))
  )
`);

// ── Site settings (key-value) ──
db.exec(`
  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT DEFAULT ''
  )
`);

// Seed default settings if empty
const seedSettings = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
seedSettings.run('contact_email', '');
seedSettings.run('contact_phone', '');
seedSettings.run('maintenance_mode', 'false');
seedSettings.run('announcement_banner', '');
seedSettings.run('hero_headline', '');
seedSettings.run('hero_subheadline', '');
seedSettings.run('footer_text', '');
seedSettings.run('social_instagram', '');
seedSettings.run('social_facebook', '');
seedSettings.run('social_tiktok', '');
seedSettings.run('booking_cta_text', '');
seedSettings.run('min_nights_override', '');
seedSettings.run('checkout_message', '');

// Multer
const storage = multer.diskStorage({
  destination: './uploads/',
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, `proof-${Date.now()}-${crypto.randomBytes(4).toString('hex')}${ext}`);
  }
});
const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ok = ['.jpg','.jpeg','.png','.gif','.webp','.heic'].includes(
      path.extname(file.originalname).toLowerCase()
    );
    cb(null, ok);
  }
});

app.use(express.json());
app.use(express.static('public'));
app.use('/uploads', express.static('uploads'));

// ── Admin Authentication ──
const ADMIN_USER = process.env.ADMIN_USER || 'admin';
const ADMIN_PASS = process.env.ADMIN_PASS || 'regent2024';
const SESSION_DURATION_HOURS = 24;

function generateToken() {
  return crypto.randomBytes(32).toString('hex');
}

function createAdminSession(username) {
  const token = generateToken();
  const expires = new Date(Date.now() + SESSION_DURATION_HOURS * 3600000).toISOString();
  // Clean expired sessions
  db.prepare("DELETE FROM admin_sessions WHERE expires_at < datetime('now')").run();
  db.prepare('INSERT INTO admin_sessions (token, username, expires_at) VALUES (?, ?, ?)').run(token, username, expires);
  return token;
}

function validateAdminSession(token) {
  if (!token) return null;
  const session = db.prepare("SELECT * FROM admin_sessions WHERE token = ? AND expires_at > datetime('now')").get(token);
  return session || null;
}

function destroyAdminSession(token) {
  if (token) db.prepare('DELETE FROM admin_sessions WHERE token = ?').run(token);
}

function parseCookies(cookieHeader) {
  const cookies = {};
  if (!cookieHeader) return cookies;
  cookieHeader.split(';').forEach(c => {
    const [k, ...v] = c.trim().split('=');
    if (k) cookies[k.trim()] = decodeURIComponent(v.join('='));
  });
  return cookies;
}

function requireAuth(req, res, next) {
  const cookies = parseCookies(req.headers.cookie);
  const token = cookies.admin_session;
  const session = validateAdminSession(token);
  if (!session) {
    return res.status(401).json({ error: 'Unauthorized', login: '/admin' });
  }
  req.adminUser = session.username;
  next();
}

// Serve admin page
app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

// ── Admin Login / Logout ──
app.post('/api/admin/login', (req, res) => {
  const { username, password } = req.body || {};
  if (username === ADMIN_USER && password === ADMIN_PASS) {
    const token = createAdminSession(username);
    res.setHeader('Set-Cookie', `admin_session=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${SESSION_DURATION_HOURS * 3600}`);
    res.json({ success: true, username });
  } else {
    res.status(401).json({ error: 'Invalid credentials' });
  }
});

app.post('/api/admin/logout', (req, res) => {
  const cookies = parseCookies(req.headers.cookie);
  destroyAdminSession(cookies.admin_session);
  res.setHeader('Set-Cookie', 'admin_session=; Path=/; HttpOnly; Max-Age=0');
  res.json({ success: true });
});

app.get('/api/admin/auth-check', (req, res) => {
  const cookies = parseCookies(req.headers.cookie);
  const session = validateAdminSession(cookies.admin_session);
  res.json({ authenticated: !!session, username: session?.username || null });
});

// Health check endpoint (also used for keep-alive pings)
app.get('/health', (req, res) => res.status(200).json({ status: 'ok', uptime: process.uptime() }));

// Route /reward to reward.html
app.get('/reward', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'reward.html'));
});

// ── PUBLIC ──
app.post('/api/submit', upload.single('proof'), (req, res) => {
  try {
    const { name, email, platform } = req.body;
    if (!email || !email.includes('@')) return res.status(400).json({ error: 'Valid email required' });
    if (!req.file) return res.status(400).json({ error: 'Screenshot proof required' });

    const stmt = db.prepare('INSERT INTO submissions (name, email, platform, proof_filename) VALUES (?, ?, ?, ?)');
    const r = stmt.run(name || '', email.trim().toLowerCase(), platform || 'google', req.file.filename);

    // Fire-and-forget: send email notification for new reward submission
    sendRewardSubmissionEmail({ name: name || 'Guest', email: email.trim(), platform: platform || 'google', filename: req.file.filename });

    res.json({ success: true, id: r.lastInsertRowid });
  } catch (err) {
    console.error('Submit error:', err);
    res.status(500).json({ error: 'Submission failed' });
  }
});

/**
 * Send an email notification when a guest submits a review proof.
 * Uses Web3Forms (same as contact form). Fire-and-forget.
 */
function sendRewardSubmissionEmail({ name, email, platform, filename }) {
  return new Promise((resolve) => {
    const accessKey = process.env.WEB3FORMS_ACCESS_KEY;
    if (!accessKey) {
      console.warn('WEB3FORMS_ACCESS_KEY not set – skipping reward submission email');
      return resolve({ skipped: true });
    }

    const timestamp = new Date().toLocaleString('en-US', {
      dateStyle: 'full',
      timeStyle: 'short',
      timeZone: 'America/Chicago'
    });

    const platformLabel = { google: 'Google', airbnb: 'Airbnb', vrbo: 'VRBO', other: 'Other' }[platform] || platform;

    const htmlBody = `
      <div style="font-family:Arial,Helvetica,sans-serif;max-width:600px;margin:0 auto;color:#333;">
        <div style="background:#1a1a2e;padding:20px 24px;border-radius:8px 8px 0 0;">
          <h2 style="margin:0;color:#ffffff;font-size:20px;">New Review Submission &mdash; $5 Gift Card</h2>
        </div>
        <div style="border:1px solid #e0e0e0;border-top:none;padding:24px;border-radius:0 0 8px 8px;">
          <p style="margin:0 0 16px;color:#666;font-size:14px;">A guest submitted proof of a review and is requesting their $5 Amazon gift card.</p>
          <table style="width:100%;border-collapse:collapse;">
            <tr>
              <td style="padding:10px 0;font-weight:bold;color:#555;width:110px;vertical-align:top;border-bottom:1px solid #f0f0f0;">Guest:</td>
              <td style="padding:10px 0;border-bottom:1px solid #f0f0f0;">${name}</td>
            </tr>
            <tr>
              <td style="padding:10px 0;font-weight:bold;color:#555;vertical-align:top;border-bottom:1px solid #f0f0f0;">Email:</td>
              <td style="padding:10px 0;border-bottom:1px solid #f0f0f0;"><a href="mailto:${email}" style="color:#C76B42;">${email}</a></td>
            </tr>
            <tr>
              <td style="padding:10px 0;font-weight:bold;color:#555;vertical-align:top;border-bottom:1px solid #f0f0f0;">Platform:</td>
              <td style="padding:10px 0;border-bottom:1px solid #f0f0f0;">${platformLabel}</td>
            </tr>
            <tr>
              <td style="padding:10px 0;font-weight:bold;color:#555;vertical-align:top;border-bottom:1px solid #f0f0f0;">Submitted:</td>
              <td style="padding:10px 0;border-bottom:1px solid #f0f0f0;">${timestamp}</td>
            </tr>
          </table>
          <div style="margin-top:20px;padding:16px;background:#FFF8F0;border-radius:8px;border-left:4px solid #C76B42;">
            <p style="margin:0;font-size:13px;color:#666;">Log in to the <a href="https://www.bookwithregent.com/admin" style="color:#C76B42;font-weight:bold;">Admin Dashboard</a> to view the screenshot proof and send the gift card.</p>
          </div>
          <div style="text-align:center;padding:16px 0;color:#999;font-size:12px;">
            Regent Capital Ventures LLC
          </div>
        </div>
      </div>
    `.trim();

    const payload = JSON.stringify({
      access_key: accessKey,
      subject: `Review Reward Request from ${name}`,
      from_name: 'Regent Rewards',
      email: email,
      cc: 'jatinshekara@gmail.com, sparx.sandeep@gmail.com',
      message: htmlBody
    });

    const https = require('https');
    const options = {
      hostname: 'api.web3forms.com',
      path: '/submit',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload)
      }
    };

    const req = https.request(options, (resp) => {
      let body = '';
      resp.on('data', (chunk) => { body += chunk; });
      resp.on('end', () => {
        try {
          const result = JSON.parse(body);
          if (result.success) {
            console.log('Reward submission email sent successfully');
          } else {
            console.error('Reward email API error:', body);
          }
        } catch (e) {
          console.error('Reward email parse error:', body);
        }
        resolve({ sent: true });
      });
    });

    req.on('error', (err) => {
      console.error('Reward email request error:', err.message);
      resolve({ error: err.message });
    });

    req.write(payload);
    req.end();
  });
}

// ── GUESTY (live availability + booking) ──

// Validation helpers
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
function isValidDate(s) {
  if (!DATE_RE.test(s)) return false;
  const d = new Date(s + 'T00:00:00Z');
  return !isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}
function todayUTC() { return new Date().toISOString().slice(0, 10); }

// List the bookable properties (live data from Guesty, cached 60 min server-side).
app.get('/api/guesty/listings', async (req, res) => {
  try {
    const listings = await guesty.getListings();
    // Allow browsers/CDNs to cache for 5 min (server cache is 60 min)
    res.set('Cache-Control', 'public, max-age=120, stale-while-revalidate=300');
    res.json({ listings });
  } catch (err) {
    console.error('Guesty listings error:', err.status || '', err.message);
    res.status(502).json({ error: 'Could not load listings' });
  }
});

// Lowest available nightly prices for all listings (scans 90-day calendar, cached 2h server-side).
app.get('/api/guesty/lowest-prices', async (req, res) => {
  try {
    const prices = await guesty.getLowestPrices();
    // Allow browsers/CDNs to cache for 2 min (server cache is 10 min)
    res.set('Cache-Control', 'public, max-age=120, stale-while-revalidate=300');
    res.json({ prices });
  } catch (err) {
    console.error('Guesty lowest-prices error:', err.status || '', err.message);
    res.status(502).json({ error: 'Could not load lowest prices' });
  }
});

// Availability calendar for one listing.
//   GET /api/guesty/calendar?listing=<slug|id>&from=YYYY-MM-DD&to=YYYY-MM-DD
app.get('/api/guesty/calendar', async (req, res) => {
  try {
    const listingId = guesty.resolveListingId(req.query.listing);
    if (!listingId) return res.status(400).json({ error: 'Unknown listing' });

    const from = req.query.from || todayUTC();
    let to = req.query.to;
    if (!to) {
      const d = new Date(from + 'T00:00:00Z');
      d.setUTCDate(d.getUTCDate() + 90);
      to = d.toISOString().slice(0, 10);
    }
    if (!isValidDate(from) || !isValidDate(to) || to <= from) {
      return res.status(400).json({ error: 'Invalid date range' });
    }
    // Cap the window to one year to keep responses small.
    if (guesty.countNights(from, to) > 366) {
      return res.status(400).json({ error: 'Date range too large (max 366 days)' });
    }

    const days = await guesty.getCalendar(listingId, from, to);
    // Availability must always be live — never let browsers or proxies cache it.
    res.set('Cache-Control', 'no-store');
    res.json({ listingId, from, to, days });
  } catch (err) {
    console.error('Guesty calendar error:', err.status || '', err.message);
    res.status(502).json({ error: 'Could not load availability' });
  }
});

// Live price quote for a stay.
//   POST { listing, checkIn, checkOut, guests, coupon? }
// When BEAPI is configured, returns full pricing with cleaning fees, taxes,
// promotions, and rate plans. Otherwise falls back to local calculation.
app.post('/api/guesty/quote', async (req, res) => {
  try {
    const { listing, checkIn, checkOut, coupon } = req.body || {};
    const guests = Math.max(1, parseInt(req.body?.guests, 10) || 1);
    const listingId = guesty.resolveListingId(listing);
    if (!listingId) return res.status(400).json({ error: 'Unknown listing' });
    if (!isValidDate(checkIn) || !isValidDate(checkOut)) {
      return res.status(400).json({ error: 'Invalid dates' });
    }
    if (checkOut <= checkIn) return res.status(400).json({ error: 'Check-out must be after check-in' });
    if (checkIn < todayUTC()) return res.status(400).json({ error: 'Check-in cannot be in the past' });

    const { summary } = await guesty.createQuote({
      listingId,
      checkIn,
      checkOut,
      guests,
      coupons: coupon || undefined,
    });
    if (!summary.total) return res.status(409).json({ error: 'No price available for those dates' });
    res.json(summary);
  } catch (err) {
    const detail = err.body?.error?.message || err.body?.message || err.message;
    console.error('Guesty quote error:', err.status || '', err.message);
    // Surface Guesty's user-facing validation (e.g. min-nights) when present.
    if (err.status === 400 && detail) return res.status(400).json({ error: detail });
    // Surface unavailable-date conflicts so the frontend can show a clear message.
    if (err.status === 409) {
      return res.status(409).json({
        error: detail || 'Some dates are not available',
        unavailableDates: err.body?.unavailableDates || [],
      });
    }
    if (err.status === 429) {
      return res.status(503).json({ error: 'Our pricing service is temporarily busy. Please try again in a few minutes.' });
    }
    res.status(502).json({ error: 'Could not get a price for those dates' });
  }
});

// BEAPI status — lets the frontend know whether BEAPI features are available.
app.get('/api/guesty/beapi-status', (req, res) => {
  res.json({ enabled: guesty.beapiAvailable() });
});

// Payment provider — returns the Guesty Pay provider connected to a listing.
//   GET /api/guesty/payment-provider?listing=<slug|id>
app.get('/api/guesty/payment-provider', async (req, res) => {
  try {
    const listingId = guesty.resolveListingId(req.query.listing);
    if (!listingId) return res.status(400).json({ error: 'Unknown listing' });
    const provider = await guesty.getPaymentProvider(listingId);
    const normalized = guesty.normalizePaymentProvider(provider);
    if (!normalized.paymentProviderId) {
      return res.status(502).json({ error: 'Payment provider is not configured for this listing' });
    }
    // Only expose what the frontend needs — never echo API credentials.
    res.json({
      listingId,
      paymentProviderId: normalized.paymentProviderId,
      provider: normalized.provider,
      method: normalized.method,
      status: normalized.status,
      active: normalized.active,
    });
  } catch (err) {
    console.error('Payment provider error:', err.status || '', err.message);
    // Not fatal — the frontend can fall back to request-to-book mode.
    res.status(502).json({ error: 'Could not load payment provider' });
  }
});

// Create a guest profile in Guesty.
//   POST { firstName, lastName, email, phone }
app.post('/api/guesty/create-guest', async (req, res) => {
  try {
    const { firstName, lastName, email, phone } = req.body || {};
    if (!firstName || !(firstName || '').trim()) {
      return res.status(400).json({ error: 'First name is required' });
    }
    if (!lastName || !(lastName || '').trim()) {
      return res.status(400).json({ error: 'Last name is required' });
    }
    if (!email || !email.includes('@')) {
      return res.status(400).json({ error: 'A valid email is required' });
    }
    const guest = await guesty.createGuest({
      firstName: firstName.trim(),
      lastName: (lastName || '').trim(),
      email: email.trim().toLowerCase(),
      phone: (phone || '').trim(),
    });
    res.json({ guestId: guest._id || guest.id, guest });
  } catch (err) {
    console.error('Create guest error:', err.status || '', err.message);
    const detail = err.body?.error?.message || err.body?.message;
    res.status(err.status === 400 ? 400 : 502).json({ error: detail || 'Could not create guest profile' });
  }
});

// Attach a Guesty Pay tokenized payment method to a guest.
//   POST { guestId, paymentToken, paymentProviderId, reservationId? }
app.post('/api/guesty/attach-payment', async (req, res) => {
  try {
    const { guestId, paymentToken, paymentProviderId, reservationId, reuse } = req.body || {};
    if (!guestId) return res.status(400).json({ error: 'Guest ID is required' });
    if (!paymentProviderId) return res.status(400).json({ error: 'Payment provider ID is required' });
    if (!paymentToken) return res.status(400).json({ error: 'Payment token is required' });

    const result = await guesty.attachPaymentMethod(guestId, {
      token: paymentToken,
      paymentProviderId,
      reservationId,
      reuse: reuse !== false,
    });
    res.json({
      paymentMethodId: result._id || result.id || null,
      status: result.status || 'attached',
    });
  } catch (err) {
    console.error('Attach payment error:', err.status || '', err.message);
    const detail = err.body?.error?.message || err.body?.message;
    // Common card/processor errors surface here.
    if (detail && /declined|expired|insufficient|card|cvv|cvc|processor/i.test(detail)) {
      return res.status(400).json({ error: detail, code: 'card_error' });
    }
    res.status(502).json({ error: detail || 'Could not attach payment method' });
  }
});

function sanitizeGuestPayload(g) {
  return {
    firstName: (g.firstName || '').trim(),
    lastName: (g.lastName || '').trim(),
    email: (g.email || '').trim().toLowerCase(),
    phone: (g.phone || '').trim(),
  };
}

function extractPaymentToken(paymentMethod) {
  return paymentMethod?._id || paymentMethod?.id || paymentMethod?.tokenId || paymentMethod?.payload?.tokenId || paymentMethod?.payload?.id || null;
}

// Create a short-lived Guesty reservation intent for Guesty Pay tokenization.
// The frontend tokenizes against this reservationId using Guesty's PCI-safe iframe.
//   POST { listing, checkIn, checkOut, guests, guest: { firstName, lastName, email, phone } }
app.post('/api/guesty/reservation-intent', async (req, res) => {
  try {
    const { listing, checkIn, checkOut, guest } = req.body || {};
    const guests = Math.max(1, parseInt(req.body?.guests, 10) || 1);
    const listingId = guesty.resolveListingId(listing);
    if (!listingId) return res.status(400).json({ error: 'Unknown listing' });
    if (!isValidDate(checkIn) || !isValidDate(checkOut) || checkOut <= checkIn) {
      return res.status(400).json({ error: 'Invalid dates' });
    }
    if (checkIn < todayUTC()) return res.status(400).json({ error: 'Check-in cannot be in the past' });

    const g = sanitizeGuestPayload(guest || {});
    if (!g.email.includes('@')) return res.status(400).json({ error: 'A valid email is required' });
    if (!g.firstName) return res.status(400).json({ error: 'First name is required' });
    if (!g.lastName) return res.status(400).json({ error: 'Last name is required' });

    const meta = Object.values(guesty.LISTINGS).find(l => l.id === listingId);
    const { summary } = await guesty.createQuote({ listingId, checkIn, checkOut, guests });
    const providerRaw = await guesty.getPaymentProvider(listingId);
    const provider = guesty.normalizePaymentProvider(providerRaw);
    if (!provider.paymentProviderId) {
      return res.status(502).json({ error: 'Guesty Pay is not configured for this listing' });
    }

    const row = db.prepare(`
      INSERT INTO booking_requests
        (listing_id, listing_name, guest_name, guest_email, guest_phone,
         check_in, check_out, guests, nights, total, currency, quote_id, status, message)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(
      listingId, meta ? meta.name : '', `${g.firstName} ${g.lastName}`.trim(), g.email, g.phone,
      checkIn, checkOut, guests, summary.nights, summary.total, summary.currency,
      summary.quoteId, 'requested', (guest?.message || '').trim()
    );
    const requestId = row.lastInsertRowid;

    const guestResult = await guesty.createGuest(g);
    const guestId = guestResult._id || guestResult.id;
    const reservation = await guesty.createReservation({
      listingId,
      checkIn,
      checkOut,
      guests,
      guestId,
      status: 'reserved',
      // Keep the hold short so a failed/abandoned payment does not block the calendar indefinitely.
      reservedUntil: 0.5,
      // Use total (includes 5% direct booking discount) so Guesty shows the actual charge
      money: { fareAccommodation: summary.total },
    });
    const reservationId = reservation._id || reservation.reservationId || reservation.id;

    db.prepare("UPDATE booking_requests SET guesty_reservation_id=? WHERE id=?")
      .run(reservationId || null, requestId);

    res.json({
      success: true,
      status: 'payment_pending',
      requestId,
      listingId,
      guestId,
      reservationId,
      paymentProviderId: provider.paymentProviderId,
      quote: summary,
    });
  } catch (err) {
    const detail = err.body?.error?.message || err.body?.message || err.message;
    console.error('Guesty reservation intent error:', err.status || '', err.message);
    if (err.status === 400 && detail) return res.status(400).json({ error: detail });
    if (err.status === 409) return res.status(409).json({ error: detail || err.message });
    res.status(502).json({ error: detail || 'Could not start Guesty Pay checkout' });
  }
});

// Attach the Guesty Pay token to the reservation and confirm it.
//   POST { requestId, guestId, reservationId, paymentProviderId, paymentMethod }
app.post('/api/guesty/confirm-payment', async (req, res) => {
  try {
    const { requestId, guestId, reservationId, paymentProviderId, paymentMethod } = req.body || {};
    const paymentToken = typeof paymentMethod === 'string' ? paymentMethod : extractPaymentToken(paymentMethod);
    if (!requestId) return res.status(400).json({ error: 'Request ID is required' });
    if (!guestId) return res.status(400).json({ error: 'Guest ID is required' });
    if (!reservationId) return res.status(400).json({ error: 'Reservation ID is required' });
    if (!paymentProviderId) return res.status(400).json({ error: 'Payment provider ID is required' });
    if (!paymentToken) return res.status(400).json({ error: 'Guesty Pay did not return a payment token' });

    const pmResult = await guesty.attachPaymentMethod(guestId, {
      token: paymentToken,
      paymentProviderId,
      reservationId,
      reuse: true,
    });

    let reservation;
    try {
      reservation = await guesty.updateReservationStatus(reservationId, {
        status: 'confirmed',
      });
    } catch (confirmErr) {
      console.error('Guesty reservation confirm error:', confirmErr.status || '', confirmErr.message);
      db.prepare("UPDATE booking_requests SET status='requested' WHERE id=?").run(requestId);
      return res.json({
        success: true,
        status: 'requested',
        requestId,
        reservationId,
        paymentMethodId: pmResult._id || pmResult.id || null,
        note: 'Payment method was saved, but the reservation still needs host confirmation in Guesty.',
      });
    }

    const resId = reservation._id || reservation.reservationId || reservation.id || reservationId;
    db.prepare("UPDATE booking_requests SET status='confirmed', guesty_reservation_id=? WHERE id=?")
      .run(resId, requestId);

    res.json({
      success: true,
      status: 'confirmed',
      requestId,
      reservationId: resId,
      paymentMethodId: pmResult._id || pmResult.id || null,
    });
  } catch (err) {
    const detail = err.body?.error?.message || err.body?.message || err.message;
    console.error('Guesty confirm payment error:', err.status || '', err.message);
    if (detail && /declined|expired|insufficient|card|cvv|cvc|processor/i.test(detail)) {
      return res.status(400).json({ error: detail, code: 'card_error' });
    }
    res.status(502).json({ error: detail || 'Could not confirm Guesty Pay booking' });
  }
});

// Request-to-book fallback without online payment.
// Guesty Pay card payments use the two-step reservation-intent/confirm-payment flow above.
// When BEAPI is configured, uses the BEAPI inquiry flow for better Guesty integration.
//   POST { listing, checkIn, checkOut, guests, guest: { firstName, lastName, email, phone } }
app.post('/api/guesty/reservation', async (req, res) => {
  try {
    const { listing, checkIn, checkOut, guest } = req.body || {};
    const guests = Math.max(1, parseInt(req.body?.guests, 10) || 1);
    const listingId = guesty.resolveListingId(listing);
    if (!listingId) return res.status(400).json({ error: 'Unknown listing' });
    if (!isValidDate(checkIn) || !isValidDate(checkOut) || checkOut <= checkIn) {
      return res.status(400).json({ error: 'Invalid dates' });
    }
    if (checkIn < todayUTC()) return res.status(400).json({ error: 'Check-in cannot be in the past' });

    const g = sanitizeGuestPayload(guest || {});
    if (!g.email.includes('@')) return res.status(400).json({ error: 'A valid email is required' });
    if (!g.firstName) return res.status(400).json({ error: 'First name is required' });
    if (!g.lastName) return res.status(400).json({ error: 'Last name is required' });

    const meta = Object.values(guesty.LISTINGS).find(l => l.id === listingId);

    // Always re-quote server-side — never trust a price from the client.
    const { quote, summary } = await guesty.createQuote({ listingId, checkIn, checkOut, guests });

    const row = db.prepare(`
      INSERT INTO booking_requests
        (listing_id, listing_name, guest_name, guest_email, guest_phone,
         check_in, check_out, guests, nights, total, currency, quote_id, status, message)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(
      listingId, meta ? meta.name : '', `${g.firstName} ${g.lastName}`.trim(), g.email, g.phone,
      checkIn, checkOut, guests, summary.nights, summary.total, summary.currency,
      summary.quoteId, 'requested', (guest?.message || '').trim()
    );
    const requestId = row.lastInsertRowid;

    // Create the reservation in Guesty so dates are blocked and the host
    // can see/manage it inside the Guesty dashboard.
    let guestyReservationId = null;

    // Path A: BEAPI inquiry flow (preferred when BEAPI is configured)
    if (guesty.beapiAvailable() && summary.source === 'beapi' && summary.ratePlanId) {
      try {
        const beapiRes = await guesty.beapiCreateInquiryReservation(summary.quoteId, {
          ratePlanId: summary.ratePlanId,
          guest: {
            firstName: g.firstName,
            lastName: g.lastName,
            phone: g.phone,
            email: g.email,
          },
        });
        guestyReservationId = beapiRes._id || beapiRes.reservationId || null;
        if (guestyReservationId) {
          db.prepare("UPDATE booking_requests SET guesty_reservation_id=?, status='confirmed' WHERE id=?")
            .run(guestyReservationId, requestId);
        }
      } catch (beapiErr) {
        console.warn('BEAPI inquiry creation failed, trying Open API:', beapiErr.message);
      }
    }

    // Path B: Open API reservation (fallback when BEAPI is unavailable or failed)
    if (!guestyReservationId) {
      try {
        const guestResult = await guesty.createGuest(g);
        const guestId = guestResult._id || guestResult.id;
        const reservation = await guesty.createReservation({
          listingId,
          checkIn,
          checkOut,
          guests,
          guestId,
          status: 'inquiry',
          money: { fareAccommodation: summary.total },
        });
        guestyReservationId = reservation._id || reservation.reservationId || reservation.id || null;
        if (guestyReservationId) {
          db.prepare("UPDATE booking_requests SET guesty_reservation_id=?, status='confirmed' WHERE id=?")
            .run(guestyReservationId, requestId);
        }
      } catch (apiErr) {
        // Log but don't fail — the booking request is already recorded locally.
        console.warn('Open API reservation creation failed (local record preserved):', apiErr.message);
      }
    }

    const finalStatus = guestyReservationId ? 'confirmed' : 'requested';
    res.json({
      success: true,
      status: finalStatus,
      requestId,
      reservationId: guestyReservationId,
      quote: summary,
    });
  } catch (err) {
    const detail = err.body?.error?.message || err.body?.message;
    console.error('Guesty booking request error:', err.status || '', err.message);
    if (err.status === 400 && detail) return res.status(400).json({ error: detail });
    if (err.status === 409) return res.status(409).json({ error: detail || err.message });
    res.status(502).json({ error: 'Could not complete the booking request' });
  }
});

// ── MESSAGES / CONTACT ──

/**
 * Send a contact-form notification email via Web3Forms.
 * Returns a Promise that always resolves (never rejects) so email
 * failures cannot break the API response.
 */
function sendContactEmail({ name, email, phone, property, subject, message }) {
  return new Promise((resolve) => {
    const accessKey = process.env.WEB3FORMS_ACCESS_KEY;
    if (!accessKey) {
      console.warn('WEB3FORMS_ACCESS_KEY not set – skipping email notification');
      return resolve({ skipped: true });
    }

    const timestamp = new Date().toLocaleString('en-US', {
      dateStyle: 'full',
      timeStyle: 'short',
      timeZone: 'America/New_York'
    });

    const htmlBody = `
      <div style="font-family:Arial,Helvetica,sans-serif;max-width:600px;margin:0 auto;color:#333;">
        <div style="background:#1a1a2e;padding:20px 24px;border-radius:8px 8px 0 0;">
          <h2 style="margin:0;color:#ffffff;font-size:20px;">New Message from bookwithregent.com</h2>
        </div>
        <div style="border:1px solid #e0e0e0;border-top:none;padding:24px;border-radius:0 0 8px 8px;">
          <table style="width:100%;border-collapse:collapse;">
            <tr>
              <td style="padding:8px 0;font-weight:bold;color:#555;width:100px;vertical-align:top;">From:</td>
              <td style="padding:8px 0;">${name || 'N/A'} (${email})</td>
            </tr>
            ${phone ? `<tr>
              <td style="padding:8px 0;font-weight:bold;color:#555;vertical-align:top;">Phone:</td>
              <td style="padding:8px 0;">${phone}</td>
            </tr>` : ''}
            <tr>
              <td style="padding:8px 0;font-weight:bold;color:#555;vertical-align:top;">Subject:</td>
              <td style="padding:8px 0;">${subject || 'General Inquiry'}</td>
            </tr>
            ${property ? `<tr>
              <td style="padding:8px 0;font-weight:bold;color:#555;vertical-align:top;">Property:</td>
              <td style="padding:8px 0;">${property}</td>
            </tr>` : ''}
            <tr>
              <td style="padding:8px 0;font-weight:bold;color:#555;vertical-align:top;">Message:</td>
              <td style="padding:8px 0;white-space:pre-wrap;">${message}</td>
            </tr>
            <tr>
              <td style="padding:8px 0;font-weight:bold;color:#555;vertical-align:top;">Submitted:</td>
              <td style="padding:8px 0;">${timestamp}</td>
            </tr>
          </table>
        </div>
        <div style="text-align:center;padding:16px 0;color:#999;font-size:12px;">
          Regent Capital Ventures LLC
        </div>
      </div>
    `.trim();

    const payload = JSON.stringify({
      access_key: accessKey,
      subject: `New Contact: ${subject || 'General Inquiry'} from ${name || 'Guest'}`,
      from_name: name || 'Website Visitor',
      email: email,
      cc: 'jatinshekara@gmail.com, sparx.sandeep@gmail.com',
      message: htmlBody
    });

    const https = require('https');
    const options = {
      hostname: 'api.web3forms.com',
      path: '/submit',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload)
      }
    };

    const req = https.request(options, (resp) => {
      let body = '';
      resp.on('data', (chunk) => { body += chunk; });
      resp.on('end', () => {
        try {
          const result = JSON.parse(body);
          if (result.success) {
            console.log('Web3Forms email sent successfully');
          } else {
            console.error('Web3Forms API error:', body);
          }
        } catch (e) {
          console.error('Web3Forms response parse error:', body);
        }
        resolve({ sent: true });
      });
    });

    req.on('error', (err) => {
      console.error('Web3Forms request error:', err.message);
      resolve({ error: err.message });
    });

    req.write(payload);
    req.end();
  });
}

// Public: submit a contact / message form.
app.post('/api/messages', (req, res) => {
  try {
    const { name, email, phone, property, subject, message } = req.body || {};
    if (!email || !email.includes('@')) {
      return res.status(400).json({ error: 'A valid email is required' });
    }
    if (!message || !message.trim()) {
      return res.status(400).json({ error: 'Message is required' });
    }
    const stmt = db.prepare(
      'INSERT INTO messages (name, email, phone, property, subject, message) VALUES (?, ?, ?, ?, ?, ?)'
    );
    const r = stmt.run(
      (name || '').trim(),
      email.trim().toLowerCase(),
      (phone || '').trim(),
      (property || '').trim(),
      (subject || '').trim(),
      message.trim()
    );
    res.json({ success: true, id: r.lastInsertRowid });

    // Fire-and-forget: send email notification via Web3Forms.
    sendContactEmail({
      name: (name || '').trim(),
      email: email.trim().toLowerCase(),
      phone: (phone || '').trim(),
      property: (property || '').trim(),
      subject: (subject || '').trim(),
      message: message.trim()
    }).catch(() => {});
  } catch (err) {
    console.error('Message submit error:', err);
    res.status(500).json({ error: 'Failed to save message' });
  }
});

// Admin: list messages, optionally filtered by ?status=
app.get('/api/admin/messages', requireAuth, (req, res) => {
  try {
    const { status } = req.query;
    let q = 'SELECT * FROM messages';
    const p = [];
    if (status && ['unread', 'read', 'replied', 'archived'].includes(status)) {
      q += ' WHERE status = ?';
      p.push(status);
    }
    q += ' ORDER BY created_at DESC';
    res.json(db.prepare(q).all(...p));
  } catch (err) {
    console.error('Messages list error:', err);
    res.status(500).json({ error: 'Failed to load messages' });
  }
});

// Admin: update a message's status and/or reply.
app.patch('/api/admin/messages/:id', requireAuth, (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!id || isNaN(id)) return res.status(400).json({ error: 'Invalid message id' });

    const existing = db.prepare('SELECT * FROM messages WHERE id = ?').get(id);
    if (!existing) return res.status(404).json({ error: 'Message not found' });

    const { status, reply } = req.body || {};
    const validStatuses = ['unread', 'read', 'replied', 'archived'];

    if (status && !validStatuses.includes(status)) {
      return res.status(400).json({ error: `Invalid status. Must be one of: ${validStatuses.join(', ')}` });
    }
    if (!status && reply === undefined) {
      return res.status(400).json({ error: 'Provide status and/or reply to update' });
    }

    const updates = [];
    const params = [];

    if (status) {
      updates.push('status = ?');
      params.push(status);
    }
    if (reply !== undefined) {
      updates.push('reply = ?');
      params.push(reply);
      updates.push("replied_at = datetime('now')");
      // Auto-set status to 'replied' when a reply is added (unless explicitly set otherwise).
      if (!status && reply.trim()) {
        updates.push("status = 'replied'");
      }
    }

    params.push(id);
    db.prepare(`UPDATE messages SET ${updates.join(', ')} WHERE id = ?`).run(...params);

    const updated = db.prepare('SELECT * FROM messages WHERE id = ?').get(id);
    res.json({ success: true, message: updated });
  } catch (err) {
    console.error('Message update error:', err);
    res.status(500).json({ error: 'Failed to update message' });
  }
});

// ── ADMIN: Custom Invoice ──
// Creates a reservation in Guesty with admin-specified pricing. Guesty's Guest
// Invoice feature is then used to send a payment link to the guest.
//   POST { listing, checkIn, checkOut, guests, totalPrice, cleaningFee?,
//          guest: { firstName, lastName, email, phone }, notes? }
app.post('/api/admin/custom-invoice', requireAuth, async (req, res) => {
  try {
    const { listing, checkIn, checkOut, totalPrice, cleaningFee, notes, guest } = req.body || {};
    const guests = Math.max(1, parseInt(req.body?.guests, 10) || 1);
    const listingId = guesty.resolveListingId(listing);
    if (!listingId) return res.status(400).json({ error: 'Unknown listing' });
    if (!isValidDate(checkIn) || !isValidDate(checkOut) || checkOut <= checkIn) {
      return res.status(400).json({ error: 'Invalid dates' });
    }
    const price = parseFloat(totalPrice);
    if (!price || price <= 0) return res.status(400).json({ error: 'A valid total price is required' });

    const g = sanitizeGuestPayload(guest || {});
    if (!g.email.includes('@')) return res.status(400).json({ error: 'A valid guest email is required' });
    if (!g.firstName) return res.status(400).json({ error: 'Guest first name is required' });
    if (!g.lastName) return res.status(400).json({ error: 'Guest last name is required' });

    const meta = Object.values(guesty.LISTINGS).find(l => l.id === listingId);
    const nights = guesty.countNights(checkIn, checkOut);

    // 1. Create guest in Guesty
    const guestResult = await guesty.createGuest(g);
    const guestId = guestResult._id || guestResult.id;

    // 2. Create reservation with custom pricing (status: reserved = booking request,
    //    guest will pay via Guesty's Guest Invoice which triggers auto-confirm)
    const moneyObj = { fareAccommodation: price };
    const reservation = await guesty.createReservation({
      listingId,
      checkIn,
      checkOut,
      guests,
      guestId,
      status: 'reserved',
      money: moneyObj,
    });
    const reservationId = reservation._id || reservation.reservationId || reservation.id;

    // 3. Save to local DB for admin tracking
    const row = db.prepare(`
      INSERT INTO booking_requests
        (listing_id, listing_name, guest_name, guest_email, guest_phone,
         check_in, check_out, guests, nights, total, currency, quote_id,
         guesty_reservation_id, status, message)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(
      listingId,
      meta ? meta.name : '',
      `${g.firstName} ${g.lastName}`.trim(),
      g.email,
      g.phone,
      checkIn,
      checkOut,
      guests,
      nights,
      price,
      'USD',
      'custom-invoice',
      reservationId || null,
      'requested',
      (notes || 'Custom invoice created from admin').trim()
    );

    res.json({
      success: true,
      requestId: row.lastInsertRowid,
      reservationId,
      guestId,
      nights,
      total: price,
      note: 'Reservation created in Guesty. Send the Guest Invoice from Guesty dashboard to collect payment.',
    });
  } catch (err) {
    const detail = err.body?.error?.message || err.body?.message || err.message;
    console.error('Custom invoice error:', err.status || '', err.message);
    if (err.status === 400 && detail) return res.status(400).json({ error: detail });
    if (err.status === 409) return res.status(409).json({ error: detail || 'Dates are not available' });
    res.status(502).json({ error: detail || 'Could not create custom invoice' });
  }
});

// ── ADMIN ──
app.get('/api/admin/booking-requests', requireAuth, (req, res) => {
  res.json(db.prepare('SELECT * FROM booking_requests ORDER BY created_at DESC').all());
});

// Alias so the bookings list is also available at /api/admin/bookings.
app.get('/api/admin/bookings', requireAuth, (req, res) => {
  res.json(db.prepare('SELECT * FROM booking_requests ORDER BY created_at DESC').all());
});

app.get('/api/admin/submissions', requireAuth, (req, res) => {
  const { status } = req.query;
  let q = 'SELECT * FROM submissions';
  const p = [];
  if (status && status !== 'all') { q += ' WHERE status = ?'; p.push(status); }
  q += ' ORDER BY created_at DESC';
  res.json(db.prepare(q).all(...p));
});

app.post('/api/admin/update', requireAuth, (req, res) => {
  const { id, status, notes } = req.body;
  if (!id || !status) return res.status(400).json({ error: 'id and status required' });
  db.prepare("UPDATE submissions SET status = ?, notes = COALESCE(?, notes), processed_at = datetime('now') WHERE id = ?")
    .run(status, notes || null, id);
  res.json({ success: true });
});

app.delete('/api/admin/delete/:id', requireAuth, (req, res) => {
  const sub = db.prepare('SELECT proof_filename FROM submissions WHERE id = ?').get(req.params.id);
  if (sub && sub.proof_filename) {
    const fp = path.join('uploads', sub.proof_filename);
    if (fs.existsSync(fp)) fs.unlinkSync(fp);
  }
  db.prepare('DELETE FROM submissions WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

app.get('/api/admin/stats', requireAuth, (req, res) => {
  const total = db.prepare('SELECT COUNT(*) as c FROM submissions').get().c;
  const g = (s) => db.prepare('SELECT COUNT(*) as c FROM submissions WHERE status = ?').get(s).c;
  res.json({ total, pending: g('pending'), sent: g('sent'), rejected: g('rejected'), approved: g('approved') });
});

// ── ADMIN: Dashboard ──
app.get('/api/admin/dashboard', requireAuth, async (req, res) => {
  try {
    const now = new Date();
    const weekAgo = new Date(now - 7 * 86400000).toISOString();
    const monthAgo = new Date(now - 30 * 86400000).toISOString();

    const messagesWeek = db.prepare("SELECT COUNT(*) as c FROM messages WHERE created_at >= ?").get(weekAgo).c;
    const messagesMonth = db.prepare("SELECT COUNT(*) as c FROM messages WHERE created_at >= ?").get(monthAgo).c;
    const messagesUnread = db.prepare("SELECT COUNT(*) as c FROM messages WHERE status = 'unread'").get().c;
    const totalMessages = db.prepare("SELECT COUNT(*) as c FROM messages").get().c;

    const totalBookings = db.prepare("SELECT COUNT(*) as c FROM booking_requests").get().c;
    const confirmedBookings = db.prepare("SELECT COUNT(*) as c FROM booking_requests WHERE status = 'confirmed'").get().c;
    const pendingBookings = db.prepare("SELECT COUNT(*) as c FROM booking_requests WHERE status = 'requested'").get().c;
    const revenue = db.prepare("SELECT COALESCE(SUM(total), 0) as r FROM booking_requests WHERE status = 'confirmed'").get().r;

    const totalReviews = db.prepare("SELECT COUNT(*) as c FROM reviews").get().c;
    const pendingGiftCards = db.prepare("SELECT COUNT(*) as c FROM reviews WHERE gift_card_sent = 0").get().c;

    // Recent activity
    const recentMessages = db.prepare("SELECT id, name, email, subject, property, status, created_at FROM messages ORDER BY created_at DESC LIMIT 5").all();
    const recentBookings = db.prepare("SELECT id, guest_name, listing_name, check_in, check_out, total, status, created_at FROM booking_requests ORDER BY created_at DESC LIMIT 5").all();
    const recentReviews = db.prepare("SELECT id, guest_name, property_slug, rating, gift_card_sent, created_at FROM reviews ORDER BY created_at DESC LIMIT 5").all();

    // Guesty live revenue data (best-effort — doesn't block the dashboard)
    let guestyRevenue = null;
    try {
      const today = new Date().toISOString().slice(0, 10);
      const yearStart = today.slice(0, 4) + '-01-01';
      const monthStart = today.slice(0, 7) + '-01';
      const nextMonth = new Date(now.getFullYear(), now.getMonth() + 1, 1);
      const monthEnd = new Date(nextMonth - 86400000).toISOString().slice(0, 10);
      const yearEnd = today.slice(0, 4) + '-12-31';

      // Fetch confirmed/checked-in reservations for the year
      const yearData = await guesty.getReservations({
        from: yearStart, to: yearEnd, limit: 100,
      });
      const allRes = yearData.reservations || [];

      // Aggregate
      let totalRevYTD = 0, totalRevMonth = 0;
      let totalPaidYTD = 0, totalPaidMonth = 0;
      let upcomingCheckins = 0, activeStays = 0;
      let occupiedNightsMonth = 0;
      const upcomingList = [];
      const resByProperty = {};

      for (const r of allRes) {
        const ci = r.checkInDateLocalized || '';
        const co = r.checkOutDateLocalized || '';
        const payout = r.money?.hostPayout || r.money?.fareAccommodation || 0;
        const paid = r.money?.totalPaid || 0;
        const status = r.status || '';
        const listingTitle = r.listing?.title || r.listing?.nickname || 'Unknown';
        const isConfirmed = ['confirmed', 'checked_in', 'checked_out'].includes(status);

        if (isConfirmed) {
          totalRevYTD += payout;
          totalPaidYTD += paid;

          if (ci >= monthStart && ci <= monthEnd) {
            totalRevMonth += payout;
            totalPaidMonth += paid;
            occupiedNightsMonth += r.nightsCount || 0;
          }

          // Aggregate by property
          if (!resByProperty[listingTitle]) resByProperty[listingTitle] = { revenue: 0, bookings: 0, nights: 0 };
          resByProperty[listingTitle].revenue += payout;
          resByProperty[listingTitle].bookings += 1;
          resByProperty[listingTitle].nights += r.nightsCount || 0;
        }

        // Upcoming check-ins (next 7 days)
        if (ci >= today && ci <= new Date(now.getTime() + 7 * 86400000).toISOString().slice(0, 10) && status !== 'canceled') {
          upcomingCheckins++;
          upcomingList.push({
            guest: r.guest ? `${r.guest.firstName || ''} ${r.guest.lastName || ''}`.trim() : 'Guest',
            guestEmail: r.guest?.email || '',
            guestPhone: r.guest?.phone || '',
            property: listingTitle,
            checkIn: ci,
            checkOut: co,
            nights: r.nightsCount || 0,
            guests: r.guestsCount || 0,
            payout,
            paid,
            balanceDue: r.money?.balanceDue || 0,
            status,
            confirmationCode: r.confirmationCode || '',
          });
        }

        // Currently active
        if (ci <= today && co > today && ['confirmed', 'checked_in'].includes(status)) {
          activeStays++;
        }
      }

      // Occupancy rate: (occupied nights / total possible nights this month)
      const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
      const totalPossibleNights = Object.keys(guesty.LISTINGS).length * daysInMonth;
      const occupancyRate = totalPossibleNights > 0 ? Math.round((occupiedNightsMonth / totalPossibleNights) * 100) : 0;

      guestyRevenue = {
        yearToDate: totalRevYTD,
        monthToDate: totalRevMonth,
        paidYTD: totalPaidYTD,
        paidMonth: totalPaidMonth,
        outstandingBalance: totalRevYTD - totalPaidYTD,
        upcomingCheckins,
        activeStays,
        upcoming: upcomingList.sort((a, b) => a.checkIn.localeCompare(b.checkIn)),
        occupancyRate,
        totalReservations: allRes.filter(r => ['confirmed', 'checked_in', 'checked_out'].includes(r.status)).length,
        byProperty: Object.entries(resByProperty).map(([name, d]) => ({ name, ...d })).sort((a, b) => b.revenue - a.revenue),
      };
    } catch (gErr) {
      console.warn('Dashboard Guesty revenue fetch failed (non-fatal):', gErr.message);
    }

    res.json({
      messages: { total: totalMessages, week: messagesWeek, month: messagesMonth, unread: messagesUnread },
      bookings: { total: totalBookings, confirmed: confirmedBookings, pending: pendingBookings, revenue },
      reviews: { total: totalReviews, pendingGiftCards },
      recent: { messages: recentMessages, bookings: recentBookings, reviews: recentReviews },
      guesty: guestyRevenue,
    });
  } catch (err) {
    console.error('Dashboard error:', err);
    res.status(500).json({ error: 'Failed to load dashboard data' });
  }
});

// ── ADMIN: Delete message ──
app.delete('/api/admin/messages/:id', requireAuth, (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!id || isNaN(id)) return res.status(400).json({ error: 'Invalid message id' });
    db.prepare('DELETE FROM messages WHERE id = ?').run(id);
    res.json({ success: true });
  } catch (err) {
    console.error('Message delete error:', err);
    res.status(500).json({ error: 'Failed to delete message' });
  }
});

// ── ADMIN: Reviews CRUD ──
app.get('/api/admin/reviews', requireAuth, (req, res) => {
  try {
    const { property, rating, gift_card } = req.query;
    let q = 'SELECT * FROM reviews';
    const conditions = [];
    const params = [];
    if (property) { conditions.push('property_slug = ?'); params.push(property); }
    if (rating) { conditions.push('rating = ?'); params.push(parseInt(rating, 10)); }
    if (gift_card === 'sent') { conditions.push('gift_card_sent = 1'); }
    else if (gift_card === 'pending') { conditions.push('gift_card_sent = 0'); }
    if (conditions.length) q += ' WHERE ' + conditions.join(' AND ');
    q += ' ORDER BY created_at DESC';
    res.json(db.prepare(q).all(...params));
  } catch (err) {
    console.error('Reviews list error:', err);
    res.status(500).json({ error: 'Failed to load reviews' });
  }
});

// Review photo upload
const reviewUpload = multer({
  storage: multer.diskStorage({
    destination: './uploads/',
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname).toLowerCase();
      cb(null, `review-${Date.now()}-${crypto.randomBytes(4).toString('hex')}${ext}`);
    }
  }),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ok = ['.jpg','.jpeg','.png','.gif','.webp','.heic'].includes(path.extname(file.originalname).toLowerCase());
    cb(null, ok);
  }
});

app.post('/api/admin/reviews', requireAuth, reviewUpload.single('photo'), (req, res) => {
  try {
    const { guest_name, guest_email, property_slug, rating, review_text, gift_card_sent, gift_card_amount, gift_card_type, gift_card_date } = req.body || {};
    if (!guest_name || !guest_name.trim()) return res.status(400).json({ error: 'Guest name is required' });

    const photo_path = req.file ? req.file.filename : '';
    const stmt = db.prepare(`
      INSERT INTO reviews (guest_name, guest_email, property_slug, rating, review_text, photo_path, gift_card_sent, gift_card_amount, gift_card_type, gift_card_date)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const r = stmt.run(
      guest_name.trim(),
      (guest_email || '').trim(),
      (property_slug || '').trim(),
      parseInt(rating, 10) || 5,
      (review_text || '').trim(),
      photo_path,
      gift_card_sent === 'true' || gift_card_sent === '1' ? 1 : 0,
      parseFloat(gift_card_amount) || 0,
      (gift_card_type || '').trim(),
      (gift_card_date || '').trim()
    );
    res.json({ success: true, id: r.lastInsertRowid });
  } catch (err) {
    console.error('Review create error:', err);
    res.status(500).json({ error: 'Failed to create review' });
  }
});

app.patch('/api/admin/reviews/:id', requireAuth, (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!id || isNaN(id)) return res.status(400).json({ error: 'Invalid review id' });

    const existing = db.prepare('SELECT * FROM reviews WHERE id = ?').get(id);
    if (!existing) return res.status(404).json({ error: 'Review not found' });

    const fields = ['guest_name', 'guest_email', 'property_slug', 'rating', 'review_text', 'gift_card_sent', 'gift_card_amount', 'gift_card_type', 'gift_card_date'];
    const updates = [];
    const params = [];

    for (const f of fields) {
      if (req.body[f] !== undefined) {
        updates.push(`${f} = ?`);
        if (f === 'rating') params.push(parseInt(req.body[f], 10) || 5);
        else if (f === 'gift_card_sent') params.push(req.body[f] ? 1 : 0);
        else if (f === 'gift_card_amount') params.push(parseFloat(req.body[f]) || 0);
        else params.push(req.body[f]);
      }
    }

    if (!updates.length) return res.status(400).json({ error: 'No fields to update' });

    params.push(id);
    db.prepare(`UPDATE reviews SET ${updates.join(', ')} WHERE id = ?`).run(...params);
    res.json({ success: true, review: db.prepare('SELECT * FROM reviews WHERE id = ?').get(id) });
  } catch (err) {
    console.error('Review update error:', err);
    res.status(500).json({ error: 'Failed to update review' });
  }
});

app.delete('/api/admin/reviews/:id', requireAuth, (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const review = db.prepare('SELECT photo_path FROM reviews WHERE id = ?').get(id);
    if (review && review.photo_path) {
      const fp = path.join('uploads', review.photo_path);
      if (fs.existsSync(fp)) fs.unlinkSync(fp);
    }
    db.prepare('DELETE FROM reviews WHERE id = ?').run(id);
    res.json({ success: true });
  } catch (err) {
    console.error('Review delete error:', err);
    res.status(500).json({ error: 'Failed to delete review' });
  }
});

// ── ADMIN: Price Overrides ──
app.get('/api/admin/price-overrides', requireAuth, (req, res) => {
  try {
    const { property } = req.query;
    let q = 'SELECT * FROM price_overrides';
    const params = [];
    if (property) { q += ' WHERE property_slug = ?'; params.push(property); }
    q += ' ORDER BY start_date ASC';
    res.json(db.prepare(q).all(...params));
  } catch (err) {
    console.error('Price overrides list error:', err);
    res.status(500).json({ error: 'Failed to load price overrides' });
  }
});

app.post('/api/admin/price-overrides', requireAuth, (req, res) => {
  try {
    const { property_slug, override_price, start_date, end_date, label } = req.body || {};
    if (!property_slug) return res.status(400).json({ error: 'Property is required' });
    if (!override_price || isNaN(parseFloat(override_price))) return res.status(400).json({ error: 'Valid price is required' });
    if (!start_date || !end_date) return res.status(400).json({ error: 'Start and end dates are required' });

    const stmt = db.prepare('INSERT INTO price_overrides (property_slug, override_price, start_date, end_date, label) VALUES (?, ?, ?, ?, ?)');
    const r = stmt.run(property_slug, parseFloat(override_price), start_date, end_date, (label || '').trim());
    res.json({ success: true, id: r.lastInsertRowid });
  } catch (err) {
    console.error('Price override create error:', err);
    res.status(500).json({ error: 'Failed to create price override' });
  }
});

app.put('/api/admin/price-overrides/:id', requireAuth, (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!id || isNaN(id)) return res.status(400).json({ error: 'Invalid override id' });

    const { override_price, start_date, end_date, label } = req.body || {};
    const updates = [];
    const params = [];

    if (override_price !== undefined) { updates.push('override_price = ?'); params.push(parseFloat(override_price)); }
    if (start_date) { updates.push('start_date = ?'); params.push(start_date); }
    if (end_date) { updates.push('end_date = ?'); params.push(end_date); }
    if (label !== undefined) { updates.push('label = ?'); params.push(label); }

    if (!updates.length) return res.status(400).json({ error: 'No fields to update' });

    params.push(id);
    db.prepare(`UPDATE price_overrides SET ${updates.join(', ')} WHERE id = ?`).run(...params);
    res.json({ success: true });
  } catch (err) {
    console.error('Price override update error:', err);
    res.status(500).json({ error: 'Failed to update price override' });
  }
});

app.delete('/api/admin/price-overrides/:id', requireAuth, (req, res) => {
  try {
    db.prepare('DELETE FROM price_overrides WHERE id = ?').run(parseInt(req.params.id, 10));
    res.json({ success: true });
  } catch (err) {
    console.error('Price override delete error:', err);
    res.status(500).json({ error: 'Failed to delete price override' });
  }
});

// ── ADMIN: Property Overrides ──
app.get('/api/admin/properties', requireAuth, async (req, res) => {
  try {
    const guesty = require('./guesty');
    const listings = await guesty.getListings();
    const overrides = db.prepare('SELECT * FROM property_overrides').all();
    const overrideMap = {};
    overrides.forEach(o => { overrideMap[o.property_slug] = o; });

    const properties = listings.map(l => ({
      ...l,
      overrides: overrideMap[l.slug] || null
    }));
    res.json(properties);
  } catch (err) {
    console.error('Properties list error:', err);
    res.status(500).json({ error: 'Failed to load properties' });
  }
});

app.put('/api/admin/properties/:slug', requireAuth, (req, res) => {
  try {
    const slug = req.params.slug;
    const { display_name, description, tagline, featured_amenities, category_badge, sort_order, visible } = req.body || {};

    const existing = db.prepare('SELECT * FROM property_overrides WHERE property_slug = ?').get(slug);
    if (existing) {
      db.prepare(`
        UPDATE property_overrides SET
          display_name = COALESCE(?, display_name),
          description = COALESCE(?, description),
          tagline = COALESCE(?, tagline),
          featured_amenities = COALESCE(?, featured_amenities),
          category_badge = COALESCE(?, category_badge),
          sort_order = COALESCE(?, sort_order),
          visible = COALESCE(?, visible),
          updated_at = datetime('now')
        WHERE property_slug = ?
      `).run(
        display_name ?? null, description ?? null, tagline ?? null,
        featured_amenities ?? null, category_badge ?? null,
        sort_order !== undefined ? sort_order : null,
        visible !== undefined ? (visible ? 1 : 0) : null,
        slug
      );
    } else {
      db.prepare(`
        INSERT INTO property_overrides (property_slug, display_name, description, tagline, featured_amenities, category_badge, sort_order, visible)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        slug,
        display_name || '', description || '', tagline || '',
        featured_amenities || '', category_badge || '',
        sort_order || 0, visible !== undefined ? (visible ? 1 : 0) : 1
      );
    }
    const updated = db.prepare('SELECT * FROM property_overrides WHERE property_slug = ?').get(slug);
    res.json({ success: true, overrides: updated });
  } catch (err) {
    console.error('Property override update error:', err);
    res.status(500).json({ error: 'Failed to update property' });
  }
});

// ── ADMIN: Settings ──
app.get('/api/admin/settings', requireAuth, (req, res) => {
  try {
    const rows = db.prepare('SELECT * FROM settings').all();
    const settings = {};
    rows.forEach(r => { settings[r.key] = r.value; });
    res.json(settings);
  } catch (err) {
    console.error('Settings load error:', err);
    res.status(500).json({ error: 'Failed to load settings' });
  }
});

app.put('/api/admin/settings', requireAuth, (req, res) => {
  try {
    const updates = req.body || {};
    const stmt = db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)');
    const allowed = [
      'contact_email', 'contact_phone', 'maintenance_mode', 'announcement_banner',
      'hero_headline', 'hero_subheadline', 'footer_text',
      'social_instagram', 'social_facebook', 'social_tiktok',
      'booking_cta_text', 'min_nights_override', 'checkout_message',
    ];
    for (const [key, value] of Object.entries(updates)) {
      if (allowed.includes(key)) {
        stmt.run(key, String(value));
      }
    }
    res.json({ success: true });
  } catch (err) {
    console.error('Settings update error:', err);
    res.status(500).json({ error: 'Failed to update settings' });
  }
});

// ── ADMIN: Listings data for pricing page ──
app.get('/api/admin/listings', requireAuth, async (req, res) => {
  try {
    const guesty = require('./guesty');
    const listings = await guesty.getListings();
    res.json(listings);
  } catch (err) {
    console.error('Admin listings error:', err);
    res.status(500).json({ error: 'Failed to load listings' });
  }
});

// ── Cache refresh (admin only) ──
// POST /api/admin/clear-cache — clears all Guesty caches so changes
// made in the Guesty dashboard are reflected on the website immediately.
app.post('/api/admin/clear-cache', requireAuth, (req, res) => {
  guesty.clearAllCaches();
  res.json({ ok: true, message: 'All Guesty caches cleared. Next request will fetch fresh data.' });
});

// ── PUBLIC: Site settings (non-sensitive fields only) ──
// The main site fetches these to reflect admin-configured values.
app.get('/api/site-settings', (req, res) => {
  try {
    const rows = db.prepare('SELECT * FROM settings').all();
    const all = {};
    rows.forEach(r => { all[r.key] = r.value; });
    // Only expose non-sensitive keys
    const publicKeys = [
      'contact_email', 'contact_phone', 'maintenance_mode', 'announcement_banner',
      'hero_headline', 'hero_subheadline', 'footer_text',
      'social_instagram', 'social_facebook', 'social_tiktok',
      'booking_cta_text', 'min_nights_override', 'checkout_message',
    ];
    const result = {};
    publicKeys.forEach(k => { if (all[k] !== undefined) result[k] = all[k]; });
    res.set('Cache-Control', 'public, max-age=60, stale-while-revalidate=120');
    res.json(result);
  } catch (err) {
    console.error('Public settings error:', err);
    res.status(500).json({});
  }
});

// ── EVENTS (Ticketmaster Discovery API proxy with 6-hour cache) ──

const eventsCache = new Map(); // key: "lat,lng,radius" → { ts, data }
const EVENTS_CACHE_TTL = 6 * 60 * 60 * 1000; // 6 hours

app.get('/api/events', async (req, res) => {
  try {
    const lat = parseFloat(req.query.lat);
    const lng = parseFloat(req.query.lng);
    const radius = parseInt(req.query.radius, 10) || 25;

    if (isNaN(lat) || isNaN(lng)) {
      return res.status(400).json({ error: 'lat and lng are required' });
    }

    const key = `${lat.toFixed(2)},${lng.toFixed(2)},${radius}`;
    const cached = eventsCache.get(key);
    if (cached && Date.now() - cached.ts < EVENTS_CACHE_TTL) {
      return res.json({ events: cached.data, cached: true });
    }

    const apiKey = process.env.TICKETMASTER_API_KEY;
    if (!apiKey) {
      // No API key configured — return curated sample events
      return res.json({ events: getSampleEvents(lat, lng), sample: true });
    }

    const url = `https://app.ticketmaster.com/discovery/v2/events.json?apikey=${apiKey}&latlong=${lat},${lng}&radius=${radius}&unit=miles&size=20&sort=date,asc&startDateTime=${new Date().toISOString().slice(0, 19)}Z`;

    const https = require('https');
    const data = await new Promise((resolve, reject) => {
      https.get(url, resp => {
        let body = '';
        resp.on('data', chunk => body += chunk);
        resp.on('end', () => {
          try {
            const json = JSON.parse(body);
            if (json._embedded && json._embedded.events) {
              const events = json._embedded.events.map(e => ({
                id: e.id,
                name: e.name,
                date: e.dates?.start?.localDate || '',
                time: e.dates?.start?.localTime || '',
                venue: e._embedded?.venues?.[0]?.name || '',
                city: e._embedded?.venues?.[0]?.city?.name || '',
                category: e.classifications?.[0]?.segment?.name || 'Event',
                subcategory: e.classifications?.[0]?.genre?.name || '',
                image: e.images?.find(i => i.ratio === '16_9' && i.width > 500)?.url
                     || e.images?.[0]?.url || '',
                url: e.url || '',
                lat: parseFloat(e._embedded?.venues?.[0]?.location?.latitude) || null,
                lng: parseFloat(e._embedded?.venues?.[0]?.location?.longitude) || null,
                priceRange: e.priceRanges?.[0] ? {
                  min: e.priceRanges[0].min,
                  max: e.priceRanges[0].max,
                  currency: e.priceRanges[0].currency
                } : null
              }));
              resolve(events);
            } else {
              resolve([]);
            }
          } catch (parseErr) {
            reject(new Error('Failed to parse Ticketmaster response'));
          }
        });
        resp.on('error', reject);
      }).on('error', reject);
    });

    eventsCache.set(key, { ts: Date.now(), data });
    res.json({ events: data, cached: false });
  } catch (err) {
    console.error('Events API error:', err.message);
    // Fallback to sample events on any error
    const lat = parseFloat(req.query.lat) || 32.85;
    const lng = parseFloat(req.query.lng) || -96.94;
    res.json({ events: getSampleEvents(lat, lng), sample: true });
  }
});

// Curated sample events for when the API key is missing or API is down
function getSampleEvents(lat, lng) {
  const now = new Date();
  const makeDate = (daysAhead) => {
    const d = new Date(now);
    d.setDate(d.getDate() + daysAhead);
    return d.toISOString().slice(0, 10);
  };
  return [
    { id:'s1', name:'Live at the Pavilion — Summer Concert Series', date:makeDate(3), time:'19:30:00', venue:'Toyota Music Factory', city:'Irving', category:'Music', subcategory:'Pop', image:'', url:'https://www.toyotamusicfactory.com', lat:32.8779, lng:-96.9430, priceRange:{min:25,max:85,currency:'USD'} },
    { id:'s2', name:'FC Dallas vs. Austin FC', date:makeDate(5), time:'20:00:00', venue:'Toyota Stadium', city:'Frisco', category:'Sports', subcategory:'Soccer', image:'', url:'https://www.fcdallas.com', lat:33.1543, lng:-96.8352, priceRange:{min:30,max:120,currency:'USD'} },
    { id:'s3', name:'Dallas Mavericks Summer Showcase', date:makeDate(7), time:'19:00:00', venue:'American Airlines Center', city:'Dallas', category:'Sports', subcategory:'Basketball', image:'', url:'https://www.mavs.com', lat:32.7905, lng:-96.8103, priceRange:{min:45,max:200,currency:'USD'} },
    { id:'s4', name:'DFW Restaurant Week', date:makeDate(10), time:'11:00:00', venue:'Various Locations', city:'Dallas-Fort Worth', category:'Arts & Theatre', subcategory:'Food & Drink', image:'', url:'https://www.dfwrestaurantweek.com', lat:32.78, lng:-96.80, priceRange:{min:25,max:55,currency:'USD'} },
    { id:'s5', name:'Alamo Drafthouse: Classic Film Festival', date:makeDate(2), time:'19:00:00', venue:'Alamo Drafthouse Las Colinas', city:'Irving', category:'Film', subcategory:'Cinema', image:'', url:'https://drafthouse.com', lat:32.8687, lng:-96.9445, priceRange:{min:15,max:25,currency:'USD'} },
    { id:'s6', name:'Medieval Times Tournament & Feast', date:makeDate(4), time:'18:00:00', venue:'Medieval Times', city:'Dallas', category:'Arts & Theatre', subcategory:'Performance', image:'', url:'https://www.medievaltimes.com', lat:32.9074, lng:-96.7685, priceRange:{min:40,max:80,currency:'USD'} },
    { id:'s7', name:'Topgolf Live: DJ Night', date:makeDate(1), time:'20:00:00', venue:'Topgolf Dallas', city:'Dallas', category:'Music', subcategory:'DJ', image:'', url:'https://topgolf.com', lat:33.0270, lng:-96.7040, priceRange:{min:0,max:65,currency:'USD'} },
    { id:'s8', name:'Dallas Farmers Market Weekend', date:makeDate(6), time:'09:00:00', venue:'Dallas Farmers Market', city:'Dallas', category:'Arts & Theatre', subcategory:'Food & Drink', image:'', url:'https://dallasfarmersmarket.org', lat:32.7822, lng:-96.7965, priceRange:null }
  ];
}

app.listen(PORT, '0.0.0.0', () => {
  console.log(`\n  Regent Review Portal`);
  console.log(`  Local:  http://localhost:${PORT}`);
  console.log(`  Admin:  http://localhost:${PORT}/admin\n`);

  // Keep-alive: ping own /health endpoint every 13 minutes to prevent Render free-tier sleep
  if (process.env.RENDER_EXTERNAL_URL) {
    const pingUrl = `${process.env.RENDER_EXTERNAL_URL}/health`;
    setInterval(() => {
      const mod = pingUrl.startsWith('https') ? require('https') : require('http');
      mod.get(pingUrl, () => {}).on('error', () => {});
    }, 13 * 60 * 1000);
    console.log(`  Keep-alive: pinging ${pingUrl} every 13 min`);
  }
});

const express = require('express');
const multer = require('multer');
const path = require('path');
const crypto = require('crypto');
const fs = require('fs');
const Database = require('better-sqlite3');
const { isDirectRegentBookingCandidate, DEFAULT_ALLOWED_DOMAINS } = require('./guesty-damage-protection-gate');

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

const TRUVI_PLAN_AMOUNT = (() => {
  const parsed = Number(process.env.TRUVI_PLAN_AMOUNT || '28.75');
  return Number.isFinite(parsed) ? parsed : 28.75;
})();
const TRUVI_PLAN_NAME = process.env.TRUVI_PLAN_NAME || 'Truvi Host Damage Protection';
const TRUVI_ALLOWED_DOMAINS = ((process.env.TRUVI_ALLOWED_BOOKING_DOMAINS || DEFAULT_ALLOWED_DOMAINS.join(','))
  .split(',')
  .map((d) => d.trim())
  .filter(Boolean));

const TRUVI_BOOKING_MIGRATIONS = [
  "ALTER TABLE booking_requests ADD COLUMN direct_booking INTEGER DEFAULT 0",
  "ALTER TABLE booking_requests ADD COLUMN protection_plan_amount REAL",
  "ALTER TABLE booking_requests ADD COLUMN protection_plan_name TEXT",
  "ALTER TABLE booking_requests ADD COLUMN protection_source TEXT",
  "ALTER TABLE booking_requests ADD COLUMN protection_domain TEXT",
  "ALTER TABLE booking_requests ADD COLUMN protection_reason TEXT",
];
for (const migration of TRUVI_BOOKING_MIGRATIONS) {
  try { db.exec(migration); } catch (e) { /* already exists */ }
}

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

// Property page route is defined below (before app.listen) using property.html template

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

function normalizeHostname(input) {
  if (!input) return '';
  return String(input)
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, '')
    .split('/')[0]
    .split('?')[0]
    .split(':')[0];
}

function getRequestOrigin(req) {
  return (
    req.get('referer') ||
    req.get('origin') ||
    req.headers?.referer ||
    req.headers?.origin ||
    req.headers?.host ||
    req.headers?.['x-forwarded-host'] ||
    req.get('x-forwarded-host') ||
    ''
  );
}

function inferTruviSourceHint(req, sourceHint) {
  const normalized = String(sourceHint || '').trim().toLowerCase();
  if (normalized && normalized !== 'beapi') return sourceHint;

  // Local API payload does not reliably preserve a durable Regent-only source field.
  // If the request is arriving on a canonical Regent direct domain, infer a trusted
  // direct-marker from the route context instead of trusting the raw `beapi` label.
  const host = normalizeHostname(getRequestOrigin(req));
  if (!host) return sourceHint;

  return isAllowedTruviDomain(host) ? 'Guesty Booking Engine' : sourceHint;
}

function isAllowedTruviDomain(host) {
  return TRUVI_ALLOWED_DOMAINS
    .map((item) => normalizeHostname(item))
    .some((item) => {
      return host === item || host.endsWith(`.${item}`);
    });
}

function getTruviProtectionDecision(req, sourceHint) {
  const host = normalizeHostname(getRequestOrigin(req));
  const inferredSource = inferTruviSourceHint(req, sourceHint);
  const decision = isDirectRegentBookingCandidate({
    source: inferredSource,
    platform: req.body?.platform,
    bookingSource: req.body?.bookingSource,
    websiteUrl: host,
    request: {
      referer: req.get('referer'),
      origin: req.get('origin'),
      host: req.headers?.host,
    },
    allowedDomains: TRUVI_ALLOWED_DOMAINS,
    requireWebsiteDomain: true,
  });

  return {
    host,
    inferredSource,
    ...decision,
  };
}

function persistTruviProtectionDecision(requestId, decision, sourceHint) {
  db.prepare(`
    UPDATE booking_requests
    SET
      direct_booking = ?,
      protection_plan_amount = ?,
      protection_plan_name = ?,
      protection_source = ?,
      protection_domain = ?,
      protection_reason = ?
    WHERE id = ?
  `).run(
    decision.eligible ? 1 : 0,
    decision.eligible ? TRUVI_PLAN_AMOUNT : null,
    decision.eligible ? TRUVI_PLAN_NAME : null,
    sourceHint || null,
    decision.host || null,
    decision.reason || null,
    requestId
  );
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
    const truviDecision = getTruviProtectionDecision(req, summary.source);
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
    persistTruviProtectionDecision(requestId, truviDecision, truviDecision.inferredSource);

    const guestResult = await guesty.createGuest(g);
    const guestId = guestResult._id || guestResult.id;
    const reservation = await guesty.createReservation({
      listingId,
      checkIn,
      checkOut,
      guests,
      guestId,
      status: 'reserved',
      source: truviDecision.inferredSource || summary.source || 'manual',
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
      truviProtection: {
        enabled: truviDecision.eligible,
        amount: truviDecision.eligible ? TRUVI_PLAN_AMOUNT : null,
        planName: truviDecision.eligible ? TRUVI_PLAN_NAME : null,
        reason: truviDecision.reason,
        domain: truviDecision.host,
      },
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
    const truviDecision = getTruviProtectionDecision(req, summary.source);

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
    persistTruviProtectionDecision(requestId, truviDecision, truviDecision.inferredSource);

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
          source: truviDecision.inferredSource || summary.source || 'manual',
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
      truviProtection: {
        enabled: truviDecision.eligible,
        amount: truviDecision.eligible ? TRUVI_PLAN_AMOUNT : null,
        planName: truviDecision.eligible ? TRUVI_PLAN_NAME : null,
        reason: truviDecision.reason,
        domain: truviDecision.host,
      },
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

// ── Property Data for Standalone Pages ──
const PROPERTY_DATA = {
  'regent-villa': {
    name: 'Regent Villa',
    slug: 'regent-villa',
    category: 'villa',
    city: 'Plano',
    state: 'Texas',
    hostingId: '1711340298974810369',
    guests: 14, beds: 4, baths: 3.5,
    rating: null, reviews: 0,
    lat: 33.02050, lng: -96.75080,
    isVilla: true,
    amenities: [
      { label: 'Hot Tub', premium: true },
      { label: '85" TV', premium: true },
      { label: 'Game Room', premium: true },
      { label: 'BBQ', premium: false },
      { label: 'Piano', premium: true },
      { label: 'Mini Golf', premium: false }
    ],
    description: 'Luxury Plano vacation rental in a prime location, perfect for families, groups, and weekend getaways. Sleeps up to 14 guests with 4 beds plus couch space. Enjoy a private hot tub, 85-inch TV, foosball, indoor basketball, mini fridge, piano, mini golf in the master, and 6 TVs total. An entertainment-filled home base near shopping, dining, events, and Plano/Dallas attractions.',
    fullAmenities: {Bathroom:['Bathtub','Hair dryer','Cleaning products','Shampoo','Conditioner','Body soap','Hot water','Shower gel','Vanity mirrors','Bathrobes','Slippers'],'Bedroom & Laundry':['Washer','Dryer','Essentials','Hangers','Bed linens','Extra pillows & blankets','Room-darkening shades','Iron','Drying rack','Clothing storage'],'Heating & Cooling':['Indoor fireplace','Ceiling fans'],Entertainment:['TV (6 total)','Piano','Sound system','Theatre room with 7.1 surround','Foosball','Indoor basketball','Books','Theme room','Mini golf','Streaming services'],'Kitchen & Dining':['Full kitchen','Refrigerator','Microwave','Cooking basics','Dishes & silverware','Mini fridge','Freezer','Dishwasher','Stove','Oven','Hot water kettle','Coffee maker','Wine glasses','Toaster','Baking sheet','Rice maker','BBQ utensils','Dining table','Coffee','Kitchen island with bar seating'],'Work & Tech':['Dedicated workspace','Smart thermostat'],Outdoor:['Private patio','Outdoor furniture','Outdoor dining area','Outdoor kitchen','BBQ grill','Private hot tub'],'Parking & Facilities':['Free parking','Street parking','2-car garage','Smart lock entry'],Family:['Children\'s books & toys','Children\'s dinnerware','Board games','Children\'s playroom'],'Home Highlights':['LED accent lighting','Reading nook']},
    amenityPhotos: {'Bathtub':48,'Vanity mirrors':53,'Bathrobes':49,'Slippers':27,'Clothing storage':49,'Indoor fireplace':8,'Piano':2,'Foosball':71,'Mini golf':25,'Streaming services':0,'Coffee maker':13,'Wine glasses':17,'BBQ utensils':63,'Kitchen island with bar seating':4,'Dedicated workspace':60,'Smart thermostat':61,'Outdoor furniture':64,'BBQ grill':62,'Private hot tub':65,'Reading nook':20},
    photos: [
      'c4264787-996e-49d3-b314-ffd1ec44a651.jpeg',
      'c5ccfab6-d77f-4b90-a60c-829c31cb09e5.png',
      '9c451b0b-2135-4698-a02f-9b26f8280041.png',
      '59b44781-e807-4dc6-9ae2-8d09ca0bb7c0.png',
      '4a2dff78-c8c7-4211-b022-e173a571c327.png',
      '8b49eeec-0e36-43ed-b5d9-40db469fb15f.png',
      'bb25e746-e4d0-4a72-8852-e9459dec36c8.jpeg',
      'e7440c21-7760-47ed-b5ec-11b9a1d3b182.jpeg',
      'b40c9963-98b9-49a0-aa20-39825f9b1b59.jpeg',
      '89401bdf-de33-48f3-8986-eb95009ae017.jpeg',
      '5dfe2116-ab82-4ab5-8f52-cc4a03ff1cd8.png',
      'b719d51a-18f7-42f6-9cf3-cae62e5c378b.png',
      'b943d204-dbb0-43f7-b900-9123a9a6d50f.png',
      '2278e117-6107-4c6f-be85-f40cfcaf53b3.jpeg',
      '2fd173a5-dfad-4bc4-aae9-ebdb30ebdb1a.jpeg',
      '9fe2d932-972d-465c-b18b-8b6b12cd6bad.jpeg',
      'b909b4be-56f8-47d2-a37b-fd54c89be3eb.png',
      '6cd76139-d32f-4dcf-be28-45a268f5add4.jpeg',
      '1dc0b413-0ed7-4129-9e9e-189f0d2718a5.png',
      '2cf353eb-9c60-43cc-a88d-7136ed45c2c7.png',
      '42c6659c-d3c2-4cfd-b8c2-ddf425be37d2.png',
      '0e485c2c-4c22-4a60-895c-91af76e5378d.png',
      '633d2662-bcc3-4f23-9cfc-3624e1482137.png',
      '1cd3fdc1-2c8e-486b-801b-057b27e6f44f.png',
      '63c592a8-e248-4345-ac10-08a61bfb04fb.png',
      '66f0e161-ee51-4591-9de9-ca7f1142608b.png',
      'ed478c60-8614-4ce2-bff2-5baf219de6cd.png',
      'e6a6a067-2e4d-4ebb-a0c0-caa3245aabbe.jpeg',
      '2ef8b75b-b9a1-408f-a79c-ee3a373ca964.png',
      '86952afa-9bf0-4492-b8f4-227b509cbf53.jpeg',
      '3074a9bf-4fb8-4743-8a4e-f26190c7efe5.png',
      '6bc01faf-a8de-45ab-b924-eacaf28a1129.png',
      '0ea9db57-530a-412b-81ea-846f57ef71c0.png',
      '67e7c78f-1578-4ab0-accf-d734019b7807.png',
      '5fc87cfd-fcbe-4bca-8207-11af284f21d2.png',
      '1f4f868c-b8d4-40b5-8535-b9f5dfb1070a.png',
      '596ac246-9020-488d-8a91-2141a3d269a9.jpeg',
      '88ffa3b7-9a61-4da0-8e0d-2eca5d29bbf2.jpeg',
      'f7a78d2b-b489-4c48-b86b-7cf2cabc0aa1.png',
      '37b2be7a-cf22-4d9f-abe9-8cb8f9ba42df.jpeg',
      '94890f87-af94-47b0-bc02-e13083a5115a.jpeg',
      '32730d6c-a9f3-4fe2-80ca-e7a8edf851d4.jpeg',
      'dad9310a-28db-4132-a4bf-a3f6f014d06a.jpeg',
      '91ce69c2-e4ca-4f98-a823-cd71778ccb24.png',
      '532f1ff1-0597-43f6-ab97-02ea4f391d19.jpeg',
      'c4800a9d-5242-44b8-82b7-f49a0d287e82.png',
      'c677cee3-a5cc-4d71-a45c-526e16b942d6.png',
      'ea185108-faf7-4e15-a108-15fc91bc3531.jpeg',
      'b67fa4fa-41b9-4570-9942-1f8543b8ae82.png',
      '25a35ab3-a529-4d6a-9229-bf2a97c60036.jpeg',
      'f78c0672-1ec9-4a1e-bb76-5863a6d7229c.png',
      'cf8cadfe-188f-4ed2-b872-339775eb84c7.png',
      '6c0ca956-a040-4379-b277-376d78ffa34c.png',
      '437f5166-503d-4af8-94bf-902d52b46608.jpeg',
      '0afa2081-bf1c-4362-b99f-51be77eeb068.png',
      '275abe46-7922-4d8a-a1b6-0b5c666ff7f7.jpeg',
      '1134344b-c0d6-450e-a8cf-e98d86c502a4.png',
      '0e40c70e-98fe-43c7-a937-2bfc99b84b5a.jpeg',
      'f96adb75-c592-4f64-ae0e-e712678bfa60.jpeg',
      'e7900c36-f237-4ac9-bfa0-71b81b2cd3e7.jpeg',
      '627d554f-e930-4afa-80d5-af1a714d173d.jpeg',
      '66846975-b48e-497a-9dda-068025ea4cd4.png',
      'd0d2b129-1e8a-419c-a580-7caa140163f8.jpeg',
      '3f740632-7440-4a15-adf3-8a2df5212864.jpeg',
      'fe59c585-48de-4c4f-a0c3-f885d13450cd.jpeg',
      '4bac69fb-4e58-4943-9a38-7c43cdfb3736.png',
      'a4f242ba-e02b-46a4-a699-4b17837ac4b7.png',
      '757c3522-7f84-426c-a895-e152ad80c8e3.png',
      'e43f4fb0-d20c-4a7a-8dd2-c33a59a2f64a.png',
      '54e8c02c-6c93-4595-8c43-0f3f1e235a31.jpeg',
      '474ef342-597c-4b0d-b549-ba4d91bcf2e3.png',
      '887eeca6-6321-4301-a345-d7841a994572.png',
      '0a64ee8f-8cd9-490f-b891-bbf97110e863.png',
      '05dbd5e8-dc1c-4962-bc76-691131db342e.png',
      '7ea01a07-b7a7-4673-8e54-69530a7817d3.png'
    ]
  },
  'regent-skyline': {
    name: 'Regent Skyline',
    slug: 'regent-skyline',
    category: 'suite',
    city: 'Dallas',
    state: 'Texas',
    hostingId: '1725649500272518567',
    guests: 5, beds: 1, baths: 1,
    rating: null, reviews: 0,
    lat: 32.7772411, lng: -96.7956303,
    isVilla: false,
    amenities: [
      { label: 'Skyline Views', premium: true },
      { label: 'Valet Parking', premium: true },
      { label: 'Cinema Room', premium: true },
      { label: 'Pool', premium: true },
      { label: 'Exposed Brick', premium: false },
      { label: '24/7 Gym', premium: false }
    ],
    description: 'Experience millionaire-level luxury in a cinematic loft in downtown Dallas. 1910 industrial charm — exposed brick and soaring 10-foot ceilings — meets bespoke modern design. Free valet parking, resort-style pool, private cinema, 24/7 gym, and a fully stocked kitchen. Steps from the Dallas Farmers Market and Deep Ellum. The premier luxury Airbnb in the Butler Brothers Building.',
    fullAmenities: {Bathroom:['Full bathroom','Hair dryer','Cleaning products','Shampoo','Body soap','Hot water','Shower gel','Full-length mirror'],'Bedroom & Laundry':['Washer','Dryer','Essentials','Hangers','Bed linens','Extra pillows & blankets','Room-darkening shades','Iron','Clothing storage','Air mattress'],Entertainment:['Smart TV (living room)','Smart TV (bedroom)','Board games','Premium LED lighting'],'Kitchen & Dining':['Full kitchen','Refrigerator','Microwave','Cooking basics','Dishes & silverware','Freezer','Dishwasher','Stove','Oven','Coffee station','Spices','Cookware','Dining table'],Outdoor:['Resort-style courtyard pool','Luxury lounge seating'],'Parking & Facilities':['Free valet parking','Pool','Elevator','24/7 Fitness center','Private cinema & screening room','Karaoke lounge','Game room','Art & music studio','24-hour security'],'Work & Tech':['Dedicated workspace','1GB high-speed internet','USB ports throughout'],Building:['Exposed brick walls','10-foot ceilings','Controlled access','Co-working spaces','Meeting rooms','Entertainment & arcade room'],Location:['Downtown Dallas','Near Farmers Market','Near Deep Ellum','AT&T Discovery District','Butler Brothers Building']},
    amenityPhotos: {'Smart TV (living room)':5,'Full kitchen':9,'Dishwasher':9,'Coffee station':11,'Microwave':15,'Smart TV (bedroom)':19,'Full-length mirror':25,'Clothing storage':27,'Dedicated workspace':37,'Washer':40,'Dryer':40,'24/7 Fitness center':43,'Pool':44,'Game room':51},
    photos: [
      '8e867888-7159-4313-b7c4-b64ff0fbd07e.png',
      'ffbb21b8-5e89-4658-bcb3-2bc399ee8e8e.png',
      '7d9a6051-8212-4b9e-bd5b-3e35f62e2f16.png',
      '94a6a3a7-4a2d-4824-9b35-c48ead279a28.png',
      'f178ad17-0c7e-414e-bd86-41b38ab788fc.png',
      'ccb42a9c-2734-4bec-bbd6-556d2a6ee375.png',
      'd6013af3-b747-45b4-9ea5-6ab0902c700a.jpeg',
      'e54b3ea3-5d1a-405f-8fbf-38938ba58a4a.jpeg',
      'de5ef0c9-3ca6-4722-9b56-50456c5f7268.png',
      '8f2df525-3bba-4aff-8e93-f563e7e39804.png',
      'f80a9c8f-1ba4-4deb-973f-5a72e88779e5.png',
      '93de7cf1-6903-4104-812f-abdfdde249db.png',
      '9a707629-9778-4344-8c77-df242154cdeb.jpeg',
      'f10eb581-3f35-4637-8757-208dca9b2435.png',
      'b99224fa-4194-46c1-aeb7-55eaafc98268.png',
      '13572235-1dd8-4f3b-abcc-0fc2728f6f2f.jpeg',
      '659b04b1-f272-49f3-9236-87c1e4aa5fd7.png',
      '4317e5f2-ff46-4cab-93ee-c87ce4e064b2.jpeg',
      'd8f1e185-1569-455a-b26d-0a07bec2dc22.jpeg',
      'df2c07dc-adc3-4f3c-8391-26c52a9d83c1.jpeg',
      'c668228a-5cfd-4493-a9c3-af26f74e575f.png',
      '712f17df-36bb-424e-99c8-dc4d964dfe3b.png',
      '7d447224-951e-46b3-828c-1b635421deb8.jpeg',
      'ccc2c434-b4a3-4695-bcde-fef5bae95d96.png',
      'b9857d4f-2532-4080-954a-5ee1f5eb5481.jpeg',
      'fcec8620-f8c6-4714-9249-78b2e89472d7.png',
      '451aa52c-6fc3-4613-aa8a-8dcda70e6f6c.png',
      '66858593-fb7c-4251-8845-08c7d58a4b23.jpeg',
      '767b42d3-8e59-477a-a3bf-41c1d23897a8.jpeg',
      'b22fe5d9-ff5b-4a64-a888-e6b3f7c5140e.png',
      'd7ba60fd-1455-4fea-89e7-87505edd3622.jpeg',
      '585cb183-437d-4e4c-81d4-cef6d1288713.jpeg',
      'bd378b7e-00e1-4f99-8a11-68ad16a5990f.png',
      'a55565c8-d7da-48cb-bf8b-7fd61e46346c.jpeg',
      'adb83a98-6a53-4048-b101-0ef7ea12cb4f.png',
      'ed58fc31-0ffa-46cf-848c-ddc45c366bb6.png',
      'ab7c2e12-ff35-4286-941a-4fe53e014e43.png',
      '1759b3d9-fde8-4d11-b167-3d876b62baa5.jpeg',
      '92ae9fcc-9b9f-4500-bd0f-9c8e65e05988.png',
      '6dc42c0f-f38c-4f77-9920-a4142c0f6a82.jpeg',
      '4fc2242c-fa32-4d81-9905-bd85e686e991.png',
      '5bb52bff-5754-48ee-a26e-d1b618df0254.jpeg',
      'd712c5be-0683-4aa2-a282-75a8db90dc0a.jpeg',
      'c34691ad-81b7-48bd-96a6-b78648242a3b.jpeg',
      'c0dd4bae-15b4-4bb8-a057-7c5763c362aa.jpeg',
      '569e164d-3d3c-4763-8c34-7d657dcaba4f.png',
      '322f943e-fbb0-4e7d-a0b9-1dc4f27628c1.jpeg',
      '6f26a567-6292-4462-8156-0efab6db306e.jpeg',
      '2ccc579a-9b17-4219-896b-b1229cd43380.jpeg',
      'b6c88164-457f-45ff-91e2-7d0b8e1a0de7.jpeg',
      '27a9b50c-120b-44f4-b231-d24845163457.jpeg',
      'f58b0127-fa24-409f-97b1-e34c629c3931.png',
      'db87b971-be0d-47e1-be18-3a1e093eec39.png',
      '66fd9af8-2184-43f9-9e05-523d1f5f410b.png',
      'be1b6604-3735-45b0-a921-687dd49b7dac.jpeg',
      'ee43abec-d053-40ea-b88f-78a358d477ec.png',
      '41fabb07-b043-47c1-945d-e72383da8117.png',
      '5414c779-859a-4c19-89f3-1b4e0454541e.jpeg',
      '25123892-fa41-4ff8-a0be-d8c6cc7c8a96.jpeg'
    ]
  },
  'cozy-designer': {
    name: 'Cozy Designer Suite',
    slug: 'cozy-designer',
    category: 'suite',
    city: 'Irving',
    state: 'Texas',
    hostingId: '1656911479326581139',
    guests: 3, beds: 1, baths: 1,
    rating: 4.89, reviews: 9,
    lat: 32.8758610678049, lng: -96.937335804104,
    isVilla: false,
    amenities: [
      { label: 'Soaking Tub', premium: true },
      { label: '65" TV', premium: true },
      { label: 'DART Rail', premium: true },
      { label: 'Lake Trails', premium: false },
      { label: 'Gym', premium: true },
      { label: 'Pool', premium: true }
    ],
    description: 'Steps from Toyota Music Factory, Water Street dining, and the Lake Carolyn trails. 10-foot ceilings, a fully stocked kitchen with a big prep island, deep soaking tub, and a living room you\'ll actually want to hang out in. DART rail is a 5-minute walk for easy access to DFW Airport and Downtown Dallas. Resort-style pool, 24/7 gym, covered parking. We handle all the supplies -- just show up.',
    fullAmenities: {Bathroom:['Bathtub','Deep soaking tub','Hair dryer','Cleaning products','Conditioner','Body soap','Bidet','Shower gel','Full-length mirror'],'Bedroom & Laundry':['Washer','Dryer','Essentials','Hangers','Bed linens','Extra pillows & blankets','Room-darkening shades','Iron','Drying rack','Clothing storage'],Entertainment:['65" Smart TV','Exercise equipment','Pool table','Theme room','Board games'],'Kitchen & Dining':['Full kitchen','Refrigerator','Microwave','Cooking basics','Dishes & silverware','Mini fridge','Freezer','Dishwasher','Stove','Oven','Coffee maker','Wine glasses','Toaster','Baking sheet','Dining table','Coffee'],Outdoor:['Patio or balcony','Outdoor furniture','Outdoor dining area','Shared BBQ grill','Sun loungers'],'Parking & Facilities':['Free parking','Pool','Elevator','Gym','Gated community'],'Location':['Lake access','Private entrance','Steps to DART rail','Toyota Music Factory nearby']},
    amenityPhotos: {'Coffee maker':4,'Board games':10,'Full kitchen':13,'Dishwasher':18,'Toaster':18,'Microwave':16,'Bathtub':21,'Washer':23,'Dryer':23,'Clothing storage':25,'Pool':27,'Gym':28,'65" Smart TV':1,'Refrigerator':15,'Iron':25},
    photos: [
      'fd9864bd-5a7f-4a14-997d-ca799df2850f.png',
      '46546182-9e9e-475d-bd14-3ca27823b1af.png',
      '7fc6f924-2e3a-4be6-874d-2be4bb232a33.jpeg',
      '5bf49e1c-74e1-4f26-aea4-aad9a7456210.png',
      '95e9f9a9-111a-4245-932b-dde0a60efd14.png',
      '089400a2-5c79-4691-bf66-e994f418167f.png',
      'f97a2735-5cce-4b30-aab3-c670fdc3e002.png',
      'c58f7e65-8dac-47c8-8233-2d18351c9c41.png',
      '16c5a890-5f75-4f7d-b3f0-fae5bdb94f60.png',
      'c0d048a4-38cf-4182-b955-cfd50b07edaa.jpeg',
      '46975f85-7704-4966-806a-135afe436803.jpeg',
      '7a325fde-d0be-4c89-ad05-013926bbf98e.png',
      '4832a41e-48e7-4a5b-af6e-1c90b06bedde.jpeg',
      'ffdef78e-166a-4e60-a20d-af8a9abb2847.jpeg',
      '5ae69a9c-fa81-4320-bbd7-9a707f3214da.png',
      'afb850b8-d6b5-478b-954d-ad3cfcad98d4.png',
      '5972d91b-d597-460e-965e-7da0823fabff.jpeg',
      '2c798f29-2b00-4903-b88b-6fb5af4a49e1.png',
      '9ffa7920-b0f6-479c-8a28-f5fb383ba428.png',
      'e0090857-45ce-4877-8edd-5d64839b9fc0.png',
      '84709410-c8d3-4aa7-a457-ce4565af3c4f.png',
      '906eef0c-6b72-4713-9c81-9e8df158d703.jpeg',
      'de97a3c2-86a4-44aa-a987-f59f0fb09273.jpeg',
      '02b44469-3233-4aff-a0a6-0890f2fa32e6.jpeg',
      '10db5be4-a628-4f62-aa60-14555be22ab1.png',
      'b0edba7c-57a6-49ce-9635-22323cb7dc9a.jpeg',
      '66581778-c057-41c8-a1f1-947084dc605e.png',
      '317aadf9-8b20-45d5-850b-599fea5427a7.png',
      'f7487bd2-1cb4-4f41-b7b2-1a20fa7af35c.png'
    ]
  },
  'designer-game': {
    name: 'Designer Game Suite',
    slug: 'designer-game',
    category: 'suite',
    city: 'Irving',
    state: 'Texas',
    hostingId: '1691507762565991335',
    guests: 3, beds: 1, baths: 1,
    rating: null, reviews: 1,
    lat: 32.8751259, lng: -96.9369134,
    isVilla: false,
    amenities: [
      { label: 'Sky Lounge', premium: true },
      { label: 'Mini Golf', premium: true },
      { label: 'Marble Finishes', premium: true },
      { label: 'EV Charging', premium: false },
      { label: 'Coffee Bar', premium: false },
      { label: 'DART Rail', premium: true }
    ],
    description: 'Designer one-bedroom in the heart of Las Colinas -- full marble finishes, soft candlelight, and the DART rail just steps from your door. Cozy up under layered comforters, brew from a fully stocked coffee bar, fire up the 65" TV, or break out the board games, mini golf, and a mini hoop. Cook in a chef-grade kitchen. Walk to Toyota Music Factory, Lake Carolyn, and Alamo Drafthouse. DFW Airport is 10 minutes by train.',
    fullAmenities: {Bathroom:['Bathtub','Hair dryer','Cleaning products','Shampoo','Conditioner','Dove body soap','Shower gel','Full-length mirror'],'Bedroom & Laundry':['Washer','Dryer','Essentials (eco-friendly)','Hangers','Bed linens','Extra pillows & blankets','Room-darkening shades','Iron','Drying rack','Clothing storage'],Entertainment:['65" Smart TV','Second TV in bedroom','Exercise equipment','Pool table','Theme room','Mini golf','Mini basketball hoop','Board games'],'Kitchen & Dining':['Full kitchen','Refrigerator','Microwave','Cooking basics','Dishes & silverware','Mini fridge','Freezer','Dishwasher','Electric stove','Oven','Keurig coffee machine','Wine glasses','Toaster','Baking sheet','Dining table','Coffee'],Outdoor:['Private patio or balcony','Outdoor furniture','Outdoor dining area','BBQ grill','Sun loungers'],'Parking & Facilities':['Free covered parking','Pool','Elevator','Gym','Gated community','EV charging stations'],Building:['Sky Lounge with skyline views','24/7 fitness center & yoga studio','Resort-style pool','On-site putting green','Clubhouse & game room'],'Location':['3-min walk to DART station','Lake Carolyn access','Alamo Drafthouse nearby','Toyota Music Factory']},
    amenityPhotos: {'Full-length mirror':19,'Board games':9,'Full kitchen':10,'Keurig coffee machine':13,'Microwave':14,'Refrigerator':12,'65" Smart TV':5,'Clothing storage':21,'Iron':21,'Bathtub':24,'Washer':28,'Dryer':28,'Gym':29,'Pool':30,'Mini basketball hoop':31,'Dishwasher':14},
    photos: [
      '80e3dcf4-ac70-4765-a5c8-f9c08d908cb4.png',
      '94b1c54b-c7c4-4165-b70c-285623ef5be8.png',
      'b716d376-c708-407f-b233-44184657bfb6.png',
      '29166219-5878-44bc-ab59-d13c1ce11a07.png',
      'f78f8f72-f6bb-41bc-b01c-ac6add4081d4.png',
      '7b56bd2d-2ad6-43b1-92cb-785ef9fbc25a.png',
      'bec987ee-0e35-42cf-bd34-e5c18fb655d9.png',
      '888e0caf-322e-418e-a2bd-cf9b8f86343e.png',
      '7bb5f8aa-6088-4ca7-accc-feab56064618.png',
      '65e39e41-8b69-49d6-a560-ab7cdf816e2a.png',
      '3fc5ca96-5c9c-48d1-a73f-c0370205819c.png',
      '40d329aa-4178-4ffe-a673-f2902f181d8d.png',
      '1f8fdc61-1f45-46b0-81ca-9cbea62b4d4a.png',
      '25f8f969-f092-4bff-ad8f-7510e74b09dd.png',
      'a85b0b0e-8ad0-4577-9b1e-e1d18d2cd745.png',
      'e32a374a-936d-455b-a609-567483316baf.png',
      '2ca282c3-0d14-4339-8611-dccb6a853358.png',
      'b1d1a84e-e7c7-47ae-bb64-bdf0f0c52b18.png',
      'bc1080b7-f594-4ec0-891e-7a285daa8166.png',
      'e0a022bc-1714-4a92-9851-afb3b5b2a940.png',
      '76a6dba6-6689-4781-845a-64b156c47334.jpeg',
      '0befff2f-9c99-4cbc-811b-12ca3b1f4c35.png',
      'b94047c8-22b3-43b6-9d9c-2381fa59ed99.png',
      '44675a4e-213a-40f9-8c4e-24cf6b0d5d4a.png',
      '40aa4173-3498-48a1-a7a6-1f5e3e7b85c5.png',
      '2bd51e06-9b25-42aa-b1d4-31be76c700b4.png',
      '500ffaa6-9262-40e1-a293-92e4b15e2c07.png',
      '564169ec-c5ab-45b8-8c9d-08740fd17379.jpeg',
      '328806b5-5e8a-4234-9e3a-fd2d67de58a2.png',
      '0a7a6a65-e33e-42f7-b8d4-c37a440908a3.png',
      '932bb8fb-b009-4abf-ae5f-ac7298698891.png',
      '1c8e9928-0fdc-462b-b1c6-34778bd9bda8.png',
      '50958b47-caf6-46f6-a5e8-75dd6fa93119.png'
    ]
  },
  'lake-view': {
    name: 'Gorgeous Luxury Lake View Suite',
    slug: 'lake-view',
    category: 'suite',
    city: 'Irving',
    state: 'Texas',
    hostingId: '1579365691674889946',
    guests: 3, beds: 1, baths: 1,
    rating: 4.92, reviews: 25,
    lat: 32.868187373138625, lng: -96.93422075361013,
    isVilla: false,
    amenities: [
      { label: 'Lake View', premium: true },
      { label: '27" Monitor', premium: true },
      { label: 'Wine Cooler', premium: true },
      { label: '500Mbps WiFi', premium: false },
      { label: 'Punching Bag', premium: false },
      { label: 'Pool', premium: true }
    ],
    description: 'Wake up to tranquil lake views in an ultra-high luxury yet irresistibly cozy 600 sq ft suite in Las Colinas. Designer interiors, refined finishes, and plush comfort. 65" Smart TV, dedicated workspace with 27" monitor, 500 Mbps fiber Wi-Fi. Steps to DART Orange Line, dining, gondola rides, trails, and more. Resort amenities: 24/7 gym, pool, billiards, game room, and conference spaces with lake views.',
    fullAmenities: {'Scenic Views':['Lake view from private balcony'],Bathroom:['Bathtub','Hair dryer','Cleaning products','Conditioner','Body soap','Shower gel','Full-length mirror'],'Bedroom & Laundry':['Washer','Dryer','Essentials','Hangers','Bed linens','Extra pillows & blankets','Room-darkening shades','Iron','Walk-in closet'],Entertainment:['65" Smart TV','Exercise equipment','Pool table','Theme room','UFC punching bag','Board games','Wine cooler'],'Kitchen & Dining':['Full kitchen','Refrigerator','Microwave','Cooking basics','Dishes & silverware','Mini fridge','Freezer','Dishwasher','Stove','Oven','Keurig coffee station','Toaster','Baking sheet','BBQ utensils','Dining table','Coffee'],'Work & Tech':['Dedicated workspace','27" mounted monitor','500 Mbps fiber WiFi'],Outdoor:['Private balcony','Outdoor kitchen','BBQ grill','Sun loungers'],'Parking & Facilities':['Free parking','Pool','Elevator','Gym','2-Story gym (24/7)','Business center & conference rooms','Smart lock entry'],'Location':['Waterfront','Lake access','Private entrance','Steps to DART Orange Line']},
    amenityPhotos: {'Keurig coffee station':8,'Board games':6,'Full kitchen':7,'Wine cooler':11,'Refrigerator':10,'Microwave':10,'Walk-in closet':13,'Iron':13,'Hair dryer':15,'Dedicated workspace':17,'27" mounted monitor':20,'65" Smart TV':18,'Washer':21,'Exercise equipment':22,'Gym':23,'Pool':24,'Sun loungers':24,'Pool table':25,'UFC punching bag':27,'Private balcony':1},
    photos: [
      'd4cb708a-3694-4e6f-bd63-6757450a95e0.png',
      'b5fe1afc-e3e3-445d-8c9c-c0d12ceb727c.jpeg',
      '4978cb0b-9144-4789-ae18-7a7822f7d99c.png',
      'f761a4f2-b2a1-4b26-aa28-7744c7aebf61.png',
      'c160bc46-1c53-4762-aa0a-7551bb21216e.jpeg',
      'a4378967-edda-42b0-815e-1394290750f2.jpeg',
      '23dc3027-a60d-4f65-b24d-da14d9090e89.png',
      'cc082589-4ee5-491e-b6ba-2c93e84b0a57.png',
      '61731f7c-ff37-4ae1-8515-fe74cb072343.png',
      'f31c1277-9f9d-4dd0-bcdf-70d04b63db04.jpeg',
      '7b1d6dc7-feaa-4beb-9241-464a3ec9f9aa.jpeg',
      'fbbb6191-c06b-44c0-84b1-7f5e3a2c23a1.jpeg',
      'bc00f64d-21d6-4907-93c2-bf91d3726c10.png',
      '05aa2270-e7b9-4269-a1f1-468f82d8a5ed.png',
      'beb4e0dc-6035-42a1-a5df-af609f3e499d.png',
      'f6e44ee9-a989-4ac8-a2b9-acd7713880cb.jpeg',
      '4b0be1b8-f953-4968-b2da-fdd70de84277.jpeg',
      '1a729f61-a2e8-4a71-b77f-c8d0711ee30e.jpeg',
      '1ed18b59-a8a7-41dc-9ecd-a97167dbf446.jpeg',
      '215b33bd-e810-45ed-8e6c-3946c2201d1d.jpeg',
      '0206f9cb-0e6b-4c1d-9863-fda86b06bab9.png',
      'bd64e520-ede8-4554-b87f-e40419c87ee0.png',
      '09827101-3a74-4445-a66e-19be02f26265.png',
      '623e2542-f69a-4254-9e15-1c09c8221483.png',
      '017e4670-5f73-462c-ad6d-6a01526fe46d.jpeg',
      '66ecca87-a6aa-4083-b10f-df80855890a6.png',
      'b4e37b38-c9dc-447e-a729-93969188df9d.png',
      '3e8bd5cf-653c-4b24-bdab-3216a32b99e5.png'
    ]
  },
  'executive': {
    name: 'Luxury Executive Living',
    slug: 'executive',
    category: 'suite',
    city: 'Richardson',
    state: 'Texas',
    hostingId: '1622247533469388804',
    guests: 5, beds: 1, baths: 1,
    rating: 4.95, reviews: 21,
    lat: 32.984401, lng: -96.710101,
    isVilla: false,
    amenities: [
      { label: '75" TV', premium: true },
      { label: 'EV Charger', premium: true },
      { label: 'Sky Lounge', premium: true },
      { label: 'Arcade Room', premium: false },
      { label: 'Fire Pit', premium: false },
      { label: 'DART Rail', premium: true }
    ],
    description: 'Soaring high ceilings with light pouring in. Fully stocked coffee station, private oversized patio, and a 3-minute walk to DART Station to go anywhere without needing your car. 75" Smart TV, dedicated desk with 27" monitor. Resort pool, 24/7 gym, sky lounge, arcade room -- all free. Sleeps 5. Everything you need, nothing you don\'t.',
    fullAmenities: {Bathroom:['Bathtub','Hair dryer','Cleaning products','Shampoo','Conditioner','Body soap','Shower gel','Full-length mirror'],'Bedroom & Laundry':['Washer','Dryer','Essentials','Hangers','Bed linens','Extra pillows & blankets','Room-darkening shades','Iron','Clothing storage','Air mattress available','Walk-in closet'],Entertainment:['75" Smart TV','Exercise equipment','Ping pong table','Pool table','Arcade games','Theme room','Board games','Star projector'],'Heating & Cooling':['Electric fireplace'],'Kitchen & Dining':['Full kitchen','Refrigerator','Microwave','Cooking basics','Dishes & silverware','Freezer','Dishwasher','Stove','Oven','Hot water kettle','Coffee maker','Wine glasses','Toaster','Baking sheet','BBQ utensils','Dining table','Coffee'],Outdoor:['Patio or balcony','Fire pit','Outdoor furniture','Outdoor dining area','Shared BBQ grill','Sun loungers'],'Parking & Facilities':['Free parking','Pool with tanning ledge','Elevator','EV charger','Gym with spin room'],Building:['Sky lounge with panoramic views','Arcade room & billiards lounge','Co-working spaces','Outdoor firepit & courtyard kitchen','Private pocket park'],'Location':['0.2mi to DART Galatyn Park','CityLine shopping next door','Near UT Dallas','Private entrance']},
    amenityPhotos: {'Star projector':1,'Electric fireplace':2,'Board games':6,'Coffee maker':9,'Full kitchen':10,'Microwave':15,'Refrigerator':10,'Patio or balcony':26,'Full-length mirror':19,'Walk-in closet':20,'Hair dryer':21,'Gym with spin room':28,'Pool with tanning ledge':29,'Sun loungers':29,'Sky lounge with panoramic views':30,'Co-working spaces':31,'Arcade games':32,'Pool table':33,'75" Smart TV':3},
    photos: [
      '93dafcdf-b571-4c4b-8eb5-4cbe3ce87677.jpeg',
      '89ccfecb-1862-4182-bd20-c4bbad80caef.png',
      '32484433-972c-47e0-8f71-74462c4ff6c6.png',
      'fca432a6-c703-4f76-a38f-429966930dca.png',
      '4623846d-d060-4e0e-9b6b-79ce0e3e0150.jpeg',
      '2f796afc-1784-4b2c-b871-7233cd347dd9.jpeg',
      '48d75aba-1d3a-4b74-9c58-354fdf012b6c.png',
      '2c4c6ba7-97b6-4e24-a8f3-22d187206bb5.jpeg',
      '3b3051d2-ff83-4c43-b4f6-fe3a3eee2edb.jpeg',
      '46bd1a12-c297-450c-813c-734d85be26c7.png',
      '1d77fb88-808e-4202-8224-abe02b70b989.png',
      'da58c93b-d4db-4696-b8b3-815d1fbca757.jpeg',
      '574fa453-2e6d-4c98-aafd-5b0433886e8f.png',
      '80fd19b7-2ead-4c54-aaf3-a789ac440dfb.jpeg',
      'ec99ba51-29c7-4616-b82c-4855a5093b41.png',
      'f8af5452-9666-4907-a39c-07c438ba3f63.png',
      'a818f74a-be97-4f4a-86df-b8198233aefd.png',
      'b1f68077-5234-470e-804b-9bc825f5f647.png',
      '804a0e54-f561-4e04-a6f7-5aabc726a43f.jpeg',
      'f13e365e-018d-4a43-aebe-116cac62d919.jpeg',
      'ee9d9278-c947-44de-963f-759dc89db0f8.png',
      'febd1f96-b1ea-445f-9972-6aa68bd870dc.jpeg',
      '59cfd6a2-6b19-452b-948f-01ed09afba51.png',
      'ca31f19c-2689-4b64-b5d8-1714d44c26b2.jpeg',
      'f603692c-be96-4688-8128-8da3ddda4a19.jpeg',
      '7863f6ca-df14-44be-a4a6-efa9242a7712.jpeg',
      '41a4b00f-3e81-4e5c-89f4-82af12c1af00.png',
      'e7984b71-dd78-4ecc-80e5-b030d3c43fe9.jpeg',
      'd133944b-1605-45d8-a844-c3731f3045fb.jpeg',
      '5bb56974-c9f6-4f32-bead-d8744a24996d.png',
      '115b3a6e-8344-41d3-b001-eaad10d55f5e.jpeg',
      'c796c9be-c3e8-44cd-a12f-03a8a6c5a31a.jpeg',
      'cfe26ff4-417a-4adc-86dc-4e1c157a922b.png',
      'dbeb219e-5bd2-405c-8ee9-1090fdcc9c1f.jpeg'
    ]
  },
  'stunning-lake': {
    name: 'Stunning Lake Views',
    slug: 'stunning-lake',
    category: 'suite',
    city: 'Irving',
    state: 'Texas',
    hostingId: '862596563097784023',
    guests: 3, beds: 1, baths: 1,
    rating: 4.83, reviews: 23,
    lat: 32.8686393, lng: -96.9340601,
    isVilla: false,
    amenities: [
      { label: 'Lake View', premium: true },
      { label: '1GB Fiber', premium: true },
      { label: 'Dual TVs', premium: true },
      { label: 'L-Shaped Couch', premium: false },
      { label: 'Pool', premium: true },
      { label: 'Gym', premium: true }
    ],
    description: 'Wake up to stunning lake views in this modern designer suite in Las Colinas. Private balcony, 65" Smart TV in living room plus 50" TV in bedroom. Massive L-shaped couch for epic streaming sessions. 1GB Fiber Wi-Fi, dedicated workspace with 27" monitor. Steps to DART Orange Line. 24/7 access to 2-story gym, waterfront pool, game room, and business center with conference rooms.',
    fullAmenities: {'Scenic Views':['Lake view from private balcony'],Bathroom:['Bathtub','Hair dryer','Cleaning products','Shampoo','Conditioner','Body soap','Shower gel','Full-length mirror'],'Bedroom & Laundry':['Washer','Dryer (in-unit)','Essentials','Hangers','Bed linens','Extra pillows & blankets','Room-darkening shades','Iron','Drying rack','Walk-in closet'],Entertainment:['65" Smart TV (living room)','50" Smart TV (bedroom)','Exercise equipment','Pool table','Board games','Mini basketball hoop'],'Kitchen & Dining':['Full kitchen','Refrigerator','Microwave','Cooking basics','Dishes & silverware','Freezer','Dishwasher','Stove','Oven','Keurig coffee station','Toaster','Baking sheet','BBQ utensils','Dining table','Coffee'],'Work & Tech':['Dedicated workspace','27" monitor','1GB Fiber Internet'],Outdoor:['Private balcony','Outdoor furniture','Outdoor dining area','Shared outdoor kitchen','BBQ grill'],'Parking & Facilities':['Free parking','Pool','Elevator','Gym','2-Story gym (24/7)','Business center','Smart lock entry'],'Location':['Waterfront','Lake access','Steps to DART Orange Line','24-hour housekeeping available']},
    amenityPhotos: {'Private balcony':0,'65" Smart TV (living room)':1,'Full-length mirror':2,'Board games':4,'Full kitchen':5,'Dishwasher':5,'Microwave':8,'Keurig coffee station':13,'Walk-in closet':15,'Iron':15,'Hair dryer':16,'Dedicated workspace':19,'27" monitor':19,'Exercise equipment':20,'Gym':21,'Pool':23,'Pool table':24,'BBQ grill':27},
    photos: [
      '9198323c-4b1b-49c9-a728-37d07c6c7658.jpeg',
      '888a837d-221c-422d-9286-aeaa2ba95d2a.jpeg',
      'f3df3c99-2d91-42db-9705-80968567f456.jpeg',
      '98efe0d1-aac5-4554-b4b8-84153d5df622.jpeg',
      'b76b23f6-3623-4aea-97f3-3c3dd903d629.jpeg',
      '9d2caa63-3829-4cc7-a019-3d6ca1a5b882.jpeg',
      '4260e8e2-f9ee-4820-890c-0f8edc4ef95c.jpeg',
      'b3897dcb-5b0d-4fff-8cc5-ce9579f152ff.jpeg',
      '3d6e90a5-e521-4f4c-b12a-b09f415eef7e.jpeg',
      '23041dc0-7b63-433d-91c8-15e14cd4a4bf.jpeg',
      '9e261182-070d-4223-9a5b-ab806c202fb9.jpeg',
      '8991b94c-d184-4bb5-aff4-c2516ff4a670.jpeg',
      'e0d098ae-a435-4b83-85ed-08fe81487f69.jpeg',
      '05630623-b2ed-4d81-aec7-6e8e8c61be61.jpeg',
      '57af5f40-9b15-4c16-946e-b2821d633df1.jpeg',
      'bc021c4d-d5aa-4251-a8d6-e1de40aca485.jpeg',
      '016fc28d-75be-4583-b494-d375432a7c60.jpeg',
      'f9f79444-ec4a-44c1-ae9c-b690370f061b.jpeg',
      '0790150c-c9d8-4168-9bbc-dc89401a45b2.jpeg',
      'fca0c998-8bf0-409e-bebe-95fa6ebb5872.jpeg',
      '289e15e1-2409-4e53-bf5b-f2be2dc47863.jpeg',
      'bc77a8c4-514c-4dd0-bc4d-df11df6406ea.jpeg',
      '44b8311c-ed9b-4239-af4c-601ee9fd52e6.jpeg',
      '80d97c23-010b-4ed4-bb1e-5f5b3cf4eb50.png',
      '801da323-6bfb-4ef5-8686-3f48ef54aeaa.png',
      '8f7ab31c-9823-41cb-981c-70296403d58a.png',
      '4886a581-3213-4c65-ac6d-9e21930131ad.png',
      '9cd45fb9-89b9-4f2a-9295-d7dc4ee73625.png'
    ]
  }
};

const GUESTY_MAP = {
  'regent-villa': '6a3874d5bcc80700147920ca',
  'regent-skyline': '6a4edd9fab1bbe001491a4e4',
  'cozy-designer': '6a29dcff12cbdd0015a65a7d',
  'designer-game': '6a29dc9862094a0012dfda6f',
  'lake-view': '6a29dcfa14fca300148799c2',
  'executive': '6a29dc944052f30019465228',
  'stunning-lake': '6a29dc8f5f85640014dfe380',
};

// ── Standalone Property Pages ──
app.get('/property/:slug', (req, res) => {
  const slug = req.params.slug;
  const prop = PROPERTY_DATA[slug];
  if (!prop) {
    return res.status(404).send(`<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Property Not Found</title>
<style>body{font-family:-apple-system,BlinkMacSystemFont,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;background:#f5f5f5;color:#333}
.box{text-align:center;padding:40px}.box h1{font-size:120px;margin:0;color:#ccc}.box p{font-size:18px;margin:12px 0}
.box a{color:#b08d57;text-decoration:none;font-weight:600}</style></head>
<body><div class="box"><h1>404</h1><p>Property not found.</p><p><a href="/">Browse all properties</a></p></div></body></html>`);
  }

  const templatePath = path.join(__dirname, 'public', 'property.html');
  if (!fs.existsSync(templatePath)) {
    return res.status(500).send('Property template not found');
  }
  let html = fs.readFileSync(templatePath, 'utf8');

  const CDN = 'https://a0.muscache.com/im/pictures/hosting/Hosting-';
  const coverPhoto = prop.photos[0];
  const coverImage = `${CDN}${prop.hostingId}/original/${coverPhoto}?im_w=1200`;
  const guestyUrl = `https://regent.guestybookings.com/en/properties/${GUESTY_MAP[slug] || ''}`;
  const ogUrl = `https://bookwithregent.com/property/${slug}`;

  // Escape for safe embedding in JS single-quoted string literal
  const propertyJson = JSON.stringify(prop)
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/<\//g, '<\\/');

  html = html
    .replace(/\{\{PROPERTY_JSON\}\}/g, propertyJson)
    .replace(/\{\{SLUG\}\}/g, slug)
    .replace(/\{\{NAME\}\}/g, prop.name)
    .replace(/\{\{DESCRIPTION\}\}/g, prop.description)
    .replace(/\{\{CITY\}\}/g, prop.city)
    .replace(/\{\{STATE\}\}/g, prop.state)
    .replace(/\{\{GUESTS\}\}/g, String(prop.guests))
    .replace(/\{\{BEDS\}\}/g, String(prop.beds))
    .replace(/\{\{BATHS\}\}/g, String(prop.baths))
    .replace(/\{\{HOSTING_ID\}\}/g, prop.hostingId)
    .replace(/\{\{COVER_IMAGE\}\}/g, coverImage)
    .replace(/\{\{GUESTY_BOOKING_URL\}\}/g, guestyUrl)
    .replace(/\{\{OG_URL\}\}/g, ogUrl)
    .replace(/\{\{IS_VILLA\}\}/g, String(prop.isVilla))
    .replace(/\{\{RATING\}\}/g, prop.rating !== null ? String(prop.rating) : '')
    .replace(/\{\{REVIEWS\}\}/g, String(prop.reviews))
    .replace(/\{\{LAT\}\}/g, String(prop.lat))
    .replace(/\{\{LNG\}\}/g, String(prop.lng))
    .replace(/\{\{CATEGORY\}\}/g, prop.category);

  res.send(html);
});

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

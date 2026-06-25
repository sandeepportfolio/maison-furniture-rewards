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
    res.json({ success: true, id: r.lastInsertRowid });
  } catch (err) {
    console.error('Submit error:', err);
    res.status(500).json({ error: 'Submission failed' });
  }
});

// ── GUESTY (live availability + booking) ──

// Validation helpers
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
function isValidDate(s) {
  if (!DATE_RE.test(s)) return false;
  const d = new Date(s + 'T00:00:00Z');
  return !isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}
function todayUTC() { return new Date().toISOString().slice(0, 10); }

// List the bookable properties (live data from Guesty, cached).
app.get('/api/guesty/listings', async (req, res) => {
  try {
    res.json({ listings: await guesty.getListings() });
  } catch (err) {
    console.error('Guesty listings error:', err.status || '', err.message);
    res.status(502).json({ error: 'Could not load listings' });
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
    res.json({ listingId, from, to, days });
  } catch (err) {
    console.error('Guesty calendar error:', err.status || '', err.message);
    res.status(502).json({ error: 'Could not load availability' });
  }
});

// Live price quote for a stay.
//   POST { listing, checkIn, checkOut, guests }
app.post('/api/guesty/quote', async (req, res) => {
  try {
    const { listing, checkIn, checkOut } = req.body || {};
    const guests = Math.max(1, parseInt(req.body?.guests, 10) || 1);
    const listingId = guesty.resolveListingId(listing);
    if (!listingId) return res.status(400).json({ error: 'Unknown listing' });
    if (!isValidDate(checkIn) || !isValidDate(checkOut)) {
      return res.status(400).json({ error: 'Invalid dates' });
    }
    if (checkOut <= checkIn) return res.status(400).json({ error: 'Check-out must be after check-in' });
    if (checkIn < todayUTC()) return res.status(400).json({ error: 'Check-in cannot be in the past' });

    const { summary } = await guesty.createQuote({ listingId, checkIn, checkOut, guests });
    if (!summary.total) return res.status(409).json({ error: 'No price available for those dates' });
    res.json(summary);
  } catch (err) {
    const detail = err.body?.error?.message || err.body?.message;
    console.error('Guesty quote error:', err.status || '', err.message);
    // Surface Guesty's user-facing validation (e.g. min-nights) when present.
    if (err.status === 400 && detail) return res.status(400).json({ error: detail });
    res.status(502).json({ error: 'Could not get a price for those dates' });
  }
});

// Booking request. Re-quotes server-side for integrity, records the request,
// and completes an instant reservation when a Guesty payment token (ccToken)
// is supplied. Without a token the request is captured for the host to confirm.
//   POST { listing, checkIn, checkOut, guests, guest:{firstName,lastName,email,phone}, ccToken? }
app.post('/api/guesty/reservation', async (req, res) => {
  try {
    const { listing, checkIn, checkOut, guest, ccToken } = req.body || {};
    const guests = Math.max(1, parseInt(req.body?.guests, 10) || 1);
    const listingId = guesty.resolveListingId(listing);
    if (!listingId) return res.status(400).json({ error: 'Unknown listing' });
    if (!isValidDate(checkIn) || !isValidDate(checkOut) || checkOut <= checkIn) {
      return res.status(400).json({ error: 'Invalid dates' });
    }
    if (checkIn < todayUTC()) return res.status(400).json({ error: 'Check-in cannot be in the past' });

    const g = guest || {};
    const email = (g.email || '').trim().toLowerCase();
    const firstName = (g.firstName || '').trim();
    const lastName = (g.lastName || '').trim();
    if (!email.includes('@')) return res.status(400).json({ error: 'A valid email is required' });
    if (!firstName) return res.status(400).json({ error: 'First name is required' });

    const meta = Object.values(guesty.LISTINGS).find(l => l.id === listingId);

    // Always re-quote server-side — never trust a price from the client.
    const { summary } = await guesty.createQuote({ listingId, checkIn, checkOut, guests });

    const row = db.prepare(`
      INSERT INTO booking_requests
        (listing_id, listing_name, guest_name, guest_email, guest_phone,
         check_in, check_out, guests, nights, total, currency, quote_id, status, message)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(
      listingId, meta ? meta.name : '', `${firstName} ${lastName}`.trim(), email, (g.phone || '').trim(),
      checkIn, checkOut, guests, summary.nights, summary.total, summary.currency,
      summary.quoteId, 'requested', (g.message || '').trim()
    );
    const requestId = row.lastInsertRowid;

    // If a payment token is present, complete an instant reservation in Guesty.
    if (ccToken) {
      try {
        const reservation = await guesty.createInstantReservation({
          quoteId: summary.quoteId,
          ratePlanId: summary.ratePlanId,
          guest: { firstName, lastName, email, phone: (g.phone || '').trim() },
          ccToken,
        });
        const resId = reservation._id || reservation.reservationId;
        db.prepare("UPDATE booking_requests SET status='confirmed', guesty_reservation_id=? WHERE id=?")
          .run(resId || null, requestId);
        return res.json({ success: true, status: 'confirmed', requestId, reservationId: resId, quote: summary });
      } catch (resErr) {
        console.error('Guesty reservation error:', resErr.status || '', resErr.message);
        db.prepare("UPDATE booking_requests SET status='failed' WHERE id=?").run(requestId);
        const detail = resErr.body?.error?.message || resErr.body?.message;
        return res.status(502).json({ error: detail || 'Payment could not be processed', requestId });
      }
    }

    // No payment token: this is a request-to-book the host will confirm.
    res.json({ success: true, status: 'requested', requestId, quote: summary });
  } catch (err) {
    const detail = err.body?.error?.message || err.body?.message;
    console.error('Guesty booking error:', err.status || '', err.message);
    if (err.status === 400 && detail) return res.status(400).json({ error: detail });
    res.status(502).json({ error: 'Could not complete the booking request' });
  }
});

// ── ADMIN (public, no auth) ──
app.get('/api/admin/booking-requests', (req, res) => {
  res.json(db.prepare('SELECT * FROM booking_requests ORDER BY created_at DESC').all());
});

app.get('/api/admin/submissions', (req, res) => {
  const { status } = req.query;
  let q = 'SELECT * FROM submissions';
  const p = [];
  if (status && status !== 'all') { q += ' WHERE status = ?'; p.push(status); }
  q += ' ORDER BY created_at DESC';
  res.json(db.prepare(q).all(...p));
});

app.post('/api/admin/update', (req, res) => {
  const { id, status, notes } = req.body;
  if (!id || !status) return res.status(400).json({ error: 'id and status required' });
  db.prepare("UPDATE submissions SET status = ?, notes = COALESCE(?, notes), processed_at = datetime('now') WHERE id = ?")
    .run(status, notes || null, id);
  res.json({ success: true });
});

app.delete('/api/admin/delete/:id', (req, res) => {
  const sub = db.prepare('SELECT proof_filename FROM submissions WHERE id = ?').get(req.params.id);
  if (sub && sub.proof_filename) {
    const fp = path.join('uploads', sub.proof_filename);
    if (fs.existsSync(fp)) fs.unlinkSync(fp);
  }
  db.prepare('DELETE FROM submissions WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

app.get('/api/admin/stats', (req, res) => {
  const total = db.prepare('SELECT COUNT(*) as c FROM submissions').get().c;
  const g = (s) => db.prepare('SELECT COUNT(*) as c FROM submissions WHERE status = ?').get(s).c;
  res.json({ total, pending: g('pending'), sent: g('sent'), rejected: g('rejected'), approved: g('approved') });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`\n  Regent Review Portal`);
  console.log(`  Local:  http://localhost:${PORT}`);
  console.log(`  Admin:  http://localhost:${PORT}/admin.html\n`);
});

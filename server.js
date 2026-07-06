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

// ── MESSAGES / CONTACT ──

// Public: submit a contact / message form.
app.post('/api/messages', (req, res) => {
  try {
    const { name, email, phone, property, message } = req.body || {};
    if (!email || !email.includes('@')) {
      return res.status(400).json({ error: 'A valid email is required' });
    }
    if (!message || !message.trim()) {
      return res.status(400).json({ error: 'Message is required' });
    }
    const stmt = db.prepare(
      'INSERT INTO messages (name, email, phone, property, message) VALUES (?, ?, ?, ?, ?)'
    );
    const r = stmt.run(
      (name || '').trim(),
      email.trim().toLowerCase(),
      (phone || '').trim(),
      (property || '').trim(),
      message.trim()
    );
    res.json({ success: true, id: r.lastInsertRowid });
  } catch (err) {
    console.error('Message submit error:', err);
    res.status(500).json({ error: 'Failed to save message' });
  }
});

// Admin: list messages, optionally filtered by ?status=
app.get('/api/admin/messages', (req, res) => {
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
app.patch('/api/admin/messages/:id', (req, res) => {
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

// ── ADMIN (public, no auth) ──
app.get('/api/admin/booking-requests', (req, res) => {
  res.json(db.prepare('SELECT * FROM booking_requests ORDER BY created_at DESC').all());
});

// Alias so the bookings list is also available at /api/admin/bookings.
app.get('/api/admin/bookings', (req, res) => {
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
  console.log(`  Admin:  http://localhost:${PORT}/admin.html\n`);

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

const express = require('express');
const multer = require('multer');
const path = require('path');
const crypto = require('crypto');
const fs = require('fs');
const Database = require('better-sqlite3');

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

// ── ADMIN (public, no auth) ──
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
  console.log(`\n  MAISON Review Portal`);
  console.log(`  Local:  http://localhost:${PORT}`);
  console.log(`  Admin:  http://localhost:${PORT}/admin.html\n`);
});

# Security Audit Report — bookwithregent.com

**Date:** July 9, 2026  
**Scope:** Full-stack review (Express backend, Guesty integration, frontend, configuration)  
**Mode:** Read-only — no code was modified  

---

## Summary

| Severity | Count |
|----------|-------|
| CRITICAL | 4 |
| HIGH     | 5 |
| MEDIUM   | 5 |
| LOW      | 4 |

---

## CRITICAL Findings

### C-1. Admin API endpoints have zero authentication

**Files:** `server.js:487–528`

Every `/api/admin/*` route is publicly accessible without any authentication. The comment on line 487 literally reads `// ── ADMIN (public, no auth) ──`. Any internet user can:

- Read all booking requests, guest names, emails, phone numbers, and payment details (`GET /api/admin/booking-requests`)
- Read all reward submissions (`GET /api/admin/submissions`)
- Read all contact messages (`GET /api/admin/messages`)
- Modify submission statuses (`POST /api/admin/update`)
- Permanently delete submissions and uploaded proof files (`DELETE /api/admin/delete/:id`)
- Modify messages and mark them as replied (`PATCH /api/admin/messages/:id`)

This exposes personally identifiable information (PII) for every guest who has booked, submitted a review, or sent a message. It also allows an attacker to delete all evidence of reward submissions.

**Remediation:** Implement authentication (e.g., session-based with a login page, or an API key checked via middleware). Protect all `/api/admin/*` routes behind an auth guard.

---

### C-2. Stored XSS via `showBookingMsg()` — server error messages rendered as raw HTML

**File:** `public/index.html:2667–2671`

```javascript
function showBookingMsg(msg, type) {
  const el = document.getElementById('bookingMsg');
  if (!msg) { el.innerHTML = ''; return; }
  el.innerHTML = `<div class="booking-msg ${type||''}">${msg}</div>`;
}
```

This function is called with `err.message` (lines 2425, 2610, 2639), which originates from server responses like `data.error`. The server forwards Guesty API error messages verbatim in several places (e.g., `server.js:206`, `server.js:387–388`). If Guesty ever returns a message containing HTML/script tags, or if an attacker crafts a request that triggers an error with injected content, it will execute in the user's browser.

**Remediation:** Use `textContent` instead of `innerHTML`, or HTML-escape the message before insertion.

---

### C-3. Reflected XSS in booking confirmation — `data.note` injected as raw HTML

**File:** `public/index.html:2656–2662`

```javascript
document.getElementById('confirmationDetails').innerHTML =
  `...${data.note ? '<br><em ...>' + data.note + '</em>' : ''}`;
```

The `data.note` field comes from the server response (`server.js:377`) and is concatenated directly into an `innerHTML` assignment without escaping. An attacker who can manipulate the server response (or a compromised upstream API) could inject arbitrary scripts.

**Remediation:** Escape `data.note` before embedding, or use DOM methods to set text content.

---

### C-4. XSS via Ticketmaster event data rendered without sanitization

**File:** `public/index.html:3453–3271`

Event data fetched from the Ticketmaster API is rendered directly into HTML via `innerHTML`:

```javascript
grid.innerHTML = events.slice(0, 8).map((ev, i) => {
  // ...
  return `<a href="${ev.url}" ...>
    <div class="event-name">${ev.name}</div>
    <span>... ${ev.venue}</span>
    ...`;
}).join('');
```

Fields `ev.name`, `ev.venue`, `ev.url`, and `ev.time` are all inserted raw. If the Ticketmaster API is compromised or returns unexpected content, this is a direct XSS vector. The `ev.url` field in the `href` attribute is especially dangerous — a `javascript:` URL would execute code on click.

**Remediation:** HTML-escape all externally-sourced text before inserting into templates. Validate that URLs begin with `https://`.

---

## HIGH Findings

### H-1. No rate limiting on any endpoint

**File:** `server.js` (entire file)

There is no rate limiting middleware (`express-rate-limit` or similar) on any route. This leaves every endpoint vulnerable to:

- Brute-force abuse of the booking system (mass reservation spam)
- Denial of service via rapid requests to Guesty-proxied endpoints (which also risks exhausting Guesty API quotas)
- Mass file uploads via `/api/submit` (limited only by the 10 MB per-file cap)
- Abuse of the contact form for spam flooding

**Remediation:** Add `express-rate-limit` with appropriate windows for public endpoints (e.g., 10 submissions/hour for `/api/submit`, 30 quotes/minute for `/api/guesty/quote`).

---

### H-2. No CSRF protection on state-changing endpoints

**Files:** `server.js:119, 288, 396, 506, 514` (all POST/PATCH/DELETE routes)

No CSRF tokens are required on any form submission or API call. Since the admin panel has no authentication (C-1), this is partially moot for admin routes — but the public endpoints (`/api/submit`, `/api/messages`, `/api/guesty/reservation`) are also unprotected. A malicious page could submit a booking or contact message on behalf of a visiting user.

**Remediation:** After adding authentication, implement CSRF tokens (e.g., `csurf` middleware or double-submit cookie pattern).

---

### H-3. No security headers (CSP, X-Frame-Options, HSTS, etc.)

**File:** `server.js` (entire file), `package.json`

The application sets no security headers at all. There is no `helmet` dependency, and no manual `res.setHeader()` calls for:

- `Content-Security-Policy` — allows inline scripts and third-party resource loading without restriction
- `X-Frame-Options` — the site can be embedded in iframes for clickjacking attacks
- `X-Content-Type-Options` — browsers may MIME-sniff uploaded files
- `Strict-Transport-Security` — no HSTS even though deployed on Render (HTTPS)
- `Referrer-Policy` — full referrer URLs may leak to third parties
- `Permissions-Policy` — no restrictions on browser features

**Remediation:** Install and configure `helmet` with a strict CSP allowing only the specific external origins needed (Stripe, Leaflet CDN, Google Fonts, Ticketmaster).

---

### H-4. Uploaded files served publicly without access control

**File:** `server.js:108`

```javascript
app.use('/uploads', express.static('uploads'));
```

All uploaded proof screenshots are served as static files at predictable URLs. Since filenames follow the pattern `proof-{timestamp}-{8 hex chars}.{ext}` (line 91–93), the random component is only 32 bits — feasible to enumerate. Any user can access other users' uploaded review screenshots, which may contain personal account information.

**Remediation:** Serve uploads through an authenticated route, or use a longer random filename (e.g., `crypto.randomUUID()`).

---

### H-5. No HTTPS enforcement in application code

**File:** `server.js` (entire file)

The Express server does not redirect HTTP to HTTPS, nor does it set `Strict-Transport-Security`. While Render's infrastructure may handle TLS termination, the application itself:

- Sets no HSTS header to prevent downgrade attacks
- Does not mark cookies as `Secure` (no cookies are used, but the absence of the pattern is a concern for future additions)
- The keep-alive ping (line 637–644) uses the protocol from `RENDER_EXTERNAL_URL`, which could be HTTP

**Remediation:** Add HSTS header via `helmet`. If using cookies in the future, set `secure: true` and `sameSite: 'strict'`.

---

## MEDIUM Findings

### M-1. OAuth token stored in plaintext on disk

**File:** `guesty.js:21, 67–71`

```javascript
const TOKEN_FILE = path.join(__dirname, 'db', 'guesty-token.json');
// ...
fs.writeFileSync(TOKEN_FILE, JSON.stringify({
  token: cachedToken, expiry: tokenExpiry
}), { mode: 0o600 });
```

The Guesty OAuth access token is persisted to `db/guesty-token.json` in plaintext. While the file permissions are restrictive (`0o600`), this token grants full API access to the Guesty account. If the server is compromised or the filesystem is exposed, the token is immediately usable. The `db/` directory is gitignored, which is good, but on a shared hosting environment this remains a risk.

**Remediation:** Consider encrypting the token at rest, or relying solely on in-memory caching and accepting the occasional extra token fetch on cold start.

---

### M-2. Guesty API error details forwarded to clients

**Files:** `server.js:203–208, 250–253, 274–278, 357–358, 385–388`

Several routes surface raw Guesty API error messages to the frontend:

```javascript
const detail = err.body?.error?.message || err.body?.message;
if (err.status === 400 && detail) return res.status(400).json({ error: detail });
```

These messages may reveal internal API structure, listing IDs, or implementation details that help an attacker understand the backend architecture.

**Remediation:** Map known Guesty errors to generic user-facing messages. Log full details server-side only.

---

### M-3. File upload extension validation is a denylist, not an allowlist (plus no content-type verification)

**File:** `server.js:95–104`

```javascript
fileFilter: (req, file, cb) => {
  const ok = ['.jpg','.jpeg','.png','.gif','.webp','.heic'].includes(
    path.extname(file.originalname).toLowerCase()
  );
  cb(null, ok);
}
```

While this is technically an allowlist of extensions, it only checks the file extension — not the actual file content (magic bytes / MIME type). A user could upload a `.png` file that is actually an HTML file or an SVG with embedded JavaScript. Combined with the static file serving (H-4), this could be exploited for stored XSS if a browser renders the file based on content sniffing.

**Remediation:** Validate file magic bytes (e.g., using `file-type` npm package). Set `X-Content-Type-Options: nosniff` header. Serve uploads with `Content-Disposition: attachment`.

---

### M-4. Weak email validation

**Files:** `server.js:122, 239, 303, 399`

Email validation throughout the application consists only of:

```javascript
if (!email || !email.includes('@'))
```

This accepts inputs like `@`, `a@`, `@@@@`, and arbitrarily long strings. No length limit, no format verification, no domain check. This affects the reward submission, guest creation, booking, and contact form endpoints.

**Remediation:** Use a proper email validation regex or library (e.g., `validator.js`). Add a maximum length constraint.

---

### M-5. No input length limits on text fields

**Files:** `server.js:119–131, 396–420, 288–391`

No server-side length limits exist on text inputs like `name`, `message`, `notes`, or `phone`. An attacker could submit megabytes of text in a single field, potentially causing:

- Database bloat
- Slow query performance
- Memory exhaustion during string operations

The `express.json()` middleware (line 106) uses the default 100KB body limit, but that still allows very large individual field values.

**Remediation:** Validate and truncate field lengths server-side (e.g., name ≤ 100 chars, message ≤ 5000 chars).

---

## LOW Findings

### L-1. Admin panel (admin.html) is publicly accessible

**File:** `server.js:107` + `public/admin.html`

The admin panel HTML file is served as a static file and is accessible to anyone at `/admin.html`. While the underlying API endpoints are the real vulnerability (C-1), the admin UI itself reveals the application's internal structure, data schema, and management capabilities to any visitor.

**Remediation:** Move `admin.html` behind authentication middleware. Do not serve it as a static file.

---

### L-2. console.error may log sensitive data in production

**Files:** `server.js:129, 150, 180, 204, 250, 274, 357, 386, 602`

Multiple `console.error()` calls log raw error objects that could contain request bodies, API responses, or stack traces:

```javascript
console.error('Submit error:', err);
console.error('Message submit error:', err);
```

On Render (or any logging platform), these end up in persistent logs that may be accessible to operators or through log management tools.

**Remediation:** Sanitize logged data. Avoid logging full error objects in production. Use a structured logger with sensitivity filtering.

---

### L-3. DELETE endpoint does not validate status before deletion

**File:** `server.js:514–522`

The `/api/admin/delete/:id` endpoint deletes any submission regardless of its status. There is no confirmation step, no soft-delete, and no audit trail. Combined with the lack of authentication (C-1), any user can permanently destroy all submissions and their associated uploaded files.

**Remediation:** Implement soft-delete (mark as deleted rather than removing). Add an audit log. Require authentication.

---

### L-4. Ticketmaster API key included in server-side URL without validation

**File:** `server.js:551–557`

```javascript
const apiKey = process.env.TICKETMASTER_API_KEY;
// ...
const url = `...?apikey=${apiKey}&latlong=${lat},${lng}&radius=${radius}...`;
```

While the API key is not exposed to the frontend (good), the `lat`, `lng`, and `radius` query parameters from user input are only type-checked (`parseFloat`, `parseInt`) but not range-validated. Extreme values could trigger unexpected behavior in the Ticketmaster API.

**Remediation:** Validate coordinate ranges (lat: -90 to 90, lng: -180 to 180) and cap radius to a reasonable maximum.

---

## Positive Observations

Several security practices are already in place:

- **SQL injection protection:** All database queries use parameterized statements via `better-sqlite3`'s `.prepare()` with `?` placeholders — no string concatenation.
- **Guesty API credentials** are loaded from environment variables only, never hardcoded, and never returned to clients (guesty.js:7–8).
- **Listing allowlist** (guesty.js:28–48) prevents the server from being used as an open proxy to arbitrary Guesty listings.
- **Admin panel escapes output** using the `esc()` function (admin.html:406) for all user-generated content.
- **File upload size limit** is set to 10 MB (server.js:97).
- **OAuth token caching** includes deduplication of concurrent requests (guesty.js:87) and proper expiry handling with a 60-second buffer.
- **Stripe card tokenization** is done client-side via Stripe.js — raw card numbers never reach the server.
- **`.env` is gitignored** (`.gitignore:6`), preventing credential commits.
- **Server-side re-quoting** (server.js:308–309) — the booking flow never trusts a price from the client.
- **npm audit reports 0 vulnerabilities** in current dependencies.

---

## Environment Variables Present in `.env`

| Key | Status |
|-----|--------|
| `GUESTY_CLIENT_ID` | Set (value present) |
| `GUESTY_CLIENT_SECRET` | Set (value present) |
| `NOTIFY_EMAIL` | Commented out |
| `TICKETMASTER_API_KEY` | Defined but empty |

---

## Priority Remediation Order

1. **Immediately:** Add authentication to all `/api/admin/*` routes (C-1)
2. **Immediately:** Fix XSS in `showBookingMsg`, `showBookingConfirmation`, and event rendering (C-2, C-3, C-4)
3. **This week:** Add `helmet` for security headers (H-3), rate limiting (H-1)
4. **This week:** Restrict upload file serving (H-4), add CSRF protection (H-2)
5. **Soon:** Improve input validation across all endpoints (M-4, M-5)
6. **Soon:** Encrypt token storage, sanitize error forwarding (M-1, M-2, M-3)

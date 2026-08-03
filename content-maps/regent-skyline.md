# Content Map — Regent Skyline

**Slug:** `regent-skyline` · **URL:** `/glance/regent-skyline` · **Canonical:** `https://bookwithregent.com/property/regent-skyline`

Sources of truth (nothing here comes from the design file):
- `server.js:3508–3592` — `PROPERTY_DATA['regent-skyline']`
- `server.js:3885` — `GUESTY_MAP['regent-skyline']`
- `server.js:3973–4022` — `renderGlancePage()` template substitution
- `public/glance.html` — markup, per-slug JS constants, all rendering logic

> **Naming note:** the task brief said "Regent Skyline / stunning-lake". Those are two
> different properties. `stunning-lake` is **Regent Lakefront** (Las Colinas). Regent
> Skyline is `regent-skyline`, and its Guesty id `6a4edd9fab1bbe001491a4e4` matches the
> one in the design file. This map is for `regent-skyline`.

---

## 1. Identity

| Field | Live value | Source |
|---|---|---|
| Name (`<h1>`) | `Regent Skyline` | PROPERTY_DATA.name |
| Location line | `DALLAS, TEXAS — SLEEPS 5` | glance.html:525 — `city.toUpperCase() + ', ' + state.toUpperCase() + ' — SLEEPS ' + guests` |
| Tag line (spec chips) | `SKYLINE VIEWS · VALET · CINEMA · POOL` | `GLANCE_TAGS['regent-skyline']` glance.html:502 |
| Hero caption | `FIG. 01 — THE LOFT` | `HERO_CAPTIONS['regent-skyline']` glance.html:491 |
| Section tagline (N°1) | `Millionaire views.` / `Industrial soul.` (2 lines, `<br>`) | `taglines['regent-skyline']` glance.html:612 |
| City / State | `Dallas` / `Texas` (abbrev `TX` in N°5 header) | PROPERTY_DATA + glance.html:901 |
| Category | `suite` | PROPERTY_DATA.category |
| isVilla | `false` | PROPERTY_DATA.isVilla |
| Airbnb hostingId | `1725649500272518567` | PROPERTY_DATA.hostingId |
| Guesty listing id | `6a4edd9fab1bbe001491a4e4` | GUESTY_MAP |
| Footer line | `REGENT · DALLAS, TEXAS` | glance.html:639 |

### Design-file mismatches to ignore
- ✗ "BUTLER BROTHERS BUILDING — EST. 1910" eyebrow — **not a field on this page.** Butler Brothers appears only inside `description` and the N°5 neighbourhood copy/tag.
- ✗ Header nav (`THE RESIDENCE / AMENITIES / SLEEP / NEIGHBOURHOOD / CONTACT`) — **does not exist** on the glance page today. See §12.
- ✗ Stat row "1910 / 10 FT / 1 GB / 74 AMENITIES" — 1910 and 10 FT are not data fields; the amenity count is **60**, not 74.

---

## 2. Capacity

| Field | Live value |
|---|---|
| Guests | **5** |
| Bedrooms (`PROP.beds`) | **1** |
| Baths | **1** |
| Total beds (computed, glance.html:647 `countTotalBeds()`) | **2** — `1 king bed` → 1, `Air mattress` → 1 |
| Ticker (marquee) items, in order | `1 BEDROOM ✦ 2 BEDS ✦ 1 BATH ✦ 5 GUESTS ✦` (duplicated once for seamless loop; `PET-FRIENDLY` omitted — not a villa) |
| N°3 section right-hand summary | `1 BR · 2 BEDS` |

> ⚠️ `beds` in PROPERTY_DATA means **bedrooms**, not beds. The design file's "1 KING BED" chip
> happens to be true but is not a field — the ticker renders `2 BEDS` (the computed total).

---

## 3. Description (verbatim, one paragraph)

> Experience millionaire-level luxury in a cinematic loft in downtown Dallas. 1910 industrial charm — exposed brick and soaring 10-foot ceilings — meets bespoke modern design. Free valet parking, resort-style pool, private cinema, 24/7 gym, and a fully stocked kitchen. Steps from the Dallas Farmers Market and Deep Ellum. The premier luxury Airbnb in the Butler Brothers Building.

Rendered as `textContent` into `#glDesc`. Also used verbatim for `<meta name="description">`, `og:description`, `twitter:description`.

### Design-file mismatches
- ✗ The pull-quote *"Every square inch designed with a millionaire-level aesthetic in mind — like a private suite at a five-star hotel."* — **not in the data.** No quote field exists.
- ✗ The two "resort floor" paragraphs — invented copy.

---

## 4. Gallery — 59 photos

CDN base: `https://a0.muscache.com/im/pictures/hosting/Hosting-1725649500272518567/original/`
Widths in use: strip `?im_w=480`, hero `?im_w=1200`, gallery `?im_w=1200`, review bg `?im_w=720`.
Hero index: **0** (no `HERO_PHOTO_INDEX` override for this slug; `?photo=N` query param can override).
Review-section background: photo **#3** (`Sofa Seating`).
Alt text = the label; strip images carry `loading="lazy"`.

The full 59-row table (index · FIG. number · label · filename · URL) is in
[`_photos.md`](./_photos.md). Summary of the label sequence:

| Range | Labels |
|---|---|
| 0–8 | Living Room · Living Room Alternate View · Living Room Sofa · Sofa Seating · Accent Lighting · Smart TV · Lounge Nook · Downtown Dallas View · Chaise Lounge |
| 9–18 | Full Kitchen · Kitchen Counter · Coffee Station · Kitchen Detail · Kitchen Essentials · Spices & Cookware · Microwave · Dining Table · Lounge Seating · Entryway |
| 19–27 | Smart TV (Bedroom) · Velvet King Bed · Dresser Detail · Tufted Headboard · Bedroom Detail · Bedroom Dresser · Full-length Mirror · King Bed · Clothing Storage |
| 28–35 | Bathroom Vanity · Shower · Bathroom Detail · Full Bathroom · Vanity Counter · Walk-in Shower · Bath Amenities · Shower Detail |
| 36–41 | Workspace & Living · Dedicated Workspace · Desk Setup · City View · Washer & Dryer · Laundry Area |
| 42–53 | Gym Weights · Fitness Center · Resort Pool · Pool Lounge · Cinema Seating · Cinema Room · Music Studio Drums · Music Studio Keys · Art & Music Studio · Game Room · Skee-Ball Arcade · Arcade Room |
| 54–58 | Hallway · View from Living Room · Entry Hallway · Sound System · Decor Detail |

Photo-count control reads **`59 PHOTOS`**.

### Design-file mismatches
- ✗ Design shows 5 photos in the mosaic and a "12+ VIEW ALL PHOTOS" tile. Real count is **59**.
- ✗ Design labels FIG. 02–05 all "THE SUITE"/"SUITE DETAIL" — real labels are per-photo (above) and were visually audited in commit `a681f6f`.
- ✗ Design uses `c668228a…` as FIG. 02; that file is actually **index 20 — "Velvet King Bed"**.
- ✗ Design's "FIG. 06 — THE BEDROOM" uses `d8f1e185…` = index **18 — "Smart TV (Bedroom)"**.

---

## 5. Where you'll sleep (N°3)

`getBedrooms()['regent-skyline']`, glance.html:677–680 — **2 cells, no room photos** (the
bed grid is text-only today):

| Label | Type | Note |
|---|---|---|
| `BEDROOM · LOFT` | `1 king bed` | `EXPOSED BRICK · SMART TV` |
| `LIVING ROOM` | `Air mattress` | `SLEEPS UP TO 5 TOTAL` |

Section-head right: `1 BR · 2 BEDS`. Grid is 2-col on mobile, 3-col ≥1024px; collapses to
1-col only when there is a single cell.

### Design-file mismatches
- ✗ Design's sleep list ("Room-darkening shades", "Extra pillows…", "Vanity & standing mirrors") is an **amenity list, not bed configuration**. Those strings live in `fullAmenities`, not in the bed grid.
- ✗ "+ QUEEN AIR MATTRESS" callout — the data says **`Air mattress`** (unqualified). `Queen air mattress` is the wording used by `executive` and `stunning-lake`, not this property. (`server.js:3955` does add a "+ Queen Air Mattress" pill on the *property* page for this slug — but the glance page does not, and the bed grid string is the authority here.)

---

## 6. Amenities (N°2)

**Featured list** — `FEATURED_AMENITIES['regent-skyline']` glance.html:715–723, numbered 01–07:

| # | Name | Detail | Click target (verified by replaying `scrollToAmenityPhoto()`) |
|---|---|---|---|
| 01 | Downtown skyline views | `FLOOR-TO-CEILING` | → photo **#7** `Downtown Dallas View` ✔ |
| 02 | Free valet parking | `BUTLER BROTHERS` | **no match — click is a no-op** ⚠️ |
| 03 | Private cinema room | `SCREENING ROOM` | → photo **#5** `Smart TV` ⚠️ **wrong** — the word-match loop hits `Smart TV (living room)` on the word "room" before reaching `Private cinema & screening room` (#47) |
| 04 | Resort-style pool | `COURTYARD` | → photo **#44** `Resort Pool` ✔ |
| 05 | Karaoke lounge | `BUILDING AMENITY` | **no match — click is a no-op** ⚠️ |
| 06 | 24/7 Fitness center | `ON-SITE` | → photo **#43** `Fitness Center` ✔ |
| 07 | Exposed brick & 10ft ceilings | `LOFT` | **no match — click is a no-op** ⚠️ |

⚠️ Pre-existing bug, not introduced by the redesign: 3 of the 7 featured amenities are dead
clicks and 1 opens the wrong photo. STEP 4 says no dead controls — see §14 Q7.

Section-head right: **`60 TOTAL`**. Expand button: **`ALL 60 AMENITIES`** → `COLLAPSE AMENITIES ▲`.

**Full list — 60 items across 9 categories** (verbatim, with photo mappings) in
[`_amenities.md`](./_amenities.md). Category counts:

| Category | Count |
|---|---|
| Bathroom | 8 |
| Bedroom & Laundry | 10 |
| Entertainment | 4 |
| Kitchen & Dining | 13 |
| Outdoor | 2 |
| Parking & Facilities | 9 |
| Work & Tech | 3 |
| Building | 6 |
| Location | 5 |
| **Total** | **60** |

`amenityPhotos` maps **19** amenity names → photo indices; those rows render with a `→` and
open the lightbox at that index.

### Design-file mismatches
- ✗ "74 AMENITIES" / "74 IN TOTAL" — real count is **60**.
- ✗ The two-column "IN THE SUITE / THE RESORT FLOOR" split does not exist in the data; the real taxonomy is the 9 categories above.
- ✗ "1 GB fiber Wi-Fi" — data says `1GB high-speed internet`. "Premium linens, towels & plush throws" — data says `Bed linens`, `Extra pillows & blankets`. "Detergent included", "cream & sugar" — invented.
- ✗ "VIEW THE FULL LIST ↗" pointing at Airbnb — the real control is an **inline expander**, not an external link.

---

## 7. Rating & reviews

| Field | Live value |
|---|---|
| `rating` | **`null`** |
| `reviews` | **`0`** |

Consequences on the live page:
- Rating row renders **`★ NEW LISTING`** (glance.html:551).
- **`buildReviews()` sets `#reviewSection` to `display:none`.** The property has **no review section at all**.
- There are **zero review objects** anywhere in the codebase — no author, no date, no text, no per-category scores.

### Design-file mismatches — this is the largest one
- ✗ `5.0`, `★★★★★`, "PERFECT SCORES, EVERY CATEGORY"
- ✗ The six category bars (Cleanliness/Accuracy/Check-in/Communication/Location/Value, all 5.0)
- ✗ "NEW LISTING · HOST RATED 4.83★ ACROSS 83 STAYS · SUPERHOST ✦"

**All fabricated. Per STEP 2 ("no reviews → review section does not render"), the desktop
build must omit the entire review block for this property.**

---

## 8. Pricing

Live, fetched at script-parse time from **`GET /api/guesty/lowest-prices`**, keyed by slug
(glance.html:930–954). No hard-coded price anywhere.

| Element | Behaviour |
|---|---|
| `#priceBig` | `$` + `Math.round(lowestPrice * 0.95)` — the 5% direct-book discount |
| `#priceOriginal` | `$` + `lowestPrice`, struck through |
| Period label | `FROM / NIGHT` (static markup) |
| `#priceSave` | `SAVE 5%+ BOOKING DIRECT — NO CHARGE YET` |
| `#stickyPrice` | same discounted figure (mobile bar; hidden ≥1024px) |
| Loading state | `.gl-price-skel` shimmer placeholders |
| No live rate | both show `—`; `#priceSave` and `#priceOriginal` are hidden |

No fees, no minimum stay, no cleaning fee, no taxes are shown on this page — those live in
the Guesty booking engine.

### Design-file mismatch
- ✗ `$169` placeholder (`data-props` default). Never hard-code a price.

---

## 9. Good to know (N°4) — `buildRules()`

Non-villa branch (this property), glance.html:846–856:

| Name | Detail |
|---|---|
| Self check-in | `SMART LOCK · 3:00 PM` |
| Checkout | `11:00 AM` |
| Parking | `FREE COVERED PARKING` |

Section-head right: `HOUSE RULES`. **That's the whole section** — three rows.

### Design-file mismatches
- ✗ "5 guests maximum · No smoking · no parties · Quiet hours 10 PM – 8 AM · Primary guest 21+" — **no such data exists**.
- ✗ "Smoke & CO alarms · Exterior security cameras · 24-hour building security" — `24-hour security` exists in `fullAmenities['Parking & Facilities']`, the rest is invented.
- ✗ Cancellation policy ("full refund up to 5 days…") — **there is no cancellation field anywhere in the codebase.**

---

## 10. Neighbourhood (N°5) & map

`NEIGHBOURHOODS['regent-skyline']`, glance.html:873–876:

> In the heart of Downtown Dallas inside the historic Butler Brothers Building. Steps from the Dallas Farmers Market, Deep Ellum, and the AT&T Discovery District.

Tags (rendered as non-interactive `<span class="gl-loc-tag">`, **no href today**):
`DALLAS FARMERS MARKET` · `DEEP ELLUM` · `AT&T DISCOVERY` · `BUTLER BROTHERS`

Section-head right: `DALLAS, TX`.

Coordinates in PROPERTY_DATA: **`lat 32.7772411, lng -96.7956303`** — but **the glance page
renders no map**. (`property.html` has the map; glance does not.)

### Design-file mismatches
- ✗ "5 MIN WALK", "STEPS AWAY", "LIVE MUSIC · BBQ", "EXPLORE CAR-FREE", "DART Rail", and the italic descriptors ("media walls, dining & events") — **all invented**; no distance/descriptor data exists.
- ✗ Design has no map either, so ⚠️ **decision needed** (§14).

---

## 11. Host

Hard-coded in `glance.html:385–390`, identical for all properties:

| Field | Value |
|---|---|
| Avatar | `https://a0.muscache.com/im/pictures/user/User/original/cfcc56a0-6613-450a-bed5-6426106cf3ec.jpeg?im_w=120`, alt `Host Jatin` |
| Name | `Hosted by Jatin` |
| Detail | `SUPERHOST · REPLIES IN 1H` / `CO-HOSTS SANDEEP & CHAMANTHI` |
| Button | `MESSAGE` → `#contactSection`, `preventDefault` + smooth scroll |

The design's host block matches (the only section that does). ✗ except "100% RESPONSE RATE",
which is invented.

---

## 12. Links, buttons & destinations

| Control | Destination | Notes |
|---|---|---|
| Back (header) | `history.back()` | |
| Brand `R E G E N T` | `/` | |
| Share | `navigator.share` → clipboard fallback + `alert('Link copied!')` | title `Regent Skyline — Regent` |
| Save (heart) | `toggleFavorite()` — CSS fill toggle only, **no persistence** | |
| Hero + chip `TAP TO EXPAND` | `openGallery(currentHeroIdx)` | |
| `59 PHOTOS` | `openGallery(0)` | |
| Each strip thumb | `openGallery(index)` | |
| **Book now** (price block) | **`https://regent.guestybookings.com/en/properties/6a4edd9fab1bbe001491a4e4`** | **no query params** — must be preserved byte-for-byte |
| **Book now** (sticky bar) | same URL | mobile only |
| `CONTACT US` | `#contactSection`, JS smooth-scroll | |
| `VIEW ON AIRBNB ↗` | `https://www.airbnb.com/rooms/1725649500272518567` | `target="_blank" rel="noopener"`, built from `hostingId` |
| `ALL 60 AMENITIES` | inline expand/collapse | |
| Amenity name (featured) | `scrollToAmenityPhoto(name)` → lightbox | fuzzy → word match; **3 of 7 are no-ops, 1 mis-targets** — see §6 |
| Amenity row (expanded, `→`) | `amenityItemClick(item)` → lightbox at mapped index | |
| Host `MESSAGE` | `#contactSection` | |
| Contact form | `POST /api/contact` with `{name,email,phone,message,property:'Regent Skyline',source:'glance-page'}` | message pre-filled `Hi, I have a question about Regent Skyline. ` |
| Gallery `✕` / `‹` / `›` | `closeGallery()` / `galleryNav(∓1)` | plus Esc, ←/→, touch swipe, and back-button close via `pushState`/`popstate` |

**Not present on the glance page today:** header nav links, phone link, email link, footer
nav (HOME / ALL PROPERTIES / MANAGEMENT / REWARDS / CONTACT), copyright line, the
"BOOK NOW →" header CTA, the marquee "REGENT ✦ STAYS ✦" strip, and the "Book direct" ticker.
The footer is a single line: `REGENT · DALLAS, TEXAS`.

Real values, if we add a header/footer (from `public/index.html`, not the design file):
`tel:+12813071280` → displayed `(281) 307-1280` · `mailto:hello@bookwithregent.com` ·
`/` · `/availability` · `/management` · `/reward`. No copyright string exists on the site
today — the design's "© 2026 Regent Capital Ventures LLC" is **unverified**.

---

## 13. SEO / head

| Tag | Value |
|---|---|
| `<title>` | `Regent Skyline \| Regent — Luxury Short-Term Rentals` |
| `meta description` | full description (§3) |
| `link canonical` | `https://bookwithregent.com/property/regent-skyline` |
| `og:type` | `website` |
| `og:title` / `twitter:title` | `Regent Skyline — Regent Luxury Rentals` |
| `og:description` / `twitter:description` | full description |
| `og:image` / `twitter:image` | `…/8e867888-7159-4313-b7c4-b64ff0fbd07e.png?im_w=1200` (photo #0) |
| `og:url` | `https://bookwithregent.com/property/regent-skyline` |
| `og:site_name` | `Regent` |
| `twitter:card` | `summary_large_image` |
| favicon | inline SVG "R" data URI |
| Fonts | Playfair Display (400–900) + Outfit (300–700), Google Fonts, with preconnects |

**Structured data: there is none on the glance page** (`property.html` has one JSON-LD block;
`glance.html` has zero). Heading hierarchy today: a single `<h1>` (`#glTitle`) and **no `<h2>`
at all** — sections use `<div class="gl-section-label">`.

### Design-file mismatch
- ✗ Design loads Playfair Display + **Archivo + IBM Plex Mono**. The live page uses **Outfit** for both `--sans` and `--mono`. Switching families is a visual change I'd treat as part of "typography scale" — flagged in §14.

---

## 14. Open questions before I code

1. **Which design option?** The file contains two full comps: **1a "Midnight Folio"** (split hero, hairline sections, N° headers, bottom sticky strip) and **1b "Grand Cinema"** (full-bleed 780px hero with glass booking card, filmstrip, centered brochure sections, footer sticky bar). The file's own closing note suggests 1a. **Which do you want — 1a, 1b, or 1a's body with 1b's hero?**
2. **Fonts.** Adopt the design's Archivo + IBM Plex Mono, or keep the live Outfit and match only scale/weight/tracking? Adding two families costs a font request; keeping Outfit is a smaller diff.
3. **Header/footer nav.** The design has a full nav bar, phone, header BOOK NOW, and a footer with 5 links + copyright. None exist on the glance page. Add them (using the real values in §12, and dropping the unverified copyright), or keep the current minimal back/brand/share/save header?
4. **Contact section.** The design's form has Name/Email/Message. The live form has **Name/Email/Phone/Message** and pre-fills the message. Keep all four fields (my default) — confirm.
5. **Empty sections.** Regent Skyline renders **no review block** and **no map**. Confirm the desktop layout simply omits them (my default) rather than substituting anything.
6. **Sticky booking.** The current desktop (≥1024px) already has a sticky sidebar card and hides `.gl-sticky`. The design instead uses a full-width pinned bottom strip. Keep the sidebar card, adopt the bottom strip, or both?
7. **Dead amenity clicks (§6).** Do you want me to fix the matcher as part of this work (map `Free valet parking`, `Karaoke lounge`, `Exposed brick`, and make `Private cinema room` resolve to #47), or leave the existing behaviour untouched and scope this to layout only? Fixing it touches shared JS, so it would affect mobile too.

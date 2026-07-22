# Host Damage Protection — Guesty → Truvi Readiness Plan

## Decision (ready state)
- Provider selected for this cycle: **Truvi**
  - Selected plan: **Screening + Protection $0–$1M** preset
  - Price: **$31.95 / booking** (verified list price at truvi.com/platform/pricing, 2026-07)
  - Coverage: **from $0 up to $1,000,000** per booking — full coverage, no self-covered gap
  - Host-facing damage-protection intent tracked in app layer with source/domain gate.

## Source of plan terms
- Plan label/price/coverage configured via `TRUVI_PLAN_NAME`, `TRUVI_PLAN_AMOUNT`,
  `TRUVI_PLAN_COVERAGE_LIMIT`, `TRUVI_PLAN_PROGRAM`.
- Price + coverage tier cross-checked live on Truvi's public pricing estimator
  (2026-07): `$0-$1M` protection product = **$31.95/booking**. The alternative
  `$500-$1M` preset ($18.40) was rejected because it leaves the first $500
  self-covered (requires a deposit/waiver), i.e. not "full" coverage.
- **No official claim is made that this plan equals any specific insurer category;**
  Truvi is "not insurance but insurance-backed." Confirm exact terms in the Truvi
  contract before guest exposure.

## Why this is the right fit
- Covers host-facing damage and incident workflow.
- Property-protection intent (not pure travel/guest insurance).
- “Not Protected” / cancelled booking handling aligns with typical inventory ops.

## Production-safe source restriction (implemented in app)
Your requirement is stricter than the native Truvi + Guesty integration filters (which only explicitly expose Airbnb/Vrbo exclusions), so we enforce additional source gating in your booking app.

### Active gate rules
- Allowlist:
  - `source === 'Guesty Booking Engine'` (when request arrives from canonical Regent direct domain)
- Hard-block list (always denied):
  - Airbnb / Vrbo / HomeAway / Booking / Expedia / Blueground / marketplace/manual imports.
- Request-level domain restriction:
  - `bookwithregent.com`
  - `regent.guestybookings.com`
  - `regent.guestbookings.com`
- Any booking not matching both source+domain rules is marked as `direct_booking=false` and excluded.

## What changed in code
- Added strict helper:
  - `guesty-damage-protection-gate.js`
  - Exports `isDirectRegentBookingCandidate()` and canonical `DEFAULT_ALLOWED_DOMAINS`.
- Added booking request-level tracking columns (migrations):
  - `direct_booking`, `protection_plan_amount`, `protection_plan_name`,
    `protection_source`, `protection_domain`, `protection_reason`.
- Updated booking endpoints to evaluate and persist the gate result:
  - `POST /api/guesty/reservation-intent`
  - `POST /api/guesty/reservation`
- `guesty.createReservation()` now supports `source` override so Guesty records can carry direct-channel provenance.
- API responses now include `truviProtection` metadata so host-visible debug is immediate.

## Implementation state right now
- **Backend logic for strict gate + $1M plan selection is implemented and persisted.**
- Plan staged at **$0–$1M / $31.95 per booking** (`TRUVI_PLAN_*` in server.js + .env.example).
- `TRUVI_ENABLED=false` in .env.example until a real Truvi account + API key exist,
  so the lifecycle worker will not attempt live enrollment against a non-existent provider.
- Direct-only enforcement proven by `scripts/verify-truvi-direct-only.js` (full
  source×domain matrix) and `scripts/test-truvi-gate.js` (contract cases).

## Remaining external blockers to go fully live
1. **Truvi account** — sign up, accept terms, set up billing (financial commitment).
2. **Truvi API key** — issued after account setup; set `TRUVI_API_KEY` + `TRUVI_ENABLED=true`.
3. **Guesty ↔ Truvi console connection** — Integrations → connect Truvi, generate the
   integration token, and set native "Exclude Airbnb/Vrbo" as defense-in-depth
   (the app-layer gate is the authoritative direct-only control).
4. Requires an authenticated `app.guesty.com` console session (Open API token is
   insufficient for installing a marketplace add-on).

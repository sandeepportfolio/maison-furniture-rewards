# Host Damage Protection — Guesty → Truvi Readiness Plan

## Decision (ready state)
- Provider selected for this cycle: **Truvi**
  - Selected plan: **$28.75 / booking**
  - Host-facing damage-protection intent tracked in app layer with source/domain gate.

## Source of plan terms
- Plan label is configured via `TRUVI_PLAN_NAME` and not yet tied here to an official public source document.
- **No official claim is made that this plan equals any specific payout threshold or insurer category;** thresholds/certifications should be confirmed in Truvi/guesty product docs before exposure to guests.

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
- **Backend logic for strict gate + plan selection is implemented and persisted.**
- Next step is activation in Guesty UI (if not already active) and validation of a real `source` payload from:
  1) your bookwithregent.com checkout flow and
  2) your prebuilt Guesty Booking Engine flow.

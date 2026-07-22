# Direct-Booking-Only STR Insurance via Per-Booking Enrollment — Implementation Plan (2026-07-22)

## WINNER: Safely (safely.com) — best fit for "direct-only, per-booking, damage + liability"

### Why Safely wins
- Coverage per stay: up to **$1,000,000 structural damage** + **$1,000,000 homeowner/PM LIABILITY (guest injury)**
  + up to **$25,000 contents/personal property**. (Damage AND liability in one product — unlike Waivo/Truvi which are damage-only.)
- Underwritten by **On Demand Insurance** (licensed carrier), not a self-insured waiver.
- **Per-reservation** pricing model (matches the automation idea).
- **Guesty integration via API Key/Token** (Marketplace > Safely > Connect > API Key) — has an automation hook.
- Explicitly supports **direct bookings** as a channel.

### Safely plan tiers (from Safely's Guesty onboarding page, per 21 nights)
- $1,500 Damage Waiver — $30
- $3,000 Damage Waiver — $36
- $5,000 Damage Waiver — $40
- $8,000 Damage Waiver — $50
- Rate type: "Per night" or "Per 21 nights"
- Cost handling: **$100 per reservation (pass to guest)** OR **$0 per reservation (you absorb / mark up)**
- NOTE: The self-serve onboarding tiers cap at $8k damage waiver; the $1M structural + $1M liability
  is the underlying Safely Protection Policy — confirm exact limit/price for Regent directly with Safely sales.

### Honest coverage-limit note
- "$0 to $100" = interpreted as **$0–$100,000 per booking**. Safely's headline is $1M structural + $1M liability,
  which EXCEEDS $100k — good. If you literally want a lower/cheaper $100k cap, Safely can likely tier it.
- A true **$100 MILLION** figure is NOT a per-booking product (that's an annual umbrella via broker, not source-gateable).

## Alternatives considered
- **Waivo**: $500-$20k, damage ONLY (no liability), no deductible, no guest contact. Good, but no liability.
- **Truvi (ex-SUPERHOG)**: rejected — native Guesty integration can't gate to direct-only (Airbnb+Vrbo only).
- **InsuraGuest**: $25k/$25k only. Too low.
- **Guesty native Liability ($1M) / Damage Protection**: property/all-channel scoped, NOT direct-only.

## HOW DIRECT-ONLY IS ACHIEVED (the core design)
Do NOT rely on the provider's channel filter. Instead **only enroll direct bookings yourself**:
Guesty webhook (reservation.new) -> check `source` == Guesty Booking Engine (regent.guestybookings.com)
-> IF direct: call Safely enroll API for that reservation. IF not direct: do nothing.
This is EXACTLY the pattern already staged in /Users/rentamac/Documents/maison-furniture-rewards
(guesty-damage-protection-gate.js + guesty-truvi-provider.js + server.js worker). Swap the provider to Safely.

## IMPLEMENTATION PLAN (per-booking direct-only automation)

### Phase 0 — Commercials (human)
- [ ] Contact Safely sales (contact@safely.com / +1-855-723-3598) as Regent Capital Ventures LLC.
      Confirm: exact limit ($1M struct + $1M liability), per-reservation price for 7 listings,
      whether they can restrict billing/enrollment to reservations WE enroll via API (direct-only),
      and get API credentials (Token).

### Phase 1 — Connect (Guesty side)
- [ ] Guesty > Integrations > Marketplace > Safely > Connect > copy API Key/Token.
- [ ] DECISION: If Safely's native Guesty sync auto-pulls ALL reservations (like Truvi did), DO NOT use
      native auto-sync. Use API-only enrollment (Phase 2) so only direct bookings are enrolled.
      (Verify with Safely: can the connection be "API-only / no auto-enroll"? If not, this is the same
      leakage risk as Truvi and must be handled by NOT connecting the auto-sync.)

### Phase 2 — Automation (already 80% built in maison-furniture-rewards)
- [ ] Add Safely provider module (mirror guesty-truvi-provider.js): auth w/ Token, enroll endpoint,
      payload = reservationId, listingId, guest, dates, plan tier.
- [ ] Reuse guesty-damage-protection-gate.js direct-only gate (source == guesty booking engine +
      approved domains bookwithregent.com / regent.guestybookings.com; fail closed).
- [ ] Guesty webhook -> server.js worker -> IF direct -> Safely.enroll(). Existing 3-layer guard
      (candidate decision, direct_booking===1 enqueue, canonical re-fetch) already proven (112 combos, 0 leaks).
- [ ] Set env: SAFELY_ENABLED, SAFELY_TOKEN, SAFELY_PLAN, SAFELY_BASE_URL. Keep disabled until live test.

### Phase 3 — Test (controlled)
- [ ] 1 test DIRECT booking via booking engine -> confirm Safely policy issued.
- [ ] 1 test OTA booking -> confirm NO Safely enrollment/charge.
- [ ] Verify Safely dashboard shows only the direct one.

### Phase 4 — Go live
- [ ] Flip SAFELY_ENABLED=true, deploy, monitor first week of real reservations.

## MANUAL FALLBACK (if you want zero code initially)
- Since the Booking Engine is a separate channel, you can ALSO just: run a Guesty saved reservations view
  filtered to Source = "Guesty Booking Engine", and manually enroll each new direct booking in Safely's
  dashboard. Direct-only by construction. Upgrade to the automation later.

## STATUS
- Truvi disconnected (0 bookings, no payment method -> no charges).
- Research complete. Recommend Safely. Automation scaffold already exists in maison-furniture-rewards.

# Guesty STR Host Protection Research — 2026-07-22
Account: Regent Capital Ventures LLC / bookwithregent.com (7 listings). Researcher: Hermes.
Requirement: High-limit coverage for guest damages/liability, applied to **direct bookings only**
(Guesty Booking Engine source), NOT other channels (Booking.com, VRBO, Airbnb, Blueground, local, manual).

## Confirmed booking sources in this Guesty account (from live Reservations > Source filter)
1. Guesty Booking Engine  <- DIRECT (bookwithregent.com)  = the ONLY one to cover
2. Booking.com            (OTA)
3. VRBO                   (OTA)
4. airbnb2                (OTA)
5. bluegroundNestpick     (Blueground, OTA)
6. local                 (manual/back-office)
7. manual                (manual)

## Truvi (ex-SUPERHOG) — VERDICT: cannot do direct-only
- Native Guesty integration excludes ONLY airbnb + vrbo (two checkboxes). No Booking.com/Blueground/etc.
- "Channel Management" toggle = decoy: per Truvi's own docs it only removes guest-facing services;
  "Truvi will still pull through the booking, run Screening and protect it."
- Programs scoped by LISTING, not channel. Auto-polls Guesty q15min. No host API key (server-to-server).
- Screen & Protect API = enterprise/white-label for platforms, not host self-serve.
- => Confirmed via Truvi Help Centre (help.truvi.com/learning-hub) + live console. Recommend DISCONNECT.
- At setup: Truvi Bookings = 0 imported, nothing charged.

## Guesty-native add-ons (Add-ons > Shield category)  [app.guesty.com/add-on]
### Guesty Liability Coverage
- Limit: up to **$1,000,000 per reservation**. Covers bodily injury, property damage,
  neighboring-property damage, falling-object injury.
- Pricing: pay-per-reservation (only billed for nights with active bookings).
- Marketing: "automatic reservation coverage" (implies all reservations by default).
- Direct-only gating: NOT yet confirmed — only visible inside Activate flow (not triggered; paid action).

### Guesty Damage Protection
- Tiers: "$3K to $20K per reservation **across all booking channels**." Status: not active ("Activate now").
- Explicitly all-channel by design (like Truvi) => same direct-only concern. Damage (property), not liability.

### Shield Suite = umbrella grouping of the above protection products.

## Third-party providers that integrate with Guesty
- InsuraGuest: integrates Guesty, but only $25K property + $25K medical. Too low.
- Waivo: high-limit damage protection; site unreachable from cloud browser (SSL). Needs follow-up.
- (Truvi: see above.)

## HONEST REALITY on "$0–$100M"
- No embedded/pay-per-booking STR product offers $100M. Market ceiling for embedded liability = ~$1M–$2M/occurrence.
- $100M only exists as a commercial umbrella/excess liability policy via a broker (Proper, CBIZ, etc.):
  annual, underwritten per-property, NOT an integration, and CANNOT be gated by booking source
  (it covers the property regardless of who booked). So "$100M" and "direct-only" are incompatible.

## Recommendation
1. Disconnect Truvi (confirmed can't be direct-only). Verify $0 billing.
2. Best gate-candidate = Guesty-native **Liability Coverage ($1M/reservation)** IF its Activate flow
   exposes a listing/channel/source selector. Must be checked live before activating (paid).
3. If a hard $100M is required, that's a broker umbrella policy — separate from Guesty, not source-gated.

## RESOLVED (live console check, 2026-07-22): Guesty Damage Protection Activate wizard
Inspected the full setup wizard read-only (exited before Confirmation; nothing activated/charged).
- Step 1 "Choose a plan": Bronze $3K/$50, Silver $5K/$55, Gold $10K/$65 per reservation (charged on Guesty bill).
- Step 2 "Select properties": scope is by PROPERTY/LISTING only ("All properties" / Edit, 7 covered).
  - "Reservations coverage: The plan includes ALL new reservations." + optional "Include current booked reservations."
  - **NO channel/source control. No 'direct only', no 'exclude OTAs'. Covers ALL channels.**
- Step 3 "Confirmation": activation/billing step (NOT taken).
=> VERDICT: Guesty native Damage Protection has the SAME limitation as Truvi — property-scoped,
   all-channel, cannot be restricted to Guesty Booking Engine / direct bookings only.
- Guesty Liability Coverage add-on ($1M): same wizard family (Shield); expected same property/all-channel
   scoping. `/add-on/liability-coverage` route rendered blank in this account — likely not provisioned;
   would need Guesty sales to enable, and no reason to expect channel gating given Damage Protection's design.

## BOTTOM LINE
NO Guesty-integrated product (Truvi, native Damage Protection, native Liability Coverage, InsuraGuest)
can restrict guest-damage/liability coverage to DIRECT bookings only. All are property/listing-scoped
and apply to ALL channels. True direct-only enforcement would require either:
  (a) a provider that filters by reservation source (none found in Guesty's ecosystem to date), or
  (b) an API-gated custom enrollment (the maison-furniture-rewards backend gate) — but none of these
      products expose a host-facing per-booking enrollment API for that.
Truvi disconnected 2026-07-22 (Guesty side; Bookings 0, no payment method => no charges).

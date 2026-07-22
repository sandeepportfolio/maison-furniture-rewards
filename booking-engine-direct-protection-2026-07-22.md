# Adding STR Host Damage Protection to the Guesty Booking Engine (DIRECT bookings) — 2026-07-22

## THE KEY INSIGHT (validated in live console)
bookwithregent.com "Book Now" -> regent.guestybookings.com = the **Guesty Booking Engine**, which is a
DISTINCT distribution channel in Guesty (Distribution page shows a "Guesty Booking engine" card,
7 listings, engine name "Regent Properties", domain www.bookwithregent.com).
Route: app.guesty.com/integrations/online-booking-solutions/booking-engine
=> Anything attached AT THE BOOKING ENGINE / its checkout affects DIRECT bookings ONLY.
   OTA reservations (Airbnb/Vrbo/Booking.com/Blueground) never pass through this checkout.
This is why the "gate by channel" fight with Truvi was the wrong layer. The booking engine IS the gate.

## THREE WAYS TO ADD PROTECTION TO DIRECT CHECKOUT (simplest -> most robust)

### Option 1 — Security Deposit / pre-authorization on the Booking Engine (SIMPLEST, native, free)
- Guesty lets you set a **Security Deposit** that applies to Booking-Engine/direct reservations.
- Hold/authorization on the guest card; you claim against it if damage occurs.
- Inherently direct-only when configured on the booking engine / direct rate.
- Pros: free, native, no third party. Cons: capped at card hold amount; you manage claims/disputes.

### Option 2 — Guest-paid Damage Waiver FEE on the Booking Engine (native, revenue-neutral)
- Add a non-refundable **"Damage Waiver" additional fee** to direct checkout (e.g. $25-$45/stay).
- Configurable as an additional/mandatory fee on the booking engine or the direct rate plan.
- You can pair it with a third-party product (below) so the fee funds real coverage.
- Inherently direct-only when attached to the booking engine.

### Option 3 — Third-party guest-damage program scoped to Direct (most coverage)
- **Waivo (waivo.io)** — damage protection $500-$20,000, NO deductible, first-dollar, no guest contact.
  Damage ONLY (NOT liability; they refer liability to Proper/Wister). Signup form explicitly lists
  "Direct Bookings" as a channel => can be scoped to direct. Integrates with PMS/channel managers.
  Best fit for "guest damage protection on my direct bookings."
- Truvi (ex-SUPERHOG): rejected — native Guesty integration can't gate to direct-only (Airbnb+Vrbo only).
- InsuraGuest: only $25k/$25k. Too low.

## LIABILITY vs DAMAGE (important distinction for the "$100M" ask)
- DAMAGE protection (guest breaks your stuff): Waivo, Truvi, Guesty Damage Protection. $ thousands-$1M.
- LIABILITY (guest injured, lawsuit, neighbor damage): different product.
  - Guesty Liability Coverage add-on: up to $1M/reservation (but property/all-channel scoped, not direct-only).
  - **Proper Insurance (properinsurance.com)** / Wister — specialized STR commercial policies:
    property + liability + revenue. Real high-limit liability lives here (typ. $1M/occ, $2M aggregate,
    umbrella to raise higher). ANNUAL policy per property, NOT a checkout integration, NOT source-gated
    (covers the property regardless of who booked). This is the ONLY realistic path to multi-million
    liability — but it cannot be "direct bookings only," because liability follows the property.

## HONEST $100M NOTE
No embedded/pay-per-booking product = $100M. That figure is an umbrella/excess policy via a broker,
underwritten per property, and by nature covers the property for ALL guests (can't be direct-only).

## RECOMMENDATION FOR REGENT
Best + simplest for "host damage protection on direct bookings only":
  -> Guest-paid **Damage Waiver fee on the Booking Engine** (native, direct-only by design) funding a
     **Waivo** plan ($1,500 or $5,000 common tiers). Direct-only achieved by the booking-engine layer,
     not by fighting channel filters.
For liability (injury/lawsuit) at high limits:
  -> Separate **Proper Insurance** annual STR policy on the LLC/properties. Not direct-only, not an
     integration — it's your baseline business insurance and should exist regardless of channel.

## STATUS
- Truvi disconnected 2026-07-22 (Guesty side; 0 bookings, no payment method => no charges).
- Booking Engine "Regent Properties" confirmed live: 7 listings, bookwithregent.com, Instant book.
- NOT YET DONE: locate exact Booking-Engine fee/deposit setting UI (editor opens via engine config);
  and confirm Waivo's Guesty-specific integration mechanics with their team.

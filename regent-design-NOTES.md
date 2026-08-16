# Regent Stays redesign — working notes

## Brief (distilled)
Dark/deep luxury aesthetic (original system, NOT a Phantom clone): warm obsidian bg, champagne-gold accents, cream type, radial atmospheric glows, glass (backdrop-blur) surfaces, high-craft serif display + crisp sans, fluid micro-interactions (magnetic buttons, tilt/parallax cards, scroll reveals, counters, marquee), zero layout shift, fluid 375→1920 (clamp/auto-fit, no media queries). Dual funnel: guests (book) + homeowners (management + yield estimator). Preserve real IA/links/content; copy stance: keep facts, elevate voice.

## Real content (fetched from bookwithregent.com July 2026)
- Brand: REGENT / Regent Stays · Regent Capital Ventures LLC · Dallas–Fort Worth, TX. © 2026.
- Contact: (281) 307-1280 (call/text) · hello@bookwithregent.com · responds <1 hr. Badges: Verified Host, 5-Star Rated, Superhost. Socials: instagram.com, facebook.com, tiktok.com.
- Nav: Properties, Experience, Explore, Our Story, Management(/management), Contact, Book Now. Book direct: 15% avg savings, <1 hr response, 3x rewards. Booking: Guesty + Stripe, direct modal (dates/guests/calendar). Cancellation: full refund ≥5 days; 50% <5 days (fees refunded); none after check-in.
- Hero: "NOW BOOKING · 2026" / "01 DALLAS–FORT WORTH" / H1 "Where every stay becomes a *story*" / "Book your perfect stay today".
- 7 properties: Regent Skyline (Dallas), Regent Villa (flagship villa), Cozy Designer Suite, Designer Game Suite, Gorgeous Luxury Lake View Suite (Irving ★4.95 Guest Favorite), Luxury Executive Living, Stunning Lake Views. Filters: All / Villas / Executive Suites.
- Story: "Two friends, tired of paying more for less." + verbatim para (thin towels, two forks…). Stats: 7 properties, 4.9★ avg, 79+ reviews, 70+ amenities.
- Amenities (7): Resort-Style Pool & Gym; Chef-Ready Kitchens; Smart TVs up to 85″; Dedicated Workspace (27″ monitor, 1GB fiber); Deep Cleaning; EV Charging & DART; Premier Concierge (100% response). Ticker tags list.
- Explore: "The Dallas-Fort Worth Experience" — 30 spots, cities: Irving & Las Colinas 9, Dallas 12, Plano 2, Arlington 3, Richardson 1, The Colony 1. Categories: Dining/Outdoors/Shopping/Arts/Family/Sports. Map of 7 properties. "Happening Nearby" events.
- Rewards: $5 Amazon gift card per verified review (Google/Airbnb/VRBO); 3 steps; fine print: one per review per property, 7 business days, program may end anytime.
- CTA: "Your Next Escape Awaits" / "Designer interiors, effortless check-in… Book direct for the best rates."
- Photos (hotlink): villa hero https://a0.muscache.com/im/pictures/hosting/Hosting-1711340298974810369/original/a4f242ba-e02b-46a4-a699-4b17837ac4b7.png?im_w=1200 ; lake suite https://a0.muscache.com/im/pictures/hosting/Hosting-1579365691674889946/original/d4cb708a-3694-4e6f-bd63-6757450a95e0.png?im_w=720

## /management page (real copy to elevate)
- H1 "Your home deserves a team that *actually* picks up the phone." Counters: avg occupancy %, above-market ROI %, properties managed, avg rating.
- Why (4): Genuine Southern Hospitality; We Pick Up the Phone. Always.; Tech Meets Human Touch; Premium Positioning, Premium Returns (each has verbatim copy).
- Services (6): Listing Optimization & Photography; Dynamic Pricing; Guest Screening & Support; Cleaning & Turnover; Maintenance & Inspections; Owner Dashboard & Reports.
- Performance: Avg Occupancy; Avg Nightly Rate; Guest Satisfaction /5; Profitable Properties.
- Platforms: Airbnb, VRBO, Booking.com, Google Vacation Rentals, Regent Direct.
- Testimonials: Michael T. 3BR San Antonio (+40% revenue, 3 mo); Sarah K. 4BR Villa Austin (honesty); Robert & Lisa D. 2 properties Dallas (second property).
- Process (4): Conversation → Assessment → Setup → Go Live. "Handshake to first booking in two weeks."
- Intake: Full Name*, Email*, Phone, Bedrooms select, Property Address, About → "Get My Free Revenue Estimate"; reply <24h.

## Estimator model (grounded: AirDNA $192 ADR/53% occ; Chalet $223-233 ADR, 54-59% occ, 3BR $249/4BR $305/5BR $329; AirROI $221/41-46%; Airbtics 61% med occ — DFW 2025-26)
beds base {1:139/58, 2:189/57, 3:249/55, 4:305/52, 5:349/49, 6:415/46} (ADR$/occ%)
areas mult/occΔ: dallas 1.08/+2, irving 1.00/+3, plano-frisco 1.02/+1, arlington 0.95/+4, richardson 0.94/0, fortworth 0.92/+1
tier: top50 1.0/+0 · top25 1.15/+6pp. amenities: pool +6% adr, hot tub +4% adr, game room +3pp, EV +1pp, pet-friendly +2pp. occ cap 75%.
monthly = adr×30.44×occ; range = ×0.9 … ×1.12. Seasonality occ mult [.84,.80,1.05,1.08,1.10,1.02,1.00,.98,1.02,1.05,.98,.86].
Portfolio claims: 78% avg occupancy, +38% above-market ROI, $245 avg nightly, 4.9/5, 7/7 profitable.

## Design tokens (repeat inline)
bg #0C0A07 / raised #14100A / cream #F4EDE0 / muted rgba(244,237,224,.62|.45) / gold #D6B36A / gold-bright #E8CD92 / gold-deep #A98543 / hairline rgba(214,179,106,.22) / glass rgba(255,252,245,.04)+blur(18px)+border rgba(244,237,224,.1). Fonts: Instrument Serif (display, italic accents) + Archivo (UI/body). Eyebrow: 11px caps .28em gold. Buttons: gold solid (ink #14100A) / ghost hairline.

## Files
map.html — plain Leaflet map (skill: maps must NOT be .dc.html), CARTO dark tiles + OSM attribution, 7 gold pins, iframe'd into home Explore section.
Regent Stays.dc.html (home) ↔ Regent Management.dc.html (cross-linked nav).

const assert = require('assert');
const {
  isDirectRegentBookingCandidate,
} = require('../guesty-damage-protection-gate');

function testCase(name, input, expectedEligible) {
  const result = isDirectRegentBookingCandidate({
    allowedDomains: ['bookwithregent.com', 'regent.guestybookings.com', 'regent.guestbookings.com'],
    requireWebsiteDomain: true,
    ...input,
  });

  try {
    assert.strictEqual(result.eligible, expectedEligible, `${name}: expected eligible=${expectedEligible}, got ${result.eligible}`);
  } catch (error) {
    const enriched = new Error(`${error.message}\n  reason=${result.reason}`);
    enriched.cause = result;
    throw enriched;
  }
}

testCase('Allow: Guesty Booking Engine on bookwithregent', {
  source: 'Guesty Booking Engine',
  websiteUrl: 'https://bookwithregent.com/checkout',
  platform: 'Direct',
}, true);

testCase('Allow: Guesty Booking Engine on regent.guestbookings.com', {
  source: 'Guesty Booking Engine',
  websiteUrl: 'https://regent.guestbookings.com/booking',
  platform: 'Direct',
}, true);

testCase('Deny: beapi on direct host (source ambiguous)', {
  source: 'beapi',
  websiteUrl: 'https://bookwithregent.com/checkout',
}, false);

testCase('Deny: Airbnb source', {
  source: 'Airbnb',
  websiteUrl: 'https://bookwithregent.com/checkout',
}, false);

testCase('Deny: Guesty Booking Engine on non-direct host', {
  source: 'Guesty Booking Engine',
  websiteUrl: 'https://partner.example.com/flow',
}, false);

testCase('Deny: platform blocked even with allowed source', {
  source: 'Guesty Booking Engine',
  platform: 'airbnb',
  websiteUrl: 'https://bookwithregent.com/checkout',
}, false);

// ── Explicit OTA/channel deny cases (Sandeep's hard rule: direct-only) ──
testCase('Deny: Vrbo source', {
  source: 'Vrbo',
  websiteUrl: 'https://bookwithregent.com/checkout',
}, false);

testCase('Deny: Booking.com source', {
  source: 'Booking.com',
  websiteUrl: 'https://bookwithregent.com/checkout',
}, false);

testCase('Deny: Blueground source', {
  source: 'Blueground',
  websiteUrl: 'https://bookwithregent.com/checkout',
}, false);

testCase('Deny: Expedia source', {
  source: 'Expedia',
  websiteUrl: 'https://bookwithregent.com/checkout',
}, false);

testCase('Deny: HomeAway source', {
  source: 'HomeAway',
  websiteUrl: 'https://bookwithregent.com/checkout',
}, false);

testCase('Deny: manual reservation', {
  source: 'manual',
  websiteUrl: 'https://bookwithregent.com/checkout',
}, false);

testCase('Deny: imported reservation', {
  source: 'imported',
  websiteUrl: 'https://bookwithregent.com/checkout',
}, false);

testCase('Deny: empty/unknown source (fail closed)', {
  source: '',
  websiteUrl: 'https://bookwithregent.com/checkout',
}, false);

testCase('Deny: allowed source but platform=blueground', {
  source: 'Guesty Booking Engine',
  platform: 'blueground',
  websiteUrl: 'https://bookwithregent.com/checkout',
}, false);

testCase('Allow: Guesty Booking Engine on bookwithregent (regent.guestybookings.com)', {
  source: 'Guesty Booking Engine',
  websiteUrl: 'https://regent.guestybookings.com/checkout',
  platform: 'Direct',
}, true);

// ── Reason-code assertions (not just eligibility booleans) ──
const airbnb = isDirectRegentBookingCandidate({
  source: 'Airbnb', websiteUrl: 'https://bookwithregent.com/checkout',
  allowedDomains: ['bookwithregent.com', 'regent.guestybookings.com', 'regent.guestbookings.com'],
});
assert.ok(/^source_blocked:/.test(airbnb.reason), `Airbnb reason should be source_blocked, got ${airbnb.reason}`);

const wrongDomain = isDirectRegentBookingCandidate({
  source: 'Guesty Booking Engine', websiteUrl: 'https://evil.example.com/checkout',
  allowedDomains: ['bookwithregent.com', 'regent.guestybookings.com', 'regent.guestbookings.com'],
});
assert.ok(/^website_domain_not_allowed:/.test(wrongDomain.reason), `Wrong-domain reason should be website_domain_not_allowed, got ${wrongDomain.reason}`);

const ok = isDirectRegentBookingCandidate({
  source: 'Guesty Booking Engine', websiteUrl: 'https://bookwithregent.com/checkout',
  allowedDomains: ['bookwithregent.com', 'regent.guestybookings.com', 'regent.guestbookings.com'],
});
assert.strictEqual(ok.reason, 'eligible_direct_regent_booking', `Allowed reason mismatch: ${ok.reason}`);

console.log('OK: Truvi gating contract tests passed');

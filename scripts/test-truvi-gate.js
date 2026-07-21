const assert = require('assert');
const {
  isDirectRegentBookingCandidate,
} = require('../guesty-damage-protection-gate');

function testCase(name, input, expectedEligible) {
  const result = isDirectRegentBookingCandidate({
    allowedDomains: ['bookwithregent.com', 'regent.guestybookings.com'],
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

console.log('OK: Truvi gating contract tests passed');

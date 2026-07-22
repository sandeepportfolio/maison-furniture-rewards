#!/usr/bin/env node
/**
 * Cross-verification matrix for Truvi $1M host damage protection.
 *
 * Sandeep's hard rule: the Truvi policy must apply ONLY to direct bookings made
 * from the Regent custom website (bookwithregent.com / regent.guestybookings.com /
 * regent.guestbookings.com via the Guesty Booking Engine source). It must NEVER
 * apply to Airbnb, Vrbo, Blueground, Booking.com, Expedia, manual, imported, etc.
 *
 * This script exhaustively evaluates every (source × domain) combination through
 * the real production gate helper and prints an ALLOW/DENY matrix, then asserts:
 *   - The ONLY combinations that are eligible are direct-channel sources on an
 *     approved Regent domain.
 *   - Every OTA/channel/manual source is denied on EVERY domain (even the
 *     approved ones) — i.e. a leaked OTA reservation can never be enrolled.
 *   - Every approved source on a NON-approved domain is denied.
 *
 * Exit code 0 = proof holds. Non-zero = a leak exists.
 */
const assert = require('assert');
const {
  isDirectRegentBookingCandidate,
  DEFAULT_ALLOWED_DOMAINS,
} = require('../guesty-damage-protection-gate');

const APPROVED_DOMAINS = [
  'bookwithregent.com',
  'regent.guestybookings.com',
  'regent.guestbookings.com',
];

// Domains to test: approved Regent hosts + hostile/unrelated hosts.
const TEST_DOMAINS = [
  'https://bookwithregent.com/checkout',
  'https://regent.guestybookings.com/booking',
  'https://regent.guestbookings.com/booking',
  'https://www.bookwithregent.com/checkout', // www-normalization check
  'https://evil.example.com/checkout',        // hostile look-alike
  'https://airbnb.com/checkout',              // OTA host
  '',                                         // missing domain (fail closed)
];

// Sources to test: the only direct markers + a broad set of OTA/manual/ambiguous.
const DIRECT_SOURCES = ['Guesty Booking Engine', 'direct'];
const BLOCKED_SOURCES = [
  'Airbnb', 'Airbnb2', 'Vrbo', 'HomeAway', 'Booking.com', 'Booking',
  'Expedia', 'Blueground', 'manual', 'imported', 'beapi', 'widget', 'pms', '',
];

function domainLabel(url) {
  if (!url) return '(none)';
  try { return new URL(url).host; } catch { return url; }
}

function evaluate(source, websiteUrl) {
  return isDirectRegentBookingCandidate({
    source,
    websiteUrl,
    allowedDomains: APPROVED_DOMAINS,
    requireWebsiteDomain: true,
  });
}

function isApprovedDomain(url) {
  const host = domainLabel(url).replace(/^www\./, '');
  return APPROVED_DOMAINS.includes(host);
}

let eligibleCount = 0;
let leakCount = 0;
const rows = [];

const allSources = [...DIRECT_SOURCES, ...BLOCKED_SOURCES];

for (const source of allSources) {
  for (const url of TEST_DOMAINS) {
    const res = evaluate(source, url);
    const isDirectSource = DIRECT_SOURCES.map(s => s.toLowerCase()).includes(String(source).toLowerCase());
    const approvedDomain = isApprovedDomain(url);
    const shouldBeEligible = isDirectSource && approvedDomain;

    if (res.eligible) eligibleCount++;

    // A "leak" = eligible when it should NOT be, OR denied when it SHOULD be allowed.
    const leaked = res.eligible !== shouldBeEligible;
    if (leaked) leakCount++;

    rows.push({
      source: source || '(empty)',
      domain: domainLabel(url),
      expected: shouldBeEligible ? 'ALLOW' : 'DENY ',
      actual: res.eligible ? 'ALLOW' : 'DENY ',
      match: leaked ? '  <-- MISMATCH' : '',
      reason: res.reason,
    });

    // Hard assertion per-cell.
    assert.strictEqual(
      res.eligible,
      shouldBeEligible,
      `LEAK: source="${source}" domain="${domainLabel(url)}" expected ${shouldBeEligible ? 'ALLOW' : 'DENY'} got ${res.eligible ? 'ALLOW' : 'DENY'} (reason=${res.reason})`
    );
  }
}

// Print the matrix.
console.log('\n=== Truvi $1M Direct-Only Cross-Verification Matrix ===');
console.log('Approved domains:', APPROVED_DOMAINS.join(', '));
console.log('Direct sources  :', DIRECT_SOURCES.join(', '));
console.log('');
console.log(
  'SOURCE'.padEnd(22),
  'DOMAIN'.padEnd(28),
  'EXPECT'.padEnd(7),
  'ACTUAL'.padEnd(7),
  'REASON'
);
console.log('-'.repeat(110));
for (const r of rows) {
  console.log(
    String(r.source).padEnd(22),
    String(r.domain).padEnd(28),
    r.expected.padEnd(7),
    r.actual.padEnd(7),
    r.reason + r.match
  );
}

// Global invariants.
console.log('\n=== Invariants ===');

// 1) The only eligible cells are (direct source × approved domain).
const expectedEligible = DIRECT_SOURCES.length * APPROVED_DOMAINS.filter(d =>
  TEST_DOMAINS.some(u => domainLabel(u).replace(/^www\./, '') === d)
).length;
console.log(`Eligible cells: ${eligibleCount} (all direct-source × approved-domain only)`);
console.log(`Mismatches/leaks: ${leakCount}`);

// 2) Every blocked source is denied on EVERY domain, including approved ones.
for (const source of BLOCKED_SOURCES) {
  for (const url of TEST_DOMAINS) {
    const res = evaluate(source, url);
    assert.strictEqual(res.eligible, false,
      `LEAK: blocked source "${source}" became eligible on ${domainLabel(url)}`);
  }
}
console.log('OK: every OTA/manual/ambiguous source denied on every domain (incl. approved).');

// 3) Direct source on a hostile domain is denied.
for (const source of DIRECT_SOURCES) {
  const res = evaluate(source, 'https://evil.example.com/checkout');
  assert.strictEqual(res.eligible, false,
    `LEAK: direct source "${source}" eligible on hostile domain`);
}
console.log('OK: direct source on non-approved domain denied.');

// 4) Direct source on each approved domain is allowed (positive path intact).
for (const source of DIRECT_SOURCES) {
  for (const d of APPROVED_DOMAINS) {
    const res = evaluate(source, `https://${d}/checkout`);
    assert.strictEqual(res.eligible, true,
      `REGRESSION: direct source "${source}" should be eligible on ${d} (reason=${res.reason})`);
    assert.strictEqual(res.reason, 'eligible_direct_regent_booking');
  }
}
console.log('OK: direct source on each approved Regent domain is enrolled.');

assert.strictEqual(leakCount, 0, `FAILED: ${leakCount} leak(s) detected`);

console.log('\n✅ PROOF HOLDS: Truvi $1M protection applies to Regent direct bookings ONLY.');
console.log('   No OTA/channel (Airbnb, Vrbo, Blueground, Booking.com, Expedia, manual) can ever enroll.');

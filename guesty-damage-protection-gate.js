const DEFAULT_ALLOWED_DOMAINS = ['bookwithregent.com', 'regent.guestybookings.com'];

const ALLOWED_SOURCES = new Set([
  'guesty booking engine',
  'guestybookingengine',
  'guesty_booking_engine',
  'guesty-booking-engine',
  'direct',
  'direct channel',
]);

const BLOCKED_SOURCES = new Set([
  'airbnb',
  'airbnb2',
  'airbnb2api',
  'airbnb api',
  'airbnb_api',
  'bookingcom',
  'booking.com',
  'booking',
  'booking.com api',
  'bookingcom api',
  'expedia',
  'vrbo',
  'homeaway',
  'homeaway2',
  'blueground',
  'manual',
  'imported',
  'import',
  'widget',
  'pms',
  'beapi',
]);

const BLOCKED_PLATFORMS = new Set([
  'airbnb',
  'homeaway',
  'vrbo',
  'booking',
  'booking.com',
  'bookingcom',
  'expedia',
  'blueground',
  'manual',
  'external',
  'imported',
]);

function normalize(value) {
  return String(value || '')
    .trim()
    .toLowerCase();
}

function toFlatString(value) {
  return normalize(value)
    .replace(/[\s_\-]/g, '')
    .replace(/[^a-z0-9.]/g, '');
}

function parseAllowedDomains(rawValue) {
  if (!rawValue) return [...DEFAULT_ALLOWED_DOMAINS];

  const list = typeof rawValue === 'string'
    ? rawValue.split(',')
    : Array.isArray(rawValue)
      ? rawValue
      : [rawValue];

  return list
    .map(v => normalize(v))
    .map(v => v.replace(/^https?:\/\//, ''))
    .map(v => v.split('/')[0])
    .map(v => v.replace(/^www\./, ''))
    .filter(Boolean);
}

function extractHostname(value) {
  const valueStr = String(value || '').trim();
  if (!valueStr) return '';
  const noPath = valueStr.split('/').slice(0, 3).join('/');
  const match = noPath.match(/([a-z0-9.-]+)(?::\d+)?$/i);
  if (!match) return '';
  return normalize(match[1]).replace(/^www\./, '');
}

function resolveRequestDomain({ request }) {
  if (!request) return '';
  return (
    extractHostname(request.referer || request.origin || request.host || request.domain) ||
    extractHostname(request.get?.('referer')) ||
    extractHostname(request.get?.('origin'))
  );
}

function isAllowedDomain(domain, allowedDomains = DEFAULT_ALLOWED_DOMAINS) {
  const normalized = normalize(domain).replace(/^www\./, '');
  if (!normalized) return false;
  return allowedDomains
    .map((item) => normalize(String(item)).replace(/^www\./, ''))
    .some((item) => normalized === item || normalized.endsWith(`.${item}`));
}

/**
 * Canonical eligibility check for host/property damage protection.
 *
 * Rule set:
 *  1) allow only source markers that indicate direct-channel creation.
 *  2) hard deny obvious marketplaces and imported/manual channels.
 *  3) require request domain to be a Regent direct site (bookwithregent.com or
 *     the connected Guesty Booking Engine domain).
 */
function isDirectRegentBookingCandidate({
  source,
  integration,
  platform,
  bookingSource,
  websiteUrl,
  request,
  allowedDomains = DEFAULT_ALLOWED_DOMAINS,
  requireWebsiteDomain = true,
} = {}) {
  const normalizedSource = toFlatString(source);
  const normalizedBookingSource = toFlatString(bookingSource);
  const normalizedPlatform = normalize(platform || integration?.platform || '');

  if (BLOCKED_SOURCES.has(normalizedSource) || BLOCKED_SOURCES.has(normalizedBookingSource)) {
    return {
      eligible: false,
      reason: `source_blocked:${normalizedSource || normalizedBookingSource || 'empty'}`,
    };
  }

  if (BLOCKED_PLATFORMS.has(normalizedPlatform)) {
    return {
      eligible: false,
      reason: `platform_blocked:${normalizedPlatform}`,
    };
  }

  const directBySource =
    ALLOWED_SOURCES.has(normalizedSource) ||
    ALLOWED_SOURCES.has(normalizedBookingSource);

  if (!directBySource) {
    return {
      eligible: false,
      reason: `source_not_allowed:${normalizedSource || normalizedBookingSource || 'empty'}`,
    };
  }

  if (!requireWebsiteDomain) {
    return {
      eligible: true,
      reason: 'eligible_direct_source',
    };
  }

  const host = extractHostname(websiteUrl) || resolveRequestDomain({ request }) || '';
  const allowed = isAllowedDomain(host, parseAllowedDomains(allowedDomains));
  if (!allowed) {
    return {
      eligible: false,
      reason: `website_domain_not_allowed:${host || 'empty'}`,
    };
  }

  return {
    eligible: true,
    reason: 'eligible_direct_regent_booking',
    allowedDomain: host,
  };
}

module.exports = {
  isDirectRegentBookingCandidate,
  DEFAULT_ALLOWED_DOMAINS,
};

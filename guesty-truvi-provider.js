const crypto = require('crypto');

function parseBoolean(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'boolean') return value;
  return /^(1|true|yes|on)$/i.test(String(value).trim());
}

const debug = String(process.env.TRUVI_DEBUG || '').toLowerCase() === 'true';

const TRUVI_PROVIDER_CONFIG = {
  enabled: parseBoolean(process.env.TRUVI_ENABLED, true),
  baseUrl: (process.env.TRUVI_API_BASE_URL || process.env.TRUVI_API_URL || 'https://api.truvi.com').replace(/\/$/, ''),
  apiKey: process.env.TRUVI_API_KEY || '',
  timeoutMs: Number(process.env.TRUVI_API_TIMEOUT_MS || 12000),
  enrollPath: process.env.TRUVI_API_ENROLL_PATH || '/v1/policies',
  updatePath: process.env.TRUVI_API_UPDATE_PATH || '/v1/policies/{policyId}',
  cancelPath: process.env.TRUVI_API_CANCEL_PATH || '/v1/policies/{policyId}/cancel',
  refundPath: process.env.TRUVI_API_REFUND_PATH || '/v1/policies/{policyId}/refund',
  fetchPath: process.env.TRUVI_API_FETCH_PATH || '/v1/policies/{policyId}',
  webhookSecret: process.env.TRUVI_WEBHOOK_SECRET || '',
  webhookHeader: process.env.TRUVI_WEBHOOK_HEADER || 'x-truvi-signature',
  allowUnconfiguredMock: parseBoolean(process.env.TRUVI_ALLOW_UNCONFIGURED_MOCK, false),
  mockMode: parseBoolean(process.env.TRUVI_MOCK_MODE, false),
};


function trimPath(path) {
  return String(path || '').trim();
}

function buildUrl(pathTemplate, replacements = {}) {
  let path = trimPath(pathTemplate) || '/';
  if (typeof path !== 'string') {
    throw new Error('Invalid Truvi endpoint path');
  }
  Object.entries(replacements).forEach(([key, value]) => {
    path = path.replace(`{${key}}`, encodeURIComponent(String(value || '')));
  });
  const full = `${TRUVI_PROVIDER_CONFIG.baseUrl}${path.startsWith('/') ? '' : '/'}${path}`;
  return full;
}

function parseJsonSafely(text) {
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { rawText: text };
  }
}

function ensureConfigured(operationName) {
  if (!TRUVI_PROVIDER_CONFIG.enabled) {
    const error = new Error(`Truvi provider is disabled (TRUVI_ENABLED!=true) for ${operationName}`);
    error.code = 'TRUVI_DISABLED';
    error.status = 503;
    throw error;
  }

  if (TRUVI_PROVIDER_CONFIG.mockMode) {
    return;
  }

  if (!TRUVI_PROVIDER_CONFIG.apiKey && !TRUVI_PROVIDER_CONFIG.allowUnconfiguredMock) {
    const error = new Error(`TRUVI_API_KEY is not configured for ${operationName}`);
    error.code = 'TRUVI_MISCONFIGURED';
    error.status = 500;
    throw error;
  }
}

function toFetchBody(payload) {
  if (payload === undefined || payload === null) return undefined;
  return JSON.stringify(payload);
}

async function request(method, pathTemplate, options = {}) {
  ensureConfigured(method + ' ' + pathTemplate);

  const {
    body,
    query,
    headers: extraHeaders = {},
    idempotencyKey,
    replacements = {},
  } = options;

  let url = buildUrl(pathTemplate, replacements);
  if (debug) {
    console.log('[TRUVI] request', method, pathTemplate, 'url=', url, 'query=', query ? Object.keys(query || {}).join(',') : '');
  }
  if (query && typeof query === 'object') {
    const params = new URLSearchParams();
    Object.entries(query).forEach(([key, value]) => {
      if (value !== undefined && value !== null) params.set(key, String(value));
    });
    const qs = params.toString();
    if (qs) url += `${url.includes('?') ? '&' : '?'}${qs}`;
  }

  const headers = {
    'Content-Type': 'application/json',
    'User-Agent': 'Hermes-Truvi-Adapter/1.0',
    ...(TRUVI_PROVIDER_CONFIG.apiKey ? { Authorization: 'Bearer ' + TRUVI_PROVIDER_CONFIG.apiKey } : {}),
    ...(idempotencyKey ? { 'Idempotency-Key': String(idempotencyKey) } : {}),
    ...extraHeaders,
  };

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TRUVI_PROVIDER_CONFIG.timeoutMs);
  try {
    const response = await globalThis.fetch(url, {
      method,
      headers,
      body: toFetchBody(body),
      signal: controller.signal,
    });
    const rawText = await response.text();
    const parsed = parseJsonSafely(rawText);

    if (!response.ok) {
      const err = new Error(parsed?.error?.message || parsed?.message || `Truvi API error ${response.status}`);
      err.status = response.status;
      err.body = parsed;
      throw err;
    }

    return parsed;
  } finally {
    clearTimeout(timeout);
  }
}

function parseWebhookSignatureHeader(signatureHeader) {
  if (!signatureHeader || typeof signatureHeader !== 'string') {
    return { timestamp: null, signatures: [] };
  }

  const out = { timestamp: null, signatures: [] };
  signatureHeader.split(',').forEach((part) => {
    const [k, v] = part.split('=', 2);
    if (!k || !v) return;
    const key = k.trim();
    const val = v.trim();
    if (key === 't') out.timestamp = val;
    if (key === 'v1') out.signatures.push(val);
  });

  return out;
}

function computeSignature(secret, timestamp, body) {
  return crypto
    .createHmac('sha256', secret)
    .update(`${timestamp}.${body || ''}`)
    .digest('hex');
}

function verifyWebhookSignature(rawBody, signatureHeader, secret) {
  if (!secret) return { ok: true, reason: 'disabled' };
  if (!rawBody || !signatureHeader) return { ok: false, reason: 'missing signature or payload' };

  const parsed = parseWebhookSignatureHeader(signatureHeader);
  if (!parsed.timestamp || !parsed.signatures.length) {
    return { ok: false, reason: 'invalid signature header format' };
  }

  const expected = computeSignature(secret, parsed.timestamp, rawBody);
  const match = parsed.signatures.includes(expected);
  if (!match) return { ok: false, reason: 'signature mismatch' };

  return { ok: true, reason: null };
}

function extractEventId(body, rawBody) {
  return (
    body.id ||
    body.event_id ||
    body.event?.id ||
    rawBody && crypto.createHash('sha256').update(rawBody).digest('hex')
  );
}

function normalizePolicyId(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';

  let decoded = raw;
  try {
    decoded = decodeURIComponent(raw);
  } catch (_err) {
    decoded = raw;
  }

  const noQuery = decoded.split('?')[0].split('#')[0];
  const match = noQuery.match(/([^/]+)\/?$/);
  return match ? match[1] : noQuery;
}

function normalizeStatus(raw) {
  return String(raw || '').trim().toLowerCase();
}

async function enroll(payload, options = {}) {
  return request('POST', TRUVI_PROVIDER_CONFIG.enrollPath, {
    body: payload,
    idempotencyKey: options.idempotencyKey,
    query: options.query,
  });
}

async function update(policyId, payload, options = {}) {
  const p = normalizePolicyId(policyId);
  if (!p) {
    const error = new Error('policyId is required for Truvi update');
    error.status = 400;
    throw error;
  }
  return request('PUT', TRUVI_PROVIDER_CONFIG.updatePath, {
    body: payload,
    replacements: { policyId: p },
    idempotencyKey: options.idempotencyKey,
    query: options.query,
  });
}

async function cancel(policyId, payload = {}, options = {}) {
  const p = normalizePolicyId(policyId);
  if (!p) {
    const error = new Error('policyId is required for Truvi cancel');
    error.status = 400;
    throw error;
  }
  return request('POST', TRUVI_PROVIDER_CONFIG.cancelPath, {
    body: payload,
    replacements: { policyId: p },
    idempotencyKey: options.idempotencyKey,
    query: options.query,
  });
}

async function refund(policyId, payload = {}, options = {}) {
  const p = normalizePolicyId(policyId);
  if (!p) {
    const error = new Error('policyId is required for Truvi refund');
    error.status = 400;
    throw error;
  }
  return request('POST', TRUVI_PROVIDER_CONFIG.refundPath, {
    body: payload,
    replacements: { policyId: p },
    idempotencyKey: options.idempotencyKey,
    query: options.query,
  });
}

async function fetchPolicy(policyId, options = {}) {
  const p = normalizePolicyId(policyId);
  if (!p) {
    const error = new Error('policyId is required for Truvi fetch');
    error.status = 400;
    throw error;
  }
  return request('GET', TRUVI_PROVIDER_CONFIG.fetchPath, {
    replacements: { policyId: p },
    query: options.query,
    idempotencyKey: options.idempotencyKey,
  });
}

module.exports = {
  TRUVI_PROVIDER_CONFIG,
  enroll,
  update,
  cancel,
  refund,
  fetchPolicy,
  fetch: fetchPolicy,
  verifyWebhookSignature,
  extractEventId,
  normalizePolicyId,
  normalizeStatus,
  parseJsonSafely,
};

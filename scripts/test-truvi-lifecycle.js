const { spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const path = require('path');

const ROOT = '/Users/rentamac/Documents/maison-furniture-rewards';
const NODE = '/Users/rentamac/local/node-v22.14.0-darwin-arm64/bin/node';
const APP_PORT = 3460;
const MOCK_PORT = 4567;
const APP_BASE = `http://127.0.0.1:${APP_PORT}`;
const MOCK_BASE = `http://127.0.0.1:${MOCK_PORT}`;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(`ASSERTION FAILED: ${message}`);
  }
}

function loadEnvFallback() {
  const data = fs.readFileSync(path.join(ROOT, '.env'), 'utf8');
  const out = {};
  for (const line of data.split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)=(.*)\s*$/);
    if (!m) continue;
    out[m[1]] = m[2].replace(/^"|"$/g, '');
  }
  return out;
}

function toYmd(date) {
  return date.toISOString().slice(0, 10);
}

function addDays(days) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + days);
  return toYmd(d);
}

function requestJson(method, pathname, body, headers = {}, base = APP_BASE) {
  return new Promise((resolve, reject) => {
    const url = new URL(pathname, base);
    const payload = body !== undefined ? JSON.stringify(body) : null;
    const req = http.request(
      {
        method,
        hostname: url.hostname,
        port: url.port,
        path: `${url.pathname}${url.search}`,
        protocol: url.protocol,
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
          ...headers,
        },
      },
      (res) => {
        let buf = '';
        res.on('data', (chunk) => (buf += chunk.toString()));
        res.on('end', () => {
          let parsed = null;
          const txt = buf.trim();
          if (txt) {
            try {
              parsed = JSON.parse(txt);
            } catch {
              parsed = txt;
            }
          }
          resolve({ status: res.statusCode || 0, headers: res.headers, body: parsed, raw: txt });
        });
      },
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function requestRaw(pathname, rawPayload, headers = {}, base = APP_BASE) {
  return new Promise((resolve, reject) => {
    const url = new URL(pathname, base);
    const payload = typeof rawPayload === 'string' ? rawPayload : JSON.stringify(rawPayload);
    const req = http.request(
      {
        method: 'POST',
        hostname: url.hostname,
        port: url.port,
        path: `${url.pathname}${url.search}`,
        protocol: url.protocol,
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          'Content-Length': Buffer.byteLength(payload),
          ...headers,
        },
      },
      (res) => {
        let buf = '';
        res.on('data', (chunk) => (buf += chunk.toString()));
        res.on('end', () => {
          let parsed = null;
          const txt = buf.trim();
          if (txt) {
            try {
              parsed = JSON.parse(txt);
            } catch {
              parsed = txt;
            }
          }
          resolve({ status: res.statusCode || 0, headers: res.headers, body: parsed, raw: txt });
        });
      },
    );
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

async function waitForHealth(retries = 90, delayMs = 500) {
  for (let i = 0; i < retries; i += 1) {
    try {
      const res = await requestJson('GET', '/health', undefined, {});
      if (res.status >= 200 && res.status < 400) return;
    } catch {
      // keep trying
    }
    await sleep(delayMs);
  }
  throw new Error('Timed out waiting for application health endpoint');
}

function createTruviWebhookSignature(secret, bodyText) {
  const ts = String(Math.floor(Date.now() / 1000));
  const sig = crypto.createHmac('sha256', secret).update(`${ts}.${bodyText}`).digest('hex');
  return `t=${ts},v1=${sig}`;
}

function startMockProvider() {
  const state = {
    nextPolicyId: 1,
    policies: new Map(),
    events: [],
    byReservation: new Map(),
    byIdempotency: new Map(),
  };

  const server = http.createServer((req, res) => {
    const url = new URL(req.url || '/', `http://${req.headers.host}`);
    const normalizedPath = url.pathname.replace(/\/+$/, '');

    const parseBody = async () =>
      new Promise((resolve) => {
        let body = '';
        req.on('data', (chunk) => {
          body += chunk.toString();
        });
        req.on('end', () => {
          if (!body) return resolve({});
          try {
            resolve(JSON.parse(body));
          } catch (err) {
            resolve({ __invalid: true, body });
          }
        });
      });

    const json = (status, payload) => {
      const body = JSON.stringify(payload);
      res.statusCode = status;
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Content-Length', Buffer.byteLength(body));
      res.end(body);
    };

    const normalizePolicyAction = () => {
      if (req.method !== 'PUT' && req.method !== 'GET' && req.method !== 'POST') {
        return null;
      }

      const cancelMatch = normalizedPath.match(/^\/v1\/policies\/([^/]+)\/cancel$/);
      if (cancelMatch) return { policyId: decodeURIComponent(cancelMatch[1]), action: 'cancel' };

      const refundMatch = normalizedPath.match(/^\/v1\/policies\/([^/]+)\/refund$/);
      if (refundMatch) return { policyId: decodeURIComponent(refundMatch[1]), action: 'refund' };

      const updateMatch = normalizedPath.match(/^\/v1\/policies\/([^/]+)$/);
      if (updateMatch) return { policyId: decodeURIComponent(updateMatch[1]), action: req.method === 'PUT' ? 'update' : req.method === 'GET' ? 'get' : 'unknown' };

      return null;
    };

    const send = async () => {
      const body = await parseBody();

      if (normalizedPath === '/health') {
        return json(200, { ok: true, policies: state.policies.size });
      }

      if (normalizedPath === '/state') {
        return json(200, {
          policies: Object.fromEntries(state.policies),
          byReservation: Object.fromEntries(state.byReservation),
          byIdempotency: Object.fromEntries(state.byIdempotency),
          events: state.events,
        });
      }

      if (normalizedPath === '/v1/policies' && req.method === 'POST') {
        if (body && body.__invalid) return json(400, { error: 'invalid json' });
        const key = req.headers['idempotency-key'];
        const existing = key ? state.byIdempotency.get(key) : null;
        if (existing && state.policies.has(existing)) {
          state.events.push({ action: 'enroll', policyId: existing, duplicate: true });
          return json(200, state.policies.get(existing));
        }

        const policyId = `policy_${state.nextPolicyId += 1}`;
        const policy = {
          id: policyId,
          reservationId: body.reservationId,
          status: 'active',
          canonical: body.canonical || null,
          history: ['enroll'],
          payload: body,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };

        state.policies.set(policyId, policy);
        state.byReservation.set(body.reservationId, policyId);
        if (key) state.byIdempotency.set(key, policyId);
        state.events.push({ action: 'enroll', policyId, reservationId: body.reservationId, key: key || null });
        return json(201, policy);
      }

      const route = normalizePolicyAction();
      if (!route) {
        return json(404, { error: 'unknown route' });
      }

      const policy = state.policies.get(route.policyId);

      if (!policy) {
        return json(404, { error: 'policy_not_found' });
      }

      if (route.action === 'get') {
        return json(200, policy);
      }

      if (route.action === 'update') {
        if (body && body.__invalid) return json(400, { error: 'invalid json' });
        policy.updatedAt = new Date().toISOString();
        policy.status = 'updated';
        policy.payload = body;
        policy.history.push('update');
        state.events.push({ action: 'update', policyId: route.policyId });
        return json(200, policy);
      }

      if (route.action === 'cancel') {
        policy.updatedAt = new Date().toISOString();
        policy.status = 'canceled';
        policy.history.push('cancel');
        state.events.push({ action: 'cancel', policyId: route.policyId });
        return json(200, policy);
      }

      if (route.action === 'refund') {
        policy.updatedAt = new Date().toISOString();
        policy.status = 'refunded';
        policy.history.push('refund');
        state.events.push({ action: 'refund', policyId: route.policyId, reason: body?.reason || 'refund' });
        return json(200, policy);
      }

      return json(405, { error: 'method_not_allowed' });
    };

    send().catch((err) => {
      res.statusCode = 500;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ error: err.message }));
    });
  });

  return new Promise((resolve, reject) => {
    server.listen(MOCK_PORT, '127.0.0.1', (err) => {
      if (err) return reject(err);
      resolve({ server, state });
    });
  });
}

async function findAvailablePair(api, startOffset = 1, maxAttempts = 30) {
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const day = startOffset + attempt;
    const checkIn = addDays(day);
    const checkOut = addDays(day + 1);
    const res = await api.post('/api/guesty/quote', {
      listing: 'regent-villa',
      checkIn,
      checkOut,
      guests: 2,
    });

    if (res.status === 200 && res.body && typeof res.body.total === 'number' && res.body.total > 0) {
      return { checkIn, checkOut, source: res.body.source || res.body?.data?.source || null, total: res.body.total };
    }

    if (res.status === 429) {
      await sleep(250);
    }
  }

  throw new Error(`No available 1-night window found in next ${maxAttempts} days`);
}

async function run() {
  const adminUser = process.env.ADMIN_USER || 'admin';
  const adminPass = process.env.ADMIN_PASS || 'regent2024';
  const dbPath = process.env.TRUVI_DB_PATH || '/tmp/guesty-truvi-lifecycle-test.db';

  const mockCtx = await startMockProvider();
  const mockServer = mockCtx.server;
  const mockState = mockCtx.state;

  try {
    fs.unlinkSync(dbPath);
  } catch (_err) {}

  const appProc = spawn(NODE, ['server.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(APP_PORT),
      TRUVI_API_BASE_URL: `${MOCK_BASE}`,
      TRUVI_API_KEY: 'test-key',
      TRUVI_WEBHOOK_SECRET: 'test-webhook-secret',
      TRUVI_MAX_RETRY_ATTEMPTS: '8',
      TRUVI_WORKER_BATCH_SIZE: '25',
      TRUVI_WORKER_INTERVAL_MS: '5000',
      TRUVI_REQUIRE_CANONICAL_MARKER: 'false',
      TRUVI_DB_PATH: dbPath,
      ADMIN_USER: adminUser,
      ADMIN_PASS: adminPass,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const logs = [];
  const pushLog = (line) => {
    logs.push(line);
    if (logs.length > 500) logs.shift();
  };

  appProc.stdout.on('data', (chunk) => pushLog(chunk.toString().trim()));
  appProc.stderr.on('data', (chunk) => pushLog(`ERR:${chunk.toString().trim()}`));
  appProc.on('exit', (code, signal) => {
    pushLog(`APP_EXIT:${code || signal}`);
  });
  appProc.on('error', (err) => {
    pushLog(`APP_ERROR:${err.message}`);
  });

  const app = {
    post: (p, body, headers = {}) => requestJson('POST', p, body, headers),
    get: (p, headers = {}) => requestJson('GET', p, undefined, headers),
    raw: (p, body, headers = {}) => requestRaw(p, body, headers),
  };

  const killAll = async () => {
    if (appProc && !appProc.killed) appProc.kill('SIGTERM');
    mockServer.close();
    try {
      fs.unlinkSync(dbPath);
    } catch (_err) {}
  };

  const result = {
    steps: [],
    mock: mockState,
    ok: false,
    errors: [],
  };

  try {
    await waitForHealth(180, 500);

    const health = await app.get('/health');
    assert(health.status === 200, 'app health should return 200');
    result.steps.push('health-ok');

    const login = await app.post('/api/admin/login', { username: adminUser, password: adminPass });
    assert(login.status === 200 && login.body?.success, 'admin login must succeed');
    const cookie = login.headers['set-cookie'][0].split(';')[0];
    const adminHeaders = { Cookie: cookie };
    result.steps.push('admin-login');

    const pair = await findAvailablePair(app);
    result.steps.push(`quote-found:${pair.checkIn}/${pair.checkOut}`);

    const bookingRes = await app.post(
      '/api/guesty/reservation-intent',
      {
        listing: 'regent-villa',
        checkIn: pair.checkIn,
        checkOut: pair.checkOut,
        guests: 2,
        guest: {
          firstName: 'Truvi',
          lastName: 'Automation',
          email: `truvitest+${Date.now()}@example.com`,
          phone: '+15550000000',
        },
      },
      { Referer: 'https://bookwithregent.com', Origin: 'https://bookwithregent.com' },
    );

    assert(bookingRes.status === 200, 'reservation-intent must succeed');
    const { requestId, reservationId, truviProtection } = bookingRes.body || {};
    assert(requestId && reservationId, 'booking must have requestId and reservationId');
    assert(truviProtection?.enabled === true, 'direct booking must be Truvi-eligible');
    result.steps.push(`booking-created:${requestId}`);

    const retryAfterCreate = await app.post('/api/admin/truvi/retry', { limit: 20 }, adminHeaders);
    assert(retryAfterCreate.status === 200, 'retry endpoint should run');
    result.steps.push('retry-after-create');

    const adminBookings = await app.get('/api/admin/booking-requests', adminHeaders);
    const booking = (adminBookings.body || []).find((r) => r.id === requestId);
    assert(booking, 'booking request should be in admin list');
    assert(Number(booking.direct_booking) === 1, 'booking must be marked direct_booking');
    assert(booking.truvi_provider_policy_id, 'Truvi policy id should be recorded after enrollment');
    assert(booking.truvi_provider_status === 'enrolled' || booking.truvi_provider_status === 'active', 'Truvi status should be enrolled');
    result.steps.push(`enrolled:${booking.truvi_provider_policy_id}`);

    const queueAfterCreate = await app.get('/api/admin/truvi/queue', adminHeaders);
    assert(queueAfterCreate.status === 200, 'queue view should be reachable');
    const anyCompleted = (queueAfterCreate.body?.queue || []).some((q) => q.booking_request_id === requestId && q.status === 'completed');
    assert(anyCompleted, 'Truvi queue should show completed actions');

    const queue1State = await requestJson('GET', '/state', undefined, undefined, MOCK_BASE);
    const policyBeforeMod = queue1State.body?.policies?.[booking.truvi_provider_policy_id];
    assert(policyBeforeMod?.status === 'active', 'mock provider should report active policy after enrollment');
    result.steps.push(`policy-active:${policyBeforeMod.status}`);

    const modifyRes = await app.post(
      '/api/guesty/modify-reservation',
      {
        requestId,
        guests: 3,
      },
      { Referer: 'https://bookwithregent.com', Origin: 'https://bookwithregent.com' },
    );
    assert(modifyRes.status === 200, 'modify reservation should succeed');
    const retryAfterModify = await app.post('/api/admin/truvi/retry', { limit: 20 }, adminHeaders);
    assert(retryAfterModify.status === 200, 'retry after modify should succeed');
    await sleep(300);

    const modBooking = (await app.get('/api/admin/booking-requests', adminHeaders)).body.find((r) => r.id === requestId);
    assert(modBooking.guests === 3, 'booking guest count should reflect modification');

    const queueAfterMod = await app.get('/api/admin/truvi/queue', adminHeaders);
    assert(Array.isArray(queueAfterMod.body?.events), 'webhook/event list should be present');
    const queueState = await requestJson('GET', '/state', undefined, undefined, MOCK_BASE);
    const policyAfterMod = queueState.body?.policies?.[modBooking.truvi_provider_policy_id];
    assert(policyAfterMod?.status === 'updated' || policyAfterMod?.status === 'active', 'mock policy should be updated or active after modification flow');
    result.steps.push(`modified:guest_count_${modBooking.guests}`);

    const cancelRes = await app.post('/api/guesty/cancel', {
      requestId,
      reason: 'guest_cancel',
      requestRefund: true,
    }, { Referer: 'https://bookwithregent.com', Origin: 'https://bookwithregent.com' });
    assert(cancelRes.status === 200, 'cancel should succeed');
    await app.post('/api/admin/truvi/retry', { limit: 20 }, adminHeaders);
    await sleep(400);

    const cancelBooking = (await app.get('/api/admin/booking-requests', adminHeaders)).body.find((r) => r.id === requestId);
    assert(
      cancelBooking.status === 'canceled' || cancelBooking.status === 'cancelled',
      'booking status should become canceled',
    );

    const finalState = await requestJson('GET', '/state', undefined, undefined, MOCK_BASE);
    const finalPolicy = finalState.body?.policies?.[cancelBooking.truvi_provider_policy_id];
    assert(finalPolicy && ['refunded', 'canceled'].includes(finalPolicy.status), 'provider should be refunded or canceled');
    result.steps.push(`canceled:${finalPolicy.status}`);

    const webhookPayload = {
      id: `evt_${Date.now()}`,
      type: 'policy.cancelled',
      data: {
        reservationId,
        policyId: cancelBooking.truvi_provider_policy_id,
      },
    };
    const webhookBody = JSON.stringify(webhookPayload);
    const signature = createTruviWebhookSignature('test-webhook-secret', webhookBody);
    const webhookFirst = await app.raw('/api/truvi/webhook', webhookBody, {
      'x-truvi-signature': signature,
      'Content-Type': 'application/json',
    });
    assert(
      webhookFirst.status === 200,
      `webhook should be accepted: ${webhookFirst.status} ${JSON.stringify(webhookFirst.body)}`,
    );
    const webhookDup = await app.raw('/api/truvi/webhook', webhookBody, {
      'x-truvi-signature': signature,
      'Content-Type': 'application/json',
    });
    assert(webhookDup.body?.duplicate === true, 'webhook duplicate should be deduplicated');
    result.steps.push('webhook-dedup-ok');

    const reconcileRes = await app.post('/api/admin/truvi/reconcile', { limit: 20 }, adminHeaders);
    assert(reconcileRes.status === 200, 'reconcile endpoint should run');
    result.steps.push('reconcile-ok');

    const exclusionPair = await findAvailablePair(app, 31);
    const exclusionReq = await app.post(
      '/api/guesty/reservation-intent',
      {
        listing: 'regent-villa',
        checkIn: exclusionPair.checkIn,
        checkOut: exclusionPair.checkOut,
        guests: 2,
        platform: 'airbnb',
        guest: {
          firstName: 'Spoof',
          lastName: 'Tester',
          email: 'spoof@example.com',
          phone: '+155****0111',
        },
      },

      { Referer: 'https://evil.example', Origin: 'https://evil.example' },
    );
    assert(exclusionReq.status === 200, 'spoof route should still create booking request');
    const reason = exclusionReq.body?.truviProtection?.reason || '';
    assert(exclusionReq.body?.truviProtection?.enabled === false, 'non-direct platform should be excluded from Truvi');
    assert(/platform|source|not_allowed/i.test(reason), 'exclusion reason should be explicit');
    result.steps.push('exclusion-blocked');

    result.ok = true;
    console.log(JSON.stringify({
      ok: true,
      mockPolicies: Object.keys(mockState.policies).length,
      steps: result.steps,
      requestId,
      reservationId,
      finalPolicy,
    }, null, 2));
    return;
  } catch (error) {
    result.errors.push(error.message);
    if (error?.stack) result.errors.push(error.stack.split('\n')[0]);
    console.error('TRACE: app logs full:', logs);
    console.error(JSON.stringify({ ok: false, steps: result.steps, errors: result.errors }, null, 2));
    process.exitCode = 1;
  } finally {
    await killAll();
  }
}

run().catch((err) => {
  console.error('Lifecycle script crashed:', err);
  process.exit(1);
});

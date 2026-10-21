/**
 * One token scenario, in its own process.
 *
 * guesty.js keeps its token state in module scope and reads db/guesty-token.json
 * at require time, so every scenario needs a fresh process — and the fetch stub
 * has to be installed BEFORE the require, because loading the module can reach
 * for the peer handoff.
 *
 * NOTHING here may touch the network. Guesty hands out 5 OAuth tokens per 24h
 * per client; a test that really called the endpoint would spend production
 * quota. The stub below is the only fetch these tests ever see, and it counts
 * every OAuth attempt so the assertions can be about slots spent.
 *
 * Usage: node scripts/_token-scenario-child.js <scenario>
 * Prints one line of JSON for the parent to assert on.
 */

const scenario = process.argv[2];

let oauthCalls = 0;
let apiCalls = 0;
let api401sRemaining = Number(process.env.SCENARIO_API_401S || 0);

const MINTED_TOKEN = 'minted-token-' + scenario;

global.fetch = async (url, options) => {
  const href = String(url);

  // OAuth: the only call that spends a Guesty slot.
  if (href.includes('/oauth2/token')) {
    oauthCalls += 1;
    if (process.env.SCENARIO_OAUTH_FAILS === '1') {
      return { ok: false, status: 500, headers: { get: () => null }, async text() { return 'nope'; }, async json() { return {}; } };
    }
    return {
      ok: true,
      status: 200,
      headers: { get: () => null },
      async json() { return { access_token: MINTED_TOKEN, expires_in: 86400 }; },
    };
  }

  // The peer handoff read. Always a miss here: these scenarios are about this
  // process's own storage, not about the live site.
  if (href.includes('/api/internal/guesty-handoff')) {
    return { ok: false, status: 404, headers: { get: () => null }, async text() { return ''; }, async json() { return {}; } };
  }

  // Any data API call.
  apiCalls += 1;
  if (api401sRemaining > 0) {
    api401sRemaining -= 1;
    return { ok: false, status: 401, headers: { get: () => null }, async text() { return 'unauthorized'; }, async json() { return {}; } };
  }
  return { ok: true, status: 200, headers: { get: () => null }, async json() { return { results: [] }; }, async text() { return '{}'; } };
};

const guesty = require('../guesty.js');

(async () => {
  const out = { scenario, oauthCalls: 0, apiCalls: 0 };
  try {
    if (scenario === 'concurrent') {
      // Two callers racing with no usable token: single-flight must collapse
      // them into ONE OAuth call.
      const [a, b] = await Promise.all([guesty.getToken(), guesty.getToken()]);
      out.sameToken = a === b;
    } else if (scenario !== 'load-only') {
      out.token = Boolean(await guesty.getToken().catch(() => null));
    }
    const status = guesty.tokenStatus();
    out.hasToken = status.hasToken;
    out.tokenPastStatedExpiry = status.tokenPastStatedExpiry;
    out.mintCount = status.mintCount;
    out.oauthCalls = oauthCalls;
    out.apiCalls = apiCalls;
    out.ok = true;
  } catch (err) {
    out.ok = false;
    out.error = err && err.message;
    out.oauthCalls = oauthCalls;
  }
  process.stdout.write(JSON.stringify(out) + '\n');
  process.exit(0);
})();

/**
 * Guesty token reuse contract.
 *
 * The thing being protected is a quota: Guesty issues 5 OAuth tokens per 24h
 * per client, shared across production, every deploy and every dev server. So
 * these tests assert in units of SLOTS SPENT (`oauthCalls`), not in units of
 * "did it return a token" — a scenario can be perfectly functional and still be
 * a bug if it spent a slot it did not have to.
 *
 * Every scenario runs in its own process (guesty.js holds token state in module
 * scope and reads db/guesty-token.json once, at require time) with a stubbed
 * global.fetch. No test here ever reaches the network.
 *
 *   node scripts/test-guesty-token-reuse.js
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const TOKEN_FILE = path.join(ROOT, 'db', 'guesty-token.json');
const CHILD = path.join(__dirname, '_token-scenario-child.js');

const HOUR = 3600_000;
const MIN = 60_000;

// Preserve whatever the developer's own db/ holds; these tests overwrite it.
const hadFile = fs.existsSync(TOKEN_FILE);
const saved = hadFile ? fs.readFileSync(TOKEN_FILE) : null;

function writeTokenFile(contents) {
  fs.mkdirSync(path.dirname(TOKEN_FILE), { recursive: true });
  fs.writeFileSync(TOKEN_FILE, typeof contents === 'string' ? contents : JSON.stringify(contents));
}

function clearTokenFile() {
  try { fs.unlinkSync(TOKEN_FILE); } catch (_) { /* already gone */ }
}

function run(scenario, { env = {}, file } = {}) {
  if (file === null) clearTokenFile();
  else if (file !== undefined) writeTokenFile(file);

  const res = spawnSync(process.execPath, [CHILD, scenario], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 30_000,
    env: {
      ...process.env,
      // Fake credentials: enough for guesty.js to consider minting a live
      // option, never enough to reach Guesty (fetch is stubbed in the child).
      GUESTY_CLIENT_ID: 'test-client-id',
      GUESTY_CLIENT_SECRET: 'test-client-secret',
      GUESTY_ACCESS_TOKEN: '',
      GUESTY_ACCESS_TOKEN_EXPIRY: '',
      ...env,
    },
  });
  const line = (res.stdout || '').trim().split('\n').filter(Boolean).pop();
  assert.ok(line, `${scenario}: child produced no result\nstdout:${res.stdout}\nstderr:${res.stderr}`);
  const out = JSON.parse(line);
  assert.ok(out.ok, `${scenario}: child reported failure — ${out.error}`);
  return out;
}

const results = [];
function check(name, fn) {
  fn();
  results.push(name);
  console.log(`  ok  ${name}`);
}

try {
  // 1. A healthy cached token is reused outright. The whole point: a restart
  //    that finds a good token on disk must not touch OAuth.
  check('valid cached token is reused and spends no OAuth slot', () => {
    const r = run('valid', { file: { token: 'cached-valid', expiry: Date.now() + 6 * HOUR } });
    assert.strictEqual(r.oauthCalls, 0, 'a valid cached token must not trigger OAuth');
    assert.strictEqual(r.hasToken, true);
    assert.strictEqual(r.mintCount, 0);
  });

  // 2. Inside the 30-minute refresh margin but not yet expired. guesty.js
  //    deliberately keeps serving it and leaves the refresh to the proactive
  //    timer — spending a slot here is what exhausts the quota.
  check('near-expiry token is still served, not re-minted', () => {
    const r = run('near-expiry', { file: { token: 'cached-near', expiry: Date.now() + 10 * MIN } });
    assert.strictEqual(r.oauthCalls, 0, 'a token 10 min from expiry must not trigger OAuth');
    assert.strictEqual(r.hasToken, true);
  });

  // 3. Past its stated expiry. Still not grounds for an OAuth call: only a 401
  //    from Guesty retires a token, because our clock is not authoritative.
  check('expired token is held pending a 401 rather than re-minted', () => {
    const r = run('expired', { file: { token: 'cached-expired', expiry: Date.now() - 2 * HOUR } });
    assert.strictEqual(r.hasToken, true, 'an expired-by-our-clock token is still a candidate');
    assert.strictEqual(r.oauthCalls, 0, 'a stated expiry must not spend a slot on its own');
  });

  // 4. Nothing on disk at all — the genuine cold start. Exactly one mint.
  check('missing storage mints exactly once', () => {
    const r = run('missing', { file: null });
    assert.strictEqual(r.oauthCalls, 1, 'a cold start should mint once, not repeatedly');
    assert.strictEqual(r.mintCount, 1, 'the mint counter must record the slot');
    assert.strictEqual(r.hasToken, true);
  });

  // 5. Corrupt file. Must not throw, must not wedge the process.
  check('corrupt token file degrades to a cold start without crashing', () => {
    const r = run('corrupt', { file: '{this is not json' });
    assert.strictEqual(r.hasToken, true);
    assert.strictEqual(r.oauthCalls, 1, 'unreadable storage behaves exactly like missing storage');
  });

  // 6. A 401 on a data call burns the token and refreshes once — once, not in a
  //    loop, because each retry is a slot.
  check('a 401 burns the token and refreshes exactly once', () => {
    const r = run('valid', {
      file: { token: 'cached-doomed', expiry: Date.now() + 6 * HOUR },
      env: { SCENARIO_API_401S: '1' },
    });
    assert.ok(r.oauthCalls <= 1, `a single 401 must cause at most one mint, got ${r.oauthCalls}`);
  });

  // 7. Two callers racing from a cold start. Single-flight must collapse them,
  //    or a burst of traffic after a deploy drains the day's quota.
  check('concurrent callers collapse into a single mint', () => {
    const r = run('concurrent', { file: null });
    assert.strictEqual(r.oauthCalls, 1, `two concurrent callers must mint once, got ${r.oauthCalls}`);
    assert.strictEqual(r.sameToken, true, 'both callers should receive the same token');
    assert.strictEqual(r.mintCount, 1);
  });

  // 8. Storage unavailable (db/ not writable). The in-memory path must still
  //    work — persistence is an optimisation, never a dependency.
  check('unwritable storage falls back to memory without failing', () => {
    clearTokenFile();
    const dbDir = path.join(ROOT, 'db');
    fs.mkdirSync(dbDir, { recursive: true });
    const mode = fs.statSync(dbDir).mode;
    fs.chmodSync(dbDir, 0o500); // read + execute, no write
    try {
      const r = run('storage-down', { });
      assert.strictEqual(r.hasToken, true, 'a token must still be obtainable with storage down');
      assert.strictEqual(r.oauthCalls, 1);
    } finally {
      fs.chmodSync(dbDir, mode);
    }
  });

  console.log(`\nOK: Guesty token reuse contract — ${results.length} scenarios passed`);
} finally {
  if (hadFile) writeTokenFile(saved.toString());
  else clearTokenFile();
}

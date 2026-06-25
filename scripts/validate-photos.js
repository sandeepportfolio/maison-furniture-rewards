#!/usr/bin/env node
/* Validates every property photo URL in public/index.html actually loads
   (HTTP 200 + non-zero image bytes + image/* content-type). */
const fs = require('fs');
const https = require('https');
const path = require('path');

const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');

// Extract the PROPERTIES array literal from the inline script.
const start = html.indexOf('const PROPERTIES = [');
const end = html.indexOf('];', start);
if (start === -1 || end === -1) { console.error('FATAL: could not locate PROPERTIES array'); process.exit(2); }
const arrSrc = html.slice(start + 'const PROPERTIES = '.length, end + 1);
let PROPERTIES;
try { PROPERTIES = eval(arrSrc); } catch (e) { console.error('FATAL: eval failed', e); process.exit(2); }

const imgUrl = (hid, uuid) => `https://a0.muscache.com/im/pictures/hosting/Hosting-${hid}/original/${uuid}?im_w=720`;

function check(url) {
  return new Promise((resolve) => {
    const req = https.get(url, (res) => {
      const { statusCode, headers } = res;
      let bytes = 0;
      res.on('data', (c) => { bytes += c.length; });
      res.on('end', () => resolve({ url, statusCode, ctype: headers['content-type'] || '', bytes }));
    });
    req.on('error', (e) => resolve({ url, statusCode: 0, ctype: '', bytes: 0, err: e.message }));
    req.setTimeout(20000, () => { req.destroy(); resolve({ url, statusCode: 0, ctype: '', bytes: 0, err: 'timeout' }); });
  });
}

(async () => {
  const tasks = [];
  let total = 0;
  for (const p of PROPERTIES) {
    if (p.photos.length !== 20) console.error(`WARN: ${p.name} has ${p.photos.length} photos (expected 20)`);
    for (const ph of p.photos) { tasks.push({ name: p.name, url: imgUrl(p.hostingId, ph) }); total++; }
  }
  console.log(`Validating ${total} photo URLs across ${PROPERTIES.length} listings...\n`);

  const results = [];
  const CONCURRENCY = 12;
  let i = 0;
  async function worker() {
    while (i < tasks.length) {
      const t = tasks[i++];
      const r = await check(t.url);
      r.name = t.name;
      const ok = r.statusCode === 200 && r.bytes > 1000 && /image\//.test(r.ctype);
      r.ok = ok;
      results.push(r);
      if (!ok) console.log(`  FAIL [${r.statusCode}] ${r.bytes}b ${r.ctype} ${r.name} ${r.url}`);
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));

  const failures = results.filter(r => !r.ok);
  const byListing = {};
  for (const p of PROPERTIES) byListing[p.name] = results.filter(r => r.name === p.name && r.ok).length;
  console.log('\n--- Per-listing OK counts ---');
  for (const [n, c] of Object.entries(byListing)) console.log(`  ${c}/20  ${n}`);
  console.log(`\n=== ${results.length - failures.length}/${total} photos OK, ${failures.length} failed ===`);
  process.exit(failures.length ? 1 : 0);
})();

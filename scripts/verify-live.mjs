#!/usr/bin/env node
// Post-deploy check for bookwithregent.com. Waits until /api/version reports
// the expected commit (Render sets RENDER_GIT_COMMIT), then loads the live
// pages in headless Chromium and asserts the things a deploy can silently
// break: map tiles carry the CARTO key and load, Explore/Events show Austin,
// Austin photos resolve, and Regent Crown advertises pets.
//
// Usage (from any machine with normal internet access):
//   npm i --no-save playwright && npx playwright install chromium
//   EXPECTED_SHA=$(git rev-parse origin/main) node scripts/verify-live.mjs

import { chromium } from 'playwright';

const SITE = process.env.SITE_URL || 'https://www.bookwithregent.com';
const EXPECTED = (process.env.EXPECTED_SHA || '').trim();
const MAX_WAIT_MS = +(process.env.MAX_WAIT_MS || 20 * 60 * 1000);
const sleep = ms => new Promise(r => setTimeout(r, ms));

const failures = [];
const check = (ok, label, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);
  if (!ok) failures.push(label);
};

// 1. Wait for the deploy to land
if (EXPECTED) {
  const start = Date.now();
  let live = '';
  while (Date.now() - start < MAX_WAIT_MS) {
    try {
      const r = await fetch(`${SITE}/api/version`, { headers: { 'Cache-Control': 'no-cache' } });
      const j = await r.json();
      live = String(j.commit || j.version || j.sha || JSON.stringify(j));
      if (live.startsWith(EXPECTED) || EXPECTED.startsWith(live)) break;
    } catch (e) { live = 'error: ' + e.message; }
    console.log(`waiting for deploy… live=${live.slice(0, 12)} expected=${EXPECTED.slice(0, 12)}`);
    await sleep(20000);
  }
  check(live.startsWith(EXPECTED) || EXPECTED.startsWith(live), 'live commit matches', live);
  if (failures.length) { console.log('Deploy never landed; skipping page checks.'); process.exit(1); }
}

const browser = await chromium.launch();

// 2. Homepage
{
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  const tiles = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('response', r => { if (/basemaps\.cartocdn\.com/.test(r.url())) tiles.push({ url: r.url(), status: r.status() }); });
  await page.goto(SITE + '/', { waitUntil: 'load', timeout: 60000 });
  await page.waitForTimeout(3000);
  await page.$eval('#propertyMapSection', el => el.scrollIntoView());
  await page.waitForTimeout(6000);

  check(tiles.length > 0, 'map tiles requested', `${tiles.length} tiles`);
  check(tiles.length > 0 && tiles.every(t => /[?&]key=/.test(t.url)), 'every tile carries the CARTO key');
  check(tiles.length > 0 && tiles.every(t => t.status === 200), 'every tile loaded (HTTP 200)',
    [...new Set(tiles.map(t => t.status))].join(','));

  const title = await page.$eval('.xplr-title', e => e.textContent.trim());
  check(/Dallas & Austin/.test(title), 'Explore title renamed', title);
  const austinTab = await page.$eval('.xplr-city-tab[data-city="austin"] .xplr-city-count', e => e.textContent.trim()).catch(() => '');
  check(+austinTab >= 20, 'Explore has an Austin tab', austinTab);

  await page.click('.xplr-city-tab[data-city="austin"]');
  await page.waitForTimeout(1500);
  const imgs = await page.$$eval('#exploreGrid .xplr-card img', els => els.map(i => ({ src: i.getAttribute('src'), ok: i.complete && i.naturalWidth > 0 })));
  const cards = await page.$$eval('#exploreGrid .xplr-card', els => els.length);
  check(cards >= 20, 'Austin spots render', `${cards} cards`);
  // Hidden cards are lazy; fetch each photo directly instead.
  const bad = [];
  for (const src of await page.$$eval('#exploreGrid .xplr-card', els => els.map(c => c.querySelector('img') ? c.querySelector('img').getAttribute('src') : null))) {
    if (!src) { bad.push('(img removed — failed to load)'); continue; }
    const r = await fetch(new URL(src, SITE));
    if (!r.ok || !/image/.test(r.headers.get('content-type') || '')) bad.push(`${src} ${r.status}`);
  }
  check(bad.length === 0, 'every Austin photo resolves', bad.join('; ') || `${imgs.length} photos`);

  await page.$eval('#exploreEvents', el => el.scrollIntoView());
  await page.waitForTimeout(3000);
  await page.click('[data-events-city="austin"]');
  await page.waitForTimeout(1500);
  const evAustin = await page.$$eval('#exploreEventsGrid .explore-event-card', cs => cs.map(c => c.textContent));
  check(evAustin.length > 0 && evAustin.every(t => /Austin/.test(t)), 'Austin events filter', `${evAustin.length} events`);
  await page.click('[data-events-city="dallas"]');
  await page.waitForTimeout(1500);
  const evDallas = await page.$$eval('#exploreEventsGrid .explore-event-card', cs => cs.map(c => c.textContent));
  check(evDallas.length > 0 && evDallas.every(t => /Dallas/.test(t) && !/· Austin/.test(t)), 'Dallas events filter', `${evDallas.length} events`);

  check(errors.length === 0, 'homepage has no script errors', errors.join(' | '));
  await page.close();
}

// 3. Regent Crown glance page
{
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto(SITE + '/glance/regent-crown', { waitUntil: 'load', timeout: 60000 });
  await page.waitForTimeout(2500);
  const rules = await page.$eval('#rulesList', e => e.textContent);
  check(/PET-FRIENDLY/i.test(rules), 'Regent Crown shows pets welcome');
  const html = await page.content();
  check(/"petsAllowed": true/.test(html), 'Regent Crown JSON-LD petsAllowed true');
  const bedW = await page.$eval('#bedGrid', e => e.getBoundingClientRect().width);
  const sectW = await page.$eval('#sleepSection', e => e.getBoundingClientRect().width);
  check(sectW > 1400, 'desktop band stretches at 1920px', `${Math.round(sectW)}px`);
  const hasPhoto = await page.$('#sleepFig.has-photo');
  check(hasPhoto || bedW > sectW * 0.9, 'bed cards fill the row', `${Math.round(bedW)}/${Math.round(sectW)}px`);
  check(errors.length === 0, 'glance page has no script errors', errors.join(' | '));
  await page.close();
}

// 4. Mobile: no horizontal scroll
for (const p of ['/', '/glance/regent-crown', '/glance/regent-sol', '/availability']) {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  await page.goto(SITE + p, { waitUntil: 'load', timeout: 60000 });
  await page.waitForTimeout(2000);
  const sw = await page.evaluate(() => document.documentElement.scrollWidth);
  check(sw <= 391, `mobile ${p} has no horizontal scroll`, `${sw}px`);
  await page.close();
}

await browser.close();
console.log(failures.length ? `\n${failures.length} check(s) failed` : '\nAll live checks passed');
process.exit(failures.length ? 1 : 0);

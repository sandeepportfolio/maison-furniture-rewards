#!/usr/bin/env node
// Fetches a real, freely licensed photo for every Austin attraction on the
// homepage's Explore section, and checks every Austin link the site uses.
//
// Photos: the attraction's Wikipedia lead image when it is a free-licensed
// JPEG of useful size, otherwise the best free JPEG from a Wikimedia Commons
// search. Non-free (fair-use) files are never taken. Each photo is resized to
// 1280px wide and saved as public/images/attractions/<file>, and its author and
// licence go to public/images/attractions/austin-credits.json so the site can
// credit it.
//
// Links: every candidate URL is requested (GET, redirects followed) and its
// final status recorded in scripts/austin-assets-report.json, alongside a
// CARTO basemap check with and without the API key.
//
// Needs network access and `sharp` (npm i sharp). Run: node scripts/fetch-austin-assets.mjs

import fs from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const OUT_DIR = path.join(ROOT, 'public/images/attractions');
const UA = 'RegentStaysSiteBot/1.0 (https://www.bookwithregent.com; hello@bookwithregent.com)';

const SPOTS = [
  { file: 'austin-franklin-barbecue.jpg', wiki: 'Franklin Barbecue', search: 'Franklin Barbecue Austin', urls: ['https://franklinbbq.com/'] },
  { file: 'austin-terry-blacks.jpg', wiki: "Terry Black's Barbecue", search: "Terry Black's Barbecue Austin", urls: ['https://terryblacksbbq.com/'] },
  { file: 'austin-rainey-street.jpg', wiki: 'Rainey Street Historic District', search: 'Rainey Street Austin bars', urls: ['https://www.austintexas.org/things-to-do/nightlife/rainey-street/', 'https://www.austintexas.org/listings/rainey-street-historic-district/'] },
  { file: 'austin-sixth-street.jpg', wiki: 'Sixth Street (Austin, Texas)', search: 'Sixth Street Austin night', urls: ['https://www.austintexas.org/things-to-do/nightlife/sixth-street/', 'https://www.visit6thstreet.com/'] },
  { file: 'austin-zilker-park.jpg', wiki: 'Zilker Park', search: 'Zilker Park Austin skyline', urls: ['https://www.austintexas.gov/department/zilker-metropolitan-park', 'https://zilkerparkconservancy.org/'] },
  { file: 'austin-barton-springs.jpg', wiki: 'Barton Springs Pool', search: 'Barton Springs Pool Austin', urls: ['https://www.austintexas.gov/department/barton-springs-pool'] },
  { file: 'austin-lady-bird-lake.jpg', wiki: 'Lady Bird Lake', search: 'Lady Bird Lake Austin trail', urls: ['https://thetrailconservancy.org/', 'https://www.thetrailconservancy.org/'] },
  { file: 'austin-mount-bonnell.jpg', wiki: 'Mount Bonnell', search: 'Mount Bonnell view Lake Austin', urls: ['https://www.austintexas.gov/department/covert-park-mount-bonnell', 'https://www.austintexas.gov/page/covert-park-mt-bonnell'] },
  { file: 'austin-wildflower-center.jpg', wiki: 'Lady Bird Johnson Wildflower Center', search: 'Lady Bird Johnson Wildflower Center', urls: ['https://www.wildflower.org/'] },
  { file: 'austin-south-congress.jpg', wiki: 'South Congress', search: 'South Congress Avenue Austin', urls: ['https://www.austintexas.org/things-to-do/shopping/south-congress/', 'https://southcongress.org/'] },
  { file: 'austin-the-domain.jpg', wiki: 'The Domain (Austin, Texas)', search: 'The Domain Austin shopping', urls: ['https://www.simon.com/mall/the-domain', 'https://www.domainnorthside.com/'] },
  { file: 'austin-whole-foods-flagship.jpg', wiki: null, search: 'Whole Foods Market Lamar Austin flagship', urls: ['https://www.wholefoodsmarket.com/stores/lamar'] },
  { file: 'austin-blanton-museum.jpg', wiki: 'Blanton Museum of Art', search: 'Blanton Museum of Art Austin', urls: ['https://blantonmuseum.org/'] },
  { file: 'austin-acl-live.jpg', wiki: 'ACL Live at the Moody Theater', search: 'ACL Live Moody Theater Austin', urls: ['https://www.acllive.com/'] },
  { file: 'austin-bullock-museum.jpg', wiki: 'Bullock Texas State History Museum', search: 'Bullock Texas State History Museum', urls: ['https://www.thestoryoftexas.com/'] },
  { file: 'austin-texas-capitol.jpg', wiki: 'Texas State Capitol', search: 'Texas State Capitol Austin', urls: ['https://tspb.texas.gov/prop/tc/tc/capitol.html', 'https://tspb.texas.gov/'] },
  { file: 'austin-congress-bridge-bats.jpg', wiki: 'Ann W. Richards Congress Avenue Bridge', search: 'Congress Avenue Bridge bats Austin', urls: ['https://www.austintexas.org/things-to-do/outdoors/bats/', 'https://batcon.org/about-bats/bats-101/congress-avenue-bridge/'] },
  { file: 'austin-thinkery.jpg', wiki: 'Thinkery', search: 'Thinkery Austin children museum', urls: ['https://thinkeryaustin.org/'] },
  { file: 'austin-zoo.jpg', wiki: 'Austin Zoo', search: 'Austin Zoo', urls: ['https://austinzoo.org/'] },
  { file: 'austin-q2-stadium.jpg', wiki: 'Q2 Stadium', search: 'Q2 Stadium Austin FC', urls: ['https://www.q2stadium.com/', 'https://www.austinfc.com/'] },
  { file: 'austin-cota.jpg', wiki: 'Circuit of the Americas', search: 'Circuit of the Americas tower', urls: ['https://circuitoftheamericas.com/'] },
  { file: 'austin-moody-center.jpg', wiki: 'Moody Center', search: 'Moody Center Austin arena', urls: ['https://moodycenteratx.com/'] },
  { file: 'austin-topgolf.jpg', wiki: null, search: 'Topgolf Austin', urls: ['https://topgolf.com/us/austin/'] }
];

// Links used by the Austin sample events (server.js getSampleEvents).
const EVENT_URLS = ['https://www.acllive.com', 'https://www.austinfc.com', 'https://moodycenteratx.com',
  'https://drafthouse.com', 'https://sustainablefoodcenter.org', 'https://www.austintexas.org',
  'https://circuitoftheamericas.com', 'https://austintheatre.org'];

const CARTO_KEY = 'cb1_3ybe_1_5724dc413473bb29ba767126';
const TILE = '11/467/843'; // central Austin at z11

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function api(host, params) {
  const url = `https://${host}/w/api.php?` + new URLSearchParams({ format: 'json', formatversion: '2', origin: '*', ...params });
  for (let attempt = 0; attempt < 3; attempt++) {
    const r = await fetch(url, { headers: { 'User-Agent': UA } });
    if (r.ok) return r.json();
    await sleep(1500 * (attempt + 1));
  }
  throw new Error('API failed: ' + url);
}

const stripTags = s => String(s || '').replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();

function isFree(meta) {
  const lic = (meta.LicenseShortName && meta.LicenseShortName.value) || '';
  const restrict = (meta.NonFree && meta.NonFree.value) || '';
  if (/true/i.test(restrict)) return false;
  if (/fair use|non-free/i.test(lic)) return false;
  return /cc|public domain|pd|gfdl|attribution|no restrictions/i.test(lic);
}

// imageinfo for a File: title on commons (falls back to enwiki for local files)
async function fileInfo(fileTitle) {
  for (const host of ['commons.wikimedia.org', 'en.wikipedia.org']) {
    const j = await api(host, { action: 'query', titles: fileTitle, prop: 'imageinfo', iiprop: 'url|size|mime|extmetadata', iiurlwidth: '1600' });
    const p = j.query && j.query.pages && j.query.pages[0];
    if (p && !p.missing && p.imageinfo && p.imageinfo[0]) return { host, title: p.title, ...p.imageinfo[0] };
  }
  return null;
}

function usable(info) {
  if (!info) return false;
  if (!/jpeg/i.test(info.mime)) return false;
  if ((info.width || 0) < 900 || (info.height || 0) < 500) return false;
  if (info.width / info.height > 3 || info.height / info.width > 1.6) return false; // panoramas / tall shots crop badly
  return isFree(info.extmetadata || {});
}

async function pickImage(spot) {
  const tried = [];
  if (spot.wiki) {
    const j = await api('en.wikipedia.org', { action: 'query', titles: spot.wiki, redirects: '1', prop: 'pageimages', piprop: 'name', pilicense: 'any' });
    const p = j.query && j.query.pages && j.query.pages[0];
    if (p && p.pageimage) {
      const info = await fileInfo('File:' + p.pageimage);
      tried.push({ source: 'wikipedia-lead', title: info && info.title, ok: usable(info) });
      if (usable(info)) return { info, tried, via: 'wikipedia-lead' };
    } else tried.push({ source: 'wikipedia-lead', none: true, page: p && p.title, missing: p && p.missing });
  }
  const s = await api('commons.wikimedia.org', { action: 'query', list: 'search', srsearch: spot.search + ' filetype:bitmap', srnamespace: '6', srlimit: '15' });
  for (const hit of (s.query && s.query.search) || []) {
    if (!/\.jpe?g$/i.test(hit.title)) continue;
    const info = await fileInfo(hit.title);
    tried.push({ source: 'commons-search', title: hit.title, ok: usable(info) });
    if (usable(info)) return { info, tried, via: 'commons-search' };
  }
  return { info: null, tried };
}

async function download(url) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const r = await fetch(url, { headers: { 'User-Agent': UA } });
    if (r.ok) return Buffer.from(await r.arrayBuffer());
    await sleep(2000 * (attempt + 1));
  }
  throw new Error('download failed ' + url);
}

async function checkUrl(url) {
  try {
    const r = await fetch(url, {
      redirect: 'follow',
      headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36', 'Accept': 'text/html,application/xhtml+xml' },
      signal: AbortSignal.timeout(20000)
    });
    return { url, status: r.status, finalUrl: r.url };
  } catch (e) {
    return { url, status: 0, error: String(e.message || e) };
  }
}

async function tileCheck(style, withKey) {
  const url = `https://a.basemaps.cartocdn.com/${style}/${TILE}.png` + (withKey ? `?key=${CARTO_KEY}` : '');
  try {
    const r = await fetch(url, { headers: { 'User-Agent': UA, Referer: 'https://www.bookwithregent.com/' } });
    const buf = Buffer.from(await r.arrayBuffer());
    const hash = (await import('node:crypto')).createHash('md5').update(buf).digest('hex');
    return { style, withKey, status: r.status, type: r.headers.get('content-type'), bytes: buf.length, md5: hash };
  } catch (e) {
    return { style, withKey, status: 0, error: String(e.message || e) };
  }
}

const credits = {};
const report = { generatedAt: new Date().toISOString(), photos: [], links: [], eventLinks: [], tiles: [] };

for (const spot of SPOTS) {
  let entry = { file: spot.file };
  try {
    const { info, tried, via } = await pickImage(spot);
    entry.tried = tried;
    if (info) {
      const src = info.thumburl || info.url;
      const raw = await download(src);
      const out = await sharp(raw).rotate().resize({ width: 1280, height: 960, fit: 'cover', position: 'attention' }).jpeg({ quality: 80, mozjpeg: true }).toBuffer();
      await fs.writeFile(path.join(OUT_DIR, spot.file), out);
      const m = info.extmetadata || {};
      credits[spot.file] = {
        author: stripTags(m.Artist && m.Artist.value) || 'Unknown',
        license: (m.LicenseShortName && m.LicenseShortName.value) || '',
        licenseUrl: (m.LicenseUrl && m.LicenseUrl.value) || '',
        source: info.descriptionurl || ''
      };
      entry = { ...entry, via, title: info.title, bytes: out.length, ...credits[spot.file] };
    } else entry.missing = true;
  } catch (e) {
    entry.error = String(e.message || e);
  }
  report.photos.push(entry);
  console.log(JSON.stringify(entry));
  for (const u of spot.urls) report.links.push({ file: spot.file, ...(await checkUrl(u)) });
  await sleep(300);
}
for (const u of EVENT_URLS) report.eventLinks.push(await checkUrl(u));
for (const style of ['light_all', 'dark_all', 'rastertiles/voyager']) {
  report.tiles.push(await tileCheck(style, false));
  report.tiles.push(await tileCheck(style, true));
}

await fs.writeFile(path.join(OUT_DIR, 'austin-credits.json'), JSON.stringify(credits, null, 2) + '\n');
await fs.writeFile(path.join(ROOT, 'scripts/austin-assets-report.json'), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ links: report.links, eventLinks: report.eventLinks, tiles: report.tiles }, null, 1));

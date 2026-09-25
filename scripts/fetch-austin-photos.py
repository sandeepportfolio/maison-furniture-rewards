#!/usr/bin/env python3
"""Rebuild the Austin attraction photos in public/images/attractions/.

Every photo is a freely licensed (CC BY / CC BY-SA / GFDL) image from one of
two public research datasets, both served from Amazon S3:

  oi   Open Images (Flickr, CC BY 2.0) — s3.amazonaws.com/open-images-dataset
  gld  Google Landmarks Dataset v2 (Wikimedia Commons) —
       s3.amazonaws.com/google-landmark. Train images live in 500 tars
       sorted by image id; this script finds the tar from each tar's first
       entry, then binary-searches inside it with HTTP range requests, so no
       1 GB tar is ever downloaded.

Each image was chosen by eye from the candidates for its landmark (Open Images
by photo title, GLD by the landmark's Wikimedia Commons category). This
script re-downloads exactly those picks, crops them to 4:3 (no upscaling;
``focus`` is the vertical crop centre for portrait shots), and rewrites
austin-credits.json with author, licence and source for the on-page credits.

Usage: pip install pillow && python3 scripts/fetch-austin-photos.py
"""
import bisect, csv, io, json, os, re, time, urllib.error, urllib.request
from PIL import Image, ImageOps

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'public', 'images', 'attractions')
OI_META = 'https://storage.googleapis.com/openimages/2018_04/image_ids_and_rotation.csv'
GLD = 'https://s3.amazonaws.com/google-landmark'

# (output file, source, image id, open-images subset, rotation, crop focus)
PICKS = [
    ('austin-franklin-barbecue.jpg', 'oi', '6ab02fff2175ed4f', 'train', 0, 0.5),
    ('austin-salt-lick.jpg', 'oi', '159a4c796a2578aa', 'train', 0, 0.5),
    ('austin-sixth-street.jpg', 'oi', 'a1c52551cc1f1a4f', 'train', 0, 0.5),
    ('austin-driskill.jpg', 'oi', '951779d76d2d7bdf', 'train', 0, 0.5),
    ('austin-barton-springs.jpg', 'oi', 'a4e047a3f0d9362d', 'train', 0, 0.5),
    ('austin-lady-bird-lake.jpg', 'oi', '47c9e7de1d3f4a97', 'train', 0, 0.5),
    ('austin-mount-bonnell.jpg', 'oi', '69af383d730dfd46', 'train', 0, 0.5),
    ('austin-south-congress.jpg', 'oi', 'd07e4b892caddbf4', 'train', 0, 0.12),
    ('austin-allens-boots.jpg', 'oi', 'c2c2d7d069b788a7', 'train', 0, 0.38),
    ('austin-the-domain.jpg', 'oi', '6677c0adbc6477e8', 'train', 0, 0.5),
    ('austin-continental-club.jpg', 'oi', 'ee4970ff7b6e85d9', 'train', 0, 0.5),
    ('austin-texas-capitol.jpg', 'oi', 'a44e1436045e3f76', 'train', 0, 0.5),
    ('austin-congress-bridge-bats.jpg', 'oi', '040503d12657745f', 'train', 0, 0.5),
    ('austin-zilker-botanical-garden.jpg', 'oi', '53142d9e257a3b17', 'train', 0, 0.5),
    ('austin-rainey-street.jpg', 'gld', '04f2d889f337dae7', None, 0, 0.5),
    ('austin-zilker-park.jpg', 'gld', 'ec906c18ce06a57f', None, 0, 0.5),
    ('austin-wildflower-center.jpg', 'gld', 'd3fdd564cd5ac3c7', None, 0, 0.5),
    ('austin-hamilton-pool.jpg', 'gld', 'cc4dbbe6418feb24', None, 0, 0.5),
    ('austin-blanton-museum.jpg', 'gld', '81e2152d001dff93', None, 0, 0.5),
    ('austin-lbj-library.jpg', 'gld', 'f61b488c2b6091a2', None, 0, 0.5),
    ('austin-long-center.jpg', 'gld', '92668a725f05f65a', None, 0, 0.5),
    ('austin-zoo.jpg', 'gld', '133ef35c1afe3eb7', None, 0, 0.5),
    ('austin-cota.jpg', 'gld', '7f550b0076f6791f', None, 0, 0.5),
    ('austin-dkr-stadium.jpg', 'gld', '25033b4e0fec1f54', None, 0, 0.5),
    ('austin-barton-creek-greenbelt.jpg', 'gld', '5a62fe8facbade6e', None, 0, 0.5),
    ('austin-lake-travis.jpg', 'gld', '408c93351a820abf', None, 0, 0.5),
]

def get(url, a=None, b=None, tries=6):
    # S3 answers 503 SlowDown under bursts of range requests; back off and retry.
    for attempt in range(tries):
        req = urllib.request.Request(url)
        if a is not None: req.add_header('Range', f'bytes={a}-{b}')
        try:
            with urllib.request.urlopen(req, timeout=120) as r: return r.read()
        except urllib.error.HTTPError as e:
            if e.code not in (500, 502, 503, 504) or attempt == tries - 1: raise
        time.sleep(2 ** attempt)

def gld_tar_index():
    starts = []
    for t in range(500):
        name = get(f'{GLD}/train/images_{t:03d}.tar', 0, 99).split(b'\0')[0].decode()
        starts.append((name.split('/')[-1][:16], t))
    return sorted(starts)

NAME = re.compile(rb'^[0-9a-f]/[0-9a-f]/[0-9a-f]/([0-9a-f]{16})\.jpg\x00')
def headers(buf, base):
    out = []
    for off in range(0, len(buf) - 512, 512):
        blk = buf[off:off + 512]
        m = NAME.match(blk) if blk[257:262] == b'ustar' else None
        if m: out.append((m.group(1).decode(), base + off, int(blk[124:136].strip(b'\0 ') or b'0', 8)))
    return out

def gld_image(img_id, index):
    t = index[bisect.bisect_right([s for s, _ in index], img_id) - 1][1]
    url = f'{GLD}/train/images_{t:03d}.tar'
    with urllib.request.urlopen(urllib.request.Request(url, method='HEAD'), timeout=60) as r:
        n = int(r.headers['Content-Length'])
    lo, hi, W = 0, n // 512, 262144
    while hi - lo > W // 512:
        mid = (lo + hi) // 2
        hs = headers(get(url, mid * 512, mid * 512 + W - 1), mid * 512)
        if hs and hs[0][0] > img_id: hi = mid
        else: lo = mid
    pos = lo * 512
    while True:
        for hid, hoff, size in headers(get(url, pos, pos + 4 * W - 1), pos):
            if hid == img_id: return get(url, hoff + 512, hoff + 512 + size - 1)
            if hid > img_id: raise LookupError(img_id)
        pos += 4 * W - 2048

def gld_attribution(ids):
    found = {}
    with urllib.request.urlopen(f'{GLD}/metadata/train_attribution.csv', timeout=600) as r:
        for row in csv.reader(io.TextIOWrapper(r, encoding='utf-8')):
            if row and row[0] in ids: found[row[0]] = {'source': row[1], 'author': row[2], 'license': row[3]}
    return found

def oi_attribution(ids):
    found = {}
    with urllib.request.urlopen(OI_META, timeout=600) as r:
        for row in csv.reader(io.TextIOWrapper(r, encoding='utf-8')):
            if row and row[0] in ids: found[row[0]] = {'source': row[3], 'author': row[6], 'license': row[4]}
    return found

def licence(s):
    s = s.strip()
    if s.startswith('https://creativecommons.org/licenses/by/2.0'): return 'CC BY 2.0', 'https://creativecommons.org/licenses/by/2.0/'
    m = re.findall(r'(CC[- ]BY(?:-SA)?[- ][0-9.]+)\((https?://[^)]+)\)', s)
    if m: return m[-1][0].replace('-', ' ').replace('CC BY SA', 'CC BY-SA'), m[-1][1]
    m = re.match(r'([^(]+)\((https?://[^)]+)\)', s)
    return (m.group(1).strip(), m.group(2)) if m else (s, '')

def main():
    attr = oi_attribution({p[2] for p in PICKS if p[1] == 'oi'})
    attr.update(gld_attribution({p[2] for p in PICKS if p[1] == 'gld'}))
    index = gld_tar_index() if any(p[1] == 'gld' for p in PICKS) else None
    credits = {}
    for fn, src, img_id, subset, rot, focus in PICKS:
        raw = get(f'https://s3.amazonaws.com/open-images-dataset/{subset}/{img_id}.jpg') if src == 'oi' else gld_image(img_id, index)
        im = ImageOps.exif_transpose(Image.open(io.BytesIO(raw))).convert('RGB')
        if rot: im = im.rotate(-rot, expand=True)
        w, h = im.size
        if w / h > 4 / 3:
            nw = int(h * 4 / 3); x = (w - nw) // 2; im = im.crop((x, 0, x + nw, h))
        else:
            nh = int(w * 3 / 4); y = int(max(0, min(h - nh, focus * h - nh / 2))); im = im.crop((0, y, w, y + nh))
        if im.width > 1280: im = im.resize((1280, 960), Image.LANCZOS)
        im.save(os.path.join(OUT, fn), quality=82, optimize=True, progressive=True)
        a = attr[img_id]; name, url = licence(a['license'])
        credits[fn] = {'author': re.sub(r'^https?://www\.flickr\.com/photos/([^/]+)/?$', r'\1', a['author'].strip()),
                       'license': name, 'licenseUrl': url, 'source': a['source'],
                       'via': 'Open Images (Flickr)' if src == 'oi' else 'Google Landmarks v2 (Wikimedia Commons)'}
        print('wrote', fn)
    with open(os.path.join(OUT, 'austin-credits.json'), 'w') as f:
        json.dump(credits, f, indent=2, ensure_ascii=False); f.write('\n')

if __name__ == '__main__':
    main()

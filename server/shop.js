/* The SHOP + CABINET (test tier — same deal as server/paid.js: the mechanics
   are real, the money is stubbed at marked STRIPE seams).

   Two kinds of products:
     · RECORDS (albums) — playable music. Drop an album folder into
       `albums/<Artist - Title>/` (repo root, NOT under audio/) and it becomes
       a product automatically; its files stream ONLY through the purchase-
       gated endpoint below (a guard in index.js blocks /albums from the
       static server). A demo record built from the deployed audio/Pulse
       tracks ships so the shop works out of the box.
     · ART (VJ packs) — procedural print packs. The catalog carries each
       pack's seed + palette; the console renders the pieces on canvases in
       the cabinet (index.html stays self-contained — no image assets).

   Purchases are keyed by user id (verified session in production; the dev
   escape hatch identity locally — see paid.js requester) and persist in
   server/.shop-data.json (dotfile → express.static never serves it; also
   gitignored). Tier 2b swap: the inline stub-pay in /buy → Stripe Checkout +
   an idempotent webhook, and this JSON file → a `purchases` table in Postgres.

   API:
     GET  /api/shop                         catalog (public)
     GET  /api/shop/library                 your purchases (session / ?uid= dev)
     POST /api/shop/buy   { itemId }        buy (STRIPE seam — stub-pays today)
     GET  /api/shop/records/:albumId/:n     stream track n (purchase-gated, Range OK) */
import { createReadStream, readdirSync, readFileSync, writeFileSync, renameSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { requester } from './auth.js';
import { httpError } from './store.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA = path.join(ROOT, 'server', '.shop-data.json');

// Stub price list (STRIPE: real prices live in the Checkout line items).
export const SHOP = { albumCents: 800, artCents: 400 };

const AUDIO_EXT = new Set(['.flac', '.mp3', '.m4a', '.aac', '.ogg', '.oga', '.opus', '.wav', '.webm']);
const MIME = { '.flac': 'audio/flac', '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.aac': 'audio/aac',
               '.ogg': 'audio/ogg', '.oga': 'audio/ogg', '.opus': 'audio/ogg', '.wav': 'audio/wav', '.webm': 'audio/webm' };

/* ── catalog ──────────────────────────────────────────────────────── */
// Art packs are procedural: the console draws each piece from (seed, palette).
// Adding a pack = adding a row here — no assets to ship.
const ART_PACKS = [
  { id: 'art-neon-tokyo',  title: 'Neon Tokyo · Prints Vol 1',  vibe: 'pulse',   seed: 20260701, pieces: 6,
    palette: ['#ff4fd8', '#4fd8ff', '#ffe14f', '#0a0618'] },
  { id: 'art-bedroom-fm',  title: 'Bedroom FM · Prints Vol 1',  vibe: 'ambient', seed: 20260702, pieces: 6,
    palette: ['#ffb37a', '#c94f6d', '#f3ebdd', '#140d08'] },
  { id: 'art-deep-water',  title: 'Deep Water · Prints Vol 1',  vibe: 'drift',   seed: 20260703, pieces: 6,
    palette: ['#4fd8ff', '#7fd0e0', '#a9ffd0', '#04101c'] },
];

const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);
const trackList = (dir) => readdirSync(dir)
  .filter(f => AUDIO_EXT.has(path.extname(f).toLowerCase()))
  .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));

/* Records = albums/<Name>/ folders (purchase-gated files), plus a demo record
   assembled from the deployed audio/Pulse tracks so the shelf isn't empty
   before real albums are dropped in. (The demo's FILES are also reachable via
   the public station — the demo gates the cabinet listing, not the bytes;
   real albums under albums/ are gated end to end.) */
let albumCache = { at: 0, map: null };
function scanAlbums(){
  // TTL cache: /api/shop is public and the stream endpoint hits this per Range
  // request — don't rescan the filesystem for every one of them.
  if (albumCache.map && Date.now() - albumCache.at < 3000) return albumCache.map;
  const out = new Map();   // id -> { id,title,cents,dir,files }
  try {
    for (const d of readdirSync(path.join(ROOT, 'albums'), { withFileTypes: true })){
      if (!d.isDirectory()) continue;
      const dir = path.join(ROOT, 'albums', d.name);
      const files = trackList(dir);
      if (files.length) out.set('rec-' + slug(d.name), {
        id: 'rec-' + slug(d.name), title: d.name, cents: SHOP.albumCents, dir, files, demo: false,
      });
    }
  } catch { /* no albums/ dir yet */ }
  try {
    const dir = path.join(ROOT, 'audio', 'Pulse');
    const files = trackList(dir);
    // demo:true items must NEVER reach a real Checkout at 2b — the same tracks
    // play free on the Pulse station; this exists so the shelf isn't empty.
    if (files.length && !out.size) out.set('rec-demo-short-line', {
      id: 'rec-demo-short-line', title: 'Pretty Lights · Station Cuts (demo)',
      cents: SHOP.albumCents, dir, files, demo: true,
    });
  } catch { /* no demo either */ }
  albumCache = { at: Date.now(), map: out };
  return out;
}

const publicAlbum = (a, owned) => ({
  id: a.id, kind: 'record', title: a.title, cents: a.cents, tracks: a.files.length,
  demo: a.demo, owned: !!owned,
  trackNames: a.files.map(f => f.replace(/\.[^.]+$/, '')),
});
/* The seed + palette ARE the art (the console renders prints from them), so
   the public catalog ships only the listing — the recipe rides exclusively in
   /library for owners. Otherwise a $4 pack is reconstructable from devtools. */
const publicArt = (p, owned) => ({
  id: p.id, kind: 'art', title: p.title, cents: SHOP.artCents, vibe: p.vibe,
  pieces: p.pieces, owned: !!owned,
  ...(owned ? { seed: p.seed, palette: p.palette } : {}),
});

/* ── purchases (JSON file; 2b moves this to Postgres) ─────────────── */
let purchases = {};                       // userId -> [itemId]
try { purchases = JSON.parse(readFileSync(DATA, 'utf8')).purchases || {}; } catch { /* fresh */ }
function persist(){
  // atomic: write a temp file and rename into place, so a crash mid-write can
  // never leave a truncated file that silently resets everyone's purchases
  try {
    writeFileSync(DATA + '.tmp', JSON.stringify({ purchases }, null, 2));
    renameSync(DATA + '.tmp', DATA);
  }
  catch (e) { console.warn('[shop] could not persist purchases:', e.message); }
}
const owns = (uid, itemId) => (purchases[uid] || []).includes(itemId);

/* ── wiring ───────────────────────────────────────────────────────── */
export function attachShop(app){
  app.get('/api/shop', async (req, res) => {
    const who = await requester(req).catch(() => null);   // optional — marks owned
    const albums = scanAlbums();
    res.json({
      prices: SHOP,
      records: [...albums.values()].map(a => publicAlbum(a, who && owns(who.id, a.id))),
      art: ART_PACKS.map(p => publicArt(p, who && owns(who.id, p.id))),
    });
  });

  app.get('/api/shop/library', async (req, res, next) => {
    try {
      const who = await requester(req);
      if (!who) throw httpError(401, 'sign in to open your cabinet');
      const albums = scanAlbums();
      const mine = purchases[who.id] || [];
      res.json({
        records: mine.map(id => albums.get(id)).filter(Boolean).map(a => publicAlbum(a, true)),
        art: ART_PACKS.filter(p => mine.includes(p.id)).map(p => publicArt(p, true)),
      });
    } catch (e) { next(e); }
  });

  app.post('/api/shop/buy', async (req, res, next) => {
    try {
      const who = await requester(req);
      if (!who) throw httpError(401, 'sign in to buy');
      const itemId = String(req.body?.itemId || '');
      const albums = scanAlbums();
      const item = albums.get(itemId) || ART_PACKS.find(p => p.id === itemId);
      if (!item) throw httpError(404, 'no such item');
      if (owns(who.id, itemId)) throw httpError(409, 'already in your cabinet');
      const cents = item.cents || SHOP.artCents;
      // STRIPE: this inline stub is the seam — in 2b this endpoint returns
      // { checkoutUrl } and the purchase lands in the webhook on
      // `checkout.session.completed`. The webhook MUST be idempotent (Stripe
      // retries): re-check owns() before pushing, exactly as below. And skip
      // Checkout entirely for demo:true items — they're free-station tracks.
      const pay = { ok: true, cents, payer: who.id };
      if (!pay.ok) throw httpError(402, 'payment failed');
      if (!owns(who.id, itemId)) (purchases[who.id] ||= []).push(itemId);   // race-proof double-buy guard
      persist();
      res.status(201).json({ ok: true, itemId, cents });
    } catch (e) { next(e); }
  });

  // Purchase-gated track streaming with Range support (seek works).
  app.get('/api/shop/records/:albumId/:n', async (req, res, next) => {
    try {
      const who = await requester(req);
      if (!who) throw httpError(401, 'sign in first');
      const album = scanAlbums().get(req.params.albumId);
      if (!album) throw httpError(404, 'no such record');
      if (!owns(who.id, album.id)) throw httpError(402, 'buy this record to play it');
      const idx = +req.params.n;
      const file = album.files[idx];
      if (!file || !Number.isInteger(idx)) throw httpError(404, 'no such track');
      const full = path.join(album.dir, file);
      const size = statSync(full).size;
      const type = MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
      // pipe() with a guarded stream: a read error (file yanked mid-stream, bad
      // symlink, disk hiccup) must fail THIS request, never crash the process —
      // and a listener hanging up must release the file handle (mirrors the
      // audio relay in index.js).
      const send = (rs) => {
        res.on('close', () => rs.destroy());
        rs.on('error', () => { try { if (!res.headersSent) res.status(500); res.end(); } catch { /* gone */ } });
        rs.pipe(res);
      };
      const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
      if (m && (m[1] || m[2])){
        const start = m[1] ? +m[1] : Math.max(0, size - +m[2]);
        const end = m[1] && m[2] ? Math.min(+m[2], size - 1) : size - 1;
        if (start >= size || start > end){   // unsatisfiable (incl. bytes=100-50) → 416, not a 500
          res.status(416).setHeader('Content-Range', `bytes */${size}`); return res.end();
        }
        res.status(206);
        res.setHeader('Content-Range', `bytes ${start}-${end}/${size}`);
        res.setHeader('Content-Length', end - start + 1);
        res.setHeader('Accept-Ranges', 'bytes');
        res.setHeader('Content-Type', type);
        send(createReadStream(full, { start, end }));
      } else {
        res.setHeader('Content-Length', size);
        res.setHeader('Accept-Ranges', 'bytes');
        res.setHeader('Content-Type', type);
        send(createReadStream(full));
      }
    } catch (e) { next(e); }
  });
}

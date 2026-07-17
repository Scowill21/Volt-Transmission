/* Volt Transmission API (ROADMAP Tier 1b) — one small Node service that
   serves BOTH the static site (repo root: index.html, admin.html, audio/)
   and the channels API the console's dropdowns fetch.

   Run locally:   node server/index.js          (JSON-file store, port 8787)
   On Render:     see render.yaml               (Postgres via DATABASE_URL)

   Admin endpoints require the X-Admin-Key header. The key comes from the
   ADMIN_KEY env var; local dev falls back to "dev" (with a console warning)
   so the admin page works out of the box.

   API (JSON):
     GET    /api/channels                        public — the dropdowns' data
     POST   /api/channels                        { name, slug?, defaultScene? }
     PATCH  /api/channels/:id                    { name?, defaultScene? }
     DELETE /api/channels/:id
     POST   /api/channels/:id/vjs                { name, plane, scene? }
     DELETE /api/channels/:id/vjs/:vjId
   Accounts (Tier 2a — server/auth.js, Supabase Auth behind cookies):
     POST   /api/auth/signup | login | logout
     GET    /api/me                              { user | null } — never errors
     POST   /api/apply                           { role: vj|radio, note? }
     GET    /api/admin/applications              pending applications
     POST   /api/admin/applications/:userId      { action: approve|decline }
   Live-action bus (Tier 4 slice — server/bus.js):
     WS     /api/bus?channel=<id>[&as=vj]        subscribe + publish actions
     POST   /api/channels/:id/actions            inject a message by HTTP
   Paid features, test tier (server/paid.js — Stripe stubbed at the seams):
     GET    /api/channels/:id/queues             control + song queues (public)
     POST   /api/channels/:id/control/request    bid for the visual controls
     POST   /api/channels/:id/control/cancel     leave queue / release slot
     POST   /api/channels/:id/songs/request      { title } song request
     POST   /api/channels/:id/songs/:songId      { action: played|refund }  (admin)
     POST   /api/channels/:id/control/skip       end current slot            (admin)
   Preset music:
     GET    /api/audio                            manifest of audio/<Category>/ files
   Shop + cabinet (server/shop.js — Stripe stubbed at the seams):
     GET    /api/shop                             catalog: records + art packs
     GET    /api/shop/library                     your purchases
     POST   /api/shop/buy                         { itemId }
     GET    /api/shop/records/:albumId/:n         stream a purchased track
   Volt Control — pay-to-control items (server/items.js, /control page):
     GET    /api/items/:code                      public — item meta + live state
     POST   /api/items/:code/buy                  buy-now: take/queue a control slot
     POST   /api/items/:code/bid                  { cents } soft-close auction bid
     POST   /api/items/:code/cancel               leave the line / surrender the slot
     GET    /api/items                            all items + live state       (admin)
     POST   /api/items                            create (server makes the code) (admin)
     PATCH  /api/items/:code                      edit price/slot/mode/…        (admin)
     DELETE /api/items/:code                                                    (admin)
     POST   /api/items/:code/skip                 end the current slot          (admin)
     POST   /api/items/:code/state                { action: pause|resume|on|off } (admin)
*/
import express from 'express';
import path from 'node:path';
import http from 'node:http';
import https from 'node:https';
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createStore, httpError } from './store.js';
import { initAuth, mountAuth, authConfigured } from './auth.js';
import { attachBus } from './bus.js';
import { attachPaid } from './paid.js';
import { attachShop } from './shop.js';
import { attachItems } from './items.js';
import { securityHeaders, makeRequireAdmin, makeRateLimiter, adminDisabledInProd, assertPublicUrl } from './security.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = process.env.PORT || 8787;

const ADMIN_KEY = process.env.ADMIN_KEY || 'dev';
if (!process.env.ADMIN_KEY) console.warn('[admin] ADMIN_KEY not set — using the dev default ("dev"). Set it in production.');
if (adminDisabledInProd()) console.error('[admin] ⛔ ADMIN_KEY is unset/"dev" on a Supabase-configured deploy — admin endpoints are DISABLED (fail-closed) until you set a real ADMIN_KEY.');

const store = await createStore();
await initAuth();
console.log('[auth]', authConfigured() ? 'supabase configured' : 'not configured — accounts disabled, console runs as before');
const app = express();
app.set('trust proxy', 1);                 // Render sits in front — trust ONE hop for a correct req.ip (rate-limit / lockout key)
app.disable('x-powered-by');
app.use(securityHeaders);                  // anti-clickjacking / nosniff / referrer / HSTS on every response
app.use(express.json({ limit: '32kb' }));

// Per-IP rate limits on STATE-CHANGING routes (reads are never throttled): a
// tight budget on auth (password/brute-force) + a generous one on the paid
// control-plane mutations (buy/bid/jukebox flooding + monopolisation).
app.use(['/api/auth/login', '/api/auth/signup'], makeRateLimiter({ windowMs: 5 * 60 * 1000, max: 30 }));
// Generous: a whole VENUE shares one WiFi egress IP, so this is a flood backstop
// (per-user abuse is already bounded by the bid cooldown, queue caps, skip latch),
// NOT a per-person cap — keep it high enough for a busy bar.
app.use(['/api/items', '/api/channels'], makeRateLimiter({ windowMs: 60 * 1000, max: 300 }));

/* ── public ── */
app.get('/healthz', (req, res) => res.json({ ok: true }));
app.get('/api/channels', async (req, res, next) => {
  try { res.json(await store.list()); } catch (e) { next(e); }
});

/* Preset music manifest: lists whatever files sit in audio/<Category>/ so the
   console's Offline stations auto-play the deployed songs — drop files in the
   folder, redeploy, done (no per-song code edit). Folder name (any case) maps
   to a station id; only audio files are listed, natural-sorted. The console
   falls back to the static PRESET_TRACKS when this isn't reachable. */
const AUDIO_EXT = new Set(['.flac', '.mp3', '.m4a', '.aac', '.ogg', '.oga', '.opus', '.wav', '.webm']);
const AUDIO_STATIONS = new Set(['ambient', 'pulse', 'static', 'drift']);
app.get('/api/audio', (req, res) => {
  const out = {};
  try {
    for (const dir of readdirSync(path.join(ROOT, 'audio'), { withFileTypes: true })){
      if (!dir.isDirectory()) continue;
      const id = dir.name.toLowerCase();
      if (!AUDIO_STATIONS.has(id)) continue;
      const files = readdirSync(path.join(ROOT, 'audio', dir.name))
        .filter(f => AUDIO_EXT.has(path.extname(f).toLowerCase()))
        .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
      if (files.length) out[id] = files.map(f => ({
        name: f.replace(/\.[^.]+$/, ''),                        // display name (extension stripped)
        url: 'audio/' + encodeURIComponent(dir.name) + '/' + encodeURIComponent(f),
      }));
    }
  } catch { /* no audio/ dir → empty manifest; the console keeps PRESET_TRACKS */ }
  res.json(out);
});

/* Live-audio relay (Tier 3a): pipes the channel's upstream stream through our
   origin. The console plays THIS instead of the raw URL, so the Web Audio
   analyser is never CORS-tainted and any stream host works — admins paste a
   URL without caring about CORS. Costs us the bandwidth (fine at this scale;
   the LiveKit tier replaces it). */
app.get('/api/channels/:id/audio', async (req, res, next) => {
  try {
    const channel = (await store.list()).find(c => c.id === req.params.id);
    if (!channel || !channel.audioUrl) throw httpError(404, 'channel has no live audio');

    // SSRF guard: this relay is PUBLIC and pipes the upstream body back, so an
    // audioUrl (or a redirect off it) pointed at a metadata / internal host would
    // exfiltrate internal responses. assertPublicUrl validates the target AND
    // returns the pinned IP; we connect to THAT exact IP (lookup override), so a
    // DNS-rebind between validation and connect can't swing us to a private host.
    // Redirects are followed manually, re-validated per hop; a hung connect times
    // out. (Live streams are unbounded by design → no byte cap.)
    let target = channel.audioUrl, upstream = null, gone = false;
    let liveReq = null;
    res.on('close', () => { gone = true; if (liveReq) liveReq.destroy(); if (upstream) upstream.destroy(); });

    for (let hop = 0; hop < 4 && !gone; hop++){
      const { url, ip, family } = await assertPublicUrl(target);   // throws 400/403/502 if non-public
      const mod = url.protocol === 'https:' ? https : http;
      upstream = await new Promise((resolve) => {
        const r = mod.request(url, {
          method: 'GET',
          headers: { 'user-agent': 'VoltTransmission-relay' },
          servername: url.hostname,                                 // TLS SNI stays the hostname (cert still validates)
          lookup: (h, o, cb) => cb(null, ip, family),               // PIN the validated IP — closes the rebind window
          timeout: 10000,
        }, resolve);
        liveReq = r;
        r.on('timeout', () => r.destroy(new Error('connect timeout')));
        r.on('error', () => resolve(null));
        r.end();
      });
      if (!upstream) break;                                         // connect error → 502 below
      const sc = upstream.statusCode || 0;
      if (sc >= 300 && sc < 400 && upstream.headers.location){
        target = new URL(upstream.headers.location, url).href;      // re-validated + re-pinned next loop
        upstream.resume();                                          // drain the redirect body
        upstream = null;
        continue;
      }
      break;
    }
    if (gone) return;
    if (!upstream || (upstream.statusCode || 0) >= 400) throw httpError(502, 'upstream stream unreachable');

    res.status(200);
    res.setHeader('Content-Type', upstream.headers['content-type'] || 'audio/mpeg');
    res.setHeader('Cache-Control', 'no-store');
    upstream.on('error', () => res.end());
    upstream.pipe(res);
  } catch (e) { next(e); }
});

/* ── admin (X-Admin-Key) ──
   Hardened in security.js: constant-time key compare, per-IP brute-force
   lockout, and FAIL-CLOSED when a Supabase-configured deploy is left on the
   insecure 'dev'/unset key. */
const requireAdmin = makeRequireAdmin(ADMIN_KEY);

app.post('/api/channels', requireAdmin, async (req, res, next) => {
  try { res.status(201).json(await store.createChannel(req.body || {})); } catch (e) { next(e); }
});
app.patch('/api/channels/:id', requireAdmin, async (req, res, next) => {
  try { res.json(await store.updateChannel(req.params.id, req.body || {})); } catch (e) { next(e); }
});
app.delete('/api/channels/:id', requireAdmin, async (req, res, next) => {
  try { await store.deleteChannel(req.params.id); res.status(204).end(); } catch (e) { next(e); }
});
app.post('/api/channels/:id/vjs', requireAdmin, async (req, res, next) => {
  try { res.status(201).json(await store.addVJ(req.params.id, req.body || {})); } catch (e) { next(e); }
});
app.delete('/api/channels/:id/vjs/:vjId', requireAdmin, async (req, res, next) => {
  try { await store.removeVJ(req.params.id, req.params.vjId); res.status(204).end(); } catch (e) { next(e); }
});

/* ── accounts + roles (Tier 2a) ── */
mountAuth(app, requireAdmin);

/* ── paid features, test tier: control queue + song requests (server/paid.js) ── */
attachPaid(app, requireAdmin);

/* ── shop + cabinet: records + art packs (server/shop.js) ── */
attachShop(app);

/* ── Volt Control: pay-to-control items (server/items.js, /control page) ── */
await attachItems(app, requireAdmin, store);

/* ── the site itself (console + admin + audio/) ── */
// albums/ holds PURCHASE-GATED records — never serve it statically; tracks
// stream only through /api/shop/records/:albumId/:n (which checks ownership).
app.use('/albums', (req, res) => res.status(403).json({ error: 'records stream via the shop — purchase required' }));
// dotfiles:'ignore' is serve-static's default, but the shop's purchase file
// (server/.shop-data.json) depends on it — pin it so an upgrade can't flip it.
app.use(express.static(ROOT, { extensions: ['html'], dotfiles: 'ignore' }));

/* ── errors → JSON (store throws httpError(status, message)) ── */
app.use((err, req, res, next) => {   // eslint-disable-line no-unused-vars
  const status = err.status || 500;
  if (status >= 500) console.error(err);
  res.status(status).json({ error: err.message || 'server error' });
});

const server = app.listen(PORT, () => console.log(`[volt] site + api on http://localhost:${PORT}`));
attachBus(server, app);   // live-action bus: wss://…/api/bus?channel=<id> (see server/bus.js)

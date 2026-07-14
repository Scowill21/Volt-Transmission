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
*/
import express from 'express';
import path from 'node:path';
import { readdirSync } from 'node:fs';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { createStore, httpError } from './store.js';
import { initAuth, mountAuth, authConfigured } from './auth.js';
import { attachBus } from './bus.js';
import { attachPaid } from './paid.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = process.env.PORT || 8787;

const ADMIN_KEY = process.env.ADMIN_KEY || 'dev';
if (!process.env.ADMIN_KEY) console.warn('[admin] ADMIN_KEY not set — using the dev default ("dev"). Set it in production.');

const store = await createStore();
await initAuth();
console.log('[auth]', authConfigured() ? 'supabase configured' : 'not configured — accounts disabled, console runs as before');
const app = express();
app.use(express.json({ limit: '32kb' }));

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

    const upstreamAbort = new AbortController();
    const upstream = await fetch(channel.audioUrl, {
      headers: { 'user-agent': 'VoltTransmission-relay' },
      redirect: 'follow',
      signal: upstreamAbort.signal,
    }).catch(() => null);
    if (!upstream || !upstream.ok || !upstream.body) throw httpError(502, 'upstream stream unreachable');

    res.status(200);
    res.setHeader('Content-Type', upstream.headers.get('content-type') || 'audio/mpeg');
    res.setHeader('Cache-Control', 'no-store');

    const body = Readable.fromWeb(upstream.body);
    res.on('close', () => { upstreamAbort.abort(); body.destroy(); });  // listener left → drop upstream
    body.on('error', () => res.end());
    body.pipe(res);
  } catch (e) { next(e); }
});

/* ── admin (X-Admin-Key) ── */
function requireAdmin(req, res, next){
  if (req.get('x-admin-key') === ADMIN_KEY) return next();
  res.status(401).json({ error: 'bad admin key' });
}

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

/* ── the site itself (console + admin + audio/) ── */
app.use(express.static(ROOT, { extensions: ['html'] }));

/* ── errors → JSON (store throws httpError(status, message)) ── */
app.use((err, req, res, next) => {   // eslint-disable-line no-unused-vars
  const status = err.status || 500;
  if (status >= 500) console.error(err);
  res.status(status).json({ error: err.message || 'server error' });
});

const server = app.listen(PORT, () => console.log(`[volt] site + api on http://localhost:${PORT}`));
attachBus(server, app);   // live-action bus: wss://…/api/bus?channel=<id> (see server/bus.js)

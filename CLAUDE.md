# Volt Transmission (td-stream-control)

Interactive radio/VJ platform. Today it's a self-contained broadcast console
(`index.html`, no build step) with audio-reactive scenes, per-station music,
and a WebRTC link to TouchDesigner — plus a small Node service (`server/`,
Express) that serves the site and the API: `/api/channels` behind the CH/VJ
dropdowns (`admin.html`, X-Admin-Key) and Tier-2a accounts (`server/auth.js`
→ Supabase Auth, server-mediated httpOnly cookies; `account.html` sign-in +
role applications; approvals in admin.html). Storage = Supabase Postgres via
DATABASE_URL (JSON-file fallback for zero-setup dev; accounts need the env).
Secrets live in `.env` (gitignored) — SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY,
DATABASE_URL (session-pooler string), ADMIN_KEY. `npm start` runs site + API
on :8787. Tier 3a: channels can carry a live `audioUrl`, played through the
server's same-origin relay (`/api/channels/:id/audio`) so the analyser is
never CORS-blocked — scenes react to the live broadcast. Tier 4 slice: the
**action bus** (`server/bus.js`, ws dep) — in Live mode the console publishes
every stamped message to `wss://…/api/bus?channel=<id>`; VJ rigs subscribe
(TD WebSocket DAT natively, OSC software via `tools/bus-to-osc.mjs`), and
`POST /api/channels/:id/actions` injects test actions. `src/` +
`react-app.html` is an archived React variant — reference only, don't
extend it.

## Golden rules

- `index.html` stays ONE self-contained file: no bundler, no external JS deps,
  no localStorage (song uploads use IndexedDB on purpose). Server-backed
  features must degrade gracefully — the `/api/channels` fetch falls back to
  the static `CHANNELS` seed, and anything new follows that pattern.
- Two visual planes (ROADMAP.md, finding #1): browser-rendered canvas scenes
  (instant interactivity, scales free) vs streamed video (TouchDesigner/VJ).
  New features must not collapse the two.
- The TD data-channel schema is a public contract (documented in SETUP.md):
  every payload carries `type` + `user` + `ts`. Extend it, never break it —
  the owner builds TouchDesigner-side parsing against it.
- Scenes draw in a virtual 1280×720 space (cover-fitted) and read only the
  `SIG` object: bass/mid/treb/level (smoothed 0..1), kick/snare (onset
  impulses that decay), bars(n), wave. Keep every scene 60 fps on modest GPUs
  — Canvas 2D, no per-frame allocations in hot loops beyond what's there.
- Keyboard: keys `h` `d` `p` are reserved outside KEY_MAP (console, diag,
  play/pause). Action keys must keep firing both sceneFX() and sendToTD().
- Modes: the UI says **Offline | Live** but the wire value stays
  `'presets'|'live'` ('presets' = Offline) — public contract. Offline owns
  the station bank + local songs; Live owns channels (canvas plane = scene +
  channel live audio, video plane = TD feed). Overlay FX (Q/W/E/Space) must
  work on BOTH planes (the canvas doubles as a transparent FX overlay above
  the video). Keys 1–4 tune stations ONLY in Offline; in Live they're the
  live actions (future: permission-gated action packs). No Skip in Live.

## Test (run after every change)

```bash
npm i jsdom          # once
node .smoke-test.cjs # headless run of every console path — keep it green
```

It evals the whole page script (also catches syntax errors) and exercises
scenes, uploads, transport, modes, action-key FX, and message stamping.
Extend it when adding features.

## Deploy

Push to `main` → Render auto-deploys (static site, publish dir `.`, see
render.yaml). Songs ship via `audio/` + `PRESET_TRACKS` in index.html.

## Docs to keep in sync

- `SETUP.md` — operator guide: TD connection, adding songs, message schema.
- `ROADMAP.md` — the tiered build plan (accounts → payments → streaming →
  control bus → VJ mesh). Build in tier order; each tier has a ready prompt.
- `README.md` — dev-facing overview (mostly the React variant + TLS/mkcert).

# Volt Transmission (td-stream-control)

Interactive radio/VJ platform. Today it's a self-contained broadcast console
(`index.html`, no build step) with audio-reactive scenes, per-station music,
and a WebRTC link to TouchDesigner — plus a small Node service (`server/`,
Express + Postgres-or-JSON-file) that serves the site and the `/api/channels`
API behind the CH/VJ dropdowns, with `admin.html` (X-Admin-Key) to manage
channels. `npm start` runs site + API on :8787. `src/` + `react-app.html` is
an archived React variant — reference only, don't extend it.

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

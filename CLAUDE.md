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
`POST /api/channels/:id/actions` injects test actions. Paid test tier
(`server/paid.js`, Stripe stubbed at marked seams): per-channel control
takeover queue — the bus verifies the session per socket and only passes
the slot holder's Live 1–4 actions — plus song requests; queues render in
the console (Live) and the host manages them in admin.html. Shop + cabinet
(`server/shop.js`, same stub-pay tier): records = `albums/<Name>/` folders
(purchase-gated streaming; `/albums` never served statically) + procedural
art/VJ packs; purchases in gitignored `server/.shop-data.json`; the console's
footer Shop/Cabinet modals play records through the analyser chain. **Drive Mode**
(phone-only, audio-only): on phones an auto-suggested, dismissible view
that kills the canvas scenes (battery) and shows only station/track + big
play/pause + volume; detection is `isPhone()` (matchMedia coarse+hover:none
+ ≤500px short side, `?drive=1|0` override), it never mutates mode/plane/
audio and restores on exit. **VOLT CONTROL** (`control.html` + `server/items.js`,
same stub-pay tier): pay-to-control physical items driven by TD — each item
has a 6-char code + QR to `/control?item=<CODE>`; buy-now queue or soft-close
auction wins a timed slot; the holder gets a d-pad/A-B-C touch controller whose
presses ride the action bus (room `item:<CODE>`, actions `pad_*`/`btn_*`) with
server-side gate enforcement (bus.js gate REGISTRY — paid.js gates scene_1..4
in radio rooms, items.js owns `item:` rooms; `item`/`item_queues` are RESERVED);
item defs persist via store.js (items table / `server/items.json`), runtime
queues reset on deploy like paid.js; admin ops live in control.html's gear view
(same X-Admin-Key), QR encoder is embedded + decoder-verified. `src/` +
`react-app.html` is an archived React variant — reference only, don't extend it.

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
npm i jsdom              # once
node .smoke-test.cjs     # client: headless run of every console path (jsdom)
node .smoke-server.cjs   # server: the paid control gate (in-process, auth-unconfigured)
node .smoke-failclosed.cjs  # server: fail-closed on DB outage (boots a child w/ Supabase env set + DB down)
node .smoke-items.cjs    # server: Volt Control items + output layer (queue, auction, gate, election, failover)
node .smoke-control.cjs  # client: control.html USER page (entry, item, controller, throttle, redundancy UI)
node .smoke-ops.cjs      # client: control-ops.html admin dashboard (gate, create/edit/actions, chain, QR)
node .smoke-stage.cjs    # client: stage.html browser output plane (scenes, election, attract)
```

`.smoke-test.cjs` evals the whole page script (also catches syntax errors) and
exercises scenes, uploads, transport, modes, action-key FX, message stamping,
the paid-takeover client mirror, and Drive Mode. `.smoke-server.cjs` proves the
server-side permission gate (non-holder denied, holder passes, admin bypass,
forged-type rejected, no create-on-read). `.smoke-failclosed.cjs` guards the
headline security invariant: with Supabase env set but Postgres down, the
payload-identity escape hatch stays CLOSED (bids AND item buys/bids 401).
`.smoke-items.cjs` covers the items product end to end (create → buy/queue →
expiry/skip/pause/off → auction arm/soft-close/win → gate verdicts → the
paid-vs-items territory split) PLUS the output layer (chain CRUD, rig auth,
election, failover grace, preemption, output-gap clock pause, the admin×output
pause matrix, duty limits, forged-type drops). `.smoke-control.cjs` drives
control.html — now the USER page only (code entry, both item modes, slot-grant
→ controller, the ≤8 Hz throttle, the output-offline banner / spectator strip),
plus a hard assertion that NO admin code/key/QR-encoder ships to visitors.
`.smoke-ops.cjs` drives the split-out admin dashboard control-ops.html (key
gate, create + QR poster, skip/pause/off, edit PATCH, the chain manager, the
edit-open refresh guard). `.smoke-stage.cjs` drives stage.html (scenes render +
react, output election self-mute, attract mode, resync staleness guard). Keep
all seven green and extend them when adding features.

## Deploy

Push to `main` → Render auto-deploys the **Node web service** (render.yaml:
`node server/index.js` serves the site + API — it has NOT been a static site
since Tier 1b; purchase-gating and the API depend on this). Station songs ship
via `audio/<Station>/` folders (auto-listed by GET /api/audio); gated shop
records via `albums/<Name>/`.

## Docs to keep in sync

- `HANDOFF.md` — **the state-transfer doc for new Claude sessions** (current
  state, open items, landmines). Update it whenever something ships.
- `MANAGE.md` — operator to-do list + runbook.
- `SETUP.md` — operator guide: TD connection, adding songs, message schema.
- `ROADMAP.md` — the tiered build plan (accounts → payments → streaming →
  control bus → VJ mesh). Build in tier order; each tier has a ready prompt.
- `README.md` — dev-facing overview (mostly the React variant + TLS/mkcert).

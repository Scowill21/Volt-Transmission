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
auction wins a timed slot; the holder gets a touch controller — one of FOUR
layouts per the item's **`controller`** field (`dpad` default / `joystick` /
`faders` / `grid`) — whose presses ride the action bus (room `item:<CODE>`,
gated `key` actions `pad_up/down/left/right·xy`, `btn_[abc]`, `fader`,
`cell_0..15` — `PAD_BTN_RE` in items.js; continuous `pad_xy`/`fader` skip the
duty cooldown but the holder gate + bus rate still bind) with server-side gate
enforcement (bus.js gate REGISTRY — paid.js gates scene_1..4 + station/channel/
mode/transport in radio rooms, items.js owns `item:` rooms; `item`/`item_queues`
are RESERVED); item defs persist via store.js (items table / `server/items.json`),
runtime queues reset on deploy like paid.js. Admin = **`control-ops.html`**
(`/control-ops`, its own standalone product page — the audio-reactive console's
admin is separately `admin.html`; the two no longer cross-link): per-item
controller picker, a Connect panel (OSC addresses + copy commands) and a live
OSC monitor. `tools/bus-to-osc.mjs` forwards joystick/fader values as OSC floats
(`/volt/xy`, `/volt/fader/<i>`). QR encoder is embedded + decoder-verified. `src/` +
`react-app.html` is an archived React variant — reference only, don't extend it.
**VOLT JUKEBOX** (`server/jukebox.js`, same tier): an item's `surface` is `'pad'`
(default, the d-pad above) or `'jukebox'` — audio as a control surface. A jukebox
room lets paid patrons queue from an admin catalog, skip (bounded by admin
sliding-window rules), or bid for the next play; the SERVER owns the queue/rules/
what-plays-next and a Pi rig (`tools/volt-jukebox.mjs`, MPD or `log` backend) is
a dumb player driven by `{type:'jukebox', action}` bus commands (RESERVED) that
reports truth back via `track_started`/`track_ended`/`position` (bus RIG_REPORT
set — server-CONSUMED, never broadcast, rig/admin only). Two postures
(`jukebox.monetization`): `controller_slot` (reuses the buy-now/auction slot;
holder drives free but windows still bind) · `per_action` (each action priced).
Spotify is DEFERRED — the server is backend-blind (see `PROMPT-JUKEBOX.md` §8).
Surface flip is guarded (no stranded slot/queue); jukebox config lives in
`item.jukebox`, runtime (nowPlaying/queue/skips/bidRound) is in-memory in
`jukebox.js`'s `rt` map, resets on deploy.

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
node .smoke-jukebox.cjs  # server: JUKEBOX rules engine (skip windows, queue caps, bid rounds, rig reports, forgery)
node .smoke-control.cjs  # client: control.html USER page (entry, item, controller, throttle, redundancy UI, jukebox surface)
node .smoke-ops.cjs      # client: control-ops.html admin dashboard (gate, create/edit/actions, chain, QR, jukebox editor)
node .smoke-stage.cjs    # client: stage.html browser output plane (scenes, election, attract, jukebox marquee)
node .smoke-security.cjs # server: take-control hardening (report-forgery, output-gate, SSRF, admin lockout, WS origin, headers)
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
react, output election self-mute, attract mode, resync staleness guard, the
jukebox `?view=marquee` now-playing board). `.smoke-security.cjs` locks in the
take-control hardening (`server/security.js`): a non-rig socket can't forge
jukebox reports (only `ws._rig` is trusted), the output-routing types
`station/channel/mode/transport` are gated operator-or-holder like scene_1..4,
the audio relay is SSRF-guarded, the admin key is constant-time + brute-force-
locked + FAIL-CLOSED on a misconfigured prod, WS upgrades reject cross-origin,
and every response ships anti-clickjacking/nosniff headers. **Security rule:**
driving the console's live output (scene/station/channel/mode/transport) now
requires a signed-in vj/radio/admin session or a held control slot — keep it
that way; never re-open a control-plane type to anonymous senders.
`.smoke-jukebox.cjs` is the JUKEBOX
rules engine's hermetic matrix — pad↔jukebox back-compat, catalog-only queueing,
idle-start, queue caps + no-repeat, play-next fairness, the full skip decision
(minPlaySec floor · onlyBeforeSec window · per-user + global sliding-window caps
that slide not reset), allowMidSong, stale-songId skips (no window decrement),
rig `track_started`/`ended`/`position` reports, forged-wire rejection, bid-round
close, controller_slot vs per_action, and admin force-skip/clear/remove. Keep all
NINE green and extend them when adding features.

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

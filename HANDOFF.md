# HANDOFF — Volt Transmission

**Paste this file (or tell the assistant to read it) at the start of a new
Claude chat.** It is the complete state transfer: what exists, what's live,
what's next, and every landmine previous sessions already stepped on.

> **Reading order for a fresh session:** this file → `CLAUDE.md` (the rules —
> binding) → then whichever deep-doc the task needs (table below).

---

## 1. What this project is

**Volt Transmission** — an interactive radio/VJ platform. A self-contained
broadcast console (`index.html` — ONE file, no build step) with audio-reactive
canvas scenes, per-station music, a WebRTC link to TouchDesigner, accounts,
paid features (test tier), and a shop — served by a small Express API
(`server/`).

- **Local path:** `~/td-stream-control`
- **GitHub:** `Scowill21/Volt-Transmission` — push to `main` → **Render
  auto-deploys** (~30–60s)
- **Production:** https://td-stream-control.onrender.com (Node web service —
  `node server/index.js` serves site + API; NOT a static site)
- **Owner:** William (Scowill21). Non-expert dev; explain clearly, verify
  everything live, don't assume.

| Doc | What it's for |
| --- | --- |
| `CLAUDE.md` | **Binding rules + test commands. Read before editing.** |
| `MANAGE.md` | Operator to-do list + runbook (deploy/admin/monitoring) |
| `SETUP.md` | Operator guide: TD, songs, action bus, paid tier, shop |
| `ROADMAP.md` | Tier plan; what's shipped vs open |
| `PAYMENTS-SETUP.md` | The full Supabase + Stripe (2b) go-live playbook |
| `ARCHITECTURE.md` | One-pager: Render vs Supabase vs backend |
| `README.md` | Mostly the archived React variant — low value |

---

## 2. Current state (verified live, 2026-07-13)

Everything below is **deployed and working in production** unless marked.

- **Tier 1a+1b** — CH/VJ dropdowns ← `GET /api/channels` (static-seed
  fallback); admin.html creates channels/VJs behind `X-Admin-Key`.
- **Tier 2a** — Supabase Auth, server-mediated (httpOnly cookies volt_at/rt,
  `/api/me`; roles listener/vj/radio/admin on a `profiles` table; approvals in
  admin.html). Console stays dependency-free.
- **Tier 3a (URL half)** — channels carry `audioUrl`; same-origin relay
  `/api/channels/:id/audio` defeats CORS; scenes react to live streams.
- **Tier 4 slice 1** — action bus `server/bus.js`: Live-mode actions fan out
  per-channel over `wss://…/api/bus?channel=<id>`; TD consumes via WebSocket
  DAT or `tools/bus-to-osc.mjs`; HTTP inject `POST /api/channels/:id/actions`.
- **Tier 4 slice 2 — PAID TAKEOVER (test tier, commit 8d71438)** —
  `server/paid.js`: control-slot queue (bid → timed slot → countdown →
  auto-promote) + song requests. **Enforcement is real**: the bus binds the
  verified session per-socket at the WS upgrade; only the slot holder (or
  verified vj/radio/admin) passes `scene_1..4`. Only the MONEY is stubbed, at
  `STRIPE:` seams. Host view in admin.html.
- **SHOP + CABINET (test tier, commit 93c60d0)** — `server/shop.js`:
  RECORDS = `albums/<Name>/` folders, purchase-gated end to end (`/albums`
  blocked from static; tracks stream only via ownership-checked
  `GET /api/shop/records/:id/:n` with Range); ART/VJ packs = procedural print
  sets (seed+palette recipe ships ONLY to owners via `/api/shop/library`).
  Purchases in gitignored `server/.shop-data.json` (atomic writes; wiped per
  Render deploy — fine for stub tier).
- **Station music (commit 3c2a12c)** — `GET /api/audio` lists
  `audio/<Station>/` folders → Offline stations auto-play deployed songs, no
  code edits. Pulse + Ambient each have the 3 Pretty Lights FLACs.
- **Scenes/signal** — visual AGC normalizes SIG toward target .55 (graphics
  only; audible path untouched), verified raw .45→.55. Onsets are
  **range-adaptive** (commit 1eff2e8): rolling floor/ceiling, fire on upward
  crossing into the top of the band's own range; snare `makeOnset(.80,420)` ≈
  backbeat, kick `(.75,300)` ≈ four-on-floor. Pulse: cars +25% on bass,
  searchlights flash on snare (alpha ~.2→~.74).
- **Drive Mode** — phone-only audio-first view; auto-suggests on phones.
- **VOLT CONTROL — pay-to-control items (test tier)** — `server/items.js` +
  `control.html` (+ items table/JSON in `store.js`): items with 6-char codes
  + printable QR to `/control?item=<CODE>`; buy-now queue or soft-close
  auction wins a timed slot; the holder's phone becomes a d-pad/A-B-C
  controller publishing `pad_*`/`btn_*` on bus room `item:<CODE>`.
  `bus.js`'s single keyGate became a **gate registry** (paid.js claims only
  scene_1..4 outside `item:` rooms and its endpoints 404 on `item:` ids;
  items.js owns `item:` rooms — territories provably disjoint). New RESERVED
  types `item` (state announcements TD parses: slot_start/slot_end/skip/
  pause/resume/on/off/auction_won) + `item_queues` (full public state).
  Admin ops in control.html's ⚙ view (memory-held X-Admin-Key); admin.html
  cross-links. account.html grew a validated `?return=` redirect. The QR
  encoder is hand-written in control.html (byte mode, EC-M, v1–10) and was
  round-trip-verified against jsqr. Same STRIPE stub seams as paid.js;
  runtime resets on deploy.
- **⚠️ CABINET DEMO LOOK IS ON** — `CABINET_DEMO = true` in `index.html`
  renders a furnished, NON-functional cabinet preview (3 fake records + 12
  prints; clicks explain). **When William says "remove demo": flip that one
  flag to false** (search "CABINET DEMO LOOK"). Smoke test covers both states.

**Security invariants (adversarially reviewed + fail-closed-tested — keep):**
- Payload/query identity (`{user:{id,name}}` / `?uid=&name=`) works ONLY when
  `devIdentityAllowed()` (= Supabase env ABSENT). Keyed on **intent, not DB
  reachability** — a DB outage on prod fails CLOSED (401s), never open.
- Clients can't forge control-plane bus types (`queues`, `denied`).
- `ws._user` binds before gated keys process (buffered during handshake).
- Album stream: no traversal, guarded streams (a read error must not crash
  the process — it used to), 416 on bad ranges.

---

## 3. Tests — run ALL before every push (green = shippable)

```bash
node .smoke-test.cjs        # client: whole console in jsdom (~20 steps)
node .smoke-server.cjs      # server: paid gate + shop gates (15 checks, hermetic)
node .smoke-failclosed.cjs  # boots real server w/ Supabase env set + DB down → 401s (incl. item buy/bid)
node .smoke-items.cjs       # server: Volt Control items (23 checks, hermetic)
node .smoke-control.cjs     # client: control.html in jsdom (14 checks)
```

Extend them with every feature (CLAUDE.md rule). They are the ONLY gate —
there is no CI.

---

## 4. Environment & secrets

- Local secrets in gitignored `.env`: `SUPABASE_URL`,
  `SUPABASE_PUBLISHABLE_KEY`, `DATABASE_URL`, `ADMIN_KEY=dev`.
  **Never commit; never echo values into chat.**
- Supabase project ref: `xyhqahemxcknyvxlrmhe` (us-west-2).
- **Local `.env` DATABASE_URL is currently BROKEN by port, not password**:
  from William's Mac the session pooler `:5432` TCP-connects but hangs at the
  Postgres handshake; the **transaction pooler `:6543` works** with identical
  credentials. Fix = change the port in `.env`. Until then local runs fail
  closed (JSON store, accounts off) — that's correct behavior, not a bug.
- Render env is set and healthy (prod uses `:5432` fine from there).
- **Password rotation is a pending William-task** (original DB password went
  through a chat once). Steps are in MANAGE.md → "Rotating the DB password".
  The new password must NEVER be pasted into chat.
- ADMIN_KEY: `dev` locally; auto-generated on Render (Blueprint).

---

## 5. Open items, in priority order

1. **William flips** local `.env` to `:6543` + rotates the DB password
   (MANAGE.md has both runbooks). Also Supabase dashboard: "Confirm email"
   OFF; delete test users `volttest23980@gmail.com`, `volt-ada-23122@gmail.com`.
2. **"remove demo"** — when William says it: `CABINET_DEMO = false`.
3. **Tier 2b — real Stripe** (blocked on William's test keys):
   `PAYMENTS-SETUP.md` §2–3 is the full seam-by-seam plan (Checkout at the
   `STRIPE:` seams in paid.js + shop.js; webhook does the enqueue,
   idempotent; queues+purchases → Postgres; admin refunds; raw-body fix for
   the webhook is one line at `server/index.js` express.json).
4. **Transcode the FLACs** → Opus/AAC (~158MB of audio deploys now; ~10×
   smaller; endpoint accepts any audio ext — just swap files).
5. **Docs housekeeping**: untracked `SETUP-PAYMENTS.md` is another session's
   partial duplicate of `PAYMENTS-SETUP.md` — merge or delete (ask William).
6. Tier 3b LiveKit (video/host-cam/browser-mic); Tier 4 leftovers (pooled FX,
   per-account rate limits); Tier 5 VJ mesh. Music licensing before real
   money moves (ROADMAP Tier 6).

---

## 6. Landmines (hard-won — read before debugging)

- **Golden rule:** `index.html` stays ONE self-contained file. No bundler, no
  external JS deps, no localStorage (IndexedDB is fine). The TD message
  schema and the `presets|live` wire values are public contracts.
- **`.smoke-test.cjs` eval scope:** page-scope `const`/`let` (player,
  IDENTITY, SIG, queueState…) are NOT reachable from separate `w.eval()`
  calls — only function declarations are. Use/extend the `window.__*` shims
  (`__player`, `__setRole`, `__setVerified`, `__setCabinetDemo`, `__ended`,
  `__resetFire`). Fetches resolve on microtasks: `await new
  Promise(setImmediate)` between action and assertion.
- **Claude preview pane quirks:** rAF can suspend mid-session (frames freeze;
  screenshots still paint) — drive `updateSignal()`/`renderLoop()` manually
  from JS to measure; a trusted `computer` keypress `'p'` supplies the
  autoplay gesture. The pane also heuristically caches HTML/JS — bust with a
  fresh `?t=` query or a new port. Port 8787 may be held by another chat's
  server: `volt-api` has `autoPort: true`, and manual test instances should
  use 879x ports and be killed after.
- **To test the dev escape hatch locally** (bids/buys without real accounts):
  run WITHOUT Supabase env — `env -u SUPABASE_URL -u SUPABASE_PUBLISHABLE_KEY
  -u DATABASE_URL PORT=8794 node server/index.js` — because with `.env`
  loaded the app correctly fails closed (401 on payload identity).
- **macOS vs Linux:** Finder may rename `audio/` → `Audio/` — paths MUST stay
  lowercase or Render (case-sensitive) silently loses the songs. Two-step
  `mv` to fix. Same class of issue: the `/albums` static block is deliberately
  case-insensitive.
- **npm cwd:** the `ws` incident — installing from the wrong directory put
  deps in `~/node_modules` and broke ONLY Render. Always `npm i` inside the
  project; always commit `package.json` + `package-lock.json`.
- **Render deploys flap** for ~30s (old+new instances both serve). Verify
  with a marker probe (`grep` a new string in `/`) and re-probe after it
  settles; don't diagnose mixed 404s mid-rollout.
- **pg timeouts masquerade as auth failures:** a wrong password says
  "password authentication failed"; a TIMEOUT is network/port (see the
  `:6543` note). `connectionTimeoutMillis` can hide the real error.
- Purchases (`server/.shop-data.json`) and paid queues are in-memory/file at
  this tier — they reset on restart/deploy. Documented; 2b fixes. Item
  DEFINITIONS survive (items table / gitignored `server/items.json`); item
  queues/auctions do not.
- **Block comments cannot contain `pad_*/btn_*`** — the `*/` closes the
  comment (a real boot-breaking incident in items.js). Write "pad/btn".
- Items landmines: item codes are stored UPPERCASE (routes normalize);
  admin PATCH deliberately 400s on `status` (on/off must go through
  `POST /state` so the change is ANNOUNCED to TD); `items.js` keeps a
  memory mirror of the store (loaded at attach) — mutate items only through
  its routes or the mirror goes stale; `.smoke-items.cjs` drives time by
  rewinding `endsAt` via the module's `__test` hook, never by sleeping.
- The Claude-preview launch entry `volt-api-dev` (in ~/.claude/launch.json)
  boots the server auth-unconfigured (env -u …) on port 8794 — that's the
  one to use for driving buy/bid flows in a browser locally; plain
  `volt-api` loads `.env` and correctly fails closed.

---

## 7. How sessions here work (what William expects)

- Verify claims **live** (curl prod, drive the browser, measure real numbers)
  — not by reading code alone. Screenshots as proof.
- Adversarial review before shipping non-trivial features (multi-lens
  workflow over the diff); fix majors before commit.
- Commit style: what + why, `Co-Authored-By: Claude Fable 5
  <noreply@anthropic.com>`; separate commits for code vs heavy assets.
- After every push: poll prod until the new build serves, then probe the
  security posture.
- Keep `MANAGE.md`/`SETUP.md`/`ROADMAP.md`/this file in sync with what ships.

## 8. Ready-made next prompts

- *"Fix my local DB: switch .env to the transaction pooler and verify
  CONNECTED, then walk me through the password rotation."*
- *"remove demo"* → flip `CABINET_DEMO` to false, run suites, push.
- *"Here's my Stripe test key — build Tier 2b"* → PAYMENTS-SETUP.md §2–3
  against the STRIPE seams, with webhook idempotency + Postgres persistence.
- *"Transcode the station/album FLACs to Opus and swap them in."*
- *"Build pooled FX"* → ROADMAP Tier 4 leftovers on the existing bus.

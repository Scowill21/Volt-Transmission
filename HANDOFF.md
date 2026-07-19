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
| `HARDWARE.md` | Raspberry Pi rig guide — `tools/bus-to-pi.mjs` (GPIO) + `tools/volt-jukebox.mjs` (jukebox player): wiring, pins.json, MPD, systemd, failover |
| `PROMPT-CONTROL-SPLIT.md` | The user/admin split build spec — SHIPPED this session (control-ops.html) |
| `PROMPT-OUTPUTS-REDUNDANCY.md` | The output-layer build spec — Phase 1 SHIPPED this session; §9 Phase-2 menu open |
| `PROMPT-ITEM-CONTROL.md` | The original Volt Control build spec (owner decisions, executed) |
| `PROMPT-JUKEBOX.md` | The Volt Jukebox build spec — SHIPPED this session (server/jukebox.js, tools/volt-jukebox.mjs); §8 = licensing reality |
| `ARCHITECTURE.md` | One-pager: Render vs Supabase vs backend |
| `README.md` | Mostly the archived React variant — low value |

---

## 2. Current state

> **⚡ VOLT CONTROL SPLIT OUT (2026-07-19).** Pay-to-control items, the jukebox
> surface, output chains, the admin chain (orgs/owner/staff/tech), and the
> operator vault are now their OWN service + repo — **`~/volt-control`**
> (GitHub `Scowill21/volt-control`, `https://volt-control.onrender.com`,
> PRIVATE repo). They share this project's Supabase, so nothing migrated. This
> repo is now the audio-reactive **console** only (index.html + admin.html +
> channels + paid takeover + shop + drive mode). The old `/control`,
> `/control-ops`, `/stage` URLs **302-redirect** to the new service (query
> preserved → printed QR posters keep working; `VOLT_CONTROL_URL` env overrides
> the target). Removed here: `control*.html`, `stage.html`,
> `server/{items,jukebox,orgs}.js`, `tools/bus-to-{pi}.mjs` +
> `tools/volt-jukebox.mjs`, `HARDWARE.md`, `.vault/` + `/api/vault`, and the six
> VC smoke suites. Shared change kept: **`requester()` moved to `auth.js`** (was
> paid.js). Suites here are now FOUR (test/server/failclosed/security). For
> anything Volt Control, read `~/volt-control/HANDOFF.md`.
>
> **William TO-DO on Render:** create the `volt-control` web service from the new
> repo — `~/volt-control/SETUP-RENDER.md` has the exact steps (share the same
> Supabase env). Until it exists, the redirects point at a URL that 404s.

Everything below is **deployed and working in production** unless marked. The
Volt Control bullets are historical (that product now lives in its own repo).

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
  searchlights flash on snare (alpha ~.2→~.74). AUDIO-DRIVEN frame shake is
  REMOVED (commit 5c5b924 — Pulse used to lurch ±7px per kick); the
  player-controlled W punch zoom+shake (`FX.punch`) is deliberately kept.
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
  runtime resets on deploy. Items also carry an admin-written
  **controls guide** (`instructions`, ≤500 chars — commit `c3058a6`): shown
  as a card on the item page and behind the controller's (i) button.
  (The admin/user SPLIT shipped since — admin now lives on `control-ops.html`,
  see the dedicated bullet below.)
- **VOLT CONTROL v2 — OUTPUT LAYER / redundancy (test tier)** — items now
  carry an ordered **output chain** (`store.js`: `outputs` + `limits`, JSONB
  migration, empty = legacy behavior). `bus.js` gained **rig identity** (a
  `registerRigHooks` object beside the gate registry: `&rig=&rigKey=` at the
  upgrade, bad key → close 4401) and two more unforgeable types (`output`
  reserved; `score`/`telemetry` rig-or-admin only). `items.js` runs the
  **election** (lowest-priority online output = program; scenes always online),
  **5 s failover grace**, preemption, "never sell dead air" (503 + auto-pause
  the holder's clock on a full output gap — a SEPARATE `outputPaused` flag from
  admin `paused`, the two compose correctly), and **duty-cycle limits**
  (privileged bypass, owner's call). Admin chain CRUD:
  `POST/PATCH/DELETE /api/items/:code/outputs` (rig create returns the key
  ONCE). New **`stage.html`** = the browser output plane (`?item=CODE`,
  scenes `orb`/`grid`, attract mode + scan-QR, `&rig=&rigKey=` registers it as
  a real output). `control.html` gained an output-offline banner, a spectator
  strip, and the chain manager in the ⚙ view. New **`tools/bus-to-pi.mjs`** +
  **`HARDWARE.md`** = the Raspberry Pi rig (sysfs GPIO, log-only off-Pi,
  self-mute). Owner calls this session: duty limits DO bypass for privileged;
  existing items default to no chain; stage scenes = Orb + Grid; `sw.js` for
  Phase-2 push is PRE-APPROVED. Phase 2 menu still open (web-app outputs,
  scores/leaderboard, pay-to-extend/jump, live camera, pooled free mode,
  schedules, push) — see `PROMPT-OUTPUTS-REDUNDANCY.md` §9.
  **Adversarial 4-lens review ran + fixes applied before ship:** a slot
  promoted during an output gap now freezes (startSlot + tick safety net — no
  dead-air billing); election is grace-aware (unrelated churn can't defeat the
  anti-flap hold); rig sockets dedupe on reconnect (revoke fully cuts a rig
  off); a lastSeen liveness reaper fails a power-yanked rig over in ~12s (not
  ~60s); stage self-mute requires a key; canvas resizes only on change (Orb
  trail works); roster re-broadcasts on spare toggles; specFlash guarded.
  Regression tests items #39–41 lock these in.
- **VOLT CONTROL — USER/ADMIN SITE SPLIT (this session)** — `control.html` is
  now the PUBLIC user product only (`/control`; code entry → item → controller);
  the admin dashboard moved to a new self-contained **`control-ops.html`**
  (`/control-ops`). Option A (same Node service, `express.static` serves it
  extensionless — zero server changes). NO admin code/key/QR-encoder ships to
  walk-up phones now (the user smoke asserts it). `/control?item=` autofill
  preserved (printed QR posters). admin.html cross-links `/control-ops`. Suites
  split: `.smoke-control.cjs` → USER (20) + the no-admin invariant; NEW
  `.smoke-ops.cjs` → dashboard (9, gate/create/QR/actions/edit/chain/refresh
  guard). The `PROMPT-CONTROL-SPLIT.md` mission is now DONE.
- **VOLT JUKEBOX — audio as a control surface (test tier, this session)** —
  an item can now have `surface:'jukebox'` (default stays `'pad'`, byte-identical
  back-compat). A jukebox turns its `item:<CODE>` room into a venue music
  controller: paid patrons queue songs from an admin catalog, skip (bounded by
  admin windows), or bid for the next play. **The SERVER is the sole authority**
  (queue, skip windows, bid round, what plays next); a **rig** (Raspberry Pi via
  `tools/volt-jukebox.mjs`, MPD or `log` backend) is a dumb player that receives
  `{type:'jukebox', action}` commands and reports reality back
  (`track_started`/`track_ended`/`position`, a new bus RIG_REPORT set the server
  CONSUMES, never broadcasts). On (re)connect / election-promotion / item-on the
  rig resyncs FROM the server. Two monetization postures
  (`jukebox.monetization`): **`controller_slot`** (default — the shipped
  buy-now/auction machinery sells a timed slot; the holder drives for free but
  every admin window/cap still binds) and **`per_action`** (each queue-add / skip
  / bid individually priced). `server/jukebox.js` is the reviewed heart; UIs:
  `control.html` patron surface (now-playing, live skip-eligibility, catalog,
  bid), `control-ops.html` catalog editor + knobs + live veto panel,
  `stage.html?view=marquee` venue now-playing board. **Spotify is deliberately
  DEFERRED** (server is backend-blind; it slots in as its own backend once
  OAuth/licensing is signed off — see `PROMPT-JUKEBOX.md` §8 / `SETUP.md`). Money
  stubbed at `STRIPE:` seams; runtime in-memory (resets on deploy). NEW suite
  `.smoke-jukebox.cjs` (20, hermetic rules matrix — incl. the ship-review
  regressions); fail-closed +3, control +6, ops +5, stage +3. **Adversarial
  review ran before ship** (two agents, hardest look at time math + window
  pruning + the auth boundary); fixes applied: jukebox `play` commands now go
  **rig-only** (never fan the catalog `file`/URI to the room), `noRepeatMin=0`
  still blocks duplicate queued/playing songs (no lost paid play), a skip cap of
  **0 = skips off** (not unlimited), a **one-skip-per-track latch** stops a
  double-tap double-charging the quota, player **reports accepted only from the
  elected program rig** (a spare can't hijack nowPlaying), `position` `sec` is
  clamped, `track_ended` can't double-advance, and `onlyBeforeSec` is floored to
  `minPlaySec` so the skip window is never empty. The `PROMPT-JUKEBOX.md` mission
  is DONE.
- **SECURITY HARDENING — "can't hack it to take control" (this session)** — an
  adversarial audit (8 attack surfaces, verified) found real take-control holes;
  all fixed in a new **`server/security.js`** + wiring. Confirmed fixes: (1) a
  privileged **vj/radio/admin SESSION** could open a plain WS to `item:<CODE>`
  and forge jukebox `track_started/ended/position` (laundered to rigName
  `'admin'`) — now RIG_REPORT is consumed **only from an authenticated rig**
  (`ws._rig`); `'admin'` reports come solely from the X-Admin-Key HTTP inject.
  (2) The pay-gate only covered `type:'key'`, so `station/channel/mode/transport`
  (which steer the live TD output) fanned out **ungated** — any spectator or
  anonymous HTTP inject could change the scene without paying; now gated
  operator-or-holder (a new `OUTPUT_CTL` set in bus.js, claimed by paid.js's
  gate). (3) **SSRF** in the public `/api/channels/:id/audio` relay (followed
  redirects with no private-IP filter) — now `assertPublicUrl` + manual
  redirect loop re-validating each hop + connect timeout. (4) Rig key moved out
  of the WS URL into an `x-rig-key` header (tools updated; browser projectors
  keep the query fallback). Defense-in-depth added: **constant-time** admin/rig
  key compare, admin **fails CLOSED** if a Supabase-configured deploy is left on
  the `dev`/unset key, **per-IP admin brute-force lockout**, **rate limits** on
  auth + control mutations, **security headers** (X-Frame-Options/CSP
  frame-ancestors/nosniff/Referrer-Policy/HSTS), and a **WS Origin** check
  (`verifyClient`). A self-review found + fixed 6 follow-ups: the bus HTTP-inject
  now also fails closed + constant-time (not just `requireAdmin`); the SSRF guard
  **pins the validated IP** through the connect (closes DNS-rebind — relay
  rewritten on node http/https with a `lookup` override); denied output-control
  actions are **silent** over WS (no spurious "locked" for viewers auto-emitting
  on tune-in); a rig can't claim the reserved `admin` name; the lockout map is
  swept; the venue rate limit is 300/min (shared-NAT-friendly). **NEW suite
  `.smoke-security.cjs` (15)**; all nine green.
  ⚠️ **Behavior change:** to drive the console's LIVE output (scene/station/
  channel/mode/transport) you must now be **signed in as vj/radio/admin OR hold
  a control slot** — an anonymous console can no longer steer the paid output.
- **CONTROLLER VARIATIONS + CONTROL HUB + PRODUCT DE-COUPLE (this session)** — a
  pad item now has a **`controller`** field (enum `dpad` (default, back-compat) /
  `joystick` / `faders` / `grid`), picked per item in `/control-ops`. The slot
  holder's `control.html` renders the matching layout: d-pad (`pad_*`/`btn_*`),
  joystick (drag → `pad_xy {x,y}` + FIRE), faders (`fader {i,v}`), grid (`cell_0`
  …`cell_8`). All ride the SAME holder-gated `{type:'key'}` path — `PAD_BTN_RE`
  extended to the new vocabulary; **continuous** actions (`pad_xy`/`fader`) skip
  the per-item duty cooldown (bus rate limit still bounds them) and stream
  coalesced ~6/s. `tools/bus-to-osc.mjs` now forwards them as OSC floats
  (`/volt/xy` f x,y · `/volt/fader/<i>` f v). **The Control admin is now a
  standalone hub:** each pad card shows the controller at a glance + a **Connect**
  panel (per-controller OSC address list + copy-paste `bus-to-osc`/`bus-to-pi`/TD
  commands, code pre-filled) + a **Live output monitor** (opens one WS to the item
  room, renders each press/drag with its OSC address; `renderAdmin` closes
  monitor sockets to avoid leaks; `refreshAdmin` holds while one is open).
  **De-coupled the two products:** removed `admin.html`'s Volt Control section
  (channels admin is now purely audio-reactive) and `control-ops`'s link to it —
  Volt Control stands alone (discoverability via docs, not cross-links). Suites:
  items 42, control 30, ops 18; all nine green. Adversarially reviewed (monitor
  socket-leak + admin XSS clean; two continuous-input fixes applied: maxPerMin
  now bounds joystick/fader, flushCont retries a drag's final value, joystick
  FIRE is a tap not hold-repeat).
- **PRIVATE OPERATOR VAULT — 🔑 on `/control-ops` (this session)** — a discrete
  key icon opens the **Volt Recipe Book** (operator build guides), owner's eyes
  only. **Server-gated for real privacy:** content lives in
  `.vault/recipe-book.html` (dot-dir → `dotfiles:'ignore'` keeps static from
  serving it; committed so it deploys) and is returned only by `GET /api/vault`
  when `X-Vault-Code` matches **`VAULT_CODE`** — constant-time (`safeEqual`),
  rate-limited (20/5min), **fails CLOSED (503)** if `VAULT_CODE` unset. Never in
  any page source. Passcode is `williamwood` in the gitignored local `.env`;
  **prod needs a `VAULT_CODE` env var on Render** (else the 🔑 reads "not set
  up"). UI renders it in a style-isolated **blob iframe** (CSP gained
  `frame-src 'self' blob:`; code held in memory only). `.smoke-security.cjs` → 17.
  NB: the pre-existing uncommitted `VOLT-PI-PLAYBOOK.md` edit still points at a
  public `VOLT-RECIPE-BOOK.html` — stale now the book is private; left untouched.
- **THE ADMIN CHAIN — orgs / delegated roles / scoped ops (this session,
  server core — needs DATABASE_URL)** — `server/orgs.js`: a delegation ladder
  over Tier-2a accounts. Platform (X-Admin-Key) › org **owner** › **staff** ›
  **tech** — a NEW axis ORTHOGONAL to platform roles (listener/vj/radio/admin;
  don't conflate). Items gained a nullable **`orgId`** (null = platform-owned
  legacy, byte-identical old behavior — a smoke check), platform-set **`bounds`**
  (priceBandCents / slotSecondsMax / cooldownFloorMs / maxPerMinCap / jukebox
  minPlaySecFloor), and owner-editable **`hours`** (stored blob; auto on/off
  enforcement is future). **Owners edit a WHITELIST within bounds, REJECT-not-
  clamp** (out-of-band → 400, nothing written, no audit); **tighten-only** (rest
  MORE / drive SLOWER, never loosen a floor); jukebox config PATCH **deep-merges**
  (the store REPLACES, so orgs.js merges — an un-merged one-knob edit would reset
  every other knob). **Owners MAY flip their own monetization/mode** (William's
  call; idle-guarded). **staff** = actions only (pause/resume/skip/force-skip/
  remove); **tech** = rig keys + output chains — a DISTINCT capability the owner
  can NEVER touch (`requireOrg('tech',{exact})`); only rung-0 grants tech/owner.
  Identity = the verified session matched to membership by **email** (`roleOf`,
  a SYNC in-memory mirror updated on every write → offboarding bites on the very
  next request, NO session cache); a role/orgRole claimed in a payload is IGNORED.
  The bus item-room gate passes org members ≥staff of **THE ITEM'S org** (starts
  from `item.orgId`, never the user's org list → cross-org privilege impossible
  by construction). **NO new bus types, NO TD/OSC wire-schema change** (SETUP
  stays true). Every org write → one **append-only audit** row (no delete/update
  path in code OR schema). **Fail-closed:** no DATABASE_URL → org endpoints 503
  (`store.orgsEnabled`; FileStore mirrors org data for hermetic tests but
  `createStore` forces the flag false whenever the file store backs a real app);
  DB down on a configured deploy → never a write. `attachItems` now returns an
  **`itemsApi`** seam orgs.js calls (index.js 3-step wire: orgs → items{orgs} →
  wireItems). NEW **`.smoke-orgs.cjs` (16)** — the full 12-point matrix incl.
  cross-org isolation at BOTH the HTTP layer and the bus gate, offboard-immediate,
  tech≠owner, bounds reject, no-DB 503; **failclosed +2 (→12), security +1 (→18,
  forged-org-claim)**. OPEN QUESTIONS for William (not solved in code): self-serve item
  creation as a paid "pro" unlock? per-org fleet map page? audit retention
  window? invite emails (Supabase magic link vs. plain "sign up with this
  email")? Stripe Connect per-org payouts stays the Tier-2b follow-up.
- **THE ADMIN CHAIN — OPS UI, BOTH LENSES (this session)** — `control-ops.html`
  finished PROMPT-ADMIN-CHAIN §7 ("one dashboard, two lenses"); the server core
  above was picked up UNCOMMITTED from the prior session, verified (all suites
  re-run green), and shipped together with this UI. **Key lens** grew a
  **venues panel**: create org · assign/unassign items by code · per-item
  **bounds editor** (⚖ — price band both-ends-required, slot max, cooldown
  floor, rate cap, song floor) · grant/remove any rung · suspend/reactivate ·
  per-venue audit viewer. 503s gracefully without a DB. **Session lens**: "Use
  my account" on the gate → `/api/org/mine` → the member's venue only, knobs by
  rung — owner gets band-annotated edit forms (band text + min/max input attrs;
  a rejected save surfaces the server's message naming the band), crew roster +
  staff invites + change log; staff gets pause/resume/skip(+jukebox veto) only;
  tech gets chain cards + add-rig/scene + per-rig **key rotation** (`↻`, new key
  shown once — §J's offboarding button). Zero admin secrets on the session path
  (no key prompt, no key-carrying fetch — `.smoke-ops` asserts zero keyed calls
  across the whole session phase). Server additions this pass: **`plays`**
  runtime counter (pad slot starts + rig-reported jukebox tracks) on `orgView`
  and the admin list; admin `GET /api/items` now carries `orgId/bounds/hours/
  limits/plays` (the LIVE browser pass caught that gap — the jsdom mock had
  hidden it); `GET /api/org/:id/members` (owner-only roster — you can't remove
  who you can't see); **suspension now freezes the BUS gate too** (`roleOf` →
  null for suspended orgs; requireOrg still says "suspended" to members);
  `store.linkMemberUserId` backfills `org_members.userId` on a verified
  member's first org request (spec §4 — fills a blank once, never re-links;
  dev-hatch ids never land). The jukebox knob block hides the `backend`
  selector in the org lens (the owner PATCH whitelist ignores it — showing a
  dead knob teaches the wrong model); `gatherJukebox` tolerates its absence.
  **A 16-finding adversarial review (1 critical / 4 major / 11 minor, all
  confirmed, 0 refuted) ran on the whole diff and ALL fixes landed before
  ship** — chief among them: (critical) an org owner could "invite" a
  platform-granted tech/co-owner's email and, because `addMember` upserts,
  DEMOTE them to staff then evict them — now the invite route rejects any email
  already holding a higher rung; (major) owner edits now REJECT-not-clamp
  against the store's intrinsic ranges (`ITEM_FIELDS`/`LIMIT_FIELDS`/
  `JUKEBOX_FIELDS`, exported), so the append-only audit can never record a
  value the store silently clamped; (major) a bad jukebox monetization/mode
  enum 400s instead of coercing to the default (billing-model flip); (major)
  the owner Save now ships a jukebox DIFF, not the full config (a stale
  out-of-band knob no longer 400s unrelated edits, and no phantom audit rows);
  (major) a blank price field is treated as unchanged, never coerced to $0.
  Minor fixes: `rotateRigKey` is one atomic store write (no more delete-then-
  add that could strand a rig), `reloadMirror` swaps atomically (a half-load
  can't un-freeze a suspended org), houseMode flips now persist AND kick the
  live player, `PATCH {jukebox:null}` → 400 not 500, and the session/venues UIs
  got stale-response guards + poll guards + re-issued status messages + the
  key-stays-visible-on-rotate fix. Verified live via curl + browser.
  Verified LIVE against the real server (scratch boot with a
  directly-constructed FileStore so `orgsEnabled` is true + a dev-identity
  shim): owner band reject/accept round-trip with real audit rows, staff
  scoping, tech rotate (old key dead), venues panel. Suites: **ops 18→26,
  orgs 16→19** (staff pause/resume via endpoint, suspension-at-gate, roster
  authz, userId-linkage, invite-guard, reject-not-clamp, enum-reject,
  jukebox-null), items 42 still green after the payload change.
- **⚠️ CABINET DEMO LOOK IS ON** — `CABINET_DEMO = true` in `index.html`
  renders a furnished, NON-functional cabinet preview (3 fake records + 12
  prints; clicks explain). **When William says "remove demo": flip that one
  flag to false** (search "CABINET DEMO LOOK"). Smoke test covers both states.

**Security invariants (adversarially reviewed + fail-closed-tested — keep):**
- Payload/query identity (`{user:{id,name}}` / `?uid=&name=`) works ONLY when
  `devIdentityAllowed()` (= Supabase env ABSENT). Keyed on **intent, not DB
  reachability** — a DB outage on prod fails CLOSED (401s), never open.
- Clients can't forge control-plane bus types (`queues`, `denied`, `item`,
  `item_queues`, `output`, `jukebox`). Player TRUTH (`track_started/ended/
  position`) is consumed **only from an authenticated rig socket** (`ws._rig`)
  or the X-Admin-Key HTTP inject — never a privileged human session.
- Steering the live output — `key` scene_1..4 AND `station/channel/mode/
  transport` (`OUTPUT_CTL`) — passes the gate: operator (vj/radio/admin) or the
  slot holder only. Anonymous spectators / HTTP injects are denied.
- `ws._user` binds before gated keys process (buffered during handshake).
- Admin: **constant-time** key compare, **per-IP brute-force lockout**, and
  FAIL-CLOSED (503) if a Supabase-configured deploy is left on the `dev`/unset
  key. Rig keys constant-time-compared and carried in the `x-rig-key` header.
- WS upgrades reject cross-origin (`verifyClient`); every response carries
  anti-clickjacking/nosniff/HSTS headers; the audio relay is SSRF-guarded
  (no loopback/link-local/private targets, redirects re-validated per hop).
- Album stream: no traversal, guarded streams (a read error must not crash
  the process — it used to), 416 on bad ranges.

---

## 3. Tests — run ALL before every push (green = shippable)

FOUR suites now (the six Volt Control suites moved to `~/volt-control`):

```bash
node .smoke-test.cjs        # client: whole console in jsdom (~20 steps)
node .smoke-server.cjs      # server: paid gate + shop gates (15 checks, hermetic)
node .smoke-failclosed.cjs  # boots real server w/ Supabase env set + DB down → paid bids 401 (5 checks)
node .smoke-security.cjs    # security hardening: output-gate, SSRF, admin lockout, WS origin, headers (12 checks)
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

0. **BUILD NEXT: the Volt Control split** — user site vs admin/ops page
   (`PROMPT-CONTROL-SPLIT.md` is the complete plan; settle its §1
   architecture question with William before coding).
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
- **Admin-chain landmines:** org roles are a SEPARATE axis from platform
  roles — never conflate `orgRole` with `role`. The ladder is NOT linear:
  owner ⊇ staff for general caps, but **tech is exact** (`requireOrg('tech',
  {exact})`) — an owner is NOT a tech and must never reach rig keys. Org
  membership matches on **email** (both the session's and the invite's,
  lowercased); `roleOf`/gate always start from `item.orgId`. `store.orgsEnabled`
  is TRUE for a directly-constructed FileStore (so `.smoke-orgs.cjs` runs) but
  `createStore` forces it FALSE for any FileStore backing a real app → prod
  without Postgres 503s. The jukebox config PATCH **must** deep-merge (orgs.js
  `planJukeboxMerge`) — the store's `applyItemPatch` REPLACES. `orgId`/`bounds`
  are set via dedicated store methods (`setItemOrg`/`setItemBounds`), NOT the
  general patch (which rejects them) — so an owner can't self-assign or
  self-widen. Test-harness note: the fake `call()` in `.smoke-orgs.cjs` collects
  and awaits ALL handler promises, because middleware call `next()` without
  awaiting — a naive `await next()` lets sequential calls overlap and race the
  file store.

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

- ***"Split Volt Control per PROMPT-CONTROL-SPLIT.md"*** → the queued-up
  mission: user site vs admin/ops page, full plan + inventory in that file.
- *"Fix my local DB: switch .env to the transaction pooler and verify
  CONNECTED, then walk me through the password rotation."*
- *"remove demo"* → flip `CABINET_DEMO` to false, run suites, push.
- *"Here's my Stripe test key — build Tier 2b"* → PAYMENTS-SETUP.md §2–3
  against the STRIPE seams, with webhook idempotency + Postgres persistence.
- *"Transcode the station/album FLACs to Opus and swap them in."*
- *"Build pooled FX"* → ROADMAP Tier 4 leftovers on the existing bus.

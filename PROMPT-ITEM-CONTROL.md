# Build prompt — "Volt Control": pay-to-control items via TouchDesigner

**Paste this whole file into a fresh Claude session in `~/td-stream-control`.**

> Before writing any code: read `HANDOFF.md` (state transfer), then `CLAUDE.md`
> (binding rules + test commands). Everything below extends the existing
> system — reuse its patterns, never break its contracts, keep all three smoke
> suites green, and verify live like the repo expects.

---

## 1. What you're building

A second product inside the existing site: **physical/visual "items" driven by
TouchDesigner that the public pays to control from their phone.**

- Each item has a **6-character code** (letters+digits). A **QR code** takes a
  user straight to it.
- Users open the page, enter (or arrive with) a code, see the item's status,
  the current controller and their remaining time, and either **Buy Now**
  (join a timed queue) or **Bid** (soft-close auction — winner takes the slot).
- Once they hold the slot, they get a **touch controller**: a d-pad
  (up/down/left/right) plus **A / B / C** buttons. Every press travels the
  existing action bus to TouchDesigner, exactly like the audio-reactive
  console's Live actions do.
- **Admins** manage items: create them, set price + slot length, choose
  buy-now vs auction mode, skip the current user, pause, and turn items
  off/on — with pause/off/on also announced to TD (WebSocket DAT natively,
  OSC via the existing bridge).

**Decided constraints (owner's calls — don't re-litigate):**

1. **UI: clean minimal.** Bright, simple, thumb-first mobile UI. Big touch
   targets, no visual noise. NOT the neon console aesthetic — this is a
   walk-up product. Admin view is desktop-first but must work on a phone.
2. **Auction = soft-close countdown.** First bid arms an admin-configured
   countdown (default 60s). A bid landing in the final 10s extends the clock
   by 10s. Highest bid at zero wins the control slot.
3. **Payments stubbed** at marked `STRIPE:` seams, exactly like
   `server/paid.js`. Mechanics are real and enforced; money is not. Tier 2b
   converts every seam at once — shape the endpoints to survive that swap.
4. **Identity: anonymous to browse, signed-in to pay.** Anyone can view an
   item, its queue/auction, and timers with no account. Bidding, buying, and
   holding the controls require a verified Tier 2a session (Supabase cookies).

Default to the user page; a small corner icon reveals admin sign-in. Users
are primarily mobile; admins primarily desktop but need quick phone access.

---

## 2. How it plugs into what exists (reuse map)

| Need | Reuse | Where |
| --- | --- | --- |
| Realtime fan-out to TD + all viewers | **Action bus rooms** — subscribe items as channel id `item:<CODE>` (e.g. `wss://…/api/bus?channel=item:7KP3QX`). No new socket infra. | `server/bus.js` |
| Timed slot → countdown → auto-promote queue | **Copy the mechanics** of the control queue (state map, `startNext`, 1s expiry tick, `publicQueues` broadcast, `peek`/`chan` no-create-on-read pattern) | `server/paid.js` |
| Who is asking (verified session, dev escape hatch) | `requester()` / `userFromRequest()` / `devIdentityAllowed()` | `server/paid.js`, `server/auth.js` |
| Server-only message types clients can't forge | `RESERVED` set | `server/bus.js` |
| Admin auth | `requireAdmin` (X-Admin-Key header) | `server/index.js` |
| Durable admin-created objects (survive deploys) | `store.js` pattern — Postgres via DATABASE_URL with JSON-file fallback | `server/store.js` |
| TD/OSC delivery | WebSocket DAT reads the bus natively; `tools/bus-to-osc.mjs` forwards `type:'key'` actions as `/volt/key/<action>` **unchanged** | `SETUP.md` §"Receiving viewer actions" |
| HTTP test injection | `POST /api/channels/item:<CODE>/actions` already works for item rooms for free | `server/bus.js` |

New files: **`control.html`** (the whole product UI — user + admin) and
**`server/items.js`** (mounted from `server/index.js` like `attachPaid`).
Item definitions persist via `store.js` (add an `items` table + JSON
fallback); runtime queue/auction state stays in-memory at this tier
(documented reset-on-deploy, same as paid.js).

`control.html` follows the same golden rules as `index.html`: ONE
self-contained file, no bundler, no external JS deps, no localStorage.
`/control` resolves to it automatically (`express.static` has
`extensions:['html']`). Do NOT touch `src/` or `react-app.html` (archived).

---

## 3. Data model

**Item (durable, via store.js):**

```
{ code: '7KP3QX',            // server-generated, 6 chars, unambiguous alphabet
                              // (exclude 0/O/1/I), unique
  name, description?,        // description optional, short
  mode: 'buynow'|'auction',
  priceCents,                // buy-now price, or auction starting bid
  slotSeconds,               // how long a winner controls it
  auctionSeconds,            // countdown length (auction mode; default 60)
  minIncrementCents,         // auction bid step (default 50)
  status: 'on'|'off',        // off = not sellable, controller dead
  createdAt }
```

**Runtime (in-memory Map keyed by code, paid.js-style):**

```
{ active: { userId, name, endsAt, startedAt, paused?, pausedRemainingMs? } | null,
  queue:  [{ userId, name, cents, at }],            // buy-now mode
  auction: { bids: [{ userId, name, cents, at }],   // auction mode
             endsAt } | null }                      // null = no live round
```

Rules: one holder at a time per item. In auction mode, when a slot ends the
next round arms on the next bid (continuous loop). Pause freezes the
holder's remaining time; resume restores it. `off` clears nothing but stops
sales and gates all controller input; `on` re-enables.

---

## 4. API (follow index.js conventions: JSON, httpError, next(e))

Public (no auth — browse is anonymous):

- `GET /api/items/:code` — item meta + public runtime state: active holder
  (name, endsAt, slot length, paused), queue positions **with estimated
  start times**, or auction state (top bid, bidder name, endsAt, min next
  bid). Must NOT create runtime state on read (mirror `peek`/`EMPTY`).

Signed-in (verified session; dev escape hatch only when auth unconfigured):

- `POST /api/items/:code/buy` — buy-now → stub-pay → join queue →
  auto-promote when free. `STRIPE:` seam. 409 if already holder/queued,
  429 if queue full (cap ~25), 409 if item is `off` or in auction mode.
- `POST /api/items/:code/bid { cents }` — auction. Validates ≥ starting
  price / ≥ top + increment; arms the countdown on first bid; soft-close
  extend in final 10s. `STRIPE:` seam — record `{cents, payer}` per bid;
  leave a comment that 2b becomes authorize-on-bid / capture-winner /
  release-losers.
- `POST /api/items/:code/cancel` — leave queue or surrender the slot
  (`STRIPE:` refund seam).

Admin (`requireAdmin` — X-Admin-Key, same as the rest of the repo):

- `GET /api/items` — all items + live state (the admin dashboard's data).
- `POST /api/items` — create (server generates the code).
- `PATCH /api/items/:code` — name/price/slotSeconds/mode/auctionSeconds/etc.
- `DELETE /api/items/:code`
- `POST /api/items/:code/skip` — end current slot, promote next
  (comment the 2b partial-refund decision, like paid.js's skip).
- `POST /api/items/:code/state { action: 'pause'|'resume'|'on'|'off' }`

Every mutation broadcasts fresh public state to the item's bus room so all
open phones update live (paid.js `broadcast` pattern).

---

## 5. Bus + TD contract (public contract — extend, never break)

**Controller input** reuses the existing stamped `key` schema so TD parsing
and the OSC bridge work unchanged:

```
{ "type": "key", "action": "pad_up"|"pad_down"|"pad_left"|"pad_right"
                          |"btn_a"|"btn_b"|"btn_c",
  "user": { id, name }, "ts": … }
```

`tools/bus-to-osc.mjs` already forwards these as
`/volt/key/pad_up` … `/volt/key/btn_c` (string arg = presser's name) with
zero changes. Document the new actions in SETUP.md's schema table + the TD
Script DAT example + the OSC table.

**Server-originated item state** (new RESERVED type — add `'item'` to the
`RESERVED` set in bus.js so clients can't forge it; additive, non-breaking):

```
{ "type": "item", "action": "pause"|"resume"|"on"|"off"|"skip"
                          |"slot_start"|"slot_end"|"auction_won",
  "item": "<CODE>", "user"?: {…}, "ts": … }
```

The bridge forwards unknown types as `/volt/<type>` with JSON today — that
already works; optionally extend its `route()` to emit `/volt/item/<action>`
(nice-to-have, keep backward-compatible).

**Queue/auction updates** reuse the RESERVED `queues` type with an item
payload (rooms are per-item, so no ambiguity), or add an `item_queues`
RESERVED type — your call, but clients must not be able to inject it.

**Gating (the critical change).** `bus.js`'s `keyGate` currently gates only
`/^scene_[1-4]$/` and is installed solely by paid.js. Generalize minimally,
e.g. a small gate registry: each registered gate is offered every
`type:'key'` message and returns `null` ("not mine") or `{ok}` /
`{ok:false, reason}`; paid.js keeps its scene_1..4 behavior verbatim,
items.js registers a gate that claims `pad_*`/`btn_*` in `item:`-prefixed
rooms. **Existing behavior and `.smoke-server.cjs` must stay green.**

Item-gate verdicts (identity = `ws._user`, the session bound at the WS
upgrade — NEVER the payload, except the documented dev escape hatch):

- item `off` or paused, or no active holder → deny all pad/btn.
- active holder's verified id matches → pass.
- verified `vj`/`radio`/`admin` → pass.
- everyone else → `{type:'denied'}` with a human reason.

The HTTP inject route runs the same gate (X-Admin-Key acts privileged) —
that comes free if you extend the gate mechanism rather than bypassing it.

**Cross-product collision to close:** nothing today stops
`POST /api/channels/item:<CODE>/control/request` from creating a paid.js
takeover queue on an item room (and paid.js's gate from acting there). Keep
the two products' territories disjoint: the items gate owns `item:`-prefixed
rooms, paid.js's gate ignores them, and the paid/song endpoints reject
`item:`-prefixed channel ids (or items.js claims the namespace explicitly).
Add a smoke check for it.

---

## 6. Security invariants (adversarially reviewed in HANDOFF — extend, don't weaken)

- Payload/query identity works ONLY when `devIdentityAllowed()` (Supabase env
  absent). With env set and the DB down, bids/buys **fail closed** (401) —
  extend `.smoke-failclosed.cjs` to prove it for `/buy` and `/bid`.
- Clients can never inject RESERVED types (`queues`, `denied`, + new `item`).
- No create-on-read: public GETs and bus subscriptions must not grow server
  state unboundedly (mirror `peek`/`EMPTY`; codes are validated against the
  durable store before any runtime state materializes).
- Respect the bus rate budget (`RATE = {burst:20, perSec:8}` per socket):
  the controller must throttle hold-to-repeat to ≤8 presses/s so real input
  never silently drops.
- Auction inputs: integer cents, hard caps (e.g. ≤ $500), reject
  out-of-round bids; per-user bid rate limit.

---

## 7. `control.html` — user UI spec (clean minimal)

Three views in one file, mobile-first (assume ~390px wide), thumb-reachable:

1. **Code entry** (default view): the product name, one big 6-slot code
   input (auto-uppercase, alphanumeric, auto-advance), Go button.
   `?item=<CODE>` in the URL (the QR target) autofills and auto-submits.
   Bad code → friendly inline error.
2. **Item view**: item name + status chip (`LIVE` / `PAUSED` / `OFF`).
   - Current controller: name + **remaining time as a progress bar** out of
     the full slot (e.g. "1:24 left of 2:00").
   - Buy-now mode: price, big **Buy Now** button, the queue with names and
     **estimated start times** (computed from active `endsAt` + slot lengths
     ahead), your highlighted position if queued, Leave Queue.
   - Auction mode: current top bid + bidder, **soft-close countdown**, min
     next bid, quick-increment buttons (+$0.50 / +$1 / custom), **Bid**.
   - Not signed in and taps Buy/Bid → inline prompt linking `account.html`
     sign-in (return to the item after). Browsing never requires sign-in.
   - Live updates via the item's bus room (reconnect with backoff); fall
     back to polling `GET /api/items/:code` every few seconds if the socket
     drops — the page must degrade gracefully (golden rule).
3. **Controller** (auto-shown while you hold the slot): full-screen touch
   pad — d-pad with four large zones + **A B C** row at the bottom;
   remaining-time bar across the top. Fire on `touchstart`/`pointerdown`
   (latency), `touch-action: manipulation`, no double-tap zoom, optional
   `navigator.vibrate(10)` per press. Hold-to-repeat ≤8Hz. Keyboard
   fallback for desktop testing: arrows + A/B/C keys — but don't collide
   with the console's reserved keys; this is a separate page, so a fresh
   KEY_MAP is fine. Slot end → "Time's up" moment → back to item view with
   a re-buy/re-bid shortcut. Paused → controller visibly frozen with a
   "host paused this item" note.

Testability from day one: expose `window.__*` shims (state, timers, fake
clock hooks) exactly like `index.html` does, so the jsdom smoke can drive it.

---

## 8. Admin spec (same page, corner icon)

Gear icon in a corner of the code-entry view → admin key prompt (kept in
memory only, sent as `X-Admin-Key`, same as `admin.html`). Wrong key →
error; correct → dashboard:

- **Item cards**: name, code (tap to copy), mode, price, slot length,
  status, current holder + countdown, queue depth / auction top bid. Live
  via bus subscriptions or short polling.
- Per-item actions: **Skip · Pause/Resume · Off/On · Edit** (price, slot
  seconds, mode, auction seconds, increment) · Delete (confirm).
- **Create item**: name, mode, price, slot length → returns code
  prominently.
- **QR code per item**: render a QR for
  `https://<site>/control?item=<CODE>` **inline** (embed a tiny
  dependency-free QR encoder — small MIT implementations exist; no external
  script tags, no CDN) with a print-friendly view (big QR + item name + code
  as text fallback).
- Must remain usable one-handed on a phone (quick skip/pause at an event).

Also add a compact Items section to `admin.html`'s host view OR link
prominently to `control.html`'s admin mode from there — don't duplicate two
full dashboards; pick one home and cross-link.

---

## 9. Payments (stub tier)

Copy paid.js's approach exactly: a `stubPay(kind, cents, user)` that
succeeds instantly, called at clearly marked `STRIPE:` seams (buy, bid,
cancel-refund, skip-partial-refund). Record cents/payer everywhere a real
charge would exist. When Tier 2b lands (PAYMENTS-SETUP.md), these seams
become Checkout/PaymentIntents + webhook, and runtime queues move to
Postgres — write nothing that fights that migration.

---

## 10. Tests (the only gate — no CI)

Keep `node .smoke-test.cjs`, `node .smoke-server.cjs`,
`node .smoke-failclosed.cjs` green, and add:

- **`.smoke-items.cjs`** (in-process, hermetic, `.smoke-server.cjs` style):
  create item (admin) → public GET (and prove no-create-on-read) → buy →
  slot starts → second buyer queues with correct estimated start → expiry
  promotes → skip promotes → pause freezes remaining time → `off` blocks
  buys AND controller input → auction: under-min bid rejected, valid bid
  arms countdown, late bid soft-extends, winner takes slot, next round
  re-arms → gate: non-holder `pad_up` denied / holder passes / admin
  bypasses / forged `type:'item'` dropped → dev escape hatch works ONLY
  with auth unconfigured.
- **Fail-closed**: extend `.smoke-failclosed.cjs` (or mirror it) — Supabase
  env set + DB down → `/buy` and `/bid` return 401, never accept payload
  identity.
- **`.smoke-control.cjs`** (jsdom, `.smoke-test.cjs` style): evals
  `control.html`'s script (catches syntax errors), drives code entry →
  item view render (both modes) → controller shows on slot grant → presses
  produce correctly-shaped stamped `key` messages → throttle enforced →
  slot-end returns to item view → admin unlock renders dashboard.

Remember the jsdom landmine from HANDOFF: page-scope `const`/`let` aren't
reachable from separate evals — build `window.__*` shims in from the start,
and `await new Promise(setImmediate)` between fetch-driven actions and
assertions.

---

## 11. Ship checklist

1. All suites green locally (use the documented no-Supabase env trick to
   exercise the dev identity path).
2. Adversarial review pass over the diff (HANDOFF §7 workflow) — especially
   the gate registry change in bus.js — before committing. Commit style:
   what + why, `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.
3. Push to `main` → Render auto-deploys (~30–60s, deploys flap ~30s — probe
   a marker string before diagnosing). Verify live: create a real item,
   open `/control?item=<CODE>` on a phone-sized viewport, buy, hold the
   controls, watch `POST /api/channels/item:<CODE>/actions` + a bus
   subscriber see the presses; probe the security posture (unauthed bid →
   401 in prod).
4. Update the docs that must stay in sync: `HANDOFF.md` (new state +
   landmines), `SETUP.md` (TD/OSC mapping for pad/btn + item messages, QR
   flow, operator how-to), `MANAGE.md` (runbook: create item, print QR,
   event-day pause/skip), `ROADMAP.md` (where this lands in the tiers),
   `CLAUDE.md` (one-paragraph product note + new smoke commands).

---

## 12. Non-goals + open questions for the owner

Non-goals for this slice: no in-page video of the TD output (assume the
output is physically visible or on a separate stream; embedding lands with
Tier 3b LiveKit), no real money, no per-user purchase history UI, no
multi-holder items.

Ask William early (don't block on them — defaults in parentheses):

1. Product name shown to users? (working title "Volt Control";
   page stays `control.html` either way)
2. Item images on the item view, or name + description only for v1?
   (default: text only)
3. Auction: keep losers' names visible in a recent-bids list? (default: show
   top bid + count only)
4. Does holding the slot ALSO grant the console's scene_1..4 anywhere, or
   are the two products fully separate? (default: fully separate)

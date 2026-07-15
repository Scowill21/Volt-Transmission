# Build prompt — split Volt Control: user site vs admin/ops site

**Paste this whole file into a fresh Claude session in `~/td-stream-control`.**

> Before writing any code: read `HANDOFF.md` (state transfer), then `CLAUDE.md`
> (binding rules + test commands). This document is the deep-dive for ONE
> mission: take `control.html` — which today contains BOTH the public
> pay-to-control experience AND the admin dashboard — and split them so the
> user product stands as an independent site and the admin tooling lives on
> its own page. Written by the session that built Volt Control (commits
> `620babf` → `c3058a6`); accurate as of `5c5b924` and fact-checked against
> the repo by an independent verification pass. Names are trustworthy;
> re-grep positions yourself (§3) if later commits landed. Repo baseline
> note: `SETUP-PAYMENTS.md` is deliberately untracked (William's pending
> merge-or-delete decision, HANDOFF §5) — leave it out of your commits.

---

## 1. The mission

**Split `control.html` (1300 lines, one self-contained file) into:**

1. **The user site** — code entry → item view (buy/bid) → touch controller.
   This is the walk-up product QR codes point at. It should feel like its own
   independent site: no gear icon, no admin code shipped to visitors' phones,
   no path from the public page into ops.
2. **The admin/ops page** — key-gated dashboard: create/edit/delete items,
   QR + print posters, skip/pause/off, live status cards.

### The architecture decision (settle with William FIRST — don't guess)

"Independent site" can mean two very different builds:

- **Option A (recommended default): same Node service, separate pages.**
  `/control` stays the user page (QR posters in the wild already point at
  it); the admin dashboard moves to a new self-contained page (suggested:
  `control-ops.html` → `/control-ops`). `express.static` with
  `extensions:['html']` serves it with zero server changes. A separate
  *brand identity* later is cheap: Render supports multiple custom domains
  on one service, so e.g. `control.somedomain.com` can serve the same app —
  same origin per domain, so the httpOnly cookie auth (`volt_at`/`volt_rt`)
  and the bus WebSocket keep working untouched.
- **Option B: a truly separate deployment** (second Render service or a
  static site). This forces the API cross-origin: CORS with credentials,
  `SameSite=None; Secure` cookies, WS origin checks, and QR/base-URL
  configuration. It breaks the repo's deliberate "server-mediated,
  same-origin, httpOnly" auth design (HANDOFF §2) for no functional gain at
  this tier. **Recommend against** unless William has a concrete reason
  (e.g. separate billing/branding constraints).

Everything below assumes Option A. If William picks B, stop and re-plan the
auth story first — that's a security redesign, not a file move.

---

## 2. What exists today (all verified live in production)

- **Product:** Volt Control — pay-to-control physical/visual items driven by
  TouchDesigner. Each item: 6-char code (alphabet excludes 0/O/1/I) +
  printable QR → `/control?item=<CODE>`. Buy-now queue (auto-promote,
  estimated starts) or soft-close auction (first bid arms the countdown,
  final-10s bid adds 10s, top bid wins, next round arms on first bid after
  the slot ends, $500 hard cap closes a round with `minNextCents: null`).
  Winner gets a timed slot; their phone becomes a d-pad/A-B-C controller.
- **Server:** `server/items.js` (runtime queues/auctions, gate, API) +
  durable item defs in `server/store.js` (Postgres `items` table / gitignored
  `server/items.json`; atomic writes; corrupt-file set-aside). Items carry an
  admin-written `instructions` field ("controls guide", ≤500 chars) shown on
  the item page and behind the controller's (i) button.
- **Bus:** presses ride room `item:<CODE>` as stamped
  `{type:'key', action:'pad_up'|…|'btn_c', user, ts}`. `server/bus.js` runs a
  **gate registry**: paid.js claims only `scene_1..4` outside `item:` rooms;
  items.js owns `item:` rooms. Gate order matters: verified vj/radio/admin
  pass FIRST (even while an item is paused/off — deliberate, the host's own
  rig keeps working); then paused/off/no-holder deny everyone else; then the
  holder check. RESERVED (unforgeable, server-only) types:
  `queues`, `denied`, `item`, `item_queues`. The OSC bridge forwards
  `/volt/key/<action>` and `/volt/item/<action>` (arg 1 = name, arg 2 = code).
- **API** (see `server/index.js` header for the full list): public
  `GET /api/items/:code`; signed-in `POST /api/items/:code/buy|bid|cancel`;
  admin (X-Admin-Key) `GET/POST /api/items`, `PATCH/DELETE /api/items/:code`,
  `POST /api/items/:code/skip`, `POST /api/items/:code/state`
  (`pause|resume|on|off` — on/off MUST go through /state so TD gets the
  announce; PATCH deliberately 400s on `status` and 409s on a mode flip while
  runtime state is live).
- **Money:** stubbed at `STRIPE:` seams (same tier as paid.js/shop.js).
  Runtime queues/auctions are in-memory — reset on deploy; item definitions
  survive in the store.
- **Identity:** anonymous browse; buy/bid needs a verified session
  (Supabase cookies). Dev escape hatch (`{user:{id,name}}` body /
  `?uid=&name=` URL) works ONLY when Supabase env is absent
  (`devIdentityAllowed()`); production fails closed — `.smoke-failclosed.cjs`
  proves buy/bid 401 during a DB outage.
- **account.html** takes a validated `?return=`: the value must START with a
  single `/` whose next char is neither `/` nor `\`, AND its resolved origin
  must equal ours — the `new URL(r, location.origin)` origin comparison is
  the authoritative backstop (e.g. `/a\b` passes the regex and is safe
  because it resolves same-origin). Reuse this exact pattern anywhere the
  ops page links to sign-in.

## 3. Inventory of `control.html` — what moves where

The file is ONE `<style>` + ONE `<script>` (1300 lines at `5c5b924`). The
inventory below is BY NAME, not by line range — a fact-check pass proved
contiguous ranges misclassify the interleaved shared pieces. **Step one of
the implementation should be your own grep sweep** (`grep -n` each name
below) — trust names, verify positions.

**Goes to BOTH files (duplicate — the self-contained golden rule):**
- CSS: the `:root` tokens, `.shell`/`.top` chrome, `.card`, `.btn` (+
  variants), `.row`, `.err`, `.status-line` (⚠ used by USER buy/bid
  messages AND admin cards — easy to misfile as admin-only), `.note`,
  `.back`, `.mini`, `.edit-form` input styling if the user page ever grows
  forms (today it's admin-only — see below).
- JS: `$`, `esc`, `fmt$`, `fmtClock`, `api()`, and **`remainingMs()`** —
  defined among the user view helpers but called by the admin dashboard's
  `adminCard()` for the live holder countdown. Miss it and the ops page
  throws only when an item has an ACTIVE holder (idle smoke tests pass).

**USER page keeps:** header (wordmark + acct chip — the **gear is
deleted**), `#viewEntry` + code-entry CSS, `#viewItem` (+ `.chips` bid UI —
user-only despite looking "shared"), `#viewController` + `#timesUp`,
`#toast` element + CSS + `toast()` (today only user code paths fire toasts),
`IDENTITY`/`hydrateIdentity` (keeps the re-apply-S.item holder-reload fix),
`payBody`, `liveSync()` + the 4s poll fallback (404 → leave the dead page),
`applyItem` (ts staleness guard), buy/bid/cancel, timers, the controller
(bucket, hold-repeat, (i) popup, release), `boot()` with `?item=` autofill.

**OPS page gets:** `#viewAdmin` markup (key gate + create form + dashboard)
+ its CSS (`.icard`, `.acts`, `.edit-form`, `#adminKeyIn`), `#qrModal` +
its CSS + the `@media print` poster mode (keep the
`body:has(#qrModal:not([hidden]))` scoping — it exists so a plain Cmd+P
doesn't print a blank page), the **QR encoder** (`const QR = …`, `drawQR`,
~240 lines, jsqr-verified — the user page sheds it entirely),
`unlockAdmin`/`adminApi`/`refreshAdmin`/`renderAdmin`/`adminCard`/
`createItem`, card actions + edit submit, `openQR`.

**Known coupling traps (each verified in the current file):**
- `show()` dereferences the gear on EVERY view change
  (`$('gearBtn').hidden = view === 'controller'`) — deleting the button
  without editing `show()` throws on the first view switch and kills the
  whole user page. Same for the `'admin'` case and `#viewAdmin` in its
  view map, `gearBtn`'s click handler, and `adminBack`.
- The `S` state object is MIXED: `adminKey`/`adminItems` live next to the
  user fields. Strip them from the user page; give the ops page its own
  tiny state. `refreshAdmin`'s first line is
  `if (!S.adminKey || S.view !== 'admin') return;` — on a standalone ops
  page there IS no `'admin'` view, so moving it "intact" silently disables
  the 4 s poll forever. Rewrite the guard (key-present + not-editing), and
  KEEP the not-editing half: skip re-render while an edit form is open or
  focus is inside `#adminList` (it protects typed-but-unsaved edits).
- The admin key stays in MEMORY only (never sessionStorage) — deliberate,
  stricter than admin.html.
- `.smoke-control.cjs` currently unlocks admin inside the same jsdom
  window — the suite must split with the pages (§6).
- The `window.__*` shims (15) split: user shims stay;
  `__unlockAdmin`/`__refreshAdmin`/`__createItem`/`__qrEncode` move to the
  ops page's own shim block.

## 4. Server-side work (small)

- **None required** for Option A: endpoints are already split by
  `requireAdmin`, and `express.static` serves any new `.html` extensionless.
- Update the cross-link in `admin.html` ("Volt Control ops view" → the new
  ops URL) and SETUP/MANAGE references to `⚙ gear`.
- Optional nice-to-have: a redirect or note at `/control` for admins who
  memorized the old gear flow.

## 5. Contracts that must NOT break

- Bus schema + RESERVED set + gate registry semantics (`.smoke-server.cjs`,
  `.smoke-items.cjs` enforce; territories stay disjoint).
- `/control?item=<CODE>` — QR posters may already be printed. The USER page
  must keep answering at `/control` with `?item=` autofill.
- Golden rules for BOTH new pages: one self-contained file each, no bundler,
  no external JS, no localStorage, degrade gracefully (poll fallback when
  the ws is down).
- `presets|live` wire values, TD message schema, everything in CLAUDE.md.
- The account.html `?return=` validator pattern (same-origin only) if the
  ops page links to sign-in anywhere.

## 6. Tests (the only gate — no CI)

Today: 5 suites, all green —
`node .smoke-test.cjs` (console) · `.smoke-server.cjs` (15) ·
`.smoke-failclosed.cjs` (7) · `.smoke-items.cjs` (26) ·
`.smoke-control.cjs` (18, drives BOTH user and admin views in one jsdom run).

The split must land with:
- `.smoke-control.cjs` reduced to the USER page (entry → item both modes →
  slot grant → stamped presses → hold-repeat + throttle → stale-ts guard →
  time's-up → sign-in prompt → controls-guide card + (i) popup) **plus an
  assertion that no admin markup/code ships in the user page** (e.g. no
  `unlockAdmin`, no `X-Admin-Key` string, no QR encoder).
- A new **`.smoke-ops.cjs`** (jsdom, same harness style): evals the ops page
  script; wrong key → error; `dev` key → dashboard renders; create → code +
  QR modal; edit form PATCH body; skip/pause/off/delete actions hit the right
  endpoints; the refresh guard skips while editing; QR matrices keep their
  structural checks (finder patterns, version sizes).
- jsdom landmines (hard-won, in HANDOFF §6): page-scope `const`/`let` are
  unreachable from separate evals — keep/extend `window.__*` shims; `await
  new Promise(setImmediate)` after fetch-driven actions; jsdom has no
  PointerEvent — dispatch `Object.assign(new w.Event('pointerdown'),
  {pointerId})` and stub `HTMLElement.prototype.setPointerCapture`; reset
  `__bucket.tokens` before throttle-flood assertions.
- Update CLAUDE.md/HANDOFF/MANAGE test lists (they enumerate the suites).

## 7. Landmines this exact feature taught us (don't relearn them)

- **Never write `pad_*/btn_*` inside a block comment** — the `*/` terminates
  it and kills the ESM parse at boot. Write "pad/btn".
- `liveSync()` must close the old room's socket on item switch AND every
  socket handler must check `S.ws === sock` before mutating — a deliberately
  closed socket's async `onclose` otherwise nulls out its replacement
  (orphaned sockets + duplicate reconnects). `.smoke-control.cjs` asserts
  the switch behavior; keep those checks when moving the code.
- `applyItem()` keeps its `ts` staleness guard (slow poll must not roll back
  a fresh buy → phantom "time's up"), and `hydrateIdentity()` re-applies
  `S.item` after `/api/me` resolves (verified holder reloading mid-slot).
- Client send budget: token bucket 7/s refill, burst 10, repeat 150 ms —
  deliberately under the bus's `RATE = {burst:20, perSec:8}` so held buttons
  never hit the server's silent drop. Don't "fix" the numbers upward.
- Browser-pane verification quirks: screenshot's focus-click can land on
  tap-anywhere-to-dismiss overlays (the (i) popup) and close them before the
  capture — check `hidden` via JS, don't trust the pixels; raw coordinate
  clicks were 2× off vs screenshot pixels — click by `read_page` refs.
- Use the `volt-api-dev` launch entry (port 8794, Supabase env stripped) to
  drive buy/bid in a browser; plain `volt-api` loads `.env` and correctly
  fails closed. Test items PSDV7H (buy-now) / 2AWK6P (auction) live in the
  local gitignored `server/items.json`.
- Render deploys flap ~30 s — probe a marker string in the new page, then
  re-probe before diagnosing.

## 8. Ship checklist

1. All suites green locally (including the new/split ones).
2. Adversarial review over the diff (HANDOFF §7 — multi-lens + refutation;
   last time it caught an open redirect and a holder-reload lockout that
   self-review missed). Fix majors before commit.
3. Commit (what + why, `Co-Authored-By: Claude Fable 5
   <noreply@anthropic.com>`), push `main` → Render.
4. Verify live: `/control` serves the user page with NO admin code in
   view-source; unauthed buy/bid still 401 in prod; old console/paid/shop
   routes untouched. **The prod ADMIN_KEY is Render-generated and must never
   be pasted into chat** — you can only verify the NEGATIVE path yourself
   (wrong key → 401/"wrong key" on the ops page); hand William the positive
   steps (unlock, create an item, print its QR from his own browser) and ask
   him to confirm.
5. Sync the docs that enumerate pages/flows: `HANDOFF.md`, `SETUP.md`
   ("Volt Control" §, the ⚙ gear instructions), `MANAGE.md` (runbook URLs),
   `CLAUDE.md` (product note + smoke list), `ROADMAP.md` if the shape moved.

## 9. Open questions for William (defaults in parentheses — ask early, don't block)

1. Option A or B from §1? (A — same service, separate pages; revisit a real
   second deployment only with a concrete need)
2. Ops page URL + title? (`control-ops.html` → `/control-ops`, titled
   "Volt Control · ops"; NOT linked from the user page)
3. Any admin affordance left on the user page? (none — gear removed; ops is
   bookmark-only, cross-linked from `admin.html`)
4. QR target base: keep `location.origin` at print time, or a configurable
   base for printing QRs that point at a future custom domain?
   (keep `location.origin`; add a base-URL field only when a custom domain
   actually exists)
5. Custom domain for the user site now? (not yet — Render multi-domain can
   be added later without code changes under Option A)

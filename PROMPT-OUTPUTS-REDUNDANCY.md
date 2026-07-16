# Build prompt — Volt Control v2: outputs, redundancy, TD-independence

**Paste this whole file into a fresh Claude session in `~/td-stream-control`.**

> Read `HANDOFF.md`, then `CLAUDE.md` (binding), then skim
> `PROMPT-CONTROL-SPLIT.md` §2–§3 and §7 — it is the fact-checked map of the
> shipped Volt Control product and its landmines; this doc builds ON that
> product and does not restate what's there. Keep every smoke suite green.
>
> **Sequencing:** this mission is written to run AFTER the control split
> (`PROMPT-CONTROL-SPLIT.md`) ships — admin UI work lands on the ops page.
> If the split has NOT shipped, everything still applies; the admin UI work
> goes into `control.html`'s gear view instead. Grep, don't assume.
>
> Baseline note: `SETUP-PAYMENTS.md` is deliberately untracked — leave it
> out of your commits.

---

## 1. The mission

Volt Control today has exactly one output: whatever TouchDesigner rig
happens to be subscribed to `item:<CODE>`. Nothing knows if it's there. An
item with no rig sells dead air; a rig crash mid-slot silently eats a
paying user's time.

Build the **output layer**: each item gets an ordered failover chain of
outputs — multiple TD/hardware **rigs** (authenticated, presence-tracked)
and **browser-rendered scenes** (a new `stage.html` venue renderer that can
never go offline). The server elects the best online output as "program",
fails over automatically, refuses to sell when nothing is listening, and
pauses a running slot's clock during output gaps. TouchDesigner becomes one
option among several instead of a hard dependency.

Owner's calls, already made: clean-minimal UI; payments stay stubbed at
`STRIPE:` seams; anonymous browse / signed-in pay; redundancy is a core
feature. Don't re-litigate.

## 2. What exists that you build on (verify by grep, per the split doc)

- `server/items.js` — items Map (durable defs mirrored in memory), runtime
  `state` Map (`peek`/`chan`), `publicItem()` → broadcast as
  `{type:'item_queues'}`, `announce()` → server-only `{type:'item'}`,
  `startSlot`/`slotOver`, the 1s expiry tick, `attachItems(app,
  requireAdmin, store)`, `__test = { state, items }`.
- `server/bus.js` — gate REGISTRY (`registerKeyGate`; items.js's gate owns
  `item:` rooms, privileged vj/radio/admin pass FIRST — deliberate, keep
  it), `RESERVED = {queues, denied, item, item_queues}`, per-socket
  `RATE = {burst:20, perSec:8}`, `ws._user` bound at upgrade with pending
  buffer.
- Item fields: `code`, `name`, `description`, `instructions`, `mode`,
  `priceCents`, `slotSeconds`, `auctionSeconds`, `minIncrementCents`,
  `status: 'on'|'off'`.
- `tools/bus-to-osc.mjs` forwards `/volt/key/<action>` and
  `/volt/item/<action>` already.
- Client: `control.html` (user views; token bucket 7/s deliberately under
  the bus RATE), ops page per the split. Suites:
  `.smoke-test/-server/-failclosed/-items/-control[/-ops]`.

## 3. Data model changes (durable, via store.js — migration-safe defaults)

Add to each item:

```
outputs: [                     // ORDERED failover chain, best first
  { kind:'rig',   name:'td-main',  priority:1 },      // TD, Pi, ESP32… (external)
  { kind:'rig',   name:'td-backup',priority:2 },
  { kind:'scene', name:'orb',      priority:3 } ],    // browser-rendered
limits: { maxPerMin: 240, cooldownMs: 0 }             // duty-cycle safety
```

- `kind:'rig'` entries get a server-generated **rigKey** — store only a
  hash; return the plaintext ONCE from the create endpoint.
- `kind:'scene'` = one of the built-in stage scenes (§6) — client-rendered,
  counts as **always online**. (A `webapp` kind is Phase 2, §9.)
- **Migration/back-compat:** existing items (and any item with an empty
  `outputs` list) behave exactly as today — treat "no chain configured" as
  "always available, no presence tracking". Nothing shipped may break the
  moment this deploys; the new rules engage only when an admin configures a
  chain.

Runtime additions per item: `rigsOnline: Map<name,{since,lastSeen}>`,
`program: {kind,name}|null`, `outputPausedAt`, duty-cycle counters.

## 4. Rig identity + presence (bus.js — smallest possible touch)

Rigs connect with identity:
`wss://…/api/bus?channel=item:<CODE>&rig=<name>&rigKey=<key>`.

- Add ONE pluggable hook beside the gate registry (e.g.
  `registerRigAuth(fn)`, same style as `registerKeyGate`): items.js
  validates `(channel, rig, rigKey)` against the item's hashed keys at the
  WS upgrade; success stamps `ws._rig = {name}`; a bad key closes the
  socket (code 4401). No rig params → plain viewer, exactly as today
  (subscribe stays public).
- items.js tracks rig sockets per item via connect/close callbacks plus the
  bus's existing ping/pong heartbeat for `lastSeen`.
- **Rig-originated types:** accept `score` and `telemetry` messages ONLY
  from sockets with `ws._rig` (or privileged `ws._user`); drop them from
  plain clients like RESERVED. The HTTP inject route keeps treating
  X-Admin-Key as privileged.

## 5. Election + failover (items.js)

- **Program** = lowest-priority-number ONLINE output; `scene` entries are
  always online. Recompute on rig connect/disconnect/heartbeat-timeout and
  on chain edits. Broadcast changes as a new server-only type (add to
  RESERVED):

```
{ "type":"output", "item":"<CODE>",
  "program": {"kind","name"} | null,
  "online": ["td-main","pi-lamp"], "ts": … }
```

- Rigs self-mute when not program (document in SETUP.md/HARDWARE.md; extend
  `bus-to-osc.mjs` to forward `/volt/output/<program-name>`).
- Program rig drops → **5s grace** → promote next in chain → broadcast.
  Higher-priority rig reconnects → preempt + broadcast.
- **No output online (`program:null`, only possible when a chain is
  configured and all rigs are down):** buy/bid return 409/503 ("output
  offline — not selling"); a RUNNING slot auto-pauses after the grace
  window and auto-resumes when an output returns. Use a SEPARATE flag from
  admin pause (`outputPaused` vs the shipped `active.paused`) so an
  admin resume can't collide with an output gap and vice versa — get the
  interaction matrix right and test all four states.
- **Duty-cycle enforcement** (`limits`) in the items gate, BEFORE fan-out:
  sliding-window `maxPerMin` + per-action `cooldownMs`, denied with a
  "cooling down" reason the controller shows. **Apply it to privileged
  senders too** — hardware doesn't care who burned out the relay
  (recommended; flag to William if he objects). Identity checks keep the
  shipped privileged-first order.
- `publicItem()` gains `program` + `outputsOnline` (+ chain names for the
  ops page) — additive fields, phones tolerate them.

## 6. stage.html — the browser output plane (what makes TD optional)

New page, same golden rules (ONE self-contained file, no external deps, no
localStorage). `stage.html?item=<CODE>` = fullscreen venue/projector
renderer: subscribes to the room, renders the item's `scene`, reacts to the
holder's pad/btn presses live. With `&rig=<name>&rigKey=<key>` it also
registers as a rig so election counts the projector as an online output;
without a key it's a passive spectator mirror.

- Ship **2–3 input-reactive scenes** (suggested: "Orb" — d-pad steers,
  A/B/C recolor/burst/trail; "Grid" — light-cycle trails; "Bloom" —
  generative flora). Console scene discipline (virtual 1280×720 cover-fit,
  60fps Canvas 2D, no per-frame allocations) but input-driven, NOT coupled
  to `SIG`/audio.
- **Attract mode** when idle: self-driving demo + "scan to control" overlay
  (big QR? it has the code — reuse the ops page's QR encoder module by
  duplication, self-contained rule). A scanned QR must never land on a
  dead-looking page.
- Reconnect with backoff; on reopen, re-fetch `GET /api/items/:code` —
  never assume missed messages (staleness guard pattern from control.html).
- `control.html`'s item view: add the `OUTPUT OFFLINE` status treatment and
  a **spectator strip** — a mini d-pad/A-B-C diagram that lights up with
  the room's live `key` messages while you wait.

## 7. API additions (conventions: JSON, httpError, next(e))

Admin (requireAdmin), on the ops page:

- `POST /api/items/:code/outputs` `{kind, name, priority, scene?}` — for
  rigs returns `{rigKey}` **once**; store the hash.
- `PATCH /api/items/:code/outputs/:name` (priority/scene) ·
  `DELETE /api/items/:code/outputs/:name` (revokes the key).
- `PATCH /api/items/:code` accepts `limits`.
- Ops dashboard: per-item output chain with live green/grey presence dots +
  `lastSeen`, program badge, add-rig flow surfacing the key once,
  drag-or-buttons reorder.

Public: `GET /api/items/:code` now carries `program`/`outputsOnline`
(names only — no keys, obviously).

## 8. Security invariants (extend, never weaken)

Everything in HANDOFF + the split doc still holds (fail-closed identity,
RESERVED unforgeable, no create-on-read, ≤8/s client throttle). New:

- rigKeys hashed at rest, shown once, revocable; bad key = refused at
  upgrade; rig names are public, keys never appear in `publicItem`,
  broadcasts, or logs.
- Plain clients cannot emit `score`/`telemetry`/`output` (forged-type smoke
  checks).
- Presence tracking must not enable state growth: rig auth only
  materializes runtime for codes that exist in the durable store.
- Duty-cycle limits are server-side (client cooldown UI is UX, not
  security).

## 9. Phase 2 (only after phase 1 ships green + verified live)

In priority order, each its own commit: **volt apps** (sandboxed-iframe
web-app outputs — `sandbox="allow-scripts"`, postMessage in:
`key/item/output`, out: whitelisted `score` only; admin-added first,
creator submissions via the apply/approve pattern later) · **scores +
leaderboard** (rig/scene-emitted `score`, per-item top-N in memory) ·
**pay-to-extend** (+30s mid-slot) and **pay-to-jump** (priced queue-jump,
never past another jumper — both `STRIPE:` seams) · **live camera** (same-
origin MJPEG relay `/api/items/:code/camera`, admin-set URL, pattern of the
Tier 3a audio relay) · **pooled free mode** (idle items: anyone's taps fire
rate-limited ghost effects) · **schedules** (auto on/off hours via the
tick, announced like admin on/off) · **web push** ("you're up soon" —
needs a separate `sw.js`; ask William before breaking the one-file rule,
fall back to in-page countdown + vibration).

## 10. Hardware companion (build in phase 1)

`NEXT-STEPS-VOLT-CONTROL.md` Part 2 is the terse Raspberry Pi spec;
`VOLT-PI-PLAYBOOK.md` is the long-form owner's guide (setup walkthrough,
recipes, venue playbook) — keep both truthful to what you implement. Build
to the Part 2 spec: **`tools/bus-to-pi.mjs`** — a rig client modeled on
`bus-to-osc.mjs` (reconnect forever; `--map pins.json` with
`pulse`/`toggle`/`hold`/`sweep`/`udp` behaviors; honors `output` self-mute
and `item` pause/off; degrades to log-only off-Pi so it's testable
anywhere). Ship **`HARDWARE.md`** — a polished version of that guide's
Parts 2–3, corrected to match what you actually implement (param names,
message fields, admin flow). Part 3 of that doc (ESP32, MQTT/Home
Assistant/Art-Net bridges, venue groups, live map, fleet ops) is backlog —
build none of it, but don't paint the rig/presence design into a corner
that blocks it.

## 11. Tests

Extend `.smoke-items.cjs`: rig auth (bad key refused / good key marks
presence) · election (two fake rig sockets, kill program → grace → promote
+ `output` broadcast) · preemption on reconnect · zero-output blocks
buy/bid · running slot auto-pauses on output gap and resumes after ·
admin-pause vs output-pause interaction (all four states) · scene-in-chain
keeps the item sellable · empty-chain items behave exactly as before
(back-compat) · duty-cycle denies (incl. privileged) · forged
`output`/`score`/`telemetry` from plain clients dropped · rigKey never in
any public payload.

New `.smoke-stage.cjs` (jsdom, harness style of `.smoke-control.cjs`,
mind its PointerEvent/shim landmines): page evals clean · scene renders
and reacts to an injected `key` · `output` switch flips renderer · attract
mode on idle · resync-on-reconnect staleness guard. Keep every existing
suite green; update the suite lists in CLAUDE.md/HANDOFF/MANAGE.

## 12. Ship checklist + open questions

Ship like the repo ships: suites green → adversarial review of the diff
(HANDOFF §7 — the rig-auth hook, election edge cases, and the pause-flag
matrix deserve the hardest look) → commit (what + why, `Co-Authored-By:
Claude Fable 5 <noreply@anthropic.com>`) → push → verify live on prod
(create a chain, connect a fake rig via `wscat`/node, kill it, watch
failover + the clock pause; confirm unauthed bid still 401; NEVER paste the
prod ADMIN_KEY into chat — verify negatives yourself, hand William the
positive steps) → sync HANDOFF/SETUP/MANAGE/ROADMAP/CLAUDE.md +
HARDWARE.md.

Ask William early (defaults in parentheses): duty limits apply to
privileged too? (yes) · default chain for existing items? (none — empty
chain = today's behavior) · stage scenes: which 2–3 first? (Orb + Grid) ·
`sw.js` exception for push? (defer).

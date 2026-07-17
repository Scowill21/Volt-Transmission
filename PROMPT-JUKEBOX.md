# Build prompt — Volt Jukebox: audio as a control surface

**Paste this whole file into a fresh Claude session in `~/td-stream-control`.**

> Read `HANDOFF.md`, then `CLAUDE.md` (binding), then
> `PROMPT-CONTROL-SPLIT.md` §2 (the fact-checked map of shipped Volt
> Control). **Sequencing: run AFTER `PROMPT-OUTPUTS-REDUNDANCY.md` ships**
> — this mission leans on its rig identity (rigKeys, presence, `ws._rig`),
> failover rules, and duty/window machinery. Grep, don't assume: verify
> what actually landed before building on it.

---

## 1. The mission

Items currently have one control surface: the d-pad/A-B-C pad. Add a
second, admin-selectable surface — **jukebox** — where the "item" is a
venue's music and the paid controls are **queue a song**, **skip**, and
optionally **bid for the next play**, all governed by admin-configured
restriction windows. A Raspberry Pi (or any rig) is the player; phones
show now-playing, the queue, prices, and skip eligibility live; the venue
TV can render the same as a marquee.

Owner's intent, verbatim requirements to honor:

- Admin specifies what audio control is allowed: **skipping** and
  **choosing/queuing** songs.
- Skip restrictions are admin-tunable: **how many skips per user within a
  time window**, a **room-wide skip cap** per window, **whether mid-song
  skips are allowed at all**, and a **skip window** (e.g. "skippable only
  before 15 seconds have elapsed"), plus a guaranteed minimum play time.
- **Add-to-queue** is a paid action with its own price; show the queue to
  everyone.
- Monetization mirrors items: fixed **prices** for queue/skip, **bidding**
  for the next play, or — the owner's preferred posture — **selling the
  CONTROLLER itself**: a timed slot (buy-now or auction, the machinery
  items already have) whose holder gets the skip/queue rights.
- Raspberry Pis run the actual music and the system shows queue +
  bids/prices to users. The player is pluggable: local files (MPD) or the
  venue's own Spotify account (§7).

## 2. Design at a glance

- **Surface, not fork.** Item gains `surface: 'pad' | 'jukebox'`
  (default `'pad'` — every existing item untouched; back-compat is a smoke
  check). A jukebox item reuses everything items already have: code + QR,
  status on/off, pause, the `item:` bus room, rig outputs + failover +
  presence from the outputs mission, STRIPE seams, ops dashboard card.
- **Server is the authority; the Pi is a dumb player.** The queue, the
  rules, the money, and "what plays next" live in `server/items.js` (or a
  sibling `server/jukebox.js` mounted the same way — your call, keep
  items.js readable). The rig receives play/skip commands and reports
  reality back; on reconnect it resyncs from the server, never the
  reverse.
- **Catalog-only selection.** Users pick from an admin-curated catalog
  (this is also what makes licensing sane — §8). No free-text requests on
  this surface.
- **Two monetization postures** (`jukebox.monetization`):
  `'controller_slot'` (recommended default) — the item sells a TIMED
  CONTROL SLOT with the exact shipped machinery (item `mode`
  buynow/auction, `priceCents`, `slotSeconds`, queue, soft-close — zero
  new money code); while you hold the slot, skip/pick/queue are yours,
  still bounded by the admin windows in §3. `'per_action'` — no slots;
  each queue-add/skip is individually priced, with optional
  bid-for-next-play. Slot mode is both simpler and the cleaner legal
  posture (§8): the product sold is an input device, never a song.
- **Pluggable player backend** (`jukebox.backend`): `'mpd'` (local files
  on the rig — rights-clean own catalog) or `'spotify'` (drive the
  venue's OWN Spotify Premium account via the Web API — no audio hardware
  in the loop at all). `'log'` for tests. §7 and §8 carry the details and
  the caveats.

## 3. Data model (durable, store.js — additive fields)

On items with `surface:'jukebox'`:

```
jukebox: {
  monetization: 'controller_slot' | 'per_action',   // see §2; default controller_slot
  backend: 'mpd' | 'spotify' | 'log',
  spotify?: { /* OAuth refresh token + device id for the venue's account —
                stored server-side only, NEVER in publicItem/broadcasts/logs;
                catalog[].file becomes a spotify track URI */ },
  catalog: [{ id, title, artist, durationSec, file }],  // admin-curated;
                                                        // `file` = rig filename or track URI
  queuePriceCents: 200,
  playNextPriceCents: null,        // optional upsell: pay more to jump to front (null = off)
  mode: 'buynow' | 'bid',          // bid = auction for NEXT PLAY (see §5)
  skip: {
    priceCents: 100,
    allowMidSong: false,           // false → skips only inside onlyBeforeSec
    onlyBeforeSec: 15,             // the owner's example; null = whole song (if allowMidSong)
    minPlaySec: 10,                // absolute floor — a song always gets this long
    perUser: { max: 2, windowMin: 30 },
    global:  { max: 6, windowMin: 60 },   // protects the room's vibe
  },
  queueRules: { maxLen: 25, maxPerUser: 3, noRepeatMin: 60 },  // same song can't requeue for N min
  houseMode: true,                 // idle + empty queue → rig shuffles its local folder
}
```

Runtime (in-memory, paid.js-style; document reset-on-deploy):
`nowPlaying {songId,title,startedAt,durationSec}` · `queue
[{songId,title,byId,byName,cents,at,priority?}]` · sliding-window skip
counters (per-user + global; prune on read) · `bidRound {bids[], closesAt}`
in bid mode.

## 4. Rules enforcement (server-side, before money — the heart of this)

Validate → pay (`STRIPE:` seam) → enact → broadcast. Never charge for an
action the rules would refuse.

**In `controller_slot` mode** the money step is replaced by a holder
check: the item's existing slot machinery (buy-now queue or soft-close
auction on the CONTROLLER) decides who may act; skip/queue endpoints then
authorize `who.id === active.userId` (or privileged) instead of charging —
but every window/cap/timing rule below still applies to the holder
(a slot buys you the controls, not immunity from the room's vibe rules).
Non-holders get watch-only UI. **In `per_action` mode:**

- **Skip request** (`POST /api/items/:code/jukebox/skip {songId}`):
  signed-in (requester() posture) · `songId` must equal `nowPlaying.songId`
  (a stale skip after the song changed = 409, no charge) · elapsed =
  `now - startedAt`: reject if `elapsed < minPlaySec`; if
  `!allowMidSong`, reject unless `elapsed <= onlyBeforeSec` (give the
  clients the exact deny reasons — "too late to skip this one" vs "song is
  protected for another Ns") · per-user window counter under `perUser.max`
  · global window counter under `global.max` · THEN pay, decrement
  windows, command the rig, announce.
- **Queue add** (`POST …/jukebox/queue {songId}`): catalog id exists ·
  queue length < maxLen · user's queued count < maxPerUser · song not
  played/queued within `noRepeatMin` · pay → enqueue → broadcast.
  `playNextPriceCents` (if enabled) inserts at position 1 (never above
  another play-next purchase — same fairness rule as pay-to-jump).
- **Bid mode** (`POST …/jukebox/bid {songId, cents}`): one auction per
  song-currently-playing; **the round closes when the current song ends**
  (the song IS the countdown — display `closesAt = nowPlaying` end
  estimate). Validation mirrors the items auction (integer cents, min
  increment, $500 cap, per-user bid cooldown). Winner's song plays next;
  `STRIPE:` comment = authorize-on-bid / capture-winner / release-losers.
  Buy-now queue and bid mode are mutually exclusive per item (mode flip
  requires idle runtime, like the shipped items mode-flip guard).
- Every deny carries a human reason; every accept broadcasts fresh state.

## 5. Wire contract (extend, never break)

- **Server → rig commands**: new server-only type — add `'jukebox'` to
  bus.js `RESERVED`:
  `{type:'jukebox', action:'play', song:{id,file,title}, item, ts}` ·
  `{action:'skip'}` · `{action:'stop'}` · `{action:'house', on:bool}`.
  Clients can never inject these (forged-type smoke check).
- **Rig → server reports**: the player reports
  `track_started {songId, durationSec}` / `track_ended {songId}` /
  periodic `position {songId, sec}` — accepted ONLY from authenticated rig
  sockets (`ws._rig`, from the outputs mission) or X-Admin-Key HTTP.
  Reports are how `nowPlaying.startedAt/durationSec` become truthful
  (skip-window math depends on them — never trust client clocks).
- **State to phones/marquees**: extend the jukebox item's `item_queues`
  broadcast (additive): `nowPlaying` (+progress basis), `queue` (names +
  titles), `prices`, `skipState` (your remaining skips in window, room
  skips left, skippable-until timestamp or "protected"), `bidRound` (top
  bid, closesAt) — everything a phone needs to render §6 with zero extra
  requests. Keep payloads bounded (queue display cap like paid.js's 12).
- Pause/off reuse the shipped `{type:'item'}` announcements — the player
  must pause/stop accordingly (and `output` failover still applies: no
  player rig online → item unavailable, don't sell queue slots to
  silence).

## 6. UI

**Phone (user page, jukebox surface):** now playing (title/artist +
progress bar) · skip button with LIVE eligibility (countdown "skippable
0:08 more", or "protected", or "2 of your skips left this half-hour") ·
up-next queue with requester names · "Add a song": searchable catalog
list (client-side filter), price chip, confirm · bid panel in bid mode
(top bid + closes-with-the-song countdown) · sign-in prompt on pay
actions, browse free (identical posture to items).

**Marquee (venue TV):** the stage page (or a `?view=marquee` variant)
renders now-playing + queue + prices + the item QR big and readable from
across a room. This is the jukebox's attract mode.

**Ops:** catalog editor (add/edit rows; CSV/JSON paste import; durations
optional — the rig's `track_started` report backfills real durations) ·
all §3 knobs with the shipped edit-form pattern · live view: now playing,
queue with per-row admin remove (vibe veto, `STRIPE:` refund comment) ·
skip counters · "force skip" and "clear queue" (announced).

## 7. Player backends

**`backend:'mpd'` — the Pi plays local files (rights-clean path).** Build
**`tools/volt-jukebox.mjs`** modeled on `bus-to-pi.mjs`/`bus-to-osc.mjs`
(reconnect forever; honors pause/off/output):

- Connects as an authenticated rig to the item room; drives **MPD**
  (`sudo apt install mpd mpc` — the standard Linux music daemon; its
  native playlist/queue model fits this exactly) via `mpc` or the MPD
  socket: `play {file}` → clear/add/play; `skip` → next/stop; polls
  status ~1s → emits `track_started`/`position`/`track_ended` reports.
- Music files live in the Pi's MPD folder; `catalog[].file` must match.
  Log-only mode off-Pi so it's testable anywhere (same discipline as
  bus-to-pi).
- `houseMode`: when told (or when idle+empty), shuffle the local folder;
  a real request always interrupts house mode at the track boundary.
- Volume cap + audio-out notes land in HARDWARE.md/playbook (Pi Zero has
  no analog jack — USB DAC or HDMI).

**`backend:'spotify'` — drive the venue's OWN Spotify (easiest tech,
caveats in §8).** No rig in the audio path at all: a SERVER-side driver in
items/jukebox.js calls the Spotify Web API on the venue's Premium account
— skip (`POST /me/player/next`), add to queue (`POST /me/player/queue`),
play a track (`PUT /me/player/play`), and poll player state
(`GET /me/player`, ~3–5s with backoff and rate-limit respect) as the
TRUTH for `nowPlaying`/progress (skip-window math = server clock anchored
to the API's `progress_ms`; never client clocks). Requirements and rules:

- Venue account OAuth per item (authorize once from the ops page; store
  the refresh token server-side, never expose it — §3). Premium required.
- Playback lands on whatever **Spotify Connect device** the venue already
  uses (their existing sound system/computer). A Pi running `raspotify`
  is the OPTIONAL role here — a cheap dedicated Connect endpoint when the
  venue has none.
- Target device offline / token revoked → item unavailable (same
  never-sell-dead-air rule as output-offline); surface it on the ops card.
- `catalog[].file` holds `spotify:track:…` URIs; the catalog is STILL
  admin-curated — patrons never get open search (vibe + licensing + terms).

**`backend:'log'`** — no-op driver for tests and dry runs.

The queue/rules engine is backend-agnostic: one interface
(`play/skip/stop/observe`), three drivers.

## 8. Licensing + terms reality (flag hard in docs — a business gate, not code)

Researched July 2026; put this guidance in SETUP/MANAGE/playbook. Not
legal advice; William verifies before real money.

- **The classic escape hatch doesn't apply.** The coin-op **Jukebox
  License Office** license (ASCAP/BMI/SESAC clearinghouse) explicitly does
  NOT cover internet jukeboxes — those route to the PROs directly.
- **"Control the venue's Spotify" is easy tech, not a licensing escape.**
  Three separate layers: (1) consumer Spotify is licensed for personal,
  non-commercial use — a venue playing it is already outside Spotify's
  terms (ubiquitous, but the venue's exposure, and worth stating plainly
  in the pitch); (2) public performance in a venue needs PRO coverage
  regardless of source — a venue's blanket background-music license may
  not cover interactive on-demand selection for money (that's the
  historical definition of jukebox use); (3) Spotify's developer terms
  gate commercial use — monetizing playback control can get the API app
  revoked, which is fleet risk. Notably, **Soundtrack** (the
  licensed-for-business streaming service with a public API) explicitly
  forbids exposing playback control to VISITORS — staff only — which
  shows where the licensed industry currently draws this line; services
  like Rockbot exist precisely because patron-request licensing is its
  own negotiated category.
- **The owner's "sell the controller, not the songs" framing
  (`controller_slot`) is the strongest posture available here** — Volt
  sells timed access to an input device; the music performance remains
  the venue's own, on the venue's own account and existing licenses. It
  meaningfully shifts risk toward arrangements the venue already owns —
  but it is an argument, not a safe harbor; disclose it honestly to
  venues rather than promising "licensed."
- **The rights-clean path stays `backend:'mpd'` + own catalog** — the
  platform's shop/label artists with direct permission (synergy: the
  jukebox promotes records the shop sells) or licensed/royalty-free
  music. Recommend pilots start there, or in `controller_slot` mode on
  the venue's account with the caveats disclosed; resolve PRO questions
  before mainstream-catalog money (ROADMAP Tier 6 already gates on this).

## 9. Tests

Extend the items suite (or a `.smoke-jukebox.cjs` sibling, hermetic):
the full **skip-rule matrix** (before/inside/after `onlyBeforeSec` ×
`allowMidSong` on/off × under/over `minPlaySec`) · window counters
(per-user exhausts and rolls over; global cap denies everyone; windows
slide, not reset) · stale-songId skip = 409 + no charge recorded · queue
caps, `maxPerUser`, `noRepeatMin` · play-next insertion fairness · bid
round closes on `track_ended` and winner enqueues first · catalog-only
ids · forged `{type:'jukebox'}` and forged rig reports from plain clients
dropped · pause/off stop the player and refuse pay actions ·
**controller_slot mode**: non-holder skip/queue denied without charge,
holder passes but windows still bind, slot expiry revokes rights
mid-action · backend abstraction: whole rules matrix runs against the
`log` driver; spotify driver unit-tested against a mocked fetch (skip,
queue, state poll → nowPlaying truth, device-offline → unavailable) ·
**back-compat: `surface:'pad'` items behave byte-identically** ·
fail-closed (Supabase env + DB down → 401 on queue/skip/bid). jsdom suite: phone surface renders
both modes, skip button reflects eligibility states, marquee view renders.
Keep every existing suite green; update the suite lists in docs.

## 10. Ship + open questions

Ship like the repo ships (suites → adversarial review — hardest look at
the rules engine's time math and window pruning → commit with
`Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>` → push → verify
live with a real Pi or a log-only rig → sync HANDOFF/SETUP/MANAGE/
ROADMAP/CLAUDE.md/HARDWARE.md/playbook).

Ask William early (defaults): monetization default? (`controller_slot` —
reuses shipped slot machinery and is the cleaner posture; `per_action`
stays fully supported per item) · backend default? (`mpd` for the
rights-clean pilot; `spotify` opt-in per item with the §8 caveats shown
in ops at connect time) · skip pricing in per_action mode? ($1 default;
`priceCents: 0` = free-with-caps is supported) · `playNextPriceCents` on
by default? (yes, 2× queue price) · house mode default? (on) · catalog
v1 = admin-entered list? (yes; rig-reported library import is a fast
follow) · marquee as stage-view variant or own page? (variant).

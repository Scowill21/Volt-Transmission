# Volt Transmission — Ecosystem Roadmap

The end goal: a multi-channel interactive radio platform. Listeners have
accounts, pay to request songs, and can grab the controls; radio hosts and
VJs get approved accounts, create channels, and stream; every channel has
reactive visuals even before a VJ shows up.

This doc orders the work **from doable → extremely difficult**, with the
latency findings up front (they shape the whole architecture). Each phase
ends with **"Prompt it as"** — a ready-made ask for a build session.

---

## The two findings that shape everything

### 1. There are two kinds of visuals, with wildly different physics

| Visual plane | Where it renders | "Press E" reaction time | Scales to N viewers |
| --- | --- | --- | --- |
| **Scene visuals** (the 4 canvas scenes you have now) | In each viewer's browser | **~0 ms on your own screen; 50–150 ms for everyone else** (just a tiny control message over WebSocket) | Free — every browser renders its own copy |
| **Video visuals** (TouchDesigner output, VJ feeds, host cam) | On the TD/VJ machine, streamed as video | **~250–700 ms** round trip (see budget below) | Needs media infrastructure (SFU), costs money per viewer |

The platform should treat browser-rendered scenes as the **default plane**
(instant interactivity, zero streaming cost — your "3 default audio
graphics" idea fits this perfectly) and video streams as the **premium
plane** (TD sets, VJs, host cam).

### 2. Press-E-over-WAN latency: yes, it works — if it's WebRTC end to end

Budget for *keypress → TouchDesigner → encoded video → viewer's eyeball*:

| Leg | Typical |
| --- | --- |
| Viewer key → server (WebSocket) → TD machine | 30–80 ms |
| TD picks it up + renders the reaction | 16–50 ms |
| Encode + send to media server (WHIP/WebRTC) | 30–60 ms |
| Media server → viewer (WebRTC) | 50–150 ms |
| Viewer jitter buffer + decode | 100–400 ms (tunable) |
| **Total** | **~0.25–0.7 s** |

A quarter-to-half second from keypress to seeing the graphics react is
absolutely usable — it reads as "on the next beat," not "broken."
Two hard rules fall out of this:

- **Never HLS/YouTube/Twitch for the interactive channel** — those are
  5–30 s behind. WebRTC (an SFU like LiveKit) end to end, with the jitter
  buffer kept modest (~150–300 ms) on interactive channels.
- Send the **control** the instant the key is pressed and let each plane
  react at its own speed: browser scenes fire instantly for the presser,
  the TD video catches up ~a half-second later.

---

## The difficulty ladder

### Tier 1 — Doable now (client + a small backend)

**1a. Channels + VJ dropdowns (static first). ✓ shipped** — `CHANNELS`
config (channel → VJs → which scene/stream each uses) + CH/VJ dropdowns in
the console. Scene VJs tune the mapped canvas scene; stream VJs flip to
Live Station; "House" = the channel's default scene. Sends
`{type:'channel', channel, vj}` to TD and re-syncs on connect.

**1b. A real backend so admin-created channels appear. ✓ shipped** —
Express + Postgres in `server/` (JSON-file store for local dev), tables
`channels` / `vj_profiles` / `channel_vjs`, deployed as one Render web
service (render.yaml: site + API + database). The console fetches
`/api/channels` and falls back to the static seed when no API exists;
`/admin.html` (X-Admin-Key) creates channels (name, slug, default scene
`ambient|pulse|static|drift`) and attaches scene/stream VJs. `users`
lands with auth in Tier 2a.

> **Prompt it as:** "Add a channel/VJ dropdown pair to the console driven
> by a `/api/channels` endpoint; build a minimal Express + Postgres API on
> Render with an admin page to create channels (name, slug, default scene)
> and attach VJs. New channels get a default scene until a VJ is added."

### Tier 2 — Standard product work (accounts + payments)

**2a. Accounts + roles. ✓ shipped** — Supabase Auth, server-mediated
(httpOnly cookies via `server/auth.js`; the console stays dependency-free
and stamps every TD message with the signed-in id/name/role). Roles
`listener | vj | radio | admin` on a `profiles` table in the same
Supabase Postgres that now also holds channels (Render PG retired).
`/account.html` = sign in/up + apply-to-broadcast; `/admin.html` gained
an Applications queue (approve = the role flips). Ops note: Supabase
"Confirm email" should be OFF until real SMTP exists (SETUP.md).

**2b. Paid song requests.** Stripe Checkout (hosted page — you never touch
cards) + a webhook that inserts into a `song_requests` table with status
`paid → queued → played`. **The 2b pass now also converts the SHOP
(`server/shop.js` — records from `albums/<Name>/` folders with purchase-gated
streaming, procedural art/VJ packs, cabinet library in the console): its
stubPay seam becomes Checkout and the `.shop-data.json` purchases move into
Postgres alongside the queues.** The channel's console (and TD, via the existing
data channel) shows the queue; the host marks them played. Refund path for
skipped requests. This is well-trodden; the work is in the flow, not the tech.

> **Prompt it as:** "Add Supabase auth with listener/vj/radio/admin roles
> and approval flags, then Stripe Checkout song requests: request form on
> the channel page, webhook → `song_requests` queue, queue view for the
> host, mark-played + refund actions."

### Tier 3 — Real streaming (one-to-many, still well-supported)

**3a. Radio audio to the world + default graphics that react.
✓ shipped (URL-stream half).** Channels carry a live `audioUrl`
(admin-set); listeners tuned there hear the broadcast through a
same-origin server relay (`/api/channels/:id/audio` — kills the CORS
problem for any stream host, costs us bandwidth per listener until
LiveKit) and the analyser drives the scenes off the live signal. Station
songs remain the fallback. **Still open in 3a:** the radio account
publishing from their own browser (mic/line-in) — that lands with the
LiveKit work in 3b; today they stream via OBS/butt → any Icecast-style
ingest and paste the URL.

**3b. Video channels via an SFU.** Stand up LiveKit (Cloud to start):
TD → NDI → OBS → **WHIP** → LiveKit room → WebRTC to viewers. The console's
Live Station mode subscribes to the room instead of dialing your LAN.
**Host-cam streaming ("the radio guy streams himself") lands here almost
for free** — a camera is just another WebRTC publish from a browser, far
easier than the VJ mesh below.

> **Prompt it as:** "Integrate LiveKit: token endpoint with role-based
> publish/subscribe permissions, WHIP ingest instructions for OBS/TD,
> viewer playback in Live mode, and browser publishing (mic/cam) for
> approved radio accounts."

### Tier 4 — The interactive layer (moderate-hard, very fun)

**4. Press-E for everyone.** A WebSocket "control bus" per channel:
keypresses → server → fan-out to all viewers (scenes react instantly)
**and** to the TD operator's machine (a tiny bridge script forwards them
into TD's WebRTC DAT / OSC — your existing `{type:'key'}` schema already
fits). **First slice shipped:** `server/bus.js` fans Live-mode actions to
per-channel subscribers over `wss://…/api/bus?channel=<id>`; VJ rigs
consume it via TD's WebSocket DAT or `tools/bus-to-osc.mjs` (OSC), and
`POST /api/channels/:id/actions` injects test events.
**Second slice shipped — the TAKEOVER mechanics (test tier):**
`server/paid.js` runs a per-channel control queue (bid → timed slot →
countdown → auto-promote) with REAL enforcement: the bus binds the
verified session to each socket at the WS handshake and only passes the
slot holder's Live 1–4 actions (vj/radio/admin bypass); the console shows
the queue, locks the caps, and a Paid-queues host view lives in
admin.html. Song requests ride the same panel (queued → played/refund).
Payment is stubbed at marked STRIPE seams — Tier 2b turns stubPay() into
Checkout + webhook and moves the in-memory queues to Postgres.
**Third slice shipped — VOLT CONTROL, pay-to-control ITEMS (test tier):**
`server/items.js` + `control.html`: physical/visual items driven by TD,
each with a 6-char code + printable QR to `/control?item=<CODE>`. Buy-now
queue (auto-promote, estimated starts) or soft-close auction (first bid
arms the clock, final-10s bids add 10s, top bid wins) grants a timed slot;
the holder gets a full-screen d-pad/A-B-C controller whose presses ride
the bus room `item:<CODE>` (`pad_*`/`btn_*` — the OSC bridge forwards them
unchanged) behind the same verified-session gate discipline as the takeover
(bus.js now runs a gate REGISTRY; the two products' territories are
disjoint). Admin (create/edit/QR/skip/pause/off) lives in control.html's
gear view. Same STRIPE stub seams; runtime queues in-memory until 2b —
bids become authorize/capture/release there. Still
open here: pooled FX from other viewers' keys, account-tied rate limits. Two modes worth building: **pooled** (everyone's hits spawn effects,
rate-limited per user) and **takeover** (one paid user holds the controls
for N minutes — this is a *product*, pairs beautifully with Stripe from
Tier 2). The console is already staged for it: keys 1–4 are the **live
actions** in Live mode (today unrestricted; gate on role/purchase here),
and the plan is purchasable **action packs** — different overlay actions a
user can buy and bring to a channel. Requires abuse limiting, per-channel rooms, and reconnect logic —
moderate-hard but no exotic tech.

> **Prompt it as:** "Build a per-channel WebSocket control bus: viewers'
> mapped keys publish `{type:'key'}` events; fan out to all subscribers +
> a TD bridge client; add pooled mode with per-user rate limits and a paid
> takeover token with a countdown."

### Tier 5 — The VJ mesh (hard: this is the gnarly one)

**5. VJs ride an existing station.** The flow: an approved VJ subscribes to
the channel's **audio** track, runs their own rig (TD/Resolume), publishes
a **video-only** track back into the same LiveKit room; admin/host switches
which video track is "program" for viewers. LiveKit's per-track permissions
make the *plumbing* straightforward — the hard 20% is:

- **A/V sync.** Viewers hear the master audio directly; the VJ's video was
  made from audio ~200–400 ms old. Beat-reactive visuals read fine (it's
  within a beat), but frame-locked sync would force re-encoding audio
  through the VJ (quality loss + more latency). Ship "loose sync," offer a
  per-viewer video-delay nudge later.
- **Operations.** VJ onboarding, upload bandwidth requirements, encoder
  settings, and a "program/preview" switcher UI. This is where most of the
  real work lives.

> **Prompt it as:** "Add VJ publishing: approved VJs join the channel room
> subscribed to audio-only, publish video-only, host gets a program/preview
> switcher; document the OBS/TD encoder settings and build the VJ 'go live'
> checklist page."

### Tier 6 — Extremely difficult (platform territory)

- **VJ/station payouts** (Stripe Connect: KYC, tax forms, disputes).
- **Scale + self-hosting media**: SFU clusters, TURN servers, global
  regions, per-GB egress costs; per-channel TD instances need GPUs —
  cloud GPU boxes or "bring your own TD machine" (the right early answer).
- **Moderation/rights**: DMCA for streamed music, abuse reports, takedowns.
  (Music licensing for a public radio platform is a legal project, not a
  code project — worth real advice before charging money around music.)

---

## Recommended stack (boring on purpose)

| Piece | Pick | Why |
| --- | --- | --- |
| Hosting | Render (what you have) | Static site + Node API + Postgres in one place |
| Auth + DB + realtime | Supabase | Auth, Postgres, and WebSocket-ish realtime in one, generous free tier |
| Payments | Stripe Checkout → later Connect | Hosted card pages, webhooks, payouts path |
| Media (video) | LiveKit Cloud | WebRTC SFU with WHIP ingest, per-track permissions, ~100–500 ms |
| Radio audio | Browser/OBS → LiveKit audio track (or Icecast to start) | Client scenes analyse it directly |
| TD bridge | Tiny local script: control bus ⇄ TD (WebSocket/OSC) | Reuses your existing `{type:'key'}` schema |

## Build order (same as the tiers)

1a dropdowns → 1b channels API/admin → 2a auth/roles → 2b paid requests →
3a live audio + default scenes → 3b LiveKit video + host cam →
4 control bus + takeover → 5 VJ mesh → 6 payouts/scale/moderation.

Each tier ships something usable on its own — and nothing in a later tier
forces a redesign of an earlier one, as long as visuals stay split across
the two planes from finding #1.

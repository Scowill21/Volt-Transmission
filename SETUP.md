# Setup & Operator Guide

Everything you need to run the Transmission console (`index.html`): connect
TouchDesigner, add songs to the preset stations, and deploy on Render.

---

## What you have

Two modes, switched with the **Mode** toggle in the console:

| Mode | What the screen shows | What the music is |
| --- | --- | --- |
| **Offline** | The station bank: a built-in audio-reactive visual per station. The channel menu is hidden — channels are a Live thing | Songs you add (see below), played locally in the browser |
| **Live** | The channel world (CH/VJ menu; the station bank hides). A channel on the **canvas plane** (House/scene VJ) shows its scene reacting to the channel's live audio; a **stream VJ** shows the TouchDesigner WebRTC feed — holding the **"awaiting signal / TRANSMISSION"** screen until TD connects, no matter how often it's clicked. **No Skip in Live** — you can't skip a broadcast | The channel's live audio stream, or whatever TD sends |

(The mode messages TD receives keep their original values — `"presets"`
means Offline; the schema is a public contract and did not change.)

The four standard stations and their visuals:

| Station | Visual | Reacts how |
| --- | --- | --- |
| **Ambient** | Lofi bedroom at night | Lamp glow breathes and the string lights sway with **bass** · monitor EQ + city windows ride **mids** · rain + dust ride **treble** · a string-light flashes and the cat's tail flicks on the **snare** (a hard one can send a shooting star past the window) · the cat's ears perk on the **kick** · vinyl spins and the monitor light spills onto the desk with **level** |
| **Pulse** | Tokyo neon skyline | Skyline bloom, light streaks + searchlight beams with **bass** · window grids + searchlight sweep with **mids** · neon flicker + drone strobes with **treble** · a sign flashes white on the **snare** · frame shakes and the wet road ripples on the **kick** · one tower is a giant equalizer, traffic thickens with **level** |
| **Static** | Flowing analog haze | Drifting color blobs, aurora ribbons + the Lissajous figure swell with **bass/kick** · drift + Lissajous ratio steer with **mids** · fine motes shimmer with **treble** · a soft ring ripples through and the chrome text rattles on the **snare** · **kick** tears soft glitch slices across the field · a ghost spectrum breathes behind everything · the oscilloscope line is the actual waveform |
| **Drift** | Open water under a low moon | The swell surges with **bass** · moon-path shimmer with **mids** · crest sparkles + plankton glow with **treble** · **snare** drops a ripple ring out on the water (a hard one can send a shooting star over it), **kick** a quick ring up close — the biggest hits flash heat lightning on the horizon · a buoy rides the swell, its lamp swelling with **level** |

Bass/snare/treble are read live from whatever song is playing (snare and kick
are onset-detected — they fire on the hit, not on sustained level). The three
small meters in the footer (BAS / SNR / TRB) show the live signal.

---

## Drive Mode (phone users)

**Drive Mode** is a stripped-down, audio-only view for listening on a phone —
in the car, in a pocket, anywhere you don't want the visuals. It **only appears
on phones**; desktop never sees it.

- On a phone, a **"Drive Mode?"** bar auto-suggests it. Tap **Start** to enter,
  or **✕** to dismiss (a small **◐ Drive** pill stays in the corner so you can
  enter later — you're never stranded).
- Inside, the screen is just: the **station/channel name**, the **current
  track**, one big **play/pause**, a **volume** slider, and **Exit Drive Mode**.
  The reactive canvas scenes are **switched off** — easier on the eyes and the
  battery. It keeps playing whatever's tuned: your Offline station's playlist,
  or a Live channel's broadcast.
- It changes nothing else — exit and you're back exactly where you were
  (same mode, channel, and audio still playing).

Notes for testing/ops:
- **It's phone-only by design.** Detection is `pointer:coarse` + `hover:none` +
  a ≤500px short side (so phones qualify in either orientation; tablets and
  desktops don't). A desktop browser — even resized narrow — won't show it,
  because a mouse/trackpad reports a *fine* pointer.
- To preview it on a desktop, add **`?drive=1`** to the URL (forces eligibility;
  `?drive=0` forces it off). This is the only persisted lever — there's no
  stored setting (the console keeps its no-localStorage rule), so a dismissal
  just re-suggests on the next load.

---

## Running it locally

Two ways, depending on whether you want the channels API:

```bash
npm start          # site + channels API on http://localhost:8787 (admin at /admin.html)
npx serve .        # static only — the console falls back to its built-in channel list
```

Opening `index.html` directly as a file also works for browser-uploaded songs.
Songs referenced in `PRESET_TRACKS` (below) need the page to be **served**
(localhost or Render), not opened as a `file://` path.

---

## Adding songs (admin side)

Each Offline station is a **playlist** — one or more songs that play through
and wrap. **Skip** jumps to the next song; each track auto-advances at its
end (a single-song playlist just loops). Two ways to fill a station's
playlist — uploads override the deployed defaults.

### 1. Browser upload — instant, per-browser

- Click **↥** on a station card and pick **one or more** audio files (⌘/Ctrl-
  click to multi-select), **or** drag files onto the page (they're added to
  the currently selected station's playlist). Upload again to add more.
- The card shows the queue — e.g. **♪ 2/3 · song.mp3** (now-playing of total).
- Songs are stored in that browser (IndexedDB): they survive reloads and
  restarts, play from disk, and never upload anywhere.
- **✕** clears the station's whole uploaded playlist (reverting to the
  deployed defaults, if any).
- Caveat: uploads live only in that browser on that machine. Your uploads on
  your laptop won't appear for visitors on your Render URL.

### 2. Deployed defaults — permanent, for everyone

1. Create an `audio/` folder next to `index.html` and drop songs in:
   ```
   td-stream-control/
     index.html
     audio/
       ambient-1.mp3
       ambient-2.mp3
       pulse.mp3
       …
   ```
2. Point `PRESET_TRACKS` (top of the `<script>` in `index.html`) at them —
   a single path for one song, or an **array** for a multi-song playlist:
   ```js
   const PRESET_TRACKS = {
     ambient: ['audio/ambient-1.mp3', 'audio/ambient-2.mp3'],  // a playlist
     pulse:   'audio/pulse.mp3',                               // one song
     static:  '',                                              // none
     drift:   '',
   };
   ```
3. Commit + push. Render redeploys and every visitor gets those songs.

MP3, M4A/AAC, OGG, and WAV all work (MP3/M4A are the safe cross-browser
picks). One song per station just loops; multiple cycle in order.

### Operating

- **Play / Pause / Skip** drive the local player in Offline mode
  (Skip = next song in the current station's playlist; switch stations with
  the cards or keys 1–4). In Live: Play/Pause controls the
  channel's live audio on the canvas plane, or sends `{type:'transport'}`
  to TouchDesigner on the video plane — and **Skip disappears** (you can't
  skip a broadcast).
- **Vol** slider sets local volume. Keys: **1–4** tune stations in Offline;
  in Live they're the **live actions** (sent to TD as `scene_1..4`, caps
  relabel to "Live 1–4"; a permissioned/purchasable action-pack version is
  planned). **P** play/pause, **H** hides the console, **D** diagnostics.
- **Action keys drive the graphics in BOTH modes**: Q = accent flash,
  W = punch zoom + shake, E = spark burst, Space = shock ring — in the
  scenes, and over the live video as a transparent FX overlay. The same
  key message reaches TouchDesigner in parallel, stamped with who pressed it.
- **Channel / VJ dropdowns** (Live mode): pick a channel, then who's driving
  it. **House** shows the channel's default scene reacting to its live audio;
  a scene VJ shows their scene; a "· live" VJ switches to the TD/WebRTC video
  plane (per-VJ stream routing arrives with the streaming tiers). The list
  comes from `/api/channels` (admin-created), falling back to the built-in
  seed. Every pick sends a `channel` message to TD (schema below).
- The whole UI auto-fades after ~4 s idle for a clean capture; move the
  mouse to bring it back.

---

## Channels & VJs (admin — ROADMAP Tier 1b)

The console's **CH / VJ dropdowns** load from `GET /api/channels` whenever the
site is served by the API (`npm start` locally, or the Render web service).
Anywhere the API doesn't exist — `file://`, plain static hosting — the fetch
fails silently and the built-in `CHANNELS` seed in `index.html` drives instead.

**Admin page: [`/admin.html`](admin.html).** Enter the admin key (local dev:
`dev` · on Render: the `ADMIN_KEY` env var, auto-generated — read it in the
service's Environment tab), then:

- **Create channels** — name, optional slug, and the default scene
  (`ambient | pulse | static | drift`) that drives until a VJ is attached.
- **Attach VJs** — a name plus what they use: a **scene** (one of the four
  canvas visuals) or a **live stream** (switches Live mode to the video plane;
  per-VJ stream routing arrives with the streaming tiers).
- **Change the default scene** or **delete** channels/VJs inline.

Changes appear in every console's dropdowns on their next page load.

**Live channel audio (ROADMAP Tier 3a):** give a channel a **live audio
stream URL** in `/admin.html` (any Icecast/HTTP audio stream — SomaFM,
Radio Paradise, your own `butt`/OBS→Icecast ingest). Listeners tuned to
that channel **in Live mode** hear the broadcast and its scene reacts to
it — the console plays the stream through the server's **same-origin
relay** (`/api/channels/<id>/audio`), so it works with any stream host,
no CORS setup needed. Notes:

- First play takes **~5–10 s** to buffer through the relay — normal.
- The relay costs the server bandwidth per listener (fine at small scale;
  the LiveKit tier replaces this).
- A Live channel with **no** stream URL shows its scene in silence —
  local songs belong to Offline mode. Clear the field + save to remove
  a channel's live audio.
- Play/Pause controls the stream; there is no Skip on a live broadcast.

**Storage:** Postgres on Render (`DATABASE_URL`, tables auto-created);
locally a JSON file at `server/channels.json` (gitignored — delete it to
re-seed from the defaults).

**API** (writes need the `X-Admin-Key` header):

| Method + path | Body |
| --- | --- |
| `GET /api/channels` | — (public; the dropdowns' data) |
| `POST /api/channels` | `{ name, slug?, defaultScene? }` |
| `PATCH /api/channels/:id` | `{ name?, defaultScene? }` |
| `DELETE /api/channels/:id` | — |
| `POST /api/channels/:id/vjs` | `{ name, plane: "scene"\|"stream", scene? }` |
| `DELETE /api/channels/:id/vjs/:vjId` | — |

---

## Accounts & roles (ROADMAP Tier 2a)

Supabase Auth behind the scenes; the console stays dependency-free because the
server mediates everything through httpOnly cookies. Configure three env vars
(local `.env`, or Render's Environment tab — see `render.yaml`):
`SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`, `DATABASE_URL` (the **session
pooler** string — the direct `db.<ref>` host is IPv6-only and won't resolve
from most networks, including Render). Missing any → accounts quietly disable
and everything else runs as before.

- **Sign in / sign up: [`/account.html`](account.html).** Listeners sign up
  freely (role `listener`). The signed-in name + role ride every control
  message to TouchDesigner, and the console footer shows an account chip.
- **Roles:** `listener | vj | radio | admin`. Signed-in users apply for
  `vj`/`radio` on the account page (with an optional note); an admin approves
  or declines in [`/admin.html`](admin.html) → **Applications** (same
  `X-Admin-Key`). Approval flips their role on the spot.
- **URL-param identity still works** (`?name=Ada&role=listener&uid=cus_123`)
  as the quick attributed-link / TD-testing path — a signed-in session simply
  overrides it.
- **One Supabase setting to flip:** *Authentication → Sign In / Providers →
  Email → **Confirm email***. ON (the default) means new accounts must click
  the confirmation email before signing in — with no custom SMTP configured,
  Supabase's built-in mailer is fine for testing but rate-limited (~a few
  per hour). **Turn it OFF for now** for instant signups; re-enable it with
  real SMTP when the platform grows up.
- Profiles live in a `profiles` table (auto-created) in the same Postgres as
  channels — since 2a that Postgres **is Supabase**, so one database serves
  channels, profiles, and (Tier 2b+) song requests.

### The admin chain — orgs & delegated roles (needs the database)

Businesses can run their own Volt Control items — price, slot length, open
hours, pause/off, controller layout, jukebox rules + catalog — without calling
you, inside safety/money **bounds you set** that they can never cross. A
delegation ladder, enforced on the server on every request (the UI hiding a
button is a courtesy; the gate is the law):

- **Platform (you)** — the `X-Admin-Key`: create orgs, assign items, set bands
  + floors, grant tech/owner, see every org and its audit trail.
- **Org owner** — edits whitelisted fields WITHIN the band (price, slot, hours,
  controller, jukebox rules, cooldown/maxPerMin *tighten-only*), pauses/skips,
  invites their own staff, reads their audit. Can flip their own monetization
  model. **Never** touches rig keys or another org.
- **Org staff** — pause / skip / force-skip only.
- **Org tech** — the venue's AV person (you grant it): rig keys + output chains.
  A DISTINCT capability the owner can never touch.

Org roles are a **separate axis** from the `listener/vj/radio/admin` platform
roles above — a vj is not thereby an org owner. Membership is matched to the
**verified email**; a role claimed in a request payload is ignored. Bounds
**reject** an out-of-band edit (400 with the band in the message) — they never
silently clamp. Every config change writes an **append-only audit** row. The
operator runbook (install day → offboarding → key rotation) is in `MANAGE.md`.

**Where venue people log in:** the same ops page you use — `/control-ops` —
via the **"Use my account"** card (their Tier-2a account; the email must match
their granted membership). They see ONLY their venue, with the knobs their
rung allows; the platform band is printed right on the owner's edit form, so
a rejected edit is never a surprise.

> **The TD / bus wire schema did NOT change for the admin chain.** No new
> message types, no new fields on `key`/`item`/`item_queues`/`jukebox`. A
> staff/owner "pause" or "skip" arrives over new session-gated `/api/org/:id/…`
> endpoints that call the SAME internals and emit the SAME server-only
> `{type:'item'}` announcements the admin key always did. Your TouchDesigner
> patch needs no changes.

---

## Connecting TouchDesigner

The WebRTC handshake in `index.html` is fully implemented (same signaling
protocol as the official TouchDesigner WebRTC Remote Panel demo). You need
three things on the TD side and one URL on the page side.

### TouchDesigner side (Palette → WebRTC)

1. **`signalingServer` COMP** — turn **Secure** on, set the cert/key (mkcert
   steps in [README → TLS / certificates](README.md#tls--certificates-the-one-required-setup)),
   note its **port**.
2. **`signalingClient` COMP** — point it at that server, enable **Forward to
   subscribers**.
3. **`WebRTCRemotePanel` COMP** — set its `signalingClient` parameter and
   give it the panel/TOP to stream. Send audio too if you want music in the
   feed (keep the project at 48 kHz).

### Page side

In `index.html`, one line:

```js
signalingUrl: 'wss://192.168.1.50:443',   // your TD machine's IP + signalingServer port
```

Leave the `[SIGNALING_SERVER_URL]` placeholder in place to run standalone
(presets work, nothing tries to connect).

### What happens then

- The page connects to the signaling server, auto-calls the first TD peer it
  sees (`peerAddressFilter` in `CONNECTION` narrows this if you run several),
  and the status dot goes **Live** — the whole accent flips amber → violet.
- If the link drops it reconnects with backoff and restarts ICE; the
  placeholder shows exactly what it's waiting on.
- Every control reaches TD as JSON on the `ControlData` data channel,
  and **every message is stamped with the user who sent it** plus a
  millisecond timestamp:

  ```jsonc
  { "type": "key",       "action": "<action>", "user": {…}, "ts": … }   // keycaps ("blackout" adds "state")
  { "type": "station",   "station": "<id>",    "user": {…}, "ts": … }   // station picks
  { "type": "transport", "action": "play"|"pause"|"skip", "user": {…}, "ts": … }
  { "type": "mode",      "mode": "presets"|"live",         "user": {…}, "ts": … }
  { "type": "channel",   "channel": "<id>", "vj": "<vj-id>"|"house", "user": {…}, "ts": … }   // channel/VJ dropdowns
  ```

  Parse these on the WebRTC DAT callback — routing sketch in
  [README → Receiving it in TouchDesigner](README.md#receiving-it-in-touchdesigner).
  When the channel opens, the current mode + station + channel/VJ are re-sent
  so TD syncs.

  The **same messages** also ride the site's action bus in Live mode, so a
  remote VJ rig can receive them with zero WebRTC setup — see
  [Receiving viewer actions in your VJ software](#receiving-viewer-actions-in-your-vj-software-the-action-bus).

### Knowing who pressed the key (paid users)

Identity comes from the signed-in **account** when there is one (Tier 2a —
`/account.html`; the session's real id/name/role stamp every message). With
no session, identity rides on the URL. Hand an approved user a link like:

```
https://your-site.onrender.com/?name=Ada&role=listener&uid=cus_123
```

and when they hit **E**, TouchDesigner receives:

```json
{ "type": "key", "action": "action_3", "ts": 1767975421042,
  "user": { "id": "cus_123", "name": "Ada", "role": "listener", "sid": "9f2c11ab" } }
```

`sid` is fresh per page load (tells two tabs apart); no URL params means
`role: "operator"`. In your WebRTC DAT callback:

```python
msg = json.loads(contents)
who = msg.get('user', {})
if msg.get('type') == 'key' and who.get('role') == 'listener':
    # who.get('id') is the paying account — route/limit/score by it
    fire(msg['action'], who.get('name'))
```

Since Tier 2a these fields come from the real session whenever the user is
signed in (accounts section above) — the URL params remain as the override-free
fallback, and the TD-side schema is unchanged either way.

### Audio breakup?

Press **D** for diagnostics. High loss/jitter/concealment → network: raise
`AUDIO.jitterBufferMs` (400–800 for a solid music feed). Clean numbers but
still glitchy → fix it in TD (bigger Audio Out buffer, 48 kHz, cook time
under the audio buffer duration).

---

## Receiving viewer actions in your VJ software (the action bus)

Every control a viewer fires **in Live mode** — the Live 1–4 actions, the
Q/W/E/Space overlay actions, Blackout, transport — is published to the
site's **action bus** and fanned out, over the plain internet, to anything
subscribed to that channel. No LAN, no WebRTC setup, no port-forwarding on
the VJ's side. One URL:

```
wss://<your-site>.onrender.com/api/bus?channel=<channel-id>&as=vj
```

(`channel-id` = the channel's slug from `/admin.html`, e.g. `volt-fm`.
Locally it's `ws://localhost:8787/api/bus?...`.)

Messages are the **same stamped JSON** documented above — always `type` +
`user` + `ts`, e.g. a viewer pressing **Live 3**:

```json
{ "type": "key", "action": "scene_3", "ts": 1783784758775,
  "user": { "id": "…", "name": "Ada", "role": "listener", "sid": "…" } }
```

### TouchDesigner (native — no bridge needed)

1. **OP Create → DAT → WebSocket.** On its parameters set
   **Network Address** to the bus URL above and turn **Active** on.
2. Open the DAT's **callbacks** (the attached `webrtc1_callbacks`-style DAT)
   and route on `type` / `action`:

   ```python
   import json

   def onReceiveText(dat, rowIndex, message):
       msg = json.loads(message)
       if msg.get('type') != 'key':
           return
       who = msg.get('user', {}).get('name', 'anon')
       action = msg['action']                 # scene_1..4, action_1..3, trigger, blackout
       if   action == 'scene_1': op('trigger1').par.pulse.pulse()
       elif action == 'trigger': op('shock').par.pulse.pulse()
       # …map the rest to whatever they should fire; `who` is the presser
       return
   ```

3. That's it — press a key in the console's Live mode and watch it fire.
   (If your rig is *also* wired as the WebRTC video peer, note the same key
   arrives on **both** the WebRTC DAT and the bus — pick one source, or
   dedupe on the message `ts`.)

### Resolume / VDMX / MadMapper / anything OSC

Run the bundled bridge on the VJ's machine (needs Node 18+, `npm ci` once
in the repo folder):

```bash
node tools/bus-to-osc.mjs \
  --url "wss://<your-site>.onrender.com/api/bus?channel=volt-fm&as=vj" \
  --osc 127.0.0.1:7000
```

It forwards every action as an OSC message (string arg = presser's name):

| OSC address | Fires when |
| --- | --- |
| `/volt/key/scene_1` … `scene_4` | a viewer hits **Live 1–4** |
| `/volt/key/action_1` … `action_3` | **Q / W / E** overlay actions |
| `/volt/key/trigger` | **Space** |
| `/volt/key/blackout` | **B** (second arg: `on` / `off`) |
| `/volt/transport/play` / `pause` | transport intents |

Then map those addresses in your software's OSC input (Resolume:
*Preferences → OSC → OSC Input Port 7000*, then shortcut-map any clip or
effect to the address). The bridge reconnects forever; leave it running.

### Testing a rig without the console

Inject an action by HTTP and watch it fire:

```bash
curl -X POST https://<your-site>.onrender.com/api/channels/volt-fm/actions \
  -H 'Content-Type: application/json' \
  -d '{"type":"key","action":"scene_3","user":{"name":"test"}}'
```

Subscribing is open for now (actions aren't secrets); publish is
rate-limited per connection. Role-gated buses land with the Tier 4
takeover work.

---

## Paid features — test tier (control bids + song requests)

The **mechanics** of the paid products are live and testable; only the money
is stubbed (each "bid" succeeds instantly — Stripe Checkout drops into the
marked seams in `server/paid.js` when Tier 2b lands).

**Control queue (the takeover product).** In Live mode the console shows a
**Queue** panel. A signed-in user bids for the visual controls ($5 / 2 min
display prices in `PAID`, `server/paid.js`); first bid takes the slot, later
bids queue up. While a slot is active:

- Everyone sees **who holds the controls and the countdown**; the holder's
  button becomes *Release controls*, queued users see their position.
- **Only the holder's Live 1–4 actions reach VJ rigs.** This is enforced on
  the server: the bus binds the *verified session* to each socket at the
  WebSocket handshake and drops non-holders' live actions (they get a
  `denied` notice; the console also locks the caps visually). Signed-in
  **vj / radio / admin** roles always bypass. The overlay actions
  (Q/W/E/Space) and everything else stay open.
- **The output-routing controls — which scene/station is up, the channel/VJ,
  mode, and transport (play/pause) — are gated the same way.** These steer what
  the live TD/VJ output shows, so only a signed-in **vj/radio/admin** operator
  or the current slot holder may originate them (a security fix — an anonymous
  spectator could previously change the live scene without paying). **To run a
  show from the console, sign in as vj/radio/admin.** A logged-out viewer can
  still watch and buy a slot; their local view changes, but it won't reroute the
  shared output.
- When the slot expires the next bidder is promoted automatically. The host
  can end a slot early: `/admin.html` → Paid queues → **End control slot**.

**Song requests.** The same panel takes paid song requests ($3 stub).
Everyone sees the queue (top few); the host works it in `/admin.html` →
Paid queues → **Played** / **Refund**.

**Testing it:**

- **Production** (auth configured): sign in two browsers via
  `/account.html`, bid in one, watch the other lock. Anonymous visitors
  can't bid ("sign in to bid…") and never bypass the lock.
- **Local dev** (JSON store, auth degraded): the documented URL-param
  escape hatch applies — requests may carry `{"user":{"id":…,"name":…}}`,
  so you can simulate rival bidders with curl:
  ```bash
  curl -X POST localhost:8787/api/channels/volt-fm/control/request \
    -H 'Content-Type: application/json' \
    -d '{"minutes":0.1,"user":{"id":"u-ada","name":"Ada"}}'
  ```
  That path switches off automatically wherever real auth is configured.
- Queues are **in-memory** at this tier (they reset on server restart);
  the Tier 2b Stripe pass moves them into Postgres.

---

## Volt Control — pay-to-control items (test tier)

The second paid product: **physical/visual "items" driven by TouchDesigner
that the public pays to control from their phone.** A lamp rig, a laser
head, a projected creature — anything TD can move.

**The flow.** Each item gets a **6-character code** and a **QR** that opens
`https://<site>/control?item=<CODE>`. Anyone can watch (holder, countdown,
queue/auction — no account); paying needs a signed-in account. Buy-now
items sell timed slots into a queue (with estimated start times); auction
items run **soft-close rounds** — the first bid arms the countdown
(default 60 s), a bid in the final 10 s adds 10 s, the top bid at zero
takes the slot, and the next round arms on the first bid after that slot
ends. The winner's phone becomes a **controller** — one of **four layouts you
pick per item** (in the item's create/edit form on `/control-ops`), all throttled
under the bus rate budget:

| Controller | The phone shows | Emits | Good for |
| --- | --- | --- | --- |
| **d-pad** (default) | ▲▼◀▶ + A/B/C, hold-to-repeat, keyboard fallback | `pad_up/down/left/right`, `btn_a/b/c` | pan/tilt, stepping, toggles |
| **joystick** | a draggable XY thumb + a FIRE button | `pad_xy {x,y}` (0..1), `btn_a` | aiming a servo / moving head, crossfades |
| **faders** | 4 vertical sliders | `fader {i,v}` (i 0–3, v 0..1) | dimmer, speed, colour, volume |
| **grid** | a 3×3 launchpad | `cell_0` … `cell_8` | cue / sample / scene triggering |

The joystick and faders stream continuous values (coalesced ~6/s); the d-pad and
grid fire discrete presses. Every layout rides the SAME holder-gated `key` path,
so the server still only lets the current slot holder drive.

### Wiring an item to TouchDesigner

Every item is a normal action-bus room named `item:<CODE>`. WebSocket DAT:

```
wss://<your-site>.onrender.com/api/bus?channel=item:7KP3QX&as=vj
```

**Controller input** is the same stamped `key` schema as the console:

```json
{ "type": "key", "action": "pad_up", "ts": 1784079724347,
  "user": { "id": "…", "name": "Ada", "role": "listener", "sid": "…" } }
```

with actions from the item's controller: d-pad `pad_up · pad_down · pad_left ·
pad_right · btn_a · btn_b · btn_c`; joystick `pad_xy` (extra fields `x`,`y` 0..1)
`btn_a`; faders `fader` (extra fields `i` 0–3, `v` 0..1); grid `cell_0` … `cell_8`.
**The server only lets the current slot holder's presses through** (verified
session bound at the WS handshake; vj/radio/admin bypass; paused/off items pass
nothing) — your TD patch can trust every `key` it receives in an item room.

**Item state** arrives as server-originated (unforgeable) messages:

```json
{ "type": "item", "action": "slot_start", "item": "7KP3QX",
  "user": { "id": "…", "name": "Ada" }, "ts": … }
```

with actions `slot_start · slot_end · skip · pause · resume · on · off ·
auction_won` — park the rig on `slot_end`/`pause`/`off`, celebrate on
`auction_won`. (`item_queues` messages also ride the room — the full public
state the phones render; ignore or mine them as you like.)

### OSC (Resolume, VDMX, chataigne…)

`tools/bus-to-osc.mjs` forwards item rooms with zero config — point it at
the item's bus URL. Additions to the address table:

| OSC address | Fires when |
| --- | --- |
| `/volt/key/pad_up` … `pad_right` | d-pad presses (arg = name) |
| `/volt/key/btn_a` … `btn_c` | A / B / C buttons |
| `/volt/key/cell_0` … `cell_8` | grid pads |
| `/volt/xy` `f x` `f y` `s name` | joystick position (0..1 floats) |
| `/volt/fader/0` … `/volt/fader/3` `f v` `s name` | fader levels (0..1 float) |
| `/volt/item/slot_start` … | item state changes (arg 1 = name, arg 2 = code) |

**On the Control admin (`/control-ops`)** you don't have to run a terminal to
see any of this: each item's card has a **"Connect a rig / VJ software"** panel
(the exact OSC addresses for that controller + ready-to-copy `bus-to-osc` /
`bus-to-pi` / TouchDesigner commands with the code pre-filled) and a **"Live
output"** monitor that shows every press/drag in real time with the address it
maps to — so you can confirm the wiring before doors open. Volt Control is its
own product with its own admin; the audio-reactive console has a separate one
(`/admin.html`).

### Running it (operator)

1. **`/control-ops`** → your admin key → **Create item** (name, mode,
   price, slot seconds, and a **controls guide** — a short player-facing
   note on what the d-pad and A/B/C actually do to your rig; it shows on
   the item page and behind the controller's **ⓘ** button). The code + QR
   appear — **Print** makes a poster-ready sheet (big QR, name, code as
   text fallback). *(Admin is its own page now; the public `/control` is
   the walk-up product visitors scan into — no admin controls there.)*
2. Wire TD to `item:<CODE>` (above) and test without a phone:
   ```bash
   curl -X POST https://<site>/api/channels/item:<CODE>/actions \
     -H 'Content-Type: application/json' -H 'X-Admin-Key: <key>' \
     -d '{"type":"key","action":"pad_up","user":{"name":"test"}}'
   ```
   (The gate applies to injection too — X-Admin-Key acts as the privileged
   sender; without it a non-holder inject is denied, which is the product
   working.)
3. Event day: `/control-ops` does **Skip / Pause / Off / Edit** per item,
   one-handed on a phone. Pause freezes the holder's remaining time; Off
   stops sales and kills the controller (pause first if someone's mid-slot).
4. Local dev testing uses the same escape hatch as the paid queues: run
   auth-unconfigured and open `/control?item=<CODE>&uid=u-ada&name=Ada`,
   or curl `/api/items/<CODE>/buy` with `{"user":{…}}`.

Queues and auction rounds are **in-memory** at this tier (restart clears
them; item definitions persist in the store). Money is stubbed at `STRIPE:`
seams in `server/items.js` — Tier 2b converts buys to Checkout and bids to
authorize-on-bid / capture-winner / release-losers.

### Output chains + failover (never sell dead air)

An item can carry an **ordered output chain** — the server drives whichever is
online, in priority order, and fails over automatically. Manage it on
**`/control-ops`** → each item's **Outputs** section.

- **Rig outputs** (`kind: rig`) — TouchDesigner, a Raspberry Pi
  (`tools/bus-to-pi.mjs` + **HARDWARE.md**), or a `stage.html` projector.
  A rig connects with identity: `wss://…/api/bus?channel=item:<CODE>&rig=<name>&rigKey=<key>`.
  **Adding a rig output shows its key ONCE** (only the hash is stored); a bad
  key is refused at the socket (close code `4401`). Rigs **self-mute** when
  they aren't the elected program.
- **Scene outputs** (`kind: scene`, one of `orb`/`grid`) — browser-rendered by
  **`stage.html?item=<CODE>`**. A scene counts as **always online**, so putting
  one at the bottom of the chain means the item never stops selling. Open
  `stage.html?item=<CODE>&rig=<name>&rigKey=<key>` on a projector to make it a
  real rig in the election; without a key it's a passive spectator mirror with
  an attract screen + "scan to control" QR.
- **Election + grace:** program = the lowest-priority ONLINE output. If the
  program rig drops, a **5 s grace** passes before failover (no flapping); a
  higher-priority rig reconnecting preempts immediately. With a chain
  configured and **nothing** online, buy/bid return **503** ("not selling")
  and any **running slot auto-pauses** (the holder's clock freezes) until an
  output returns. Back-compat: an item with **no chain** behaves exactly as
  before — always sellable, no presence tracking.
- **Duty-cycle limits** (`limits.maxPerMin` / `cooldownMs`, per item) throttle
  how fast an item can be driven, enforced server-side before fan-out.
  Verified vj/radio/admin senders **bypass** them (owner's call).
- The OSC bridge (`tools/bus-to-osc.mjs`) forwards `/volt/output/<program>`;
  `stage.html` and `bus-to-pi.mjs` honor the self-mute automatically.

---

## Volt Jukebox — audio as a control surface (test tier)

A Volt Control item can drive **music** instead of a physical object. In the ops
page (`/control-ops`), a new item's **surface** dropdown has **jukebox · music**.
A jukebox turns the item's room into a walk-up music controller: patrons scan the
QR, pick from a catalog you curate, and pay to queue / skip / bump the line — or
bid for what plays next.

**The server is the boss.** It owns the queue, the skip rules, the bid round, and
what plays next. A **player rig** (a Raspberry Pi running
`tools/volt-jukebox.mjs`, or a laptop in `log` mode) is a dumb output that just
plays what it's told and reports back what's actually happening — so the skip
windows and "now playing" track *real* playback, never a guessed clock. Set the
player up exactly like any other rig: add it to the item's **Outputs chain** and
copy its key (see `HARDWARE.md` §9). No rig in the chain → the jukebox reads
"player offline" and politely refuses requests.

### Two ways to charge (the `money` dropdown)

- **control slot** (default) — the item sells a **timed control slot** with the
  exact buy-now / auction machinery you already know. Whoever holds the slot
  drives the music for free *while their time runs* — but every skip window and
  cap below still binds them (a slot buys the controls, not immunity). Cleanest
  posture; reuses everything.
- **per action** — no slots; each **queue-add**, **skip**, and **bid** is priced
  individually. Set the prices in the item's edit form.

### The catalog + the knobs (item → Edit)

Open a jukebox item's **Edit** form for the full panel:

- **Catalog** — add a row per song: title, artist, **file** (the player's URI —
  for MPD, the path relative to its music library, e.g. `bowie/rebel.mp3`), and
  length. This is the *only* thing patrons can pick from. (v1 is admin-entered;
  keep it curated.)
- **Prices** — queue, **play-next** (skip the line, defaults to 2× queue), skip.
- **Skip rules** — a song is always protected for **min play floor** seconds;
  after that it's skippable only within **skip only before** seconds (unless you
  tick **allow mid-song skips**); and skips are rate-limited **per user** and
  **per room** on sliding windows (e.g. 2 per user / 30 min, 6 per room / 60 min)
  so one person can't skip-spam the night.
- **Queue rules** — max length, max per user, and a no-repeat window so the same
  song can't be re-queued for N minutes.
- **House mode** — when nothing's queued, the player fills the silence from its
  library; a paid request interrupts it. Toggle it live from the card too.

### The live panel (item card)

The jukebox card shows **now playing** + the running **queue**, with a ✕ to veto
any row, plus **Skip track**, **Clear queue**, and a **House** toggle — all live,
key-gated. The **stage** view has a venue now-playing board at
`/stage?item=CODE&view=marquee` (big now-playing + up-next + a scan-to-queue QR).

### ⚠️ Music licensing — read before you charge the public (`PROMPT-JUKEBOX.md` §8)

Playing recorded music **in a venue** is a **public performance**, and charging
patrons to pick or skip songs does **not** transfer any music rights to you.
This build ships the **rights-clean pilot path** on purpose:

- The **MPD backend plays local files you already have the right to play**, from
  a catalog **you** enter — so *you* control what's in the pool.
- **Spotify (and any streaming service) is deliberately NOT wired in.** Their
  terms forbid this kind of paid, third-party jukebox control, and their API
  access can be revoked. The code is backend-blind so it *could* be added later,
  but only behind a proper licensing agreement — don't.
- **What you still owe:** a public-performance license for the venue (in the US,
  ASCAP + BMI + SESAC; a background-music provider like Soundtrack Your Brand
  bundles this). The **"sell the controller experience," not the music** framing
  (the `control slot` posture) is the safest pilot: patrons pay for the fun of
  driving the vibe on *your* licensed, curated library.

When in doubt, run it as a **private/BYO-music** setup first (your own files, your
own event) and get the venue's performance license sorted before taking money
from the public.

---

## The shop + cabinet (records & art — test tier)

Footer → **Shop** (or the bag icon). Two kinds of products, payment stubbed
at `STRIPE:` seams in `server/shop.js` until Tier 2b:

- **Records (albums).** Drop an album folder into **`albums/<Artist - Title>/`**
  (repo root — *not* under `audio/`) and it appears in the shop automatically.
  Its files are **purchase-gated**: they never serve statically (the `/albums`
  path is blocked) and stream only through `GET /api/shop/records/:id/:n`,
  which checks ownership. A demo record built from the deployed Pulse tracks
  ships so the shelf isn't empty (labeled *demo listing* — those files are
  also publicly playable on the Pulse station).
- **Art · VJ packs.** Procedural print sets — the catalog carries each pack's
  seed + palette and the console draws the prints on canvases in the cabinet.
  No image assets to ship; a pack is rows in `ART_PACKS` (`server/shop.js`).

Footer → **Cabinet**: your purchases. Click a record to put it on — it plays
through the console's audio chain, so **the scenes react to it** (Skip/Play/
Pause work; tuning a station takes it off). Scroll the art strip to browse
your prints.

> **Demo look (current state):** the cabinet ships with `CABINET_DEMO = true`
> in `index.html` — a furnished, NON-functional preview (fixed records +
> prints; clicking a record just explains it's a demo). To switch to the real
> purchases-driven cabinet, flip that one flag to `false` (search
> "CABINET DEMO LOOK").

**Identity & testing:** buying needs a signed-in account in production; in
local unconfigured-auth dev the same escape hatch as the paid queues applies
(`{"user":{id,name}}` body on POSTs, `?uid=&name=` on GETs). Purchases persist
in `server/.shop-data.json` (gitignored; on Render this file is wiped by each
deploy — fine for the stub tier, Tier 2b moves purchases into Postgres).

---

## Sending your feed to the site (going live)

Two kinds of feed, matching the two Live planes:

### Audio feed — a radio broadcast (works today, easiest)

1. **Get a stream URL.** Broadcast from any encoder — **butt**, **Mixxx**,
   OBS, or your DAW — to an Icecast-style host (a rented Icecast server,
   Radio.co, Caster.fm, Azuracast…). They give you a public URL like
   `https://yourhost.example/live.mp3`.
2. **Paste it into the channel** at `/admin.html` → your channel's
   *live audio stream URL* → **Save audio**.
3. Done. Every listener who tunes your channel in **Live** hears the
   broadcast (through the site's relay — any stream host works, no CORS
   worries) and the channel's scene reacts to your audio in their browser.
   Expect ~5–10 s of buffering on first play.

### Video feed — your TouchDesigner rig (today's path)

Today the video plane dials **one TD rig per deployment** over WebRTC
(per-VJ video routing arrives with the LiveKit tier). To put your rig on
the "· live" VJ slot:

1. **TD side** (Palette → WebRTC): `signalingServer` COMP with **Secure**
   on + a certificate (mkcert steps in [README](README.md)); a
   `signalingClient` pointed at it with **Forward to subscribers** on; a
   `WebRTCRemotePanel` with the panel/TOP (and 48 kHz audio) to stream.
2. **Reach it from the internet:** forward the signalingServer's port on
   your router, and use a cert the viewer's browser trusts (a real domain
   + CA cert is the smooth path; mkcert works for machines that install
   your root).
3. **Page side:** set `CONNECTION.signalingUrl` in `index.html` to
   `wss://<your-public-ip-or-domain>:<port>` (plus `peerAddressFilter` if
   several TD rigs share the signaling server), commit, push.
4. **Remote viewers** behind strict NATs may also need a TURN server in
   `CONNECTION.iceServers` — without it, some viewers' video won't
   connect (they still get everything else).
5. Viewers picking your "· live" VJ now see your feed — and your rig hears
   their actions through the **action bus above**, even with no direct
   WebRTC data channel.

---

## Deploying on Render

The blueprint deploys **one Node web service** (it serves the static site
*and* the API). Since Tier 2a the database is **Supabase** (auth + Postgres
together — no expiring Render Postgres).

1. Push this repo to GitHub/GitLab.
2. Render → **New → Blueprint** → pick the repo. Already linked? It syncs on
   push — approve the removal of the old `volt-transmission-db` if prompted
   (channels live in Supabase now and re-seed there automatically).
3. In the service's **Environment** tab set `DATABASE_URL` (Supabase
   **session-pooler** string), `SUPABASE_URL`, and `SUPABASE_PUBLISHABLE_KEY`
   — same values as your local `.env`. Copy the auto-generated **`ADMIN_KEY`**
   while you're there — that's your key for `/admin.html`. ⚠️ **`ADMIN_KEY` must
   be a real value in production:** with Supabase configured, the server now
   *refuses* the insecure `dev`/unset default and disables admin (503) until a
   real key is set — the blueprint's auto-generated key satisfies this. (Optional
   `ALLOWED_ORIGINS`, comma-separated, only if you serve the console from a
   different origin than the API — cross-origin WebSockets are otherwise refused.)
4. If the old *static site* service from pre-1b still exists, delete it in
   the dashboard so only the web service serves the site.
5. Every push redeploys. Songs in `audio/` + `PRESET_TRACKS` ship with it.

Static-only hosting still works fine — without the API the console simply
falls back to the built-in channel list and runs accountless.

Two things to know about **Live mode on a hosted page**:

- Render serves over HTTPS, so the signaling URL must be `wss://` (it is),
  and the browser you operate from must **trust the TD cert** — on your own
  machine `mkcert -install` covers it; on another device visit
  `https://<td-ip>:<port>` once and accept the warning.
- The operator's browser must be able to **reach** the signaling server.
  Same LAN as TouchDesigner: works as-is. From outside your network you'd
  need port-forwarding plus a TURN server in `CONNECTION.iceServers` —
  visitors without that still get the full Offline experience.

---

## Verifying / dev notes

- Open the page: Offline mode, Ambient's bedroom scene idling. Add a song
  (or several — each station is a playlist),
  press Play — the VU meters and the room should move with it.
- Click **Live** and pick a "· live" VJ: music cuts, "awaiting signal / TRANSMISSION"
  holds until TD connects.
- `.smoke-test.cjs` is a headless test of the whole console
  (`npm i jsdom && node .smoke-test.cjs`) — handy after editing.

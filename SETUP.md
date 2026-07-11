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
| **Ambient** | Lofi bedroom at night | Lamp glow breathes with **bass** · monitor EQ + city windows ride **mids** · rain + dust ride **treble** · a string-light flashes and the cat's tail flicks on the **snare** |
| **Pulse** | Tokyo neon skyline | Skyline bloom + light streaks with **bass** · window grids with **mids** · neon flicker with **treble** · a sign flashes white on the **snare** · frame shakes on the **kick** |
| **Static** | Flowing analog haze | Drifting color blobs + aurora ribbons swell and speed up with **bass/kick** · drift steers with **mids** · fine motes shimmer with **treble** · a soft ring ripples through on the **snare** · the oscilloscope line is the actual waveform |
| **Drift** | Open water under a low moon | The swell surges with **bass** · moon-path shimmer with **mids** · crest sparkles with **treble** · **snare** drops a ripple ring out on the water, **kick** a quick one up close |

Bass/snare/treble are read live from whatever song is playing (snare and kick
are onset-detected — they fire on the hit, not on sustained level). The three
small meters in the footer (BAS / SNR / TRB) show the live signal.

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

Two ways — uploads override defaults.

### 1. Browser upload — instant, per-browser

- Click **↥** on a station card and pick an audio file, **or** drag a file
  onto the page (it's assigned to the currently selected station).
- The song is stored in that browser (IndexedDB): it survives reloads and
  restarts, plays from disk, and never uploads anywhere.
- **✕** removes it (and reverts to the deployed default, if one exists).
- Caveat: it lives only in that browser on that machine. Your uploads on
  your laptop won't appear for visitors on your Render URL.

### 2. Deployed defaults — permanent, for everyone

1. Create an `audio/` folder next to `index.html` and drop songs in:
   ```
   td-stream-control/
     index.html
     audio/
       ambient.mp3
       pulse.mp3
       static.mp3
       drift.mp3
   ```
2. Point `PRESET_TRACKS` (top of the `<script>` in `index.html`) at them:
   ```js
   const PRESET_TRACKS = {
     ambient: 'audio/ambient.mp3',
     pulse:   'audio/pulse.mp3',
     static:  'audio/static.mp3',
     drift:   'audio/drift.mp3',
   };
   ```
3. Commit + push. Render redeploys and every visitor gets those songs.

MP3, M4A/AAC, OGG, and WAV all work (MP3/M4A are the safe cross-browser
picks). One song per station; the player loops it.

### Operating

- **Play / Pause / Skip** drive the local player in Offline mode
  (Skip advances to the next station). In Live: Play/Pause controls the
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
   while you're there — that's your key for `/admin.html`.
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

- Open the page: Offline mode, Ambient's bedroom scene idling. Add a song,
  press Play — the VU meters and the room should move with it.
- Click **Live** and pick a "· live" VJ: music cuts, "awaiting signal / TRANSMISSION"
  holds until TD connects.
- `.smoke-test.cjs` is a headless test of the whole console
  (`npm i jsdom && node .smoke-test.cjs`) — handy after editing.

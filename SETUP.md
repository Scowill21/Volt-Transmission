# Setup & Operator Guide

Everything you need to run the Transmission console (`index.html`): connect
TouchDesigner, add songs to the preset stations, and deploy on Render.

---

## What you have

Two modes, switched with the **Mode** toggle in the console:

| Mode | What the screen shows | What the music is |
| --- | --- | --- |
| **Presets** | A built-in audio-reactive visual per station | Songs you add (see below), played locally in the browser |
| **Live Station** | Your TouchDesigner WebRTC stream. Until TD connects it holds the **"awaiting signal / TRANSMISSION"** screen — and keeps holding it, no matter how often it's clicked | Whatever TD sends |

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

Open `index.html` directly in a browser, or serve the folder:

```bash
npx serve .        # or: python3 -m http.server
```

Opening the file directly works for browser-uploaded songs. Songs referenced
in `PRESET_TRACKS` (below) need the page to be **served** (localhost or
Render), not opened as a `file://` path.

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

- **Play / Pause / Skip** drive the local player in Presets mode
  (Skip advances to the next station). In Live mode the same buttons send
  `{type:'transport'}` messages to TouchDesigner instead.
- **Vol** slider sets preset volume. Keys: **1–4** tune stations, **P**
  play/pause, **H** hides the console, **D** audio diagnostics.
- **Action keys drive the graphics too**: Q = accent flash, W = punch
  zoom + shake, E = spark burst, Space = shock ring — instantly in the
  default scenes, and the same key message reaches TouchDesigner in
  parallel, stamped with who pressed it.
- **Channel / VJ dropdowns** (top of the console): pick a channel, then who's
  driving it. **House** plays the channel's default scene; a scene VJ tunes
  their scene (station bank stays in sync); a "· live" VJ flips the console to
  Live Station (per-VJ stream routing arrives with the streaming tiers).
  Channels live in the `CHANNELS` config at the top of `index.html` — static
  for now; ROADMAP Tier 1b replaces it with the admin-created list from
  `/api/channels`. Every pick sends a `channel` message to TD (schema below).
- The whole UI auto-fades after ~4 s idle for a clean capture; move the
  mouse to bring it back.

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

Until real accounts exist, identity rides on the URL. Hand an approved
user a link like:

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

When the account system lands (ROADMAP Tier 2), the backend will set
these fields from the real session instead of the URL — the TD-side
schema won't change.

### Audio breakup?

Press **D** for diagnostics. High loss/jitter/concealment → network: raise
`AUDIO.jitterBufferMs` (400–800 for a solid music feed). Clean numbers but
still glitchy → fix it in TD (bigger Audio Out buffer, 48 kHz, cook time
under the audio buffer duration).

---

## Deploying on Render

It's a static site — no build step needed for the console.

1. Push this repo to GitHub/GitLab.
2. Render → **New → Static Site** → pick the repo.
3. **Build Command:** *(leave empty)* · **Publish Directory:** `.`
4. Every push redeploys. Songs in `audio/` + `PRESET_TRACKS` ship with it.

(If you'd rather deploy the built Vite bundle, use build `npm run build`,
publish `dist` — but that serves the React variant workflow; the console is
self-contained and simplest from the repo root.)

Two things to know about **Live mode on a hosted page**:

- Render serves over HTTPS, so the signaling URL must be `wss://` (it is),
  and the browser you operate from must **trust the TD cert** — on your own
  machine `mkcert -install` covers it; on another device visit
  `https://<td-ip>:<port>` once and accept the warning.
- The operator's browser must be able to **reach** the signaling server.
  Same LAN as TouchDesigner: works as-is. From outside your network you'd
  need port-forwarding plus a TURN server in `CONNECTION.iceServers` —
  visitors without that still get the full Presets experience.

---

## Verifying / dev notes

- Open the page: Presets mode, Ambient's bedroom scene idling. Add a song,
  press Play — the VU meters and the room should move with it.
- Click **Live Station**: music cuts, "awaiting signal / TRANSMISSION"
  holds until TD connects.
- `.smoke-test.cjs` is a headless test of the whole console
  (`npm i jsdom && node .smoke-test.cjs`) — handy after editing.

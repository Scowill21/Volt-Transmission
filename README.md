# TD Stream Control

A single-purpose web page that:

1. **Displays a live WebRTC video stream from TouchDesigner**, full-screen.
2. **Sends labeled keystrokes back to TouchDesigner** over the WebRTC data
   channel — one clean message per key press.

The whole page is your TouchDesigner output with a compact, self-documenting
control strip on top. Each control shows **what it does** (label) above **the
key that triggers it** (cap). Caps work by physical keyboard *and* by
click/tap, so it runs on a laptop or a tablet.

It's modeled on the official
[TouchDesigner WebRTC Remote Panel Web Demo](https://github.com/TouchDesigner/WebRTC-Remote-Panel-Web-Demo)
— it reuses that demo's signaling + WebRTC approach (the TD `signalingServer`
protocol, SDP offer/answer, ICE, and a data channel) but strips the UI down to
just the video and replaces the raw mouse/keyboard passthrough with a defined,
labeled key map. It also **auto-connects** to the TD peer (no manual "Start"
click) and **auto-reconnects** if the link drops.

---

## Quick start

```bash
npm install
npm run dev
```

Open the printed URL (defaults to `http://localhost:5173`). `npm run dev` also
exposes the page on your LAN, so a tablet on the same network can open
`http://<your-computer-ip>:5173`.

> `http://localhost` is a "secure context" in browsers, so the page can open a
> `wss://` connection to TouchDesigner without itself being served over HTTPS.
> See **TLS / certificates** below for the one piece of TLS you *do* need.

Build for production:

```bash
npm run build      # outputs to dist/
npm run preview     # serve the production build locally
```

---

## Configure it (one file)

Everything you'll normally touch lives in **[`src/config.js`](src/config.js)**.

### 1) Point it at your signaling server

```js
export const SIGNALING_SERVER_URL  = 'wss://127.0.0.1'; // your signalingServer COMP
export const SIGNALING_SERVER_PORT = 443;               // its port
```

- Use `wss://` when the `signalingServer` COMP's **Secure** toggle is on (the
  normal case). Use `ws://` only for an insecure server.
- Use the machine's IP instead of `127.0.0.1` if TouchDesigner runs on a
  different computer (e.g. `wss://192.168.1.50`).

### 2) Edit the key map

This is the single array that defines every control:

```js
export const KEY_MAP = [
  { key: 'q', label: 'Scene 1',  action: 'scene_1' },
  { key: 'w', label: 'Scene 2',  action: 'scene_2' },
  { key: 'e', label: 'Scene 3',  action: 'scene_3' },
  { key: 'r', label: 'Reset',    action: 'reset'   },
  { key: 't', label: 'Strobe',   action: 'strobe'  },
  { key: 'y', label: 'Blackout', action: 'blackout'},
  { key: ' ', label: 'Trigger',  action: 'trigger' },
];
```

| Field    | Meaning                                                                                  |
| -------- | ---------------------------------------------------------------------------------------- |
| `key`    | The physical key to listen for. A single lowercase char (`'q'`, `'1'`) or `' '` for Space. Case-insensitive. |
| `label`  | Human-readable description shown **above** the cap.                                       |
| `action` | The identifier sent to TouchDesigner — the value TD reads as `message.action`.           |

Add, remove, or rename entries freely — the panel re-renders automatically.
Seeded with placeholders; just change the labels and actions to match your patch.

### Other handy toggles (also in `src/config.js`)

| Constant                     | Default        | What it does                                                       |
| ---------------------------- | -------------- | ------------------------------------------------------------------ |
| `VIDEO_FIT`                  | `'contain'`    | `'contain'` letterboxes (never crops); `'cover'` fills and crops.  |
| `VIDEO_MUTED`                | `true`         | Set `false` only if TD also sends audio (autoplay needs muted).    |
| `PANEL_VISIBLE_BY_DEFAULT`   | `true`         | Whether the control strip shows on load.                           |
| `PANEL_TOGGLE_KEYS`          | `['h','Tab']`  | Keys that hide/show the panel for a clean stream.                  |
| `DATA_CHANNEL_LABEL`         | `'ControlData'`| The WebRTC data channel label (see schema below).                  |
| `ICE_SERVERS`                | Google STUN    | ICE servers. Pure-LAN works without STUN; harmless to keep.        |
| `PEER_ADDRESS_FILTER`        | `''`           | Only auto-connect to a peer whose address contains this substring. Leave `''` for the usual single-TD setup. |

---

## What gets sent to TouchDesigner (message schema)

When a key fires (physical press **or** click/tap), exactly **one** JSON
message is sent over the data channel labeled `DATA_CHANNEL_LABEL`
(`'ControlData'` by default):

```json
{ "type": "key", "action": "<action>" }
```

`<action>` is the `action` field from the `KEY_MAP` entry that fired
(e.g. `"scene_1"`, `"trigger"`). The shape is built by `buildKeyMessage()` in
`src/config.js` if you want to change it.

**Behavior guarantees:**

- **Discrete** — one message per press. Auto-repeat (holding a key) is
  debounced, so holding a key does **not** spam messages.
- Fires immediately on `keydown` and sends directly over the data channel
  (no detour through a separate server) for low latency.
- `preventDefault` is called on mapped keys (and the toggle keys) so the
  browser doesn't also act on them (e.g. Space scrolling).

### Receiving it in TouchDesigner

These messages arrive on the **WebRTC DAT's** received-data callback in
TouchDesigner (the same WebRTC DAT used by your `signalingClient` /
`WebRTCRemotePanel` setup). In that callback, parse the JSON and route on
`action`. Sketch:

```python
# WebRTC DAT callback (e.g. onReceiveText / data-channel callback)
def onReceiveText(dat, contents, *args):
    import json
    try:
        msg = json.loads(contents)
    except Exception:
        return
    if msg.get('type') == 'key':
        action = msg.get('action')
        # Map each action to whatever operator it should drive:
        if action == 'scene_1':
            op('/project1/scenes').par.index = 0
        elif action == 'trigger':
            op('/project1/trigger').par.pulse.pulse()
        # ...etc
    return
```

(The exact callback name/signature depends on your TD version and how the
WebRTC DAT is wired — the point is: JSON in, switch on `action`, drive ops.
Wiring the TD side is up to you; this app only sends the messages.)

---

## TLS / certificates (the one required setup)

TouchDesigner's `signalingServer` runs over **TLS (`wss://`)** when its
**Secure** toggle is on, so the browser must trust the server's certificate.
The cleanest local approach is [`mkcert`](https://github.com/FiloSottile/mkcert).

1. **Install mkcert** (see its README), then install the local CA once:

   ```bash
   mkcert -install
   ```

2. **Generate a cert/key** for the addresses you'll use. Run this in your
   TouchDesigner project folder:

   ```bash
   mkcert -cert-file tdServer.crt -key-file tdServer.key localhost 127.0.0.1
   ```

   Include any LAN IP you'll connect to as well, e.g.:

   ```bash
   mkcert -cert-file tdServer.crt -key-file tdServer.key localhost 127.0.0.1 192.168.1.50
   ```

3. **Point the `signalingServer` COMP at the cert:** turn on **Secure**, and
   set its certificate and private-key parameters to `tdServer.crt` /
   `tdServer.key`.

4. **Make the browser trust it.** `mkcert -install` handles this on the machine
   where you generated the cert. On a *different* device (e.g. a tablet), the
   self-signed cert won't be trusted automatically — either:
   - visit `https://<signaling-ip>:<port>` once in the browser and accept the
     warning (this temporarily trusts the server cert for the session), **or**
   - install the mkcert root CA on that device.

> Development certificates aren't recognized by a public certificate authority,
> so the trust step is required. For a permanent install you can instead use a
> real CA-issued certificate on the `signalingServer`.

### (Optional) Serving *this app* over HTTPS too

You only need this if you open the page from another device **by IP** and the
browser blocks the `wss://` upgrade as mixed content. To enable it, generate a
cert with mkcert (as above) and uncomment the `server.https` block in
[`vite.config.js`](vite.config.js).

---

## TouchDesigner side (summary)

This app only *sends* data and *receives* video. On the TD side you need
(per the reference demo):

- A **`signalingServer`** COMP (Palette → WebRTC). Turn on **Secure** and set
  the cert/key if using `wss://`. Note its **port** → that's `SIGNALING_SERVER_PORT`.
- A **`signalingClient`** COMP connected to that server, with **Forward to
  subscribers** turned on.
- A **`WebRTCRemotePanel`** COMP, with its `signalingClient` parameter set and a
  panel to stream.
- Handle the `ControlData` data-channel messages on the WebRTC DAT callback (see
  the schema section above) to drive your operators.

This page auto-connects to the first signaling peer it sees (optionally filtered
by `PEER_ADDRESS_FILTER`), so once TouchDesigner is up the stream appears with no
clicks.

---

## Deploy

It's a static site — build and host the `dist/` folder anywhere static
(Netlify, Vercel, GitHub Pages, an S3 bucket, a local web server, etc.):

```bash
npm run build      # -> dist/
```

- Set the signaling target in `src/config.js` **before** building (it's baked
  into the bundle).
- If you deploy under a sub-path (e.g. GitHub Pages project pages at
  `/<repo>/`), set `base` in [`vite.config.js`](vite.config.js) to `'/<repo>/'`.
- The hosting page can be plain HTTP or HTTPS, but remember the browser still
  has to trust the TouchDesigner `signalingServer` cert (see **TLS** above).

---

## How it's organized

> **Which page loads at `localhost`?** The root (`index.html`, served by `npm run
> dev`) is the **Transmission console** documented in the next section. The React
> variant below is archived as **`react-app.html`** (open `/react-app.html`) — it
> still runs, but it isn't the default page.

The React variant (`react-app.html` → `src/`):

```
src/
  config.js                  # ← the ONE file to edit: signaling target + key map + toggles
  main.jsx                   # React entry (StrictMode intentionally off — see file)
  App.jsx                    # composes video + status + key panel
  styles.css                 # all styling — follows the "voltage-drop" design system (--vd-* tokens, one easing curve)
  useKeyControls.js          # physical keyboard: debounce, preventDefault, pulses, panel toggle
  webrtc/
    SignalingClient.js       # WebSocket to TD signalingServer (+ auto-reconnect)
    WebRTCConnection.js      # RTCPeerConnection, perfect negotiation, data channel
    useTouchDesigner.js      # React hook tying it together (status, stream, sendAction, auto-connect)
  components/
    VideoStage.jsx           # full-viewport <video>
    KeyPanel.jsx             # the control strip
    KeyCap.jsx               # one labeled cap (clickable + key-bound, with pulse feedback)
    StatusIndicator.jsx      # small corner connecting/connected/reconnecting dot
```

**Connection lifecycle** — the status dot (top-right) shows
`connecting → connected → reconnecting` and fades out shortly after connecting.
The signaling WebSocket reconnects with backoff if it drops, and the peer
connection restarts ICE on failure, then re-establishes against whoever is still
in the session.

---

## Transmission console ([`index.html`](index.html) — the default page)

This is what loads at `localhost`. A self-contained, single-file app (no build
step — open it directly or serve the folder). It's a broadcast/tuner console
with **two modes** (see **[SETUP.md](SETUP.md)** for the full operator guide):

- **Presets** — each station has a built-in audio-reactive visual (Ambient →
  lofi bedroom, Pulse → Tokyo neon, Static → broadcast noise, Drift → open
  water) driven by live bass / snare-onset / treble analysis of songs you add:
  per-station browser uploads (↥ / drag-drop, persisted in IndexedDB) or
  deployed defaults via `PRESET_TRACKS` + an `audio/` folder.
- **Live Station** — the full-screen TD WebRTC stream; holds the "awaiting
  signal / TRANSMISSION" screen until TouchDesigner connects.

Plus the station preset bank, labeled key caps, transport + volume, a
bass/snare/treble VU, a TX readout, audio hardening, and an idle auto-hide
for clean capture.

### Edit your controls (top of the `<script>`)
- **`KEY_MAP`** — `{ key, label, action }` per cap (`' '` = space). Label shows
  above the cap; pressing the physical key or tapping the cap fires it.
- **`STATIONS`** — `{ id, name, note }` per preset; picking one is exclusive.
- **`CONNECTION.signalingUrl`** — set `wss://[SIGNALING_SERVER_URL]:[PORT]` to
  connect; leave the placeholder to run standalone (controls + TX readout work,
  nothing connects).
- `H` hides/shows the console, `D` toggles audio diagnostics (both kept out of
  `KEY_MAP` so they don't clash).

### Message schemas (over the WebRTC data channel)
```jsonc
{ "type": "key",       "action": "<action>" }              // a key cap fired
{ "type": "station",   "station": "<id>" }                 // a station was selected
{ "type": "transport", "action": "play" | "pause" | "skip" } // music transport
```
All arrive on the **WebRTC DAT** in TouchDesigner — switch on `type` and route:
`key` → trigger the matching operator, `station` → set the active preset,
`transport` → play / pause / skip the audio. When the data channel opens, the
currently-lit station is re-sent so TD syncs to it. (Play/Pause is a lit pair
reflecting the last command; Skip is momentary.)

### Color system
Resting/offline accent is **amber**; the instant the connection goes live a
single `body.live` class swaps three CSS vars (`--signal/--glow/--edge`) to
**violet**, flipping the whole accent at once (status light, lit station, active
caps, TX highlight, enable-sound prompt). Nothing hardcodes the accent.

### Audio robustness
- **Jitter buffer** (`AUDIO.jitterBufferMs`, default 200, max 4000): set on the
  receivers in `ontrack` via `jitterBufferTarget` (+ `playoutDelayHint` as the
  Chromium fallback). Raising it smooths brief network jitter/loss into
  continuous audio; **400–800 ms** for a rock-solid music feed. It delays only
  the displayed stream — the data-channel controls stay instant — and, if A/V
  are synced, pulls video along so reactive visuals stay locked to the sound.
- **Enable sound**: the video starts muted (so it can autoplay); when live and
  still muted, an "Enable sound" prompt appears — one click unmutes.
- **Diagnostics** (`D`): polls `getStats()` ~1/s for inbound audio — packet
  loss %, jitter, effective buffer, concealment/s — and warns past loss > 1 %,
  jitter > 30 ms, or any concealment. It tells you *which* breakup you have:
  high loss/jitter/concealment = **network** (raise the jitter buffer); clean
  numbers but still glitchy = **upstream in TouchDesigner**.
- **Fix it at the TD source** (the client can't repair already-glitchy audio):
  raise the Audio Device Out / Audio Stream Out CHOP buffer size; keep the whole
  project at **48 kHz** to match WebRTC/Opus; and keep TD's per-frame cook time
  well under the audio buffer duration so CPU/GPU spikes don't starve the audio
  and crackle at the source.

### The connection
The WebRTC **signaling handshake is fully implemented** in
`connectToTouchDesigner()` — ported from `src/webrtc/` (roster tracking,
auto-call of the first TD peer, perfect negotiation for offer glare, ICE
restart, and signaling auto-reconnect with backoff). Set
`CONNECTION.signalingUrl` and it connects; the `mode`/`station` state is
re-sent whenever the data channel opens. Signaling needs TLS (`wss://`) — use
the **mkcert** dev-certificate steps in the
[TLS / certificates](#tls--certificates-the-one-required-setup) section above.
Setup walkthrough: **[SETUP.md](SETUP.md)**.

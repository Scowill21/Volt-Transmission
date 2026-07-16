# Volt Control — your next steps + hardware guide

*Part 1 = what you do, in order. Part 2 = the Raspberry Pi how-to (becomes
`HARDWARE.md` + `tools/bus-to-pi.mjs` when the outputs mission ships —
don't follow it before then, the tool won't exist yet). Part 3 = ideas for
networking objects anywhere in the world.*

**Where things stand:** Volt Control is BUILT and live (commits `620babf`,
`c3058a6`) — items, QR codes, buy-now queue, soft-close auction, the
phone controller, admin behind the gear icon, five smoke suites green.
Two build missions are queued as prompt files in this folder:

| Order | Prompt file | What it does |
| --- | --- | --- |
| 1 | `PROMPT-CONTROL-SPLIT.md` | Splits the user site from the admin/ops page (no admin code on visitors' phones) |
| 2 | `PROMPT-OUTPUTS-REDUNDANCY.md` | Output chains + failover: multiple TD rigs, Raspberry Pi rigs, browser scenes (`stage.html`), never-sell-dead-air, Pi tooling |

| 3 | `PROMPT-JUKEBOX.md` | Audio as a control surface: paid song queue + skip with admin-set restriction windows, bid-for-next-play, Pi music player |

(`PROMPT-ITEM-CONTROL.md` is the original build prompt — historical now.
**`VOLT-PI-PLAYBOOK.md`** is the long-form owner's guide: beginner Pi
setup, the build recipe book, and the venue/business playbook — Part 2
below stays the terse spec the build sessions reference.)

---

## Part 1 — Next steps, in order

**1. Try what's already live.** Local play: run the dev server without
Supabase env (the repo's `volt-api-dev` entry, port 8794) — test items
`PSDV7H` (buy-now) and `2AWK6P` (auction) exist locally. On prod: unlock
the gear view on `/control` with your admin key, create a real item, print
its QR, buy a slot from your phone. Never paste the prod admin key into a
chat.

**2. Run the split mission.** Fresh session, paste
`PROMPT-CONTROL-SPLIT.md`. It will ask you its §9 questions — the defaults
are right (same service, ops at `/control-ops`, gear removed, QR base
unchanged).

**3. Run the outputs/redundancy mission.** Fresh session, paste
`PROMPT-OUTPUTS-REDUNDANCY.md`. This is the TD-independence build: output
chains with automatic failover, rig keys + presence dots in the ops page,
`stage.html` (projector-ready browser scenes + attract mode), no sales
while nothing's listening, clock pauses during output gaps, and the
`bus-to-pi` tool from Part 2. Its phase 2 menu (web-app outputs, scores,
pay-to-extend, live camera, pooled free mode, schedules, push) — pick
what you want when phase 1 is live.

**4. Wire TouchDesigner.** Works TODAY (no rigKey yet): WebSocket DAT →
`wss://td-stream-control.onrender.com/api/bus?channel=item:<CODE>`, parse
`{type:'key', action:'pad_up'|'pad_down'|'pad_left'|'pad_right'|'btn_a'|
'btn_b'|'btn_c'}` exactly like `scene_1..4`, honor `{type:'item'}`
(pause/off). OSC software: `tools/bus-to-osc.mjs` already forwards
`/volt/key/<action>` and `/volt/item/<action>`. After the outputs mission: add
`&rig=td-main&rigKey=<key>` to the URL and self-mute unless the `output`
message names you program — that's what makes a second TD machine a real
hot backup.

**5. Order hardware while missions run (~$60–100):** Raspberry Pi Zero 2 W
(or any Pi) + microSD + PSU · relay HAT (for anything mains) · 2× SG90
servos + small 5V supply · WS2812 LED strip (+ an ESP32 flashed with WLED
for the easy LED path) · jumper wires. Covers the first three ideas in
Part 2.

**6. First Pi rig** — Part 2 below, once the outputs mission has shipped.
(The full beginner walkthrough and recipe book: `VOLT-PI-PLAYBOOK.md`.)

**7. Money.** When you have Stripe test keys, the Tier 2b playbook
(`PAYMENTS-SETUP.md`) converts every `STRIPE:` seam — console
takeover/songs, shop, AND all item buys/bids/extends — in one pass.

**8. Housekeeping** (pending from HANDOFF): flip local `.env` DATABASE_URL
to the `:6543` transaction pooler · rotate the DB password (runbook in
MANAGE.md) · decide merge-or-delete for the untracked `SETUP-PAYMENTS.md`.

---

## Part 2 — Raspberry Pi how-to

*The key property: rigs dial OUT over WSS. A Pi on any venue WiFi, phone
hotspot, or NAT reaches your site with zero port-forwarding, zero static
IP, zero VPN. If a browser at the venue can load your site, a Pi there can
be an item.*

*(Today a Pi can already LISTEN — bus subscribe is public. The rigKey,
presence dot, self-mute, and the `bus-to-pi.mjs` tool below arrive with
the outputs mission.)*

### 2.1 How a Pi talks to the controller

The Pi is just another rig: it opens
`wss://<site>/api/bus?channel=item:<CODE>&rig=pi-lamp&rigKey=<key>` and
receives every controller press as JSON —
`{type:'key', action:'pad_up'|…|'btn_c', user, ts}` — plus
`{type:'item'}` (pause/off) and `{type:'output'}` (am-I-program). It maps
actions to GPIO pins. That's the entire integration.

Run it with:

```
node tools/bus-to-pi.mjs \
  --url "wss://<site>/api/bus?channel=item:7KP3QX&rig=pi-lamp&rigKey=XXXX" \
  --map pins.json
```

`pins.json` maps actions → behaviors, so re-wiring never means editing code:

```
{ "pad_up":   { "pin": 17, "mode": "pulse", "ms": 150 },
  "pad_down": { "pin": 27, "mode": "pulse", "ms": 150 },
  "pad_left": { "pin": 22, "mode": "toggle" },
  "pad_right":{ "pin": 23, "mode": "toggle" },
  "btn_a":    { "pin": 24, "mode": "hold",  "ms": 400 },
  "btn_b":    { "servo": 18, "mode": "sweep", "from": 0, "to": 120 },
  "btn_c":    { "udp": "192.168.4.40:21324", "payload": "wled-preset-3" } }
```

(`pulse` = on for N ms; `toggle` = flip state; `hold` = on while held;
`sweep` = servo travel; `udp` = fire a packet at something like WLED.)

### 2.2 Setup, once per Pi (~20 minutes)

1. Flash **Raspberry Pi OS Lite** with Raspberry Pi Imager — set WiFi +
   SSH in the imager's settings screen. Any Pi works; a Zero 2 W is plenty.
2. SSH in, install Node 20+ (`sudo apt install -y nodejs npm`, or nvm if
   apt's is old). In a folder: `npm i ws onoff` (use `pigpio` instead if
   you need servo PWM).
3. Copy `tools/bus-to-pi.mjs` and your `pins.json` over. In the ops
   dashboard, add a `rig` output to the item and copy the rigKey — it is
   shown once.
4. **Test with no hardware wired**: run the script, then from your laptop
   inject a press and watch the Pi log it:

```
curl -X POST https://<site>/api/channels/item:<CODE>/actions \
  -H 'content-type: application/json' -H 'X-Admin-Key: <key>' \
  -d '{"type":"key","action":"pad_up","user":{"name":"test"}}'
```

5. Make it survive reboots and outages — `/etc/systemd/system/volt-rig.service`:

```
[Unit]
Description=Volt rig
After=network-online.target
Wants=network-online.target

[Service]
ExecStart=/usr/bin/node /home/pi/volt/bus-to-pi.mjs --url "…" --map /home/pi/volt/pins.json
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
```

   then `sudo systemctl enable --now volt-rig`. From here the green dot in
   the ops dashboard is the health check, and the server's duty-cycle
   limits (`maxPerMin` / `cooldownMs` per item) protect the hardware from
   button-mashers.

**Safety, non-negotiable:** mains power ONLY through a proper relay HAT or
an enclosed smart plug (or stay low-voltage, WLED-style) · fuse it ·
flyback diodes on anything with a coil/motor · never power servos or
motors from the Pi's 5V rail (separate supply, common ground) · a physical
local off switch on every installation · tight `cooldownMs` on anything
that moves. Expect ~50–150ms press-to-GPIO — fine for everything below.

### 2.3 Ideas — things a Pi makes controllable

- **Claw machine** (the canonical one): buy-now = one play; d-pad drives
  X/Y steppers, A drops the claw; a win-detect beam sensor reports a
  `score` back — and phase 2 can award a shop record/print on a win.
- **Pan/tilt spotlight or camera**: d-pad aims two servos; A pulses the
  beam, or snaps a photo the item page shows — proof you did it.
- **LED installations**: WLED over UDP — A/B/C switch presets, d-pad
  changes direction/speed. The `pins.json` example above does this with
  zero extra code.
- **Solenoid drumbot**: A/B/C strike different percussion. Pairs absurdly
  well with the radio side of the site.
- **Dispensers**: candy/capsule/dog-treat via servo — pay-to-vend, camera
  shows the payoff.
- **Kinetic sculpture / drawing plotter**: users steer the pen; the artwork
  accretes across many paid slots; sell prints of it through the shop.
- **Bursts**: fog machine, bubble machine, confetti cannon (relay + a LONG
  cooldown).
- **Split-flap / flip-dot sign**: shows the current holder's name (filter
  text server-side).
- **Table-top RC arena**: d-pad drives a little car; the phase-2 camera
  relay shows it live.
- **Ambient venue toys**: fountain valves, grow lights, arcade marquee
  lighting.

---

## Part 3 — Networking objects in the world

The outbound-WSS pattern means anything with a network stack can be an
item, anywhere on earth — each object needs only its code + rigKey.

- **ESP32 native rigs (~$5/object).** Skip the Pi: an ESP32 WebSocket
  client parses the same JSON and drives LEDs/servos directly.
  Battery/solar friendly. A future `tools/esp32-rig/` sketch makes any
  hobbyist object connectable.
- **Bridge whole ecosystems with one Pi.** A `bus-to-mqtt` bridge opens
  Tasmota/ESPHome and the entire IoT hobby world; a Home Assistant bridge
  (HA's WebSocket API) turns every smart plug, bulb, and cover in a
  building into potential items; `bus-to-artnet` (Art-Net/sACN) drives
  real stage lighting — the d-pad literally aims a moving-head light.
- **Venues as first-class objects.** Tag items with a venue; filter the
  ops dashboard by venue; venue-wide pause/off for closing time (the
  phase-2 schedules generalize to this); one Pi bridges many items per
  site.
- **A public live map.** City-level map of online items worldwide → tap →
  item page. The presence system (outputs mission) already knows what's online.
  Extremely shareable.
- **Telemetry as product.** Rigs publish photos-after-action, win sensors,
  tilt/temp. Proof-of-action on the item page ("you made this happen"),
  and physical wins that award shop items — the loop that ties Volt
  Control to your existing store.
- **Fleet ops without SSH.** Rig dashboard (last-seen, RTT, script
  version), server-stored pin maps that rigs fetch on connect, a `reboot`
  command over the bus, staged script updates. This is what makes 20
  objects in 5 cities manageable by one person.
- **Connectivity resilience.** Venue WiFi with a phone-hotspot or
  LTE-dongle fallback; rigs hold no important state (the server owns it),
  so a flapping link just misses presses; systemd + a watchdog reboot
  recover everything unattended.
- **Security posture at world scale.** Per-rig revocable keys, duty limits
  per item, quiet-hours schedules, a local hardware e-stop on every
  install, and the fail-closed rule that no-output-online = no sales —
  which is exactly why those invariants live in the outputs mission's
  phase 1, not bolted on later.

# The Volt Pi Playbook

*Raspberry Pi + Volt Control, end to end: what to buy, exactly how to set it
up (written for a beginner), a recipe book of things to build, and the
business playbook — where to put items in the world and how they make money.*

**How this fits the repo docs:** `NEXT-STEPS-VOLT-CONTROL.md` Part 2 holds
the terse technical spec the build sessions use. THIS file is the long-form
owner's guide. One honesty note before anything else:

> **What works today vs. after the outputs mission.** Right now a Pi can
> already LISTEN to any item (bus subscribe is public) and react to presses
> — §3.6 below does exactly that. The polished pieces —
> `tools/bus-to-pi.mjs`, rig keys, the green presence dot, self-mute,
> duty-cycle limits — arrive when `PROMPT-OUTPUTS-REDUNDANCY.md` ships.
> Steps that need it are marked **[after outputs mission]**. Everything
> else works right now.

---

## 1 · The idea, in one page

Coin-op machines were a great business for a hundred years: put a machine
where people gather, charge a quarter, collect. Volt Control is coin-op
reinvented with the two devices everyone already has — **their phone** (the
controller and the wallet) and **your Pi** (the machine's brain):

- A thing in the world does something delightful (moves, lights up, draws,
  drops candy).
- A QR code next to it opens `/control?item=CODE`. No app install.
- The phone shows who's controlling it now, the countdown, and the price —
  **watching creates wanting.**
- Buy Now (short timed slot, queue) or Bid (soft-close auction) — then the
  phone becomes a d-pad + A/B/C and the thing obeys them, live, in front of
  everyone.

The Raspberry Pi is the workhorse because of one property of the system:
**rigs dial OUT over WSS.** The Pi connects from any venue WiFi or phone
hotspot to your server — no port forwarding, no static IP, no VPN, no
router settings. If a phone can load your site at that location, a Pi can
be an item there. Set it, plug it in, manage it from home.

The end goal (§6 and §7): a network of paid-controllable objects in bars,
venues, windows, and streams — each one earning small amounts continuously,
all operated remotely from one dashboard.

---

## 2 · Shopping lists

Buy from Adafruit or Micro Center (fast, documented), Amazon (fast), or
AliExpress (half price, three weeks). Prices are rough.

**Kit A — the brain (every project needs this, ~$45–75):**

| Part | ~Price | Notes |
| --- | --- | --- |
| Raspberry Pi Zero 2 W **or** Pi 4 | $15 / $45–55 | Zero 2 W is plenty and tiny. Prefer these over Pi 5 for hardware projects — GPIO libraries are simplest on them. **Zero 2 W is 2.4 GHz WiFi ONLY** (see §3.8). |
| 32 GB microSD (name brand) | $8 | SanDisk/Samsung. Cheap cards corrupt. |
| Official USB power supply | $8–12 | Underpowered phone chargers cause mystery crashes. |
| Breadboard + jumper wire kit + LED/resistor assortment | $12 | For learning and prototyping. |

**Kit B — motion (~$25):** 2× SG90 micro servos ($6) · PCA9685 16-channel
servo driver board ($12) · 5 V 3 A DC supply for the servos ($8). The
PCA9685 exists so servos get their own power and the Pi just sends I2C —
the single biggest beginner reliability upgrade.

**Kit C — switching things on/off (~$10–25):** For anything mains-powered,
DON'T wire mains. Buy a **Tasmota-flashed smart plug** (~$12, sold
pre-flashed) or Kasa plug — the Pi switches it over the network, your
fingers never touch 120 V. For low-voltage loads: a 4-channel relay module
($8) or logic-level MOSFET boards ($6).

**Kit D — lights (~$30):** WS2812B LED strip, 5 V ($15–20 for 5 m) + an
ESP32 board flashed with **WLED** ($8) + 5 V supply sized to the strip.
WLED is the easy path: the Pi (or even your laptop) triggers presets over
the network — zero soldering if you buy strips with connectors.

**Kit E — the flagship (~$150–400):** a used countertop **claw machine**
from Facebook Marketplace / OfferUp. You will not build a claw; you'll
*hack* one (§5, Recipe 7).

---

## 3 · One-time Pi setup — click by click (beginner-proof)

You'll do this once per Pi, from your Mac. ~30 minutes the first time.

### 3.1 Flash the SD card

1. Download **Raspberry Pi Imager** from raspberrypi.com/software and open it.
2. **Choose Device** → your Pi model.
3. **Choose OS** → *Raspberry Pi OS (other)* → **Raspberry Pi OS Lite
   (64-bit)**. "Lite" = no desktop — you don't need one, and it boots faster.
4. **Choose Storage** → your microSD (in a USB reader).
5. Click **Next** → **Edit Settings** (this screen is the magic — it means
   you never need a monitor or keyboard on the Pi):
   - **Hostname:** `volt-pi-1`
   - **Username/password:** pick both and WRITE THEM DOWN (e.g. user `will`).
   - **Configure wireless LAN:** your WiFi name + password, country `US`.
   - **Services tab → Enable SSH** → "Use password authentication".
6. Save → **Yes** → wait for write + verify → eject the card.

### 3.2 First boot + connect

1. Card into the Pi, plug in power. Give it 2–3 minutes on first boot.
2. On your Mac, open **Terminal** and type:

   ```
   ssh will@volt-pi-1.local
   ```

   (your username + your hostname). First time it asks
   `Are you sure you want to continue connecting?` → type `yes`. Enter your
   password. You're now typing commands *on the Pi*. The prompt changes to
   `will@volt-pi-1:~ $`.

### 3.3 Update + install Node

Paste these one at a time (each may take a few minutes on a Zero):

```
sudo apt update && sudo apt full-upgrade -y
sudo apt install -y nodejs npm git
node -v
```

`node -v` must print **v18 or higher**. If it's lower, install via
NodeSource: `curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E
bash - && sudo apt install -y nodejs`.

### 3.4 Make the project folder

```
mkdir ~/volt && cd ~/volt
npm init -y
npm i ws
```

(`ws` is the WebSocket library — the same one the server uses.)

### 3.5 Get an item code

On the ops/admin page (gear view on `/control` today; `/control-ops` after
the split mission), create an item — say a buy-now item, $2, 60-second
slots — and note its 6-character code, e.g. `7KP3QX`. Codes are always
UPPERCASE letters/digits (no 0/O/1/I). **[after outputs mission]** you'll also
add a `rig` output here and copy the **rigKey** — it's shown exactly once.

### 3.6 The listen test — works TODAY, no hardware, no rigKey

Create the test script on the Pi. Type `nano listen.mjs`, paste this, then
Ctrl-O Enter Ctrl-X to save:

```js
// listen.mjs — subscribe to an item's room and print what happens.
// usage: node listen.mjs 7KP3QX
import { WebSocket } from 'ws';
const code = (process.argv[2] || '').toUpperCase();
if (!code){ console.error('usage: node listen.mjs <ITEM-CODE>'); process.exit(1); }
const url = `wss://td-stream-control.onrender.com/api/bus?channel=item:${code}`;
(function connect(){
  const ws = new WebSocket(url);
  ws.on('open', () => console.log('[volt] listening to', code));
  ws.on('message', (d) => {
    try {
      const m = JSON.parse(d);
      if (m.type === 'key')        console.log('PRESS ', m.action, 'by', m.user?.name || 'anon');
      else if (m.type === 'item')  console.log('STATE ', m.action);
      else if (m.type === 'item_queues') console.log('QUEUE  holder:', m.active?.name || '—', 'line:', m.queue?.length || 0);
    } catch {}
  });
  ws.on('close', () => setTimeout(connect, 3000));
  ws.on('error', () => {});
})();
```

Run it: `node listen.mjs 7KP3QX`

Now make it print something, two ways:

- **The real way:** buy the slot from your phone at
  `https://td-stream-control.onrender.com/control?item=7KP3QX` and mash the
  d-pad. Every press appears on the Pi's screen. That's the whole product,
  working.
- **The tester's way (no purchase):** from your MAC's terminal, inject a
  press with your admin key (admin bypasses the holder gate):

  ```
  curl -X POST https://td-stream-control.onrender.com/api/channels/item:7KP3QX/actions \
    -H 'content-type: application/json' -H 'X-Admin-Key: YOUR_KEY' \
    -d '{"type":"key","action":"pad_up","user":{"name":"test"}}'
  ```

When you see `PRESS pad_up by test` on the Pi, the entire pipeline —
phone → your server → venue WiFi → Pi — is proven. Everything after this
is just deciding what a press *does*.

### 3.7 Make it survive reboots (systemd)

So the Pi recovers from power cuts and WiFi flaps without you:

```
sudo nano /etc/systemd/system/volt-rig.service
```

Paste (adjust username/paths/args):

```
[Unit]
Description=Volt rig
After=network-online.target
Wants=network-online.target

[Service]
User=will
WorkingDirectory=/home/will/volt
ExecStart=/usr/bin/node /home/will/volt/listen.mjs 7KP3QX
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
```

Then:

```
sudo systemctl enable --now volt-rig
journalctl -u volt-rig -f     # live logs; Ctrl-C to stop watching
```

**[after outputs mission]** change `ExecStart` to the real tool:
`/usr/bin/node /home/will/volt/bus-to-pi.mjs --url
"wss://…/api/bus?channel=item:7KP3QX&rig=pi-1&rigKey=XXXX" --map
/home/will/volt/pins.json` — and from then on the ops dashboard's green
dot is your health check, presence-tracked and failover-aware.

### 3.8 Troubleshooting (the four things that actually go wrong)

- **Can't `ssh …local`:** the Pi isn't on WiFi. #1 cause on a Zero 2 W:
  it's a **2.4 GHz-only** board and your network name points at 5 GHz.
  Re-flash with the 2.4 GHz SSID, or find the Pi's IP in your router's
  client list and `ssh will@192.168.x.x`.
- **`node -v` too old:** use the NodeSource line in §3.3.
- **Mystery reboots/freezes:** cheap power supply. Use a real one.
- **Works at home, dead at the venue:** captive-portal WiFi (the
  click-to-agree page). Use a phone hotspot or a travel router that logs in
  for you; see §7.6.

---

## 4 · Wiring for people who've never wired — the 20% that matters

- **The GPIO pins** are the double row of 40 pins. Pins are referred to by
  **BCM number** (GPIO17), not physical position — every pinout diagram
  online shows both (search "Raspberry Pi pinout" → pinout.xyz).
- **3.3 V logic, tiny current.** A GPIO pin can light an LED (through a
  330 Ω resistor). It cannot drive a motor, a strip, or a solenoid —
  those need a **driver** (relay module, MOSFET board, PCA9685) between
  the Pi and the load.
- **The one rule that prevents most dead Pis: common ground.** Any external
  power supply's ground (−) must connect to a Pi ground pin. Power flows in
  loops; grounds join the loops.
- **Never power motors/servos from the Pi's 5 V pin.** Separate supply,
  common ground. The Pi browns out and corrupts its SD card otherwise.
- **Never touch mains.** Anything that plugs into the wall gets switched by
  a smart plug (Tasmota/Kasa — the Pi commands it over the network) or a
  properly enclosed relay HAT. This is the difference between a fun hobby
  and an electrician's liability.
- **First circuit, always:** LED + 330 Ω resistor from GPIO17 to GND. When
  a phone press blinks that LED, you'll feel it — everything else is the
  same idea with bigger drivers.

**The universal trick — a relay across a button.** Almost anything with a
physical button (an RC car's remote, a claw machine's joystick panel, a
bubble machine's switch, an arcade board) can be Volt-controlled WITHOUT
understanding its electronics: open it, find the two contacts the button
bridges, wire a relay's output across them, and let the Pi "press the
button" by clicking the relay. You're not hacking the device; you're
poking its button with an electric finger. This one pattern unlocks half
the recipe book below.

---

## 5 · Recipe book

Each recipe: what the crowd sees · parts · difficulty · how · suggested
item settings. Prices/slots are starting points — tune per venue.

### Recipe 0 — The Soundboard (zero wiring, one evening)
**Crowd sees:** press A/B/C and airhorns/laughs/beat-drops play through a
speaker in the room. **Parts:** Kit A + any powered speaker + (Pi Zero has
no headphone jack) a $8 USB audio adapter. **How:** map presses to
`aplay sound.wav` / `mpg123` calls. It's the perfect first build — the
"hardware" is a speaker cable — and in a bar it's *hilarious*.
**Settings:** buy-now · $1 · 30 s · generous limits.

### Recipe 1 — The Beacon (first real hardware, one evening)
**Crowd sees:** a lamp/neon sign/rope light turns on-off-flicker on command.
**Parts:** Kit A + Kit C (smart plug path = no wiring at all).
**How:** presses fire the plug's local HTTP command (Tasmota:
`http://PLUG-IP/cm?cmnd=Power%20TOGGLE`). d-pad = patterns (slow blink,
strobe-lite), A/B/C = on/off/party. **Settings:** buy-now · $1 · 60 s ·
`cooldownMs` ≥ 500 so relays aren't hammered.

### Recipe 2 — The Light Wall (the best $/wow ratio)
**Crowd sees:** a whole wall/window/bar-back of LEDs changes pattern,
color, speed under their thumbs. **Parts:** Kit A + Kit D. **Difficulty:**
easy — WLED does the hard part. **How:** flash WLED onto the ESP32 (web
installer, 5 minutes), save 6–8 presets; the Pi triggers presets/effects
over the network (HTTP `http://WLED-IP/win&PL=3` or UDP). d-pad =
direction/speed/brightness, A/B/C = palettes. **Settings:** buy-now ·
$1–2 · 60–90 s. This is the recipe to build FIRST for a venue pitch —
visible from the street, zero moving parts, nothing to break.

### Recipe 3 — The Searchlight (motion, one weekend)
**Crowd sees:** a spotlight (or laser, or webcam) physically aims where
they steer. **Parts:** Kit A + Kit B + a small LED spot. **How:** two
servos in a pan/tilt bracket ($9), driven via the PCA9685; d-pad nudges
angles (clamp the range in software so it can't point at eyes/traffic),
A pulses the light, B recenters. **Settings:** buy-now · $2 · 60 s ·
`maxPerMin` tuned so servos rest.

### Recipe 4 — The Candy Drop (money printer at all-ages venues)
**Crowd sees:** press A → a scoop of candy/capsule/toy drops into the tray.
**Parts:** Kit A + a continuous-rotation servo ($8) + a hopper you 3D-print
or build from a soda bottle + funnel. **How:** A rotates the auger one
metered turn. THE settings matter: mode buy-now, price = candy cost × 4,
slot 15 s, `cooldownMs` huge (one drop per purchase — a slot IS a vend).
Refill weekly. This is literally a vending machine where the machine cost
$40.

### Recipe 5 — The Drumbot (for the radio tie-in)
**Crowd sees:** solenoids strike a snare/cowbell/woodblock in time with
their taps — a physical drum machine the audience plays. **Parts:** Kit A +
3 push solenoids ($6 ea) + MOSFET driver board + 12 V supply. **How:**
A/B/C = one hit each, d-pad switches padded/accent modes. `cooldownMs`
~120 per solenoid (they overheat if held). Point a mic at it and it's ON
your radio stream — the loop closes.

### Recipe 6 — The Plotter (art that accretes)
**Crowd sees:** a pen plotter draws THEIR line onto a big shared sheet;
the artwork grows all night from everyone's slots. **Parts:** cheapest
path is a kit plotter (AxiDraw clone, ~$120) driven over USB-serial; the
Pi translates d-pad to small pen moves, A = pen up/down. Date each sheet,
sell prints in the shop later — one item, two revenue streams.
**Settings:** buy-now · $3 · 120 s.

### Recipe 7 — The Claw (the flagship)
**Crowd sees:** a real claw machine, controlled from their phone, with
their name on the marquee. **Parts:** Kit E (used machine) + 4–8 channel
relay board. **How — the universal trick, not a rebuild:** the machine
already knows how to be a claw; its joystick and drop button are just
switches. Open the control panel, wire one relay across each direction
contact + one across DROP, and the Pi presses them. Leave coin mode
satisfied (most machines have a free-play DIP switch). d-pad = X/Y, A =
drop. **[after outputs mission, phase 2]** a $2 IR beam sensor in the chute
reports wins as `score` — winners can earn shop credit automatically.
**Settings:** buy-now · $2–3 · one play per slot. The unit economics of
claws are famously good; yours has no coin box to empty.

### Recipe 8 — The Window Robot (retail after hours)
**Crowd sees:** a mannequin arm waves / a toy train runs / blinds open to
reveal displays — controlled from the SIDEWALK through the glass, when the
store is closed. **Parts:** whatever the display is + the universal trick.
Dead retail hours become the show; QR on the glass. Stores pay YOU for
this (§7).

### Recipe 9 — The Arena (table-top RC)
**Crowd sees:** an RC car in a walled table arena (obstacles, a ball to
push). **Parts:** cheap RC car — but don't touch the car: open its REMOTE
and relay across the four direction buttons (universal trick again; the
radio link stays factory). d-pad drives. **[after outputs mission, phase 2]** the
MJPEG camera relay puts a live top-down view on the phone, and this
becomes playable from home — the first fully remote item.

### Recipe 10 — The Oracle (weird and cheap)
**Crowd sees:** a flip-dot display / split-flap / LED matrix that shows the
current controller's name and lets them push one short message (A/B/C
cycle through admin-curated phrases — never free text without a filter).
**Parts:** Kit A + a $30 LED matrix (HUB75 + adapter). Names-in-lights is
a stupidly effective draw at bars.

### Recipe 11 — The Garden (slow-burn charm)
**Crowd sees:** press to water a plant wall / turn grow lights / release a
mister, with a "last watered by NAME" sign. **Parts:** Kit A + 12 V pump +
MOSFET + tubing. Coffee-shop catnip. Long `cooldownMs` protects the plants
from enthusiasm.

### Recipe 12 — The Jukebox (the bar's music, sold as a controller)
**Crowd sees:** the venue's music with a live "NOW PLAYING / UP NEXT"
marquee on the TV — and whoever holds the controller (bought or won at
auction) picks and skips, within house rules the admin set: e.g. "skips
only in a song's first 15 seconds, 2 skips per person per half hour, 6
per hour room-wide." **Build mission:** `PROMPT-JUKEBOX.md` (run it after
the outputs mission). **Two ways to play the music:**

- **Own catalog (cleanest rights):** the Pi runs **MPD** (`sudo apt
  install mpd mpc`), music files in a folder, USB-DAC or HDMI into the
  venue amp (Pi Zero has no headphone jack — a $8 USB audio adapter fixes
  that). Perfect fit for your shop/label artists — the jukebox literally
  promotes records you sell.
- **The venue's own Spotify (easiest pilot):** no audio wiring at all —
  the server drives the venue's existing Spotify Premium via their API
  (skip/queue/pick on THEIR account, playing through THEIR speakers). If
  the venue has no Spotify Connect device, a Pi running `raspotify`
  becomes one. Honesty required in the pitch: this rides the venue's own
  account and licenses — see the licensing box below.

**The queue/price display:** any screen with a browser is the marquee —
an old tablet on a shelf, or the bar TV via a $30 HDMI stick, pointed at
the item's marquee view (now playing, up next with names, prices or the
current controller + countdown, and the QR). No extra software on the Pi.

**Settings that work:** sell the CONTROLLER, not songs — buy-now $3 for a
3-minute controller slot (or auction it on Friday nights); skips
restricted to the first 15 s, guaranteed 10 s minimum play, per-user and
room-wide skip caps. Per-song pricing ($2/queue, $1/skip) is supported
too when that fits the room better.

> **Licensing box (important, not legal advice):** music in a venue is
> public performance no matter the source. The old coin-op jukebox
> license explicitly does NOT cover internet jukeboxes; consumer Spotify
> is personal-use by its terms (venues playing it is common but that's
> the venue's exposure, and monetizing control via Spotify's API can get
> the app cut off); even the licensed business-music services with APIs
> currently allow STAFF control only, not patron control. Selling the
> controller-slot instead of songs is your strongest posture — the
> performance stays the venue's, on their account — but it's an argument,
> not a safe harbor. Cleanest pilots: your own label catalog on MPD, or
> controller-slot mode with the caveats disclosed to the venue. Sort PRO
> licensing before real money rides on mainstream catalog.

### Recipe 13 — The Multi-Rig (one Pi, many items)
One Pi can run SEVERAL items — a bar's soundboard + light wall + beacon on
a single $15 board: run one process per item code (three systemd services),
or **[after outputs mission]** one `bus-to-pi` per item. This is what makes a
"venue package" (§7.3) cheap to deploy.

---

## 6 · The end goal: engagement loops that turn presses into money

The product thesis: **people pay small amounts for real agency in a real
place, in front of other people.** Every design choice should serve one of
these loops:

**The sidewalk loop (minutes):** attract mode makes the item move on its
own → QR scan → the item page shows someone ELSE controlling it + a
countdown + a price → envy is the salesperson → buy → your slot → the
crowd sees what you did → the person next to you scans. Design for it:
put the QR at eye level; make attract mode gentle but alive
**[after outputs mission]**; keep slots SHORT (30–120 s) — scarcity sells, and
short slots mean more people get a turn per hour.

**The status loop (all night):** names on the sign (Recipe 10), high-score
boards **[phase 2]**, auction mode on the flagship item so the crowd
watches a bidding war for the prime Friday-night slot. Buy-now items =
impulse; ONE auction item per venue = theater.

**The ownership loop (weeks):** the plotter's sheet becomes prints in the
shop; claw wins become shop credit `[phase 2]`; regulars chase a
leaderboard that resets monthly. The physical world feeds the digital
store you already built.

**Pricing that works (starting grid):** impulse items $1 (soundboard,
beacon) · standard $2–3/60–90 s (lights, searchlight, claw play) ·
flagship auction: starting bid $3, let the room decide the ceiling ·
pay-to-extend **[phase 2]** is the natural upsell at slot end. Rough
honest math: a $2/90 s item sells at most ~$70/hour saturated; a realistic
busy-night take is 15–30 plays = **$30–75/night/item**. A three-item venue
package on good weekends ≈ $200–400/month — against ~$150 of hardware per
venue, one-time. The margin is in the fleet: 10 venues run from one couch.

**The operations promise that makes it scale:** duty-cycle limits protect
hardware from mashers · schedules **[phase 2]** sleep items at closing ·
presence dots tell you a rig died before the bartender does · everything
reachable outbound-only, so "deployment" = plug + WiFi password. One
person can run dozens of items because the system was built fail-closed
and remote-first.

**Sequencing honesty:** money is stubbed until Tier 2b (Stripe). Run your
first venue pilots in free mode to prove engagement (count plays, film
reactions), and flip real charging on when 2b lands — `PAYMENTS-SETUP.md`
converts every seam at once.

---

## 7 · Where to put items — placements likely to be profitable

### 7.1 The venue shortlist, best first

1. **Bars, breweries, barcades** — the bullseye: captive crowds, dwell
   time, impulse cash, social one-upmanship. Package: light wall +
   soundboard + claw. The bar ALSO benefits (spectacle sells another
   round), which makes the pitch easy.
2. **Music venues + clubs** — searchlights/lasers the crowd steers between
   sets, drumbot on the patio; ties directly into the Volt radio/VJ side
   (the same bus drives both). Best fit for AUCTION mode — one prime item,
   one bidding war per set break.
3. **Late-night food** (pizza slices, taco windows, food halls): queues of
   bored people holding phones = your exact user. Candy drop, oracle sign,
   light wall.
4. **Retail windows after hours** (Recipe 8) — the only placement where
   the VENUE pays you (window animation = foot-traffic marketing), plus
   users pay per control. Pitch it to boutiques and record stores as
   "your window works while you sleep."
5. **Coffee shops / study spots** (daytime gentler set): the Garden, the
   plotter drawing your name, quiet lights. Lower take, near-zero risk,
   great for iterating.
6. **Arcades + FECs** — obvious fit, and rev-share deals are their native
   language; bring the claw conversion pitch (their dead machines, your
   phone-pay brain).
7. **Festivals, night markets, art walks, pop-ups** — portable rigs on a
   hotspot (§7.6). Short seasons, dense crowds, cash-rich hours; ideal for
   proving numbers fast.
8. **Museums/galleries/immersive spaces** — kinetic sculpture + plotter as
   participatory art; framed as pay-what-you-want or donation, it dodges
   the "arcade in a gallery" objection.
9. **Hotel lobbies / rooftop bars / tourist overlooks** — the coin
   telescope's grandchild: searchlight, camera, oracle. Transient crowds
   never get bored of it because they're always new.
10. **The internet itself** — a streamer points a camera at any recipe and
    their whole audience can pay to control it live **[phase 2 camera
    makes this fully remote]**. No venue, no permission, infinite
    sidewalks. This is where the world-networking goal (ESP32 fleets, the
    live map) pays off.

### 7.2 What makes a spot GOOD (site-selection checklist)

Dwell time over foot traffic (waiting people beat walking people) ·
sightlines (the item must be visible while someone ELSE controls it) ·
WiFi you can actually use (§7.6) · a socket · staff who'll tolerate it ·
under $200 of your hardware at risk if it walks · and a reason people are
already holding their phones out (lines, tables, bars — not hallways).

### 7.3 The pitch (works because the venue risks nothing)

Offer the **venue package**: you supply and maintain 2–3 items, they
supply a plug and WiFi. **Free 2–4 week pilot** in stub/free mode → show
them the play counts and the crowd videos → then rev-share (venue
20–30% is standard sales-language for amusement routes) once real money
is on. You keep ownership of all hardware; "if you ever don't want it, I
unplug it same-day." One page, no contract heavier than a handshake for
the pilot. Start with ONE friendly bar where you know the owner — the
first venue is a portfolio, not a business.

### 7.4 Read the room (rules of thumb, not legal advice)

Anything that MOVES near people needs conservative ranges, an e-stop, and
tight duty limits (you built those server-side for a reason) · food items
(candy) = sealed hopper, single-serve wrapped candy keeps it simple ·
prizes/claws can brush against local amusement/redemption rules — selling
PLAYS is simpler than promising PRIZES, and shop-credit rewards are
cleaner than cash-value ones · sidewalk placements may need the shop's
permission at minimum · get a cheap general-liability policy before the
fleet is real. When in doubt: lights and sound, not motion and food.

### 7.5 What to measure during pilots (so the money decision is data)

Plays/night · unique users vs repeats · scan→buy conversion (page views
vs purchases) · peak hours (informs schedules) · deaths/restarts (rig
reliability) · and the one that sells venues: photos of a crowd around
your item. The ops dashboard + server logs give you most of this today;
a proper per-item revenue view is a natural 2b follow-up.

### 7.6 Venue connectivity (the #1 field problem, solved in advance)

Captive-portal WiFi (click-to-agree pages) breaks headless Pis. In order
of preference: ask the venue for the STAFF network password · a $30–40
**travel router** (GL.iNet) that handles the portal login and gives your
Pi a normal network · a phone hotspot or $20 LTE dongle with a cheap data
SIM (rig traffic is tiny — kilobytes). Test the listen script (§3.6) ON
SITE before install day; it's a 2-minute check that saves a wasted trip.

---

## 8 · Your first 30 days, concretely

1. **Week 1:** Kit A + Kit D ordered · do §3 end to end at home · Recipe 0
   or 1 working on your desk · presses from your phone blink a real thing.
2. **Week 2:** Recipe 2 (light wall) built · run the two build missions
   (`PROMPT-CONTROL-SPLIT.md`, then `PROMPT-OUTPUTS-REDUNDANCY.md`) so
   rigs get keys, presence, failover, and the real `bus-to-pi` tool ·
   convert your desk rig to it.
3. **Week 3:** pick the friendly bar · site-check WiFi (§7.6) · install
   the light wall + soundboard as a FREE pilot · QR stands up · watch what
   people actually do; tune slots/prices/limits.
4. **Week 4:** review pilot numbers (§7.5) · start the claw hunt on
   Marketplace (Recipe 7) · if the bar wants music control, run
   `PROMPT-JUKEBOX.md` (Recipe 12) · when Stripe keys exist, run Tier 2b
   and flip the pilot to real money.

*Everything here rides the invariants the repo already enforces: verified
sessions, fail-closed payments, unforgeable server messages, rate and duty
limits. The Pis are just fingers — the server stays the brain.*

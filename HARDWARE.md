# HARDWARE.md — plug a Raspberry Pi into Volt Control

This is how you make a **real object** (a lamp, a relay, a servo, a smoke
machine) one of an item's outputs, so people who buy a control slot drive it
from their phone. The Pi runs `tools/bus-to-pi.mjs`, connects to the item's
bus room as an authenticated **rig**, and turns controller presses into GPIO
or UDP actions. Because it's a rig in the item's **output chain**, the server
counts it as a live output — TouchDesigner is optional, and if you add a
second rig (or a browser scene) the system fails over automatically.

> **Two kinds of rig, same chain.** Sections 1–8 cover the **GPIO/actuator** rig
> (`bus-to-pi.mjs`) for pad-surface items. **Section 9** covers the **jukebox
> player** rig (`tools/volt-jukebox.mjs`, MPD/log) for `surface:jukebox` items —
> it plays music instead of firing pins but joins the output chain the same way.

> ESP32 / MQTT / Home-Assistant / Art-Net bridges and multi-venue fleets are a
> future direction — this guide covers the Raspberry Pi rig only.

---

## 1. What you need

- A **Raspberry Pi** (any model with GPIO + network — a Pi Zero 2 W or Pi 4 is
  plenty), running **Raspberry Pi OS Lite**.
- Whatever you're driving, on a **safe interface**:
  - **LED / low-power** — an LED + resistor straight off a GPIO pin is fine.
  - **Mains or motors** — NEVER switch mains from a GPIO pin. Use a **rated
    opto-isolated relay board** (or a proper SSR). The Pi triggers the relay's
    input pin; the relay switches the real load on its own supply.
  - **Hobby servo** — power the servo from its own 5 V supply (not the Pi's
    3.3 V pin), common ground with the Pi; signal wire to a GPIO pin.
- Common ground between the Pi and anything it triggers.

⚠️ **Safety:** the server enforces duty-cycle limits (max actions/min,
cooldowns — set per item in the ops page), but that protects against spam, not
bad wiring. Pick sensible `ms` values in `pins.json`, fuse real loads, and
don't drive an inductive load (motor/solenoid) without a flyback diode.

---

## 2. Set up the Pi (from zero)

```bash
# on the Pi (SSH in, or a keyboard + monitor once):
sudo apt update && sudo apt install -y git nodejs npm
node --version            # need 18+; if apt's node is old, use nodesource:
#   curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash - && sudo apt install -y nodejs

# get the tool. Easiest: copy the whole repo (it's small) OR just the two files:
git clone https://github.com/Scowill21/Volt-Transmission.git
cd Volt-Transmission
npm ci                    # installs `ws` (the only dependency the tool uses)
```

You only actually need `tools/bus-to-pi.mjs`, your `pins.json`, and the `ws`
package. Cloning the repo + `npm ci` is the simplest way to get all three.

---

## 3. Get a rig key (once, from the ops page)

1. Open **`https://td-stream-control.onrender.com/control`** on any computer.
2. Tap the **⚙ gear** (top-right) and unlock with your **admin key**.
3. Find your item (or **Create item** first), open its **Outputs — failover
   chain**, type a rig **name** (e.g. `pi-lamp`), and hit **Add rig + get key**.
4. **Copy the key immediately — it's shown once.** It only ever exists hashed
   on the server after this; if you lose it, delete the output and add a new one.

The chain shows a **dot per output**: grey = offline, green = online, amber =
the current **program** (the one actually driving). Priority `#1` is tried
first; add a `td-backup` rig and/or a **scene** output below it for redundancy.

---

## 4. Write `pins.json`

Map each controller action to a pin behavior. The controller sends
`pad_up` `pad_down` `pad_left` `pad_right` and `btn_a` `btn_b` `btn_c`.

```json
{
  "pad_up":    { "pin": 17, "mode": "pulse", "ms": 150 },
  "pad_down":  { "pin": 27, "mode": "pulse", "ms": 150 },
  "pad_left":  { "pin": 22, "mode": "sweep", "from": 0,   "to": 180, "ms": 700 },
  "pad_right": { "pin": 23, "mode": "sweep", "from": 180, "to": 0,   "ms": 700 },
  "btn_a":     { "pin": 24, "mode": "toggle" },
  "btn_b":     { "pin": 25, "mode": "hold",  "ms": 1000 },
  "btn_c":     { "mode": "udp", "host": "192.168.1.50", "port": 7000, "payload": "fire" }
}
```

Behaviors:

| mode | what it does | good for |
| --- | --- | --- |
| `pulse` | pin HIGH for `ms`, then LOW | a lamp blink, a relay tap, a solenoid poke |
| `toggle` | flip the pin and latch it | on/off lamp, a latching relay |
| `hold` | HIGH for `ms` (retriggerable), then LOW | "press and it stays on a beat" |
| `sweep` | software-PWM ramp `from`→`to` over `ms` | wiggle a hobby servo (see note) |
| `udp` | send a datagram (`payload`) — no GPIO | hand off to a PWM HAT, another Pi, DMX/OSC box |

`pin` numbers are **BCM GPIO** (the same numbers on the pinout, not physical
pin positions). Unmapped actions are ignored.

> **Servo note:** `sweep` bit-bangs a coarse duty cycle over sysfs — it can't
> hit a clean 50 Hz servo frame, so expect jitter. It's fine for a "twitch on
> a press" gag. For smooth/precise motion, drive a real PWM HAT and use `udp`
> mode to talk to it.

---

## 5. Run it

```bash
node tools/bus-to-pi.mjs \
  --url wss://td-stream-control.onrender.com/api/bus \
  --item ABC123 --rig pi-lamp --key <the key from step 3> \
  --map pins.json
```

- `--url` is the bus base (no query string — the tool adds `channel`, `rig`,
  `rigKey`).
- `--item` is the 6-char code; `--rig` must match the output name you created;
  `--key` is the rig key.
- Add `--log-only` to print what it *would* do without touching GPIO — use this
  to test your `pins.json` on a laptop before deploying to the Pi.

On success it prints `connected as rig "pi-lamp"`, and the item's chain dot for
`pi-lamp` turns green in the ops page. Buy a slot from your phone and press
buttons — the pins fire.

### Run it forever (systemd)

So it survives reboots and crashes:

```ini
# /etc/systemd/system/volt-rig.service
[Unit]
Description=Volt Control Pi rig
After=network-online.target
Wants=network-online.target

[Service]
WorkingDirectory=/home/pi/Volt-Transmission
ExecStart=/usr/bin/node tools/bus-to-pi.mjs --url wss://td-stream-control.onrender.com/api/bus --item ABC123 --rig pi-lamp --key YOUR_KEY --map /home/pi/pins.json
Restart=always
RestartSec=3
User=pi

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now volt-rig
journalctl -u volt-rig -f      # watch the logs
```

(The tool also reconnects on its own with backoff, so a brief network drop
doesn't need systemd — but systemd handles reboots and hard crashes.)

---

## 6. How failover behaves (what you'll see)

The server elects ONE **program** output per item — the lowest-priority-number
one that's online (scenes count as always online). Your rig **self-mutes when
it isn't program**: it ignores controller keys and drives every pin to a safe
(LOW) state, then goes live again automatically when it becomes program.

- Add a **second rig** (`td-backup`, priority 2) as a hot spare: if the program
  rig drops, the server waits a **5-second grace** (so a network blip doesn't
  flap the show) then promotes the backup. A higher-priority rig reconnecting
  **preempts** immediately.
- Add a **scene** output (a browser projector — see `stage.html`) as the
  bottom of the chain: it's always online, so the item **keeps selling even if
  every rig is down**, and a paying holder's clock **auto-pauses during an
  output gap** and resumes when an output returns — nobody pays for dead air.
- On item **pause / off / slot end**, your rig drives all pins safe.

---

## 7. Troubleshooting

| Symptom | Cause → fix |
| --- | --- |
| Exits with `rig key rejected (4401)` | `--rig`/`--key` don't match an output on that item. Re-add the rig output in the ops page and copy the new key. |
| Logs say `[gpio:log] pin N → …` on the Pi | The pin couldn't be exported (permissions or not-a-Pi). Run node as a user in the `gpio` group, or with sudo; off a Pi this is expected. |
| Connected but nothing fires | You're **self-muted** — another output is program (check the ops page chain; the amber dot is program). Raise this rig's priority or stop the other output. Also: nobody holds a slot, or the item is paused/off. |
| `--log-only` everywhere | You passed `--log-only`, or `/sys/class/gpio` isn't available. Drop the flag on the actual Pi. |
| Servo jitters | Expected with `sweep` (see the servo note). Use a PWM HAT + `udp` mode. |

---

## 8. Safety recap

- Never switch **mains** from a GPIO pin — use a rated relay/SSR board.
- Give motors/solenoids their **own supply**, a common ground, and a flyback
  diode; don't back-feed the Pi.
- Keep `pins.json` `ms` values sane so a held button can't cook a relay — and
  set per-item **duty limits** in the ops page as a server-side backstop.

---

## 9. The jukebox player rig (`tools/volt-jukebox.mjs`)

A **jukebox** item (`surface:jukebox` in the ops page) plays *music* instead of
firing pins. Same rig model: the Pi joins the item's output chain as an
authenticated rig and is the **player**; the server owns the queue, the skip
rules, the bid round, and what plays next. The rig only receives
`play` / `house` / `stop` / `skip` commands and reports back what actually
happened (`track_started` / `track_ended` / `position`) so the server's clocks
track *real* playback. On (re)connect — or when it's promoted program by
failover, or when the item is turned back on — the server resyncs it to the
current track.

**Add it to the chain exactly like a GPIO rig** (section 3): create the jukebox
item, open its Outputs chain, add a rig named e.g. `pi-jukebox`, copy the key.
An **unlisted** rig is never elected program, so the jukebox reads "player
offline" and refuses requests — the rig MUST be in the chain.

### Backends

| `--backend` | what it does | needs |
| --- | --- | --- |
| `mpd` | plays local files through **Music Player Daemon** (rights-clean) | `mpd` installed + a music library |
| `log` | no audio — prints every command and **simulates** playback with timers, reporting the same events | nothing (runs on a laptop) |

Spotify is **deliberately not a backend yet** — the server is backend-blind, so
it slots in later as its own `--backend spotify` once the OAuth/licensing path
is signed off (`PROMPT-JUKEBOX.md` §8 / `SETUP.md`).

### MPD in one minute (on the Pi)

```bash
sudo apt install -y mpd mpc
# point MPD at your music + enable it (edit /etc/mpd.conf: music_directory "/home/pi/Music")
sudo systemctl enable --now mpd
mpc update && mpc listall | head        # confirm it sees your files
```

Put each catalog song's **`file`** (in the ops catalog editor) as MPD's URI —
the path **relative to `music_directory`** (e.g. `bowie/rebel-rebel.mp3`). House
mode adds the whole library on random+repeat; point it at a folder/playlist with
`--house "chill"` if you want a specific vibe.

### Run it

```bash
# on the Pi, MPD backend:
node tools/volt-jukebox.mjs \
  --url wss://td-stream-control.onrender.com/api/bus \
  --item ABC123 --rig pi-jukebox --key <the key from step 3> \
  --backend mpd            # [--mpd-host 127.0.0.1 --mpd-port 6600 --house ""]

# on any laptop, no audio — prove the whole loop end to end:
node tools/volt-jukebox.mjs --url wss://…/api/bus \
  --item ABC123 --rig pi-jukebox --key … --backend log --sim-sec 20
```

On success it prints `connected as rig "pi-jukebox" … backend:mpd` and the
chain dot goes green. Queue a song from a phone (`/control?item=ABC123`) — it
plays; when it ends the rig reports back and the server advances the queue (or
resumes the house mix). Run it under **systemd** exactly like section 5 (swap the
`ExecStart` line for the `volt-jukebox.mjs` command above).

### What the jukebox rig does on events

- **Self-mute / failover** — identical to a GPIO rig: if another player is
  program, this one goes **silent** (stops the player, ignores commands) and
  resumes automatically when it's elected program again (the server re-sends the
  current track).
- **Item off** stops the player; **item on** resumes (server re-issues the
  track). A **slot pause / slot end does NOT stop the music** — the queue and
  house mode are room-level, not tied to one holder's presence (unlike a GPIO
  rig, which goes pins-safe on pause).
- Reconnects forever with backoff; Ctrl-C stops the player and exits clean.

| Symptom | Cause → fix |
| --- | --- |
| "player offline — not taking requests" on phones | The rig isn't in the item's Outputs chain, or isn't connected. Add it / start it. |
| `mpd not connected` / `mpd greeting timeout` | MPD isn't running or is on another host/port. `sudo systemctl start mpd`, or pass `--mpd-host/--mpd-port`. |
| A queued song never plays | Its catalog **`file`** doesn't match an MPD URI. `mpc listall` and copy the exact relative path into the ops catalog editor. |
| House mode silent | `add ""` (whole library) found nothing — set `music_directory` correctly and `mpc update`, or pass `--house "<folder/playlist>"`. |

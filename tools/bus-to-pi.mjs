#!/usr/bin/env node
/* Volt Control → Raspberry Pi rig bridge.
   Runs on a Pi (or any Node box) and turns an item's live controller presses
   into GPIO / UDP actions. It connects to the item's bus room as an
   AUTHENTICATED RIG, so the server's output election counts this Pi as an
   online output — a TouchDesigner rig is no longer required.

   Usage:
     node tools/bus-to-pi.mjs \
       --url wss://<site>/api/bus \
       --item ABC123 --rig pi-main --key <rigKey from the ops page> \
       --map pins.json [--log-only]

   --url is the bus base (no query); --item/--rig/--key are added as query
   params. Get the rigKey once from control.html's ⚙ ops view → the item's
   "Outputs" chain → "Add rig + get key".

   pins.json — map each controller action to a behavior:
     {
       "pad_up":    { "pin": 17, "mode": "pulse",  "ms": 150 },
       "pad_down":  { "pin": 27, "mode": "pulse",  "ms": 150 },
       "pad_left":  { "pin": 22, "mode": "sweep",  "from": 0, "to": 180, "ms": 700 },
       "pad_right": { "pin": 23, "mode": "sweep",  "from": 180, "to": 0, "ms": 700 },
       "btn_a":     { "pin": 24, "mode": "toggle" },
       "btn_b":     { "pin": 25, "mode": "hold",   "ms": 1000 },
       "btn_c":     { "mode": "udp", "host": "192.168.1.50", "port": 7000, "payload": "fire" }
     }
   behaviors: pulse (on for ms, then off) · toggle (flip and latch) ·
   hold (on for ms, retriggerable) · sweep (software-PWM ramp from→to over ms,
   coarse — see notes) · udp (send a datagram, no GPIO).

   Self-mute contract (redundancy): the server elects ONE program output. On
   every {type:'output'} broadcast this rig checks program.name === --rig; if a
   HIGHER-priority output is program, this Pi goes quiet (ignores controller
   keys, drives pins to a safe state) and un-mutes automatically when it becomes
   program again. It also goes safe on item pause/off/slot_end and output_pause.

   GPIO backend is dependency-free sysfs (/sys/class/gpio). Off a Pi — or with
   --log-only — it prints what it WOULD do so you can test the wiring logic
   anywhere. Reconnects forever; Ctrl-C drives every pin safe and exits clean. */

import { WebSocket } from 'ws';
import dgram from 'node:dgram';
import fs from 'node:fs';

/* ── args ─────────────────────────────────────────────────────────── */
const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i > -1 ? process.argv[i + 1] : d; };
const has = (k) => process.argv.includes('--' + k);
const base = arg('url');
const item = (arg('item', '') || '').toUpperCase();
const rig  = arg('rig');
const key  = arg('key');
const mapFile = arg('map', 'pins.json');
let LOG_ONLY = has('log-only');

if (!base || !item || !rig || !key){
  console.error('usage: node tools/bus-to-pi.mjs --url wss://<site>/api/bus --item CODE --rig NAME --key RIGKEY --map pins.json [--log-only]');
  process.exit(1);
}

let MAP = {};
try { MAP = JSON.parse(fs.readFileSync(mapFile, 'utf8')); }
catch (e){ console.error(`[pins] could not read ${mapFile}: ${e.message}`); process.exit(1); }

// The key rides an x-rig-key HEADER (not the URL) so it never lands in a proxy /
// access log; only the rig NAME is in the query string.
const url = `${base}?channel=${encodeURIComponent('item:' + item)}&rig=${encodeURIComponent(rig)}`;
const wsOpts = { headers: { 'x-rig-key': key } };

/* ── GPIO backend (sysfs, dependency-free; log-only fallback) ─────────
   /sys/class/gpio is deprecated on newer kernels but still the only backend
   that needs zero npm deps and works on Pi OS Lite out of the box. If export
   fails (not a Pi / no permission), we fall back to log-only for that pin. */
const SYSFS = '/sys/class/gpio';
const exported = new Set();
const pinState = new Map();          // pin -> 0|1 (for toggle latch)

function sysfsWrite(file, val){ fs.writeFileSync(file, String(val)); }
function ensurePin(pin){
  if (LOG_ONLY) return false;
  if (exported.has(pin)) return true;
  try {
    if (!fs.existsSync(`${SYSFS}/gpio${pin}`)) sysfsWrite(`${SYSFS}/export`, pin);
    // give udev a beat to chmod the new node, then set direction
    for (let i = 0; i < 20 && !fs.existsSync(`${SYSFS}/gpio${pin}/direction`); i++){ /* spin briefly */ }
    sysfsWrite(`${SYSFS}/gpio${pin}/direction`, 'out');
    sysfsWrite(`${SYSFS}/gpio${pin}/value`, '0');
    exported.add(pin); pinState.set(pin, 0);
    return true;
  } catch (e){
    console.warn(`[gpio] pin ${pin} unavailable (${e.code || e.message}) → log-only for this pin`);
    return false;
  }
}
function write(pin, val){
  pinState.set(pin, val ? 1 : 0);
  if (LOG_ONLY || !ensurePin(pin)){ console.log(`[gpio:log] pin ${pin} → ${val ? 'HIGH' : 'LOW'}`); return; }
  try { sysfsWrite(`${SYSFS}/gpio${pin}/value`, val ? '1' : '0'); }
  catch (e){ console.warn(`[gpio] write pin ${pin} failed: ${e.message}`); }
}

/* ── behaviors ────────────────────────────────────────────────────── */
const timers = new Set();
const after = (ms, fn) => { const t = setTimeout(() => { timers.delete(t); fn(); }, ms); timers.add(t); return t; };
const udp = dgram.createSocket('udp4');

function runBehavior(action){
  if (muted){ return; }                                   // not program → stay quiet
  const b = MAP[action];
  if (!b){ return; }                                      // unmapped action — ignore
  switch (b.mode){
    case 'pulse':
      write(b.pin, 1); after(b.ms ?? 120, () => write(b.pin, 0)); break;
    case 'hold':
      write(b.pin, 1); after(b.ms ?? 800, () => write(b.pin, 0)); break;
    case 'toggle': {
      const next = pinState.get(b.pin) ? 0 : 1; write(b.pin, next); break;
    }
    case 'sweep': sweep(b); break;
    case 'udp': {
      const buf = Buffer.from(String(b.payload ?? action));
      udp.send(buf, b.port ?? 7000, b.host ?? '127.0.0.1');
      console.log(`[udp] ${b.host ?? '127.0.0.1'}:${b.port ?? 7000} ← ${b.payload ?? action}`);
      break;
    }
    default: console.warn(`[pins] unknown mode "${b.mode}" for ${action}`);
  }
}
/* Software PWM servo sweep — COARSE by design: a sysfs bit-bang can't hit a
   clean 50 Hz servo frame, so this steps a duty-cycle approximation. Fine for
   "wiggle a hobby servo on a press"; for smooth/precise motion use a proper
   PWM HAT and the 'udp' mode to talk to it. */
function sweep(b){
  const steps = 18, dur = b.ms ?? 700, from = b.from ?? 0, to = b.to ?? 180;
  let i = 0;
  const tick = () => {
    if (muted) return;
    const frac = i / steps;
    const angle = from + (to - from) * frac;
    const dutyMs = 1 + angle / 180;                       // ~1–2 ms pulse
    write(b.pin, 1); after(dutyMs, () => write(b.pin, 0));
    if (++i <= steps) after(dur / steps, tick);
  };
  tick();
}

function allSafe(reason){
  for (const t of timers) clearTimeout(t);
  timers.clear();
  for (const pin of exported) write(pin, 0);
  for (const [action, b] of Object.entries(MAP)) if (b.pin !== undefined && !exported.has(b.pin)) write(b.pin, 0);
  if (reason) console.log(`[safe] all pins low — ${reason}`);
}

/* ── protocol ─────────────────────────────────────────────────────── */
let muted = false;                                        // true = another output is program

function onOutput(m){
  const wasMuted = muted;
  muted = !!(m.program && m.program.name !== rig);
  if (muted !== wasMuted){
    if (muted) allSafe(`standing by — "${m.program.name}" is program`);
    else console.log(`[output] this rig is PROGRAM now — live`);
  }
}
const SAFE_ITEM_ACTIONS = new Set(['pause', 'off', 'slot_end', 'skip', 'output_pause']);

function route(m){
  if (m.type === 'output' && m.item === item){ onOutput(m); return; }
  if (m.type === 'item' && m.item === item){
    if (SAFE_ITEM_ACTIONS.has(m.action)) allSafe(`item ${m.action}`);
    else if (m.action === 'resume' || m.action === 'on' || m.action === 'output_resume') console.log(`[item] ${m.action}`);
    return;
  }
  if (m.type === 'key' && m.action){ runBehavior(m.action); }
}

/* ── connect (reconnect forever, capped backoff) ─────────────────────── */
let delay = 1000;
(function connect(){
  const ws = new WebSocket(url, wsOpts);
  ws.on('open', () => {
    delay = 1000;
    console.log(`[bus] connected as rig "${rig}" on item ${item}${LOG_ONLY ? ' (LOG-ONLY)' : ''}`);
  });
  ws.on('message', (data) => { try { route(JSON.parse(data)); } catch { /* not JSON */ } });
  ws.on('error', (e) => console.error('[bus]', e.message));
  ws.on('close', (code) => {
    allSafe('disconnected');
    if (code === 4401){ console.error('[bus] rig key rejected (4401) — check --rig / --key against the ops page'); process.exit(1); }
    console.log(`[bus] closed — retrying in ${Math.round(delay / 1000)}s`);
    setTimeout(connect, delay);
    delay = Math.min(delay * 2, 15000);
  });
})();

/* ── clean shutdown ───────────────────────────────────────────────── */
function shutdown(){
  console.log('\n[pi] shutting down — pins safe');
  allSafe('shutdown');
  if (!LOG_ONLY) for (const pin of exported){ try { sysfsWrite(`${SYSFS}/unexport`, pin); } catch { /* best effort */ } }
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

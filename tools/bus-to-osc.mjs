#!/usr/bin/env node
/* Volt Transmission → OSC bridge.
   Subscribes a channel's live-action bus and forwards every action as an
   OSC message over UDP — for VJ software without WebSocket support
   (Resolume, VDMX, MadMapper, chataigne…). TouchDesigner users don't need
   this: the WebSocket DAT consumes the bus natively (see SETUP.md).

   Usage:
     node tools/bus-to-osc.mjs --url "wss://<your-site>/api/bus?channel=volt-fm&as=vj" [--osc 127.0.0.1:7000]

   OSC address layout (trailing string argument = the presser's name):
     /volt/key/scene_1 … scene_4     the Live 1–4 actions
     /volt/key/action_1 … action_3   Q / W / E overlay actions
     /volt/key/trigger               Space
     /volt/key/blackout              (arg 2 = "on" | "off")
     /volt/transport/play|pause      transport intents
   Volt Control item controllers (control.html · pick one per item):
     /volt/key/pad_up|down|left|right   d-pad presses      (d-pad controller)
     /volt/key/btn_a|b|c                A/B/C buttons
     /volt/key/cell_0 … cell_8          3×3 grid triggers  (grid controller)
     /volt/xy            f x, f y       joystick position 0..1 (joystick controller)
     /volt/fader/0 … 3   f v            fader levels 0..1  (faders controller)
     /volt/<type>                    anything else, JSON as the argument

   Map those addresses to triggers in your software's OSC input settings.
   Runs anywhere Node 18+ and this repo's node_modules are available
   (`npm ci` first), reconnects forever. */
import { WebSocket } from 'ws';
import dgram from 'node:dgram';

const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i > -1 ? process.argv[i + 1] : d; };
const url = arg('url');
const [oscHost, oscPort] = arg('osc', '127.0.0.1:7000').split(':');
if (!url){
  console.error('usage: node tools/bus-to-osc.mjs --url "wss://<site>/api/bus?channel=<id>&as=vj" [--osc host:port]');
  process.exit(1);
}

const sock = dgram.createSocket('udp4');
const pad  = (b) => Buffer.concat([b, Buffer.alloc((4 - (b.length % 4)) % 4 || 4)]); // OSC 4-byte align (incl. NUL)
const str  = (s) => pad(Buffer.from(String(s)));
const f32  = (n) => { const b = Buffer.alloc(4); b.writeFloatBE(Number.isFinite(n) ? n : 0); return b; }; // OSC float32

// Mixed-type OSC: a numeric arg is tagged 'f' (float, for the joystick/fader
// value streams), everything else 's' (string). Value args go FIRST so VJ
// software can bind the address straight to the float; the presser name is last.
function osc(address, ...args){
  const tags = ',' + args.map(a => (typeof a === 'number' ? 'f' : 's')).join('');
  const body = args.map(a => (typeof a === 'number' ? f32(a) : str(a)));
  sock.send(Buffer.concat([str(address), str(tags), ...body]), +oscPort, oscHost);
}

function route(m){
  const who = m.user?.name || 'anon';
  if (m.type === 'key' && m.action === 'pad_xy')   osc('/volt/xy', Number(m.x) || 0, Number(m.y) || 0, who);   // joystick position (2 floats 0..1)
  else if (m.type === 'key' && m.action === 'fader') osc('/volt/fader/' + (m.i ?? 0), Number(m.v) || 0, who);  // fader level (float 0..1)
  else if (m.type === 'key' && m.action === 'blackout') osc('/volt/key/blackout', who, m.state || '');
  else if (m.type === 'key')                       osc('/volt/key/' + m.action, who);   // pad_*/btn_*/cell_* triggers
  else if (m.type === 'transport')                 osc('/volt/transport/' + m.action, who);
  else if (m.type === 'item' && m.action)          osc('/volt/item/' + m.action, who, m.item || '');  // item state (pause/off/slot_start/…)
  else                                             osc('/volt/' + m.type, JSON.stringify(m).slice(0, 240));
  console.log(`→ osc://${oscHost}:${oscPort}  ${m.type}${m.action ? '/' + m.action : ''}  (${who})`);
}

(function connect(){
  const ws = new WebSocket(url);
  ws.on('open', () => console.log('[bus] connected —', url));
  ws.on('message', (data) => { try { route(JSON.parse(data)); } catch { /* not JSON — ignore */ } });
  ws.on('error', (e) => console.error('[bus]', e.message));
  ws.on('close', () => { console.log('[bus] closed — retrying in 3 s'); setTimeout(connect, 3000); });
})();

#!/usr/bin/env node
/* Volt Transmission → OSC bridge.
   Subscribes a channel's live-action bus and forwards every action as an
   OSC message over UDP — for VJ software without WebSocket support
   (Resolume, VDMX, MadMapper, chataigne…). TouchDesigner users don't need
   this: the WebSocket DAT consumes the bus natively (see SETUP.md).

   Usage:
     node tools/bus-to-osc.mjs --url "wss://<your-site>/api/bus?channel=volt-fm&as=vj" [--osc 127.0.0.1:7000]

   OSC address layout (one string argument = the presser's name):
     /volt/key/scene_1 … scene_4     the Live 1–4 actions
     /volt/key/action_1 … action_3   Q / W / E overlay actions
     /volt/key/trigger               Space
     /volt/key/blackout              (arg 2 = "on" | "off")
     /volt/transport/play|pause      transport intents
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

function osc(address, ...args){
  const packet = Buffer.concat([
    str(address),
    str(',' + 's'.repeat(args.length)),
    ...args.map(str),
  ]);
  sock.send(packet, +oscPort, oscHost);
}

function route(m){
  const who = m.user?.name || 'anon';
  if (m.type === 'key' && m.action === 'blackout') osc('/volt/key/blackout', who, m.state || '');
  else if (m.type === 'key')                       osc('/volt/key/' + m.action, who);
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

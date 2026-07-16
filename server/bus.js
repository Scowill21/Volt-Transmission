/* Live-action bus (a slice of ROADMAP Tier 4).
   Carries viewer actions to VJ rigs over the plain web — no LAN, no WebRTC
   setup. The console publishes every Live-mode message here (same stamped
   JSON schema as the TD data channel); anything subscribed to the channel
   receives it in real time:

     wss://<site>/api/bus?channel=<channel-id>&as=vj

   VJ side: TouchDesigner's WebSocket DAT consumes it natively; anything
   OSC-based uses tools/bus-to-osc.mjs. Docs: SETUP.md → "Receiving viewer
   actions in your VJ software".

   Also exposed: POST /api/channels/:id/actions — inject a message by HTTP
   (handy for testing a rig without opening the console).

   Notes: fan-out goes to every socket in the channel room except the
   sender (viewers too — Tier 4's pooled FX will consume that). Publishing
   is rate-limited per socket. Subscribing is open for now; role-gating
   lands with the Tier 4 hardening. */
import { WebSocketServer } from 'ws';
import { userFromRequest } from './auth.js';

const rooms = new Map();                       // channelId -> Set<ws>
const RATE = { burst: 20, perSec: 8 };         // per-socket publish budget
const ADMIN_KEY = process.env.ADMIN_KEY || 'dev';   // single source (mirrors index.js)

// Control-plane message types the SERVER originates (paid.js broadcasts
// 'queues'; items.js broadcasts 'item' + 'item_queues' + 'output' election
// results). Clients may never inject them — otherwise any peer could forge
// queue/lock/auction/program state or fake "denied" notices to the room.
const RESERVED = new Set(['queues', 'denied', 'item', 'item_queues', 'output']);
// Types only RIGS (authenticated hardware/renderers) or privileged senders
// may originate — plain viewers' copies are dropped exactly like RESERVED.
const RIG_ONLY = new Set(['score', 'telemetry']);
const PRIVILEGED = new Set(['vj', 'radio', 'admin']);

// Pluggable permission checks for {type:'key'} actions. Each paid product
// registers ONE gate; every key message is offered to every gate, which
// answers null ("not mine — someone else's action/territory") or a verdict
// { ok } / { ok:false, reason }. First verdict wins; no verdict = open.
// Territories are disjoint by construction: paid.js gates scene_1..4 in
// radio-channel rooms and ignores item:-prefixed rooms; items.js gates
// item:-prefixed rooms only (pad_*/btn_* controller input).
const keyGates = [];
export function registerKeyGate(fn){ keyGates.push(fn); }
function gateVerdict(channel, sender, msg){
  for (const gate of keyGates){
    const v = gate(channel, sender, msg);
    if (v) return v;
  }
  return { ok: true };
}

// Rig identity (items.js registers this): rigs — TD bridges, Pis, stage.html
// projectors — connect with &rig=<name>&rigKey=<key> and get presence-tracked
// so the output election knows who's listening. One hook object, same style
// as the gate registry: auth() rules on the key at the upgrade, connected/
// closed/seen feed presence. No hooks registered → rig params are ignored.
let rigHooks = null;
export function registerRigHooks(hooks){ rigHooks = hooks; }

export function publish(channel, msg, exceptWs){
  const room = rooms.get(channel);
  if (!room || !room.size) return 0;
  const data = JSON.stringify(msg);
  let delivered = 0;
  for (const ws of room){
    if (ws === exceptWs || ws.readyState !== ws.OPEN) continue;
    try { ws.send(data); delivered++; } catch { /* dead socket — heartbeat reaps it */ }
  }
  return delivered;
}

export function attachBus(server, app){
  const wss = new WebSocketServer({ server, path: '/api/bus' });

  wss.on('connection', (ws, req) => {
    const q = new URL(req.url, 'http://x').searchParams;
    const channel = (q.get('channel') || '').slice(0, 40);
    if (!channel){ ws.close(4000, 'channel query param required'); return; }
    // Rig identity: validated BEFORE the socket joins the room — a bad key
    // never sees a single message. No rig params → plain viewer, as always.
    const rigName = (q.get('rig') || '').slice(0, 24);
    if (rigName && rigHooks){
      const verdict = rigHooks.auth(channel, rigName, q.get('rigKey') || '');
      if (!verdict || !verdict.ok){ ws.close(4401, 'bad rig key'); return; }
      ws._rig = { name: rigName };
    }
    ws._tokens = RATE.burst;
    ws._alive = true;
    ws._user = undefined;                      // undefined = session bind in flight
    ws._pending = [];                          // messages that arrived before the bind settled
    if (!rooms.has(channel)) rooms.set(channel, new Set());
    rooms.get(channel).add(ws);
    if (ws._rig && rigHooks) rigHooks.connected(channel, ws._rig.name, ws);

    // Bind the VERIFIED account (session cookie on the upgrade request) to the
    // socket — takeover permission checks trust this, never the payload. Until
    // it resolves, gated messages are BUFFERED so a reconnecting slot holder's
    // first keypress isn't wrongly denied during the bind round-trip.
    userFromRequest(req)
      .then(u => { ws._user = u || null; }, () => { ws._user = null; })
      .then(() => { const q = ws._pending || []; ws._pending = null; for (const d of q) handleMessage(d); });

    function handleMessage(data){
      if (ws._tokens <= 0) return;             // over budget — drop silently
      ws._tokens--;
      let msg;
      try { msg = JSON.parse(String(data).slice(0, 4096)); } catch { return; }
      if (!msg || typeof msg.type !== 'string') return;
      if (RESERVED.has(msg.type)) return;      // clients can't forge server control-plane types
      // score/telemetry come from RIGS (or privileged sessions) only — a
      // plain viewer's copy is dropped exactly like a RESERVED forgery.
      if (RIG_ONLY.has(msg.type) && !ws._rig && !(ws._user && PRIVILEGED.has(ws._user.role))) return;
      // Gating: key actions only pass for whoever holds the relevant controls
      // (paid.js: scene_1..4 takeover · items.js: pad/btn in item rooms).
      if (msg.type === 'key'){
        const verdict = gateVerdict(channel, ws, msg);
        if (!verdict.ok){
          try { ws.send(JSON.stringify({ type: 'denied', action: msg.action, reason: verdict.reason })); } catch {}
          return;
        }
      }
      publish(channel, msg, ws);
    }

    ws.on('pong', () => {
      ws._alive = true;
      if (ws._rig && rigHooks) rigHooks.seen(channel, ws._rig.name);
    });
    ws.on('message', (data) => {
      // Still binding? Buffer (bounded by the burst budget) and replay on bind.
      if (ws._user === undefined && ws._pending){
        if (ws._pending.length < RATE.burst) ws._pending.push(data);
        return;
      }
      handleMessage(data);
    });
    ws.on('close', () => {
      const room = rooms.get(channel);
      if (room){ room.delete(ws); if (!room.size) rooms.delete(channel); }
      if (ws._rig && rigHooks) rigHooks.closed(channel, ws._rig.name, ws);
    });
    ws.on('error', () => {});
  });

  // Token refill (1 s) + heartbeat (30 s) — reaps dead sockets so rooms stay clean.
  setInterval(() => {
    for (const room of rooms.values())
      for (const ws of room) ws._tokens = Math.min(RATE.burst, ws._tokens + RATE.perSec);
  }, 1000).unref();
  setInterval(() => {
    for (const room of rooms.values())
      for (const ws of room){
        if (!ws._alive){ ws.terminate(); continue; }
        ws._alive = false;
        try { ws.ping(); } catch { /* closing */ }
      }
  }, 30000).unref();

  // HTTP injection — test a rig without the console: curl -X POST …/actions
  app.post('/api/channels/:id/actions', (req, res) => {
    const msg = req.body;
    if (!msg || typeof msg.type !== 'string')
      return res.status(400).json({ error: 'body must be a message with a "type"' });
    if (RESERVED.has(msg.type))
      return res.status(400).json({ error: 'reserved (server-originated) message type' });
    const admin = req.get('x-admin-key') === ADMIN_KEY;
    // score/telemetry are rig-originated — over HTTP only X-Admin-Key may inject.
    if (RIG_ONLY.has(msg.type) && !admin)
      return res.status(403).json({ error: 'rig-originated message type — rigs or X-Admin-Key only' });
    // Same gates as the socket path (X-Admin-Key acts as privileged).
    if (msg.type === 'key'){
      const verdict = gateVerdict(req.params.id, { _user: admin ? { role: 'admin' } : null }, msg);
      if (!verdict.ok) return res.status(403).json({ error: verdict.reason });
    }
    const delivered = publish(req.params.id, { ts: Date.now(), ...msg }, null);
    res.json({ ok: true, delivered });
  });
}

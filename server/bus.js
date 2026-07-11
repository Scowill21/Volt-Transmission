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

const rooms = new Map();                       // channelId -> Set<ws>
const RATE = { burst: 20, perSec: 8 };         // per-socket publish budget

function publish(channel, msg, exceptWs){
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
    ws._tokens = RATE.burst;
    ws._alive = true;
    if (!rooms.has(channel)) rooms.set(channel, new Set());
    rooms.get(channel).add(ws);

    ws.on('pong', () => { ws._alive = true; });
    ws.on('message', (data) => {
      if (ws._tokens <= 0) return;             // over budget — drop silently
      ws._tokens--;
      let msg;
      try { msg = JSON.parse(String(data).slice(0, 4096)); } catch { return; }
      if (!msg || typeof msg.type !== 'string') return;
      publish(channel, msg, ws);
    });
    ws.on('close', () => {
      const room = rooms.get(channel);
      if (room){ room.delete(ws); if (!room.size) rooms.delete(channel); }
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
    const delivered = publish(req.params.id, { ts: Date.now(), ...msg }, null);
    res.json({ ok: true, delivered });
  });
}

/* Paid features — TEST TIER (the mechanics of Tier 2b + Tier 4's takeover,
   with the payment itself stubbed).

   What's real here and testable end to end:
     · a per-channel CONTROL QUEUE: signed-in users "bid" for the visual
       controls, hold them for a timed slot (countdown), then the next in
       line is promoted automatically
     · PERMISSION ENFORCEMENT: while a slot is active, the bus only passes
       LIVE ACTIONS (keys scene_1..4) from the slot holder — identity comes
       from the VERIFIED session bound to the socket at the WS handshake,
       never from the message payload. vj / radio / admin roles always pass.
     · a per-channel SONG REQUEST queue everyone can see; the host marks
       requests played / refunded from the admin room
     · every change is broadcast to the channel room as {type:'queues'} so
       all consoles update live

   What's stubbed (marked STRIPE below): the money. Each "bid" records its
   price and immediately succeeds. Tier 2b replaces stubPay() with a Stripe
   Checkout session + webhook, and moves the queues into Postgres — the
   endpoint shapes are designed to survive that swap.

   Identity: requests must carry a signed-in session (Tier 2a cookies).
   Where auth ISN'T configured (local JSON-store dev), the documented
   URL-param escape hatch applies instead: the request body may declare
   { user: { id, name } } — that path switches off automatically the
   moment auth is configured, so production always requires real sessions. */
import { publish, registerKeyGate, OUTPUT_CTL } from './bus.js';
import { userFromRequest, devIdentityAllowed } from './auth.js';
import { httpError } from './store.js';

// Stub price list — display-only until Stripe lands (STRIPE: real prices).
export const PAID = {
  controlCents: 500, controlMinutes: 2,   // a control slot: $5 · 2 minutes
  songCents: 300,                         // a song request: $3
};
const PRIVILEGED = new Set(['vj', 'radio', 'admin']);

/* In-memory queues (the 2b swap moves these to Postgres):
   state[channel] = {
     active: { userId, name, startedAt, endsAt } | null,
     queue:  [{ userId, name, cents, minutes, at }],
     songs:  [{ id, title, userId, name, cents, at, status: 'queued'|'played'|'refunded' }],
   } */
const state = new Map();
let songSeq = 1;
const MAX_QUEUE = 25;         // waiting control bidders per channel
const MAX_SONGS = 50;         // queued song requests per channel
const SONG_HISTORY = 200;     // cap total song rows (queued + played/refunded)

// Frozen empty shape for READ-ONLY lookups — peek() never materializes state,
// so the public GET /queues can't be used to grow the Map without bound.
const EMPTY = Object.freeze({ active: null, queue: Object.freeze([]), songs: Object.freeze([]) });
const peek = (id) => state.get(id) || EMPTY;                        // read: never creates
const chan = (id) => {                                             // write: create on demand
  if (!state.has(id)) state.set(id, { active: null, queue: [], songs: [] });
  return state.get(id);
};

function publicQueues(id){
  const c = peek(id);
  const queued = c.songs.filter(s => s.status === 'queued');
  return {
    type: 'queues',
    channel: id,
    prices: { controlCents: PAID.controlCents, controlMinutes: PAID.controlMinutes, songCents: PAID.songCents },
    control: {
      active: c.active ? { userId: c.active.userId, name: c.active.name, endsAt: c.active.endsAt } : null,
      queue: c.queue.map((q, i) => ({ userId: q.userId, name: q.name, position: i + 1 })),
    },
    songs: queued.slice(0, 12).map(s => ({ id: s.id, title: s.title, name: s.name })),
    songsQueued: queued.length,   // full backlog size (the visible list is capped at 12)
    ts: Date.now(),
  };
}
const broadcast = (id) => publish(id, publicQueues(id), null);

function startNext(id){
  const c = chan(id);
  const next = c.queue.shift();
  if (!next){ c.active = null; return; }
  const now = Date.now();
  c.active = { userId: next.userId, name: next.name, startedAt: now, endsAt: now + next.minutes * 60000 };
}

// Expiry tick: promote the next bidder when a slot runs out, and evict any
// channel that has gone fully idle (keeps the Map bounded over a long run).
setInterval(() => {
  for (const [id, c] of state){
    if (c.active && Date.now() >= c.active.endsAt){
      startNext(id);
      broadcast(id);
    }
    if (!c.active && !c.queue.length && !c.songs.some(s => s.status === 'queued')) state.delete(id);
  }
}, 1000).unref();

/* STRIPE: this is the seam. Today a bid "pays" instantly; 2b turns this into
   a Checkout session and the enqueue happens in the webhook on `paid`. */
function stubPay(kind, cents, user){
  return { ok: true, kind, cents, payer: user.id };
}

/* Who is asking? Verified session first; the escape hatch only exists while
   auth is unconfigured (local dev), mirroring IDENTITY layers. Dev identity
   rides the body ({user:{id,name}}) on POSTs, or ?uid=&name= query params on
   GETs (server/shop.js library/streaming). Shared with the shop. */
export async function requester(req){
  const u = await userFromRequest(req);
  if (u) return { id: u.id, name: u.name || u.email, role: u.role, verified: true };
  if (devIdentityAllowed()){
    const b = (req.body && req.body.user)
      || (req.query && req.query.uid && { id: req.query.uid, name: req.query.name || req.query.uid });
    if (b && b.id && b.name)
      return { id: String(b.id).slice(0, 64), name: String(b.name).slice(0, 40), role: 'listener', verified: false };
  }
  return null;
}

/* Cross-product territory guard: item:-prefixed bus rooms belong to the item
   control product (server/items.js). The paid takeover/song endpoints must
   never materialize queue state there, and this gate never rules on them. */
const assertRadioChannel = (id) => {
  if (String(id).startsWith('item:'))
    throw httpError(404, 'item rooms have no radio queues — see /api/items/:code');
};

export function attachPaid(app, requireAdmin){
  /* The permission gate the bus consults for key actions. This gate claims
     ONLY the Live 1–4 actions (scene_1..4) in radio-channel rooms — anything
     else answers null ("not mine"). No active slot → open (today's
     behavior). Active slot → only the slot holder or a privileged verified
     role passes. In unconfigured-auth dev, the payload identity is trusted
     (documented escape hatch). */
  registerKeyGate((channelId, sender, msg) => {
    if (String(channelId).startsWith('item:')) return null;    // items.js territory
    const isScene = /^scene_[1-4]$/.test(msg.action || '');    // pooled-until-purchased overlay
    const isOutputCtl = OUTPUT_CTL.has(msg.type);              // station/channel/mode/transport — operator grade
    if (!isScene && !isOutputCtl) return null;                 // other keys stay open
    const c = state.get(channelId);
    const u = sender && sender._user;
    const priv = !!(u && PRIVILEGED.has(u.role));
    const holds = !!(c && c.active && (
      (u && u.id === c.active.userId) ||
      (devIdentityAllowed() && msg.user && msg.user.id === c.active.userId)));
    // Output-routing controls (which scene/station/channel is up, mode,
    // transport) STEER the live paid output, so only the operator (verified vj/
    // radio/admin) or the current slot holder may originate them — never an
    // anonymous spectator, and never when nobody holds the slot either.
    if (isOutputCtl){
      if (priv || holds) return { ok: true };
      return { ok: false, reason: c && c.active ? `${c.active.name} has the controls` : 'only the controller can steer the output' };
    }
    // scene_1..4 keep the pooled-until-purchased behavior: open with no active
    // slot, holder/privileged-only once someone buys in.
    if (!c || !c.active) return { ok: true };
    if (priv || holds) return { ok: true };
    return { ok: false, reason: `${c.active.name} has the controls` };
  });

  // Everyone can see the queues (the console polls this on channel change).
  app.get('/api/channels/:id/queues', (req, res, next) => {
    try {
      assertRadioChannel(req.params.id);
      res.json(publicQueues(req.params.id));
    } catch (e){ next(e); }
  });

  // Bid for the visual controls (STRIPE seam — stub-pays today).
  app.post('/api/channels/:id/control/request', async (req, res, next) => {
    try {
      assertRadioChannel(req.params.id);
      const who = await requester(req);
      if (!who) throw httpError(401, 'sign in to bid for the controls');
      const c = chan(req.params.id);
      if (c.active && c.active.userId === who.id) throw httpError(409, 'you already have the controls');
      if (c.queue.some(q => q.userId === who.id)) throw httpError(409, 'already in the queue');
      if (c.queue.length >= MAX_QUEUE) throw httpError(429, 'the control queue is full');
      // The slot length is a FIXED product at this price (PAID.controlMinutes).
      // A caller-supplied `minutes` is a local-dev testing knob only — it must
      // never ride into the Stripe seam unpriced, so it's gated on dev intent.
      const minutes = devIdentityAllowed()
        ? Math.min(10, Math.max(.05, +req.body?.minutes || PAID.controlMinutes))
        : PAID.controlMinutes;
      const pay = stubPay('control', PAID.controlCents, who);            // STRIPE: Checkout here
      if (!pay.ok) throw httpError(402, 'payment failed');
      c.queue.push({ userId: who.id, name: who.name, cents: pay.cents, minutes, at: Date.now() });
      if (!c.active) startNext(req.params.id);
      broadcast(req.params.id);
      res.status(201).json(publicQueues(req.params.id));
    } catch (e){ next(e); }
  });

  // Leave the queue / give up an active slot.
  app.post('/api/channels/:id/control/cancel', async (req, res, next) => {
    try {
      assertRadioChannel(req.params.id);
      const who = await requester(req);
      if (!who) throw httpError(401, 'sign in first');
      const c = chan(req.params.id);
      c.queue = c.queue.filter(q => q.userId !== who.id);                // STRIPE: refund here
      if (c.active && c.active.userId === who.id) startNext(req.params.id);
      broadcast(req.params.id);
      res.json(publicQueues(req.params.id));
    } catch (e){ next(e); }
  });

  // Request a song (STRIPE seam — stub-pays today).
  app.post('/api/channels/:id/songs/request', async (req, res, next) => {
    try {
      assertRadioChannel(req.params.id);
      const who = await requester(req);
      if (!who) throw httpError(401, 'sign in to request a song');
      const title = String(req.body?.title || '').trim().slice(0, 120);
      if (!title) throw httpError(400, 'title required');
      const c = chan(req.params.id);
      if (c.songs.filter(s => s.status === 'queued').length >= MAX_SONGS) throw httpError(429, 'queue is full');
      const pay = stubPay('song', PAID.songCents, who);                  // STRIPE: Checkout here
      if (!pay.ok) throw httpError(402, 'payment failed');
      c.songs.push({ id: songSeq++, title, userId: who.id, name: who.name, cents: pay.cents, at: Date.now(), status: 'queued' });
      // Keep the row list bounded — drop the oldest resolved (played/refunded)
      // entries once history exceeds SONG_HISTORY; queued rows are never dropped.
      if (c.songs.length > SONG_HISTORY){
        const keep = c.songs.filter(s => s.status === 'queued');
        const done = c.songs.filter(s => s.status !== 'queued').slice(-(SONG_HISTORY - keep.length));
        c.songs = c.songs.filter(s => keep.includes(s) || done.includes(s));
      }
      broadcast(req.params.id);
      res.status(201).json(publicQueues(req.params.id));
    } catch (e){ next(e); }
  });

  /* Host/ops actions (admin room, X-Admin-Key) */
  app.post('/api/channels/:id/songs/:songId', requireAdmin, (req, res, next) => {
    try {
      assertRadioChannel(req.params.id);
      const action = req.body?.action;
      if (!['played', 'refund'].includes(action)) throw httpError(400, 'action must be played|refund');
      const c = chan(req.params.id);
      const s = c.songs.find(s => s.id === +req.params.songId && s.status === 'queued');
      if (!s) throw httpError(404, 'no such queued request');
      s.status = action === 'played' ? 'played' : 'refunded';            // STRIPE: real refund here
      broadcast(req.params.id);
      res.json(publicQueues(req.params.id));
    } catch (e){ next(e); }
  });
  app.post('/api/channels/:id/control/skip', requireAdmin, (req, res, next) => {
    try {
      assertRadioChannel(req.params.id);
      // STRIPE: ending a PAID slot early is a partial-refund/credit decision —
      // 2b should refund the unused minutes (or comp a fresh slot) here.
      startNext(req.params.id);                                          // end current slot, promote next
      broadcast(req.params.id);
      res.json(publicQueues(req.params.id));
    } catch (e){ next(e); }
  });
}

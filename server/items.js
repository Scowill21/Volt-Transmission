/* Volt Control — pay-to-control ITEMS driven by TouchDesigner (test tier).

   A second product beside the radio console: physical/visual "items" (a lamp
   rig, a robot arm, a projection…) each carry a 6-char code and a QR that
   opens /control?item=<CODE>. Anyone can watch an item's state; a signed-in
   user pays for a timed control slot — buy-now (queue) or soft-close auction
   — and while they hold it, their d-pad/A-B-C presses ride the existing
   action bus (room `item:<CODE>`) to TouchDesigner exactly like the
   console's Live actions do.

   What's real and enforced end to end:
     · durable item definitions (store.js — Postgres or JSON fallback)
     · buy-now queue with auto-promotion + estimated start times
     · soft-close auctions: first bid arms the countdown, a bid in the final
       10 s extends it 10 s, top bid at zero takes the slot; the next round
       arms on the first bid after that slot ends (continuous loop)
     · PERMISSION ENFORCEMENT: the bus gate (bus.js registry) passes pad and
       btn actions in item:<CODE> rooms only for the verified slot holder
       (or verified vj/radio/admin); item off/paused kills all input
     · admin ops: create/edit/delete, skip, pause/resume, on/off — state
       changes are announced to TD as server-only {type:'item'} messages

   What's stubbed (marked STRIPE below): the money — same seams as paid.js.
   Tier 2b: buys become Checkout sessions (enqueue in the webhook), bids
   become authorize-on-bid → capture-winner → release-losers, and this
   runtime state moves to Postgres. Until then queues/auctions are in-memory
   and reset on deploy (documented, same as paid.js). */
import { publish, registerKeyGate } from './bus.js';
import { requester } from './paid.js';
import { devIdentityAllowed } from './auth.js';
import { httpError, ITEM_CODE_RE } from './store.js';

const PRIVILEGED = new Set(['vj', 'radio', 'admin']);
const MAX_QUEUE = 25;              // waiting buyers per item
const MAX_BID_CENTS = 50000;       // hard cap: $500
const SOFT_CLOSE_MS = 10000;       // a bid in the final 10 s extends the clock 10 s
const BID_COOLDOWN_MS = 1500;      // per-user bid rate limit
const PAD_BTN_RE = /^(pad_(up|down|left|right)|btn_[abc])$/;

export const itemRoom = (code) => 'item:' + code;

// Durable item definitions, mirrored in memory so the bus gate (synchronous)
// and public reads never touch the store. Loaded once at attach; every admin
// mutation updates it — the store stays the source of truth across restarts.
const items = new Map();           // code -> item definition

/* Runtime state (in-memory at this tier, paid.js-style):
   state[code] = {
     active:  { userId, name, startedAt, endsAt, paused?, pausedRemainingMs? } | null,
     queue:   [{ userId, name, cents, at }],           // buy-now mode
     auction: { bids: [{ userId, name, cents, at }],   // auction mode
                endsAt } | null,                       // null = no live round
     lastBidAt: Map<userId, ts>,                       // bid rate limit
   } */
const state = new Map();
const EMPTY = Object.freeze({ active: null, queue: Object.freeze([]), auction: null });
const peek = (code) => state.get(code) || EMPTY;                    // read: never creates
const chan = (code) => {                                            // write: create on demand
  if (!state.has(code)) state.set(code, { active: null, queue: [], auction: null, lastBidAt: new Map() });
  return state.get(code);
};

// Codes reach us uppercase or lowercase (typed on phones) — normalize, and
// validate the SHAPE before anything else so junk never probes further.
function normCode(raw){
  const code = String(raw || '').trim().toUpperCase();
  if (!ITEM_CODE_RE.test(code)) throw httpError(404, 'no item with that code');
  return code;
}
function findItem(code){
  const item = items.get(code);
  if (!item) throw httpError(404, 'no item with that code');
  return item;
}

const topBid = (auction) => auction.bids.reduce((a, b) => (b.cents > a.cents ? b : a));

/* The public shape — GET /api/items/:code and every bus state broadcast.
   userIds ride along (like paid.js's queues) so a phone can find itself in
   the queue / on the slot; they're session ids, not secrets. */
function publicItem(item){
  const c = peek(item.code);
  const now = Date.now();
  const activeRemainingMs = c.active
    ? (c.active.paused ? c.active.pausedRemainingMs : Math.max(0, c.active.endsAt - now))
    : 0;
  const auction = c.auction ? (() => {
    const top = topBid(c.auction);
    const rawNext = top.cents + item.minIncrementCents;
    return {
      endsAt: c.auction.endsAt,
      topCents: top.cents, topName: top.name, topUserId: top.userId,
      bidCount: c.auction.bids.length,
      // null = the top bid is at the $500 cap and can't be raised — clients
      // must show "cap reached", never advertise a minimum the validator
      // would reject.
      minNextCents: rawNext > MAX_BID_CENTS ? null : rawNext,
    };
  })() : null;
  return {
    type: 'item_queues', item: item.code,
    name: item.name, description: item.description, mode: item.mode,
    priceCents: item.priceCents, slotSeconds: item.slotSeconds,
    auctionSeconds: item.auctionSeconds, minIncrementCents: item.minIncrementCents,
    status: item.status,
    active: c.active ? {
      userId: c.active.userId, name: c.active.name,
      startedAt: c.active.startedAt, endsAt: c.active.endsAt,
      paused: !!c.active.paused, remainingMs: activeRemainingMs,
    } : null,
    queue: c.queue.map((q, i) => ({
      userId: q.userId, name: q.name, position: i + 1,
      estimatedStartAt: now + activeRemainingMs + i * item.slotSeconds * 1000,
    })),
    auction,
    ts: now,
  };
}
const broadcastState = (item) => publish(itemRoom(item.code), publicItem(item), null);

// Server-only TD announcements ({type:'item'} is RESERVED in bus.js — clients
// can't forge these). The OSC bridge forwards them as /volt/item/<action>.
function announce(code, action, user){
  publish(itemRoom(code), { type: 'item', action, item: code, ...(user ? { user } : {}), ts: Date.now() }, null);
}

function startSlot(item, winner){
  const c = chan(item.code);
  const now = Date.now();
  c.active = { userId: winner.userId, name: winner.name, startedAt: now, endsAt: now + item.slotSeconds * 1000 };
  announce(item.code, 'slot_start', { id: winner.userId, name: winner.name });
}

// End the running slot ('slot_end' on expiry/surrender, 'skip' from admin)
// and promote: buy-now pulls the next buyer; an auction's next round arms on
// the first bid after the slot ends.
function slotOver(item, why){
  const c = chan(item.code);
  if (c.active) announce(item.code, why, { id: c.active.userId, name: c.active.name });
  c.active = null;
  if (item.mode === 'buynow'){
    const next = c.queue.shift();
    if (next) startSlot(item, next);
  }
}

// Expiry tick: end run-out slots, resolve finished auctions, evict idle
// state (keeps the Map bounded, mirrors paid.js).
setInterval(() => {
  const now = Date.now();
  for (const [code, c] of state){
    const item = items.get(code);
    if (!item){ state.delete(code); continue; }         // definition deleted → drop runtime
    if (c.active && !c.active.paused && now >= c.active.endsAt){
      slotOver(item, 'slot_end');
      broadcastState(item);
    }
    if (c.auction && !c.active && now >= c.auction.endsAt){
      const top = topBid(c.auction);
      /* STRIPE: capture the winner's authorization here; release the losers'. */
      c.auction = null;
      announce(code, 'auction_won', { id: top.userId, name: top.name });
      startSlot(item, top);
      broadcastState(item);
    }
    if (!c.active && !c.queue.length && !c.auction) state.delete(code);
  }
}, 1000).unref();

/* STRIPE: the seam, copied from paid.js. Today every buy/bid "pays"
   instantly; 2b swaps this for Checkout / PaymentIntents + webhook. */
function stubPay(kind, cents, user){
  return { ok: true, kind, cents, payer: user.id };
}

export async function attachItems(app, requireAdmin, store){
  for (const item of await store.listItems()) items.set(item.code, item);

  /* The bus gate for item rooms (bus.js registry). This gate OWNS the
     item:-prefixed namespace: it rules on every {type:'key'} message there
     (paid.js's gate answers null for them). Identity = the verified session
     bound to the socket at the WS upgrade (ws._user) — never the payload,
     except the documented dev escape hatch when auth is unconfigured. */
  registerKeyGate((channelId, sender, msg) => {
    if (!String(channelId).startsWith('item:')) return null;      // not our territory
    const u = sender && sender._user;
    if (u && PRIVILEGED.has(u.role)) return { ok: true };         // verified vj/radio/admin
    if (!PAD_BTN_RE.test(msg.action || ''))
      return { ok: false, reason: 'item rooms only carry pad/btn controls' };
    const item = items.get(String(channelId).slice(5));
    if (!item) return { ok: false, reason: 'no such item' };
    if (item.status !== 'on') return { ok: false, reason: 'this item is off' };
    const c = state.get(item.code);
    if (!c || !c.active) return { ok: false, reason: 'no one holds the controls — buy a slot first' };
    if (c.active.paused) return { ok: false, reason: 'the host paused this item' };
    if (u && u.id === c.active.userId) return { ok: true };
    if (devIdentityAllowed() && msg.user && msg.user.id === c.active.userId) return { ok: true };
    return { ok: false, reason: `${c.active.name} has the controls` };
  });

  /* ── public: anyone can watch an item (no account, no state created) ── */
  app.get('/api/items/:code', (req, res, next) => {
    try { res.json(publicItem(findItem(normCode(req.params.code)))); }
    catch (e){ next(e); }
  });

  /* ── signed-in: buy / bid / cancel (verified session; dev hatch only
        while auth is unconfigured — identical posture to paid.js) ── */

  // Buy-now: pay → take the free slot or join the line (STRIPE seam).
  app.post('/api/items/:code/buy', async (req, res, next) => {
    try {
      const who = await requester(req);
      if (!who) throw httpError(401, 'sign in to buy a control slot');
      const item = findItem(normCode(req.params.code));
      if (item.status !== 'on') throw httpError(409, 'this item is off right now');
      if (item.mode !== 'buynow') throw httpError(409, 'this item sells by auction — place a bid instead');
      const c = chan(item.code);
      if (c.active && c.active.userId === who.id) throw httpError(409, 'you already have the controls');
      if (c.queue.some(q => q.userId === who.id)) throw httpError(409, 'you are already in line');
      if (c.queue.length >= MAX_QUEUE) throw httpError(429, 'the line is full — try again soon');
      const pay = stubPay('item_slot', item.priceCents, who);      // STRIPE: Checkout here
      if (!pay.ok) throw httpError(402, 'payment failed');
      if (!c.active) startSlot(item, { userId: who.id, name: who.name, cents: pay.cents });
      else c.queue.push({ userId: who.id, name: who.name, cents: pay.cents, at: Date.now() });
      broadcastState(item);
      res.status(201).json(publicItem(item));
    } catch (e){ next(e); }
  });

  // Auction: validate → (soft-close) arm/extend the countdown → record the
  // bid. STRIPE: 2b authorizes the card per bid here; the tick captures the
  // winner and releases the losers when the round resolves.
  app.post('/api/items/:code/bid', async (req, res, next) => {
    try {
      const who = await requester(req);
      if (!who) throw httpError(401, 'sign in to bid');
      const item = findItem(normCode(req.params.code));
      if (item.status !== 'on') throw httpError(409, 'this item is off right now');
      if (item.mode !== 'auction') throw httpError(409, 'this item sells by buy-now — no auction here');
      const c = chan(item.code);
      if (c.active) throw httpError(409, 'a control slot is running — the next round opens when it ends');
      const cents = req.body?.cents;
      if (!Number.isInteger(cents) || cents <= 0) throw httpError(400, 'cents must be a positive integer');
      if (cents > MAX_BID_CENTS) throw httpError(400, 'max bid is $500');
      const last = c.lastBidAt.get(who.id) || 0;
      const now = Date.now();
      if (now - last < BID_COOLDOWN_MS) throw httpError(429, 'bidding too fast — give it a second');
      if (!c.auction){
        if (cents < item.priceCents) throw httpError(400, `the starting bid is ${item.priceCents} cents`);
      } else {
        const top = topBid(c.auction);
        if (top.userId === who.id) throw httpError(409, 'you already hold the top bid');
        const minNext = top.cents + item.minIncrementCents;
        if (minNext > MAX_BID_CENTS)
          throw httpError(409, 'the top bid is at the $500 cap — this round can only play out');
        if (cents < minNext) throw httpError(400, `the minimum next bid is ${minNext} cents`);
      }
      const pay = stubPay('item_bid', cents, who);                 // STRIPE: authorize here
      if (!pay.ok) throw httpError(402, 'payment failed');
      c.lastBidAt.set(who.id, now);
      if (!c.auction){
        c.auction = { bids: [], endsAt: now + item.auctionSeconds * 1000 };  // first bid arms the round
      } else if (c.auction.endsAt - now <= SOFT_CLOSE_MS){
        c.auction.endsAt += SOFT_CLOSE_MS;                         // soft close: late bid extends
      }
      c.auction.bids.push({ userId: who.id, name: who.name, cents: pay.cents, at: now });
      broadcastState(item);
      res.status(201).json(publicItem(item));
    } catch (e){ next(e); }
  });

  // Leave the line / surrender an active slot (lenient like paid.js —
  // canceling nothing is a 200 no-op). Bids are binding and can't be pulled.
  app.post('/api/items/:code/cancel', async (req, res, next) => {
    try {
      const who = await requester(req);
      if (!who) throw httpError(401, 'sign in first');
      const item = findItem(normCode(req.params.code));
      const c = state.get(item.code);
      if (c){
        c.queue = c.queue.filter(q => q.userId !== who.id);        // STRIPE: refund here
        if (c.active && c.active.userId === who.id) slotOver(item, 'slot_end');
        broadcastState(item);
      }
      res.json(publicItem(item));
    } catch (e){ next(e); }
  });

  /* ── admin (X-Admin-Key, same scheme as the rest of the repo) ── */

  // The dashboard's data: every item + its live state.
  app.get('/api/items', requireAdmin, (req, res) => {
    res.json(Array.from(items.values()).map(publicItem));
  });

  app.post('/api/items', requireAdmin, async (req, res, next) => {
    try {
      const item = await store.createItem(req.body || {});
      items.set(item.code, item);
      res.status(201).json(publicItem(item));
    } catch (e){ next(e); }
  });

  app.patch('/api/items/:code', requireAdmin, async (req, res, next) => {
    try {
      const code = normCode(req.params.code);
      findItem(code);
      // on/off go through POST /state so the change is ANNOUNCED to TD —
      // a silent PATCH would leave rigs believing the old state.
      if (req.body && req.body.status !== undefined)
        throw httpError(400, 'use POST /api/items/:code/state to turn items on/off');
      // A mode flip with live runtime would strand paid buyers (a buy-now
      // queue never promotes under auction rules) — demand a clean slate.
      const cur = items.get(code);
      const c = state.get(code);
      if (req.body && req.body.mode !== undefined && req.body.mode !== cur.mode
          && c && (c.active || c.queue.length || c.auction))
        throw httpError(409, 'end the current slot/queue/round before switching modes');
      const item = await store.updateItem(code, req.body || {});
      items.set(code, item);
      broadcastState(item);                    // open phones re-render prices etc.
      res.json(publicItem(item));
    } catch (e){ next(e); }
  });

  app.delete('/api/items/:code', requireAdmin, async (req, res, next) => {
    try {
      const code = normCode(req.params.code);
      findItem(code);
      await store.deleteItem(code);
      announce(code, 'off');                   // rigs/phones: this item is gone
      items.delete(code);
      state.delete(code);
      res.status(204).end();
    } catch (e){ next(e); }
  });

  // End the current slot early; buy-now promotes the next buyer.
  app.post('/api/items/:code/skip', requireAdmin, (req, res, next) => {
    try {
      const item = findItem(normCode(req.params.code));
      // STRIPE: ending a PAID slot early is a partial-refund/credit decision —
      // 2b refunds the unused seconds (or comps a fresh slot) here, like
      // paid.js's control/skip.
      const c = state.get(item.code);
      if (c && c.active) slotOver(item, 'skip');
      broadcastState(item);
      res.json(publicItem(item));
    } catch (e){ next(e); }
  });

  // pause/resume freeze the holder's remaining time; on/off flip the durable
  // status (off = not sellable + all controller input gated). Every change is
  // announced to TD (WebSocket DAT natively, OSC via the bridge).
  app.post('/api/items/:code/state', requireAdmin, async (req, res, next) => {
    try {
      const code = normCode(req.params.code);
      let item = findItem(code);
      const action = req.body?.action;
      const now = Date.now();
      if (action === 'pause'){
        const c = state.get(code);
        if (!c || !c.active || c.active.paused) throw httpError(409, 'no running slot to pause');
        c.active.paused = true;
        c.active.pausedRemainingMs = Math.max(0, c.active.endsAt - now);
        announce(code, 'pause');
      } else if (action === 'resume'){
        const c = state.get(code);
        if (!c || !c.active || !c.active.paused) throw httpError(409, 'nothing is paused');
        c.active.endsAt = now + c.active.pausedRemainingMs;
        c.active.paused = false;
        delete c.active.pausedRemainingMs;
        announce(code, 'resume');
      } else if (action === 'on' || action === 'off'){
        item = await store.updateItem(code, { status: action });
        items.set(code, item);
        announce(code, action);
      } else throw httpError(400, 'action must be pause|resume|on|off');
      broadcastState(item);
      res.json(publicItem(item));
    } catch (e){ next(e); }
  });
}

// Test hook (.smoke-items.cjs): drive the expiry tick deterministically by
// rewinding endsAt timestamps instead of sleeping through real slots.
export const __test = { state, items };

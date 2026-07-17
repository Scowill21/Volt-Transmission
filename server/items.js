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
import crypto from 'node:crypto';
import { publish, registerKeyGate, registerRigHooks } from './bus.js';
import { requester } from './paid.js';
import { attachJukebox } from './jukebox.js';
import { devIdentityAllowed } from './auth.js';
import { httpError, ITEM_CODE_RE, STAGE_SCENES, DEFAULT_LIMITS } from './store.js';

const PRIVILEGED = new Set(['vj', 'radio', 'admin']);
const MAX_QUEUE = 25;              // waiting buyers per item
const MAX_BID_CENTS = 50000;       // hard cap: $500
const SOFT_CLOSE_MS = 10000;       // a bid in the final 10 s extends the clock 10 s
const BID_COOLDOWN_MS = 1500;      // per-user bid rate limit
const OUTPUT_GRACE_MS = 5000;      // program rig drops → this long to come back before failover
const PAD_BTN_RE = /^(pad_(up|down|left|right)|btn_[abc])$/;

export const itemRoom = (code) => 'item:' + code;
const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');

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

/* ── the OUTPUT layer (redundancy) — kept OUTSIDE `state` on purpose: rig
   presence must survive the idle-state eviction in the tick, and it only
   ever materializes for codes that exist in `items` (rig auth checks the
   durable chain first, so unknown codes can't grow these maps). ──────── */
const rigsOnline = new Map();      // code -> Map<rigName, {since, lastSeen, ws}>
const programs   = new Map();      // code -> {kind,name} | null   (last ELECTED output)
const graceUntil = new Map();      // code -> ts — failover pending while the program rig may return
const duty       = new Map();      // code -> { times:[], last:Map<action,ts> }   (sliding window)

const onlineNames = (code) => [...(rigsOnline.get(code)?.keys() || [])];

/* Election: lowest priority number wins among ONLINE outputs. Scenes are
   browser-rendered and count as always online. An EMPTY chain returns
   undefined — "unconfigured", the pre-redundancy behavior (always sellable,
   nothing tracked). null = a chain exists but every output is down. */
function elect(code){
  const item = items.get(code);
  if (!item || !item.outputs.length) return undefined;
  const online = rigsOnline.get(code);
  for (const o of item.outputs){   // store keeps the chain priority-sorted
    if (o.kind === 'scene') return { kind: 'scene', name: o.name };
    if (online && online.has(o.name)) return { kind: 'rig', name: o.name };
  }
  return null;
}
const outputRank = (item, out) => item.outputs.find(o => o.name === out.name)?.priority ?? 99;

/* Recompute the election and act on the result: broadcast {type:'output'} on
   any change, and clear an output-pause the moment something is listening
   again. Engaging the pause is the TICK's job (it owns the grace window). */
const rosters = new Map();                     // code -> last-broadcast online roster string
function applyElection(item){
  const code = item.code;
  const held = programs.get(code) ?? null;
  let next = elect(code) ?? null;

  // Anti-flap: while a failover grace is pending we HOLD the dropped program,
  // so unrelated churn (a spare joining/leaving, a chain edit) can't promote a
  // backup early and cause an A→B→A flap. We only resolve the grace now if the
  // held program itself returned, or a STRICTLY higher-priority output appeared.
  if (graceUntil.has(code) && held){
    const heldBack = next && next.name === held.name;
    const preempt = next && outputRank(item, next) < outputRank(item, held);
    if (!heldBack && !preempt){ programs.set(code, held); maybeBroadcastRoster(item, held); return held; }
    graceUntil.delete(code);
  } else if (next){
    graceUntil.delete(code);                   // something is listening — no failover pending
  }

  const changed = !programs.has(code)
    || (held === null) !== (next === null)
    || (held && next && (held.kind !== next.kind || held.name !== next.name));
  programs.set(code, next);
  if (changed && item.outputs.length){
    rosters.set(code, onlineNames(code).join(','));
    publish(itemRoom(code), { type: 'output', item: code,
      program: next, online: onlineNames(code), ts: Date.now() }, null);
  } else {
    maybeBroadcastRoster(item, next);          // program same but the online set may have moved
  }
  // Promotion by election (failover/preemption) resyncs the NEW jukebox player:
  // the connect-time resync (rigHooks.connected) only covers a rig JOINING, not
  // one already online being elected program. The rig dedupes an identical play
  // command, so the rare first-connect + first-election overlap is harmless.
  if (changed && next && item.surface === 'jukebox' && jukeboxApi) jukeboxApi.onRigConnect(code);
  const c = state.get(code);
  if (next && c && c.active && c.active.outputPaused){   // output returned mid-slot → resume the clock
    c.active.outputPaused = false;
    thaw(c.active);
    announce(code, 'output_resume');
    broadcastState(item);
  }
  return next;
}
// Keep observers' online roster fresh even when the elected program is unchanged
// (a spare rig toggling): re-broadcast only when the online set actually moved.
function maybeBroadcastRoster(item, program){
  const code = item.code;
  if (!item.outputs.length) return;
  const now = onlineNames(code).join(',');
  if (rosters.get(code) === now) return;
  rosters.set(code, now);
  publish(itemRoom(code), { type: 'output', item: code, program, online: onlineNames(code), ts: Date.now() }, null);
}

/* Duty-cycle guard (William's call: privileged senders BYPASS this — the
   gate returns ok for them before duty is consulted). Sliding one-minute
   window + optional per-action cooldown, per item. */
function dutyAllows(item, action){
  const lim = item.limits || DEFAULT_LIMITS;
  if (!duty.has(item.code)) duty.set(item.code, { times: [], last: new Map() });
  const d = duty.get(item.code);
  const now = Date.now();
  while (d.times.length && d.times[0] <= now - 60000) d.times.shift();
  if (d.times.length >= lim.maxPerMin) return false;
  if (lim.cooldownMs && now - (d.last.get(action) || 0) < lim.cooldownMs) return false;
  d.times.push(now); d.last.set(action, now);
  return true;
}

/* Slot freeze/thaw — ONE clock, TWO independent reasons (admin pause vs
   output gap). The remaining time is captured when the FIRST reason engages
   and the clock restarts only when the LAST one clears, so admin-resume
   during an output gap (or an output returning mid-admin-pause) can never
   double-credit or eat the holder's time. */
const isFrozen = (a) => !!(a.paused || a.outputPaused);
function freeze(a){ if (a.pausedRemainingMs === undefined) a.pausedRemainingMs = Math.max(0, a.endsAt - Date.now()); }
function thaw(a){
  if (isFrozen(a) || a.pausedRemainingMs === undefined) return;   // still frozen by the other reason
  a.endsAt = Date.now() + a.pausedRemainingMs;
  delete a.pausedRemainingMs;
}

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
function publicItem(item, who){
  const c = peek(item.code);
  const now = Date.now();
  const activeRemainingMs = c.active
    ? (isFrozen(c.active) ? c.active.pausedRemainingMs : Math.max(0, c.active.endsAt - now))
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
    name: item.name, description: item.description, instructions: item.instructions, mode: item.mode,
    priceCents: item.priceCents, slotSeconds: item.slotSeconds,
    auctionSeconds: item.auctionSeconds, minIncrementCents: item.minIncrementCents,
    status: item.status,
    // The output layer (additive — phones built before it ignore these).
    // keyHash is deliberately stripped: chain names are public, keys never.
    outputs: item.outputs.map(o => ({ kind: o.kind, name: o.name, priority: o.priority,
                                      ...(o.scene ? { scene: o.scene } : {}) })),
    program: item.outputs.length ? (programs.get(item.code) ?? elect(item.code) ?? null) : null,
    outputsOnline: onlineNames(item.code),
    sellable: item.status === 'on' && (!item.outputs.length || (elect(item.code) ?? null) !== null),
    active: c.active ? {
      userId: c.active.userId, name: c.active.name,
      startedAt: c.active.startedAt, endsAt: c.active.endsAt,
      paused: !!c.active.paused, outputPaused: !!c.active.outputPaused,
      remainingMs: activeRemainingMs,
    } : null,
    queue: c.queue.map((q, i) => ({
      userId: q.userId, name: q.name, position: i + 1,
      estimatedStartAt: now + activeRemainingMs + i * item.slotSeconds * 1000,
    })),
    auction,
    // Control surface. A jukebox item carries its music state (personalized
    // for `who` on the GET path; room-wide on broadcasts).
    surface: item.surface || 'pad',
    ...(item.surface === 'jukebox' && jukeboxApi ? { jukebox: jukeboxApi.publicJukebox(item, who, now) } : {}),
    ts: now,
  };
}
let jukeboxApi = null;            // set by attachJukebox inside attachItems
// The raw jukebox config for the ADMIN dashboard, minus any secret (the
// deferred spotify backend's OAuth token would live under .spotify).
const jukeboxSafeConfig = (jb) => { if (!jb) return null; const { spotify, ...safe } = jb; return safe; };
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
  // Never hand a live clock to a slot that STARTS on a dead output (a buy-now
  // promotion or auction win that lands during an ongoing gap) — freeze it at
  // once so nobody is billed for dead air. applyElection() thaws it when an
  // output returns; the tick's safety net is the belt-and-suspenders.
  if (item.outputs.length && (elect(item.code) ?? null) === null){
    freeze(c.active); c.active.outputPaused = true;
    announce(item.code, 'output_pause');
  }
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

/* Rig liveness sweep: a CLEANLY disconnected rig fires a 'close' at once, but
   a power-yanked / network-partitioned one only stops answering pings. We ping
   rig sockets on a short cadence (each pong refreshes lastSeen via bus.seen)
   and fail out any rig that's gone silent past RIG_STALE_MS — so a hard rig
   death fails over in ~12s instead of waiting ~60s for the bus heartbeat. */
const RIG_STALE_MS = 12000;
setInterval(() => {
  const now = Date.now();
  for (const [code, rigs] of rigsOnline){
    for (const [name, rec] of rigs){
      try { if (rec.ws.readyState === rec.ws.OPEN) rec.ws.ping(); } catch { /* closing */ }
      if (now - rec.lastSeen <= RIG_STALE_MS) continue;
      rigs.delete(name);                       // silent too long → treat as gone
      const item = items.get(code);
      if (!item) continue;
      const prog = programs.get(code);
      if (prog && prog.kind === 'rig' && prog.name === name) graceUntil.set(code, now + OUTPUT_GRACE_MS);
      else applyElection(item);
    }
    if (!rigs.size) rigsOnline.delete(code);
  }
}, 4000).unref();

// Expiry tick: end run-out slots, resolve finished auctions, evict idle
// state (keeps the Map bounded, mirrors paid.js).
setInterval(() => {
  const now = Date.now();
  // Failover grace ran out: the program rig didn't come back — re-elect
  // (promotes the next output or goes dark) and pause any running clock.
  for (const [code, until] of graceUntil){
    if (now < until) continue;
    graceUntil.delete(code);
    const item = items.get(code);
    if (!item) continue;
    const program = applyElection(item);
    const c = state.get(code);
    if (program === null && item.outputs.length && c && c.active && !c.active.outputPaused){
      freeze(c.active);                       // capture remaining BEFORE flagging
      c.active.outputPaused = true;
      announce(code, 'output_pause');
      broadcastState(item);
    }
  }
  for (const [code, c] of state){
    const item = items.get(code);
    if (!item){ state.delete(code); continue; }         // definition deleted → drop runtime
    // Safety net: any running, non-output-paused slot whose configured chain
    // has gone fully dark gets frozen here (catches every start/promote path
    // in one place, so dead air is never billed no matter how the slot began).
    if (c.active && !c.active.outputPaused && item.outputs.length && (elect(code) ?? null) === null){
      freeze(c.active); c.active.outputPaused = true;
      announce(code, 'output_pause');
      broadcastState(item);
    }
    if (c.active && !isFrozen(c.active) && now >= c.active.endsAt){
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
    // Verified vj/radio/admin pass first — including past the duty limits
    // (owner's explicit call: privileged senders bypass the cooldowns).
    if (u && PRIVILEGED.has(u.role)) return { ok: true };
    if (!PAD_BTN_RE.test(msg.action || ''))
      return { ok: false, reason: 'item rooms only carry pad/btn controls' };
    const item = items.get(String(channelId).slice(5));
    if (!item) return { ok: false, reason: 'no such item' };
    if (item.status !== 'on') return { ok: false, reason: 'this item is off' };
    const c = state.get(item.code);
    if (!c || !c.active) return { ok: false, reason: 'no one holds the controls — buy a slot first' };
    if (c.active.paused) return { ok: false, reason: 'the host paused this item' };
    if (c.active.outputPaused) return { ok: false, reason: 'output offline — your clock is paused until it returns' };
    const holds = (u && u.id === c.active.userId)
      || (devIdentityAllowed() && msg.user && msg.user.id === c.active.userId);
    if (!holds) return { ok: false, reason: `${c.active.name} has the controls` };
    if (!dutyAllows(item, msg.action))
      return { ok: false, reason: 'cooling down — this item limits how fast it can be driven' };
    return { ok: true };
  });

  /* Rig identity + presence (bus.js hooks). auth() rules at the WS upgrade:
     the code must exist in the DURABLE chain (unknown codes can never grow
     the presence maps) and the key must hash-match. connect/close drive the
     election; a dropping PROGRAM rig gets a grace window before failover so
     a network blip doesn't flap outputs. */
  const rigHooks = {
    auth(channel, rigName, rigKey){
      if (!String(channel).startsWith('item:')) return { ok: false };
      const item = items.get(String(channel).slice(5));
      if (!item) return { ok: false };
      const entry = item.outputs.find(o => o.kind === 'rig' && o.name === rigName);
      if (!entry) return { ok: false };
      return { ok: sha256(rigKey) === entry.keyHash };
    },
    connected(channel, rigName, ws){
      const code = String(channel).slice(5);
      const item = items.get(code);
      if (!item) return;
      if (!rigsOnline.has(code)) rigsOnline.set(code, new Map());
      // Dedupe: a reconnect-before-close (or a second holder of the same key)
      // would orphan the prior socket — it'd survive a later revoke while still
      // authenticated. Close it now so there is ONLY EVER one socket per rig.
      const prev = rigsOnline.get(code).get(rigName);
      if (prev && prev.ws !== ws){ try { prev.ws.close(4409, 'superseded by a newer connection'); } catch {} }
      const now = Date.now();
      rigsOnline.get(code).set(rigName, { since: now, lastSeen: now, ws });
      applyElection(item);                     // may preempt a lower-priority program immediately
      // A jukebox player rig (re)joining resyncs to current state FROM the server.
      if (item.surface === 'jukebox' && jukeboxApi && (programs.get(code)?.name === rigName)) jukeboxApi.onRigConnect(code);
    },
    closed(channel, rigName, ws){
      const code = String(channel).slice(5);
      const rec = rigsOnline.get(code)?.get(rigName);
      if (!rec || rec.ws !== ws) return;       // an older socket for a reconnected rig — ignore
      rigsOnline.get(code).delete(rigName);
      if (!rigsOnline.get(code).size) rigsOnline.delete(code);
      const item = items.get(code);
      if (!item) return;
      const prog = programs.get(code);
      if (prog && prog.kind === 'rig' && prog.name === rigName){
        graceUntil.set(code, Date.now() + OUTPUT_GRACE_MS);   // was program → grace before failover
      } else {
        applyElection(item);                   // spare rig left — just refresh the online list
      }
    },
    seen(channel, rigName){
      const rec = rigsOnline.get(String(channel).slice(5))?.get(rigName);
      if (rec) rec.lastSeen = Date.now();
    },
    // Rig → server jukebox reports (track_started/ended/position) — bus routes
    // only authenticated-rig / admin messages here; delegate to the jukebox engine.
    message(channel, rigName, msg){
      if (!jukeboxApi || !String(channel).startsWith('item:')) return;
      const code = String(channel).slice(5);
      // Only the ELECTED PROGRAM player reports truth — a spare keyed rig in the
      // chain must not hijack nowPlaying / the skip window / the queue. 'admin'
      // is the privileged inject sender (bus.js), always trusted.
      if (rigName === 'admin' || programs.get(code)?.name === rigName) jukeboxApi.onReport(code, msg);
    },
  };
  registerRigHooks(rigHooks);
  __test.rigHooks = rigHooks;                  // suites drive auth/presence directly

  /* ── the jukebox surface (server/jukebox.js) rides on top of items ── */
  jukeboxApi = attachJukebox(app, requireAdmin, store, {
    items,
    activeSlot: (code) => peek(code).active,
    elect,
    // Jukebox commands are server→RIG only (patrons never consume them) and can
    // carry the catalog `file` / track URI, which publicJukebox deliberately
    // strips from patron payloads. So send them ONLY to the item's authenticated
    // rig sockets — never fan them out to the whole room, where any subscriber
    // would read the file paths. Non-program rigs receive + self-mute, as before.
    command: (code, m) => {
      const rigs = rigsOnline.get(code);
      if (!rigs || !rigs.size) return;
      const data = JSON.stringify({ type: 'jukebox', ...m, item: code, ts: Date.now() });
      for (const rec of rigs.values())
        if (rec.ws && rec.ws.readyState === rec.ws.OPEN){ try { rec.ws.send(data); } catch { /* dead — reaper handles it */ } }
    },
    broadcast: broadcastState,
    announce,
    public: (item, who) => publicItem(item, who),
  });
  __test.jukebox = jukeboxApi.__test;

  /* ── public: anyone can watch an item (no account, no state created) ── */
  app.get('/api/items/:code', async (req, res, next) => {
    try {
      const item = findItem(normCode(req.params.code));
      // personalize a jukebox's skipState for the caller (optional identity)
      const who = item.surface === 'jukebox' ? await requester(req).catch(() => null) : null;
      res.json(publicItem(item, who));
    } catch (e){ next(e); }
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
      // Never sell dead air: a configured chain with nothing online = no sale.
      if (item.outputs.length && (elect(item.code) ?? null) === null)
        throw httpError(503, 'output offline — this item is not selling right now');
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
      // Never sell dead air (same rule as buy-now).
      if (item.outputs.length && (elect(item.code) ?? null) === null)
        throw httpError(503, 'output offline — this item is not selling right now');
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
    // Admin dashboard needs the RAW jukebox config (rule knobs + catalog files)
    // to edit it — publicItem's jukebox block is the patron shape. jukeboxConfig
    // is admin-only (this route is requireAdmin) and carries no secrets (spotify
    // tokens, when that backend lands, are stripped before here).
    res.json(Array.from(items.values()).map(i => ({
      ...publicItem(i),
      ...(i.surface === 'jukebox' ? { jukeboxConfig: jukeboxSafeConfig(i.jukebox) } : {}),
    })));
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
      // Flipping the control surface (pad↔jukebox) with live runtime would
      // strand a slot holder or a music queue — demand a clean slate too.
      if (req.body && req.body.surface !== undefined && req.body.surface !== cur.surface){
        const jkActive = jukeboxApi && cur.surface === 'jukebox' && jukeboxApi.__test.rt.get(code);
        if ((c && (c.active || c.queue.length || c.auction)) || (jkActive && (jkActive.nowPlaying || jkActive.queue.length)))
          throw httpError(409, 'end the current slot/queue before switching the surface');
      }
      const item = await store.updateItem(code, req.body || {});
      if (jukeboxApi && item.surface !== 'jukebox') jukeboxApi.dropRuntime(code);
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
      for (const rec of rigsOnline.get(code)?.values() || []){
        try { rec.ws.close(4401, 'item deleted'); } catch { /* already gone */ }
      }
      rigsOnline.delete(code); programs.delete(code); graceUntil.delete(code); duty.delete(code); rosters.delete(code);
      if (jukeboxApi) jukeboxApi.dropRuntime(code);
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
        freeze(c.active);                      // no-op if already frozen by an output gap
        c.active.paused = true;
        announce(code, 'pause');
      } else if (action === 'resume'){
        const c = state.get(code);
        if (!c || !c.active || !c.active.paused) throw httpError(409, 'nothing is paused');
        c.active.paused = false;
        thaw(c.active);                        // stays frozen if an output gap still holds it
        announce(code, 'resume');
      } else if (action === 'on' || action === 'off'){
        item = await store.updateItem(code, { status: action });
        items.set(code, item);
        announce(code, action);
        // A jukebox player stops on the 'off' announce; on 'on' it needs the
        // current track (or house) re-issued so music resumes without waiting
        // for the next request. onRigConnect does exactly that and no-ops when
        // the item isn't a jukebox / isn't back on.
        if (action === 'on' && item.surface === 'jukebox' && jukeboxApi) jukeboxApi.onRigConnect(code);
      } else throw httpError(400, 'action must be pause|resume|on|off');
      broadcastState(item);
      res.json(publicItem(item));
    } catch (e){ next(e); }
  });

  /* ── admin: the OUTPUT CHAIN (ordered failover list) ──────────────
     Rig entries get a server-generated key: the PLAINTEXT is returned once
     from create and never again — only its sha256 lands in the store. */
  app.post('/api/items/:code/outputs', requireAdmin, async (req, res, next) => {
    try {
      const code = normCode(req.params.code);
      const item = findItem(code);
      const { kind, name, priority, scene } = req.body || {};
      const entry = { kind, name, priority: priority ?? (item.outputs.length + 1), scene };
      let rigKey;
      if (kind === 'rig'){
        rigKey = crypto.randomBytes(24).toString('base64url');
        entry.keyHash = sha256(rigKey);
      }
      const updated = await store.updateItemOutputs(code, [...item.outputs, entry]);
      items.set(code, updated);
      applyElection(updated);
      broadcastState(updated);
      res.status(201).json({ ...(rigKey ? { rigKey } : {}), item: publicItem(updated) });
    } catch (e){ next(e); }
  });

  app.patch('/api/items/:code/outputs/:name', requireAdmin, async (req, res, next) => {
    try {
      const code = normCode(req.params.code);
      const item = findItem(code);
      const cur = item.outputs.find(o => o.name === req.params.name);
      if (!cur) throw httpError(404, 'no output with that name');
      const next_ = item.outputs.map(o => o !== cur ? o : {
        ...o,
        ...(req.body?.priority !== undefined ? { priority: req.body.priority } : {}),
        ...(o.kind === 'scene' && req.body?.scene !== undefined ? { scene: req.body.scene } : {}),
      });
      const updated = await store.updateItemOutputs(code, next_);
      items.set(code, updated);
      applyElection(updated);
      broadcastState(updated);
      res.json(publicItem(updated));
    } catch (e){ next(e); }
  });

  app.delete('/api/items/:code/outputs/:name', requireAdmin, async (req, res, next) => {
    try {
      const code = normCode(req.params.code);
      const item = findItem(code);
      if (!item.outputs.some(o => o.name === req.params.name)) throw httpError(404, 'no output with that name');
      const updated = await store.updateItemOutputs(code, item.outputs.filter(o => o.name !== req.params.name));
      items.set(code, updated);
      // Revoke = the rig's socket dies with its key.
      const rec = rigsOnline.get(code)?.get(req.params.name);
      if (rec){
        try { rec.ws.close(4401, 'output revoked'); } catch { /* closing */ }
        rigsOnline.get(code).delete(req.params.name);
        if (!rigsOnline.get(code).size) rigsOnline.delete(code);
      }
      applyElection(updated);
      broadcastState(updated);
      res.json(publicItem(updated));
    } catch (e){ next(e); }
  });
}

// Test hook (.smoke-items.cjs): drive the expiry tick deterministically by
// rewinding endsAt/graceUntil timestamps instead of sleeping through them.
export const __test = { state, items, rigsOnline, programs, graceUntil, duty, elect, applyElection, sha256 };

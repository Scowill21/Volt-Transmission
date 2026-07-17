/* Volt JUKEBOX — audio as a control surface (test tier).

   An item with surface:'jukebox' turns its `item:<CODE>` room into a venue
   music controller: paid patrons queue songs from an admin-curated catalog,
   skip (bounded by admin windows), or bid for the next play. A rig (Raspberry
   Pi running tools/volt-jukebox.mjs, MPD or log backend) is the PLAYER; the
   SERVER is the sole authority for the queue, the rules, the money, and what
   plays next. The rig only receives commands and reports reality back; on
   reconnect it resyncs FROM the server, never the reverse.

   Two monetization postures (jukebox.monetization):
     · 'controller_slot' (default) — the item sells a TIMED CONTROL SLOT with
       the exact shipped items machinery (buy-now/auction); while you hold it,
       skip/queue are YOURS — no per-action charge — but every admin window/cap
       still binds you (a slot buys the controls, not immunity from the rules).
     · 'per_action' — no slots; each queue-add/skip is individually priced, with
       optional bid-for-next-play.

   Money is stubbed at STRIPE: seams (same tier as items.js/paid.js); runtime
   (nowPlaying, queue, skip windows, bid round) is in-memory and resets on
   deploy. Licensing reality: see PROMPT-JUKEBOX.md §8 / SETUP.md — the
   'sell the controller' posture on the venue's own catalog is the pilot path. */
import { requester } from './paid.js';
import { devIdentityAllowed } from './auth.js';
import { httpError } from './store.js';

const MAX_BID_CENTS = 50000;       // $500 hard cap, mirrors items.js
const BID_COOLDOWN_MS = 1500;
const PRIVILEGED = new Set(['vj', 'radio', 'admin']);

/* Runtime state per jukebox item (in-memory):
   js = { nowPlaying, queue[], skips{perUser:Map, global:[]}, recent:Map,
          bidRound{bids[],songId}|null, lastBidAt:Map } */
const rt = new Map();
const EMPTY = Object.freeze({ nowPlaying: null, queue: Object.freeze([]), bidRound: null });
const peek = (code) => rt.get(code) || EMPTY;
function jchan(code){
  if (!rt.has(code)) rt.set(code, {
    nowPlaying: null, queue: [], skips: { perUser: new Map(), global: [] },
    recent: new Map(), bidRound: null, lastBidAt: new Map(),
  });
  return rt.get(code);
}

const song = (item, songId) => item.jukebox.catalog.find(s => s.id === songId);
const elapsedSec = (np, now) => (np ? Math.max(0, Math.floor((now - np.startedAt) / 1000)) : 0);
const durOf = (item, np) => np && (np.durationSec || song(item, np.songId)?.durationSec || 0);

// Sliding-window prune: drop timestamps older than the window (called on read
// AND write so counters never leak across window boundaries).
function pruneSkips(js, jb, now){
  const uMs = jb.skip.perUser.windowMin * 60000, gMs = jb.skip.global.windowMin * 60000;
  js.skips.global = js.skips.global.filter(t => t > now - gMs);
  for (const [uid, arr] of js.skips.perUser){
    const kept = arr.filter(t => t > now - uMs);
    if (kept.length) js.skips.perUser.set(uid, kept); else js.skips.perUser.delete(uid);
  }
}
const userSkips = (js, uid) => (js.skips.perUser.get(uid) || []).length;

/* The skip decision — the timing heart. Returns the full state a phone needs
   to render a live skip button, plus {ok, reason} for the endpoint. */
function skipEligibility(item, js, uid, now){
  const jb = item.jukebox, np = js.nowPlaying;
  pruneSkips(js, jb, now);
  const yourLeft = Math.max(0, jb.skip.perUser.max - userSkips(js, uid));
  const roomLeft = Math.max(0, jb.skip.global.max - js.skips.global.length);
  if (!np) return { ok: false, reason: 'nothing is playing', yourLeft, roomLeft };
  const el = elapsedSec(np, now);
  const minPlayUntil = np.startedAt + jb.skip.minPlaySec * 1000;
  // absolute floor: a song always gets minPlaySec, no matter what
  if (el < jb.skip.minPlaySec)
    return { ok: false, reason: `this song is protected for ${jb.skip.minPlaySec - el}s more`, yourLeft, roomLeft, minPlayUntil };
  // window: unless mid-song skips are allowed, only skippable within onlyBeforeSec
  let skippableUntil = null;
  if (!jb.skip.allowMidSong){
    skippableUntil = np.startedAt + jb.skip.onlyBeforeSec * 1000;
    if (el > jb.skip.onlyBeforeSec)
      return { ok: false, reason: 'too late to skip this one', yourLeft, roomLeft, skippableUntil };
  }
  // A cap of 0 means NO skips (yourLeft/roomLeft are already 0) — the intuitive
  // reading, not "unlimited". For effectively-unlimited, set a high cap.
  if (yourLeft <= 0)
    return { ok: false, reason: jb.skip.perUser.max === 0 ? 'skips are off here' : 'you have used your skips for now', yourLeft, roomLeft, skippableUntil };
  if (roomLeft <= 0)
    return { ok: false, reason: jb.skip.global.max === 0 ? 'skips are off here' : 'the room has hit its skip limit for now', yourLeft, roomLeft, skippableUntil };
  return { ok: true, yourLeft, roomLeft, skippableUntil, minPlayUntil };
}

function queueEligibility(item, js, songId, uid, now){
  const jb = item.jukebox;
  if (!song(item, songId)) return { ok: false, reason: 'that song is not in the catalog' };
  if (js.queue.length >= jb.queueRules.maxLen) return { ok: false, reason: 'the queue is full' };
  if (js.queue.filter(q => q.byId === uid).length >= jb.queueRules.maxPerUser)
    return { ok: false, reason: 'you already have the max songs queued' };
  // No duplicate of a song already queued or playing — ALWAYS, independent of the
  // no-repeat WINDOW below. Without this, noRepeatMin=0 would admit two paid
  // copies of one songId that track_started's by-songId filter then deletes
  // TOGETHER, so the second buyer pays and never plays.
  if (js.queue.some(q => q.songId === songId)) return { ok: false, reason: 'that song is already in the queue' };
  if (js.nowPlaying && js.nowPlaying.songId === songId) return { ok: false, reason: 'that song is playing now' };
  const noRepeatMs = jb.queueRules.noRepeatMin * 60000;
  if (noRepeatMs){
    const recentAt = js.recent.get(songId);
    if (recentAt && recentAt > now - noRepeatMs)
      return { ok: false, reason: 'that song was played too recently — try another' };
  }
  return { ok: true };
}

/* ── public state (item_queues extension). `who` personalizes the caller's
   skip count on the GET path; broadcasts (who=null) carry room-wide only. ── */
export function publicJukebox(item, who, now = Date.now()){
  const js = peek(item.code), jb = item.jukebox;
  const np = js.nowPlaying;
  const skipState = (() => {
    const uid = who ? who.id : null;
    const jsw = rt.get(item.code);
    if (!jsw) return { roomLeft: jb.skip.global.max, skippableUntil: null };
    pruneSkips(jsw, jb, now);   // so room-wide broadcasts (uid=null) report a fresh roomLeft too
    const e = uid ? skipEligibility(item, jsw, uid, now) : { roomLeft: Math.max(0, jb.skip.global.max - jsw.skips.global.length) };
    return {
      canSkip: uid ? e.ok : undefined, reason: uid ? (e.ok ? null : e.reason) : undefined,
      yourLeft: uid ? e.yourLeft : undefined,
      roomLeft: e.roomLeft,
      skippableUntil: e.skippableUntil ?? null, minPlayUntil: e.minPlayUntil ?? null,
    };
  })();
  const bidRound = js.bidRound ? (() => {
    const top = js.bidRound.bids.reduce((a, b) => (b.cents > a.cents ? b : a), { cents: 0 });
    const raw = top.cents + 50;
    return { topCents: top.cents, topName: top.name || null, topUserId: top.userId || null,
      bidCount: js.bidRound.bids.length, closesAt: np ? np.startedAt + durOf(item, np) * 1000 : null,
      minNextCents: raw > MAX_BID_CENTS ? null : raw };
  })() : null;
  return {
    surface: 'jukebox',
    monetization: jb.monetization, mode: jb.mode, backend: jb.backend,
    catalog: jb.catalog.map(s => ({ id: s.id, title: s.title, artist: s.artist, durationSec: s.durationSec })),
    prices: { queueCents: jb.queuePriceCents, playNextCents: jb.playNextPriceCents, skipCents: jb.skip.priceCents },
    houseMode: jb.houseMode,
    nowPlaying: np ? { songId: np.songId, title: np.title, artist: song(item, np.songId)?.artist || null,
      startedAt: np.startedAt, durationSec: durOf(item, np), elapsedSec: elapsedSec(np, now) } : null,
    queue: js.queue.slice(0, 12).map((q, i) => ({ position: i + 1, songId: q.songId, title: q.title,
      byName: q.byName, byId: q.byId, playNext: !!q.playNext })),
    queueLen: js.queue.length,
    skipState, bidRound,
  };
}

/* ── the player state machine (driven by rig reports) ──
   The rig owns audio; the server owns "what should be playing". These functions
   send commands (via ctx.command) and advance the queue on track boundaries. */
export function attachJukebox(app, requireAdmin, store, ctx){
  // ctx = { items, activeSlot, elect, command, broadcast, announce }
  const isJukebox = (code) => { const it = ctx.items.get(code); return it && it.surface === 'jukebox' ? it : null; };
  const cmd = (item, m) => ctx.command(item.code, m);
  const bcast = (item) => ctx.broadcast(item);

  function startPlay(item, songId){
    const s = song(item, songId);
    if (!s) return advance(item);          // vanished from catalog — skip it
    cmd(item, { action: 'play', song: { id: s.id, file: s.file, title: s.title } });
    // nowPlaying becomes truthful when the rig reports track_started; until then
    // we optimistically set it so the UI/queue update immediately.
    const js = jchan(item.code);
    js.nowPlaying = { songId: s.id, title: s.title, startedAt: Date.now(), durationSec: s.durationSec || 0 };
    js.recent.set(s.id, Date.now());
  }
  // Pull the next thing to play: a bid winner, else the queue head, else house/stop.
  function advance(item){
    const js = jchan(item.code);
    if (js.bidRound && js.bidRound.bids.length){          // bid mode: winner of the round that just closed
      const top = js.bidRound.bids.reduce((a, b) => (b.cents > a.cents ? b : a));
      /* STRIPE: capture the winning bid here; release the losers'. */
      js.bidRound = null;
      ctx.announce(item.code, 'auction_won', { id: top.userId, name: top.name });
      return startPlay(item, top.songId);
    }
    const next = js.queue.shift();
    if (next) return startPlay(item, next.songId);
    js.nowPlaying = null;
    if (item.jukebox.houseMode && item.status === 'on') cmd(item, { action: 'house', on: true });
    else cmd(item, { action: 'stop' });
  }

  // Rig → server reports (bus RIG_REPORT, server-consumed). This is TRUTH.
  function onReport(code, msg){
    const item = isJukebox(code);
    if (!item) return;
    const js = jchan(code);
    if (msg.type === 'track_started' && msg.songId){
      const s = song(item, msg.songId);
      js.nowPlaying = { songId: msg.songId, title: s ? s.title : (msg.title || msg.songId),
        startedAt: Date.now(), durationSec: msg.durationSec || (s && s.durationSec) || 0 };
      if (s && msg.durationSec && !s.durationSec) s.durationSec = msg.durationSec;   // backfill real duration
      js.recent.set(msg.songId, Date.now());
      js.queue = js.queue.filter(q => q.songId !== msg.songId || q.byId === '__house');
      bcast(item);
    } else if (msg.type === 'track_ended'){
      if (!js.nowPlaying) return;                                    // nothing playing — ignore a stray/duplicate end
      if (msg.songId && js.nowPlaying.songId !== msg.songId) return; // stale end for a prior track
      js.nowPlaying = null;
      advance(item);
      bcast(item);
    } else if (msg.type === 'position' && js.nowPlaying && msg.songId === js.nowPlaying.songId){
      // reconcile the clock to the player's truth (drift correction); no broadcast
      // (chatty). Clamp to [0, duration] so a bogus/negative sec can't push
      // startedAt into the future (song never skippable) or the deep past.
      if (Number.isFinite(msg.sec) && msg.sec >= 0){
        const dur = durOf(item, js.nowPlaying) || Infinity;
        js.nowPlaying.startedAt = Date.now() - Math.min(msg.sec, dur) * 1000;
      }
    }
  }
  // On (re)connect of the program player rig: resync it to current state.
  function onRigConnect(code){
    const item = isJukebox(code);
    if (!item) return;
    const js = peek(code);
    if (js.nowPlaying) cmd(item, { action: 'play', song: { id: js.nowPlaying.songId, file: song(item, js.nowPlaying.songId)?.file, title: js.nowPlaying.title } });
    else if (item.jukebox.houseMode && item.status === 'on') cmd(item, { action: 'house', on: true });
  }

  /* Identity FIRST — resolved before the item is even looked up, so an
     unauthenticated caller 401s without learning whether a code exists (matches
     the buy/bid posture) and the dev payload-identity hatch stays fail-closed
     on a configured deploy whose DB is down. */
  async function requireWho(req){
    const who = await requester(req);
    if (!who) throw httpError(401, 'sign in first');
    return who;
  }
  /* Then the item-specific gate: controller_slot → the slot holder (or
     privileged); per_action → any signed-in payer (already proven above). */
  function assertActor(item, who, req){
    if (item.jukebox.monetization === 'controller_slot'){
      const active = ctx.activeSlot(item.code);
      const holds = (active && active.userId === who.id) || PRIVILEGED.has(who.role)
        || (devIdentityAllowed() && active && req.body?.user && req.body.user.id === active.userId);
      if (!holds) throw httpError(403, active ? `${active.name} holds the controls — buy the slot to drive` : 'buy the control slot first');
    }
  }
  const guardSellable = (item) => {   // never sell dead air: configured player chain, none online
    if (item.outputs.length && (ctx.elect(item.code) ?? null) === null)
      throw httpError(503, 'the player is offline — not taking requests right now');
    if (item.status !== 'on') throw httpError(409, 'this jukebox is off right now');
  };

  /* ── endpoints ── */
  app.post('/api/items/:code/jukebox/queue', async (req, res, next) => {
    try {
      const who = await requireWho(req);
      const item = requireJukebox(req);
      guardSellable(item);
      assertActor(item, who, req);
      const js = jchan(item.code);
      const now = Date.now();
      const songId = String(req.body?.songId || '');
      const elig = queueEligibility(item, js, songId, who.id, now);
      if (!elig.ok) throw httpError(409, elig.reason);
      const playNext = !!req.body?.playNext && item.jukebox.playNextPriceCents != null;
      const cents = item.jukebox.monetization === 'per_action'
        ? (playNext ? item.jukebox.playNextPriceCents : item.jukebox.queuePriceCents) : 0;
      /* STRIPE: charge `cents` here (per_action); controller_slot is holder-gated, no charge. */
      const entry = { songId, title: song(item, songId).title, byId: who.id, byName: who.name, cents, at: now, playNext };
      if (playNext){                     // insert after other play-next buys, never above them (fairness)
        let i = 0; while (i < js.queue.length && js.queue[i].playNext) i++;
        js.queue.splice(i, 0, entry);
      } else js.queue.push(entry);
      if (!js.nowPlaying) advance(item);  // idle → start immediately
      bcast(item);
      res.status(201).json(ctx.public(item, who));
    } catch (e){ next(e); }
  });

  app.post('/api/items/:code/jukebox/skip', async (req, res, next) => {
    try {
      const who = await requireWho(req);
      const item = requireJukebox(req);
      guardSellable(item);
      assertActor(item, who, req);
      const js = jchan(item.code);
      const now = Date.now();
      if (!js.nowPlaying) throw httpError(409, 'nothing is playing');
      if (req.body?.songId && req.body.songId !== js.nowPlaying.songId)
        throw httpError(409, 'that song already changed');   // stale skip → no charge
      // One skip per track: a second request before the rig round-trips its
      // track_ended would otherwise pass again (nowPlaying is unchanged) and
      // DOUBLE-decrement both quotas for a single actual skip. The flag lives on
      // nowPlaying, so it clears automatically when the next track starts.
      if (js.nowPlaying.skipRequested) throw httpError(409, 'this song is already being skipped');
      const elig = skipEligibility(item, js, who.id, now);
      if (!elig.ok) throw httpError(409, elig.reason);
      /* STRIPE: charge skip.priceCents here (per_action); slot mode is holder-gated. */
      js.nowPlaying.skipRequested = true;
      js.skips.global.push(now);
      js.skips.perUser.set(who.id, [...(js.skips.perUser.get(who.id) || []), now]);
      cmd(item, { action: 'skip' });     // the rig skips → reports track_ended → advance()
      ctx.announce(item.code, 'skip', { id: who.id, name: who.name });
      bcast(item);
      res.json(ctx.public(item, who));
    } catch (e){ next(e); }
  });

  app.post('/api/items/:code/jukebox/bid', async (req, res, next) => {
    try {
      const who = await requireWho(req);
      const item = requireJukebox(req);
      if (item.jukebox.mode !== 'bid') throw httpError(409, 'this jukebox is not in bid mode');
      guardSellable(item);
      assertActor(item, who, req);
      const js = jchan(item.code);
      const now = Date.now();
      if (!js.nowPlaying) throw httpError(409, 'wait for a song to be playing to bid on the next one');
      const songId = String(req.body?.songId || '');
      if (!song(item, songId)) throw httpError(400, 'that song is not in the catalog');
      const cents = req.body?.cents;
      if (!Number.isInteger(cents) || cents <= 0) throw httpError(400, 'cents must be a positive integer');
      if (cents > MAX_BID_CENTS) throw httpError(400, 'max bid is $500');
      if (now - (js.lastBidAt.get(who.id) || 0) < BID_COOLDOWN_MS) throw httpError(429, 'bidding too fast');
      if (!js.bidRound) js.bidRound = { bids: [], songId: null };
      const top = js.bidRound.bids.reduce((a, b) => (b.cents > a.cents ? b : a), { cents: 0, userId: null });
      if (top.userId === who.id) throw httpError(409, 'you already hold the top bid');
      const minNext = js.bidRound.bids.length ? top.cents + 50 : 1;
      if (minNext > MAX_BID_CENTS) throw httpError(409, 'the top bid is at the $500 cap');
      if (cents < minNext) throw httpError(400, `the minimum next bid is ${minNext} cents`);
      /* STRIPE: authorize the bid here; capture the winner / release losers when the round closes on track_ended. */
      js.lastBidAt.set(who.id, now);
      js.bidRound.bids.push({ userId: who.id, name: who.name, cents, songId, at: now });
      bcast(item);
      res.status(201).json(ctx.public(item, who));
    } catch (e){ next(e); }
  });

  /* ── admin live-view actions (X-Admin-Key) ── */
  app.post('/api/items/:code/jukebox/admin', requireAdmin, (req, res, next) => {
    try {
      const item = requireJukebox(req);
      const js = jchan(item.code);
      const action = req.body?.action;
      if (action === 'force_skip'){ if (js.nowPlaying){ js.nowPlaying.skipRequested = true; cmd(item, { action: 'skip' }); } ctx.announce(item.code, 'skip'); }
      else if (action === 'clear_queue'){ js.queue = []; /* STRIPE: refund cleared per_action buys here */ }
      else if (action === 'house'){ item.jukebox.houseMode = !!req.body.on; if (!js.nowPlaying) advance(item); }
      else if (action === 'remove'){                        // remove one queue row (vibe veto)
        const idx = js.queue.findIndex(q => q.songId === req.body.songId && q.byId === req.body.byId);
        if (idx >= 0) js.queue.splice(idx, 1);              /* STRIPE: refund that buyer here */
      } else throw httpError(400, 'action must be force_skip|clear_queue|house|remove');
      bcast(item);
      res.json(ctx.public(item));
    } catch (e){ next(e); }
  });

  function requireJukebox(req){
    const code = String(req.params.code || '').trim().toUpperCase();
    const item = ctx.items.get(code);
    if (!item) throw httpError(404, 'no item with that code');
    if (item.surface !== 'jukebox') throw httpError(409, 'this item is not a jukebox');
    return item;
  }
  // A jukebox item switched off / deleted: drop its runtime.
  function dropRuntime(code){ rt.delete(code); }

  return { onReport, onRigConnect, publicJukebox, dropRuntime, __test: { rt, jchan, skipEligibility, queueEligibility, advance } };
}

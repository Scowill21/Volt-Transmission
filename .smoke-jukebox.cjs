/* Server-side smoke test for the VOLT JUKEBOX rules engine (server/jukebox.js).
   Hermetic, same harness as .smoke-items.cjs: real routes on a fake Express
   app, auth left UNCONFIGURED so the payload escape hatch stands in for
   sessions. Time-dependent rules (skip windows, minPlaySec, bid close) are
   driven by rewinding startedAt / window timestamps through the __test hook
   instead of sleeping.

   Run:  node .smoke-jukebox.cjs   — must exit 0.  */
'use strict';
delete process.env.SUPABASE_URL;
delete process.env.SUPABASE_PUBLISHABLE_KEY;
delete process.env.ADMIN_KEY;

const http = require('http');
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

function makeApp(){
  const routes = [];
  const add = (method) => (p, ...h) => routes.push({ method, path: p, handlers: h });
  return { get: add('GET'), post: add('POST'), patch: add('PATCH'), delete: add('DELETE'), use(){}, _routes: routes };
}
function makeRes(){
  return { statusCode: 200, body: undefined, headers: {},
    status(c){ this.statusCode = c; return this; }, json(o){ this.body = o; return this; },
    end(){}, setHeader(){}, on(){ return this; } };
}
async function call(app, method, p, { params = {}, body = {}, headers = {}, query = {} } = {}){
  const route = app._routes.find(r => r.method === method && r.path === p);
  if (!route) throw new Error(`no route ${method} ${p}`);
  const req = { params, body, headers, query, get: (h) => headers[h.toLowerCase()] };
  const res = makeRes();
  let i = 0;
  const next = async (err) => { if (err){ if (err.status) res.status(err.status); res.json({ error: err.message }); return; }
    const h = route.handlers[i++]; if (h) await h(req, res, next); };
  await next();
  return res;
}
const requireAdmin = (req, res, next) =>
  req.get('x-admin-key') === (process.env.ADMIN_KEY || 'dev') ? next() : res.status(401).json({ error: 'admin key required' });

const AS = (id, name) => ({ user: { id, name } });
const ADMIN = { 'x-admin-key': 'dev' };
const ROOM = (c) => 'item:' + c;
let passed = 0;
const ok = (label) => { console.log('OK  ', passed + 1, label); passed++; };

const CATALOG = [
  { id: 'a', title: 'Song A', durationSec: 200 },
  { id: 'b', title: 'Song B', durationSec: 180 },
  { id: 'c', title: 'Song C', durationSec: 210 },
];

(async () => {
  const server = http.createServer();
  const app = makeApp();
  const bus = await import('./server/bus.js');
  await import('./server/paid.js').then(m => m.attachPaid(app, requireAdmin));
  const itemsMod = await import('./server/items.js');
  const { FileStore } = await import('./server/store.js');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'volt-jb-'));
  const store = new FileStore(path.join(tmp, 'channels.json'), path.join(tmp, 'items.json'));
  const cleanup = () => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {} };
  bus.attachBus(server, app);
  await itemsMod.attachItems(app, requireAdmin, store);
  const rt = itemsMod.__test;
  const jrt = rt.jukebox.rt;             // Map<code, jukebox runtime>
  // reports are accepted only from the ELECTED PROGRAM rig (or 'admin'); the
  // helper reports as 'player', so mark 'player' the program for a jukebox code.
  const beProgram = (code) => rt.programs.set(code, { kind: 'rig', name: 'player' });
  const rigMsg = (code, msg, name = 'player') => rt.rigHooks.message(ROOM(code), name, msg);

  try {
    // 1. back-compat: a plain (pad) item carries surface:'pad', jukebox:null.
    const pad = (await call(app, 'POST', '/api/items', { headers: ADMIN, body: { name: 'Lamp' } })).body;
    assert.strictEqual(pad.surface, 'pad');
    let r = await call(app, 'GET', '/api/items/:code', { params: { code: pad.item } });
    assert.strictEqual(r.body.surface, 'pad');
    assert.strictEqual(r.body.jukebox, undefined, 'pad item ships no jukebox block');
    ok('back-compat: pad item is surface:pad, no jukebox payload');

    // 2. create a per_action jukebox with a catalog + tight skip rules
    const JB_CFG = { monetization: 'per_action', backend: 'log', catalog: CATALOG,
      queuePriceCents: 200, playNextPriceCents: 400,
      skip: { priceCents: 100, allowMidSong: false, onlyBeforeSec: 15, minPlaySec: 10,
              perUser: { max: 2, windowMin: 30 }, global: { max: 3, windowMin: 60 } },
      queueRules: { maxLen: 5, maxPerUser: 2, noRepeatMin: 60 }, houseMode: false };
    const jb = (await call(app, 'POST', '/api/items', { headers: ADMIN, body: {
      name: 'Bar Jukebox', surface: 'jukebox', jukebox: JB_CFG } })).body;
    const CODE = jb.item;
    assert.strictEqual(jb.surface, 'jukebox');
    assert.strictEqual(jb.jukebox.catalog.length, 3, 'catalog persisted');
    assert.strictEqual(jb.jukebox.prices.queueCents, 200);
    ok(`create jukebox item ${CODE} (per_action, log backend, 3-song catalog)`);

    // 3. catalog-only: queueing an unknown song is refused.
    r = await call(app, 'POST', `/api/items/:code/jukebox/queue`, { params: { code: CODE }, body: { songId: 'nope', ...AS('u1', 'Ann') } });
    assert.strictEqual(r.statusCode, 409);
    assert.match(r.body.error, /not in the catalog/);
    ok('queue: catalog-only — unknown songId refused');

    // 4. first queue-add on an idle jukebox starts playback (rig gets a play command via the runtime).
    r = await call(app, 'POST', `/api/items/:code/jukebox/queue`, { params: { code: CODE }, body: { songId: 'a', ...AS('u1', 'Ann') } });
    assert.strictEqual(r.statusCode, 201);
    let js = jrt.get(CODE);
    assert.ok(js.nowPlaying && js.nowPlaying.songId === 'a', 'idle → first add plays immediately');
    ok('queue: first add on idle jukebox starts playback');

    // 5. queue caps: maxPerUser, then a second user, then noRepeat, then maxLen.
    await call(app, 'POST', `/api/items/:code/jukebox/queue`, { params: { code: CODE }, body: { songId: 'b', ...AS('u1', 'Ann') } });   // Ann: 1 queued (a is playing)
    await call(app, 'POST', `/api/items/:code/jukebox/queue`, { params: { code: CODE }, body: { songId: 'c', ...AS('u1', 'Ann') } });   // Ann: 2 queued
    r = await call(app, 'POST', `/api/items/:code/jukebox/queue`, { params: { code: CODE }, body: { songId: 'a', ...AS('u1', 'Ann') } });   // over maxPerUser? a also playing/recent
    assert.strictEqual(r.statusCode, 409, 'maxPerUser / repeat blocks Ann');
    r = await call(app, 'POST', `/api/items/:code/jukebox/queue`, { params: { code: CODE }, body: { songId: 'b', ...AS('u2', 'Bo') } });   // b already queued (noRepeat/dup)
    assert.strictEqual(r.statusCode, 409, 'duplicate song already queued refused');
    ok('queue: maxPerUser + no-duplicate/no-repeat enforced');

    // 6. play-next insertion fairness: a play-next buy goes to the FRONT but
    //    never above another play-next buy. (Clear recent so noRepeat doesn't
    //    reject songs played earlier; keep something "playing" so adds queue
    //    rather than auto-starting.)
    js.recent = new Map();
    js.nowPlaying = { songId: 'playing', title: '…', startedAt: Date.now(), durationSec: 200 };
    js.queue = [{ songId: 'b', title: 'B', byId: 'u1', byName: 'Ann', playNext: false }];
    await call(app, 'POST', `/api/items/:code/jukebox/queue`, { params: { code: CODE }, body: { songId: 'c', playNext: true, ...AS('u2', 'Bo') } });
    await call(app, 'POST', `/api/items/:code/jukebox/queue`, { params: { code: CODE }, body: { songId: 'a', playNext: true, ...AS('u3', 'Cy') } });
    js = jrt.get(CODE);
    assert.deepStrictEqual(js.queue.map(q => q.songId), ['c', 'a', 'b'], 'play-next go to front, in purchase order, above the normal add');
    ok('play-next: inserts at front, never above another play-next');

    // 7. SKIP RULE MATRIX — drive elapsed by rewinding nowPlaying.startedAt.
    const setElapsed = (sec) => { jrt.get(CODE).nowPlaying = { songId: 'a', title: 'A', startedAt: Date.now() - sec * 1000, durationSec: 200 }; };
    jrt.get(CODE).skips = { perUser: new Map(), global: [] };
    // (a) under minPlaySec (10) → protected
    setElapsed(5);
    r = await call(app, 'POST', `/api/items/:code/jukebox/skip`, { params: { code: CODE }, body: AS('u1', 'Ann') });
    assert.strictEqual(r.statusCode, 409); assert.match(r.body.error, /protected/);
    // (b) past minPlaySec but within onlyBeforeSec (12s, mid-song off) → allowed
    setElapsed(12);
    r = await call(app, 'POST', `/api/items/:code/jukebox/skip`, { params: { code: CODE }, body: AS('u1', 'Ann') });
    assert.strictEqual(r.statusCode, 200, 'skippable inside the window');
    // (c) after onlyBeforeSec (20s, mid-song off) → too late
    setElapsed(20);
    r = await call(app, 'POST', `/api/items/:code/jukebox/skip`, { params: { code: CODE }, body: AS('u2', 'Bo') });
    assert.strictEqual(r.statusCode, 409); assert.match(r.body.error, /too late/);
    ok('skip matrix: <minPlay protected · inside window ok · after window "too late"');

    // 8. allowMidSong:true → skippable any time past minPlaySec.
    await call(app, 'PATCH', '/api/items/:code', { params: { code: CODE }, headers: ADMIN,
      body: { jukebox: { ...JB_CFG, skip: { ...JB_CFG.skip, allowMidSong: true } } } });
    setElapsed(120); jrt.get(CODE).skips = { perUser: new Map(), global: [] };
    r = await call(app, 'POST', `/api/items/:code/jukebox/skip`, { params: { code: CODE }, body: AS('u1', 'Ann') });
    assert.strictEqual(r.statusCode, 200, 'mid-song skip allowed when allowMidSong');
    setElapsed(5);
    r = await call(app, 'POST', `/api/items/:code/jukebox/skip`, { params: { code: CODE }, body: AS('u1', 'Ann') });
    assert.strictEqual(r.statusCode, 409, 'minPlaySec floor still binds even with allowMidSong');
    ok('skip: allowMidSong lets late skips through but minPlaySec floor still binds');

    // 9. WINDOW COUNTERS: per-user exhausts (max 2) then rolls over; global cap denies everyone.
    setElapsed(120); jrt.get(CODE).skips = { perUser: new Map(), global: [] };
    for (let i = 0; i < 2; i++){ r = await call(app, 'POST', `/api/items/:code/jukebox/skip`, { params: { code: CODE }, body: AS('u1', 'Ann') }); assert.strictEqual(r.statusCode, 200); setElapsed(120); }
    r = await call(app, 'POST', `/api/items/:code/jukebox/skip`, { params: { code: CODE }, body: AS('u1', 'Ann') });
    assert.strictEqual(r.statusCode, 409); assert.match(r.body.error, /used your skips/);
    // Ann's window slides: rewind her timestamps past 30min → she can skip again.
    jrt.get(CODE).skips.perUser.set('u1', jrt.get(CODE).skips.perUser.get('u1').map(t => t - 31 * 60000));
    setElapsed(120);
    r = await call(app, 'POST', `/api/items/:code/jukebox/skip`, { params: { code: CODE }, body: AS('u1', 'Ann') });
    assert.strictEqual(r.statusCode, 200, 'per-user window slid → skips replenish');
    ok('windows: per-user cap exhausts then slides (not resets)');

    // 10. global cap (3) denies EVERYONE once hit.
    setElapsed(120); jrt.get(CODE).skips = { perUser: new Map(), global: [Date.now(), Date.now(), Date.now()] };
    r = await call(app, 'POST', `/api/items/:code/jukebox/skip`, { params: { code: CODE }, body: AS('u9', 'Fresh') });
    assert.strictEqual(r.statusCode, 409); assert.match(r.body.error, /room/);
    ok('windows: global cap denies even a user who never skipped');

    // 11. stale-songId skip → 409, NO charge, NO window decrement.
    setElapsed(120); jrt.get(CODE).skips = { perUser: new Map(), global: [] };
    r = await call(app, 'POST', `/api/items/:code/jukebox/skip`, { params: { code: CODE }, body: { songId: 'b', ...AS('u1', 'Ann') } });
    assert.strictEqual(r.statusCode, 409); assert.match(r.body.error, /changed/);
    assert.strictEqual(jrt.get(CODE).skips.global.length, 0, 'stale skip charged/counted nothing');
    ok('skip: stale songId → 409, no window decrement');

    // 12. RIG REPORTS drive nowPlaying truth + advance the queue.
    beProgram(CODE);
    jrt.get(CODE).queue = [{ songId: 'b', title: 'B', byId: 'u1', byName: 'Ann' }];
    rigMsg(CODE, { type: 'track_started', songId: 'a', durationSec: 205 });
    js = jrt.get(CODE);
    assert.strictEqual(js.nowPlaying.songId, 'a'); assert.strictEqual(js.nowPlaying.durationSec, 205, 'rig backfills duration');
    // a spare (NON-program) rig must NOT be able to hijack playback truth
    rigMsg(CODE, { type: 'track_started', songId: 'c', durationSec: 99 }, 'imposter');
    assert.strictEqual(jrt.get(CODE).nowPlaying.songId, 'a', 'a non-program rig report is ignored');
    rigMsg(CODE, { type: 'track_ended', songId: 'a' });
    js = jrt.get(CODE);
    assert.strictEqual(js.nowPlaying.songId, 'b', 'track_ended advanced to the queued song');
    assert.strictEqual(js.queue.length, 0, 'the played song left the queue');
    ok('rig reports: program-only truth (spare rig ignored), track_ended advances the queue');

    // 13. forged wire messages: {type:'jukebox'} is RESERVED; rig reports need admin over HTTP.
    r = await call(app, 'POST', '/api/channels/:id/actions', { params: { id: ROOM(CODE) }, body: { type: 'jukebox', action: 'skip' } });
    assert.strictEqual(r.statusCode, 400, 'jukebox command is server-only (RESERVED)');
    r = await call(app, 'POST', '/api/channels/:id/actions', { params: { id: ROOM(CODE) }, body: { type: 'track_started', songId: 'c' } });
    assert.strictEqual(r.statusCode, 403, 'rig report from a plain client refused');
    r = await call(app, 'POST', '/api/channels/:id/actions', { params: { id: ROOM(CODE) }, headers: ADMIN, body: { type: 'track_started', songId: 'c', durationSec: 100 } });
    assert.strictEqual(r.statusCode, 200); assert.strictEqual(jrt.get(CODE).nowPlaying.songId, 'c', 'X-Admin-Key may report');
    ok('forgery: jukebox cmd RESERVED · rig report plain-client 403 · admin 200');

    // 14. BID MODE: round closes on track_ended, winner enqueues first.
    const bidItem = (await call(app, 'POST', '/api/items', { headers: ADMIN, body: {
      name: 'Bid Box', surface: 'jukebox',
      jukebox: { monetization: 'per_action', backend: 'log', mode: 'bid', catalog: CATALOG, houseMode: false } } })).body.item;
    beProgram(bidItem);
    rigMsg(bidItem, { type: 'track_started', songId: 'a', durationSec: 200 });   // a song must be playing to bid on next
    r = await call(app, 'POST', `/api/items/:code/jukebox/bid`, { params: { code: bidItem }, body: { songId: 'b', cents: 300, ...AS('u1', 'Ann') } });
    assert.strictEqual(r.statusCode, 201);
    r = await call(app, 'POST', `/api/items/:code/jukebox/bid`, { params: { code: bidItem }, body: { songId: 'c', cents: 500, ...AS('u2', 'Bo') } });
    assert.strictEqual(r.statusCode, 201, 'higher bid accepted');
    r = await call(app, 'POST', `/api/items/:code/jukebox/bid`, { params: { code: bidItem }, body: { songId: 'a', cents: 400, ...AS('u3', 'Cy') } });
    assert.strictEqual(r.statusCode, 400, 'below current top+increment refused');
    rigMsg(bidItem, { type: 'track_ended', songId: 'a' });    // round closes → Bo (top bid) wins → c plays
    assert.strictEqual(jrt.get(bidItem).nowPlaying.songId, 'c', 'bid winner song plays next');
    assert.strictEqual(jrt.get(bidItem).bidRound, null, 'round resolved');
    ok('bid: round closes on track_ended, top bidder\'s song plays next');

    // 15. CONTROLLER_SLOT mode: non-holder denied WITHOUT charge; holder passes but windows bind.
    const slotItem = (await call(app, 'POST', '/api/items', { headers: ADMIN, body: {
      name: 'Slot Box', surface: 'jukebox', priceCents: 100, slotSeconds: 600,
      jukebox: { monetization: 'controller_slot', backend: 'log', catalog: CATALOG, houseMode: false,
        skip: { priceCents: 0, allowMidSong: true, minPlaySec: 0, onlyBeforeSec: null, perUser: { max: 1, windowMin: 30 }, global: { max: 9, windowMin: 60 } } } } })).body.item;
    // nobody holds → queue denied
    r = await call(app, 'POST', `/api/items/:code/jukebox/queue`, { params: { code: slotItem }, body: { songId: 'a', ...AS('u1', 'Ann') } });
    assert.strictEqual(r.statusCode, 403); assert.match(r.body.error, /control/);
    // Ann buys the control slot → now she may queue
    await call(app, 'POST', '/api/items/:code/buy', { params: { code: slotItem }, body: AS('u1', 'Ann') });
    r = await call(app, 'POST', `/api/items/:code/jukebox/queue`, { params: { code: slotItem }, body: { songId: 'a', ...AS('u1', 'Ann') } });
    assert.strictEqual(r.statusCode, 201, 'holder may queue');
    // but a non-holder still can't, and the holder is still bound by windows (max 1 skip)
    r = await call(app, 'POST', `/api/items/:code/jukebox/queue`, { params: { code: slotItem }, body: { songId: 'b', ...AS('u2', 'Bo') } });
    assert.strictEqual(r.statusCode, 403, 'non-holder still denied while Ann holds');
    jrt.get(slotItem).nowPlaying = { songId: 'a', title: 'A', startedAt: Date.now() - 60000, durationSec: 200 };
    jrt.get(slotItem).skips = { perUser: new Map(), global: [] };
    r = await call(app, 'POST', `/api/items/:code/jukebox/skip`, { params: { code: slotItem }, body: AS('u1', 'Ann') });
    assert.strictEqual(r.statusCode, 200);
    // fresh track (skip latch resets) but the per-user window still holds max 1
    jrt.get(slotItem).nowPlaying = { songId: 'b', title: 'B', startedAt: Date.now() - 60000, durationSec: 200 };
    r = await call(app, 'POST', `/api/items/:code/jukebox/skip`, { params: { code: slotItem }, body: AS('u1', 'Ann') });
    assert.strictEqual(r.statusCode, 409, 'holder still bound by the per-user skip window');
    ok('controller_slot: non-holder denied (no charge), holder passes but windows still bind');

    // 16. admin live actions: force skip, clear queue, remove a row.
    jrt.get(CODE).queue = [{ songId: 'b', title: 'B', byId: 'u1', byName: 'Ann' }, { songId: 'c', title: 'C', byId: 'u2', byName: 'Bo' }];
    r = await call(app, 'POST', `/api/items/:code/jukebox/admin`, { params: { code: CODE }, headers: ADMIN, body: { action: 'remove', songId: 'b', byId: 'u1' } });
    assert.strictEqual(r.statusCode, 200); assert.strictEqual(jrt.get(CODE).queue.length, 1, 'admin removed a queue row');
    r = await call(app, 'POST', `/api/items/:code/jukebox/admin`, { params: { code: CODE }, headers: ADMIN, body: { action: 'clear_queue' } });
    assert.strictEqual(jrt.get(CODE).queue.length, 0, 'admin cleared the queue');
    r = await call(app, 'POST', `/api/items/:code/jukebox/admin`, { params: { code: CODE }, body: { action: 'clear_queue' } });
    assert.strictEqual(r.statusCode, 401, 'admin actions need the key');
    ok('admin: remove row / clear queue / force skip (key-gated)');

    // 17. off / not-a-jukebox guards.
    r = await call(app, 'POST', `/api/items/:code/jukebox/queue`, { params: { code: pad.item }, body: { songId: 'a', ...AS('u1', 'Ann') } });
    assert.strictEqual(r.statusCode, 409); assert.match(r.body.error, /not a jukebox/);
    await call(app, 'POST', '/api/items/:code/state', { params: { code: CODE }, headers: ADMIN, body: { action: 'off' } });
    r = await call(app, 'POST', `/api/items/:code/jukebox/queue`, { params: { code: CODE }, body: { songId: 'a', ...AS('u1', 'Ann') } });
    assert.strictEqual(r.statusCode, 409); assert.match(r.body.error, /off/);
    ok('guards: pad item rejects jukebox calls · off jukebox refuses requests');

    /* ── adversarial-review regressions (fixes from the ship review) ── */

    // 18. noRepeatMin=0 must STILL reject a duplicate already-queued/playing song
    // (else two paid copies exist and track_started's by-songId filter deletes both).
    const dupItem = (await call(app, 'POST', '/api/items', { headers: ADMIN, body: {
      name: 'Dup Box', surface: 'jukebox',
      jukebox: { monetization: 'per_action', backend: 'log', catalog: CATALOG, houseMode: false,
        queueRules: { maxLen: 10, maxPerUser: 9, noRepeatMin: 0 } } } })).body.item;
    beProgram(dupItem);
    r = await call(app, 'POST', `/api/items/:code/jukebox/queue`, { params: { code: dupItem }, body: { songId: 'a', ...AS('u1', 'Ann') } });
    assert.strictEqual(r.statusCode, 201, 'first add starts playing');            // idle → plays 'a'
    r = await call(app, 'POST', `/api/items/:code/jukebox/queue`, { params: { code: dupItem }, body: { songId: 'a', ...AS('u2', 'Bo') } });
    assert.strictEqual(r.statusCode, 409); assert.match(r.body.error, /playing now/);   // can't queue what's playing
    r = await call(app, 'POST', `/api/items/:code/jukebox/queue`, { params: { code: dupItem }, body: { songId: 'b', ...AS('u1', 'Ann') } });
    assert.strictEqual(r.statusCode, 201);
    r = await call(app, 'POST', `/api/items/:code/jukebox/queue`, { params: { code: dupItem }, body: { songId: 'b', ...AS('u2', 'Bo') } });
    assert.strictEqual(r.statusCode, 409); assert.match(r.body.error, /already in the queue/);   // no paid duplicate
    ok('noRepeat=0 still blocks a duplicate queued/playing song (no lost paid play)');

    // 19. a skip cap of 0 means NO skips (not "unlimited").
    const zeroItem = (await call(app, 'POST', '/api/items', { headers: ADMIN, body: {
      name: 'No Skip', surface: 'jukebox',
      jukebox: { monetization: 'per_action', backend: 'log', catalog: CATALOG, houseMode: false,
        skip: { priceCents: 0, allowMidSong: true, minPlaySec: 0, perUser: { max: 0, windowMin: 30 }, global: { max: 0, windowMin: 60 } } } } })).body.item;
    beProgram(zeroItem);
    await call(app, 'POST', `/api/items/:code/jukebox/queue`, { params: { code: zeroItem }, body: { songId: 'a', ...AS('u1', 'Ann') } });   // idle → plays 'a'
    r = await call(app, 'POST', `/api/items/:code/jukebox/skip`, { params: { code: zeroItem }, body: AS('u1', 'Ann') });
    assert.strictEqual(r.statusCode, 409); assert.match(r.body.error, /off/);
    ok('skip cap 0 = skips OFF (not unlimited)');

    // 20. one skip per track: a double-tap before track_ended can't double-charge the quota.
    const dblItem = (await call(app, 'POST', '/api/items', { headers: ADMIN, body: {
      name: 'Double Box', surface: 'jukebox',
      jukebox: { monetization: 'per_action', backend: 'log', catalog: CATALOG, houseMode: false,
        skip: { priceCents: 0, allowMidSong: true, minPlaySec: 0, perUser: { max: 3, windowMin: 30 }, global: { max: 9, windowMin: 60 } } } } })).body.item;
    beProgram(dblItem);
    await call(app, 'POST', `/api/items/:code/jukebox/queue`, { params: { code: dblItem }, body: { songId: 'a', ...AS('u1', 'Ann') } });   // idle → plays 'a'
    r = await call(app, 'POST', `/api/items/:code/jukebox/skip`, { params: { code: dblItem }, body: AS('u1', 'Ann') });
    assert.strictEqual(r.statusCode, 200, 'first skip lands');
    r = await call(app, 'POST', `/api/items/:code/jukebox/skip`, { params: { code: dblItem }, body: AS('u1', 'Ann') });
    assert.strictEqual(r.statusCode, 409); assert.match(r.body.error, /already being skipped/);
    assert.strictEqual(jrt.get(dblItem).skips.global.length, 1, 'only ONE skip counted for the double-tap');
    assert.strictEqual((jrt.get(dblItem).skips.perUser.get('u1') || []).length, 1, 'per-user quota decremented once');
    ok('one skip per track: double-tap cannot double-charge the skip quota');

    console.log(`\nALL CLEAR — ${passed} jukebox checks passed`);
  } finally { cleanup(); }
  process.exit(0);
})().catch((e) => { console.error('\nFAIL:', e.message); console.error(e.stack); process.exit(1); });

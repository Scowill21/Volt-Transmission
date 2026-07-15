/* Server-side smoke test for VOLT CONTROL (server/items.js) — the pay-to-
   control items product. Same style as .smoke-server.cjs: real routes on a
   fake Express app, hermetic and fast. Auth is left UNCONFIGURED so the
   documented payload escape hatch stands in for sessions (production runs
   the same gate with ws._user identity — .smoke-failclosed.cjs proves the
   hatch stays closed there).

   Time-dependent paths (slot expiry, auction close) are driven by rewinding
   endsAt through the module's __test hook instead of sleeping.

   Run:  node .smoke-items.cjs   — must exit 0.  */
'use strict';
delete process.env.SUPABASE_URL;
delete process.env.SUPABASE_PUBLISHABLE_KEY;   // force auth-unconfigured (dev identity)
delete process.env.ADMIN_KEY;                  // admin key falls back to 'dev'

const http = require('http');
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

/* ── minimal Express stand-in (same as .smoke-server.cjs) ───────────── */
function makeApp(){
  const routes = [];
  const add = (method) => (path, ...handlers) => routes.push({ method, path, handlers });
  return { get: add('GET'), post: add('POST'), patch: add('PATCH'), delete: add('DELETE'), use(){}, _routes: routes };
}
function makeRes(){
  return {
    statusCode: 200, body: undefined, _sent: false, headers: {},
    status(c){ this.statusCode = c; return this; },
    json(o){ this.body = o; this._sent = true; return this; },
    end(){ this._sent = true; },
    setHeader(){}, on(){ return this; },
  };
}
async function call(app, method, path, { params = {}, body = {}, headers = {}, query = {} } = {}){
  const route = app._routes.find(r => r.method === method && r.path === path);
  if (!route) throw new Error(`no route ${method} ${path}`);
  const req = { params, body, headers, query, get: (h) => headers[h.toLowerCase()] };
  const res = makeRes();
  let idx = 0;
  const next = async (err) => {
    if (err){ if (err.status) res.status(err.status); res.json({ error: err.message }); return; }
    const h = route.handlers[idx++];
    if (h) await h(req, res, next);
  };
  await next();
  return res;
}
const requireAdmin = (req, res, next) =>
  req.get('x-admin-key') === (process.env.ADMIN_KEY || 'dev')
    ? next()
    : res.status(401).json({ error: 'admin key required' });

const AS = (id, name) => ({ user: { id, name } });
const ADMIN = { 'x-admin-key': 'dev' };
let passed = 0;
const ok = (label) => { console.log('OK  ', passed + 1, label); passed++; };

(async () => {
  const server = http.createServer();
  const app = makeApp();
  const bus = await import('./server/bus.js');
  const paid = await import('./server/paid.js');
  const itemsMod = await import('./server/items.js');
  const { FileStore } = await import('./server/store.js');

  // throwaway file store so the dev items.json is never touched
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'volt-items-'));
  const store = new FileStore(path.join(tmp, 'channels.json'), path.join(tmp, 'items.json'));
  const cleanup = () => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {} };

  bus.attachBus(server, app);
  paid.attachPaid(app, requireAdmin);
  await itemsMod.attachItems(app, requireAdmin, store);
  const rt = itemsMod.__test;                    // { state, items } — the fake clock

  /* ── admin create + public read ── */
  // 1. create requires the admin key
  let r = await call(app, 'POST', '/api/items', { body: { name: 'Lamp' } });
  assert.strictEqual(r.statusCode, 401);
  ok('create without admin key → 401');

  // 2. create (buy-now) returns a well-formed 6-char code + the controls guide
  r = await call(app, 'POST', '/api/items', { headers: ADMIN,
    body: { name: 'Lamp', mode: 'buynow', priceCents: 300, slotSeconds: 60,
            instructions: '▲▼ tilt · A strobe' } });
  assert.strictEqual(r.statusCode, 201);
  const CODE = r.body.item;
  assert.match(CODE, /^[A-HJ-NP-Z2-9]{6}$/, 'code uses the unambiguous alphabet');
  assert.strictEqual(r.body.mode, 'buynow');
  assert.strictEqual(r.body.instructions, '▲▼ tilt · A strobe', 'controls guide rides the public payload');
  ok(`create item → 201, code ${CODE} (no 0/O/1/I), instructions carried`);

  // 3. survives a restart: a fresh module attach re-reads the store
  assert.strictEqual((await store.listItems()).length, 1, 'item persisted durably');
  ok('item definition persisted via the store');

  // 4. public GET needs no identity and does NOT materialize runtime state
  r = await call(app, 'GET', '/api/items/:code', { params: { code: CODE.toLowerCase() } });
  assert.strictEqual(r.statusCode, 200, 'lowercase code accepted');
  assert.strictEqual(r.body.active, null);
  assert.strictEqual(rt.state.has(CODE), false, 'GET must not create runtime state');
  r = await call(app, 'GET', '/api/items/:code', { params: { code: 'ZZZZZZ' } });
  assert.strictEqual(r.statusCode, 404);
  r = await call(app, 'GET', '/api/items/:code', { params: { code: '../etc' } });
  assert.strictEqual(r.statusCode, 404, 'junk codes rejected by shape');
  assert.strictEqual(rt.state.size, 0, 'no runtime state grown by reads');
  ok('public GET → live state, no create-on-read, junk 404s');

  /* ── buy-now queue ── */
  // 5. anonymous buy rejected; Ada buys and takes the slot
  r = await call(app, 'POST', '/api/items/:code/buy', { params: { code: CODE } });
  assert.strictEqual(r.statusCode, 401);
  r = await call(app, 'POST', '/api/items/:code/buy', { params: { code: CODE }, body: AS('u-ada', 'Ada') });
  assert.strictEqual(r.statusCode, 201);
  assert.strictEqual(r.body.active.name, 'Ada');
  ok('anonymous buy 401 · Ada buys → holds the slot');

  // 6. Bob queues with a correct estimated start (= Ada's endsAt)
  r = await call(app, 'POST', '/api/items/:code/buy', { params: { code: CODE }, body: AS('u-bob', 'Bob') });
  assert.strictEqual(r.body.queue[0].name, 'Bob');
  const endsAt = rt.state.get(CODE).active.endsAt;
  assert.ok(Math.abs(r.body.queue[0].estimatedStartAt - endsAt) < 1500, 'estimate ≈ active endsAt');
  r = await call(app, 'POST', '/api/items/:code/buy', { params: { code: CODE }, body: AS('u-bob', 'Bob') });
  assert.strictEqual(r.statusCode, 409, 'double-queue rejected');
  ok('Bob queues at #1 with estimated start ≈ slot end · double-buy 409');

  /* ── the gate (via the HTTP inject route, same verdicts as the socket) ── */
  const inject = (action, uid) => call(app, 'POST', '/api/channels/:id/actions',
    { params: { id: 'item:' + CODE }, body: { type: 'key', action, ...(uid ? { user: { id: uid } } : {}) } });

  // 7. non-holder denied · holder passes · admin bypasses
  r = await inject('pad_up', 'u-bob');
  assert.strictEqual(r.statusCode, 403);
  assert.match(r.body.error, /Ada has the controls/);
  r = await inject('pad_up', 'u-ada');
  assert.strictEqual(r.statusCode, 200);
  r = await call(app, 'POST', '/api/channels/:id/actions',
    { params: { id: 'item:' + CODE }, body: { type: 'key', action: 'btn_c' }, headers: ADMIN });
  assert.strictEqual(r.statusCode, 200, 'X-Admin-Key bypasses the item gate');
  ok('gate: non-holder pad_up 403 · holder passes · admin bypasses');

  // 8. non-pad/btn key actions are denied in item rooms (territory is owned)
  r = await inject('scene_1', 'u-ada');
  assert.strictEqual(r.statusCode, 403, 'scene actions have no business in item rooms');
  ok('gate: scene_1 in an item room → 403 (namespace owned by items)');

  // 9. forged server-only types can't be injected
  for (const type of ['item', 'item_queues']){
    r = await call(app, 'POST', '/api/channels/:id/actions',
      { params: { id: 'item:' + CODE }, body: { type, action: 'off', item: CODE } });
    assert.strictEqual(r.statusCode, 400, `forged {type:'${type}'} must be rejected`);
  }
  ok("forged {type:'item'} / {type:'item_queues'} inject → 400");

  // 10. cross-product territory: paid endpoints refuse item: rooms
  r = await call(app, 'POST', '/api/channels/:id/control/request',
    { params: { id: 'item:' + CODE }, body: AS('u-x', 'X') });
  assert.strictEqual(r.statusCode, 404, 'paid takeover must not run on item rooms');
  r = await call(app, 'GET', '/api/channels/:id/queues', { params: { id: 'item:' + CODE } });
  assert.strictEqual(r.statusCode, 404);
  assert.strictEqual(rt.state.get(CODE).queue.length, 1, 'items runtime untouched by paid probe');
  ok('paid control/queues endpoints on item: rooms → 404 (territories disjoint)');

  /* ── expiry, skip, pause ── */
  // 11. expiry promotes Bob (rewind the clock, run the real tick logic)
  rt.state.get(CODE).active.endsAt = Date.now() - 1;
  await new Promise(res => setTimeout(res, 1100));           // one real tick
  assert.strictEqual(rt.state.get(CODE).active.name, 'Bob', 'expiry promotes the next buyer');
  assert.strictEqual(rt.state.get(CODE).queue.length, 0);
  ok('slot expiry → Bob promoted automatically');

  // 12. admin skip ends Bob's slot (empty queue → controls free)
  r = await call(app, 'POST', '/api/items/:code/skip', { params: { code: CODE }, headers: ADMIN });
  assert.strictEqual(r.statusCode, 200);
  assert.strictEqual(r.body.active, null);
  ok('admin skip → slot ends, controls free');

  // 13. pause freezes remaining time; resume restores it
  await call(app, 'POST', '/api/items/:code/buy', { params: { code: CODE }, body: AS('u-ada', 'Ada') });
  r = await call(app, 'POST', '/api/items/:code/state', { params: { code: CODE }, headers: ADMIN, body: { action: 'pause' } });
  assert.strictEqual(r.body.active.paused, true);
  const frozen = r.body.active.remainingMs;
  await new Promise(res => setTimeout(res, 1200));
  r = await call(app, 'GET', '/api/items/:code', { params: { code: CODE } });
  assert.strictEqual(r.body.active.remainingMs, frozen, 'paused remaining time must not tick down');
  r = await inject('pad_up', 'u-ada');
  assert.strictEqual(r.statusCode, 403, 'holder input denied while paused');
  r = await call(app, 'POST', '/api/items/:code/state', { params: { code: CODE }, headers: ADMIN, body: { action: 'resume' } });
  assert.strictEqual(r.body.active.paused, false);
  assert.ok(Math.abs(r.body.active.remainingMs - frozen) < 500, 'resume restores the frozen time');
  r = await inject('pad_up', 'u-ada');
  assert.strictEqual(r.statusCode, 200, 'holder input passes again after resume');
  ok('pause freezes time + gates input · resume restores both');

  // 14. off blocks buys AND controller input; on re-enables
  r = await call(app, 'POST', '/api/items/:code/state', { params: { code: CODE }, headers: ADMIN, body: { action: 'off' } });
  assert.strictEqual(r.body.status, 'off');
  r = await call(app, 'POST', '/api/items/:code/buy', { params: { code: CODE }, body: AS('u-eve', 'Eve') });
  assert.strictEqual(r.statusCode, 409, 'off items are not sellable');
  r = await inject('pad_up', 'u-ada');
  assert.strictEqual(r.statusCode, 403, 'off gates even the holder');
  r = await call(app, 'POST', '/api/items/:code/state', { params: { code: CODE }, headers: ADMIN, body: { action: 'on' } });
  assert.strictEqual(r.body.status, 'on');
  r = await inject('pad_up', 'u-ada');
  assert.strictEqual(r.statusCode, 200);
  ok('off → buys 409 + all input 403 · on → re-enabled');

  // 15. cancel surrenders the slot
  r = await call(app, 'POST', '/api/items/:code/cancel', { params: { code: CODE }, body: AS('u-ada', 'Ada') });
  assert.strictEqual(r.body.active, null);
  ok('cancel → holder surrenders, controls free');

  /* ── auction ── */
  // 16. create an auction item; buy is the wrong verb on it
  r = await call(app, 'POST', '/api/items', { headers: ADMIN,
    body: { name: 'Laser', mode: 'auction', priceCents: 200, slotSeconds: 30, auctionSeconds: 60, minIncrementCents: 50 } });
  const AUC = r.body.item;
  r = await call(app, 'POST', '/api/items/:code/buy', { params: { code: AUC }, body: AS('u-ada', 'Ada') });
  assert.strictEqual(r.statusCode, 409, 'buy on an auction item → 409');
  r = await call(app, 'POST', '/api/items/:code/bid', { params: { code: CODE }, body: { cents: 500, ...AS('u-ada', 'Ada') } });
  assert.strictEqual(r.statusCode, 409, 'bid on a buy-now item → 409');
  ok('mode fencing: buy↔bid cross-calls → 409');

  // 17. bid validation: under-min, non-integer, over-cap
  r = await call(app, 'POST', '/api/items/:code/bid', { params: { code: AUC }, body: { cents: 150, ...AS('u-ada', 'Ada') } });
  assert.strictEqual(r.statusCode, 400, 'under starting price rejected');
  r = await call(app, 'POST', '/api/items/:code/bid', { params: { code: AUC }, body: { cents: 2.5, ...AS('u-ada', 'Ada') } });
  assert.strictEqual(r.statusCode, 400, 'non-integer cents rejected');
  r = await call(app, 'POST', '/api/items/:code/bid', { params: { code: AUC }, body: { cents: 50001, ...AS('u-ada', 'Ada') } });
  assert.strictEqual(r.statusCode, 400, 'over the $500 cap rejected');
  assert.strictEqual(rt.state.get(AUC) && rt.state.get(AUC).auction || null, null, 'no round armed by rejects');
  ok('bids: under-min 400 · non-integer 400 · >$500 400 · nothing armed');

  // 18. a valid first bid arms the countdown
  r = await call(app, 'POST', '/api/items/:code/bid', { params: { code: AUC }, body: { cents: 200, ...AS('u-ada', 'Ada') } });
  assert.strictEqual(r.statusCode, 201);
  assert.ok(r.body.auction && r.body.auction.endsAt > Date.now() + 55000, 'first bid arms ~60s countdown');
  assert.strictEqual(r.body.auction.topCents, 200);
  assert.strictEqual(r.body.auction.minNextCents, 250);
  ok('first valid bid arms the 60s round, top $2, min next $2.50');

  // 19. increments enforced; top bidder can't outbid themselves; rate limit
  r = await call(app, 'POST', '/api/items/:code/bid', { params: { code: AUC }, body: { cents: 240, ...AS('u-bob', 'Bob') } });
  assert.strictEqual(r.statusCode, 400, 'below top+increment rejected');
  rt.state.get(AUC).lastBidAt.clear();                        // step past the cooldown, not the rules
  r = await call(app, 'POST', '/api/items/:code/bid', { params: { code: AUC }, body: { cents: 300, ...AS('u-ada', 'Ada') } });
  assert.strictEqual(r.statusCode, 409, 'top bidder self-outbid rejected');
  r = await call(app, 'POST', '/api/items/:code/bid', { params: { code: AUC }, body: { cents: 300, ...AS('u-bob', 'Bob') } });
  assert.strictEqual(r.statusCode, 201);
  r = await call(app, 'POST', '/api/items/:code/bid', { params: { code: AUC }, body: { cents: 400, ...AS('u-bob', 'Bob') } });
  assert.strictEqual(r.statusCode, 429, 'per-user bid rate limit fires before the self-outbid rule');
  ok('increment enforced · self-outbid 409 · rapid re-bid 429');

  // 20. soft close: a bid in the final 10s extends the clock by 10s
  const auc = rt.state.get(AUC).auction;
  auc.endsAt = Date.now() + 5000;                             // simulate final seconds
  rt.state.get(AUC).lastBidAt.clear();                        // clear the rate limiter, not the bids
  const before = auc.endsAt;
  r = await call(app, 'POST', '/api/items/:code/bid', { params: { code: AUC }, body: { cents: 400, ...AS('u-ada', 'Ada') } });
  assert.strictEqual(r.statusCode, 201);
  assert.strictEqual(rt.state.get(AUC).auction.endsAt - before, 10000, 'late bid adds exactly 10s');
  ok('soft close: bid in the final 10s extends the round 10s');

  // 21. countdown zero → highest bid wins the slot; next round arms on next bid
  rt.state.get(AUC).auction.endsAt = Date.now() - 1;
  await new Promise(res => setTimeout(res, 1100));
  let st = rt.state.get(AUC);
  assert.strictEqual(st.auction, null, 'round resolved');
  assert.strictEqual(st.active.userId, 'u-ada', 'highest bidder took the slot');
  // bids are blocked while a slot runs…
  st.lastBidAt && st.lastBidAt.clear();
  r = await call(app, 'POST', '/api/items/:code/bid', { params: { code: AUC }, body: { cents: 500, ...AS('u-bob', 'Bob') } });
  assert.strictEqual(r.statusCode, 409, 'no bidding while a slot runs');
  // …and the loop re-arms on the first bid after it ends
  st.active.endsAt = Date.now() - 1;
  await new Promise(res => setTimeout(res, 1100));
  assert.strictEqual(rt.state.get(AUC) ? rt.state.get(AUC).active : null, null, 'slot expired');
  r = await call(app, 'POST', '/api/items/:code/bid', { params: { code: AUC }, body: { cents: 200, ...AS('u-bob', 'Bob') } });
  assert.strictEqual(r.statusCode, 201);
  assert.ok(r.body.auction, 'next round armed by the next bid');
  ok('countdown zero → winner takes slot · next round re-arms on next bid');

  /* ── admin edit/delete + dashboard ── */
  // 22. dashboard lists both items; PATCH edits; status via PATCH is refused
  r = await call(app, 'GET', '/api/items', { headers: ADMIN });
  assert.strictEqual(r.body.length, 2);
  r = await call(app, 'PATCH', '/api/items/:code', { params: { code: CODE }, headers: ADMIN,
    body: { priceCents: 700, instructions: 'B = new colorway' } });
  assert.strictEqual(r.body.priceCents, 700);
  assert.strictEqual(r.body.instructions, 'B = new colorway', 'PATCH updates the controls guide');
  r = await call(app, 'PATCH', '/api/items/:code', { params: { code: CODE }, headers: ADMIN, body: { status: 'off' } });
  assert.strictEqual(r.statusCode, 400, 'status flips must go through /state (announced to TD)');
  r = await call(app, 'DELETE', '/api/items/:code', { params: { code: AUC }, headers: ADMIN });
  assert.strictEqual(r.statusCode, 204);
  assert.strictEqual(rt.items.has(AUC), false);
  assert.strictEqual(rt.state.has(AUC), false, 'runtime dropped with the definition');
  r = await call(app, 'GET', '/api/items/:code', { params: { code: AUC } });
  assert.strictEqual(r.statusCode, 404);
  ok('admin list · PATCH edit · status-via-PATCH 400 · DELETE drops runtime');

  // 23. mode flip with live runtime is refused (would strand paid buyers)
  await call(app, 'POST', '/api/items/:code/buy', { params: { code: CODE }, body: AS('u-ada', 'Ada') });
  await call(app, 'POST', '/api/items/:code/buy', { params: { code: CODE }, body: AS('u-bob', 'Bob') });
  r = await call(app, 'PATCH', '/api/items/:code', { params: { code: CODE }, headers: ADMIN, body: { mode: 'auction' } });
  assert.strictEqual(r.statusCode, 409, 'mode flip with a live queue must 409');
  await call(app, 'POST', '/api/items/:code/skip', { params: { code: CODE }, headers: ADMIN });  // promotes Bob
  await call(app, 'POST', '/api/items/:code/skip', { params: { code: CODE }, headers: ADMIN });  // frees the item
  r = await call(app, 'PATCH', '/api/items/:code', { params: { code: CODE }, headers: ADMIN, body: { mode: 'auction' } });
  assert.strictEqual(r.statusCode, 200, 'idle item switches modes fine');
  await call(app, 'PATCH', '/api/items/:code', { params: { code: CODE }, headers: ADMIN, body: { mode: 'buynow' } });
  ok('mode flip: 409 while runtime live · 200 once idle');

  // 24. queue cap: the line refuses buyer #26
  const capItem = (await call(app, 'POST', '/api/items', { headers: ADMIN, body: { name: 'Busy', slotSeconds: 600 } })).body.item;
  await call(app, 'POST', '/api/items/:code/buy', { params: { code: capItem }, body: AS('u-holder', 'H') });
  for (let i = 0; i < 25; i++){
    r = await call(app, 'POST', '/api/items/:code/buy', { params: { code: capItem }, body: AS('u-q' + i, 'Q' + i) });
    assert.strictEqual(r.statusCode, 201, 'queue member ' + i);
  }
  r = await call(app, 'POST', '/api/items/:code/buy', { params: { code: capItem }, body: AS('u-late', 'Late') });
  assert.strictEqual(r.statusCode, 429);
  ok('queue caps at 25 waiting buyers → 429');

  // 25. top bid at the $500 cap: round closes honestly (no unbiddable minimum)
  const capAuc = (await call(app, 'POST', '/api/items', { headers: ADMIN,
    body: { name: 'Cap', mode: 'auction', priceCents: 50000 } })).body.item;
  r = await call(app, 'POST', '/api/items/:code/bid', { params: { code: capAuc }, body: { cents: 50000, ...AS('u-ada', 'Ada') } });
  assert.strictEqual(r.statusCode, 201);
  assert.strictEqual(r.body.auction.minNextCents, null, 'no advertised minimum above the cap');
  r = await call(app, 'POST', '/api/items/:code/bid', { params: { code: capAuc }, body: { cents: 50000, ...AS('u-bob', 'Bob') } });
  assert.strictEqual(r.statusCode, 409, 'capped round refuses further bids with a clear reason');
  assert.match(r.body.error, /cap/);
  ok('top bid at $500 → minNextCents null, further bids 409 (never contradictory 400s)');

  // 26. a corrupt items.json is set aside, not fatal (the JSON store is the
  // documented prod fallback — boot must survive it)
  fs.writeFileSync(store.itemsFile, '{"truncated": tru');
  const recovered = await store.listItems();
  assert.deepStrictEqual(recovered, [], 'corrupt file reads as empty');
  assert.ok(fs.readdirSync(tmp).some(f => f.includes('.corrupt-')), 'corrupt file preserved for recovery');
  assert.doesNotThrow(() => JSON.parse(fs.readFileSync(store.itemsFile, 'utf8')), 'store healed with valid JSON');
  ok('corrupt items.json → set aside + empty store, never a boot crash');

  cleanup();
  console.log(`\nALL CLEAR — ${passed} item-control checks passed`);
  process.exit(0);
})().catch((e) => { console.error('\nFAIL:', e.message); console.error(e.stack); process.exit(1); });

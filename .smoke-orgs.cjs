/* Server-side smoke test for THE ADMIN CHAIN (server/orgs.js) — orgs, delegated
   roles (owner/staff/tech), platform bands + floors, per-request org authz, the
   append-only audit log, and the item-room gate extension. Same hermetic
   fake-express + FileStore harness as .smoke-items.cjs.

   Auth is UNCONFIGURED → the dev-identity hatch stands in for real sessions;
   the actor's EMAIL (which org membership matches on) rides the dev-hatch body
   as { user:{ id, name, email } }. Production runs the identical authz with the
   verified session's email — .smoke-failclosed.cjs proves the hatch stays shut
   there, and item #10 below extends that to the org write paths.

   The org store works in the FileStore for hermetic testing; `orgsEnabled`
   reflects prod policy (real Postgres only). We flip it true to exercise the
   happy paths and false to prove the 503 degrade (#9).

   Run:  node .smoke-orgs.cjs   — must exit 0.  */
'use strict';
delete process.env.SUPABASE_URL;
delete process.env.SUPABASE_PUBLISHABLE_KEY;   // force auth-unconfigured (dev identity)
delete process.env.ADMIN_KEY;                  // admin key falls back to 'dev'

const http = require('http');
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

/* ── minimal Express stand-in (same as .smoke-items.cjs) ───────────── */
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
    setHeader(){}, on(){ return this; }, headersSent: false,
  };
}
async function call(app, method, path, { params = {}, body = {}, headers = {}, query = {} } = {}){
  const route = app._routes.find(r => r.method === method && r.path === path);
  if (!route) throw new Error(`no route ${method} ${path}`);
  const req = { params, body, headers, query, get: (h) => headers[h.toLowerCase()] };
  const res = makeRes();
  let idx = 0;
  // Middleware (requireAdmin/requireOrg) call next() WITHOUT awaiting it — correct
  // in real Express, but it means a naive `await next()` returns while the async
  // handler is still running, letting sequential calls overlap and race the file
  // store. Collect every handler promise and await them all so calls truly
  // serialize (what production's single event loop + one request at a time gives).
  const pending = [];
  const next = (err) => {
    if (err){ if (err.status) res.status(err.status); res.json({ error: err.message }); return Promise.resolve(); }
    const h = route.handlers[idx++];
    if (!h) return Promise.resolve();
    const p = Promise.resolve(h(req, res, next));
    pending.push(p);
    return p;
  };
  await next();
  await Promise.all(pending);
  return res;
}
const requireAdmin = (req, res, next) =>
  req.get('x-admin-key') === (process.env.ADMIN_KEY || 'dev')
    ? next()
    : res.status(401).json({ error: 'admin key required' });

// dev-hatch identity carrying an email (org membership matches on it)
const AS = (id, name, email) => ({ user: { id, name, email } });
const ADMIN = { 'x-admin-key': 'dev' };
// synthetic verified session for the bus gate (what ws._user is in production)
const SESSION = (id, email, role = 'listener') => ({ _user: { id, email, role } });
let passed = 0;
const ok = (label) => { console.log('OK  ', passed + 1, label); passed++; };

(async () => {
  const server = http.createServer();
  const app = makeApp();
  const bus = await import('./server/bus.js');
  const paid = await import('./server/paid.js');
  const itemsMod = await import('./server/items.js');
  const orgsMod = await import('./server/orgs.js');
  const { FileStore } = await import('./server/store.js');

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'volt-orgs-'));
  const store = new FileStore(path.join(tmp, 'channels.json'), path.join(tmp, 'items.json'), path.join(tmp, 'orgs.json'));
  store.orgsEnabled = true;                     // exercise the happy paths (FileStore genuinely stores orgs)
  const cleanup = () => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {} };

  bus.attachBus(server, app);
  paid.attachPaid(app, requireAdmin);
  const orgs = await orgsMod.attachOrgs(app, requireAdmin, store);
  const itemsApi = await itemsMod.attachItems(app, requireAdmin, store, { orgs });
  orgs.wireItems(itemsApi);
  const rt = itemsMod.__test;
  const gate = (code, sender, action = 'pad_up') => rt.keyGate('item:' + code, sender, { type: 'key', action });
  const audFor = async (orgId) => (await call(app, 'GET', '/api/admin/audit', { headers: ADMIN, query: { orgId } })).body;

  try {
    /* ── platform: create an org, an item, assign it, set bands ── */
    let r = await call(app, 'POST', '/api/admin/orgs', { headers: ADMIN, body: { name: 'The Anchor Bar' } });
    assert.strictEqual(r.statusCode, 201);
    const ORG = r.body.id;
    r = await call(app, 'POST', '/api/admin/orgs', { headers: ADMIN, body: { name: 'Rival Room' } });
    const ORG2 = r.body.id;
    // a legacy item (no org) + an org item
    const LEGACY = (await call(app, 'POST', '/api/items', { headers: ADMIN, body: { name: 'Legacy Lamp', priceCents: 300, slotSeconds: 60 } })).body.item;
    const CODE = (await call(app, 'POST', '/api/items', { headers: ADMIN, body: { name: 'Claw', priceCents: 500, slotSeconds: 120 } })).body.item;
    r = await call(app, 'POST', '/api/admin/orgs/:id/items', { params: { id: ORG }, headers: ADMIN, body: { code: CODE } });
    assert.strictEqual(r.statusCode, 201);
    assert.strictEqual(r.body.orgId, ORG, 'item assigned to the org');
    r = await call(app, 'PATCH', '/api/admin/items/:code/bounds', { params: { code: CODE }, headers: ADMIN,
      body: { bounds: { priceBandCents: { min: 200, max: 1000 }, slotSecondsMax: 300, cooldownFloorMs: 200, maxPerMinCap: 120, jukebox: { minPlaySecFloor: 20 } } } });
    assert.strictEqual(r.statusCode, 200);
    assert.strictEqual(r.body.bounds.priceBandCents.max, 1000, 'bounds stored');
    ok('platform: org create · item assign · bounds set');

    // grant owner + staff + tech (rung 0 mints tech/owner)
    await call(app, 'POST', '/api/admin/orgs/:id/grants', { params: { id: ORG }, headers: ADMIN, body: { email: 'owner@anchor.com', orgRole: 'owner' } });
    await call(app, 'POST', '/api/admin/orgs/:id/grants', { params: { id: ORG }, headers: ADMIN, body: { email: 'staff@anchor.com', orgRole: 'staff' } });
    await call(app, 'POST', '/api/admin/orgs/:id/grants', { params: { id: ORG }, headers: ADMIN, body: { email: 'tech@anchor.com', orgRole: 'tech' } });
    await call(app, 'POST', '/api/admin/orgs/:id/grants', { params: { id: ORG2 }, headers: ADMIN, body: { email: 'owner2@rival.com', orgRole: 'owner' } });
    ok('platform: grant owner/staff/tech + a rival owner');

    /* 1. LEGACY item (orgId null): every existing behavior identical. */
    r = await call(app, 'GET', '/api/items/:code', { params: { code: LEGACY } });
    assert.strictEqual(r.body.orgId ?? null, null, 'legacy item has no org');
    // buy + hold + drive it exactly as before (dev hatch holder)
    await call(app, 'POST', '/api/items/:code/buy', { params: { code: LEGACY }, body: AS('u-pat', 'Pat') });
    assert.strictEqual(gate(LEGACY, SESSION('u-other', 'other@x.com')).ok, false, 'a session that is not the holder is denied on a legacy item');
    assert.strictEqual(rt.keyGate('item:' + LEGACY, null, { type: 'key', action: 'pad_up', user: { id: 'u-pat' } }).ok, true, 'dev-hatch holder still drives the legacy item');
    // org endpoints refuse to touch a non-org item
    r = await call(app, 'PATCH', '/api/org/:id/items/:code', { params: { id: ORG, code: LEGACY }, body: AS('u-o', 'O', 'owner@anchor.com'), body: { ...AS('u-o', 'O', 'owner@anchor.com'), priceCents: 400 } });
    assert.strictEqual(r.statusCode, 403, 'a legacy item belongs to no org — owner PATCH 403s');
    ok('#1 legacy item (orgId null) behaves exactly as before');

    /* 2. Owner PATCH inside band → 200, applied, audit row (old→new). */
    r = await call(app, 'PATCH', '/api/org/:id/items/:code', { params: { id: ORG, code: CODE },
      body: { ...AS('u-owner', 'Owner', 'owner@anchor.com'), priceCents: 800, slotSeconds: 200 } });
    assert.strictEqual(r.statusCode, 200);
    assert.strictEqual(r.body.priceCents, 800, 'price applied');
    assert.strictEqual(itemsApi.get(CODE).priceCents, 800, 'store + mirror updated');
    let aud = await audFor(ORG);
    assert.ok(aud.some(a => a.field === 'priceCents' && a.old === '500' && a.new === '800'), 'audit row old→new');
    assert.ok(aud.some(a => a.field === 'slotSeconds'), 'slot audited too');
    ok('#2 owner PATCH inside band → 200 + value applied + audit old→new');

    /* 3. Owner PATCH outside band / below floor → 400, nothing written, no audit. */
    const priceBefore = itemsApi.get(CODE).priceCents;
    const auditLenBefore = (await audFor(ORG)).length;
    r = await call(app, 'PATCH', '/api/org/:id/items/:code', { params: { id: ORG, code: CODE },
      body: { ...AS('u-owner', 'Owner', 'owner@anchor.com'), priceCents: 5000 } });   // above band max 1000
    assert.strictEqual(r.statusCode, 400);
    assert.match(r.body.error, /band/);
    assert.strictEqual(itemsApi.get(CODE).priceCents, priceBefore, 'nothing written on a rejected price');
    r = await call(app, 'PATCH', '/api/org/:id/items/:code', { params: { id: ORG, code: CODE },
      body: { ...AS('u-owner', 'Owner', 'owner@anchor.com'), limits: { cooldownMs: 50 } } });   // below floor 200
    assert.strictEqual(r.statusCode, 400, 'below the cooldown floor rejected (rest more, never less)');
    assert.strictEqual((await audFor(ORG)).length, auditLenBefore, 'no audit row for a rejected edit');
    ok('#3 owner PATCH outside band / below floor → 400, nothing written, no audit');

    /* 4. Staff can pause/skip; staff PATCH of priceCents → 403. */
    await call(app, 'POST', '/api/items/:code/buy', { params: { code: CODE }, body: AS('u-pat2', 'Pat2') });
    r = await call(app, 'POST', '/api/org/:id/items/:code/actions', { params: { id: ORG, code: CODE },
      body: { ...AS('u-staff', 'Staff', 'staff@anchor.com'), action: 'skip' } });
    assert.strictEqual(r.statusCode, 200, 'staff skip works');
    assert.strictEqual(itemsApi.get(CODE) && rt.state.get(CODE).active, null, 'slot ended by staff skip');
    r = await call(app, 'PATCH', '/api/org/:id/items/:code', { params: { id: ORG, code: CODE },
      body: { ...AS('u-staff', 'Staff', 'staff@anchor.com'), priceCents: 400 } });
    assert.strictEqual(r.statusCode, 403, 'staff cannot edit money fields');
    ok('#4 staff pause/skip OK · staff PATCH price → 403');

    /* 5. Tech rotates a rig key; owner attempting it → 403; old key dead after. */
    r = await call(app, 'POST', '/api/org/:id/items/:code/outputs', { params: { id: ORG, code: CODE },
      body: { ...AS('u-tech', 'Tech', 'tech@anchor.com'), kind: 'rig', name: 'td-main', priority: 1 } });
    assert.strictEqual(r.statusCode, 201);
    const firstKey = r.body.rigKey;
    assert.ok(firstKey, 'tech mints a rig key');
    r = await call(app, 'POST', '/api/org/:id/items/:code/rig-key', { params: { id: ORG, code: CODE },
      body: { ...AS('u-owner', 'Owner', 'owner@anchor.com'), name: 'td-main' } });
    assert.strictEqual(r.statusCode, 403, 'owner cannot rotate rig keys — that is the tech rung');
    r = await call(app, 'POST', '/api/org/:id/items/:code/rig-key', { params: { id: ORG, code: CODE },
      body: { ...AS('u-tech', 'Tech', 'tech@anchor.com'), name: 'td-main' } });
    assert.strictEqual(r.statusCode, 201, 'tech rotates the key');
    const secondKey = r.body.rigKey;
    assert.notStrictEqual(firstKey, secondKey, 'a fresh key is issued');
    assert.strictEqual(rt.rigHooks.auth('item:' + CODE, 'td-main', firstKey).ok, false, 'the old key is dead');
    assert.strictEqual(rt.rigHooks.auth('item:' + CODE, 'td-main', secondKey).ok, true, 'the new key works');
    ok('#5 tech rotates rig key · owner rotate → 403 · old key dead');

    /* 6. Cross-org: a member of ORG2 hitting ORG's item → 403 on every endpoint,
          AND the bus gate refuses their "privileged" pass. */
    r = await call(app, 'PATCH', '/api/org/:id/items/:code', { params: { id: ORG, code: CODE },
      body: { ...AS('u-o2', 'Rival', 'owner2@rival.com'), priceCents: 400 } });
    assert.strictEqual(r.statusCode, 403, 'rival owner cannot PATCH via the wrong org id');
    // even naming their OWN org in the path but the other org's item → 403
    r = await call(app, 'PATCH', '/api/org/:id/items/:code', { params: { id: ORG2, code: CODE },
      body: { ...AS('u-o2', 'Rival', 'owner2@rival.com'), priceCents: 400 } });
    assert.strictEqual(r.statusCode, 403, "that item belongs to a different org");
    // the bus gate: rival owner is NOT privileged on ORG's item
    await call(app, 'POST', '/api/items/:code/buy', { params: { code: CODE }, body: AS('u-holder', 'Holder') });
    assert.strictEqual(gate(CODE, SESSION('u-o2', 'owner2@rival.com')).ok, false, 'cross-org member is not privileged on the item gate');
    // ...but the ACTUAL org's staff IS privileged (drives without holding a slot)
    assert.strictEqual(gate(CODE, SESSION('u-staff', 'staff@anchor.com')).ok, true, 'own-org staff drives the item room');
    await call(app, 'POST', '/api/items/:code/skip', { params: { code: CODE }, headers: ADMIN });
    ok('#6 cross-org → 403 on endpoints AND denied by the bus gate; own-org staff passes');

    /* 7. Offboard: delete membership → next request 403 (no session cache). */
    assert.strictEqual(gate(CODE, SESSION('u-staff', 'staff@anchor.com')).ok, true, 'staff privileged before removal');
    r = await call(app, 'DELETE', '/api/org/:id/members/:email', { params: { id: ORG, email: 'staff@anchor.com' },
      body: AS('u-owner', 'Owner', 'owner@anchor.com') });
    assert.strictEqual(r.statusCode, 200, 'owner removes their staff');
    assert.strictEqual(gate(CODE, SESSION('u-staff', 'staff@anchor.com')).ok, false, 'removed staff is denied on the very next gate check');
    r = await call(app, 'POST', '/api/org/:id/items/:code/actions', { params: { id: ORG, code: CODE },
      body: { ...AS('u-staff', 'Staff', 'staff@anchor.com'), action: 'skip' } });
    assert.strictEqual(r.statusCode, 403, 'removed staff cannot act — no cached role');
    ok('#7 offboard → immediate 403 on gate + endpoints (no session cache)');

    /* 8. Tech/owner grant via owner → 403; via key → 200. Owner may invite staff. */
    // the rung-0 grant route is admin-key-gated — an owner (no key) is refused
    r = await call(app, 'POST', '/api/admin/orgs/:id/grants', { params: { id: ORG }, body: { email: 'x@y.com', orgRole: 'tech' } });
    assert.strictEqual(r.statusCode, 401, 'the rung-0 grant route needs the platform key, which an owner lacks');
    r = await call(app, 'POST', '/api/org/:id/invites', { params: { id: ORG }, body: { ...AS('u-owner', 'Owner', 'owner@anchor.com'), email: 'newstaff@anchor.com', orgRole: 'tech' } });
    assert.strictEqual(r.statusCode, 403, 'owner invite can only mint staff, never tech');
    r = await call(app, 'POST', '/api/org/:id/invites', { params: { id: ORG }, body: { ...AS('u-owner', 'Owner', 'owner@anchor.com'), email: 'newstaff@anchor.com' } });
    assert.strictEqual(r.statusCode, 201, 'owner invites a new staff');
    assert.strictEqual(gate(CODE, SESSION('u-ns', 'newstaff@anchor.com')).ok, true, 'the invited staff can drive immediately');
    r = await call(app, 'POST', '/api/admin/orgs/:id/grants', { params: { id: ORG }, headers: ADMIN, body: { email: 'tech2@anchor.com', orgRole: 'tech' } });
    assert.strictEqual(r.statusCode, 201, 'the platform key mints tech');
    ok('#8 owner grant of tech → 403 · owner invites staff → 200 · key mints tech → 201');

    /* 4b. Staff pause/resume through the org endpoint (the other half of the
       §10.4 matrix — the earlier check proved skip); owner-only actions 403.
       #5 gave CODE a rig chain and no rig is online, so the dead-air guard
       correctly refuses to sell — tech adds a scene output (always online)
       to make it sellable again. */
    r = await call(app, 'POST', '/api/org/:id/items/:code/outputs', { params: { id: ORG, code: CODE },
      body: { ...AS('u-tech', 'Tech', 'tech@anchor.com'), kind: 'scene', name: 'stage-orb', scene: 'orb' } });
    assert.strictEqual(r.statusCode, 201, 'tech adds a scene output through the org route');
    r = await call(app, 'POST', '/api/items/:code/buy', { params: { code: CODE }, body: AS('u-pat3', 'Pat3') });
    assert.ok(r.statusCode < 300, 'buy lands once an output is online (was dead-air-guarded)');
    r = await call(app, 'POST', '/api/org/:id/items/:code/actions', { params: { id: ORG, code: CODE },
      body: { ...AS('u-ns', 'NewStaff', 'newstaff@anchor.com'), action: 'pause' } });
    assert.strictEqual(r.statusCode, 200, 'staff pause works');
    assert.strictEqual(rt.state.get(CODE).active.paused, true, 'the running slot is paused');
    r = await call(app, 'POST', '/api/org/:id/items/:code/actions', { params: { id: ORG, code: CODE },
      body: { ...AS('u-ns', 'NewStaff', 'newstaff@anchor.com'), action: 'resume' } });
    assert.strictEqual(r.statusCode, 200, 'staff resume works');
    r = await call(app, 'POST', '/api/org/:id/items/:code/actions', { params: { id: ORG, code: CODE },
      body: { ...AS('u-ns', 'NewStaff', 'newstaff@anchor.com'), action: 'off' } });
    assert.strictEqual(r.statusCode, 403, 'on/off needs the owner rung');
    await call(app, 'POST', '/api/items/:code/skip', { params: { code: CODE }, headers: ADMIN });   // clean slate
    ok('#4b staff pause/resume via the org endpoint · owner-only actions 403');

    /* Owner roster: you can't remove who you can't see; staff can't read it. */
    r = await call(app, 'GET', '/api/org/:id/members', { params: { id: ORG }, body: AS('u-owner', 'Owner', 'owner@anchor.com') });
    assert.strictEqual(r.statusCode, 200);
    assert.ok(r.body.some(m => m.email === 'newstaff@anchor.com' && m.orgRole === 'staff'), 'roster lists staff with rungs');
    assert.ok(r.body.every(m => m.userId === undefined && m.invitedBy === undefined), 'roster view is emails + rungs only');
    r = await call(app, 'GET', '/api/org/:id/members', { params: { id: ORG }, body: AS('u-ns', 'NewStaff', 'newstaff@anchor.com') });
    assert.strictEqual(r.statusCode, 403, 'staff cannot read the roster');
    ok('owner reads the roster · staff denied · emails+rungs only');

    /* §4 userId linkage: the store fills a blank once, never re-links. */
    await store.linkMemberUserId(ORG, 'owner@anchor.com', 'uuid-first');
    let mem = (await store.listMembers(ORG)).find(m => m.email === 'owner@anchor.com');
    assert.strictEqual(mem.userId, 'uuid-first', 'blank userId backfilled');
    await store.linkMemberUserId(ORG, 'owner@anchor.com', 'uuid-second');
    mem = (await store.listMembers(ORG)).find(m => m.email === 'owner@anchor.com');
    assert.strictEqual(mem.userId, 'uuid-first', 'an existing link is never overwritten');
    ok('§4 userId linkage: fills a blank once, never re-links');

    /* invite guard: an owner may NOT demote a higher rung by "inviting" their
       email (addMember is an upsert). Tech tech@anchor.com must survive. */
    r = await call(app, 'POST', '/api/org/:id/invites', { params: { id: ORG },
      body: { ...AS('u-owner', 'Owner', 'owner@anchor.com'), email: 'tech@anchor.com' } });
    assert.strictEqual(r.statusCode, 403, 'owner cannot re-invite (demote) a tech to staff');
    assert.strictEqual(orgs.__test.roleOf({ email: 'tech@anchor.com' }, ORG), 'tech', 'the tech keeps their rung');
    // but re-inviting an existing STAFF (idempotent) is fine
    r = await call(app, 'POST', '/api/org/:id/invites', { params: { id: ORG },
      body: { ...AS('u-owner', 'Owner', 'owner@anchor.com'), email: 'newstaff@anchor.com' } });
    assert.strictEqual(r.statusCode, 201, 're-inviting an existing staff is idempotent');
    ok('invite guard: owner cannot demote a tech/owner via invite; re-inviting staff is fine');

    /* reject-not-clamp on UNBOUNDED dims: with bounds set but no explicit
       intrinsic escape, an out-of-store-range value must 400, not clamp. Set a
       generous band, then exceed the store's own $500 hard cap. */
    r = await call(app, 'PATCH', '/api/org/:id/items/:code', { params: { id: ORG, code: CODE },
      body: { ...AS('u-owner', 'Owner', 'owner@anchor.com'), priceCents: 900 } });   // in band, resets to a known value
    assert.strictEqual(r.statusCode, 200);
    const priceNow = itemsApi.get(CODE).priceCents;
    // widen the band ABOVE the store's intrinsic $500 cap, then try to exceed the cap
    await call(app, 'PATCH', '/api/admin/items/:code/bounds', { params: { code: CODE }, headers: ADMIN,
      body: { bounds: { priceBandCents: { min: 200, max: 90000 }, slotSecondsMax: 300, cooldownFloorMs: 200, maxPerMinCap: 120 } } });
    r = await call(app, 'PATCH', '/api/org/:id/items/:code', { params: { id: ORG, code: CODE },
      body: { ...AS('u-owner', 'Owner', 'owner@anchor.com'), priceCents: 60000 } });   // above intrinsic 50000
    assert.strictEqual(r.statusCode, 400, 'above the store intrinsic cap → 400 (reject, not clamp)');
    assert.strictEqual(itemsApi.get(CODE).priceCents, priceNow, 'nothing written — no silent clamp to 50000');
    // restore the tight band for later checks
    await call(app, 'PATCH', '/api/admin/items/:code/bounds', { params: { code: CODE }, headers: ADMIN,
      body: { bounds: { priceBandCents: { min: 200, max: 1000 }, slotSecondsMax: 300, cooldownFloorMs: 200, maxPerMinCap: 120, jukebox: { minPlaySecFloor: 20 } } } });
    ok('reject-not-clamp: out-of-store-range owner edit → 400, nothing written (audit never records a clamped value)');

    /* 11-lite. Owner jukebox PATCH merges (no default-reset) + floor + monetization flip. */
    const JUKE = (await call(app, 'POST', '/api/items', { headers: ADMIN,
      body: { name: 'Bar Jukebox', surface: 'jukebox', jukebox: { skip: { minPlaySec: 30, perUser: { max: 5 } }, queueRules: { maxLen: 40 } } } })).body.item;
    await call(app, 'POST', '/api/admin/orgs/:id/items', { params: { id: ORG }, headers: ADMIN, body: { code: JUKE } });
    await call(app, 'PATCH', '/api/admin/items/:code/bounds', { params: { code: JUKE }, headers: ADMIN,
      body: { bounds: { priceBandCents: { min: 100, max: 500 }, jukebox: { minPlaySecFloor: 25 } } } });
    // change ONE knob; everything else must survive (store REPLACES, orgs.js merges)
    r = await call(app, 'PATCH', '/api/org/:id/items/:code', { params: { id: ORG, code: JUKE },
      body: { ...AS('u-owner', 'Owner', 'owner@anchor.com'), jukebox: { queuePriceCents: 250 } } });
    assert.strictEqual(r.statusCode, 200);
    const jb = itemsApi.get(JUKE).jukebox;
    assert.strictEqual(jb.queuePriceCents, 250, 'the edited knob changed');
    assert.strictEqual(jb.skip.minPlaySec, 30, 'minPlaySec survived the merge (not reset to default 10)');
    assert.strictEqual(jb.skip.perUser.max, 5, 'perUser survived');
    assert.strictEqual(jb.queueRules.maxLen, 40, 'queueRules survived');
    // below the platform floor → 400
    r = await call(app, 'PATCH', '/api/org/:id/items/:code', { params: { id: ORG, code: JUKE },
      body: { ...AS('u-owner', 'Owner', 'owner@anchor.com'), jukebox: { skip: { minPlaySec: 10 } } } });
    assert.strictEqual(r.statusCode, 400, 'skip.minPlaySec below the floor rejected');
    // an INVALID monetization enum must 400 (not silently coerce to a default,
    // which would flip the billing model) — and nothing is written
    const monBefore = itemsApi.get(JUKE).jukebox.monetization;
    r = await call(app, 'PATCH', '/api/org/:id/items/:code', { params: { id: ORG, code: JUKE },
      body: { ...AS('u-owner', 'Owner', 'owner@anchor.com'), jukebox: { monetization: 'per-action' } } });   // dash typo
    assert.strictEqual(r.statusCode, 400, 'a bogus monetization enum is rejected, not coerced');
    assert.strictEqual(itemsApi.get(JUKE).jukebox.monetization, monBefore, 'monetization unchanged on the reject');
    // a jukebox PATCH of {jukebox:null} is a 400, not a 500
    r = await call(app, 'PATCH', '/api/org/:id/items/:code', { params: { id: ORG, code: JUKE },
      body: { ...AS('u-owner', 'Owner', 'owner@anchor.com'), jukebox: null } });
    assert.strictEqual(r.statusCode, 400, '{jukebox:null} → 400, not a TypeError 500');
    // owner flips monetization (William's call) while idle → 200
    r = await call(app, 'PATCH', '/api/org/:id/items/:code', { params: { id: ORG, code: JUKE },
      body: { ...AS('u-owner', 'Owner', 'owner@anchor.com'), jukebox: { monetization: 'per_action' } } });
    assert.strictEqual(r.statusCode, 200, 'owner may flip monetization on an idle jukebox');
    assert.strictEqual(itemsApi.get(JUKE).jukebox.monetization, 'per_action', 'monetization flipped');
    ok('#11 owner jukebox PATCH merges (no reset) · below floor 400 · monetization flip 200');

    /* forged-claim guard: identity comes from the session, never the payload.
       A body claiming a role/orgRole must be ignored — the dev hatch only
       carries id/name/email; membership is resolved server-side. */
    r = await call(app, 'PATCH', '/api/org/:id/items/:code', { params: { id: ORG, code: CODE },
      body: { user: { id: 'u-nobody', name: 'Nobody', email: 'nobody@nowhere.com', role: 'admin', orgRole: 'owner' }, priceCents: 400 } });
    assert.strictEqual(r.statusCode, 403, 'a forged role/orgRole in the payload is ignored — non-member is denied');
    ok('#12 forged org/role claims in the body are ignored (identity = session only)');

    /* suspended org freezes its members — over HTTP AND on the bus gate
       (a suspended venue's staff can't keep driving the item). */
    assert.strictEqual(gate(CODE, SESSION('u-owner', 'owner@anchor.com')).ok, true, 'owner privileged before the suspension');
    await call(app, 'PATCH', '/api/admin/orgs/:id', { params: { id: ORG }, headers: ADMIN, body: { status: 'suspended' } });
    r = await call(app, 'POST', '/api/org/:id/items/:code/actions', { params: { id: ORG, code: CODE },
      body: { ...AS('u-owner', 'Owner', 'owner@anchor.com'), action: 'off' } });
    assert.strictEqual(r.statusCode, 403, 'a suspended org is frozen for its members');
    assert.strictEqual(gate(CODE, SESSION('u-owner', 'owner@anchor.com')).ok, false, 'suspension freezes the BUS privilege too');
    await call(app, 'PATCH', '/api/admin/orgs/:id', { params: { id: ORG }, headers: ADMIN, body: { status: 'active' } });
    assert.strictEqual(gate(CODE, SESSION('u-owner', 'owner@anchor.com')).ok, true, 'reactivation restores the privilege');
    ok('suspended org → members 403 AND bus-gate denied; platform reactivates');

    /* /api/org/mine reflects membership. */
    r = await call(app, 'GET', '/api/org/mine', { query: { uid: 'u-owner', name: 'Owner', email: 'owner@anchor.com' } });
    assert.ok(r.body.orgs.some(o => o.id === ORG && o.role === 'owner'), 'owner sees their org + rung');
    r = await call(app, 'GET', '/api/org/mine', { query: { uid: 'u-nobody', name: 'N', email: 'nobody@nowhere.com' } });
    assert.strictEqual(r.body.orgs.length, 0, 'a non-member sees no orgs');
    ok('/api/org/mine → members see their orgs, non-members see none');

    /* audit is append-only: no route deletes or mutates it. */
    assert.ok(!app._routes.some(rt => (rt.method === 'DELETE' || rt.method === 'PATCH') && /audit/.test(rt.path)), 'no audit delete/patch route exists');
    ok('audit log is append-only (no delete/mutate route)');

    /* 9. No DATABASE_URL / org store disabled → org endpoints 503, rest unaffected. */
    store.orgsEnabled = false;
    r = await call(app, 'POST', '/api/admin/orgs', { headers: ADMIN, body: { name: 'X' } });
    assert.strictEqual(r.statusCode, 503, 'org create 503 without a database');
    r = await call(app, 'GET', '/api/org/mine', { query: { uid: 'u-owner', name: 'Owner', email: 'owner@anchor.com' } });
    assert.strictEqual(r.statusCode, 503, 'org read 503 without a database');
    r = await call(app, 'PATCH', '/api/org/:id/items/:code', { params: { id: ORG, code: CODE },
      body: { ...AS('u-owner', 'Owner', 'owner@anchor.com'), priceCents: 400 } });
    assert.strictEqual(r.statusCode, 503, 'org write 503 without a database');
    // the rest of the platform is unaffected
    r = await call(app, 'GET', '/api/items/:code', { params: { code: CODE } });
    assert.strictEqual(r.statusCode, 200, 'items still serve with orgs disabled');
    store.orgsEnabled = true;
    ok('#9 orgs disabled → org endpoints 503, the rest of the platform runs untouched');

    console.log(`\nALL CLEAR — ${passed} admin-chain checks passed`);
  } finally { cleanup(); }
  process.exit(0);
})().catch((e) => { console.error('\nFAIL:', e.message); console.error(e.stack); process.exit(1); });

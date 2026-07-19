/* Headless smoke test for control-ops.html (Volt Control · ops) — the admin
   dashboard that split out of control.html. Same jsdom harness style as
   .smoke-control.cjs: evals the whole page, stubs fetch/canvas, and drives
   the key gate → dashboard → create/QR/actions/edit/chain flows.

   jsdom landmines (HANDOFF): page-scope const/let are unreachable from a
   separate eval — drive through window.__* shims and DOM clicks; fetches
   resolve on microtasks — `await new Promise(setImmediate)` between action
   and assert.

   Run:  node .smoke-ops.cjs   — must exit 0.  */
'use strict';
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { JSDOM } = (() => {
  try { return require('jsdom'); }
  catch { return require(path.join('/tmp', 'node_modules', 'jsdom')); }
})();

const html = fs.readFileSync(path.join(__dirname, 'control-ops.html'), 'utf8');
const dom = new JSDOM(html, { runScripts: 'outside-only', url: 'http://localhost/control-ops' });
const w = dom.window;
const errors = [];
w.addEventListener('error', (e) => errors.push('window.onerror: ' + e.message));

/* ── stubs ── */
w.HTMLCanvasElement.prototype.getContext = function(){ return { fillRect(){}, fillStyle: '' }; };
w.confirm = () => true;
w.print = () => {};

const now = () => Date.now();
const DB = {
  PSDV7H: { type: 'item_queues', item: 'PSDV7H', name: 'Lobby Lamp', description: 'tilt', instructions: 'tilt · strobe',
    mode: 'buynow', priceCents: 500, slotSeconds: 120, auctionSeconds: 60, minIncrementCents: 50,
    status: 'on', outputs: [], active: null, queue: [], auction: null, ts: 0,
    // admin-chain fields (orgView shape): assigned to the anchor venue
    orgId: 'anchor', hours: null, plays: 7,
    bounds: { priceBandCents: { min: 200, max: 1000 }, slotSecondsMax: 300, cooldownFloorMs: 200, maxPerMinCap: 120 },
    limits: { cooldownMs: 250, maxPerMin: 60 } },
  '2AWK6P': { type: 'item_queues', item: '2AWK6P', name: 'Laser Head', description: null,
    mode: 'auction', priceCents: 200, slotSeconds: 60, auctionSeconds: 45, minIncrementCents: 50,
    status: 'on', outputs: [], active: null, queue: [], auction: null, ts: 0,
    orgId: 'rival', plays: 0 },   // the RIVAL venue's item — must never render for anchor members
  JUKE01: { type: 'item_queues', item: 'JUKE01', name: 'Bar Jukebox', description: 'music', instructions: '',
    surface: 'jukebox', mode: 'buynow', priceCents: 500, slotSeconds: 120, auctionSeconds: 60, minIncrementCents: 50,
    status: 'on', outputs: [{ kind: 'rig', name: 'pi-jukebox', priority: 1 }], active: null, queue: [], auction: null, ts: 0,
    orgId: 'anchor', plays: 3,
    jukebox: { monetization: 'per_action', mode: 'buynow', backend: 'log', houseMode: true,
      nowPlaying: null, queueLen: 1,
      queue: [{ position: 1, songId: 'aaa', title: 'Song A', byName: 'Pat', byId: 'u1', playNext: false }],
      catalog: [{ id: 'aaa', title: 'Song A', artist: 'A', durationSec: 180 }, { id: 'bbb', title: 'Song B', artist: 'B', durationSec: 200 }],
      prices: { queueCents: 200, playNextCents: 400, skipCents: 100 }, skipState: { roomLeft: 6 }, bidRound: null },
    // admin-only raw config (the real GET /api/items attaches this for jukebox items)
    jukeboxConfig: { monetization: 'per_action', mode: 'buynow', backend: 'log', houseMode: true,
      queuePriceCents: 200, playNextPriceCents: 400,
      skip: { priceCents: 100, allowMidSong: false, onlyBeforeSec: 15, minPlaySec: 10, perUser: { max: 2, windowMin: 30 }, global: { max: 6, windowMin: 60 } },
      queueRules: { maxLen: 25, maxPerUser: 3, noRepeatMin: 60 },
      catalog: [{ id: 'aaa', title: 'Song A', artist: 'A', file: 'a.mp3', durationSec: 180 }, { id: 'bbb', title: 'Song B', artist: 'B', file: 'b.mp3', durationSec: 200 }] } },
};
let lastCreate = null;   // last POST /api/items body (assert surface/jukebox flow)
let lastOrgPatch = null; // last PATCH /api/org/:id/items/:code body (assert diff-not-full-config)
const payload = (code) => JSON.parse(JSON.stringify({ ...DB[code], ts: now() }));
const respond = (status, body) => Promise.resolve({ ok: status < 400, status, json: () => Promise.resolve(body) });
const calls = [];   // record method+path so we can assert the right endpoint fired

/* ── the admin chain: orgs + a simulated cookie session ── */
const ORGS = {
  anchor: { id: 'anchor', name: 'The Anchor Bar', slug: 'anchor', status: 'active',
    members: [{ email: 'owner@anchor.com', orgRole: 'owner' },
              { email: 'staff@anchor.com', orgRole: 'staff' },
              { email: 'tech@anchor.com', orgRole: 'tech' }] },
  rival: { id: 'rival', name: 'Rival Room', slug: 'rival', status: 'active',
    members: [{ email: 'owner2@rival.com', orgRole: 'owner' }] },
};
const AUDIT = [{ id: 1, orgId: 'anchor', actorUserId: 'u-owner', itemCode: 'PSDV7H',
  field: 'priceCents', old: '500', new: '800', at: '2026-07-19T12:00:00Z' }];
let sessionUser = null;              // the signed-in account (httpOnly-cookie stand-in); null = signed out
const roleFor = (orgId) => {
  if (!sessionUser || !ORGS[orgId]) return null;
  const mm = ORGS[orgId].members.find(x => x.email === sessionUser.email);
  return mm ? mm.orgRole : null;
};
const keyedCalls = [];               // every fetch that carried a truthy X-Admin-Key (session lens must add none)

w.fetch = (url, opts = {}) => {
  const u = String(url);
  const method = (opts.method || 'GET').toUpperCase();
  const headers = opts.headers || {};
  const body = opts.body ? JSON.parse(opts.body) : {};
  const admin = headers['X-Admin-Key'] === 'dev';
  calls.push(method + ' ' + u.replace(/^https?:\/\/[^/]+/, ''));
  if (headers['X-Admin-Key']) keyedCalls.push(method + ' ' + u.replace(/^https?:\/\/[^/]+/, ''));
  let m;

  /* ── admin chain routes · key lens (X-Admin-Key) ── */
  if (/\/api\/admin\/orgs$/.test(u)){
    if (!admin) return respond(401, { error: 'admin key required' });
    if (method === 'GET') return respond(200, Object.values(ORGS).map(o => JSON.parse(JSON.stringify(o))));
    if (method === 'POST'){
      const id = String(body.name || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
      ORGS[id] = { id, name: body.name, slug: id, status: 'active', members: [] };
      return respond(201, JSON.parse(JSON.stringify(ORGS[id])));
    }
  }
  m = u.match(/\/api\/admin\/orgs\/([^/]+)\/items$/);
  if (m && method === 'POST'){
    if (!admin) return respond(401, { error: 'admin key required' });
    DB[body.code].orgId = m[1];
    return respond(201, payload(body.code));
  }
  m = u.match(/\/api\/admin\/orgs\/([^/]+)\/items\/([A-Z0-9]{6})$/);
  if (m && method === 'DELETE'){
    if (!admin) return respond(401, { error: 'admin key required' });
    DB[m[2]].orgId = null;
    return respond(200, payload(m[2]));
  }
  m = u.match(/\/api\/admin\/items\/([A-Z0-9]{6})\/bounds$/);
  if (m && method === 'PATCH'){
    if (!admin) return respond(401, { error: 'admin key required' });
    DB[m[1]].bounds = body.bounds;
    return respond(200, payload(m[1]));
  }
  m = u.match(/\/api\/admin\/orgs\/([^/]+)\/grants$/);
  if (m && method === 'POST'){
    if (!admin) return respond(401, { error: 'admin key required' });
    ORGS[m[1]].members.push({ email: body.email, orgRole: body.orgRole });
    return respond(201, { orgId: m[1], email: body.email, orgRole: body.orgRole });
  }
  m = u.match(/\/api\/admin\/orgs\/([^/]+)\/members\/([^/]+)$/);
  if (m && method === 'DELETE'){
    if (!admin) return respond(401, { error: 'admin key required' });
    ORGS[m[1]].members = ORGS[m[1]].members.filter(x => x.email !== decodeURIComponent(m[2]));
    return respond(200, { ok: true });
  }
  m = u.match(/\/api\/admin\/orgs\/([^/]+)$/);
  if (m && method === 'PATCH'){
    if (!admin) return respond(401, { error: 'admin key required' });
    if (body.status) ORGS[m[1]].status = body.status;
    if (body.name) ORGS[m[1]].name = body.name;
    return respond(200, JSON.parse(JSON.stringify(ORGS[m[1]])));
  }
  if (/\/api\/admin\/audit\?/.test(u)){
    if (!admin) return respond(401, { error: 'admin key required' });
    return respond(200, JSON.parse(JSON.stringify(AUDIT)));
  }

  /* ── admin chain routes · session lens (cookie session; NO key involved) ── */
  if (/\/api\/org\/mine$/.test(u)){
    if (!sessionUser) return respond(401, { error: 'sign in first' });
    const orgs = Object.keys(ORGS).filter(roleFor).map(id =>
      ({ id, name: ORGS[id].name, status: ORGS[id].status, role: roleFor(id) }));
    return respond(200, { me: { ...sessionUser }, orgs });
  }
  m = u.match(/\/api\/org\/([^/]+)\/items$/);
  if (m && method === 'GET'){
    if (!roleFor(m[1])) return respond(403, { error: 'you do not have that permission in this org' });
    return respond(200, Object.values(DB).filter(i => i.orgId === m[1]).map(i => payload(i.item)));
  }
  m = u.match(/\/api\/org\/([^/]+)\/members$/);
  if (m && method === 'GET'){
    if (roleFor(m[1]) !== 'owner') return respond(403, { error: 'owner only' });
    return respond(200, ORGS[m[1]].members.map(x => ({ ...x })));
  }
  m = u.match(/\/api\/org\/([^/]+)\/items\/([A-Z0-9]{6})\/actions$/);
  if (m && method === 'POST'){
    const role = roleFor(m[1]);
    if (!role) return respond(403, { error: 'you do not have that permission in this org' });
    if (['on', 'off', 'clear_queue'].includes(body.action) && role !== 'owner')
      return respond(403, { error: 'that action needs the owner rung' });
    if (body.action === 'on' || body.action === 'off') DB[m[2]].status = body.action;
    if (body.action === 'clear_queue' && DB[m[2]].jukebox){ DB[m[2]].jukebox.queue = []; DB[m[2]].jukebox.queueLen = 0; }
    return respond(200, payload(m[2]));
  }
  m = u.match(/\/api\/org\/([^/]+)\/items\/([A-Z0-9]{6})\/rig-key$/);
  if (m && method === 'POST'){
    if (roleFor(m[1]) !== 'tech') return respond(403, { error: "only the org's tech may do that" });
    return respond(201, { rigKey: 'R'.repeat(32), item: payload(m[2]) });
  }
  m = u.match(/\/api\/org\/([^/]+)\/items\/([A-Z0-9]{6})$/);
  if (m && method === 'PATCH'){
    if (roleFor(m[1]) !== 'owner') return respond(403, { error: 'you do not have that permission in this org' });
    const item = DB[m[2]];
    if (!item || item.orgId !== m[1]) return respond(403, { error: 'that item belongs to a different org' });
    lastOrgPatch = body;                         // capture the body so tests can assert it's a DIFF, not the full config
    const band = item.bounds && item.bounds.priceBandCents;
    if (body.priceCents != null && band && (body.priceCents < band.min || body.priceCents > band.max))
      return respond(400, { error: `priceCents must be within ${band.min}–${band.max} cents (your band)` });
    if (body.priceCents != null) item.priceCents = body.priceCents;
    if (body.slotSeconds != null) item.slotSeconds = body.slotSeconds;
    if (body.controller) item.controller = body.controller;
    if (body.hours !== undefined) item.hours = body.hours;
    if (body.limits) item.limits = { ...item.limits, ...body.limits };
    return respond(200, payload(m[2]));
  }
  m = u.match(/\/api\/org\/([^/]+)\/invites$/);
  if (m && method === 'POST'){
    if (roleFor(m[1]) !== 'owner') return respond(403, { error: 'owner only' });
    ORGS[m[1]].members.push({ email: body.email, orgRole: 'staff' });
    return respond(201, { orgId: m[1], email: body.email, orgRole: 'staff' });
  }
  m = u.match(/\/api\/org\/([^/]+)\/audit$/);
  if (m && method === 'GET'){
    if (roleFor(m[1]) !== 'owner') return respond(403, { error: 'owner only' });
    return respond(200, JSON.parse(JSON.stringify(AUDIT)));
  }

  m = u.match(/\/api\/items\/([A-Z0-9]{6})\/outputs\/([^/?]+)$/);
  if (m && method === 'DELETE'){
    if (!admin) return respond(401, { error: 'bad admin key' });
    const p = DB[m[1]]; p.outputs = (p.outputs || []).filter(o => o.name !== decodeURIComponent(m[2]));
    return respond(200, payload(m[1]));
  }
  m = u.match(/\/api\/items\/([A-Z0-9]{6})\/outputs$/);
  if (m && method === 'POST'){
    if (!admin) return respond(401, { error: 'bad admin key' });
    const p = DB[m[1]]; p.outputs = p.outputs || [];
    p.outputs.push({ kind: body.kind, name: body.name, priority: body.priority || p.outputs.length + 1, ...(body.scene ? { scene: body.scene } : {}) });
    const item = payload(m[1]);
    return respond(201, body.kind === 'rig' ? { rigKey: 'K'.repeat(32), item } : { item });
  }
  m = u.match(/\/api\/items\/([A-Z0-9]{6})\/jukebox\/admin$/);
  if (m){
    if (!admin) return respond(401, { error: 'bad admin key' });
    const jb = DB[m[1]].jukebox, cfg = DB[m[1]].jukeboxConfig;
    if (body.action === 'force_skip') jb.nowPlaying = null;
    else if (body.action === 'clear_queue'){ jb.queue = []; jb.queueLen = 0; }
    else if (body.action === 'house'){ cfg.houseMode = !!body.on; jb.houseMode = !!body.on; }
    else if (body.action === 'remove'){ jb.queue = jb.queue.filter(q => !(q.songId === body.songId && q.byId === body.byId)); jb.queueLen = jb.queue.length; }
    const resp = payload(m[1]); delete resp.jukeboxConfig;   // prod returns publicItem (no config) — merge must preserve it
    return respond(200, resp);
  }
  m = u.match(/\/api\/items\/([A-Z0-9]{6})\/(skip|state)$/);
  if (m){
    if (!admin) return respond(401, { error: 'bad admin key' });
    if (m[2] === 'state' && (body.action === 'on' || body.action === 'off')) DB[m[1]].status = body.action;
    return respond(200, payload(m[1]));
  }
  m = u.match(/\/api\/items\/([A-Z0-9]{6})$/);
  if (m){
    if (!admin) return respond(401, { error: 'bad admin key' });
    if (method === 'PATCH'){
      if (body.name) DB[m[1]].name = body.name;
      if (body.controller) DB[m[1]].controller = body.controller;
      if (body.surface === 'jukebox' && body.jukebox) DB[m[1]].jukeboxConfig = JSON.parse(JSON.stringify(body.jukebox));
      return respond(200, payload(m[1]));
    }
    if (method === 'DELETE'){ delete DB[m[1]]; return respond(204, null); }
  }
  if (/\/api\/items$/.test(u)){
    if (!admin) return respond(401, { error: 'bad admin key' });
    if (method === 'GET') return respond(200, Object.keys(DB).map(payload));
    if (method === 'POST'){
      lastCreate = body;
      DB.NEW111 = { ...JSON.parse(JSON.stringify(DB.PSDV7H)), item: 'NEW111', name: body.name, outputs: [],
        orgId: null, bounds: null, limits: null, plays: 0,   // fresh items are platform-owned (matches the real server)
        surface: body.surface || 'pad', ...(body.surface === 'jukebox' ? { jukebox: JSON.parse(JSON.stringify(DB.JUKE01.jukebox)), jukeboxConfig: JSON.parse(JSON.stringify(DB.JUKE01.jukeboxConfig)) } : {}) };
      return respond(201, payload('NEW111'));
    }
  }
  return respond(404, { error: 'unhandled ' + method + ' ' + u });
};

/* ── run the page script ── */
const script = html.match(/<script>([\s\S]*)<\/script>/)[1];
w.eval(script);
const tick = () => new Promise(setImmediate);
let passed = 0;
const ok = (label) => { console.log('OK  ', passed + 1, label); passed++; };
const $ = (id) => w.document.getElementById(id);

(async () => {
  await tick();
  assert.strictEqual(errors.length, 0, 'page errors: ' + errors.join(' | '));
  // the split invariant, from the ops side: NO user product code ships here.
  assert.strictEqual(typeof w.__submitCode, 'undefined', 'no user submitCode shim on ops');
  assert.strictEqual(typeof w.__fire, 'undefined', 'no controller shim on ops');
  assert.ok(!/id="viewController"|id="viewEntry"|function submitCode|function liveSync/.test(html), 'ops page ships no user views/JS');
  assert.ok(!$('viewAdmin').hidden, 'ops opens straight on the dashboard gate');
  ok('ops page evals clean → dashboard gate, no user product code');

  // wrong key rejected, dashboard stays gated
  assert.strictEqual(await w.__unlockAdmin('nope'), false);
  assert.match($('adminGateMsg').textContent, /wrong key/);
  assert.ok($('adminDash').hidden, 'dash stays hidden on a bad key');
  ok('key gate: wrong key → "wrong key", dashboard stays locked');

  // right key → dashboard renders both items
  assert.strictEqual(await w.__unlockAdmin('dev'), true);
  assert.ok($('adminGate').hidden && !$('adminDash').hidden, 'gate swapped for dash');
  let cards = w.document.querySelectorAll('#adminList .icard');
  assert.strictEqual(cards.length, 3, 'all three items listed (pad, auction, jukebox)');
  ok('unlock: dev key → dashboard renders the item list');

  // create → new code + QR modal opens (+ the chosen controller rides the body)
  $('nItemName').value = 'Fog Machine';
  $('nItemController').value = 'grid';
  await w.__createItem(); await tick();
  assert.strictEqual(lastCreate.controller, 'grid', 'create body carries the chosen controller');
  assert.ok(!$('qrModal').hidden, 'QR modal opens on create');
  assert.strictEqual($('qrCode').textContent, 'NEW111', 'the new code shows big');
  assert.ok($('qrCanvas').width > 0, 'a QR matrix was drawn');
  $('qrClose').click();
  ok('create item → code minted + QR poster modal');

  // card actions hit the right endpoints (each action re-renders the list, so
  // re-query the card node between clicks — the old node detaches).
  const cardBtn = (act) => w.document.querySelector(`#adminList .icard[data-code="PSDV7H"] [data-act="${act}"]`);
  calls.length = 0;
  cardBtn('skip').click(); await tick();
  cardBtn('pauseresume').click(); await tick();
  cardBtn('onoff').click(); await tick();
  assert.ok(calls.some(c => c === 'POST /api/items/PSDV7H/skip'), 'skip → /skip');
  assert.ok(calls.some(c => c === 'POST /api/items/PSDV7H/state'), 'pause/off → /state');
  ok('card actions: skip / pause / on-off hit the right admin endpoints');

  // edit form → PATCH with the new name
  cardBtn('edit').click();
  const card = w.document.querySelector('#adminList .icard[data-code="PSDV7H"]');
  const form = card.querySelector('form[data-edit]');
  assert.ok(!form.hidden, 'edit form opened');
  form.querySelector('[name="name"]').value = 'Lobby Lamp 2';
  calls.length = 0;
  form.dispatchEvent(new w.Event('submit', { cancelable: true, bubbles: true })); await tick();
  assert.ok(calls.some(c => c === 'PATCH /api/items/PSDV7H'), 'edit submit → PATCH');
  ok('edit form → PATCH the item');

  // chain manager: add a rig → key shown ONCE, survives the re-render
  const card2 = w.document.querySelector('#adminList .icard[data-code="2AWK6P"]');
  card2.querySelector('[data-out="rigname"]').value = 'pi-rig';
  card2.querySelector('[data-out="addrig"]').click(); await tick();
  const reveal = w.document.querySelector('.icard[data-code="2AWK6P"] .keyReveal');
  assert.ok(reveal && /shown once/i.test(reveal.textContent), 'rig key revealed after add');
  assert.match(reveal.querySelector('code').textContent, /^K{32}$/, 'plaintext key shown exactly once');
  ok('chain manager: add rig → key shown once, chain re-renders in place');

  // refresh guard: an open edit form must block the 4s re-render (protects typed edits)
  const openCard = w.document.querySelector('#adminList .icard[data-code="PSDV7H"]');
  openCard.querySelector('[data-act="edit"]').click();          // open an edit form
  assert.ok(!openCard.querySelector('form[data-edit]').hidden, 'edit form open');
  const htmlBefore = $('adminList').innerHTML;
  await w.__refreshAdmin(); await tick();
  assert.strictEqual($('adminList').innerHTML, htmlBefore, 'refresh skipped while an edit form is open');
  ok('refresh guard: skips the re-render while an edit form is open');

  // QR encoder structure (moved from the user suite; full decode via jsqr tooling)
  const m1 = w.__qrEncode('HELLO'), m4 = w.__qrEncode('https://td-stream-control.onrender.com/control?item=PSDV7H');
  assert.strictEqual(m1.length, 21, '5 bytes → v1 (21×21)');
  assert.strictEqual(m4.length, 33, 'product URL → v4 (33×33)');
  for (const m of [m1, m4]){
    const s = m.length;
    for (const [r, c] of [[0, 0], [0, s - 7], [s - 7, 0]]){
      assert.strictEqual(m[r][c], 1, 'finder corner dark');
      assert.strictEqual(m[r + 3][c + 3], 1, 'finder center dark');
      assert.strictEqual(m[r + 1][c + 1], 0, 'finder ring light');
    }
    assert.ok(m.every(row => row.length === s && row.every(v => v === 0 || v === 1)), 'square 0/1 matrix');
  }
  ok('QR matrices: correct versions + finder patterns (decode: qr tooling)');

  /* ── jukebox card: surface-aware meta, live panel, editor, live actions ── */
  const jbCard = () => w.document.querySelector('#adminList .icard[data-code="JUKE01"]');
  assert.strictEqual(jbCard().dataset.surface, 'jukebox', 'card tagged as a jukebox surface');
  assert.match(jbCard().querySelector('.meta').textContent, /jukebox · per action · log · 2 songs/, 'jukebox meta line');
  assert.ok(jbCard().querySelector('[data-jb="force_skip"]'), 'live panel: Skip track');
  assert.ok(jbCard().querySelector('[data-jb="clear_queue"]'), 'live panel: Clear queue');
  assert.ok(jbCard().querySelector('[data-jb="house"]'), 'live panel: House toggle');
  assert.ok(!jbCard().querySelector('[data-act="skip"]'), 'no slot-Skip button on a jukebox card');
  assert.match(jbCard().querySelector('.jb-q').textContent, /Song A/, 'live queue shows the running song');
  ok('jukebox card: surface meta + live panel (skip/clear/house), no slot-skip');

  // live action: Clear queue → POST /jukebox/admin, queue empties, config preserved
  calls.length = 0;
  jbCard().querySelector('[data-jb="clear_queue"]').click(); await tick();
  assert.ok(calls.some(c => c === 'POST /api/items/JUKE01/jukebox/admin'), 'clear → /jukebox/admin');
  assert.match(jbCard().querySelector('.jb-q').textContent, /queue empty/i, 'queue cleared in the live panel');
  assert.ok(jbCard().querySelector('[data-jb="house"]').textContent.match(/House: on/), 'jukeboxConfig preserved across the merge (house label intact)');
  ok('jukebox live action: Clear queue hits /jukebox/admin, config survives the merge');

  // House toggle flips the config-backed label
  jbCard().querySelector('[data-jb="house"]').click(); await tick();
  assert.match(jbCard().querySelector('[data-jb="house"]').textContent, /House: off/, 'house toggled off');
  ok('jukebox live action: House toggle flips on the config');

  // edit form: jukebox knobs + catalog editor render; add a song + save → PATCH
  jbCard().querySelector('[data-act="edit"]').click();
  const jform = jbCard().querySelector('form[data-edit]');
  assert.ok(!jform.hidden, 'jukebox edit form opened');
  assert.ok(jform.querySelector('[name="jb_monetization"]') && jform.querySelector('[name="jb_skipPrice"]'), 'jukebox knobs render');
  assert.strictEqual(jform.querySelectorAll('[data-catalog] li').length, 2, 'catalog editor lists the 2 songs');
  jbCard().querySelector('[data-cat="add"]').click();
  const newLi = jform.querySelectorAll('[data-catalog] li');
  newLi[newLi.length - 1].querySelector('[data-cf="title"]').value = 'Song C';
  newLi[newLi.length - 1].querySelector('[data-cf="file"]').value = 'c.mp3';
  jform.querySelector('[name="jb_queuePrice"]').value = '3.00';
  calls.length = 0;
  jform.dispatchEvent(new w.Event('submit', { cancelable: true, bubbles: true })); await tick();
  assert.ok(calls.some(c => c === 'PATCH /api/items/JUKE01'), 'jukebox edit → PATCH');
  assert.strictEqual(DB.JUKE01.jukeboxConfig.catalog.length, 3, 'the added song persisted through the PATCH');
  assert.strictEqual(DB.JUKE01.jukeboxConfig.queuePriceCents, 300, 'the changed queue price persisted');
  ok('jukebox editor: knobs + catalog editor save via PATCH (add song, price change)');

  // create a jukebox item: surface + monetization ride the create body
  $('nItemName').value = 'Cafe Jukebox';
  $('nItemSurface').value = 'jukebox';
  $('nItemSurface').dispatchEvent(new w.Event('change'));
  assert.ok(!$('nJukeMonWrap').hidden, 'monetization picker revealed for a jukebox');
  $('nJukeMon').value = 'per_action';
  await w.__createItem(); await tick();
  assert.strictEqual(lastCreate.surface, 'jukebox', 'create body carries surface:jukebox');
  assert.strictEqual(lastCreate.jukebox.monetization, 'per_action', 'create body carries the monetization');
  $('qrClose').click();
  ok('create jukebox: surface + monetization ride the create request');

  /* ── controller + the Control hub (pad items) ── */
  DB.PSDV7H.controller = 'joystick';
  await w.__refreshAdmin(); await tick();
  const padCard = () => w.document.querySelector('#adminList .icard[data-code="PSDV7H"]');
  assert.strictEqual(padCard().dataset.surface, 'pad', 'PSDV7H is a pad surface');
  assert.match(padCard().querySelector('.meta').textContent, /joystick/, 'controller shown at a glance on the card');
  assert.match(padCard().querySelector('.osc-addr').textContent, /\/volt\/xy/, 'Connect panel: joystick maps to /volt/xy');
  assert.match(padCard().querySelector('.cmd').textContent, /bus-to-osc\.mjs.*channel=item:PSDV7H/, 'Connect panel: OSC bridge command pre-fills the item code');
  assert.ok(padCard().querySelector('details.mon-wrap[data-mon="PSDV7H"]'), 'live output monitor present');
  ok('control hub: controller at a glance + Connect panel (addresses + pre-filled command) + monitor');

  // action→OSC translation (what the live monitor renders per message)
  const xy = w.__actionToOsc({ action: 'pad_xy', x: 0.75, y: 0.25 });
  assert.strictEqual(xy.label, 'pad_xy  x=0.75  y=0.25'); assert.strictEqual(xy.osc, '/volt/xy 0.75 0.25');
  const fd = w.__actionToOsc({ action: 'fader', i: 2, v: 0.5 });
  assert.strictEqual(fd.label, 'fader 2  v=0.50'); assert.strictEqual(fd.osc, '/volt/fader/2 0.50');
  const cl = w.__actionToOsc({ action: 'cell_4' });
  assert.strictEqual(cl.label, 'cell_4'); assert.strictEqual(cl.osc, '/volt/key/cell_4');
  ok('control hub: action→OSC mapping (pad_xy→/volt/xy · fader→/volt/fader/i · cell→/volt/key/cell_N)');

  // edit form controller select round-trips to PATCH
  padCard().querySelector('[data-act="edit"]').click();
  const pform = padCard().querySelector('form[data-edit]');
  assert.strictEqual(pform.querySelector('[name="controller"]').value, 'joystick', 'edit form reflects the current controller');
  pform.querySelector('[name="controller"]').value = 'faders';
  calls.length = 0;
  pform.dispatchEvent(new w.Event('submit', { cancelable: true, bubbles: true })); await tick();
  assert.ok(calls.some(c => c === 'PATCH /api/items/PSDV7H'), 'controller edit → PATCH');
  assert.strictEqual(DB.PSDV7H.controller, 'faders', 'the changed controller persisted through PATCH');
  ok('control hub: edit form controller select round-trips through PATCH');

  // de-couple invariant: the Control admin no longer links to the channels admin
  assert.ok(!/href="\/admin\.html"/.test(html), 'control-ops does not cross-link the audio-reactive admin');
  ok('de-couple: Control admin stands alone (no link to the channels admin)');

  /* ── THE ADMIN CHAIN · key lens: the venues panel ── */
  await w.__loadOrgs(); await tick();
  const orgCardEl = (id) => w.document.querySelector(`#orgsList [data-org="${id}"]`);
  assert.ok(orgCardEl('anchor') && orgCardEl('rival'), 'both venues render in the panel');
  assert.match(orgCardEl('anchor').textContent, /owner@anchor\.com/, 'members listed with rungs');
  assert.match(orgCardEl('anchor').textContent, /PSDV7H/, "the venue's items are listed");
  // bounds editor: ⚖ opens the prefilled form; save rides the dedicated endpoint
  orgCardEl('anchor').querySelector('[data-okey="bounds"][data-code="PSDV7H"]').click();
  const bform = orgCardEl('anchor').querySelector('form[data-obounds="PSDV7H"]');
  assert.ok(!bform.hidden, 'bounds form opens');
  assert.strictEqual(bform.querySelector('[name="bmax"]').value, '10.00', 'form prefilled from the current band');
  bform.querySelector('[name="bmax"]').value = '12.00';
  calls.length = 0;
  bform.dispatchEvent(new w.Event('submit', { cancelable: true, bubbles: true })); await tick(); await tick();
  assert.ok(calls.some(c => c === 'PATCH /api/admin/items/PSDV7H/bounds'), 'bounds ride PATCH /api/admin/items/:code/bounds');
  assert.strictEqual(DB.PSDV7H.bounds.priceBandCents.max, 1200, 'band max updated');
  ok('venues panel: orgs render with members + items · bounds editor round-trips');

  // key lens grants tech (rung 0 only) + the audit trail renders
  calls.length = 0;
  let aCard = orgCardEl('anchor');
  aCard.querySelector('[data-of="grantemail"]').value = 'ava@anchor.com';
  aCard.querySelector('[data-of="grantrole"]').value = 'tech';
  aCard.querySelector('[data-okey="grant"]').click(); await tick(); await tick();
  assert.ok(calls.some(c => c === 'POST /api/admin/orgs/anchor/grants'), 'grant rides the rung-0 route');
  assert.ok(ORGS.anchor.members.some(x => x.email === 'ava@anchor.com' && x.orgRole === 'tech'), 'tech granted by the key');
  orgCardEl('anchor').querySelector('[data-okey="audit"]').click(); await tick();
  assert.match(orgCardEl('anchor').querySelector('[data-oaudit]').textContent, /priceCents[\s\S]*500[\s\S]*800/, 'audit rows render old→new');
  ok('venues panel: key grants tech · per-venue audit trail renders');

  /* ── THE ADMIN CHAIN · the session lens ── */
  // hand the page back to a walk-up state: no key in memory, key dash away
  w.__S.adminKey = null; w.__S.adminItems = []; w.__S.adminOrgs = null;
  $('adminDash').hidden = true;
  const keyedMark = keyedCalls.length;

  // signed out → the door explains instead of opening
  sessionUser = null;
  assert.strictEqual(await w.__unlockSession(), false);
  assert.match($('sessGateMsg').textContent, /sign in first/, 'signed-out visitor pointed at account sign-in');
  assert.ok($('sessDash').hidden, 'session dash stays hidden');
  ok('session lens: signed out → pointed at sign-in, nothing unlocks');

  // owner: ONLY their venue's items render (not the rival's, not platform items)
  sessionUser = { email: 'owner@anchor.com', name: 'Ava Owner' };
  assert.strictEqual(await w.__unlockSession(), true); await tick();
  assert.ok(!$('sessDash').hidden, 'session dash open');
  assert.strictEqual($('sessRole').textContent, 'owner');
  const codes = [...w.document.querySelectorAll('#sessList .icard')].map(c => c.dataset.code).sort();
  assert.deepStrictEqual(codes, ['JUKE01', 'PSDV7H'], "only the member's own venue items render — no rival, no platform items");
  assert.match(w.document.querySelector('#sessList .icard[data-code="PSDV7H"] .meta').textContent, /7 plays/, 'plays-per-item view');
  assert.match($('sessOwnerTools').textContent, /staff@anchor\.com/, "owner sees the crew roster");
  ok("session lens: owner sees ONLY their org's items + plays + crew");

  // the band is rendered on the owner form; out-of-band rejected; in-band saves via the ORG route
  const sCard = () => w.document.querySelector('#sessList .icard[data-code="PSDV7H"]');
  sCard().querySelector('[data-sact="edit"]').click();
  const sform = () => sCard().querySelector('form[data-sedit]');
  assert.match(sform().textContent, /your band: price \$2–\$12/, 'the band is rendered, not hidden');
  assert.strictEqual(sform().querySelector('[name="price"]').getAttribute('max'), '12.00', 'price input carries the band max');
  sform().querySelector('[name="price"]').value = '50.00';
  sform().dispatchEvent(new w.Event('submit', { cancelable: true, bubbles: true })); await tick();
  assert.match(sCard().querySelector('[data-cardmsg]').textContent, /band/, "an out-of-band price surfaces the server's band message");
  assert.strictEqual(DB.PSDV7H.priceCents, 500, 'nothing written on the reject');
  sform().querySelector('[name="price"]').value = '9.00';
  calls.length = 0;
  sform().dispatchEvent(new w.Event('submit', { cancelable: true, bubbles: true })); await tick();
  assert.ok(calls.some(c => c === 'PATCH /api/org/anchor/items/PSDV7H'), 'owner saves ride the ORG route, never /api/items');
  assert.strictEqual(DB.PSDV7H.priceCents, 900, 'in-band price applied');
  ok('session lens: band shown on the owner form · reject names the band · in-band saves via org route');

  // staff: action buttons only, through the org actions endpoint
  sessionUser = { email: 'staff@anchor.com', name: 'Sam' };
  assert.strictEqual(await w.__unlockSession(), true); await tick();
  assert.strictEqual($('sessRole').textContent, 'staff');
  assert.ok(!sCard().querySelector('form[data-sedit]'), 'staff gets no edit form');
  assert.ok(!sCard().querySelector('[data-sact="onoff"]'), 'no on/off for staff');
  assert.strictEqual($('sessOwnerTools').innerHTML.trim(), '', 'no crew/invite card for staff');
  calls.length = 0;
  sCard().querySelector('[data-sact="pauseresume"]').click(); await tick();
  assert.ok(calls.some(c => c === 'POST /api/org/anchor/items/PSDV7H/actions'), 'staff pause rides the org actions route');
  ok('session lens: staff = actions only, via the org actions endpoint');

  // tech: chain card + rig-key rotation through the org route, key shown once
  sessionUser = { email: 'tech@anchor.com', name: 'Tex' };
  assert.strictEqual(await w.__unlockSession(), true); await tick();
  assert.strictEqual($('sessRole').textContent, 'tech');
  assert.ok(!sCard().querySelector('form[data-sedit]'), 'tech gets no owner form');
  const jCard = () => w.document.querySelector('#sessList .icard[data-code="JUKE01"]');
  assert.ok(jCard().querySelector('details.chain-wrap'), 'tech sees the chain card');
  calls.length = 0;
  jCard().querySelector('[data-sout="rotate"][data-name="pi-jukebox"]').click(); await tick();
  assert.ok(calls.some(c => c === 'POST /api/org/anchor/items/JUKE01/rig-key'), 'rotation rides the org rig-key route');
  assert.match(jCard().querySelector('.keyReveal').textContent, /R{32}/, 'the NEW key is revealed (shown once)');
  // regression (review #11): the just-revealed key must NOT be hidden by a
  // details that re-rendered closed — the Outputs panel stays open over it.
  assert.strictEqual(jCard().querySelector('details.chain-wrap').open, true, 'the Outputs details stays open over the revealed key');
  ok('session lens: tech rotates a rig key through the org route, key shown once (panel stays open)');

  // regression (review #1 + #3): owner Save sends a DIFF, and a blank price is
  // treated as unchanged (never coerced to $0).
  sessionUser = { email: 'owner@anchor.com', name: 'Ava Owner' };
  assert.strictEqual(await w.__unlockSession(), true); await tick();
  // jukebox: change only the queue price → the PATCH carries just that knob,
  // not the whole config (no backend, no untouched skip/catalog).
  jCard().querySelector('[data-sact="edit"]').click();
  const jbForm = jCard().querySelector('form[data-sedit]');
  jbForm.querySelector('[name="jb_queuePrice"]').value = '5.00';   // differs from the current 3.00
  lastOrgPatch = null;
  jbForm.dispatchEvent(new w.Event('submit', { cancelable: true, bubbles: true })); await tick();
  assert.ok(lastOrgPatch && lastOrgPatch.jukebox, 'jukebox PATCH sent');
  assert.strictEqual(lastOrgPatch.jukebox.queuePriceCents, 500, 'the changed knob rode the PATCH');
  assert.ok(!('backend' in lastOrgPatch.jukebox), 'the backend knob is never sent from the org lens');
  assert.deepStrictEqual(Object.keys(lastOrgPatch.jukebox), ['queuePriceCents'], 'ONLY the changed knob rode the PATCH (a diff, not the full config)');
  // pad: clear the price, change the slot → the PATCH omits priceCents entirely
  const padC = () => w.document.querySelector('#sessList .icard[data-code="PSDV7H"]');
  padC().querySelector('[data-sact="edit"]').click();
  const pf = padC().querySelector('form[data-sedit]');
  pf.querySelector('[name="price"]').value = '';
  pf.querySelector('[name="slot"]').value = '150';
  lastOrgPatch = null;
  pf.dispatchEvent(new w.Event('submit', { cancelable: true, bubbles: true })); await tick();
  assert.ok(lastOrgPatch && !('priceCents' in lastOrgPatch), 'a blank price is treated as unchanged, never sent as $0');
  assert.strictEqual(lastOrgPatch.slotSeconds, 150, 'the changed slot still rode the PATCH');
  ok('session lens: owner Save is a diff (jukebox knob-only, blank price omitted)');

  // the security invariant: the whole session phase sent ZERO admin-key fetches
  assert.strictEqual(keyedCalls.length, keyedMark, 'the session lens never sent the admin key');
  assert.ok(!w.document.querySelector('#sessList [data-act]'), 'no key-lens buttons inside the session list');
  assert.ok($('adminDash').hidden, 'the key dashboard (create/QR/delete) stays hidden in session mode');
  ok('session lens: zero admin-key code paths reachable');

  console.log(`\nALL CLEAR — ${passed} ops-page checks passed`);
  w.close();
  process.exit(0);
})().catch((e) => { console.error('\nFAIL:', e.message); console.error(e.stack); process.exit(1); });

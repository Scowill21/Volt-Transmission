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
    status: 'on', outputs: [], active: null, queue: [], auction: null, ts: 0 },
  '2AWK6P': { type: 'item_queues', item: '2AWK6P', name: 'Laser Head', description: null,
    mode: 'auction', priceCents: 200, slotSeconds: 60, auctionSeconds: 45, minIncrementCents: 50,
    status: 'on', outputs: [], active: null, queue: [], auction: null, ts: 0 },
};
const payload = (code) => JSON.parse(JSON.stringify({ ...DB[code], ts: now() }));
const respond = (status, body) => Promise.resolve({ ok: status < 400, status, json: () => Promise.resolve(body) });
const calls = [];   // record method+path so we can assert the right endpoint fired

w.fetch = (url, opts = {}) => {
  const u = String(url);
  const method = (opts.method || 'GET').toUpperCase();
  const headers = opts.headers || {};
  const body = opts.body ? JSON.parse(opts.body) : {};
  const admin = headers['X-Admin-Key'] === 'dev';
  calls.push(method + ' ' + u.replace(/^https?:\/\/[^/]+/, ''));

  let m = u.match(/\/api\/items\/([A-Z0-9]{6})\/outputs\/([^/?]+)$/);
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
  m = u.match(/\/api\/items\/([A-Z0-9]{6})\/(skip|state)$/);
  if (m){
    if (!admin) return respond(401, { error: 'bad admin key' });
    if (m[2] === 'state' && (body.action === 'on' || body.action === 'off')) DB[m[1]].status = body.action;
    return respond(200, payload(m[1]));
  }
  m = u.match(/\/api\/items\/([A-Z0-9]{6})$/);
  if (m){
    if (!admin) return respond(401, { error: 'bad admin key' });
    if (method === 'PATCH'){ if (body.name) DB[m[1]].name = body.name; return respond(200, payload(m[1])); }
    if (method === 'DELETE'){ delete DB[m[1]]; return respond(204, null); }
  }
  if (/\/api\/items$/.test(u)){
    if (!admin) return respond(401, { error: 'bad admin key' });
    if (method === 'GET') return respond(200, Object.keys(DB).map(payload));
    if (method === 'POST'){ DB.NEW111 = { ...JSON.parse(JSON.stringify(DB.PSDV7H)), item: 'NEW111', name: body.name, outputs: [] }; return respond(201, payload('NEW111')); }
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
  assert.strictEqual(cards.length, 2, 'both items listed');
  ok('unlock: dev key → dashboard renders the item list');

  // create → new code + QR modal opens
  $('nItemName').value = 'Fog Machine';
  await w.__createItem(); await tick();
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

  console.log(`\nALL CLEAR — ${passed} ops-page checks passed`);
  w.close();
  process.exit(0);
})().catch((e) => { console.error('\nFAIL:', e.message); console.error(e.stack); process.exit(1); });

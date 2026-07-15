/* Headless smoke test for control.html (Volt Control) — same style as
   .smoke-test.cjs: evals the whole page script in jsdom (catches syntax
   errors), stubs fetch/WebSocket/canvas, and drives every view: code entry,
   item view (both modes), slot grant → controller, stamped key presses,
   the ≤8 Hz send throttle, slot end, admin unlock + QR.

   jsdom landmines (HANDOFF): page-scope const/let are unreachable from
   separate evals — drive everything through the window.__* shims; fetches
   resolve on microtasks — `await new Promise(setImmediate)` between action
   and assertion.

   Run:  node .smoke-control.cjs   — must exit 0.  */
'use strict';
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { JSDOM } = (() => {
  try { return require('jsdom'); }
  catch { return require(path.join('/tmp', 'node_modules', 'jsdom')); }
})();

const html = fs.readFileSync(path.join(__dirname, 'control.html'), 'utf8');
// dev-identity URL (documented escape hatch) so pay actions work sessionless
const dom = new JSDOM(html, { runScripts: 'outside-only', url: 'http://localhost/control?uid=u-test&name=Tess' });
const w = dom.window;
const errors = [];
w.addEventListener('error', (e) => errors.push('window.onerror: ' + e.message));

/* ── stubs ── */
const ctx = { fillRect(){}, fillStyle: '' };
w.HTMLCanvasElement.prototype.getContext = function(){ return ctx; };
w.confirm = () => true;
Object.defineProperty(w.navigator, 'vibrate', { value: () => true, configurable: true });

// fake items API — two items, mutated by buy/bid like the real server
const now = () => Date.now();
const DB = {
  PSDV7H: { type: 'item_queues', item: 'PSDV7H', name: 'Lobby Lamp', description: 'tilt + strobe',
    instructions: '▲▼ tilt the lamp · A strobe',
    mode: 'buynow', priceCents: 500, slotSeconds: 120, auctionSeconds: 60, minIncrementCents: 50,
    status: 'on', active: null, queue: [], auction: null, ts: 0 },
  '2AWK6P': { type: 'item_queues', item: '2AWK6P', name: 'Laser Head', description: null,
    mode: 'auction', priceCents: 200, slotSeconds: 60, auctionSeconds: 45, minIncrementCents: 50,
    status: 'on', active: null, queue: [], auction: null, ts: 0 },
};
const payload = (code) => JSON.parse(JSON.stringify({ ...DB[code], ts: now() }));
const respond = (status, body) => Promise.resolve({ ok: status < 400, status, json: () => Promise.resolve(body) });

w.fetch = (url, opts = {}) => {
  const u = String(url);
  const method = (opts.method || 'GET').toUpperCase();
  const headers = opts.headers || {};
  const body = opts.body ? JSON.parse(opts.body) : {};
  if (u.endsWith('/api/me')) return respond(200, { user: null });

  let m = u.match(/\/api\/items\/([A-Z0-9]{6})$/);
  if (m && method === 'GET')
    return DB[m[1]] ? respond(200, payload(m[1])) : respond(404, { error: 'no item with that code' });

  m = u.match(/\/api\/items\/([A-Z0-9]{6})\/(buy|bid|cancel)$/);
  if (m){
    const p = DB[m[1]];
    if (!p) return respond(404, { error: 'no item with that code' });
    if (!body.user) return respond(401, { error: 'sign in first' });
    if (m[2] === 'buy'){
      p.active = { userId: body.user.id, name: body.user.name, startedAt: now(),
        endsAt: now() + p.slotSeconds * 1000, paused: false, remainingMs: p.slotSeconds * 1000 };
    } else if (m[2] === 'bid'){
      if (!Number.isInteger(body.cents)) return respond(400, { error: 'cents must be a positive integer' });
      const min = p.auction ? p.auction.minNextCents : p.priceCents;
      if (body.cents < min) return respond(400, { error: 'bid too low' });
      p.auction = { endsAt: now() + p.auctionSeconds * 1000, topCents: body.cents, topName: body.user.name,
        topUserId: body.user.id, bidCount: (p.auction ? p.auction.bidCount : 0) + 1,
        minNextCents: body.cents + p.minIncrementCents };
    } else p.active = null;
    return respond(201, payload(m[1]));
  }

  if (/\/api\/items$/.test(u)){
    if (headers['X-Admin-Key'] !== 'dev') return respond(401, { error: 'bad admin key' });
    if (method === 'GET') return respond(200, Object.keys(DB).map(payload));
    if (method === 'POST'){
      DB.NEW111 = { ...DB.PSDV7H, item: 'NEW111', name: body.name, mode: body.mode || 'buynow' };
      return respond(201, payload('NEW111'));
    }
  }
  return respond(404, { error: 'unhandled ' + method + ' ' + u });
};

w.__wsInstances = [];
w.WebSocket = class {
  constructor(url){ this.url = String(url); this.readyState = 1; this.sent = []; w.__wsInstances.push(this); }
  send(m){ this.sent.push(JSON.parse(m)); }
  close(){ this.readyState = 3; if (this.onclose) this.onclose(); }
};

/* ── run the page script ── */
const script = html.match(/<script>([\s\S]*)<\/script>/)[1];
w.eval(script);
const tick = () => new Promise(setImmediate);

let passed = 0;
const ok = (label) => { console.log('OK  ', passed + 1, label); passed++; };

(async () => {
  await tick();
  assert.strictEqual(errors.length, 0, 'page script errors: ' + errors.join(' | '));
  assert.strictEqual(w.__S.view, 'entry');
  assert.strictEqual(w.__IDENTITY.id, 'u-test', 'URL dev identity hydrated');
  ok('script evals clean → entry view, dev identity from URL');

  // bad code → inline error, view unchanged
  assert.strictEqual(await w.__submitCode('ZZZZZZ'), false);
  assert.match(w.document.getElementById('codeErr').textContent, /no item/i);
  assert.strictEqual(w.__S.view, 'entry');
  ok('unknown code → friendly inline error, stays on entry');

  // good code → item view (buy-now), bus room subscribed
  assert.strictEqual(await w.__submitCode('psdv7h'), true);            // lowercase accepted
  assert.strictEqual(w.__S.view, 'item');
  assert.strictEqual(w.document.getElementById('itemName').textContent, 'Lobby Lamp');
  assert.ok(!w.document.getElementById('buyCard').hidden, 'buy card visible');
  assert.ok(w.document.getElementById('bidCard').hidden, 'bid card hidden in buy-now mode');
  assert.match(w.document.getElementById('buyPrice').textContent, /\$5/);
  const ws = w.__wsInstances[w.__wsInstances.length - 1];
  assert.match(ws.url, /\/api\/bus\?channel=item%3APSDV7H$/, 'subscribed to the item room');
  ok('code entry → buy-now item view + bus room item:PSDV7H');

  // the admin-written controls guide shows on the item (bid) page…
  assert.ok(!w.document.getElementById('instrCard').hidden, 'controls guide card visible');
  assert.match(w.document.getElementById('instrText').textContent, /tilt the lamp/);
  ok('controls guide renders on the item page');

  // buy → slot granted → controller auto-shows
  await w.__doBuy(); await tick();
  assert.strictEqual(w.__S.holding, true);
  assert.strictEqual(w.__S.view, 'controller');
  ok('buy → slot granted → controller view auto-shows');

  // …and behind the controller's (i) button as a dismissible popup
  assert.ok(!w.document.getElementById('ctlInfo').hidden, '(i) button visible when a guide exists');
  w.document.getElementById('ctlInfo').click();
  assert.ok(!w.document.getElementById('ctlInstr').hidden, '(i) opens the guide popup');
  assert.match(w.document.getElementById('ctlInstrText').textContent, /tilt the lamp/);
  w.document.getElementById('ctlInstr').click();
  assert.ok(w.document.getElementById('ctlInstr').hidden, 'tap dismisses the popup');
  ok('controller (i) → guide popup opens and dismisses');

  // a press produces the stamped key schema on the socket
  const before = ws.sent.length;
  w.document.querySelector('.pad-up').dispatchEvent(new w.Event('pointerdown', { bubbles: true }));
  w.document.querySelector('.pad-up').dispatchEvent(new w.Event('pointerup', { bubbles: true }));
  const msg = ws.sent[before];
  assert.ok(msg, 'press sent a message');
  assert.strictEqual(msg.type, 'key');
  assert.strictEqual(msg.action, 'pad_up');
  assert.strictEqual(msg.user.id, 'u-test');
  assert.ok(msg.ts > 0, 'stamped with ts');
  ok('pointerdown → stamped {type:key, action:pad_up, user, ts}');

  // keyboard fallback fires the same path
  w.document.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'a', bubbles: true }));
  w.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'a' }));
  assert.ok(ws.sent.some(s => s.action === 'btn_a'), 'A key → btn_a');
  ok('keyboard fallback: "a" → btn_a');

  // hold-to-repeat: pointer capture requested, ~6.7 Hz repeat, stops on release
  let captured = 0;
  w.HTMLElement.prototype.setPointerCapture = function(){ captured++; };
  const padDown = w.document.querySelector('.pad-down');
  const preHold = ws.sent.length;
  padDown.dispatchEvent(Object.assign(new w.Event('pointerdown', { bubbles: true }), { pointerId: 9 }));
  await new Promise(r => setTimeout(r, 520));
  const held = ws.sent.slice(preHold).filter(s => s.action === 'pad_down').length;
  assert.ok(held >= 3 && held <= 6, `hold ~500ms → initial + ~3 repeats, got ${held}`);
  assert.ok(captured >= 1, 'pointer capture requested');
  padDown.dispatchEvent(Object.assign(new w.Event('pointerup', { bubbles: true }), { pointerId: 9 }));
  const afterRelease = ws.sent.length;
  await new Promise(r => setTimeout(r, 350));
  assert.strictEqual(ws.sent.length, afterRelease, 'release stops the repeat interval');
  ok(`hold-to-repeat: captured pointer, ${held} sends over 500ms, clean stop`);

  // throttle: a flood of presses stays inside the bus rate budget
  w.__bucket.tokens = 10; w.__bucket.last = Date.now();       // full bucket → deterministic bound
  const start = ws.sent.length;
  for (let i = 0; i < 40; i++) w.__fire('pad_right');
  const flood = ws.sent.length - start;
  assert.ok(flood >= 10 && flood <= 12, `flood of 40 from a full bucket must send 10-12, sent ${flood}`);
  assert.strictEqual(w.__fire('pad_right'), false, 'bucket empty → fire() reports the drop');
  ok(`hold-flood throttled: 40 presses → ${flood} sends (≤ bus budget)`);

  // staleness guard: a slow poll snapshot must not roll back a fresh buy
  const stale = payload('PSDV7H');
  stale.active = null; stale.ts = 1;                          // "from before the buy"
  w.__applyItem(stale);
  assert.strictEqual(w.__S.holding, true, 'stale snapshot ignored — still holding');
  assert.strictEqual(w.__S.view, 'controller', 'no spurious time\'s-up');
  ok('stale poll snapshot ignored (ts guard) — no phantom slot loss');

  // slot end → time's-up moment → back to the item view with re-buy UI
  const gone = payload('PSDV7H'); gone.active = null;
  w.__applyItem(gone);
  assert.strictEqual(w.__S.holding, false);
  assert.ok(!w.document.getElementById('timesUp').hidden, "time's-up overlay shows");
  await new Promise(r => setTimeout(r, 2500));
  assert.strictEqual(w.__S.view, 'item');
  assert.ok(!w.document.getElementById('buyBtn').hidden, 'buy button back for a re-buy');
  ok("slot end → time's-up moment → item view with re-buy");

  // paused holder → controller stays, visibly frozen
  const pausedP = payload('PSDV7H');
  pausedP.active = { userId: 'u-test', name: 'Tess', startedAt: now(), endsAt: now() + 60000, paused: true, remainingMs: 45000 };
  w.__applyItem(pausedP);
  assert.strictEqual(w.__S.view, 'controller');
  assert.ok(!w.document.getElementById('ctlFreeze').hidden, 'freeze overlay visible');
  assert.match(w.document.getElementById('freezeMsg').textContent, /paused/);
  assert.match(w.document.getElementById('itemChip').textContent, /PAUSED/);
  w.__applyItem(payload('PSDV7H')); await new Promise(r => setTimeout(r, 2500));  // release for later checks
  ok('paused → controller frozen with a host-paused note');

  // auction item: bid card, min-next math, countdown text
  const beforeSwitch = w.__wsInstances[w.__wsInstances.length - 1];
  assert.strictEqual(await w.__submitCode('2AWK6P'), true);
  const afterSwitch = w.__wsInstances[w.__wsInstances.length - 1];
  assert.strictEqual(beforeSwitch.readyState, 3, 'old item room socket closed on switch');
  assert.match(afterSwitch.url, /item%3A2AWK6P$/, 'fresh socket subscribed to the new room');
  assert.ok(!w.document.getElementById('bidCard').hidden, 'bid card visible');
  assert.ok(w.document.getElementById('buyCard').hidden, 'buy card hidden in auction mode');
  assert.strictEqual(w.__chosenBidCents(), 200, 'default bid = starting price');
  await w.__doBid(); await tick();
  assert.match(w.document.getElementById('bidMsg').textContent, /placed/);
  assert.match(w.document.getElementById('topBid').textContent, /\$2/);
  w.__renderTimers();
  assert.match(w.document.getElementById('auctionClock').textContent, /left/, 'soft-close countdown rendering');
  assert.strictEqual(w.__chosenBidCents(), 250, 'next default = top + increment');
  ok('auction view: bid placed, top/min-next update, countdown ticks');

  // sign-in prompt for anonymous visitors (no dev identity, unverified)
  w.__IDENTITY.dev = false;
  await w.__doBuy(); await tick();
  assert.ok(!w.document.getElementById('signinCard').hidden, 'sign-in prompt shown');
  assert.match(w.document.getElementById('signinLink').href, /account\.html\?return=/, 'returns to the item after sign-in');
  w.__IDENTITY.dev = true;
  ok('anonymous pay attempt → inline sign-in prompt with return link');

  // admin: wrong key rejected, right key renders the dashboard
  w.__show('admin');
  assert.strictEqual(await w.__unlockAdmin('wrong'), false);
  assert.match(w.document.getElementById('adminGateMsg').textContent, /wrong key/);
  assert.strictEqual(await w.__unlockAdmin('dev'), true);
  const cards = w.document.querySelectorAll('#adminList .icard');
  assert.strictEqual(cards.length, 2, 'both items on the dashboard');
  ok('admin gate: wrong key rejected · dev key → dashboard (2 items)');

  // QR modal from a card renders the code + a real matrix on the canvas
  cards[0].querySelector('[data-act="qr"]').click(); await tick();
  assert.ok(!w.document.getElementById('qrModal').hidden, 'QR modal open');
  assert.match(w.document.getElementById('qrCode').textContent, /^[A-Z0-9]{6}$/);
  ok('item card → QR modal with the printable code');

  // QR encoder structure (full decode is proven by the jsqr round-trip tooling)
  const m1 = w.__qrEncode('HELLO');
  assert.strictEqual(m1.length, 21, '5 bytes → version 1 (21×21)');
  const m4 = w.__qrEncode('https://td-stream-control.onrender.com/control?item=PSDV7H');
  assert.strictEqual(m4.length, 33, 'product URL → version 4 (33×33)');
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

  console.log(`\nALL CLEAR — ${passed} control-page checks passed`);
  w.close();
  process.exit(0);
})().catch((e) => { console.error('\nFAIL:', e.message); console.error(e.stack); process.exit(1); });

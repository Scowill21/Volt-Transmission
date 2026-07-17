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
  JUKE01: { type: 'item_queues', item: 'JUKE01', name: 'Bar Jukebox', description: 'Pick the vibe',
    surface: 'jukebox', mode: 'buynow', priceCents: 500, slotSeconds: 120, auctionSeconds: 60, minIncrementCents: 50,
    status: 'on', active: null, queue: [], auction: null, ts: 0,
    jukebox: { monetization: 'per_action', mode: 'buynow', backend: 'log',
      catalog: [{ id: 'aaa', title: 'Song A', artist: 'Artist A', durationSec: 180 },
                { id: 'bbb', title: 'Song B', artist: 'Artist B', durationSec: 200 },
                { id: 'ccc', title: 'Song C', artist: null, durationSec: 0 }],
      prices: { queueCents: 200, playNextCents: 400, skipCents: 100 }, houseMode: true,
      nowPlaying: null, queue: [], queueLen: 0, skipState: { roomLeft: 6 }, bidRound: null } },
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

  m = u.match(/\/api\/items\/([A-Z0-9]{6})\/jukebox\/(queue|skip|bid)$/);
  if (m){
    const p = DB[m[1]];
    if (!p || !p.jukebox) return respond(404, { error: 'no item with that code' });
    if (!body.user) return respond(401, { error: 'sign in first' });
    const jb = p.jukebox;
    if (m[2] === 'queue'){
      const song = jb.catalog.find(s => s.id === body.songId);
      if (!song) return respond(409, { error: 'that song is not in the catalog' });
      if (!jb.nowPlaying) jb.nowPlaying = { songId: song.id, title: song.title, artist: song.artist, startedAt: now(), durationSec: song.durationSec || 180, elapsedSec: 0 };
      else jb.queue.push({ position: jb.queue.length + 1, songId: song.id, title: song.title, byName: body.user.name, byId: body.user.id, playNext: !!body.playNext });
      jb.queueLen = jb.queue.length;
    } else if (m[2] === 'skip'){
      if (!jb.nowPlaying) return respond(409, { error: 'nothing is playing' });
      jb.nowPlaying = jb.queue.length ? (() => { const n = jb.queue.shift(); jb.queueLen = jb.queue.length;
        return { songId: n.songId, title: n.title, artist: null, startedAt: now(), durationSec: 180, elapsedSec: 0 }; })() : null;
    } else if (m[2] === 'bid'){
      if (jb.mode !== 'bid') return respond(409, { error: 'this jukebox is not in bid mode' });
      jb.bidRound = { topCents: body.cents, topName: body.user.name, topUserId: body.user.id,
        bidCount: (jb.bidRound ? jb.bidRound.bidCount : 0) + 1, minNextCents: body.cents + 50, closesAt: now() + 60000 };
    }
    return respond(201, payload(m[1]));
  }

  m = u.match(/\/api\/items\/([A-Z0-9]{6})\/outputs$/);
  if (m && method === 'POST'){
    if (headers['X-Admin-Key'] !== 'dev') return respond(401, { error: 'bad admin key' });
    const p = DB[m[1]];
    p.outputs = p.outputs || [];
    p.outputs.push({ kind: body.kind, name: body.name, priority: body.priority || p.outputs.length + 1,
      ...(body.scene ? { scene: body.scene } : {}) });
    const item = payload(m[1]);
    return respond(201, body.kind === 'rig' ? { rigKey: 'k'.repeat(32), item } : { item });
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

  /* ── redundancy UI on the USER item view (offline banner, spectator, gap) ── */
  await w.__submitCode('psdv7h'); await tick();

  // configured chain + nothing online → OFFLINE banner + buy disabled
  const offItem = { ...payload('PSDV7H'), outputs: [{ kind: 'rig', name: 'td-main', priority: 1 }],
    program: null, outputsOnline: [], sellable: false, active: null };
  w.__applyItem(offItem);
  assert.ok(!w.document.getElementById('offlineCard').hidden, 'output-offline banner shown');
  assert.strictEqual(w.document.getElementById('buyBtn').disabled, true, 'buy disabled while offline');
  assert.match(w.document.getElementById('buyBtn').textContent, /not selling/i);
  ok('output offline: banner shown + buy button disabled ("not selling")');

  // a rig online → banner clears, buy re-enabled
  const onItem = { ...offItem, program: { kind: 'rig', name: 'td-main' }, outputsOnline: ['td-main'], sellable: true };
  w.__applyItem(onItem);
  assert.ok(w.document.getElementById('offlineCard').hidden, 'banner clears when an output is online');
  assert.strictEqual(w.document.getElementById('buyBtn').disabled, false, 'buy re-enabled');
  ok('output back online: banner clears, buy re-enabled');

  // someone else holds → spectator strip shows and lights on a key message
  const heldItem = { ...onItem, active: { userId: 'u-other', name: 'Rex', paused: false, outputPaused: false, remainingMs: 60000 } };
  w.__applyItem(heldItem);
  assert.ok(!w.document.getElementById('spectatorCard').hidden, 'spectator strip shown while another drives');
  const specSock = w.__wsInstances[w.__wsInstances.length - 1];
  specSock.onmessage({ data: JSON.stringify({ type: 'key', action: 'pad_left' }) });
  assert.ok(w.document.querySelector('.spec-pad [data-spec="pad_left"]').classList.contains('lit'),
    'spectator cell lights on the live key');
  ok('spectator strip: visible while another holds, lights on live key traffic');

  // output gap mid-slot → chip shows the gap, buy stays off
  const gapItem = { ...heldItem, active: { ...heldItem.active, outputPaused: true } };
  w.__applyItem(gapItem);
  assert.match(w.document.getElementById('itemChip').textContent, /OUTPUT GAP/);
  ok('output gap mid-slot surfaces on the item chip');

  // THE SPLIT INVARIANT: no admin code/markup ships to walk-up phones.
  assert.strictEqual(typeof w.__unlockAdmin, 'undefined', 'no admin shim on the user page');
  assert.strictEqual(typeof w.__qrEncode, 'undefined', 'no QR encoder shim on the user page');
  assert.ok(!/X-Admin-Key/.test(html), 'user page ships no X-Admin-Key string');
  assert.ok(!/unlockAdmin|adminApi|const QR = /.test(html), 'user page ships no admin JS / QR encoder');
  assert.ok(!/id="viewAdmin"|id="gearBtn"|id="qrModal"/.test(html), 'user page has no admin markup');
  ok('split invariant: user page carries NO admin code, key, or QR encoder');

  /* ── jukebox surface (per_action) ── */
  assert.strictEqual(await w.__submitCode('JUKE01'), true);
  assert.strictEqual(w.__S.view, 'item');
  assert.ok(!w.document.getElementById('jukeboxCard').hidden, 'jukebox card visible');
  assert.ok(w.document.getElementById('buyCard').hidden, 'per_action hides the slot buy card');
  assert.ok(w.document.getElementById('bidCard').hidden, 'per_action hides the slot bid card');
  assert.strictEqual(w.document.querySelectorAll('#jbCatalog [data-act="queue"]').length, 3, 'all 3 catalog rows render a Queue button');
  assert.match(w.document.getElementById('jbNpTitle').textContent, /House mix/i, 'idle jukebox shows the house-mix now-playing');
  ok('jukebox per_action: jukebox card shown, slot cards hidden, catalog + house render');

  // queue on an idle jukebox → it starts playing that song
  w.__doJbQueue('aaa', false); await tick();
  assert.match(w.document.getElementById('jbNpTitle').textContent, /Song A/, 'now-playing = the queued song');
  ok('queue on idle jukebox → now-playing = Song A');

  // a second add lands in up-next
  w.__doJbQueue('bbb', false); await tick();
  assert.match(w.document.getElementById('jbQueue').textContent, /Song B/, 'second add appears in up-next');
  ok('second queue add → shows in up-next');

  // live skip window: protected < minPlay · open inside onlyBefore · too late after
  const jukePayload = (elapsedSec, extra) => {
    const st = now() - elapsedSec * 1000;
    const jp = payload('JUKE01');
    jp.jukebox.nowPlaying = { songId: 'aaa', title: 'Song A', artist: 'Artist A', startedAt: st, durationSec: 180, elapsedSec };
    jp.jukebox.skipState = Object.assign({ canSkip: true, yourLeft: 2, roomLeft: 6, minPlayUntil: st + 10000, skippableUntil: st + 30000 }, extra || {});
    return jp;
  };
  w.__applyItem(jukePayload(5));
  assert.strictEqual(w.document.getElementById('jbSkip').disabled, true, 'skip disabled within the minPlay floor');
  assert.match(w.document.getElementById('jbSkip').textContent, /protected/i, 'shows the protected reason');
  w.__applyItem(jukePayload(20));
  assert.strictEqual(w.document.getElementById('jbSkip').disabled, false, 'skip enabled inside the window');
  w.__applyItem(jukePayload(40));
  assert.strictEqual(w.document.getElementById('jbSkip').disabled, true, 'skip disabled past onlyBeforeSec');
  assert.match(w.document.getElementById('jbSkip').textContent, /too late/i, 'shows the too-late reason');
  // exhausted personal skips → disabled even inside the window
  w.__applyItem(jukePayload(20, { yourLeft: 0 }));
  assert.strictEqual(w.document.getElementById('jbSkip').disabled, true, 'no skips left → disabled');
  ok('skip button ticks the window: protected < minPlay · open in window · too late after · caps bind');

  // controller_slot posture: the slot buy card AND the jukebox card both show;
  // actions are gated on holding the slot (not on paying per-action)
  const csp = payload('JUKE01');
  csp.jukebox.monetization = 'controller_slot'; csp.active = null;
  w.__applyItem(csp);
  assert.ok(!w.document.getElementById('buyCard').hidden, 'controller_slot shows the slot buy card');
  assert.ok(!w.document.getElementById('jukeboxCard').hidden, 'jukebox card also shown');
  assert.match(w.document.getElementById('jbGate').textContent, /control slot/i, 'non-holder is told to buy the slot');
  ok('controller_slot: slot buy + jukebox card both show, actions gated on the slot');

  // bid mode: bid panel appears, a bid updates the top (flip the backing item too
  // so the /jukebox/bid endpoint accepts it, not just the client render)
  DB.JUKE01.jukebox.mode = 'bid';
  DB.JUKE01.jukebox.monetization = 'per_action';
  DB.JUKE01.jukebox.nowPlaying = { songId: 'aaa', title: 'Song A', artist: 'Artist A', startedAt: now(), durationSec: 180, elapsedSec: 0 };
  DB.JUKE01.jukebox.queue = []; DB.JUKE01.jukebox.queueLen = 0; DB.JUKE01.jukebox.bidRound = null;
  w.__applyItem(payload('JUKE01'));
  assert.ok(!w.document.getElementById('jbBid').hidden, 'bid panel shown in bid mode');
  w.__S.jbPick = 'bbb';
  w.document.getElementById('jbBidCustom').value = '2.50';
  w.__doJbBid(); await tick();
  assert.match(w.document.getElementById('jbBidTop').textContent, /\$2\.50/, 'top bid reflects the placed bid');
  ok('bid mode: bid-for-next panel bids on the picked song, top updates');

  /* ── controller variations (4 layouts, each fires its own gated action) ── */
  w.__S.code = 'PSDV7H';   // back to the pad item (applyItem ignores a mismatched code)
  const ws2 = w.__wsInstances[w.__wsInstances.length - 1];
  const ctlItem = (controller) => {
    const p = payload('PSDV7H'); p.controller = controller;
    p.active = { userId: 'u-test', name: 'Tess', paused: false, outputPaused: false, startedAt: now(), endsAt: now() + 60000, remainingMs: 60000 };
    return p;
  };
  const pdown = (el, extra) => el.dispatchEvent(Object.assign(new w.Event('pointerdown', { bubbles: true }), { pointerId: 1, ...extra }));

  // joystick — drag fires pad_xy {x,y}
  w.__bucket.tokens = 10;
  w.__applyItem(ctlItem('joystick')); w.__show('controller');
  assert.ok(w.document.getElementById('joyPad'), 'joystick XY pad renders');
  assert.ok(w.document.querySelector('#ctlSurface [data-action="btn_a"]'), 'joystick FIRE button renders');
  const joy = w.document.getElementById('joyPad');
  joy.getBoundingClientRect = () => ({ left: 0, top: 0, width: 200, height: 200, right: 200, bottom: 200 });
  let bx = ws2.sent.length;
  pdown(joy, { clientX: 150, clientY: 50 });                 // → x .75, y .25
  const xy = ws2.sent.slice(bx).find(m => m.action === 'pad_xy');
  assert.ok(xy, 'drag fires pad_xy');
  assert.ok(Math.abs(xy.x - 0.75) < 0.02 && Math.abs(xy.y - 0.25) < 0.02, `pad_xy carries x/y (got ${xy.x},${xy.y})`);
  ok('controller joystick: XY pad + FIRE render, drag streams pad_xy {x,y}');

  // faders — drag fires fader {i,v}
  await new Promise(r => setTimeout(r, 180));               // clear the continuous coalesce window
  w.__bucket.tokens = 10;
  w.__applyItem(ctlItem('faders'));
  assert.strictEqual(w.document.querySelectorAll('#ctlSurface .fader').length, 4, '4 faders render');
  const f0 = w.document.querySelector('#ctlSurface .fader');
  f0.getBoundingClientRect = () => ({ left: 0, top: 0, width: 60, height: 200, right: 60, bottom: 200 });
  bx = ws2.sent.length;
  pdown(f0, { pointerId: 2, clientX: 30, clientY: 50 });     // near top → v ≈ .75
  const fd = ws2.sent.slice(bx).find(m => m.action === 'fader');
  assert.ok(fd && fd.i === 0, 'fader fires with its index');
  assert.ok(Math.abs(fd.v - 0.75) < 0.02, `fader carries v (got ${fd.v})`);
  ok('controller faders: 4 sliders render, drag streams fader {i,v}');

  // grid — tap fires cell_N (discrete)
  w.__bucket.tokens = 10;
  w.__applyItem(ctlItem('grid'));
  const cells = w.document.querySelectorAll('#ctlSurface .cgrid button');
  assert.strictEqual(cells.length, 9, '3×3 grid renders');
  bx = ws2.sent.length;
  pdown(cells[4], { pointerId: 3 });
  assert.ok(ws2.sent.slice(bx).some(m => m.action === 'cell_4'), 'tap fires cell_N');
  ok('controller grid: 3×3 pads render, tap fires cell_N');

  // default (no controller field) → d-pad, and its pad_up still fires (back-compat)
  w.__bucket.tokens = 10;
  const dp = payload('PSDV7H'); dp.active = { userId: 'u-test', name: 'Tess', paused: false, outputPaused: false, startedAt: now(), endsAt: now() + 60000, remainingMs: 60000 };
  w.__applyItem(dp); w.__show('controller');
  assert.ok(w.document.querySelector('#ctlSurface .pad-up'), 'undefined controller falls back to the d-pad');
  bx = ws2.sent.length;
  pdown(w.document.querySelector('#ctlSurface .pad-up'), { pointerId: 4 });
  assert.ok(ws2.sent.slice(bx).some(m => m.action === 'pad_up'), 'd-pad still fires pad_up');
  ok('controller default: undefined → d-pad, pad_up fires (back-compat)');

  console.log(`\nALL CLEAR — ${passed} control-page (user) checks passed`);
  w.close();
  process.exit(0);
})().catch((e) => { console.error('\nFAIL:', e.message); console.error(e.stack); process.exit(1); });

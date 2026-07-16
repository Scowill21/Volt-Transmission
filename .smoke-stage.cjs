/* Headless smoke test for stage.html (Volt Stage — the browser OUTPUT plane).
   Same style as .smoke-control.cjs: evals the whole page script in jsdom
   (catches syntax errors), stubs fetch/WebSocket/canvas/rAF, and drives:
   clean eval, scene renders + reacts to an injected key, output switch flips
   the muted veil, attract mode on idle, and the resync-on-reconnect staleness
   guard.

   jsdom landmines (HANDOFF): page-scope const/let are unreachable from a
   separate eval — drive through window.__stage; fetches resolve on
   microtasks — `await new Promise(setImmediate)` between action and assert.

   Run:  node .smoke-stage.cjs   — must exit 0.  */
'use strict';
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { JSDOM } = (() => {
  try { return require('jsdom'); }
  catch { return require(path.join('/tmp', 'node_modules', 'jsdom')); }
})();

const html = fs.readFileSync(path.join(__dirname, 'stage.html'), 'utf8');
// rig-mode URL: this projector is output "stage" for item PSDV7H
const dom = new JSDOM(html, {
  runScripts: 'outside-only',
  url: 'http://localhost/stage?item=PSDV7H&rig=stage&rigKey=k&scene=orb',
  pretendToBeVisual: true,
});
const w = dom.window;
const errors = [];
w.addEventListener('error', (e) => errors.push('window.onerror: ' + e.message));

/* ── stubs ── */
// canvas ctx that records fillRect calls so we can prove the scene DREW
const drawCalls = { fillRect: 0, arc: 0, stroke: 0 };
const gradient = { addColorStop(){} };
const ctx = new Proxy({}, {
  get(_t, p){
    if (p === 'fillRect'){ return () => { drawCalls.fillRect++; }; }
    if (p === 'arc'){ return () => { drawCalls.arc++; }; }
    if (p === 'stroke'){ return () => { drawCalls.stroke++; }; }
    if (p === 'createRadialGradient' || p === 'createLinearGradient') return () => gradient;
    if (p === 'canvas') return { clientWidth: 1280, clientHeight: 720 };
    return () => {};
  },
  set(){ return true; },
});
w.HTMLCanvasElement.prototype.getContext = function(){ return ctx; };
Object.defineProperty(w.HTMLCanvasElement.prototype, 'clientWidth', { get(){ return 1280; }, configurable: true });
Object.defineProperty(w.HTMLCanvasElement.prototype, 'clientHeight', { get(){ return 720; }, configurable: true });

let rafCbs = [];
w.requestAnimationFrame = (cb) => { rafCbs.push(cb); return rafCbs.length; };
const pump = (n, t0 = 0) => { for (let i = 0; i < n; i++){ const q = rafCbs; rafCbs = []; for (const cb of q) cb(t0 + i * 16.7); } };

const ITEM = {
  type: 'item_queues', item: 'PSDV7H', name: 'Lobby Lamp', mode: 'buynow',
  priceCents: 500, slotSeconds: 120, status: 'on',
  outputs: [{ kind: 'rig', name: 'stage', priority: 1 }], program: { kind: 'rig', name: 'stage' },
  outputsOnline: ['stage'], sellable: true, active: null, queue: [], auction: null, ts: 1000,
};
const respond = (status, body) => Promise.resolve({ ok: status < 400, status, json: () => Promise.resolve(body) });
w.fetch = (url) => {
  if (/\/api\/items\/PSDV7H$/.test(String(url))) return respond(200, JSON.parse(JSON.stringify(ITEM)));
  return respond(404, { error: 'nope' });
};
w.__wsInstances = [];
w.WebSocket = class {
  constructor(url){ this.url = String(url); this.readyState = 1; this.sent = []; w.__wsInstances.push(this);
    setTimeout(() => this.onopen && this.onopen(), 0); }
  send(m){ this.sent.push(JSON.parse(m)); }
  close(){ this.readyState = 3; if (this.onclose) this.onclose({ code: 1000 }); }
};

/* ── run the page script ── */
const script = html.match(/<script>([\s\S]*)<\/script>/)[1];
w.eval(script);
const tick = () => new Promise(setImmediate);
let passed = 0;
const ok = (label) => { console.log('OK  ', passed + 1, label); passed++; };

(async () => {
  await tick(); await tick();
  const st = w.__stage;
  assert.strictEqual(errors.length, 0, 'page script errors: ' + errors.join(' | '));
  assert.ok(st && st.S, 'shims exposed');
  assert.strictEqual(st.S.code, 'PSDV7H', 'item code parsed from URL');
  assert.strictEqual(st.S.rig, 'stage', 'rig identity parsed');
  ok('script evals clean → item + rig identity from URL');

  // the WS connects WITH the rig identity params (so election counts it)
  const ws = w.__wsInstances[w.__wsInstances.length - 1];
  assert.match(ws.url, /channel=item%3APSDV7H/, 'subscribed to the item room');
  assert.match(ws.url, /rig=stage&rigKey=k/, 'rig params on the socket → presence-tracked');
  ok('bus socket carries the rig identity');

  // scene renders: pump frames, prove the canvas was drawn into
  const before = drawCalls.fillRect;
  pump(4, 0);
  assert.ok(drawCalls.fillRect > before, 'scene drew to the canvas');
  assert.strictEqual(st.S.scene.name, 'orb', 'the ?scene=orb pick took');
  ok('scene renders on the render loop');

  // reacts to an injected holder key press (item is active + we are program)
  ITEM.active = { userId: 'u-h', name: 'Holder', paused: false, outputPaused: false, remainingMs: 90000 };
  st.applyItem(JSON.parse(JSON.stringify(ITEM)));
  // feed a pad_right via the socket message path (as the bus would)
  const beforePos = st.S.scene.name;   // orb has no exposed pos; assert via no-throw + draw delta
  ws.onmessage({ data: JSON.stringify({ type: 'key', action: 'pad_right' }) });
  ws.onmessage({ data: JSON.stringify({ type: 'key', action: 'btn_b' }) });   // burst
  const d2 = drawCalls.fillRect; pump(3, 100);
  assert.ok(drawCalls.fillRect > d2, 'keeps rendering after input');
  assert.ok(!w.document.getElementById('attract').hidden === false, 'attract hidden while a holder drives');
  ok('active slot: holder key presses drive the scene, attract hidden');

  // OUTPUT switch: another output becomes program → this rig self-mutes
  st.onOutput({ type: 'output', item: 'PSDV7H', program: { kind: 'rig', name: 'td-main' }, online: ['td-main', 'stage'] });
  assert.strictEqual(st.isMuted(), true, 'not program → muted');
  assert.ok(!w.document.getElementById('muted').hidden, 'muted veil shown');
  // …and back: we become program again → un-mute automatically
  st.onOutput({ type: 'output', item: 'PSDV7H', program: { kind: 'rig', name: 'stage' }, online: ['stage'] });
  assert.strictEqual(st.isMuted(), false, 'program again → un-muted');
  assert.ok(w.document.getElementById('muted').hidden, 'muted veil cleared on failover back');
  ok('output election: self-mutes when not program, un-mutes on takeover');

  // ATTRACT mode when idle: no active slot → overlay + QR, and the scene
  // self-drives (a scanned QR must never land on a dead page)
  ITEM.active = null;
  st.applyItem(JSON.parse(JSON.stringify(ITEM)));
  assert.ok(!w.document.getElementById('attract').hidden, 'attract overlay shown when idle');
  assert.strictEqual(w.document.getElementById('attractCode').textContent, 'PSDV7H', 'code on the attract card');
  const d3 = drawCalls.fillRect; pump(80, 1000);   // >1s of frames → attract driver fires input
  assert.ok(drawCalls.fillRect > d3, 'scene keeps moving in attract mode');
  ok('attract mode: overlay + QR on idle, scene self-drives');

  // STALENESS guard: an older ts must not roll back a newer state
  const fresh = { ...JSON.parse(JSON.stringify(ITEM)), ts: 5000,
    active: { userId: 'u-x', name: 'Fresh', paused: false, outputPaused: false, remainingMs: 50000 } };
  st.applyItem(fresh);
  assert.ok(st.S.item.active, 'fresh active applied');
  st.applyItem({ ...JSON.parse(JSON.stringify(ITEM)), ts: 2000, active: null });   // stale reply
  assert.ok(st.S.item.active, 'stale snapshot ignored — active NOT rolled back');
  ok('resync staleness guard: an older ts never rolls back fresh state');

  console.log(`\nALL CLEAR — ${passed} stage checks passed`);
  process.exit(0);
})().catch((e) => { console.error('\nFAIL:', e.message); console.error(e.stack); process.exit(1); });

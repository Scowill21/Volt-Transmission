/* Headless smoke test for index.html — stubs canvas/audio, runs the script,
   pumps frames, and exercises every mode/station path. Not part of the site. */
const fs = require('fs');
const path = require('path');
const { JSDOM } = (() => {
  try { return require('jsdom'); }                                        // npm i jsdom
  catch { return require(path.join('/tmp', 'node_modules', 'jsdom')); }   // sandbox fallback
})();

const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
const dom = new JSDOM(html, { runScripts: 'outside-only', url: 'http://localhost/', pretendToBeVisual: false });
const w = dom.window;
const errors = [];

/* ── all-absorbing proxy for canvas ctx / gradients / patterns ── */
function absorb(name){
  const target = function(){};
  return new Proxy(target, {
    get(t, p){
      if (p === Symbol.toPrimitive) return () => 0;
      if (p === 'data') return new Uint8ClampedArray(192 * 108 * 4);
      return absorb(name + '.' + String(p));
    },
    set(){ return true; },
    apply(t, th, args){
      return absorb(name + '()');
    },
  });
}
const ctxHandler = () => {
  const gradients = () => ({ addColorStop(){} });
  const base = {
    canvas: null,
    createLinearGradient: gradients, createRadialGradient: gradients,
    createPattern: () => ({}),
    createImageData: (a, b) => ({ data: new Uint8ClampedArray(a * b * 4), width: a, height: b }),
    getImageData: (x, y, a, b) => ({ data: new Uint8ClampedArray(a * b * 4) }),
    putImageData(){}, drawImage(){}, fillRect(){}, strokeRect(){}, clearRect(){},
    beginPath(){}, closePath(){}, moveTo(){}, lineTo(){}, quadraticCurveTo(){}, bezierCurveTo(){},
    arc(){}, ellipse(){}, rect(){}, fill(){}, stroke(){}, clip(){},
    save(){}, restore(){}, translate(){}, scale(){}, rotate(){}, setTransform(){},
    fillText(){}, strokeText(){}, measureText: () => ({ width: 10 }),
    setLineDash(){}, getLineDash: () => [],
  };
  return new Proxy(base, {
    get(t, p){ return p in t ? t[p] : undefined; },
    set(t, p, v){ t[p] = v; return true; },
  });
};
w.HTMLCanvasElement.prototype.getContext = function(){ const c = ctxHandler(); c.canvas = this; return c; };

/* ── Web Audio stub ── */
class FakeAC {
  constructor(){ this.sampleRate = 44100; this.state = 'running'; this.destination = {}; this.currentTime = 0; }
  resume(){ return Promise.resolve(); }
  createGain(){ return { gain: { value: 1 }, connect(){} }; }
  createAnalyser(){
    return {
      fftSize: 2048, smoothingTimeConstant: 0, frequencyBinCount: 1024, connect(){},
      getByteFrequencyData(a){ for (let i = 0; i < a.length; i++) a[i] = (Math.random() * 200) | 0; },
      getByteTimeDomainData(a){ for (let i = 0; i < a.length; i++) a[i] = 128 + ((Math.random() * 40 - 20) | 0); },
    };
  }
  createMediaElementSource(){ return { connect(){} }; }
}
w.AudioContext = FakeAC; w.webkitAudioContext = FakeAC;

/* ── misc stubs ── */
// /api/channels (Tier 1b): serve the static seed + a marker channel, so the
// suite proves the fetched payload rebuilds the dropdowns via renderChannels.
const API_CHANNELS = [
  { id: 'volt-fm', name: 'Volt FM', slug: 'volt-fm', defaultScene: 'ambient',
    vjs: [
      { id: 'kera', name: 'Kera',    uses: { plane: 'scene',  scene: 'pulse' } },
      { id: 'nova', name: 'VJ Nova', uses: { plane: 'stream', scene: null } },
    ] },
  { id: 'drift-radio', name: 'Drift Radio', slug: 'drift-radio', defaultScene: 'drift',
    vjs: [ { id: 'moss', name: 'Moss', uses: { plane: 'scene', scene: 'static' } } ] },
  { id: 'api-test', name: 'API Test FM', slug: 'api-test', defaultScene: 'pulse', vjs: [] },
];
w.fetch = (url) => String(url).endsWith('/api/channels')
  ? Promise.resolve({ ok: true, json: () => Promise.resolve(API_CHANNELS) })
  : Promise.resolve({ ok: false, json: () => Promise.resolve(null) });
w.indexedDB = { open(){ return {}; } };
w.URL.createObjectURL = () => 'blob:fake-' + Math.random();
w.URL.revokeObjectURL = () => {};
if (!w.matchMedia) w.matchMedia = () => ({ matches: false, addEventListener(){} });
w.HTMLMediaElement.prototype.play = function(){ this._paused = false; this.dispatchEvent(new w.Event('play')); return Promise.resolve(); };
w.HTMLMediaElement.prototype.pause = function(){ this._paused = true; this.dispatchEvent(new w.Event('pause')); };
Object.defineProperty(w.HTMLMediaElement.prototype, 'paused', { get(){ return this._paused !== false; } });

let rafQ = [];
w.requestAnimationFrame = (cb) => { rafQ.push(cb); return rafQ.length; };
w.devicePixelRatio = 2;

w.addEventListener('error', (e) => errors.push('window.onerror: ' + e.message));

/* ── run the page script ── */
const script = html.match(/<script>([\s\S]*)<\/script>/)[1] +
  `;window.__dbg = () => ({ mode, currentStation, transportState, playing: SIG.playing,
     scenes: Object.keys(SCENES).join(','), paused: player.paused,
     fxCount: FX.sparks.length + FX.shocks.length + (FX.flash > .5 ? 1 : 0),
     lastSent: window.__lastSent, sent: window.__sent,
     channel: channelState.channel + '/' + channelState.vj,
     chip: (id) => document.getElementById('trk-' + id).textContent });
   const __origSend = sendToTD;
   window.__lastSent = null;
   window.__sent = [];
   sendToTD = (p) => { window.__lastSent = { ...p, user: IDENTITY, ts: Date.now() };
     window.__sent.push(window.__lastSent); return __origSend(p); };`;
try { w.eval(script); console.log('EVAL OK'); }
catch (e) { errors.push('EVAL FAIL: ' + e.stack.split('\n').slice(0, 3).join(' | ')); }
const dbg = () => w.__dbg();

function pump(n, t0){
  for (let i = 0; i < n; i++){
    const q = rafQ; rafQ = [];
    for (const cb of q){
      try { cb(t0 + i * 16.7); }
      catch (e) { errors.push('FRAME FAIL: ' + e.stack.split('\n').slice(0, 3).join(' | ')); return; }
    }
  }
}

const step = (label, fn) => {
  try { fn(); console.log('OK  ', label); }
  catch (e) { errors.push(label + ': ' + e.stack.split('\n').slice(0, 3).join(' | ')); console.log('FAIL', label); }
};

pump(5, 0);
step('scenes registered', () => {
  const s = dbg().scenes;
  if (s !== 'ambient,pulse,static,drift') throw new Error('got: ' + s);
});
step('tune each station + frames', () => {
  for (const id of ['pulse', 'static', 'drift', 'ambient']){
    w.eval(`document.getElementById('st-${id}').checked = true; selectStation('${id}')`);
    pump(10, 1000);
  }
});
step('preset play w/o track shows hint', () => {
  w.eval(`presetPlay()`);
  const tx = w.document.getElementById('tx').textContent;
  if (!/no track/.test(tx)) throw new Error('tx: ' + tx);
});
step('upload → track set + autoplay', () => {
  w.eval(`setTrack('ambient', URL.createObjectURL(new Blob(['x'])), 'test-song.mp3', {})`);
  if (!/test-song/.test(dbg().chip('ambient'))) throw new Error('chip: ' + dbg().chip('ambient'));
  w.eval(`document.getElementById('st-ambient').checked = true; selectStation('ambient'); presetPlay()`);
  pump(20, 2000);
  if (!dbg().playing) throw new Error('SIG.playing false after play');
});
step('transport pause/play/skip routing', () => {
  w.eval(`setTransport('pause')`);
  if (dbg().transportState !== 'paused') throw new Error('pause did not sync');
  w.eval(`setTransport('play')`);
  w.eval(`setTransport('skip')`);
  if (dbg().currentStation !== 'pulse') throw new Error('skip went to: ' + dbg().currentStation);
  pump(10, 3000);
});
step('mode → live holds placeholder, pauses music', () => {
  w.eval(`setMode('live')`);
  const place = w.document.getElementById('placeholder').style.display;
  const vis = w.document.getElementById('vis').hidden;
  if (place === 'none') throw new Error('placeholder hidden in live+offline');
  if (!vis) throw new Error('canvas still visible in live');
  if (!dbg().paused) throw new Error('music still playing in live');
  w.eval(`setMode('live')`);          // re-click: must keep holding
  if (w.document.getElementById('placeholder').style.display === 'none') throw new Error('re-click broke hold');
  w.eval(`setMode('presets')`);
  if (w.document.getElementById('vis').hidden) throw new Error('canvas hidden back in presets');
  pump(5, 4000);
});
step('keys 1-4 tune stations in presets', () => {
  w.eval(`fireKey('scene_3')`);
  if (dbg().currentStation !== 'static') throw new Error('got: ' + dbg().currentStation);
  pump(5, 5000);
});
step('action keys fire scene FX + messages carry user/ts', () => {
  w.eval(`fireKey('action_1'); fireKey('action_2'); fireKey('action_3'); fireKey('trigger')`);
  pump(6, 5500);
  if (dbg().fxCount < 5) throw new Error('fxCount: ' + dbg().fxCount);
  const sent = dbg().lastSent;
  if (!sent || !sent.user || !sent.user.id || !sent.ts) throw new Error('missing user/ts: ' + JSON.stringify(sent));
  pump(60, 6000);   // let FX decay across frames without error
});
step('channel/VJ dropdowns route planes + message', () => {
  const ch = w.document.getElementById('channelSelect');
  const vj = w.document.getElementById('vjSelect');
  if (!ch || ch.options.length < 2) throw new Error('channels not populated: ' + (ch && ch.options.length));
  if (vj.options[0].value !== 'house') throw new Error('house not first: ' + vj.options[0].value);

  w.eval(`selectVJ('nova')`);                    // stream VJ → live plane
  if (dbg().mode !== 'live') throw new Error('stream VJ did not go live');
  const msg = dbg().sent.find(m => m.type === 'channel' && m.vj === 'nova');
  if (!msg || msg.channel !== 'volt-fm' || !msg.user || !msg.user.id || !msg.ts)
    throw new Error('channel msg: ' + JSON.stringify(msg));

  w.eval(`selectVJ('house')`);                   // house → presets + default scene
  if (dbg().mode !== 'presets') throw new Error('house did not return to presets');
  if (dbg().currentStation !== 'ambient') throw new Error('house scene: ' + dbg().currentStation);
  if (!w.document.getElementById('st-ambient').checked) throw new Error('station radio not synced');

  w.eval(`selectVJ('kera')`);                    // scene VJ → mapped station
  if (dbg().currentStation !== 'pulse') throw new Error('scene VJ station: ' + dbg().currentStation);

  w.eval(`selectChannel('drift-radio')`);        // switch channel → VJ list rebuilt, default scene routed
  if (vj.options.length !== 2) throw new Error('vj list not rebuilt: ' + vj.options.length);
  if (dbg().channel !== 'drift-radio/house') throw new Error('state: ' + dbg().channel);
  if (dbg().currentStation !== 'drift') throw new Error('default scene: ' + dbg().currentStation);
  pump(10, 6000);
});
step('VU + station cards present', () => {
  for (const id of ['vuBass', 'vuSnr', 'vuTrb', 'macro', 'dropzone', 'fileIn']) {
    if (!w.document.getElementById(id)) throw new Error('missing #' + id);
  }
});

// The /api/channels fetch resolves through microtasks, and everything above is
// synchronous — yield once so the payload lands, then assert the rebuild.
(async () => {
  await new Promise((r) => setImmediate(r));
  step('fetched /api/channels payload rebuilt the dropdowns', () => {
    const ch = w.document.getElementById('channelSelect');
    if (ch.options.length !== 3) throw new Error('expected 3 channels after fetch, got ' + ch.options.length);
    if (![...ch.options].some(o => o.value === 'api-test')) throw new Error('api-test channel missing');
    w.eval(`selectChannel('api-test')`);           // API-only channel routes like any other
    if (dbg().currentStation !== 'pulse') throw new Error('api channel default scene: ' + dbg().currentStation);
    const vj = w.document.getElementById('vjSelect');
    if (vj.options.length !== 1 || vj.options[0].value !== 'house')
      throw new Error('api channel should have house only');
    pump(5, 6300);
  });

  pump(30, 6000);
  console.log(errors.length ? '\n=== ERRORS ===\n' + errors.join('\n') : '\nALL CLEAR — no runtime errors');
  process.exit(errors.length ? 1 : 0);
})();

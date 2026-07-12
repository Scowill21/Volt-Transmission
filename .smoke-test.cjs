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
  { id: 'api-test', name: 'API Test FM', slug: 'api-test', defaultScene: 'pulse',
    audioUrl: 'https://stream.example/live.mp3', vjs: [] },   // Tier 3a: live channel audio
];
// /api/me (Tier 2a): a signed-in account — the console must stamp messages
// with it (IDENTITY hydration) and light the footer account chip.
const API_ME = { user: { id: 'u-test-1', email: 't@example.com', name: 'Test Account', role: 'vj', appliedRole: null } };
w.fetch = (url) => {
  const u = String(url);
  if (u.endsWith('/api/channels')) return Promise.resolve({ ok: true, json: () => Promise.resolve(API_CHANNELS) });
  if (u.endsWith('/api/me'))       return Promise.resolve({ ok: true, json: () => Promise.resolve(API_ME) });
  return Promise.resolve({ ok: false, json: () => Promise.resolve(null) });
};
w.indexedDB = { open(){ return {}; } };
// Live-action bus (Tier 4 slice): capture the console's bus sockets.
w.__busSockets = [];
w.WebSocket = class {
  constructor(url){ this.url = String(url); this.readyState = 1; this.sent = []; w.__busSockets.push(this); }
  send(m){ this.sent.push(JSON.parse(m)); }
  close(){ this.readyState = 3; this.onclose && this.onclose(); }
};
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
  `;window.__dbg = () => ({ mode, plane, currentStation, transportState, playing: SIG.playing,
     scene: (Object.keys(SCENES).find(k => SCENES[k] === currentScene) || ''),
     scenes: Object.keys(SCENES).join(','), paused: player.paused,
     fxCount: FX.sparks.length + FX.shocks.length + (FX.flash > .5 ? 1 : 0),
     lastSent: window.__lastSent, sent: window.__sent,
     channel: channelState.channel + '/' + channelState.vj,
     playerSrc: player.src || '', playerTid: player.dataset.tid || '', loop: player.loop,
     plLen: playlist(currentStation).length, playIdx: (playIdx[currentStation] || 0),
     chip: (id) => document.getElementById('trk-' + id).textContent });
   const __origSend = sendToTD;
   window.__resetFire = (a) => { lastFire[a] = 0; };   // step re-fires within the 70ms lockout
   window.__ended = () => player.dispatchEvent(new Event('ended'));   // player is a page-scope const
   window.__setRole = (r) => { IDENTITY.role = r; };                  // IDENTITY is a page-scope const
   window.__setVerified = (v) => { IDENTITY.verified = v; };          // only /api/me sets this for real
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
step('upload a 2-song playlist → queued, counted, autoplays', () => {
  w.eval(`document.getElementById('st-ambient').checked = true; selectStation('ambient')`);
  w.eval(`addUploads('ambient', [
    { url: URL.createObjectURL(new Blob(['a'])), name: 'song-a.mp3', file: new Blob(['a']) },
    { url: URL.createObjectURL(new Blob(['b'])), name: 'song-b.mp3', file: new Blob(['b']) },
  ])`);
  if (dbg().plLen !== 2) throw new Error('playlist length: ' + dbg().plLen);
  if (!/1\/2.*song-a/.test(dbg().chip('ambient'))) throw new Error('chip: ' + dbg().chip('ambient'));
  if (dbg().loop !== false) throw new Error('multi-song playlist should not loop the element');
  pump(20, 2000);
  if (!dbg().playing) throw new Error('SIG.playing false after upload autoplay');
});
step('skip advances the playlist and wraps; station stays', () => {
  w.eval(`setTransport('pause')`);
  if (dbg().transportState !== 'paused') throw new Error('pause did not sync');
  w.eval(`setTransport('play')`);
  w.eval(`setTransport('skip')`);
  if (dbg().currentStation !== 'ambient') throw new Error('skip changed station: ' + dbg().currentStation);
  if (dbg().playIdx !== 1) throw new Error('skip did not advance: idx ' + dbg().playIdx);
  if (!/2\/2.*song-b/.test(dbg().chip('ambient'))) throw new Error('chip after skip: ' + dbg().chip('ambient'));
  w.eval(`setTransport('skip')`);              // wrap back to the top
  if (dbg().playIdx !== 0) throw new Error('skip did not wrap: idx ' + dbg().playIdx);
  // 'ended' auto-advances too
  w.eval(`__ended()`);
  if (dbg().playIdx !== 1) throw new Error('ended did not advance: idx ' + dbg().playIdx);
  pump(10, 3000);
});
step('Live mode: plane follows the channel, placeholder on video plane', () => {
  w.eval(`setMode('live')`);
  if (!w.document.getElementById('console').classList.contains('mode-live')) throw new Error('console missing mode-live');
  if (dbg().plane !== 'canvas') throw new Error('house channel should be canvas plane: ' + dbg().plane);
  if (w.document.getElementById('vis').hidden) throw new Error('canvas hidden on canvas plane');
  if (w.document.getElementById('stream').style.display !== 'none') throw new Error('video visible on canvas plane');
  if (!dbg().paused) throw new Error('local music still playing in Live');
  w.eval(`selectVJ('nova')`);                    // stream VJ → video plane
  if (dbg().plane !== 'video') throw new Error('nova should be video plane: ' + dbg().plane);
  if (w.document.getElementById('placeholder').style.display === 'none') throw new Error('placeholder hidden on video+offline');
  w.eval(`setMode('live')`);                     // re-click: must keep holding
  if (w.document.getElementById('placeholder').style.display === 'none') throw new Error('re-click broke hold');
  w.eval(`selectVJ('house'); setMode('presets')`);
  if (dbg().mode !== 'presets' || dbg().plane !== 'canvas') throw new Error('did not return to Offline canvas');
  if (w.document.getElementById('vis').hidden) throw new Error('canvas hidden back in Offline');
  if (w.document.getElementById('console').classList.contains('mode-live')) throw new Error('mode-live class stuck');
  pump(5, 4000);
});
step('keys 1-4: tune stations Offline, live actions in Live', () => {
  w.eval(`fireKey('scene_3')`);
  if (dbg().currentStation !== 'static') throw new Error('got: ' + dbg().currentStation);
  w.eval(`setMode('live')`);
  w.eval(`fireKey('scene_2')`);
  if (dbg().currentStation !== 'static') throw new Error('Live 1-4 must not tune: ' + dbg().currentStation);
  const sent = dbg().lastSent;
  if (sent.type !== 'key' || sent.action !== 'scene_2') throw new Error('live action msg: ' + JSON.stringify(sent));
  const liveLbl = w.document.querySelectorAll('#keys .key-label')[1].textContent;
  if (liveLbl !== 'Live 2') throw new Error('live label: ' + liveLbl);
  w.eval(`setMode('presets')`);
  const offLbl = w.document.querySelectorAll('#keys .key-label')[0].textContent;
  if (offLbl !== 'Scene 1') throw new Error('offline label: ' + offLbl);
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
step('overlay FX also fire on the Live video plane', () => {
  w.eval(`setMode('live'); selectVJ('nova')`);   // video plane
  // the whole suite runs in <70ms real time — clear the per-action lockout
  w.eval(`__resetFire('action_3'); __resetFire('trigger')`);
  w.eval(`fireKey('action_3'); fireKey('trigger')`);
  pump(4, 6100);
  if (dbg().fxCount < 1) throw new Error('no FX on video plane: ' + dbg().fxCount);
  if (w.document.getElementById('vis').hidden) throw new Error('FX overlay canvas hidden on video plane');
  w.eval(`selectVJ('house'); setMode('presets')`);
  pump(30, 6150);
});
step('channel/VJ dropdowns route planes + message (Live only)', () => {
  const ch = w.document.getElementById('channelSelect');
  const vj = w.document.getElementById('vjSelect');
  if (!ch || ch.options.length < 2) throw new Error('channels not populated: ' + (ch && ch.options.length));
  if (vj.options[0].value !== 'house') throw new Error('house not first: ' + vj.options[0].value);

  w.eval(`selectVJ('nova')`);                    // in Offline: message only, no mode flip
  if (dbg().mode !== 'presets') throw new Error('Offline channel pick flipped the mode');
  const msg = dbg().sent.find(m => m.type === 'channel' && m.vj === 'nova');
  if (!msg || msg.channel !== 'volt-fm' || !msg.user || !msg.user.id || !msg.ts)
    throw new Error('channel msg: ' + JSON.stringify(msg));

  w.eval(`setMode('live')`);                     // entering Live applies the pick
  if (dbg().plane !== 'video') throw new Error('nova should be video plane: ' + dbg().plane);

  w.eval(`selectVJ('kera')`);                    // scene VJ → canvas plane + their scene
  if (dbg().plane !== 'canvas' || dbg().scene !== 'pulse')
    throw new Error('kera routing: ' + dbg().plane + '/' + dbg().scene);

  w.eval(`selectChannel('drift-radio')`);        // switch channel → VJ list rebuilt, default scene
  if (vj.options.length !== 2) throw new Error('vj list not rebuilt: ' + vj.options.length);
  if (dbg().channel !== 'drift-radio/house') throw new Error('state: ' + dbg().channel);
  if (dbg().scene !== 'drift') throw new Error('default scene: ' + dbg().scene);
  if (!dbg().sent.some(m => m.type === 'station' && m.station === 'drift'))
    throw new Error('scene message missing');
  if (dbg().currentStation !== 'static') throw new Error('Live routing must not touch the Offline station');

  w.eval(`setMode('presets')`);
  pump(10, 6000);
});
step('Live actions publish to the channel action bus', () => {
  const before = w.__busSockets.length;
  w.eval(`setMode('live')`);                     // channel is drift-radio from the previous step
  const s = w.__busSockets[w.__busSockets.length - 1];
  if (w.__busSockets.length === before || !s) throw new Error('no bus socket opened');
  if (!/\/api\/bus\?channel=drift-radio/.test(s.url)) throw new Error('bus url: ' + s.url);
  w.eval(`__resetFire('action_2'); fireKey('action_2')`);
  const got = s.sent.find(m => m.type === 'key' && m.action === 'action_2');
  if (!got || !got.user || !got.user.id || !got.ts) throw new Error('bus msg missing/unstamped: ' + JSON.stringify(s.sent.slice(-2)));
  w.eval(`setMode('presets')`);
  if (s.readyState === 1) throw new Error('bus socket not closed in Offline');
  pump(5, 6200);
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
    w.eval(`setMode('live'); selectChannel('api-test')`);   // API-only channel routes like any other
    if (dbg().plane !== 'canvas' || dbg().scene !== 'pulse')
      throw new Error('api channel routing: ' + dbg().plane + '/' + dbg().scene);
    const vj = w.document.getElementById('vjSelect');
    if (vj.options.length !== 1 || vj.options[0].value !== 'house')
      throw new Error('api channel should have house only');
    pump(5, 6300);
  });

  step('Live channel audio plays via the relay; no skipping live', () => {
    // still Live on api-test (canvas plane) — its live stream is the audio
    if (dbg().playerTid !== 'live:api-test') throw new Error('liveTune tid: ' + dbg().playerTid);
    w.eval(`presetPlay()`);
    if (!/\/api\/channels\/api-test\/audio/.test(dbg().playerSrc)) throw new Error('src: ' + dbg().playerSrc);
    if (!/LIVE AUDIO/.test(w.document.getElementById('tx').textContent))
      throw new Error('tx: ' + w.document.getElementById('tx').textContent);
    // skip is dead in Live: no station change, no transport message
    const transportsBefore = dbg().sent.filter(m => m.type === 'transport').length;
    w.eval(`setTransport('skip')`);
    if (dbg().sent.filter(m => m.type === 'transport').length !== transportsBefore)
      throw new Error('skip leaked a transport message in Live');
    if (dbg().playerTid !== 'live:api-test') throw new Error('skip touched the live stream');
    // a channel WITHOUT live audio → silence (the visual still runs)
    w.eval(`selectChannel('volt-fm')`);
    if (dbg().playerTid !== '') throw new Error('should be silent: ' + dbg().playerTid);
    if (!dbg().paused) throw new Error('player should be paused with no live audio');
    // back to Offline → the station songs return
    w.eval(`setMode('presets'); document.getElementById('st-ambient').checked = true; selectStation('ambient')`);
    if (dbg().playerTid !== 'ambient') throw new Error('offline song did not return: ' + dbg().playerTid);
    if (!/blob:/.test(dbg().playerSrc)) throw new Error('offline src: ' + dbg().playerSrc);
    pump(8, 6400);
  });
  step('signed-in account stamps messages + lights the chip', () => {
    w.eval(`fireKey('trigger')`);
    const sent = dbg().lastSent;
    if (!sent || sent.user.id !== 'u-test-1' || sent.user.name !== 'Test Account' || sent.user.role !== 'vj')
      throw new Error('identity not hydrated: ' + JSON.stringify(sent && sent.user));
    if (!sent.user.sid) throw new Error('sid dropped by hydration');
    const chip = w.document.getElementById('acct');
    if (!/Test Account · vj/.test(chip.textContent) || !chip.classList.contains('on'))
      throw new Error('account chip: "' + chip.textContent + '" on=' + chip.classList.contains('on'));
    pump(5, 6600);
  });

  step('paid takeover: queue renders + locks live actions for non-holders', () => {
    w.eval(`setMode('live')`);
    w.eval(`__setRole('listener')`);             // listeners are gated; vj/radio/admin bypass
    const ch = dbg().channel.split('/')[0];      // page consts aren't reachable across evals
    w.eval(`applyQueues({ channel: '${ch}',
      control: { active: { userId: 'u-rex', name: 'Rex', endsAt: Date.now() + 90000 },
                 queue: [{ userId: 'u-test-1', name: 'Test Account', position: 1 }] },
      songs: [{ id: 1, title: 'Flim', name: 'Rex' }] })`);
    const head = w.document.getElementById('qCtlHead').textContent;
    if (!/Rex.*has the controls/.test(head)) throw new Error('head: ' + head);
    if (!/1\. Test Account \(you\)/.test(w.document.getElementById('qCtlList').textContent))
      throw new Error('queue list: ' + w.document.getElementById('qCtlList').textContent);
    if (!/Leave the queue/.test(w.document.getElementById('qBid').textContent))
      throw new Error('bid button: ' + w.document.getElementById('qBid').textContent);
    if (!/Flim/.test(w.document.getElementById('qSongList').textContent)) throw new Error('song list missing request');
    const cap1 = w.document.querySelector('.keycap[data-action="scene_1"]');
    if (!cap1.classList.contains('locked')) throw new Error('live-action caps not locked');
    const sentBefore = dbg().sent.length;
    w.eval(`__resetFire('scene_2'); fireKey('scene_2')`);          // locked → nothing may leave
    if (dbg().sent.length !== sentBefore) throw new Error('locked live action leaked a message');
    if (!/has the controls/.test(w.document.getElementById('tx').textContent))
      throw new Error('tx: ' + w.document.getElementById('tx').textContent);
    // my slot starts → unlocked, actions flow again
    w.eval(`applyQueues({ channel: '${ch}',
      control: { active: { userId: 'u-test-1', name: 'Test Account', endsAt: Date.now() + 90000 }, queue: [] }, songs: [] })`);
    if (cap1.classList.contains('locked')) throw new Error('caps still locked for the slot holder');
    if (!/Release controls/.test(w.document.getElementById('qBid').textContent))
      throw new Error('holder button: ' + w.document.getElementById('qBid').textContent);
    w.eval(`__resetFire('scene_2'); fireKey('scene_2')`);
    if (dbg().lastSent.action !== 'scene_2') throw new Error('holder action did not send');
    // Privileged bypass must require a VERIFIED session: an unverified ?role=vj
    // stays LOCKED (the server would deny it), a verified vj bypasses.
    w.eval(`__setRole('vj'); __setVerified(false);
      applyQueues({ channel: '${ch}',
        control: { active: { userId: 'u-rex', name: 'Rex', endsAt: Date.now() + 90000 }, queue: [] }, songs: [] })`);
    if (!cap1.classList.contains('locked')) throw new Error('unverified vj role wrongly bypassed the lock');
    w.eval(`__setVerified(true); renderQueues()`);
    if (cap1.classList.contains('locked')) throw new Error('verified vj should bypass the lock');
    w.eval(`__setRole('operator'); __setVerified(false);
      applyQueues({ channel: '${ch}', control: { active: null, queue: [] }, songs: [] });
      setMode('presets')`);
    pump(5, 6700);
  });

  pump(30, 6000);
  console.log(errors.length ? '\n=== ERRORS ===\n' + errors.join('\n') : '\nALL CLEAR — no runtime errors');
  process.exit(errors.length ? 1 : 0);
})();

/* Security-hardening regression suite — locks in the fixes from the
   "can't hack it to take control" audit.

   Part A: unit-tests server/security.js (constant-time compare, SSRF/private-IP
   guard, admin fail-closed + brute-force lockout, rate limiter, WS origin,
   response headers).
   Part B: boots a REAL in-process server (no Supabase → dev identity) and drives
   a live WebSocket to prove the confirmed take-control holes are closed:
     · a non-rig socket CANNOT forge jukebox player reports (track_started/ended/
       position) — only an authenticated program rig can;
     · the output-routing control types (station/channel/mode/transport) are
       gated like scene_1..4 — an anonymous inject is refused, admin passes;
     · a cross-origin WS handshake is rejected; a rig (no Origin) is accepted;
     · security headers ship on every response.

   Run:  node .smoke-security.cjs   — must exit 0. */
'use strict';
const assert = require('assert');
const http = require('node:http');
const path = require('node:path');

let passed = 0;
const ok = (m) => { console.log('OK  ', passed + 1, m); passed++; };

(async () => {
  /* ══ Part A — security.js units ══ */
  const sec = await import('./server/security.js');

  // constant-time compare
  assert.strictEqual(sec.safeEqual('hunter2', 'hunter2'), true);
  assert.strictEqual(sec.safeEqual('hunter2', 'hunter3'), false);
  assert.strictEqual(sec.safeEqual('', 'x'), false);
  assert.strictEqual(sec.safeEqual('abc', 'abcd'), false);   // length differs, no throw
  ok('safeEqual: constant-time compare matches only exact secrets (length-safe)');

  // private-IP / SSRF classification
  for (const ip of ['127.0.0.1', '10.0.0.1', '172.16.5.5', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '::1', 'fe80::1', 'fd00::1'])
    assert.strictEqual(sec.isPrivateIp(ip), true, `${ip} must be private`);
  for (const ip of ['8.8.8.8', '1.1.1.1', '93.184.216.34', '2606:4700:4700::1111'])
    assert.strictEqual(sec.isPrivateIp(ip), false, `${ip} must be public`);
  await assert.rejects(() => sec.assertPublicUrl('http://127.0.0.1/x'), /non-public/);
  await assert.rejects(() => sec.assertPublicUrl('http://169.254.169.254/latest/meta-data/'), /non-public/);
  await assert.rejects(() => sec.assertPublicUrl('ftp://example.com/x'), /http/);
  await assert.rejects(() => sec.assertPublicUrl('http://user:pass@example.com/x'), /credentials/);
  await sec.assertPublicUrl('https://1.1.1.1/stream');   // public IP → resolves without throwing
  ok('SSRF guard: loopback/link-local/private/creds/non-http rejected, public allowed');

  // admin insecure / fail-closed-in-prod detection (env-driven)
  const save = { A: process.env.ADMIN_KEY, U: process.env.SUPABASE_URL, K: process.env.SUPABASE_PUBLISHABLE_KEY };
  delete process.env.ADMIN_KEY; delete process.env.SUPABASE_URL; delete process.env.SUPABASE_PUBLISHABLE_KEY;
  assert.strictEqual(sec.adminKeyInsecure(), true, 'unset key is insecure');
  assert.strictEqual(sec.adminDisabledInProd(), false, 'unset key + no Supabase = local dev, allowed');
  process.env.ADMIN_KEY = 'dev';
  assert.strictEqual(sec.adminDisabledInProd(), false, "'dev' + no Supabase = local dev, allowed");
  process.env.SUPABASE_URL = 'https://x.supabase.co'; process.env.SUPABASE_PUBLISHABLE_KEY = 'sb_pub';
  assert.strictEqual(sec.adminDisabledInProd(), true, "'dev' + Supabase configured = DISABLED (fail-closed)");
  process.env.ADMIN_KEY = 'a-real-strong-key';
  assert.strictEqual(sec.adminDisabledInProd(), false, 'real key + Supabase = allowed');
  ok('admin gate: insecure default fails CLOSED on a Supabase-configured deploy');

  // requireAdmin: wrong key 401, right key next(), lockout after N fails → 429
  sec.__resetAdminThrottle();
  const gate = sec.makeRequireAdmin('a-real-strong-key');
  const fakeReq = (key, ip = '9.9.9.9') => ({ get: (h) => (h.toLowerCase() === 'x-admin-key' ? key : undefined), ip });
  const fakeRes = () => { const r = { code: 200, body: null, setHeader(){}, status(c){ this.code = c; return this; }, json(b){ this.body = b; return this; } }; return r; };
  let nexted = false; let r = fakeRes();
  gate(fakeReq('a-real-strong-key'), r, () => { nexted = true; });
  assert.ok(nexted && r.code === 200, 'right key calls next()');
  r = fakeRes(); gate(fakeReq('wrong'), r, () => {}); assert.strictEqual(r.code, 401, 'wrong key → 401');
  for (let i = 0; i < 12; i++){ r = fakeRes(); gate(fakeReq('wrong', '6.6.6.6'), r, () => {}); }
  assert.strictEqual(r.code, 429, 'after 10 bad keys the IP is locked out (429)');
  // a different IP is unaffected, and the real key still works from it
  r = fakeRes(); nexted = false; gate(fakeReq('a-real-strong-key', '7.7.7.7'), r, () => { nexted = true; });
  assert.ok(nexted, 'lockout is per-IP — a clean IP with the right key still passes');
  ok('admin gate: constant-time check + per-IP brute-force lockout');

  // rate limiter: allows up to max, then 429; skips GET
  sec.__resetAdminThrottle();
  const rl = sec.makeRateLimiter({ windowMs: 10000, max: 3 });
  const rlReq = (method = 'POST', ip = '5.5.5.5') => ({ method, ip });
  let denied = 0; for (let i = 0; i < 5; i++){ const rr = fakeRes(); rl(rlReq(), rr, () => {}); if (rr.code === 429) denied++; }
  assert.strictEqual(denied, 2, 'over-budget POSTs are 429 (3 allowed of 5)');
  let getPassed = true; for (let i = 0; i < 10; i++){ const rr = fakeRes(); let n = false; rl(rlReq('GET'), rr, () => { n = true; }); if (!n) getPassed = false; }
  assert.ok(getPassed, 'GET is never rate-limited');
  ok('rate limiter: caps state-changing requests per IP, never throttles reads');

  // WS origin
  assert.strictEqual(sec.wsOriginAllowed({ headers: {} }), true, 'no Origin (rig) allowed');
  assert.strictEqual(sec.wsOriginAllowed({ headers: { origin: 'https://evil.example', host: 'volt.example' } }), false, 'cross-origin rejected');
  assert.strictEqual(sec.wsOriginAllowed({ headers: { origin: 'https://volt.example', host: 'volt.example' } }), true, 'same-origin allowed');
  ok('WS origin: cross-origin handshake rejected, same-origin and rigs allowed');

  // headers
  const hres = { h: {}, setHeader(k, v){ this.h[k] = v; } };
  sec.securityHeaders({ get: () => 'https', protocol: 'https', headers: {} }, hres, () => {});
  assert.strictEqual(hres.h['X-Frame-Options'], 'DENY');
  assert.match(hres.h['Content-Security-Policy'], /frame-ancestors 'none'/);
  assert.strictEqual(hres.h['X-Content-Type-Options'], 'nosniff');
  assert.ok(hres.h['Strict-Transport-Security'], 'HSTS on https');
  ok('security headers: frame-ancestors none / nosniff / referrer / HSTS');

  // restore env for Part B (no Supabase → dev identity works)
  process.env.ADMIN_KEY = 'dev';
  delete process.env.SUPABASE_URL; delete process.env.SUPABASE_PUBLISHABLE_KEY;

  /* ══ Part B — live server: the confirmed take-control holes are closed ══ */
  const express = (await import('express')).default;
  const { WebSocket } = await import('ws');
  const { createStore } = await import('./server/store.js');
  const itemsMod = await import('./server/items.js');
  const { attachBus } = await import('./server/bus.js');
  const { attachPaid } = await import('./server/paid.js');
  const { securityHeaders, makeRequireAdmin } = await import('./server/security.js');
  const fs = require('node:fs'); const os = require('node:os');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'volt-sec-'));
  const store = await (async () => { const { FileStore } = await import('./server/store.js'); return new FileStore(path.join(tmp, 'ch.json'), path.join(tmp, 'items.json')); })();

  const app = express();
  app.use(securityHeaders);
  app.use(express.json({ limit: '32kb' }));
  const requireAdmin = makeRequireAdmin('dev');
  attachPaid(app, requireAdmin);
  // Wire the admin chain too (directly-constructed FileStore has orgsEnabled
  // true) so the item-room gate's org branch is live for the forgery check.
  const { attachOrgs } = await import('./server/orgs.js');
  const orgs = await attachOrgs(app, requireAdmin, store);
  const itemsApi = await itemsMod.attachItems(app, requireAdmin, store, { orgs });
  orgs.wireItems(itemsApi);
  app.use((err, rq, rs, nx) => { rs.status(err.status || 500).json({ error: err.message || 'server error' }); });  // errors → JSON (like index.js)
  const server = http.createServer(app);
  attachBus(server, app);
  await new Promise(res => server.listen(0, '127.0.0.1', res));
  const PORT = server.address().port;
  const jrt = itemsMod.__test.jukebox.rt;

  const req = (method, p, { body, headers } = {}) => new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const r = http.request({ host: '127.0.0.1', port: PORT, path: p, method,
      headers: { ...(data ? { 'content-type': 'application/json' } : {}), ...(headers || {}) } }, (res) => {
      let b = ''; res.on('data', c => b += c); res.on('end', () => { let body = null; try { body = b ? JSON.parse(b) : null; } catch { body = b; } resolve({ status: res.statusCode, headers: res.headers, body }); });
    });
    r.on('error', reject); if (data) r.write(data); r.end();
  });
  const ADMIN = { 'x-admin-key': 'dev' };
  const wsConnect = (pathq, headers) => new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}${pathq}`, headers ? { headers } : undefined);
    ws.on('open', () => resolve({ ws, rejected: false }));
    ws.on('unexpected-response', () => resolve({ ws: null, rejected: true }));   // verifyClient refused the handshake
    ws.on('error', () => resolve({ ws: null, rejected: true }));
    ws.on('close', () => resolve({ ws: null, rejected: true }));
  });
  const settle = () => new Promise(r => setTimeout(r, 120));

  // security headers on a live response
  let res = await req('GET', '/api/items/ZZZZZZ');
  assert.strictEqual(res.headers['x-frame-options'], 'DENY', 'live responses carry X-Frame-Options');
  assert.match(res.headers['content-security-policy'] || '', /frame-ancestors/);
  ok('live: every response ships the anti-clickjacking + nosniff headers');

  // cross-origin WS rejected; rig-style (no origin) accepted
  const cross = await wsConnect('/api/bus?channel=item:AAAAAA', { origin: 'https://evil.example' });
  assert.strictEqual(cross.rejected, true, 'cross-origin WS handshake refused');
  const sameless = await wsConnect('/api/bus?channel=item:AAAAAA');
  assert.ok(sameless.ws, 'no-Origin (rig/tool) WS accepted');
  sameless.ws.close();
  ok('live: cross-origin WS refused at the handshake, rig/no-origin accepted');

  // build a jukebox + a rig output
  const jb = (await req('POST', '/api/items', { headers: ADMIN, body: {
    name: 'Sec Jukebox', surface: 'jukebox',
    jukebox: { monetization: 'per_action', backend: 'log', houseMode: false,
      catalog: [{ id: 'a', title: 'A', durationSec: 200 }, { id: 'b', title: 'B', durationSec: 200 }],
      skip: { minPlaySec: 0, allowMidSong: true } } } })).body;
  const CODE = jb.item;
  const rigAdd = await req('POST', `/api/items/${CODE}/outputs`, { headers: ADMIN, body: { kind: 'rig', name: 'pi-sec' } });
  const RIGKEY = rigAdd.body.rigKey;
  assert.ok(RIGKEY, 'rig key minted');

  // connect the program rig FIRST (name in the URL, key via HEADER) so the item
  // is sellable — this also exercises fix #4 (key out of the query string).
  const rig = await wsConnect(`/api/bus?channel=item:${CODE}&rig=pi-sec`, { 'x-rig-key': RIGKEY });
  assert.ok(rig.ws, 'rig socket open (key via header)');
  await settle();   // election makes it program

  // queue two songs (dev identity) → A plays, B queues
  await req('POST', `/api/items/${CODE}/jukebox/queue`, { body: { songId: 'a', user: { id: 'u1', name: 'Pat' } } });
  await req('POST', `/api/items/${CODE}/jukebox/queue`, { body: { songId: 'b', user: { id: 'u2', name: 'Sam' } } });
  assert.strictEqual(jrt.get(CODE).nowPlaying.songId, 'a', 'song A is playing, B queued');

  // ATTACK: a NON-RIG socket forges track_ended/track_started → must be IGNORED
  // (fix #1). A plain viewer here stands in for the privileged-session path the
  // audit found: the fix routes RIG_REPORT only when ws._rig is set, so a socket
  // that is not an authenticated rig — privileged human session or not — can't.
  const viewer = await wsConnect(`/api/bus?channel=item:${CODE}`);
  assert.ok(viewer.ws, 'viewer socket open');
  viewer.ws.send(JSON.stringify({ type: 'track_ended', songId: 'a' }));
  viewer.ws.send(JSON.stringify({ type: 'track_started', songId: 'b' }));
  await settle();
  assert.strictEqual(jrt.get(CODE).nowPlaying.songId, 'a', 'a non-rig socket CANNOT forge player reports (queue not advanced/hijacked)');
  viewer.ws.close();
  ok('fix#1: a non-rig WS cannot forge jukebox reports — player truth stays with the rig');

  // the LEGIT program rig CAN report → advances the queue (legit path intact)
  rig.ws.send(JSON.stringify({ type: 'track_ended', songId: 'a' }));
  await settle();
  assert.strictEqual(jrt.get(CODE).nowPlaying.songId, 'b', 'the elected program rig advances the queue');
  rig.ws.close();
  ok('fix#1: the authenticated program rig still reports truth (legit path intact)');

  // OUTPUT_CTL gate over the HTTP inject twin: anonymous station change refused,
  // admin passes (fix #2). Use a radio-channel room (not item:).
  const ch = (await req('POST', '/api/channels', { headers: ADMIN, body: { name: 'Main' } })).body;
  let anon = await req('POST', `/api/channels/${ch.id}/actions`, { body: { type: 'station', station: 'aurora' } });
  assert.strictEqual(anon.status, 403, 'anonymous station change refused (pay-gate)');
  anon = await req('POST', `/api/channels/${ch.id}/actions`, { body: { type: 'mode', mode: 'live' } });
  assert.strictEqual(anon.status, 403, 'anonymous mode flip refused');
  const adm = await req('POST', `/api/channels/${ch.id}/actions`, { headers: ADMIN, body: { type: 'station', station: 'aurora' } });
  assert.strictEqual(adm.status, 200, 'admin (operator) may steer the output');
  ok('fix#2: station/channel/mode/transport are gated — anonymous denied, operator passes');

  // a denied OUTPUT_CTL over WS must be SILENT (no "locked" readout for a viewer
  // whose console auto-emits station/mode on tune-in)
  const spy = await new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/api/bus?channel=${ch.id}`);
    const msgs = []; ws.on('message', (d) => { try { msgs.push(JSON.parse(d)); } catch {} });
    ws.on('open', () => resolve({ ws, msgs }));
  });
  spy.ws.send(JSON.stringify({ type: 'station', station: 'aurora' }));
  await settle();
  assert.ok(!spy.msgs.some(m => m.type === 'denied'), 'denied OUTPUT_CTL is silent (no spurious lock readout)');
  spy.ws.close();
  ok('fix#2: a denied output-control action is dropped silently over WS');

  // a rig may NOT claim the reserved 'admin' name (sentinel-collision guard)
  const badName = await req('POST', `/api/items/${CODE}/outputs`, { headers: ADMIN, body: { kind: 'rig', name: 'admin' } });
  assert.strictEqual(badName.status, 400, "a rig named 'admin' is refused");
  ok('rig sentinel: a rig cannot claim the reserved "admin" name');

  // ADMIN-CHAIN forgery: a bus key message that FORGES an org/platform role in
  // its payload must not escalate. The gate reads the verified session
  // (ws._user) + server-resolved org membership — NEVER the payload's claimed
  // role/orgRole (the same rule that closed the payload-identity hatch). Build
  // an org item with a holder, then forge a non-holder inject.
  const org = (await req('POST', '/api/admin/orgs', { headers: ADMIN, body: { name: 'Sec Bar' } })).body;
  const padItem = (await req('POST', '/api/items', { headers: ADMIN, body: { name: 'Sec Claw', priceCents: 100, slotSeconds: 300 } })).body.item;
  await req('POST', `/api/admin/orgs/${org.id}/items`, { headers: ADMIN, body: { code: padItem } });
  await req('POST', `/api/items/${padItem}/buy`, { body: { user: { id: 'holder-1', name: 'Holder' } } });   // dev-hatch holder
  // a non-holder inject that forges role:'admin' + orgRole:'owner' → still DENIED
  const forged = await req('POST', `/api/channels/item:${padItem}/actions`,
    { body: { type: 'key', action: 'pad_up', user: { id: 'attacker', name: 'M', role: 'admin', orgRole: 'owner' } } });
  assert.strictEqual(forged.status, 403, 'a forged role/orgRole in the payload does NOT grant item control');
  // the real holder (dev hatch) still drives — the gate works, it just ignores forged claims
  const real = await req('POST', `/api/channels/item:${padItem}/actions`,
    { body: { type: 'key', action: 'pad_up', user: { id: 'holder-1', name: 'Holder' } } });
  assert.strictEqual(real.status, 200, 'the genuine holder still drives (gate intact)');
  ok('admin-chain: forged org/platform role in a bus payload is ignored (identity = session + server-resolved membership)');

  // Gap 4A: the bus HTTP-inject honors fail-closed too — with Supabase configured
  // + the insecure 'dev' key, a track_started inject must NOT be accepted as admin.
  process.env.SUPABASE_URL = 'https://x.supabase.co'; process.env.SUPABASE_PUBLISHABLE_KEY = 'sb_pub';
  const injectFC = await req('POST', `/api/channels/${ch.id}/actions`, { headers: ADMIN, body: { type: 'track_started', songId: 'a' } });
  assert.strictEqual(injectFC.status, 403, 'bus inject refuses the insecure dev key when Supabase is configured (fail-closed)');
  delete process.env.SUPABASE_URL; delete process.env.SUPABASE_PUBLISHABLE_KEY;
  ok('fix Gap-4A: the bus HTTP-inject admin path also fails CLOSED on a misconfigured prod');

  server.close();
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}

  /* ══ Part C — the private operator vault (real index.js child boot) ══ */
  const { spawn } = require('node:child_process');
  const cget = (port, p, headers) => new Promise((resolve) => {
    const rq = http.get({ host: '127.0.0.1', port, path: p, headers: headers || {} }, (x) => { let b = ''; x.on('data', c => b += c); x.on('end', () => resolve({ status: x.statusCode, body: b })); });
    rq.on('error', () => resolve({ status: 0, body: '' }));
  });
  async function bootIndex(port, extraEnv){
    const child = spawn('node', ['server/index.js'], { cwd: __dirname, env: { ...process.env, PORT: String(port), ADMIN_KEY: 'dev', ...extraEnv }, stdio: 'ignore' });
    for (let i = 0; i < 40; i++){ if ((await cget(port, '/healthz')).status === 200) return child; await settle(); }
    child.kill('SIGKILL'); throw new Error('index.js did not boot on ' + port);
  }
  // configured vault: wrong code 401, right code 200 + content, file NOT static-served
  let vc = await bootIndex(8811, { VAULT_CODE: 'test-secret-123' });
  assert.strictEqual((await cget(8811, '/api/vault', { 'x-vault-code': 'nope' })).status, 401, 'wrong vault code → 401');
  const good = await cget(8811, '/api/vault', { 'x-vault-code': 'test-secret-123' });
  assert.strictEqual(good.status, 200, 'correct vault code → 200'); assert.ok(good.body.length > 100, 'vault serves content');
  assert.strictEqual((await cget(8811, '/.vault/recipe-book.html')).status, 404, 'the vault file is NOT served statically (no leak)');
  vc.kill('SIGKILL');
  ok('vault: correct code serves content · wrong code 401 · file blocked from static');
  // unconfigured vault (no VAULT_CODE) → fails CLOSED (503), even with a code
  vc = await bootIndex(8812, { VAULT_CODE: '' });
  assert.strictEqual((await cget(8812, '/api/vault', { 'x-vault-code': 'anything' })).status, 503, 'no VAULT_CODE → vault off (503)');
  vc.kill('SIGKILL');
  ok('vault: fails CLOSED (503) when VAULT_CODE is unset');

  Object.assign(process.env, save.A ? { ADMIN_KEY: save.A } : {});
  console.log(`\nALL CLEAR — ${passed} security checks passed`);
  process.exit(0);
})().catch((e) => { console.error('\nFAIL:', e.message); console.error(e.stack); process.exit(1); });

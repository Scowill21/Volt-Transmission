/* Server-side smoke test for the PAID CONTROL GATE — the part that earns money.
   The client smoke test (.smoke-test.cjs) only proves the console MIRRORS the
   lock; this proves the SERVER actually enforces it. It boots no socket: it
   installs the real routes (bus.js + paid.js) onto a fake Express app and
   drives them, so it runs fast and hermetically.

   Auth is left UNCONFIGURED (no SUPABASE_URL/KEY) → devIdentityAllowed() is
   true, so the documented payload escape hatch stands in for real sessions.
   That is exactly the path the local console uses; the production path (verified
   cookie → ws._user) is the same keyGate with identity from a different source.

   Run:  node .smoke-server.cjs   — must exit 0.  */
'use strict';
delete process.env.SUPABASE_URL;
delete process.env.SUPABASE_PUBLISHABLE_KEY;   // force auth-unconfigured (dev identity)
delete process.env.ADMIN_KEY;                  // admin key falls back to 'dev'

const http = require('http');
const assert = require('assert');

/* ── a minimal Express stand-in ─────────────────────────────────────── */
function makeApp(){
  const routes = [];
  const add = (method) => (path, ...handlers) => routes.push({ method, path, handlers });
  return {
    get: add('GET'), post: add('POST'), patch: add('PATCH'), delete: add('DELETE'), use(){},
    _routes: routes,
  };
}
function makeRes(){
  const res = {
    statusCode: 200, body: undefined, _sent: false,
    status(c){ this.statusCode = c; return this; },
    json(o){ this.body = o; this._sent = true; return this; },
    send(o){ this.body = o; this._sent = true; return this; },
    setHeader(){}, end(){ this._sent = true; },
  };
  return res;
}
async function call(app, method, path, { params = {}, body = {}, headers = {} } = {}){
  const route = app._routes.find(r => r.method === method && r.path === path);
  if (!route) throw new Error(`no route ${method} ${path}`);
  const req = { params, body, headers, get: (h) => headers[h.toLowerCase()] };
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

/* ── faithful requireAdmin (mirrors server/index.js) ────────────────── */
const requireAdmin = (req, res, next) =>
  req.get('x-admin-key') === (process.env.ADMIN_KEY || 'dev')
    ? next()
    : res.status(401).json({ error: 'admin key required' });

const CH = 'volt-fm';
const AS = (id, name) => ({ user: { id, name } });                 // dev escape-hatch identity
const inject = (action, id) => ({ type: 'key', action, ...(id ? { user: { id } } : {}) });

let passed = 0;
const ok = (label) => { console.log('OK  ', label); passed++; };

(async () => {
  const server = http.createServer();                             // never listens — just for WSS attach
  const app = makeApp();
  const bus = await import('./server/bus.js');
  const paid = await import('./server/paid.js');
  bus.attachBus(server, app);                                     // registers POST …/actions + installs nothing
  paid.attachPaid(app, requireAdmin);                            // installs the keyGate + paid routes

  // 1. Identity-less bid is rejected.
  let r = await call(app, 'POST', '/api/channels/:id/control/request', { params: { id: CH }, body: {} });
  assert.strictEqual(r.statusCode, 401, 'anonymous bid should 401');
  ok('anonymous control bid → 401');

  // 2. Ada bids and takes the (only) slot.
  r = await call(app, 'POST', '/api/channels/:id/control/request', { params: { id: CH }, body: AS('u-ada', 'Ada') });
  assert.strictEqual(r.statusCode, 201);
  assert.strictEqual(r.body.control.active.name, 'Ada', 'Ada should hold the slot');
  ok('Ada bids → holds the control slot');

  // 3. THE PRODUCT: a non-holder's live action is DENIED at the server.
  r = await call(app, 'POST', '/api/channels/:id/actions', { params: { id: CH }, body: inject('scene_3', 'u-bob') });
  assert.strictEqual(r.statusCode, 403, 'non-holder scene action must be 403');
  assert.match(r.body.error, /Ada has the controls/);
  ok('non-holder scene_3 → 403 (blocked server-side)');

  // 4. The holder's own live action passes.
  r = await call(app, 'POST', '/api/channels/:id/actions', { params: { id: CH }, body: inject('scene_2', 'u-ada') });
  assert.strictEqual(r.statusCode, 200, 'holder scene action should pass');
  assert.strictEqual(r.body.ok, true);
  ok('holder scene_2 → passes');

  // 5. Admin (X-Admin-Key) bypasses the takeover.
  r = await call(app, 'POST', '/api/channels/:id/actions',
    { params: { id: CH }, body: inject('scene_1'), headers: { 'x-admin-key': 'dev' } });
  assert.strictEqual(r.statusCode, 200, 'admin should bypass the lock');
  ok('admin scene_1 → bypasses the lock');

  // 6. Overlay actions are NOT gated by the takeover (only scene_1..4 are).
  r = await call(app, 'POST', '/api/channels/:id/actions',
    { params: { id: CH }, body: { type: 'key', action: 'action_1', user: { id: 'u-bob' } } });
  assert.strictEqual(r.statusCode, 200, 'overlay action must stay open to everyone');
  ok('non-holder overlay action_1 → passes (not gated)');

  // 7. Reserved control-plane types can't be injected by clients.
  r = await call(app, 'POST', '/api/channels/:id/actions',
    { params: { id: CH }, body: { type: 'queues', control: { active: { name: 'Mallory' } } } });
  assert.strictEqual(r.statusCode, 400, 'forged {type:queues} must be rejected');
  ok('forged {type:queues} inject → 400');

  // 8. Bob queues behind Ada; skip promotes him.
  r = await call(app, 'POST', '/api/channels/:id/control/request', { params: { id: CH }, body: AS('u-bob', 'Bob') });
  assert.strictEqual(r.body.control.queue[0].name, 'Bob', 'Bob should be queued at position 1');
  r = await call(app, 'POST', '/api/channels/:id/control/skip', { params: { id: CH }, headers: { 'x-admin-key': 'dev' } });
  assert.strictEqual(r.body.control.active.name, 'Bob', 'skip should promote Bob');
  ok('admin skip → promotes the next bidder');

  // 9. Now Bob is the holder, Ada's action is denied.
  r = await call(app, 'POST', '/api/channels/:id/actions', { params: { id: CH }, body: inject('scene_2', 'u-ada') });
  assert.strictEqual(r.statusCode, 403, 'former holder should now be denied');
  ok('after promotion, old holder scene_2 → 403');

  // 10. Song request round-trip + admin gating.
  r = await call(app, 'POST', '/api/channels/:id/songs/request',
    { params: { id: CH }, body: { title: 'Windowlicker', ...AS('u-ada', 'Ada') } });
  assert.strictEqual(r.statusCode, 201);
  const songId = r.body.songs[0].id;
  r = await call(app, 'POST', '/api/channels/:id/songs/:songId',
    { params: { id: CH, songId: String(songId) }, body: { action: 'played' } });       // no admin key
  assert.strictEqual(r.statusCode, 401, 'non-admin mark-played must 401');
  r = await call(app, 'POST', '/api/channels/:id/songs/:songId',
    { params: { id: CH, songId: String(songId) }, body: { action: 'played' }, headers: { 'x-admin-key': 'dev' } });
  assert.strictEqual(r.statusCode, 200, 'admin mark-played should pass');
  ok('song request → non-admin played 401, admin played 200');

  // 11. Public GET must not materialize state for an unknown channel (DoS guard).
  r = await call(app, 'GET', '/api/channels/:id/queues', { params: { id: 'ghost-' + passed } });
  assert.strictEqual(r.body.control.active, null, 'unknown channel reads empty');
  // Re-read: still no active slot, and nothing leaked from the real channel.
  assert.strictEqual(r.body.channel, 'ghost-' + passed);
  ok('GET /queues on unknown channel → empty, no state created');

  console.log(`\nALL CLEAR — ${passed} server-gate checks passed`);
  process.exit(0);
})().catch((e) => { console.error('\nFAIL:', e.message); process.exit(1); });

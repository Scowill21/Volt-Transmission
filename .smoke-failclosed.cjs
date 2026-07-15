/* Fail-closed regression test — guards THE headline security fix.

   The dev "declare your own identity" escape hatch (paid.js requester() +
   keyGate) must key on DEPLOY INTENT (Supabase env vars present), NOT on live
   DB reachability. So on a real deploy whose Postgres is down, payload identity
   must be REJECTED — never silently trusted.

   devIdentityAllowed() reads SUPABASE_URL/KEY at MODULE LOAD, so this can't be
   tested in-process alongside .smoke-server.cjs (which imports with the env
   deleted). We boot the real server in a child process WITH Supabase env set
   but DATABASE_URL pointed at an unreachable host (simulating an outage → JSON
   fallback → getPool() null → authConfigured() false), then assert the paid
   write paths fail closed.

   Run:  node .smoke-failclosed.cjs   — must exit 0.  */
'use strict';
const { spawn } = require('node:child_process');
const http = require('node:http');
const path = require('node:path');

const PORT = 8793;
const BASE = `http://127.0.0.1:${PORT}`;

const env = {
  ...process.env,
  PORT: String(PORT),
  ADMIN_KEY: 'dev',
  // Supabase env PRESENT → this is a "configured" deploy (production intent)…
  SUPABASE_URL: 'https://example.supabase.co',
  SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_failclosed_test',
  // …but the DB is unreachable → the escape hatch must NOT re-open.
  DATABASE_URL: 'postgresql://postgres:nope@127.0.0.1:59998/postgres',
};

function req(method, urlPath, body){
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const r = http.request(BASE + urlPath, {
      method, headers: { 'Content-Type': 'application/json' },
    }, (res) => {
      let buf = '';
      res.on('data', (c) => (buf += c));
      res.on('end', () => resolve({ status: res.statusCode, body: buf }));
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

async function waitForBoot(tries){
  for (let i = 0; i < tries; i++){
    try { const r = await req('GET', '/healthz'); if (r.status === 200) return true; }
    catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
}

(async () => {
  const child = spawn('node', ['server/index.js'], {
    cwd: path.resolve(__dirname), env, stdio: ['ignore', 'ignore', 'ignore'],
  });
  let passed = 0;
  const fail = (m) => { console.error('FAIL:', m); child.kill('SIGKILL'); process.exit(1); };
  const ok = (m) => { console.log('OK  ', m); passed++; };

  try {
    if (!await waitForBoot(30)) fail('server did not boot within ~9s');
    ok('server booted (Supabase env set, Postgres unreachable → JSON fallback)');

    // A payload-identity bid MUST be rejected: env is set, so devIdentityAllowed()
    // is false; the DB being down must NOT re-open the hatch.
    let r = await req('POST', '/api/channels/volt-fm/control/request', { user: { id: 'attacker', name: 'Mallory' } });
    if (r.status !== 401) fail(`control bid should 401 during outage, got ${r.status}: ${r.body}`);
    ok('payload-identity control bid → 401 (fail-closed, not trusted)');

    r = await req('POST', '/api/channels/volt-fm/songs/request', { title: 'spoof', user: { id: 'attacker', name: 'Mallory' } });
    if (r.status !== 401) fail(`song request should 401 during outage, got ${r.status}: ${r.body}`);
    ok('payload-identity song request → 401 (fail-closed)');

    // The minutes knob must be unreachable here too (rides only the dev hatch).
    r = await req('POST', '/api/channels/volt-fm/control/request', { minutes: 10, user: { id: 'x', name: 'X' } });
    if (r.status !== 401) fail(`minutes-knob bid should 401 during outage, got ${r.status}`);
    ok('minutes-knob bid → 401 (knob unreachable in production intent)');

    // Volt Control items (server/items.js) share the same posture: with
    // Supabase env set, payload identity on /buy and /bid must be rejected
    // even while the DB is down — never trusted. (Identity is checked before
    // the item lookup, so any well-formed code proves it.)
    r = await req('POST', '/api/items/ZZZZZZ/buy', { user: { id: 'attacker', name: 'Mallory' } });
    if (r.status !== 401) fail(`item buy should 401 during outage, got ${r.status}: ${r.body}`);
    ok('payload-identity item buy → 401 (fail-closed)');

    r = await req('POST', '/api/items/ZZZZZZ/bid', { cents: 500, user: { id: 'attacker', name: 'Mallory' } });
    if (r.status !== 401) fail(`item bid should 401 during outage, got ${r.status}: ${r.body}`);
    ok('payload-identity item bid → 401 (fail-closed)');

    // Sanity: the public read still works and creates no state.
    r = await req('GET', '/api/channels/volt-fm/queues');
    if (r.status !== 200) fail(`GET /queues should 200, got ${r.status}`);
    ok('GET /queues still serves (read-only) during outage');

    child.kill('SIGKILL');
    console.log(`\nALL CLEAR — ${passed} fail-closed checks passed`);
    process.exit(0);
  } catch (e) {
    child.kill('SIGKILL');
    fail(e.message);
  }
})();

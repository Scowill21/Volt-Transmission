/* Headless smoke test for account.html (Volt Control) — evals the page script
   in jsdom with a mocked auth API and drives every sign-in/out flow,
   INCLUDING the regressions that made William unable to log in/out:

   1. THE BOUNCE TRAP: landing on /account.html?return=… while ALREADY signed
      in must NOT redirect — the signed-in card (with Sign out) must render.
      The bounce is welcome only immediately after an explicit sign-in.
   2. Sign out works and returns the page to the sign-in form.
   3. "forgot password?" sends /api/auth/recover with the typed email.
   4. A #access_token…&type=recovery hash posts /api/auth/recovered, opens the
      set-new-password card, and /api/auth/password saves it.
   5. "Email not confirmed" login errors surface the resend button →
      /api/auth/resend.

   jsdom landmines (HANDOFF): page-scope const/let unreachable — this page
   wires everything through element handlers, so drive via DOM; fetches
   resolve on microtasks — `await new Promise(setImmediate)` between action
   and assertion.

   Run:  node .smoke-account.cjs   — must exit 0.  */
'use strict';
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { JSDOM, VirtualConsole } = (() => {
  try { return require('jsdom'); }
  catch { return require(path.join('/tmp', 'node_modules', 'jsdom')); }
})();

const html = fs.readFileSync(path.join(__dirname, 'account.html'), 'utf8');
const results = [];
let n = 0;
const ok = (name) => { results.push(`OK   ${++n} ${name}`); };
const tick = () => new Promise(setImmediate);

/* One jsdom boot per scenario — the page decides everything at load time.
   jsdom can't actually navigate: `location.href = …` raises a jsdomError on
   the virtual console. We CAPTURE those as `navs` — a redirect ATTEMPT is the
   observable behavior under test (test 1 asserts none happen; test 2 asserts
   one does). */
function boot({ url, user, hashOutcome } = {}){
  const navs = [];
  const vc = new VirtualConsole();
  vc.on('jsdomError', (err) => { if (/navigation/i.test(String(err.message))) navs.push('nav'); });
  const dom = new JSDOM(html, { runScripts: 'outside-only', url: url || 'http://localhost/account.html', virtualConsole: vc });
  const w = dom.window;
  const state = { user: user || null, calls: [], navs };
  const respond = (status, body) => Promise.resolve({ ok: status < 400, status, json: () => Promise.resolve(body) });
  w.fetch = (u, opts = {}) => {
    const method = (opts.method || 'GET').toUpperCase();
    const body = opts.body ? JSON.parse(opts.body) : {};
    state.calls.push(`${method} ${u}`);
    if (String(u).endsWith('/api/me')) return respond(200, { user: state.user });
    if (String(u).endsWith('/api/auth/login')){
      if (body.password === 'right'){ state.user = { id: 'u1', email: body.email, name: 'Will', role: 'listener' }; return respond(200, { user: state.user }); }
      if (body.password === 'unconfirmed') return respond(400, { error: 'Email not confirmed' });
      return respond(400, { error: 'Invalid login credentials' });
    }
    if (String(u).endsWith('/api/auth/logout')){ state.user = null; return respond(200, { ok: true }); }
    if (String(u).endsWith('/api/auth/recover')) return respond(200, { ok: true });
    if (String(u).endsWith('/api/auth/resend')) return respond(200, { ok: true });
    if (String(u).endsWith('/api/auth/recovered')){
      if (hashOutcome === 'expired') return respond(401, { error: 'invalid recovery token' });
      state.user = { id: 'u1', email: 'w@x.com', name: 'Will', role: 'listener' };
      return respond(200, { user: state.user });
    }
    if (String(u).endsWith('/api/auth/password')){
      state.calls.push(`PASSWORD:${body.password}`);
      return body.password.length >= 8 ? respond(200, { ok: true }) : respond(400, { error: 'password must be at least 8 characters' });
    }
    return respond(404, { error: 'unmocked ' + u });
  };
  // eval the page script (script tag content) the way the other suites do
  const src = html.match(/<script>([\s\S]*)<\/script>/)[1];
  w.eval(src);
  return { w, state, $: (id) => w.document.getElementById(id) };
}

(async () => {
  /* 1 ── THE BOUNCE TRAP (regression): signed in + ?return → NO redirect */
  {
    const { $, state } = boot({ url: 'http://localhost/account.html?return=/control-ops', user: { id: 'u1', email: 'w@x.com', name: 'Will', role: 'listener' } });
    await tick(); await tick(); await tick();
    assert.strictEqual(state.navs.length, 0, 'no redirect attempt on load while signed in');
    assert.strictEqual($('meBox').hidden, false, 'signed-in card renders (Sign out reachable)');
    assert.ok($('logout'), 'Sign out is present');
    assert.strictEqual($('returnLink').hidden, false, 'a "Continue →" link offers the return path instead');
    assert.strictEqual($('returnLink').getAttribute('href'), '/control-ops', 'continue link targets the return path');
    ok('bounce trap fixed: signed-in + ?return shows Sign out (no instant redirect)');
  }

  /* 2 ── the bounce still happens right after an explicit sign-in */
  {
    const { $, state } = boot({ url: 'http://localhost/account.html?return=/control-ops' });
    await tick(); await tick();
    assert.strictEqual($('authBox').hidden, false, 'signed-out → the sign-in form');
    $('email').value = 'w@x.com'; $('password').value = 'right';
    $('go').onclick();
    await tick(); await tick(); await tick();
    assert.ok(state.calls.some(c => c === 'POST /api/auth/login'), 'login posted');
    assert.strictEqual(state.navs.length, 1, 'post-login bounce to ?return still fires');
    ok('post-sign-in ?return bounce preserved');
  }

  /* 3 ── sign out returns to the sign-in form */
  {
    const { $, state } = boot({ user: { id: 'u1', email: 'w@x.com', name: 'Will', role: 'listener' } });
    await tick(); await tick();
    assert.strictEqual($('meBox').hidden, false, 'starts signed in');
    $('logout').onclick();
    await tick(); await tick(); await tick();
    assert.ok(state.calls.some(c => c === 'POST /api/auth/logout'), 'logout posted');
    assert.strictEqual($('authBox').hidden, false, 'back to the sign-in form');
    assert.strictEqual($('meBox').hidden, true, 'signed-in card gone');
    ok('sign out round-trips to the sign-in form');
  }

  /* 4 ── forgot password */
  {
    const { $, state } = boot({});
    await tick(); await tick();
    $('forgot').onclick({ preventDefault(){} });
    await tick();
    assert.match($('authStatus').textContent, /type your email/, 'no email → told to type it first');
    $('email').value = ' will@x.com ';
    $('forgot').onclick({ preventDefault(){} });
    await tick(); await tick();
    assert.ok(state.calls.some(c => c === 'POST /api/auth/recover'), 'recover posted');
    assert.match($('authStatus').textContent, /reset link sent/, 'confirmation message');
    ok('forgot password → /api/auth/recover with the typed email');
  }

  /* 5 ── recovery-link landing: hash → recovered → set new password */
  {
    const { w, $, state } = boot({ url: 'http://localhost/account.html#access_token=tok123&refresh_token=r456&type=recovery' });
    await tick(); await tick(); await tick();
    assert.ok(state.calls.some(c => c === 'POST /api/auth/recovered'), 'hash tokens posted to /api/auth/recovered');
    assert.ok(!String(w.location.hash).includes('access_token'), 'the token hash is scrubbed from the URL');
    assert.strictEqual($('resetBox').hidden, false, 'set-new-password card opens');
    $('newPassword').value = 'brand-new-pass';
    $('setPassword').onclick();
    await tick(); await tick(); await tick();
    assert.ok(state.calls.some(c => c === 'PASSWORD:brand-new-pass'), 'new password posted');
    assert.match($('resetStatus').textContent, /password saved/, 'saved confirmation');
    ok('recovery link → cookies via /recovered → new password saved');
  }

  /* 6 ── expired recovery link degrades politely */
  {
    const { $ } = boot({ url: 'http://localhost/account.html#access_token=dead&type=recovery', hashOutcome: 'expired' });
    await tick(); await tick(); await tick();
    assert.strictEqual($('resetBox').hidden, true, 'no password card on a dead link');
    assert.match($('authStatus').textContent, /link expired/, 'told to request a fresh link');
    ok('expired recovery link → clear message, sign-in form still usable');
  }

  /* 7 ── unconfirmed account → resend confirmation */
  {
    const { $, state } = boot({});
    await tick(); await tick();
    $('email').value = 'w@x.com'; $('password').value = 'unconfirmed';
    $('go').onclick();
    await tick(); await tick(); await tick();
    assert.strictEqual($('resend').hidden, false, '"Email not confirmed" surfaces the resend button');
    $('resend').onclick();
    await tick(); await tick();
    assert.ok(state.calls.some(c => c === 'POST /api/auth/resend'), 'resend posted');
    assert.match($('authStatus').textContent, /re-sent/, 'resend confirmation message');
    ok('unconfirmed login → resend confirmation email');
  }

  /* 8 ── wrong password points at the reset path */
  {
    const { $ } = boot({});
    await tick(); await tick();
    $('email').value = 'w@x.com'; $('password').value = 'nope';
    $('go').onclick();
    await tick(); await tick(); await tick();
    assert.match($('authStatus').textContent, /forgot password/, 'wrong-password error points at the reset link');
    ok('wrong password → error message routes to "forgot password?"');
  }

  console.log(results.join('\n'));
  console.log(`\nALL CLEAR — ${n} account checks passed`);
})().catch((e) => { console.error(results.join('\n')); console.error('\nFAIL:', e.message); process.exit(1); });

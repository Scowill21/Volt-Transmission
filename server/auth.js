/* Accounts + roles (ROADMAP Tier 2a).
   Supabase Auth (GoTrue REST) does the hard part — passwords, tokens,
   confirmation emails. This module keeps the console dependency-free by
   mediating everything server-side:

     browser ⇄ our Express API (httpOnly cookies) ⇄ Supabase Auth
                                 ⇅
                    profiles table (same Postgres as channels)

   Roles: listener (default) | vj | radio | admin. Listeners sign up freely;
   vj/radio are applications an admin approves (admin.html). The effective
   role lives on the profiles row — approval just flips it.

   Config: SUPABASE_URL + SUPABASE_PUBLISHABLE_KEY (+ DATABASE_URL for the
   profiles table). Missing any → every endpoint degrades politely
   (GET /api/me answers { user: null }) and the console runs as before.

   Cookies: volt_at (access JWT, ~1 h) + volt_rt (refresh). HttpOnly,
   SameSite=Lax; Secure behind HTTPS (x-forwarded-proto on Render). */
import { getPool, httpError } from './store.js';

const SUPABASE_URL = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
const SUPABASE_KEY = process.env.SUPABASE_PUBLISHABLE_KEY || '';

export const ROLES = ['listener', 'vj', 'radio', 'admin'];
export const APPLY_ROLES = ['vj', 'radio'];

export const authConfigured = () => !!(SUPABASE_URL && SUPABASE_KEY && getPool());

// Is the local-dev URL-param / payload identity escape hatch allowed?
// Keyed on INTENT (Supabase env absent), NOT on live DB reachability — so a
// transient Postgres outage on a real deploy fails CLOSED (401 / deny) instead
// of silently trusting client-declared identity.
export const devIdentityAllowed = () => !(SUPABASE_URL && SUPABASE_KEY);

/* ── GoTrue REST ─────────────────────────────────────────────────── */
async function gotrue(path, { method = 'POST', token, body } = {}){
  const res = await fetch(`${SUPABASE_URL}/auth/v1${path}`, {
    method,
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${token || SUPABASE_KEY}`,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok){
    const msg = data.msg || data.error_description || data.message || data.error || `auth ${res.status}`;
    throw httpError(res.status === 422 ? 400 : res.status, msg);
  }
  return data;
}

/* ── cookies (tiny, dependency-free) ─────────────────────────────── */
export function readCookies(req){
  const out = {};
  for (const part of (req.headers.cookie || '').split(';')){
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function setSession(req, res, session){
  const secure = (req.get('x-forwarded-proto') || req.protocol) === 'https' ? '; Secure' : '';
  const base = `Path=/; HttpOnly; SameSite=Lax${secure}`;
  const cookies = session
    ? [
        `volt_at=${encodeURIComponent(session.access_token)}; ${base}; Max-Age=${session.expires_in || 3600}`,
        `volt_rt=${encodeURIComponent(session.refresh_token)}; ${base}; Max-Age=${60 * 60 * 24 * 30}`,
      ]
    : [`volt_at=; ${base}; Max-Age=0`, `volt_rt=; ${base}; Max-Age=0`];
  res.setHeader('Set-Cookie', cookies);
}

/* ── profiles table (rides the channels pool) ────────────────────── */
export async function initAuth(){
  if (!authConfigured()) return;
  await getPool().query(`
    CREATE TABLE IF NOT EXISTS profiles (
      user_id      UUID PRIMARY KEY,
      email        TEXT,
      name         TEXT,
      role         TEXT NOT NULL DEFAULT 'listener',
      applied_role TEXT,
      applied_note TEXT,
      applied_at   TIMESTAMPTZ,
      created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
}

async function ensureProfile(user){
  const name = user.user_metadata?.name || user.email?.split('@')[0] || 'listener';
  await getPool().query(
    `INSERT INTO profiles (user_id, email, name) VALUES ($1,$2,$3)
     ON CONFLICT (user_id) DO NOTHING`,
    [user.id, user.email || null, name]);
  const { rows } = await getPool().query(
    'SELECT user_id, email, name, role, applied_role FROM profiles WHERE user_id = $1', [user.id]);
  return rows[0];
}

const publicUser = (p) => p && {
  id: p.user_id, email: p.email, name: p.name, role: p.role, appliedRole: p.applied_role || null,
};

/* ── session resolution (+ silent refresh) ───────────────────────── */
async function resolveUser(req, res){
  const cookies = readCookies(req);
  if (cookies.volt_at){
    try {
      const user = await gotrue('/user', { method: 'GET', token: cookies.volt_at });
      if (user?.id) return publicUser(await ensureProfile(user));
    } catch { /* expired — fall through to refresh */ }
  }
  if (cookies.volt_rt){
    try {
      const session = await gotrue('/token?grant_type=refresh_token', { body: { refresh_token: cookies.volt_rt } });
      setSession(req, res, session);
      if (session.user?.id) return publicUser(await ensureProfile(session.user));
    } catch (e) {
      // Clear cookies ONLY when GoTrue says the token is dead (400/401). A
      // transient 5xx / network blip must not nuke a valid 30-day session.
      if (e && (e.status === 400 || e.status === 401)) setSession(req, res, null);
    }
  }
  return null;
}

/* Read-only session check for non-Express contexts (WebSocket upgrades,
   paid-feature requests): verifies the volt_at cookie against GoTrue and
   returns the profile, WITHOUT attempting the refresh-token dance (there is
   no response to set cookies on). Expired token → null; the console's
   normal /api/me polling refreshes the session out-of-band. */
export async function userFromRequest(req){
  if (!authConfigured()) return null;
  const { volt_at } = readCookies(req);
  if (!volt_at) return null;
  try {
    const user = await gotrue('/user', { method: 'GET', token: volt_at });
    if (user?.id) return publicUser(await ensureProfile(user));
  } catch { /* expired/invalid — treat as signed out */ }
  return null;
}

/* The acting identity for the paid tiers + the admin chain: the VERIFIED
   session, or the documented dev escape hatch when auth is unconfigured (local
   JSON-store dev), mirroring the console's IDENTITY layers. Dev identity rides
   the body ({user:{id,name,email?}}) on POSTs, or ?uid=&name=&email= query
   params on GETs. Lives here (not in a product module) because it is pure
   identity — items.js / jukebox.js / orgs.js / paid.js / shop.js all consume
   it, and it must not tie any of them to another product. `email` rides along
   for the admin chain (org membership matches on it). */
export async function requester(req){
  const u = await userFromRequest(req);
  if (u) return { id: u.id, name: u.name || u.email, role: u.role, verified: true, email: u.email || null };
  if (devIdentityAllowed()){
    const b = (req.body && req.body.user)
      || (req.query && req.query.uid && { id: req.query.uid, name: req.query.name || req.query.uid, email: req.query.email });
    if (b && b.id && b.name)
      return { id: String(b.id).slice(0, 64), name: String(b.name).slice(0, 40), role: 'listener', verified: false,
        email: b.email ? String(b.email).slice(0, 120).toLowerCase() : null };
  }
  return null;
}

/* ── express wiring ──────────────────────────────────────────────── */
export function mountAuth(app, requireAdmin){
  const guard = (handler) => async (req, res, next) => {
    if (!authConfigured()) return res.status(501).json({ error: 'auth not configured (set SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, DATABASE_URL)' });
    try { await handler(req, res); } catch (e) { next(e); }
  };

  app.post('/api/auth/signup', guard(async (req, res) => {
    const { email, password, name } = req.body || {};
    if (!email || !password) throw httpError(400, 'email and password required');
    // redirect_to: the confirmation email should land back on THIS site's
    // account page (shared Supabase project — without it, the link falls back
    // to the project Site URL, which points at a different property).
    const proto = req.get('x-forwarded-proto') || req.protocol;
    const redirect = encodeURIComponent(`${proto}://${req.get('host')}/account.html`);
    const data = await gotrue(`/signup?redirect_to=${redirect}`, { body: { email, password, data: { name: (name || '').trim() || undefined } } });
    // Confirmations ON → GoTrue returns a user but no session until the email
    // link is clicked. Confirmations OFF → session arrives immediately.
    if (data.access_token){
      setSession(req, res, data);
      return res.status(201).json({ user: publicUser(await ensureProfile(data.user)) });
    }
    res.status(201).json({ user: null, pendingConfirmation: true });
  }));

  app.post('/api/auth/login', guard(async (req, res) => {
    const { email, password } = req.body || {};
    if (!email || !password) throw httpError(400, 'email and password required');
    const session = await gotrue('/token?grant_type=password', { body: { email, password } });
    setSession(req, res, session);
    res.json({ user: publicUser(await ensureProfile(session.user)) });
  }));

  app.post('/api/auth/logout', async (req, res) => {
    const { volt_at } = readCookies(req);
    if (volt_at && authConfigured()) await gotrue('/logout', { token: volt_at }).catch(() => {});
    setSession(req, res, null);
    res.json({ ok: true });
  });

  // Forgot password: GoTrue emails a recovery link. redirect_to points back at
  // OUR account page (must be in Supabase Auth → URL Configuration → Redirect
  // URLs, else GoTrue falls back to the project Site URL — the account page on
  // any of our domains completes the flow either way). Always answers ok — a
  // "no such account" answer would leak who has an account.
  app.post('/api/auth/recover', guard(async (req, res) => {
    const email = String((req.body || {}).email || '').trim();
    if (!email) throw httpError(400, 'email required');
    const proto = req.get('x-forwarded-proto') || req.protocol;
    const redirect = encodeURIComponent(`${proto}://${req.get('host')}/account.html`);
    await gotrue(`/recover?redirect_to=${redirect}`, { body: { email } }).catch(() => {});
    res.json({ ok: true });
  }));

  // The recovery/confirmation link lands with tokens in the URL FRAGMENT
  // (#access_token=…&type=recovery). The page posts them here; we verify the
  // access token against GoTrue before trusting it, then move the session into
  // our httpOnly cookies (the fragment never reaches any server log).
  app.post('/api/auth/recovered', guard(async (req, res) => {
    const { access_token, refresh_token } = req.body || {};
    if (!access_token) throw httpError(400, 'access_token required');
    const user = await gotrue('/user', { method: 'GET', token: access_token });
    if (!user?.id) throw httpError(401, 'invalid recovery token');
    setSession(req, res, { access_token, refresh_token: refresh_token || '', expires_in: 3600 });
    res.json({ user: publicUser(await ensureProfile(user)) });
  }));

  // Set a new password for the SIGNED-IN account (the recovery flow signs the
  // user in via /recovered first, so "reset password" is just this).
  app.post('/api/auth/password', guard(async (req, res) => {
    const password = String((req.body || {}).password || '');
    if (password.length < 8) throw httpError(400, 'password must be at least 8 characters');
    const { volt_at } = readCookies(req);
    if (!volt_at) throw httpError(401, 'sign in first');
    await gotrue('/user', { method: 'PUT', token: volt_at, body: { password } });
    res.json({ ok: true });
  }));

  // Resend the signup confirmation email (surfaced when a login fails with
  // "Email not confirmed"). Always ok — same no-leak rule as /recover.
  app.post('/api/auth/resend', guard(async (req, res) => {
    const email = String((req.body || {}).email || '').trim();
    if (!email) throw httpError(400, 'email required');
    await gotrue('/resend', { body: { type: 'signup', email } }).catch(() => {});
    res.json({ ok: true });
  }));

  // Who am I? The console calls this on load to stamp messages with the real
  // account. Never errors — an unconfigured/anonymous answer is { user: null }.
  app.get('/api/me', async (req, res) => {
    if (!authConfigured()) return res.json({ user: null });
    try { res.json({ user: await resolveUser(req, res) }); }
    catch { res.json({ user: null }); }
  });

  // Apply to be a VJ / radio host (any signed-in account).
  app.post('/api/apply', guard(async (req, res) => {
    const user = await resolveUser(req, res);
    if (!user) throw httpError(401, 'sign in first');
    const { role, note } = req.body || {};
    if (!APPLY_ROLES.includes(role)) throw httpError(400, `role must be one of ${APPLY_ROLES.join('|')}`);
    if (user.role === role) throw httpError(409, `already approved as ${role}`);
    await getPool().query(
      `UPDATE profiles SET applied_role = $2, applied_note = $3, applied_at = now() WHERE user_id = $1`,
      [user.id, role, (note || '').slice(0, 500) || null]);
    res.json({ ok: true, appliedRole: role });
  }));

  /* admin: review applications (same X-Admin-Key scheme as channels) */
  app.get('/api/admin/applications', requireAdmin, guard(async (req, res) => {
    const { rows } = await getPool().query(
      `SELECT user_id, email, name, role, applied_role, applied_note, applied_at
       FROM profiles WHERE applied_role IS NOT NULL ORDER BY applied_at`);
    res.json(rows.map(p => ({
      id: p.user_id, email: p.email, name: p.name, role: p.role,
      appliedRole: p.applied_role, note: p.applied_note, appliedAt: p.applied_at,
    })));
  }));

  app.post('/api/admin/applications/:userId', requireAdmin, guard(async (req, res) => {
    const { action } = req.body || {};
    if (!['approve', 'decline'].includes(action)) throw httpError(400, 'action must be approve|decline');
    const { rows } = await getPool().query(
      'SELECT user_id, applied_role FROM profiles WHERE user_id = $1', [req.params.userId]);
    if (!rows.length || !rows[0].applied_role) throw httpError(404, 'no pending application');
    if (action === 'approve'){
      await getPool().query(
        `UPDATE profiles SET role = applied_role, applied_role = NULL, applied_note = NULL, applied_at = NULL
         WHERE user_id = $1`, [req.params.userId]);
    } else {
      await getPool().query(
        `UPDATE profiles SET applied_role = NULL, applied_note = NULL, applied_at = NULL
         WHERE user_id = $1`, [req.params.userId]);
    }
    res.json({ ok: true });
  }));
}

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
    } catch { setSession(req, res, null); }   // dead refresh token — clear
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

/* ── express wiring ──────────────────────────────────────────────── */
export function mountAuth(app, requireAdmin){
  const guard = (handler) => async (req, res, next) => {
    if (!authConfigured()) return res.status(501).json({ error: 'auth not configured (set SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, DATABASE_URL)' });
    try { await handler(req, res); } catch (e) { next(e); }
  };

  app.post('/api/auth/signup', guard(async (req, res) => {
    const { email, password, name } = req.body || {};
    if (!email || !password) throw httpError(400, 'email and password required');
    const data = await gotrue('/signup', { body: { email, password, data: { name: (name || '').trim() || undefined } } });
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

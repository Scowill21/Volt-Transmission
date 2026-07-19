/* The admin chain — orgs, delegated roles, scoped ops (Volt Control).

   A delegation ladder where every rung only reaches DOWN, enforced on the
   SERVER on every request — never in the page (the UI hiding a button is a
   courtesy; the gate is the law). Extends the Tier-2a accounts machinery:

     rung 0  platform   X-Admin-Key            create orgs/items/rigs, set
                                               bands + floors, grant tech/owner,
                                               all orgs, audit
     rung 1  org owner  business principal     edit whitelisted item fields
                                               WITHIN bounds, pause/off, layout,
                                               jukebox rules/catalog, invite
                                               staff, view org audit
     rung 2  org staff  bartender / floor      pause/skip/force-skip only
     rung 2b org tech   their AV person        rotate rig keys, output chains,
                                               controller maps
     rung 3  rig key    a machine              (unchanged — items.js)
     rung 4  slot holder paying patron         (unchanged — the bus gate)

   Org roles are a NEW axis, orthogonal to platform roles (listener/vj/radio/
   admin): a vj is not thereby an org owner. Identity comes from the verified
   session (or the dev-hatch in unconfigured-auth dev), matched to org
   membership BY EMAIL — the same email GoTrue verifies and org invites are
   keyed on. Bounds are REJECT-not-clamp: an out-of-band edit is a 400 with the
   band in the message, nothing written. Every successful org write appends one
   audit row (append-only, no delete path). Requires a durable database
   (store.orgsEnabled) — without one the endpoints 503; the rest of the
   platform runs untouched. */
import { requester } from './paid.js';
import { httpError, ORG_ROLE_RANK, ORG_ROLES, ITEM_FIELDS, LIMIT_FIELDS,
         JUKEBOX_MONETIZATION, JUKEBOX_MODES, JUKEBOX_FIELDS } from './store.js';

const rank = (role) => ORG_ROLE_RANK[role] || 0;

// REJECT-not-clamp: an owner edit outside the store's intrinsic [min,max] must
// 400 (the store would otherwise silently clamp, making the audit log record a
// value that was never stored). A per-item `bounds` band tightens INSIDE these.
function assertRange(v, range, name){
  if (!range) return v;
  const [min, max] = range;
  if (v < min || v > max) throw httpError(400, `${name} must be between ${min} and ${max}`);
  return v;
}

export async function attachOrgs(app, requireAdmin, store){
  // In-memory membership mirror for the SYNCHRONOUS bus gate (items.js calls
  // roleOf per key message and can't await). Keyed by org → lowercased email →
  // role. Authoritative + updated on every write, so offboarding bites on the
  // very next request (no per-session role cache — the mission's rule). Loaded
  // once at attach; empty (and roleOf → null) whenever orgs aren't enabled.
  const mirror = new Map();                      // orgId -> Map<lowerEmail, orgRole>
  const suspended = new Set();                   // orgIds whose members are frozen (HTTP and bus gate)
  const setMember = (orgId, email, role) => {
    if (!mirror.has(orgId)) mirror.set(orgId, new Map());
    mirror.get(orgId).set(String(email).toLowerCase(), role);
  };
  const dropMember = (orgId, email) => {
    const m = mirror.get(orgId); if (!m) return;
    m.delete(String(email).toLowerCase()); if (!m.size) mirror.delete(orgId);
  };
  async function reloadMirror(){
    if (!store.orgsEnabled){ mirror.clear(); suspended.clear(); return; }
    // Build into temp structures and swap ONLY on full success — a half-load
    // (members loaded, orgs query throws) must NOT leave a populated mirror with
    // an EMPTY suspended set, which would silently un-freeze a suspended org's
    // members on the bus until the next restart. On failure, keep the prior view.
    try {
      const members = await store.listAllMembers();
      const orgs = await store.listOrgs();
      mirror.clear(); suspended.clear();
      for (const m of members) setMember(m.orgId, m.email, m.orgRole);
      for (const o of orgs) if (o.status !== 'active') suspended.add(o.id);
    }
    catch (e){ console.error('[orgs] membership mirror load failed (keeping prior view):', e.message); }
  }
  await reloadMirror();

  // Raw membership lookup — ignores suspension, because requireOrg needs the
  // real rung to say "this org is suspended" rather than a misleading
  // "no permission" to a legitimate member.
  function memberRole(user, orgId){
    if (!orgId || !user || !user.email) return null;
    return mirror.get(orgId)?.get(String(user.email).toLowerCase()) || null;
  }
  // The bus gate's sync resolver: what org role does this user hold in THIS org?
  // Starts from the item's org (caller passes item.orgId) — never the user's org
  // list — so cross-org privilege is impossible by construction. Matches on the
  // session's verified email. Suspension freezes members on the BUS too, not
  // just over HTTP — a suspended venue's staff can't keep driving the item.
  function roleOf(user, orgId){
    if (suspended.has(orgId)) return null;
    return memberRole(user, orgId);
  }

  // §4's userId linkage: invites are email-only rows; the VERIFIED auth user id
  // backfills the first time that person touches their org (never a dev-hatch
  // id — those aren't verified). Best-effort by design: a link hiccup must
  // never fail the request it rode in on.
  function linkUser(who, orgId){
    if (!who || !who.verified || !who.id || !who.email) return;
    Promise.resolve(store.linkMemberUserId(orgId, String(who.email).toLowerCase(), who.id))
      .catch(() => {});
  }

  // itemsApi is wired AFTER attachItems (index.js orchestrates the 3-step dance
  // to break the mutual dependency). Routes close over this ref; it is populated
  // before any request can arrive.
  let itemsApi = null;

  /* ── guards ─────────────────────────────────────────────────────── */
  const need503 = () => { if (!store.orgsEnabled) throw httpError(503, 'org features need a database (set DATABASE_URL)'); };

  // Resolve the acting person (verified session or dev-hatch). Null → 401.
  async function actorOf(req){
    const who = await requester(req);
    if (!who) throw httpError(401, 'sign in first');
    return who;
  }

  // Session-gated middleware factory: the actor must satisfy `minRole` in the
  // org named by :id. Two shapes, because the ladder is NOT purely linear:
  //  · default (rank): role rank ≥ minRole rank — owner ⊇ staff (owner can do
  //    everything staff can). Used for actions (floor 'staff') + owner config.
  //  · { exact:true }: role === minRole EXACTLY. Used for the TECH rung — rig
  //    keys / output chains / controller maps are a DISTINCT capability the
  //    owner explicitly can NEVER touch (rung table), only the platform-vetted
  //    per-org tech person. X-Admin-Key never reaches here (rung 0 has its own
  //    key-gated routes). Attaches req._org.
  function requireOrg(minRole, { exact = false } = {}){
    return async (req, res, next) => {
      try {
        need503();
        const orgId = req.params.id;
        const org = await store.getOrg(orgId);
        if (!org) throw httpError(404, 'org not found');
        const who = await actorOf(req);
        const role = memberRole(who, orgId);
        const okRole = role && (exact ? role === minRole : rank(role) >= rank(minRole));
        if (!okRole) throw httpError(403, exact
          ? `only the org's ${minRole} may do that`
          : 'you do not have that permission in this org');
        // A suspended org is frozen for its members (platform can still manage it).
        if (org.status !== 'active') throw httpError(403, 'this org is suspended — contact the operator');
        linkUser(who, orgId);
        req._org = { org, actor: who, role };
        next();
      } catch (e){ next(e); }
    };
  }
  const requireTech = () => requireOrg('tech', { exact: true });   // rig keys / outputs — tech only, NOT owner

  // Load an item and assert it belongs to the org in the route. The org check
  // ALWAYS starts from item.orgId, so a member of org A can never touch org B's
  // item even by guessing a code.
  function orgItem(req){
    const code = String(req.params.code || '').toUpperCase();
    const item = itemsApi && itemsApi.get(code);
    if (!item) throw httpError(404, 'no item with that code');
    if (item.orgId !== req._org.org.id) throw httpError(403, 'that item belongs to a different org');
    return item;
  }

  // Append one audit row per successful write. Awaited but never fatal: the
  // write already happened, so an audit-store hiccup logs rather than 500s.
  async function audit(actorUserId, orgId, itemCode, field, oldV, newV){
    try { await store.appendAudit({ orgId, actorUserId, itemCode, field, old: oldV, new: newV }); }
    catch (e){ console.error('[orgs] audit append failed:', e.message); }
  }

  /* ── the owner field whitelist + bounds (single source of truth) ──
     Reject-not-clamp: an out-of-band value is a 400 that names the band and
     writes nothing. Returns the validated { patch } to hand the store, plus a
     list of {field, from, to} changes for the audit trail. */
  function planOwnerPatch(item, body){
    const bounds = item.bounds || {};
    const patch = {};
    const changes = [];
    const change = (field, to, from) => { changes.push({ field, from, to }); };

    if (body.priceCents !== undefined){
      const v = assertRange(intOrThrow(body.priceCents, 'priceCents'), ITEM_FIELDS.priceCents, 'priceCents');
      const band = bounds.priceBandCents;
      if (band && (v < band.min || v > band.max))
        throw httpError(400, `priceCents must be within ${band.min}–${band.max} cents (your band)`);
      if (v !== item.priceCents){ patch.priceCents = v; change('priceCents', v, item.priceCents); }
    }
    if (body.slotSeconds !== undefined){
      const v = assertRange(intOrThrow(body.slotSeconds, 'slotSeconds'), ITEM_FIELDS.slotSeconds, 'slotSeconds');
      if (bounds.slotSecondsMax && v > bounds.slotSecondsMax)
        throw httpError(400, `slotSeconds must be ≤ ${bounds.slotSecondsMax} (your cap)`);
      if (v !== item.slotSeconds){ patch.slotSeconds = v; change('slotSeconds', v, item.slotSeconds); }
    }
    if (body.controller !== undefined){
      patch.controller = body.controller;   // store validates the enum (reject on bad value)
      if (body.controller !== item.controller) change('controller', body.controller, item.controller);
    }
    if (body.hours !== undefined){
      patch.hours = body.hours;             // store validates shape/size
      change('hours', '(updated)', '(prev)');
    }
    // limits: tighten-only vs the platform floor/cap (rest MORE, drive SLOWER)
    if (body.limits !== undefined && typeof body.limits === 'object' && body.limits){
      const lim = { ...item.limits };
      if (body.limits.cooldownMs !== undefined){
        const v = assertRange(intOrThrow(body.limits.cooldownMs, 'cooldownMs'), LIMIT_FIELDS.cooldownMs, 'cooldownMs');
        if (bounds.cooldownFloorMs && v < bounds.cooldownFloorMs)
          throw httpError(400, `cooldownMs must be ≥ ${bounds.cooldownFloorMs} (your floor — you may rest it more, never less)`);
        lim.cooldownMs = v; change('limits.cooldownMs', v, (item.limits || {}).cooldownMs);
      }
      if (body.limits.maxPerMin !== undefined){
        const v = assertRange(intOrThrow(body.limits.maxPerMin, 'maxPerMin'), LIMIT_FIELDS.maxPerMin, 'maxPerMin');
        if (bounds.maxPerMinCap && v > bounds.maxPerMinCap)
          throw httpError(400, `maxPerMin must be ≤ ${bounds.maxPerMinCap} (your cap)`);
        lim.maxPerMin = v; change('limits.maxPerMin', v, (item.limits || {}).maxPerMin);
      }
      patch.limits = lim;
    }
    // jukebox rules/catalog: DEEP-MERGE over the existing config (the store
    // REPLACES, so an un-merged one-knob PATCH would reset every other knob to
    // defaults). Money knobs ride the price band; the skip floor rides the
    // platform's minPlaySec floor. monetization + mode flips are owner-allowed
    // (owner's call) but need an idle item (no live slot/queue) — same as the
    // platform surface-flip guard.
    if (body.jukebox !== undefined){
      if (item.surface !== 'jukebox') throw httpError(409, 'this item is not a jukebox');
      if (!body.jukebox || typeof body.jukebox !== 'object' || Array.isArray(body.jukebox))
        throw httpError(400, 'jukebox must be an object of knobs to change');
      patch.jukebox = planJukeboxMerge(item, body.jukebox, bounds, changes);
    }
    if (!changes.length) throw httpError(400, 'nothing to change (no editable fields in that patch, or values unchanged)');
    return { patch, changes };
  }

  function planJukeboxMerge(item, jb, bounds, changes){
    const cur = item.jukebox || {};
    const merged = deepClone(cur);
    const band = bounds.priceBandCents;
    // Money knob: reject outside the store's intrinsic cents range (never clamp)
    // AND outside the owner's band if one is set. Returns the validated value.
    const money = (v, fieldKey, name) => {
      const n = assertRange(intOrThrow(v, name), JUKEBOX_FIELDS[fieldKey], name);
      if (band && (n < band.min || n > band.max))
        throw httpError(400, `${name} must be within ${band.min}–${band.max} cents (your band)`);
      return n;
    };
    const num = (v, fieldKey, name) => assertRange(intOrThrow(v, name), JUKEBOX_FIELDS[fieldKey], name);
    // flips (owner-allowed, idle-guarded) — validate the enum so a typo can't
    // silently coerce to the platform default and flip the billing model.
    if (jb.monetization !== undefined && jb.monetization !== cur.monetization){
      if (!JUKEBOX_MONETIZATION.includes(jb.monetization)) throw httpError(400, `monetization must be ${JUKEBOX_MONETIZATION.join('|')}`);
      assertJukeboxIdle(item, 'change how this jukebox is monetized');
      merged.monetization = jb.monetization; changes.push({ field: 'jukebox.monetization', from: cur.monetization, to: jb.monetization });
    }
    if (jb.mode !== undefined && jb.mode !== cur.mode){
      if (!JUKEBOX_MODES.includes(jb.mode)) throw httpError(400, `mode must be ${JUKEBOX_MODES.join('|')}`);
      assertJukeboxIdle(item, "change the jukebox's request model");
      merged.mode = jb.mode; changes.push({ field: 'jukebox.mode', from: cur.mode, to: jb.mode });
    }
    // Every remaining knob only audits when it actually CHANGES — the store
    // REPLACES, so the client sends the whole config; without an equality guard
    // a no-op Save would append phantom rows to the append-only change log.
    if (jb.houseMode !== undefined && !!jb.houseMode !== !!cur.houseMode){
      merged.houseMode = !!jb.houseMode; changes.push({ field: 'jukebox.houseMode', from: cur.houseMode, to: !!jb.houseMode });
    }
    if (jb.catalog !== undefined && !deepEqual(jb.catalog, cur.catalog)){
      merged.catalog = jb.catalog;
      changes.push({ field: 'jukebox.catalog', from: (cur.catalog || []).length + ' songs', to: (Array.isArray(jb.catalog) ? jb.catalog.length : '?') + ' songs' });
    }
    if (jb.queueRules !== undefined){
      const qr = { ...cur.queueRules, ...jb.queueRules };
      for (const k of ['maxLen', 'maxPerUser', 'noRepeatMin'])
        if (jb.queueRules[k] !== undefined) qr[k] = num(jb.queueRules[k], 'queueRules.' + k, 'queueRules.' + k);
      if (!deepEqual(qr, cur.queueRules)){ merged.queueRules = qr; changes.push({ field: 'jukebox.queueRules', from: '(prev)', to: '(updated)' }); }
    }
    if (jb.queuePriceCents !== undefined){
      const v = money(jb.queuePriceCents, 'queuePriceCents', 'queuePriceCents');
      if (v !== cur.queuePriceCents){ merged.queuePriceCents = v; changes.push({ field: 'jukebox.queuePriceCents', from: cur.queuePriceCents, to: v }); }
    }
    if (jb.playNextPriceCents !== undefined){
      const v = jb.playNextPriceCents === null ? null : money(jb.playNextPriceCents, 'playNextPriceCents', 'playNextPriceCents');
      if (v !== cur.playNextPriceCents){ merged.playNextPriceCents = v; changes.push({ field: 'jukebox.playNextPriceCents', from: cur.playNextPriceCents, to: v }); }
    }
    if (jb.skip !== undefined && typeof jb.skip === 'object' && jb.skip){
      const skip = { ...cur.skip, perUser: { ...cur.skip.perUser }, global: { ...cur.skip.global } };
      const s = jb.skip;
      if (s.priceCents !== undefined) skip.priceCents = money(s.priceCents, 'skip.priceCents', 'skip.priceCents');
      if (s.allowMidSong !== undefined) skip.allowMidSong = !!s.allowMidSong;
      if (s.minPlaySec !== undefined){
        const v = num(s.minPlaySec, 'skip.minPlaySec', 'skip.minPlaySec');
        const floor = bounds.jukebox?.minPlaySecFloor;
        if (floor && v < floor) throw httpError(400, `skip.minPlaySec must be ≥ ${floor} (your floor — songs may rest longer, never shorter)`);
        skip.minPlaySec = v;
      }
      if (s.onlyBeforeSec !== undefined) skip.onlyBeforeSec = num(s.onlyBeforeSec, 'skip.onlyBeforeSec', 'skip.onlyBeforeSec');
      // Pre-validate the window BEFORE the store silently widens onlyBeforeSec up
      // to minPlaySec — an owner deserves a rejection, not a quiet correction.
      if (!skip.allowMidSong && skip.onlyBeforeSec < skip.minPlaySec)
        throw httpError(400, `skip.onlyBeforeSec (${skip.onlyBeforeSec}) must be ≥ skip.minPlaySec (${skip.minPlaySec}) unless mid-song skips are on`);
      if (s.perUser !== undefined){
        if (s.perUser.max !== undefined) skip.perUser.max = num(s.perUser.max, 'skip.perUser.max', 'skip.perUser.max');
        if (s.perUser.windowMin !== undefined) skip.perUser.windowMin = num(s.perUser.windowMin, 'skip.perUser.windowMin', 'skip.perUser.windowMin');
      }
      if (s.global !== undefined){
        if (s.global.max !== undefined) skip.global.max = num(s.global.max, 'skip.global.max', 'skip.global.max');
        if (s.global.windowMin !== undefined) skip.global.windowMin = num(s.global.windowMin, 'skip.global.windowMin', 'skip.global.windowMin');
      }
      if (!deepEqual(skip, cur.skip)){ merged.skip = skip; changes.push({ field: 'jukebox.skip', from: '(prev)', to: '(updated)' }); }
    }
    return merged;
  }

  function assertJukeboxIdle(item, what){
    const live = itemsApi && itemsApi.hasLiveRuntime(item.code);
    if (live) throw httpError(409, `end the current slot/queue before you ${what}`);
  }

  /* ══════════ rung 0 — platform (X-Admin-Key) ══════════ */

  app.get('/api/admin/orgs', requireAdmin, wrap(async (req) => {
    need503();
    const orgs = await store.listOrgs();
    // include member counts + item counts for the fleet view
    const members = await store.listAllMembers();
    return orgs.map(o => ({ ...o,
      members: members.filter(m => m.orgId === o.id).map(m => ({ email: m.email, orgRole: m.orgRole })),
      itemCount: itemsApi ? itemsApi.listByOrg(o.id).length : 0 }));
  }));

  app.post('/api/admin/orgs', requireAdmin, wrap(async (req) => {
    need503();
    const org = await store.createOrg({ name: req.body?.name, slug: req.body?.slug });
    await audit('admin-key', org.id, null, 'org.create', null, org.name);
    return org;
  }, 201));

  app.patch('/api/admin/orgs/:id', requireAdmin, wrap(async (req) => {
    need503();
    const before = await store.getOrg(req.params.id);
    if (!before) throw httpError(404, 'org not found');
    const org = await store.updateOrg(req.params.id, req.body || {});
    // keep the gate's suspension view in lockstep with the durable status
    if (org.status === 'active') suspended.delete(org.id); else suspended.add(org.id);
    if (req.body?.status !== undefined && req.body.status !== before.status)
      await audit('admin-key', org.id, null, 'org.status', before.status, org.status);
    if (req.body?.name !== undefined && org.name !== before.name)
      await audit('admin-key', org.id, null, 'org.name', before.name, org.name);
    return org;
  }));

  // Assign / unassign an item to an org (platform only — orgId is never
  // owner-editable). Unassign = pass no org or the /items DELETE route.
  app.post('/api/admin/orgs/:id/items', requireAdmin, wrap(async (req) => {
    need503();
    const org = await store.getOrg(req.params.id);
    if (!org) throw httpError(404, 'org not found');
    const code = String(req.body?.code || '').toUpperCase();
    const item = itemsApi && itemsApi.get(code);
    if (!item) throw httpError(404, 'no item with that code');
    const updated = await itemsApi.setOrg(code, org.id);
    await audit('admin-key', org.id, code, 'item.assign', item.orgId || '(none)', org.id);
    return updated;
  }, 201));

  app.delete('/api/admin/orgs/:id/items/:code', requireAdmin, wrap(async (req) => {
    need503();
    const code = String(req.params.code).toUpperCase();
    const item = itemsApi && itemsApi.get(code);
    if (!item) throw httpError(404, 'no item with that code');
    if (item.orgId !== req.params.id) throw httpError(409, 'that item is not assigned to this org');
    const updated = await itemsApi.setOrg(code, null);
    await audit('admin-key', req.params.id, code, 'item.unassign', req.params.id, '(none)');
    return updated;
  }));

  app.patch('/api/admin/items/:code/bounds', requireAdmin, wrap(async (req) => {
    need503();
    const code = String(req.params.code).toUpperCase();
    const item = itemsApi && itemsApi.get(code);
    if (!item) throw httpError(404, 'no item with that code');
    const updated = await itemsApi.setBounds(code, req.body?.bounds ?? req.body ?? null);
    await audit('admin-key', item.orgId, code, 'item.bounds', JSON.stringify(item.bounds), JSON.stringify(updated.bounds));
    return updated;
  }));

  // Grant / change / revoke org roles. ONLY rung 0 mints tech or owner; an org
  // owner may invite staff (that route lives below, session-gated). Passing an
  // empty role or the DELETE route removes.
  app.post('/api/admin/orgs/:id/grants', requireAdmin, wrap(async (req) => {
    need503();
    const org = await store.getOrg(req.params.id);
    if (!org) throw httpError(404, 'org not found');
    const email = String(req.body?.email || '').trim().toLowerCase();
    const orgRole = req.body?.orgRole;
    if (!ORG_ROLES.includes(orgRole)) throw httpError(400, `orgRole must be ${ORG_ROLES.join('|')}`);
    const m = await store.addMember({ orgId: org.id, email, orgRole, invitedBy: 'admin-key' });
    setMember(org.id, email, orgRole);
    await audit('admin-key', org.id, null, 'grant.' + orgRole, null, email);
    return m;
  }, 201));

  app.delete('/api/admin/orgs/:id/members/:email', requireAdmin, wrap(async (req) => {
    need503();
    const email = String(req.params.email).trim().toLowerCase();
    await store.removeMember(req.params.id, email);
    dropMember(req.params.id, email);
    await audit('admin-key', req.params.id, null, 'revoke', email, null);
    return { ok: true };
  }));

  app.get('/api/admin/audit', requireAdmin, wrap(async (req) => {
    need503();
    if (!req.query.orgId) throw httpError(400, 'orgId query param required');
    return store.listAudit({ orgId: req.query.orgId, limit: +req.query.limit || 200 });
  }));

  /* ══════════ session-gated — org members (rungs 1/2/2b) ══════════ */

  // Which orgs am I in, and at what rung? (drives the ops session lens — `me`
  // feeds the signed-in header chip, `status` lets the page say "suspended")
  app.get('/api/org/mine', wrap(async (req) => {
    need503();
    const who = await actorOf(req);
    const email = who.email && who.email.toLowerCase();
    const me = { email: email || null, name: who.name };
    if (!email) return { me, orgs: [] };
    const out = [];
    for (const [orgId, m] of mirror){
      const role = m.get(email);
      if (!role) continue;
      const org = await store.getOrg(orgId);
      if (!org) continue;
      out.push({ id: org.id, name: org.name, status: org.status, role });
      linkUser(who, orgId);
    }
    return { me, orgs: out };
  }));

  // The roster (owner) — you can't remove who you can't see. Emails + rungs
  // only; reads are never audited.
  app.get('/api/org/:id/members', requireOrg('owner'), wrap(async (req) => {
    return (await store.listMembers(req._org.org.id)).map(m => ({ email: m.email, orgRole: m.orgRole }));
  }));

  // The org's items (staff+). Returns full item shape incl. bounds (render the
  // band, don't hide it) and jukebox config (owner edits it).
  app.get('/api/org/:id/items', requireOrg('staff'), wrap(async (req) => {
    return itemsApi.listByOrg(req._org.org.id).map(i => itemsApi.orgView(i));
  }));

  // Owner edits whitelisted fields, within bounds, audited field-by-field.
  app.patch('/api/org/:id/items/:code', requireOrg('owner'), wrap(async (req) => {
    const item = orgItem(req);
    const { patch, changes } = planOwnerPatch(item, req.body || {});
    const updated = await itemsApi.applyOrgPatch(item.code, patch);
    for (const c of changes) await audit(req._org.actor.id, req._org.org.id, item.code, c.field, c.from, c.to);
    return itemsApi.orgView(updated);
  }));

  // Staff/owner runtime actions (no config change). Staff-reachable set is
  // pause/resume/skip/force_skip; owner also gets on/off + clear_queue/house.
  const STAFF_ACTIONS = new Set(['pause', 'resume', 'skip', 'force_skip', 'remove']);
  const OWNER_ACTIONS = new Set(['on', 'off', 'clear_queue']);
  app.post('/api/org/:id/items/:code/actions', requireOrg('staff'), wrap(async (req) => {
    const item = orgItem(req);
    const action = req.body?.action;
    const isOwner = rank(req._org.role) >= rank('owner');
    if (!STAFF_ACTIONS.has(action) && !(isOwner && OWNER_ACTIONS.has(action)))
      throw httpError(isOwner ? 400 : 403, isOwner ? 'unknown action' : 'that action needs the owner rung');
    const updated = await itemsApi.action(item.code, action, req.body || {});   // body carries songId/byId for 'remove'
    await audit(req._org.actor.id, req._org.org.id, item.code, 'action.' + action, null, req.body?.songId || req.body?.on || '');
    return itemsApi.orgView(updated);
  }));

  // Owner invites/removes STAFF only. Tech + owner grants are rung-0 (above).
  app.post('/api/org/:id/invites', requireOrg('owner'), wrap(async (req) => {
    const email = String(req.body?.email || '').trim().toLowerCase();
    const orgRole = req.body?.orgRole || 'staff';
    if (orgRole !== 'staff') throw httpError(403, 'only the platform operator grants tech or owner');
    // addMember is an UPSERT — without this an owner could invite the email of a
    // platform-granted tech or co-owner and silently DEMOTE them to staff (then
    // the staff-only remove route would evict them). Only rung 0 touches a
    // higher rung; an owner may only (re)invite a brand-new or existing-staff email.
    const cur = memberRole({ email }, req._org.org.id);
    if (cur && cur !== 'staff') throw httpError(403, 'that email already holds a higher rung — only the platform operator changes it');
    const m = await store.addMember({ orgId: req._org.org.id, email, orgRole: 'staff', invitedBy: req._org.actor.id });
    setMember(req._org.org.id, email, 'staff');
    await audit(req._org.actor.id, req._org.org.id, null, 'invite.staff', null, email);
    return m;
  }, 201));

  app.delete('/api/org/:id/members/:email', requireOrg('owner'), wrap(async (req) => {
    const email = String(req.params.email).trim().toLowerCase();
    const cur = memberRole({ email }, req._org.org.id);
    // An owner may only remove STAFF — never another owner or a tech (rung 0's job).
    if (cur && cur !== 'staff') throw httpError(403, 'only the platform operator removes owners or tech');
    await store.removeMember(req._org.org.id, email);
    dropMember(req._org.org.id, email);
    await audit(req._org.actor.id, req._org.org.id, null, 'remove.staff', email, null);
    return { ok: true };
  }));

  app.get('/api/org/:id/audit', requireOrg('owner'), wrap(async (req) => {
    return store.listAudit({ orgId: req._org.org.id, limit: +req.query.limit || 200 });
  }));

  // Tech: rotate this org's item rig keys + edit its output chain. Reuses the
  // items output internals, re-gated to the org's tech rung.
  app.post('/api/org/:id/items/:code/rig-key', requireTech(), wrap(async (req) => {
    const item = orgItem(req);
    const name = String(req.body?.name || '').trim();
    const result = await itemsApi.rotateRigKey(item.code, name);   // { rigKey, item }
    await audit(req._org.actor.id, req._org.org.id, item.code, 'rig-key.rotate', name, '(rotated)');
    return { rigKey: result.rigKey, item: itemsApi.orgView(result.item) };
  }, 201));

  app.post('/api/org/:id/items/:code/outputs', requireTech(), wrap(async (req) => {
    const item = orgItem(req);
    const result = await itemsApi.outputsCreate(item.code, req.body || {});
    await audit(req._org.actor.id, req._org.org.id, item.code, 'output.add', null, req.body?.name || '');
    return { ...(result.rigKey ? { rigKey: result.rigKey } : {}), item: itemsApi.orgView(result.item) };
  }, 201));

  app.patch('/api/org/:id/items/:code/outputs/:name', requireTech(), wrap(async (req) => {
    const item = orgItem(req);
    const updated = await itemsApi.outputsPatch(item.code, req.params.name, req.body || {});
    await audit(req._org.actor.id, req._org.org.id, item.code, 'output.edit', req.params.name, JSON.stringify(req.body || {}));
    return itemsApi.orgView(updated);
  }));

  app.delete('/api/org/:id/items/:code/outputs/:name', requireTech(), wrap(async (req) => {
    const item = orgItem(req);
    const updated = await itemsApi.outputsDelete(item.code, req.params.name);
    await audit(req._org.actor.id, req._org.org.id, item.code, 'output.remove', req.params.name, null);
    return itemsApi.orgView(updated);
  }));

  return {
    roleOf,
    wireItems(api){ itemsApi = api; },
    reloadMirror,
    __test: { mirror, suspended, roleOf, memberRole, setMember, dropMember, reloadMirror },
  };
}

/* ── small helpers ── */
function intOrThrow(v, name){
  if (typeof v !== 'number' || !Number.isInteger(v)) throw httpError(400, `${name} must be an integer`);
  return v;
}
function deepClone(o){ return o == null ? o : JSON.parse(JSON.stringify(o)); }
// Structural equality for the jukebox no-op-audit guards (small config blobs;
// JSON stringify is fine — keys come from the store's normalized shape, order-
// stable, no functions/undefined).
function deepEqual(a, b){ return JSON.stringify(a) === JSON.stringify(b); }
// Route wrapper: run an async handler, JSON its result (default 200 / custom),
// funnel throws to the shared error middleware. Mirrors the repo's try/next idiom.
function wrap(handler, status = 200){
  return async (req, res, next) => {
    try { const out = await handler(req, res); if (!res._sent && !res.headersSent) res.status(status).json(out); }
    catch (e){ next(e); }
  };
}

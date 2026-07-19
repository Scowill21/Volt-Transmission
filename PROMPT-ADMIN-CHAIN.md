# Build prompt — Volt Control: the admin chain (orgs, delegated roles, scoped ops)

**Paste this whole file into a fresh Claude session in `~/td-stream-control`.**

> Read `HANDOFF.md`, then `CLAUDE.md` (binding), then `PROMPT-CONTROL-SPLIT.md`
> §2 (the fact-checked map of shipped Volt Control), then `VOLT-RECIPE-BOOK.html`
> §J (the owner-approved design this mission implements). **Sequencing: run
> AFTER `PROMPT-OUTPUTS-REDUNDANCY.md`** (rig keys, presence, rotation exist)
> — jukebox is optional but if it shipped, its admin knobs join the owner
> whitelist below. Grep, don't assume: verify what actually landed before
> building on it. **This mission requires DATABASE_URL** (it extends the
> Tier-2a accounts machinery); everything must degrade gracefully without it.

---

## 1. The mission

Today the ops side is single-operator: one `ADMIN_KEY`, one `control-ops.html`
that sees every item. That doesn't scale to the business model (playbook §7:
venues get a scoped dashboard). Build the **admin chain** — a delegation
ladder where each rung only reaches DOWN, enforced server-side on every
request, never in the page.

Owner's intent, verbatim requirements to honor:

- Businesses must be able to **adjust their own product**: pricing, slot
  length, open hours, pause/off, **controller layout**, jukebox rules +
  catalog — without calling the operator.
- Some venues have **experienced technical staff** who may go deeper (rig
  keys, output chains, controller maps) — but only when the platform owner
  grants it, per venue.
- The platform owner keeps **admin access to every project** from the one
  fleet dashboard he already has. Nothing a business does can lock him out
  or leak sideways into another business.
- Safety and money have **floors and bands the business cannot cross**:
  they can make an item rest MORE, never less; price inside a band, never
  outside it.

## 2. The ladder (the permission model — implement exactly this)

| Rung | Who | Can | Can never |
| --- | --- | --- | --- |
| 0 · Platform | `X-Admin-Key` (+ platform `admin` role) | create orgs/items/rigs · set bands + floors · grant `tech` · all orgs, audit, payouts | — |
| 1 · Org owner | business principal | edit whitelisted item fields within bounds · pause/off · layout picker · jukebox rules/catalog · org revenue/plays view · invite `staff` · view org audit | create/delete items · touch rig keys · loosen any floor · see other orgs · grant `tech` |
| 2 · Org staff | bartender / floor | pause, skip, force-skip · watch queues | any money/config field |
| 2b · Org tech | their AV person | rotate that org's rig keys · edit output chains · controller maps | other orgs · item create/delete · bands/floors |
| 3 · Rig key | a machine | report truth · receive commands (unchanged from outputs mission) | drive anything |
| 4 · Slot holder | paying patron | gated pad/btn actions while the clock runs (unchanged) | everything else |

Org roles are a **new axis, orthogonal to platform roles** (`listener/vj/
radio/admin` on profiles — verify `APPLY_ROLES` in `server/auth.js`). A vj
is not thereby an org owner; an org owner gets no radio-console powers.
Don't conflate the axes anywhere.

## 3. What exists that you build on (verify by grep)

- `server/auth.js` — Supabase Auth, httpOnly cookie sessions, `profiles`
  row per user (`user_id, email, name, role, applied_role`),
  `userFromRequest(req)`, `ensureProfile(user)`, `mountAuth(app,
  requireAdmin)`, application/approval flow.
- `server/index.js` — `requireAdmin = makeRequireAdmin(ADMIN_KEY)`;
  `server/security.js` makes it constant-time, lockout-protected, and
  FAIL-CLOSED (503) on misconfigured prod. The key stays the platform rung;
  org roles never substitute for it.
- `server/bus.js` gate REGISTRY — paid.js gates the radio rooms, items.js
  owns `item:` rooms; `item`/`item_queues`/`jukebox` RESERVED; RIG_REPORT
  server-consumed. **CLAUDE.md security rule (binding): never re-open a
  control-plane type to anonymous senders.**
- `server/store.js` — durable tables with JSON-file fallback; items pattern
  (`items` table / `server/items.json`).
- `control-ops.html` + `.smoke-ops.cjs` — the standalone ops dashboard and
  its gate assertions. NINE smokes are green; keep them green.

## 4. Data model (durable, store.js — additive, migration-safe)

- `orgs`: `id, name, slug, status('active'|'suspended'), createdAt`.
- `org_members`: `orgId, userId?, email(lowercased), orgRole('owner'|'staff'|'tech'),
  invitedBy, at` — unique on (orgId, email). Invites are rows with `email`
  only; `ensureProfile` links `userId` on first sign-in by email match.
- `items` gain `orgId` (nullable). **Null = platform-owned legacy item;
  everything behaves exactly as today — back-compat is a smoke check.**
- `items` gain `bounds` (platform-set, key-only): `priceBandCents{min,max}`,
  `slotSecondsMax`, `cooldownFloorMs`, `maxPerMinCap` — plus an explicit
  `ownerEditable` whitelist derived in code (below), never stored per item.
- `audit_log`: `id, orgId, actorUserId|'admin-key', itemCode?, field, old,
  new, at`. Append-only: no update/delete path exists, not even key-gated.

No DATABASE_URL → org/audit endpoints 503 with a clear error; the rest of
the platform (items, paid, jukebox, single-operator ops) runs untouched.
DATABASE_URL set but DB down → fail closed like everything else
(`.smoke-failclosed` extends to org routes).

## 5. AuthZ core — new `server/orgs.js`, mounted like paid/items

- `orgRoleOf(user, orgId)` — resolved fresh per request from `org_members`.
  **No caching of org roles in sessions**: offboarding must bite on the
  very next request.
- `requireOrg(minRole)` middleware factory; ladder order
  `staff < tech < owner`. `X-Admin-Key` (via existing `requireAdmin`
  semantics) bypasses org checks everywhere — never the reverse.
- **Field whitelist, per rung** (single source of truth, one exported map):
  - owner: `priceCents` (within band) · `slotSeconds` (≤ max) · `hours` ·
    `status` pause/off/on · `controller` (dpad/joystick/faders/grid) ·
    `jukebox.*` rules/catalog knobs (if jukebox shipped; still bounded:
    `skip.minPlaySec` has a floor too) · `cooldownMs`/`maxPerMin`
    (tighten-only: ≥ floor / ≤ cap).
  - staff: no fields — actions only (pause/resume/skip/force-skip).
  - tech: rig-key rotation, output-chain edits, controller maps — reusing
    the outputs-mission endpoints, re-gated `tech-or-key`.
- **Bounds enforcement is reject, not clamp**: out-of-band PATCH → 400
  with the band in the message, nothing written. Silent clamping teaches
  owners wrong numbers.
- Every successful org write → one audit row (old → new). Reads are never
  audited.
- Grants: owner may invite/remove `staff`; **only rung 0 grants or revokes
  `tech` and `owner`**. Removing a member deletes the row; their next
  request 403s.

## 6. Bus + gate (smallest possible touch)

No new bus message types. No wire schema changes (SETUP.md stays true —
state that explicitly in HANDOFF). Staff/owner actions arrive over HTTP
endpoints that call the same internals items.js already uses for
admin-key actions (pause/skip/force-skip). Inside `item:` room gates,
where items.js checks "privileged?", extend privileged to "admin-key OR
org member ≥ staff **of the item's org**" — resolved server-side from the
verified session, per message, per the existing pattern. Cross-org
privilege must be impossible by construction: the check starts from the
item's `orgId`, never from the user's org list.

## 7. Ops UI — one dashboard, two lenses (`control-ops.html`)

- **Key lens (unchanged + grows):** full fleet, plus an Orgs panel —
  create org · assign/unassign items by code · set bands/floors · grant
  tech/owner · view any org's audit trail.
- **Session lens (new):** a signed-in org member GETs `/api/org/mine`,
  page renders ONLY their org's items with the knobs their rung allows
  (owner sees sliders bounded by the band — render the band, don't hide
  it; staff sees action buttons; tech sees rig/chain cards). Plays-per-item
  view now; revenue joins at Tier 2b (leave the `STRIPE:` seam comment).
- The page ships zero admin secrets to session users (no key prompts, no
  key-gated fetch paths taken); `.smoke-ops.cjs` grows assertions for it.
- Everything the UI hides, the server refuses anyway — the smoke tests
  prove the server side, not the hiding.

## 8. API additions (conventions: JSON, `httpError`, `guard`, `next(e)`)

Key-gated (rung 0): `POST /api/admin/orgs` · `PATCH /api/admin/orgs/:id`
(rename/suspend) · `POST /api/admin/orgs/:id/items {code}` /
`DELETE …/items/:code` (assign/unassign) · `PATCH /api/admin/items/:code/bounds` ·
`POST /api/admin/orgs/:id/grants {email, orgRole}` (tech/owner) ·
`GET /api/admin/audit?orgId=`.

Session-gated: `GET /api/org/mine` · `GET /api/org/:id/items` (requireOrg
staff) · `PATCH /api/org/:id/items/:code` (owner; whitelist+bounds+audit) ·
`POST /api/org/:id/items/:code/actions {action}` (staff) ·
`POST /api/org/:id/invites {email}` / `DELETE /api/org/:id/members/:email`
(owner, staff-rung members only) · `GET /api/org/:id/audit` (owner) ·
`POST /api/org/:id/items/:code/rig-key` (tech).

## 9. Security invariants (extend, never weaken)

- Fail-closed inheritance: DB down → no org reads, no org writes, no
  takeovers. Constant-time admin key, lockout, WS origin checks, headers —
  all untouched.
- An org role can NEVER: create/delete items, edit bounds, read another
  org, loosen a floor, mint rig keys for another org, or inject bus types
  directly (HTTP endpoints only; the socket gate still sees them as
  ordinary users unless the item-org check passes).
- Audit log is append-only in code and in schema (no route deletes it).
- Rig keys stay shown-once; rotation invalidates the old key atomically.
- The Tier-2a approval flow is untouched — org membership is granted
  through the endpoints above, not through `applied_role`.

## 10. Tests — new `.smoke-orgs.cjs` + extend the suite (all TEN green)

Hermetic, in-process, store on the JSON/pg-mock path like `.smoke-items.cjs`:

1. Legacy item (`orgId` null): every existing behavior identical (run a
   slice of the items matrix against it).
2. Owner PATCH inside band → 200, value applied, audit row (old→new).
3. Owner PATCH outside band / below floor → 400, nothing written, no audit.
4. Staff can pause/skip; staff PATCH of `priceCents` → 403.
5. Tech rotates rig key; owner attempting it → 403; old key dead after.
6. Cross-org: member of org A on org B's item → 403 on every endpoint AND
   the bus gate refuses their "privileged" pause.
7. Offboard: delete membership → next request 403 (no session cache).
8. Tech grant via owner → 403; via key → 200.
9. No DATABASE_URL → org endpoints 503, whole rest of suite unaffected.
10. Extend `.smoke-failclosed.cjs`: env set + DB down → org bids/PATCHes 401/503, never a write.
11. Extend `.smoke-ops.cjs`: session lens renders only own-org items; no
    admin-key code path reachable; band shown on owner sliders.
12. Extend `.smoke-security.cjs`: forged org claims in payloads ignored
    (identity comes from the verified session only — same rule that closed
    the payload-identity hatch).

## 11. Ship checklist + open questions

- [ ] `npm start` clean with and without DATABASE_URL; all TEN smokes green.
- [ ] `HANDOFF.md`: state, landmines (org axis ⊥ platform roles; `orgId`
      null = legacy; bounds reject-not-clamp; no wire changes).
- [ ] `MANAGE.md`: the onboarding runbook — install day: create org →
      assign items → set bands → invite owner email → they invite staff →
      tech only if earned; offboarding + key/rig-key rotation steps.
- [ ] `SETUP.md`: note explicitly that the TD/bus wire schema did NOT change.
- [ ] `ROADMAP.md`: tick the tier; Stripe Connect (per-org payouts) stays
      the Tier-2b follow-up — leave seams, build nothing.
- Open questions for the owner, listed in HANDOFF, not solved in code:
  self-serve item creation as a paid "pro" unlock? per-org fleet map page?
  audit retention window? invite emails (Supabase magic link vs. plain
  "sign up with this email" instructions)?

*The spirit, from CLAUDE.md and the book's §J: the UI hiding a button is a
courtesy — the bus check is the law. Every rung tightens, nothing loosens,
and the couch keeps the whole fleet.*

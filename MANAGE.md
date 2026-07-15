# Managing Volt Transmission

The operator's hub: **what to do next** (to-do list) and **how to run it**
(runbook). Everything here links to a deeper doc rather than repeating it.

**Production:** https://td-stream-control.onrender.com · **Repo:**
`Scowill21/Volt-Transmission` (push `main` → Render auto-deploys).

### The docs and what each is for
| Doc | Use it for |
| --- | --- |
| **MANAGE.md** (this) | To-do list + day-to-day runbook |
| `SETUP.md` | Operator guide: TD connection, adding songs, message schema, paid test tier |
| `PAYMENTS-SETUP.md` | Full Supabase + Stripe (Tier 2b) + admin playbook — canonical |
| `ARCHITECTURE.md` | "Do I need a backend?" one-pager (Render vs Supabase vs server) |
| `ROADMAP.md` | The tiered build plan (what's shipped, what's next) |
| `CLAUDE.md` | Rules + test commands (read before editing) |

---

## ✅ To-do list

### 🔴 Now — unblock local dev + close security gaps
- [ ] **Local DB:** in `~/td-stream-control/.env`, set `DATABASE_URL` port to
      `:6543` (transaction pooler). Verify with the command in *Runbook →
      Monitoring* until it prints `CONNECTED ✓`. *(The password is correct — a
      timeout is the port, not the password.)*
- [ ] **Rotate the DB password** — it was pasted in chat months ago. Supabase →
      Settings → Database → reset password → update the string in **both** local
      `.env` and the **Render** Environment tab. Redeploy; confirm prod
      `/healthz` + a bid still work.
- [ ] **Supabase settings:** Authentication → Providers → Email → **"Confirm
      email" OFF** (until real SMTP). Confirm the 3 env vars are set in Render.
- [ ] **Delete test users:** Supabase → Authentication → Users → remove
      `volttest23980@gmail.com`, `volt-ada-23122@gmail.com`.
- [ ] **Docs housekeeping:** two payment docs exist — `PAYMENTS-SETUP.md`
      (committed, complete) and `SETUP-PAYMENTS.md` (untracked, partial, from
      another session). Keep one, delete the other so there's a single source.

### 🟡 Soon — turn on real payments (ROADMAP Tier 2b)
Follow `PAYMENTS-SETUP.md` §2–§3. In order:
- [ ] Create a Stripe account; grab **test** keys (`sk_test_…`). `npm i stripe`
      (commit `package.json` + `package-lock.json` — remember the `ws` lesson).
- [ ] Set `STRIPE_SECRET_KEY` + `STRIPE_WEBHOOK_SECRET` in `.env` and Render.
- [ ] Code the seams in `server/paid.js`: Checkout session per bid → webhook
      does the enqueue → persist queues to a `paid_events` Postgres table →
      refunds. *(Hand me the test key and I'll build this against the seams.)*
- [ ] Same pass for the **shop** (`server/shop.js`): stubPay → Checkout, move
      `.shop-data.json` purchases into Postgres (Render wipes the file per
      deploy), gate real album downloads/streams on the paid webhook.
- [ ] Extend `.smoke-server.cjs` to cover the webhook enqueue path.
- [ ] End-to-end test: Stripe CLI (`stripe listen --forward-to …/api/stripe/webhook`)
      + card `4242 4242 4242 4242`; verify enqueue + refund + idempotency.
- [ ] Wire the admin **Refund** / **End slot** buttons to real Stripe refunds.
- [ ] Go live: swap to `sk_live_…`, register a **live** webhook at the prod URL,
      set the new `whsec_…` in Render.

### 🟢 Later — roadmap + polish
- [ ] Tier 3b: LiveKit (video channels, host cam, browser-mic publishing).
- [ ] Tier 4 open items: pooled FX from other viewers' keys; account-tied rate limits.
- [ ] Tier 5: VJ mesh (approved VJs publish video into the channel room).
- [ ] ⚠️ **Legal:** get advice on music licensing before charging around specific
      tracks (ROADMAP Tier 6).

---

## 📖 Runbook — how to manage it

### Deploying
- **Push `main` → Render auto-deploys.** No manual step.
- **Always run the 3 test suites before pushing** (see *Testing*).
- **Verify a deploy:** wait ~1 min, then
  `curl -s https://td-stream-control.onrender.com/healthz` → `{"ok":true}`, and
  spot-check a real endpoint (e.g. `…/api/channels`).

### Admin tasks — `/admin.html` (needs the `ADMIN_KEY`)
- **Channels / VJs:** create channels (name, slug, default scene), attach
  scene/stream VJs.
- **Applications:** approve or decline VJ / radio role requests (approve flips
  the account's role).
- **Paid queues:** per channel — mark song requests **Played** / **Refund**, and
  **End control slot** to cut a takeover short. *(After Tier 2b, Refund/End also
  issue the Stripe refund.)*

### Volt Control items — `/control` → ⚙ gear (same admin key)
- **Create an item:** name, buy-now or auction, price, slot seconds → the
  6-char code appears with its QR. **Print** gives a poster-ready sheet
  (big QR + name + code); tape it to the physical thing.
- **Event day, one-handed:** each item card has **Skip** (end the current
  slot), **Pause/Resume** (freezes the holder's remaining time + their
  controls), **Off/On** (off = not sellable, controller dead — pause first
  if someone is mid-slot so they don't burn paid time), **Edit**, **Delete**.
- Wire TouchDesigner to the item's bus room first (SETUP.md → "Volt Control")
  and test with the HTTP inject before doors open.
- Queues/auctions are in-memory at this tier — a deploy or restart clears
  them (item definitions survive; they're in the database).

### Testing — run before every push
```bash
node .smoke-test.cjs        # client: every console path (jsdom)
node .smoke-server.cjs      # server: the paid permission gate
node .smoke-failclosed.cjs  # server: fail-closed on a DB outage
node .smoke-items.cjs       # server: Volt Control items product
node .smoke-control.cjs     # client: the /control page (jsdom)
```
All five must print `ALL CLEAR`. Extend them when you add features (it's a rule
in `CLAUDE.md`).

### Monitoring & health
- **Production health:** `curl …/healthz`. Bidding 401s in prod = the DB is
  unreachable and the app is failing closed (check `DATABASE_URL`/Render), not a
  bug.
- **Local DB check:**
  ```bash
  node --env-file=.env -e "import('pg').then(async({default:pg})=>{const p=new pg.Pool({connectionString:process.env.DATABASE_URL,ssl:{rejectUnauthorized:false},connectionTimeoutMillis:8000});try{const r=await p.query('select current_user');console.log('CONNECTED ✓',r.rows[0].current_user)}catch(e){console.log('FAILED ✗',e.message)}await p.end()})"
  ```
- **Render → Logs:** the boot lines tell you the state — `[store] json file …`
  (DB down, JSON fallback) vs Postgres connected; `[auth] supabase configured`
  vs `not configured`.
- **Supabase dashboard:** tables, Auth users, DB status/pausing.
- **Stripe dashboard** (once live): the payments ledger, disputes, payouts —
  don't rebuild this; filter by the `metadata.channel` set at checkout.

### Secrets
- **Local:** `.env` (gitignored) — `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`,
  `DATABASE_URL`, `ADMIN_KEY` (+ `STRIPE_*` after 2b). Keep `ADMIN_KEY=dev` local.
- **Render:** Environment tab — the `sync:false` vars are set by hand;
  `ADMIN_KEY` is auto-generated.
- **Never commit `.env`.** Rotate anything that lands in a chat or a screenshot.

### Rotating the DB password
The original went through a chat, so rotate it. A reset takes effect
**immediately**, so line up Render first to keep the prod window tiny — and
while it's down the app just **fails closed** (401s), never exposes anything.

> ⚠️ The new password must go straight into your password manager and the two
> config spots below — **never paste it into a chat** (that would re-expose it).
> Only `DATABASE_URL`'s password changes; `SUPABASE_URL` / publishable key don't.

1. **Open both tabs first**, at a quiet time: Supabase → **Settings → Database**,
   and Render → the service → **Environment**.
2. **Reset:** Supabase → Settings → Database → **Reset database password** →
   generate a strong one. Then **Connect → pooler** → copy the new connection
   string. Save it in your password manager.
3. **Render (immediately):** edit `DATABASE_URL` → paste the new string (Render
   works on `:5432`) → **Save** (auto-redeploys). After ~1 min confirm
   `curl …/healthz` = `{"ok":true}` and a real bid works.
4. **Local `.env`:** open it in an editor (not `echo`, not chat) and swap the
   password in `DATABASE_URL`, keeping port **`:6543`**. Verify with the
   `CONNECTED ✓` command above.
5. Done — the old password is dead, so its copies in old chat logs are inert.

### Troubleshooting
| Symptom | Cause → fix |
| --- | --- |
| Local DB "connection timeout" | Wrong pooler port → use `:6543` (transaction). Not the password. |
| Render deploy failed | Render → Logs. Usually a missing dep — commit `package.json` + `package-lock.json` (the `ws` incident). |
| Prod bidding returns 401 | DB unreachable → app fails closed. Check `DATABASE_URL` in Render. |
| New sign-ups can't log in | Supabase "Confirm email" is ON → turn it OFF (no SMTP yet). |
| Paid features "off" locally | `.env` Supabase set but DB down → fails closed. Fix `DATABASE_URL` (`:6543`). |

---
*When you're ready for the 🟡 payments block, drop your Stripe **test** secret key
in `.env` and I'll implement the Checkout + webhook + Postgres persistence +
admin refunds against the seams, with tests.*

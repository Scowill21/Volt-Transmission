# Going Live: Supabase + Stripe + Admin

A setup playbook for turning the **paid test tier** (control-takeover queue +
song requests, payment currently stubbed) into real money. Follow it top to
bottom when you're ready — nothing here is required for the free features.

Legend: **[dashboard]** = click-ops in a web console · **[env]** = a variable to
set · **[code]** = code that still needs writing (I can do these when you have
test keys — this is the parked ROADMAP "Tier 2b").

---

## 0. Fix your local DB connection first (1-character fix)

Your `.env` credentials are **correct** — I tested them. The problem is the
**port**: your Mac's network can reach Supabase's *transaction* pooler but not
the *session* pooler.

| Port | Pooler | From your Mac |
| --- | --- | --- |
| `5432` | session | ✗ times out |
| `6543` | transaction | ✓ **connects** (same username + password) |

**Fix:** in `~/td-stream-control/.env`, change the `DATABASE_URL` port from
`:5432` to `:6543`:

```
postgresql://postgres.xyhqahemxcknyvxlrmhe:PASSWORD@aws-1-us-west-2.pooler.supabase.com:6543/postgres
```

Then re-run the verify command in §1.3 — it should print `CONNECTED ✓`.

> The transaction pooler is the right pick for this app anyway (Supabase
> recommends it for app/serverless connections). This app only runs plain
> parameterized queries + `CREATE TABLE IF NOT EXISTS`, all of which work fine
> in transaction mode — no session-pinned features (LISTEN/NOTIFY, session
> advisory locks) are used. Production already works, so leave Render as-is
> unless it ever shows the same timeout, in which case switch Render's
> `DATABASE_URL` to `:6543` too.

---

## 1. Supabase checklist

**There's no SQL to run.** The server creates its own tables (`channels`,
`vj_profiles`, `channel_vjs`, `profiles`) on boot. Supabase just needs to be
reachable + configured — two dashboard settings and four env vars in two places.

### 1.1 In the Supabase dashboard

- **[dashboard]** Authentication → Providers → Email → **turn "Confirm email"
  OFF** (until you wire real SMTP). With it on, new sign-ups never get a session
  and accounts/bidding break.
- **[dashboard]** **Connect** button (top bar) → **"Transaction pooler"** → copy
  that URI. Use the pooler, **not** the direct `db.<ref>` connection — the direct
  host is IPv6-only and won't resolve from Render or most home networks. Yours:

  ```
  postgresql://postgres.xyhqahemxcknyvxlrmhe:PASSWORD@aws-1-us-west-2.pooler.supabase.com:6543/postgres
  ```

  Only the password differs from what's shown. If it has special characters
  (`!`, `@`, `#`…), URL-encode them (`!` → `%21`, `@` → `%40`).

### 1.2 The four env vars — same values in BOTH places

| Var | Value | Where it comes from |
| --- | --- | --- |
| `SUPABASE_URL` | `https://xyhqahemxcknyvxlrmhe.supabase.co` | Project URL |
| `SUPABASE_PUBLISHABLE_KEY` | `sb_publishable_…` | Settings → API → publishable key |
| `DATABASE_URL` | the transaction-pooler URI above | Connect → Transaction pooler |
| `ADMIN_KEY` | any strong secret (protects `/admin.html`) | you choose |

- **[env] Place 1 — local `~/td-stream-control/.env`** (gitignored): the fixed
  `DATABASE_URL`. Keep `ADMIN_KEY=dev` locally.
- **[env] Place 2 — Render → your service → Environment**: `DATABASE_URL`,
  `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY` are `sync: false` in `render.yaml`,
  so set them by hand. `ADMIN_KEY` is auto-generated (leave it). Production is
  already working — only touch Render if you rotate the password there.

### 1.3 Verify (locally)

```bash
cd ~/td-stream-control
node --env-file=.env -e "import('pg').then(async({default:pg})=>{const p=new pg.Pool({connectionString:process.env.DATABASE_URL,ssl:{rejectUnauthorized:false},connectionTimeoutMillis:8000});try{const r=await p.query('select current_user');console.log('CONNECTED ✓',r.rows[0].current_user)}catch(e){console.log('FAILED ✗',e.message)}await p.end()})"
```

- **`CONNECTED ✓`** → `npm start`; the boot log shows `[auth] supabase
  configured` and paid bidding works locally with real sign-in.
- **`FAILED ✗ … timeout`** → you're still on `:5432` (see §0) or the password is
  wrong. A *wrong password* says `password authentication failed` (not timeout).

> **Security note (already shipped):** if Supabase env is set but the DB can't
> connect, the app **fails closed** — accounts/bidding return `401` rather than
> trusting anyone. A bad `DATABASE_URL` = no paid features, never an open door.
> (Guarded by `.smoke-failclosed.cjs`.)

---

## 2. Stripe — turn the stub into real payments (Tier 2b)

**What's stubbed today:** every "bid"/"request" calls `stubPay()` in
`server/paid.js` and succeeds instantly. The enqueue happens right in the
request handler. Real payments are async, so the shape changes:

```
   TODAY (stub):   click → server enqueues immediately → broadcast
   WITH STRIPE:    click → server creates a Checkout Session → user pays on
                   Stripe's page → Stripe webhook fires → server enqueues →
                   broadcast → user redirected back
```

Two consequences that drive the work:
1. **Enqueue moves out of the request handler and into the webhook** (you only
   add to the queue once money actually clears).
2. **Queues must persist to Postgres** — a Checkout can complete minutes later,
   possibly on a different server instance, and you need the Stripe
   `payment_intent` on record so refunds work. (Today they're in-memory.)

### 2.1 Stripe account + keys **[dashboard]**

1. Create a Stripe account; stay in **Test mode** (toggle, top-right) until
   you've run the full flow.
2. Developers → API keys → copy the **Secret key** (`sk_test_…`).
3. The webhook signing secret (`whsec_…`) comes in §2.5.

### 2.2 Env vars to add **[env]** (local `.env` and Render)

| Var | Value |
| --- | --- |
| `STRIPE_SECRET_KEY` | `sk_test_…` (then `sk_live_…` for production) |
| `STRIPE_WEBHOOK_SECRET` | `whsec_…` (from §2.5) |

You do **not** need a publishable key on the client — Checkout is a hosted
redirect, so no card fields touch your site.

### 2.3 Dependency **[code]**

```bash
npm i stripe        # commit package.json + package-lock.json (see the ws lesson)
```

### 2.4 Create a Checkout Session at each seam **[code]**

In `server/paid.js`, replace the two `stubPay(...)` calls (the `// STRIPE:
Checkout here` seams) with a Checkout Session and return its URL instead of
enqueuing. Sketch:

```js
import Stripe from 'stripe';
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

// inside POST /control/request, after `who` is resolved and validated:
const origin = req.get('origin') || `https://${req.get('host')}`;
const session = await stripe.checkout.sessions.create({
  mode: 'payment',
  line_items: [{
    quantity: 1,
    price_data: {
      currency: 'usd',
      product_data: { name: `Control slot · ${minutes} min` },
      unit_amount: PAID.controlCents,          // price still lives in PAID
    },
  }],
  success_url: `${origin}/?paid=control`,
  cancel_url:  `${origin}/?paycancel=1`,
  metadata: { kind: 'control', channel: req.params.id, userId: who.id, name: who.name, minutes: String(minutes) },
});
return res.status(200).json({ checkoutUrl: session.url });   // client redirects here
```

(The song seam is identical with `kind:'song'` + the `title` in metadata and
`PAID.songCents`.) **Client change** in `index.html` `qPost()`: if the response
carries `checkoutUrl`, do `location.href = d.checkoutUrl` instead of
`applyQueues(d)`.

### 2.5 The webhook — where the enqueue actually happens **[code]**

Stripe signature verification needs the **raw** request body, but `server/index.js:55`
already parses JSON globally. Minimal fix — capture the raw bytes in that same
line:

```js
app.use(express.json({ limit: '32kb', verify: (req, _res, buf) => { req.rawBody = buf; } }));
```

Then add the webhook route (before the static handler at index.js:121):

```js
app.post('/api/stripe/webhook', (req, res) => {
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.rawBody, req.get('stripe-signature'), process.env.STRIPE_WEBHOOK_SECRET);
  } catch (e) { return res.status(400).send(`Webhook Error: ${e.message}`); }

  if (event.type === 'checkout.session.completed') {
    const s = event.data.object, m = s.metadata || {};
    // idempotency: ignore if s.id already recorded (webhooks can retry)
    if (m.kind === 'control') enqueueControl(m.channel, { id: m.userId, name: m.name }, +m.minutes, s.payment_intent, s.id);
    else if (m.kind === 'song') enqueueSong(m.channel, m.title, { id: m.userId, name: m.name }, s.payment_intent, s.id);
    // enqueue* = the current c.queue.push / c.songs.push logic + broadcast(),
    // now storing s.payment_intent so refunds work, keyed by s.id for idempotency.
  }
  res.json({ received: true });
});
```

Local testing with the **Stripe CLI**:

```bash
stripe login
stripe listen --forward-to localhost:8787/api/stripe/webhook   # prints your whsec_… → put in .env
# in another terminal, drive a real test payment with card 4242 4242 4242 4242
```

### 2.6 Persist the queues to Postgres **[code]**

Add a table (same pattern as `initAuth()` in `server/auth.js:80`) so paid state
survives restarts and refunds can find the payment:

```sql
CREATE TABLE IF NOT EXISTS paid_events (
  id             TEXT PRIMARY KEY,       -- stripe checkout session id (idempotency)
  channel        TEXT NOT NULL,
  kind           TEXT NOT NULL,          -- 'control' | 'song'
  user_id        TEXT NOT NULL,
  name           TEXT,
  cents          INT  NOT NULL,
  minutes        REAL,                   -- control slots
  title          TEXT,                   -- song requests
  payment_intent TEXT,                   -- needed for refunds
  status         TEXT NOT NULL,          -- queued | active | played | refunded
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

The in-memory `state` Map becomes a thin cache/read-model over this table; the
active-slot countdown timer can stay in memory.

### 2.7 Refunds at the three refund seams **[code]**

Wire the existing `// STRIPE: refund here` seams (cancel, admin refund, early
skip) to:

```js
await stripe.refunds.create({ payment_intent: record.payment_intent });
```

- **cancel** (leave the queue before your slot): full refund.
- **admin Refund** (song request): full refund.
- **admin End slot** (`control/skip` on an active paid holder): decide
  full/partial/credit — the seam comment flags this at `paid.js:212`.

---

## 3. Manage it from the admin side

`/admin.html` already has a **Paid queues** section (channel picker → control
status, song list with **Played** / **Refund**, and **End control slot**). Once
Stripe is live, extend it:

- **[code]** Wire the existing **Refund** / **End slot** buttons to the Stripe
  refund calls in §2.7 — the buttons already exist; they just need the server
  side to actually refund instead of only flipping status.
- **[code]** Show **amount + payment status** per row (e.g. `$5 · paid`,
  `refunded`) by returning `cents`/`status` from `GET /queues` (already carries
  `cents` server-side — surface it in the admin list).
- **[dashboard]** Use the **Stripe Dashboard** as the source of truth for the
  full ledger, disputes, and payouts — don't rebuild that. Payments →
  filter by the `metadata.channel` you set in §2.4.
- **[code] Pricing** lives in the `PAID` object (`server/paid.js:32`:
  `controlCents`, `controlMinutes`, `songCents`). To let yourself change prices
  without editing code, read them from env (`CONTROL_CENTS`, `SONG_CENTS`,
  `CONTROL_MINUTES`) with the current values as defaults, and set them in Render.
- **[dashboard]** Existing admin powers unrelated to money: create channels /
  attach VJs, and approve **VJ / radio applications** (Applications queue) — all
  behind `X-Admin-Key` (`ADMIN_KEY`).

---

## 4. Go-live checklist

- [ ] §0 local DB connects (`CONNECTED ✓`)
- [ ] §1 Supabase env set locally + on Render; "Confirm email" OFF
- [ ] §2 Stripe **test mode** end-to-end: bid → Checkout → card `4242…` → webhook
      enqueues → queue updates → refund works
- [ ] Idempotency verified (replay a webhook; no double-enqueue)
- [ ] `.smoke-server.cjs` extended to cover the webhook enqueue path
- [ ] Flip to **live** keys: `sk_live_…` + a **live** webhook endpoint registered
      at your production URL → new `whsec_…`; set `STRIPE_SECRET_KEY` +
      `STRIPE_WEBHOOK_SECRET` in Render
- [ ] ⚠️ **Legal:** charging around music (song requests) can carry licensing
      obligations — get advice before taking live payments tied to specific
      tracks (ROADMAP Tier 6).

---

*When you're ready to build §2/§3, hand me your Stripe **test** secret key (or
set `STRIPE_SECRET_KEY` in `.env`) and I'll implement the Checkout + webhook +
Postgres persistence + admin refunds against these exact seams, with test
coverage. Everything in this doc is designed so that work is additive — no
rewrite of what's already shipped.*

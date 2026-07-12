# Do I need a backend? (Render · Supabase · your server)

A one-page decision guide. Three different things, not either/or:

- **Render** = *where things run.* Hosts either a **Static Site** (just files) or a **Web Service** (a Node process = your backend).
- **Your backend** (`server.js` / Express) = *code you trust.* Needed only when something must be **secret** or **unfakeable** — the browser can't be trusted with either.
- **Supabase** = *your database + accounts (Auth).* Not hosting; the data layer.

## The one rule that decides everything

> The moment you have a **secret that can't reach the browser** (Stripe secret key, admin key) or a **rule a user must not be able to fake** (permissions, payments, who-holds-the-controls), you **must** have a real backend. Until then, you don't.

A static site's JavaScript is fully readable by anyone — it can't hide a key or verify a webhook.

## The three tiers

| You're building… | You need | Just Render? |
| --- | --- | --- |
| **Showcase / tool / visuals** — all in the browser, no accounts, no payments | Render **Static Site**. Nothing else. | ✅ free & simple |
| **Accounts + database, no secrets** | Render Static Site **+ Supabase called from the browser** (client SDK + Row-Level Security). No server you write. | ✅ Render hosts files; Supabase is DB/Auth |
| **Payments, webhooks, or server-enforced rules** | Render **Web Service** (your backend) **+ Supabase** (DB/Auth) | ✅ Render still hosts it — as a Web Service |

## How the pieces connect

```
                 ┌─────────── Render ───────────┐
  Browser  ◀────▶│  Static Site  (HTML/CSS/JS)   │      no accounts/secrets → stop here
                 └──────────────┬───────────────┘
                                │ needs accounts/DB but NO secrets
                                ▼
                        Supabase (Auth + Postgres)   ◀── called straight from the browser (RLS-guarded)
                                ▲
                                │ needs SECRETS or UNFAKEABLE rules (Stripe, permissions, webhooks)
                 ┌──────────────┴───────────────┐
  Browser  ◀────▶│  Web Service (your server.js) │────▶ Supabase (Postgres + Auth)
                 │   holds secret keys, verifies  │────▶ Stripe (secret key, webhook verify)
                 │   webhooks, enforces the rules │
                 └───────── Render ──────────────┘
```

## Verdict per project

- **Volt Transmission** — backend is **not optional.** Its whole point is server-authoritative: only the paid holder's keypresses pass, identity fails closed on a DB outage, the action bus. Browsers lie, so those must be enforced server-side. Already a Render **Web Service** + **Supabase** — correct, keep it.
- **Stripe (Tier 2b)** — needs the backend for the **webhook**: Stripe confirms payment by POSTing to *your server*, which verifies the signature with your secret key. Can't be done from a static site.
- **Key Change Lab** — its `server.js` (`/checkout`, `/stripe-webhook`) means the paywall/accounts need a Render **Web Service** to work. The static preview only serves the front-end.
- **Voltage Drop** — pure showcase → Render **Static Site alone.** No Supabase, no backend. The simplest of the set.

## The one real simplification

If you ever want to drop your own backend, the **middle tier** — Supabase-from-the-browser — gives accounts + database with no server to maintain (Supabase enforces access with Row-Level Security). **But it can't do payments securely** (nowhere to hide the Stripe secret key, no webhook verification). Anything touching money → back to needing the backend.

---
**Bottom line:** Render is always the host. *Also* needing Supabase + a backend is a function of the feature — showcase needs neither; accounts/payments/enforced-rules need both. For Volt Transmission, both are load-bearing and already set up right.

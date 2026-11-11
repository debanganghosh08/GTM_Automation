# GTM Autopilot

A self-serve outbound product for SparqLabs. A founder redeems a partner code, adds a card ($0 for 30 days), answers a questionnaire, and the system does the rest: GTM strategy, lead sourcing and verification, copy, domains and mailboxes, warm-up, campaign launch, and a results dashboard. Day 31 bills $2,000/month.

**1 credit = 1 email sent.** The launch offer is 30,000 credits plus a done-for-you strategy, free for the first month.

> **Status:** built overnight 2026-10-22 → 23 from `GTM_Autopilot_Build_Brief.pdf`. 364 tests pass, including a nine-step end-to-end run of the whole customer journey and a security suite. Hardened for launch on 2026-10-23; see `docs/SECURITY.md`. The vendor integrations are written against verified API docs but have not yet run against a live account — see [`docs/HANDOFF.md`](docs/HANDOFF.md).

## Quick start

```bash
cp .env.example .env.local     # works as-is: everything runs offline
npm install
npm run migrate                # embedded Postgres — no cloud account needed
npm run seed                   # partner codes: LAUNCH30K, NETWORK30K, DEMO
npm run dev                    # http://localhost:3000
npm run worker                 # second terminal — runs the pipeline
```

Then open `http://localhost:3000/?code=LAUNCH30K` and walk the journey.

| Command | What it does |
| --- | --- |
| `npm test` | The full suite |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run migrate` | Apply `supabase/migrations/` to whichever database is configured |
| `npm run seed` | Partner codes, and optionally an admin user |
| `npm run worker` | The job runner (every pipeline stage) |
| `npm run live-smoke` | Read-only check of every real vendor credential |
| `npm run build` | Production build |

## The journey

| Step | Customer sees | System does |
| --- | --- | --- |
| 1. Redeem | Landing page with the code applied, then Stripe | Subscription with a 30-day trial, card saved, $0 due. Account created, 30,000 credits granted |
| 2. Onboard | A short questionnaire | Stores answers, scrapes their site |
| 3. Strategy | "Your GTM strategy", editable | Claude generates ICP, segments, angles, offer and sequence plan |
| 4. Infrastructure | Connect or buy a domain; a warm-up bar | Registers the domain, sets DNS, provisions mailboxes, starts warm-up |
| 5. Campaign | Review leads and copy, edit, send | Sources and verifies leads, writes copy, builds the campaign in EmailBison |
| 6. Results | Sent, opens, replies, interested, credits left | Pulls stats and replies, classifies them, decrements credits |
| 7. Upgrade | Renews on day 31 | Stripe bills $2,000; cancelling pauses sending |

## How it is put together

- **Next.js 16** (App Router, React 19, Tailwind 4) for the UI and the HTTP surface.
- **PostgreSQL** via plain SQL migrations. With `DATABASE_URL` empty it runs on **PGlite**, an embedded Postgres, so the whole product works offline; point `DATABASE_URL` at Supabase and the same migrations run there.
- **A job queue in the database.** Every pipeline stage is an idempotent job with retries, backoff and crash recovery. `npm run worker` locally; `POST /api/jobs/tick` from pg_cron or a Vercel cron in production.
- **Every vendor behind an interface** with a `mock` and a `live` implementation, selected by `PROVIDER_MODE`. A live provider with a missing key fails loudly rather than silently doing nothing.

```
src/lib/contracts.ts    every type and provider interface — the module boundary
src/lib/ledger.ts       credits and cost, append-only
src/lib/guardrails.ts   the seven send gates, warm-up ramp, auto-pause
src/lib/compliance.ts   the copy gate that runs before anything sends
src/lib/billing.ts      Stripe event handling
src/providers/          mock/ and live/, one file per vendor
src/jobs/               queue, runner, registry, handlers
supabase/migrations/    the schema
docs/                   SPEC (the contract), VENDOR_NOTES (APIs), HANDOFF (read this)
reference/              the EmailBison OpenAPI spec
```

## Before deploying

The app **refuses to start in production** if it is configured dangerously — dev
secrets, mock billing (which would hand out free credits), an empty `DATABASE_URL`, a
plain-HTTP `APP_URL` or missing Stripe keys. Generate two different secrets and let
the boot guard list anything still missing:

```bash
openssl rand -base64 48   # SESSION_SECRET
openssl rand -base64 48   # CRON_SECRET
```

See [`docs/SECURITY.md`](docs/SECURITY.md).

## Rules this codebase enforces

These are tested, not aspirational (364 tests, 19 files):

1. **Credits are an append-only ledger.** No balance column exists anywhere; balance is `SUM(delta)` and every write carries an idempotency key, so no webhook replay or job retry can double-spend.
2. **Every tenant query is scoped by `account_id`.**
3. **Suppression is checked before every upload**, and an unsubscribe writes a suppression row.
4. **Stripe webhooks are idempotent**, verified against the raw body, and a failed one releases its claim so the retry still does the work.
5. **Nothing sends until all seven gates pass:** active subscription, credits remaining, compliant copy, warm-up complete, first-campaign approval, bounce rate under threshold, and daily cap not reached.
6. **Warm-up cannot be skipped.** The UI says so plainly instead of promising instant sending.
7. **Every external fetch is bounded** and reports truncation rather than hiding it.

## Documentation

- [`docs/HANDOFF.md`](docs/HANDOFF.md) — start here: what is real, what needs credentials, the morning checklist, and the open decisions
- [`docs/SPEC.md`](docs/SPEC.md) — the build contract
- [`docs/VENDOR_NOTES.md`](docs/VENDOR_NOTES.md) — verified API details and every gotcha, labelled verified or unverified
- [`docs/SECURITY.md`](docs/SECURITY.md) — the pre-launch hardening pass: what was found, what was fixed, and what still needs a product decision

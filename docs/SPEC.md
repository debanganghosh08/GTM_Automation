# GTM Autopilot — Build Contract

**Date:** 2026-10-23 · **Source:** `GTM_Autopilot_Build_Brief.pdf` (22 Oct 2026) + the 22 Oct founder meeting.
**Status:** this file plus `src/lib/contracts.ts` plus `supabase/migrations/0001_init.sql` are the contract. Modules talk only through them.

## 1. What this is

A self-serve outbound product. A founder redeems a partner code, adds a card ($0 for 30 days), answers a questionnaire, and the system produces a GTM strategy, sources and verifies leads, writes the copy, provisions domains and mailboxes, warms them, and launches a campaign. They watch results on a dashboard. Day 31 bills $2,000/month unless cancelled.

Credits: **1 credit = 1 email sent.** Launch grant is 30,000.

## 2. Stack decisions (lead engineer's call; the brief gave discretion)

| Layer | Choice | Why |
| --- | --- | --- |
| Frontend | Next.js 15 App Router, React 19, TypeScript, Tailwind 4 | As briefed. Server components keep the client thin |
| Database | **PostgreSQL**, schema as plain SQL migrations | Supabase-compatible. `DATABASE_URL` points at Supabase in prod |
| Local DB | **PGlite** (embedded Postgres) | Real Postgres semantics with no server or cloud account, so the full flow and all tests run offline tonight. Same migrations run on both |
| Auth | DB-backed sessions, httpOnly cookie, scrypt password hash | No external dependency, testable tonight. Swappable for Supabase Auth later |
| Jobs | `jobs` table + idempotent handlers + worker process | Matches the briefed "edge functions + pg_cron queue table" model without needing either to exist yet. In prod: pg_cron or a Vercel cron hitting `/api/jobs/tick` |
| External vendors | **Provider interfaces** with `mock` and `live` implementations, chosen by `PROVIDER_MODE` | The full journey runs end to end offline tonight; tomorrow it is an env change plus keys. See §7 |

**Deviation from the brief, recorded deliberately:** the brief says "test with a real run, not mocks". That needs vendor keys, a Stripe account and a real domain, none of which exist on this machine tonight. So: every provider has a real `live` implementation written against the documented API, and a `mock` that exercises the same code path. `scripts/live-smoke.ts` runs the real end-to-end test the moment keys are added. Tonight's tests prove the orchestration, the money arithmetic and the guardrails; they cannot prove a vendor's API shape.

## 3. User journey → system stages

| # | Customer sees | System does | Job types |
| --- | --- | --- | --- |
| 1 | Landing page, code pre-applied, Stripe Checkout | Stripe subscription, 30-day trial, card saved, $0 due. Account + 30,000 credits | — (webhook) |
| 2 | Questionnaire | Store answers, scrape their site | `scrape_site` |
| 3 | "Your GTM strategy" in minutes | Claude generates ICP, segments, angles, offer, sequence plan | `generate_strategy` |
| 4 | Connect or buy a domain; 7-day warm-up bar | Register domain, set DNS, provision mailboxes, start warm-up | `provision_domain`, `verify_dns`, `provision_mailboxes`, `warmup_monitor` |
| 5 | Review leads and copy, edit, Send | Source leads, verify, personalise copy, build campaign, upload leads | `source_leads`, `verify_leads`, `generate_copy`, `build_campaign`, `launch_campaign` |
| 6 | Dashboard: sent, opens, replies, interested, credits | Pull stats and replies, classify, decrement credits | `sync_stats`, `sync_replies`, `classify_replies` |
| 7 | Auto-renews day 31 | Stripe bills $2,000; cancellation pauses sending | — (webhook) |

## 4. Invariants (these are the things that must not break)

The brief names three things not to trust to an unreviewed build: **Stripe webhook logic, anything that sends email, and credit-ledger arithmetic.** Each is pinned by an invariant with a test.

- **I1 — Credits are an append-only ledger.** No mutable balance column exists. `balance = SUM(delta)`. Every write carries an `idempotency_key` unique per account. Granting the same code twice, or billing the same send twice, is a no-op.
- **I2 — Every tenant query is scoped by `account_id`.** Enforced in the repository layer; no route builds SQL without it.
- **I3 — Suppression is checked before every upload.** Global (`account_id IS NULL`) and per-account, by email and by domain. Unsubscribes write a suppression row.
- **I4 — Stripe webhooks are idempotent.** `INSERT INTO stripe_events (id)` first; a conflict means the event was handled and processing stops. Signature verified before parsing.
- **I5 — Jobs are idempotent.** `(type, dedupe_key)` is unique among pending/running jobs. Handlers re-run safely.
- **I6 — Nothing sends without passing the gates.** See §5.
- **I7 — Credits are spent on send confirmation, never on intent.** Spend is reconciled from provider-reported sends, keyed by `campaign:<id>:day:<date>`.
- **I8 — Truncation is reported, never hidden.** Lead sourcing returns a `stop_reason`.

## 5. Sending gates (all must pass, checked in `assertCanSend`)

1. Account is not `sending_paused` and status is `trialing` or `active`.
2. Credit balance > 0.
3. The campaign's copy has `compliance_passed = true`.
4. Every mailbox used is `ready` (warm-up complete). Warm-up is 7 days and cannot be skipped.
5. The account's **first campaign** has an `approved` approval row. Later campaigns do not need one.
6. Bounce rate over the trailing window is below `bounce_pause_threshold` (default 3%).
7. Today's sends are below `min(account.daily_send_cap, campaign.daily_cap, sum(mailbox.daily_cap))`.

Failing 1, 2, 4, 5 or 6 pauses the campaign and writes an `events` row. The ramp during warm-up is linear over `warmup_days`.

## 6. Compliance checker (automatic, blocks the send)

Errors (block): missing `{{unsubscribe_link}}`, unknown merge tag, body under 20 or over 220 words, empty step, missing sender identity. The floor is 20 rather than 30 because a step-3 breakup email is deliberately terse; the per-step band (step 1 under 80, step 2 80-120, step 3 30-60) is reported as a warning so the customer can judge it.
Warnings (allow, surface to reviewer): spam words, subject over 6 words, ALL CAPS, `!!`/`??`, more than 2 links.

## 7. Providers

| Interface | Live implementation | Mock behaviour |
| --- | --- | --- |
| `leads` / `leadsOverflow` | Prospeo (primary), GetLeads (overflow) | Deterministic synthetic leads from the query, seeded by query hash |
| `verification` | TrueList | ~85% valid, ~5% invalid, ~5% risky, ~5% catch-all, deterministic per email |
| `sending` | EmailBison at `send.roister.ai` | In-memory campaigns; simulated sends, replies and bounces |
| `domains` | Registrar API | Availability by hash; instant "registration" |
| `mailboxes` | Inbox Kit reseller | Generates name-permutation addresses, $30/mailbox |
| `billing` | Stripe | Fake checkout URL, signed fake webhooks |
| `llm` | Anthropic Claude | Schema-shaped fixtures, so strategy and copy pages render |
| `scrape` | Fetch + extract | Fixture HTML |

`PROVIDER_MODE=mock|live`, with per-provider override (`PROVIDER_LEADS=live`). Live providers throw a clear error when their key is missing, rather than silently falling back to mock.

## 8. HTTP surface

Public: `GET /` (landing, `?code=`), `POST /api/checkout`, `POST /api/webhooks/stripe`, `GET /api/unsubscribe?token=`.
Auth: `POST /api/auth/register|login|logout`.
App (session required, account-scoped): `GET|POST /api/onboarding`, `POST /api/strategy/generate`, `GET|PUT /api/strategy`, `POST /api/strategy/approve`, `GET|POST /api/domains`, `POST /api/domains/:id/verify`, `POST /api/mailboxes`, `GET|POST /api/campaigns`, `GET /api/campaigns/:id`, `POST /api/campaigns/:id/leads`, `GET|PUT /api/campaigns/:id/copy`, `POST /api/campaigns/:id/approve`, `POST /api/campaigns/:id/launch`, `POST /api/campaigns/:id/pause`, `GET /api/dashboard`, `GET /api/credits`.
Admin (`is_admin`): `GET /api/admin/approvals`, `POST /api/admin/approvals/:id`, `GET /api/admin/accounts`, `GET /api/admin/costs`.
Ops: `POST /api/jobs/tick` (cron secret), `GET /api/health`.

Every response uses `ApiResponse<T>`.

## 9. Pages

`/` landing · `/redeem` · `/login`, `/register` · `/onboarding` · `/strategy` · `/infrastructure` · `/campaigns`, `/campaigns/[id]` (lead + copy review) · `/dashboard` · `/admin` · `/unsubscribed`.

## 10. Module split (parallel build)

A worker owns a module and touches only its own files plus the contract.

| Module | Owns |
| --- | --- |
| M1 core | db client, migrations runner, repository, session auth, `ApiResponse`, logging |
| M2 billing | Stripe provider, checkout, webhooks, redemption codes, credit grants |
| M3 ledger | credit + cost ledger, `assertCanSend`, guardrail enforcement |
| M4 onboarding | questionnaire, scrape, strategy generation, strategy UI |
| M5 leads | lead providers, verification, suppression, lead review UI |
| M6 copy | copy generation, compliance checker, copy review UI |
| M7 sending | EmailBison provider, campaign build/launch/pause, stats + reply sync |
| M8 infra | domain + mailbox providers, DNS records, warm-up |
| M9 ui | landing, dashboard, admin, shared components |
| M10 jobs | job queue, worker runner, handler registry, cron endpoint |

## 11. Definition of done (from the brief §9)

1. A stranger clicks a coded link, adds a card ($0), fills the form, sees a real strategy within 5 minutes.
2. One account completes the whole flow end to end.
3. Credits decrement correctly; cancelling pauses sending.
4. Landing page, redemption and fulfilment are solid enough to put in the partner email.

Tonight that is proven in `mock` mode by an automated end-to-end test. Item 2 with real vendors is `scripts/live-smoke.ts`, to run once keys exist.

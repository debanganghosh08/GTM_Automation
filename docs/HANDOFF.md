# GTM Autopilot — Handoff

**Built overnight 2026-10-22 → 23.** Read this first, then `docs/SPEC.md`.

## What this is

The product from `GTM_Autopilot_Build_Brief.pdf`: a founder redeems a partner code, adds a card ($0 for 30 days), answers a questionnaire, and the system produces a GTM strategy, sources and verifies leads, writes the copy, provisions domains and mailboxes, warms them, and launches a campaign. Results land on a dashboard. Day 31 bills $2,000/month.

## Run it

```bash
cd GTM_Automation
cp .env.example .env.local      # works as-is for offline mode
npm install
npm run migrate                 # embedded Postgres, no cloud account needed
npm run seed                    # partner codes: LAUNCH30K, NETWORK30K, DEMO
npm run dev                     # http://localhost:3000
npm run worker                  # second terminal: runs the pipeline
npm test                        # the suite
```

Everything runs **offline by default** (`PROVIDER_MODE=mock`). No vendor keys, no Stripe account and no domain are needed to click through the whole journey.

## The two things to understand

**1. Two database backends, one schema.** With `DATABASE_URL` empty the app runs on PGlite, an embedded Postgres, so the full flow and all tests work on a laptop with no cloud account. Set `DATABASE_URL` to a Supabase connection string and the same migrations run there. Nothing above `src/lib/db.ts` knows the difference.

**2. Every vendor sits behind an interface with two implementations.** `mock` is deterministic and offline; `live` calls the real API. `PROVIDER_MODE=mock|live`, with per-provider overrides (`PROVIDER_SENDING=live`). **A live provider with a missing key throws loudly** rather than silently doing nothing — a demo that quietly sends no email is worse than a crash.

## What is real and what is not

**Proven by 313 automated tests, including a nine-step end-to-end run of the whole journey:** the schema and its invariants, the credit ledger (including concurrent spends and idempotent reconciliation), the seven send gates, warm-up ramp maths, the compliance checker, the job queue (dedupe, backoff, crash recovery, concurrent claims), transaction isolation, and the mock provider behaviour.

`tests/e2e/journey.test.ts` drives the real route handlers and the real job handlers, with only the vendors mocked: redeem a code, grant 30,000 credits, onboard, generate and approve a strategy, buy a domain, verify DNS, provision mailboxes, wait out warm-up, source and verify leads, generate compliant copy, be refused a launch until a human approves, launch, report stats, spend credits exactly once per send, and have sending pause when the subscription is cancelled. The signup-to-credits path was also driven over real HTTP against a production build.

**Written against verified API docs but never executed against a live vendor:** EmailBison, Prospeo, TrueList, InboxKit, Porkbun, Stripe, Anthropic. The EmailBison integration is the strongest of these because that instance publishes its own OpenAPI spec, which is mirrored at `reference/roister-openapi.yaml` and was used to write every call.

**The brief asked for a real end-to-end run with a real card and a throwaway domain.** That needs credentials that do not exist on this machine, so it is the first thing to do in the morning: `npm run live-smoke` is the script for it.

## Security

A full hardening pass ran on 2026-10-23: five audits, then fixes. It found three real
bugs (every Stripe subscription event threw; any string was worth 30,000 credits;
pausing never stopped the vendor sending) and two measured denial-of-service vectors.
Read [`SECURITY.md`](SECURITY.md) before deploying — in particular the
"deliberately not done" list, which needs product decisions, and note that the app now
refuses to boot in production with dev secrets or mock billing.

## Morning checklist, in order

0. **Generate the two secrets** (`openssl rand -base64 48` twice, different values) and set them in Vercel, or the app will refuse to start.
1. **Decide the database.** Create the Supabase project, put its connection string in `DATABASE_URL`, run `npm run migrate`.
2. **Stripe, in test mode first.** Create the $2,000/month recurring Price, set `STRIPE_SECRET_KEY`, `STRIPE_PRICE_ID` and `STRIPE_WEBHOOK_SECRET`, then `stripe listen --forward-to localhost:3000/api/webhooks/stripe`. Walk one signup through with card `4242424242424242`. Then confirm day-31 behaviour with a test clock and the failure card `4000000000000341`.
3. **Probe EmailBison before trusting the write path.** The integration was written against that instance's own published OpenAPI spec, and building it corrected ten details in our notes (stats is a POST, sequence steps need the `v1.1` path, stats values come back as strings, `sender_email_ids` items are strings, `unsubscribe_text` is not in the update schema, and so on — all recorded in `docs/VENDOR_NOTES.md` §1). Get a token from Settings → Developer API. Create a throwaway campaign by hand through the API and confirm the five write calls in `docs/VENDOR_NOTES.md` §1 behave as the spec says, especially `attach-sender-emails`, the `v1.1` sequence-steps path, and that stats is a POST.
4. **Mailboxes.** InboxKit is the fastest path and already automates SPF/DKIM/DMARC. It can also push senders straight into EmailBison, which removes hand-wiring.
5. **Then the real smoke test:** `npm run live-smoke` with a throwaway domain, your own company as the customer, and a tiny lead list.

## Decisions I made that you should know about

| Decision | Why |
| --- | --- |
| Next.js 16 + embedded-or-Supabase Postgres, not Supabase-only | The brief gave technical discretion. This runs offline tonight and in Supabase tomorrow with no code change |
| Session auth in our own tables, not Supabase Auth | No external dependency, testable immediately, swappable later |
| Credits are an append-only ledger with no balance column | A balance column is how double-spends happen. Balance is `SUM(delta)`; every write carries an idempotency key |
| Over-spend clamps instead of rejecting | Sends are reported by the provider after the fact, so the honest response is to bill what remains and report the shortfall |
| Redemption codes grant credits in OUR database, not via Stripe coupons | Month one is already free through `trial_period_days`, so no Stripe discount is involved |
| Copy must carry both the P.S. opt-out and a real `{{unsubscribe_link}}` | The house style uses a reply-based opt-out, which is fine for Sparq's own hand-built lists. For thousands of strangers sending through our infrastructure, a real unsubscribe is required |
| Porkbun as the default registrar | Namecheap needs 20+ domains plus IP whitelisting; GoDaddy v3 needs a billing method on file. Porkbun has a sandbox and a spend cap |
| The first campaign of every account needs human approval | Brief §7. One bad actor burns shared domains |

## Things that need a human decision

1. **GetLeads cannot legally be the overflow lead source.** Their FAQ says using the unlimited plan to power a product is not allowed, and reselling needs a written agreement. The provider is implemented but **refuses to run** unless `GETLEADS_SAAS_APPROVED=true`. Either get that agreement or drop overflow and queue against Prospeo's rate limits.
2. **"Packsit/Paxit" does not exist as a vendor.** The nearest match is Pax8, a Microsoft CSP distributor that advertises neither unlimited tenants nor cold-email use. Confirm what was meant before building any provisioning on it.
3. **Microsoft's terms are a standing risk** for sending bulk cold email from CSP/Azure tenants: their own guidance says to use a third-party provider, and trial tenants cap at 5,000 external recipients/day. This is the same gate recorded as D-008 in the sibling project.
4. **Warm-up is 7 days in our config; the market standard is 14.** Artisan uses 14 and still shows a red mailbox status for ~3 weeks. If we promise 7 and deliverability suffers, that lands on the partner. Consider 14 and say so plainly.
5. **Price and unit economics** (brief §8): with lead data, verification and ~$30/mailbox before a cent of revenue, confirm $2,000/month works. `GET /api/admin/accounts` reports cost per account from `cost_ledger`, which is what that question needs.
6. **Brand and the landing URL** for the partner email.

## Defects found and fixed during the build

The end-to-end test earned its keep. These were real bugs, not test artifacts:

1. **A paid-for mailbox could be silently discarded.** When the provider created a mailbox whose address we already held, the `on conflict do nothing` insert dropped the row — so we were billed for a mailbox the system could not see or use. `provision_mailboxes` now records a `mailboxes.orphaned` event naming each one, logs a warning, and surfaces the count in the job result. The e2e asserts that zero orphans occur on a clean run.
2. **A failed Stripe webhook could be lost forever.** The event id was recorded *before* processing, so a transient database error would mark the event handled and Stripe's retry would be discarded as a duplicate — losing a payment. The claim is now released on failure so the retry does the work.
3. **An unknown redemption code broke checkout entirely.** `subscriptions.redemption_code` has a foreign key, so a mistyped partner code raised a constraint violation and failed the whole webhook — a customer who had already entered a card would get no account. Unknown codes are now stored as NULL, the discrepancy is recorded as an event, and the default grant still applies.
4. **Embedded-Postgres transactions did not isolate.** `tx()` was hand-rolled `BEGIN`/`COMMIT` on a shared connection, so concurrent transactions interleaved and anything relying on `select ... for update` quietly lost isolation. It now uses PGlite's own `transaction()`, which holds its mutex, and `tests/unit/db-tx.test.ts` proves serialisation.
5. **`/api/health` reported every job handler as missing**, because it never imported the registry — a false alarm precisely when the endpoint matters. Fixed and verified against a running server.
6. **The compliance floor contradicted the house style.** SPEC said 30 words minimum (blocking); the house style wants step-3 breakup emails at 30–60 words, so a well-written terse breakup was blocked. The blocking floor is now 20 — a blocking error should mean "empty or malformed", not "shorter than ideal" — and the per-step band warns instead. Blocking short copy would only push writers to pad it.

## Something the brief assumes that is not quite true

**"Fulfil every redemption without manual work" holds fully only for domains we buy.** When a customer *connects* a domain they already own, we cannot write its DNS: the pipeline correctly computes the SPF/DKIM/DMARC records and then waits for the customer to add them, retrying for up to 48 hours. That is the right behaviour, but it is a human step in the middle of a "self-serve" flow. Two options before the newsletter goes out: make buying the domain the default path in the UI, or set expectations clearly on the infrastructure screen. The e2e exercises the purchased path because that is the one that completes unattended.

## Known gaps

- **A paused campaign is paused in our database but not yet at the provider.** `enforceGuardrails` sets our state and writes an event; wiring that to `SendingProvider.pause` is a small, important follow-up.
- **"No fabricated stats" is not mechanically checked.** The compliance checker cannot see the customer's proof points. Passing them into `checkCompliance` and flagging any numeral not present in them is the fix.
- **Customer emails are not sent** (strategy-ready, trial-ending). The events are recorded; the sending is a TODO.
- The reply inbox, A/B variants and auto-optimisation are V2 in the brief and not built.

## Where things live

```
docs/SPEC.md            the build contract: schema, stages, invariants, gates, routes
docs/VENDOR_NOTES.md    verified API details and every gotcha, with V/U labels
docs/HANDOFF.md         this file
reference/              the EmailBison OpenAPI spec
src/lib/contracts.ts    every type and provider interface — the module boundary
src/lib/{ledger,guardrails,compliance,billing}.ts   the money and safety code
src/providers/{mock,live}/   one file per vendor per mode
src/jobs/               queue, runner, registry, handlers
supabase/migrations/    the schema
tests/                  140 tests
```

**The three things the brief says not to trust to an unreviewed build** — Stripe webhook logic, anything that sends email, and credit-ledger arithmetic — are in `src/lib/billing.ts`, `src/providers/live/emailbison.ts` + `src/lib/compliance.ts`, and `src/lib/ledger.ts`. Read those four first.

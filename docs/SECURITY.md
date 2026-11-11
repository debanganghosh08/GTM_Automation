# Security

**Hardening pass: 2026-10-23.** Five parallel audits (auth and sessions, money paths, injection and SSRF, configuration and dependencies, plus research into how AI-generated apps actually get breached), then the fixes below. No product behaviour was changed — every change either closes a hole or makes an existing control real.

**Verified at the end:** 364 tests pass, typecheck clean, production build clean, `npm audit` reports 0 vulnerabilities, and each control was exercised against a running server.

## The one that mattered most

Nothing stopped this app booting in production with development secrets, mock billing and no database. Mock billing leaves `/api/mock/checkout-complete` able to grant 30,000 credits with no payment, and an empty `DATABASE_URL` silently writes every signup to a container filesystem that is wiped on the next deploy.

`src/lib/startup-checks.ts` now runs from `src/instrumentation.ts` and **refuses to start**. Confirmed live:

```
[config] Refusing to start: 10 configuration problem(s).
  1. SESSION_SECRET is still the development default.
  4. DATABASE_URL is empty, so the app would fall back to an embedded database.
  5. Billing is in mock mode in production. /api/mock/checkout-complete would grant
     30000 credits with no payment.
```

A process that exits is a visible outage. A process that runs with mock billing quietly gives the product away.

## Bugs found, not just weaknesses

1. **Every subscription event threw.** `onSubscriptionChanged` referenced five query placeholders but passed four arguments, with `status` missing. `customer.subscription.created` fires on every signup, so each one 500'd and Stripe retried for three days — and Stripe disables endpoints that keep failing, which would have taken down `checkout.session.completed` too. No test covered those two event types; two now do.
2. **Any string was worth 30,000 credits.** An unknown, expired or exhausted redemption code fell through to the full launch grant, so `max_redemptions` enforced nothing. The cap is now claimed atomically in one `UPDATE … WHERE … RETURNING`, so two concurrent redemptions of the last slot cannot both win. An invalid code gets a small fallback and is recorded for partner reconciliation.
3. **Pausing did not stop sending.** `pauseSending` set a database flag; the campaign kept running at EmailBison. A cancelled subscription, failed payment, exhausted balance or tripped bounce threshold stopped the bookkeeping while email kept going out. `src/lib/provider-pause.ts` now propagates the stop through the job queue (retryable, and not inline in a webhook), recording `provider_sending_stopped_at` so it is not re-sent, and logging loudly when the vendor call fails.
4. **Two denial-of-service vectors, measured.** A crafted merge tag (`{{` plus 8,000 spaces) in a copy edit froze the process for **58 seconds**; a hostile website froze the HTML extractor for **78 seconds**. Both ran synchronously on the single Node event loop, so one request stalled every tenant. Both were lazy quantifiers that restart their scan at each opener. Now **67ms** and **under 1 second** respectively, with timing tests to catch a regression.
5. **Hash and verify disagreed about long passwords.** Caught by the new test suite, before it could lock anyone out.

## What changed, by area

### Database exposure (the breach pattern)
Supabase exposes `public` tables through PostgREST and grants `anon` by default, and the anon key is public by design. Without Row Level Security, anyone with the project URL could read `users.password_hash` and `sessions`, or set `is_admin = true`. This is the documented root cause of both the Lovable (CVE-2025-48757) and Moltbook breaches — both AI-built apps.

`0004_rls_and_indexes.sql` enables (and `FORCE`s) RLS on every table with no policies, and revokes all `anon`/`authenticated` grants. Our server connects with a role that bypasses RLS, so this costs nothing functionally and closes the whole client-reachable surface.

### Sessions
Tokens were stored as the raw bearer value and were the primary key, so any database read was an account takeover. Now stored as SHA-256; the plaintext never returns to the database. A plain hash is right here (unlike for passwords) because the token is 256 bits of CSPRNG output. Added: absolute expiry so a session cannot be refreshed forever, `destroyAllSessions` for credential changes, and explicit column selection so `password_hash` cannot leak through the session lookup.

### Passwords
scrypt ran at Node's defaults (N=2¹⁴), about eight times weaker than current OWASP guidance. Now N=2¹⁶, r=8, p=2 (64 MiB), with the parameters stored in the hash string so they can be raised later without invalidating anyone. Legacy hashes still verify and are flagged for upgrade. The unknown-user path now performs the same scrypt work, closing an ~80ms timing oracle that enumerated accounts.

### Rate limiting
There was none. `src/lib/rate-limit.ts` is a fixed-window counter in Postgres — chosen because on Vercel every request may hit a different instance, so an in-memory limiter limits nothing, and a second datastore is not worth it at launch. One atomic `INSERT … ON CONFLICT DO UPDATE` per check; the window is part of the primary key, so expiry needs no cleanup job and concurrent requests cannot both create a window. **It fails open**: a limiter that takes the product down when Postgres hiccups is worse than one that briefly stops limiting.

| Surface | Limit |
| --- | --- |
| Login, per IP | 10 / 15 min |
| Login, per email | 8 / 15 min — a distributed attack on one account is still throttled |
| Signup, per IP | 5 / hour |
| Checkout, per IP | 5 / hour (each one is a paid Stripe API call) |
| Unsubscribe, per IP | 60 / hour |
| Everything else, per IP | 300 / min |

Verified live: `401 401 401 401 401 401 401 401 429 429 429 429`.

### Request guards
The cross-origin, content-type and flood checks live in the shared `route()` wrapper that all 28 routes already use. That placement is deliberate: the arXiv study of 9,041 AI-authored repos found broken access control in 64% of apps, and the recurring cause was a guard applied to new handlers and missed on old ones. A guard in one place cannot be missed.

- Cross-site requests → 403 (verified)
- Form-encoded bodies → 415, which is what stops a plain HTML form reaching a mutating route (verified)
- Bodies over 64 KB → rejected
- Errors masked unless `NODE_ENV` is explicitly `development`, so a host with the variable unset no longer returns raw SQL

### Other
Security headers (CSP with `frame-ancestors 'none'`, HSTS, nosniff, Referrer-Policy, Permissions-Policy, COOP) — verified on the wire. `poweredByHeader` off. TLS certificate verification turned **on** for the database (it was `rejectUnauthorized: false`, so anything on the path could read password hashes). Pool reduced to 5 with acquire and statement timeouts, so a spike fails fast instead of hanging. `/api/health` returns bare liveness publicly, with detail behind the operator secret. Hot-path indexes added, plus `prune_operational_data()` for three tables that grew without bound. `.gitignore` widened to `.env*`. All dev-dependency advisories cleared.

## Deliberately not done

These are product features, not hardening, and the instruction was not to add logic. Each needs a decision:

1. **Email verification.** Anyone can register `someone-else@company.com` and get a live session. This is the biggest remaining gap and it also enables trial farming.
2. **Password reset.** There is none, so a forgotten password locks the account out permanently. Note that `createAccountWithUser` allows a null password hash at checkout.
3. **Multi-account farming.** Uniqueness is `lower(email)` only, so `+tag`, Gmail dots and disposable domains all work. Consider normalising the email and deduplicating by Stripe card fingerprint.
4. **A spend circuit breaker.** Per-account caps exist (25 domains, 50 mailboxes, 5,000 trial leads), but there is no global daily vendor-spend ceiling or kill switch. With a newsletter going to 6.6M people, add one before launch.
5. **Credits are granted when a card is entered, not when it is charged.** A virtual card that passes the $0 setup gets 30,000 credits. Consider releasing them in tranches, or after the first real charge.
6. **Approval is not bound to the copy it approved.** Copy can be edited after approval, and `first_campaign_approved` exempts every later campaign. Store the approved version hash.
7. **MFA for admin accounts**, and moving the seed script's password off argv.
8. **Per-account job fairness.** The queue is global, so one noisy account can starve paying customers.
9. **DNS rebinding in the scraper.** The SSRF guard resolves the host and then `fetch` resolves it again, so a TTL-0 attacker-controlled domain can pass the check and connect elsewhere. Closing it properly means pinning the connection to the validated IP with a custom agent. The practical impact is bounded (the scraped text goes only to that customer's own strategy page), but it should be fixed.
10. **Vendor unsubscribes are not synced into global suppression**, so a recipient who opts out through EmailBison can be re-sourced by another tenant.

## Running the checks

```bash
npm run verify        # typecheck + 364 tests
npm audit             # expect 0 vulnerabilities
npm run live-smoke    # read-only check of every real vendor credential
```

Before the first deploy, generate two different secrets and let the boot guard tell you what is still missing:

```bash
openssl rand -base64 48   # SESSION_SECRET
openssl rand -base64 48   # CRON_SECRET
```

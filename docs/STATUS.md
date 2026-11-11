# GTM Autopilot — build status

## What it is

Self-serve outbound for founders. Redeem a partner code → card on file, $0 today → 8-question
questionnaire → the system writes the GTM strategy, sources and verifies leads, writes the copy,
registers a sending domain, provisions and warms mailboxes, launches the campaign, and reports
results. **1 credit = 1 email.** 30,000 credits on day one; $2,000/month from day 31.

## Where it stands: ~85% complete

| | |
| --- | --- |
| Source | 129 files, 18,570 lines TypeScript (Next.js 16, strict) |
| Tests | **364 passing**, including a nine-step end-to-end run of the whole journey |
| Database | 26 tables, 6 migrations, append-only credit ledger |
| API | 28 endpoints |
| Background work | 18 job handlers — scrape, strategy, leads, verify, copy, domain, DNS, mailboxes, warm-up, launch, stats, replies, guardrails |

**Vendor integrations already written** against the real API docs, each behind one interface with a
working offline simulator: InboxKit (mailboxes, warm-up, export senders), EmailBison (campaigns,
leads, schedule, launch, pause), Prospeo + GetLeads (lead search), TrueList (verification),
Namecheap/Porkbun (domains, DNS), Anthropic (strategy and copy), Stripe (billing).

**Proven end to end on real PostgreSQL** (recorded 2026-11-02): 30,000 credits granted → strategy
→ domain with SPF/DMARC/MX verified → 330 leads sourced and verified → copy written and
compliance-checked → **send correctly blocked** on two gates → human approval → launch → 25 sent,
25 delivered, 40% open, 1 reply, 29,975 credits left. A 3m54s recording of that run exists.

## What is left

| # | Item | Effort | Blocked by |
| --- | --- | --- | --- |
| 1 | Point at Supabase and run the 6 migrations | **~1 hour** | Connection string (account created) |
| 2 | Decide and wire the payment path | 0–2 days | **A decision — see below** |
| 3 | Anthropic API key so strategy/copy are real, not fixtures | ~1 hour | Key |
| 4 | First live run against real vendor accounts | ~2 days | Vendor keys |
| 5 | Deploy to Vercel + cron | ~half a day | Items 1–3 |

Item 4 is the only one carrying real risk. Every vendor call is written from the documentation but
**has never run against a live account**, so expect a day or two of shaking out field-shape and
pagination differences. Everything else is plumbing.

> Two caveats already known: GetLeads' terms forbid using their plan to power a product, so the code
> refuses to use them without a signed agreement — Prospeo is primary. And three mailboxes requested
> currently yields two, because the third name collides; worth settling before anyone is billed per
> mailbox.

## On the payment gateway

**Playto Pay cannot run this product as specified.** I tested the live key Nishkarsh sent: it is
valid, the merchant account is active, USD works, and read-only calls return 200. But across the
plan object, the subscription create body, the subscription object and the guides, **Playto has no
trial mechanism of any kind** — no `trial_days`, no delayed first charge, no card-on-file without
charging. `subscription.activated` is defined as "the first charge succeeds."

The offer is "card saved, $0 today, free for 30 days, $2,000 on day 31." Playto cannot express it.

Three ways forward:

| | What happens | Cost |
| --- | --- | --- |
| **A. Stripe** | Offer intact; the code is already written and tested | A Stripe account |
| **B. Playto, no trial** | Charge $2,000 on day one | The offer and the partner pitch both change |
| **C. Playto + trial in our code** | Grant credits at signup, create the Playto subscription on day 31 | **No card on file** — day-31 conversion falls sharply |

**D — and this is the one I would pick to launch this week:** ship with **no gateway at all.** Partner
codes already grant credits without any payment step, and that path is built, tested and recorded.
Invoice the first cohort by hand on day 31. It removes item 2 from the critical path entirely and
costs nothing but a spreadsheet, while Stripe or Playto gets decided properly rather than under
time pressure.

Also worth knowing: the Playto webhook secret only exists once merchant onboarding and KYC are
finished, and that live key gives read access to Sparq Labs' real customer list — please rotate it
and send the `pk_test_` sandbox key instead.

## Shortest path to a live customer

Supabase (1 hour) → Anthropic key (1 hour) → partner-code launch with manual invoicing →
first real campaign. **That is two days of work, and only two credentials.**

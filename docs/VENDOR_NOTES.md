# Vendor Notes

**Date:** 2026-10-23. What we actually know, and how sure we are. **V** = verified from the vendor's own spec/docs or captured live payloads. **U** = unverified.

> The brief says to reuse `sparq-campaign-from-scratch`, `sparq-list-build`, `sparq-copywriting` and `roister-*`. **Seven of those nine skills do not exist on this machine.** Only `sparqlabs-cold-email` (copy rules, §2) and `prospeo-enrich` (list hygiene, §3) are present. Fortunately the EmailBison instance publishes its own API spec, so §1 is verified rather than guessed.

## 1. EmailBison (send.roister.ai) — written against the instance's own OpenAPI spec

**The instance publishes its spec publicly:** `https://send.roister.ai/api/reference.openapi` (181 operations), mirrored at `reference/roister-openapi.yaml` in this repo. Interactive reference at `/api/reference`; docs at docs.emailbison.com. Everything in this section is **V** from that spec. Grep the spec before changing any call.

- **Auth:** `Authorization: Bearer <token>`, `Content-Type: application/json`. Token from Settings → Developer API → New API Token. Unauthenticated calls return 401.
- **Base URL:** the instance URL + `/api`.

### The campaign build sequence (exact)

| # | Step | Call |
| --- | --- | --- |
| 1 | List senders | `GET /api/sender-emails` — rows carry `id`, `email`, `status` ("Connected"), `daily_limit`, `warmup_enabled` |
| 2 | Create campaign | `POST /api/campaigns` `{name, type}` — `type` is `outbound` (default) or `reply_followup`; only `name` is required. Read `data.id` |
| 3 | Settings | **`PATCH /api/campaigns/{id}/update`** — `max_emails_per_day`, `max_new_leads_per_day`, `daily_max_sends_per_receiving_domain`, `plain_text`, `open_tracking`, `reputation_building`, `can_unsubscribe`, `unsubscribe_text`, `sequence_prioritization` |
| 4 | Attach senders | **`POST /api/campaigns/{id}/attach-sender-emails`** with `{"sender_email_ids":[1,2]}` — **confirmed: the field is `sender_email_ids`. `email_account_ids` appears nowhere in the spec** |
| 5 | Create leads | `POST /api/leads/create-or-update/multiple` `{leads[], existing_lead_behavior:"put"|"patch"}` — **max 500 per request** |
| 6 | Attach leads | `POST /api/campaigns/{id}/leads/attach-leads` `{"lead_ids":[...], "allow_parallel_sending":bool}` — the key is `lead_ids`, not `leads` |
| 7 | Sequence steps | **`POST /api/campaigns/v1.1/{id}/sequence-steps`** — the **v1.1 path**; the unversioned one is deprecated. Body `{title, sequence_steps:[{email_subject, email_body, wait_in_days, order, variant, thread_reply}]}` |
| 8 | Schedule | `POST /api/campaigns/{id}/schedule` — all seven of `monday`…`sunday` as booleans, `start_time`/`end_time` as `HH:MM`, `timezone` as an IANA name. `PUT` on the same path updates it |
| 9 | Launch | **`PATCH /api/campaigns/{id}/resume`** — there is no "start" call; resume *is* launch. Pause is `PATCH /api/campaigns/{id}/pause` |
| 10 | Stats | **`POST /api/campaigns/{id}/stats`** `{start_date, end_date}` — a **POST**, not a GET. Returns `emails_sent`, `opened`, `unique_replies_per_contact`, `bounced`, `unsubscribed`, `interested`, plus `sequence_step_stats[]` |
| 11 | Replies | `GET /api/campaigns/{id}/replies` or `/api/replies` — filters `status` (`interested`, `automated_reply`, `not_automated_reply`), `folder`, `read`, `campaign_id`, `sender_email_id` |

### Corrections found when the live provider was written against the spec (V)

The table above was drafted from research; building against the actual spec turned up ten differences. The spec wins.

1. **The mirrored spec is YAML**, despite earlier being saved as `.json`. It is now `reference/roister-openapi.yaml`. Grep it; `json.load` fails.
2. **`unsubscribe_text` is NOT in the `PATCH /update` request schema.** Only `name`, `max_emails_per_day`, `max_new_leads_per_day`, `daily_max_sends_per_receiving_domain`, `plain_text`, `open_tracking`, `reputation_building`, `can_unsubscribe`, `include_auto_replies_in_stats`, `sequence_prioritization` are accepted. It appears only in response examples. We send it and warn on a mismatched echo; `can_unsubscribe: true` is asserted hard.
3. **`sender_email_ids` items are typed `string`**, not integer (while `lead_ids` items *are* integers).
4. **Response envelopes are inconsistent:** `attach-sender-emails` returns `{success, message}` at the top level; `attach-leads` nests it under `data`.
5. **Stats values come back as numeric strings** (`emails_sent: "10"`), so they must be parsed and range-checked.
6. **No `per_page` parameter exists anywhere in the spec.** Pagination is `?page=N` with `links.next` / `meta.last_page`.
7. **No rate-limit or `Retry-After` documentation at all.** Back off anyway.
8. **`POST /api/leads/create-or-update/multiple` returns HTTP 201**, and `first_name` plus `email` are required per lead — so a row without a first name is rejected locally rather than 422-ing a whole 500-lead chunk.
9. Sequence steps (v1.1) also accept `email_subject_variables`, `variant_from_step`, `variant_from_step_id`.
10. `email_account_ids` appears **0 times** in the spec, confirming the field name.

**Unsubscribe handling, as implemented:** `{{unsubscribe_link}}` is stripped from the body (dropping the line if the tag was alone on it), and the campaign is configured with `can_unsubscribe: true` plus `unsubscribe_text`, with the echo asserted **before** any sequence step is posted. No campaign can be built through this provider without the vendor's own one-click link. The P.S. reply-to-opt-out text is left intact.

**Merge-tag mapping:** only `{FIRST_NAME}` is verified as a native token in the spec. Every other per-lead field is uploaded **both** to its native column and as a custom variable of the same name, so a non-native token still resolves. `{{sending_name}}` maps to `{SENDER_FIRST_NAME}` — a judgement call, flagged in the code.

### Gotchas (V unless noted)

1. **Merge variables are `{FIRST_NAME}`** — uppercase, single braces — and each must already exist via `POST /api/custom-variables`. Our contract uses snake_case `{{first_name}}` internally, so the live provider **translates at upload time**. Keep that mapping in one function.
2. **Prefer webhooks over polling:** `POST /api/webhook-url` `{name, url, events[]}` with `lead_replied`, `lead_interested`, `email_bounced`, `email_sent`, `lead_unsubscribed`, `email_account_disconnected`.
3. Pagination defaults to 15 per page; `?page=N` caps at 1000 pages; use `?pagination_type=cursor&cursor=…` for large sets. A `per_page` maximum is **U**.
4. Leads added to a running campaign sync only every ~5 minutes.
5. Personal domains (gmail.com etc.) are skipped by default.
6. `remove-sender-emails` is a **DELETE with a body**; the prose docs' curl examples say POST and are wrong — the spec wins.
7. Lead email must be unique per tenant.
8. No documented rate limits (**U**) — back off on 429 anyway.
9. Microsoft/Google OAuth senders cannot be added via API; only IMAP/SMTP (`POST /api/sender-emails/imap-smtp`) or bulk CSV.
10. Earlier read-only capture of this same instance found `per_page` pinned at 15, filters ignored on `/api/replies`, the field `interested` (not `is_interested`), and ~44 of 75 replies being `automated_reply` — always exclude those, since their `from_email_address` is a mail server, not a buyer.

## 2. Copy rules (V — from the `sparqlabs-cold-email` skill, the real house style)

Ported into `prompts/copy/v001.md` and `src/lib/compliance.ts`.

**Cadence:** 3 steps, 3 variants each (9 emails). Variants test *different angles*, never synonym swaps.

| Step | Day | Focus | Length |
| --- | --- | --- | --- |
| 1 | 0 | Pain / poke-the-bear | **under 80 words** |
| 2 | 3–4 | Benefits as outcomes | 80–120 words |
| 3 | 7–9 | Soft breakup | 30–60 words |

**Rules:** subject lines are 2-word lowercase spintax `{a|b|c}`, all three steps thread under one subject. Every line under 25 words, hard line breaks, one idea per line. One "without" objection line. Soft CTA gauging interest; **no calendar ask in email 1**; no hard CTA on first touch. Every email ends with a P.S. opt-out. Email 3 acknowledges it is the last touch and offers easy re-entry ("just reply here").

**Banned:** em dashes, fabricated stats, buzzwords (revolutionize, game-changing, unlock, synergy…), calendar links in email 1, bullet-hyphen lists in email 1. Tone: a smart person texting a smart person, never a marketing deck.

**Opener formula:** `{{first_name}}, saw that {{company_name}} <icp phrase>` where the phrase is a lowercase verb phrase ("provides residential landscaping across Tampa").

**Proof points — Sparq's own three, numbers never altered:** a service business grown 6× in 3 years; 102 qualified meetings in one month for a funded SaaS client; booking Legl 10–20 meetings per day. **For this product the generator may only use the customer's own proof points from onboarding — never Sparq's, and never an invented one.**

**Merge-tag naming (gotcha, V):** the skill says camelCase but its own archive mixes `{{first_name}}` and `%signature%`. We pin **snake_case** in `MERGE_TAGS`, enforce it in the compliance checker, and translate to EmailBison's `{UPPER_CASE}` at upload.

### Deliberate addition: a real unsubscribe link

The house style uses a reply-based P.S. opt-out and mentions no unsubscribe link, physical address, CAN-SPAM or GDPR. Acceptable for Sparq sending as itself to a hand-built list. **Not acceptable for this product**, where thousands of strangers send through our infrastructure. Copy must carry **both**: the P.S. opt-out (voice) and `{{unsubscribe_link}}` (compliance). A missing link is a blocking error. EmailBison's `can_unsubscribe` / `unsubscribe_text` are set too.

## 3. List building (V — `prospeo-enrich`)

- Required columns: first name, company, **domain**, email. No domain → stop and re-export.
- Normalise headers; strip `https://`, `www.`, trailing slash to a bare domain.
- **A column that is 100% filled but has 2 distinct values personalises nothing.** Audit field *variety*, not just fill rate. One personalisation variable per email.
- ICP phrases must be true from the company's own site; if unsure mark `NEEDS_REVIEW`, never invent.
- QA gate before upload: no blank required fields, no duplicate emails, exclusion list applied, cap contacts per company.

## 4. Other vendors (V from their own docs, 2026-10-23)

### InboxKit — mailboxes and domains (this is the "$30" from the meeting)
- Auth `Authorization: Bearer <key>`, base `https://api.inboxkit.com`; domain/mailbox calls also need `X-Workspace-Id` (from `GET /v1/api/workspaces/list`).
- **Pricing confirms the founder's number:** an **Azure tenant is $30/month and holds up to 100 mailboxes**. Google/M365 mailboxes are ~$2.50–3.00 each. Warm-up is a $3/mailbox add-on.
- Flow: `GET /v1/api/domains/available` → `POST /v1/api/domains/register` (or `/nameservers` to bring your own) → wait for `active` → `POST /v1/api/mailboxes/buy` `{mailboxes:[{first_name,last_name,username,domain_name,platform: GOOGLE|MICROSOFT|AZURE}], warmup_addon_enabled}` → poll `POST /v1/api/mailboxes/status` → `GET /v1/api/mailboxes/show-credentials`.
- **It automates SPF, DKIM and DMARC**, which removes most of our DNS work.
- **It can push senders straight into EmailBison:** `POST /v1/api/sequencers/add` with `platform:"emailbison"` + `app_url` + `api_key`, then `POST /v1/api/sequencers/export`. That removes hand-wiring senders.
- Limits: one platform per domain; max 5 mailboxes/domain for Google and Microsoft, 100 for Azure; 5,000 req/min.
- Credentials arrive in plaintext on the `mailbox.status_changed` webhook — HTTPS and a signature check are required.

### Prospeo — lead data
- Header `X-KEY`, base `https://api.prospeo.io`, all POST except `GET /account-information` (free; returns remaining credits).
- **The old endpoints are gone.** No `/domain-search` or `/email-finder`. Use `POST /enrich-person` (`{data:{first_name,last_name,company_website}}` or `{data:{linkedin_url}}`), `/bulk-enrich-person` (≤50), `/search-person`, `/search-company`.
- Credits: 1 per email found, 10 per mobile, **nothing charged on a miss**, nothing for re-enriching the same record within 90 days. Search costs 1 credit per 25-result page.
- Rate limits by plan: Starter 5/s and 2,000/day; Growth 5/s and 5,000/day; Pro 30/s. Response headers report what is left.

### TrueList — verification
- Bearer auth, base `https://api.truelist.io`, **10 req/s**.
- Single: `POST /api/v1/verify_inline?email=…` → `{emails:[{address, email_state, email_sub_state, …}]}`.
- `email_state` is `ok` / `risky` / `invalid` / `unknown`; sub-states include `accept_all` (catch-all → treat as risky), `disposable_address`, `role_address`, `failed_no_mailbox`.
- Batch routes exist (`/api/v1/batches`) but **their body fields are not public (U)** — discover with a key.
- Unknown and accept-all results cost 0 credits.

### GetLeads — **a blocker, not a vendor**
Their FAQ states: **"Using the unlimited plan to power your product is not allowed."** Reselling the database needs written agreement. So GetLeads **cannot be the overflow source for a SaaS** without a signed arrangement, and the "no rate limit" claim is false (default 100 req/min). **Action: get written approval or drop the overflow provider and queue against Prospeo's limits.** Flagged for the founder in `docs/HANDOFF.md`.

### Registrars
- **Porkbun is the best fit:** `X-API-Key` + `X-Secret-API-Key`, simple JSON, sandbox, idempotency keys, a default $100/month spend cap. Endpoints `/domain/checkDomain`, `/domain/create`, `/domain/updateNs`, `/dns/create|retrieve|edit|delete`.
- GoDaddy v3 needs a Personal Access Token and a billing method on file; 60 req/min.
- Namecheap requires 20+ domains or $50 spent, plus IP whitelisting.
- **InboxKit registers domains too**, which may make a registrar integration unnecessary for V1.

### "Packsit / Paxit" — unidentified
No vendor by that name exists. The closest match is **Pax8**, a Microsoft CSP distributor, which does not advertise unlimited tenants or cold-email use. **Confirm what was meant before building anything on it.**

### Microsoft 365 mailbox creation (only if we self-provision)
`POST /v1.0/users` then `POST /users/{id}/assignLicense` (app permission `User.ReadWrite.All`); an Exchange Online licence auto-provisions the mailbox. Graph `$batch` caps at 20 requests. Per-mailbox limits: 10,000 recipients/day, 30 messages/min. **Trial tenants are capped at 5,000 external recipients/day.** Microsoft's own guidance says bulk commercial email should go through a third-party provider — a standing policy risk for sending cold email from CSP tenants.

## 5. DNS records per sending domain

InboxKit sets these automatically. If we ever set them ourselves:
- **SPF:** `@ TXT "v=spf1 include:spf.protection.outlook.com -all"` (Microsoft) or `include:_spf.google.com`. One SPF record per domain.
- **DKIM (M365):** two CNAMEs, `selector1._domainkey` and `selector2._domainkey`, pointing at `…_domainkey.<prefix>.<partition>-v1.dkim.mail.microsoft`. **The old `onmicrosoft.com` target is out of date.** Read real values with `Get-DkimSigningConfig`.
- **DMARC:** `_dmarc TXT "v=DMARC1; p=none; rua=mailto:dmarc@example.com; pct=100; adkim=s; aspf=s"`. Start at `p=none`, tighten later.
- **MX:** tenant-specific target from the M365 admin centre. Needed for reply tracking.
- **Tracking:** `POST /api/custom-tracking-domain` in EmailBison, then the CNAME it returns (target **U** — not in the spec).

## 6. Still to discover with keys in hand

| Item | Why it matters |
| --- | --- |
| TrueList `/api/v1/batches` field names | Bulk verification throughput |
| EmailBison `per_page` max, real rate limits, tracking-domain CNAME target | Sync sizing |
| Prospeo company/domain filter names | List building by domain |
| InboxKit `GET /v1/api/sequencers/platforms` field list | Direct sender export to EmailBison |
| GetLeads written SaaS approval | Whether an overflow source exists at all |
| Whether "Packsit" is Pax8 | A whole provisioning path depends on it |

Per the parent repo's F-003: **assert on returned data, not status codes**, and bound every call.

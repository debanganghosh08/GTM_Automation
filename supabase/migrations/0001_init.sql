-- GTM Autopilot — initial schema
-- Target: PostgreSQL 15+ (Supabase-compatible). Runs identically on PGlite for local dev/test.
--
-- Invariants this schema enforces structurally (see docs/SPEC.md §Invariants):
--   I1  Credits are an append-only ledger. There is no mutable balance column anywhere.
--       Balance = SUM(delta). Double-spend is prevented by a unique idempotency key.
--   I2  Every tenant-owned row carries account_id. Every query filters on it.
--   I3  Suppression is checked before any lead enters a campaign (unique index supports it).
--   I4  Stripe webhooks are idempotent via a processed-event table keyed by Stripe's event id.
--   I5  Jobs are idempotent: (type, dedupe_key) is unique among live jobs.

-- gen_random_uuid() is built into PostgreSQL 13+, so pgcrypto is not required.
-- (Requiring it would also break PGlite, which ships no pgcrypto.)

-- ---------------------------------------------------------------- enums

do $$ begin
  create type account_status as enum ('trialing','active','past_due','paused','cancelled');
  create type domain_status as enum ('pending','purchasing','dns_pending','verifying','warming','ready','failed');
  create type mailbox_status as enum ('pending','provisioning','warming','ready','paused','failed');
  create type campaign_status as enum ('draft','awaiting_copy','awaiting_review','pending_approval','approved','building','scheduled','sending','paused','completed','failed');
  create type lead_verification as enum ('unverified','valid','invalid','risky','catch_all','unknown');
  create type send_status as enum ('pending','queued','sent','bounced','replied','unsubscribed','failed','skipped');
  create type reply_sentiment as enum ('interested','not_interested','objection','out_of_office','referral','unsubscribe','unclear');
  create type job_status as enum ('pending','running','succeeded','failed','dead');
  create type approval_status as enum ('pending','approved','rejected');
exception when duplicate_object then null; end $$;

-- ---------------------------------------------------------------- tenancy

create table if not exists accounts (
  id                      uuid primary key default gen_random_uuid(),
  company_name            text not null,
  website_url             text,
  status                  account_status not null default 'trialing',
  -- Sending guardrails. Defaults are deliberately conservative; see docs/SPEC.md §Guardrails.
  daily_send_cap          integer not null default 50 check (daily_send_cap >= 0),
  bounce_pause_threshold  numeric(5,4) not null default 0.03 check (bounce_pause_threshold between 0 and 1),
  first_campaign_approved boolean not null default false,
  sending_paused          boolean not null default false,
  paused_reason           text,
  trial_ends_at           timestamptz,
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now()
);

create table if not exists users (
  id            uuid primary key default gen_random_uuid(),
  account_id    uuid not null references accounts(id) on delete cascade,
  email         text not null,
  password_hash text,
  name          text,
  is_admin      boolean not null default false,
  created_at    timestamptz not null default now()
);
create unique index if not exists users_email_key on users (lower(email));
create index if not exists users_account_idx on users (account_id);

create table if not exists sessions (
  token      text primary key,
  user_id    uuid not null references users(id) on delete cascade,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);
create index if not exists sessions_user_idx on sessions (user_id);

-- ---------------------------------------------------------------- offer / redemption

create table if not exists redemption_codes (
  code            text primary key,
  partner         text not null,
  credits_granted integer not null check (credits_granted > 0),
  trial_days      integer not null default 30 check (trial_days >= 0),
  max_redemptions integer,
  times_redeemed  integer not null default 0,
  expires_at      timestamptz,
  active          boolean not null default true,
  created_at      timestamptz not null default now(),
  constraint redemptions_within_max check (max_redemptions is null or times_redeemed <= max_redemptions)
);

create table if not exists subscriptions (
  id                     uuid primary key default gen_random_uuid(),
  account_id             uuid not null references accounts(id) on delete cascade,
  stripe_customer_id     text,
  stripe_subscription_id text unique,
  price_cents            integer,
  currency               text not null default 'usd',
  status                 text,
  trial_end              timestamptz,
  current_period_end     timestamptz,
  cancel_at_period_end   boolean not null default false,
  redemption_code        text references redemption_codes(code),
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now()
);
create index if not exists subscriptions_account_idx on subscriptions (account_id);

-- I4: Stripe webhook idempotency. Insert-first; a duplicate insert means already processed.
create table if not exists stripe_events (
  id            text primary key,
  type          text not null,
  processed_at  timestamptz not null default now(),
  payload       jsonb
);

-- ---------------------------------------------------------------- onboarding & strategy

create table if not exists onboarding_profiles (
  id              uuid primary key default gen_random_uuid(),
  account_id      uuid not null unique references accounts(id) on delete cascade,
  product         text,
  icp_description text,
  offer           text,
  proof_points    jsonb not null default '[]'::jsonb,
  sending_name    text,
  target_titles   jsonb not null default '[]'::jsonb,
  target_industries jsonb not null default '[]'::jsonb,
  target_geos     jsonb not null default '[]'::jsonb,
  headcount_min   integer,
  headcount_max   integer,
  exclusions      jsonb not null default '[]'::jsonb,
  site_scrape     jsonb,
  completed_at    timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create table if not exists strategies (
  id            uuid primary key default gen_random_uuid(),
  account_id    uuid not null references accounts(id) on delete cascade,
  version       integer not null default 1,
  -- Generated payload conforms to GtmStrategy in src/lib/contracts.ts
  payload       jsonb not null,
  model         text,
  prompt_version text,
  edited_by_user boolean not null default false,
  approved_at   timestamptz,
  created_at    timestamptz not null default now(),
  unique (account_id, version)
);
create index if not exists strategies_account_idx on strategies (account_id);

-- ---------------------------------------------------------------- infrastructure

create table if not exists domains (
  id                uuid primary key default gen_random_uuid(),
  account_id        uuid not null references accounts(id) on delete cascade,
  domain            text not null,
  status            domain_status not null default 'pending',
  source            text not null default 'connected' check (source in ('connected','purchased')),
  registrar         text,
  redirect_to       text,
  dns_records       jsonb not null default '[]'::jsonb,
  dns_verified_at   timestamptz,
  warmup_started_at timestamptz,
  warmup_days       integer not null default 7 check (warmup_days >= 0),
  provider_ref      text,
  error             text,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);
create unique index if not exists domains_domain_key on domains (lower(domain));
create index if not exists domains_account_idx on domains (account_id);

create table if not exists mailboxes (
  id                uuid primary key default gen_random_uuid(),
  account_id        uuid not null references accounts(id) on delete cascade,
  domain_id         uuid not null references domains(id) on delete cascade,
  email             text not null,
  display_name      text,
  status            mailbox_status not null default 'pending',
  provider          text,
  provider_ref      text,
  -- The sender id in the sending platform. NOTE: EmailBison expects these as
  -- `sender_email_ids` when attaching to a campaign, never `email_account_ids`.
  sender_email_id   text,
  warmup_started_at timestamptz,
  daily_cap         integer not null default 20 check (daily_cap >= 0),
  cost_cents        integer not null default 0,
  error             text,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);
create unique index if not exists mailboxes_email_key on mailboxes (lower(email));
create index if not exists mailboxes_account_idx on mailboxes (account_id);
create index if not exists mailboxes_domain_idx on mailboxes (domain_id);

-- ---------------------------------------------------------------- leads

create table if not exists leads (
  id                uuid primary key default gen_random_uuid(),
  account_id        uuid not null references accounts(id) on delete cascade,
  email             text not null,
  first_name        text,
  last_name         text,
  title             text,
  company_name      text,
  company_domain    text,
  linkedin_url      text,
  industry          text,
  headcount         integer,
  country           text,
  source            text,
  signals           jsonb not null default '[]'::jsonb,
  enrichment        jsonb,
  verification      lead_verification not null default 'unverified',
  verified_at       timestamptz,
  cost_cents        integer not null default 0,
  created_at        timestamptz not null default now()
);
-- One row per (account, email): re-sourcing the same person must not duplicate.
create unique index if not exists leads_account_email_key on leads (account_id, lower(email));
create index if not exists leads_account_idx on leads (account_id);
create index if not exists leads_verification_idx on leads (account_id, verification);

-- I3: suppression. account_id NULL = global suppression (applies to every account).
create table if not exists suppressions (
  id         uuid primary key default gen_random_uuid(),
  account_id uuid references accounts(id) on delete cascade,
  email      text,
  domain     text,
  reason     text not null,
  created_at timestamptz not null default now(),
  constraint suppression_target check (email is not null or domain is not null)
);
create unique index if not exists suppressions_email_key
  on suppressions (coalesce(account_id::text,'global'), lower(email)) where email is not null;
create unique index if not exists suppressions_domain_key
  on suppressions (coalesce(account_id::text,'global'), lower(domain)) where domain is not null;

-- ---------------------------------------------------------------- campaigns

create table if not exists campaigns (
  id                uuid primary key default gen_random_uuid(),
  account_id        uuid not null references accounts(id) on delete cascade,
  strategy_id       uuid references strategies(id) on delete set null,
  name              text not null,
  angle             text,
  status            campaign_status not null default 'draft',
  target_lead_count integer not null default 1000 check (target_lead_count >= 0),
  daily_cap         integer not null default 50 check (daily_cap >= 0),
  timezone          text not null default 'UTC',
  send_window_start text not null default '09:00',
  send_window_end   text not null default '17:00',
  send_days         jsonb not null default '["mon","tue","wed","thu","fri"]'::jsonb,
  provider          text,
  provider_ref      text,
  launched_at       timestamptz,
  paused_reason     text,
  error             text,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);
create index if not exists campaigns_account_idx on campaigns (account_id);

create table if not exists campaign_copy (
  id                uuid primary key default gen_random_uuid(),
  campaign_id       uuid not null references campaigns(id) on delete cascade,
  account_id        uuid not null references accounts(id) on delete cascade,
  version           integer not null default 1,
  -- Conforms to CampaignCopy in src/lib/contracts.ts: ordered sequence steps.
  steps             jsonb not null,
  model             text,
  prompt_version    text,
  edited_by_user    boolean not null default false,
  compliance        jsonb,
  compliance_passed boolean not null default false,
  approved_at       timestamptz,
  created_at        timestamptz not null default now(),
  unique (campaign_id, version)
);
create index if not exists campaign_copy_account_idx on campaign_copy (account_id);

create table if not exists campaign_leads (
  id            uuid primary key default gen_random_uuid(),
  campaign_id   uuid not null references campaigns(id) on delete cascade,
  lead_id       uuid not null references leads(id) on delete cascade,
  account_id    uuid not null references accounts(id) on delete cascade,
  status        send_status not null default 'pending',
  personalization jsonb,
  provider_ref  text,
  sent_at       timestamptz,
  bounced_at    timestamptz,
  replied_at    timestamptz,
  created_at    timestamptz not null default now(),
  unique (campaign_id, lead_id)
);
create index if not exists campaign_leads_account_idx on campaign_leads (account_id);
create index if not exists campaign_leads_status_idx on campaign_leads (campaign_id, status);

create table if not exists reply_messages (
  id              uuid primary key default gen_random_uuid(),
  account_id      uuid not null references accounts(id) on delete cascade,
  campaign_id     uuid references campaigns(id) on delete set null,
  lead_id         uuid references leads(id) on delete set null,
  provider_ref    text,
  from_email      text,
  subject         text,
  body_preview    text,
  sentiment       reply_sentiment,
  classified_by   text,
  received_at     timestamptz,
  created_at      timestamptz not null default now()
);
create unique index if not exists reply_messages_provider_key on reply_messages (provider_ref) where provider_ref is not null;
create index if not exists reply_messages_account_idx on reply_messages (account_id);

create table if not exists daily_send_stats (
  id            uuid primary key default gen_random_uuid(),
  account_id    uuid not null references accounts(id) on delete cascade,
  campaign_id   uuid not null references campaigns(id) on delete cascade,
  day           date not null,
  sent          integer not null default 0,
  delivered     integer not null default 0,
  opens         integer not null default 0,
  replies       integer not null default 0,
  bounces       integer not null default 0,
  unsubscribes  integer not null default 0,
  interested    integer not null default 0,
  updated_at    timestamptz not null default now(),
  unique (campaign_id, day)
);
create index if not exists daily_send_stats_account_idx on daily_send_stats (account_id, day);

-- ---------------------------------------------------------------- money

-- I1: append-only credit ledger. Positive delta = grant, negative = spend.
create table if not exists credit_ledger (
  id              uuid primary key default gen_random_uuid(),
  account_id      uuid not null references accounts(id) on delete cascade,
  delta           integer not null check (delta <> 0),
  reason          text not null,
  campaign_id     uuid references campaigns(id) on delete set null,
  idempotency_key text not null,
  metadata        jsonb,
  created_at      timestamptz not null default now()
);
create unique index if not exists credit_ledger_idem_key on credit_ledger (account_id, idempotency_key);
create index if not exists credit_ledger_account_idx on credit_ledger (account_id, created_at);

-- Our own spend per account (lead data, verification, mailboxes). Not customer-visible.
create table if not exists cost_ledger (
  id              uuid primary key default gen_random_uuid(),
  account_id      uuid not null references accounts(id) on delete cascade,
  cost_cents      integer not null,
  category        text not null check (category in ('lead_data','verification','mailbox','domain','llm','other')),
  quantity        integer,
  idempotency_key text not null,
  metadata        jsonb,
  created_at      timestamptz not null default now()
);
create unique index if not exists cost_ledger_idem_key on cost_ledger (account_id, idempotency_key);
create index if not exists cost_ledger_account_idx on cost_ledger (account_id, created_at);

-- ---------------------------------------------------------------- ops

-- I5: idempotent job queue. dedupe_key is unique among non-terminal jobs.
create table if not exists jobs (
  id            uuid primary key default gen_random_uuid(),
  account_id    uuid references accounts(id) on delete cascade,
  type          text not null,
  payload       jsonb not null default '{}'::jsonb,
  status        job_status not null default 'pending',
  dedupe_key    text,
  attempts      integer not null default 0,
  max_attempts  integer not null default 5,
  run_after     timestamptz not null default now(),
  locked_at     timestamptz,
  locked_by     text,
  last_error    text,
  result        jsonb,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create unique index if not exists jobs_dedupe_key on jobs (type, dedupe_key)
  where dedupe_key is not null and status in ('pending','running');
create index if not exists jobs_claim_idx on jobs (status, run_after) where status = 'pending';
create index if not exists jobs_account_idx on jobs (account_id);

create table if not exists approvals (
  id           uuid primary key default gen_random_uuid(),
  account_id   uuid not null references accounts(id) on delete cascade,
  campaign_id  uuid references campaigns(id) on delete cascade,
  kind         text not null,
  status       approval_status not null default 'pending',
  requested_at timestamptz not null default now(),
  decided_at   timestamptz,
  decided_by   uuid references users(id) on delete set null,
  note         text
);
create index if not exists approvals_status_idx on approvals (status, requested_at);
create index if not exists approvals_account_idx on approvals (account_id);

create table if not exists events (
  id          uuid primary key default gen_random_uuid(),
  account_id  uuid references accounts(id) on delete cascade,
  actor       text,
  type        text not null,
  subject     text,
  detail      jsonb,
  created_at  timestamptz not null default now()
);
create index if not exists events_account_idx on events (account_id, created_at desc);
create index if not exists events_type_idx on events (type, created_at desc);

create table if not exists unsubscribes (
  id         uuid primary key default gen_random_uuid(),
  account_id uuid not null references accounts(id) on delete cascade,
  email      text not null,
  campaign_id uuid references campaigns(id) on delete set null,
  token      text,
  created_at timestamptz not null default now()
);
create unique index if not exists unsubscribes_key on unsubscribes (account_id, lower(email));

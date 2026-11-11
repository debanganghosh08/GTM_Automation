-- Security hardening. Adds no product behaviour: rate limiting, login throttling,
-- hashed session storage and the indexes the hot paths need.

-- ---------------------------------------------------------------- rate limiting
--
-- A Postgres-backed fixed-window counter. Chosen over an in-memory limiter because
-- on Vercel every request may hit a different instance, so process-local state
-- cannot limit anything. Chosen over Redis because we already require Postgres and
-- adding a second datastore for this is not worth the operational cost at launch.
--
-- The window is encoded in the primary key, so expiry needs no background job and
-- two concurrent requests cannot both "create" the same window.

create table if not exists rate_limits (
  bucket       text        not null,   -- e.g. 'login:ip:203.0.113.5'
  window_start timestamptz not null,
  hits         integer     not null default 0,
  expires_at   timestamptz not null,
  primary key (bucket, window_start)
);

create index if not exists rate_limits_expiry_idx on rate_limits (expires_at);

comment on table rate_limits is
  'Fixed-window request counters. Rows are disposable; deleting any row only resets a limit.';

-- ---------------------------------------------------------------- login throttling
--
-- Separate from rate_limits because it is keyed on the account being attacked, not
-- on the caller, so a distributed attempt against one email is still slowed down.

create table if not exists login_attempts (
  id          uuid primary key default gen_random_uuid(),
  email       text not null,
  ip          text,
  successful  boolean not null,
  created_at  timestamptz not null default now()
);

create index if not exists login_attempts_email_idx on login_attempts (lower(email), created_at desc);
create index if not exists login_attempts_ip_idx on login_attempts (ip, created_at desc);

comment on table login_attempts is
  'Recent authentication attempts, for lockout decisions and for showing a user their own history.';

-- ---------------------------------------------------------------- session hardening
--
-- Sessions were stored as the raw bearer token, so anyone who could read the table
-- (a backup, a log, a SQL injection elsewhere, a support engineer) held every live
-- session. Store a SHA-256 hash instead and look up by hash; the plaintext never
-- touches the database again.
--
-- Added as nullable so existing rows keep working; the application writes the hash
-- and matches on it. `token` stays for one deploy so sessions are not all dropped,
-- and migration 0004 removes it once traffic has cycled.

alter table sessions add column if not exists token_hash text;
create unique index if not exists sessions_token_hash_key on sessions (token_hash) where token_hash is not null;

-- Absolute expiry independent of the sliding one, so a stolen session cannot be
-- refreshed forever.
alter table sessions add column if not exists absolute_expires_at timestamptz;
alter table sessions add column if not exists last_seen_at timestamptz;
alter table sessions add column if not exists ip text;
alter table sessions add column if not exists user_agent text;

-- ---------------------------------------------------------------- abuse signals
--
-- One row per account per signup source, so repeat abuse from one origin is
-- visible without scanning the whole accounts table.

alter table accounts add column if not exists signup_ip text;
alter table accounts add column if not exists signup_user_agent text;
create index if not exists accounts_signup_ip_idx on accounts (signup_ip, created_at desc);

-- ---------------------------------------------------------------- hot-path indexes
--
-- These match queries that exist today and would table-scan as data grows.

-- Dashboard and stats sync read per campaign, newest first.
create index if not exists daily_send_stats_campaign_day_idx on daily_send_stats (campaign_id, day desc);

-- The ledger balance is SUM(delta) per account: this makes it an index-only scan.
create index if not exists credit_ledger_account_delta_idx on credit_ledger (account_id) include (delta);
create index if not exists cost_ledger_account_cost_idx on cost_ledger (account_id) include (cost_cents);

-- Lead review pages page through one campaign at a time.
create index if not exists campaign_leads_campaign_created_idx on campaign_leads (campaign_id, created_at);

-- Suppression is checked before every upload, by email and by domain.
create index if not exists suppressions_lookup_email_idx on suppressions (lower(email)) where email is not null;
create index if not exists suppressions_lookup_domain_idx on suppressions (lower(domain)) where domain is not null;

-- Reply sync looks up unclassified replies per account.
create index if not exists reply_messages_unclassified_idx on reply_messages (account_id) where sentiment is null;

-- The campaigns list and the guardrail sweep both filter by status.
create index if not exists campaigns_account_status_idx on campaigns (account_id, status);

-- Strategy reads always want the newest version for an account.
create index if not exists strategies_account_version_idx on strategies (account_id, version desc);

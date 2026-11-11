-- Row Level Security, privilege revocation, and the remaining hot-path indexes.
--
-- WHY THIS MATTERS MOST
-- Supabase exposes every table in `public` through PostgREST, and grants the `anon`
-- and `authenticated` roles access by default. The anon key is public by design — it
-- ships in client code. So without RLS, anyone with the project URL and that key can
-- read `users.password_hash` and `sessions`, and write to `credit_ledger` or set
-- `users.is_admin = true`.
--
-- This is not theoretical: it is the documented root cause of the Lovable
-- (CVE-2025-48757) and Moltbook breaches, both AI-built apps that shipped without it.
--
-- Our server connects with a role that bypasses RLS, so enabling it costs nothing
-- functionally and closes the entire client-reachable attack surface. Enabled with no
-- policies means "no access via the API" — exactly what we want, because this app has
-- no client-side database access at all.

-- ---------------------------------------------------------------- enable RLS
do $$
declare t text;
begin
  foreach t in array array[
    'accounts','users','sessions','redemption_codes','subscriptions','stripe_events',
    'onboarding_profiles','strategies','domains','mailboxes','leads','suppressions',
    'campaigns','campaign_copy','campaign_leads','reply_messages','daily_send_stats',
    'credit_ledger','cost_ledger','jobs','approvals','events','unsubscribes',
    'rate_limits','login_attempts','schema_migrations'
  ]
  loop
    if exists (select 1 from information_schema.tables
                where table_schema = 'public' and table_name = t) then
      execute format('alter table public.%I enable row level security', t);
      -- FORCE also applies policies to the table owner, so a mistake in which role
      -- the app connects as cannot silently re-open everything.
      execute format('alter table public.%I force row level security', t);
    end if;
  end loop;
end $$;

-- ---------------------------------------------------------------- revoke API roles
--
-- Belt and braces: even if RLS were disabled on a future table, these roles should
-- hold no grants. Wrapped in a DO block because the roles only exist on Supabase, not
-- on a plain Postgres or the embedded database used in development.
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on all tables in schema public from anon';
    execute 'revoke all on all sequences in schema public from anon';
    execute 'revoke all on all functions in schema public from anon';
    execute 'alter default privileges in schema public revoke all on tables from anon';
    execute 'alter default privileges in schema public revoke all on sequences from anon';
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'revoke all on all tables in schema public from authenticated';
    execute 'revoke all on all sequences in schema public from authenticated';
    execute 'revoke all on all functions in schema public from authenticated';
    execute 'alter default privileges in schema public revoke all on tables from authenticated';
    execute 'alter default privileges in schema public revoke all on sequences from authenticated';
  end if;
end $$;

-- ---------------------------------------------------------------- remaining indexes

-- `verify_leads` filters with `not exists (... cl.lead_id = l.id ...)`, and deleting a
-- lead or an account cascades through this foreign key. Without it both scan.
create index if not exists campaign_leads_lead_idx on campaign_leads (lead_id);

-- The stale-job reaper filters running jobs by lock age every tick. The only existing
-- index covers pending jobs, so this was a sequential scan over a table that only grows.
create index if not exists jobs_reaper_idx on jobs (locked_at) where status = 'running';

-- Suppression is checked before every upload. The queries compare
-- `lower(s.email) = lower(l.email)` and a split_part of the domain, so the index has
-- to match that exact expression or the planner cannot use it.
create index if not exists suppressions_email_expr_idx on suppressions (lower(email));
create index if not exists suppressions_domain_expr_idx on suppressions (lower(domain));

-- Job housekeeping: finished rows are never read again but are scanned by stats.
create index if not exists jobs_cleanup_idx on jobs (status, updated_at)
  where status in ('succeeded', 'failed');

-- ---------------------------------------------------------------- retention
--
-- Nothing deletes finished jobs, old events or expired sessions, so three tables grow
-- without bound. This function is called from the job tick; it is plain SQL so it also
-- works from pg_cron.

create or replace function prune_operational_data(retain_days integer default 30)
returns table (table_name text, rows_deleted bigint)
language plpgsql
as $$
declare
  n bigint;
begin
  delete from sessions where expires_at < now();
  get diagnostics n = row_count;
  table_name := 'sessions'; rows_deleted := n; return next;

  delete from jobs
   where status in ('succeeded', 'failed')
     and updated_at < now() - (retain_days || ' days')::interval;
  get diagnostics n = row_count;
  table_name := 'jobs'; rows_deleted := n; return next;

  delete from rate_limits where expires_at < now() - interval '1 hour';
  get diagnostics n = row_count;
  table_name := 'rate_limits'; rows_deleted := n; return next;

  delete from login_attempts where created_at < now() - interval '30 days';
  get diagnostics n = row_count;
  table_name := 'login_attempts'; rows_deleted := n; return next;

  -- Stripe payloads hold customer email and metadata. The event id is what gives
  -- idempotency, so the payload can go once it is old enough to be useful.
  update stripe_events set payload = null
   where payload is not null and processed_at < now() - interval '14 days';
  get diagnostics n = row_count;
  table_name := 'stripe_events.payload'; rows_deleted := n; return next;
end $$;

comment on function prune_operational_data is
  'Deletes expired sessions, finished jobs, old rate-limit windows and login attempts, '
  'and strips Stripe payloads older than 14 days. Safe to run repeatedly.';

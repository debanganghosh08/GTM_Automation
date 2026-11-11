-- Scheduled work.
--
-- Two options, because the deployment target is not fixed yet:
--
--  A) Vercel Cron (see vercel.json) hits POST /api/jobs/tick with the cron secret.
--     Simplest, and the default. Nothing in this file is needed for it.
--
--  B) Supabase pg_cron calls the same endpoint from the database. Use this when the
--     app is not on Vercel, or when jobs must keep running during a frontend outage.
--
-- Option B is commented out because pg_cron and pg_net must be enabled on the project
-- first, and the secret must not live in a migration. Enable it by hand, per the
-- instructions below.

-- ---------------------------------------------------------------- option B setup
--
-- 1. In the Supabase dashboard enable the `pg_cron` and `pg_net` extensions.
-- 2. Store the endpoint and secret in Vault rather than inline in SQL:
--
--      select vault.create_secret('https://your-app.vercel.app/api/jobs/tick', 'gtm_tick_url');
--      select vault.create_secret('<CRON_SECRET>', 'gtm_cron_secret');
--
-- 3. Then schedule the tick:
--
--      select cron.schedule(
--        'gtm-autopilot-tick',
--        '* * * * *',                   -- every minute; the runner is idempotent
--        $$
--        select net.http_post(
--          url     := (select decrypted_secret from vault.decrypted_secrets where name = 'gtm_tick_url'),
--          headers := jsonb_build_object(
--            'Content-Type', 'application/json',
--            'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'gtm_cron_secret')
--          ),
--          body    := '{}'::jsonb
--        );
--        $$
--      );
--
-- 4. To stop it:  select cron.unschedule('gtm-autopilot-tick');
--
-- Check what is scheduled:  select * from cron.job;
-- Check recent runs:        select * from cron.job_run_details order by start_time desc limit 20;

-- ---------------------------------------------------------------- housekeeping
--
-- These run through the job queue rather than pg_cron, so they work on both
-- deployment options. The view below is for operators looking at a live system.

create or replace view job_queue_health as
select
  type,
  status,
  count(*)                                           as jobs,
  min(run_after)                                     as next_run_at,
  max(attempts)                                      as max_attempts_seen,
  count(*) filter (where status = 'dead')             as dead,
  count(*) filter (where locked_at < now() - interval '15 minutes'
                     and status = 'running')          as stale
from jobs
group by type, status;

comment on view job_queue_health is
  'Per-type queue state. A non-zero "dead" or "stale" count needs a human: see /api/health.';

-- Expired sessions are not worth keeping. Deleted lazily rather than on a timer,
-- so there is no scheduled dependency.
create index if not exists sessions_expiry_idx on sessions (expires_at);

-- Records that a pause actually reached the sending provider.
-- ---------------------------------------------------------------- provider pause
--
-- Records that a pause actually reached the sending provider. Until this is set, a
-- campaign our database calls paused may still be sending, so the guardrail job
-- retries. See src/lib/provider-pause.ts.
alter table campaigns add column if not exists provider_sending_stopped_at timestamptz;

create index if not exists campaigns_pending_provider_stop_idx
  on campaigns (account_id)
  where provider_ref is not null and provider_sending_stopped_at is null;

/**
 * sync_replies — stage 6. Pulls replies since the newest one we hold (the
 * watermark) and inserts them `on conflict (provider_ref) do nothing`, so a
 * re-pull never duplicates. Each reply is linked to the lead by address when
 * one matches on this account. Enqueues classify_replies, and re-enqueues
 * itself hourly while the campaign is sending.
 *
 * Bounded: at most MAX_REPLIES_PER_RUN inserted per run; the rest is reported
 * as truncated and picked up next run by the watermark.
 *
 * Payload: { account_id, campaign_id }
 */

import type { Job, JobResult } from '../../lib/contracts';
import type { JobDeps } from '../registry';
import { HOUR_MS, accountIdOf, done, requireString, terminal, toIso } from './_shared';

export const SYNC_REPLIES_INTERVAL_MS = HOUR_MS;
export const MAX_REPLIES_PER_RUN = 1_000;

export async function syncReplies(job: Job, deps: JobDeps): Promise<JobResult> {
  const accountId = accountIdOf(job);
  if (!accountId) return terminal('no account_id on job');
  const campaignId = requireString(job, 'campaign_id');
  const { db } = deps;

  const campRes = await db.query<{ id: string; status: string; provider_ref: string | null }>(
    `select id, status::text as status, provider_ref from campaigns where id = $1 and account_id = $2`,
    [campaignId, accountId],
  );
  const campaign = campRes.rows[0];
  if (!campaign) return terminal('campaign not found on this account', { campaign_id: campaignId });
  if (!campaign.provider_ref) return terminal('campaign has no provider_ref', { campaign_id: campaignId });

  const wm = await db.query<{ since: Date | string | null }>(
    `select max(received_at) as since from reply_messages where account_id = $1 and campaign_id = $2`,
    [accountId, campaignId],
  );
  const since = toIso(wm.rows[0]?.since ?? null);

  const providers = await deps.providers();
  const replies = await providers.sending.getReplies({ provider_ref: campaign.provider_ref, ...(since ? { since } : {}) });
  const truncated = replies.length > MAX_REPLIES_PER_RUN;
  const batch = replies.slice(0, MAX_REPLIES_PER_RUN);

  let inserted = 0;
  for (const r of batch) {
    if (!r.provider_ref) continue;
    const res = await db.query(
      `insert into reply_messages (account_id, campaign_id, lead_id, provider_ref, from_email, subject, body_preview, received_at)
       select $1::uuid, $2::uuid,
              (select l.id from leads l where l.account_id = $1::uuid and lower(l.email) = lower($4) limit 1),
              $3, $4, $5, $6, $7::timestamptz
       on conflict (provider_ref) where provider_ref is not null do nothing`,
      [accountId, campaignId, r.provider_ref, r.from_email, r.subject, (r.body_preview ?? '').slice(0, 2000) || null, r.received_at],
    );
    inserted += res.rowCount;
  }

  const next: JobResult['next'] = [];
  if (inserted > 0) {
    next.push({ type: 'classify_replies', payload: { account_id: accountId, campaign_id: campaignId }, dedupe_key: `classify_replies:${campaignId}` });
  }
  if (campaign.status === 'sending') {
    next.push({ type: 'sync_replies', payload: { account_id: accountId, campaign_id: campaignId },
      dedupe_key: `sync_replies:${campaignId}`, delay_ms: SYNC_REPLIES_INTERVAL_MS });
  }

  return done({ campaign_id: campaignId, since, fetched: replies.length, inserted, duplicates: batch.length - inserted, truncated }, next);
}

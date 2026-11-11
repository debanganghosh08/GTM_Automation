/**
 * launch_campaign — stage 5, step 5. Re-checks every send gate (the state may
 * have changed since the build), then tells the sending platform to start.
 * Sets status `sending` and `launched_at` (once), and kicks off the hourly
 * stats and reply syncs.
 *
 * Idempotent: a campaign already `sending` is left alone. `sending.launch` on
 * EmailBison is a resume, which is itself repeatable.
 *
 * Payload: { account_id, campaign_id }
 */

import { assertCanSend } from '../../lib/guardrails';
import type { CampaignStatus, Job, JobResult } from '../../lib/contracts';
import type { JobDeps } from '../registry';
import { accountIdOf, done, logEvent, requireString, terminal } from './_shared';

const LAUNCHABLE: ReadonlySet<CampaignStatus> = new Set(['scheduled', 'paused']);

export function syncJobsFor(accountId: string, campaignId: string, delayMs = 0): NonNullable<JobResult['next']> {
  return [
    { type: 'sync_stats', payload: { account_id: accountId, campaign_id: campaignId }, dedupe_key: `sync_stats:${campaignId}`, delay_ms: delayMs },
    { type: 'sync_replies', payload: { account_id: accountId, campaign_id: campaignId }, dedupe_key: `sync_replies:${campaignId}`, delay_ms: delayMs },
  ];
}

export async function launchCampaign(job: Job, deps: JobDeps): Promise<JobResult> {
  const accountId = accountIdOf(job);
  if (!accountId) return terminal('no account_id on job');
  const campaignId = requireString(job, 'campaign_id');
  const { db } = deps;

  const res = await db.query<{ id: string; status: CampaignStatus; provider_ref: string | null }>(
    `select id, status, provider_ref from campaigns where id = $1 and account_id = $2`,
    [campaignId, accountId],
  );
  const campaign = res.rows[0];
  if (!campaign) return terminal('campaign not found on this account', { campaign_id: campaignId });
  if (campaign.status === 'sending') {
    return done({ skipped: 'already sending', campaign_id: campaignId }, syncJobsFor(accountId, campaignId));
  }
  if (!LAUNCHABLE.has(campaign.status)) {
    return terminal(`campaign is ${campaign.status}; only scheduled or paused campaigns launch`, { campaign_id: campaignId });
  }
  if (!campaign.provider_ref) return terminal('campaign has no provider_ref; run build_campaign first', { campaign_id: campaignId });

  const check = await assertCanSend(accountId, campaignId);
  if (!check.allowed) {
    const reason = `launch refused: ${check.reasons.join('; ')}`.slice(0, 2000);
    await db.query(`update campaigns set error = $3, updated_at = now() where id = $1 and account_id = $2`,
      [campaignId, accountId, reason]);
    await logEvent(db, accountId, 'campaign.launch_refused', campaignId, {
      campaign_id: campaignId, reasons: check.reasons, failed_gates: check.failed_gates,
    });
    return terminal('send gates failed', { campaign_id: campaignId, reasons: check.reasons, failed_gates: check.failed_gates });
  }

  const providers = await deps.providers();
  await providers.sending.launch({ provider_ref: campaign.provider_ref });

  await db.query(
    `update campaigns
     set status = 'sending', launched_at = coalesce(launched_at, now()), paused_reason = null, error = null, updated_at = now()
     where id = $1 and account_id = $2`,
    [campaignId, accountId],
  );
  await logEvent(db, accountId, 'campaign.launched', campaignId, { campaign_id: campaignId, provider_ref: campaign.provider_ref, resumed: campaign.status === 'paused' });

  return done({ campaign_id: campaignId, status: 'sending', resumed: campaign.status === 'paused' }, syncJobsFor(accountId, campaignId));
}

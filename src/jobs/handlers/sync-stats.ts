/**
 * sync_stats — stage 6. Pulls cumulative campaign totals from the sending
 * platform, derives today's slice, upserts `daily_send_stats`, then:
 *   1. reconcileSends — the ONLY path that spends send credits (I7). It bills the
 *      delta between today's provider-confirmed sends and what is already billed
 *      for this campaign-day, so a second run on the same numbers writes nothing.
 *   2. enforceGuardrails — pauses the campaign if a pausing gate now fails.
 * Re-enqueues itself hourly while the campaign is sending.
 *
 * Today's numbers = cumulative totals minus the sum of every earlier day's row.
 * That holds as long as earlier rows are never rewritten, which they are not:
 * only today's row is upserted here.
 *
 * Payload: { account_id?, campaign_id? }. With neither, every sending campaign
 * (bounded) is synced; with only account_id, that account's sending campaigns.
 */

import { enforceGuardrails } from '../../lib/guardrails';
import { reconcileSends } from '../../lib/ledger';
import type { Job, JobResult } from '../../lib/contracts';
import type { JobDeps } from '../registry';
import { HOUR_MS, accountIdOf, done, errText, isoDay, logEvent, payloadString } from './_shared';

export const SYNC_STATS_INTERVAL_MS = HOUR_MS;
export const MAX_CAMPAIGNS_PER_RUN = 200;

interface CampaignRow {
  id: string;
  account_id: string;
  status: string;
  provider_ref: string | null;
}

interface Totals { sent: number; delivered: number; opens: number; replies: number; bounces: number; unsubscribes: number; interested: number }
const METRICS = ['sent', 'delivered', 'opens', 'replies', 'bounces', 'unsubscribes', 'interested'] as const;

async function selectCampaigns(deps: JobDeps, accountId: string | null, campaignId: string | null): Promise<CampaignRow[]> {
  const { db } = deps;
  if (campaignId && accountId) {
    const r = await db.query<CampaignRow>(
      `select id, account_id, status::text as status, provider_ref from campaigns where id = $1 and account_id = $2`,
      [campaignId, accountId],
    );
    return r.rows;
  }
  if (accountId) {
    const r = await db.query<CampaignRow>(
      `select id, account_id, status::text as status, provider_ref from campaigns
       where account_id = $1 and status = 'sending' order by created_at limit $2`,
      [accountId, MAX_CAMPAIGNS_PER_RUN],
    );
    return r.rows;
  }
  const r = await db.query<CampaignRow>(
    `select id, account_id, status::text as status, provider_ref from campaigns
     where status = 'sending' order by created_at limit $1`,
    [MAX_CAMPAIGNS_PER_RUN],
  );
  return r.rows;
}

export async function syncOneCampaign(deps: JobDeps, campaign: CampaignRow, today: string): Promise<Record<string, unknown>> {
  const { db } = deps;
  const accountId = campaign.account_id;
  if (!campaign.provider_ref) return { campaign_id: campaign.id, skipped: 'no provider_ref' };

  const providers = await deps.providers();
  const totals = await providers.sending.getStats({ provider_ref: campaign.provider_ref });

  const prior = await db.query<Record<(typeof METRICS)[number], string | number>>(
    `select coalesce(sum(sent),0) as sent, coalesce(sum(delivered),0) as delivered, coalesce(sum(opens),0) as opens,
            coalesce(sum(replies),0) as replies, coalesce(sum(bounces),0) as bounces,
            coalesce(sum(unsubscribes),0) as unsubscribes, coalesce(sum(interested),0) as interested
     from daily_send_stats where account_id = $1 and campaign_id = $2 and day < $3::date`,
    [accountId, campaign.id, today],
  );
  const before = prior.rows[0];
  const todaySlice: Totals = { sent: 0, delivered: 0, opens: 0, replies: 0, bounces: 0, unsubscribes: 0, interested: 0 };
  for (const m of METRICS) {
    const cumulative = Math.max(0, Math.floor(Number(totals[m] ?? 0)));
    const earlier = Number(before?.[m] ?? 0);
    todaySlice[m] = Math.max(0, cumulative - earlier);
  }

  await db.query(
    `insert into daily_send_stats (account_id, campaign_id, day, sent, delivered, opens, replies, bounces, unsubscribes, interested)
     values ($1, $2, $3::date, $4, $5, $6, $7, $8, $9, $10)
     on conflict (campaign_id, day) do update
       set sent = excluded.sent, delivered = excluded.delivered, opens = excluded.opens, replies = excluded.replies,
           bounces = excluded.bounces, unsubscribes = excluded.unsubscribes, interested = excluded.interested,
           updated_at = now()
     where daily_send_stats.account_id = $1`,
    [accountId, campaign.id, today, todaySlice.sent, todaySlice.delivered, todaySlice.opens, todaySlice.replies,
      todaySlice.bounces, todaySlice.unsubscribes, todaySlice.interested],
  );

  // I7: spend only for provider-confirmed sends, keyed per campaign-day.
  const reconciled = await reconcileSends({ accountId, campaignId: campaign.id, day: today, sentCount: todaySlice.sent });
  if (reconciled.shortfall > 0) {
    await logEvent(db, accountId, 'credits.shortfall', campaign.id, {
      campaign_id: campaign.id, day: today, shortfall: reconciled.shortfall, balance_after: reconciled.balance_after,
    });
  }

  const enforced = await enforceGuardrails(accountId);

  return {
    campaign_id: campaign.id,
    day: today,
    cumulative_sent: totals.sent,
    today: todaySlice,
    credits_spent: reconciled.spent,
    billed_after: reconciled.billed_after,
    shortfall: reconciled.shortfall,
    balance_after: reconciled.balance_after,
    guardrails_checked: enforced.checked,
    paused: enforced.paused.map((p) => p.campaign_id),
  };
}

export async function syncStats(job: Job, deps: JobDeps): Promise<JobResult> {
  const accountId = accountIdOf(job);
  const campaignId = payloadString(job, 'campaign_id');
  const today = isoDay();

  const campaigns = await selectCampaigns(deps, accountId, campaignId);
  if (campaignId && campaigns.length === 0) {
    return { ok: false, detail: { reason: 'campaign not found on this account', campaign_id: campaignId } };
  }

  const results: Record<string, unknown>[] = [];
  const errors: Record<string, unknown>[] = [];
  for (const c of campaigns) {
    try {
      results.push(await syncOneCampaign(deps, c, today));
    } catch (err) {
      // One campaign's vendor error must not stall the others. A single-campaign
      // job rethrows so the queue retries it with backoff.
      if (campaignId) throw err;
      errors.push({ campaign_id: c.id, error: errText(err) });
    }
  }

  const next: JobResult['next'] = [];
  if (campaignId && accountId) {
    const still = await deps.db.query<{ status: string }>(
      `select status::text as status from campaigns where id = $1 and account_id = $2`, [campaignId, accountId],
    );
    if (still.rows[0]?.status === 'sending') {
      next.push({ type: 'sync_stats', payload: { account_id: accountId, campaign_id: campaignId },
        dedupe_key: `sync_stats:${campaignId}`, delay_ms: SYNC_STATS_INTERVAL_MS });
    }
  }

  return done({ day: today, synced: results.length, truncated: campaigns.length >= MAX_CAMPAIGNS_PER_RUN, results, errors }, next);
}

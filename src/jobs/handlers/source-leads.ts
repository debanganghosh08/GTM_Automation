/**
 * source_leads — stage 5, step 1. Builds a LeadSearchQuery from the APPROVED
 * strategy, buys leads, filters them against suppressions (I3) BEFORE any row is
 * written, and inserts them `on conflict (account_id, lower(email)) do nothing`.
 *
 * Cost control (brief §7): while the account is trialing, the purchase is capped
 * at env.freeTrialLeadCap minus leads already bought for the account.
 *
 * Overflow: the secondary provider is used ONLY when the primary stops with
 * `rate_limited`. The overflow provider may throw by design (no key yet); that is
 * caught and reported as truncation, never hidden and never fatal.
 *
 * Idempotency: the purchase is keyed to the job id in cost_ledger
 * (`lead_data:job:<id>`). A re-run that finds that key skips the vendor call and
 * only enqueues the next stage, so a crash after buying cannot buy twice.
 *
 * Payload: { account_id, campaign_id, limit? }
 */

import { env } from '../../lib/env';
import { recordCost } from '../../lib/ledger';
import type { GtmStrategy, Job, JobResult, LeadSearchQuery, LeadSearchResult, SourcedLead } from '../../lib/contracts';
import type { JobDeps } from '../registry';
import {
  accountIdOf, done, errText, isSuppressed, loadSuppressions, logEvent, payloadInt, requireString, terminal,
} from './_shared';

/** Rows per insert statement. */
const INSERT_BATCH = 200;
/** Never ask a vendor for more than this in one job, whatever the payload says. */
export const MAX_LEADS_PER_JOB = 10_000;

interface CampaignRow {
  id: string;
  strategy_id: string | null;
  angle: string | null;
  target_lead_count: number;
  account_status: string;
}

interface StrategyRow {
  id: string;
  payload: GtmStrategy;
}

function looksLikeDomain(s: string): boolean {
  return /^[a-z0-9.-]+\.[a-z]{2,}$/i.test(s.trim());
}

export function buildLeadQuery(strategy: GtmStrategy, angle: string | null, limit: number, extraExcludedDomains: string[]): LeadSearchQuery {
  const segment = angle
    ? strategy.segments.find((s) => s.name === angle || s.angle === angle) ?? null
    : null;
  const exclusions = strategy.icp.exclusions.filter(looksLikeDomain).map((d) => d.toLowerCase());
  return {
    titles: strategy.icp.titles,
    industries: strategy.icp.industries,
    geos: strategy.icp.geos,
    headcount_min: strategy.icp.headcount_min,
    headcount_max: strategy.icp.headcount_max,
    signals: segment ? segment.signals : [],
    exclude_domains: [...new Set([...exclusions, ...extraExcludedDomains])],
    limit,
  };
}

async function loadApprovedStrategy(deps: JobDeps, accountId: string, strategyId: string | null): Promise<StrategyRow | null> {
  const res = strategyId
    ? await deps.db.query<StrategyRow>(
        `select id, payload from strategies where id = $1 and account_id = $2 and approved_at is not null`,
        [strategyId, accountId],
      )
    : await deps.db.query<StrategyRow>(
        `select id, payload from strategies where account_id = $1 and approved_at is not null
         order by version desc limit 1`,
        [accountId],
      );
  return res.rows[0] ?? null;
}

export async function sourceLeads(job: Job, deps: JobDeps): Promise<JobResult> {
  const accountId = accountIdOf(job);
  if (!accountId) return terminal('no account_id on job');
  const campaignId = requireString(job, 'campaign_id');
  const { db } = deps;

  const campRes = await db.query<CampaignRow>(
    `select c.id, c.strategy_id, c.angle, c.target_lead_count, a.status::text as account_status
     from campaigns c join accounts a on a.id = c.account_id
     where c.id = $1 and c.account_id = $2`,
    [campaignId, accountId],
  );
  const campaign = campRes.rows[0];
  if (!campaign) return terminal('campaign not found on this account', { campaign_id: campaignId });

  const next: JobResult['next'] = [{
    type: 'verify_leads',
    payload: { account_id: accountId, campaign_id: campaignId },
    dedupe_key: `verify_leads:${campaignId}`,
  }];

  const costKey = `lead_data:job:${job.id}`;
  const already = await db.query<{ quantity: number | null; cost_cents: number }>(
    `select quantity, cost_cents from cost_ledger where account_id = $1 and idempotency_key = $2`,
    [accountId, costKey],
  );
  const prior = already.rows[0];
  if (prior) {
    return done({
      skipped: 'this job already purchased leads',
      campaign_id: campaignId,
      purchased: prior.quantity === null ? null : Number(prior.quantity),
      cost_cents: Number(prior.cost_cents),
    }, next);
  }

  const strategy = await loadApprovedStrategy(deps, accountId, campaign.strategy_id);
  if (!strategy) {
    return terminal('no approved strategy for this account; approve the strategy first', { campaign_id: campaignId });
  }

  // --- limit: requested, then the free-trial cap, then the hard per-job cap.
  const requested = Math.max(0, payloadInt(job, 'limit') ?? Number(campaign.target_lead_count));
  let limit = Math.min(requested, MAX_LEADS_PER_JOB);
  let capApplied: { cap: number; already_purchased: number; remaining: number } | null = null;
  if (campaign.account_status === 'trialing') {
    const bought = await db.query<{ n: string | number }>(
      `select count(*) as n from leads where account_id = $1`,
      [accountId],
    );
    const alreadyPurchased = Number(bought.rows[0]?.n ?? 0);
    const remaining = Math.max(0, env.freeTrialLeadCap - alreadyPurchased);
    capApplied = { cap: env.freeTrialLeadCap, already_purchased: alreadyPurchased, remaining };
    limit = Math.min(limit, remaining);
  }

  const suppressions = await loadSuppressions(db, accountId);
  const query = buildLeadQuery(strategy.payload, campaign.angle, limit, [...suppressions.domains]);

  if (limit <= 0) {
    await recordCost({ accountId, costCents: 0, category: 'lead_data', quantity: 0, idempotencyKey: costKey,
      metadata: { campaign_id: campaignId, reason: 'limit_zero', cap: capApplied } }, db);
    await logEvent(db, accountId, 'leads.cap_reached', campaignId, { campaign_id: campaignId, requested, cap: capApplied });
    return done({ campaign_id: campaignId, requested, limit: 0, purchased: 0, inserted: 0, cap: capApplied,
      stop_reason: 'limit_reached', truncated: requested > 0 }, next);
  }

  // --- primary, then overflow only on rate limit.
  const providers = await deps.providers();
  const primary: LeadSearchResult = await providers.leads.search(query);
  let overflow: LeadSearchResult | null = null;
  let overflowError: string | null = null;
  const sourced: SourcedLead[] = [...primary.leads.slice(0, limit)];
  if (primary.stop_reason === 'rate_limited' && sourced.length < limit) {
    try {
      overflow = await providers.leadsOverflow.search({ ...query, limit: limit - sourced.length });
      sourced.push(...overflow.leads.slice(0, limit - sourced.length));
    } catch (err) {
      overflowError = errText(err);
    }
  }

  // --- I3: suppression filter and in-batch dedupe BEFORE any insert.
  const seen = new Set<string>();
  let suppressed = 0;
  let invalid = 0;
  const keep: SourcedLead[] = [];
  for (const lead of sourced) {
    const email = lead.email?.trim().toLowerCase() ?? '';
    if (!email || !email.includes('@')) { invalid += 1; continue; }
    if (seen.has(email)) continue;
    seen.add(email);
    if (isSuppressed(suppressions, email, lead.company_domain)) { suppressed += 1; continue; }
    keep.push({ ...lead, email });
  }

  const totalCost = Math.max(0, Math.floor(primary.cost_cents)) + Math.max(0, Math.floor(overflow?.cost_cents ?? 0));
  const perLeadCents = sourced.length > 0 ? Math.round(totalCost / sourced.length) : 0;
  const providerNames = overflow ? `${primary.provider}+${overflow.provider}` : primary.provider;

  let inserted = 0;
  for (let i = 0; i < keep.length; i += INSERT_BATCH) {
    const batch = keep.slice(i, i + INSERT_BATCH);
    const values: string[] = [];
    const params: unknown[] = [accountId];
    for (const lead of batch) {
      const base = params.length;
      params.push(
        lead.email, lead.first_name ?? null, lead.last_name ?? null, lead.title ?? null,
        lead.company_name ?? null, lead.company_domain ?? null, lead.linkedin_url ?? null,
        lead.industry ?? null, lead.headcount ?? null, lead.country ?? null, providerNames,
        JSON.stringify(lead.signals ?? []), lead.raw ? JSON.stringify(lead.raw) : null, perLeadCents,
      );
      const p = (n: number) => `$${base + n}`;
      values.push(`($1, ${p(1)}, ${p(2)}, ${p(3)}, ${p(4)}, ${p(5)}, ${p(6)}, ${p(7)}, ${p(8)}, ${p(9)}, ${p(10)}, ${p(11)}, ${p(12)}::jsonb, ${p(13)}::jsonb, ${p(14)})`);
    }
    const res = await db.query(
      `insert into leads (account_id, email, first_name, last_name, title, company_name, company_domain,
                          linkedin_url, industry, headcount, country, source, signals, enrichment, cost_cents)
       values ${values.join(', ')}
       on conflict (account_id, lower(email)) do nothing`,
      params,
    );
    inserted += res.rowCount;
  }

  await recordCost({
    accountId,
    costCents: totalCost,
    category: 'lead_data',
    quantity: sourced.length,
    idempotencyKey: costKey,
    metadata: {
      campaign_id: campaignId, provider: providerNames, requested, limit,
      primary_stop_reason: primary.stop_reason, overflow_stop_reason: overflow?.stop_reason ?? null,
    },
  }, db);

  const truncated = sourced.length < requested;
  const detail = {
    campaign_id: campaignId,
    strategy_id: strategy.id,
    requested,
    limit,
    cap: capApplied,
    purchased: sourced.length,
    suppressed,
    invalid,
    duplicates_in_batch: sourced.length - invalid - suppressed - keep.length,
    inserted,
    already_known: keep.length - inserted,
    cost_cents: totalCost,
    provider: providerNames,
    primary_stop_reason: primary.stop_reason,
    primary_error: primary.error ?? null,
    overflow_used: overflow !== null,
    overflow_stop_reason: overflow?.stop_reason ?? null,
    overflow_error: overflowError,
    truncated,
  };
  await logEvent(db, accountId, 'leads.sourced', campaignId, detail);
  return done(detail, next);
}

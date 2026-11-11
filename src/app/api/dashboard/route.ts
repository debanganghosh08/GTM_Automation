/**
 * GET /api/dashboard — the DashboardSummary contract: account header, credits,
 * every campaign with stats, the least-progressed mailbox warm-up, and totals.
 * A brand-new account gets zeroed stats and `warmup: null`, never an error.
 */

import { getDb } from '@/lib/db';
import { requireUser } from '@/lib/auth';
import { notFound, ok, route, unauthorized } from '@/lib/api';
import { getCreditSummary } from '@/lib/ledger';
import { warmupProgress } from '@/lib/guardrails';
import type { Campaign, CampaignStats, DashboardSummary, WarmupProgress } from '@/lib/contracts';

export const runtime = 'nodejs';

const CAMPAIGN_COLS =
  'id, account_id, strategy_id, name, angle, status, target_lead_count, daily_cap, timezone, ' +
  'send_window_start, send_window_end, send_days, provider, provider_ref, launched_at, paused_reason, error';

interface StatsRow {
  campaign_id: string;
  sent: string | number;
  delivered: string | number;
  opens: string | number;
  replies: string | number;
  bounces: string | number;
  unsubscribes: string | number;
  interested: string | number;
}

interface WarmupRow {
  mailbox_warmup_started_at: Date | string | null;
  domain_warmup_started_at: Date | string | null;
  domain_warmup_days: number;
}

function toStats(campaignId: string, row: StatsRow | undefined): CampaignStats {
  const n = (v: string | number | undefined) => Number(v ?? 0);
  const sent = n(row?.sent);
  return {
    campaign_id: campaignId,
    sent,
    delivered: n(row?.delivered),
    opens: n(row?.opens),
    replies: n(row?.replies),
    bounces: n(row?.bounces),
    unsubscribes: n(row?.unsubscribes),
    interested: n(row?.interested),
    bounce_rate: sent > 0 ? n(row?.bounces) / sent : 0,
    reply_rate: sent > 0 ? n(row?.replies) / sent : 0,
  };
}

function sumStats(all: CampaignStats[]): CampaignStats {
  const t: CampaignStats = {
    campaign_id: 'all', sent: 0, delivered: 0, opens: 0, replies: 0, bounces: 0,
    unsubscribes: 0, interested: 0, bounce_rate: 0, reply_rate: 0,
  };
  for (const s of all) {
    t.sent += s.sent; t.delivered += s.delivered; t.opens += s.opens; t.replies += s.replies;
    t.bounces += s.bounces; t.unsubscribes += s.unsubscribes; t.interested += s.interested;
  }
  t.bounce_rate = t.sent > 0 ? t.bounces / t.sent : 0;
  t.reply_rate = t.sent > 0 ? t.replies / t.sent : 0;
  return t;
}

function latest(a: Date | string | null, b: Date | string | null): Date | null {
  const da = a === null ? null : new Date(a);
  const dbb = b === null ? null : new Date(b);
  if (da === null) return dbb;
  if (dbb === null) return da;
  return da.getTime() >= dbb.getTime() ? da : dbb;
}

/** The slowest warm-up among usable mailboxes: that is the date sending can start. */
function slowestWarmup(rows: WarmupRow[]): WarmupProgress | null {
  let slowest: WarmupProgress | null = null;
  for (const r of rows) {
    const started = latest(r.domain_warmup_started_at, r.mailbox_warmup_started_at);
    const p = warmupProgress({ warmup_started_at: started, warmup_days: Number(r.domain_warmup_days) });
    if (!slowest || p.percent < slowest.percent) slowest = p;
  }
  return slowest;
}

export const GET = route(async (req: Request) => {
  const user = await requireUser(req);
  if (!user) return unauthorized();

  const db = await getDb();
  const [account, credits, campaigns, stats, mailboxes] = await Promise.all([
    db.query<DashboardSummary['account']>(
      `select id, company_name, status, sending_paused, paused_reason, trial_ends_at
       from accounts where id = $1`,
      [user.account_id],
    ),
    getCreditSummary(user.account_id),
    db.query<Campaign>(
      `select ${CAMPAIGN_COLS} from campaigns where account_id = $1 order by created_at desc limit 100`,
      [user.account_id],
    ),
    db.query<StatsRow>(
      `select campaign_id, sum(sent) as sent, sum(delivered) as delivered, sum(opens) as opens,
              sum(replies) as replies, sum(bounces) as bounces, sum(unsubscribes) as unsubscribes,
              sum(interested) as interested
       from daily_send_stats where account_id = $1 group by campaign_id`,
      [user.account_id],
    ),
    db.query<WarmupRow>(
      `select m.warmup_started_at as mailbox_warmup_started_at,
              d.warmup_started_at as domain_warmup_started_at,
              d.warmup_days as domain_warmup_days
       from mailboxes m
       join domains d on d.id = m.domain_id and d.account_id = m.account_id
       where m.account_id = $1 and m.status not in ('failed', 'paused')`,
      [user.account_id],
    ),
  ]);
  const acc = account.rows[0];
  if (!acc) return notFound('Account not found');

  const byCampaign = new Map(stats.rows.map((r) => [r.campaign_id, r]));
  const withStats = campaigns.rows.map((c) => ({ ...c, stats: toStats(c.id, byCampaign.get(c.id)) }));

  const summary: DashboardSummary = {
    account: acc,
    credits,
    campaigns: withStats,
    warmup: slowestWarmup(mailboxes.rows),
    totals: sumStats(withStats.map((c) => c.stats)),
  };
  return ok(summary);
});

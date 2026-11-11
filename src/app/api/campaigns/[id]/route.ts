/**
 * GET /api/campaigns/:id — one campaign with its stats, a first page of leads,
 * the latest copy (with its compliance report), the first-campaign approval, and
 * the full send-gate check from lib/guardrails so the UI can say exactly what
 * still blocks a launch.
 */

import { z } from 'zod';
import { getDb } from '@/lib/db';
import { requireUser } from '@/lib/auth';
import { notFound, ok, route, unauthorized } from '@/lib/api';
import { assertCanSend } from '@/lib/guardrails';
import type { ApprovalStatus, Campaign, CampaignStats, ComplianceReport, CopyStep, Lead, SendStatus } from '@/lib/contracts';

export const runtime = 'nodejs';

type Ctx = { params: Promise<{ id: string }> };

const CAMPAIGN_COLS =
  'id, account_id, strategy_id, name, angle, status, target_lead_count, daily_cap, timezone, ' +
  'send_window_start, send_window_end, send_days, provider, provider_ref, launched_at, paused_reason, error';

const LEAD_COLS =
  'l.id, l.account_id, l.email, l.first_name, l.last_name, l.title, l.company_name, l.company_domain, ' +
  'l.linkedin_url, l.industry, l.headcount, l.country, l.source, l.signals, l.enrichment, l.verification, ' +
  'l.verified_at, l.cost_cents';

const LEAD_PREVIEW = 50;

interface StatsRow {
  sent: string | number;
  delivered: string | number;
  opens: string | number;
  replies: string | number;
  bounces: string | number;
  unsubscribes: string | number;
  interested: string | number;
}

interface CopyRow {
  id: string;
  campaign_id: string;
  version: number;
  steps: CopyStep[];
  model: string | null;
  edited_by_user: boolean;
  compliance: ComplianceReport | null;
  compliance_passed: boolean;
  approved_at: string | null;
  created_at: string;
}

interface ApprovalRow {
  id: string;
  kind: string;
  status: ApprovalStatus;
  requested_at: string;
  decided_at: string | null;
  note: string | null;
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

export const GET = route<Ctx>(async (req: Request, ctx) => {
  const user = await requireUser(req);
  if (!user) return unauthorized();

  const { id } = await ctx.params;
  if (!z.string().uuid().safeParse(id).success) return notFound();

  const db = await getDb();
  const found = await db.query<Campaign>(
    `select ${CAMPAIGN_COLS} from campaigns where id = $1 and account_id = $2`,
    [id, user.account_id],
  );
  const campaign = found.rows[0];
  if (!campaign) return notFound();

  const [stats, leads, leadTotal, copy, approval, gate] = await Promise.all([
    db.query<StatsRow>(
      `select sum(sent) as sent, sum(delivered) as delivered, sum(opens) as opens, sum(replies) as replies,
              sum(bounces) as bounces, sum(unsubscribes) as unsubscribes, sum(interested) as interested
       from daily_send_stats where account_id = $1 and campaign_id = $2`,
      [user.account_id, id],
    ),
    db.query<Lead & { status: SendStatus }>(
      `select ${LEAD_COLS}, cl.status
       from campaign_leads cl
       join leads l on l.id = cl.lead_id and l.account_id = cl.account_id
       where cl.campaign_id = $1 and cl.account_id = $2
       order by cl.created_at asc, l.id asc
       limit $3`,
      [id, user.account_id, LEAD_PREVIEW],
    ),
    db.query<{ n: string | number }>(
      `select count(*) as n from campaign_leads where campaign_id = $1 and account_id = $2`,
      [id, user.account_id],
    ),
    db.query<CopyRow>(
      `select id, campaign_id, version, steps, model, edited_by_user, compliance, compliance_passed,
              approved_at, created_at
       from campaign_copy where campaign_id = $1 and account_id = $2
       order by version desc limit 1`,
      [id, user.account_id],
    ),
    db.query<ApprovalRow>(
      `select id, kind, status, requested_at, decided_at, note
       from approvals where campaign_id = $1 and account_id = $2
       order by requested_at desc limit 1`,
      [id, user.account_id],
    ),
    assertCanSend(user.account_id, id),
  ]);

  return ok({
    campaign,
    stats: toStats(id, stats.rows[0]),
    leads: { items: leads.rows, total: Number(leadTotal.rows[0]?.n ?? 0), preview_limit: LEAD_PREVIEW },
    copy: copy.rows[0] ?? null,
    approval: approval.rows[0] ?? null,
    send_gate: gate,
  });
});

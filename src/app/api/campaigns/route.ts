/**
 * GET  /api/campaigns — the account's campaigns, each with its stats.
 * POST /api/campaigns — create a draft from the approved strategy and enqueue
 *      `source_leads`. The account's first campaign also opens a pending
 *      first-campaign approval so an admin sees it (SPEC §5 gate 5).
 */

import { z } from 'zod';
import { getDb } from '@/lib/db';
import { env } from '@/lib/env';
import { requireUser } from '@/lib/auth';
import { fail, jsonBody, ok, route, unauthorized } from '@/lib/api';
import { enqueue } from '@/jobs/queue';
import type { Campaign, CampaignStats, GtmStrategy } from '@/lib/contracts';

export const runtime = 'nodejs';

const CAMPAIGN_COLS =
  'id, account_id, strategy_id, name, angle, status, target_lead_count, daily_cap, timezone, ' +
  'send_window_start, send_window_end, send_days, provider, provider_ref, launched_at, paused_reason, error';

const DAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const;
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

const Body = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    angle: z.string().trim().max(1000).nullable().optional(),
    /** Index into the strategy's segments; the segment's angle becomes the campaign angle. */
    segment: z.number().int().min(0).max(19).optional(),
    target_lead_count: z.number().int().min(1).max(50_000).optional(),
    daily_cap: z.number().int().min(1).max(5_000).optional(),
    timezone: z.string().trim().min(1).max(64).optional(),
    send_window_start: z.string().regex(HHMM).optional(),
    send_window_end: z.string().regex(HHMM).optional(),
    send_days: z.array(z.enum(DAYS)).min(1).max(7).optional(),
  })
  .strict();

const MAX_CAMPAIGNS_PER_ACCOUNT = 100;

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

export const GET = route(async (req: Request) => {
  const user = await requireUser(req);
  if (!user) return unauthorized();

  const db = await getDb();
  const [campaigns, stats] = await Promise.all([
    db.query<Campaign>(
      `select ${CAMPAIGN_COLS} from campaigns where account_id = $1 order by created_at desc limit $2`,
      [user.account_id, MAX_CAMPAIGNS_PER_ACCOUNT],
    ),
    db.query<StatsRow>(
      `select campaign_id, sum(sent) as sent, sum(delivered) as delivered, sum(opens) as opens,
              sum(replies) as replies, sum(bounces) as bounces, sum(unsubscribes) as unsubscribes,
              sum(interested) as interested
       from daily_send_stats where account_id = $1 group by campaign_id`,
      [user.account_id],
    ),
  ]);
  const byCampaign = new Map(stats.rows.map((r) => [r.campaign_id, r]));
  return ok({
    campaigns: campaigns.rows.map((c) => ({ ...c, stats: toStats(c.id, byCampaign.get(c.id)) })),
  });
});

export const POST = route(async (req: Request) => {
  const user = await requireUser(req);
  if (!user) return unauthorized();

  const raw = (await jsonBody<unknown>(req)) ?? {};
  if (typeof raw !== 'object') return fail('Invalid JSON body', 400, 'invalid_body');
  const parsed = Body.safeParse(raw);
  if (!parsed.success) {
    return fail(parsed.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; '), 400, 'invalid_body');
  }
  const b = parsed.data;

  const db = await getDb();
  const strategy = await db.query<{ id: string; version: number; payload: GtmStrategy }>(
    `select id, version, payload from strategies
     where account_id = $1 and approved_at is not null
     order by version desc limit 1`,
    [user.account_id],
  );
  const approved = strategy.rows[0];
  if (!approved) return fail('Approve a strategy before creating a campaign', 400, 'strategy_not_approved');

  const count = await db.query<{ n: string | number }>(
    `select count(*) as n from campaigns where account_id = $1`, [user.account_id],
  );
  const existing = Number(count.rows[0]?.n ?? 0);
  if (existing >= MAX_CAMPAIGNS_PER_ACCOUNT) {
    return fail(`At most ${MAX_CAMPAIGNS_PER_ACCOUNT} campaigns per account`, 400, 'limit_reached');
  }

  const segment = b.segment !== undefined ? approved.payload.segments?.[b.segment] : undefined;
  if (b.segment !== undefined && !segment) return fail('No such strategy segment', 400, 'invalid_body');

  const account = await db.query<{ status: string; daily_send_cap: number }>(
    `select status::text as status, daily_send_cap from accounts where id = $1`, [user.account_id],
  );
  const acc = account.rows[0];
  // Free-trial cost control: lead purchases are capped until the account pays.
  const requestedLeads = b.target_lead_count ?? 1000;
  const targetLeads = acc?.status === 'trialing' ? Math.min(requestedLeads, env.freeTrialLeadCap) : requestedLeads;

  const name = b.name ?? (segment ? `${segment.name} outreach` : `Campaign ${existing + 1}`);
  const angle = b.angle !== undefined ? b.angle : segment?.angle ?? null;

  const campaign = await db.tx(async (t) => {
    const ins = await t.query<Campaign>(
      `insert into campaigns
         (account_id, strategy_id, name, angle, status, target_lead_count, daily_cap, timezone,
          send_window_start, send_window_end, send_days)
       values ($1, $2, $3, $4, 'draft'::campaign_status, $5, $6, $7, $8, $9, $10::jsonb)
       returning ${CAMPAIGN_COLS}`,
      [
        user.account_id, approved.id, name, angle, targetLeads,
        Math.min(b.daily_cap ?? 50, Number(acc?.daily_send_cap ?? 50)),
        b.timezone ?? 'UTC', b.send_window_start ?? '09:00', b.send_window_end ?? '17:00',
        JSON.stringify(b.send_days ?? ['mon', 'tue', 'wed', 'thu', 'fri']),
      ],
    );
    const row = ins.rows[0]!;

    if (existing === 0) {
      await t.query(
        `insert into approvals (account_id, campaign_id, kind, status)
         values ($1, $2, 'first_campaign', 'pending'::approval_status)`,
        [user.account_id, row.id],
      );
    }
    await t.query(
      `insert into events (account_id, actor, type, subject, detail)
       values ($1, 'customer', 'campaign.created', $2, $3::jsonb)`,
      [user.account_id, row.id, JSON.stringify({
        strategy_version: approved.version,
        target_lead_count: targetLeads,
        lead_cap_applied: targetLeads < requestedLeads,
      })],
    );
    return row;
  });

  const job = await enqueue({
    type: 'source_leads',
    accountId: user.account_id,
    payload: { account_id: user.account_id, campaign_id: campaign.id, limit: targetLeads },
    dedupeKey: `source_leads:${campaign.id}`,
  });

  return ok(
    { campaign: { ...campaign, stats: toStats(campaign.id, undefined) }, job_id: job.id },
    { status: 201 },
  );
});

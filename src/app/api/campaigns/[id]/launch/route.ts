/**
 * POST /api/campaigns/:id/launch — run every sending gate (SPEC §5) and either
 * enqueue `build_campaign` or answer 409 listing EVERY failing reason, so the
 * customer fixes them all at once instead of one per click.
 *
 * The 409 body keeps the ApiResponse envelope (`ok`, `error`, `code`) and adds
 * `reasons` and `failed_gates` so the page can render them individually. The
 * `error` string also carries every reason, for clients that read only that.
 */

import { z } from 'zod';
import { NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { requireUser } from '@/lib/auth';
import { fail, notFound, ok, route, unauthorized } from '@/lib/api';
import { assertCanSend } from '@/lib/guardrails';
import { enqueue } from '@/jobs/queue';
import type { ApiResponse, Campaign } from '@/lib/contracts';

export const runtime = 'nodejs';

type Ctx = { params: Promise<{ id: string }> };

const CAMPAIGN_COLS =
  'id, account_id, strategy_id, name, angle, status, target_lead_count, daily_cap, timezone, ' +
  'send_window_start, send_window_end, send_days, provider, provider_ref, launched_at, paused_reason, error';

/** Statuses from which a launch request makes no sense. */
const NOT_LAUNCHABLE = new Set(['building', 'sending', 'completed']);

export const POST = route<Ctx>(async (req: Request, ctx) => {
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
  if (NOT_LAUNCHABLE.has(campaign.status)) {
    return fail(`Campaign is already ${campaign.status}`, 409, 'campaign_not_launchable');
  }

  const check = await assertCanSend(user.account_id, id);
  if (!check.allowed) {
    const body: ApiResponse<never> & { reasons: string[]; failed_gates: number[] } = {
      ok: false,
      error: `Cannot launch: ${check.reasons.join(' | ')}`,
      code: 'send_blocked',
      reasons: check.reasons,
      failed_gates: check.failed_gates,
    };
    return NextResponse.json(body, { status: 409 });
  }

  const updated = await db.query<Campaign>(
    `update campaigns
     set status = 'building'::campaign_status, paused_reason = null, error = null, updated_at = now()
     where id = $1 and account_id = $2
     returning ${CAMPAIGN_COLS}`,
    [id, user.account_id],
  );
  const job = await enqueue({
    type: 'build_campaign',
    accountId: user.account_id,
    payload: { account_id: user.account_id, campaign_id: id },
    dedupeKey: `build_campaign:${id}`,
  });
  await db.query(
    `insert into events (account_id, actor, type, subject, detail)
     values ($1, 'customer', 'campaign.launch_requested', $2, $3::jsonb)`,
    [user.account_id, id, JSON.stringify({ user_id: user.id, job_id: job.id, deduped: job.deduped })],
  );

  return ok({ campaign: updated.rows[0] ?? campaign, job_id: job.id, deduped: job.deduped }, { status: 202 });
});

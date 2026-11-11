/**
 * POST /api/campaigns/:id/pause — pause a campaign on our side and record an
 * `events` row. The sending module reacts to the status change (same pattern
 * as lib/guardrails); this route never calls the provider itself.
 */

import { z } from 'zod';
import { getDb } from '@/lib/db';
import { requireUser } from '@/lib/auth';
import { fail, jsonBody, notFound, ok, route, unauthorized } from '@/lib/api';
import type { Campaign } from '@/lib/contracts';

export const runtime = 'nodejs';

type Ctx = { params: Promise<{ id: string }> };

const CAMPAIGN_COLS =
  'id, account_id, strategy_id, name, angle, status, target_lead_count, daily_cap, timezone, ' +
  'send_window_start, send_window_end, send_days, provider, provider_ref, launched_at, paused_reason, error';

const Body = z.object({ reason: z.string().trim().min(1).max(500).optional() }).strict();

const TERMINAL = new Set(['completed', 'failed']);

export const POST = route<Ctx>(async (req: Request, ctx) => {
  const user = await requireUser(req);
  if (!user) return unauthorized();

  const { id } = await ctx.params;
  if (!z.string().uuid().safeParse(id).success) return notFound();

  const raw = (await jsonBody<unknown>(req)) ?? {};
  if (typeof raw !== 'object') return fail('Invalid JSON body', 400, 'invalid_body');
  const parsed = Body.safeParse(raw);
  if (!parsed.success) {
    return fail(parsed.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; '), 400, 'invalid_body');
  }
  const reason = parsed.data.reason ?? 'Paused by customer';

  const db = await getDb();
  const found = await db.query<Campaign>(
    `select ${CAMPAIGN_COLS} from campaigns where id = $1 and account_id = $2`,
    [id, user.account_id],
  );
  const campaign = found.rows[0];
  if (!campaign) return notFound();
  if (TERMINAL.has(campaign.status)) {
    return fail(`Campaign is ${campaign.status} and cannot be paused`, 409, 'campaign_not_pausable');
  }
  if (campaign.status === 'paused') return ok({ campaign, changed: false });

  const updated = await db.query<Campaign>(
    `update campaigns set status = 'paused'::campaign_status, paused_reason = $3, updated_at = now()
     where id = $1 and account_id = $2
     returning ${CAMPAIGN_COLS}`,
    [id, user.account_id, reason],
  );
  await db.query(
    `insert into events (account_id, actor, type, subject, detail)
     values ($1, 'customer', 'campaign.paused', $2, $3::jsonb)`,
    [user.account_id, id, JSON.stringify({ reason, user_id: user.id, previous_status: campaign.status })],
  );
  return ok({ campaign: updated.rows[0] ?? campaign, changed: true });
});

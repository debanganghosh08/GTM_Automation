/**
 * POST /api/strategy/approve — stamp approved_at on the latest strategy version.
 * Idempotent: approving an already-approved version keeps the original timestamp.
 */

import { getDb } from '@/lib/db';
import { requireUser } from '@/lib/auth';
import { notFound, ok, route, unauthorized } from '@/lib/api';
import type { GtmStrategy } from '@/lib/contracts';

export const runtime = 'nodejs';

interface StrategyRecord {
  id: string;
  account_id: string;
  version: number;
  payload: GtmStrategy;
  model: string | null;
  edited_by_user: boolean;
  approved_at: string | null;
  created_at: string;
}

export const POST = route(async (req: Request) => {
  const user = await requireUser(req);
  if (!user) return unauthorized();

  const db = await getDb();
  const res = await db.query<StrategyRecord>(
    `update strategies set approved_at = coalesce(approved_at, now())
     where account_id = $1
       and id = (select id from strategies where account_id = $1 order by version desc limit 1)
     returning id, account_id, version, payload, model, edited_by_user, approved_at, created_at`,
    [user.account_id],
  );
  const strategy = res.rows[0];
  if (!strategy) return notFound('No strategy to approve yet');

  await db.query(
    `insert into events (account_id, actor, type, subject, detail)
     values ($1, 'customer', 'strategy.approved', $2, $3::jsonb)`,
    [user.account_id, strategy.id, JSON.stringify({ version: strategy.version, user_id: user.id })],
  );
  return ok({ strategy });
});

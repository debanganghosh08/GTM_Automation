/**
 * POST /api/strategy/generate — enqueue `generate_strategy` for the account.
 * The dedupe key makes a double-click a no-op: the second call returns the
 * existing job's id with `deduped: true` (SPEC §4 I5).
 */

import { getDb } from '@/lib/db';
import { requireUser } from '@/lib/auth';
import { fail, ok, route, unauthorized } from '@/lib/api';
import { enqueue } from '@/jobs/queue';

export const runtime = 'nodejs';

export const POST = route(async (req: Request) => {
  const user = await requireUser(req);
  if (!user) return unauthorized();

  const db = await getDb();
  const profile = await db.query<{ completed_at: Date | string | null }>(
    `select completed_at from onboarding_profiles where account_id = $1`,
    [user.account_id],
  );
  if (!profile.rows[0]?.completed_at) {
    return fail('Complete onboarding before generating a strategy', 400, 'onboarding_incomplete');
  }

  const job = await enqueue({
    type: 'generate_strategy',
    accountId: user.account_id,
    payload: { account_id: user.account_id },
    dedupeKey: `generate_strategy:${user.account_id}`,
  });
  return ok({ job_id: job.id, deduped: job.deduped, generating: true }, { status: 202 });
});

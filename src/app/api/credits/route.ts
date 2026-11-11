/**
 * GET /api/credits?limit= — the credit summary plus the most recent ledger
 * entries. Arithmetic lives in lib/ledger (I1); this route only reads.
 */

import { requireUser } from '@/lib/auth';
import { ok, route, unauthorized } from '@/lib/api';
import { getCreditSummary, listLedger } from '@/lib/ledger';

export const runtime = 'nodejs';

const LIMIT_DEFAULT = 50;
const LIMIT_MAX = 200;

export const GET = route(async (req: Request) => {
  const user = await requireUser(req);
  if (!user) return unauthorized();

  const raw = new URL(req.url).searchParams.get('limit');
  const parsedLimit = raw ? Number.parseInt(raw, 10) : LIMIT_DEFAULT;
  const limit = Number.isFinite(parsedLimit) ? Math.max(1, Math.min(LIMIT_MAX, parsedLimit)) : LIMIT_DEFAULT;

  const [summary, ledger] = await Promise.all([
    getCreditSummary(user.account_id),
    listLedger(user.account_id, limit),
  ]);
  return ok({ summary, ledger, limit });
});

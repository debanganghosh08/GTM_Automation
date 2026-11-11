/**
 * GET /api/admin/accounts — every account with its credit summary (customer
 * facing) and our cost summary (internal). Admin only.
 *
 * Both summaries come from lib/ledger so the arithmetic has one home (I1).
 * Per-account lookups are bounded by LIMIT; the response says when it was cut.
 */

import { getDb } from '@/lib/db';
import { requireUser } from '@/lib/auth';
import { forbidden, ok, route, unauthorized } from '@/lib/api';
import { getCostSummary, getCreditSummary } from '@/lib/ledger';
import type { Account } from '@/lib/contracts';

export const runtime = 'nodejs';

const LIMIT = 200;

type AccountRow = Account & { users: string | number; campaigns: string | number };

export const GET = route(async (req: Request) => {
  const user = await requireUser(req);
  if (!user) return unauthorized();
  if (!user.is_admin) return forbidden();

  const db = await getDb();
  const res = await db.query<AccountRow>(
    `select a.id, a.company_name, a.website_url, a.status, a.daily_send_cap, a.bounce_pause_threshold,
            a.first_campaign_approved, a.sending_paused, a.paused_reason, a.trial_ends_at,
            a.created_at, a.updated_at,
            (select count(*) from users u where u.account_id = a.id) as users,
            (select count(*) from campaigns c where c.account_id = a.id) as campaigns
     from accounts a
     order by a.created_at desc
     limit $1`,
    [LIMIT],
  );

  const accounts = await Promise.all(
    res.rows.map(async (row) => {
      const [credits, cost] = await Promise.all([
        getCreditSummary(row.id, db),
        getCostSummary(row.id, db),
      ]);
      const { users, campaigns, ...account } = row;
      return {
        ...account,
        bounce_pause_threshold: Number(account.bounce_pause_threshold),
        users: Number(users),
        campaigns: Number(campaigns),
        credits,
        cost,
      };
    }),
  );

  return ok({ accounts, limit: LIMIT, truncated: accounts.length === LIMIT });
});

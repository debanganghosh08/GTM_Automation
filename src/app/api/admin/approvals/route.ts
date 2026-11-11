/**
 * GET /api/admin/approvals?status= — approvals across every account, for the
 * admin review queue. Defaults to pending. Admin only (403 otherwise).
 *
 * This is the one place the app reads across tenants on purpose: the reviewer
 * is platform staff. The rows carry the account and campaign names, never
 * credentials, provider refs or raw payloads.
 */

import { z } from 'zod';
import { getDb } from '@/lib/db';
import { requireUser } from '@/lib/auth';
import { forbidden, ok, route, unauthorized } from '@/lib/api';
import type { ApprovalStatus } from '@/lib/contracts';

export const runtime = 'nodejs';

const LIMIT = 200;

interface AdminApprovalRow {
  id: string;
  account_id: string;
  company_name: string;
  campaign_id: string | null;
  campaign_name: string | null;
  campaign_status: string | null;
  kind: string;
  status: ApprovalStatus;
  requested_at: string;
  decided_at: string | null;
  decided_by: string | null;
  note: string | null;
}

const StatusParam = z.enum(['pending', 'approved', 'rejected', 'all']).default('pending');

export const GET = route(async (req: Request) => {
  const user = await requireUser(req);
  if (!user) return unauthorized();
  if (!user.is_admin) return forbidden();

  const parsed = StatusParam.safeParse(new URL(req.url).searchParams.get('status') ?? undefined);
  const status = parsed.success ? parsed.data : 'pending';

  const db = await getDb();
  const res = await db.query<AdminApprovalRow>(
    `select a.id, a.account_id, acc.company_name, a.campaign_id, c.name as campaign_name,
            c.status::text as campaign_status, a.kind, a.status, a.requested_at, a.decided_at,
            a.decided_by, a.note,
            -- The panel has a Leads column and the card tells the reviewer to read the
            -- leads before approving, but this was never selected, so it always showed
            -- a dash. Counted here rather than fetched per row by the client.
            (select count(*) from campaign_leads cl where cl.campaign_id = a.campaign_id)::int as lead_count
     from approvals a
     join accounts acc on acc.id = a.account_id
     left join campaigns c on c.id = a.campaign_id and c.account_id = a.account_id
     where ($1::text = 'all' or a.status::text = $1::text)
     order by a.requested_at asc
     limit $2`,
    [status, LIMIT],
  );
  return ok({ approvals: res.rows, status, limit: LIMIT, truncated: res.rows.length === LIMIT });
});

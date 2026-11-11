/**
 * POST /api/campaigns/:id/approve — admin only. Resolves the first-campaign
 * approval for a campaign on the admin's own account (the cross-account path
 * for platform admins is /api/admin/approvals/:id).
 *
 * A non-admin gets 403. A campaign outside the caller's account is a 404, not a
 * 403, so the response says nothing about whether the id exists elsewhere.
 */

import { z } from 'zod';
import { getDb } from '@/lib/db';
import { requireUser } from '@/lib/auth';
import { fail, forbidden, jsonBody, notFound, ok, route, unauthorized } from '@/lib/api';
import type { ApprovalStatus } from '@/lib/contracts';

export const runtime = 'nodejs';

type Ctx = { params: Promise<{ id: string }> };

const Body = z.object({ note: z.string().trim().max(2000).optional() }).strict();

interface ApprovalRow {
  id: string;
  account_id: string;
  campaign_id: string | null;
  kind: string;
  status: ApprovalStatus;
  requested_at: string;
  decided_at: string | null;
  decided_by: string | null;
  note: string | null;
}

const APPROVAL_COLS = 'id, account_id, campaign_id, kind, status, requested_at, decided_at, decided_by, note';

export const POST = route<Ctx>(async (req: Request, ctx) => {
  const user = await requireUser(req);
  if (!user) return unauthorized();
  if (!user.is_admin) return forbidden();

  const { id } = await ctx.params;
  if (!z.string().uuid().safeParse(id).success) return notFound();

  const raw = (await jsonBody<unknown>(req)) ?? {};
  if (typeof raw !== 'object') return fail('Invalid JSON body', 400, 'invalid_body');
  const parsed = Body.safeParse(raw);
  if (!parsed.success) {
    return fail(parsed.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; '), 400, 'invalid_body');
  }
  const note = parsed.data.note ?? null;

  const db = await getDb();
  const campaign = await db.query<{ id: string; status: string }>(
    `select id, status::text as status from campaigns where id = $1 and account_id = $2`,
    [id, user.account_id],
  );
  if (!campaign.rows[0]) return notFound();

  const approval = await db.tx(async (t) => {
    const pending = await t.query<ApprovalRow>(
      `update approvals
       set status = 'approved'::approval_status, decided_at = now(), decided_by = $3, note = $4
       where campaign_id = $1 and account_id = $2 and status = 'pending'
       returning ${APPROVAL_COLS}`,
      [id, user.account_id, user.id, note],
    );
    let row = pending.rows[0];
    if (!row) {
      const already = await t.query<ApprovalRow>(
        `select ${APPROVAL_COLS} from approvals
         where campaign_id = $1 and account_id = $2 and status = 'approved' limit 1`,
        [id, user.account_id],
      );
      row = already.rows[0];
    }
    if (!row) {
      const created = await t.query<ApprovalRow>(
        `insert into approvals (account_id, campaign_id, kind, status, decided_at, decided_by, note)
         values ($1, $2, 'first_campaign', 'approved'::approval_status, now(), $3, $4)
         returning ${APPROVAL_COLS}`,
        [user.account_id, id, user.id, note],
      );
      row = created.rows[0]!;
    }

    await t.query(
      `update accounts set first_campaign_approved = true, updated_at = now()
       where id = $1 and first_campaign_approved = false`,
      [user.account_id],
    );
    await t.query(
      `update campaigns set status = 'approved'::campaign_status, updated_at = now()
       where id = $1 and account_id = $2 and status = 'pending_approval'`,
      [id, user.account_id],
    );
    await t.query(
      `insert into events (account_id, actor, type, subject, detail)
       values ($1, $2, 'campaign.approved', $3, $4::jsonb)`,
      [user.account_id, `admin:${user.id}`, id, JSON.stringify({ approval_id: row.id, note })],
    );
    return row;
  });

  return ok({ approval });
});

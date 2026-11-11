/**
 * POST /api/admin/approvals/:id  body { decision: 'approve' | 'reject', note? }
 *
 * Admin only. Resolves a pending approval on any account. Approving a
 * first-campaign approval also flips accounts.first_campaign_approved and moves
 * a campaign waiting on it to `approved`; rejecting pauses that campaign with
 * the note as the reason so the customer sees why.
 */

import { z } from 'zod';
import { getDb } from '@/lib/db';
import { requireUser } from '@/lib/auth';
import { fail, forbidden, jsonBody, notFound, ok, route, unauthorized } from '@/lib/api';
import type { ApprovalStatus } from '@/lib/contracts';

export const runtime = 'nodejs';

type Ctx = { params: Promise<{ id: string }> };

const Body = z
  .object({
    decision: z.enum(['approve', 'reject']),
    note: z.string().trim().max(2000).optional(),
  })
  .strict();

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

  const raw = await jsonBody<unknown>(req);
  if (raw === null || typeof raw !== 'object') return fail('Invalid JSON body', 400, 'invalid_body');
  const parsed = Body.safeParse(raw);
  if (!parsed.success) {
    return fail(parsed.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; '), 400, 'invalid_body');
  }
  const { decision } = parsed.data;
  const note = parsed.data.note ?? null;
  if (decision === 'reject' && !note) return fail('A rejection needs a note for the customer', 400, 'note_required');

  const db = await getDb();
  const existing = await db.query<ApprovalRow>(`select ${APPROVAL_COLS} from approvals where id = $1`, [id]);
  const current = existing.rows[0];
  if (!current) return notFound();
  if (current.status !== 'pending') {
    return fail(`Approval was already ${current.status}`, 409, 'already_decided');
  }

  const status: ApprovalStatus = decision === 'approve' ? 'approved' : 'rejected';
  const approval = await db.tx(async (t) => {
    const upd = await t.query<ApprovalRow>(
      `update approvals
       set status = $2::approval_status, decided_at = now(), decided_by = $3, note = $4
       where id = $1 and status = 'pending'
       returning ${APPROVAL_COLS}`,
      [id, status, user.id, note],
    );
    const row = upd.rows[0];
    if (!row) return null;

    if (row.kind === 'first_campaign') {
      if (status === 'approved') {
        await t.query(
          `update accounts set first_campaign_approved = true, updated_at = now()
           where id = $1 and first_campaign_approved = false`,
          [row.account_id],
        );
        if (row.campaign_id) {
          await t.query(
            `update campaigns set status = 'approved'::campaign_status, updated_at = now()
             where id = $1 and account_id = $2 and status = 'pending_approval'`,
            [row.campaign_id, row.account_id],
          );
        }
      } else if (row.campaign_id) {
        await t.query(
          `update campaigns set status = 'paused'::campaign_status, paused_reason = $3, updated_at = now()
           where id = $1 and account_id = $2 and status not in ('completed', 'failed')`,
          [row.campaign_id, row.account_id, `Review rejected: ${note}`],
        );
      }
    }

    await t.query(
      `insert into events (account_id, actor, type, subject, detail)
       values ($1, $2, $3, $4, $5::jsonb)`,
      [row.account_id, `admin:${user.id}`, `approval.${status}`, row.id,
        JSON.stringify({ kind: row.kind, campaign_id: row.campaign_id, note })],
    );
    return row;
  });

  // Lost a race with another admin between the select and the update.
  if (!approval) return fail('Approval was already decided', 409, 'already_decided');
  return ok({ approval });
});

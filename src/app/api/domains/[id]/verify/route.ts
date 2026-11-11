/**
 * POST /api/domains/:id/verify — enqueue `verify_dns` for one of the account's domains.
 * A domain in another tenant (or no domain at all) is a 404, never a 403.
 */

import { z } from 'zod';
import { getDb } from '@/lib/db';
import { requireUser } from '@/lib/auth';
import { notFound, ok, route, unauthorized } from '@/lib/api';
import { enqueue } from '@/jobs/queue';
import type { DomainStatus } from '@/lib/contracts';

export const runtime = 'nodejs';

type Ctx = { params: Promise<{ id: string }> };

export const POST = route<Ctx>(async (req: Request, ctx) => {
  const user = await requireUser(req);
  if (!user) return unauthorized();

  const { id } = await ctx.params;
  if (!z.string().uuid().safeParse(id).success) return notFound();

  const db = await getDb();
  const res = await db.query<{ id: string; status: DomainStatus }>(
    `select id, status from domains where id = $1 and account_id = $2`,
    [id, user.account_id],
  );
  const domain = res.rows[0];
  if (!domain) return notFound();

  if (domain.status === 'pending' || domain.status === 'purchasing') {
    await db.query(
      `update domains set status = 'verifying'::domain_status, updated_at = now()
       where id = $1 and account_id = $2 and status in ('pending', 'purchasing')`,
      [id, user.account_id],
    );
  }

  const job = await enqueue({
    type: 'verify_dns',
    accountId: user.account_id,
    payload: { account_id: user.account_id, domain_id: id },
    dedupeKey: `verify_dns:${id}`,
  });
  return ok({ job_id: job.id, deduped: job.deduped }, { status: 202 });
});

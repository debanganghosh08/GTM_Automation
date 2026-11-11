/**
 * GET  /api/mailboxes — the account's mailboxes, each with warm-up progress.
 * POST /api/mailboxes — request N mailboxes on one of the account's domains
 *      (enqueues `provision_mailboxes`; the route itself provisions nothing).
 *
 * Warm-up uses the same model as lib/guardrails so the UI bar and the send gate
 * can never disagree: the domain carries the duration, and the later of the
 * domain's and the mailbox's start is the clock.
 */

import { z } from 'zod';
import { getDb } from '@/lib/db';
import { requireUser } from '@/lib/auth';
import { fail, jsonBody, notFound, ok, route, unauthorized } from '@/lib/api';
import { warmupProgress } from '@/lib/guardrails';
import { enqueue } from '@/jobs/queue';
import type { Mailbox, WarmupProgress } from '@/lib/contracts';

export const runtime = 'nodejs';

const MAILBOX_COLS =
  'm.id, m.account_id, m.domain_id, m.email, m.display_name, m.status, m.provider, m.provider_ref, ' +
  'm.sender_email_id, m.warmup_started_at, m.daily_cap, m.cost_cents, m.error';

type MailboxRow = Mailbox & {
  domain_warmup_started_at: Date | string | null;
  domain_warmup_days: number;
};

const Body = z
  .object({
    domain_id: z.string().uuid(),
    count: z.number().int().min(1).max(10),
    display_name: z.string().trim().min(1).max(120).optional(),
  })
  .strict();

const MAX_MAILBOXES_PER_ACCOUNT = 50;

function latest(a: Date | string | null, b: Date | string | null): Date | null {
  const da = a === null ? null : new Date(a);
  const dbb = b === null ? null : new Date(b);
  if (da === null) return dbb;
  if (dbb === null) return da;
  return da.getTime() >= dbb.getTime() ? da : dbb;
}

function withWarmup(row: MailboxRow): Mailbox & { warmup: WarmupProgress } {
  const { domain_warmup_started_at, domain_warmup_days, ...mailbox } = row;
  const started = latest(domain_warmup_started_at, mailbox.warmup_started_at);
  const warmup = warmupProgress({ warmup_started_at: started, warmup_days: Number(domain_warmup_days) });
  return { ...mailbox, warmup };
}

export const GET = route(async (req: Request) => {
  const user = await requireUser(req);
  if (!user) return unauthorized();

  const db = await getDb();
  const res = await db.query<MailboxRow>(
    `select ${MAILBOX_COLS},
            d.warmup_started_at as domain_warmup_started_at,
            d.warmup_days as domain_warmup_days
     from mailboxes m
     join domains d on d.id = m.domain_id and d.account_id = m.account_id
     where m.account_id = $1
     order by m.email asc`,
    [user.account_id],
  );
  return ok({ mailboxes: res.rows.map(withWarmup) });
});

export const POST = route(async (req: Request) => {
  const user = await requireUser(req);
  if (!user) return unauthorized();

  const raw = await jsonBody<unknown>(req);
  if (raw === null || typeof raw !== 'object') return fail('Invalid JSON body', 400, 'invalid_body');
  const parsed = Body.safeParse(raw);
  if (!parsed.success) {
    return fail(parsed.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; '), 400, 'invalid_body');
  }
  const { domain_id, count, display_name } = parsed.data;

  const db = await getDb();
  const domain = await db.query<{ id: string; status: string }>(
    `select id, status::text as status from domains where id = $1 and account_id = $2`,
    [domain_id, user.account_id],
  );
  if (!domain.rows[0]) return notFound();
  if (domain.rows[0].status === 'failed') {
    return fail('That domain failed provisioning; fix it before adding mailboxes', 409, 'domain_failed');
  }

  const existing = await db.query<{ n: string | number }>(
    `select count(*) as n from mailboxes where account_id = $1`, [user.account_id],
  );
  if (Number(existing.rows[0]?.n ?? 0) + count > MAX_MAILBOXES_PER_ACCOUNT) {
    return fail(`At most ${MAX_MAILBOXES_PER_ACCOUNT} mailboxes per account`, 400, 'limit_reached');
  }

  const job = await enqueue({
    type: 'provision_mailboxes',
    accountId: user.account_id,
    payload: { account_id: user.account_id, domain_id, count, display_name: display_name ?? null },
    dedupeKey: `provision_mailboxes:${domain_id}`,
  });
  await db.query(
    `insert into events (account_id, actor, type, subject, detail)
     values ($1, 'customer', 'mailboxes.requested', $2, $3::jsonb)`,
    [user.account_id, domain_id, JSON.stringify({ count, deduped: job.deduped })],
  );
  return ok({ job_id: job.id, deduped: job.deduped, requested: count }, { status: 202 });
});

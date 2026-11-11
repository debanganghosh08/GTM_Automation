/**
 * GET  /api/domains — the account's sending domains.
 * POST /api/domains — connect a domain the customer owns, or buy a new one.
 *      Either way the row is created here and `provision_domain` does the work.
 */

import { z } from 'zod';
import { getDb } from '@/lib/db';
import { requireUser } from '@/lib/auth';
import { fail, jsonBody, ok, route, unauthorized } from '@/lib/api';
import { enqueue } from '@/jobs/queue';
import type { Domain } from '@/lib/contracts';

export const runtime = 'nodejs';

/** Public columns only: provider_ref is an opaque vendor id, never a credential. */
const DOMAIN_COLS =
  'id, account_id, domain, status, source, registrar, redirect_to, dns_records, dns_verified_at, ' +
  'warmup_started_at, warmup_days, provider_ref, error';

const DOMAIN_RE = /^(?=.{4,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

const Body = z
  .object({
    domain: z.string().trim().toLowerCase().max(253).regex(DOMAIN_RE, 'Not a valid domain name'),
    mode: z.enum(['connect', 'buy']).default('connect'),
    redirect_to: z.string().trim().url().max(2000).nullable().optional(),
  })
  .strict();

const MAX_DOMAINS_PER_ACCOUNT = 25;

export const GET = route(async (req: Request) => {
  const user = await requireUser(req);
  if (!user) return unauthorized();

  const db = await getDb();
  const res = await db.query<Domain>(
    `select ${DOMAIN_COLS} from domains where account_id = $1 order by created_at asc`,
    [user.account_id],
  );
  return ok({ domains: res.rows });
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
  const { domain, mode, redirect_to } = parsed.data;

  const db = await getDb();
  const count = await db.query<{ n: string | number }>(
    `select count(*) as n from domains where account_id = $1`, [user.account_id],
  );
  if (Number(count.rows[0]?.n ?? 0) >= MAX_DOMAINS_PER_ACCOUNT) {
    return fail(`At most ${MAX_DOMAINS_PER_ACCOUNT} domains per account`, 400, 'limit_reached');
  }

  // The domain index is global (one tenant per domain). A conflict is reported as a
  // plain "taken" without saying who holds it.
  const taken = await db.query<{ account_id: string }>(
    `select account_id from domains where lower(domain) = $1`, [domain],
  );
  if (taken.rows[0]) {
    return fail('That domain is already registered on the platform', 409, 'domain_taken');
  }

  const source = mode === 'buy' ? 'purchased' : 'connected';
  const status = mode === 'buy' ? 'purchasing' : 'pending';
  const res = await db.query<Domain>(
    `insert into domains (account_id, domain, status, source, redirect_to)
     values ($1, $2, $3::domain_status, $4, $5)
     returning ${DOMAIN_COLS}`,
    [user.account_id, domain, status, source, redirect_to ?? null],
  );
  const row = res.rows[0]!;

  const job = await enqueue({
    type: 'provision_domain',
    accountId: user.account_id,
    payload: { account_id: user.account_id, domain_id: row.id },
    dedupeKey: `provision_domain:${row.id}`,
  });
  await db.query(
    `insert into events (account_id, actor, type, subject, detail)
     values ($1, 'customer', 'domain.requested', $2, $3::jsonb)`,
    [user.account_id, row.id, JSON.stringify({ domain, mode })],
  );
  return ok({ domain: row, job_id: job.id }, { status: 201 });
});

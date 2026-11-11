/**
 * GET    /api/campaigns/:id/leads?page=&per_page= — paginated leads on the campaign.
 * DELETE /api/campaigns/:id/leads  body { lead_id } — remove a lead from the
 *        campaign (the lead row itself stays on the account for suppression and
 *        dedupe; only the campaign link is removed).
 */

import { z } from 'zod';
import { getDb } from '@/lib/db';
import { requireUser } from '@/lib/auth';
import { fail, jsonBody, notFound, ok, route, unauthorized } from '@/lib/api';
import type { Lead, SendStatus } from '@/lib/contracts';

export const runtime = 'nodejs';

type Ctx = { params: Promise<{ id: string }> };

const LEAD_COLS =
  'l.id, l.account_id, l.email, l.first_name, l.last_name, l.title, l.company_name, l.company_domain, ' +
  'l.linkedin_url, l.industry, l.headcount, l.country, l.source, l.signals, l.enrichment, l.verification, ' +
  'l.verified_at, l.cost_cents';

const PER_PAGE_DEFAULT = 50;
const PER_PAGE_MAX = 200;

const DeleteBody = z.object({ lead_id: z.string().uuid() }).strict();

async function ownsCampaign(accountId: string, campaignId: string): Promise<boolean> {
  const db = await getDb();
  const res = await db.query<{ id: string }>(
    `select id from campaigns where id = $1 and account_id = $2`, [campaignId, accountId],
  );
  return Boolean(res.rows[0]);
}

function intParam(url: URL, key: string, fallback: number, min: number, max: number): number {
  const raw = url.searchParams.get(key);
  if (raw === null || raw === '') return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

export const GET = route<Ctx>(async (req: Request, ctx) => {
  const user = await requireUser(req);
  if (!user) return unauthorized();

  const { id } = await ctx.params;
  if (!z.string().uuid().safeParse(id).success) return notFound();
  if (!(await ownsCampaign(user.account_id, id))) return notFound();

  const url = new URL(req.url);
  const page = intParam(url, 'page', 1, 1, 100_000);
  const perPage = intParam(url, 'per_page', PER_PAGE_DEFAULT, 1, PER_PAGE_MAX);
  const offset = (page - 1) * perPage;

  const db = await getDb();
  const [items, total] = await Promise.all([
    db.query<Lead & { status: SendStatus; campaign_lead_id: string }>(
      `select ${LEAD_COLS}, cl.status, cl.id as campaign_lead_id
       from campaign_leads cl
       join leads l on l.id = cl.lead_id and l.account_id = cl.account_id
       where cl.campaign_id = $1 and cl.account_id = $2
       order by cl.created_at asc, l.id asc
       limit $3 offset $4`,
      [id, user.account_id, perPage, offset],
    ),
    db.query<{ n: string | number }>(
      `select count(*) as n from campaign_leads where campaign_id = $1 and account_id = $2`,
      [id, user.account_id],
    ),
  ]);
  const count = Number(total.rows[0]?.n ?? 0);
  return ok({
    items: items.rows,
    page,
    per_page: perPage,
    total: count,
    total_pages: Math.max(1, Math.ceil(count / perPage)),
  });
});

export const DELETE = route<Ctx>(async (req: Request, ctx) => {
  const user = await requireUser(req);
  if (!user) return unauthorized();

  const { id } = await ctx.params;
  if (!z.string().uuid().safeParse(id).success) return notFound();
  if (!(await ownsCampaign(user.account_id, id))) return notFound();

  const raw = await jsonBody<unknown>(req);
  if (raw === null || typeof raw !== 'object') return fail('Invalid JSON body', 400, 'invalid_body');
  const parsed = DeleteBody.safeParse(raw);
  if (!parsed.success) {
    return fail(parsed.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; '), 400, 'invalid_body');
  }

  const db = await getDb();
  // A lead already handed to the sending provider cannot be silently unsent here;
  // removing it from a running campaign is a job for the sending module.
  const del = await db.query<{ id: string }>(
    `delete from campaign_leads
     where campaign_id = $1 and account_id = $2 and lead_id = $3
       and status in ('pending', 'skipped')
     returning id`,
    [id, user.account_id, parsed.data.lead_id],
  );
  if (!del.rows[0]) return notFound('Lead is not on this campaign or has already been sent to');

  await db.query(
    `insert into events (account_id, actor, type, subject, detail)
     values ($1, 'customer', 'campaign.lead_removed', $2, $3::jsonb)`,
    [user.account_id, id, JSON.stringify({ lead_id: parsed.data.lead_id, user_id: user.id })],
  );
  return ok({ removed: true, lead_id: parsed.data.lead_id });
});

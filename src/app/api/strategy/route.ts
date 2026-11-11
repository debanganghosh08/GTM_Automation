/**
 * GET /api/strategy — the latest strategy version plus a `generating` flag derived
 *     from a live (pending/running) `scrape_site` or `generate_strategy` job.
 * PUT /api/strategy — save customer edits as a new version with edited_by_user = true.
 *     An edited version is not approved; the customer approves it explicitly.
 */

import { z } from 'zod';
import { getDb } from '@/lib/db';
import { requireUser } from '@/lib/auth';
import { fail, jsonBody, notFound, ok, route, unauthorized } from '@/lib/api';
import type { GtmStrategy } from '@/lib/contracts';

export const runtime = 'nodejs';

interface StrategyRecord {
  id: string;
  account_id: string;
  version: number;
  payload: GtmStrategy;
  model: string | null;
  edited_by_user: boolean;
  approved_at: string | null;
  created_at: string;
}

const STRATEGY_COLS = 'id, account_id, version, payload, model, edited_by_user, approved_at, created_at';

const STR = z.string().max(4000);
const LIST = z.array(z.string().max(400)).max(50);

const StrategySchema = z
  .object({
    positioning: STR,
    icp: z
      .object({
        summary: STR,
        titles: LIST,
        industries: LIST,
        geos: LIST,
        headcount_min: z.number().int().min(0).nullable(),
        headcount_max: z.number().int().min(0).nullable(),
        exclusions: LIST,
      })
      .strict(),
    segments: z
      .array(
        z
          .object({
            name: z.string().max(200),
            description: STR,
            signals: LIST,
            angle: STR,
            estimated_size: z.number().int().min(0).nullable(),
          })
          .strict(),
      )
      .max(20),
    offer: z
      .object({
        headline: z.string().max(400),
        body: STR,
        proof_points: LIST,
        risk_reversal: z.string().max(1000).nullable(),
      })
      .strict(),
    sequence_plan: z
      .array(
        z
          .object({
            step: z.number().int().min(1).max(20),
            delay_days: z.number().int().min(0).max(90),
            purpose: z.string().max(400),
            channel: z.literal('email'),
          })
          .strict(),
      )
      .max(20),
    rationale: STR,
    assumptions: LIST,
  })
  .strict();

const Body = z.object({ payload: StrategySchema }).strict();

async function latestStrategy(accountId: string): Promise<StrategyRecord | null> {
  const db = await getDb();
  const res = await db.query<StrategyRecord>(
    `select ${STRATEGY_COLS} from strategies where account_id = $1 order by version desc limit 1`,
    [accountId],
  );
  return res.rows[0] ?? null;
}

export const GET = route(async (req: Request) => {
  const user = await requireUser(req);
  if (!user) return unauthorized();

  const db = await getDb();
  const [strategy, live] = await Promise.all([
    latestStrategy(user.account_id),
    db.query<{ n: string | number }>(
      `select count(*) as n from jobs
       where account_id = $1 and type in ('scrape_site', 'generate_strategy')
         and status in ('pending', 'running')`,
      [user.account_id],
    ),
  ]);
  return ok({ strategy, generating: Number(live.rows[0]?.n ?? 0) > 0 });
});

export const PUT = route(async (req: Request) => {
  const user = await requireUser(req);
  if (!user) return unauthorized();

  const raw = await jsonBody<unknown>(req);
  if (raw === null || typeof raw !== 'object') return fail('Invalid JSON body', 400, 'invalid_body');
  const parsed = Body.safeParse(raw);
  if (!parsed.success) {
    return fail(parsed.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; '), 400, 'invalid_body');
  }

  const db = await getDb();
  const current = await latestStrategy(user.account_id);
  if (!current) return notFound('No strategy to edit yet');

  const res = await db.query<StrategyRecord>(
    `insert into strategies (account_id, version, payload, model, prompt_version, edited_by_user)
     values ($1, $2, $3::jsonb, $4, 'user-edit', true)
     returning ${STRATEGY_COLS}`,
    [user.account_id, current.version + 1, JSON.stringify(parsed.data.payload), current.model],
  );
  return ok({ strategy: res.rows[0]!, generating: false });
});

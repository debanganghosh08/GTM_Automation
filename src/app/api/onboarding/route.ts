/**
 * GET  /api/onboarding — the account's questionnaire profile (null before first save).
 * POST /api/onboarding — upsert the questionnaire. With `complete: true` it stamps
 *      completed_at and enqueues `scrape_site`, which chains to `generate_strategy`.
 *      An account with no website goes straight to `generate_strategy`.
 *
 * Every query is scoped by the session's account_id (SPEC §4 I2).
 */

import { z } from 'zod';
import { getDb } from '@/lib/db';
import { requireUser } from '@/lib/auth';
import { fail, jsonBody, ok, route, unauthorized } from '@/lib/api';
import { enqueue } from '@/jobs/queue';
import type { JobType, OnboardingProfile } from '@/lib/contracts';

export const runtime = 'nodejs';

const SHORT = z.string().trim().max(200);
const LONG = z.string().trim().max(4000);
const LIST = z.array(z.string().trim().min(1).max(200)).max(50);

const Body = z
  .object({
    product: LONG.nullable().optional(),
    icp_description: LONG.nullable().optional(),
    offer: LONG.nullable().optional(),
    proof_points: LIST.optional(),
    sending_name: SHORT.nullable().optional(),
    target_titles: LIST.optional(),
    target_industries: LIST.optional(),
    target_geos: LIST.optional(),
    headcount_min: z.number().int().min(0).max(10_000_000).nullable().optional(),
    headcount_max: z.number().int().min(0).max(10_000_000).nullable().optional(),
    exclusions: LIST.optional(),
    complete: z.boolean().optional(),
  })
  .strict();

const COLS =
  'id, account_id, product, icp_description, offer, proof_points, sending_name, target_titles, ' +
  'target_industries, target_geos, headcount_min, headcount_max, exclusions, site_scrape, completed_at';

async function loadProfile(accountId: string): Promise<OnboardingProfile | null> {
  const db = await getDb();
  const res = await db.query<OnboardingProfile>(
    `select ${COLS} from onboarding_profiles where account_id = $1`,
    [accountId],
  );
  return res.rows[0] ?? null;
}

export const GET = route(async (req: Request) => {
  const user = await requireUser(req);
  if (!user) return unauthorized();
  return ok({ profile: await loadProfile(user.account_id) });
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
  const b = parsed.data;
  if (b.headcount_min != null && b.headcount_max != null && b.headcount_min > b.headcount_max) {
    return fail('headcount_min cannot exceed headcount_max', 400, 'invalid_body');
  }

  const db = await getDb();
  const existing = await loadProfile(user.account_id);
  const merged = {
    product: b.product !== undefined ? b.product : existing?.product ?? null,
    icp_description: b.icp_description !== undefined ? b.icp_description : existing?.icp_description ?? null,
    offer: b.offer !== undefined ? b.offer : existing?.offer ?? null,
    proof_points: b.proof_points ?? existing?.proof_points ?? [],
    sending_name: b.sending_name !== undefined ? b.sending_name : existing?.sending_name ?? null,
    target_titles: b.target_titles ?? existing?.target_titles ?? [],
    target_industries: b.target_industries ?? existing?.target_industries ?? [],
    target_geos: b.target_geos ?? existing?.target_geos ?? [],
    headcount_min: b.headcount_min !== undefined ? b.headcount_min : existing?.headcount_min ?? null,
    headcount_max: b.headcount_max !== undefined ? b.headcount_max : existing?.headcount_max ?? null,
    exclusions: b.exclusions ?? existing?.exclusions ?? [],
  };

  if (b.complete) {
    const missing = (['product', 'icp_description', 'sending_name'] as const).filter((k) => !merged[k]?.trim());
    if (missing.length > 0) {
      return fail(`Cannot complete onboarding without: ${missing.join(', ')}`, 400, 'incomplete');
    }
  }

  const res = await db.query<OnboardingProfile>(
    `insert into onboarding_profiles
       (account_id, product, icp_description, offer, proof_points, sending_name, target_titles,
        target_industries, target_geos, headcount_min, headcount_max, exclusions, completed_at)
     values ($1, $2, $3, $4, $5::jsonb, $6, $7::jsonb, $8::jsonb, $9::jsonb, $10, $11, $12::jsonb,
             case when $13::boolean then now() else null end)
     on conflict (account_id) do update set
       product = excluded.product,
       icp_description = excluded.icp_description,
       offer = excluded.offer,
       proof_points = excluded.proof_points,
       sending_name = excluded.sending_name,
       target_titles = excluded.target_titles,
       target_industries = excluded.target_industries,
       target_geos = excluded.target_geos,
       headcount_min = excluded.headcount_min,
       headcount_max = excluded.headcount_max,
       exclusions = excluded.exclusions,
       completed_at = case when $13::boolean then now() else onboarding_profiles.completed_at end,
       updated_at = now()
     returning ${COLS}`,
    [
      user.account_id, merged.product, merged.icp_description, merged.offer,
      JSON.stringify(merged.proof_points), merged.sending_name, JSON.stringify(merged.target_titles),
      JSON.stringify(merged.target_industries), JSON.stringify(merged.target_geos),
      merged.headcount_min, merged.headcount_max, JSON.stringify(merged.exclusions), Boolean(b.complete),
    ],
  );
  const profile = res.rows[0]!;

  let queued: JobType | null = null;
  if (b.complete) {
    const acc = await db.query<{ website_url: string | null }>(
      `select website_url from accounts where id = $1`, [user.account_id],
    );
    const url = acc.rows[0]?.website_url?.trim() || null;
    if (url) {
      await enqueue({
        type: 'scrape_site',
        accountId: user.account_id,
        payload: { account_id: user.account_id, url },
        dedupeKey: `scrape_site:${user.account_id}`,
      });
      queued = 'scrape_site';
    } else {
      await enqueue({
        type: 'generate_strategy',
        accountId: user.account_id,
        payload: { account_id: user.account_id },
        dedupeKey: `generate_strategy:${user.account_id}`,
      });
      queued = 'generate_strategy';
    }
    await db.query(
      `insert into events (account_id, actor, type, subject, detail)
       values ($1, 'customer', 'onboarding.completed', $2, $3::jsonb)`,
      [user.account_id, profile.id, JSON.stringify({ queued })],
    );
  }

  return ok({ profile, queued });
});

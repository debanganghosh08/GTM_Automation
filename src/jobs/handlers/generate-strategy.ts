/**
 * generate_strategy — stage 3. Turns onboarding answers + the site scrape into a
 * GtmStrategy via the strategy model and stores it as a new `strategies` version.
 *
 * Idempotent: when a strategy already exists and the onboarding profile has not
 * been edited since it was generated, nothing is called and nothing is written.
 * `payload.force = true` regenerates regardless (the "regenerate" button).
 *
 * The system prompt is read from prompts/strategy/<PROMPT_VERSION>.md at run time
 * and the version is recorded on the row (prompts/README.md).
 */

import { GTM_STRATEGY_SCHEMA } from '../../lib/schemas';
import type { GtmStrategy, Job, JobResult, SiteScrape } from '../../lib/contracts';
import type { JobDeps } from '../registry';
import { accountIdOf, done, logEvent, payloadBool, readPrompt, terminal, toIso } from './_shared';

export const STRATEGY_PROMPT_VERSION = 'v001';

interface ProfileRow {
  product: string | null;
  icp_description: string | null;
  offer: string | null;
  proof_points: unknown;
  sending_name: string | null;
  target_titles: unknown;
  target_industries: unknown;
  target_geos: unknown;
  headcount_min: number | null;
  headcount_max: number | null;
  exclusions: unknown;
  site_scrape: SiteScrape | null;
  updated_at: Date | string;
}

export async function generateStrategy(job: Job, deps: JobDeps): Promise<JobResult> {
  const accountId = accountIdOf(job);
  if (!accountId) return terminal('no account_id on job');
  const { db } = deps;

  const profileRes = await db.query<ProfileRow>(
    `select product, icp_description, offer, proof_points, sending_name, target_titles,
            target_industries, target_geos, headcount_min, headcount_max, exclusions,
            site_scrape, updated_at
     from onboarding_profiles where account_id = $1`,
    [accountId],
  );
  const profile = profileRes.rows[0];
  if (!profile) return terminal('no onboarding profile for account', { account_id: accountId });

  const latest = await db.query<{ id: string; version: number; created_at: Date | string }>(
    `select id, version, created_at from strategies where account_id = $1
     order by version desc limit 1`,
    [accountId],
  );
  const existing = latest.rows[0];
  const profileEditedAt = new Date(profile.updated_at).getTime();
  if (existing && !payloadBool(job, 'force')) {
    const generatedAt = new Date(existing.created_at).getTime();
    if (profileEditedAt <= generatedAt) {
      return done({ skipped: 'strategy is current', strategy_id: existing.id, version: Number(existing.version) });
    }
  }

  const system = await readPrompt('strategy', STRATEGY_PROMPT_VERSION);
  const user = JSON.stringify({
    onboarding: {
      product: profile.product,
      icp_description: profile.icp_description,
      offer: profile.offer,
      proof_points: profile.proof_points ?? [],
      sending_name: profile.sending_name,
      target_titles: profile.target_titles ?? [],
      target_industries: profile.target_industries ?? [],
      target_geos: profile.target_geos ?? [],
      headcount_min: profile.headcount_min,
      headcount_max: profile.headcount_max,
      exclusions: profile.exclusions ?? [],
    },
    site_scrape: profile.site_scrape,
  });

  const providers = await deps.providers();
  const out = await providers.llm.json<GtmStrategy>({
    system,
    user,
    schema_name: 'gtm_strategy',
    schema: GTM_STRATEGY_SCHEMA,
    model: 'strategy',
    cache_system: true,
  });

  // Version is assigned inside the insert so two racing runs cannot pick the same
  // number; the unique (account_id, version) index makes the loser throw and retry,
  // at which point the "is current" check above skips it.
  const inserted = await db.query<{ id: string; version: number }>(
    `insert into strategies (account_id, version, payload, model, prompt_version)
     select $1::uuid, coalesce(max(version), 0) + 1, $2::jsonb, $3, $4
     from strategies where account_id = $1::uuid
     returning id, version`,
    [accountId, JSON.stringify(out.value), out.model, STRATEGY_PROMPT_VERSION],
  );
  const row = inserted.rows[0];
  if (!row) throw new Error('generate_strategy: insert returned no row');

  await logEvent(db, accountId, 'strategy.generated', row.id, {
    version: Number(row.version),
    model: out.model,
    prompt_version: STRATEGY_PROMPT_VERSION,
    input_tokens: out.input_tokens,
    output_tokens: out.output_tokens,
    segments: out.value.segments.length,
    assumptions: out.value.assumptions.length,
    profile_updated_at: toIso(profile.updated_at),
  });

  return done({
    strategy_id: row.id,
    version: Number(row.version),
    model: out.model,
    prompt_version: STRATEGY_PROMPT_VERSION,
    segments: out.value.segments.length,
    input_tokens: out.input_tokens,
    output_tokens: out.output_tokens,
  });
}

/**
 * generate_copy — stage 5, step 3. Writes the three-step sequence with the copy
 * model, runs the compliance checker, and stores a `campaign_copy` version with
 * the report. Either way the campaign goes to `awaiting_review`: a human reads
 * the copy before anything is built. When compliance FAILS the handler stops
 * there, records the errors on the campaign, and never retries into a send; the
 * reviewer fixes the copy by hand (PUT /api/campaigns/:id/copy) and the gate in
 * assertCanSend (gate 3) stays shut until a version passes.
 *
 * Idempotent: an existing copy version for the campaign means no new call unless
 * `payload.force = true`. The system prompt is prompts/copy/<version>.md.
 *
 * Payload: { account_id, campaign_id, force?: boolean }
 */

import { checkCompliance } from '../../lib/compliance';
import { CAMPAIGN_COPY_SCHEMA } from '../../lib/schemas';
import type { CampaignCopy, GtmStrategy, Job, JobResult } from '../../lib/contracts';
import type { JobDeps } from '../registry';
import { accountIdOf, done, logEvent, payloadBool, readPrompt, requireString, terminal } from './_shared';

export const COPY_PROMPT_VERSION = 'v001';

interface CampaignRow {
  id: string;
  name: string;
  angle: string | null;
  strategy_id: string | null;
  status: string;
}

interface ProfileRow {
  product: string | null;
  offer: string | null;
  proof_points: unknown;
  sending_name: string | null;
}

export async function generateCopy(job: Job, deps: JobDeps): Promise<JobResult> {
  const accountId = accountIdOf(job);
  if (!accountId) return terminal('no account_id on job');
  const campaignId = requireString(job, 'campaign_id');
  const { db } = deps;

  const campRes = await db.query<CampaignRow>(
    `select id, name, angle, strategy_id, status::text as status from campaigns where id = $1 and account_id = $2`,
    [campaignId, accountId],
  );
  const campaign = campRes.rows[0];
  if (!campaign) return terminal('campaign not found on this account', { campaign_id: campaignId });

  const latest = await db.query<{ id: string; version: number; compliance_passed: boolean }>(
    `select id, version, compliance_passed from campaign_copy
     where campaign_id = $1 and account_id = $2 order by version desc limit 1`,
    [campaignId, accountId],
  );
  const existing = latest.rows[0];
  if (existing && !payloadBool(job, 'force')) {
    return done({
      skipped: 'copy already exists for this campaign',
      campaign_id: campaignId,
      copy_id: existing.id,
      version: Number(existing.version),
      compliance_passed: existing.compliance_passed,
    });
  }

  const stratRes = campaign.strategy_id
    ? await db.query<{ id: string; payload: GtmStrategy }>(
        `select id, payload from strategies where id = $1 and account_id = $2`,
        [campaign.strategy_id, accountId],
      )
    : await db.query<{ id: string; payload: GtmStrategy }>(
        `select id, payload from strategies where account_id = $1 and approved_at is not null
         order by version desc limit 1`,
        [accountId],
      );
  const strategy = stratRes.rows[0];
  if (!strategy) return terminal('no strategy for this campaign', { campaign_id: campaignId });

  const profRes = await db.query<ProfileRow>(
    `select product, offer, proof_points, sending_name from onboarding_profiles where account_id = $1`,
    [accountId],
  );
  const profile = profRes.rows[0] ?? { product: null, offer: null, proof_points: [], sending_name: null };

  const segment = campaign.angle
    ? strategy.payload.segments.find((s) => s.name === campaign.angle || s.angle === campaign.angle) ?? null
    : null;

  const system = await readPrompt('copy', COPY_PROMPT_VERSION);
  const user = JSON.stringify({
    strategy: strategy.payload,
    segment,
    onboarding: {
      product: profile.product,
      offer: profile.offer,
      proof_points: profile.proof_points ?? [],
      sending_name: profile.sending_name,
    },
    campaign: { name: campaign.name, angle: campaign.angle },
  });

  const providers = await deps.providers();
  const out = await providers.llm.json<CampaignCopy>({
    system,
    user,
    schema_name: 'campaign_copy',
    schema: CAMPAIGN_COPY_SCHEMA,
    model: 'copy',
    cache_system: true,
  });

  const copy: CampaignCopy = { steps: Array.isArray(out.value?.steps) ? out.value.steps : [] };
  const report = checkCompliance(copy, { sendingName: profile.sending_name });

  const ins = await db.query<{ id: string; version: number }>(
    `insert into campaign_copy (campaign_id, account_id, version, steps, model, prompt_version, compliance, compliance_passed)
     select $1::uuid, $2::uuid, coalesce(max(version), 0) + 1, $3::jsonb, $4, $5, $6::jsonb, $7
     from campaign_copy where campaign_id = $1::uuid and account_id = $2::uuid
     returning id, version`,
    [campaignId, accountId, JSON.stringify(copy.steps), out.model, COPY_PROMPT_VERSION, JSON.stringify(report), report.passed],
  );
  const row = ins.rows[0];
  if (!row) throw new Error('generate_copy: insert returned no row');

  const errorSummary = report.passed
    ? null
    : `Copy v${Number(row.version)} failed compliance: ${report.errors.map((e) => `[${e.code}${e.step ? ` step ${e.step}` : ''}] ${e.message}`).join(' ')}`.slice(0, 2000);

  await db.query(
    `update campaigns set status = 'awaiting_review', error = $3, updated_at = now()
     where id = $1 and account_id = $2`,
    [campaignId, accountId, errorSummary],
  );

  const detail = {
    campaign_id: campaignId,
    copy_id: row.id,
    version: Number(row.version),
    model: out.model,
    prompt_version: COPY_PROMPT_VERSION,
    steps: copy.steps.length,
    compliance_passed: report.passed,
    errors: report.errors.map((e) => e.code),
    warnings: report.warnings.length,
    input_tokens: out.input_tokens,
    output_tokens: out.output_tokens,
    status: 'awaiting_review',
    halted: !report.passed,
  };
  await logEvent(db, accountId, report.passed ? 'copy.generated' : 'copy.compliance_failed', campaignId, detail);

  // No `next` in either case: a human reviews the copy before anything is built.
  return done(detail);
}

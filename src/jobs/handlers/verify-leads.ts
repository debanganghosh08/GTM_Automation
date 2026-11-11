/**
 * verify_leads — stage 5, step 2. Verifies every unverified lead on the account
 * in bounded batches, records the verification cost, then attaches deliverable
 * leads to the campaign up to `target_lead_count`.
 *
 * Attach rule: `valid` only. `catch_all` is attached only when the payload says
 * `attach_catch_all: true` (default off: catch-all domains accept everything and
 * bounce later, which is exactly what the bounce guardrail punishes). Leads are
 * filtered against suppressions again at attach time (I3) and never attached to
 * two campaigns.
 *
 * Idempotency: a verified lead is never re-sent to the vendor; attach is
 * `on conflict (campaign_id, lead_id) do nothing`; cost rows are keyed per job
 * and batch.
 *
 * Cost: the VerificationProvider contract returns no price, so the cost row
 * carries the quantity and VERIFICATION_COST_CENTS_PER_EMAIL (0 until the vendor
 * price is wired through the contract). The quantity is what matters for audit.
 *
 * Payload: { account_id, campaign_id, attach_catch_all?: boolean }
 */

import { recordCost } from '../../lib/ledger';
import type { Job, JobResult, LeadVerification } from '../../lib/contracts';
import type { JobDeps } from '../registry';
import { accountIdOf, done, logEvent, notSuppressedSql, payloadBool, requireString, terminal } from './_shared';

export const VERIFY_BATCH = 100;
export const MAX_VERIFY_PER_JOB = 5_000;
export const VERIFICATION_COST_CENTS_PER_EMAIL = 0;

const VERDICTS: ReadonlySet<string> = new Set<LeadVerification>(['unverified', 'valid', 'invalid', 'risky', 'catch_all', 'unknown']);

export async function verifyLeads(job: Job, deps: JobDeps): Promise<JobResult> {
  const accountId = accountIdOf(job);
  if (!accountId) return terminal('no account_id on job');
  const campaignId = requireString(job, 'campaign_id');
  const { db } = deps;
  const attachCatchAll = payloadBool(job, 'attach_catch_all');

  const campRes = await db.query<{ id: string; status: string; target_lead_count: number }>(
    `select id, status::text as status, target_lead_count from campaigns where id = $1 and account_id = $2`,
    [campaignId, accountId],
  );
  const campaign = campRes.rows[0];
  if (!campaign) return terminal('campaign not found on this account', { campaign_id: campaignId });

  // --- verify
  const pending = await db.query<{ id: string; email: string }>(
    `select id, email from leads where account_id = $1 and verification = 'unverified'
     order by created_at asc limit $2`,
    [accountId, MAX_VERIFY_PER_JOB + 1],
  );
  const truncated = pending.rows.length > MAX_VERIFY_PER_JOB;
  const toVerify = pending.rows.slice(0, MAX_VERIFY_PER_JOB);

  const providers = await deps.providers();
  const counts: Record<string, number> = {};
  let verified = 0;
  let batches = 0;
  for (let i = 0; i < toVerify.length; i += VERIFY_BATCH) {
    const batch = toVerify.slice(i, i + VERIFY_BATCH);
    const byEmail = new Map(batch.map((l) => [l.email.toLowerCase(), l.id]));
    const results = await providers.verification.verify(batch.map((l) => l.email));
    for (const r of results) {
      const id = byEmail.get(r.email.toLowerCase());
      if (!id) continue;
      const status: LeadVerification = VERDICTS.has(r.status) ? r.status : 'unknown';
      await db.query(
        `update leads set verification = $3::lead_verification, verified_at = now()
         where id = $1 and account_id = $2`,
        [id, accountId, status],
      );
      counts[status] = (counts[status] ?? 0) + 1;
      verified += 1;
    }
    batches += 1;
    await recordCost({
      accountId,
      costCents: batch.length * VERIFICATION_COST_CENTS_PER_EMAIL,
      category: 'verification',
      quantity: batch.length,
      idempotencyKey: `verification:job:${job.id}:batch:${batches}`,
      metadata: { campaign_id: campaignId, provider: providers.verification.name, batch: batches },
    }, db);
  }

  // --- attach
  const attachedRes = await db.query<{ n: string | number }>(
    `select count(*) as n from campaign_leads where campaign_id = $1 and account_id = $2`,
    [campaignId, accountId],
  );
  const alreadyAttached = Number(attachedRes.rows[0]?.n ?? 0);
  const remaining = Math.max(0, Number(campaign.target_lead_count) - alreadyAttached);
  const allowed: LeadVerification[] = attachCatchAll ? ['valid', 'catch_all'] : ['valid'];
  const allowedSql = allowed.map((v) => `'${v}'`).join(', ');

  let attached = 0;
  if (remaining > 0) {
    const ins = await db.query(
      `insert into campaign_leads (campaign_id, lead_id, account_id)
       select $1::uuid, l.id, $2::uuid
       from leads l
       where l.account_id = $2
         and l.verification in (${allowedSql})
         and not exists (select 1 from campaign_leads cl where cl.lead_id = l.id and cl.account_id = $2)
         and ${notSuppressedSql('l', '$2')}
       order by l.created_at asc
       limit $3
       on conflict (campaign_id, lead_id) do nothing`,
      [campaignId, accountId, remaining],
    );
    attached = ins.rowCount;
  }

  if (campaign.status === 'draft') {
    await db.query(
      `update campaigns set status = 'awaiting_copy', updated_at = now()
       where id = $1 and account_id = $2 and status = 'draft'`,
      [campaignId, accountId],
    );
  }

  const detail = {
    campaign_id: campaignId,
    verified,
    batches,
    counts,
    truncated,
    attach_catch_all: attachCatchAll,
    already_attached: alreadyAttached,
    attached,
    total_attached: alreadyAttached + attached,
    target: Number(campaign.target_lead_count),
  };
  await logEvent(db, accountId, 'leads.verified', campaignId, detail);

  return done(detail, [{
    type: 'generate_copy',
    payload: { account_id: accountId, campaign_id: campaignId },
    dedupe_key: `generate_copy:${campaignId}`,
  }]);
}

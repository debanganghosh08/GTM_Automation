/**
 * enforce_guardrails — runs lib/guardrails.enforceGuardrails for one account
 * (payload.account_id) or, with no account, for every account that has an
 * active campaign (bounded). Pausing is recorded by the library with an
 * events row; this handler only reports what changed.
 *
 * Payload: { account_id? }
 */

import { enforceGuardrails } from '../../lib/guardrails';
import type { Job, JobResult } from '../../lib/contracts';
import type { JobDeps } from '../registry';
import { accountIdOf, done, errText } from './_shared';
import { pauseAccountCampaignsAtProvider } from '../../lib/provider-pause';

export const MAX_ACCOUNTS_PER_RUN = 500;

export async function enforceGuardrailsJob(job: Job, deps: JobDeps): Promise<JobResult> {
  const accountId = accountIdOf(job);

  if (accountId) {
    const r = await enforceGuardrails(accountId);
    // A local pause is only half the job: the campaign is still live at the vendor
    // until this succeeds. Retried by the queue if it fails.
    const stopped = await pauseAccountCampaignsAtProvider(accountId, deps.db);
    return done({ accounts: 1, checked: r.checked, paused: r.paused, provider_stopped: stopped });
  }

  const accounts = await deps.db.query<{ account_id: string }>(
    `select distinct account_id from campaigns where status in ('scheduled', 'sending') limit $1`,
    [MAX_ACCOUNTS_PER_RUN],
  );
  let checked = 0;
  const paused: Array<{ account_id: string; campaign_id: string; reasons: string[] }> = [];
  const providerStopped: Array<{ campaign_id: string; ok: boolean }> = [];
  const errors: Record<string, unknown>[] = [];
  for (const row of accounts.rows) {
    try {
      const r = await enforceGuardrails(row.account_id);
      checked += r.checked;
      for (const p of r.paused) paused.push({ account_id: row.account_id, campaign_id: p.campaign_id, reasons: p.reasons });
      providerStopped.push(...(await pauseAccountCampaignsAtProvider(row.account_id, deps.db)));
    } catch (err) {
      errors.push({ account_id: row.account_id, error: errText(err) });
    }
  }
  return done({ accounts: accounts.rows.length, checked, paused, provider_stopped: providerStopped, errors, truncated: accounts.rows.length >= MAX_ACCOUNTS_PER_RUN });
}

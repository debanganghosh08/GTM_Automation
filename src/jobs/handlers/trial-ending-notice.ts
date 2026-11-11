/**
 * trial_ending_notice — stage 7. Records that the customer's trial is about to
 * end. Writes one `events` row per (account, trial end date); a re-run for the
 * same trial end is a no-op.
 *
 * TODO(email): sending the notice email to the customer is out of scope for this
 * build. When a transactional mail provider lands, send it here and store the
 * message id in the same events row. Until then the row is what the admin view
 * and the dashboard banner read.
 *
 * Payload: { account_id }
 */

import type { Job, JobResult } from '../../lib/contracts';
import type { JobDeps } from '../registry';
import { accountIdOf, done, isoDay, logEvent, terminal } from './_shared';

export const TRIAL_NOTICE_EVENT = 'trial.ending_notice';

export async function trialEndingNotice(job: Job, deps: JobDeps): Promise<JobResult> {
  const accountId = accountIdOf(job);
  if (!accountId) return terminal('no account_id on job');
  const { db } = deps;

  const res = await db.query<{ id: string; status: string; trial_ends_at: Date | string | null; company_name: string }>(
    `select id, status::text as status, trial_ends_at, company_name from accounts where id = $1`,
    [accountId],
  );
  const account = res.rows[0];
  if (!account) return terminal('account not found', { account_id: accountId });
  if (!account.trial_ends_at) return done({ skipped: 'account has no trial end date', account_id: accountId });

  const trialEnds = new Date(account.trial_ends_at);
  const endsDay = isoDay(trialEnds);

  const existing = await db.query<{ id: string }>(
    `select id from events where account_id = $1 and type = $2 and detail->>'trial_ends_day' = $3 limit 1`,
    [accountId, TRIAL_NOTICE_EVENT, endsDay],
  );
  if (existing.rows[0]) {
    return done({ skipped: 'notice already recorded', account_id: accountId, event_id: existing.rows[0].id, trial_ends_day: endsDay });
  }

  const daysLeft = Math.ceil((trialEnds.getTime() - Date.now()) / 86_400_000);
  await logEvent(db, accountId, TRIAL_NOTICE_EVENT, accountId, {
    trial_ends_at: trialEnds.toISOString(),
    trial_ends_day: endsDay,
    days_left: daysLeft,
    account_status: account.status,
    email_sent: false, // TODO(email): flip when the customer email goes out.
  });

  return done({ account_id: accountId, trial_ends_day: endsDay, days_left: daysLeft, email_sent: false });
}

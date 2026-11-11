/**
 * Propagating a pause to the sending provider.
 *
 * Pausing previously only set `accounts.sending_paused` and the campaign status in
 * our database. The campaign kept running at EmailBison, so a cancelled subscription,
 * a failed payment, an exhausted credit balance or a tripped bounce threshold all
 * stopped the bookkeeping while the email kept going out. That is both unbilled
 * sending and a reputation risk on shared infrastructure.
 *
 * This closes that gap. It adds no new product behaviour: it makes the existing
 * pause mean what the rest of the system already assumes it means.
 *
 * Called from the `enforce_guardrails` job rather than inline from a webhook, so a
 * slow or failing vendor cannot make a Stripe webhook time out, and so a failure is
 * retried by the queue.
 */

import type { Db } from './db';
import { getDb } from './db';
import { getSendingProvider } from '../providers';

export interface PausedAtProvider {
  campaign_id: string;
  provider_ref: string;
  ok: boolean;
  error?: string;
}

/** How many campaigns one run will try to pause, so a huge account cannot hang a job. */
const MAX_PER_RUN = 50;

/**
 * Pauses, at the provider, every campaign for this account that our database says
 * should not be sending. Idempotent: pausing an already-paused campaign is a no-op
 * at the vendor and here.
 */
export async function pauseAccountCampaignsAtProvider(
  accountId: string,
  dbOverride?: Db,
): Promise<PausedAtProvider[]> {
  const db = dbOverride ?? (await getDb());

  // Campaigns that still have a live provider campaign but must not be sending:
  // either the whole account is paused, or the campaign itself was paused locally.
  const rows = await db.query<{ id: string; provider_ref: string }>(
    `select c.id, c.provider_ref
       from campaigns c
       join accounts a on a.id = c.account_id
      where c.account_id = $1
        and c.provider_ref is not null
        and c.provider_sending_stopped_at is null
        and (a.sending_paused = true or c.status = 'paused')
      limit $2`,
    [accountId, MAX_PER_RUN],
  );
  if (rows.rows.length === 0) return [];

  const sending = await getSendingProvider();
  const results: PausedAtProvider[] = [];

  for (const row of rows.rows) {
    try {
      await sending.pause({ provider_ref: row.provider_ref });
      // Recorded so a later run does not call the vendor again, and so an operator
      // can see that the stop actually reached the provider.
      await db.query(
        `update campaigns set provider_sending_stopped_at = now(), updated_at = now() where id = $1`,
        [row.id],
      );
      await db.query(
        `insert into events (account_id, actor, type, subject, detail)
         values ($1, 'system:guardrails', 'campaign.paused_at_provider', $2, $3)`,
        [accountId, row.id, JSON.stringify({ provider_ref: row.provider_ref })],
      );
      results.push({ campaign_id: row.id, provider_ref: row.provider_ref, ok: true });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // Left unmarked so the next run retries. Loud, because until this succeeds the
      // campaign is still sending.
      console.error(`[provider-pause] FAILED to stop campaign ${row.id} at the provider: ${message}`);
      await db.query(
        `insert into events (account_id, actor, type, subject, detail)
         values ($1, 'system:guardrails', 'campaign.pause_at_provider_failed', $2, $3)`,
        [accountId, row.id, JSON.stringify({ error: message.slice(0, 500) })],
      );
      results.push({ campaign_id: row.id, provider_ref: row.provider_ref, ok: false, error: message });
    }
  }

  return results;
}

/**
 * Clears the stopped marker when an account is allowed to send again, so a later
 * pause will call the provider afresh. Does NOT resume anything at the vendor:
 * resuming is an explicit customer action through the launch route.
 */
export async function clearProviderStopMarker(accountId: string, dbOverride?: Db): Promise<void> {
  const db = dbOverride ?? (await getDb());
  await db.query(
    `update campaigns set provider_sending_stopped_at = null
      where account_id = $1 and provider_sending_stopped_at is not null`,
    [accountId],
  );
}

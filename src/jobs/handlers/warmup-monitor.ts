/**
 * warmup_monitor — stage 4, step 4. Polls the mailbox provider for each mailbox
 * on a domain and flips a mailbox to `ready` only when BOTH the provider reports
 * it ready AND the warm-up window (lib/warmup.ts) has elapsed. Warm-up is
 * `domains.warmup_days` from the later of the domain's and the mailbox's start,
 * which matches the ramp in lib/guardrails.ts so the two never disagree.
 *
 * Re-enqueues itself daily until every mailbox on the domain is ready or failed,
 * then marks the domain `ready`. Bounded: at most MAX_POLLS mailboxes per run.
 *
 * Payload: { account_id, domain_id }
 */

import { warmupProgress } from '../../lib/warmup';
import type { DomainStatus, Job, JobResult, MailboxStatus } from '../../lib/contracts';
import type { JobDeps } from '../registry';
import { DAY_MS, accountIdOf, done, errText, logEvent, requireString, terminal, toIso } from './_shared';

export const WARMUP_POLL_INTERVAL_MS = DAY_MS;
export const MAX_POLLS = 100;

interface DomainRow {
  id: string;
  status: DomainStatus;
  warmup_started_at: Date | string | null;
  warmup_days: number;
}

interface MailboxRow {
  id: string;
  status: MailboxStatus;
  provider_ref: string | null;
  warmup_started_at: Date | string | null;
}

function later(a: Date | string | null, b: Date | string | null): string | null {
  const ia = toIso(a);
  const ib = toIso(b);
  if (ia === null) return ib;
  if (ib === null) return ia;
  return ia >= ib ? ia : ib;
}

export async function warmupMonitor(job: Job, deps: JobDeps): Promise<JobResult> {
  const accountId = accountIdOf(job);
  if (!accountId) return terminal('no account_id on job');
  const domainId = requireString(job, 'domain_id');
  const { db } = deps;
  const now = new Date();

  const domRes = await db.query<DomainRow>(
    `select id, status, warmup_started_at, warmup_days from domains where id = $1 and account_id = $2`,
    [domainId, accountId],
  );
  const domain = domRes.rows[0];
  if (!domain) return terminal('domain not found on this account', { domain_id: domainId });
  if (domain.status === 'failed') return terminal('domain is marked failed', { domain_id: domainId });

  const boxes = await db.query<MailboxRow>(
    `select id, status, provider_ref, warmup_started_at from mailboxes
     where domain_id = $1 and account_id = $2 and status not in ('failed', 'paused')
     order by created_at`,
    [domainId, accountId],
  );
  const toPoll = boxes.rows.slice(0, MAX_POLLS);
  const truncated = boxes.rows.length > toPoll.length;

  const providers = await deps.providers();
  const counts: Record<string, number> = { ready: 0, warming: 0, provisioning: 0, pending: 0, failed: 0 };
  let polled = 0;

  for (const box of toPoll) {
    let providerStatus: MailboxStatus = box.status;
    let providerError: string | null = null;
    if (box.provider_ref && box.status !== 'ready') {
      try {
        const s = await providers.mailboxes.getStatus({ provider_ref: box.provider_ref });
        providerStatus = s.status;
        providerError = s.error ?? null;
        polled += 1;
      } catch (err) {
        providerError = errText(err);
        providerStatus = box.status;
      }
    }

    const warmup = warmupProgress({
      startedAt: later(domain.warmup_started_at, box.warmup_started_at),
      days: Number(domain.warmup_days),
      now,
    });

    let nextStatus: MailboxStatus;
    if (providerStatus === 'failed') nextStatus = 'failed';
    else if (providerStatus === 'ready' && warmup.complete) nextStatus = 'ready';
    else if (providerStatus === 'ready' || providerStatus === 'warming') nextStatus = 'warming';
    else nextStatus = providerStatus;

    counts[nextStatus] = (counts[nextStatus] ?? 0) + 1;
    if (nextStatus !== box.status || providerError) {
      await db.query(
        `update mailboxes
         set status = $3::mailbox_status,
             error = $4,
             warmup_started_at = coalesce(warmup_started_at, case when $3 in ('warming', 'ready') then now() else null end),
             updated_at = now()
         where id = $1 and account_id = $2`,
        [box.id, accountId, nextStatus, providerError],
      );
    }
  }

  const total = toPoll.length;
  const ready = counts.ready ?? 0;
  const allReady = total > 0 && ready === total && !truncated;

  const detail = {
    domain_id: domainId,
    mailboxes: total,
    polled,
    counts,
    warmup_days: Number(domain.warmup_days),
    warmup_started_at: toIso(domain.warmup_started_at),
    truncated,
  };

  if (allReady) {
    const upd = await db.query(
      `update domains set status = 'ready', error = null, updated_at = now()
       where id = $1 and account_id = $2 and status <> 'ready'`,
      [domainId, accountId],
    );
    if (upd.rowCount > 0) await logEvent(db, accountId, 'domain.ready', domainId, detail);
    return done({ ...detail, status: 'ready' });
  }

  if (total === 0) {
    return terminal('no mailboxes on this domain to monitor', detail);
  }

  return done({ ...detail, status: domain.status, retry_in_ms: WARMUP_POLL_INTERVAL_MS }, [{
    type: 'warmup_monitor',
    payload: { account_id: accountId, domain_id: domainId },
    dedupe_key: `warmup_monitor:${domainId}`,
    delay_ms: WARMUP_POLL_INTERVAL_MS,
  }]);
}

/**
 * provision_mailboxes — stage 4, step 3. Buys `count` mailboxes on a verified
 * domain, inserts the rows and records our cost per mailbox.
 *
 * Idempotency: only the shortfall (count minus mailboxes already on the domain)
 * is requested; rows insert `on conflict (lower(email)) do nothing`; cost rows are
 * keyed `mailbox:<id>`. The one gap: a crash between the vendor call and the
 * insert re-runs the vendor call. The mock returns the same addresses; a live
 * reseller may not, and the second batch would show up as extra rows on the next
 * run. There is no vendor-side idempotency key to close that.
 *
 * Payload: { account_id, domain_id, count }
 */

import { recordCost } from '../../lib/ledger';
import type { DomainStatus, Job, JobResult, MailboxStatus } from '../../lib/contracts';
import type { JobDeps } from '../registry';
import { accountIdOf, done, logEvent, payloadInt, requireString, terminal } from './_shared';
import { DEFAULT_MAILBOX_COUNT } from './provision-domain';

/** Hard cap per run regardless of payload; InboxKit allows at most 5 per Google/M365 domain. */
export const MAX_MAILBOXES_PER_DOMAIN = 100;

interface DomainRow {
  id: string;
  domain: string;
  status: DomainStatus;
}

export async function provisionMailboxes(job: Job, deps: JobDeps): Promise<JobResult> {
  const accountId = accountIdOf(job);
  if (!accountId) return terminal('no account_id on job');
  const domainId = requireString(job, 'domain_id');
  const { db } = deps;
  const requested = Math.min(MAX_MAILBOXES_PER_DOMAIN, Math.max(0, payloadInt(job, 'count') ?? DEFAULT_MAILBOX_COUNT));

  const domRes = await db.query<DomainRow>(
    `select id, domain, status from domains where id = $1 and account_id = $2`,
    [domainId, accountId],
  );
  const domain = domRes.rows[0];
  if (!domain) return terminal('domain not found on this account', { domain_id: domainId });
  if (domain.status !== 'warming' && domain.status !== 'ready') {
    return terminal(`domain is ${domain.status}; mailboxes need a verified domain`, { domain_id: domainId });
  }

  const next: JobResult['next'] = [{
    type: 'warmup_monitor',
    payload: { account_id: accountId, domain_id: domainId },
    dedupe_key: `warmup_monitor:${domainId}`,
  }];

  const existingRes = await db.query<{ n: string | number }>(
    `select count(*) as n from mailboxes where domain_id = $1 and account_id = $2`,
    [domainId, accountId],
  );
  const existing = Number(existingRes.rows[0]?.n ?? 0);
  const shortfall = Math.max(0, requested - existing);

  let inserted = 0;
  let provisioned = 0;
  /** Mailboxes the provider created that we could not store. See below. */
  const orphaned: Array<{ email: string; provider_ref: string; cost_cents: number }> = [];
  if (shortfall > 0) {
    const nameRes = await db.query<{ sending_name: string | null; company_name: string }>(
      `select p.sending_name, a.company_name
       from accounts a left join onboarding_profiles p on p.account_id = a.id
       where a.id = $1`,
      [accountId],
    );
    const names = nameRes.rows[0];
    const displayName = names?.sending_name?.trim() || names?.company_name || 'Outreach';

    const providers = await deps.providers();
    const boxes = await providers.mailboxes.provision({
      domain: domain.domain,
      count: shortfall,
      display_name: displayName,
      name_seeds: [displayName],
    });
    provisioned = boxes.length;

    for (const box of boxes.slice(0, shortfall)) {
      const status: MailboxStatus = box.status;
      const ins = await db.query(
        `insert into mailboxes (account_id, domain_id, email, display_name, status, provider, provider_ref,
                                sender_email_id, warmup_started_at, cost_cents)
         values ($1, $2, $3, $4, $5::mailbox_status, $6, $7, $8, now(), $9)
         on conflict (lower(email)) do nothing`,
        [accountId, domainId, box.email, displayName, status, providers.mailboxes.name, box.provider_ref,
          box.sender_email_id, Math.max(0, Math.floor(box.cost_cents))],
      );
      if (ins.rowCount > 0) {
        inserted += ins.rowCount;
      } else {
        // The vendor created a mailbox whose address we already hold, so the row was
        // dropped by the conflict clause. We have been CHARGED for a mailbox the
        // system cannot see or use. Silently discarding it would leak money and leave
        // an orphan at the provider, so record it loudly for a human to reconcile.
        orphaned.push({ email: box.email, provider_ref: box.provider_ref, cost_cents: box.cost_cents });
      }
    }
  }

  if (orphaned.length > 0) {
    await logEvent(db, accountId, 'mailboxes.orphaned', domainId, {
      domain_id: domainId,
      count: orphaned.length,
      // The address is the customer's own sending domain, not lead data, so it is
      // safe to record here and is exactly what a human needs to reconcile.
      orphaned,
      note: 'Provider created these but a mailbox with the same address already existed. '
        + 'They are billable at the provider and unusable here: delete them there, or '
        + 'attach them by hand.',
    });
    console.warn(
      `[provision_mailboxes] ${orphaned.length} orphaned mailbox(es) for domain ${domainId}: `
      + 'created at the provider but not stored. See the mailboxes.orphaned event.',
    );
  }

  // Cost per mailbox, keyed on the row id: a re-run records nothing new.
  const rows = await db.query<{ id: string; cost_cents: number; provider: string | null }>(
    `select id, cost_cents, provider from mailboxes where domain_id = $1 and account_id = $2 order by created_at`,
    [domainId, accountId],
  );
  let costRecorded = 0;
  for (const m of rows.rows) {
    const r = await recordCost({
      accountId,
      costCents: Math.max(0, Number(m.cost_cents)),
      category: 'mailbox',
      quantity: 1,
      idempotencyKey: `mailbox:${m.id}`,
      metadata: { mailbox_id: m.id, domain_id: domainId, provider: m.provider },
    }, db);
    if (!r.duplicate) costRecorded += r.recorded_cents;
  }

  if (inserted > 0) {
    await logEvent(db, accountId, 'mailboxes.provisioned', domainId, {
      domain_id: domainId, requested, existing, inserted, provisioned, cost_recorded_cents: costRecorded,
    });
  }

  return done({
    domain_id: domainId,
    requested,
    existing,
    shortfall,
    provisioned,
    inserted,
    orphaned: orphaned.length,
    total: rows.rows.length,
    cost_recorded_cents: costRecorded,
  }, next);
}

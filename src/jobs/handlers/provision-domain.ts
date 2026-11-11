/**
 * provision_domain — stage 4, step 1.
 *
 *   connected: compute the records the customer must publish, store them, set
 *              `dns_pending`. The customer's registrar is theirs; we only verify.
 *   purchased: register through the registrar provider (once; the provider_ref
 *              is stored the moment it returns), record the cost, write the records
 *              we can fully determine, store them all, set `dns_pending`.
 *
 * Records whose value still carries a `{{TOKEN}}` (tenant-specific DKIM targets,
 * the tracking CNAME) are stored for the UI but never written to a registrar and
 * never block verification; see verify-dns.ts for how they are reported.
 *
 * Payload: { account_id, domain_id, platform?: 'GOOGLE'|'MICROSOFT'|'AZURE',
 *            mailbox_count?: number, tracking_host?: string }
 */

import { requiredDnsRecords, type MailPlatform, type RequiredDnsRecord } from '../../lib/dns';
import { recordCost } from '../../lib/ledger';
import type { DnsRecord, DomainStatus, Job, JobResult } from '../../lib/contracts';
import type { JobDeps } from '../registry';
import { accountIdOf, done, logEvent, payloadInt, payloadString, requireString, terminal } from './_shared';

/** Mailboxes per domain when the payload does not say (InboxKit allows 5 on Google/M365). */
export const DEFAULT_MAILBOX_COUNT = 2;
const DEFAULT_PLATFORM: MailPlatform = 'GOOGLE';

/** Statuses in which the domain has already been through this handler. */
const ALREADY_PROVISIONED: ReadonlySet<DomainStatus> = new Set(['dns_pending', 'verifying', 'warming', 'ready']);

interface DomainRow {
  id: string;
  domain: string;
  status: DomainStatus;
  source: 'connected' | 'purchased';
  provider_ref: string | null;
  dns_records: DnsRecord[] | null;
}

export function platformOf(job: Job): MailPlatform {
  const raw = payloadString(job, 'platform');
  return raw === 'MICROSOFT' || raw === 'AZURE' || raw === 'GOOGLE' ? raw : DEFAULT_PLATFORM;
}

function stripMeta(records: RequiredDnsRecord[]): DnsRecord[] {
  // Keep the UI-facing hints out of the provider call but in the stored copy.
  return records.map(({ needs_substitution: _n, note: _note, ...rest }) => rest);
}

export async function provisionDomain(job: Job, deps: JobDeps): Promise<JobResult> {
  const accountId = accountIdOf(job);
  if (!accountId) return terminal('no account_id on job');
  const domainId = requireString(job, 'domain_id');
  const { db } = deps;
  const mailboxCount = payloadInt(job, 'mailbox_count') ?? DEFAULT_MAILBOX_COUNT;
  const platform = platformOf(job);

  const res = await db.query<DomainRow>(
    `select id, domain, status, source, provider_ref, dns_records
     from domains where id = $1 and account_id = $2`,
    [domainId, accountId],
  );
  const domain = res.rows[0];
  if (!domain) return terminal('domain not found on this account', { domain_id: domainId });

  const next: JobResult['next'] = [{
    type: 'verify_dns',
    payload: { account_id: accountId, domain_id: domainId, mailbox_count: mailboxCount, platform, first_attempt_at: new Date().toISOString() },
    dedupe_key: `verify_dns:${domainId}`,
  }];

  if (ALREADY_PROVISIONED.has(domain.status)) {
    return done({ skipped: `domain already ${domain.status}`, domain_id: domainId }, next);
  }
  if (domain.status === 'failed') {
    return terminal('domain is marked failed; a human must reset it', { domain_id: domainId });
  }

  const providers = await deps.providers();
  const records = requiredDnsRecords({
    domain: domain.domain,
    platform,
    trackingHost: payloadString(job, 'tracking_host') ?? undefined,
  });
  const writable = records.filter((r) => !r.needs_substitution);
  const pendingSubstitution = records.filter((r) => r.needs_substitution).map((r) => `${r.type} ${r.host}`);

  let registered = false;
  let priceCents: number | null = null;

  if (domain.source === 'purchased') {
    if (!domain.provider_ref) {
      await db.query(
        `update domains set status = 'purchasing', updated_at = now() where id = $1 and account_id = $2`,
        [domainId, accountId],
      );
      const reg = await providers.domains.register({ domain: domain.domain });
      // Store the ref before anything else can fail, so a re-run never re-registers.
      await db.query(
        `update domains set provider_ref = $3, registrar = $4, updated_at = now()
         where id = $1 and account_id = $2`,
        [domainId, accountId, reg.provider_ref, providers.domains.name],
      );
      await recordCost({
        accountId,
        costCents: Math.max(0, Math.floor(reg.price_cents)),
        category: 'domain',
        quantity: 1,
        idempotencyKey: `domain:${domainId}`,
        metadata: { domain_id: domainId, provider: providers.domains.name, provider_ref: reg.provider_ref },
      }, db);
      registered = true;
      priceCents = reg.price_cents;
    }
    if (writable.length > 0) {
      await providers.domains.setDnsRecords({ domain: domain.domain, records: stripMeta(writable) });
    }
  }

  await db.query(
    `update domains
     set status = 'dns_pending', dns_records = $3::jsonb, error = null, updated_at = now()
     where id = $1 and account_id = $2`,
    [domainId, accountId, JSON.stringify(records)],
  );

  await logEvent(db, accountId, 'domain.provisioned', domainId, {
    domain_id: domainId,
    source: domain.source,
    platform,
    registered,
    price_cents: priceCents,
    records: records.length,
    written: domain.source === 'purchased' ? writable.length : 0,
    pending_substitution: pendingSubstitution,
  });

  return done({
    domain_id: domainId,
    source: domain.source,
    platform,
    registered,
    records: records.length,
    pending_substitution: pendingSubstitution,
    status: 'dns_pending',
  }, next);
}

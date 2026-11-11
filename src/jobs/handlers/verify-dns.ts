/**
 * verify_dns — stage 4, step 2. Looks up the domain's records and compares them
 * with what provision_domain stored.
 *
 * Pass rule: every record whose expected value is fully known must match. Records
 * still holding a `{{TOKEN}}` (tenant-specific DKIM targets, tracking CNAME) cannot
 * be verified by anyone; they are reported as `unverifiable` in the result and on
 * the stored record (`verified: false`), and do not block. In the normal purchased
 * flow the mailbox reseller publishes DKIM itself after provisioning (dns.ts).
 *
 * When records do not match the job re-enqueues itself every VERIFY_INTERVAL_MS
 * until VERIFY_DEADLINE_MS after `first_attempt_at`, then marks the domain failed
 * with the last reasons. On success: `dns_verified_at`, status `warming`,
 * `warmup_started_at` (set once, never moved by a re-run), and provision_mailboxes.
 */

import { PLACEHOLDER_RE, validateDnsRecords } from '../../lib/dns';
import type { DnsRecord, DomainStatus, Job, JobResult } from '../../lib/contracts';
import type { JobDeps } from '../registry';
import { HOUR_MS, accountIdOf, done, logEvent, payloadInt, payloadString, requireString, terminal } from './_shared';
import { DEFAULT_MAILBOX_COUNT } from './provision-domain';

export const VERIFY_INTERVAL_MS = 10 * 60_000;
export const VERIFY_DEADLINE_MS = 48 * HOUR_MS;
/** Belt and braces on top of the deadline, in case timestamps are ever wrong. */
export const VERIFY_MAX_ATTEMPTS = 320;

interface DomainRow {
  id: string;
  domain: string;
  status: DomainStatus;
  dns_records: DnsRecord[] | null;
  warmup_started_at: Date | string | null;
}

function hasPlaceholder(value: string): boolean {
  const hit = PLACEHOLDER_RE.test(value);
  PLACEHOLDER_RE.lastIndex = 0;
  return hit;
}

export async function verifyDns(job: Job, deps: JobDeps): Promise<JobResult> {
  const accountId = accountIdOf(job);
  if (!accountId) return terminal('no account_id on job');
  const domainId = requireString(job, 'domain_id');
  const { db } = deps;
  const mailboxCount = payloadInt(job, 'mailbox_count') ?? DEFAULT_MAILBOX_COUNT;
  const platform = payloadString(job, 'platform');
  const firstAttemptAt = payloadString(job, 'first_attempt_at') ?? new Date().toISOString();
  const attempt = (payloadInt(job, 'attempt') ?? 0) + 1;

  const res = await db.query<DomainRow>(
    `select id, domain, status, dns_records, warmup_started_at
     from domains where id = $1 and account_id = $2`,
    [domainId, accountId],
  );
  const domain = res.rows[0];
  if (!domain) return terminal('domain not found on this account', { domain_id: domainId });

  const provisionNext: JobResult['next'] = [{
    type: 'provision_mailboxes',
    payload: { account_id: accountId, domain_id: domainId, count: mailboxCount, platform },
    dedupe_key: `provision_mailboxes:${domainId}`,
  }];

  if (domain.status === 'warming' || domain.status === 'ready') {
    return done({ skipped: `domain already ${domain.status}`, domain_id: domainId }, provisionNext);
  }
  if (domain.status === 'failed') return terminal('domain is marked failed', { domain_id: domainId });

  const expected = Array.isArray(domain.dns_records) ? domain.dns_records : [];
  if (expected.length === 0) {
    return terminal('domain has no expected DNS records; run provision_domain first', { domain_id: domainId });
  }

  await db.query(
    `update domains set status = 'verifying', updated_at = now() where id = $1 and account_id = $2 and status = 'dns_pending'`,
    [domainId, accountId],
  );

  const providers = await deps.providers();
  const actual = await providers.domains.getDnsRecords({ domain: domain.domain });
  const checks = validateDnsRecords(expected, actual, domain.domain);

  const unverifiable = checks.filter((c) => hasPlaceholder(c.record.value));
  const required = checks.filter((c) => !hasPlaceholder(c.record.value));
  const failing = required.filter((c) => !c.ok);
  const allPass = required.length > 0 && failing.length === 0;

  const stored: DnsRecord[] = checks.map((c) => c.record);
  const summary = {
    domain_id: domainId,
    attempt,
    checked: required.length,
    passed: required.length - failing.length,
    failing: failing.map((c) => `${c.record.type} ${c.record.host}: ${c.reason ?? 'mismatch'}`),
    unverifiable: unverifiable.map((c) => `${c.record.type} ${c.record.host}`),
  };

  if (allPass) {
    await db.query(
      `update domains
       set status = 'warming',
           dns_records = $3::jsonb,
           dns_verified_at = coalesce(dns_verified_at, now()),
           warmup_started_at = coalesce(warmup_started_at, now()),
           error = null,
           updated_at = now()
       where id = $1 and account_id = $2`,
      [domainId, accountId, JSON.stringify(stored)],
    );
    await logEvent(db, accountId, 'domain.dns_verified', domainId, summary);
    return done({ ...summary, status: 'warming' }, provisionNext);
  }

  const elapsedMs = Date.now() - new Date(firstAttemptAt).getTime();
  const error = `DNS not verified after ${attempt} attempt(s): ${summary.failing.join('; ')}`.slice(0, 2000);
  const giveUp = elapsedMs >= VERIFY_DEADLINE_MS || attempt >= VERIFY_MAX_ATTEMPTS;

  if (giveUp) {
    await db.query(
      `update domains set status = 'failed', dns_records = $3::jsonb, error = $4, updated_at = now()
       where id = $1 and account_id = $2`,
      [domainId, accountId, JSON.stringify(stored), error],
    );
    await logEvent(db, accountId, 'domain.dns_failed', domainId, { ...summary, elapsed_ms: elapsedMs });
    return terminal('DNS verification deadline passed', { ...summary, status: 'failed', elapsed_ms: elapsedMs });
  }

  await db.query(
    `update domains set status = 'dns_pending', dns_records = $3::jsonb, error = $4, updated_at = now()
     where id = $1 and account_id = $2`,
    [domainId, accountId, JSON.stringify(stored), error],
  );
  return done({ ...summary, status: 'dns_pending', retry_in_ms: VERIFY_INTERVAL_MS }, [{
    type: 'verify_dns',
    payload: { account_id: accountId, domain_id: domainId, mailbox_count: mailboxCount, platform, first_attempt_at: firstAttemptAt, attempt },
    dedupe_key: `verify_dns:${domainId}`,
    delay_ms: VERIFY_INTERVAL_MS,
  }]);
}

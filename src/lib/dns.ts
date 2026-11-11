/**
 * DNS records for a sending domain. Pure: no lookups, no I/O.
 *
 * Source of truth: docs/VENDOR_NOTES.md §5. InboxKit sets SPF, DKIM and DMARC itself
 * when it provisions the mailboxes, so in the normal flow these functions only
 * describe what SHOULD exist, for the UI and for `verify_dns`. They matter for real
 * when a customer connects a domain they already own.
 *
 * Placeholders. Some values cannot be known without a real tenant (M365 DKIM
 * targets, the Google DKIM public key, the EmailBison tracking CNAME target). Those
 * records carry `needs_substitution: true` and a `{{TOKEN}}` in `value`. A record
 * with an unsubstituted token never validates, and `setDnsRecords` callers must
 * substitute before writing. `dnsPlaceholders()` lists what is still missing.
 */

import type { DnsRecord } from './contracts';

export type MailPlatform = 'GOOGLE' | 'MICROSOFT' | 'AZURE';

/** A DnsRecord plus the metadata the UI and the provisioning job need. */
export interface RequiredDnsRecord extends DnsRecord {
  /** True when `value` still contains a `{{TOKEN}}` that must come from the tenant. */
  needs_substitution?: boolean;
  /** Where the real value comes from. Shown next to the record in the UI. */
  note?: string;
}

export const PLACEHOLDER_RE = /\{\{([A-Z0-9_]+)\}\}/g;

export interface RequiredDnsInput {
  domain: string;
  platform: MailPlatform;
  /**
   * Subdomain for the open/click tracking CNAME, e.g. "track". Omit to skip the
   * tracking record (EmailBison then uses its shared tracking host).
   */
  trackingHost?: string;
  /** Mailbox that receives DMARC aggregate reports. Omit to publish DMARC without `rua`. */
  dmarcReportEmail?: string;
}

function normaliseDomain(domain: string): string {
  return domain.trim().toLowerCase().replace(/\.$/, '');
}

/** "example.com" -> "example-com", the label M365 uses in DKIM and MX targets. */
function dashedLabel(domain: string): string {
  return normaliseDomain(domain).replace(/\./g, '-');
}

/**
 * DMARC, starting at `p=none`: monitor-only, nothing is quarantined or rejected
 * until we have seen reports. Strict alignment (adkim=s, aspf=s) from day one,
 * since every sender here is our own on our own domain. Tighten to quarantine
 * and then reject later, by hand, once reports are clean.
 */
export function dmarcRecord(reportEmail?: string | null): string {
  const tags = ['v=DMARC1', 'p=none'];
  const rua = reportEmail?.trim();
  if (rua) tags.push(`rua=mailto:${rua}`);
  tags.push('pct=100', 'adkim=s', 'aspf=s');
  return tags.join('; ');
}

/**
 * Exact records per VENDOR_NOTES §5. AZURE is an Exchange Online tenant bought
 * through InboxKit, so it needs the Microsoft records.
 */
export function requiredDnsRecords(input: RequiredDnsInput): RequiredDnsRecord[] {
  const domain = normaliseDomain(input.domain);
  const microsoft = input.platform === 'MICROSOFT' || input.platform === 'AZURE';
  const records: RequiredDnsRecord[] = [];

  // --- SPF: exactly one per domain. `-all` (hard fail) because nothing else
  //     legitimately sends as this domain.
  records.push({
    type: 'TXT',
    host: '@',
    value: microsoft
      ? 'v=spf1 include:spf.protection.outlook.com -all'
      : 'v=spf1 include:_spf.google.com -all',
    purpose: 'spf',
  });

  // --- DKIM
  if (microsoft) {
    // Two CNAMEs, selector1 and selector2. The real targets are tenant-specific:
    // read them with `Get-DkimSigningConfig -Identity <domain> | fl Selector1CNAME,Selector2CNAME`
    // in Exchange Online PowerShell. The old `<label>._domainkey.<tenant>.onmicrosoft.com`
    // target is OUT OF DATE; current targets look like
    // `selector1-<label>._domainkey.<prefix>.<partition>-v1.dkim.mail.microsoft`.
    // We cannot derive <prefix> or <partition>, so both records need substitution.
    for (const selector of ['selector1', 'selector2'] as const) {
      records.push({
        type: 'CNAME',
        host: `${selector}._domainkey`,
        value: `${selector}-${dashedLabel(domain)}._domainkey.{{M365_DKIM_PREFIX}}.{{M365_DKIM_PARTITION}}-v1.dkim.mail.microsoft`,
        purpose: 'dkim',
        needs_substitution: true,
        note: 'Read Selector1CNAME / Selector2CNAME from Get-DkimSigningConfig in Exchange Online PowerShell.',
      });
    }
  } else {
    // Google Workspace publishes one TXT at google._domainkey with the public key
    // generated in Admin console -> Apps -> Google Workspace -> Gmail -> Authenticate email.
    records.push({
      type: 'TXT',
      host: 'google._domainkey',
      value: 'v=DKIM1; k=rsa; p={{GOOGLE_DKIM_PUBLIC_KEY}}',
      purpose: 'dkim',
      needs_substitution: true,
      note: 'Generate the key in Google Admin (Gmail -> Authenticate email) and paste the p= value.',
    });
  }

  // --- DMARC
  records.push({
    type: 'TXT',
    host: '_dmarc',
    value: dmarcRecord(input.dmarcReportEmail),
    purpose: 'dmarc',
  });

  // --- MX: needed so replies land somewhere EmailBison can read them.
  if (microsoft) {
    // M365's MX target is normally `<label>.mail.protection.outlook.com`, which we
    // can derive, but the admin centre is authoritative (some tenants differ), so we
    // emit the derived value AND mark it for confirmation.
    records.push({
      type: 'MX',
      host: '@',
      value: `${dashedLabel(domain)}.mail.protection.outlook.com`,
      priority: 0,
      purpose: 'mx',
      needs_substitution: false,
      note: 'Derived from the domain. Confirm against Microsoft 365 admin centre -> Domains -> DNS records.',
    });
  } else {
    // Google Workspace, single-record form (priority 1).
    records.push({
      type: 'MX',
      host: '@',
      value: 'smtp.google.com',
      priority: 1,
      purpose: 'mx',
    });
  }

  // --- Tracking: the CNAME EmailBison returns from POST /api/custom-tracking-domain.
  //     Its target is not in the published spec (VENDOR_NOTES §5 marks it U).
  const tracking = input.trackingHost?.trim().toLowerCase().replace(/\.$/, '');
  if (tracking) {
    records.push({
      type: 'CNAME',
      host: tracking,
      value: '{{EMAILBISON_TRACKING_CNAME_TARGET}}',
      purpose: 'tracking',
      needs_substitution: true,
      note: 'Create the custom tracking domain in EmailBison and use the CNAME target it returns.',
    });
  }

  return records;
}

/** Tokens still unsubstituted across a record set, e.g. ["M365_DKIM_PREFIX"]. */
export function dnsPlaceholders(records: readonly DnsRecord[]): string[] {
  const found = new Set<string>();
  for (const r of records) {
    for (const m of r.value.matchAll(PLACEHOLDER_RE)) {
      const token = m[1];
      if (token) found.add(token);
    }
  }
  return [...found].sort();
}

/** Replace `{{TOKEN}}`s from a map; records whose tokens are all filled lose the flag. */
export function substituteDnsPlaceholders(
  records: readonly RequiredDnsRecord[],
  values: Readonly<Record<string, string>>,
): RequiredDnsRecord[] {
  return records.map((r) => {
    const value = r.value.replace(PLACEHOLDER_RE, (whole, token: string) => values[token] ?? whole);
    const stillMissing = PLACEHOLDER_RE.test(value);
    PLACEHOLDER_RE.lastIndex = 0;
    return { ...r, value, needs_substitution: stillMissing };
  });
}

// ---------------------------------------------------------------- validation

export interface DnsCheck {
  record: DnsRecord;
  ok: boolean;
  reason?: string;
}

function stripQuotes(value: string): string {
  // A long TXT comes back as several quoted chunks: "v=DKIM1; k=rsa; " "p=MIGf...".
  // Join the chunks, then drop any remaining stray quotes.
  const chunks = value.match(/"([^"]*)"/g);
  const joined = chunks && chunks.length > 0 ? chunks.map((c) => c.slice(1, -1)).join('') : value;
  return joined.replace(/"/g, '');
}

function collapseWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

/** Lower-cased, trailing dot removed. For hostnames and host-like values. */
function normaliseHostname(value: string): string {
  return value.trim().toLowerCase().replace(/\.$/, '');
}

/**
 * Relative host for comparison: "@", "" and the bare domain all mean the apex;
 * "_dmarc.example.com" becomes "_dmarc" when the domain is known.
 */
function normaliseHost(host: string, domain: string | undefined): string {
  let h = normaliseHostname(host);
  if (domain) {
    const d = normaliseDomain(domain);
    if (h === d) return '@';
    if (h.endsWith(`.${d}`)) h = h.slice(0, -(d.length + 1));
  }
  return h === '' ? '@' : h;
}

/** Canonical form of a TXT so ordering and quoting differences do not matter. */
function canonicalTxt(value: string): string {
  const flat = collapseWhitespace(stripQuotes(value));
  const lower = flat.toLowerCase();

  if (lower.startsWith('v=spf1')) {
    // SPF: `include:` and other mechanisms are an unordered set for our purposes,
    // except the version tag (first) and the `all` qualifier (last), which we keep
    // positionally so "-all" vs "~all" still counts as a difference.
    const tokens = lower.split(' ').filter(Boolean);
    const version = tokens[0] ?? '';
    const rest = tokens.slice(1);
    const allIdx = rest.findIndex((t) => /^[-~+?]?all$/.test(t));
    const all = allIdx >= 0 ? rest.splice(allIdx, 1) : [];
    return [version, ...rest.sort(), ...all].join(' ');
  }

  if (lower.startsWith('v=dmarc1') || lower.startsWith('v=dkim1')) {
    // Tag=value lists: normalise separators and sort everything after the version tag.
    const tags = lower.split(';').map((t) => t.replace(/\s+/g, '')).filter(Boolean);
    const version = tags[0] ?? '';
    return [version, ...tags.slice(1).sort()].join(';');
  }

  return lower;
}

function canonicalValue(record: DnsRecord): string {
  switch (record.type) {
    case 'TXT':
      return canonicalTxt(record.value);
    case 'CNAME':
    case 'MX':
      return normaliseHostname(stripQuotes(record.value));
    case 'A':
      return record.value.trim();
    default:
      return collapseWhitespace(record.value);
  }
}

/**
 * Compares what we asked for against what a lookup returned.
 *
 * - `expected` hosts are relative ("@", "_dmarc"); `actual` hosts may be relative
 *   or fully-qualified. Pass `domain` to let the FQDN form match.
 * - Quotes and whitespace are normalised; SPF `include:` order is ignored.
 * - An expected value still holding a `{{TOKEN}}` can never be ok.
 * - MX priority is compared only when both sides carry one.
 */
export function validateDnsRecords(
  expected: readonly DnsRecord[],
  actual: readonly DnsRecord[],
  domain?: string,
): DnsCheck[] {
  return expected.map((record): DnsCheck => {
    if (PLACEHOLDER_RE.test(record.value)) {
      PLACEHOLDER_RE.lastIndex = 0;
      return { record: { ...record, verified: false }, ok: false, reason: 'expected value still contains a placeholder that must be substituted from the real tenant' };
    }
    PLACEHOLDER_RE.lastIndex = 0;

    const host = normaliseHost(record.host, domain);
    const sameHost = actual.filter((a) => a.type === record.type && normaliseHost(a.host, domain) === host);
    if (sameHost.length === 0) {
      return { record: { ...record, verified: false }, ok: false, reason: `no ${record.type} record found at ${record.host}` };
    }

    const want = canonicalValue(record);
    const match = sameHost.find((a) => canonicalValue(a) === want);
    if (!match) {
      return {
        record: { ...record, verified: false },
        ok: false,
        reason: `${record.type} at ${record.host} has a different value (found ${sameHost.length} record${sameHost.length === 1 ? '' : 's'}, none matched)`,
      };
    }

    if (record.type === 'MX' && record.priority !== undefined && match.priority !== undefined && record.priority !== match.priority) {
      return { record: { ...record, verified: false }, ok: false, reason: `MX priority is ${match.priority}, expected ${record.priority}` };
    }

    return { record: { ...record, verified: true }, ok: true };
  });
}

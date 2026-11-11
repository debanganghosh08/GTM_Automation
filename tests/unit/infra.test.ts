/**
 * Email infrastructure: DNS records, warm-up maths, and the InboxKit / Porkbun
 * providers against a stubbed fetch. Nothing here touches the network.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DnsRecord } from '../../src/lib/contracts';
import {
  dmarcRecord, dnsPlaceholders, requiredDnsRecords, substituteDnsPlaceholders, validateDnsRecords,
} from '../../src/lib/dns';
import { warmupCopy, warmupDailyCap, warmupProgress } from '../../src/lib/warmup';
import {
  InboxKitProvider, inboxKitCostCents, inboxKitUsernames, mapInboxKitStatus,
} from '../../src/providers/live/inboxkit';
import { NamecheapProvider, PorkbunDomainProvider, dollarsToCents } from '../../src/providers/live/namecheap';

// ---------------------------------------------------------------- DNS

describe('requiredDnsRecords', () => {
  it('emits SPF, DKIM, DMARC and MX with the right purposes for an Azure (M365) domain', () => {
    const records = requiredDnsRecords({ domain: 'example.com', platform: 'AZURE' });
    const byPurpose = (p: DnsRecord['purpose']) => records.filter((r) => r.purpose === p);

    expect(byPurpose('spf')).toHaveLength(1);
    expect(byPurpose('spf')[0]).toMatchObject({ type: 'TXT', host: '@', value: 'v=spf1 include:spf.protection.outlook.com -all' });

    expect(byPurpose('dkim')).toHaveLength(2);
    expect(byPurpose('dkim').map((r) => r.host).sort()).toEqual(['selector1._domainkey', 'selector2._domainkey']);
    for (const r of byPurpose('dkim')) {
      expect(r.type).toBe('CNAME');
      expect(r.needs_substitution).toBe(true);
      expect(r.value).not.toContain('onmicrosoft.com');
      expect(r.value).toContain('dkim.mail.microsoft');
    }

    expect(byPurpose('dmarc')).toHaveLength(1);
    expect(byPurpose('dmarc')[0]).toMatchObject({ type: 'TXT', host: '_dmarc' });

    expect(byPurpose('mx')).toHaveLength(1);
    expect(byPurpose('mx')[0]).toMatchObject({ type: 'MX', host: '@', value: 'example-com.mail.protection.outlook.com', priority: 0 });

    expect(byPurpose('tracking')).toHaveLength(0);
  });

  it('emits the Google SPF, a google._domainkey TXT and smtp.google.com MX for GOOGLE', () => {
    const records = requiredDnsRecords({ domain: 'Example.COM.', platform: 'GOOGLE', trackingHost: 'track' });
    expect(records.find((r) => r.purpose === 'spf')?.value).toBe('v=spf1 include:_spf.google.com -all');
    const dkim = records.filter((r) => r.purpose === 'dkim');
    expect(dkim).toHaveLength(1);
    expect(dkim[0]).toMatchObject({ type: 'TXT', host: 'google._domainkey', needs_substitution: true });
    expect(records.find((r) => r.purpose === 'mx')).toMatchObject({ value: 'smtp.google.com', priority: 1 });
    expect(records.find((r) => r.purpose === 'tracking')).toMatchObject({ type: 'CNAME', host: 'track', needs_substitution: true });
  });

  it('DMARC starts at p=none with strict alignment and the report address', () => {
    expect(dmarcRecord('dmarc@example.com')).toBe('v=DMARC1; p=none; rua=mailto:dmarc@example.com; pct=100; adkim=s; aspf=s');
    expect(dmarcRecord()).toBe('v=DMARC1; p=none; pct=100; adkim=s; aspf=s');
    const records = requiredDnsRecords({ domain: 'example.com', platform: 'MICROSOFT', dmarcReportEmail: 'dmarc@example.com' });
    const dmarc = records.find((r) => r.purpose === 'dmarc');
    expect(dmarc?.value.startsWith('v=DMARC1; p=none;')).toBe(true);
    expect(dmarc?.value).not.toMatch(/p=(quarantine|reject)/);
  });

  it('lists the placeholders that must come from a real tenant, and substitution clears them', () => {
    const records = requiredDnsRecords({ domain: 'example.com', platform: 'AZURE', trackingHost: 'track' });
    expect(dnsPlaceholders(records)).toEqual(['EMAILBISON_TRACKING_CNAME_TARGET', 'M365_DKIM_PARTITION', 'M365_DKIM_PREFIX']);

    const filled = substituteDnsPlaceholders(records, { M365_DKIM_PREFIX: 'abc123', M365_DKIM_PARTITION: 'o' });
    expect(dnsPlaceholders(filled)).toEqual(['EMAILBISON_TRACKING_CNAME_TARGET']);
    expect(filled.find((r) => r.host === 'selector1._domainkey')).toMatchObject({
      value: 'selector1-example-com._domainkey.abc123.o-v1.dkim.mail.microsoft',
      needs_substitution: false,
    });
    expect(filled.find((r) => r.purpose === 'tracking')?.needs_substitution).toBe(true);
  });
});

describe('validateDnsRecords', () => {
  const spf: DnsRecord = { type: 'TXT', host: '@', value: 'v=spf1 include:spf.protection.outlook.com include:_spf.google.com -all', purpose: 'spf' };
  const dmarc: DnsRecord = { type: 'TXT', host: '_dmarc', value: dmarcRecord('dmarc@example.com'), purpose: 'dmarc' };
  const mx: DnsRecord = { type: 'MX', host: '@', value: 'example-com.mail.protection.outlook.com', priority: 0, purpose: 'mx' };

  it('ignores SPF include ordering, surrounding quotes and whitespace', () => {
    const actual: DnsRecord[] = [
      { type: 'TXT', host: 'example.com', value: '"v=spf1   include:_spf.google.com include:spf.protection.outlook.com -all"', purpose: 'spf' },
      { type: 'TXT', host: '_dmarc.example.com', value: '"v=DMARC1; aspf=s; adkim=s; pct=100; rua=mailto:dmarc@example.com; p=none"', purpose: 'dmarc' },
      { type: 'MX', host: '@', value: 'EXAMPLE-COM.mail.protection.outlook.com.', priority: 0, purpose: 'mx' },
    ];
    const checks = validateDnsRecords([spf, dmarc, mx], actual, 'example.com');
    expect(checks.map((c) => c.ok)).toEqual([true, true, true]);
    expect(checks.every((c) => c.record.verified === true)).toBe(true);
  });

  it('does not let a softer "all" qualifier pass as the hard-fail SPF we asked for', () => {
    const actual: DnsRecord[] = [{ type: 'TXT', host: '@', value: 'v=spf1 include:_spf.google.com include:spf.protection.outlook.com ~all', purpose: 'spf' }];
    const [check] = validateDnsRecords([spf], actual);
    expect(check?.ok).toBe(false);
    expect(check?.reason).toMatch(/different value/);
  });

  it('reports a missing record, a wrong MX priority and an unsubstituted placeholder', () => {
    const actual: DnsRecord[] = [{ type: 'MX', host: '@', value: 'example-com.mail.protection.outlook.com', priority: 10, purpose: 'mx' }];
    const placeholder: DnsRecord = { type: 'CNAME', host: 'selector1._domainkey', value: 'x.{{M365_DKIM_PREFIX}}.dkim.mail.microsoft', purpose: 'dkim' };
    const checks = validateDnsRecords([spf, mx, placeholder], actual);
    expect(checks[0]).toMatchObject({ ok: false, reason: 'no TXT record found at @' });
    expect(checks[1]?.ok).toBe(false);
    expect(checks[1]?.reason).toMatch(/priority is 10/);
    expect(checks[2]?.ok).toBe(false);
    expect(checks[2]?.reason).toMatch(/placeholder/);
  });
});

// ---------------------------------------------------------------- warm-up

const START = new Date('2026-10-23T09:00:00.000Z');
const dayN = (n: number) => new Date(START.getTime() + (n - 1) * 86_400_000 + 3_600_000); // an hour into day n

describe('warmupDailyCap', () => {
  const base = { fullCap: 50, startedAt: START.toISOString(), days: 7 };

  it('ramps 50 over 7 days: day 1 is 7, day 7 is 50', () => {
    expect(warmupDailyCap({ ...base, now: dayN(1) })).toBe(7);
    expect(warmupDailyCap({ ...base, now: dayN(2) })).toBe(14);
    expect(warmupDailyCap({ ...base, now: dayN(6) })).toBe(42);
    expect(warmupDailyCap({ ...base, now: dayN(7) })).toBe(50);
    expect(warmupDailyCap({ ...base, now: dayN(30) })).toBe(50);
  });

  it('is 0 before warm-up starts and never below 1 once it has', () => {
    expect(warmupDailyCap({ ...base, now: new Date(START.getTime() - 1) })).toBe(0);
    expect(warmupDailyCap({ ...base, startedAt: null, now: dayN(3) })).toBe(0);
    expect(warmupDailyCap({ fullCap: 3, startedAt: START, days: 14, now: dayN(1) })).toBe(1);
    expect(warmupDailyCap({ fullCap: 0, startedAt: START, days: 7, now: dayN(7) })).toBe(0);
  });
});

describe('warmupProgress', () => {
  it('is incomplete at day 6 and complete once 7 whole days have elapsed', () => {
    const atDay6 = warmupProgress({ startedAt: START, days: 7, now: new Date(START.getTime() + 6 * 86_400_000) });
    expect(atDay6).toMatchObject({ days_total: 7, days_elapsed: 6, percent: 85, complete: false, ready_at: '2026-10-30T09:00:00.000Z' });

    const atDay7 = warmupProgress({ startedAt: START, days: 7, now: new Date(START.getTime() + 7 * 86_400_000) });
    expect(atDay7).toMatchObject({ days_elapsed: 7, percent: 100, complete: true });
  });

  it('treats a null start as not started', () => {
    expect(warmupProgress({ startedAt: null, days: 7, now: dayN(1) })).toEqual({
      started_at: null, days_total: 7, days_elapsed: 0, percent: 0, ready_at: null, complete: false,
    });
  });
});

describe('warmupCopy', () => {
  const immediate = /within an hour|immediately|right away|start sending now|send(ing)? today/i;

  it('never claims immediate sending and names the date sending begins', () => {
    const inProgress = warmupProgress({ startedAt: START, days: 7, now: dayN(2) });
    const copy = warmupCopy(inProgress);
    expect(copy).not.toMatch(immediate);
    expect(copy).toMatch(/strategy and lead list are ready now/i);
    expect(copy).toMatch(/sending begins when warm-up completes on 30 Oct 2026/);
    expect(copy).toContain('day 2 of 7');

    const notStarted = warmupCopy(warmupProgress({ startedAt: null, days: 7, now: dayN(1) }));
    expect(notStarted).not.toMatch(immediate);
    expect(notStarted).toMatch(/has not started yet/);

    const done = warmupCopy(warmupProgress({ startedAt: START, days: 7, now: dayN(9) }));
    expect(done).toMatch(/Warm-up is complete/);
  });
});

// ---------------------------------------------------------------- fetch stub

type Handler = (url: string, init: RequestInit) => { status?: number; body?: unknown };

interface Captured { url: string; init: RequestInit; body: unknown }

function stubFetch(handler: Handler): Captured[] {
  const calls: Captured[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    const i = init ?? {};
    const body = typeof i.body === 'string' ? (JSON.parse(i.body) as unknown) : null;
    calls.push({ url: u, init: i, body });
    const out = handler(u, i);
    return new Response(out.body === undefined ? '' : JSON.stringify(out.body), {
      status: out.status ?? 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }));
  return calls;
}

function header(init: RequestInit, name: string): string | undefined {
  const h = init.headers;
  if (!h) return undefined;
  if (h instanceof Headers) return h.get(name) ?? undefined;
  if (Array.isArray(h)) return h.find(([k]) => k.toLowerCase() === name.toLowerCase())?.[1];
  const entry = Object.entries(h).find(([k]) => k.toLowerCase() === name.toLowerCase());
  return entry?.[1];
}

afterEach(() => {
  vi.unstubAllGlobals();
});

// ---------------------------------------------------------------- InboxKit

describe('InboxKitProvider', () => {
  beforeEach(() => {
    stubFetch(() => ({ body: {} }));
  });

  it('rejects 6 mailboxes on the GOOGLE platform before calling the API', async () => {
    const provider = new InboxKitProvider({ apiKey: 'test-key', platform: 'GOOGLE', workspaceId: 'ws' });
    await expect(provider.provision({ domain: 'example.com', count: 6, display_name: 'Tom Smith' }))
      .rejects.toThrow(/at most 5 mailboxes per domain on the GOOGLE platform/);
    expect(vi.mocked(globalThis.fetch)).not.toHaveBeenCalled();
  });

  it('allows up to 100 on AZURE and 5 on MICROSOFT', async () => {
    const ms = new InboxKitProvider({ apiKey: 'k', platform: 'MICROSOFT', workspaceId: 'ws' });
    await expect(ms.provision({ domain: 'example.com', count: 6, display_name: 'Tom Smith' })).rejects.toThrow(/MICROSOFT/);
    const azure = new InboxKitProvider({ apiKey: 'k', platform: 'AZURE', workspaceId: 'ws' });
    await expect(azure.provision({ domain: 'example.com', count: 101, display_name: 'Tom Smith' })).rejects.toThrow(/at most 100/);
  });

  it('username permutations contain no digits when the seeds suffice', () => {
    const names = inboxKitUsernames(['Tom Smith', 'Hannah Jones'], 8, 'Acme');
    expect(names).toHaveLength(8);
    expect(new Set(names.map((n) => n.username)).size).toBe(8);
    for (const n of names) expect(n.username).toMatch(/^[a-z.]+$/);
    expect(names.slice(0, 4).map((n) => n.username)).toEqual(['t.smith', 'h.jones', 'tom.smith', 'hannah.jones']);
    expect(names[0]).toMatchObject({ first_name: 'Tom', last_name: 'Smith' });
  });

  it('falls back to numeric suffixes only after every permutation is used', () => {
    const names = inboxKitUsernames(['Tom Smith'], 12, 'Acme');
    expect(names.slice(0, 10).every((n) => /^[a-z.]+$/.test(n.username))).toBe(true);
    expect(names[10]?.username).toBe('tom.smith2');
    expect(names[11]?.username).toBe('tom.smith3');
  });

  it('buys with warm-up enabled, the workspace header, and maps the returned uids', async () => {
    const calls = stubFetch((url) => {
      if (url.endsWith('/v1/api/workspaces/list')) return { body: { data: [{ uid: 'ws_1', name: 'Default' }] } };
      if (url.endsWith('/v1/api/mailboxes/buy')) {
        return { body: { data: { mailboxes: [
          { uid: 'mb_a', email: 't.smith@example.com', status: 'pending' },
          { uid: 'mb_b', email: 'tom.smith@example.com', status: 'pending' },
        ] } } };
      }
      return { status: 404, body: { error: 'nope' } };
    });

    const provider = new InboxKitProvider({ apiKey: 'test-key', retryBaseMs: 0 });
    const result = await provider.provision({ domain: 'example.com', count: 2, display_name: 'Acme', name_seeds: ['Tom Smith'] });

    const buy = calls.find((c) => c.url.endsWith('/mailboxes/buy'));
    expect(buy).toBeDefined();
    expect(header(buy!.init, 'Authorization')).toBe('Bearer test-key');
    expect(header(buy!.init, 'X-Workspace-Id')).toBe('ws_1');
    expect(buy!.body).toMatchObject({
      use_wallet_balance: true,
      warmup_addon_enabled: true,
      mailboxes: [
        { first_name: 'Tom', last_name: 'Smith', username: 't.smith', domain_name: 'example.com', platform: 'AZURE' },
        { first_name: 'Tom', last_name: 'Smith', username: 'tom.smith', domain_name: 'example.com', platform: 'AZURE' },
      ],
    });
    expect(calls.filter((c) => c.url.endsWith('/workspaces/list'))).toHaveLength(1);

    expect(result).toEqual([
      { email: 't.smith@example.com', provider_ref: 'mb_a', sender_email_id: null, cost_cents: 1800, status: 'provisioning' },
      { email: 'tom.smith@example.com', provider_ref: 'mb_b', sender_email_id: null, cost_cents: 1800, status: 'provisioning' },
    ]);
  });

  it('refuses to invent provider refs when the buy response has none', async () => {
    stubFetch((url) => (url.endsWith('/mailboxes/buy') ? { body: { ok: true } } : { body: {} }));
    const provider = new InboxKitProvider({ apiKey: 'k', workspaceId: 'ws' });
    await expect(provider.provision({ domain: 'example.com', count: 1, display_name: 'Tom Smith' })).rejects.toThrow(/no mailbox rows/);
  });

  it('maps InboxKit statuses onto MailboxStatus and surfaces an error field', async () => {
    stubFetch((url) => (url.endsWith('/mailboxes/status')
      ? { body: { data: [{ uid: 'mb_a', status: 'warming' }, { uid: 'mb_x', status: 'failed', error: 'domain not active' }] } }
      : { body: {} }));
    const provider = new InboxKitProvider({ apiKey: 'k', workspaceId: 'ws' });
    expect(await provider.getStatus({ provider_ref: 'mb_a' })).toEqual({ status: 'warming' });
    expect(await provider.getStatus({ provider_ref: 'mb_x' })).toEqual({ status: 'failed', error: 'domain not active' });
    expect(await provider.getStatus({ provider_ref: 'mb_missing' })).toMatchObject({ status: 'failed' });

    expect(mapInboxKitStatus('ACTIVE')).toBe('ready');
    expect(mapInboxKitStatus('paused')).toBe('paused');
    expect(() => mapInboxKitStatus('banana')).toThrow(/unmapped/);
  });

  it('retries on 429 and 5xx with backoff, then succeeds', async () => {
    let n = 0;
    const calls = stubFetch((url) => {
      if (!url.endsWith('/mailboxes/status')) return { body: {} };
      n += 1;
      if (n === 1) return { status: 429, body: { message: 'slow down' } };
      if (n === 2) return { status: 503, body: {} };
      return { body: [{ uid: 'mb_a', status: 'active' }] };
    });
    const provider = new InboxKitProvider({ apiKey: 'k', workspaceId: 'ws', retryBaseMs: 0 });
    expect(await provider.getStatus({ provider_ref: 'mb_a' })).toEqual({ status: 'ready' });
    expect(calls.filter((c) => c.url.endsWith('/mailboxes/status'))).toHaveLength(3);
  });

  it('does not retry a 4xx and never leaks the key into the error', async () => {
    stubFetch(() => ({ status: 401, body: { message: 'bad token' } }));
    const provider = new InboxKitProvider({ apiKey: 'super-secret', workspaceId: 'ws', retryBaseMs: 0 });
    const err = await provider.getStatus({ provider_ref: 'mb_a' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/HTTP 401: bad token/);
    expect((err as Error).message).not.toContain('super-secret');
    expect(vi.mocked(globalThis.fetch)).toHaveBeenCalledTimes(1);
  });

  it('throws MissingCredentialError without INBOXKIT_API_KEY', () => {
    expect(() => new InboxKitProvider()).toThrow(/INBOXKIT_API_KEY/);
  });

  it('computes cost: Azure tenant split across the call, flat for Google/M365, plus warm-up', () => {
    expect(inboxKitCostCents('AZURE', 1)).toBe(3_000 + 300);
    expect(inboxKitCostCents('AZURE', 10)).toBe(300 + 300);
    expect(inboxKitCostCents('AZURE', 100)).toBe(30 + 300);
    expect(inboxKitCostCents('GOOGLE', 5)).toBe(300 + 300);
    expect(inboxKitCostCents('MICROSOFT', 5, false)).toBe(300);
  });
});

// ---------------------------------------------------------------- Porkbun / registrar dispatch

describe('NamecheapProvider (registrar dispatch)', () => {
  it('defaults to Porkbun and refuses namecheap and godaddy with a clear message', () => {
    const keys = { apiKey: 'pk', secretKey: 'sk' };
    expect(new NamecheapProvider({ provider: 'porkbun', porkbun: keys }).name).toBe('porkbun');
    expect(() => new NamecheapProvider({ provider: 'namecheap', porkbun: keys })).toThrow(/not implemented.*porkbun/i);
    expect(() => new NamecheapProvider({ provider: 'godaddy', porkbun: keys })).toThrow(/billing method/);
  });

  it('throws MissingCredentialError without Porkbun keys', () => {
    expect(() => new PorkbunDomainProvider()).toThrow(/PORKBUN_API_KEY/);
  });
});

describe('PorkbunDomainProvider', () => {
  it('checks availability, converting the dollar price to cents and sending both auth forms', async () => {
    const calls = stubFetch(() => ({ body: { status: 'SUCCESS', response: { avail: 'yes', price: '11.98' } } }));
    const provider = new PorkbunDomainProvider({ apiKey: 'pk', secretKey: 'sk' });
    expect(await provider.checkAvailability('Example.com')).toEqual({ available: true, price_cents: 1198 });

    const call = calls[0];
    expect(call?.url).toBe('https://api.porkbun.com/api/json/v3/domain/checkDomain/example.com');
    expect(call?.init.method).toBe('POST');
    expect(header(call!.init, 'X-API-Key')).toBe('pk');
    expect(header(call!.init, 'X-Secret-API-Key')).toBe('sk');
    expect(call?.body).toMatchObject({ apikey: 'pk', secretapikey: 'sk' });
    expect(dollarsToCents('$2.5')).toBe(250);
  });

  it('treats status ERROR as failure even on HTTP 200', async () => {
    stubFetch(() => ({ body: { status: 'ERROR', message: 'Invalid API key.' } }));
    const provider = new PorkbunDomainProvider({ apiKey: 'pk', secretKey: 'sk' });
    await expect(provider.checkAvailability('example.com')).rejects.toThrow(/Invalid API key/);
  });

  it('reads DNS records back as relative hosts with inferred purposes', async () => {
    stubFetch(() => ({ body: { status: 'SUCCESS', records: [
      { id: '1', name: 'example.com', type: 'TXT', content: 'v=spf1 include:spf.protection.outlook.com -all', ttl: '600', prio: '0' },
      { id: '2', name: '_dmarc.example.com', type: 'TXT', content: 'v=DMARC1; p=none', ttl: '600' },
      { id: '3', name: 'example.com', type: 'MX', content: 'example-com.mail.protection.outlook.com', ttl: '600', prio: '0' },
      { id: '4', name: 'example.com', type: 'NS', content: 'ns1.porkbun.com', ttl: '600' },
    ] } }));
    const provider = new PorkbunDomainProvider({ apiKey: 'pk', secretKey: 'sk' });
    const records = await provider.getDnsRecords({ domain: 'example.com' });
    expect(records).toEqual([
      { type: 'TXT', host: '@', value: 'v=spf1 include:spf.protection.outlook.com -all', purpose: 'spf' },
      { type: 'TXT', host: '_dmarc', value: 'v=DMARC1; p=none', purpose: 'dmarc' },
      { type: 'MX', host: '@', value: 'example-com.mail.protection.outlook.com', priority: 0, purpose: 'mx' },
    ]);
  });

  it('setDnsRecords skips matching records, edits a changed SPF, and creates the rest', async () => {
    const calls = stubFetch((url) => {
      if (url.includes('/dns/retrieve/')) {
        return { body: { status: 'SUCCESS', records: [
          { id: '1', name: 'example.com', type: 'TXT', content: 'v=spf1 include:_spf.google.com -all' },
          { id: '2', name: '_dmarc.example.com', type: 'TXT', content: 'v=DMARC1; p=none; pct=100; adkim=s; aspf=s' },
        ] } };
      }
      if (url.includes('/dns/create/')) return { body: { status: 'SUCCESS', id: 99 } };
      if (url.includes('/dns/edit/')) return { body: { status: 'SUCCESS' } };
      return { status: 404, body: { status: 'ERROR', message: 'unknown' } };
    });
    const provider = new PorkbunDomainProvider({ apiKey: 'pk', secretKey: 'sk' });
    const wanted = requiredDnsRecords({ domain: 'example.com', platform: 'AZURE' }).filter((r) => !r.needs_substitution);
    await provider.setDnsRecords({ domain: 'example.com', records: wanted });

    const edits = calls.filter((c) => c.url.includes('/dns/edit/'));
    const creates = calls.filter((c) => c.url.includes('/dns/create/'));
    expect(edits).toHaveLength(1);
    expect(edits[0]?.url).toMatch(/\/dns\/edit\/example\.com\/1$/);
    expect(edits[0]?.body).toMatchObject({ name: '', type: 'TXT', content: 'v=spf1 include:spf.protection.outlook.com -all' });
    expect(creates).toHaveLength(1);
    expect(creates[0]?.body).toMatchObject({ name: '', type: 'MX', content: 'example-com.mail.protection.outlook.com', prio: '0' });
  });

  it('refuses to write a record that still holds a placeholder', async () => {
    stubFetch(() => ({ body: { status: 'SUCCESS', records: [] } }));
    const provider = new PorkbunDomainProvider({ apiKey: 'pk', secretKey: 'sk' });
    const dkim = requiredDnsRecords({ domain: 'example.com', platform: 'AZURE' }).filter((r) => r.purpose === 'dkim');
    await expect(provider.setDnsRecords({ domain: 'example.com', records: dkim })).rejects.toThrow(/placeholder/);
  });
});

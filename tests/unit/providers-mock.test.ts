/**
 * Mock provider sanity checks: determinism, fake-only data, and the copy
 * fixture obeying the rules the compliance checker enforces.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import type { CampaignCopy, GtmStrategy, LeadSearchQuery } from '../../src/lib/contracts';
import { MERGE_TAGS } from '../../src/lib/contracts';
import { MockLeadProvider } from '../../src/providers/mock/leads';
import { MockVerificationProvider } from '../../src/providers/mock/verification';
import { MockSendingProvider, __resetMockSending, __setMockBounceRate } from '../../src/providers/mock/sending';
import { MockDomainProvider, __resetMockDomains } from '../../src/providers/mock/domains';
import { MockMailboxProvider, __resetMockMailboxes } from '../../src/providers/mock/mailboxes';
import { MockBillingProvider, __resetMockBilling, signMockWebhook } from '../../src/providers/mock/billing';
import { MockLlmProvider } from '../../src/providers/mock/llm';
import { MockScrapeProvider } from '../../src/providers/mock/scrape';

const query: LeadSearchQuery = {
  titles: ['Head of Sales', 'Founder'],
  industries: ['Software'],
  geos: ['United Kingdom'],
  headcount_min: 20,
  headcount_max: 200,
  signals: ['hiring SDRs'],
  limit: 25,
};

const llmInput = { system: 'sys', user: 'user', schema: {} };

describe('MockLeadProvider', () => {
  it('returns identical leads for the same query', async () => {
    const provider = new MockLeadProvider();
    const a = await provider.search(query);
    const b = await provider.search(query);
    expect(a).toEqual(b);
    expect(a.leads).toHaveLength(25);
    expect(a.stop_reason).toBe('limit_reached');
    expect(a.cost_cents).toBe(50);
  });

  it('extends rather than reshuffles when the limit grows', async () => {
    const provider = new MockLeadProvider();
    const small = await provider.search({ ...query, limit: 5 });
    const big = await provider.search({ ...query, limit: 10 });
    expect(big.leads.slice(0, 5)).toEqual(small.leads);
  });

  it('emits only .test addresses, unique, drawn from the query', async () => {
    const { leads } = await new MockLeadProvider().search(query);
    const emails = new Set(leads.map((l) => l.email));
    expect(emails.size).toBe(leads.length);
    for (const lead of leads) {
      expect(lead.email).toMatch(/@[a-z0-9-]+\.test$/);
      expect(query.titles).toContain(lead.title);
      expect(lead.industry).toBe('Software');
      expect(lead.country).toBe('United Kingdom');
      expect(lead.headcount).toBeGreaterThanOrEqual(20);
      expect(lead.headcount).toBeLessThanOrEqual(200);
    }
  });

  it('reports exhaustion instead of hiding truncation', async () => {
    const result = await new MockLeadProvider().search({ ...query, limit: 5_000 });
    expect(result.stop_reason).toBe('exhausted');
    expect(result.leads.length).toBeLessThan(5_000);
  });
});

describe('MockVerificationProvider', () => {
  it('is deterministic per email and roughly 85% valid', async () => {
    const provider = new MockVerificationProvider();
    const emails = Array.from({ length: 1_000 }, (_, i) => `person${i}@example-${i % 37}.test`);
    const first = await provider.verify(emails);
    const second = await provider.verify(emails);
    expect(first).toEqual(second);
    const valid = first.filter((r) => r.status === 'valid').length;
    expect(valid).toBeGreaterThan(780);
    expect(valid).toBeLessThan(920);
    expect(new Set(first.map((r) => r.status)).size).toBe(4);
  });
});

describe('MockSendingProvider', () => {
  beforeEach(() => __resetMockSending());

  async function launched(now: () => number): Promise<{ provider: MockSendingProvider; ref: string }> {
    const provider = new MockSendingProvider({ now });
    const { provider_ref: ref } = await provider.createCampaign({ name: 'Test', steps: [], timezone: 'UTC' });
    const leads = Array.from({ length: 200 }, (_, i) => ({ email: `lead${i}@fixture.test`, fields: {} }));
    await provider.uploadLeads({ provider_ref: ref, leads });
    await provider.launch({ provider_ref: ref });
    return { provider, ref };
  }

  it('grows the funnel with elapsed time, never past uploaded', async () => {
    let t = 1_700_000_000_000;
    const { provider, ref } = await launched(() => t);
    const at0 = await provider.getStats({ provider_ref: ref });
    expect(at0.sent).toBeGreaterThan(0);
    t += 60_000;
    const at1 = await provider.getStats({ provider_ref: ref });
    expect(at1.sent).toBeGreaterThan(at0.sent);
    t += 86_400_000;
    const late = await provider.getStats({ provider_ref: ref });
    expect(late.sent).toBe(200);
    expect(late.delivered).toBe(late.sent - late.bounces);
    expect(late.opens).toBeGreaterThan(0);
  });

  it('honours a forced bounce rate and stable reply refs', async () => {
    let t = 1_700_000_000_000;
    const { provider, ref } = await launched(() => t);
    __setMockBounceRate(ref, 0.2);
    t += 600_000;
    const stats = await provider.getStats({ provider_ref: ref });
    expect(stats.bounces / stats.sent).toBeCloseTo(0.2, 1);

    const first = await provider.getReplies({ provider_ref: ref });
    const second = await provider.getReplies({ provider_ref: ref });
    expect(first.length).toBeGreaterThan(0);
    expect(first.map((r) => r.provider_ref)).toEqual(second.map((r) => r.provider_ref));
    const sinceLast = first[first.length - 1]!.received_at;
    expect(await provider.getReplies({ provider_ref: ref, since: sinceLast })).toEqual([]);
  });
});

describe('MockDomainProvider', () => {
  beforeEach(() => __resetMockDomains());

  it('checks availability deterministically and stores DNS records', async () => {
    const provider = new MockDomainProvider();
    const a = await provider.checkAvailability('outbound-fixture.test');
    expect(a).toEqual(await provider.checkAvailability('outbound-fixture.test'));
    await provider.setDnsRecords({
      domain: 'outbound-fixture.test',
      records: [{ type: 'TXT', host: '@', value: 'v=spf1 -all', purpose: 'spf' }],
    });
    const records = await provider.getDnsRecords({ domain: 'outbound-fixture.test' });
    expect(records).toHaveLength(1);
    expect(records[0]?.verified).toBe(true);
  });
});

describe('MockMailboxProvider', () => {
  beforeEach(() => {
    __resetMockMailboxes();
    __resetMockSending();
  });

  it('permutes names without digits and flips to ready', async () => {
    const provider = new MockMailboxProvider();
    const boxes = await provider.provision({
      domain: 'outbound-fixture.test',
      count: 6,
      display_name: 'Tom Smith',
      name_seeds: ['Tom Smith', 'Hilary Jones'],
    });
    expect(boxes).toHaveLength(6);
    const locals = boxes.map((b) => b.email.split('@')[0]);
    expect(locals.slice(0, 4)).toEqual(['t.smith', 'h.jones', 'tom.smith', 'hilary.jones']);
    for (const local of locals) expect(local).not.toMatch(/\d/);
    expect(new Set(locals).size).toBe(6);
    expect(boxes.every((b) => b.status === 'provisioning' && b.cost_cents === 3_000)).toBe(true);

    const ref = boxes[0]!.provider_ref;
    expect((await provider.getStatus({ provider_ref: ref })).status).toBe('warming');
    expect((await provider.getStatus({ provider_ref: ref })).status).toBe('ready');

    const senders = await new MockSendingProvider().listSenders();
    expect(senders.map((s) => s.email)).toContain('t.smith@outbound-fixture.test');
  });
});

describe('MockBillingProvider', () => {
  beforeEach(() => __resetMockBilling());

  it('builds a local checkout URL and verifies signed webhooks', async () => {
    const provider = new MockBillingProvider();
    const session = await provider.createCheckoutSession({
      account_id: 'acct-1',
      email: 'owner@fixture.test',
      code: 'PARTNER',
      trial_days: 30,
      price_cents: 200_000,
      success_url: 'http://localhost:3000/ok',
      cancel_url: 'http://localhost:3000/no',
    });
    expect(session.url).toContain('/api/mock/checkout-complete?');
    expect(session.url).toContain(`session_id=${session.session_id}`);
    expect(session.url).toContain('account_id=acct-1');

    const raw = JSON.stringify({ id: 'evt_1', type: 'checkout.session.completed', data: { object: { id: session.session_id } } });
    const event = await provider.verifyWebhook(raw, signMockWebhook(raw));
    expect(event).toMatchObject({ id: 'evt_1', type: 'checkout.session.completed' });
    await expect(provider.verifyWebhook(raw, 'mock-sig=deadbeef')).rejects.toThrow(/signature/);
  });
});

describe('MockLlmProvider', () => {
  const llm = new MockLlmProvider();
  const BUZZWORDS = /revolutioni[sz]e|game.?changing|unlock|synergy|leverage|seamless|cutting.?edge|supercharge|empower/i;

  it('returns compliant campaign copy', async () => {
    const { value, input_tokens, output_tokens } = await llm.json<CampaignCopy>({ ...llmInput, schema_name: 'campaign_copy' });
    expect(value.steps).toHaveLength(3);
    expect(input_tokens).toBeGreaterThan(0);
    expect(output_tokens).toBeGreaterThan(0);

    const wordRange: Record<number, [number, number]> = { 1: [30, 79], 2: [80, 120], 3: [30, 60] };
    for (const step of value.steps) {
      expect(step.body).toContain('{{unsubscribe_link}}');
      expect(step.body).toContain('{{sending_name}}');
      expect(step.body).toMatch(/P\.S\./);
      expect(step.body).not.toContain('—');
      expect(step.body).not.toMatch(BUZZWORDS);
      expect(step.subject).toBe(step.subject.toLowerCase());
      const words = step.body.split(/\s+/).filter(Boolean).length;
      const [min, max] = wordRange[step.step]!;
      expect(words, `step ${step.step} has ${words} words`).toBeGreaterThanOrEqual(min);
      expect(words, `step ${step.step} has ${words} words`).toBeLessThanOrEqual(max);
      for (const tag of step.body.matchAll(/\{\{(\w+)\}\}/g)) {
        expect(MERGE_TAGS as readonly string[]).toContain(tag[1]);
      }
    }
  });

  it('returns a full strategy and classifies replies', async () => {
    const { value } = await llm.json<GtmStrategy>({ ...llmInput, schema_name: 'gtm_strategy' });
    expect(value.segments.length).toBeGreaterThan(0);
    expect(value.sequence_plan[0]?.delay_days).toBe(0);
    const cls = await llm.json<{ sentiment: string }>({ ...llmInput, user: 'Please remove me from your list', schema_name: 'reply_classification' });
    expect(cls.value.sentiment).toBe('unsubscribe');
  });

  it('throws loudly on an unknown schema', async () => {
    await expect(llm.json({ ...llmInput, schema_name: 'nope' })).rejects.toThrow(/no fixture for schema_name "nope"/);
  });
});

describe('MockScrapeProvider', () => {
  it('derives a site from the hostname with a fixed clock', async () => {
    const provider = new MockScrapeProvider({ now: () => 1_700_000_000_000 });
    const a = await provider.scrape('https://www.acme-widgets.test/pricing');
    expect(a).toEqual(await provider.scrape('https://www.acme-widgets.test/pricing'));
    expect(a.title).toContain('Acme Widgets');
    expect(a.error).toBeUndefined();
    expect((await provider.scrape('not a url')).error).toMatch(/not a valid URL/);
  });
});

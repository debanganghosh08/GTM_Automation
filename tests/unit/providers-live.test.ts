/**
 * Live providers, offline. Every network call is stubbed: `fetch` is injected (or
 * stubbed on globalThis) and the Anthropic SDK client is either a fake passed to the
 * constructor or a real client with a stubbed `fetch` underneath it.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import type Anthropic from '@anthropic-ai/sdk';
import type { LeadSearchQuery } from '../../src/lib/contracts';
import { MissingCredentialError, env } from '../../src/lib/env';
import {
  AnthropicOutputError,
  AnthropicProvider,
  AnthropicRefusalError,
  AnthropicSpendLimitError,
  AnthropicTruncatedError,
  createAnthropicClient,
  type AnthropicMessagesClient,
} from '../../src/providers/live/anthropic';
import { ProspeoLeadProvider } from '../../src/providers/live/prospeo';
import { TrueListAuthError, TrueListProvider, mapTrueListState } from '../../src/providers/live/truelist';
import { GetLeadsNotApprovedError, GetLeadsProvider } from '../../src/providers/live/getleads';
import { HttpScrapeProvider, extractPage, isBlockedAddress } from '../../src/providers/live/scrape';

const noSleep = async (): Promise<void> => {};
type FetchStub = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

function jsonResponse(body: unknown, init: { status?: number; headers?: Record<string, string> } = {}): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
  });
}

const query: LeadSearchQuery = {
  titles: ['Head of Sales'],
  industries: ['Software'],
  geos: ['United Kingdom'],
  headcount_min: 20,
  headcount_max: 200,
  limit: 30,
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------- Anthropic

function fakeMessage(overrides: Partial<Anthropic.Message> = {}): Anthropic.Message {
  const base = {
    id: 'msg_test',
    type: 'message',
    role: 'assistant',
    model: 'claude-haiku-5-5',
    content: [{ type: 'text', text: '{"sentiment":"interested","confidence":0.9,"reason":"asks for more"}', citations: null }],
    stop_reason: 'end_turn',
    stop_sequence: null,
    stop_details: null,
    diagnostics: null,
    usage: {
      input_tokens: 120,
      output_tokens: 30,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
      cache_creation: null,
      server_tool_use: null,
      service_tier: 'standard',
    },
  };
  return { ...base, ...overrides } as unknown as Anthropic.Message;
}

function fakeClient(reply: Anthropic.Message | Error): { client: AnthropicMessagesClient; calls: Anthropic.MessageCreateParamsNonStreaming[] } {
  const calls: Anthropic.MessageCreateParamsNonStreaming[] = [];
  const client: AnthropicMessagesClient = {
    messages: {
      async create(params) {
        calls.push(params);
        if (reply instanceof Error) throw reply;
        return reply;
      },
    },
  };
  return { client, calls };
}

const llmInput = {
  system: 'Classify the reply.',
  user: 'Sounds relevant, send over more detail.',
  schema_name: 'reply_classification',
  schema: { type: 'object', properties: { sentiment: { type: 'string' } }, required: ['sentiment'], additionalProperties: false },
};

describe('AnthropicProvider', () => {
  it('sends structured-output params only: no temperature/top_p/top_k/tool_choice/response_format', async () => {
    const { client, calls } = fakeClient(fakeMessage());
    const provider = new AnthropicProvider(client);
    const out = await provider.json<{ sentiment: string }>({ ...llmInput, model: 'cheap' });

    expect(out.value.sentiment).toBe('interested');
    expect(out.model).toBe('claude-haiku-5-5');
    expect(out.input_tokens).toBe(120);
    expect(out.output_tokens).toBe(30);

    const params = calls[0]!;
    expect(params.model).toBe(env.models.cheap);
    expect(params.output_config).toEqual({ format: { type: 'json_schema', schema: llmInput.schema } });
    for (const forbidden of ['temperature', 'top_p', 'top_k', 'tool_choice', 'tools', 'response_format', 'thinking']) {
      expect(params).not.toHaveProperty(forbidden);
    }
    expect(params.system).toBe(llmInput.system);
  });

  it('selects the model from env.models by key and defaults to cheap', async () => {
    const { client, calls } = fakeClient(fakeMessage());
    const provider = new AnthropicProvider(client);
    await provider.json({ ...llmInput, model: 'strategy' });
    await provider.json({ ...llmInput, model: 'copy' });
    await provider.json({ ...llmInput });
    expect(calls.map((c) => c.model)).toEqual([env.models.strategy, env.models.copy, env.models.cheap]);
  });

  it('wraps the system prompt in a cache_control block when cache_system is set and reports cache usage', async () => {
    const { client, calls } = fakeClient(fakeMessage({
      usage: {
        input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 600, cache_read_input_tokens: 0,
        cache_creation: null, server_tool_use: null, service_tier: 'standard',
      } as unknown as Anthropic.Usage,
    }));
    const provider = new AnthropicProvider(client);
    const out = await provider.json({ ...llmInput, cache_system: true });
    expect(calls[0]!.system).toEqual([
      { type: 'text', text: llmInput.system, cache_control: { type: 'ephemeral' } },
    ]);
    expect(out.cache_creation_input_tokens).toBe(600);
    expect(out.cache_read_input_tokens).toBe(0);
    // Everything billed as input, cached or not.
    expect(out.input_tokens).toBe(610);
  });

  it('throws AnthropicRefusalError on stop_reason=refusal without parsing the text', async () => {
    const { client } = fakeClient(fakeMessage({
      stop_reason: 'refusal',
      stop_details: { type: 'refusal', category: 'general_harms', explanation: 'declined' } as unknown as Anthropic.Message['stop_details'],
      content: [{ type: 'text', text: 'not json at all', citations: null }],
    }));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const provider = new AnthropicProvider(client);
    const err = await provider.json(llmInput).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AnthropicRefusalError);
    expect(err).not.toBeInstanceOf(AnthropicTruncatedError);
    expect((err as AnthropicRefusalError).category).toBe('general_harms');
    expect((err as Error).message).toMatch(/refused/);
  });

  it('throws AnthropicTruncatedError on stop_reason=max_tokens', async () => {
    const { client } = fakeClient(fakeMessage({
      stop_reason: 'max_tokens',
      content: [{ type: 'text', text: '{"sentiment":"inte', citations: null }],
    }));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const provider = new AnthropicProvider(client);
    const err = await provider.json({ ...llmInput, max_tokens: 50 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AnthropicTruncatedError);
    expect(err).not.toBeInstanceOf(AnthropicRefusalError);
    expect((err as AnthropicTruncatedError).max_tokens).toBe(50);
    expect((err as Error).message).toMatch(/max_tokens=50/);
  });

  it('throws AnthropicOutputError when the text is not JSON', async () => {
    const { client } = fakeClient(fakeMessage({ content: [{ type: 'text', text: 'hello', citations: null }] }));
    const provider = new AnthropicProvider(client);
    await expect(provider.json(llmInput)).rejects.toBeInstanceOf(AnthropicOutputError);
  });

  it('does not retry a 429 whose error_code is enforced_spend_limit_reached', async () => {
    const fetchStub = vi.fn<FetchStub>(async () => jsonResponse(
      {
        type: 'error',
        error: {
          type: 'rate_limit_error',
          message: 'Your organization has reached its spend limit.',
          details: { error_code: 'enforced_spend_limit_reached' },
        },
      },
      { status: 429, headers: { 'request-id': 'req_spend_cap' } },
    ));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const client = createAnthropicClient({ apiKey: 'test-key', fetch: fetchStub as unknown as typeof fetch });
    const provider = new AnthropicProvider(client);

    const err = await provider.json(llmInput).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AnthropicSpendLimitError);
    expect((err as Error).message).toMatch(/spend limit/);
    expect((err as Error).message).toMatch(/req_spend_cap/);
    expect(fetchStub).toHaveBeenCalledTimes(1);
  });

  it('still retries an ordinary 429 (so the spend-cap guard is specific, not blanket)', async () => {
    let n = 0;
    const fetchStub = vi.fn<FetchStub>(async () => {
      n += 1;
      if (n < 3) {
        return jsonResponse(
          { type: 'error', error: { type: 'rate_limit_error', message: 'slow down' } },
          { status: 429, headers: { 'retry-after-ms': '10' } },
        );
      }
      return jsonResponse(fakeMessage(), { headers: { 'request-id': 'req_ok' } });
    });
    const client = createAnthropicClient({ apiKey: 'test-key', fetch: fetchStub as unknown as typeof fetch });
    const provider = new AnthropicProvider(client);
    const out = await provider.json<{ sentiment: string }>(llmInput);
    expect(out.value.sentiment).toBe('interested');
    expect(out.request_id).toBe('req_ok');
    expect(fetchStub).toHaveBeenCalledTimes(3);
  });

  it.skipIf(Boolean(env.anthropicApiKey))('fails loudly without ANTHROPIC_API_KEY', () => {
    expect(() => new AnthropicProvider()).toThrow(MissingCredentialError);
  });
});

// ---------------------------------------------------------------- TrueList

describe('TrueListProvider', () => {
  it('maps email_state/email_sub_state to LeadVerification', () => {
    expect(mapTrueListState('ok', null)).toBe('valid');
    expect(mapTrueListState('invalid', 'failed_no_mailbox')).toBe('invalid');
    expect(mapTrueListState('unknown', null)).toBe('unknown');
    expect(mapTrueListState('risky', 'accept_all')).toBe('catch_all');
    expect(mapTrueListState('risky', 'role_address')).toBe('risky');
    expect(mapTrueListState('risky', 'disposable_address')).toBe('risky');
    expect(mapTrueListState('something_new', null)).toBe('unknown');
    expect(mapTrueListState(undefined, undefined)).toBe('unknown');
  });

  it('verifies each address through verify_inline with Bearer auth and keeps order', async () => {
    const states: Record<string, [string, string | null]> = {
      'a@example.com': ['ok', null],
      'b@example.com': ['risky', 'accept_all'],
      'c@example.com': ['invalid', 'failed_no_mailbox'],
      'd@example.com': ['risky', 'role_address'],
    };
    const fetchStub = vi.fn<FetchStub>(async (input, init) => {
      const url = new URL(String(input));
      expect(url.origin + url.pathname).toBe('https://api.truelist.io/api/v1/verify_inline');
      expect(init?.method).toBe('POST');
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer tl-test');
      const email = url.searchParams.get('email')!;
      const [state, sub] = states[email]!;
      return jsonResponse({ emails: [{ address: email, email_state: state, email_sub_state: sub }] });
    });
    const provider = new TrueListProvider({ apiKey: 'tl-test', fetch: fetchStub, sleep: noSleep, concurrency: 2 });
    const results = await provider.verify(Object.keys(states));
    expect(results.map((r) => r.status)).toEqual(['valid', 'catch_all', 'invalid', 'risky']);
    expect(results.map((r) => r.email)).toEqual(Object.keys(states));
    expect(results.every((r) => r.provider === 'truelist')).toBe(true);
    expect(fetchStub).toHaveBeenCalledTimes(4);
  });

  it('spaces request starts to stay under 10 req/s', async () => {
    const waits: number[] = [];
    const fetchStub = vi.fn<FetchStub>(async (input) => {
      const email = new URL(String(input)).searchParams.get('email')!;
      return jsonResponse({ emails: [{ address: email, email_state: 'ok', email_sub_state: null }] });
    });
    const provider = new TrueListProvider({
      apiKey: 'tl-test', fetch: fetchStub, concurrency: 8, minIntervalMs: 125,
      sleep: async (ms) => { waits.push(ms); },
    });
    await provider.verify(Array.from({ length: 8 }, (_, i) => `u${i}@example.com`));
    // Eight requests started at once would be a burst; all but the first must have waited.
    expect(waits.length).toBeGreaterThanOrEqual(7);
    expect(Math.max(...waits)).toBeGreaterThanOrEqual(125 * 7 - 5);
  });

  it('returns unknown for a malformed 200 body instead of trusting the status', async () => {
    const fetchStub = vi.fn<FetchStub>(async () => jsonResponse({ ok: true }));
    const provider = new TrueListProvider({ apiKey: 'tl-test', fetch: fetchStub, sleep: noSleep });
    const [r] = await provider.verify(['x@example.com']);
    expect(r?.status).toBe('unknown');
  });

  it('throws on 401 so a bad key is loud', async () => {
    const fetchStub = vi.fn<FetchStub>(async () => jsonResponse({ error: 'unauthorized' }, { status: 401 }));
    const provider = new TrueListProvider({ apiKey: 'bad', fetch: fetchStub, sleep: noSleep });
    await expect(provider.verify(['x@example.com'])).rejects.toBeInstanceOf(TrueListAuthError);
  });

  it.skipIf(Boolean(env.truelistApiKey))('fails loudly without TRUELIST_API_KEY', () => {
    expect(() => new TrueListProvider()).toThrow(MissingCredentialError);
  });
});

// ---------------------------------------------------------------- Scrape

const publicLookup = async (): Promise<Array<{ address: string; family: number }>> => [{ address: '93.184.216.34', family: 4 }];

describe('HttpScrapeProvider', () => {
  it('refuses loopback and the cloud metadata address without calling fetch', async () => {
    const fetchStub = vi.fn<FetchStub>();
    const provider = new HttpScrapeProvider({ fetch: fetchStub, lookup: publicLookup });
    for (const url of ['http://127.0.0.1/', 'http://169.254.169.254/latest/meta-data/', 'http://[::1]/', 'http://localhost:3000/']) {
      const out = await provider.scrape(url);
      expect(out.error, url).toMatch(/refusing/);
      expect(out.title).toBeNull();
      expect(out.headings).toEqual([]);
    }
    expect(fetchStub).not.toHaveBeenCalled();
  });

  it('refuses a hostname that resolves to a private address', async () => {
    const fetchStub = vi.fn<FetchStub>();
    const provider = new HttpScrapeProvider({
      fetch: fetchStub,
      lookup: async () => [{ address: '10.0.0.5', family: 4 }],
    });
    const out = await provider.scrape('https://intranet.example.com/');
    expect(out.error).toMatch(/resolves to private or local address 10\.0\.0\.5/);
    expect(fetchStub).not.toHaveBeenCalled();
  });

  it('refuses non-http schemes', async () => {
    const provider = new HttpScrapeProvider({ fetch: vi.fn<FetchStub>(), lookup: publicLookup });
    const out = await provider.scrape('ftp://example.com/');
    expect(out.error).toMatch(/unsupported URL scheme/);
  });

  it('returns error instead of throwing on a network failure', async () => {
    const fetchStub = vi.fn<FetchStub>(async () => { throw new TypeError('fetch failed: ECONNRESET'); });
    const provider = new HttpScrapeProvider({ fetch: fetchStub, lookup: publicLookup, now: () => 0 });
    const out = await provider.scrape('https://example.com');
    expect(out.error).toMatch(/fetch failed/);
    expect(out.url).toBe('https://example.com');
    expect(out.fetched_at).toBe('1970-01-01T00:00:00.000Z');
    expect(out.truncated).toBe(false);
  });

  it('extracts title, description, headings and an excerpt from HTML', async () => {
    const html = `<!doctype html><html><head>
      <title> Acme &amp; Co | Outbound done for you </title>
      <meta content="We build your pipeline." name="description">
      <script>var x = "<h1>not a heading</h1>";</script>
      </head><body>
      <h1>Qualified meetings without hiring an SDR team</h1>
      <nav><h2>Pricing</h2></nav>
      <h2>Verified lists, warmed inboxes, replies in your CRM</h2>
      <h2>Verified lists, warmed inboxes, replies in your CRM</h2>
      <p>Trusted by growing teams.</p>
      </body></html>`;
    const fetchStub = vi.fn<FetchStub>(async () => new Response(html, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } }));
    const provider = new HttpScrapeProvider({ fetch: fetchStub, lookup: publicLookup });
    const out = await provider.scrape('https://example.com/');
    expect(out.error).toBeUndefined();
    expect(out.title).toBe('Acme & Co | Outbound done for you');
    expect(out.description).toBe('We build your pipeline.');
    expect(out.headings).toEqual([
      'Qualified meetings without hiring an SDR team',
      'Pricing',
      'Verified lists, warmed inboxes, replies in your CRM',
    ]);
    expect(out.value_props).toEqual([
      'Qualified meetings without hiring an SDR team',
      'Verified lists, warmed inboxes, replies in your CRM',
    ]);
    expect(out.raw_text_excerpt).toContain('Trusted by growing teams.');
    expect(out.raw_text_excerpt).not.toContain('not a heading');
    expect(out.customers_mentioned).toEqual([]);
    expect(out.truncated).toBe(false);
  });

  it('follows at most 3 redirects and re-checks each hop', async () => {
    const fetchStub = vi.fn<FetchStub>(async (input) =>
      new Response(null, { status: 302, headers: { location: `${String(input)}next/` } }),
    );
    const provider = new HttpScrapeProvider({ fetch: fetchStub, lookup: publicLookup });
    const out = await provider.scrape('https://example.com/');
    expect(out.error).toMatch(/too many redirects/);
    expect(fetchStub).toHaveBeenCalledTimes(4); // original + 3 redirects, then stop

    const toPrivate = vi.fn<FetchStub>(async () => new Response(null, { status: 301, headers: { location: 'http://169.254.169.254/' } }));
    const guarded = new HttpScrapeProvider({ fetch: toPrivate, lookup: publicLookup });
    const out2 = await guarded.scrape('https://example.com/');
    expect(out2.error).toMatch(/refusing/);
    expect(toPrivate).toHaveBeenCalledTimes(1);
  });

  it('caps the body at ~500KB and reports truncation', async () => {
    const big = `<html><head><title>Big</title></head><body>${'x'.repeat(900 * 1024)}</body></html>`;
    const fetchStub = vi.fn<FetchStub>(async () => new Response(big, { status: 200, headers: { 'content-type': 'text/html' } }));
    const provider = new HttpScrapeProvider({ fetch: fetchStub, lookup: publicLookup });
    const out = await provider.scrape('https://example.com/');
    expect(out.error).toBeUndefined();
    expect(out.title).toBe('Big');
    expect(out.truncated).toBe(true);
    expect((out.raw_text_excerpt ?? '').length).toBeLessThanOrEqual(2_000);
  });

  it('rejects non-HTML content types', async () => {
    const fetchStub = vi.fn<FetchStub>(async () => new Response('%PDF-1.4', { status: 200, headers: { 'content-type': 'application/pdf' } }));
    const provider = new HttpScrapeProvider({ fetch: fetchStub, lookup: publicLookup });
    const out = await provider.scrape('https://example.com/brochure.pdf');
    expect(out.error).toMatch(/not an HTML page/);
  });

  it('classifies addresses', () => {
    expect(isBlockedAddress('127.0.0.1')).toBe(true);
    expect(isBlockedAddress('169.254.169.254')).toBe(true);
    expect(isBlockedAddress('10.1.2.3')).toBe(true);
    expect(isBlockedAddress('172.16.0.1')).toBe(true);
    expect(isBlockedAddress('172.32.0.1')).toBe(false);
    expect(isBlockedAddress('192.168.1.1')).toBe(true);
    expect(isBlockedAddress('100.64.0.1')).toBe(true);
    expect(isBlockedAddress('0.0.0.0')).toBe(true);
    expect(isBlockedAddress('::1')).toBe(true);
    expect(isBlockedAddress('::ffff:127.0.0.1')).toBe(true);
    expect(isBlockedAddress('::ffff:8.8.8.8')).toBe(false);
    expect(isBlockedAddress('fe80::1')).toBe(true);
    expect(isBlockedAddress('fd00::1')).toBe(true);
    expect(isBlockedAddress('2606:4700::6810:84e5')).toBe(false);
    expect(isBlockedAddress('8.8.8.8')).toBe(false);
    expect(isBlockedAddress('not-an-ip')).toBe(true);
  });

  it('extractPage handles a page with no body or head', () => {
    const out = extractPage('<p>just text</p>');
    expect(out.title).toBeNull();
    expect(out.description).toBeNull();
    expect(out.headings).toEqual([]);
    expect(out.excerpt).toBe('just text');
  });
});

// ---------------------------------------------------------------- GetLeads

describe('GetLeadsProvider', () => {
  it('throws on construction without GETLEADS_SAAS_APPROVED=true, pointing at VENDOR_NOTES §4', () => {
    const previous = process.env.GETLEADS_SAAS_APPROVED;
    delete process.env.GETLEADS_SAAS_APPROVED;
    try {
      expect(() => new GetLeadsProvider({ apiKey: 'gl-test' })).toThrow(GetLeadsNotApprovedError);
      expect(() => new GetLeadsProvider({ apiKey: 'gl-test' })).toThrow(/VENDOR_NOTES\.md §4/);
      expect(() => new GetLeadsProvider({ apiKey: 'gl-test' })).toThrow(/GETLEADS_SAAS_APPROVED=true/);
      process.env.GETLEADS_SAAS_APPROVED = 'false';
      expect(() => new GetLeadsProvider({ apiKey: 'gl-test' })).toThrow(GetLeadsNotApprovedError);
    } finally {
      if (previous === undefined) delete process.env.GETLEADS_SAAS_APPROVED;
      else process.env.GETLEADS_SAAS_APPROVED = previous;
    }
  });

  it('constructs when the env flag is set', () => {
    const previous = process.env.GETLEADS_SAAS_APPROVED;
    process.env.GETLEADS_SAAS_APPROVED = 'true';
    try {
      expect(new GetLeadsProvider({ apiKey: 'gl-test' }).name).toBe('getleads');
    } finally {
      if (previous === undefined) delete process.env.GETLEADS_SAAS_APPROVED;
      else process.env.GETLEADS_SAAS_APPROVED = previous;
    }
  });

  it.skipIf(Boolean(env.getleadsApiKey))('still requires the API key once approved', () => {
    expect(() => new GetLeadsProvider({ approved: true })).toThrow(MissingCredentialError);
  });

  it('searches with offset pagination behind the gate and reports exhaustion honestly', async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const fetchStub = vi.fn<FetchStub>(async (input, init) => {
      expect(String(input)).toBe('https://api.getleads.ai/api/v1/contacts/search');
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer gl-test');
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      bodies.push(body);
      return jsonResponse({
        data: [
          { email: 'One@Example.com', first_name: 'One', job_title: 'Head of Sales', company: { name: 'Ex', domain: 'example.com', employees: 50 } },
          { email: 'two@example.com', first_name: 'Two' },
          { first_name: 'NoEmail' },
        ],
      });
    });
    const provider = new GetLeadsProvider({ apiKey: 'gl-test', approved: true, fetch: fetchStub, sleep: noSleep });
    const out = await provider.search({ ...query, limit: 100 });
    expect(out.provider).toBe('getleads');
    expect(out.stop_reason).toBe('exhausted');
    expect(out.leads.map((l) => l.email)).toEqual(['one@example.com', 'two@example.com']);
    expect(out.leads[0]?.headcount).toBe(50);
    expect(out.cost_cents).toBe(0);
    expect(bodies[0]).toMatchObject({ limit: 100, offset: 0, job_titles: ['Head of Sales'] });
    expect(fetchStub).toHaveBeenCalledTimes(1);
  });

  it('reports rate_limited after repeated 429s', async () => {
    const fetchStub = vi.fn<FetchStub>(async () => jsonResponse({ error: 'too many' }, { status: 429 }));
    const provider = new GetLeadsProvider({ apiKey: 'gl-test', approved: true, fetch: fetchStub, sleep: noSleep });
    const out = await provider.search({ ...query, limit: 10 });
    expect(out.stop_reason).toBe('rate_limited');
    expect(out.leads).toEqual([]);
    expect(out.error).toMatch(/rate limited/);
  });
});

// ---------------------------------------------------------------- Prospeo

function prospeoPage(count: number, startAt: number): Response {
  const results = Array.from({ length: count }, (_, i) => ({
    person: { email: `lead${startAt + i}@example.com`, first_name: `L${startAt + i}`, title: 'Head of Sales' },
    company: { name: 'Ex', domain: 'example.com', size: 80 },
  }));
  return jsonResponse({ error: false, results, pagination: { total_count: 1000 } }, {
    headers: { 'x-minute-request-left': '4', 'x-daily-request-left': '1990' },
  });
}

describe('ProspeoLeadProvider', () => {
  it('paginates /search-person with X-KEY, charges one credit per page and stops at the limit', async () => {
    const pages: number[] = [];
    const fetchStub = vi.fn<FetchStub>(async (input, init) => {
      expect(String(input)).toBe('https://api.prospeo.io/search-person');
      expect(init?.method).toBe('POST');
      expect(new Headers(init?.headers).get('x-key')).toBe('pr-test');
      const body = JSON.parse(String(init?.body)) as { page: number; filters: Record<string, unknown> };
      pages.push(body.page);
      expect(body.filters).toHaveProperty('person_title');
      return prospeoPage(25, (body.page - 1) * 25);
    });
    const provider = new ProspeoLeadProvider({ apiKey: 'pr-test', fetch: fetchStub, sleep: noSleep, centsPerCredit: 3 });
    const out = await provider.search({ ...query, limit: 30 });
    expect(pages).toEqual([1, 2]);
    expect(out.leads).toHaveLength(30);
    expect(out.stop_reason).toBe('limit_reached');
    expect(out.cost_cents).toBe(6);
    expect(out.provider).toBe('prospeo');
    expect(out.error).toBeUndefined();
  });

  it('reports exhausted on a short page', async () => {
    const fetchStub = vi.fn<FetchStub>(async () => prospeoPage(7, 0));
    const provider = new ProspeoLeadProvider({ apiKey: 'pr-test', fetch: fetchStub, sleep: noSleep });
    const out = await provider.search({ ...query, limit: 100 });
    expect(out.leads).toHaveLength(7);
    expect(out.stop_reason).toBe('exhausted');
    expect(out.cost_cents).toBe(2);
    expect(fetchStub).toHaveBeenCalledTimes(1);
  });

  it('reports rate_limited when the daily allowance is gone, keeping what it already has', async () => {
    let n = 0;
    const fetchStub = vi.fn<FetchStub>(async () => {
      n += 1;
      if (n === 1) return prospeoPage(25, 0);
      return jsonResponse({ error: true, message: 'rate limit' }, { status: 429, headers: { 'x-daily-request-left': '0' } });
    });
    const provider = new ProspeoLeadProvider({ apiKey: 'pr-test', fetch: fetchStub, sleep: noSleep });
    const out = await provider.search({ ...query, limit: 100 });
    expect(out.leads).toHaveLength(25);
    expect(out.stop_reason).toBe('rate_limited');
    expect(out.error).toMatch(/daily/);
    expect(out.cost_cents).toBe(2);
  });

  it('treats a 200 with an unexpected shape as an error, not as data', async () => {
    const fetchStub = vi.fn<FetchStub>(async () => jsonResponse({ hello: 'world' }));
    const provider = new ProspeoLeadProvider({ apiKey: 'pr-test', fetch: fetchStub, sleep: noSleep });
    const out = await provider.search({ ...query, limit: 10 });
    expect(out.stop_reason).toBe('error');
    expect(out.leads).toEqual([]);
    expect(out.error).toMatch(/no results array/);
  });

  it('retries 5xx with backoff then gives up as error', async () => {
    const fetchStub = vi.fn<FetchStub>(async () => jsonResponse({ error: true }, { status: 503 }));
    const provider = new ProspeoLeadProvider({ apiKey: 'pr-test', fetch: fetchStub, sleep: noSleep });
    const out = await provider.search({ ...query, limit: 10 });
    expect(out.stop_reason).toBe('error');
    expect(fetchStub).toHaveBeenCalledTimes(4);
  });

  it.skipIf(Boolean(env.prospeoApiKey))('fails loudly without PROSPEO_API_KEY', () => {
    expect(() => new ProspeoLeadProvider()).toThrow(MissingCredentialError);
  });
});

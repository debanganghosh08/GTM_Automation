/**
 * EmailBison live provider: request shapes and the pure parts.
 *
 * No network. `globalThis.fetch` is stubbed with a tiny router that records every
 * request and answers with canned bodies modelled on the spec's response examples.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MissingCredentialError } from '../../src/lib/env';
import { HttpError, parseRetryAfter } from '../../src/providers/live/http';
import {
  EmailBisonProvider,
  EmailBisonResponseError,
  EmailBisonTruncatedError,
  LEAD_CHUNK_SIZE,
  mergeTagsIn,
  toEmailBisonVariables,
} from '../../src/providers/live/emailbison';

// ---------------------------------------------------------------- fetch stub

interface Recorded {
  method: string;
  path: string;
  query: URLSearchParams;
  body: unknown;
  headers: Record<string, string>;
}

type Handler = (req: Recorded) => { status?: number; body?: unknown; headers?: Record<string, string> };

const calls: Recorded[] = [];
let routes: Array<{ method: string; path: RegExp; handle: Handler }> = [];
let originalFetch: typeof fetch;

function route(method: string, path: RegExp, handle: Handler): void {
  routes.push({ method, path, handle });
}

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(body === undefined ? '' : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

const stubFetch: typeof fetch = async (input, init) => {
  const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url);
  const headers: Record<string, string> = {};
  const rawHeaders = init?.headers;
  if (rawHeaders && !(rawHeaders instanceof Headers) && !Array.isArray(rawHeaders)) Object.assign(headers, rawHeaders);
  const rec: Recorded = {
    method: init?.method ?? 'GET',
    path: url.pathname,
    query: url.searchParams,
    body: typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined,
    headers,
  };
  calls.push(rec);
  const match = routes.find((r) => r.method === rec.method && r.path.test(rec.path));
  if (!match) return jsonResponse(404, { message: `no stub for ${rec.method} ${rec.path}` });
  const out = match.handle(rec);
  return jsonResponse(out.status ?? 200, out.body, out.headers);
};

function paged(items: unknown[], page: number, perPage = 15, path = '/x'): unknown {
  const lastPage = Math.max(1, Math.ceil(items.length / perPage));
  const slice = items.slice((page - 1) * perPage, page * perPage);
  return {
    data: slice,
    links: { first: `${path}?page=1`, last: `${path}?page=${lastPage}`, prev: null, next: page < lastPage ? `${path}?page=${page + 1}` : null },
    meta: { current_page: page, last_page: lastPage, per_page: perPage, total: items.length },
  };
}

function pageOf(req: Recorded): number {
  return Number.parseInt(req.query.get('page') ?? '1', 10);
}

function provider(extra: ConstructorParameters<typeof EmailBisonProvider>[0] = {}): EmailBisonProvider {
  return new EmailBisonProvider({
    baseUrl: 'https://bison.test',
    apiToken: 'test-token-do-not-log',
    http: { sleep: async () => undefined, log: () => undefined, maxRetries: 3 },
    ...extra,
  });
}

function requests(method: string, pathPrefix: string): Recorded[] {
  return calls.filter((c) => c.method === method && c.path.startsWith(pathPrefix));
}

beforeEach(() => {
  originalFetch = globalThis.fetch;
  globalThis.fetch = stubFetch;
  calls.length = 0;
  routes = [];
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

// ---------------------------------------------------------------- pure parts

describe('toEmailBisonVariables', () => {
  it('converts {{first_name}} to {FIRST_NAME} and leaves unknown text alone', () => {
    const body = '{{first_name}}, saw that {{company_name}} does {thing|stuff}. {{not_a_tag}} stays. {FIRST_NAME} too.';
    expect(toEmailBisonVariables(body)).toBe(
      '{FIRST_NAME}, saw that {COMPANY_NAME} does {thing|stuff}. {{not_a_tag}} stays. {FIRST_NAME} too.',
    );
  });

  it('maps every merge tag except the unsubscribe link to a single-brace upper-case token', () => {
    const body = '{{first_name}} {{last_name}} {{company_name}} {{title}} {{industry}} {{sending_name}}';
    expect(toEmailBisonVariables(body)).toBe('{FIRST_NAME} {LAST_NAME} {COMPANY_NAME} {TITLE} {INDUSTRY} {SENDER_FIRST_NAME}');
  });

  it('removes {{unsubscribe_link}} and drops the line when nothing else was on it', () => {
    const body = 'Hi {{first_name}},\n\nP.S. reply "no" and I will stop.\n{{unsubscribe_link}}\nThanks';
    expect(toEmailBisonVariables(body)).toBe('Hi {FIRST_NAME},\n\nP.S. reply "no" and I will stop.\nThanks');
  });

  it('keeps the surrounding words when the unsubscribe tag shares a line with prose', () => {
    expect(toEmailBisonVariables('Opt out here {{unsubscribe_link}}')).toBe('Opt out here');
  });

  it('tolerates whitespace inside the braces', () => {
    expect(toEmailBisonVariables('{{ first_name }}')).toBe('{FIRST_NAME}');
  });
});

describe('mergeTagsIn', () => {
  it('lists only known tags, deduplicated, in MERGE_TAGS order', () => {
    expect(mergeTagsIn('{{company_name}} {{first_name}} {{first_name}} {{bogus}}')).toEqual(['first_name', 'company_name']);
  });
});

describe('parseRetryAfter', () => {
  it('reads delta-seconds', () => {
    expect(parseRetryAfter('7')).toBe(7000);
  });
  it('reads an HTTP-date relative to now', () => {
    const now = Date.parse('2026-10-23T10:00:00Z');
    expect(parseRetryAfter('Fri, 23 Oct 2026 10:00:30 GMT', now)).toBe(30_000);
  });
  it('returns null for garbage or absence', () => {
    expect(parseRetryAfter(null)).toBeNull();
    expect(parseRetryAfter('soon')).toBeNull();
  });
});

// ---------------------------------------------------------------- construction

describe('EmailBisonProvider construction', () => {
  it('fails loudly without a token', () => {
    const saved = process.env['EMAILBISON_API_TOKEN'];
    delete process.env['EMAILBISON_API_TOKEN'];
    try {
      expect(() => new EmailBisonProvider({ apiToken: '' })).toThrow(MissingCredentialError);
    } finally {
      if (saved !== undefined) process.env['EMAILBISON_API_TOKEN'] = saved;
    }
  });

  it('sends the bearer token and never a plain token header', async () => {
    route('GET', /^\/api\/sender-emails$/, () => ({ body: paged([{ id: 1, email: 'a@x.test' }], 1) }));
    await provider().listSenders();
    expect(calls[0]?.headers['Authorization']).toBe('Bearer test-token-do-not-log');
  });
});

// ---------------------------------------------------------------- senders

describe('listSenders', () => {
  it('walks every page and maps id/email', async () => {
    const senders = Array.from({ length: 32 }, (_, i) => ({ id: i + 1, email: `s${i + 1}@x.test`, status: 'Connected' }));
    route('GET', /^\/api\/sender-emails$/, (req) => ({ body: paged(senders, pageOf(req), 15, '/api/sender-emails') }));
    const out = await provider().listSenders();
    expect(out).toHaveLength(32);
    expect(out[0]).toEqual({ sender_email_id: '1', email: 's1@x.test' });
    expect(requests('GET', '/api/sender-emails')).toHaveLength(3);
  });

  it('reports truncation instead of returning a partial list', async () => {
    const senders = Array.from({ length: 60 }, (_, i) => ({ id: i + 1, email: `s${i + 1}@x.test` }));
    route('GET', /^\/api\/sender-emails$/, (req) => ({ body: paged(senders, pageOf(req), 15, '/api/sender-emails') }));
    await expect(provider({ maxPages: 2 }).listSenders()).rejects.toBeInstanceOf(EmailBisonTruncatedError);
  });

  it('rejects a 200 whose body has no data array', async () => {
    route('GET', /^\/api\/sender-emails$/, () => ({ body: { ok: true } }));
    await expect(provider().listSenders()).rejects.toBeInstanceOf(EmailBisonResponseError);
  });
});

// ---------------------------------------------------------------- attach senders

describe('attachSenders', () => {
  it('(a) posts to /attach-sender-emails with a sender_email_ids key', async () => {
    route('POST', /^\/api\/campaigns\/42\/attach-sender-emails$/, () => ({ body: { success: true, message: 'ok' } }));
    await provider().attachSenders({ provider_ref: '42', sender_email_ids: ['7', '9'] });
    const [req] = requests('POST', '/api/campaigns/42/attach-sender-emails');
    expect(req).toBeDefined();
    expect(req?.body).toEqual({ sender_email_ids: ['7', '9'] });
    expect(JSON.stringify(req?.body)).not.toContain('email_account_ids');
  });

  it('treats success:false as a failure even on HTTP 200', async () => {
    route('POST', /attach-sender-emails$/, () => ({ body: { success: false, message: 'nope' } }));
    await expect(provider().attachSenders({ provider_ref: '42', sender_email_ids: ['7'] })).rejects.toBeInstanceOf(EmailBisonResponseError);
  });

  it('refuses a provider_ref that is not an EmailBison id', async () => {
    await expect(provider().attachSenders({ provider_ref: 'mock-campaign-1', sender_email_ids: ['7'] })).rejects.toThrow(/provider_ref/);
    expect(calls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------- leads

describe('uploadLeads', () => {
  it('(b) chunks 1,200 leads into 3 upsert requests of at most 500 and counts from the response', async () => {
    let nextId = 1000;
    route('GET', /^\/api\/custom-variables$/, () => ({ body: paged([{ id: 1, name: 'company_name' }, { id: 2, name: 'last_name' }], 1) }));
    route('POST', /^\/api\/leads\/create-or-update\/multiple$/, (req) => {
      const body = req.body as { leads: Array<{ email: string }> };
      // The vendor silently skips one lead per chunk (e.g. a personal domain).
      const kept = body.leads.slice(1);
      return { status: 201, body: { data: kept.map((l) => ({ id: nextId++, email: l.email })) } };
    });
    route('POST', /^\/api\/campaigns\/42\/leads\/attach-leads$/, () => ({ body: { data: { success: true, message: 'ok' } } }));

    const leads = Array.from({ length: 1200 }, (_, i) => ({
      email: `lead${i}@corp${i % 97}.test`,
      fields: { first_name: `F${i}`, last_name: 'L', company_name: `C${i}` },
    }));
    const result = await provider().uploadLeads({ provider_ref: '42', leads });

    const upserts = requests('POST', '/api/leads/create-or-update/multiple');
    expect(upserts).toHaveLength(3);
    const sizes = upserts.map((r) => (r.body as { leads: unknown[] }).leads.length);
    expect(sizes).toEqual([500, 500, 200]);
    for (const size of sizes) expect(size).toBeLessThanOrEqual(LEAD_CHUNK_SIZE);
    expect((upserts[0]?.body as { existing_lead_behavior: string }).existing_lead_behavior).toBe('patch');

    const attaches = requests('POST', '/api/campaigns/42/leads/attach-leads');
    expect(attaches.length).toBeGreaterThan(0);
    const attachedIds = attaches.flatMap((r) => (r.body as { lead_ids: number[] }).lead_ids);
    expect(attachedIds).toHaveLength(1197);
    expect(attachedIds.every((id) => typeof id === 'number')).toBe(true);
    expect((attaches[0]?.body as { allow_parallel_sending: boolean }).allow_parallel_sending).toBe(false);

    expect(result).toEqual({ uploaded: 1197, rejected: 3 });
  });

  it('maps fields onto native columns and custom variables, creating missing variables first', async () => {
    const created: string[] = [];
    route('GET', /^\/api\/custom-variables$/, () => ({ body: paged([{ id: 1, name: 'company_name' }], 1) }));
    route('POST', /^\/api\/custom-variables$/, (req) => {
      const name = (req.body as { name: string }).name;
      created.push(name);
      return { body: { data: { id: 50 + created.length, name } } };
    });
    route('POST', /create-or-update\/multiple$/, () => ({ status: 201, body: { data: [{ id: 1 }] } }));
    route('POST', /attach-leads$/, () => ({ body: { data: { success: true } } }));

    await provider().uploadLeads({
      provider_ref: '42',
      leads: [{ email: 'Jo@Acme.test', fields: { first_name: 'Jo', last_name: 'Bloggs', title: 'CEO', company_name: 'Acme', industry: 'SaaS', unsubscribe_link: 'https://x', sending_name: 'Sam' } }],
    });

    expect(created.sort()).toEqual(['industry', 'last_name', 'title']);
    const [upsert] = requests('POST', '/api/leads/create-or-update/multiple');
    const lead = (upsert?.body as { leads: Array<Record<string, unknown>> }).leads[0];
    expect(lead).toMatchObject({ email: 'jo@acme.test', first_name: 'Jo', last_name: 'Bloggs', title: 'CEO', company: 'Acme' });
    const names = (lead?.['custom_variables'] as Array<{ name: string }>).map((v) => v.name).sort();
    expect(names).toEqual(['company_name', 'industry', 'last_name', 'title']);
    expect(JSON.stringify(lead)).not.toContain('unsubscribe_link');
  });

  it('counts leads it could not send (no first name, bad email, duplicates) as rejected', async () => {
    route('GET', /^\/api\/custom-variables$/, () => ({ body: paged([], 1) }));
    route('POST', /create-or-update\/multiple$/, (req) => ({
      status: 201,
      body: { data: (req.body as { leads: unknown[] }).leads.map((_, i) => ({ id: i + 1 })) },
    }));
    route('POST', /attach-leads$/, () => ({ body: { data: { success: true } } }));
    const result = await provider().uploadLeads({
      provider_ref: '42',
      leads: [
        { email: 'ok@corp.test', fields: { first_name: 'A' } },
        { email: 'OK@corp.test', fields: { first_name: 'Dup' } },
        { email: 'no-name@corp.test', fields: {} },
        { email: 'not an email', fields: { first_name: 'B' } },
      ],
    });
    expect(result).toEqual({ uploaded: 1, rejected: 3 });
  });
});

// ---------------------------------------------------------------- campaign build

describe('createCampaign', () => {
  const steps = [
    { step: 1, delay_days: 0, subject: '{quick|fast} question', body: '{{first_name}}, saw {{company_name}}.\n\nP.S. reply no.\n{{unsubscribe_link}}' },
    { step: 2, delay_days: 3, subject: '{quick|fast} question', body: 'Following up.\n{{unsubscribe_link}}' },
  ];

  function stubBuild(echo: Record<string, unknown> = {}): void {
    route('GET', /^\/api\/custom-variables$/, () => ({ body: paged([], 1) }));
    route('POST', /^\/api\/custom-variables$/, (req) => ({ body: { data: { id: 9, name: (req.body as { name: string }).name } } }));
    route('POST', /^\/api\/campaigns$/, () => ({ body: { data: { id: 77, name: 'c', type: 'outbound', status: 'Draft' } } }));
    route('PATCH', /^\/api\/campaigns\/77\/update$/, (req) => ({
      body: { data: { id: 77, ...(req.body as Record<string, unknown>), ...echo } },
    }));
    route('POST', /^\/api\/campaigns\/v1\.1\/77\/sequence-steps$/, (req) => ({
      body: { data: { id: 5, title: 'c', sequence_steps: (req.body as { sequence_steps: unknown[] }).sequence_steps.map((s, i) => ({ id: i + 1, ...(s as object) })) } },
    }));
  }

  it('creates, configures unsubscribe/plain text, and posts v1.1 sequence steps with translated tags', async () => {
    stubBuild();
    const { provider_ref } = await provider().createCampaign({ name: 'Campaign A', steps, timezone: 'Europe/London' });
    expect(provider_ref).toBe('77');

    expect(requests('POST', '/api/campaigns')[0]?.body).toEqual({ name: 'Campaign A', type: 'outbound' });
    const update = requests('PATCH', '/api/campaigns/77/update')[0]?.body as Record<string, unknown>;
    expect(update).toMatchObject({ can_unsubscribe: true, plain_text: true, open_tracking: false });
    expect(typeof update['unsubscribe_text']).toBe('string');

    const seq = requests('POST', '/api/campaigns/v1.1/77/sequence-steps')[0]?.body as { title: string; sequence_steps: Array<Record<string, unknown>> };
    expect(seq.sequence_steps).toHaveLength(2);
    expect(seq.sequence_steps[0]).toMatchObject({ order: 1, wait_in_days: 0, thread_reply: false, email_body: '{FIRST_NAME}, saw {COMPANY_NAME}.\n\nP.S. reply no.' });
    expect(seq.sequence_steps[1]).toMatchObject({ order: 2, wait_in_days: 3, thread_reply: true, email_body: 'Following up.' });
    expect(JSON.stringify(seq)).not.toContain('{{');

    // Only company_name needs a custom variable here: first_name is native, unsubscribe_link is removed.
    expect(requests('POST', '/api/custom-variables').map((r) => (r.body as { name: string }).name)).toEqual(['company_name']);
    expect(requests('POST', '/api/campaigns/v1.1/77/sequence-steps').length).toBe(1);
  });

  it('throws when the vendor does not echo can_unsubscribe: true', async () => {
    stubBuild({ can_unsubscribe: false });
    await expect(provider().createCampaign({ name: 'x', steps, timezone: 'UTC' })).rejects.toThrow(/can_unsubscribe/);
    expect(requests('POST', '/api/campaigns/v1.1/77/sequence-steps')).toHaveLength(0);
  });

  it('throws when fewer sequence steps come back than were sent', async () => {
    stubBuild();
    routes = routes.filter((r) => !r.path.test('/api/campaigns/v1.1/77/sequence-steps'));
    route('POST', /sequence-steps$/, () => ({ body: { data: { id: 5, sequence_steps: [{ id: 1 }] } } }));
    await expect(provider().createCampaign({ name: 'x', steps, timezone: 'UTC' })).rejects.toThrow(/sequence_steps/);
  });
});

// ---------------------------------------------------------------- schedule / launch / pause

describe('setSchedule', () => {
  it('posts all seven weekday booleans, HH:MM times and the IANA zone, then sets the daily cap', async () => {
    route('POST', /^\/api\/campaigns\/42\/schedule$/, (req) => ({ body: { data: { id: 1, type: 'Generated', ...(req.body as object) } } }));
    route('PATCH', /^\/api\/campaigns\/42\/update$/, (req) => ({ body: { data: { id: 42, ...(req.body as object) } } }));
    await provider().setSchedule({ provider_ref: '42', timezone: 'America/New_York', window_start: '09:00', window_end: '17:00', days: ['mon', 'tue', 'wed', 'thu', 'fri'], daily_cap: 150 });
    expect(requests('POST', '/api/campaigns/42/schedule')[0]?.body).toEqual({
      monday: true, tuesday: true, wednesday: true, thursday: true, friday: true, saturday: false, sunday: false,
      start_time: '09:00', end_time: '17:00', timezone: 'America/New_York',
    });
    expect(requests('PATCH', '/api/campaigns/42/update')[0]?.body).toEqual({ max_emails_per_day: 150 });
  });

  it('rejects a non-HH:MM window before making any call', async () => {
    await expect(provider().setSchedule({ provider_ref: '42', timezone: 'UTC', window_start: '9am', window_end: '17:00', days: ['mon'], daily_cap: 10 })).rejects.toThrow(/HH:MM/);
    expect(calls).toHaveLength(0);
  });
});

describe('launch and pause', () => {
  it('launch is PATCH /resume and checks the echoed status', async () => {
    route('PATCH', /^\/api\/campaigns\/42\/resume$/, () => ({ body: { data: { id: 42, status: 'Queued' } } }));
    await provider().launch({ provider_ref: '42' });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ method: 'PATCH', path: '/api/campaigns/42/resume' });
  });

  it('pause is PATCH /pause and fails if the campaign did not pause', async () => {
    route('PATCH', /^\/api\/campaigns\/42\/pause$/, () => ({ body: { data: { id: 42, status: 'Active' } } }));
    await expect(provider().pause({ provider_ref: '42' })).rejects.toThrow(/status/);
  });
});

// ---------------------------------------------------------------- stats

describe('getStats', () => {
  it('(c) issues a POST with a 90-day start/end window and parses numeric strings', async () => {
    route('POST', /^\/api\/campaigns\/42\/stats$/, () => ({
      body: { data: { emails_sent: '120', opened: '40', unique_replies_per_contact: '6', bounced: '3', unsubscribed: '1', interested: '2', sequence_step_stats: [] } },
    }));
    const now = () => Date.parse('2026-10-23T12:00:00Z');
    const stats = await provider({ now }).getStats({ provider_ref: '42' });
    const [req] = requests('POST', '/api/campaigns/42/stats');
    expect(req).toBeDefined();
    expect(req?.body).toEqual({ start_date: '2026-07-25', end_date: '2026-10-23' });
    expect(stats).toEqual({ sent: 120, delivered: 117, opens: 40, replies: 6, bounces: 3, unsubscribes: 1, interested: 2 });
  });

  it('rejects a stats body with a missing count rather than reporting zero', async () => {
    route('POST', /stats$/, () => ({ body: { data: { emails_sent: '10' } } }));
    await expect(provider().getStats({ provider_ref: '42' })).rejects.toBeInstanceOf(EmailBisonResponseError);
  });
});

// ---------------------------------------------------------------- replies

describe('getReplies', () => {
  const rows = [
    { id: 501, subject: 're: quick question', automated_reply: false, text_body: 'Sure, tell me more', html_body: '<p>Sure, tell me more</p>', date_received: '2026-10-20T10:00:00.000000Z', from_email_address: 'buyer@corp.test' },
    { id: 502, subject: 'Automatic reply', automated_reply: true, text_body: 'Out of office', html_body: null, date_received: '2026-10-20T11:00:00.000000Z', from_email_address: 'mailer-daemon@corp.test' },
    { id: 503, subject: null, automated_reply: false, text_body: '', html_body: '<div>Not <b>now</b></div>', date_received: '2026-10-01T09:00:00.000000Z', from_email_address: 'old@corp.test' },
  ];

  it('(e) drops automated replies and keeps the vendor reply id as provider_ref', async () => {
    route('GET', /^\/api\/campaigns\/42\/replies$/, (req) => ({ body: paged(rows, pageOf(req), 15, '/api/campaigns/42/replies') }));
    const out = await provider().getReplies({ provider_ref: '42' });
    expect(out.map((r) => r.provider_ref)).toEqual(['501', '503']);
    expect(out[0]).toEqual({ provider_ref: '501', from_email: 'buyer@corp.test', subject: 're: quick question', body_preview: 'Sure, tell me more', received_at: '2026-10-20T10:00:00.000Z' });
    expect(out[1]?.body_preview).toBe('Not now');
    expect(out[1]?.subject).toBeNull();
  });

  it('applies `since` client-side and paginates', async () => {
    const many = Array.from({ length: 40 }, (_, i) => ({ ...rows[0], id: 600 + i, date_received: `2026-10-${String(1 + (i % 28)).padStart(2, '0')}T10:00:00Z` }));
    route('GET', /^\/api\/campaigns\/42\/replies$/, (req) => ({ body: paged(many, pageOf(req), 15, '/api/campaigns/42/replies') }));
    const out = await provider().getReplies({ provider_ref: '42', since: '2026-10-20T00:00:00Z' });
    expect(requests('GET', '/api/campaigns/42/replies')).toHaveLength(3);
    expect(out.every((r) => Date.parse(r.received_at) > Date.parse('2026-10-20T00:00:00Z'))).toBe(true);
    expect(out.length).toBeGreaterThan(0);
    expect(out.length).toBeLessThan(40);
  });
});

// ---------------------------------------------------------------- retry

describe('retry and backoff', () => {
  it('(f) retries a 429 and honours Retry-After', async () => {
    const waits: number[] = [];
    let attempt = 0;
    route('PATCH', /^\/api\/campaigns\/42\/pause$/, () => {
      attempt += 1;
      if (attempt === 1) return { status: 429, body: { message: 'slow down' }, headers: { 'retry-after': '2' } };
      return { body: { data: { id: 42, status: 'Paused' } } };
    });
    const p = provider({ http: { sleep: async (ms) => { waits.push(ms); }, log: () => undefined, backoffMs: 100 } });
    await p.pause({ provider_ref: '42' });
    expect(attempt).toBe(2);
    expect(waits).toEqual([2000]);
  });

  it('retries 5xx with exponential backoff and gives up with an HttpError that names the endpoint', async () => {
    const waits: number[] = [];
    route('PATCH', /resume$/, () => ({ status: 503, body: { message: 'down' } }));
    const p = provider({ http: { sleep: async (ms) => { waits.push(ms); }, log: () => undefined, maxRetries: 2, backoffMs: 100 } });
    await expect(p.launch({ provider_ref: '42' })).rejects.toMatchObject({ name: 'HttpError', status: 503, endpoint: 'PATCH /api/campaigns/42/resume' });
    expect(waits).toEqual([100, 200]);
    expect(requests('PATCH', '/api/campaigns/42/resume')).toHaveLength(3);
  });

  it('does not retry a 4xx other than 429', async () => {
    route('PATCH', /resume$/, () => ({ status: 422, body: { data: { success: false, message: 'no senders' } } }));
    await expect(provider().launch({ provider_ref: '42' })).rejects.toBeInstanceOf(HttpError);
    expect(calls).toHaveLength(1);
  });

  it('never puts the token in an error message', async () => {
    route('PATCH', /resume$/, () => ({ status: 500, body: { message: 'boom' } }));
    const p = provider({ http: { sleep: async () => undefined, log: () => undefined, maxRetries: 0 } });
    const err = await p.launch({ provider_ref: '42' }).catch((e: unknown) => e);
    expect(String(err)).not.toContain('test-token-do-not-log');
  });
});

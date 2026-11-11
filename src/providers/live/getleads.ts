/**
 * GetLeads overflow lead provider — GATED. Read before enabling.
 *
 * GetLeads' own FAQ states: "Using the unlimited plan to power your product is not
 * allowed." Reselling the database needs a written agreement (docs/VENDOR_NOTES.md §4,
 * verified 2026-10-23). Powering a SaaS from it without that agreement is a terms
 * violation, so this class refuses to construct unless the operator asserts the
 * agreement exists by setting `GETLEADS_SAAS_APPROVED=true`. Nothing else in this
 * file runs until then.
 *
 * Behind the gate, what is verified from their docs:
 *   - `POST /api/v1/contacts/search`, default 100 requests/minute (the "no rate
 *     limit" marketing claim is false), up to 5,000 records per request, `offset`
 *     pagination, and 60–90s response times on large pages (so a 90s timeout).
 *
 * Unverified (U): the API base host and the filter field names. Both are isolated
 * (`baseUrl` option, `buildBody`) so a key-in-hand check changes one place.
 */

import type { LeadProvider, LeadSearchQuery, LeadSearchResult, SourcedLead } from '../../lib/contracts';
import { env, requireCredential } from '../../lib/env';

const DEFAULT_BASE_URL = 'https://api.getleads.ai'; // (U) confirm with a key
const PAGE_SIZE = 5_000;
/** Hard ceiling: 10 pages = 50,000 records per search. */
const MAX_PAGES = 10;
const REQUEST_TIMEOUT_MS = 90_000;
const MAX_ATTEMPTS_PER_PAGE = 3;
/** 100 req/min -> one request every 600ms keeps us at the documented default. */
const MIN_INTERVAL_MS = 600;
/**
 * (U) GetLeads sells a flat "unlimited" plan, so the marginal cost per record is 0.
 * We report 0 and leave the subscription cost to the ledger. Override if a per-record
 * contract is signed.
 */
const DEFAULT_CENTS_PER_LEAD = 0;

type FetchLike = typeof fetch;
type Sleep = (ms: number) => Promise<void>;

export interface GetLeadsOptions {
  apiKey?: string;
  fetch?: FetchLike;
  sleep?: Sleep;
  baseUrl?: string;
  centsPerLead?: number;
  /** Overrides the GETLEADS_SAAS_APPROVED env read. Tests only. */
  approved?: boolean;
}

export class GetLeadsNotApprovedError extends Error {
  constructor() {
    super(
      'GetLeadsProvider is disabled: GetLeads\' terms forbid using their unlimited plan to power a ' +
        'product, and no written SaaS agreement is on file. See docs/VENDOR_NOTES.md §4 ("GetLeads — a ' +
        'blocker, not a vendor"). Once a signed agreement exists, set GETLEADS_SAAS_APPROVED=true to ' +
        'enable this provider; until then set PROVIDER_LEADS_OVERFLOW=mock or queue against Prospeo.',
    );
    this.name = 'GetLeadsNotApprovedError';
  }
}

const defaultSleep: Sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function int(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.trunc(value);
  if (typeof value === 'string' && /^\d+$/.test(value.trim())) return Number.parseInt(value, 10);
  return null;
}

/** (U) Filter field names for /api/v1/contacts/search. Confirm with a key. */
function buildBody(query: LeadSearchQuery, limit: number, offset: number): Record<string, unknown> {
  const body: Record<string, unknown> = { limit, offset };
  if (query.titles.length) body.job_titles = query.titles;
  if (query.industries.length) body.industries = query.industries;
  if (query.geos.length) body.locations = query.geos;
  if (query.headcount_min != null) body.employees_min = query.headcount_min;
  if (query.headcount_max != null) body.employees_max = query.headcount_max;
  if (query.exclude_domains?.length) body.exclude_domains = query.exclude_domains;
  return body;
}

function parseLead(row: unknown): SourcedLead | null {
  if (!isRecord(row)) return null;
  const email = str(row.email) ?? str(row.work_email);
  if (!email || !email.includes('@')) return null;
  const company = isRecord(row.company) ? row.company : {};
  return {
    email: email.toLowerCase(),
    first_name: str(row.first_name),
    last_name: str(row.last_name),
    title: str(row.job_title) ?? str(row.title),
    company_name: str(row.company_name) ?? str(company.name),
    company_domain: str(row.company_domain) ?? str(company.domain) ?? str(company.website),
    linkedin_url: str(row.linkedin_url) ?? str(row.linkedin),
    industry: str(row.industry) ?? str(company.industry),
    headcount: int(row.employees) ?? int(company.employees) ?? int(company.size),
    country: str(row.country) ?? str(row.location),
    raw: row,
  };
}

/** (U) Response shape: accepts `data`, `contacts` or `results` as the row array. */
function parsePage(body: unknown): { leads: SourcedLead[]; rows: number } | { error: string } {
  if (!isRecord(body)) return { error: 'response body is not an object' };
  const rows = Array.isArray(body.data) ? body.data
    : Array.isArray(body.contacts) ? body.contacts
    : Array.isArray(body.results) ? body.results
    : null;
  if (!rows) return { error: 'response has no contacts array' };
  const leads: SourcedLead[] = [];
  for (const row of rows) {
    const lead = parseLead(row);
    if (lead) leads.push(lead);
  }
  return { leads, rows: rows.length };
}

type PageOutcome =
  | { kind: 'ok'; leads: SourcedLead[]; rows: number }
  | { kind: 'rate_limited'; detail: string }
  | { kind: 'error'; detail: string };

export class GetLeadsProvider implements LeadProvider {
  readonly name = 'getleads';
  private readonly apiKey: string;
  private readonly fetchImpl: FetchLike;
  private readonly sleep: Sleep;
  private readonly baseUrl: string;
  private readonly centsPerLead: number;
  private nextSlotAt = 0;

  constructor(options: GetLeadsOptions = {}) {
    const approved = options.approved ?? env.getleadsSaasApproved;
    if (!approved) throw new GetLeadsNotApprovedError();
    this.apiKey = requireCredential('GetLeads', 'GETLEADS_API_KEY', options.apiKey ?? env.getleadsApiKey);
    this.fetchImpl = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
    this.sleep = options.sleep ?? defaultSleep;
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
    this.centsPerLead = options.centsPerLead ?? DEFAULT_CENTS_PER_LEAD;
  }

  async search(query: LeadSearchQuery): Promise<LeadSearchResult> {
    const limit = Math.max(0, Math.trunc(query.limit));
    const leads: SourcedLead[] = [];
    const seen = new Set<string>();
    const finish = (stop_reason: LeadSearchResult['stop_reason'], error?: string): LeadSearchResult => {
      const out = leads.slice(0, limit);
      const result: LeadSearchResult = {
        leads: out,
        stop_reason,
        cost_cents: out.length * this.centsPerLead,
        provider: this.name,
      };
      if (error) result.error = error;
      return result;
    };
    if (limit === 0) return finish('limit_reached');

    const wantedPages = Math.ceil(limit / PAGE_SIZE);
    const pagesToFetch = Math.min(wantedPages, MAX_PAGES);

    for (let page = 0; page < pagesToFetch; page++) {
      const offset = page * PAGE_SIZE;
      const pageLimit = Math.min(PAGE_SIZE, limit - leads.length);
      const outcome = await this.fetchPage(query, pageLimit, offset);
      if (outcome.kind === 'rate_limited') return finish('rate_limited', outcome.detail);
      if (outcome.kind === 'error') return finish('error', outcome.detail);
      for (const lead of outcome.leads) {
        if (seen.has(lead.email)) continue;
        seen.add(lead.email);
        leads.push(lead);
      }
      if (leads.length >= limit) return finish('limit_reached');
      if (outcome.rows < pageLimit) return finish('exhausted');
    }
    if (wantedPages > MAX_PAGES) {
      return finish('limit_reached', `stopped at the provider page cap (${MAX_PAGES} pages); ${limit} were requested`);
    }
    return finish('limit_reached');
  }

  private async throttle(): Promise<void> {
    const now = Date.now();
    const at = Math.max(now, this.nextSlotAt);
    this.nextSlotAt = at + MIN_INTERVAL_MS;
    if (at > now) await this.sleep(at - now);
  }

  private async fetchPage(query: LeadSearchQuery, limit: number, offset: number): Promise<PageOutcome> {
    let lastDetail = 'no attempts made';
    for (let attempt = 1; attempt <= MAX_ATTEMPTS_PER_PAGE; attempt++) {
      await this.throttle();
      let response: Response;
      try {
        response = await this.fetchImpl(`${this.baseUrl}/api/v1/contacts/search`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${this.apiKey}`,
            'Content-Type': 'application/json',
            Accept: 'application/json',
          },
          body: JSON.stringify(buildBody(query, limit, offset)),
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
      } catch (err) {
        lastDetail = `network error at offset ${offset}: ${err instanceof Error ? err.message : String(err)}`;
        await this.sleep(backoffMs(attempt));
        continue;
      }

      if (response.status === 429) {
        const retryAfter = Number.parseInt(response.headers.get('retry-after') ?? '', 10);
        lastDetail = `GetLeads rate limited at offset ${offset} (HTTP 429)`;
        await this.sleep(Number.isFinite(retryAfter) ? Math.min(retryAfter * 1000, 65_000) : backoffMs(attempt));
        continue;
      }
      if (response.status === 401 || response.status === 403) {
        return { kind: 'error', detail: `GetLeads rejected the API key (HTTP ${response.status})` };
      }
      if (response.status >= 500) {
        lastDetail = `GetLeads server error at offset ${offset} (HTTP ${response.status})`;
        await this.sleep(backoffMs(attempt));
        continue;
      }
      if (!response.ok) return { kind: 'error', detail: `GetLeads returned HTTP ${response.status} at offset ${offset}` };

      let body: unknown;
      try {
        body = await response.json();
      } catch {
        return { kind: 'error', detail: `GetLeads returned a non-JSON body at offset ${offset}` };
      }
      const parsed = parsePage(body);
      if ('error' in parsed) return { kind: 'error', detail: `GetLeads offset ${offset}: ${parsed.error}` };
      return { kind: 'ok', leads: parsed.leads, rows: parsed.rows };
    }
    return lastDetail.includes('rate limited')
      ? { kind: 'rate_limited', detail: lastDetail }
      : { kind: 'error', detail: lastDetail };
  }
}

function backoffMs(attempt: number): number {
  return 2000 * 2 ** (attempt - 1) + Math.floor(Math.random() * 500);
}

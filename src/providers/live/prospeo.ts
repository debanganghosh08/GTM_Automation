/**
 * Prospeo lead provider: list building through `POST /search-person`.
 *
 * Verified (docs/VENDOR_NOTES.md §4, 2026-10-23):
 *   - Header `X-KEY`, base `https://api.prospeo.io`, every call is a POST.
 *   - The old `/domain-search` and `/email-finder` endpoints NO LONGER EXIST. Do not
 *     reintroduce them; the replacements are `/enrich-person`, `/bulk-enrich-person`,
 *     `/search-person` and `/search-company`.
 *   - Search costs 1 credit per 25-result page. Nothing is charged on a miss.
 *   - Plan rate limits: Starter 5/s + 2,000/day, Growth 5/s + 5,000/day, Pro 30/s.
 *     Response headers `x-minute-request-left` / `x-daily-request-left` report what
 *     is left; we read them and back off instead of guessing the plan.
 *
 * Unverified (U): the exact filter field names accepted by `/search-person` and the
 * shape of its response. Both are isolated in `buildFilters` and `parseSearchPage`
 * so a key-in-hand check changes one function each. A response that does not match
 * the expected shape ends the search with `stop_reason: 'error'` rather than being
 * trusted because it was a 200.
 *
 * Honest stopping: the result always says why it stopped (`limit_reached`,
 * `exhausted`, `rate_limited`, `error`) and how many credits were spent.
 */

import type { LeadProvider, LeadSearchQuery, LeadSearchResult, SourcedLead } from '../../lib/contracts';
import { env, requireCredential } from '../../lib/env';

const BASE_URL = 'https://api.prospeo.io';
const PAGE_SIZE = 25;
/** Hard ceiling on pages per search, whatever `limit` says: 40 pages = 1,000 leads = 40 credits. */
const MAX_PAGES = 40;
const REQUEST_TIMEOUT_MS = 30_000;
const MAX_ATTEMPTS_PER_PAGE = 4;
/** Longest we wait for a per-minute limit to reset before giving up the page. */
const MAX_RATE_WAIT_MS = 65_000;
/**
 * (U) Prospeo sells credits in bundles; the per-credit price depends on the plan.
 * 2 cents is a conservative mid-plan figure. Override via the constructor once the
 * real plan is known so `cost_cents` stays honest.
 */
const DEFAULT_CENTS_PER_CREDIT = 2;

type FetchLike = typeof fetch;
type Sleep = (ms: number) => Promise<void>;

export interface ProspeoOptions {
  apiKey?: string;
  fetch?: FetchLike;
  sleep?: Sleep;
  centsPerCredit?: number;
  maxPages?: number;
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

function headerInt(headers: Headers, name: string): number | null {
  return int(headers.get(name));
}

/**
 * (U) Filter field names. Prospeo's search filters are documented as include/exclude
 * lists keyed by attribute; the exact keys below are our best reading and must be
 * confirmed with a key (docs/VENDOR_NOTES.md §6).
 */
function buildFilters(query: LeadSearchQuery): Record<string, unknown> {
  const filters: Record<string, unknown> = {};
  if (query.titles.length) filters.person_title = { include: query.titles };
  if (query.industries.length) filters.company_industry = { include: query.industries };
  if (query.geos.length) filters.person_location = { include: query.geos };
  if (query.headcount_min != null || query.headcount_max != null) {
    filters.company_size = {
      min: query.headcount_min ?? null,
      max: query.headcount_max ?? null,
    };
  }
  if (query.exclude_domains?.length) filters.company_domain = { exclude: query.exclude_domains };
  // `signals` have no Prospeo filter; the strategy applies them downstream.
  return filters;
}

/** Pulls a SourcedLead out of one result row, or null when it has no usable email. */
function parseLead(row: unknown): SourcedLead | null {
  if (!isRecord(row)) return null;
  const person = isRecord(row.person) ? row.person : row;
  const company = isRecord(row.company) ? row.company : (isRecord(person.company) ? person.company : {});
  const email = str(person.email) ?? (isRecord(person.email) ? str(person.email.email) : null);
  if (!email || !email.includes('@')) return null;
  const lead: SourcedLead = {
    email: email.toLowerCase(),
    first_name: str(person.first_name),
    last_name: str(person.last_name),
    title: str(person.title) ?? str(person.job_title),
    company_name: str(company.name) ?? str(person.company_name),
    company_domain: str(company.domain) ?? str(company.website),
    linkedin_url: str(person.linkedin_url) ?? str(person.linkedin),
    industry: str(company.industry),
    headcount: int(company.size) ?? int(company.headcount) ?? int(company.employee_count),
    country: str(person.country) ?? (isRecord(person.location) ? str(person.location.country) : null),
    raw: row,
  };
  return lead;
}

interface ParsedPage {
  leads: SourcedLead[];
  /** Rows on the page before filtering out those without an email. */
  rows: number;
  total: number | null;
}

/** (U) Response shape. Accepts `results` or `data` as the row array; anything else is an error. */
function parseSearchPage(body: unknown): ParsedPage | { error: string } {
  if (!isRecord(body)) return { error: 'response body is not an object' };
  if (body.error === true) return { error: str(body.message) ?? 'Prospeo returned error=true' };
  const rows = Array.isArray(body.results) ? body.results : Array.isArray(body.data) ? body.data : null;
  if (!rows) return { error: 'response has no results array' };
  const pagination = isRecord(body.pagination) ? body.pagination : {};
  const total = int(pagination.total_count) ?? int(pagination.total) ?? int(body.total) ?? null;
  const leads: SourcedLead[] = [];
  for (const row of rows) {
    const lead = parseLead(row);
    if (lead) leads.push(lead);
  }
  return { leads, rows: rows.length, total };
}

type PageOutcome =
  | { kind: 'ok'; page: ParsedPage; minuteLeft: number | null; dailyLeft: number | null }
  | { kind: 'rate_limited'; detail: string }
  | { kind: 'error'; detail: string };

export class ProspeoLeadProvider implements LeadProvider {
  readonly name = 'prospeo';
  private readonly apiKey: string;
  private readonly fetchImpl: FetchLike;
  private readonly sleep: Sleep;
  private readonly centsPerCredit: number;
  private readonly maxPages: number;

  constructor(options: ProspeoOptions = {}) {
    this.apiKey = requireCredential('Prospeo', 'PROSPEO_API_KEY', options.apiKey ?? env.prospeoApiKey);
    this.fetchImpl = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
    this.sleep = options.sleep ?? defaultSleep;
    this.centsPerCredit = options.centsPerCredit ?? DEFAULT_CENTS_PER_CREDIT;
    this.maxPages = Math.max(1, Math.min(options.maxPages ?? MAX_PAGES, MAX_PAGES));
  }

  async search(query: LeadSearchQuery): Promise<LeadSearchResult> {
    const limit = Math.max(0, Math.trunc(query.limit));
    const leads: SourcedLead[] = [];
    const seen = new Set<string>();
    let creditsUsed = 0;
    const finish = (stop_reason: LeadSearchResult['stop_reason'], error?: string): LeadSearchResult => {
      const result: LeadSearchResult = {
        leads: leads.slice(0, limit),
        stop_reason,
        cost_cents: creditsUsed * this.centsPerCredit,
        provider: this.name,
      };
      if (error) result.error = error;
      return result;
    };

    if (limit === 0) return finish('limit_reached');

    const wantedPages = Math.ceil(limit / PAGE_SIZE);
    const pagesToFetch = Math.min(wantedPages, this.maxPages);
    const filters = buildFilters(query);

    for (let page = 1; page <= pagesToFetch; page++) {
      const outcome = await this.fetchPage(filters, page);
      if (outcome.kind === 'rate_limited') return finish('rate_limited', outcome.detail);
      if (outcome.kind === 'error') return finish('error', outcome.detail);

      // A page that came back counts as a credit even when it was partly empty.
      creditsUsed += 1;
      for (const lead of outcome.page.leads) {
        if (seen.has(lead.email)) continue;
        seen.add(lead.email);
        leads.push(lead);
      }

      if (leads.length >= limit) return finish('limit_reached');
      // Short page, or the provider says there is nothing past this page: exhausted.
      if (outcome.page.rows < PAGE_SIZE) return finish('exhausted');
      if (outcome.page.total !== null && page * PAGE_SIZE >= outcome.page.total) return finish('exhausted');

      if (outcome.dailyLeft !== null && outcome.dailyLeft <= 0) {
        return finish('rate_limited', 'Prospeo daily request allowance exhausted (x-daily-request-left=0)');
      }
      if (outcome.minuteLeft !== null && outcome.minuteLeft <= 0) {
        // Per-minute budget gone: wait for the window to roll over rather than burning retries.
        await this.sleep(60_000);
      }
    }

    // We stopped because of our own page cap, not because the data ran out.
    if (wantedPages > this.maxPages) {
      return finish('limit_reached', `stopped at the provider page cap (${this.maxPages} pages); ${limit} were requested`);
    }
    return finish('limit_reached');
  }

  private async fetchPage(filters: Record<string, unknown>, page: number): Promise<PageOutcome> {
    let lastDetail = 'no attempts made';
    for (let attempt = 1; attempt <= MAX_ATTEMPTS_PER_PAGE; attempt++) {
      let response: Response;
      try {
        response = await this.fetchImpl(`${BASE_URL}/search-person`, {
          method: 'POST',
          headers: { 'X-KEY': this.apiKey, 'Content-Type': 'application/json', Accept: 'application/json' },
          body: JSON.stringify({ page, filters }),
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
      } catch (err) {
        lastDetail = `network error on page ${page}: ${err instanceof Error ? err.message : String(err)}`;
        await this.sleep(backoffMs(attempt));
        continue;
      }

      const minuteLeft = headerInt(response.headers, 'x-minute-request-left');
      const dailyLeft = headerInt(response.headers, 'x-daily-request-left');

      if (response.status === 429) {
        if (dailyLeft !== null && dailyLeft <= 0) {
          return { kind: 'rate_limited', detail: 'Prospeo daily request allowance exhausted (HTTP 429, x-daily-request-left=0)' };
        }
        const retryAfter = headerInt(response.headers, 'retry-after');
        const wait = Math.min(retryAfter !== null ? retryAfter * 1000 : backoffMs(attempt), MAX_RATE_WAIT_MS);
        lastDetail = `Prospeo rate limited page ${page} (HTTP 429)`;
        await this.sleep(wait);
        continue;
      }
      if (response.status === 401 || response.status === 403) {
        return { kind: 'error', detail: `Prospeo rejected the API key (HTTP ${response.status})` };
      }
      if (response.status === 402) {
        return { kind: 'error', detail: 'Prospeo account has no credits left (HTTP 402)' };
      }
      if (response.status >= 500) {
        lastDetail = `Prospeo server error on page ${page} (HTTP ${response.status})`;
        await this.sleep(backoffMs(attempt));
        continue;
      }
      if (!response.ok) {
        return { kind: 'error', detail: `Prospeo returned HTTP ${response.status} for page ${page}` };
      }

      let body: unknown;
      try {
        body = await response.json();
      } catch {
        return { kind: 'error', detail: `Prospeo returned a non-JSON body for page ${page}` };
      }
      const parsed = parseSearchPage(body);
      if ('error' in parsed) return { kind: 'error', detail: `Prospeo page ${page}: ${parsed.error}` };
      return { kind: 'ok', page: parsed, minuteLeft, dailyLeft };
    }
    // Retries exhausted. A 429 trail is a rate limit; anything else is an error.
    return lastDetail.includes('rate limited')
      ? { kind: 'rate_limited', detail: lastDetail }
      : { kind: 'error', detail: lastDetail };
  }
}

/** 1s, 2s, 4s, 8s with a little jitter. */
function backoffMs(attempt: number): number {
  const base = 1000 * 2 ** (attempt - 1);
  return base + Math.floor(Math.random() * 250);
}

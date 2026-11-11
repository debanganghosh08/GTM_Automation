/**
 * EmailBison sending provider (live).
 *
 * Written against the instance's own OpenAPI document, mirrored at
 * `reference/roister-openapi.yaml` (a YAML file despite the extension), and the
 * verified sequence in `docs/VENDOR_NOTES.md` §1. Every path, method and body
 * field below was checked in that spec on 2026-10-23. Where the spec and the notes
 * disagree, the spec wins and the difference is flagged inline with "SPEC:".
 *
 * Guarantees this module keeps:
 *  - Every call is bounded: a timeout, a retry budget with backoff on 429/5xx
 *    (honouring Retry-After), a page cap on every list, and chunking on bulk writes.
 *    A list that hits its page cap throws EmailBisonTruncatedError rather than
 *    returning a partial result as if it were complete.
 *  - Responses are validated by DATA, not status. A write is only treated as done
 *    when the body says so (`success: true`, or the echoed settings match).
 *  - The bearer token is never logged. Lead lists are never logged; only counts.
 *
 * ---------------------------------------------------------------------------
 * Merge tags
 *
 * Internal copy uses `{{first_name}}` (snake_case, double braces; the full list is
 * MERGE_TAGS in lib/contracts). EmailBison renders `{FIRST_NAME}` (upper-case,
 * SINGLE braces) and resolves it from the lead's native columns or from a workspace
 * custom variable of the same name. `toEmailBisonVariables` is the ONE place that
 * translation happens; `ensureCustomVariables` creates any variable the copy needs
 * that the workspace does not have yet.
 *
 * Tag-by-tag:
 *   first_name    -> {FIRST_NAME}         native lead column; `{FIRST_NAME}` appears
 *                                         verbatim in the spec's sequence-step examples.
 *   last_name     -> {LAST_NAME}          native lead column AND uploaded as a custom
 *   title         -> {TITLE}              variable of the same name, because the spec
 *   company_name  -> {COMPANY_NAME}       documents `{FIRST_NAME}` only; the other
 *   industry      -> {INDUSTRY}           native token names are unverified, so the
 *                                         custom variable guarantees resolution.
 *   sending_name  -> {SENDER_FIRST_NAME}  the sender, not the lead, so it cannot be a
 *                                         per-lead variable. `{SENDER_FIRST_NAME}` is the
 *                                         token the spec uses in signature examples.
 *   unsubscribe_link -> REMOVED           see "Unsubscribe link" below.
 *
 * Anything else, including spintax `{a|b}` and unknown `{{tags}}`, is left exactly
 * as written: the compliance checker already rejects unknown tags upstream, and a
 * silent rewrite here would hide a bug rather than surface it.
 *
 * ---------------------------------------------------------------------------
 * Unsubscribe link
 *
 * The compliance checker requires `{{unsubscribe_link}}` in every body. In the live
 * provider that tag is NOT rendered by us: it is stripped from the body (and the
 * line is dropped if the tag was all that was on it), and EmailBison's own one-click
 * unsubscribe is switched on instead via `PATCH /api/campaigns/{id}/update` with
 * `can_unsubscribe: true` plus `unsubscribe_text` for the link's wording. The PATCH
 * response is checked: if `data.can_unsubscribe` does not come back `true`, campaign
 * creation throws, so no campaign can be built here without the vendor's
 * unsubscribe link. The P.S. reply-to-opt-out line in the copy is untouched.
 *
 * SPEC: the update route's request schema lists `can_unsubscribe` but NOT
 * `unsubscribe_text` (it appears only in response examples). We send it anyway, as
 * the notes instruct, and warn if the echoed value differs; wording is cosmetic,
 * `can_unsubscribe` is the compliance-critical bit and is asserted.
 */

import { env, requireCredential } from '../../lib/env';
import { MERGE_TAGS, type CampaignStats, type CopyStep, type IsoTimestamp, type SendingProvider } from '../../lib/contracts';
import { HttpClient, type HttpClientOptions } from './http';

// ---------------------------------------------------------------- constants

/** Spec: "limit 500 per request" on POST /api/leads/create-or-update/multiple. */
export const LEAD_CHUNK_SIZE = 500;
/** attach-leads has no documented limit; chunk anyway so a single call stays bounded. */
const ATTACH_CHUNK_SIZE = 500;
/** Vendor pagination defaults to 15/page and caps `?page=N` at 1000. We stop well before. */
const DEFAULT_MAX_PAGES = 200;
const DEFAULT_STATS_WINDOW_DAYS = 90;
const BODY_PREVIEW_LENGTH = 500;
const DEFAULT_UNSUBSCRIBE_TEXT = 'Unsubscribe';

const DAY_KEYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'] as const;
type DayKey = (typeof DAY_KEYS)[number];

const DAY_ALIASES: Record<string, DayKey> = {
  mon: 'monday', monday: 'monday',
  tue: 'tuesday', tues: 'tuesday', tuesday: 'tuesday',
  wed: 'wednesday', wednesday: 'wednesday',
  thu: 'thursday', thur: 'thursday', thurs: 'thursday', thursday: 'thursday',
  fri: 'friday', friday: 'friday',
  sat: 'saturday', saturday: 'saturday',
  sun: 'sunday', sunday: 'sunday',
};

/** Internal tag -> EmailBison token (without braces). `null` means "remove the tag". */
const TAG_TO_TOKEN: Record<(typeof MERGE_TAGS)[number], string | null> = {
  first_name: 'FIRST_NAME',
  last_name: 'LAST_NAME',
  company_name: 'COMPANY_NAME',
  title: 'TITLE',
  industry: 'INDUSTRY',
  sending_name: 'SENDER_FIRST_NAME',
  unsubscribe_link: null,
};

/** Lead fields that map onto native lead columns in the bulk upsert body. */
const NATIVE_LEAD_FIELDS: Record<string, 'first_name' | 'last_name' | 'title' | 'company'> = {
  first_name: 'first_name',
  last_name: 'last_name',
  title: 'title',
  company_name: 'company',
};

/** Fields that are never per-lead data and so are never uploaded as custom variables. */
const NON_LEAD_FIELDS = new Set<string>(['sending_name', 'unsubscribe_link']);

/**
 * Tags that resolve without a custom variable. `first_name` is a native column whose
 * token the spec shows; the sender token is sender-side; the unsubscribe tag is removed.
 */
const TAGS_WITHOUT_CUSTOM_VARIABLE = new Set<string>(['first_name', 'sending_name', 'unsubscribe_link']);

// ---------------------------------------------------------------- errors

export class EmailBisonResponseError extends Error {
  readonly endpoint: string;
  constructor(endpoint: string, detail: string) {
    super(`emailbison: ${endpoint} returned an unexpected body: ${detail}`);
    this.name = 'EmailBisonResponseError';
    this.endpoint = endpoint;
  }
}

/** Thrown when a paginated read hit its page cap before the vendor reported the last page. */
export class EmailBisonTruncatedError extends Error {
  readonly endpoint: string;
  readonly pagesRead: number;
  readonly itemsRead: number;
  constructor(endpoint: string, pagesRead: number, itemsRead: number) {
    super(`emailbison: ${endpoint} stopped after ${pagesRead} page(s) / ${itemsRead} item(s): page cap reached before the last page. Raise maxPages or narrow the query.`);
    this.name = 'EmailBisonTruncatedError';
    this.endpoint = endpoint;
    this.pagesRead = pagesRead;
    this.itemsRead = itemsRead;
  }
}

// ---------------------------------------------------------------- merge tags

/**
 * Translates internal `{{snake_case}}` merge tags into EmailBison `{UPPER_CASE}` tokens.
 * Only tags in MERGE_TAGS are touched; everything else passes through untouched.
 * `{{unsubscribe_link}}` is removed (see the module comment).
 */
export function toEmailBisonVariables(body: string): string {
  const out: string[] = [];
  for (const line of body.split('\n')) {
    const hadUnsubscribe = UNSUBSCRIBE_TAG_RE.test(line);
    const translated = line.replace(/\{\{[ \t]*([a-z_]+)[ \t]*\}\}/g, (match, rawName: string) => {
      if (!isMergeTag(rawName)) return match;
      const token = TAG_TO_TOKEN[rawName];
      return token === null ? '' : `{${token}}`;
    });
    // A line that held nothing but the unsubscribe tag (plus punctuation) is dropped whole.
    if (hadUnsubscribe && translated.replace(/[\s:.\-–—|]+/g, '').length === 0) continue;
    out.push(hadUnsubscribe ? translated.replace(/\s+$/, '') : translated);
  }
  return out.join('\n');
}

const UNSUBSCRIBE_TAG_RE = /\{\{\s*unsubscribe_link\s*\}\}/;

/** Internal tags referenced by a piece of copy, in MERGE_TAGS order. */
export function mergeTagsIn(text: string): Array<(typeof MERGE_TAGS)[number]> {
  const found = new Set<string>();
  for (const match of text.matchAll(/\{\{[ \t]*([a-z_]+)[ \t]*\}\}/g)) {
    const name = match[1];
    if (name !== undefined && isMergeTag(name)) found.add(name);
  }
  return MERGE_TAGS.filter((tag) => found.has(tag));
}

function isMergeTag(name: string): name is (typeof MERGE_TAGS)[number] {
  return (MERGE_TAGS as readonly string[]).includes(name);
}

// ---------------------------------------------------------------- narrowing helpers

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function dataOf(endpoint: string, body: unknown): unknown {
  if (!isRecord(body) || !('data' in body)) {
    throw new EmailBisonResponseError(endpoint, 'missing top-level "data"');
  }
  return body.data;
}

function recordData(endpoint: string, body: unknown): Record<string, unknown> {
  const data = dataOf(endpoint, body);
  if (!isRecord(data)) throw new EmailBisonResponseError(endpoint, '"data" is not an object');
  return data;
}

function arrayData(endpoint: string, body: unknown): unknown[] {
  const data = dataOf(endpoint, body);
  if (!Array.isArray(data)) throw new EmailBisonResponseError(endpoint, '"data" is not an array');
  return data;
}

function idOf(endpoint: string, record: Record<string, unknown>): number {
  const id = record['id'];
  if (typeof id === 'number' && Number.isInteger(id) && id > 0) return id;
  throw new EmailBisonResponseError(endpoint, `"id" is ${JSON.stringify(id)}, expected a positive integer`);
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

/** Stats come back as numeric strings ('10'). Accept numbers too. */
function countOf(endpoint: string, record: Record<string, unknown>, key: string): number {
  const raw = record[key];
  const n = typeof raw === 'number' ? raw : typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : Number.NaN;
  if (!Number.isFinite(n) || n < 0) {
    throw new EmailBisonResponseError(endpoint, `"${key}" is ${JSON.stringify(raw)}, expected a non-negative count`);
  }
  return Math.round(n);
}

function campaignIdOf(providerRef: string): number {
  const id = Number.parseInt(providerRef, 10);
  if (!Number.isInteger(id) || id <= 0 || String(id) !== providerRef.trim()) {
    throw new Error(`emailbison: provider_ref "${providerRef}" is not an EmailBison campaign id`);
  }
  return id;
}

function isoDate(ms: number): string {
  const d = new Date(ms);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function requireHhMm(label: string, value: string): string {
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(value)) {
    throw new Error(`emailbison: ${label} must be HH:MM (24h), got "${value}"`);
  }
  return value;
}

function stripHtml(html: string): string {
  return html.replace(/<style[\s\S]*?<\/style>/gi, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

// ---------------------------------------------------------------- provider

export interface EmailBisonProviderOptions {
  /** Overrides env.emailbison.baseUrl. */
  baseUrl?: string;
  /** Overrides env.emailbison.apiToken. Tests only; live code reads env. */
  apiToken?: string;
  /** Page cap for every paginated read. */
  maxPages?: number;
  /** Injectable clock for the stats window. */
  now?: () => number;
  /** Wording of EmailBison's own unsubscribe link. */
  unsubscribeText?: string;
  /** Open tracking is off by default: a tracking pixel hurts deliverability on cold email. */
  openTracking?: boolean;
  /** Passed through to the HTTP client (timeouts, retries, sleep, fetch, log). */
  http?: Partial<Pick<HttpClientOptions, 'timeoutMs' | 'maxRetries' | 'backoffMs' | 'maxBackoffMs' | 'sleep' | 'fetchImpl' | 'log'>>;
}

export class EmailBisonProvider implements SendingProvider {
  readonly name = 'emailbison';
  private readonly http: HttpClient;
  private readonly maxPages: number;
  private readonly now: () => number;
  private readonly unsubscribeText: string;
  private readonly openTracking: boolean;
  private readonly log: (line: string) => void;
  /** Custom variable names confirmed to exist in the workspace, by lower-cased name. */
  private readonly knownVariables = new Set<string>();

  constructor(options: EmailBisonProviderOptions = {}) {
    const token = requireCredential('EmailBison', 'EMAILBISON_API_TOKEN', options.apiToken ?? env.emailbison.apiToken);
    this.http = new HttpClient({
      baseUrl: options.baseUrl ?? env.emailbison.baseUrl,
      token,
      label: 'emailbison',
      ...options.http,
    });
    this.maxPages = options.maxPages ?? DEFAULT_MAX_PAGES;
    this.now = options.now ?? Date.now;
    this.unsubscribeText = options.unsubscribeText ?? DEFAULT_UNSUBSCRIBE_TEXT;
    this.openTracking = options.openTracking ?? false;
    this.log = options.http?.log ?? ((line: string) => console.info(line));
  }

  // ------------------------------------------------------------ pagination

  /**
   * Walks a length-aware paginated list (`?page=N`) until `links.next` is null or
   * `meta.current_page >= meta.last_page`. Throws EmailBisonTruncatedError at the cap.
   */
  private async paginate(path: string, query: Record<string, string | number | boolean | undefined> = {}): Promise<unknown[]> {
    const endpoint = `GET ${path}`;
    const items: unknown[] = [];
    for (let page = 1; page <= this.maxPages; page++) {
      const { data: body } = await this.http.request({ method: 'GET', path, query: { ...query, page } });
      const rows = arrayData(endpoint, body);
      items.push(...rows);

      if (!isRecord(body)) throw new EmailBisonResponseError(endpoint, 'body is not an object');
      const links = isRecord(body['links']) ? body['links'] : null;
      const meta = isRecord(body['meta']) ? body['meta'] : null;
      const next = links ? links['next'] : undefined;
      const current = meta && typeof meta['current_page'] === 'number' ? meta['current_page'] : page;
      const last = meta && typeof meta['last_page'] === 'number' ? meta['last_page'] : null;

      const done = rows.length === 0
        || next === null
        || (last !== null && current >= last)
        || (links === null && meta === null);
      if (done) return items;
    }
    throw new EmailBisonTruncatedError(endpoint, this.maxPages, items.length);
  }

  // ------------------------------------------------------------ senders

  /** GET /api/sender-emails, every page. Rows carry integer `id` and `email`. */
  async listSenders(): Promise<Array<{ sender_email_id: string; email: string }>> {
    const endpoint = 'GET /api/sender-emails';
    const rows = await this.paginate('/api/sender-emails');
    const out: Array<{ sender_email_id: string; email: string }> = [];
    for (const row of rows) {
      if (!isRecord(row)) throw new EmailBisonResponseError(endpoint, 'a sender row is not an object');
      const id = idOf(endpoint, row);
      const email = row['email'];
      if (typeof email !== 'string' || email.length === 0) {
        throw new EmailBisonResponseError(endpoint, `sender ${id} has no "email"`);
      }
      out.push({ sender_email_id: String(id), email });
    }
    this.log(`[emailbison] listSenders -> ${out.length} sender(s)`);
    return out;
  }

  // ------------------------------------------------------------ custom variables

  /**
   * Creates any custom variable in `names` that the workspace does not already have.
   * Names are compared case-insensitively. GET /api/custom-variables is paginated;
   * POST /api/custom-variables {name} returns data.{id,name}.
   */
  async ensureCustomVariables(names: string[]): Promise<void> {
    const wanted = [...new Set(names.map((n) => n.trim()).filter((n) => n.length > 0))];
    const missing = wanted.filter((n) => !this.knownVariables.has(n.toLowerCase()));
    if (missing.length === 0) return;

    const listEndpoint = 'GET /api/custom-variables';
    const existing = await this.paginate('/api/custom-variables');
    for (const row of existing) {
      if (!isRecord(row)) throw new EmailBisonResponseError(listEndpoint, 'a custom variable row is not an object');
      const name = row['name'];
      if (typeof name === 'string') this.knownVariables.add(name.toLowerCase());
    }

    const createEndpoint = 'POST /api/custom-variables';
    for (const name of missing) {
      if (this.knownVariables.has(name.toLowerCase())) continue;
      const { data: body } = await this.http.request({ method: 'POST', path: '/api/custom-variables', body: { name } });
      const data = recordData(createEndpoint, body);
      idOf(createEndpoint, data);
      const echoed = data['name'];
      if (typeof echoed !== 'string' || echoed.toLowerCase() !== name.toLowerCase()) {
        throw new EmailBisonResponseError(createEndpoint, `created variable echoed name ${JSON.stringify(echoed)}, expected "${name}"`);
      }
      this.knownVariables.add(name.toLowerCase());
    }
    this.log(`[emailbison] ensureCustomVariables -> ${missing.length} created, ${wanted.length - missing.length} already present`);
  }

  // ------------------------------------------------------------ campaign build

  /**
   * Steps 2, 3 and 7 of the verified sequence:
   *  POST  /api/campaigns {name, type:'outbound'}                -> data.id
   *  PATCH /api/campaigns/{id}/update {can_unsubscribe, ...}      -> data echoes settings
   *  POST  /api/campaigns/v1.1/{id}/sequence-steps {title, sequence_steps[]}
   * Custom variables referenced by the copy are created first.
   */
  async createCampaign(input: { name: string; steps: CopyStep[]; timezone: string }): Promise<{ provider_ref: string }> {
    if (input.steps.length === 0) throw new Error('emailbison: createCampaign needs at least one step');
    const ordered = [...input.steps].sort((a, b) => a.step - b.step);

    const tags = new Set<string>();
    for (const step of ordered) {
      for (const tag of mergeTagsIn(`${step.subject}\n${step.body}`)) tags.add(tag);
    }
    await this.ensureCustomVariables([...tags].filter((t) => !TAGS_WITHOUT_CUSTOM_VARIABLE.has(t)));

    const createEndpoint = 'POST /api/campaigns';
    const { data: created } = await this.http.request({
      method: 'POST',
      path: '/api/campaigns',
      body: { name: input.name, type: 'outbound' },
    });
    const id = idOf(createEndpoint, recordData(createEndpoint, created));

    await this.updateSettings(id, {
      can_unsubscribe: true,
      unsubscribe_text: this.unsubscribeText,
      plain_text: true,
      open_tracking: this.openTracking,
    });

    const stepsEndpoint = `POST /api/campaigns/v1.1/${id}/sequence-steps`;
    const sequenceSteps = ordered.map((step, index) => ({
      email_subject: toEmailBisonVariables(step.subject),
      email_body: toEmailBisonVariables(step.body),
      // Contract: delay_days is "days after the previous step"; spec: wait_in_days is "the days to wait".
      wait_in_days: Math.max(0, Math.round(step.delay_days)),
      order: index + 1,
      variant: false,
      // House style threads every follow-up under the first subject.
      thread_reply: index > 0,
    }));
    const { data: stepsBody } = await this.http.request({
      method: 'POST',
      path: `/api/campaigns/v1.1/${id}/sequence-steps`,
      body: { title: input.name, sequence_steps: sequenceSteps },
    });
    const stepsData = recordData(stepsEndpoint, stepsBody);
    const echoedSteps = stepsData['sequence_steps'];
    if (!Array.isArray(echoedSteps) || echoedSteps.length !== sequenceSteps.length) {
      throw new EmailBisonResponseError(
        stepsEndpoint,
        `expected ${sequenceSteps.length} sequence_steps back, got ${Array.isArray(echoedSteps) ? echoedSteps.length : 'none'}`,
      );
    }

    this.log(`[emailbison] createCampaign -> campaign ${id}, ${sequenceSteps.length} step(s), timezone ${input.timezone} (applied at setSchedule)`);
    return { provider_ref: String(id) };
  }

  /**
   * PATCH /api/campaigns/{id}/update. The response echoes the campaign, so every
   * boolean/number we sent is checked against what came back. `unsubscribe_text`
   * is not in the request schema (SPEC), so a mismatch there only warns.
   */
  private async updateSettings(
    id: number,
    settings: {
      can_unsubscribe?: boolean;
      unsubscribe_text?: string;
      plain_text?: boolean;
      open_tracking?: boolean;
      max_emails_per_day?: number;
      max_new_leads_per_day?: number;
      daily_max_sends_per_receiving_domain?: number;
    },
  ): Promise<void> {
    const endpoint = `PATCH /api/campaigns/${id}/update`;
    const { data: body } = await this.http.request({ method: 'PATCH', path: `/api/campaigns/${id}/update`, body: settings });
    const data = recordData(endpoint, body);
    if (idOf(endpoint, data) !== id) throw new EmailBisonResponseError(endpoint, `echoed campaign id ${String(data['id'])}, expected ${id}`);

    for (const [key, wanted] of Object.entries(settings)) {
      if (wanted === undefined) continue;
      const got = data[key];
      if (got === wanted) continue;
      if (key === 'unsubscribe_text') {
        this.log(`[emailbison] ${endpoint}: unsubscribe_text echoed as ${JSON.stringify(got)}, sent ${JSON.stringify(wanted)} (field is not in the request schema)`);
        continue;
      }
      throw new EmailBisonResponseError(endpoint, `"${key}" echoed as ${JSON.stringify(got)}, sent ${JSON.stringify(wanted)}; the setting did not take`);
    }
  }

  // ------------------------------------------------------------ senders -> campaign

  /**
   * POST /api/campaigns/{id}/attach-sender-emails {"sender_email_ids": [...]}.
   * SPEC: `sender_email_ids.items.type` is `string` (examples show integers), so the
   * contract's string ids are sent as-is. The response is `{success, message}` at the
   * TOP level (not under `data`), and `success: true` is required.
   */
  async attachSenders(input: { provider_ref: string; sender_email_ids: string[] }): Promise<void> {
    const id = campaignIdOf(input.provider_ref);
    const ids = input.sender_email_ids.map((s) => s.trim()).filter((s) => s.length > 0);
    if (ids.length === 0) throw new Error('emailbison: attachSenders called with no sender_email_ids');
    for (const sid of ids) {
      if (!/^\d+$/.test(sid)) throw new Error(`emailbison: sender_email_id "${sid}" is not an EmailBison sender id`);
    }

    const endpoint = `POST /api/campaigns/${id}/attach-sender-emails`;
    const { data: body } = await this.http.request({
      method: 'POST',
      path: `/api/campaigns/${id}/attach-sender-emails`,
      body: { sender_email_ids: ids },
    });
    this.requireSuccess(endpoint, body);
    this.log(`[emailbison] attachSenders -> campaign ${id}, ${ids.length} sender(s)`);
  }

  /** Accepts `{success:true}` at the top level or under `data` (the spec uses both shapes). */
  private requireSuccess(endpoint: string, body: unknown): void {
    const top = isRecord(body) ? body : null;
    const nested = top && isRecord(top['data']) ? top['data'] : null;
    const success = top && typeof top['success'] === 'boolean'
      ? top['success']
      : nested && typeof nested['success'] === 'boolean'
        ? nested['success']
        : null;
    if (success === true) return;
    const message = (top && stringOrNull(top['message'])) ?? (nested && stringOrNull(nested['message'])) ?? '';
    throw new EmailBisonResponseError(endpoint, success === null ? 'no "success" flag in body' : `success=false ${message}`.trim());
  }

  // ------------------------------------------------------------ leads

  /**
   * Steps 5 and 6: POST /api/leads/create-or-update/multiple in chunks of 500 with
   * `existing_lead_behavior: 'patch'` (never wipe fields another upload set), then
   * POST /api/campaigns/{id}/leads/attach-leads {lead_ids, allow_parallel_sending:false}.
   *
   * Counts come from the RESPONSE: `uploaded` is the number of lead ids the vendor
   * returned and we then attached; `rejected` is everything we asked for that did not
   * come back (the vendor silently skips e.g. personal domains) plus leads we could
   * not send at all (no first name, which the spec requires; no email).
   */
  async uploadLeads(input: {
    provider_ref: string;
    leads: Array<{ email: string; fields: Record<string, string> }>;
  }): Promise<{ uploaded: number; rejected: number }> {
    const id = campaignIdOf(input.provider_ref);
    if (input.leads.length === 0) return { uploaded: 0, rejected: 0 };

    const customNames = new Set<string>();
    const payloads: Array<Record<string, unknown>> = [];
    let rejectedLocally = 0;
    const seen = new Set<string>();

    for (const lead of input.leads) {
      const email = lead.email.trim().toLowerCase();
      const firstName = (lead.fields['first_name'] ?? '').trim();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || firstName.length === 0 || seen.has(email)) {
        rejectedLocally += 1;
        continue;
      }
      seen.add(email);

      const row: Record<string, unknown> = { email, first_name: firstName };
      const custom: Array<{ name: string; value: string }> = [];
      for (const [key, value] of Object.entries(lead.fields)) {
        if (key === 'first_name' || NON_LEAD_FIELDS.has(key)) continue;
        const native = NATIVE_LEAD_FIELDS[key];
        if (native) row[native] = value;
        // Every per-lead field is also a custom variable of the same name, so `{COMPANY_NAME}`
        // etc. resolve whether or not the native token name matches (see module comment).
        custom.push({ name: key, value });
        customNames.add(key);
      }
      if (custom.length > 0) row['custom_variables'] = custom;
      payloads.push(row);
    }

    await this.ensureCustomVariables([...customNames]);

    const upsertEndpoint = 'POST /api/leads/create-or-update/multiple';
    const leadIds: number[] = [];
    const chunks = chunk(payloads, LEAD_CHUNK_SIZE);
    for (const batch of chunks) {
      const { data: body } = await this.http.request({
        method: 'POST',
        path: '/api/leads/create-or-update/multiple',
        body: { leads: batch, existing_lead_behavior: 'patch' },
      });
      const rows = arrayData(upsertEndpoint, body);
      for (const row of rows) {
        if (!isRecord(row)) throw new EmailBisonResponseError(upsertEndpoint, 'a lead row is not an object');
        leadIds.push(idOf(upsertEndpoint, row));
      }
      this.log(`[emailbison] ${upsertEndpoint} -> sent ${batch.length}, returned ${rows.length}`);
    }

    const attachEndpoint = `POST /api/campaigns/${id}/leads/attach-leads`;
    const uniqueIds = [...new Set(leadIds)];
    for (const batch of chunk(uniqueIds, ATTACH_CHUNK_SIZE)) {
      const { data: body } = await this.http.request({
        method: 'POST',
        path: `/api/campaigns/${id}/leads/attach-leads`,
        body: { lead_ids: batch, allow_parallel_sending: false },
      });
      this.requireSuccess(attachEndpoint, body);
    }

    const uploaded = uniqueIds.length;
    const rejected = input.leads.length - uploaded;
    this.log(`[emailbison] uploadLeads -> campaign ${id}: ${uploaded} uploaded, ${rejected} rejected (${rejectedLocally} never sent)`);
    return { uploaded, rejected };
  }

  // ------------------------------------------------------------ schedule

  /**
   * Step 8: POST /api/campaigns/{id}/schedule with all seven weekday booleans,
   * HH:MM start/end and an IANA timezone. The daily cap lives on the campaign, not
   * the schedule, so it goes through PATCH /update (max_emails_per_day) and is
   * verified from the echo.
   */
  async setSchedule(input: {
    provider_ref: string;
    timezone: string;
    window_start: string;
    window_end: string;
    days: string[];
    daily_cap: number;
  }): Promise<void> {
    const id = campaignIdOf(input.provider_ref);
    const start = requireHhMm('window_start', input.window_start);
    const end = requireHhMm('window_end', input.window_end);
    if (!input.timezone.includes('/') && input.timezone !== 'UTC') {
      throw new Error(`emailbison: timezone must be an IANA name, got "${input.timezone}"`);
    }
    if (!Number.isInteger(input.daily_cap) || input.daily_cap <= 0) {
      throw new Error(`emailbison: daily_cap must be a positive integer, got ${input.daily_cap}`);
    }

    const enabled = new Set<DayKey>();
    for (const day of input.days) {
      const key = DAY_ALIASES[day.trim().toLowerCase()];
      if (!key) throw new Error(`emailbison: unknown day "${day}"`);
      enabled.add(key);
    }
    if (enabled.size === 0) throw new Error('emailbison: setSchedule needs at least one sending day');

    const body: Record<string, boolean | string> = { start_time: start, end_time: end, timezone: input.timezone };
    for (const key of DAY_KEYS) body[key] = enabled.has(key);

    const endpoint = `POST /api/campaigns/${id}/schedule`;
    const { data: response } = await this.http.request({ method: 'POST', path: `/api/campaigns/${id}/schedule`, body });
    const data = recordData(endpoint, response);
    for (const key of DAY_KEYS) {
      if (data[key] !== enabled.has(key)) {
        throw new EmailBisonResponseError(endpoint, `"${key}" echoed as ${JSON.stringify(data[key])}, sent ${enabled.has(key)}`);
      }
    }
    if (data['start_time'] !== start || data['end_time'] !== end || data['timezone'] !== input.timezone) {
      throw new EmailBisonResponseError(endpoint, 'echoed window or timezone differs from what was sent');
    }

    await this.updateSettings(id, { max_emails_per_day: input.daily_cap });
    this.log(`[emailbison] setSchedule -> campaign ${id}: ${[...enabled].join(',')} ${start}-${end} ${input.timezone}, cap ${input.daily_cap}/day`);
  }

  // ------------------------------------------------------------ launch / pause

  /** Step 9: PATCH /api/campaigns/{id}/resume. There is no "start"; resume is launch. */
  async launch(input: { provider_ref: string }): Promise<void> {
    await this.transition(campaignIdOf(input.provider_ref), 'resume');
  }

  /** PATCH /api/campaigns/{id}/pause. */
  async pause(input: { provider_ref: string }): Promise<void> {
    await this.transition(campaignIdOf(input.provider_ref), 'pause');
  }

  private async transition(id: number, action: 'resume' | 'pause'): Promise<void> {
    const endpoint = `PATCH /api/campaigns/${id}/${action}`;
    const { data: body } = await this.http.request({ method: 'PATCH', path: `/api/campaigns/${id}/${action}` });
    const data = recordData(endpoint, body);
    if (idOf(endpoint, data) !== id) throw new EmailBisonResponseError(endpoint, `echoed campaign id ${String(data['id'])}, expected ${id}`);
    const status = typeof data['status'] === 'string' ? data['status'].toLowerCase() : '';
    // Spec examples: resume -> "Queued" (then Launching/Active); pause -> "Paused".
    const ok = action === 'pause' ? status === 'paused' : ['queued', 'launching', 'active'].includes(status);
    if (!ok) throw new EmailBisonResponseError(endpoint, `campaign status is "${String(data['status'])}" after ${action}`);
    this.log(`[emailbison] ${action} -> campaign ${id} status ${status}`);
  }

  // ------------------------------------------------------------ stats

  /**
   * Step 10: POST /api/campaigns/{id}/stats {start_date, end_date} (a POST). Values
   * come back as numeric strings. Window defaults to the last 90 days.
   */
  async getStats(input: { provider_ref: string }): Promise<Omit<CampaignStats, 'campaign_id' | 'bounce_rate' | 'reply_rate'>> {
    const id = campaignIdOf(input.provider_ref);
    const endMs = this.now();
    const startMs = endMs - DEFAULT_STATS_WINDOW_DAYS * 86_400_000;
    const endpoint = `POST /api/campaigns/${id}/stats`;
    const { data: body } = await this.http.request({
      method: 'POST',
      path: `/api/campaigns/${id}/stats`,
      body: { start_date: isoDate(startMs), end_date: isoDate(endMs) },
    });
    const data = recordData(endpoint, body);
    const sent = countOf(endpoint, data, 'emails_sent');
    const bounces = countOf(endpoint, data, 'bounced');
    return {
      sent,
      delivered: Math.max(0, sent - bounces),
      opens: countOf(endpoint, data, 'opened'),
      replies: countOf(endpoint, data, 'unique_replies_per_contact'),
      bounces,
      unsubscribes: countOf(endpoint, data, 'unsubscribed'),
      interested: countOf(endpoint, data, 'interested'),
    };
  }

  // ------------------------------------------------------------ replies

  /**
   * Step 11: GET /api/campaigns/{id}/replies, every page. `automated_reply === true`
   * rows are dropped (an auto-responder is not a buyer). The `status=not_automated_reply`
   * filter is requested too, but an earlier capture found filters ignored on this
   * instance, so the client-side check is the one that counts. `provider_ref` is the
   * vendor's integer reply id, so a re-sync cannot duplicate a reply.
   */
  async getReplies(input: { provider_ref: string; since?: IsoTimestamp }): Promise<Array<{
    provider_ref: string;
    from_email: string;
    subject: string | null;
    body_preview: string | null;
    received_at: IsoTimestamp;
  }>> {
    const id = campaignIdOf(input.provider_ref);
    const endpoint = `GET /api/campaigns/${id}/replies`;
    const sinceMs = input.since === undefined ? Number.NEGATIVE_INFINITY : Date.parse(input.since);
    if (Number.isNaN(sinceMs)) throw new Error(`emailbison: since "${input.since}" is not an ISO timestamp`);

    // No `folder` filter: a buyer reply that lands in spam is still a reply. `status` is only a hint.
    const rows = await this.paginate(`/api/campaigns/${id}/replies`, { status: 'not_automated_reply' });
    const out: Array<{ provider_ref: string; from_email: string; subject: string | null; body_preview: string | null; received_at: IsoTimestamp }> = [];
    let automated = 0;
    let tooOld = 0;

    for (const row of rows) {
      if (!isRecord(row)) throw new EmailBisonResponseError(endpoint, 'a reply row is not an object');
      const replyId = idOf(endpoint, row);
      if (row['automated_reply'] === true) {
        automated += 1;
        continue;
      }
      const from = row['from_email_address'];
      if (typeof from !== 'string' || from.length === 0) {
        throw new EmailBisonResponseError(endpoint, `reply ${replyId} has no "from_email_address"`);
      }
      const receivedRaw = row['date_received'];
      const receivedMs = typeof receivedRaw === 'string' ? Date.parse(receivedRaw) : Number.NaN;
      if (Number.isNaN(receivedMs)) throw new EmailBisonResponseError(endpoint, `reply ${replyId} has an unreadable "date_received"`);
      if (receivedMs <= sinceMs) {
        tooOld += 1;
        continue;
      }

      const text = stringOrNull(row['text_body']);
      const html = stringOrNull(row['html_body']);
      const preview = (text && text.trim().length > 0 ? text.trim() : html ? stripHtml(html) : '').slice(0, BODY_PREVIEW_LENGTH);
      out.push({
        provider_ref: String(replyId),
        from_email: from,
        subject: stringOrNull(row['subject']),
        body_preview: preview.length > 0 ? preview : null,
        received_at: new Date(receivedMs).toISOString(),
      });
    }

    this.log(`[emailbison] getReplies -> campaign ${id}: ${rows.length} fetched, ${automated} automated dropped, ${tooOld} before since, ${out.length} returned`);
    return out;
  }
}

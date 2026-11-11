/**
 * InboxKit mailbox provider (live).
 *
 * Verified against InboxKit's docs on 2026-10-23 (docs/VENDOR_NOTES.md §4):
 *  - Auth `Authorization: Bearer <key>`, base `https://api.inboxkit.com`.
 *  - Domain and mailbox calls ALSO need `X-Workspace-Id`, read once from
 *    `GET /v1/api/workspaces/list` and cached on the instance.
 *  - Buy: `POST /v1/api/mailboxes/buy` with
 *      { use_wallet_balance, warmup_addon_enabled,
 *        mailboxes: [{ first_name, last_name, username, domain_name, platform }] }
 *    platform is GOOGLE | MICROSOFT | AZURE. One platform per domain.
 *  - Status: `POST /v1/api/mailboxes/status { uids: [...] }`.
 *  - Limits: 5 mailboxes/domain on GOOGLE and MICROSOFT, 100 on AZURE; 5,000 req/min.
 *  - InboxKit sets SPF/DKIM/DMARC itself when it provisions.
 *
 * Response SHAPES are not in the public docs (VENDOR_NOTES marks field names U), so
 * every reader below validates the body it gets and throws a descriptive error
 * rather than inventing a provider_ref. Per the parent repo's F-003: assert on
 * returned data, not status codes.
 *
 * Never log the API key or anything returned by show-credentials.
 */

import { env, requireCredential } from '../../lib/env';
import type { MailboxProvider, MailboxStatus } from '../../lib/contracts';

export type InboxKitPlatform = 'GOOGLE' | 'MICROSOFT' | 'AZURE';

/** Hard per-domain limits from InboxKit's docs. Exceeding them is a 4xx, so we check first. */
export const INBOXKIT_MAX_PER_DOMAIN: Readonly<Record<InboxKitPlatform, number>> = {
  GOOGLE: 5,
  MICROSOFT: 5,
  AZURE: 100,
};

// ---------------------------------------------------------------- cost
//
// Our cost (not the customer's price; that is env.mailboxPriceCents, $30/mailbox).
//
//   AZURE     an Exchange Online tenant is $30/month and holds up to 100 mailboxes.
//             The tenant is the billable unit, so the per-mailbox cost of ONE
//             provision call is ceil(3000 / count): 1 mailbox costs $30.00,
//             10 cost $3.00 each, 100 cost $0.30 each. A second call against the
//             same tenant would double-count the tenant; the caller should size
//             one call per domain (cost tracking, not billing, so an over-estimate
//             is the safe direction).
//   GOOGLE    ~$2.50-3.00 per mailbox per month. We book the top of the range,
//   MICROSOFT $3.00, so the ledger never under-reports.
//   warm-up   +$3.00 per mailbox on every platform (warmup_addon_enabled: true).
//
export const AZURE_TENANT_CENTS = 3_000;
export const PER_MAILBOX_CENTS: Readonly<Record<InboxKitPlatform, number>> = {
  GOOGLE: 300,
  MICROSOFT: 300,
  AZURE: 0, // tenant-priced, see above
};
export const WARMUP_ADDON_CENTS = 300;

export function inboxKitCostCents(platform: InboxKitPlatform, count: number, warmup = true): number {
  const n = Math.max(1, Math.floor(count));
  const base = platform === 'AZURE' ? Math.ceil(AZURE_TENANT_CENTS / n) : PER_MAILBOX_CENTS[platform];
  return base + (warmup ? WARMUP_ADDON_CENTS : 0);
}

// ---------------------------------------------------------------- usernames

interface NameSeed {
  first: string;
  last: string;
}

function splitSeed(seed: string): NameSeed | null {
  const parts = seed
    .trim()
    .split(/\s+/)
    .map((p) => p.toLowerCase().replace(/[^a-z]/g, ''))
    .filter(Boolean);
  const first = parts[0];
  if (!first) return null;
  const last = parts.length > 1 ? (parts[parts.length - 1] ?? '') : '';
  return { first, last };
}

/** Permutations in the order a human would pick them. Only letters and dots. */
function permutations(seed: NameSeed): string[] {
  const { first, last } = seed;
  if (!last) return [first];
  return [
    `${first.charAt(0)}.${last}`,
    `${first}.${last}`,
    first,
    `${first}${last}`,
    `${first}.${last.charAt(0)}`,
    `${last}.${first}`,
    `${first.charAt(0)}${last}`,
    last,
    `${first}${last.charAt(0)}`,
    `${last}${first.charAt(0)}`,
  ];
}

export interface GeneratedUsername {
  username: string;
  first_name: string;
  last_name: string;
}

/**
 * `count` usernames from the seeds, round-robin across seeds so two people get
 * t.smith and h.jones before anyone gets tom.smith. Numeric suffixes appear only
 * once every permutation of every seed is used, which with two seeds is 20
 * addresses. Prefer more seeds over suffixes: "tom.smith2" looks like spam.
 */
export function inboxKitUsernames(seeds: readonly string[], count: number, fallbackDisplayName: string): GeneratedUsername[] {
  const parsed = seeds.map(splitSeed).filter((s): s is NameSeed => s !== null);
  const fallback = splitSeed(fallbackDisplayName);
  const source = parsed.length ? parsed : fallback ? [fallback] : [];
  if (source.length === 0) throw new Error('InboxKit: cannot generate usernames without a name seed or display name.');

  const perSeed = source.map((s) => ({ seed: s, list: permutations(s) }));
  const longest = Math.max(...perSeed.map((p) => p.list.length));
  const out: GeneratedUsername[] = [];
  const seen = new Set<string>();

  const push = (username: string, seed: NameSeed): void => {
    if (seen.has(username)) return;
    seen.add(username);
    out.push({ username, first_name: capitalise(seed.first), last_name: capitalise(seed.last) });
  };

  for (let round = 0; round < longest && out.length < count; round++) {
    for (const { seed, list } of perSeed) {
      if (out.length >= count) break;
      const candidate = list[round];
      if (candidate !== undefined) push(candidate, seed);
    }
  }

  // Only reached when the seeds cannot cover `count` on their own.
  let suffix = 2;
  while (out.length < count) {
    for (const { seed, list } of perSeed) {
      if (out.length >= count) break;
      const base = list[1] ?? list[0];
      if (base !== undefined) push(`${base}${suffix}`, seed);
    }
    suffix += 1;
  }
  return out;
}

function capitalise(word: string): string {
  return word ? word.charAt(0).toUpperCase() + word.slice(1) : '';
}

// ---------------------------------------------------------------- status mapping

/**
 * InboxKit's status vocabulary is not fully documented; this covers the values seen
 * in their docs and webhook examples. Anything unknown throws so the job retries and
 * the gap surfaces, instead of silently marking a mailbox failed or ready.
 */
export function mapInboxKitStatus(raw: string): MailboxStatus {
  const s = raw.trim().toLowerCase();
  if (['pending', 'queued', 'ordered', 'processing', 'creating', 'provisioning', 'in_progress', 'setup'].includes(s)) return 'provisioning';
  if (['warming', 'warmup', 'warming_up', 'warm_up'].includes(s)) return 'warming';
  if (['active', 'ready', 'connected', 'live', 'completed', 'done'].includes(s)) return 'ready';
  if (['paused', 'suspended', 'disabled', 'inactive'].includes(s)) return 'paused';
  if (['failed', 'error', 'cancelled', 'canceled', 'rejected', 'deleted'].includes(s)) return 'failed';
  throw new Error(`InboxKit: unmapped mailbox status "${raw}". Add it to mapInboxKitStatus.`);
}

// ---------------------------------------------------------------- HTTP

type Json = Record<string, unknown>;

function isObject(v: unknown): v is Json {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function asString(v: unknown): string | null {
  if (typeof v === 'string' && v.trim()) return v;
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  return null;
}

/** Finds the first array of objects at any of the given keys, or at the top level. */
function findObjectArray(body: unknown, keys: readonly string[]): Json[] | null {
  if (Array.isArray(body)) return body.filter(isObject);
  if (!isObject(body)) return null;
  for (const key of keys) {
    const v = body[key];
    if (Array.isArray(v)) return v.filter(isObject);
    if (isObject(v)) {
      const nested = findObjectArray(v, keys);
      if (nested) return nested;
    }
  }
  return null;
}

export class InboxKitApiError extends Error {
  constructor(readonly status: number, readonly path: string, detail: string | null) {
    // Only a vendor `error`/`message` string is included, never the full body:
    // some bodies (show-credentials) hold plaintext passwords.
    super(`InboxKit ${path} failed with HTTP ${status}${detail ? `: ${detail}` : ''}`);
    this.name = 'InboxKitApiError';
  }
}

export interface InboxKitOptions {
  /** Defaults to INBOXKIT_API_KEY. Tests inject one to avoid touching env. */
  apiKey?: string;
  baseUrl?: string;
  /** Skip the workspaces/list call when the id is already known. */
  workspaceId?: string;
  platform?: InboxKitPlatform;
  /** Pay from the InboxKit wallet rather than the card on file. */
  useWalletBalance?: boolean;
  timeoutMs?: number;
  retries?: number;
  retryBaseMs?: number;
}

export class InboxKitProvider implements MailboxProvider {
  readonly name = 'inboxkit';

  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly platform: InboxKitPlatform;
  private readonly useWalletBalance: boolean;
  private readonly timeoutMs: number;
  private readonly retries: number;
  private readonly retryBaseMs: number;
  private workspaceIdCache: string | null;

  constructor(options: InboxKitOptions = {}) {
    this.apiKey = options.apiKey ?? requireCredential('InboxKit', 'INBOXKIT_API_KEY', env.inboxkitApiKey);
    this.baseUrl = (options.baseUrl ?? 'https://api.inboxkit.com').replace(/\/$/, '');
    this.platform = options.platform ?? 'AZURE';
    this.useWalletBalance = options.useWalletBalance ?? true;
    this.timeoutMs = options.timeoutMs ?? 20_000;
    this.retries = options.retries ?? 3;
    this.retryBaseMs = options.retryBaseMs ?? 500;
    this.workspaceIdCache = options.workspaceId ?? null;
  }

  // -------------------------------------------------------------- MailboxProvider

  async provision(input: {
    domain: string;
    count: number;
    display_name: string;
    name_seeds?: string[];
  }): Promise<Array<{
    email: string;
    provider_ref: string;
    sender_email_id: string | null;
    cost_cents: number;
    status: MailboxStatus;
  }>> {
    const domain = input.domain.trim().toLowerCase().replace(/\.$/, '');
    const count = Math.floor(input.count);
    if (!domain) throw new Error('InboxKit: provision needs a domain.');
    if (!Number.isFinite(count) || count < 1) throw new Error(`InboxKit: provision count must be at least 1, got ${input.count}.`);

    const limit = INBOXKIT_MAX_PER_DOMAIN[this.platform];
    if (count > limit) {
      throw new Error(
        `InboxKit allows at most ${limit} mailboxes per domain on the ${this.platform} platform; ` +
          `${count} requested for ${domain}. Use fewer mailboxes, more domains, or the AZURE platform (100 per domain).`,
      );
    }

    const names = inboxKitUsernames(input.name_seeds ?? [], count, input.display_name);
    const body = {
      use_wallet_balance: this.useWalletBalance,
      warmup_addon_enabled: true,
      mailboxes: names.map((n) => ({
        first_name: n.first_name,
        last_name: n.last_name,
        username: n.username,
        domain_name: domain,
        platform: this.platform,
      })),
    };

    const response = await this.request('POST', '/v1/api/mailboxes/buy', body, { workspace: true });
    const rows = findObjectArray(response, ['mailboxes', 'data', 'result', 'items']);
    if (!rows || rows.length === 0) {
      throw new Error('InboxKit: mailboxes/buy returned no mailbox rows; refusing to invent provider refs.');
    }

    const costCents = inboxKitCostCents(this.platform, count, true);
    const byEmail = new Map<string, Json>();
    for (const row of rows) {
      const email = this.rowEmail(row, domain);
      if (email) byEmail.set(email, row);
    }

    return names.map((n) => {
      const email = `${n.username}@${domain}`;
      const row = byEmail.get(email) ?? rows[names.indexOf(n)];
      const uid = row ? asString(row['uid']) ?? asString(row['id']) ?? asString(row['mailbox_uid']) : null;
      if (!uid) {
        throw new Error(`InboxKit: mailboxes/buy response has no uid for ${email}; cannot track it.`);
      }
      const rawStatus = row ? asString(row['status']) : null;
      return {
        email,
        provider_ref: uid,
        // InboxKit is not the sending platform; the EmailBison sender id is set
        // after exportSendersToEmailBison() runs and the senders are listed there.
        sender_email_id: null,
        cost_cents: costCents,
        status: rawStatus ? mapInboxKitStatus(rawStatus) : 'provisioning',
      };
    });
  }

  async getStatus(input: { provider_ref: string }): Promise<{ status: MailboxStatus; error?: string }> {
    const uid = input.provider_ref.trim();
    if (!uid) throw new Error('InboxKit: getStatus needs a provider_ref.');

    const response = await this.request('POST', '/v1/api/mailboxes/status', { uids: [uid] }, { workspace: true });
    const rows = findObjectArray(response, ['mailboxes', 'data', 'result', 'items', 'statuses']) ?? (isObject(response) ? [response] : []);
    const row =
      rows.find((r) => asString(r['uid']) === uid || asString(r['id']) === uid || asString(r['mailbox_uid']) === uid) ??
      (rows.length === 1 ? rows[0] : undefined);
    if (!row) return { status: 'failed', error: `InboxKit: mailboxes/status returned no row for uid ${uid}` };

    const raw = asString(row['status']);
    if (!raw) throw new Error(`InboxKit: mailboxes/status row for ${uid} has no status field.`);
    const status = mapInboxKitStatus(raw);
    const error = asString(row['error']) ?? asString(row['error_message']) ?? asString(row['failure_reason']);
    return error ? { status, error } : { status };
  }

  // -------------------------------------------------------------- helpers for later
  //
  // Neither is on the MailboxProvider interface yet. They exist so the
  // provision_mailboxes -> build_campaign hand-off can be wired without a second
  // spelunk through the vendor docs.

  /**
   * Pushes InboxKit mailboxes straight into EmailBison as senders, so nobody
   * hand-wires IMAP/SMTP. Two calls (VENDOR_NOTES §4):
   *   1. POST /v1/api/sequencers/add    { platform: "emailbison", app_url, api_key }
   *      registers the EmailBison instance once; returns a sequencer uid.
   *   2. POST /v1/api/sequencers/export { sequencer_uid, mailbox_uids }
   *      exports the given mailboxes into it.
   * Field names on the export call are U (see §6: discover `GET /v1/api/sequencers/platforms`
   * with a key in hand). The EmailBison API key travels to InboxKit in the body: that is
   * the vendor's design, but it means InboxKit holds a credential for our sending
   * platform. Use a token scoped to sender management if EmailBison allows it.
   *
   * After this, SendingProvider.listSenders() on EmailBison returns the new senders and
   * their `sender_email_id`s can be written onto our mailbox rows.
   */
  async exportSendersToEmailBison(input: {
    mailbox_uids: string[];
    emailbison_app_url: string;
    emailbison_api_key: string;
  }): Promise<{ sequencer_uid: string; exported: number }> {
    if (input.mailbox_uids.length === 0) return { sequencer_uid: '', exported: 0 };

    const added = await this.request(
      'POST',
      '/v1/api/sequencers/add',
      { platform: 'emailbison', app_url: input.emailbison_app_url.replace(/\/$/, ''), api_key: input.emailbison_api_key },
      { workspace: true },
    );
    const addedRow = isObject(added) ? (isObject(added['data']) ? added['data'] : added) : null;
    const sequencerUid = addedRow ? asString(addedRow['uid']) ?? asString(addedRow['id']) ?? asString(addedRow['sequencer_uid']) : null;
    if (!sequencerUid) throw new Error('InboxKit: sequencers/add returned no sequencer uid.');

    const exported = await this.request(
      'POST',
      '/v1/api/sequencers/export',
      { sequencer_uid: sequencerUid, mailbox_uids: input.mailbox_uids },
      { workspace: true },
    );
    const exportedRows = findObjectArray(exported, ['mailboxes', 'data', 'result', 'exported']);
    return { sequencer_uid: sequencerUid, exported: exportedRows ? exportedRows.length : input.mailbox_uids.length };
  }

  /**
   * SECURITY: InboxKit returns mailbox credentials in PLAINTEXT (password, SMTP and
   * IMAP settings). The result of this call must NEVER be logged, put in a job
   * `result`, written to an error message, or stored anywhere unencrypted. Hold it
   * in memory only as long as it takes to hand it to the sending platform, then
   * drop it. The same applies to the `mailbox.status_changed` webhook payload.
   *
   * GET /v1/api/mailboxes/show-credentials?uid=<uid>  (query parameter name U)
   */
  async showCredentials(uid: string): Promise<InboxKitCredentials> {
    const response = await this.request('GET', `/v1/api/mailboxes/show-credentials?uid=${encodeURIComponent(uid)}`, undefined, {
      workspace: true,
      sensitive: true,
    });
    const row = isObject(response) ? (isObject(response['data']) ? response['data'] : response) : null;
    const email = row ? asString(row['email']) : null;
    const password = row ? asString(row['password']) : null;
    if (!row || !email || !password) {
      throw new Error(`InboxKit: show-credentials for ${uid} returned no usable email/password fields.`);
    }
    return {
      email,
      password,
      smtp_host: asString(row['smtp_host']),
      smtp_port: typeof row['smtp_port'] === 'number' ? row['smtp_port'] : null,
      imap_host: asString(row['imap_host']),
      imap_port: typeof row['imap_port'] === 'number' ? row['imap_port'] : null,
    };
  }

  // -------------------------------------------------------------- internals

  private rowEmail(row: Json, domain: string): string | null {
    const direct = asString(row['email']);
    if (direct) return direct.toLowerCase();
    const username = asString(row['username']);
    const rowDomain = asString(row['domain_name']) ?? asString(row['domain']) ?? domain;
    return username ? `${username}@${rowDomain}`.toLowerCase() : null;
  }

  /** `X-Workspace-Id`, read once. Takes the first workspace unless one was injected. */
  private async workspaceId(): Promise<string> {
    if (this.workspaceIdCache) return this.workspaceIdCache;
    const response = await this.request('GET', '/v1/api/workspaces/list', undefined, { workspace: false });
    const rows = findObjectArray(response, ['workspaces', 'data', 'result', 'items']);
    const first = rows?.[0];
    const id = first ? asString(first['uid']) ?? asString(first['id']) ?? asString(first['workspace_id']) : null;
    if (!id) throw new Error('InboxKit: workspaces/list returned no workspace with a uid/id. Set workspaceId explicitly.');
    this.workspaceIdCache = id;
    return id;
  }

  private async request(
    method: 'GET' | 'POST',
    path: string,
    body: unknown,
    opts: { workspace: boolean; sensitive?: boolean },
  ): Promise<unknown> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.apiKey}`,
      Accept: 'application/json',
    };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (opts.workspace) headers['X-Workspace-Id'] = await this.workspaceId();

    let lastError: unknown = null;
    for (let attempt = 0; attempt <= this.retries; attempt++) {
      if (attempt > 0) await sleep(this.retryBaseMs * 2 ** (attempt - 1));
      let res: Response;
      try {
        res = await globalThis.fetch(`${this.baseUrl}${path}`, {
          method,
          headers,
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: AbortSignal.timeout(this.timeoutMs),
        });
      } catch (err) {
        lastError = err; // network failure or timeout: retry
        continue;
      }

      const retryable = res.status === 429 || res.status >= 500;
      let parsed: unknown = null;
      const text = await res.text();
      if (text) {
        try {
          parsed = JSON.parse(text) as unknown;
        } catch {
          parsed = null;
        }
      }

      if (res.ok) {
        if (parsed === null && text) throw new InboxKitApiError(res.status, path, 'response was not JSON');
        return parsed;
      }
      const detail = opts.sensitive ? null : vendorMessage(parsed);
      lastError = new InboxKitApiError(res.status, path, detail);
      if (!retryable) throw lastError;
    }
    throw lastError instanceof Error ? lastError : new Error(`InboxKit ${path}: request failed after ${this.retries + 1} attempts`);
  }
}

export interface InboxKitCredentials {
  email: string;
  /** PLAINTEXT. See showCredentials(). */
  password: string;
  smtp_host: string | null;
  smtp_port: number | null;
  imap_host: string | null;
  imap_port: number | null;
}

function vendorMessage(body: unknown): string | null {
  if (!isObject(body)) return null;
  const msg = asString(body['error']) ?? asString(body['message']) ?? asString(body['detail']);
  return msg ? msg.slice(0, 200) : null;
}

function sleep(ms: number): Promise<void> {
  return ms <= 0 ? Promise.resolve() : new Promise((resolve) => setTimeout(resolve, ms));
}

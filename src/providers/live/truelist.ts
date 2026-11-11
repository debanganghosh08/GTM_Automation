/**
 * TrueList email verification.
 *
 * Verified (docs/VENDOR_NOTES.md §4, 2026-10-23):
 *   - Bearer auth, base `https://api.truelist.io`, 10 requests/second.
 *   - Single address: `POST /api/v1/verify_inline?email=…` returns
 *     `{ emails: [{ address, email_state, email_sub_state, … }] }`.
 *   - `email_state` is `ok` / `risky` / `invalid` / `unknown`. Sub-states include
 *     `accept_all` (catch-all), `disposable_address`, `role_address`, `failed_no_mailbox`.
 *   - Unknown and accept-all results cost 0 credits.
 *
 * Mapping to our LeadVerification:
 *   ok -> valid, invalid -> invalid, unknown -> unknown,
 *   risky + accept_all -> catch_all, any other risky -> risky.
 *
 * Throttle: TrueList allows 10 req/s. We schedule request starts at least
 * `minIntervalMs` apart (default 125ms = 8/s) across all workers, with bounded
 * concurrency, so bursts stay under the limit even when the API answers quickly.
 *
 * TODO(truelist-batch): `/api/v1/batches` exists for bulk verification but its
 * request/response fields are not public (VENDOR_NOTES §4, §6). Discover them with
 * a key before adding a batch path. Do not guess the field names.
 *
 * Failure policy: a 401/403 throws (bad key, live mode must fail loudly). Any other
 * failure for an individual address, after retries, yields `unknown` for that
 * address so one flaky lookup does not sink the batch.
 */

import type { LeadVerification, VerificationProvider, VerificationResult } from '../../lib/contracts';
import { env, requireCredential } from '../../lib/env';

const BASE_URL = 'https://api.truelist.io';
const REQUEST_TIMEOUT_MS = 20_000;
const MAX_ATTEMPTS = 3;
const DEFAULT_CONCURRENCY = 4;
/** 125ms between request starts = 8/s, under the 10/s ceiling. */
const DEFAULT_MIN_INTERVAL_MS = 125;

type FetchLike = typeof fetch;
type Sleep = (ms: number) => Promise<void>;

export interface TrueListOptions {
  apiKey?: string;
  fetch?: FetchLike;
  sleep?: Sleep;
  concurrency?: number;
  minIntervalMs?: number;
}

export class TrueListAuthError extends Error {
  constructor(status: number) {
    super(`TrueList rejected the API key (HTTP ${status}). Check TRUELIST_API_KEY.`);
    this.name = 'TrueListAuthError';
  }
}

const defaultSleep: Sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Pure mapping from TrueList's state pair to our verdict. Exported for tests. */
export function mapTrueListState(email_state: unknown, email_sub_state: unknown): LeadVerification {
  const state = typeof email_state === 'string' ? email_state.toLowerCase() : '';
  const sub = typeof email_sub_state === 'string' ? email_sub_state.toLowerCase() : '';
  switch (state) {
    case 'ok':
      return 'valid';
    case 'invalid':
      return 'invalid';
    case 'unknown':
      return 'unknown';
    case 'risky':
      return sub === 'accept_all' ? 'catch_all' : 'risky';
    default:
      return 'unknown';
  }
}

/** Finds the row for `email` in a verify_inline body, or null when the shape is wrong. */
function parseInline(body: unknown, email: string): { email_state: unknown; email_sub_state: unknown } | null {
  if (!isRecord(body) || !Array.isArray(body.emails)) return null;
  const wanted = email.toLowerCase();
  const rows = body.emails.filter(isRecord);
  const row = rows.find((r) => typeof r.address === 'string' && r.address.toLowerCase() === wanted) ?? rows[0];
  if (!row) return null;
  return { email_state: row.email_state, email_sub_state: row.email_sub_state };
}

export class TrueListProvider implements VerificationProvider {
  readonly name = 'truelist';
  private readonly apiKey: string;
  private readonly fetchImpl: FetchLike;
  private readonly sleep: Sleep;
  private readonly concurrency: number;
  private readonly minIntervalMs: number;
  private nextSlotAt = 0;

  constructor(options: TrueListOptions = {}) {
    this.apiKey = requireCredential('TrueList', 'TRUELIST_API_KEY', options.apiKey ?? env.truelistApiKey);
    this.fetchImpl = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
    this.sleep = options.sleep ?? defaultSleep;
    this.concurrency = Math.max(1, options.concurrency ?? DEFAULT_CONCURRENCY);
    this.minIntervalMs = Math.max(0, options.minIntervalMs ?? DEFAULT_MIN_INTERVAL_MS);
  }

  async verify(emails: string[]): Promise<VerificationResult[]> {
    const results: VerificationResult[] = new Array<VerificationResult>(emails.length);
    let cursor = 0;
    const worker = async (): Promise<void> => {
      for (;;) {
        const index = cursor++;
        const email = emails[index];
        if (email === undefined) return;
        const status = await this.verifyOne(email);
        results[index] = { email, status, provider: this.name };
      }
    };
    const workers = Array.from({ length: Math.min(this.concurrency, emails.length) }, () => worker());
    await Promise.all(workers);
    return results;
  }

  /** Reserves the next start slot so that starts are spaced `minIntervalMs` apart globally. */
  private async throttle(): Promise<void> {
    const now = Date.now();
    const at = Math.max(now, this.nextSlotAt);
    this.nextSlotAt = at + this.minIntervalMs;
    if (at > now) await this.sleep(at - now);
  }

  private async verifyOne(email: string): Promise<LeadVerification> {
    const url = `${BASE_URL}/api/v1/verify_inline?email=${encodeURIComponent(email)}`;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      await this.throttle();
      let response: Response;
      try {
        response = await this.fetchImpl(url, {
          method: 'POST',
          headers: { Authorization: `Bearer ${this.apiKey}`, Accept: 'application/json' },
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
      } catch {
        await this.sleep(backoffMs(attempt));
        continue;
      }

      if (response.status === 401 || response.status === 403) throw new TrueListAuthError(response.status);
      if (response.status === 429 || response.status >= 500) {
        const retryAfter = Number.parseInt(response.headers.get('retry-after') ?? '', 10);
        await this.sleep(Number.isFinite(retryAfter) ? Math.min(retryAfter * 1000, 30_000) : backoffMs(attempt));
        continue;
      }
      if (!response.ok) return 'unknown';

      let body: unknown;
      try {
        body = await response.json();
      } catch {
        return 'unknown';
      }
      const row = parseInline(body, email);
      if (!row) return 'unknown';
      return mapTrueListState(row.email_state, row.email_sub_state);
    }
    return 'unknown';
  }
}

function backoffMs(attempt: number): number {
  return 500 * 2 ** (attempt - 1) + Math.floor(Math.random() * 100);
}

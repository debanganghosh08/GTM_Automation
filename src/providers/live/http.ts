/**
 * Bounded JSON HTTP client for live providers.
 *
 * Every request has a timeout (AbortSignal.timeout), a bounded retry budget with
 * exponential backoff on 429 / 5xx / network errors, and honours `Retry-After`
 * (seconds or HTTP-date) when the server sends one. Logging is endpoint + status
 * only: never the bearer token, never request or response bodies.
 *
 * The client returns the parsed body as `unknown`. Callers must narrow it before
 * use: a 200 proves the server answered, not that the write took effect. Some
 * EmailBison routes declare `text/plain` while returning JSON, so the body is
 * always parsed from text regardless of Content-Type.
 */

export type HttpMethod = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';

export interface HttpClientOptions {
  baseUrl: string;
  token: string;
  /** Name used in log lines and error messages, e.g. "emailbison". */
  label: string;
  timeoutMs?: number;
  /** Retries after the first attempt. 0 disables retrying. */
  maxRetries?: number;
  /** First backoff; doubles on each retry. */
  backoffMs?: number;
  /** Longest wait the client will honour, including Retry-After. */
  maxBackoffMs?: number;
  /** Injectable for tests so a retry does not need wall-clock time. */
  sleep?: (ms: number) => Promise<void>;
  /** Injectable for tests. Defaults to globalThis.fetch, resolved at call time. */
  fetchImpl?: typeof fetch;
  /** Injectable for tests. */
  log?: (line: string) => void;
}

export interface HttpRequest {
  method: HttpMethod;
  /** Path starting with "/", e.g. "/api/campaigns". */
  path: string;
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
}

export interface HttpResult {
  status: number;
  /** Parsed JSON, or the raw text when the body was not JSON, or null when empty. */
  data: unknown;
}

export class HttpError extends Error {
  readonly endpoint: string;
  readonly status: number;
  readonly attempts: number;
  /** A short, token-free excerpt of the response body for diagnostics. */
  readonly bodyExcerpt: string;

  constructor(input: { label: string; endpoint: string; status: number; attempts: number; bodyExcerpt: string }) {
    super(`${input.label}: ${input.endpoint} responded ${input.status} after ${input.attempts} attempt(s)`
      + (input.bodyExcerpt ? `: ${input.bodyExcerpt}` : ''));
    this.name = 'HttpError';
    this.endpoint = input.endpoint;
    this.status = input.status;
    this.attempts = input.attempts;
    this.bodyExcerpt = input.bodyExcerpt;
  }
}

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_BACKOFF_MS = 500;
const DEFAULT_MAX_BACKOFF_MS = 30_000;
const EXCERPT_LENGTH = 200;

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Parses Retry-After as delta-seconds or an HTTP-date. Returns null when absent or unparseable. */
export function parseRetryAfter(header: string | null, now: number = Date.now()): number | null {
  if (!header) return null;
  const trimmed = header.trim();
  if (/^\d+$/.test(trimmed)) return Number.parseInt(trimmed, 10) * 1000;
  const at = Date.parse(trimmed);
  if (Number.isNaN(at)) return null;
  return Math.max(0, at - now);
}

function isRetryable(status: number): boolean {
  return status === 429 || (status >= 500 && status <= 599);
}

function buildUrl(baseUrl: string, path: string, query?: HttpRequest['query']): string {
  const url = new URL(path, baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`);
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (value === undefined) continue;
      url.searchParams.set(key, String(value));
    }
  }
  return url.toString();
}

function parseBody(text: string): unknown {
  if (text.length === 0) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

function excerpt(text: string): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, EXCERPT_LENGTH);
}

export class HttpClient {
  private readonly options: Required<Omit<HttpClientOptions, 'fetchImpl' | 'log'>> &
    Pick<HttpClientOptions, 'fetchImpl' | 'log'>;

  constructor(options: HttpClientOptions) {
    this.options = {
      timeoutMs: DEFAULT_TIMEOUT_MS,
      maxRetries: DEFAULT_MAX_RETRIES,
      backoffMs: DEFAULT_BACKOFF_MS,
      maxBackoffMs: DEFAULT_MAX_BACKOFF_MS,
      sleep: defaultSleep,
      ...options,
    };
  }

  private log(line: string): void {
    (this.options.log ?? ((l: string) => console.info(l)))(`[${this.options.label}] ${line}`);
  }

  async request(req: HttpRequest): Promise<HttpResult> {
    const endpoint = `${req.method} ${req.path}`;
    const url = buildUrl(this.options.baseUrl, req.path, req.query);
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.options.token}`,
      Accept: 'application/json',
    };
    const init: RequestInit = { method: req.method, headers };
    if (req.body !== undefined) {
      headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(req.body);
    }

    const maxAttempts = this.options.maxRetries + 1;
    let lastError: unknown = null;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      // fetch is resolved per attempt so a test stub installed on globalThis is honoured.
      const fetchImpl = this.options.fetchImpl ?? globalThis.fetch;
      let response: Response;
      try {
        response = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(this.options.timeoutMs) });
      } catch (error) {
        lastError = error;
        this.log(`${endpoint} -> network/timeout error (attempt ${attempt}/${maxAttempts})`);
        if (attempt < maxAttempts) {
          await this.options.sleep(this.backoff(attempt, null));
          continue;
        }
        break;
      }

      const text = await response.text();
      this.log(`${endpoint} -> ${response.status} (attempt ${attempt}/${maxAttempts})`);

      if (response.ok) {
        return { status: response.status, data: parseBody(text) };
      }

      const error = new HttpError({
        label: this.options.label,
        endpoint,
        status: response.status,
        attempts: attempt,
        bodyExcerpt: excerpt(text),
      });
      lastError = error;

      if (isRetryable(response.status) && attempt < maxAttempts) {
        await this.options.sleep(this.backoff(attempt, parseRetryAfter(response.headers.get('retry-after'))));
        continue;
      }
      throw error;
    }

    if (lastError instanceof Error) {
      if (lastError instanceof HttpError) throw lastError;
      throw new HttpError({
        label: this.options.label,
        endpoint,
        status: 0,
        attempts: maxAttempts,
        bodyExcerpt: excerpt(lastError.message),
      });
    }
    throw new HttpError({ label: this.options.label, endpoint, status: 0, attempts: maxAttempts, bodyExcerpt: '' });
  }

  private backoff(attempt: number, retryAfterMs: number | null): number {
    const exponential = this.options.backoffMs * 2 ** (attempt - 1);
    const wanted = retryAfterMs === null ? exponential : Math.max(retryAfterMs, exponential);
    return Math.min(wanted, this.options.maxBackoffMs);
  }
}

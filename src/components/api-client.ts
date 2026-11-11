/**
 * Browser-side fetch helper for the pages.
 *
 * Every route returns ApiResponse<T>. This wrapper guarantees the caller always
 * gets that envelope, even when the route does not exist yet (Next's HTML 404),
 * the server is unreachable, or the body is not JSON. Pages therefore never crash
 * on a missing route; they render their shell with the error message inline.
 */

import type { ApiResponse } from '@/lib/contracts';

export type { ApiResponse };

export interface ApiFailure {
  ok: false;
  error: string;
  code?: string;
  /** HTTP status when there was a response, 0 when the request never completed. */
  status: number;
}

export type ApiResult<T> = { ok: true; data: T; status: number } | ApiFailure;

function isEnvelope(value: unknown): value is ApiResponse<unknown> {
  return typeof value === 'object' && value !== null && 'ok' in value;
}

export async function apiFetch<T>(
  path: string,
  init?: { method?: 'GET' | 'POST' | 'PUT' | 'DELETE'; body?: unknown },
): Promise<ApiResult<T>> {
  const method = init?.method ?? 'GET';
  let res: Response;
  try {
    res = await fetch(path, {
      method,
      credentials: 'same-origin',
      headers: init?.body === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: init?.body === undefined ? undefined : JSON.stringify(init.body),
      cache: 'no-store',
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Network error';
    return { ok: false, error: `Could not reach the server (${message})`, code: 'network', status: 0 };
  }

  let parsed: unknown = null;
  const text = await res.text();
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = null;
    }
  }

  if (isEnvelope(parsed)) {
    if (parsed.ok) return { ok: true, data: parsed.data as T, status: res.status };
    return { ok: false, error: parsed.error, code: parsed.code, status: res.status };
  }

  if (res.status === 404) {
    return { ok: false, error: `${method} ${path} is not available yet`, code: 'route_missing', status: 404 };
  }
  if (res.status === 401) {
    return { ok: false, error: 'Not signed in', code: 'unauthorized', status: 401 };
  }
  return {
    ok: false,
    error: `Unexpected ${res.status} response from ${path}`,
    code: 'bad_response',
    status: res.status,
  };
}

export function isUnauthorized(r: ApiFailure): boolean {
  return r.status === 401 || r.code === 'unauthorized';
}

export function isMissingRoute(r: ApiFailure): boolean {
  return r.code === 'route_missing';
}

/** Reads a field off an unknown object, for tolerating slightly different route shapes. */
export function pick<T>(obj: unknown, key: string): T | undefined {
  if (typeof obj !== 'object' || obj === null) return undefined;
  return (obj as Record<string, unknown>)[key] as T | undefined;
}

export function formatNumber(n: number | null | undefined): string {
  if (n === null || n === undefined || Number.isNaN(n)) return '–';
  return new Intl.NumberFormat('en-US').format(n);
}

/** Rates may arrive as 0–1 fractions or 0–100 percentages; normalise to a percent string. */
export function formatRate(rate: number | null | undefined, digits = 1): string {
  if (rate === null || rate === undefined || Number.isNaN(rate)) return '–';
  const pct = rate <= 1 ? rate * 100 : rate;
  return `${pct.toFixed(digits)}%`;
}

export function ratio(numerator: number, denominator: number): number {
  if (!denominator) return 0;
  return numerator / denominator;
}

export function formatDate(iso: string | null | undefined): string {
  if (!iso) return '–';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
}

export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return '–';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

export function formatCents(cents: number | null | undefined): string {
  if (cents === null || cents === undefined || Number.isNaN(cents)) return '–';
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(cents / 100);
}

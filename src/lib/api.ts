/**
 * HTTP helpers. Every route returns ApiResponse<T> so the client never has to
 * guess the error shape.
 */

import { NextResponse } from 'next/server';
import type { ApiResponse } from './contracts';

export function ok<T>(data: T, init?: ResponseInit): NextResponse {
  return NextResponse.json({ ok: true, data } satisfies ApiResponse<T>, init);
}

export function fail(error: string, status = 400, code?: string): NextResponse {
  return NextResponse.json({ ok: false, error, code } satisfies ApiResponse<never>, { status });
}

/** 401 with a consistent shape, used by the session guard. */
export function unauthorized(): NextResponse {
  return fail('Not signed in', 401, 'unauthorized');
}

export function forbidden(message = 'Not allowed'): NextResponse {
  return fail(message, 403, 'forbidden');
}

export function notFound(message = 'Not found'): NextResponse {
  return fail(message, 404, 'not_found');
}

export interface RouteOptions {
  /** Skip the Content-Type check (for routes that take no JSON body). */
  requireJson?: boolean;
  /** Skip the cross-origin check (only for routes a third party must call). */
  skipOriginCheck?: boolean;
  /** Skip the per-IP ceiling (only for routes with their own tighter limit). */
  skipRateLimit?: boolean;
}

/**
 * Wraps a route handler.
 *
 * Every route in the app goes through here, which is deliberate: the common failure
 * in generated code is a guard that gets added to new handlers and missed on old
 * ones. Putting the cross-origin, content-type and flood checks in this one place
 * means a route cannot be written without them.
 *
 * It also turns an unexpected throw into a 500 with a logged cause, rather than
 * Next's default HTML error page.
 *
 * The context parameter is generic rather than `never` so a dynamic segment's
 * `{ params }` still typechecks against Next's build-time route validation.
 * In Next 15+ `params` is a Promise, so handlers await it.
 */
export function route<Ctx = unknown>(
  handler: (req: Request, ctx: Ctx) => Promise<Response>,
  options: RouteOptions = {},
) {
  return async (req: Request, ctx: Ctx): Promise<Response> => {
    try {
      // Imported lazily so this module stays usable from tests and scripts that do
      // not have a database available.
      if (!options.skipOriginCheck) {
        const { guardRequest } = await import('./request-guard');
        const rejected = guardRequest(req, { requireJson: options.requireJson });
        if (rejected) return rejected;
      }

      if (!options.skipRateLimit) {
        const { checkRateLimit, clientIp } = await import('./rate-limit');
        const limit = await checkRateLimit('api', `ip:${clientIp(req)}`);
        if (!limit.allowed) {
          return tooManyRequests(limit.resetSeconds);
        }
      }

      return await handler(req, ctx);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error('[route error]', req.method, new URL(req.url).pathname, message);
      return fail(
        // Masked unless explicitly in development: a host that leaves NODE_ENV unset
        // would otherwise return raw SQL and stack text to the caller.
        process.env.NODE_ENV === 'development' ? message : 'Something went wrong',
        500,
        'internal_error',
      );
    }
  };
}

/** 429 with the standard Retry-After header. */
export function tooManyRequests(resetSeconds: number): NextResponse {
  const res = NextResponse.json(
    { ok: false, error: 'Too many requests. Please slow down.', code: 'rate_limited' } satisfies ApiResponse<never>,
    { status: 429 },
  );
  res.headers.set('Retry-After', String(Math.max(1, resetSeconds)));
  return res;
}

/**
 * Largest request body any route accepts. Every route takes a small JSON object; the
 * biggest legitimate one is campaign copy at a few tens of kilobytes. Without a cap an
 * unauthenticated caller can make the server buffer an arbitrarily large body.
 */
export const MAX_BODY_BYTES = 64 * 1024;

/**
 * Parses a JSON body, returning null when it is absent, malformed or too large.
 *
 * Checks Content-Length first (cheap, and covers honest clients), then measures the
 * text it actually read, because Content-Length can be absent under chunked encoding.
 */
export async function jsonBody<T>(req: Request): Promise<T | null> {
  const declared = Number.parseInt(req.headers.get('content-length') ?? '', 10);
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) return null;

  try {
    const text = await req.text();
    if (text.length > MAX_BODY_BYTES) return null;
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

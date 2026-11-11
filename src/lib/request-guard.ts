/**
 * Cross-origin and content-type guards for state-changing requests.
 *
 * The session cookie is `SameSite=Lax`, which stops a cross-site POST from carrying
 * it in current browsers. That is the main CSRF defence and it is sound, but it is a
 * single control that depends on browser behaviour and on the cookie flag never
 * changing. These checks add a server-side layer that does not:
 *
 *   - `Origin` must match our own origin when the header is present.
 *   - `Sec-Fetch-Site` must not say `cross-site`.
 *   - A JSON body must actually be declared as JSON, so a form POST (which needs no
 *     preflight and therefore no CORS permission) cannot reach a mutating route.
 *
 * Nothing here changes what a route does; it only decides whether to let the request
 * reach it. Read-only methods are untouched.
 */

import { env } from './env';
import { fail } from './api';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

function appOrigin(): string {
  try {
    return new URL(env.appUrl).origin;
  } catch {
    return '';
  }
}

/**
 * Returns a rejection Response when the request looks cross-origin, or null when it
 * is fine to proceed.
 */
export function checkOrigin(req: Request): Response | null {
  if (SAFE_METHODS.has(req.method)) return null;

  // `Sec-Fetch-Site` is set by the browser and cannot be forged by page JavaScript.
  // `same-origin` and `none` (a direct navigation) are both fine.
  const fetchSite = req.headers.get('sec-fetch-site');
  if (fetchSite === 'cross-site') {
    return fail('Cross-origin requests are not allowed', 403, 'cross_origin');
  }

  const origin = req.headers.get('origin');
  if (origin) {
    const expected = appOrigin();
    // In development APP_URL often does not match the port in use, so compare only
    // when we have a configured origin to compare against.
    if (expected && origin !== expected) {
      return fail('Cross-origin requests are not allowed', 403, 'cross_origin');
    }
  }

  return null;
}

/**
 * Requires that a body-carrying request declares JSON. Without this a route is
 * reachable from a plain HTML form, which browsers send without a CORS preflight.
 */
export function checkJsonContentType(req: Request): Response | null {
  if (SAFE_METHODS.has(req.method)) return null;

  const contentType = req.headers.get('content-type');
  const contentLength = req.headers.get('content-length');

  // A bodyless POST (an action trigger such as /strategy/generate) legitimately has
  // no Content-Type. Cross-origin protection for those comes from the Origin and
  // Sec-Fetch-Site checks above, not from this one.
  if (!contentType && (contentLength === null || contentLength === '0')) return null;

  // A body that declares anything other than JSON is refused. This is what stops a
  // plain HTML form reaching a mutating route: a form can only send
  // urlencoded, multipart or text/plain, none of which need a CORS preflight.
  if (!contentType || !contentType.toLowerCase().includes('application/json')) {
    return fail('Content-Type must be application/json', 415, 'unsupported_media_type');
  }
  return null;
}

/**
 * Both guards in the order a route wants them. Returns a Response to send back, or
 * null to continue.
 */
export function guardRequest(req: Request, opts: { requireJson?: boolean } = {}): Response | null {
  const origin = checkOrigin(req);
  if (origin) return origin;
  if (opts.requireJson !== false) {
    const contentType = checkJsonContentType(req);
    if (contentType) return contentType;
  }
  return null;
}

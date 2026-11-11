/**
 * Content-Security-Policy with a per-request nonce.
 *
 * WHY THIS FILE EXISTS
 * The first version of the CSP lived in next.config.ts as a static header with
 * `script-src 'self' https://js.stripe.com`. That blocked Next's own inline bootstrap
 * scripts, so React never hydrated: every form fell back to a native HTML submit,
 * which turned the signup form into a GET that put the password in the URL and never
 * called the API. A security header broke sign-in.
 *
 * Two ways out. `'unsafe-inline'` on script-src is one line and gives up most of the
 * protection a CSP exists for. A nonce keeps it: Next stamps the same nonce onto the
 * scripts it emits, and the browser runs those and nothing else.
 *
 * The usual cost of a nonce is losing static optimisation, because a per-request value
 * cannot be baked into a cached page. That cost is zero here: the landing page already
 * renders dynamically (it reads the `?code=` parameter), as do all the signed-in pages.
 *
 * In Next 16 this file is `proxy.ts`; it was `middleware.ts` in earlier versions.
 *
 * NOTE: this is defence in depth only. Authentication and tenant scoping are enforced
 * in each route handler, never here — a proxy must not be the only thing standing
 * between a request and someone else's data.
 */

import { NextResponse, type NextRequest } from 'next/server';

export function proxy(req: NextRequest): NextResponse {
  const nonce = Buffer.from(crypto.randomUUID()).toString('base64');

  /**
   * React's DEVELOPMENT build calls eval() for debugging features (reconstructing
   * call stacks across environments). Without 'unsafe-eval' it throws during render,
   * so every client component stays stuck on its loading state and the signed-in app
   * looks empty — which is exactly how this was first reported.
   *
   * React's own message states it never uses eval() in production, so this is added
   * for development only and the production policy stays strict.
   */
  const devEval = process.env.NODE_ENV === 'production' ? '' : " 'unsafe-eval'";

  const csp = [
    "default-src 'self'",
    // `strict-dynamic` lets a nonced script load the chunks it needs, which is how
    // Next's bootstrap pulls the rest of the bundle. Modern browsers then ignore the
    // host allowlist for scripts, so js.stripe.com is kept only for older ones.
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic' https://js.stripe.com${devEval}`,
    // Styles still need 'unsafe-inline': Next injects inline <style> for CSS and there
    // is no nonce hook for it. A stylesheet cannot execute, so the risk is cosmetic
    // rather than script execution.
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: https://*.stripe.com",
    "font-src 'self' data:",
    "connect-src 'self' https://api.stripe.com",
    "frame-src https://js.stripe.com https://hooks.stripe.com",
    // The part that matters most for a dashboard with Launch and Approve buttons.
    "frame-ancestors 'none'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "upgrade-insecure-requests",
  ].join('; ');

  // Next reads `x-nonce` off the request and applies it to the scripts it renders.
  const requestHeaders = new Headers(req.headers);
  requestHeaders.set('x-nonce', nonce);

  const res = NextResponse.next({ request: { headers: requestHeaders } });
  res.headers.set('Content-Security-Policy', csp);
  return res;
}

export const config = {
  /**
   * Everything except API routes and static assets. API responses carry no scripts,
   * and hashing a nonce into every static file would defeat caching.
   *
   * Prefetches are excluded because Next issues them for pages the user has not
   * navigated to, and a CSP response for a prefetch can be cached against the wrong
   * nonce.
   */
  matcher: [
    {
      source: '/((?!api|_next/static|_next/image|favicon.ico).*)',
      missing: [
        { type: 'header', key: 'next-router-prefetch' },
        { type: 'header', key: 'purpose', value: 'prefetch' },
      ],
    },
  ],
};

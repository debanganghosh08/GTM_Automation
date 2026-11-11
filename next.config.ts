import type { NextConfig } from 'next';

/**
 * Security headers.
 *
 * The Content-Security-Policy is NOT here: it needs a per-request nonce so that Next's
 * inline bootstrap scripts can run, so it is set in src/proxy.ts. A static CSP here
 * blocked those scripts, React never hydrated, and every form silently fell back to a
 * native HTML submit. See the comment at the top of proxy.ts.
 *
 * These headers are static and belong at the config level.
 */
const securityHeaders = [
  {
    key: 'Strict-Transport-Security',
    // No `preload` directive: that is a one-way commitment for the whole domain and
    // every subdomain, and should be a deliberate decision, not a default.
    value: 'max-age=63072000; includeSubDomains',
  },
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  {
    key: 'Permissions-Policy',
    value: 'camera=(), microphone=(), geolocation=(), browsing-topics=(), interest-cohort=()',
  },
  // allow-popups rather than same-origin: Stripe's 3DS flow opens a popup.
  { key: 'Cross-Origin-Opener-Policy', value: 'same-origin-allow-popups' },
];

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // Do not advertise the framework and its version.
  poweredByHeader: false,
  // PGlite and pg are server-only; keep them out of the client bundle.
  serverExternalPackages: ['@electric-sql/pglite', 'pg'],

  async headers() {
    return [
      { source: '/(.*)', headers: securityHeaders },
      {
        // API responses are never a document and must never be cached by a shared
        // cache: several carry account-scoped data behind a session cookie.
        source: '/api/(.*)',
        headers: [
          { key: 'Cache-Control', value: 'no-store, max-age=0, must-revalidate' },
          { key: 'Cross-Origin-Resource-Policy', value: 'same-origin' },
        ],
      },
    ];
  },
};

export default nextConfig;

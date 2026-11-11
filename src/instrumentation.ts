/**
 * Next.js runs this once per server start, before handling any request.
 *
 * It is the only place that can stop a dangerously-configured deployment from
 * serving traffic at all, which is why the configuration guard lives here rather
 * than in a route.
 */

export async function register(): Promise<void> {
  // Only the Node runtime has the env and crypto surface these checks need; the
  // edge runtime would throw on import.
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;

  const { assertConfiguration } = await import('./lib/startup-checks');
  assertConfiguration();
}

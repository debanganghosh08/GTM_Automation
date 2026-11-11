/**
 * GET /api/health
 *
 * Public response is a bare liveness check. The operational detail (provider modes,
 * job counts, handler coverage) is only returned when the caller presents the cron
 * secret, because it is useful reconnaissance: a reader who learns that billing is in
 * mock mode knows the free-credit route is open, and the job counts expose
 * system-wide activity. It also ran a count(*) over a table that only grows.
 *
 * Detail:  curl -H "x-cron-secret: $CRON_SECRET" https://host/api/health
 */

import { timingSafeEqual } from 'node:crypto';
import { getDb } from '@/lib/db';
import { env } from '@/lib/env';
import { providerMode } from '@/lib/env';
import { fail, ok } from '@/lib/api';
import { jobStats } from '@/jobs/queue';
import { missingHandlers, unexpectedMissingHandlers } from '@/jobs/registry';
// Handlers register themselves on import. Without this the registry looks empty in
// this route's module graph and health reports every handler as missing — a false
// alarm that would make the endpoint useless exactly when it matters.
import '@/jobs/handlers';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const PROVIDER_KEYS = [
  'leads', 'leads_overflow', 'verification', 'sending', 'domains', 'mailboxes', 'billing', 'llm', 'scrape',
] as const;

/** Constant-time check of the operator secret. */
function isOperator(req: Request): boolean {
  const presented = req.headers.get('x-cron-secret')
    ?? req.headers.get('authorization')?.replace(/^Bearer\s+/i, '')
    ?? '';
  if (!presented || !env.cronSecret) return false;
  const a = Buffer.from(presented);
  const b = Buffer.from(env.cronSecret);
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function GET(req: Request): Promise<Response> {
  // Liveness only, for anyone. A load balancer needs nothing more than this.
  if (!isOperator(req)) {
    try {
      const db = await getDb();
      await db.query('select 1');
      return ok({ status: 'ok' });
    } catch {
      return fail('Service unavailable', 503, 'unhealthy');
    }
  }

  try {
    const db = await getDb();
    const migrations = await db
      .query<{ n: string | number }>('select count(*) as n from schema_migrations')
      .then((r) => Number(r.rows[0]?.n ?? 0))
      .catch(() => 0);
    const jobs = await jobStats(db);

    const providers: Record<string, 'mock' | 'live'> = { default: providerMode() };
    for (const key of PROVIDER_KEYS) providers[key] = providerMode(key);

    return ok({
      status: 'ok',
      db: db.backend,
      migrations,
      jobs,
      providers,
      handlers: {
        missing: missingHandlers(),
        unexpected_missing: unexpectedMissingHandlers(),
      },
      time: new Date().toISOString(),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[health]', message);
    return fail('database unavailable', 503, 'unavailable');
  }
}

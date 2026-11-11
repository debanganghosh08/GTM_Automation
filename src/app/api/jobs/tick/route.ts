/**
 * POST /api/jobs/tick — one scheduler tick, for pg_cron or a Vercel cron.
 *
 * Auth is a shared secret. Accepted as `x-cron-secret: <secret>` or, because Vercel
 * cron can only send it this way, `authorization: Bearer <secret>`.
 */

import { timingSafeEqual } from 'node:crypto';
import { env } from '@/lib/env';
import { fail, ok } from '@/lib/api';
import { reapStale } from '@/jobs/queue';
import { runOnce } from '@/jobs/runner';
import '@/jobs/handlers';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const DEV_DEFAULT_SECRET = 'dev-only-change-me';

function secretMatches(given: string | null): boolean {
  if (!given) return false;
  const a = Buffer.from(given, 'utf8');
  const b = Buffer.from(env.cronSecret, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

function presentedSecret(req: Request): string | null {
  const header = req.headers.get('x-cron-secret');
  if (header) return header;
  const auth = req.headers.get('authorization');
  if (auth?.toLowerCase().startsWith('bearer ')) return auth.slice(7).trim();
  return null;
}

async function tick(req: Request): Promise<Response> {
  if (env.nodeEnv === 'production' && env.cronSecret === DEV_DEFAULT_SECRET) {
    return fail('CRON_SECRET is not configured', 503, 'misconfigured');
  }
  if (!secretMatches(presentedSecret(req))) {
    return fail('Invalid cron secret', 401, 'unauthorized');
  }

  try {
    const reaped = await reapStale();
    const run = await runOnce(`tick-${process.pid}`);
    return ok({ reaped, ran: run.ran, results: run.results });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[jobs/tick]', message);
    return fail(env.nodeEnv === 'production' ? 'Tick failed' : message, 500, 'internal_error');
  }
}

export async function POST(req: Request): Promise<Response> {
  return tick(req);
}

/**
 * Vercel Cron invokes the path with a GET and an `authorization: Bearer <CRON_SECRET>`
 * header, so GET has to work for the scheduled path to run at all. Same secret check.
 */
export async function GET(req: Request): Promise<Response> {
  return tick(req);
}

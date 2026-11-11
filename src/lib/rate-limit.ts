/**
 * Rate limiting.
 *
 * A fixed-window counter in Postgres. On Vercel each request may land on a different
 * instance, so an in-memory limiter cannot limit anything; and adding Redis for this
 * alone is not worth a second datastore at launch. One `INSERT ... ON CONFLICT DO
 * UPDATE` per check is a single round trip and is safe under concurrency, because
 * the window is part of the primary key.
 *
 * Fixed windows allow a burst across a window boundary (up to 2x the limit in the
 * worst case). That is an accepted trade-off here: these limits exist to stop brute
 * force and cost abuse, not to meter precisely.
 *
 * This module decides nothing about product behaviour. It only answers "has this
 * caller done this too often".
 */

import { getDb, type Db } from './db';

export interface RateLimitRule {
  /** Maximum hits allowed inside the window. */
  limit: number;
  /** Window length in seconds. */
  windowSeconds: number;
}

export interface RateLimitResult {
  allowed: boolean;
  limit: number;
  remaining: number;
  /** Seconds until the current window ends. */
  resetSeconds: number;
}

/**
 * The limits. Tuned to be invisible to a real user and painful to a script.
 *
 * Login is the strictest: credential stuffing is the most likely attack on a
 * self-serve product, and a human never needs ten attempts a minute.
 */
export const RULES = {
  /** Per IP. Signup creates an account and costs us money downstream. */
  signup: { limit: 5, windowSeconds: 3600 },
  /** Per IP. Deliberately tight. */
  login_ip: { limit: 10, windowSeconds: 900 },
  /** Per email, so a distributed attack on one account is still throttled. */
  login_email: { limit: 8, windowSeconds: 900 },
  /** Per IP. Checkout creates a Stripe session, which is a paid API call. */
  checkout: { limit: 5, windowSeconds: 3600 },
  /** Per account. The general authenticated API budget. */
  api: { limit: 300, windowSeconds: 60 },
  /** Per account. Each of these enqueues paid vendor work. */
  expensive: { limit: 20, windowSeconds: 3600 },
  /** Per IP. Unauthenticated and public, so it needs its own ceiling. */
  unsubscribe: { limit: 60, windowSeconds: 3600 },
  /** Per IP. Stripe itself is allowlisted by signature, but floods still cost us. */
  webhook: { limit: 600, windowSeconds: 60 },
} as const satisfies Record<string, RateLimitRule>;

export type RuleName = keyof typeof RULES;

/**
 * Records one hit and reports whether it is allowed.
 *
 * Fails OPEN: if the database is unreachable the request proceeds. A limiter that
 * takes the whole product down when Postgres hiccups is worse than one that briefly
 * stops limiting. Authentication and payment correctness never depend on this.
 */
export async function checkRateLimit(
  rule: RuleName,
  identifier: string,
  dbOverride?: Db,
): Promise<RateLimitResult> {
  const { limit, windowSeconds } = RULES[rule];
  const bucket = `${rule}:${identifier}`;

  try {
    const db = dbOverride ?? (await getDb());
    const res = await db.query<{ hits: number; reset_seconds: number }>(
      `insert into rate_limits (bucket, window_start, hits, expires_at)
       values (
         $1,
         to_timestamp(floor(extract(epoch from now()) / $2) * $2),
         1,
         to_timestamp(floor(extract(epoch from now()) / $2) * $2) + ($2 || ' seconds')::interval
       )
       on conflict (bucket, window_start) do update set hits = rate_limits.hits + 1
       returning hits, ceil(extract(epoch from (rate_limits.expires_at - now())))::int as reset_seconds`,
      [bucket, windowSeconds],
    );

    const row = res.rows[0];
    if (!row) return { allowed: true, limit, remaining: limit, resetSeconds: windowSeconds };

    const hits = Number(row.hits);
    return {
      allowed: hits <= limit,
      limit,
      remaining: Math.max(0, limit - hits),
      resetSeconds: Math.max(0, Number(row.reset_seconds)),
    };
  } catch (err) {
    console.error('[rate-limit] check failed, allowing request:', err instanceof Error ? err.message : err);
    return { allowed: true, limit, remaining: limit, resetSeconds: windowSeconds };
  }
}

/**
 * Best-effort cleanup of windows that have passed. Called from the job tick; the
 * table works correctly without it, this just keeps it small.
 */
export async function pruneRateLimits(dbOverride?: Db): Promise<number> {
  try {
    const db = dbOverride ?? (await getDb());
    const res = await db.query('delete from rate_limits where expires_at < now() - interval \'1 hour\'');
    return res.rowCount;
  } catch {
    return 0;
  }
}

/**
 * The caller's IP, from the proxy headers Vercel sets.
 *
 * `x-forwarded-for` can be spoofed when nothing trusted sits in front, so this is
 * only ever used for rate limiting and abuse signals, never for authorization.
 * Vercel overwrites these at the edge, so the leftmost entry is trustworthy there.
 */
export function clientIp(req: Request): string {
  const forwarded = req.headers.get('x-forwarded-for');
  if (forwarded) {
    const first = forwarded.split(',')[0]?.trim();
    if (first) return first;
  }
  return req.headers.get('x-real-ip')?.trim() || 'unknown';
}

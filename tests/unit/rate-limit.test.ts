/**
 * Rate limiting. These prove the limiter actually stops a burst, isolates callers,
 * and never takes the product down when the database is unavailable.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { freshDb, dropDb } from '../helpers/db';
import { checkRateLimit, clientIp, pruneRateLimits, RULES } from '../../src/lib/rate-limit';
import type { Db } from '../../src/lib/db';

let db: Db;

beforeAll(async () => {
  db = await freshDb();
});
afterAll(dropDb);

describe('checkRateLimit', () => {
  it('allows up to the limit and blocks after it', async () => {
    const id = 'ip:198.51.100.1';
    const { limit } = RULES.login_ip;

    for (let i = 1; i <= limit; i += 1) {
      const res = await checkRateLimit('login_ip', id, db);
      expect(res.allowed, `attempt ${i} of ${limit} should be allowed`).toBe(true);
      expect(res.remaining).toBe(limit - i);
    }

    const blocked = await checkRateLimit('login_ip', id, db);
    expect(blocked.allowed).toBe(false);
    expect(blocked.remaining).toBe(0);
    expect(blocked.resetSeconds).toBeGreaterThan(0);
  });

  it('keeps separate callers independent', async () => {
    const a = await checkRateLimit('signup', 'ip:203.0.113.10', db);
    const b = await checkRateLimit('signup', 'ip:203.0.113.11', db);
    expect(a.remaining).toBe(RULES.signup.limit - 1);
    expect(b.remaining).toBe(RULES.signup.limit - 1);
  });

  it('keeps separate rules independent for the same caller', async () => {
    const id = 'ip:203.0.113.20';
    await checkRateLimit('signup', id, db);
    const other = await checkRateLimit('checkout', id, db);
    expect(other.remaining).toBe(RULES.checkout.limit - 1);
  });

  it('counts concurrent hits exactly once each', async () => {
    const id = 'ip:203.0.113.30';
    const burst = 8;
    const results = await Promise.all(
      Array.from({ length: burst }, () => checkRateLimit('login_email', id, db)),
    );
    // Every hit must be accounted for: no lost updates under concurrency.
    const remainings = results.map((r) => r.remaining).sort((x, y) => x - y);
    const expected = Array.from({ length: burst }, (_, i) => RULES.login_email.limit - burst + i);
    expect(remainings).toEqual(expected);
  });

  it('fails open when the database is unavailable', async () => {
    const broken = {
      query: async () => { throw new Error('connection refused'); },
    } as unknown as Db;
    const res = await checkRateLimit('api', 'account:x', broken);
    expect(res.allowed, 'a limiter outage must not take the product down').toBe(true);
  });

  it('prunes expired windows without affecting live ones', async () => {
    await checkRateLimit('api', 'account:prune-live', db);
    await db.query(
      `insert into rate_limits (bucket, window_start, hits, expires_at)
       values ('api:old', now() - interval '3 hours', 5, now() - interval '2 hours')`,
    );
    await pruneRateLimits(db);
    const left = await db.query<{ bucket: string }>(`select bucket from rate_limits where bucket = 'api:old'`);
    expect(left.rows).toHaveLength(0);
    const live = await db.query<{ bucket: string }>(
      `select bucket from rate_limits where bucket = 'api:account:prune-live'`,
    );
    expect(live.rows).toHaveLength(1);
  });
});

describe('clientIp', () => {
  it('reads the leftmost x-forwarded-for entry', () => {
    const req = new Request('http://x/', { headers: { 'x-forwarded-for': '203.0.113.7, 10.0.0.1' } });
    expect(clientIp(req)).toBe('203.0.113.7');
  });

  it('falls back to x-real-ip, then to unknown', () => {
    expect(clientIp(new Request('http://x/', { headers: { 'x-real-ip': '203.0.113.8' } }))).toBe('203.0.113.8');
    expect(clientIp(new Request('http://x/'))).toBe('unknown');
  });
});

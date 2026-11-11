/**
 * Job queue (I5). Exercises the real schema through the real queue code: dedupe,
 * atomic claim, backoff, death, reaping, and a runner that cannot be taken down by
 * a handler.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { freshDb, dropDb, makeAccount } from '../helpers/db';
import type { Db } from '../../src/lib/db';
import type { JobType } from '../../src/lib/contracts';
import {
  backoffSeconds, claimNext, complete, enqueue, failJob, getJob, jobStats, reapStale,
} from '../../src/jobs/queue';
import {
  JOB_TYPES, NOT_YET_IMPLEMENTED, clearHandlers, hasHandlerFor, missingHandlers,
  registerHandler, unexpectedMissingHandlers,
} from '../../src/jobs/registry';
import { runForever, runOnce } from '../../src/jobs/runner';
import { registerAllHandlers } from '../../src/jobs/handlers';

let db: Db;
let account: string;
const quiet = () => {};

beforeAll(async () => {
  db = await freshDb();
  account = await makeAccount(db);
});
afterAll(dropDb);

beforeEach(async () => {
  await db.query('delete from jobs');
  await db.query('delete from events');
  clearHandlers();
});

async function secondsUntilRun(id: string): Promise<number> {
  const res = await db.query<{ secs: string | number }>(
    `select extract(epoch from (run_after - now())) as secs from jobs where id = $1`,
    [id],
  );
  return Number(res.rows[0]!.secs);
}

async function makeDueNow(id: string): Promise<void> {
  await db.query(`update jobs set run_after = now() where id = $1`, [id]);
}

// ---------------------------------------------------------------- enqueue

describe('enqueue', () => {
  it('dedupes an identical pending job and returns the existing id', async () => {
    const a = await enqueue({ type: 'source_leads', accountId: account, dedupeKey: 'camp-1', payload: { x: 1 } });
    const b = await enqueue({ type: 'source_leads', accountId: account, dedupeKey: 'camp-1', payload: { x: 2 } });

    expect(a.deduped).toBe(false);
    expect(b).toEqual({ id: a.id, deduped: true });

    const rows = await db.query(`select id from jobs where type = 'source_leads' and dedupe_key = 'camp-1'`);
    expect(rows.rows).toHaveLength(1);
  });

  it('also dedupes against a running job', async () => {
    const a = await enqueue({ type: 'sync_stats', dedupeKey: 'running-1' });
    const claimed = await claimNext('w1');
    expect(claimed?.id).toBe(a.id);
    const b = await enqueue({ type: 'sync_stats', dedupeKey: 'running-1' });
    expect(b).toEqual({ id: a.id, deduped: true });
  });

  it('allows the same dedupe key again once the earlier job is terminal', async () => {
    const a = await enqueue({ type: 'generate_copy', dedupeKey: 'copy-1' });
    const claimed = await claimNext('w1');
    await complete(claimed!.id, { ok: true });

    const b = await enqueue({ type: 'generate_copy', dedupeKey: 'copy-1' });
    expect(b.deduped).toBe(false);
    expect(b.id).not.toBe(a.id);

    const stats = await jobStats();
    expect(stats.succeeded).toBe(1);
    expect(stats.pending).toBe(1);
  });

  it('treats the same key under a different type as a different job', async () => {
    const a = await enqueue({ type: 'sync_stats', dedupeKey: 'shared' });
    const b = await enqueue({ type: 'sync_replies', dedupeKey: 'shared' });
    expect(b.deduped).toBe(false);
    expect(b.id).not.toBe(a.id);
  });

  it('never dedupes jobs without a key', async () => {
    const a = await enqueue({ type: 'sync_stats' });
    const b = await enqueue({ type: 'sync_stats' });
    expect(a.id).not.toBe(b.id);
    expect(b.deduped).toBe(false);
  });

  it('honours delayMs, maxAttempts and the payload', async () => {
    const { id } = await enqueue({ type: 'scrape_site', payload: { url: 'https://x.io' }, delayMs: 60_000, maxAttempts: 2 });
    const job = await getJob(id);
    expect(job?.payload).toEqual({ url: 'https://x.io' });
    expect(job?.max_attempts).toBe(2);
    expect(await secondsUntilRun(id)).toBeGreaterThan(55);
    expect(await claimNext('w1')).toBeNull();
  });
});

// ---------------------------------------------------------------- claim

describe('claimNext', () => {
  it('claims one job, marks it running, locks it and counts the attempt', async () => {
    const { id } = await enqueue({ type: 'verify_dns', accountId: account, payload: { domain_id: 'd1' } });
    const job = await claimNext('worker-A');

    expect(job?.id).toBe(id);
    expect(job?.status).toBe('running');
    expect(job?.attempts).toBe(1);
    expect(job?.payload).toEqual({ domain_id: 'd1' });
    expect(typeof job?.run_after).toBe('string');

    const row = await db.query<{ locked_by: string; locked_at: Date | null }>(
      `select locked_by, locked_at from jobs where id = $1`, [id],
    );
    expect(row.rows[0]?.locked_by).toBe('worker-A');
    expect(row.rows[0]?.locked_at).not.toBeNull();
  });

  it('never hands the same job to two concurrent workers', async () => {
    const ids = new Set<string>();
    for (let i = 0; i < 6; i++) ids.add((await enqueue({ type: 'sync_stats', dedupeKey: `c-${i}` })).id);

    const claimed = await Promise.all(
      Array.from({ length: 10 }, (_, i) => claimNext(`worker-${i}`)),
    );
    const got = claimed.filter((j) => j !== null).map((j) => j.id);

    expect(got).toHaveLength(6);
    expect(new Set(got).size).toBe(6);
    for (const id of got) expect(ids.has(id)).toBe(true);
    expect(claimed.filter((j) => j === null)).toHaveLength(4);
  });

  it('skips jobs whose run_after is in the future', async () => {
    await enqueue({ type: 'sync_stats', delayMs: 120_000 });
    const { id } = await enqueue({ type: 'sync_replies' });
    expect((await claimNext('w'))?.id).toBe(id);
    expect(await claimNext('w')).toBeNull();
  });
});

// ---------------------------------------------------------------- fail / backoff

describe('failJob', () => {
  it('computes the documented schedule', () => {
    expect([1, 2, 3, 4, 5].map(backoffSeconds)).toEqual([30, 60, 120, 240, 480]);
    expect(backoffSeconds(8)).toBe(3600);
    expect(backoffSeconds(20)).toBe(3600);
  });

  it('backs off 30s, 60s, 120s and then dies after max_attempts', async () => {
    const { id } = await enqueue({ type: 'launch_campaign', accountId: account, dedupeKey: 'L1', maxAttempts: 3 });

    for (const expected of [30, 60]) {
      const job = await claimNext('w');
      expect(job?.id).toBe(id);
      const out = await failJob(id, new Error(`boom ${expected}`));
      expect(out?.status).toBe('pending');
      expect(out?.backoffSeconds).toBe(expected);
      const secs = await secondsUntilRun(id);
      expect(secs).toBeGreaterThan(expected - 3);
      expect(secs).toBeLessThanOrEqual(expected + 1);
      const row = await getJob(id);
      expect(row?.status).toBe('pending');
      expect(row?.last_error).toContain(`boom ${expected}`);
      await makeDueNow(id);
    }

    const third = await claimNext('w');
    expect(third?.attempts).toBe(3);
    const out = await failJob(id, 'final failure');
    expect(out).toEqual({ status: 'dead', attempts: 3, backoffSeconds: 0 });

    const dead = await getJob(id);
    expect(dead?.status).toBe('dead');
    expect(dead?.last_error).toBe('final failure');

    const events = await db.query<{ type: string; subject: string; account_id: string; detail: Record<string, unknown> }>(
      `select type, subject, account_id, detail from events where type = 'job_dead'`,
    );
    expect(events.rows).toHaveLength(1);
    expect(events.rows[0]?.subject).toBe(id);
    expect(events.rows[0]?.account_id).toBe(account);
    expect(events.rows[0]?.detail).toMatchObject({ job_type: 'launch_campaign', attempts: 3 });

    // Dead is terminal, so the key is free again.
    expect((await enqueue({ type: 'launch_campaign', dedupeKey: 'L1' })).deduped).toBe(false);
  });

  it('caps the backoff at one hour', async () => {
    const { id } = await enqueue({ type: 'sync_stats', maxAttempts: 50 });
    await db.query(`update jobs set attempts = 11 where id = $1`, [id]);
    await claimNext('w'); // attempts -> 12
    const out = await failJob(id, 'slow');
    expect(out?.backoffSeconds).toBe(3600);
    const secs = await secondsUntilRun(id);
    expect(secs).toBeGreaterThan(3595);
    expect(secs).toBeLessThanOrEqual(3601);
  });

  it('is a no-op for a job that is not running', async () => {
    const { id } = await enqueue({ type: 'sync_stats' });
    expect(await failJob(id, 'x')).toBeNull();
    expect((await getJob(id))?.status).toBe('pending');
  });
});

// ---------------------------------------------------------------- reap

describe('reapStale', () => {
  it('returns a job stuck in running to pending and frees its dedupe key', async () => {
    const { id } = await enqueue({ type: 'build_campaign', dedupeKey: 'B1' });
    await claimNext('crashed-worker');
    await db.query(`update jobs set locked_at = now() - interval '20 minutes' where id = $1`, [id]);

    expect(await reapStale(15)).toEqual({ requeued: 1, dead: 0 });

    const job = await getJob(id);
    expect(job?.status).toBe('pending');
    expect(job?.last_error).toContain('crashed-worker');
    const row = await db.query<{ locked_by: string | null }>(`select locked_by from jobs where id = $1`, [id]);
    expect(row.rows[0]?.locked_by).toBeNull();
    expect((await claimNext('w2'))?.id).toBe(id);
  });

  it('leaves recently claimed jobs alone', async () => {
    await enqueue({ type: 'sync_stats' });
    await claimNext('w');
    expect(await reapStale(15)).toEqual({ requeued: 0, dead: 0 });
    expect((await jobStats()).running).toBe(1);
  });

  it('kills a stale job that has already used every attempt', async () => {
    const { id } = await enqueue({ type: 'sync_stats', accountId: account, maxAttempts: 1 });
    await claimNext('w');
    await db.query(`update jobs set locked_at = now() - interval '1 hour' where id = $1`, [id]);
    expect(await reapStale(15)).toEqual({ requeued: 0, dead: 1 });
    expect((await getJob(id))?.status).toBe('dead');
    const events = await db.query(`select 1 from events where type = 'job_dead' and subject = $1`, [id]);
    expect(events.rows).toHaveLength(1);
  });
});

// ---------------------------------------------------------------- stats

describe('jobStats', () => {
  it('returns numbers for every status', async () => {
    await enqueue({ type: 'sync_stats' });
    await enqueue({ type: 'sync_replies' });
    await claimNext('w');
    const stats = await jobStats();
    expect(stats).toEqual({ pending: 1, running: 1, succeeded: 0, failed: 0, dead: 0, total: 2 });
    expect(typeof stats.pending).toBe('number');
  });
});

// ---------------------------------------------------------------- runner

describe('runner', () => {
  it('survives a handler that throws and still processes the remaining jobs', async () => {
    const seen: string[] = [];
    registerHandler('sync_stats', async () => { throw new Error('provider exploded'); });
    registerHandler('sync_replies', async (job) => { seen.push(job.id); return { ok: true, detail: { n: 1 } }; });

    const bad = await enqueue({ type: 'sync_stats', dedupeKey: 'bad' });
    const good1 = await enqueue({ type: 'sync_replies', dedupeKey: 'g1' });
    const good2 = await enqueue({ type: 'sync_replies', dedupeKey: 'g2' });

    const out = await runOnce('w', { log: quiet });
    expect(out.ran).toBe(3);
    expect(out.results.map((r) => r.ok)).toEqual([false, true, true]);
    expect(out.results[0]?.error).toContain('provider exploded');
    expect(seen).toEqual([good1.id, good2.id]);

    const failed = await getJob(bad.id);
    expect(failed?.status).toBe('pending');
    expect(failed?.attempts).toBe(1);
    expect(failed?.last_error).toContain('provider exploded');
    expect((await getJob(good1.id))?.status).toBe('succeeded');
    expect((await getJob(good1.id))?.result).toEqual({ ok: true, detail: { n: 1 } });
  });

  it('enqueues the follow-up jobs a handler returns in next, inheriting account_id', async () => {
    registerHandler('generate_strategy', async () => ({
      ok: true,
      next: [
        { type: 'source_leads', payload: { campaign_id: 'c1' }, dedupe_key: 'c1' },
        { type: 'source_leads', payload: { campaign_id: 'c1' }, dedupe_key: 'c1' },
        { type: 'generate_copy', payload: { campaign_id: 'c1' }, delay_ms: 30_000 },
      ],
    }));
    const { id } = await enqueue({ type: 'generate_strategy', accountId: account });

    // limit 1: otherwise the loop would also claim the now-due source_leads job.
    const out = await runOnce('w', { limit: 1, log: quiet });
    expect(out.ran).toBe(1);
    expect((await getJob(id))?.status).toBe('succeeded');

    const rows = await db.query<{ type: string; account_id: string; payload: Record<string, unknown>; status: string }>(
      `select type, account_id, payload, status from jobs where id <> $1 order by type`, [id],
    );
    expect(rows.rows.map((r) => r.type)).toEqual(['generate_copy', 'source_leads']);
    for (const r of rows.rows) {
      expect(r.account_id).toBe(account);
      expect(r.status).toBe('pending');
      expect(r.payload).toEqual({ campaign_id: 'c1' });
    }
    const copyId = (await db.query<{ id: string }>(`select id from jobs where type = 'generate_copy'`)).rows[0]!.id;
    expect(await secondsUntilRun(copyId)).toBeGreaterThan(25);
  });

  it('marks ok:false results as failed (terminal, no retry)', async () => {
    registerHandler('classify_replies', async () => ({ ok: false, detail: { reason: 'nothing to classify' } }));
    const { id } = await enqueue({ type: 'classify_replies', dedupeKey: 'k' });
    const out = await runOnce('w', { log: quiet });
    expect(out.results[0]?.ok).toBe(false);
    const job = await getJob(id);
    expect(job?.status).toBe('failed');
    expect(await claimNext('w')).toBeNull();
  });

  it('fails a job whose type has no handler instead of skipping it', async () => {
    const { id } = await enqueue({ type: 'trial_ending_notice', maxAttempts: 1 });
    const out = await runOnce('w', { log: quiet });
    expect(out.ran).toBe(1);
    expect(out.results[0]?.error).toContain('no handler registered');
    expect((await getJob(id))?.status).toBe('dead');
    const events = await db.query(`select 1 from events where type = 'job_dead' and subject = $1`, [id]);
    expect(events.rows).toHaveLength(1);
  });

  it('respects the per-call limit', async () => {
    registerHandler('sync_stats', async () => ({ ok: true }));
    for (let i = 0; i < 5; i++) await enqueue({ type: 'sync_stats' });
    expect((await runOnce('w', { limit: 2, log: quiet })).ran).toBe(2);
    expect((await runOnce('w', { limit: 10, log: quiet })).ran).toBe(3);
    expect((await runOnce('w', { log: quiet })).ran).toBe(0);
  });

  it('runForever drains the queue and stops cleanly on abort', async () => {
    let runs = 0;
    registerHandler('sync_stats', async () => { runs++; return { ok: true }; });
    for (let i = 0; i < 3; i++) await enqueue({ type: 'sync_stats' });

    const controller = new AbortController();
    const loop = runForever({ intervalMs: 10, signal: controller.signal, workerId: 'loop', log: quiet, reapEveryMs: 0 });
    await new Promise((r) => setTimeout(r, 300));
    controller.abort();
    await expect(loop).resolves.toBeUndefined();
    expect(runs).toBe(3);
    expect((await jobStats()).succeeded).toBe(3);
  });

  it('logs one structured line per job', async () => {
    const lines: Record<string, unknown>[] = [];
    registerHandler('sync_stats', async () => ({ ok: true }));
    await enqueue({ type: 'sync_stats' });
    await runOnce('w9', { log: (l) => lines.push(l) });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ scope: 'job', worker: 'w9', type: 'sync_stats', ok: true, attempt: 1 });
    expect(typeof lines[0]?.ms).toBe('number');
  });
});

// ---------------------------------------------------------------- registry coverage

describe('registry', () => {
  // The suite-level beforeEach clears the registry; put the real handlers back so
  // this check sees what the worker sees.
  beforeEach(() => registerAllHandlers());

  it('every JobType in the contract has a handler or is explicitly not-yet-implemented', () => {
    const problems: string[] = [];
    for (const t of JOB_TYPES) {
      const handled = hasHandlerFor(t);
      const listed = NOT_YET_IMPLEMENTED.has(t);
      if (!handled && !listed) problems.push(`${t}: no handler and not listed in NOT_YET_IMPLEMENTED`);
      if (handled && listed) problems.push(`${t}: has a handler but is still listed in NOT_YET_IMPLEMENTED`);
    }
    expect(problems).toEqual([]);
    expect(unexpectedMissingHandlers()).toEqual([]);
  });

  it('JOB_TYPES is the whole union, with no duplicates', () => {
    const unique = new Set<JobType>(JOB_TYPES);
    expect(unique.size).toBe(JOB_TYPES.length);
    expect(JOB_TYPES.length).toBe(16);
  });

  it('missingHandlers shrinks as handlers register', () => {
    clearHandlers();
    const before = missingHandlers();
    expect(before).toContain('scrape_site');
    registerHandler('scrape_site', async () => ({ ok: true }));
    expect(missingHandlers()).not.toContain('scrape_site');
    expect(missingHandlers()).toHaveLength(before.length - 1);
    // Every other type is now missing and not excused: exactly what the worker warns about.
    expect(unexpectedMissingHandlers()).toEqual(JOB_TYPES.filter((t) => t !== 'scrape_site'));
  });
});

// ---------------------------------------------------------------- tick route

describe('POST /api/jobs/tick', () => {
  it('rejects a missing or wrong secret and never runs anything', async () => {
    const { POST } = await import('../../src/app/api/jobs/tick/route');
    registerHandler('sync_stats', async () => ({ ok: true }));
    await enqueue({ type: 'sync_stats' });

    const none = await POST(new Request('http://x/api/jobs/tick', { method: 'POST' }));
    expect(none.status).toBe(401);
    const wrong = await POST(new Request('http://x/api/jobs/tick', { method: 'POST', headers: { 'x-cron-secret': 'nope' } }));
    expect(wrong.status).toBe(401);
    const longer = await POST(new Request('http://x/api/jobs/tick', { method: 'POST', headers: { 'x-cron-secret': 'dev-only-change-me-but-longer' } }));
    expect(longer.status).toBe(401);
    expect((await jobStats()).pending).toBe(1);
  });

  it('reaps then runs with the right secret, via either header', async () => {
    const { POST } = await import('../../src/app/api/jobs/tick/route');
    registerHandler('sync_stats', async () => ({ ok: true }));
    await enqueue({ type: 'sync_stats', dedupeKey: 't1' });
    await enqueue({ type: 'sync_stats', dedupeKey: 't2' });

    const res = await POST(new Request('http://x/api/jobs/tick', { method: 'POST', headers: { 'x-cron-secret': 'dev-only-change-me' } }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; data: { ran: number; reaped: { requeued: number; dead: number } } };
    expect(body.ok).toBe(true);
    expect(body.data.ran).toBe(2);
    expect(body.data.reaped).toEqual({ requeued: 0, dead: 0 });

    const bearer = await POST(new Request('http://x/api/jobs/tick', { method: 'POST', headers: { authorization: 'Bearer dev-only-change-me' } }));
    expect(bearer.status).toBe(200);
  });
});

describe('GET /api/health', () => {
  it('returns only liveness to an unauthenticated caller', async () => {
    const { GET } = await import('../../src/app/api/health/route');
    const res = await GET(new Request('http://localhost/api/health'));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; data: Record<string, unknown> };
    expect(body.data).toEqual({ status: 'ok' });
    // Provider modes are reconnaissance: a reader learning that billing is mock knows
    // the free-credit route is reachable.
    expect(Object.keys(body.data)).not.toContain('providers');
  });

  it('reports backend, migrations, job stats and provider modes without secrets', async () => {
    const { GET } = await import('../../src/app/api/health/route');
    await enqueue({ type: 'sync_stats' });
    // Operational detail is now behind the operator secret; see the route header.
    const res = await GET(
      new Request('http://localhost/api/health', { headers: { 'x-cron-secret': 'dev-only-change-me' } }),
    );
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain('dev-only-change-me');
    const body = JSON.parse(text) as { ok: boolean; data: Record<string, unknown> };
    expect(body.ok).toBe(true);
    expect(body.data.db).toBe('pglite');
    expect(body.data.migrations).toBeGreaterThanOrEqual(1);
    expect(body.data.jobs).toMatchObject({ pending: 1 });
    expect(body.data.providers).toMatchObject({ default: 'mock', sending: 'mock' });
  });
});

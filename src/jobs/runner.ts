/**
 * Worker loop. Claims jobs, runs their handlers, records the outcome.
 *
 * The one rule: a handler must never be able to take the loop down. Every handler
 * call is wrapped; a throw becomes `failJob` (retry with backoff), and the loop moves
 * on to the next job.
 */

import { getDb, type Db } from '../lib/db';
import { getProviders } from '../providers';
import type { Job, JobResult, Providers } from '../lib/contracts';
import { claimNext, complete, enqueue, errorMessage, failJob, reapStale } from './queue';
import { getHandler, type JobDeps } from './registry';

export interface RunOutcome {
  type: string;
  id: string;
  ok: boolean;
  ms: number;
  error?: string;
}

export interface RunOnceResult {
  ran: number;
  results: RunOutcome[];
}

export type JobLogger = (line: Record<string, unknown>) => void;

export interface RunOnceOptions {
  limit?: number;
  db?: Db;
  providers?: () => Promise<Providers>;
  log?: JobLogger;
}

const defaultLog: JobLogger = (line) => {
  console.log(JSON.stringify({ at: new Date().toISOString(), ...line }));
};

let cachedProviders: Promise<Providers> | null = null;
function lazyProviders(): Promise<Providers> {
  cachedProviders ??= getProviders();
  return cachedProviders;
}

export async function runOnce(workerId: string, opts: RunOnceOptions = {}): Promise<RunOnceResult> {
  const db = opts.db ?? (await getDb());
  const limit = Math.max(1, opts.limit ?? 10);
  const log = opts.log ?? defaultLog;
  const deps: JobDeps = { db, providers: opts.providers ?? lazyProviders };

  const results: RunOutcome[] = [];
  for (let i = 0; i < limit; i++) {
    const job = await claimNext(workerId, db);
    if (!job) break;
    const outcome = await runJob(job, deps, workerId);
    log({ scope: 'job', worker: workerId, ...outcome, attempt: job.attempts });
    results.push(outcome);
  }
  return { ran: results.length, results };
}

async function runJob(job: Job, deps: JobDeps, workerId: string): Promise<RunOutcome> {
  const started = Date.now();
  const base = { type: job.type, id: job.id };

  const handler = getHandler(job.type);
  if (!handler) {
    // Loud, not silent: the job retries and eventually dies with an events row.
    const error = `no handler registered for job type "${job.type}" (worker ${workerId})`;
    await failJob(job.id, error, deps.db);
    return { ...base, ok: false, ms: Date.now() - started, error };
  }

  let result: JobResult;
  try {
    result = await handler(job, deps);
  } catch (err) {
    const error = errorMessage(err);
    await failJob(job.id, err, deps.db).catch((inner: unknown) => {
      // Even the bookkeeping failed. The reaper will pick the row up later.
      defaultLog({ scope: 'job', level: 'error', ...base, msg: 'failJob threw', error: errorMessage(inner) });
    });
    return { ...base, ok: false, ms: Date.now() - started, error: error.split('\n')[0] ?? error };
  }

  try {
    await deps.db.tx(async (t) => {
      await complete(job.id, result, t);
      for (const n of result.next ?? []) {
        // Follow-ups inherit the tenant unless the payload says otherwise (I2).
        const accountId =
          typeof n.payload?.account_id === 'string' ? n.payload.account_id : job.account_id;
        await enqueue(
          { type: n.type, payload: n.payload, dedupeKey: n.dedupe_key, delayMs: n.delay_ms, accountId },
          t,
        );
      }
    });
  } catch (err) {
    // The handler succeeded but we could not record it. Treat as a failed attempt so
    // the job is retried; the handler's idempotency contract makes that safe.
    await failJob(job.id, err, deps.db).catch(() => {});
    return { ...base, ok: false, ms: Date.now() - started, error: errorMessage(err).split('\n')[0] };
  }

  return { ...base, ok: result.ok, ms: Date.now() - started };
}

export interface RunForeverOptions extends RunOnceOptions {
  intervalMs: number;
  signal: AbortSignal;
  workerId?: string;
  /** How often to run the stale-job reaper. */
  reapEveryMs?: number;
  staleMinutes?: number;
}

/** Polls until the signal aborts. Drains the queue without sleeping while there is work. */
export async function runForever(opts: RunForeverOptions): Promise<void> {
  const workerId = opts.workerId ?? `worker-${process.pid}`;
  const log = opts.log ?? defaultLog;
  const reapEveryMs = opts.reapEveryMs ?? 60_000;
  let lastReap = 0;

  log({ scope: 'worker', worker: workerId, msg: 'started', intervalMs: opts.intervalMs });

  while (!opts.signal.aborted) {
    try {
      if (Date.now() - lastReap >= reapEveryMs) {
        lastReap = Date.now();
        const reaped = await reapStale(opts.staleMinutes, opts.db);
        if (reaped.requeued || reaped.dead) log({ scope: 'reaper', worker: workerId, ...reaped });
      }
      const { ran } = await runOnce(workerId, opts);
      if (ran > 0) continue;
    } catch (err) {
      // Database hiccup. Back off for one interval and try again.
      log({ scope: 'worker', level: 'error', worker: workerId, error: errorMessage(err).split('\n')[0] });
    }
    await sleep(opts.intervalMs, opts.signal);
  }

  log({ scope: 'worker', worker: workerId, msg: 'stopped' });
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    }
    signal.addEventListener('abort', done, { once: true });
  });
}

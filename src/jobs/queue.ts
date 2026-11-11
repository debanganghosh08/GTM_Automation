/**
 * Job queue over the `jobs` table.
 *
 * Idempotency (SPEC §4 I5) is enforced by the partial unique index
 * `jobs_dedupe_key (type, dedupe_key) where status in ('pending','running')`:
 * an identical job can exist at most once while it is live. Once a job reaches a
 * terminal state (succeeded / failed / dead) the key is free again.
 *
 * Every function takes an optional `Db` so the runner can pass a transaction-scoped
 * handle (completing a job and enqueueing its successors must be atomic).
 */

import { getDb, type Db } from '../lib/db';
import type { Job, JobResult, JobStatus, JobType } from '../lib/contracts';

const BACKOFF_BASE_SECONDS = 30;
const BACKOFF_CAP_SECONDS = 3600;
const PG_UNIQUE_VIOLATION = '23505';

export interface EnqueueInput {
  type: JobType;
  payload?: Record<string, unknown>;
  accountId?: string | null;
  dedupeKey?: string | null;
  delayMs?: number;
  maxAttempts?: number;
}

export interface EnqueueResult {
  id: string;
  deduped: boolean;
}

export type JobStats = Record<JobStatus, number> & { total: number };

/** Raw row shape as both pg and PGlite return it. Timestamps arrive as Date objects. */
interface JobRow {
  id: string;
  account_id: string | null;
  type: string;
  payload: Record<string, unknown> | null;
  status: JobStatus;
  dedupe_key: string | null;
  attempts: number;
  max_attempts: number;
  run_after: Date | string;
  last_error: string | null;
  result: Record<string, unknown> | null;
}

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

export function rowToJob(row: JobRow): Job {
  return {
    id: row.id,
    account_id: row.account_id,
    type: row.type as JobType,
    payload: row.payload ?? {},
    status: row.status,
    dedupe_key: row.dedupe_key,
    attempts: Number(row.attempts),
    max_attempts: Number(row.max_attempts),
    run_after: toIso(row.run_after),
    last_error: row.last_error,
    result: row.result,
  };
}

const JOB_COLUMNS =
  'id, account_id, type, payload, status, dedupe_key, attempts, max_attempts, run_after, last_error, result';

function isUniqueViolation(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const code = (err as { code?: unknown }).code;
  if (code === PG_UNIQUE_VIOLATION) return true;
  // Belt and braces: some drivers wrap the server error and drop `code`.
  const message = (err as { message?: unknown }).message;
  return typeof message === 'string' && message.includes('jobs_dedupe_key');
}

export async function enqueue(input: EnqueueInput, db?: Db, retry = true): Promise<EnqueueResult> {
  const conn = db ?? (await getDb());
  const delayMs = Math.max(0, Math.floor(input.delayMs ?? 0));
  const params = [
    input.accountId ?? null,
    input.type,
    JSON.stringify(input.payload ?? {}),
    input.dedupeKey ?? null,
    delayMs,
    input.maxAttempts ?? 5,
  ];

  // ON CONFLICT targets the partial index directly (the WHERE must repeat its
  // predicate). This matters inside a transaction: a raised 23505 would abort the
  // whole transaction, and a handler's `next` list is enqueued in the same
  // transaction that completes it. The catch below only covers drivers or races
  // where the conflict surfaces as an error anyway.
  try {
    const res = await conn.query<{ id: string }>(
      `insert into jobs (account_id, type, payload, dedupe_key, run_after, max_attempts)
       values ($1, $2, $3::jsonb, $4, now() + ($5::int * interval '1 millisecond'), $6::int)
       on conflict (type, dedupe_key) where dedupe_key is not null and status in ('pending','running')
       do nothing
       returning id`,
      params,
    );
    const row = res.rows[0];
    if (row) return { id: row.id, deduped: false };
    if (!input.dedupeKey) throw new Error('enqueue: insert returned no row');
  } catch (err) {
    if (!isUniqueViolation(err) || !input.dedupeKey) throw err;
  }

  const existing = await conn.query<{ id: string }>(
    `select id from jobs
     where type = $1 and dedupe_key = $2 and status in ('pending', 'running')
     limit 1`,
    [input.type, input.dedupeKey],
  );
  const row = existing.rows[0];
  // The live twin finished between our insert and this select. One retry is
  // enough: either the insert lands or the select finds a new twin.
  if (!row) {
    if (!retry) throw new Error(`enqueue: could not insert or find ${input.type}/${input.dedupeKey}`);
    return enqueue(input, conn, false);
  }
  return { id: row.id, deduped: true };
}

/**
 * Claims one due pending job. The CTE locks the candidate row with SKIP LOCKED, so
 * two workers running this statement concurrently can never both get the same row.
 */
export async function claimNext(workerId: string, db?: Db): Promise<Job | null> {
  const conn = db ?? (await getDb());
  const res = await conn.query<JobRow>(
    `with next as (
       select id from jobs
       where status = 'pending' and run_after <= now()
       order by run_after asc, created_at asc
       limit 1
       for update skip locked
     )
     update jobs j
     set status = 'running',
         locked_at = now(),
         locked_by = $1,
         attempts = j.attempts + 1,
         updated_at = now()
     from next
     where j.id = next.id
     returning ${JOB_COLUMNS.split(', ').map((c) => `j.${c}`).join(', ')}`,
    [workerId],
  );
  const row = res.rows[0];
  return row ? rowToJob(row) : null;
}

/**
 * Terminal success (`ok: true`) or terminal non-retryable failure (`ok: false`).
 * A handler that wants a retry throws instead; see failJob.
 */
export async function complete(jobId: string, result: JobResult, db?: Db): Promise<void> {
  const conn = db ?? (await getDb());
  const status: JobStatus = result.ok ? 'succeeded' : 'failed';
  await conn.query(
    `update jobs
     set status = $2::job_status,
         result = $3::jsonb,
         locked_at = null,
         locked_by = null,
         updated_at = now()
     where id = $1 and status = 'running'`,
    [jobId, status, JSON.stringify({ ok: result.ok, detail: result.detail ?? null })],
  );
}

export interface FailOutcome {
  status: 'pending' | 'dead';
  attempts: number;
  /** Seconds until the next attempt; 0 when dead. */
  backoffSeconds: number;
}

export function backoffSeconds(attempts: number): number {
  const exp = Math.max(0, attempts - 1);
  return Math.min(BACKOFF_BASE_SECONDS * 2 ** exp, BACKOFF_CAP_SECONDS);
}

/**
 * Records a failed attempt. attempts was already incremented on claim, so the
 * schedule is 30s, 60s, 120s... after attempts 1, 2, 3... capped at one hour.
 * Exhausted jobs go `dead` and leave an `events` row so a human sees them.
 */
export async function failJob(jobId: string, error: unknown, db?: Db): Promise<FailOutcome | null> {
  const conn = db ?? (await getDb());
  const message = errorMessage(error);

  return conn.tx(async (t) => {
    const res = await t.query<{
      status: 'pending' | 'dead';
      attempts: number;
      account_id: string | null;
      type: string;
    }>(
      `update jobs
       set status = (case when attempts >= max_attempts then 'dead' else 'pending' end)::job_status,
           run_after = case
             when attempts >= max_attempts then run_after
             else now() + (least(${BACKOFF_BASE_SECONDS} * power(2, attempts - 1), ${BACKOFF_CAP_SECONDS}) * interval '1 second')
           end,
           last_error = $2,
           locked_at = null,
           locked_by = null,
           updated_at = now()
       where id = $1 and status = 'running'
       returning status, attempts, account_id, type`,
      [jobId, message],
    );
    const row = res.rows[0];
    if (!row) return null;

    const attempts = Number(row.attempts);
    if (row.status === 'dead') {
      await t.query(
        `insert into events (account_id, actor, type, subject, detail)
         values ($1, 'worker', 'job_dead', $2, $3::jsonb)`,
        [row.account_id, jobId, JSON.stringify({ job_type: row.type, attempts, error: message })],
      );
      return { status: 'dead', attempts, backoffSeconds: 0 };
    }
    return { status: 'pending', attempts, backoffSeconds: backoffSeconds(attempts) };
  });
}

export interface ReapOutcome {
  requeued: number;
  dead: number;
}

/**
 * A worker that dies mid-job leaves the row `running` forever, and with it the
 * dedupe key, so nothing can ever enqueue that work again. This puts such rows back
 * to `pending`. A stuck job that has already burned every attempt goes `dead`
 * instead, otherwise a handler that crashes the process would be reaped and
 * reclaimed in a loop.
 */
export async function reapStale(olderThanMinutes = 15, db?: Db): Promise<ReapOutcome> {
  const conn = db ?? (await getDb());
  return conn.tx(async (t) => {
    const res = await t.query<{ id: string; status: 'pending' | 'dead'; account_id: string | null; type: string; attempts: number }>(
      `update jobs
       set status = (case when attempts >= max_attempts then 'dead' else 'pending' end)::job_status,
           last_error = coalesce(last_error, '') || ' [reaped: worker ' || coalesce(locked_by, '?') || ' stale]',
           locked_at = null,
           locked_by = null,
           updated_at = now()
       where status = 'running' and locked_at < now() - ($1::int * interval '1 minute')
       returning id, status, account_id, type, attempts`,
      [olderThanMinutes],
    );
    let requeued = 0;
    let dead = 0;
    for (const row of res.rows) {
      if (row.status === 'dead') {
        dead++;
        await t.query(
          `insert into events (account_id, actor, type, subject, detail)
           values ($1, 'reaper', 'job_dead', $2, $3::jsonb)`,
          [row.account_id, row.id, JSON.stringify({ job_type: row.type, attempts: Number(row.attempts), error: 'stale after exhausting attempts' })],
        );
      } else {
        requeued++;
      }
    }
    return { requeued, dead };
  });
}

export async function jobStats(db?: Db): Promise<JobStats> {
  const conn = db ?? (await getDb());
  const res = await conn.query<{ status: JobStatus; n: string | number }>(
    `select status, count(*) as n from jobs group by status`,
  );
  const stats: JobStats = { pending: 0, running: 0, succeeded: 0, failed: 0, dead: 0, total: 0 };
  for (const row of res.rows) {
    const n = Number(row.n);
    stats[row.status] = n;
    stats.total += n;
  }
  return stats;
}

export async function getJob(jobId: string, db?: Db): Promise<Job | null> {
  const conn = db ?? (await getDb());
  const res = await conn.query<JobRow>(`select ${JOB_COLUMNS} from jobs where id = $1`, [jobId]);
  const row = res.rows[0];
  return row ? rowToJob(row) : null;
}

export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.stack ? `${err.message}\n${err.stack}`.slice(0, 4000) : err.message;
  return String(err).slice(0, 4000);
}

/**
 * Handler registry: JobType -> handler.
 *
 * THE IDEMPOTENCY CONTRACT (SPEC §4 I5)
 * -------------------------------------
 * A handler can run more than once for the same job. This happens whenever a worker
 * crashes after acting but before `complete()` lands, when a stale `running` row is
 * reaped and reclaimed, or when a handler throws part-way through. The queue
 * guarantees a job is *claimed* by one worker at a time; it cannot guarantee a
 * handler's side effects happened exactly once. So every handler must be written so
 * that a re-run after any partial execution does not double-act:
 *
 *   - Money: write to credit_ledger / cost_ledger with a deterministic
 *     idempotency_key derived from the job's inputs, never from a timestamp.
 *   - External calls: check for an existing provider_ref before creating, and
 *     store the ref as soon as the vendor returns it.
 *   - Rows: insert with `on conflict do nothing` on the natural key.
 *   - Follow-up jobs: return them in `next` with a `dedupe_key`; the runner enqueues
 *     them in the same transaction that marks this job done, and the dedupe index
 *     collapses duplicates.
 *
 * A handler that cannot make progress should throw (the queue retries with backoff).
 * A handler that has decided the job can never succeed returns `{ ok: false }`
 * (terminal, no retry).
 *
 * REGISTRATION
 * ------------
 * Other modules call `registerHandler` from their own files. Whoever boots a worker
 * (scripts/worker.ts, the tick route) must import those modules so registration
 * runs. `NOT_YET_IMPLEMENTED` is the explicit list of job types that have no handler
 * on purpose; the test in tests/unit/jobs.test.ts fails if any JobType is in neither
 * place or in both. That test exists because a scheduler that silently skips a job
 * type is indistinguishable from one that works, until a customer notices.
 */

import type { Job, JobResult, JobType, Providers } from '../lib/contracts';
import type { Db } from '../lib/db';

export interface JobDeps {
  db: Db;
  /**
   * Lazy on purpose: resolving providers may import vendor SDKs, and a handler that
   * needs none of them (or a test) should not pay for that.
   */
  providers: () => Promise<Providers>;
}

export type JobHandler = (job: Job, deps: JobDeps) => Promise<JobResult>;

/** Runtime list of the JobType union; the type assertion below keeps it in sync. */
export const JOB_TYPES = [
  'scrape_site',
  'generate_strategy',
  'provision_domain',
  'verify_dns',
  'provision_mailboxes',
  'warmup_monitor',
  'source_leads',
  'verify_leads',
  'generate_copy',
  'build_campaign',
  'launch_campaign',
  'sync_stats',
  'sync_replies',
  'classify_replies',
  'enforce_guardrails',
  'trial_ending_notice',
] as const satisfies readonly JobType[];

type MissingFromList = Exclude<JobType, (typeof JOB_TYPES)[number]>;
// Compile error here means the contract gained a JobType that JOB_TYPES does not list.
const _jobTypesComplete: [MissingFromList] extends [never] ? true : never = true;
void _jobTypesComplete;

/**
 * Job types that deliberately have no handler yet. Remove a type from here in the
 * same commit that registers its handler.
 */
export const NOT_YET_IMPLEMENTED: ReadonlySet<JobType> = new Set<JobType>([]);

const handlers = new Map<JobType, JobHandler>();

export function registerHandler(type: JobType, fn: JobHandler): void {
  handlers.set(type, fn);
}

export function getHandler(type: JobType): JobHandler | undefined {
  return handlers.get(type);
}

export function hasHandlerFor(type: JobType): boolean {
  return handlers.has(type);
}

/** JobType values with no handler, whether or not they are listed as not-yet-implemented. */
export function missingHandlers(): JobType[] {
  return JOB_TYPES.filter((t) => !handlers.has(t));
}

/** Missing handlers that are NOT on the explicit list: these are bugs. */
export function unexpectedMissingHandlers(): JobType[] {
  return missingHandlers().filter((t) => !NOT_YET_IMPLEMENTED.has(t));
}

export function registeredTypes(): JobType[] {
  return [...handlers.keys()];
}

/** Tests only: start from an empty registry. */
export function clearHandlers(): void {
  handlers.clear();
}

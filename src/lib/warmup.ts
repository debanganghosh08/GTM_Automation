/**
 * Warm-up maths. Pure: no I/O, no clock. Every function takes `now` so a test can
 * pin it; nothing in here calls Date.now().
 *
 * Model (matches lib/guardrails.ts so the two can never disagree):
 *  - "days elapsed" is whole days since `startedAt`, never negative.
 *  - the ramp runs on a 1-based day index: elapsed 0 is day 1, elapsed N-1 is day N.
 *  - warm-up is `complete` only when elapsed >= days. A null start is "not started".
 *  - days = 0 means no warm-up is required at all, which counts as complete.
 */

import type { IsoTimestamp, WarmupProgress } from './contracts';

const MS_PER_DAY = 86_400_000;

export interface WarmupWindow {
  /** When warm-up began. `null` means it has not started. */
  startedAt: IsoTimestamp | Date | null;
  /** Length of the warm-up in whole days. */
  days: number;
  /** The clock. Injected so the maths is deterministic. */
  now: Date;
}

function toDate(value: IsoTimestamp | Date | null): Date | null {
  if (value === null) return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

function wholeDays(days: number): number {
  return Number.isFinite(days) ? Math.max(0, Math.floor(days)) : 0;
}

/** Whole days between start and now, clamped at 0 (a future start has elapsed nothing). */
function elapsedDays(started: Date, now: Date): number {
  return Math.max(0, Math.floor((now.getTime() - started.getTime()) / MS_PER_DAY));
}

/**
 * Progress for the UI bar. `percent` is floor(elapsed / days * 100), capped at 100.
 * `ready_at` is start + days, the date the honest copy names.
 */
export function warmupProgress(window: WarmupWindow): WarmupProgress {
  const daysTotal = wholeDays(window.days);
  const started = toDate(window.startedAt);

  if (started === null) {
    return {
      started_at: null,
      days_total: daysTotal,
      days_elapsed: 0,
      percent: daysTotal === 0 ? 100 : 0,
      ready_at: null,
      complete: daysTotal === 0,
    };
  }

  const elapsed = elapsedDays(started, window.now);
  const complete = elapsed >= daysTotal;
  const daysElapsed = Math.min(elapsed, daysTotal);
  const percent = daysTotal === 0 ? 100 : Math.floor((daysElapsed * 100) / daysTotal);

  return {
    started_at: started.toISOString(),
    days_total: daysTotal,
    days_elapsed: daysElapsed,
    percent,
    ready_at: new Date(started.getTime() + daysTotal * MS_PER_DAY).toISOString(),
    complete,
  };
}

export interface WarmupCapInput extends WarmupWindow {
  /** The cap a fully warmed mailbox is allowed. */
  fullCap: number;
}

/**
 * Linear ramp of the daily send cap.
 *
 *   before start (null, or now < startedAt)  -> 0
 *   day k of N (1 <= k < N)                   -> max(1, floor(fullCap * k / N))
 *   day N and later                           -> fullCap
 *
 * So a cap of 50 over 7 days gives 7, 14, 21, 28, 35, 42, 50. The floor of 1 keeps
 * a tiny cap from silencing a mailbox entirely during warm-up.
 */
export function warmupDailyCap(input: WarmupCapInput): number {
  const fullCap = Number.isFinite(input.fullCap) ? Math.max(0, Math.floor(input.fullCap)) : 0;
  if (fullCap === 0) return 0;

  const daysTotal = wholeDays(input.days);
  if (daysTotal === 0) return fullCap;

  const started = toDate(input.startedAt);
  if (started === null) return 0;
  if (input.now.getTime() < started.getTime()) return 0;

  const elapsed = elapsedDays(started, input.now);
  if (elapsed >= daysTotal) return fullCap;

  const dayIndex = Math.min(elapsed + 1, daysTotal);
  if (dayIndex >= daysTotal) return fullCap;
  return Math.max(1, Math.floor((fullCap * dayIndex) / daysTotal));
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;

/** "30 Oct 2026", in UTC, with no locale or ICU dependence so tests are stable. */
export function formatWarmupDate(iso: IsoTimestamp): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return 'an unknown date';
  const month = MONTHS[d.getUTCMonth()] ?? '';
  return `${d.getUTCDate()} ${month} ${d.getUTCFullYear()}`;
}

/**
 * The sentence the UI shows under the progress bar.
 *
 * The brief's "start sending within an hour" is false for a new domain: a mailbox
 * on a fresh domain that sends cold email on day one burns the domain. So the copy
 * says exactly what IS ready now (strategy and leads) and names the date sending
 * actually begins. It never promises immediate sending.
 */
export function warmupCopy(progress: WarmupProgress): string {
  if (progress.complete) {
    return 'Warm-up is complete. Your mailboxes are ready and your campaign can be launched.';
  }
  if (progress.started_at === null || progress.ready_at === null) {
    return (
      'Your strategy and lead list are ready now. Sending begins only after your ' +
      `mailboxes finish a ${progress.days_total}-day warm-up, which has not started yet.`
    );
  }
  const day = Math.min(progress.days_elapsed + 1, progress.days_total);
  return (
    'Your strategy and lead list are ready now. Your mailboxes are warming up ' +
    `(day ${day} of ${progress.days_total}); sending begins when warm-up completes on ` +
    `${formatWarmupDate(progress.ready_at)}.`
  );
}

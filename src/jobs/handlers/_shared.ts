/**
 * Helpers shared by the job handlers. Nothing here talks to a vendor.
 *
 * Conventions every handler follows:
 *   - `accountIdOf(job)` resolves the tenant; a job with no tenant is terminal.
 *   - every SQL statement carries `account_id` (SPEC §4 I2).
 *   - `terminal(reason)` is the `{ ok: false }` shape for "this job can never
 *     succeed"; throwing is reserved for "try again later".
 *   - never log or return lead emails or copy bodies; counts and ids only.
 */

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { Db } from '../../lib/db';
import type { Job, JobResult, Uuid } from '../../lib/contracts';

// ---------------------------------------------------------------- payload access

export class PayloadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PayloadError';
  }
}

export function payloadString(job: Job, key: string): string | null {
  const v = job.payload[key];
  return typeof v === 'string' && v.trim() !== '' ? v : null;
}

export function payloadInt(job: Job, key: string): number | null {
  const v = job.payload[key];
  if (typeof v === 'number' && Number.isFinite(v)) return Math.floor(v);
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number.parseInt(v, 10);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

export function payloadBool(job: Job, key: string): boolean {
  return job.payload[key] === true;
}

export function requireString(job: Job, key: string): string {
  const v = payloadString(job, key);
  if (!v) throw new PayloadError(`${job.type}: payload.${key} is required`);
  return v;
}

/** The tenant for this job: payload.account_id first, then the job row's account_id. */
export function accountIdOf(job: Job): Uuid | null {
  return payloadString(job, 'account_id') ?? job.account_id;
}

// ---------------------------------------------------------------- results

export function terminal(reason: string, detail: Record<string, unknown> = {}): JobResult {
  return { ok: false, detail: { reason, ...detail } };
}

export function done(detail: Record<string, unknown> = {}, next?: JobResult['next']): JobResult {
  const result: JobResult = { ok: true, detail };
  if (next && next.length > 0) result.next = next;
  return result;
}

// ---------------------------------------------------------------- events

export async function logEvent(
  db: Db,
  accountId: Uuid | null,
  type: string,
  subject: string | null,
  detail: Record<string, unknown>,
  actor = 'worker',
): Promise<void> {
  await db.query(
    `insert into events (account_id, actor, type, subject, detail)
     values ($1, $2, $3, $4, $5::jsonb)`,
    [accountId, actor, type, subject, JSON.stringify(detail)],
  );
}

// ---------------------------------------------------------------- prompts

const PROMPTS_DIR = path.join(process.cwd(), 'prompts');

/**
 * Reads `prompts/<task>/<version>.md` from disk at call time. Not cached on
 * purpose: the file is small, and a long-lived worker should pick up a new
 * version the moment the handler points at it.
 */
export async function readPrompt(task: 'strategy' | 'copy', version: string): Promise<string> {
  const file = path.join(PROMPTS_DIR, task, `${version}.md`);
  try {
    const text = await readFile(file, 'utf8');
    if (!text.trim()) throw new Error('empty file');
    return text;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`prompt ${task}/${version} could not be read from ${file}: ${msg}`);
  }
}

// ---------------------------------------------------------------- misc

/** YYYY-MM-DD in UTC. Matches `current_date` on a UTC-configured database. */
export function isoDay(date: Date = new Date()): string {
  return date.toISOString().slice(0, 10);
}

export function toIso(value: Date | string | null): string | null {
  if (value === null) return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

export function emailDomain(email: string): string {
  const at = email.lastIndexOf('@');
  return at < 0 ? '' : email.slice(at + 1).toLowerCase();
}

export function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

export function errText(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).slice(0, 1000);
}

export const HOUR_MS = 3_600_000;
export const DAY_MS = 86_400_000;

// ---------------------------------------------------------------- suppression (I3)

export interface SuppressionSets {
  emails: Set<string>;
  domains: Set<string>;
  count: number;
}

/** Global (`account_id is null`) plus per-account suppressions, lower-cased. */
export async function loadSuppressions(db: Db, accountId: Uuid): Promise<SuppressionSets> {
  const res = await db.query<{ email: string | null; domain: string | null }>(
    `select email, domain from suppressions where account_id = $1 or account_id is null`,
    [accountId],
  );
  const emails = new Set<string>();
  const domains = new Set<string>();
  for (const row of res.rows) {
    if (row.email) emails.add(row.email.trim().toLowerCase());
    if (row.domain) domains.add(row.domain.trim().toLowerCase().replace(/\.$/, ''));
  }
  return { emails, domains, count: res.rows.length };
}

export function isSuppressed(sets: SuppressionSets, email: string, companyDomain?: string | null): boolean {
  const lower = email.trim().toLowerCase();
  if (sets.emails.has(lower)) return true;
  const domain = emailDomain(lower);
  if (domain && sets.domains.has(domain)) return true;
  const company = companyDomain?.trim().toLowerCase().replace(/\.$/, '');
  if (company && sets.domains.has(company)) return true;
  return false;
}

/** SQL fragment: true when lead alias `l` is NOT suppressed for account $accountParam. */
export function notSuppressedSql(leadAlias: string, accountParam: string): string {
  return `not exists (
    select 1 from suppressions s
    where (s.account_id = ${accountParam} or s.account_id is null)
      and (
        (s.email is not null and lower(s.email) = lower(${leadAlias}.email))
        or (s.domain is not null and lower(s.domain) = split_part(lower(${leadAlias}.email), '@', 2))
      )
  )`;
}

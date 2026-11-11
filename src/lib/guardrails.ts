/**
 * Sending gates and guardrail enforcement (module M3).
 *
 * `assertCanSend` implements the seven gates in docs/SPEC.md §5 and returns every
 * failing reason, not only the first. `enforceGuardrails` runs the pausing gates
 * (1, 2, 4, 5, 6) over every active campaign and pauses the ones that fail.
 *
 * Every query is scoped by account_id (I2). Nothing here calls a provider: a
 * pause is recorded on our side and as an `events` row; the sending module reacts.
 */

import { getDb, type Db } from './db';
import { env } from './env';
import { getCreditSummary } from './ledger';
import type { AccountStatus, CampaignStatus, IsoTimestamp, Uuid, WarmupProgress } from './contracts';

// ---------------------------------------------------------------- types

/** Stable tokens at the front of every reason string, so callers can match on them. */
export const GATE = {
  account_paused: 'account_paused',
  account_status: 'account_status',
  no_credits: 'no_credits',
  compliance_failed: 'compliance_failed',
  mailboxes_not_ready: 'mailboxes_not_ready',
  first_campaign_unapproved: 'first_campaign_unapproved',
  bounce_rate: 'bounce_rate',
  daily_cap_reached: 'daily_cap_reached',
  campaign_not_found: 'campaign_not_found',
  account_not_found: 'account_not_found',
} as const;
export type GateCode = (typeof GATE)[keyof typeof GATE];

export interface SendCheck {
  allowed: boolean;
  reasons: string[];
  /** The gate numbers (1-7) that failed; empty when allowed. */
  failed_gates: number[];
}

export interface PausedCampaign {
  campaign_id: Uuid;
  reasons: string[];
  bounce_rate: number;
}

export interface EnforceResult {
  checked: number;
  paused: PausedCampaign[];
}

/** Statuses in which a campaign is actively sending or about to. */
const ACTIVE_CAMPAIGN_STATUSES: readonly CampaignStatus[] = ['scheduled', 'sending'];
/** Inlined (not a bound array) so the enum cast behaves identically on PGlite and node-postgres. */
const ACTIVE_STATUS_SQL = ACTIVE_CAMPAIGN_STATUSES.map((s) => `'${s}'`).join(', ');

/** Gates whose failure pauses the campaign (SPEC §5): all but compliance (3) and cap (7). */
const PAUSING_GATES: ReadonlySet<number> = new Set([1, 2, 4, 5, 6]);

const SENDABLE_ACCOUNT_STATUSES: readonly AccountStatus[] = ['trialing', 'active'];

const MS_PER_DAY = 86_400_000;

// ---------------------------------------------------------------- warm-up

export interface WarmupSource {
  warmup_started_at: IsoTimestamp | Date | null;
  /** Falls back to env.warmupDays when absent (mailboxes carry no own duration). */
  warmup_days?: number | null;
}

/**
 * Pure. `complete` only when elapsed >= days_total. A null start is "not started",
 * which is never complete unless no warm-up is required at all (days_total = 0).
 */
export function warmupProgress(source: WarmupSource, now: Date = new Date()): WarmupProgress {
  const daysTotal = Math.max(0, Math.floor(source.warmup_days ?? env.warmupDays));
  const started = source.warmup_started_at === null ? null : new Date(source.warmup_started_at);
  if (started === null || Number.isNaN(started.getTime())) {
    return {
      started_at: null,
      days_total: daysTotal,
      days_elapsed: 0,
      percent: daysTotal === 0 ? 100 : 0,
      ready_at: null,
      complete: daysTotal === 0,
    };
  }
  const elapsedRaw = Math.max(0, Math.floor((now.getTime() - started.getTime()) / MS_PER_DAY));
  const complete = elapsedRaw >= daysTotal;
  const daysElapsed = Math.min(elapsedRaw, daysTotal);
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

/**
 * Linear ramp: day 1 of N gets floor(cap / N), day N gets the full cap, never
 * below 1 while the cap itself is at least 1. Day index = whole days elapsed + 1.
 */
export function rampedCap(cap: number, source: WarmupSource, now: Date = new Date()): number {
  if (cap <= 0) return 0;
  const progress = warmupProgress(source, now);
  if (progress.complete) return cap;
  const day = Math.min(progress.days_elapsed + 1, progress.days_total);
  return Math.max(1, Math.floor((cap * day) / progress.days_total));
}

// ---------------------------------------------------------------- row types

interface AccountRow {
  id: string;
  status: AccountStatus;
  daily_send_cap: number;
  bounce_pause_threshold: string | number;
  first_campaign_approved: boolean;
  sending_paused: boolean;
}

interface CampaignRow {
  id: string;
  status: CampaignStatus;
  daily_cap: number;
}

interface MailboxRow {
  id: string;
  email: string;
  status: string;
  daily_cap: number;
  mailbox_warmup_started_at: Date | string | null;
  domain_warmup_started_at: Date | string | null;
  domain_warmup_days: number;
}

// ---------------------------------------------------------------- queries

async function loadAccount(db: Db, accountId: Uuid): Promise<AccountRow | null> {
  const res = await db.query<AccountRow>(
    `select id, status, daily_send_cap, bounce_pause_threshold, first_campaign_approved, sending_paused
     from accounts where id = $1`,
    [accountId],
  );
  return res.rows[0] ?? null;
}

async function loadCampaign(db: Db, accountId: Uuid, campaignId: Uuid): Promise<CampaignRow | null> {
  const res = await db.query<CampaignRow>(
    `select id, status, daily_cap from campaigns where id = $1 and account_id = $2`,
    [campaignId, accountId],
  );
  return res.rows[0] ?? null;
}

/**
 * The mailboxes a campaign sends from. There is no campaign-mailbox link table;
 * the sending module attaches the account's usable mailboxes, so "used" means
 * every account mailbox that is not failed or paused.
 */
async function loadUsedMailboxes(db: Db, accountId: Uuid): Promise<MailboxRow[]> {
  const res = await db.query<MailboxRow>(
    `select m.id, m.email, m.status::text as status, m.daily_cap,
            m.warmup_started_at as mailbox_warmup_started_at,
            d.warmup_started_at as domain_warmup_started_at,
            d.warmup_days       as domain_warmup_days
     from mailboxes m
     join domains d on d.id = m.domain_id and d.account_id = m.account_id
     where m.account_id = $1 and m.status not in ('failed', 'paused')
     order by m.email`,
    [accountId],
  );
  return res.rows;
}

function readyMailboxes(rows: MailboxRow[]): MailboxRow[] {
  return rows.filter((m) => m.status === 'ready');
}

/**
 * Bounces / sent over the trailing window (today and the windowDays-1 days before).
 * 0 when nothing was sent: never NaN, never a division by zero.
 */
export async function bounceRate(accountId: Uuid, campaignId: Uuid, windowDays = 7): Promise<number> {
  const db = await getDb();
  const days = Math.max(1, Math.floor(windowDays));
  const res = await db.query<{ sent: string | number; bounces: string | number }>(
    `select coalesce(sum(sent), 0) as sent, coalesce(sum(bounces), 0) as bounces
     from daily_send_stats
     where account_id = $1 and campaign_id = $2
       and day >= current_date - ($3::integer - 1)`,
    [accountId, campaignId, days],
  );
  const sent = Number(res.rows[0]?.sent ?? 0);
  const bounces = Number(res.rows[0]?.bounces ?? 0);
  if (sent <= 0) return 0;
  return bounces / sent;
}

async function sentToday(db: Db, accountId: Uuid, campaignId: Uuid | null): Promise<number> {
  const res = campaignId
    ? await db.query<{ sent: string | number }>(
        `select coalesce(sum(sent), 0) as sent from daily_send_stats
         where account_id = $1 and campaign_id = $2 and day = current_date`,
        [accountId, campaignId],
      )
    : await db.query<{ sent: string | number }>(
        `select coalesce(sum(sent), 0) as sent from daily_send_stats
         where account_id = $1 and day = current_date`,
        [accountId],
      );
  return Number(res.rows[0]?.sent ?? 0);
}

function capFromRows(account: AccountRow, campaign: CampaignRow, mailboxes: MailboxRow[], now: Date): number {
  const ready = readyMailboxes(mailboxes);
  const mailboxSum = ready.reduce((acc, m) => acc + Number(m.daily_cap), 0);
  const cap = Math.min(Number(account.daily_send_cap), Number(campaign.daily_cap), mailboxSum);
  if (cap <= 0 || ready.length === 0) return 0;

  // Ramp by the least-progressed warm-up among the mailboxes in use. The domain
  // carries the duration; a mailbox that started warming later than its domain
  // is the slower of the two.
  let ramped = cap;
  for (const m of ready) {
    const started = latest(m.domain_warmup_started_at, m.mailbox_warmup_started_at);
    const r = rampedCap(cap, { warmup_started_at: started, warmup_days: Number(m.domain_warmup_days) }, now);
    if (r < ramped) ramped = r;
  }
  return ramped;
}

function latest(a: Date | string | null, b: Date | string | null): Date | null {
  const da = a === null ? null : new Date(a);
  const dbb = b === null ? null : new Date(b);
  if (da === null) return dbb;
  if (dbb === null) return da;
  return da.getTime() >= dbb.getTime() ? da : dbb;
}

/**
 * min(account.daily_send_cap, campaign.daily_cap, SUM(ready mailbox.daily_cap)),
 * ramped linearly while the mailboxes' warm-up is still running.
 */
export async function dailyCapFor(accountId: Uuid, campaignId: Uuid, now: Date = new Date()): Promise<number> {
  const db = await getDb();
  const [account, campaign, mailboxes] = await Promise.all([
    loadAccount(db, accountId),
    loadCampaign(db, accountId, campaignId),
    loadUsedMailboxes(db, accountId),
  ]);
  if (!account || !campaign) return 0;
  return capFromRows(account, campaign, mailboxes, now);
}

// ---------------------------------------------------------------- the seven gates

interface GateContext {
  db: Db;
  account: AccountRow;
  campaign: CampaignRow;
  now: Date;
}

interface GateOutcome {
  reasons: string[];
  failed_gates: number[];
  bounce_rate: number;
}

async function evaluateGates(ctx: GateContext): Promise<GateOutcome> {
  const { db, account, campaign, now } = ctx;
  const accountId = account.id;
  const campaignId = campaign.id;
  const reasons: string[] = [];
  const failed = new Set<number>();
  const fail = (gate: number, code: GateCode, message: string) => {
    failed.add(gate);
    reasons.push(`[${code}] ${message}`);
  };

  // Gate 1: account may send.
  if (account.sending_paused) fail(1, GATE.account_paused, 'Sending is paused on this account');
  if (!SENDABLE_ACCOUNT_STATUSES.includes(account.status)) {
    fail(1, GATE.account_status, `Account status is '${account.status}'; must be trialing or active`);
  }

  // Gate 2: credits.
  const credits = await getCreditSummary(accountId, db);
  if (credits.balance <= 0) fail(2, GATE.no_credits, `Credit balance is ${credits.balance}`);

  // Gate 3: latest copy passed compliance.
  const copy = await db.query<{ compliance_passed: boolean; version: number }>(
    `select compliance_passed, version from campaign_copy
     where campaign_id = $1 and account_id = $2 order by version desc limit 1`,
    [campaignId, accountId],
  );
  const latestCopy = copy.rows[0];
  if (!latestCopy) fail(3, GATE.compliance_failed, 'Campaign has no copy');
  else if (!latestCopy.compliance_passed) {
    fail(3, GATE.compliance_failed, `Copy v${latestCopy.version} has not passed the compliance check`);
  }

  // Gate 4: every mailbox in use is ready.
  const mailboxes = await loadUsedMailboxes(db, accountId);
  const ready = readyMailboxes(mailboxes);
  if (mailboxes.length === 0) fail(4, GATE.mailboxes_not_ready, 'No mailboxes are attached to this account');
  else if (ready.length !== mailboxes.length) {
    const notReady = mailboxes.filter((m) => m.status !== 'ready').map((m) => `${m.email} (${m.status})`);
    fail(4, GATE.mailboxes_not_ready, `Mailboxes still warming or not provisioned: ${notReady.join(', ')}`);
  }

  // Gate 5: the account's first campaign carries an approved approval.
  if (!(await firstCampaignApproved(db, accountId, campaignId, account))) {
    fail(5, GATE.first_campaign_unapproved, "The account's first campaign has not been approved by a human");
  }

  // Gate 6: bounce rate below threshold.
  const threshold = Number(account.bounce_pause_threshold);
  const rate = await bounceRate(accountId, campaignId);
  if (rate >= threshold) {
    fail(6, GATE.bounce_rate, `Bounce rate ${pct(rate)} is at or above the ${pct(threshold)} pause threshold`);
  }

  // Gate 7: under today's cap, for the campaign and for the account as a whole.
  // With no ready mailbox the cap is 0 by construction; gate 4 already says why.
  const cap = capFromRows(account, campaign, mailboxes, now);
  const campaignToday = await sentToday(db, accountId, campaignId);
  if (ready.length > 0 && campaignToday >= cap) {
    fail(7, GATE.daily_cap_reached, `Campaign has sent ${campaignToday} today; cap is ${cap}`);
  }
  const accountToday = await sentToday(db, accountId, null);
  if (accountToday >= Number(account.daily_send_cap)) {
    fail(7, GATE.daily_cap_reached, `Account has sent ${accountToday} today; account cap is ${account.daily_send_cap}`);
  }

  return { reasons, failed_gates: [...failed].sort((a, b) => a - b), bounce_rate: rate };
}

/**
 * Passes when the account flag is set, when this campaign has an approved row, or
 * when the account's earliest campaign has one. Checking the earliest campaign
 * (not just "is this the first") means a second campaign cannot be used to skip
 * the human review of the first.
 */
async function firstCampaignApproved(db: Db, accountId: Uuid, campaignId: Uuid, account: AccountRow): Promise<boolean> {
  if (account.first_campaign_approved) return true;
  const res = await db.query<{ ok: boolean }>(
    `select exists (
       select 1 from approvals a
       where a.account_id = $1 and a.status = 'approved'
         and a.campaign_id in (
           $2::uuid,
           (select id from campaigns where account_id = $1 order by created_at asc, id asc limit 1)
         )
     ) as ok`,
    [accountId, campaignId],
  );
  return res.rows[0]?.ok === true;
}

function pct(rate: number): string {
  return `${(rate * 100).toFixed(2)}%`;
}

export async function assertCanSend(accountId: Uuid, campaignId: Uuid, now: Date = new Date()): Promise<SendCheck> {
  const db = await getDb();
  const account = await loadAccount(db, accountId);
  if (!account) {
    return { allowed: false, reasons: [`[${GATE.account_not_found}] Account not found`], failed_gates: [] };
  }
  const campaign = await loadCampaign(db, accountId, campaignId);
  if (!campaign) {
    return { allowed: false, reasons: [`[${GATE.campaign_not_found}] Campaign not found on this account`], failed_gates: [] };
  }
  const outcome = await evaluateGates({ db, account, campaign, now });
  return { allowed: outcome.reasons.length === 0, reasons: outcome.reasons, failed_gates: outcome.failed_gates };
}

// ---------------------------------------------------------------- enforcement

async function logEvent(
  db: Db,
  accountId: Uuid,
  type: string,
  subject: string | null,
  detail: Record<string, unknown>,
): Promise<void> {
  await db.query(
    `insert into events (account_id, actor, type, subject, detail)
     values ($1, 'system:guardrails', $2, $3, $4::jsonb)`,
    [accountId, type, subject, JSON.stringify(detail)],
  );
}

/**
 * Checks every active campaign on the account and pauses those failing a pausing
 * gate (bounce rate at or over threshold, account paused, no credits, mailboxes
 * not ready, first campaign unapproved). Idempotent: a paused campaign is no
 * longer active, so a second run finds nothing to do.
 */
export async function enforceGuardrails(accountId: Uuid, now: Date = new Date()): Promise<EnforceResult> {
  const db = await getDb();
  const account = await loadAccount(db, accountId);
  if (!account) return { checked: 0, paused: [] };

  const campaigns = await db.query<CampaignRow>(
    `select id, status, daily_cap from campaigns
     where account_id = $1 and status in (${ACTIVE_STATUS_SQL})
     order by created_at asc`,
    [accountId],
  );

  const paused: PausedCampaign[] = [];
  for (const campaign of campaigns.rows) {
    const outcome = await evaluateGates({ db, account, campaign, now });
    const pausing = outcome.failed_gates.filter((g) => PAUSING_GATES.has(g));
    if (pausing.length === 0) continue;

    const reasons = outcome.reasons.filter((r) => !r.startsWith(`[${GATE.daily_cap_reached}]`) && !r.startsWith(`[${GATE.compliance_failed}]`));
    const reason = reasons.join('; ');
    const changed = await db.tx(async (tx) => {
      const upd = await tx.query(
        `update campaigns set status = 'paused', paused_reason = $3, updated_at = now()
         where id = $1 and account_id = $2 and status in (${ACTIVE_STATUS_SQL})`,
        [campaign.id, accountId, reason],
      );
      if (upd.rowCount === 0) return false;
      await logEvent(tx, accountId, 'campaign.paused', campaign.id, {
        campaign_id: campaign.id,
        reasons,
        failed_gates: pausing,
        bounce_rate: outcome.bounce_rate,
        bounce_pause_threshold: Number(account.bounce_pause_threshold),
      });
      return true;
    });
    if (changed) paused.push({ campaign_id: campaign.id, reasons, bounce_rate: outcome.bounce_rate });
  }

  return { checked: campaigns.rows.length, paused };
}

/** Stops all sending for the account. Used by billing on cancellation / failed payment. */
export async function pauseSending(accountId: Uuid, reason: string): Promise<{ changed: boolean }> {
  const db = await getDb();
  return db.tx(async (tx) => {
    const upd = await tx.query(
      `update accounts set sending_paused = true, paused_reason = $2, updated_at = now()
       where id = $1 and (sending_paused = false or paused_reason is distinct from $2)`,
      [accountId, reason],
    );
    if (upd.rowCount === 0) return { changed: false };
    await logEvent(tx, accountId, 'account.sending_paused', accountId, { reason });

    // Setting the flag is not enough: campaigns keep running at the sending provider
    // until something tells it to stop. Queued rather than called inline so a slow
    // vendor cannot make a Stripe webhook time out, and so it retries on failure.
    await tx.query(
      `insert into jobs (account_id, type, payload, dedupe_key)
       values ($1, 'enforce_guardrails', $2, $3)
       on conflict (type, dedupe_key)
         where dedupe_key is not null and status in ('pending','running')
         do nothing`,
      [accountId, JSON.stringify({ account_id: accountId }), `guardrails:${accountId}`],
    );

    return { changed: true };
  });
}

export async function resumeSending(accountId: Uuid): Promise<{ changed: boolean }> {
  const db = await getDb();
  return db.tx(async (tx) => {
    const upd = await tx.query(
      `update accounts set sending_paused = false, paused_reason = null, updated_at = now()
       where id = $1 and sending_paused = true`,
      [accountId],
    );
    if (upd.rowCount === 0) return { changed: false };
    // Clear the "already stopped at the provider" marker, so if this account is
    // paused again later the stop is sent afresh rather than assumed.
    await tx.query(
      `update campaigns set provider_sending_stopped_at = null
        where account_id = $1 and provider_sending_stopped_at is not null`,
      [accountId],
    );
    await logEvent(tx, accountId, 'account.sending_resumed', accountId, {});
    return { changed: true };
  });
}

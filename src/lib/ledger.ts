/**
 * Credit ledger and cost ledger (module M3).
 *
 * Invariants enforced here (docs/SPEC.md §4):
 *   I1  Credits are append-only. Balance = SUM(delta). Every write carries an
 *       idempotency key unique per account; a replayed write is a no-op.
 *   I2  Every query is scoped by account_id.
 *   I7  Send credits are spent only from provider-confirmed sends, through
 *       reconcileSends, keyed `campaign:<id>:day:<YYYY-MM-DD>`.
 *
 * All amounts are integers. node-postgres returns SUM() as a string, so every
 * aggregate goes through Number() before it is used.
 */

import { getDb, type Db } from './db';
import type { CostCategory, CreditReason, CreditSummary, LedgerEntry, Uuid } from './contracts';

// ---------------------------------------------------------------- types

export interface GrantInput {
  accountId: Uuid;
  amount: number;
  reason: CreditReason;
  idempotencyKey: string;
  metadata?: Record<string, unknown>;
}

export interface GrantResult {
  /** Credits added by this call. 0 when the key had already been applied. */
  granted: number;
  duplicate: boolean;
  entry: LedgerEntry;
  summary: CreditSummary;
}

export interface SpendInput {
  accountId: Uuid;
  amount: number;
  reason: CreditReason;
  campaignId?: Uuid | null;
  idempotencyKey: string;
  metadata?: Record<string, unknown>;
}

export interface SpendResult {
  /** Credits actually deducted. Never more than the balance at the time of the call. */
  spent: number;
  requested: number;
  /** True when the balance could not cover the request and only the remainder was spent. */
  clamped: boolean;
  /** True when the key had already been applied; nothing was written. */
  duplicate: boolean;
  balance_before: number;
  balance_after: number;
  /** The ledger row for this key, or null when nothing was written (balance was 0). */
  entry: LedgerEntry | null;
}

export interface RecordCostInput {
  accountId: Uuid;
  costCents: number;
  category: CostCategory;
  quantity?: number | null;
  idempotencyKey: string;
  metadata?: Record<string, unknown>;
}

export interface CostEntry {
  id: Uuid;
  account_id: Uuid;
  cost_cents: number;
  category: CostCategory;
  quantity: number | null;
  idempotency_key: string;
  metadata: Record<string, unknown> | null;
  created_at: string;
}

export interface RecordCostResult {
  recorded_cents: number;
  duplicate: boolean;
  entry: CostEntry;
}

export interface CostSummary {
  total_cents: number;
  by_category: Record<CostCategory, number>;
  entries: number;
}

export interface ReconcileInput {
  accountId: Uuid;
  campaignId: Uuid;
  /** Calendar day in the provider's reporting, as YYYY-MM-DD. */
  day: string;
  /** Cumulative sends the provider reports for that campaign-day. */
  sentCount: number;
}

export interface ReconcileResult {
  idempotency_key: string;
  /** Cumulative sends billed for this campaign-day before this call. */
  billed_before: number;
  /** Cumulative sends billed after this call. */
  billed_after: number;
  /** Credits deducted by this call. */
  spent: number;
  /** Credits this call tried to deduct (sentCount - billed_before, floored at 0). */
  requested: number;
  clamped: boolean;
  /** Sends reported but not yet billed because the balance ran out. */
  shortfall: number;
  balance_after: number;
}

export const COST_CATEGORIES: readonly CostCategory[] = [
  'lead_data', 'verification', 'mailbox', 'domain', 'llm', 'other',
];

// ---------------------------------------------------------------- helpers

interface LedgerRow {
  id: string;
  account_id: string;
  delta: number;
  reason: string;
  campaign_id: string | null;
  idempotency_key: string;
  metadata: Record<string, unknown> | null;
  created_at: Date | string;
}

interface CostRow {
  id: string;
  account_id: string;
  cost_cents: number;
  category: string;
  quantity: number | null;
  idempotency_key: string;
  metadata: Record<string, unknown> | null;
  created_at: Date | string;
}

const LEDGER_COLS = 'id, account_id, delta, reason, campaign_id, idempotency_key, metadata, created_at';
const COST_COLS = 'id, account_id, cost_cents, category, quantity, idempotency_key, metadata, created_at';

function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function toEntry(row: LedgerRow): LedgerEntry {
  return {
    id: row.id,
    account_id: row.account_id,
    delta: Number(row.delta),
    reason: row.reason as CreditReason,
    campaign_id: row.campaign_id,
    idempotency_key: row.idempotency_key,
    metadata: row.metadata,
    created_at: iso(row.created_at),
  };
}

function toCostEntry(row: CostRow): CostEntry {
  return {
    id: row.id,
    account_id: row.account_id,
    cost_cents: Number(row.cost_cents),
    category: row.category as CostCategory,
    quantity: row.quantity === null ? null : Number(row.quantity),
    idempotency_key: row.idempotency_key,
    metadata: row.metadata,
    created_at: iso(row.created_at),
  };
}

function assertPositiveInt(value: number, name: string): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer, got ${String(value)}`);
  }
}

function assertNonNegativeInt(value: number, name: string): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative integer, got ${String(value)}`);
  }
}

function assertKey(key: string): void {
  if (typeof key !== 'string' || key.trim() === '') throw new Error('idempotencyKey is required');
}

function jsonParam(metadata: Record<string, unknown> | undefined): string | null {
  return metadata === undefined ? null : JSON.stringify(metadata);
}

async function findEntry(db: Db, accountId: Uuid, key: string): Promise<LedgerEntry | null> {
  const res = await db.query<LedgerRow>(
    `select ${LEDGER_COLS} from credit_ledger where account_id = $1 and idempotency_key = $2`,
    [accountId, key],
  );
  const row = res.rows[0];
  return row ? toEntry(row) : null;
}

/**
 * Serialises every balance-changing write for one account across connections.
 * Throws if the account does not exist, which keeps a typo'd id from creating
 * orphan ledger rows (the FK would catch it too, but with a worse message).
 */
async function lockAccount(db: Db, accountId: Uuid): Promise<void> {
  const res = await db.query<{ id: string }>(`select id from accounts where id = $1 for update`, [accountId]);
  if (res.rows.length === 0) throw new Error(`account ${accountId} not found`);
}

async function balanceOf(db: Db, accountId: Uuid): Promise<number> {
  const res = await db.query<{ balance: string | number }>(
    `select coalesce(sum(delta), 0) as balance from credit_ledger where account_id = $1`,
    [accountId],
  );
  return Number(res.rows[0]?.balance ?? 0);
}

// ---------------------------------------------------------------- summary

export async function getCreditSummary(accountId: Uuid, dbOverride?: Db): Promise<CreditSummary> {
  const db = dbOverride ?? (await getDb());
  const res = await db.query<{ balance: string | number; granted: string | number; spent: string | number }>(
    `select
       coalesce(sum(delta), 0)                                   as balance,
       coalesce(sum(case when delta > 0 then delta else 0 end), 0) as granted,
       coalesce(sum(case when delta < 0 then -delta else 0 end), 0) as spent
     from credit_ledger where account_id = $1`,
    [accountId],
  );
  const row = res.rows[0];
  const balance = Number(row?.balance ?? 0);
  const granted = Number(row?.granted ?? 0);
  const spent = Number(row?.spent ?? 0);
  // Integer comparison: balance < 10% of granted  <=>  balance * 10 < granted.
  const low = granted > 0 && balance * 10 < granted;
  return { balance, granted, spent, low };
}

// ---------------------------------------------------------------- grant

/**
 * Adds credits. A repeated idempotency key is a silent no-op: the unique index
 * (account_id, idempotency_key) rejects the second row and we return the first.
 *
 * `on conflict do nothing` is used rather than catching SQLSTATE 23505 because a
 * raised unique violation aborts the surrounding Postgres transaction, which
 * would break callers that grant inside a larger tx (billing webhooks do).
 */
export async function grantCredits(input: GrantInput, dbOverride?: Db): Promise<GrantResult> {
  const { accountId, amount, reason, idempotencyKey, metadata } = input;
  assertPositiveInt(amount, 'amount');
  assertKey(idempotencyKey);
  const db = dbOverride ?? (await getDb());

  const res = await db.query<LedgerRow>(
    `insert into credit_ledger (account_id, delta, reason, campaign_id, idempotency_key, metadata)
     values ($1::uuid, $2::integer, $3::text, null, $4::text, $5::jsonb)
     on conflict (account_id, idempotency_key) do nothing
     returning ${LEDGER_COLS}`,
    [accountId, amount, reason, idempotencyKey, jsonParam(metadata)],
  );

  const inserted = res.rows[0];
  if (inserted) {
    return { granted: amount, duplicate: false, entry: toEntry(inserted), summary: await getCreditSummary(accountId, db) };
  }

  const existing = await findEntry(db, accountId, idempotencyKey);
  if (!existing) {
    // on conflict do nothing returned no row, yet the key is absent: only possible
    // if the row was deleted between the two statements. Ledger rows are never deleted.
    throw new Error(`grantCredits: key ${idempotencyKey} conflicted but no row found`);
  }
  return { granted: 0, duplicate: true, entry: existing, summary: await getCreditSummary(accountId, db) };
}

// ---------------------------------------------------------------- spend

/**
 * Deducts credits without ever taking the balance below zero.
 *
 * Over-spend policy: if the request exceeds the balance, spend exactly the
 * remaining balance and report `clamped: true`. Sends are reported by the
 * provider after they happened, so refusing would leave real sends unbilled;
 * clamping records what we can and the shortfall is visible to the caller.
 *
 * The balance is computed and the row inserted in ONE statement, so the clamp is
 * atomic even on a backend that cannot hold a row lock across statements (PGlite
 * runs every tx() on one connection, where interleaved transactions merge).
 * On Postgres the caller additionally holds the account row lock, which
 * serialises spends across connections.
 */
async function spendWithin(db: Db, input: SpendInput): Promise<SpendResult> {
  const { accountId, amount, reason, idempotencyKey, metadata } = input;
  const campaignId = input.campaignId ?? null;
  assertPositiveInt(amount, 'amount');
  assertKey(idempotencyKey);

  const res = await db.query<{ balance_before: string | number } & Partial<LedgerRow>>(
    `with bal as (
       select coalesce(sum(delta), 0)::bigint as balance
       from credit_ledger where account_id = $1::uuid
     ),
     ins as (
       insert into credit_ledger (account_id, delta, reason, campaign_id, idempotency_key, metadata)
       select $1::uuid,
              (-least($2::bigint, bal.balance))::integer,
              $3::text, $4::uuid, $5::text, $6::jsonb
       from bal
       where least($2::bigint, bal.balance) > 0
       on conflict (account_id, idempotency_key) do nothing
       returning ${LEDGER_COLS}
     )
     select bal.balance as balance_before,
            ins.id, ins.account_id, ins.delta, ins.reason, ins.campaign_id,
            ins.idempotency_key, ins.metadata, ins.created_at
     from bal left join ins on true`,
    [accountId, amount, reason, campaignId, idempotencyKey, jsonParam(metadata)],
  );

  const row = res.rows[0];
  if (!row) throw new Error('spendCredits: balance query returned no row');
  const balanceBefore = Number(row.balance_before);

  if (row.id) {
    const entry = toEntry(row as LedgerRow);
    const spent = -entry.delta;
    return {
      spent,
      requested: amount,
      clamped: spent < amount,
      duplicate: false,
      balance_before: balanceBefore,
      balance_after: balanceBefore - spent,
      entry,
    };
  }

  // No row written: either the key was already applied, or the balance was 0.
  const existing = await findEntry(db, accountId, idempotencyKey);
  if (existing) {
    const spent = -existing.delta;
    const balance = await balanceOf(db, accountId);
    return {
      spent,
      requested: amount,
      clamped: spent < amount,
      duplicate: true,
      balance_before: balance,
      balance_after: balance,
      entry: existing,
    };
  }
  return {
    spent: 0,
    requested: amount,
    clamped: true,
    duplicate: false,
    balance_before: balanceBefore,
    balance_after: balanceBefore,
    entry: null,
  };
}

export async function spendCredits(input: SpendInput): Promise<SpendResult> {
  const db = await getDb();
  return db.tx(async (tx) => {
    await lockAccount(tx, input.accountId);
    return spendWithin(tx, input);
  });
}

// ---------------------------------------------------------------- cost ledger

export async function recordCost(input: RecordCostInput, dbOverride?: Db): Promise<RecordCostResult> {
  const { accountId, costCents, category, idempotencyKey, metadata } = input;
  const quantity = input.quantity ?? null;
  assertNonNegativeInt(costCents, 'costCents');
  if (quantity !== null) assertNonNegativeInt(quantity, 'quantity');
  if (!COST_CATEGORIES.includes(category)) throw new Error(`unknown cost category ${String(category)}`);
  assertKey(idempotencyKey);
  const db = dbOverride ?? (await getDb());

  const res = await db.query<CostRow>(
    `insert into cost_ledger (account_id, cost_cents, category, quantity, idempotency_key, metadata)
     values ($1::uuid, $2::integer, $3::text, $4::integer, $5::text, $6::jsonb)
     on conflict (account_id, idempotency_key) do nothing
     returning ${COST_COLS}`,
    [accountId, costCents, category, quantity, idempotencyKey, jsonParam(metadata)],
  );
  const inserted = res.rows[0];
  if (inserted) return { recorded_cents: costCents, duplicate: false, entry: toCostEntry(inserted) };

  const existing = await db.query<CostRow>(
    `select ${COST_COLS} from cost_ledger where account_id = $1 and idempotency_key = $2`,
    [accountId, idempotencyKey],
  );
  const row = existing.rows[0];
  if (!row) throw new Error(`recordCost: key ${idempotencyKey} conflicted but no row found`);
  return { recorded_cents: 0, duplicate: true, entry: toCostEntry(row) };
}

/** Our spend on one account, in cents, in total and per category. */
export async function getCostSummary(accountId: Uuid, dbOverride?: Db): Promise<CostSummary> {
  const db = dbOverride ?? (await getDb());
  const res = await db.query<{ category: string; cents: string | number; n: string | number }>(
    `select category, coalesce(sum(cost_cents), 0) as cents, count(*) as n
     from cost_ledger where account_id = $1 group by category`,
    [accountId],
  );
  const by_category: Record<CostCategory, number> = {
    lead_data: 0, verification: 0, mailbox: 0, domain: 0, llm: 0, other: 0,
  };
  let total_cents = 0;
  let entries = 0;
  for (const row of res.rows) {
    const cents = Number(row.cents);
    const cat = row.category as CostCategory;
    if (cat in by_category) by_category[cat] = cents;
    total_cents += cents;
    entries += Number(row.n);
  }
  return { total_cents, by_category, entries };
}

// ---------------------------------------------------------------- send reconciliation (I7)

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

export function reconcileKey(campaignId: Uuid, day: string): string {
  return `campaign:${campaignId}:day:${day}`;
}

/**
 * The only path that spends send credits. `sentCount` is the provider's
 * cumulative count for the campaign-day; each call bills only the part not yet
 * billed, so re-running with the same or a lower count writes nothing.
 *
 * Keys: the first ledger row for a campaign-day carries exactly
 * `campaign:<id>:day:<YYYY-MM-DD>`. A later increment carries that key suffixed
 * with the cumulative count already billed (`...:100`), which is deterministic
 * for a given ledger state, so two racing reconciles of the same state collide
 * on the key and the loser is a no-op. A clamped (partial) bill leaves the
 * shortfall unbilled; the next reconcile picks it up if credits have arrived.
 */
export async function reconcileSends(input: ReconcileInput): Promise<ReconcileResult> {
  const { accountId, campaignId, day, sentCount } = input;
  if (!DAY_RE.test(day)) throw new Error(`day must be YYYY-MM-DD, got ${day}`);
  assertNonNegativeInt(sentCount, 'sentCount');
  const baseKey = reconcileKey(campaignId, day);

  const db = await getDb();
  return db.tx(async (tx) => {
    await lockAccount(tx, accountId);

    const billedRes = await tx.query<{ billed: string | number }>(
      `select coalesce(sum(-delta), 0) as billed
       from credit_ledger
       where account_id = $1 and campaign_id = $2 and reason = 'spend_email_sent'
         and (idempotency_key = $3 or idempotency_key like $4)`,
      [accountId, campaignId, baseKey, `${baseKey}:%`],
    );
    const billedBefore = Number(billedRes.rows[0]?.billed ?? 0);
    const requested = Math.max(0, sentCount - billedBefore);

    if (requested === 0) {
      return {
        idempotency_key: baseKey,
        billed_before: billedBefore,
        billed_after: billedBefore,
        spent: 0,
        requested: 0,
        clamped: false,
        shortfall: 0,
        balance_after: await balanceOf(tx, accountId),
      };
    }

    const key = billedBefore === 0 ? baseKey : `${baseKey}:${billedBefore}`;
    const spend = await spendWithin(tx, {
      accountId,
      amount: requested,
      reason: 'spend_email_sent',
      campaignId,
      idempotencyKey: key,
      metadata: { day, sent_count: sentCount, billed_before: billedBefore, requested },
    });

    // A duplicate means another reconcile already billed from this same state;
    // its row is already counted in billedBefore on the next run, so report 0 here.
    const spent = spend.duplicate ? 0 : spend.spent;
    const billedAfter = billedBefore + spent;
    return {
      idempotency_key: key,
      billed_before: billedBefore,
      billed_after: billedAfter,
      spent,
      requested,
      clamped: spent < requested,
      shortfall: Math.max(0, sentCount - billedAfter),
      balance_after: spend.balance_after,
    };
  });
}

/** Ledger rows for one account, newest first. */
export async function listLedger(accountId: Uuid, limit = 100): Promise<LedgerEntry[]> {
  const db = await getDb();
  const res = await db.query<LedgerRow>(
    `select ${LEDGER_COLS} from credit_ledger where account_id = $1
     order by created_at desc, id desc limit $2`,
    [accountId, Math.max(1, Math.min(limit, 1000))],
  );
  return res.rows.map(toEntry);
}

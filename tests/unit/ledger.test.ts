/**
 * Credit + cost ledger (I1, I7). These run against the real migrations on an
 * embedded Postgres, so they prove the arithmetic the database actually does.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { freshDb, dropDb, makeAccount } from '../helpers/db';
import type { Db } from '../../src/lib/db';
import {
  getCreditSummary,
  grantCredits,
  spendCredits,
  recordCost,
  getCostSummary,
  reconcileSends,
  reconcileKey,
  listLedger,
} from '../../src/lib/ledger';

let db: Db;

beforeAll(async () => {
  db = await freshDb();
});
afterAll(dropDb);

async function makeCampaign(accountId: string, name = 'Campaign'): Promise<string> {
  const res = await db.query<{ id: string }>(
    `insert into campaigns (account_id, name) values ($1, $2) returning id`,
    [accountId, name],
  );
  return res.rows[0]!.id;
}

async function rawBalance(accountId: string): Promise<number> {
  const res = await db.query<{ balance: string }>(
    `select coalesce(sum(delta), 0) as balance from credit_ledger where account_id = $1`,
    [accountId],
  );
  return Number(res.rows[0]!.balance);
}

describe('getCreditSummary', () => {
  it('is all zeros and not low for an account with no ledger rows', async () => {
    const account = await makeAccount(db);
    expect(await getCreditSummary(account)).toEqual({ balance: 0, granted: 0, spent: 0, low: false });
  });

  it('computes balance, granted, spent and the low flag from the ledger', async () => {
    const account = await makeAccount(db);
    await grantCredits({ accountId: account, amount: 100, reason: 'grant_manual', idempotencyKey: 'g1' });
    await spendCredits({ accountId: account, amount: 90, reason: 'adjustment', idempotencyKey: 's1' });
    expect(await getCreditSummary(account)).toEqual({ balance: 10, granted: 100, spent: 90, low: false });

    await spendCredits({ accountId: account, amount: 1, reason: 'adjustment', idempotencyKey: 's2' });
    // 9 < 10% of 100.
    expect(await getCreditSummary(account)).toEqual({ balance: 9, granted: 100, spent: 91, low: true });
  });
});

describe('grantCredits', () => {
  it('inserts a positive row and returns the new summary', async () => {
    const account = await makeAccount(db);
    const res = await grantCredits({
      accountId: account, amount: 30_000, reason: 'grant_redemption', idempotencyKey: 'redeem:CODE', metadata: { code: 'CODE' },
    });
    expect(res.duplicate).toBe(false);
    expect(res.granted).toBe(30_000);
    expect(res.entry.delta).toBe(30_000);
    expect(res.entry.metadata).toEqual({ code: 'CODE' });
    expect(res.summary.balance).toBe(30_000);
  });

  it('treats a duplicate idempotency key as a silent no-op and keeps the balance correct', async () => {
    const account = await makeAccount(db);
    const first = await grantCredits({ accountId: account, amount: 500, reason: 'grant_manual', idempotencyKey: 'dup' });
    const second = await grantCredits({ accountId: account, amount: 500, reason: 'grant_manual', idempotencyKey: 'dup' });
    const third = await grantCredits({ accountId: account, amount: 999, reason: 'grant_renewal', idempotencyKey: 'dup' });

    expect(second.duplicate).toBe(true);
    expect(second.granted).toBe(0);
    expect(second.entry.id).toBe(first.entry.id);
    expect(third.duplicate).toBe(true);
    expect(third.entry.delta).toBe(500);
    expect(await rawBalance(account)).toBe(500);
    expect((await listLedger(account)).length).toBe(1);
  });

  it('applies the same key independently per account (I2)', async () => {
    const a = await makeAccount(db, 'A');
    const b = await makeAccount(db, 'B');
    await grantCredits({ accountId: a, amount: 10, reason: 'grant_manual', idempotencyKey: 'shared' });
    const res = await grantCredits({ accountId: b, amount: 20, reason: 'grant_manual', idempotencyKey: 'shared' });
    expect(res.duplicate).toBe(false);
    expect(await rawBalance(a)).toBe(10);
    expect(await rawBalance(b)).toBe(20);
  });

  it('rejects a non-positive or non-integer amount', async () => {
    const account = await makeAccount(db);
    await expect(grantCredits({ accountId: account, amount: 0, reason: 'grant_manual', idempotencyKey: 'z' })).rejects.toThrow();
    await expect(grantCredits({ accountId: account, amount: -5, reason: 'grant_manual', idempotencyKey: 'n' })).rejects.toThrow();
    await expect(grantCredits({ accountId: account, amount: 1.5, reason: 'grant_manual', idempotencyKey: 'f' })).rejects.toThrow();
    await expect(grantCredits({ accountId: account, amount: 1, reason: 'grant_manual', idempotencyKey: '' })).rejects.toThrow();
    expect(await rawBalance(account)).toBe(0);
  });
});

describe('spendCredits', () => {
  it('inserts a negative row when the balance covers the request', async () => {
    const account = await makeAccount(db);
    await grantCredits({ accountId: account, amount: 100, reason: 'grant_manual', idempotencyKey: 'g' });
    const res = await spendCredits({ accountId: account, amount: 40, reason: 'adjustment', idempotencyKey: 's' });
    expect(res).toMatchObject({ spent: 40, requested: 40, clamped: false, duplicate: false, balance_before: 100, balance_after: 60 });
    expect(res.entry?.delta).toBe(-40);
    expect(await rawBalance(account)).toBe(60);
  });

  it('clamps an over-spend to the remaining balance and reports it', async () => {
    const account = await makeAccount(db);
    await grantCredits({ accountId: account, amount: 25, reason: 'grant_manual', idempotencyKey: 'g' });
    const res = await spendCredits({ accountId: account, amount: 100, reason: 'spend_email_sent', idempotencyKey: 's' });
    expect(res).toMatchObject({ spent: 25, requested: 100, clamped: true, balance_after: 0 });
    expect(await rawBalance(account)).toBe(0);
  });

  it('writes nothing when the balance is already zero', async () => {
    const account = await makeAccount(db);
    const res = await spendCredits({ accountId: account, amount: 10, reason: 'adjustment', idempotencyKey: 's' });
    expect(res).toMatchObject({ spent: 0, requested: 10, clamped: true, duplicate: false, entry: null });
    expect(await rawBalance(account)).toBe(0);
    expect(await listLedger(account)).toEqual([]);
  });

  it('treats a duplicate idempotency key as a no-op', async () => {
    const account = await makeAccount(db);
    await grantCredits({ accountId: account, amount: 100, reason: 'grant_manual', idempotencyKey: 'g' });
    const first = await spendCredits({ accountId: account, amount: 30, reason: 'adjustment', idempotencyKey: 'dup' });
    const second = await spendCredits({ accountId: account, amount: 30, reason: 'adjustment', idempotencyKey: 'dup' });
    expect(second.duplicate).toBe(true);
    expect(second.entry?.id).toBe(first.entry?.id);
    expect(await rawBalance(account)).toBe(70);
  });

  it('concurrent spends cannot push the balance below zero', async () => {
    const account = await makeAccount(db);
    await grantCredits({ accountId: account, amount: 100, reason: 'grant_manual', idempotencyKey: 'g' });

    const results = await Promise.all(
      Array.from({ length: 6 }, (_, i) =>
        spendCredits({ accountId: account, amount: 30, reason: 'adjustment', idempotencyKey: `c${i}` }),
      ),
    );

    const totalSpent = results.reduce((acc, r) => acc + r.spent, 0);
    const balance = await rawBalance(account);
    expect(balance).toBeGreaterThanOrEqual(0);
    expect(totalSpent).toBeLessThanOrEqual(100);
    // Stronger: with clamping, every credit is spent exactly once.
    expect(totalSpent).toBe(100);
    expect(balance).toBe(0);
    for (const r of results) expect(r.spent).toBeGreaterThanOrEqual(0);
  });

  it('refuses a spend against an unknown account', async () => {
    await expect(
      spendCredits({ accountId: '00000000-0000-0000-0000-000000000000', amount: 1, reason: 'adjustment', idempotencyKey: 'x' }),
    ).rejects.toThrow(/not found/);
  });
});

describe('reconcileSends (I7)', () => {
  it('run with 100, 100, 150 spends 100 then 0 then 50', async () => {
    const account = await makeAccount(db);
    const campaign = await makeCampaign(account);
    await grantCredits({ accountId: account, amount: 1000, reason: 'grant_manual', idempotencyKey: 'g' });
    const day = '2026-10-23';

    const r1 = await reconcileSends({ accountId: account, campaignId: campaign, day, sentCount: 100 });
    expect(r1).toMatchObject({ spent: 100, requested: 100, billed_before: 0, billed_after: 100, clamped: false, shortfall: 0 });
    expect(r1.idempotency_key).toBe(`campaign:${campaign}:day:${day}`);
    expect(r1.idempotency_key).toBe(reconcileKey(campaign, day));

    const r2 = await reconcileSends({ accountId: account, campaignId: campaign, day, sentCount: 100 });
    expect(r2).toMatchObject({ spent: 0, requested: 0, billed_before: 100, billed_after: 100 });

    const r3 = await reconcileSends({ accountId: account, campaignId: campaign, day, sentCount: 150 });
    expect(r3).toMatchObject({ spent: 50, requested: 50, billed_before: 100, billed_after: 150 });
    expect(r3.idempotency_key).toBe(`campaign:${campaign}:day:${day}:100`);

    expect(await rawBalance(account)).toBe(850);
    const rows = await listLedger(account);
    const spends = rows.filter((r) => r.reason === 'spend_email_sent');
    expect(spends.length).toBe(2);
    for (const s of spends) expect(s.campaign_id).toBe(campaign);
  });

  it('never bills a lower count twice and keeps days separate', async () => {
    const account = await makeAccount(db);
    const campaign = await makeCampaign(account);
    await grantCredits({ accountId: account, amount: 1000, reason: 'grant_manual', idempotencyKey: 'g' });

    await reconcileSends({ accountId: account, campaignId: campaign, day: '2026-10-23', sentCount: 80 });
    const lower = await reconcileSends({ accountId: account, campaignId: campaign, day: '2026-10-23', sentCount: 50 });
    expect(lower.spent).toBe(0);
    const nextDay = await reconcileSends({ accountId: account, campaignId: campaign, day: '2026-10-24', sentCount: 20 });
    expect(nextDay.spent).toBe(20);
    expect(nextDay.billed_before).toBe(0);
    expect(await rawBalance(account)).toBe(900);
  });

  it('clamps to the balance, reports the shortfall, and bills it once credits arrive', async () => {
    const account = await makeAccount(db);
    const campaign = await makeCampaign(account);
    await grantCredits({ accountId: account, amount: 30, reason: 'grant_manual', idempotencyKey: 'g1' });

    const r1 = await reconcileSends({ accountId: account, campaignId: campaign, day: '2026-10-23', sentCount: 100 });
    expect(r1).toMatchObject({ spent: 30, requested: 100, clamped: true, shortfall: 70, balance_after: 0 });

    const r2 = await reconcileSends({ accountId: account, campaignId: campaign, day: '2026-10-23', sentCount: 100 });
    expect(r2).toMatchObject({ spent: 0, requested: 70, clamped: true, shortfall: 70 });
    expect(await rawBalance(account)).toBe(0);

    await grantCredits({ accountId: account, amount: 1000, reason: 'grant_renewal', idempotencyKey: 'g2' });
    const r3 = await reconcileSends({ accountId: account, campaignId: campaign, day: '2026-10-23', sentCount: 100 });
    expect(r3).toMatchObject({ spent: 70, requested: 70, clamped: false, shortfall: 0, billed_after: 100 });
    expect(await rawBalance(account)).toBe(930);
  });

  it('is safe under concurrent reconciles of the same campaign-day', async () => {
    const account = await makeAccount(db);
    const campaign = await makeCampaign(account);
    await grantCredits({ accountId: account, amount: 1000, reason: 'grant_manual', idempotencyKey: 'g' });

    await Promise.all(
      Array.from({ length: 4 }, () => reconcileSends({ accountId: account, campaignId: campaign, day: '2026-10-23', sentCount: 100 })),
    );
    // Four racing reports of the same 100 sends bill 100 exactly once.
    expect(await rawBalance(account)).toBe(900);
  });

  it('validates its inputs', async () => {
    const account = await makeAccount(db);
    const campaign = await makeCampaign(account);
    await expect(reconcileSends({ accountId: account, campaignId: campaign, day: '23/10/2026', sentCount: 1 })).rejects.toThrow(/YYYY-MM-DD/);
    await expect(reconcileSends({ accountId: account, campaignId: campaign, day: '2026-10-23', sentCount: -1 })).rejects.toThrow();
    await expect(reconcileSends({ accountId: account, campaignId: campaign, day: '2026-10-23', sentCount: 1.5 })).rejects.toThrow();
  });
});

describe('cost ledger', () => {
  it('records costs idempotently and summarises per category', async () => {
    const account = await makeAccount(db);
    const first = await recordCost({ accountId: account, costCents: 1200, category: 'lead_data', quantity: 400, idempotencyKey: 'leads:batch1' });
    const dup = await recordCost({ accountId: account, costCents: 1200, category: 'lead_data', quantity: 400, idempotencyKey: 'leads:batch1' });
    await recordCost({ accountId: account, costCents: 300, category: 'verification', quantity: 400, idempotencyKey: 'verify:batch1' });
    await recordCost({ accountId: account, costCents: 3000, category: 'mailbox', quantity: 1, idempotencyKey: 'mailbox:1' });
    await recordCost({ accountId: account, costCents: 3000, category: 'mailbox', quantity: 1, idempotencyKey: 'mailbox:2' });

    expect(first.duplicate).toBe(false);
    expect(dup.duplicate).toBe(true);
    expect(dup.recorded_cents).toBe(0);
    expect(dup.entry.id).toBe(first.entry.id);

    const summary = await getCostSummary(account);
    expect(summary.total_cents).toBe(7500);
    expect(summary.entries).toBe(4);
    expect(summary.by_category).toEqual({ lead_data: 1200, verification: 300, mailbox: 6000, domain: 0, llm: 0, other: 0 });
  });

  it('does not mix accounts', async () => {
    const a = await makeAccount(db, 'A');
    const b = await makeAccount(db, 'B');
    await recordCost({ accountId: a, costCents: 100, category: 'llm', idempotencyKey: 'k' });
    await recordCost({ accountId: b, costCents: 5, category: 'llm', idempotencyKey: 'k' });
    expect((await getCostSummary(a)).total_cents).toBe(100);
    expect((await getCostSummary(b)).total_cents).toBe(5);
  });

  it('rejects bad input', async () => {
    const account = await makeAccount(db);
    await expect(recordCost({ accountId: account, costCents: -1, category: 'llm', idempotencyKey: 'neg' })).rejects.toThrow();
    await expect(recordCost({ accountId: account, costCents: 1.5, category: 'llm', idempotencyKey: 'frac' })).rejects.toThrow();
    await expect(
      recordCost({ accountId: account, costCents: 1, category: 'bogus' as never, idempotencyKey: 'cat' }),
    ).rejects.toThrow();
  });
});

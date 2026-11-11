/**
 * Transaction isolation.
 *
 * The embedded backend runs on one connection, so a hand-rolled BEGIN/COMMIT does
 * not isolate concurrent transactions. These tests pin the behaviour the rest of the
 * codebase assumes: that `db.tx()` serialises, and that a throw rolls back.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { freshDb, dropDb, makeAccount } from '../helpers/db';
import type { Db } from '../../src/lib/db';

let db: Db;

beforeAll(async () => {
  db = await freshDb();
});
afterAll(dropDb);

describe('db.tx', () => {
  it('rolls back every write when the callback throws', async () => {
    const account = await makeAccount(db, 'Rollback Co');
    await expect(
      db.tx(async (t) => {
        await t.query(
          `insert into credit_ledger (account_id, delta, reason, idempotency_key)
           values ($1, 500, 'grant_manual', 'rollback-test')`,
          [account],
        );
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');

    const res = await db.query<{ n: string }>(
      `select count(*) as n from credit_ledger where account_id = $1`,
      [account],
    );
    expect(Number(res.rows[0]!.n)).toBe(0);
  });

  it('commits when the callback returns', async () => {
    const account = await makeAccount(db, 'Commit Co');
    const out = await db.tx(async (t) => {
      await t.query(
        `insert into credit_ledger (account_id, delta, reason, idempotency_key)
         values ($1, 700, 'grant_manual', 'commit-test')`,
        [account],
      );
      return 'done';
    });
    expect(out).toBe('done');

    const res = await db.query<{ total: string }>(
      `select coalesce(sum(delta), 0) as total from credit_ledger where account_id = $1`,
      [account],
    );
    expect(Number(res.rows[0]!.total)).toBe(700);
  });

  it('serialises concurrent transactions instead of interleaving them', async () => {
    const account = await makeAccount(db, 'Serial Co');

    // Each transaction reads the balance, waits, then writes a row bringing the
    // total to a fixed target. Interleaved reads would both see 0 and overshoot.
    const bump = () =>
      db.tx(async (t) => {
        const cur = await t.query<{ total: string }>(
          `select coalesce(sum(delta), 0) as total from credit_ledger where account_id = $1`,
          [account],
        );
        const balance = Number(cur.rows[0]!.total);
        await new Promise((r) => setTimeout(r, 15));
        if (balance >= 100) return 'skipped';
        await t.query(
          `insert into credit_ledger (account_id, delta, reason, idempotency_key)
           values ($1, 100, 'grant_manual', $2)`,
          [account, `serial-${balance}`],
        );
        return 'wrote';
      });

    const results = await Promise.all([bump(), bump(), bump()]);

    const res = await db.query<{ total: string }>(
      `select coalesce(sum(delta), 0) as total from credit_ledger where account_id = $1`,
      [account],
    );
    // Exactly one transaction should have written: the others see the committed 100.
    expect(Number(res.rows[0]!.total)).toBe(100);
    expect(results.filter((r) => r === 'wrote')).toHaveLength(1);
  });

  it('allows a nested tx() call without deadlocking', async () => {
    const account = await makeAccount(db, 'Nested Co');
    await db.tx(async (t) => {
      await t.tx(async (inner) => {
        await inner.query(
          `insert into credit_ledger (account_id, delta, reason, idempotency_key)
           values ($1, 42, 'grant_manual', 'nested-test')`,
          [account],
        );
      });
    });
    const res = await db.query<{ total: string }>(
      `select coalesce(sum(delta), 0) as total from credit_ledger where account_id = $1`,
      [account],
    );
    expect(Number(res.rows[0]!.total)).toBe(42);
  });
});

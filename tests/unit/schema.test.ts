/**
 * Schema invariants. These assert the things the database itself must refuse,
 * because the application layer is not the last line of defence for money.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { freshDb, dropDb, makeAccount } from '../helpers/db';
import type { Db } from '../../src/lib/db';

let db: Db;

beforeAll(async () => {
  db = await freshDb();
});
afterAll(dropDb);

describe('schema', () => {
  it('creates every table the contract needs', async () => {
    const res = await db.query<{ table_name: string }>(
      `select table_name from information_schema.tables where table_schema = 'public'`,
    );
    const tables = res.rows.map((r) => r.table_name);
    for (const t of [
      'accounts', 'users', 'sessions', 'redemption_codes', 'subscriptions', 'stripe_events',
      'onboarding_profiles', 'strategies', 'domains', 'mailboxes', 'leads', 'suppressions',
      'campaigns', 'campaign_copy', 'campaign_leads', 'reply_messages', 'daily_send_stats',
      'credit_ledger', 'cost_ledger', 'jobs', 'approvals', 'events', 'unsubscribes',
    ]) {
      expect(tables, `missing table ${t}`).toContain(t);
    }
  });

  it('has no mutable credit balance column anywhere (I1)', async () => {
    const res = await db.query<{ table_name: string; column_name: string }>(
      `select table_name, column_name from information_schema.columns
       where table_schema = 'public' and column_name in ('credits','balance','credit_balance')`,
    );
    expect(res.rows).toEqual([]);
  });
});

describe('credit ledger (I1)', () => {
  it('rejects a duplicate idempotency key for the same account', async () => {
    const account = await makeAccount(db);
    const insert = () =>
      db.query(
        `insert into credit_ledger (account_id, delta, reason, idempotency_key)
         values ($1, 30000, 'grant_redemption', 'redeem:CODE1')`,
        [account],
      );

    await insert();
    await expect(insert()).rejects.toThrow();

    const bal = await db.query<{ balance: string }>(
      `select coalesce(sum(delta), 0) as balance from credit_ledger where account_id = $1`,
      [account],
    );
    expect(Number(bal.rows[0]!.balance)).toBe(30000);
  });

  it('allows the same idempotency key for a different account', async () => {
    const a = await makeAccount(db, 'A Co');
    const b = await makeAccount(db, 'B Co');
    const grant = (id: string) =>
      db.query(
        `insert into credit_ledger (account_id, delta, reason, idempotency_key)
         values ($1, 100, 'grant_manual', 'same-key')`,
        [id],
      );
    await grant(a);
    await expect(grant(b)).resolves.toBeDefined();
  });

  it('refuses a zero delta', async () => {
    const account = await makeAccount(db);
    await expect(
      db.query(
        `insert into credit_ledger (account_id, delta, reason, idempotency_key)
         values ($1, 0, 'adjustment', 'zero')`,
        [account],
      ),
    ).rejects.toThrow();
  });
});

describe('job queue (I5)', () => {
  it('refuses a second pending job with the same type and dedupe key', async () => {
    const account = await makeAccount(db);
    const enqueue = () =>
      db.query(
        `insert into jobs (account_id, type, dedupe_key) values ($1, 'source_leads', 'camp-1')`,
        [account],
      );
    await enqueue();
    await expect(enqueue()).rejects.toThrow();
  });

  it('allows a re-queue once the earlier job reached a terminal state', async () => {
    const account = await makeAccount(db);
    await db.query(
      `insert into jobs (account_id, type, dedupe_key, status)
       values ($1, 'sync_stats', 'camp-2', 'succeeded')`,
      [account],
    );
    await expect(
      db.query(`insert into jobs (account_id, type, dedupe_key) values ($1, 'sync_stats', 'camp-2')`, [account]),
    ).resolves.toBeDefined();
  });
});

describe('suppression (I3)', () => {
  it('keeps global and per-account suppressions separate', async () => {
    const account = await makeAccount(db);
    await db.query(`insert into suppressions (email, reason) values ('x@acme.com', 'global_complaint')`);
    await expect(
      db.query(`insert into suppressions (account_id, email, reason) values ($1, 'x@acme.com', 'customer_request')`, [
        account,
      ]),
    ).resolves.toBeDefined();
    // ...but not two identical global rows.
    await expect(
      db.query(`insert into suppressions (email, reason) values ('x@acme.com', 'dup')`),
    ).rejects.toThrow();
  });

  it('requires either an email or a domain', async () => {
    await expect(db.query(`insert into suppressions (reason) values ('nothing')`)).rejects.toThrow();
  });
});

describe('stripe idempotency (I4)', () => {
  it('refuses to record the same event id twice', async () => {
    await db.query(`insert into stripe_events (id, type) values ('evt_1', 'invoice.paid')`);
    await expect(
      db.query(`insert into stripe_events (id, type) values ('evt_1', 'invoice.paid')`),
    ).rejects.toThrow();
  });
});

describe('tenancy (I2)', () => {
  it('cascades tenant data when an account is deleted', async () => {
    const account = await makeAccount(db);
    await db.query(
      `insert into credit_ledger (account_id, delta, reason, idempotency_key)
       values ($1, 10, 'grant_manual', 'cascade')`,
      [account],
    );
    await db.query(`delete from accounts where id = $1`, [account]);
    const left = await db.query(`select 1 from credit_ledger where account_id = $1`, [account]);
    expect(left.rows).toEqual([]);
  });
});

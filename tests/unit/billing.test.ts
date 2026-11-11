/**
 * Stripe event handling.
 *
 * The build brief names webhook logic as one of three things not to ship without
 * review. These tests pin the behaviour that matters: an event is applied exactly
 * once, a replay cannot grant credits twice, a FAILED event can still be retried,
 * and losing the subscription stops sending.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { freshDb, dropDb } from '../helpers/db';
import { handleStripeEvent, type StripeEventLike } from '../../src/lib/billing';
import { getCreditSummary } from '../../src/lib/ledger';
import type { Db } from '../../src/lib/db';

let db: Db;
let seq = 0;

beforeAll(async () => {
  db = await freshDb();
  await db.query(
    `insert into redemption_codes (code, partner, credits_granted, trial_days, max_redemptions)
     values ('NET30K', 'startup-network', 30000, 30, 5000)`,
  );
});
afterAll(dropDb);

async function makeAccountWithSub(): Promise<{ accountId: string; subId: string }> {
  seq += 1;
  const acc = await db.query<{ id: string }>(
    `insert into accounts (company_name, status) values ($1, 'trialing') returning id`,
    [`Billing Co ${seq}`],
  );
  return { accountId: acc.rows[0]!.id, subId: `sub_test_${seq}` };
}

function checkoutEvent(accountId: string, subId: string, code: string | null, id: string): StripeEventLike {
  return {
    id,
    type: 'checkout.session.completed',
    data: {
      object: {
        id: `cs_${id}`,
        client_reference_id: accountId,
        customer: `cus_${accountId.slice(0, 8)}`,
        subscription: subId,
        metadata: { account_id: accountId, code: code ?? '' },
      },
    },
  };
}

beforeEach(() => {
  seq += 1;
});

describe('checkout.session.completed', () => {
  it('links the subscription and grants the code credits exactly once', async () => {
    const { accountId, subId } = await makeAccountWithSub();
    const event = checkoutEvent(accountId, subId, 'NET30K', `evt_a_${seq}`);

    const first = await handleStripeEvent(event);
    expect(first.duplicate).toBe(false);

    const credits = await getCreditSummary(accountId);
    expect(credits.balance).toBe(30000);

    const sub = await db.query<{ stripe_subscription_id: string; redemption_code: string }>(
      `select stripe_subscription_id, redemption_code from subscriptions where account_id = $1`,
      [accountId],
    );
    expect(sub.rows[0]?.stripe_subscription_id).toBe(subId);
    expect(sub.rows[0]?.redemption_code).toBe('NET30K');
  });

  it('is a no-op when Stripe redelivers the same event id (I4)', async () => {
    const { accountId, subId } = await makeAccountWithSub();
    const event = checkoutEvent(accountId, subId, 'NET30K', `evt_b_${seq}`);

    await handleStripeEvent(event);
    const replay = await handleStripeEvent(event);

    expect(replay.duplicate).toBe(true);
    const credits = await getCreditSummary(accountId);
    expect(credits.balance).toBe(30000);
  });

  it('cannot double-grant even when a DIFFERENT event id carries the same redemption', async () => {
    // Stripe documents that two distinct Event objects are sometimes generated for
    // one occurrence, so event-id dedupe alone is not enough. The ledger key is.
    const { accountId, subId } = await makeAccountWithSub();
    await handleStripeEvent(checkoutEvent(accountId, subId, 'NET30K', `evt_c1_${seq}`));
    await handleStripeEvent(checkoutEvent(accountId, subId, 'NET30K', `evt_c2_${seq}`));

    const credits = await getCreditSummary(accountId);
    expect(credits.balance).toBe(30000);
  });

  it('grants only the small fallback when the code is unknown, not the launch amount', async () => {
    const { accountId, subId } = await makeAccountWithSub();
    await handleStripeEvent(checkoutEvent(accountId, subId, 'NOPE', `evt_d_${seq}`));

    const credits = await getCreditSummary(accountId);
    // The customer is not turned away, but an invalid code must not be worth the
    // same as a valid one.
    expect(credits.balance).toBeGreaterThan(0);
    expect(credits.balance).toBeLessThan(30000);

    const logged = await db.query(
      `select 1 from events where account_id = $1 and type = 'billing.unknown_code'`,
      [accountId],
    );
    expect(logged.rows).toHaveLength(1);
  });

  it('enforces max_redemptions atomically under concurrency', async () => {
    await db.query(
      `insert into redemption_codes (code, partner, credits_granted, trial_days, max_redemptions)
       values ('CAPPED2', 'partner', 5000, 30, 2)`,
    );

    // Three accounts race for two slots.
    const accounts = await Promise.all([makeAccountWithSub(), makeAccountWithSub(), makeAccountWithSub()]);
    await Promise.all(
      accounts.map((a, i) => handleStripeEvent(checkoutEvent(a.accountId, a.subId, 'CAPPED2', `evt_cap_${seq}_${i}`))),
    );

    const code = await db.query<{ times_redeemed: number }>(
      `select times_redeemed from redemption_codes where code = 'CAPPED2'`,
    );
    expect(Number(code.rows[0]!.times_redeemed), 'the cap must not be overshot').toBe(2);

    const balances = await Promise.all(accounts.map((a) => getCreditSummary(a.accountId)));
    const full = balances.filter((b) => b.balance === 5000);
    expect(full, 'exactly two accounts should get the code amount').toHaveLength(2);
  });

  it('does not grant twice if a second checkout completes for the same account', async () => {
    const { accountId, subId } = await makeAccountWithSub();
    await handleStripeEvent(checkoutEvent(accountId, subId, 'NET30K', `evt_r1_${seq}`));
    await handleStripeEvent(checkoutEvent(accountId, `${subId}-b`, 'NET30K', `evt_r2_${seq}`));

    const credits = await getCreditSummary(accountId);
    expect(credits.granted).toBe(30000);
  });

  it('releases its claim when processing throws, so a retry can still work', async () => {
    // A checkout for an account that does not exist fails on the foreign key.
    const missing = '00000000-0000-0000-0000-000000000000';
    const event = checkoutEvent(missing, `sub_missing_${seq}`, 'NET30K', `evt_e_${seq}`);

    await expect(handleStripeEvent(event)).rejects.toThrow();

    const claimed = await db.query(`select 1 from stripe_events where id = $1`, [event.id]);
    expect(claimed.rows, 'a failed event must not stay claimed').toHaveLength(0);
  });
});

describe('subscription lifecycle', () => {
  it('mirrors subscription.created and .updated, including the status column', async () => {
    // Regression: the UPDATE referenced five placeholders but was given four
    // arguments with `status` missing, so EVERY subscription event threw and Stripe
    // retried for three days. Nothing covered these two event types.
    const { accountId, subId } = await makeAccountWithSub();
    await handleStripeEvent(checkoutEvent(accountId, subId, null, `evt_sc_${seq}`));

    const created = await handleStripeEvent({
      id: `evt_created_${seq}`,
      type: 'customer.subscription.created',
      data: { object: { id: subId, status: 'trialing', trial_end: 1800000000, current_period_end: 1800000000 } },
    });
    expect(created.action).toBe('subscription_trialing');

    const updated = await handleStripeEvent({
      id: `evt_updated_${seq}`,
      type: 'customer.subscription.updated',
      data: { object: { id: subId, status: 'active', cancel_at_period_end: true } },
    });
    expect(updated.action).toBe('subscription_active');

    const row = await db.query<{ status: string; cancel_at_period_end: boolean }>(
      `select status, cancel_at_period_end from subscriptions where stripe_subscription_id = $1`,
      [subId],
    );
    expect(row.rows[0]?.status).toBe('active');
    expect(row.rows[0]?.cancel_at_period_end).toBe(true);
  });

  it('pauses sending when a subscription goes past_due', async () => {
    const { accountId, subId } = await makeAccountWithSub();
    await handleStripeEvent(checkoutEvent(accountId, subId, null, `evt_pd0_${seq}`));
    await handleStripeEvent({
      id: `evt_pd_${seq}`,
      type: 'customer.subscription.updated',
      data: { object: { id: subId, status: 'past_due' } },
    });
    const acc = await db.query<{ status: string; sending_paused: boolean }>(
      `select status, sending_paused from accounts where id = $1`, [accountId],
    );
    expect(acc.rows[0]?.status).toBe('past_due');
    expect(acc.rows[0]?.sending_paused).toBe(true);
  });

  it('pauses sending when the subscription is deleted', async () => {
    const { accountId, subId } = await makeAccountWithSub();
    await handleStripeEvent(checkoutEvent(accountId, subId, null, `evt_f_${seq}`));

    const result = await handleStripeEvent({
      id: `evt_g_${seq}`,
      type: 'customer.subscription.deleted',
      data: { object: { id: subId, status: 'canceled' } },
    });
    expect(result.action).toContain('sending_paused');

    const acc = await db.query<{ status: string; sending_paused: boolean }>(
      `select status, sending_paused from accounts where id = $1`,
      [accountId],
    );
    expect(acc.rows[0]?.status).toBe('cancelled');
    expect(acc.rows[0]?.sending_paused).toBe(true);
  });

  it('pauses on a failed invoice and resumes on a paid one', async () => {
    const { accountId, subId } = await makeAccountWithSub();
    await handleStripeEvent(checkoutEvent(accountId, subId, null, `evt_h_${seq}`));

    await handleStripeEvent({
      id: `evt_i_${seq}`,
      type: 'invoice.payment_failed',
      data: { object: { id: `in_fail_${seq}`, subscription: subId } },
    });
    let acc = await db.query<{ status: string; sending_paused: boolean }>(
      `select status, sending_paused from accounts where id = $1`, [accountId],
    );
    expect(acc.rows[0]?.status).toBe('past_due');
    expect(acc.rows[0]?.sending_paused).toBe(true);

    await handleStripeEvent({
      id: `evt_j_${seq}`,
      type: 'invoice.paid',
      data: { object: { id: `in_ok_${seq}`, subscription: subId, amount_paid: 200000 } },
    });
    acc = await db.query<{ status: string; sending_paused: boolean }>(
      `select status, sending_paused from accounts where id = $1`, [accountId],
    );
    expect(acc.rows[0]?.status).toBe('active');
    expect(acc.rows[0]?.sending_paused).toBe(false);
  });

  it('does not grant credits for the $0 invoice at trial start', async () => {
    const { accountId, subId } = await makeAccountWithSub();
    await handleStripeEvent(checkoutEvent(accountId, subId, 'NET30K', `evt_k_${seq}`));
    const before = await getCreditSummary(accountId);

    const res = await handleStripeEvent({
      id: `evt_l_${seq}`,
      type: 'invoice.paid',
      data: { object: { id: `in_zero_${seq}`, subscription: subId, amount_paid: 0 } },
    });

    expect(res.action).toContain('zero_amount');
    const after = await getCreditSummary(accountId);
    expect(after.balance).toBe(before.balance);
  });

  it('reads the subscription id from the nested invoice shape too', async () => {
    // Newer Stripe API versions nest it under parent.subscription_details.
    const { accountId, subId } = await makeAccountWithSub();
    await handleStripeEvent(checkoutEvent(accountId, subId, null, `evt_m_${seq}`));

    const res = await handleStripeEvent({
      id: `evt_n_${seq}`,
      type: 'invoice.paid',
      data: {
        object: {
          id: `in_nested_${seq}`,
          amount_paid: 200000,
          parent: { subscription_details: { subscription: subId } },
        },
      },
    });
    expect(res.action).toContain('renewed');
  });

  it('records but ignores an event type it does not handle', async () => {
    const res = await handleStripeEvent({
      id: `evt_o_${seq}`,
      type: 'customer.updated',
      data: { object: { id: 'cus_x' } },
    });
    expect(res.handled).toBe(false);
    expect(res.action).toContain('ignored');
  });
});

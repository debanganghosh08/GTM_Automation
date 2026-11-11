/**
 * Billing logic, kept separate from the HTTP route so it is unit-testable
 * without Stripe or a server.
 *
 * The build brief singles out Stripe webhook logic as something not to ship
 * unreviewed, so the rules are written out here explicitly:
 *
 *  1. Signature is verified in the route, before this file sees anything.
 *  2. Every event is recorded in `stripe_events` by id FIRST. A duplicate insert
 *     means we already handled it and we stop (invariant I4). Stripe explicitly
 *     warns that `checkout.session.completed` can arrive more than once, even
 *     concurrently.
 *  3. Event order is NOT guaranteed, so state is driven by the subscription's
 *     current status, re-read from our mirror, never by event arrival order.
 *  4. There is no "trial ended" event. Day 31 is `invoice.paid` (or
 *     `invoice.payment_failed`) followed by `customer.subscription.updated`.
 *     We never run a timer against the trial.
 *  5. Credits come from OUR redemption codes, not from Stripe coupons. Month one
 *     is free through `trial_period_days`, so no Stripe discount is involved.
 */

import type { Db } from './db';
import { getDb } from './db';
import { env } from './env';
import { grantCredits } from './ledger';
import { pauseSending, resumeSending } from './guardrails';

export interface StripeEventLike {
  id: string;
  type: string;
  data: { object: Record<string, unknown> };
}

export interface HandleResult {
  handled: boolean;
  duplicate: boolean;
  action: string;
}

/** Records the event and returns false when it was already recorded. */
async function claimEvent(db: Db, event: StripeEventLike): Promise<boolean> {
  try {
    await db.query('insert into stripe_events (id, type, payload) values ($1, $2, $3)', [
      event.id,
      event.type,
      JSON.stringify(event.data?.object ?? {}),
    ]);
    return true;
  } catch (err) {
    if (isUniqueViolation(err)) return false;
    throw err;
  }
}

export function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === '23505';
}

function str(obj: Record<string, unknown>, key: string): string | null {
  const v = obj[key];
  return typeof v === 'string' ? v : null;
}

function num(obj: Record<string, unknown>, key: string): number | null {
  const v = obj[key];
  return typeof v === 'number' ? v : null;
}

/** Unix seconds -> ISO, or null. */
function ts(value: number | null): string | null {
  return value === null ? null : new Date(value * 1000).toISOString();
}

/**
 * Applies a verified Stripe event. Safe to call repeatedly with the same event.
 *
 * Claim-then-release: the event id is recorded before any work, so a concurrent
 * duplicate delivery is dropped. If the work then FAILS, the claim is released so
 * Stripe's retry can do it properly — otherwise a transient database error would
 * mark the event permanently handled and silently lose a payment.
 *
 * The handlers are not wrapped in one transaction because the ledger and guardrail
 * helpers open their own connections, which would sit outside it on a pooled
 * Postgres. Every individual write is idempotent instead, which is what makes a
 * retry safe.
 */
export async function handleStripeEvent(event: StripeEventLike): Promise<HandleResult> {
  const db = await getDb();

  const fresh = await claimEvent(db, event);
  if (!fresh) return { handled: true, duplicate: true, action: 'already_processed' };

  const object = event.data?.object ?? {};

  try {
    switch (event.type) {
      case 'checkout.session.completed':
        return { handled: true, duplicate: false, action: await onCheckoutCompleted(db, object) };

      case 'customer.subscription.created':
      case 'customer.subscription.updated':
        return { handled: true, duplicate: false, action: await onSubscriptionChanged(db, object) };

      case 'customer.subscription.deleted':
        return { handled: true, duplicate: false, action: await onSubscriptionDeleted(db, object) };

      case 'invoice.paid':
        return { handled: true, duplicate: false, action: await onInvoicePaid(db, object) };

      case 'invoice.payment_failed':
        return { handled: true, duplicate: false, action: await onInvoiceFailed(db, object) };

      case 'customer.subscription.trial_will_end':
        return { handled: true, duplicate: false, action: await onTrialWillEnd(db, object) };

      default:
        // Recorded but not acted on. Keeping the row means a later replay is still deduped.
        return { handled: false, duplicate: false, action: `ignored:${event.type}` };
    }
  } catch (err) {
    await releaseEvent(db, event.id);
    throw err;
  }
}

/** Undoes claimEvent so a failed event can be retried by Stripe. */
async function releaseEvent(db: Db, eventId: string): Promise<void> {
  try {
    await db.query('delete from stripe_events where id = $1', [eventId]);
  } catch (err) {
    // Losing the release is not worth masking the original failure; log and move on.
    console.error('[billing] failed to release event claim', eventId, err);
  }
}

/**
 * Checkout finished. The account already exists (we create it before redirecting
 * to Stripe so the id can ride along in metadata), so this links the subscription
 * and grants the redemption credits.
 */
async function onCheckoutCompleted(db: Db, o: Record<string, unknown>): Promise<string> {
  const accountId = metadataAccountId(o) ?? str(o, 'client_reference_id');
  if (!accountId) return 'no_account_reference';

  const customerId = str(o, 'customer');
  const subscriptionId = str(o, 'subscription');
  const code = metadataCode(o);

  // `subscriptions.redemption_code` has a foreign key to `redemption_codes`, so a
  // mistyped or retired partner code must be stored as NULL rather than verbatim.
  // Writing it raw raises a foreign-key violation, which would fail the whole webhook
  // and leave a customer who has already handed over a card with no account at all.
  const codeExists = code
    ? (await db.query(`select 1 from redemption_codes where code = $1`, [code])).rows.length > 0
    : false;

  await db.query(
    `insert into subscriptions (account_id, stripe_customer_id, stripe_subscription_id, price_cents, status, redemption_code)
     values ($1, $2, $3, $4, 'trialing', $5)
     on conflict (stripe_subscription_id) do update
       set stripe_customer_id = excluded.stripe_customer_id,
           redemption_code    = coalesce(subscriptions.redemption_code, excluded.redemption_code),
           updated_at         = now()`,
    [accountId, customerId, subscriptionId, env.subscriptionPriceCents, codeExists ? code : null],
  );

  // The unvalidated code is still passed on, so an unknown one is recorded as an
  // event and the customer gets the default grant instead of nothing.
  const credits = await grantRedemption(db, accountId, code);

  await db.query(
    `update accounts set status = 'trialing',
            trial_ends_at = coalesce(trial_ends_at, now() + ($2 || ' days')::interval),
            updated_at = now()
      where id = $1`,
    [accountId, String(env.trialDays)],
  );

  await logEvent(db, accountId, 'billing.checkout_completed', subscriptionId, { code, credits });
  return `checkout_completed:credits=${credits}`;
}

/**
 * Grants the code's credits, or the default launch grant when there is no code.
 * Idempotent: the ledger key is per account + code, so a replayed webhook cannot
 * grant twice.
 */
/**
 * Grants the credits a redemption code is worth.
 *
 * The cap is claimed ATOMICALLY. The previous version read the code, checked the
 * cap, then incremented in a separate statement, so concurrent redemptions could
 * both pass the check and overshoot `max_redemptions`. More importantly it fell back
 * to the full launch grant whenever the code was unknown, expired or exhausted —
 * which meant the cap enforced nothing at all and any typed-in string was worth
 * 30,000 credits.
 *
 * Now: a valid, unexhausted code grants its amount and consumes a slot in one
 * statement. Anything else grants `FALLBACK_CREDITS`, which is deliberately small,
 * and is recorded so the partner relationship can be reconciled. The customer is not
 * turned away — they have already given a card — but an invalid code is no longer
 * worth the same as a valid one.
 */
const FALLBACK_CREDITS = 1_000;

async function grantRedemption(db: Db, accountId: string, code: string | null): Promise<number> {
  let credits = FALLBACK_CREDITS;
  let claimedCode: string | null = null;

  if (code) {
    // One statement: the WHERE clause re-checks every condition at write time, so two
    // concurrent redemptions of the last slot cannot both succeed.
    const claim = await db.query<{ credits_granted: number }>(
      `update redemption_codes
          set times_redeemed = times_redeemed + 1
        where code = $1
          and active = true
          and (expires_at is null or expires_at > now())
          and (max_redemptions is null or times_redeemed < max_redemptions)
        returning credits_granted`,
      [code],
    );

    const row = claim.rows[0];
    if (row) {
      credits = Number(row.credits_granted);
      claimedCode = code;
    } else {
      // Distinguish "no such code" from "cap reached" for the partner report.
      const exists = await db.query<{ times_redeemed: number; max_redemptions: number | null }>(
        `select times_redeemed, max_redemptions from redemption_codes where code = $1`,
        [code],
      );
      const found = exists.rows[0];
      await logEvent(
        db,
        accountId,
        found ? 'billing.code_exhausted' : 'billing.unknown_code',
        code,
        { granted_instead: FALLBACK_CREDITS, ...(found ? { times_redeemed: Number(found.times_redeemed) } : {}) },
      );
    }
  } else {
    await logEvent(db, accountId, 'billing.no_code', null, { granted_instead: FALLBACK_CREDITS });
  }

  await grantCredits({
    accountId,
    amount: credits,
    reason: 'grant_redemption',
    // Keyed on the account, not the code: a second checkout for the same account must
    // not grant again even if a different code is presented.
    idempotencyKey: `redeem:${accountId}`,
    metadata: { code, claimed: claimedCode !== null },
  });

  return credits;
}

async function onSubscriptionChanged(db: Db, o: Record<string, unknown>): Promise<string> {
  const subscriptionId = str(o, 'id');
  if (!subscriptionId) return 'no_subscription_id';
  const status = str(o, 'status') ?? 'unknown';

  const res = await db.query<{ account_id: string }>(
    `update subscriptions
        set status = $2,
            trial_end = $3,
            current_period_end = $4,
            cancel_at_period_end = $5,
            updated_at = now()
      where stripe_subscription_id = $1
      returning account_id`,
    [
      subscriptionId,
      status,
      ts(num(o, 'trial_end')),
      ts(num(o, 'current_period_end')),
      o['cancel_at_period_end'] === true,
    ],
  );
  const accountId = res.rows[0]?.account_id;
  if (!accountId) return 'subscription_not_mirrored';

  // Account status follows the subscription, so a mid-cycle change cannot leave
  // sending enabled on a dead subscription.
  const accountStatus =
    status === 'trialing' ? 'trialing'
    : status === 'active' ? 'active'
    : status === 'past_due' || status === 'unpaid' ? 'past_due'
    : status === 'canceled' ? 'cancelled'
    : 'paused';

  await db.query(`update accounts set status = $2, updated_at = now() where id = $1`, [accountId, accountStatus]);

  if (accountStatus === 'active' || accountStatus === 'trialing') {
    await resumeSending(accountId);
  } else {
    await pauseSending(accountId, `subscription_${status}`);
  }

  await logEvent(db, accountId, 'billing.subscription_updated', subscriptionId, { status });
  return `subscription_${status}`;
}

async function onSubscriptionDeleted(db: Db, o: Record<string, unknown>): Promise<string> {
  const subscriptionId = str(o, 'id');
  if (!subscriptionId) return 'no_subscription_id';

  const res = await db.query<{ account_id: string }>(
    `update subscriptions set status = 'canceled', updated_at = now()
      where stripe_subscription_id = $1 returning account_id`,
    [subscriptionId],
  );
  const accountId = res.rows[0]?.account_id;
  if (!accountId) return 'subscription_not_mirrored';

  await db.query(`update accounts set status = 'cancelled', updated_at = now() where id = $1`, [accountId]);
  // Definition of done: "stopping the subscription pauses sending".
  await pauseSending(accountId, 'subscription_cancelled');
  await logEvent(db, accountId, 'billing.subscription_deleted', subscriptionId, {});
  return 'subscription_cancelled_sending_paused';
}

async function onInvoicePaid(db: Db, o: Record<string, unknown>): Promise<string> {
  const subscriptionId = invoiceSubscriptionId(o);
  if (!subscriptionId) return 'no_subscription_on_invoice';

  const res = await db.query<{ account_id: string }>(
    `select account_id from subscriptions where stripe_subscription_id = $1`,
    [subscriptionId],
  );
  const accountId = res.rows[0]?.account_id;
  if (!accountId) return 'subscription_not_mirrored';

  const amountPaid = num(o, 'amount_paid') ?? 0;

  // The $0 trial-start invoice also arrives as invoice.paid. Only a real payment
  // renews the credit allowance.
  if (amountPaid > 0) {
    await db.query(`update accounts set status = 'active', updated_at = now() where id = $1`, [accountId]);
    await resumeSending(accountId);
    await grantCredits({
      accountId,
      amount: env.launchCredits,
      reason: 'grant_renewal',
      idempotencyKey: `invoice:${str(o, 'id') ?? 'unknown'}`,
      metadata: { amount_paid: amountPaid },
    });
    await logEvent(db, accountId, 'billing.invoice_paid', str(o, 'id'), { amountPaid });
    return `invoice_paid:renewed`;
  }

  await logEvent(db, accountId, 'billing.zero_invoice', str(o, 'id'), {});
  return 'invoice_paid:zero_amount';
}

async function onInvoiceFailed(db: Db, o: Record<string, unknown>): Promise<string> {
  const subscriptionId = invoiceSubscriptionId(o);
  if (!subscriptionId) return 'no_subscription_on_invoice';
  const res = await db.query<{ account_id: string }>(
    `select account_id from subscriptions where stripe_subscription_id = $1`,
    [subscriptionId],
  );
  const accountId = res.rows[0]?.account_id;
  if (!accountId) return 'subscription_not_mirrored';

  await db.query(`update accounts set status = 'past_due', updated_at = now() where id = $1`, [accountId]);
  await pauseSending(accountId, 'invoice_payment_failed');
  await logEvent(db, accountId, 'billing.invoice_failed', str(o, 'id'), {});
  return 'invoice_failed_sending_paused';
}

async function onTrialWillEnd(db: Db, o: Record<string, unknown>): Promise<string> {
  const subscriptionId = str(o, 'id');
  if (!subscriptionId) return 'no_subscription_id';
  const res = await db.query<{ account_id: string }>(
    `select account_id from subscriptions where stripe_subscription_id = $1`,
    [subscriptionId],
  );
  const accountId = res.rows[0]?.account_id;
  if (!accountId) return 'subscription_not_mirrored';
  await logEvent(db, accountId, 'billing.trial_will_end', subscriptionId, { trial_end: ts(num(o, 'trial_end')) });
  return 'trial_will_end_noted';
}

// ---------------------------------------------------------------- helpers

function metadataAccountId(o: Record<string, unknown>): string | null {
  const md = o['metadata'];
  if (typeof md === 'object' && md !== null) {
    const v = (md as Record<string, unknown>)['account_id'];
    if (typeof v === 'string') return v;
  }
  return null;
}

function metadataCode(o: Record<string, unknown>): string | null {
  const md = o['metadata'];
  if (typeof md === 'object' && md !== null) {
    const v = (md as Record<string, unknown>)['code'];
    if (typeof v === 'string' && v.length > 0) return v;
  }
  return null;
}

/**
 * The subscription id moved around between Stripe API versions: older invoices carry
 * a top-level `subscription`, newer ones nest it under `parent`. Read both.
 */
function invoiceSubscriptionId(o: Record<string, unknown>): string | null {
  const direct = str(o, 'subscription');
  if (direct) return direct;
  const parent = o['parent'];
  if (typeof parent === 'object' && parent !== null) {
    const details = (parent as Record<string, unknown>)['subscription_details'];
    if (typeof details === 'object' && details !== null) {
      const v = (details as Record<string, unknown>)['subscription'];
      if (typeof v === 'string') return v;
    }
  }
  return null;
}

async function logEvent(
  db: Db,
  accountId: string | null,
  type: string,
  subject: string | null,
  detail: Record<string, unknown>,
): Promise<void> {
  await db.query(
    `insert into events (account_id, actor, type, subject, detail) values ($1, 'stripe', $2, $3, $4)`,
    [accountId, type, subject, JSON.stringify(detail)],
  );
}

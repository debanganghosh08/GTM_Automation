/**
 * Mock billing. Checkout "redirects" to a local route that completes the
 * session, and webhooks are signed with a scheme any test can reproduce.
 *
 * Signature scheme: the header value is `mock-sig=<fnv1a-32 hex of the raw body>`.
 * Produce it with `signMockWebhook(rawBody)`. Anything else is rejected, so a
 * test that forgets to sign fails the same way an unsigned Stripe call would.
 */

import type { BillingProvider, Uuid } from '../../lib/contracts';
import { env } from '../../lib/env';
import { fnv1a, hex8 } from './hash';

const SIGNATURE_PREFIX = 'mock-sig=';

export interface MockCheckoutSession {
  session_id: string;
  account_id: Uuid;
  email: string;
  code: string | null;
  trial_days: number;
  price_cents: number;
  success_url: string;
  cancel_url: string;
}

const sessions = new Map<string, MockCheckoutSession>();
const cancelled = new Set<string>();

export function signMockWebhook(rawBody: string): string {
  return `${SIGNATURE_PREFIX}${hex8(fnv1a(rawBody))}`;
}

/** The local checkout-complete route looks the session up by id. */
export function __getMockCheckoutSession(sessionId: string): MockCheckoutSession | null {
  return sessions.get(sessionId) ?? null;
}

export function __mockCancelledSubscriptions(): string[] {
  return [...cancelled];
}

export function __resetMockBilling(): void {
  sessions.clear();
  cancelled.clear();
}

export class MockBillingProvider implements BillingProvider {
  readonly name = 'mock-stripe';

  async createCheckoutSession(input: {
    account_id: Uuid;
    email: string;
    code?: string;
    trial_days: number;
    price_cents: number;
    success_url: string;
    cancel_url: string;
  }): Promise<{ url: string; session_id: string }> {
    const session_id = `mock_cs_${hex8(fnv1a(`${input.account_id}:${input.email}:${input.code ?? ''}`))}`;
    sessions.set(session_id, {
      session_id,
      account_id: input.account_id,
      email: input.email,
      code: input.code ?? null,
      trial_days: input.trial_days,
      price_cents: input.price_cents,
      success_url: input.success_url,
      cancel_url: input.cancel_url,
    });
    const url = new URL('/api/mock/checkout-complete', env.appUrl);
    url.searchParams.set('session_id', session_id);
    url.searchParams.set('account_id', input.account_id);
    // The redemption code has to survive the round trip. Live Stripe carries it in
    // subscription metadata; the mock path has only this URL, and without it every
    // offline signup fell through to the small fallback grant instead of the code's
    // real amount — which made the demo look like the offer was not being honoured.
    if (input.code) url.searchParams.set('code', input.code);
    return { url: url.toString(), session_id };
  }

  async verifyWebhook(rawBody: string, signature: string): Promise<{ id: string; type: string; data: unknown }> {
    if (signature !== signMockWebhook(rawBody)) {
      throw new Error('mock-stripe: webhook signature mismatch. Sign the raw body with signMockWebhook().');
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawBody);
    } catch {
      throw new Error('mock-stripe: webhook body is not valid JSON');
    }
    if (typeof parsed !== 'object' || parsed === null) throw new Error('mock-stripe: webhook body must be an object');
    const event = parsed as Record<string, unknown>;
    const { id, type } = event;
    if (typeof id !== 'string' || !id) throw new Error('mock-stripe: webhook event is missing "id"');
    if (typeof type !== 'string' || !type) throw new Error('mock-stripe: webhook event is missing "type"');
    return { id, type, data: event.data ?? null };
  }

  async cancelSubscription(input: { stripe_subscription_id: string }): Promise<void> {
    cancelled.add(input.stripe_subscription_id);
  }
}

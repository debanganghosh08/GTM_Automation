/**
 * Stripe billing provider.
 *
 * Verified against the Stripe docs on 2026-10-23:
 *  - stripe-node 23.0.0 pins API version 2026-09-30.endive. Do NOT pass apiVersion;
 *    overriding it would change every webhook payload shape under us.
 *  - `subscription_data.trial_period_days` gives the 30-day trial. Checkout collects a
 *    card during a trial by default (`payment_method_collection` defaults to 'always'),
 *    which is exactly the "card on file, $0 charged" the brief asks for.
 *  - `discounts` accepts a promotion code ID, not the typed string, so a code from the
 *    URL must be resolved through promotionCodes.list first.
 *
 * Note on redemption codes: our partner codes grant CREDITS and are applied in our own
 * database (see lib/billing.ts). They are not Stripe coupons, because month one is
 * already free via the trial. We still resolve a Stripe promotion code when one exists,
 * so a future "discount the $2,000" offer needs no code change here.
 */

import Stripe from 'stripe';
import { env, requireCredential } from '../../lib/env';
import type { BillingProvider } from '../../lib/contracts';

export class StripeBillingProvider implements BillingProvider {
  readonly name = 'stripe';
  private client: Stripe;

  constructor() {
    const key = requireCredential('Stripe', 'STRIPE_SECRET_KEY', env.stripe.secretKey);
    this.client = new Stripe(key);
  }

  async createCheckoutSession(input: {
    account_id: string;
    email: string;
    code?: string;
    trial_days: number;
    price_cents: number;
    success_url: string;
    cancel_url: string;
  }): Promise<{ url: string; session_id: string }> {
    const priceId = requireCredential('Stripe', 'STRIPE_PRICE_ID', env.stripe.priceId);

    // Resolve a Stripe promotion code if the partner code happens to be one.
    // A missing code is normal and not an error.
    let discounts: Stripe.Checkout.SessionCreateParams.Discount[] | undefined;
    if (input.code) {
      const found = await this.client.promotionCodes.list({ code: input.code, active: true, limit: 1 });
      const promo = found.data[0];
      if (promo) discounts = [{ promotion_code: promo.id }];
    }

    const session = await this.client.checkout.sessions.create({
      mode: 'subscription',
      line_items: [{ price: priceId, quantity: 1 }],
      subscription_data: {
        trial_period_days: input.trial_days,
        metadata: { account_id: input.account_id, code: input.code ?? '' },
      },
      // Carried on the session itself too, because checkout.session.completed is the
      // event that creates our linkage and it reads metadata from the session.
      metadata: { account_id: input.account_id, code: input.code ?? '' },
      client_reference_id: input.account_id,
      customer_email: input.email,
      success_url: input.success_url,
      cancel_url: input.cancel_url,
      // Stripe rejects `discounts` together with `allow_promotion_codes`, so the code
      // box is only offered when we did not pre-apply one.
      ...(discounts ? { discounts } : { allow_promotion_codes: true }),
    });

    if (!session.url) throw new Error('Stripe returned a session with no URL');
    return { url: session.url, session_id: session.id };
  }

  async verifyWebhook(rawBody: string, signature: string): Promise<{ id: string; type: string; data: unknown }> {
    const secret = requireCredential('Stripe', 'STRIPE_WEBHOOK_SECRET', env.stripe.webhookSecret);
    // Throws on a bad signature or a timestamp outside the default 5-minute tolerance.
    const event = this.client.webhooks.constructEvent(rawBody, signature, secret);
    return { id: event.id, type: event.type, data: event.data };
  }

  async cancelSubscription(input: { stripe_subscription_id: string }): Promise<void> {
    await this.client.subscriptions.cancel(input.stripe_subscription_id);
  }
}

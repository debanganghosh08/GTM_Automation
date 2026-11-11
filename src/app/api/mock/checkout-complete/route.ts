/**
 * Mock checkout completion — the offline stand-in for returning from Stripe.
 *
 * The mock billing provider points its checkout URL here. Hitting it synthesises the
 * `checkout.session.completed` event and runs it through the SAME
 * `handleStripeEvent` path the real webhook uses, so the offline flow exercises the
 * production code rather than a parallel shortcut.
 *
 * Refuses to run when billing is live, so it can never be used to grant credits
 * against a real Stripe account.
 */

import { handleStripeEvent } from '../../../../lib/billing';
import { providerMode, env } from '../../../../lib/env';
import { requireUser } from '../../../../lib/auth';
import { fail, route } from '../../../../lib/api';

export const runtime = 'nodejs';

export const GET = route(async (req: Request) => {
  // Hard kill in production, before anything else.
  //
  // This route grants a full credit balance with no payment. Gating it only on
  // "billing is not live" was not enough: anything other than the exact string
  // `live` counts as mock, so a typo, an unset variable, a preview deployment or a
  // stray PROVIDER_BILLING override would all have re-opened it. Production answers
  // 404 as though the route does not exist, which is also the honest answer.
  if (env.nodeEnv === 'production') {
    return new Response('Not found', { status: 404 });
  }

  if (providerMode('billing') === 'live') {
    return fail('Mock checkout is disabled when billing is live', 403, 'live_billing');
  }

  // Even in development, only the signed-in owner of the account may complete its
  // mock checkout. Otherwise this is a one-click credit grant for any account id
  // that happens to leak, and a GET that anyone can trigger with an image tag.
  const user = await requireUser(req);
  if (!user) return fail('Sign in first', 401, 'unauthorized');

  const url = new URL(req.url);
  const accountId = url.searchParams.get('account_id');
  if (accountId && accountId !== user.account_id) {
    return fail('Mock checkout can only complete your own account', 403, 'wrong_account');
  }
  const sessionId = url.searchParams.get('session_id') ?? `mock_cs_${Date.now()}`;
  const code = url.searchParams.get('code') ?? '';
  if (!accountId) return fail('account_id is required', 400, 'missing_account');

  await handleStripeEvent({
    id: `evt_mock_${sessionId}`,
    type: 'checkout.session.completed',
    data: {
      object: {
        id: sessionId,
        object: 'checkout.session',
        client_reference_id: accountId,
        customer: `cus_mock_${accountId.slice(0, 8)}`,
        subscription: `sub_mock_${accountId.slice(0, 8)}`,
        payment_status: 'no_payment_required',
        metadata: { account_id: accountId, code },
      },
    },
  });

  return new Response(null, {
    status: 303,
    headers: { Location: `${env.appUrl}/onboarding?mock_checkout=complete` },
  });
});

/**
 * Stripe webhook receiver.
 *
 * Two rules this route exists to enforce:
 *  1. Verify the signature against the RAW body. `req.text()` gives the untouched
 *     bytes; parsing the JSON first would break verification.
 *  2. Return 2xx quickly. Stripe retries for up to 3 days on a non-2xx, and a slow
 *     handler turns one event into a pile of duplicates.
 */

import { getBillingProvider } from '../../../../providers';
import { handleStripeEvent, type StripeEventLike } from '../../../../lib/billing';
import { fail, ok } from '../../../../lib/api';

export const runtime = 'nodejs';

export async function POST(req: Request): Promise<Response> {
  const signature = req.headers.get('stripe-signature');
  if (!signature) return fail('Missing stripe-signature header', 400, 'missing_signature');

  const rawBody = await req.text();

  let event: StripeEventLike;
  try {
    const billing = await getBillingProvider();
    const verified = await billing.verifyWebhook(rawBody, signature);
    event = verified as StripeEventLike;
  } catch (err) {
    // A bad signature is not retryable, so answer 400 and stop.
    const message = err instanceof Error ? err.message : 'invalid signature';
    console.error('[stripe webhook] signature rejected:', message);
    return fail('Invalid signature', 400, 'invalid_signature');
  }

  try {
    const result = await handleStripeEvent(event);
    console.log(
      `[stripe webhook] ${event.type} ${event.id} -> ${result.action}${result.duplicate ? ' (duplicate)' : ''}`,
    );
    return ok(result);
  } catch (err) {
    // Processing failed on our side. Answer 500 so Stripe retries. handleStripeEvent
    // releases its event claim on failure, so the retry does the work rather than
    // being discarded as a duplicate.
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[stripe webhook] processing failed for ${event.id}:`, message);
    return fail('Processing failed', 500, 'processing_failed');
  }
}

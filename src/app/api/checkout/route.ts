/**
 * Redemption -> Checkout.
 *
 * The account is created BEFORE the redirect so its id can ride along in Stripe
 * metadata. checkout.session.completed then links the subscription and grants
 * credits against an account that already exists, instead of having to invent one
 * from webhook data.
 *
 * Creating an account here means an abandoned checkout leaves an empty account
 * behind. That is deliberate: it is cheaper than reconciling a payment against no
 * account, it holds the email so the user can be recovered, and it carries no
 * credits until the webhook grants them.
 */

import { getBillingProvider } from '../../../providers';
import { getDb } from '../../../lib/db';
import { env } from '../../../lib/env';
import { createAccountWithUser, createSession, sessionCookieOptions, MAX_PASSWORD_LENGTH } from '../../../lib/auth';
import { checkRateLimit, clientIp } from '../../../lib/rate-limit';
import { fail, jsonBody, ok, route, tooManyRequests } from '../../../lib/api';

export const runtime = 'nodejs';

interface CheckoutBody {
  email?: string;
  company_name?: string;
  website_url?: string;
  password?: string;
  code?: string;
}

export const POST = route(async (req: Request) => {
  // Checkout creates an account AND a Stripe Checkout Session (a paid API call), so
  // it needs its own ceiling rather than the generic one.
  const ip = clientIp(req);
  const limit = await checkRateLimit('checkout', `ip:${ip}`);
  if (!limit.allowed) return tooManyRequests(limit.resetSeconds);

  const body = await jsonBody<CheckoutBody>(req);
  if (!body) return fail('Invalid JSON body');

  const email = body.email?.trim().toLowerCase();
  const companyName = body.company_name?.trim();
  if (!email || !email.includes('@')) return fail('A valid email is required', 400, 'invalid_email');
  if (!companyName) return fail('Company name is required', 400, 'missing_company');
  if (body.password && body.password.length < 8) {
    return fail('Password must be at least 8 characters', 400, 'weak_password');
  }
  if (body.password && body.password.length > MAX_PASSWORD_LENGTH) {
    return fail(`Password must be at most ${MAX_PASSWORD_LENGTH} characters`, 400, 'password_too_long');
  }

  const db = await getDb();

  // One account per email. A returning user resumes rather than duplicating.
  const existing = await db.query<{ id: string; account_id: string }>(
    `select id, account_id from users where lower(email) = $1`,
    [email],
  );
  if (existing.rows[0]) {
    return fail('An account already exists for this email. Please sign in.', 409, 'account_exists');
  }

  const code = body.code?.trim() || undefined;
  if (code) {
    const found = await db.query<{ code: string }>(
      `select code from redemption_codes
        where code = $1 and active = true and (expires_at is null or expires_at > now())`,
      [code],
    );
    // An invalid code does not block checkout; the webhook falls back to the default
    // grant and records the discrepancy. Blocking here would lose a paying signup
    // because a partner mistyped a code.
    if (!found.rows[0]) console.warn('[checkout] unknown or expired redemption code presented');
  }

  const { accountId, userId } = await createAccountWithUser({
    companyName,
    email,
    password: body.password,
    websiteUrl: body.website_url?.trim() || null,
    trialDays: env.trialDays,
  });

  const billing = await getBillingProvider();
  const session = await billing.createCheckoutSession({
    account_id: accountId,
    email,
    code,
    trial_days: env.trialDays,
    price_cents: env.subscriptionPriceCents,
    success_url: `${env.appUrl}/onboarding?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${env.appUrl}/?checkout=cancelled`,
  });

  await db.query(
    `insert into events (account_id, actor, type, subject, detail)
     values ($1, 'customer', 'billing.checkout_started', $2, $3)`,
    [accountId, session.session_id, JSON.stringify({ code: code ?? null })],
  );

  // Sign the user in now, so returning from Stripe lands them straight in onboarding.
  const token = await createSession(userId, { ip, userAgent: req.headers.get('user-agent') });
  const res = ok({ url: session.url, session_id: session.session_id, account_id: accountId });
  const cookie = sessionCookieOptions();
  res.cookies.set(cookie.name, token, cookie);
  return res;
});

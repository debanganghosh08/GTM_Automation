/**
 * Direct registration, without going through Stripe.
 *
 * This is the path for team members and for anyone invited manually. The paying
 * self-serve path is /api/checkout, which creates the account and then redirects to
 * Stripe. Accounts created here get NO credits: credits are granted by the billing
 * webhook or by an admin, never by signing up.
 */

import { getDb } from '../../../../lib/db';
import { createAccountWithUser, createSession, sessionCookieOptions, MAX_PASSWORD_LENGTH } from '../../../../lib/auth';
import { checkRateLimit, clientIp } from '../../../../lib/rate-limit';
import { fail, jsonBody, ok, route, tooManyRequests } from '../../../../lib/api';

export const runtime = 'nodejs';

interface Body {
  email?: string;
  password?: string;
  company_name?: string;
  website_url?: string;
}

export const POST = route(async (req: Request) => {
  // Each signup creates an account that later jobs will spend money against, so the
  // cheapest place to stop mass registration is here.
  const ip = clientIp(req);
  const limit = await checkRateLimit('signup', `ip:${ip}`);
  if (!limit.allowed) return tooManyRequests(limit.resetSeconds);

  const body = await jsonBody<Body>(req);
  const email = body?.email?.trim().toLowerCase();
  const password = body?.password;
  const companyName = body?.company_name?.trim();

  if (!email || !email.includes('@')) return fail('A valid email is required', 400, 'invalid_email');
  if (!password || password.length < 8) return fail('Password must be at least 8 characters', 400, 'weak_password');
  // Rejected, never truncated: hashing an unbounded password is a CPU DoS.
  if (password.length > MAX_PASSWORD_LENGTH) {
    return fail(`Password must be at most ${MAX_PASSWORD_LENGTH} characters`, 400, 'password_too_long');
  }
  if (!companyName) return fail('Company name is required', 400, 'missing_company');

  const db = await getDb();
  const existing = await db.query(`select 1 from users where lower(email) = $1`, [email]);
  if (existing.rows.length > 0) {
    return fail('An account already exists for this email', 409, 'account_exists');
  }

  const { accountId, userId } = await createAccountWithUser({
    companyName,
    email,
    password,
    websiteUrl: body?.website_url?.trim() || null,
  });

  const token = await createSession(userId, { ip, userAgent: req.headers.get('user-agent') });
  const response = ok({ account_id: accountId, user_id: userId });
  const cookie = sessionCookieOptions();
  response.cookies.set(cookie.name, token, cookie);
  return response;
});

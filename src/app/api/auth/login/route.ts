import { getDb } from '../../../../lib/db';
import { createSession, sessionCookieOptions, verifyPassword } from '../../../../lib/auth';
import { checkRateLimit, clientIp } from '../../../../lib/rate-limit';
import { fail, jsonBody, ok, route, tooManyRequests } from '../../../../lib/api';

export const runtime = 'nodejs';

/**
 * Login is the most likely thing to be attacked on a self-serve product, so it is
 * rate limited on two keys:
 *
 *   - by IP, which stops one host grinding through a password list;
 *   - by email, which stops a distributed attempt against one known account, where a
 *     per-IP limit would never trigger.
 *
 * Each attempt also costs real CPU (scrypt at 64MiB), so an unlimited login endpoint
 * is a cheap way to exhaust a serverless function. The limiter protects the wallet as
 * much as the password.
 *
 * `skipRateLimit` disables the generic per-IP ceiling from `route()` because these
 * limits are tighter and more specific.
 */
export const POST = route(
  async (req: Request) => {
    const ip = clientIp(req);

    const byIp = await checkRateLimit('login_ip', `ip:${ip}`);
    if (!byIp.allowed) return tooManyRequests(byIp.resetSeconds);

    const body = await jsonBody<{ email?: string; password?: string }>(req);
    const email = body?.email?.trim().toLowerCase();
    const password = body?.password;
    if (!email || !password) return fail('Email and password are required', 400, 'missing_fields');

    const byEmail = await checkRateLimit('login_email', `email:${email}`);
    if (!byEmail.allowed) return tooManyRequests(byEmail.resetSeconds);

    const db = await getDb();
    const res = await db.query<{ id: string; password_hash: string | null }>(
      `select id, password_hash from users where lower(email) = $1`,
      [email],
    );
    const user = res.rows[0];

    // verifyPassword does the same scrypt work whether or not the user exists, so the
    // response time does not reveal which emails have accounts.
    const valid = await verifyPassword(password, user?.password_hash ?? null);

    await db
      .query(`insert into login_attempts (email, ip, successful) values ($1, $2, $3)`, [email, ip, valid])
      .catch(() => {
        // Recording an attempt must never block a legitimate login.
      });

    if (!user || !valid) return fail('Email or password is incorrect', 401, 'invalid_credentials');

    const token = await createSession(user.id, { ip, userAgent: req.headers.get('user-agent') });
    const response = ok({ user_id: user.id });
    const cookie = sessionCookieOptions();
    response.cookies.set(cookie.name, token, cookie);
    return response;
  },
  { skipRateLimit: true },
);

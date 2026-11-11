/**
 * Session auth. DB-backed sessions with an httpOnly cookie.
 *
 * Deliberately dependency-free: scrypt from node:crypto, no bcrypt build step,
 * no external auth service. Swappable for Supabase Auth later without touching
 * callers, because everything goes through currentUser() / requireUser().
 */

import { createHash, randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { cookies } from 'next/headers';
import { getDb } from './db';
import type { User } from './contracts';

type ScryptOptions = { N: number; r: number; p: number; maxmem: number };
const scrypt = promisify(scryptCb) as (
  p: string, s: Buffer, k: number, o: ScryptOptions,
) => Promise<Buffer>;

export const SESSION_COOKIE = 'gtm_session';
const SESSION_DAYS = 30;
const KEY_LEN = 64;

/**
 * scrypt cost. Node's defaults (N=2^14) are about eight times weaker than the current
 * OWASP minimum, which matters only if the hashes ever leak -- but that is exactly the
 * scenario a KDF exists for. N=2^16 with r=8, p=2 reaches the OWASP guidance at 64MiB,
 * which fits comfortably in a serverless function; N=2^17 would need 128MiB.
 *
 * The parameters are written into the hash string, so these can be raised later and
 * existing hashes still verify (and are upgraded on next login).
 */
const SCRYPT: ScryptOptions = { N: 2 ** 16, r: 8, p: 2, maxmem: 128 * 1024 * 1024 };

/** Passwords longer than this are rejected rather than truncated (hashing DoS). */
export const MAX_PASSWORD_LENGTH = 128;

// ---------------------------------------------------------------- passwords

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  // Sliced identically to verifyPassword. The routes reject anything longer, so this
  // is only a guard against the two paths ever disagreeing about the same input.
  const key = await scrypt(password.slice(0, MAX_PASSWORD_LENGTH), salt, KEY_LEN, SCRYPT);
  // Parameters are stored with the hash so they can be raised without invalidating
  // existing passwords.
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('hex')}$${key.toString('hex')}`;
}

export async function verifyPassword(password: string, stored: string | null): Promise<boolean> {
  // Always do the same work, even with no stored hash. Returning early for an unknown
  // user made the response ~80ms faster than for a known one, which enumerates
  // accounts. The dummy hash is a real hash of a fixed string, so the cost matches.
  if (!stored) {
    await scrypt(password.slice(0, MAX_PASSWORD_LENGTH), DUMMY_SALT, KEY_LEN, SCRYPT);
    return false;
  }

  const parts = stored.split('$');
  let saltHex: string | undefined;
  let keyHex: string | undefined;
  let params = SCRYPT;

  if (parts.length === 6 && parts[0] === 'scrypt') {
    // scrypt$N$r$p$salt$key
    params = {
      N: Number(parts[1]), r: Number(parts[2]), p: Number(parts[3]), maxmem: SCRYPT.maxmem,
    };
    saltHex = parts[4];
    keyHex = parts[5];
  } else if (parts.length === 3 && parts[0] === 'scrypt') {
    // Legacy scrypt$salt$key, written before the parameters were recorded. Verified
    // with Node's defaults so existing logins keep working.
    params = { N: 2 ** 14, r: 8, p: 1, maxmem: SCRYPT.maxmem };
    saltHex = parts[1];
    keyHex = parts[2];
  } else {
    await scrypt(password.slice(0, MAX_PASSWORD_LENGTH), DUMMY_SALT, KEY_LEN, SCRYPT);
    return false;
  }

  if (!saltHex || !keyHex || !Number.isFinite(params.N) || !Number.isFinite(params.r)) return false;

  const key = await scrypt(password.slice(0, MAX_PASSWORD_LENGTH), Buffer.from(saltHex, 'hex'), KEY_LEN, params);
  const expected = Buffer.from(keyHex, 'hex');
  // Length check first: timingSafeEqual throws on a length mismatch.
  return key.length === expected.length && timingSafeEqual(key, expected);
}

/** Fixed salt for the equal-work path above. Not a secret: it hashes a constant. */
const DUMMY_SALT = Buffer.alloc(16, 7);

/** True when a stored hash used weaker parameters than we now use. */
export function needsRehash(stored: string | null): boolean {
  if (!stored) return false;
  const parts = stored.split('$');
  if (parts.length !== 6) return true;
  return Number(parts[1]) < SCRYPT.N || Number(parts[3]) < SCRYPT.p;
}

// ---------------------------------------------------------------- sessions

/**
 * SHA-256 of the session token.
 *
 * The raw token was previously the primary key, so anyone who could read the table --
 * a backup, a log, a support query, a misconfigured Supabase API -- held every live
 * session. Storing only the hash means a database read is no longer an account
 * takeover. A plain hash is correct here (unlike for passwords) because the token is
 * 256 bits of CSPRNG output, so there is nothing to brute-force.
 */
function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export async function createSession(
  userId: string,
  meta: { ip?: string | null; userAgent?: string | null } = {},
): Promise<string> {
  const token = randomBytes(32).toString('hex');
  const db = await getDb();
  await db.query(
    `insert into sessions (token, token_hash, user_id, expires_at, absolute_expires_at, last_seen_at, ip, user_agent)
     values ($1, $2, $3,
             now() + ($4 || ' days')::interval,
             now() + ($4 || ' days')::interval,
             now(), $5, $6)`,
    // `token` is still written for one deploy so sessions issued by the previous
    // version keep working; migration 0006 drops the column once traffic has cycled.
    [token, hashToken(token), userId, String(SESSION_DAYS), meta.ip ?? null, (meta.userAgent ?? null)?.slice(0, 300) ?? null],
  );
  return token;
}

export async function destroySession(token: string): Promise<void> {
  const db = await getDb();
  await db.query('delete from sessions where token_hash = $1 or token = $1', [hashToken(token), token]);
}

/**
 * Ends every session for a user. Used when a password changes, so a stolen cookie
 * cannot outlive the credential it was issued against.
 */
export async function destroyAllSessions(userId: string): Promise<number> {
  const db = await getDb();
  const res = await db.query('delete from sessions where user_id = $1', [userId]);
  return res.rowCount;
}

/** Reads the session cookie and returns the user, or null. Never throws. */
export async function currentUser(): Promise<User | null> {
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value;
  if (!token) return null;
  return userForToken(token);
}

/** Same as currentUser but takes the token directly, for route handlers and tests. */
export async function userForToken(token: string): Promise<User | null> {
  const db = await getDb();
  const res = await db.query<User>(
    // Explicit columns rather than u.*: a future route returning this object must not
    // be able to leak password_hash by accident.
    `select u.id, u.account_id, u.email, u.name, u.is_admin, u.created_at,
            null::text as password_hash
       from sessions s
       join users u on u.id = s.user_id
      where (s.token_hash = $1 or s.token = $2)
        and s.expires_at > now()
        and (s.absolute_expires_at is null or s.absolute_expires_at > now())`,
    [hashToken(token), token],
  );
  return res.rows[0] ?? null;
}

export function tokenFromRequest(req: Request): string | null {
  const header = req.headers.get('cookie');
  if (!header) return null;
  for (const part of header.split(';')) {
    const [k, ...rest] = part.trim().split('=');
    if (k === SESSION_COOKIE) return rest.join('=');
  }
  return null;
}

/**
 * Resolves the signed-in user for an API route, or null.
 * Routes turn null into `unauthorized()` from lib/api.
 */
export async function requireUser(req: Request): Promise<User | null> {
  const token = tokenFromRequest(req);
  if (!token) return null;
  return userForToken(token);
}

export function sessionCookieOptions(maxAgeDays = SESSION_DAYS) {
  return {
    name: SESSION_COOKIE,
    httpOnly: true,
    sameSite: 'lax' as const,
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: maxAgeDays * 24 * 60 * 60,
  };
}

// ---------------------------------------------------------------- registration

/**
 * Creates an account plus its first user. Used by the Stripe webhook after a
 * successful redemption, and by the plain register route.
 */
export async function createAccountWithUser(input: {
  companyName: string;
  email: string;
  password?: string;
  websiteUrl?: string | null;
  trialDays?: number;
}): Promise<{ accountId: string; userId: string }> {
  const db = await getDb();
  return db.tx(async (t) => {
    const acc = await t.query<{ id: string }>(
      `insert into accounts (company_name, website_url, trial_ends_at)
       values ($1, $2, case when $3::int is null then null else now() + ($3 || ' days')::interval end)
       returning id`,
      [input.companyName, input.websiteUrl ?? null, input.trialDays ?? null],
    );
    const accountId = acc.rows[0]!.id;
    const hash = input.password ? await hashPassword(input.password) : null;
    const usr = await t.query<{ id: string }>(
      `insert into users (account_id, email, password_hash) values ($1, $2, $3) returning id`,
      [accountId, input.email.toLowerCase(), hash],
    );
    return { accountId, userId: usr.rows[0]!.id };
  });
}

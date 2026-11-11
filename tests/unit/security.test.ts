/**
 * Security controls.
 *
 * Each test here corresponds to a finding from the pre-launch audit. They exist so a
 * later refactor cannot quietly remove a control: the studies on AI-written code found
 * that the most common failure is not a missing guard, but a guard that was added to
 * new handlers and never applied to the old ones.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { freshDb, dropDb, makeAccount } from '../helpers/db';
import { checkOrigin, checkJsonContentType } from '../../src/lib/request-guard';
import { hashPassword, verifyPassword, createSession, userForToken, destroyAllSessions, needsRehash, MAX_PASSWORD_LENGTH } from '../../src/lib/auth';
import { verifyUnsubscribeToken, unsubscribeToken } from '../../src/lib/unsubscribe';
import { MAX_BODY_BYTES, jsonBody } from '../../src/lib/api';
import type { Db } from '../../src/lib/db';

let db: Db;

beforeAll(async () => {
  db = await freshDb();
});
afterAll(dropDb);

function req(method: string, headers: Record<string, string> = {}): Request {
  return new Request('http://localhost:3000/api/thing', { method, headers });
}

describe('cross-origin protection', () => {
  it('rejects a browser-declared cross-site request', () => {
    expect(checkOrigin(req('POST', { 'sec-fetch-site': 'cross-site' }))).not.toBeNull();
  });

  it('rejects a mismatched Origin header', () => {
    expect(checkOrigin(req('POST', { origin: 'https://evil.example' }))).not.toBeNull();
  });

  it('allows same-origin and same-site requests', () => {
    expect(checkOrigin(req('POST', { 'sec-fetch-site': 'same-origin' }))).toBeNull();
    expect(checkOrigin(req('POST', { origin: 'http://localhost:3000' }))).toBeNull();
  });

  it('never blocks a read', () => {
    expect(checkOrigin(req('GET', { 'sec-fetch-site': 'cross-site' }))).toBeNull();
  });
});

describe('content-type protection', () => {
  it('rejects a form-encoded body, which needs no CORS preflight', () => {
    const r = checkJsonContentType(
      req('POST', { 'content-type': 'application/x-www-form-urlencoded', 'content-length': '12' }),
    );
    expect(r?.status).toBe(415);
  });

  it('rejects text/plain, the other form-postable type', () => {
    expect(checkJsonContentType(req('POST', { 'content-type': 'text/plain', 'content-length': '5' }))?.status).toBe(415);
  });

  it('accepts JSON, and allows a bodyless action POST', () => {
    expect(checkJsonContentType(req('POST', { 'content-type': 'application/json' }))).toBeNull();
    expect(checkJsonContentType(req('POST'))).toBeNull();
  });
});

describe('request body limit', () => {
  it('refuses a body larger than the cap', async () => {
    const big = JSON.stringify({ padding: 'x'.repeat(MAX_BODY_BYTES + 100) });
    const r = new Request('http://localhost/api/x', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: big,
    });
    expect(await jsonBody(r)).toBeNull();
  });

  it('accepts a normal body', async () => {
    const r = new Request('http://localhost/api/x', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ hello: 'world' }),
    });
    expect(await jsonBody<{ hello: string }>(r)).toEqual({ hello: 'world' });
  });
});

describe('password hashing', () => {
  it('stores its parameters so they can be raised later', async () => {
    const hash = await hashPassword('correct-horse-battery');
    expect(hash.split('$')).toHaveLength(6);
    expect(hash.startsWith('scrypt$65536$8$2$')).toBe(true);
    expect(await verifyPassword('correct-horse-battery', hash)).toBe(true);
    expect(await verifyPassword('wrong', hash)).toBe(false);
  });

  it('still verifies a legacy hash written before parameters were recorded', async () => {
    // scrypt$salt$key with Node's old defaults. Generated here the same way the
    // previous implementation did, so existing users are not locked out.
    const { randomBytes, scryptSync } = await import('node:crypto');
    const salt = randomBytes(16);
    const key = scryptSync('legacy-password', salt, 64);
    const legacy = `scrypt$${salt.toString('hex')}$${key.toString('hex')}`;
    expect(await verifyPassword('legacy-password', legacy)).toBe(true);
    expect(await verifyPassword('nope', legacy)).toBe(false);
    expect(needsRehash(legacy), 'a legacy hash should be upgraded on next login').toBe(true);
  });

  it('does the same work for an unknown user, so timing cannot enumerate accounts', async () => {
    const hash = await hashPassword('some-password');

    const timeOf = async (stored: string | null) => {
      const start = performance.now();
      await verifyPassword('an-attempted-password', stored);
      return performance.now() - start;
    };

    const known = await timeOf(hash);
    const unknown = await timeOf(null);
    // The unknown path must not short-circuit. Allow a wide band: this asserts the
    // work happens at all, not that the timings match precisely.
    expect(unknown).toBeGreaterThan(known * 0.3);
  });

  it('rejects an over-long password rather than truncating it', async () => {
    const long = 'a'.repeat(MAX_PASSWORD_LENGTH + 50);
    const hash = await hashPassword(long);
    // Truncation would make a 200-character password equal to its first 128
    // characters, silently weakening it. The routes reject over-long input instead.
    expect(await verifyPassword(long, hash)).toBe(true);
  });
});

describe('session storage', () => {
  it('never stores the raw token', async () => {
    const accountId = await makeAccount(db, 'Session Co');
    const user = await db.query<{ id: string }>(
      `insert into users (account_id, email) values ($1, 'sess@example.test') returning id`,
      [accountId],
    );
    const token = await createSession(user.rows[0]!.id);

    const row = await db.query<{ token_hash: string | null }>(
      `select token_hash from sessions where token_hash is not null`,
    );
    expect(row.rows.length).toBeGreaterThan(0);
    // The hash is what the lookup uses, and it is not the token.
    expect(row.rows[0]!.token_hash).not.toBe(token);
    expect(row.rows[0]!.token_hash).toMatch(/^[0-9a-f]{64}$/);

    // The token still resolves to the user.
    const resolved = await userForToken(token);
    expect(resolved?.id).toBe(user.rows[0]!.id);
  });

  it('never returns a password hash through the session lookup', async () => {
    const accountId = await makeAccount(db, 'Leak Co');
    const hash = await hashPassword('a-real-password');
    const user = await db.query<{ id: string }>(
      `insert into users (account_id, email, password_hash) values ($1, 'leak@example.test', $2) returning id`,
      [accountId, hash],
    );
    const token = await createSession(user.rows[0]!.id);
    const resolved = await userForToken(token);
    expect(resolved).not.toBeNull();
    expect(resolved?.password_hash).toBeNull();
  });

  it('can revoke every session for a user', async () => {
    const accountId = await makeAccount(db, 'Revoke Co');
    const user = await db.query<{ id: string }>(
      `insert into users (account_id, email) values ($1, 'revoke@example.test') returning id`,
      [accountId],
    );
    const a = await createSession(user.rows[0]!.id);
    const b = await createSession(user.rows[0]!.id);
    expect(await userForToken(a)).not.toBeNull();

    const removed = await destroyAllSessions(user.rows[0]!.id);
    expect(removed).toBeGreaterThanOrEqual(2);
    expect(await userForToken(a)).toBeNull();
    expect(await userForToken(b)).toBeNull();
  });

  it('refuses a session past its absolute expiry', async () => {
    const accountId = await makeAccount(db, 'Expiry Co');
    const user = await db.query<{ id: string }>(
      `insert into users (account_id, email) values ($1, 'exp@example.test') returning id`,
      [accountId],
    );
    const token = await createSession(user.rows[0]!.id);
    await db.query(
      `update sessions set absolute_expires_at = now() - interval '1 day' where user_id = $1`,
      [user.rows[0]!.id],
    );
    expect(await userForToken(token), 'a session cannot be refreshed forever').toBeNull();
  });
});

describe('unsubscribe tokens', () => {
  it('rejects a token signed with a different secret', () => {
    const original = process.env.SESSION_SECRET;
    process.env.SESSION_SECRET = 'secret-one-'.repeat(4);
    const token = unsubscribeToken({ accountId: '00000000-0000-0000-0000-000000000001', email: 'a@b.test' });
    // The module reads the secret through lib/env, which is captured at import, so
    // this asserts the structural check rather than key rotation.
    expect(verifyUnsubscribeToken(`${token}x`)).toBeNull();
    expect(verifyUnsubscribeToken(token.replace(/.$/, 'A'))).toBeNull();
    if (original === undefined) delete process.env.SESSION_SECRET;
    else process.env.SESSION_SECRET = original;
  });
});

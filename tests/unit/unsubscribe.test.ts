/**
 * Unsubscribe.
 *
 * Gmail and Yahoo bulk-sender rules require honouring an opt-out within two days,
 * and the brief makes unsubscribe mandatory. These tests pin that a click actually
 * stops future sends, that the token cannot be forged, and that clicking twice is
 * harmless.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { freshDb, dropDb, makeAccount } from '../helpers/db';
import { unsubscribeToken, unsubscribeUrl, verifyUnsubscribeToken } from '../../src/lib/unsubscribe';
import { GET, POST } from '../../src/app/api/unsubscribe/route';
import type { Db } from '../../src/lib/db';

let db: Db;
let accountId: string;

beforeAll(async () => {
  db = await freshDb();
  accountId = await makeAccount(db, 'Unsub Co');
});
afterAll(dropDb);

const RECIPIENT = 'someone@example.test';

function request(token: string | null): Request {
  const url = token
    ? `http://localhost:3000/api/unsubscribe?token=${encodeURIComponent(token)}`
    : 'http://localhost:3000/api/unsubscribe';
  return new Request(url);
}

describe('token', () => {
  it('round-trips the payload', () => {
    const token = unsubscribeToken({ accountId, email: RECIPIENT, campaignId: null });
    const parsed = verifyUnsubscribeToken(token);
    expect(parsed?.accountId).toBe(accountId);
    expect(parsed?.email).toBe(RECIPIENT);
  });

  it('lowercases the email so casing cannot create a second identity', () => {
    const token = unsubscribeToken({ accountId, email: 'MiXeD@Example.Test' });
    expect(verifyUnsubscribeToken(token)?.email).toBe('mixed@example.test');
  });

  it('rejects a tampered payload', () => {
    const token = unsubscribeToken({ accountId, email: RECIPIENT });
    const [body, sig] = token.split('.');
    const forged = `${Buffer.from(JSON.stringify({ a: accountId, e: 'victim@example.test', c: null })).toString('base64url')}.${sig}`;
    expect(body).toBeDefined();
    expect(verifyUnsubscribeToken(forged)).toBeNull();
  });

  it('rejects a missing or malformed token', () => {
    expect(verifyUnsubscribeToken('')).toBeNull();
    expect(verifyUnsubscribeToken('nodot')).toBeNull();
    expect(verifyUnsubscribeToken('a.b')).toBeNull();
  });

  it('builds a URL on the configured app origin', () => {
    expect(unsubscribeUrl({ accountId, email: RECIPIENT })).toContain('/api/unsubscribe?token=');
  });
});

describe('GET /api/unsubscribe', () => {
  it('writes a suppression row and redirects', async () => {
    const token = unsubscribeToken({ accountId, email: RECIPIENT });
    const res = await GET(request(token));

    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toContain('/unsubscribed?status=ok');

    const sup = await db.query(
      `select 1 from suppressions where account_id = $1 and lower(email) = $2 and reason = 'unsubscribe'`,
      [accountId, RECIPIENT],
    );
    expect(sup.rows).toHaveLength(1);
  });

  it('is idempotent — a second click changes nothing', async () => {
    const token = unsubscribeToken({ accountId, email: RECIPIENT });
    await GET(request(token));
    await GET(request(token));

    const sup = await db.query<{ n: string }>(
      `select count(*)::text as n from suppressions where account_id = $1 and lower(email) = $2`,
      [accountId, RECIPIENT],
    );
    expect(Number(sup.rows[0]!.n)).toBe(1);
  });

  it('marks pending sends to that address as unsubscribed', async () => {
    const email = 'pending@example.test';
    const lead = await db.query<{ id: string }>(
      `insert into leads (account_id, email) values ($1, $2) returning id`,
      [accountId, email],
    );
    const campaign = await db.query<{ id: string }>(
      `insert into campaigns (account_id, name) values ($1, 'Unsub Campaign') returning id`,
      [accountId],
    );
    await db.query(
      `insert into campaign_leads (campaign_id, lead_id, account_id, status)
       values ($1, $2, $3, 'pending')`,
      [campaign.rows[0]!.id, lead.rows[0]!.id, accountId],
    );

    await GET(request(unsubscribeToken({ accountId, email, campaignId: campaign.rows[0]!.id })));

    const row = await db.query<{ status: string }>(
      `select status from campaign_leads where lead_id = $1`,
      [lead.rows[0]!.id],
    );
    expect(row.rows[0]?.status).toBe('unsubscribed');
  });

  it('redirects to an invalid notice for a bad token, without writing anything', async () => {
    const before = await db.query<{ n: string }>(`select count(*)::text as n from suppressions`);
    const res = await GET(request('garbage.signature'));
    expect(res.headers.get('location')).toContain('status=invalid');
    const after = await db.query<{ n: string }>(`select count(*)::text as n from suppressions`);
    expect(after.rows[0]!.n).toBe(before.rows[0]!.n);
  });

  it('accepts a POST too, for RFC 8058 one-click clients', async () => {
    const email = 'oneclick@example.test';
    const res = await POST(request(unsubscribeToken({ accountId, email })));
    expect(res.status).toBe(303);
    const sup = await db.query(
      `select 1 from suppressions where account_id = $1 and lower(email) = $2`,
      [accountId, email],
    );
    expect(sup.rows).toHaveLength(1);
  });
});

/**
 * Unsubscribe tokens.
 *
 * Every email carries a per-recipient unsubscribe URL. The token is an HMAC over
 * (account_id, email, campaign_id) so it cannot be forged or enumerated, and it
 * needs no database row until someone actually clicks it.
 *
 * Why HMAC rather than a random token in a table: the link has to be generated for
 * thousands of leads at upload time, and a stateless token means no extra write per
 * lead and no row to miss when a campaign is rebuilt.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';
import { env } from './env';

export interface UnsubscribePayload {
  accountId: string;
  email: string;
  campaignId?: string | null;
}

function sign(data: string): string {
  return createHmac('sha256', env.sessionSecret).update(data).digest('base64url');
}

function encode(payload: UnsubscribePayload): string {
  return Buffer.from(
    JSON.stringify({ a: payload.accountId, e: payload.email.toLowerCase(), c: payload.campaignId ?? null }),
  ).toString('base64url');
}

export function unsubscribeToken(payload: UnsubscribePayload): string {
  const body = encode(payload);
  return `${body}.${sign(body)}`;
}

export function unsubscribeUrl(payload: UnsubscribePayload): string {
  return `${env.appUrl}/api/unsubscribe?token=${unsubscribeToken(payload)}`;
}

/** Returns the payload when the signature is valid, otherwise null. */
export function verifyUnsubscribeToken(token: string): UnsubscribePayload | null {
  const dot = token.lastIndexOf('.');
  if (dot <= 0) return null;

  const body = token.slice(0, dot);
  const provided = token.slice(dot + 1);
  const expected = sign(body);

  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;

  try {
    const parsed = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as {
      a?: unknown; e?: unknown; c?: unknown;
    };
    if (typeof parsed.a !== 'string' || typeof parsed.e !== 'string') return null;
    return {
      accountId: parsed.a,
      email: parsed.e,
      campaignId: typeof parsed.c === 'string' ? parsed.c : null,
    };
  } catch {
    return null;
  }
}

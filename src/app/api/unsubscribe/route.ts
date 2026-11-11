/**
 * One-click unsubscribe.
 *
 * Reachable without a session, by design: the recipient is not our customer.
 * It must work on the first click with no confirmation step, because Gmail and
 * Yahoo bulk-sender rules require honouring an opt-out within two days and any
 * extra friction here is both a compliance and a reputation problem.
 *
 * Writing a suppression row is what actually stops future sends: every lead upload
 * is filtered against suppressions (invariant I3).
 */

import { getDb } from '../../../lib/db';
import { verifyUnsubscribeToken } from '../../../lib/unsubscribe';
import { env } from '../../../lib/env';
import { checkRateLimit, clientIp } from '../../../lib/rate-limit';

export const runtime = 'nodejs';

function redirect(path: string): Response {
  return new Response(null, { status: 303, headers: { Location: `${env.appUrl}${path}` } });
}

async function unsubscribe(token: string | null, req: Request): Promise<Response> {
  // Unauthenticated and public. Limited per IP so the endpoint cannot be used to
  // probe tokens or to flood the suppression table.
  const limit = await checkRateLimit('unsubscribe', `ip:${clientIp(req)}`);
  if (!limit.allowed) return redirect('/unsubscribed?status=rate_limited');

  if (!token) return redirect('/unsubscribed?status=invalid');

  const payload = verifyUnsubscribeToken(token);
  if (!payload) return redirect('/unsubscribed?status=invalid');

  const db = await getDb();

  // Suppression is the thing that stops sending. Idempotent: clicking twice is fine.
  await db.query(
    `insert into suppressions (account_id, email, reason)
     values ($1, $2, 'unsubscribe')
     on conflict do nothing`,
    [payload.accountId, payload.email],
  );

  await db.query(
    `insert into unsubscribes (account_id, email, campaign_id, token)
     values ($1, $2, $3, $4)
     on conflict (account_id, lower(email)) do nothing`,
    [payload.accountId, payload.email, payload.campaignId, token.slice(0, 64)],
  );

  // Mark any in-flight sends to this address so the campaign view is truthful.
  await db.query(
    `update campaign_leads cl
        set status = 'unsubscribed'
       from leads l
      where cl.lead_id = l.id
        and cl.account_id = $1
        and lower(l.email) = $2
        and cl.status in ('pending', 'queued')`,
    [payload.accountId, payload.email],
  );

  await db.query(
    `insert into events (account_id, actor, type, subject, detail)
     values ($1, 'recipient', 'email.unsubscribed', $2, $3)`,
    [payload.accountId, payload.campaignId, JSON.stringify({ via: 'one_click' })],
  );

  return redirect('/unsubscribed?status=ok');
}

export async function GET(req: Request): Promise<Response> {
  return unsubscribe(new URL(req.url).searchParams.get('token'), req);
}

/**
 * RFC 8058 one-click: mail clients POST to the List-Unsubscribe-Post URL.
 * Same effect as the GET.
 */
export async function POST(req: Request): Promise<Response> {
  return unsubscribe(new URL(req.url).searchParams.get('token'), req);
}

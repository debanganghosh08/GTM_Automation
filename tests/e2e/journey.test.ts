/**
 * The whole journey, end to end, in mock mode.
 *
 * This is the brief's definition of done, expressed as a test:
 *   1. A stranger clicks a coded link, adds a card ($0), fills the form and sees a
 *      real strategy.
 *   2. One account completes the entire flow.
 *   3. Credits decrement correctly, and stopping the subscription pauses sending.
 *
 * It drives the REAL route handlers and the REAL job handlers; only the external
 * vendors are mocked. Where the journey depends on elapsed time (the 7-day warm-up),
 * the test moves the timestamps back rather than waiting.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { freshDb, dropDb } from '../helpers/db';
import type { Db } from '../../src/lib/db';
import { getCreditSummary } from '../../src/lib/ledger';
import { runOnce } from '../../src/jobs/runner';
import { handleStripeEvent } from '../../src/lib/billing';
import '../../src/jobs/handlers';

import { POST as checkout } from '../../src/app/api/checkout/route';
import { GET as mockCheckoutComplete } from '../../src/app/api/mock/checkout-complete/route';
import { POST as saveOnboarding } from '../../src/app/api/onboarding/route';
import { GET as getStrategy } from '../../src/app/api/strategy/route';
import { POST as approveStrategy } from '../../src/app/api/strategy/approve/route';
import { POST as createDomain } from '../../src/app/api/domains/route';
import { POST as createCampaign, GET as listCampaigns } from '../../src/app/api/campaigns/route';
import { GET as getCampaign } from '../../src/app/api/campaigns/[id]/route';
import { POST as launchCampaign } from '../../src/app/api/campaigns/[id]/launch/route';
import { GET as getDashboard } from '../../src/app/api/dashboard/route';

let db: Db;
let sessionCookie = '';
let accountId = '';
let campaignId = '';

const EMAIL = 'founder@newco.test';
const CODE = 'NETWORK30K';

beforeAll(async () => {
  db = await freshDb();
  await db.query(
    `insert into redemption_codes (code, partner, credits_granted, trial_days, max_redemptions)
     values ($1, 'startup-network', 30000, 30, 2000)`,
    [CODE],
  );
});
afterAll(dropDb);

/** Builds an authenticated request carrying the session cookie from signup. */
function req(url: string, init: RequestInit = {}): Request {
  const headers = new Headers(init.headers);
  if (sessionCookie) headers.set('cookie', sessionCookie);
  if (init.body && !headers.has('content-type')) headers.set('content-type', 'application/json');
  return new Request(`http://localhost:3000${url}`, { ...init, headers });
}

/**
 * Calls a route handler. `route()` wraps handlers as (req, ctx), so a route with no
 * dynamic segment still needs a context argument; pass an empty one.
 */
async function call(
  handler: (request: Request, ctx: Record<string, never>) => Promise<Response>,
  request: Request,
): Promise<Response> {
  return handler(request, {} as Record<string, never>);
}

async function body<T>(res: Response): Promise<T> {
  const parsed = (await res.json()) as { ok: boolean; data?: T; error?: string };
  if (!parsed.ok) throw new Error(`request failed: ${parsed.error}`);
  return parsed.data as T;
}

/** Drains the job queue, with a bound so a broken handler cannot hang the suite. */
async function drain(maxRounds = 25): Promise<void> {
  for (let i = 0; i < maxRounds; i += 1) {
    const result = await runOnce(`e2e-${i}`, { limit: 20 });
    if (result.ran === 0) return;
  }
}

describe('GTM Autopilot — full journey', () => {
  it('1. redeems the code and creates an account with a card on file', async () => {
    const res = await call(checkout, 
      req('/api/checkout', {
        method: 'POST',
        body: JSON.stringify({
          email: EMAIL,
          company_name: 'NewCo',
          website_url: 'https://newco.test',
          password: 'correct-horse-battery',
          code: CODE,
        }),
      }),
    );
    expect(res.status).toBe(200);

    const data = await body<{ url: string; account_id: string }>(res);
    accountId = data.account_id;
    expect(data.url).toContain('/api/mock/checkout-complete');

    // Keep the session for every later request, as a browser would.
    const setCookie = res.headers.get('set-cookie') ?? '';
    sessionCookie = setCookie.split(';')[0] ?? '';
    expect(sessionCookie).toContain('gtm_session=');

    // No credits before Stripe confirms. Signing up must not grant anything.
    const before = await getCreditSummary(accountId);
    expect(before.balance).toBe(0);
  });

  it('2. grants 30,000 credits when checkout completes', async () => {
    const res = await call(mockCheckoutComplete, 
      req(`/api/mock/checkout-complete?account_id=${accountId}&session_id=cs_e2e&code=${CODE}`),
    );
    expect(res.status).toBe(303);

    const credits = await getCreditSummary(accountId);
    expect(credits.balance).toBe(30000);
    expect(credits.granted).toBe(30000);
  });

  it('3. accepts onboarding and generates a real strategy', async () => {
    const saved = await call(saveOnboarding, 
      req('/api/onboarding', {
        method: 'POST',
        body: JSON.stringify({
          product: 'A scheduling tool for field service teams',
          icp_description: 'Operations leads at 20-200 person HVAC and plumbing companies in the US',
          offer: 'A 30-day pilot with onboarding included',
          proof_points: ['Cut dispatch time by a third at a 40-van operator'],
          sending_name: 'Sam Rivera',
          target_titles: ['Operations Manager', 'VP Operations'],
          target_industries: ['HVAC', 'Plumbing'],
          target_geos: ['US'],
          headcount_min: 20,
          headcount_max: 200,
          exclusions: ['competitor.test'],
          complete: true,
        }),
      }),
    );
    expect([200, 201, 202]).toContain(saved.status);

    await drain();

    const res = await call(getStrategy, req('/api/strategy'));
    const data = await body<{ strategy: { payload: Record<string, unknown> } | null }>(res);
    expect(data.strategy, 'a strategy should exist after the queue drains').not.toBeNull();

    const payload = data.strategy!.payload as {
      positioning: string;
      segments: unknown[];
      sequence_plan: unknown[];
      assumptions: unknown[];
    };
    expect(typeof payload.positioning).toBe('string');
    expect(payload.segments.length).toBeGreaterThan(0);
    expect(payload.sequence_plan.length).toBeGreaterThan(0);
    // The brief wants the customer told what was assumed, not just what was decided.
    expect(Array.isArray(payload.assumptions)).toBe(true);

    const approved = await call(approveStrategy, req('/api/strategy/approve', { method: 'POST' }));
    expect(approved.status).toBe(200);
  });

  it('4. provisions a domain and mailboxes, and respects the warm-up wait', async () => {
    const domainRes = await call(createDomain, 
      req('/api/domains', {
        method: 'POST',
        // 'buy' rather than 'connect': when WE own the domain we can write its DNS, so
        // the journey completes without human action. A connected domain correctly
        // waits for the customer to add the records themselves (see docs/HANDOFF.md).
        body: JSON.stringify({ domain: 'getnewco.test', mode: 'buy' }),
      }),
    );
    expect([200, 201, 202]).toContain(domainRes.status);
    await drain();

    const domain = await db.query<{ id: string; status: string }>(
      `select id, status from domains where account_id = $1`,
      [accountId],
    );
    expect(domain.rows[0]).toBeDefined();
    const domainId = domain.rows[0]!.id;

    // No explicit mailbox request: provisioning is chained off DNS verification, which
    // is the real automated path. Asking the route for more at the same time would race
    // the pipeline and is what surfaced the orphaned-mailbox defect.
    const mailboxes = await db.query<{ id: string; email: string; status: string }>(
      `select id, email, status from mailboxes where account_id = $1`,
      [accountId],
    );
    expect(mailboxes.rows.length, 'DNS verification should have provisioned mailboxes').toBeGreaterThan(0);

    // Nothing may be billed-but-lost: the provider must not have created a mailbox we
    // then failed to store.
    const orphans = await db.query<{ n: string }>(
      `select count(*)::text as n from events where account_id = $1 and type = 'mailboxes.orphaned'`,
      [accountId],
    );
    expect(Number(orphans.rows[0]!.n), 'no mailbox should be paid for and discarded').toBe(0);

    // Warm-up is 7 days and cannot be skipped, so move the clock back instead of
    // waiting. This is the one place the test fabricates elapsed time.
    await db.query(
      `update domains set warmup_started_at = now() - interval '8 days', status = 'ready',
              dns_verified_at = now() - interval '8 days'
        where account_id = $1`,
      [accountId],
    );
    await db.query(
      `update mailboxes set warmup_started_at = now() - interval '8 days' where account_id = $1`,
      [accountId],
    );
    // warmup_monitor re-queues itself a day out, so moving the clock back has to move
    // its scheduled time too; otherwise the drain simply skips it.
    await db.query(
      `update jobs set run_after = now() - interval '1 minute'
        where account_id = $1 and type = 'warmup_monitor' and status = 'pending'`,
      [accountId],
    );
    await drain();

    const ready = await db.query<{ n: string }>(
      `select count(*)::text as n from mailboxes where account_id = $1 and status = 'ready'`,
      [accountId],
    );
    expect(
      Number(ready.rows[0]!.n),
      'every provisioned mailbox should be ready once warm-up has elapsed',
    ).toBe(mailboxes.rows.length);
  });

  it('5. builds a campaign with verified leads and compliant copy', async () => {
    const created = await call(createCampaign, 
      req('/api/campaigns', {
        method: 'POST',
        body: JSON.stringify({ name: 'HVAC ops — pilot offer', target_lead_count: 120 }),
      }),
    );
    expect([200, 201, 202]).toContain(created.status);

    const listed = await call(listCampaigns, req('/api/campaigns'));
    const list = await body<{ campaigns: Array<{ id: string }> }>(listed);
    campaignId = list.campaigns[0]!.id;

    await drain();

    const leads = await db.query<{ n: string }>(
      `select count(*)::text as n from campaign_leads where campaign_id = $1`,
      [campaignId],
    );
    expect(Number(leads.rows[0]!.n), 'leads should be sourced, verified and attached').toBeGreaterThan(0);

    const copy = await db.query<{ compliance_passed: boolean; steps: unknown }>(
      `select compliance_passed, steps from campaign_copy where campaign_id = $1 order by version desc limit 1`,
      [campaignId],
    );
    expect(copy.rows[0], 'copy should have been generated').toBeDefined();
    expect(copy.rows[0]!.compliance_passed, 'generated copy must pass the compliance gate').toBe(true);

    // Every lead that reached the campaign must be verified-valid.
    const unverified = await db.query<{ n: string }>(
      `select count(*)::text as n from campaign_leads cl
         join leads l on l.id = cl.lead_id
        where cl.campaign_id = $1 and l.verification <> 'valid'`,
      [campaignId],
    );
    expect(Number(unverified.rows[0]!.n)).toBe(0);
  });

  it('6. refuses to launch until the first campaign is approved, then launches', async () => {
    const blocked = await launchCampaign(req(`/api/campaigns/${campaignId}/launch`, { method: 'POST' }), {
      params: Promise.resolve({ id: campaignId }),
    });
    expect(blocked.status, 'the first campaign needs human approval').toBe(409);

    const blockedBody = (await blocked.json()) as { ok: boolean; error: string };
    expect(blockedBody.ok).toBe(false);
    // The gate codes are stable tokens; assert on the token, not on prose.
    expect(blockedBody.error).toContain('first_campaign_unapproved');

    // An admin approves it. This is the gate the brief insists must exist.
    await db.query(
      `update approvals set status = 'approved', decided_at = now()
        where account_id = $1 and kind = 'first_campaign'`,
      [accountId],
    );

    const launched = await launchCampaign(req(`/api/campaigns/${campaignId}/launch`, { method: 'POST' }), {
      params: Promise.resolve({ id: campaignId }),
    });
    expect(launched.status, 'approved campaigns should launch').toBeLessThan(300);

    await drain();

    const campaign = await db.query<{ status: string; provider_ref: string | null }>(
      `select status, provider_ref from campaigns where id = $1`,
      [campaignId],
    );
    expect(['sending', 'scheduled']).toContain(campaign.rows[0]!.status);
    expect(campaign.rows[0]!.provider_ref, 'the campaign should exist at the provider').not.toBeNull();
  });

  it('7. reports stats and decrements credits once per send', async () => {
    await drain();

    const dashRes = await call(getDashboard, req('/api/dashboard'));
    const dash = await body<{
      credits: { balance: number; spent: number };
      totals: { sent: number };
    }>(dashRes);

    expect(dash.totals.sent, 'the mock provider should report sends').toBeGreaterThan(0);
    expect(dash.credits.spent, 'credits should be spent for those sends').toBe(dash.totals.sent);
    expect(dash.credits.balance).toBe(30000 - dash.credits.spent);

    // Re-running the sync must not bill the same sends again (invariant I7).
    const spentBefore = dash.credits.spent;
    await db.query(
      `insert into jobs (account_id, type, payload) values ($1, 'sync_stats', $2)`,
      [accountId, JSON.stringify({ account_id: accountId, campaign_id: campaignId })],
    );
    await drain();

    const after = await getCreditSummary(accountId);
    expect(after.spent, 'a repeated stats sync must not double-charge').toBe(spentBefore);
  });

  it('8. pauses sending when the subscription is cancelled', async () => {
    const sub = await db.query<{ stripe_subscription_id: string }>(
      `select stripe_subscription_id from subscriptions where account_id = $1`,
      [accountId],
    );
    const subscriptionId = sub.rows[0]!.stripe_subscription_id;

    await handleStripeEvent({
      id: 'evt_e2e_cancel',
      type: 'customer.subscription.deleted',
      data: { object: { id: subscriptionId, status: 'canceled' } },
    });

    const account = await db.query<{ status: string; sending_paused: boolean }>(
      `select status, sending_paused from accounts where id = $1`,
      [accountId],
    );
    expect(account.rows[0]!.status).toBe('cancelled');
    expect(account.rows[0]!.sending_paused).toBe(true);

    // And the gate actually refuses a new launch.
    const res = await getCampaign(req(`/api/campaigns/${campaignId}`), {
      params: Promise.resolve({ id: campaignId }),
    });
    const data = await body<{ send_gate: { allowed: boolean } }>(res);
    expect(data.send_gate.allowed).toBe(false);
  });

  it('9. leaves an audit trail and spends nothing it did not account for', async () => {
    const events = await db.query<{ type: string }>(
      `select distinct type from events where account_id = $1`,
      [accountId],
    );
    const types = events.rows.map((r) => r.type);
    expect(types.some((t) => t.startsWith('billing.'))).toBe(true);

    // Conservation: the ledger must reconcile to its own entries.
    const ledger = await db.query<{ granted: string; spent: string }>(
      `select coalesce(sum(delta) filter (where delta > 0), 0)::text as granted,
              coalesce(abs(sum(delta) filter (where delta < 0)), 0)::text as spent
         from credit_ledger where account_id = $1`,
      [accountId],
    );
    const summary = await getCreditSummary(accountId);
    expect(summary.granted).toBe(Number(ledger.rows[0]!.granted));
    expect(summary.spent).toBe(Number(ledger.rows[0]!.spent));
    expect(summary.balance).toBe(summary.granted - summary.spent);

    // Our own cost per account must be measurable; the brief asks for it before the
    // offer goes out.
    const cost = await db.query<{ cents: string }>(
      `select coalesce(sum(cost_cents), 0)::text as cents from cost_ledger where account_id = $1`,
      [accountId],
    );
    expect(Number(cost.rows[0]!.cents), 'lead and mailbox spend should be metered').toBeGreaterThan(0);
  });
});

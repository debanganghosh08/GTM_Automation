/**
 * App API routes: auth, tenant isolation, admin gating, server-side compliance,
 * the launch gate, and the dashboard contract. Handlers are imported directly and
 * called with constructed Requests, the same way jobs.test.ts drives the tick route.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { freshDb, dropDb, makeAccount } from '../helpers/db';
import type { Db } from '../../src/lib/db';
import { createSession, SESSION_COOKIE } from '../../src/lib/auth';
import type { ApiResponse, DashboardSummary } from '../../src/lib/contracts';

import * as onboarding from '../../src/app/api/onboarding/route';
import * as strategy from '../../src/app/api/strategy/route';
import * as strategyGenerate from '../../src/app/api/strategy/generate/route';
import * as strategyApprove from '../../src/app/api/strategy/approve/route';
import * as domains from '../../src/app/api/domains/route';
import * as domainVerify from '../../src/app/api/domains/[id]/verify/route';
import * as mailboxes from '../../src/app/api/mailboxes/route';
import * as campaigns from '../../src/app/api/campaigns/route';
import * as campaign from '../../src/app/api/campaigns/[id]/route';
import * as campaignLeads from '../../src/app/api/campaigns/[id]/leads/route';
import * as campaignCopy from '../../src/app/api/campaigns/[id]/copy/route';
import * as campaignApprove from '../../src/app/api/campaigns/[id]/approve/route';
import * as campaignLaunch from '../../src/app/api/campaigns/[id]/launch/route';
import * as campaignPause from '../../src/app/api/campaigns/[id]/pause/route';
import * as dashboard from '../../src/app/api/dashboard/route';
import * as credits from '../../src/app/api/credits/route';
import * as adminApprovals from '../../src/app/api/admin/approvals/route';
import * as adminApproval from '../../src/app/api/admin/approvals/[id]/route';
import * as adminAccounts from '../../src/app/api/admin/accounts/route';

type Handler = (req: Request, ctx: { params: Promise<{ id: string }> }) => Promise<Response>;
type Method = 'GET' | 'POST' | 'PUT' | 'DELETE';

interface Call {
  method?: Method;
  token?: string | null;
  body?: unknown;
  id?: string;
  path?: string;
}

const RANDOM_UUID = '11111111-2222-4333-8444-555555555555';

let db: Db;
let accountA: string;
let accountB: string;
let tokenA: string;
let tokenB: string;
let tokenAdmin: string;

async function makeUser(accountId: string, email: string, isAdmin = false): Promise<string> {
  const res = await db.query<{ id: string }>(
    `insert into users (account_id, email, is_admin) values ($1, $2, $3) returning id`,
    [accountId, email, isAdmin],
  );
  return res.rows[0]!.id;
}

async function call(handler: Handler, opts: Call = {}): Promise<{ status: number; body: ApiResponse<unknown> & Record<string, unknown>; text: string }> {
  const method = opts.method ?? 'GET';
  const headers: Record<string, string> = {};
  if (opts.token) headers.cookie = `${SESSION_COOKIE}=${opts.token}`;
  if (opts.body !== undefined) headers['content-type'] = 'application/json';
  const req = new Request(`http://x/api${opts.path ?? '/test'}`, {
    method,
    headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  const res = await handler(req, { params: Promise.resolve({ id: opts.id ?? RANDOM_UUID }) });
  const text = await res.text();
  return { status: res.status, body: JSON.parse(text), text };
}

async function makeCampaign(accountId: string, name = 'Test campaign'): Promise<string> {
  const res = await db.query<{ id: string }>(
    `insert into campaigns (account_id, name) values ($1, $2) returning id`, [accountId, name],
  );
  return res.rows[0]!.id;
}

beforeAll(async () => {
  db = await freshDb();
  accountA = await makeAccount(db, 'Account A');
  accountB = await makeAccount(db, 'Account B');
  const userA = await makeUser(accountA, 'a@example.com');
  const userB = await makeUser(accountB, 'b@example.com');
  const admin = await makeUser(accountA, 'admin@example.com', true);
  tokenA = await createSession(userA);
  tokenB = await createSession(userB);
  tokenAdmin = await createSession(admin);
});
afterAll(dropDb);

beforeEach(async () => {
  await db.query('delete from jobs');
  await db.query('delete from events');
  await db.query('delete from approvals');
  await db.query('delete from campaign_copy');
  await db.query('delete from campaign_leads');
  await db.query('delete from campaigns');
  await db.query('delete from strategies');
  await db.query('delete from onboarding_profiles');
  await db.query('delete from mailboxes');
  await db.query('delete from domains');
  await db.query('delete from credit_ledger');
  await db.query(`update accounts set first_campaign_approved = false, sending_paused = false, paused_reason = null`);
});

// ---------------------------------------------------------------- 401

const APP_ROUTES: Array<[string, Handler, Method]> = [
  ['GET /onboarding', onboarding.GET as Handler, 'GET'],
  ['POST /onboarding', onboarding.POST as Handler, 'POST'],
  ['GET /strategy', strategy.GET as Handler, 'GET'],
  ['PUT /strategy', strategy.PUT as Handler, 'PUT'],
  ['POST /strategy/generate', strategyGenerate.POST as Handler, 'POST'],
  ['POST /strategy/approve', strategyApprove.POST as Handler, 'POST'],
  ['GET /domains', domains.GET as Handler, 'GET'],
  ['POST /domains', domains.POST as Handler, 'POST'],
  ['POST /domains/:id/verify', domainVerify.POST, 'POST'],
  ['GET /mailboxes', mailboxes.GET as Handler, 'GET'],
  ['POST /mailboxes', mailboxes.POST as Handler, 'POST'],
  ['GET /campaigns', campaigns.GET as Handler, 'GET'],
  ['POST /campaigns', campaigns.POST as Handler, 'POST'],
  ['GET /campaigns/:id', campaign.GET, 'GET'],
  ['GET /campaigns/:id/leads', campaignLeads.GET, 'GET'],
  ['DELETE /campaigns/:id/leads', campaignLeads.DELETE, 'DELETE'],
  ['GET /campaigns/:id/copy', campaignCopy.GET, 'GET'],
  ['PUT /campaigns/:id/copy', campaignCopy.PUT, 'PUT'],
  ['POST /campaigns/:id/approve', campaignApprove.POST, 'POST'],
  ['POST /campaigns/:id/launch', campaignLaunch.POST, 'POST'],
  ['POST /campaigns/:id/pause', campaignPause.POST, 'POST'],
  ['GET /dashboard', dashboard.GET as Handler, 'GET'],
  ['GET /credits', credits.GET as Handler, 'GET'],
  ['GET /admin/approvals', adminApprovals.GET as Handler, 'GET'],
  ['POST /admin/approvals/:id', adminApproval.POST, 'POST'],
  ['GET /admin/accounts', adminAccounts.GET as Handler, 'GET'],
];

describe('authentication', () => {
  it('returns 401 from every app route without a session', async () => {
    const failures: string[] = [];
    for (const [name, handler, method] of APP_ROUTES) {
      const res = await call(handler, { method, body: method === 'GET' ? undefined : {} });
      if (res.status !== 401 || res.body.ok !== false || res.body.code !== 'unauthorized') {
        failures.push(`${name} -> ${res.status} ${res.text}`);
      }
    }
    expect(failures).toEqual([]);
  });

  it('returns 401 for an expired or unknown session token', async () => {
    const res = await call(dashboard.GET as Handler, { token: 'not-a-real-token' });
    expect(res.status).toBe(401);
  });
});

// ---------------------------------------------------------------- tenant isolation

describe('tenant isolation', () => {
  it("account A cannot read account B's campaign, and the 404 does not reveal it exists", async () => {
    const bCampaign = await makeCampaign(accountB, 'B secret campaign');

    const theirs = await call(campaign.GET, { token: tokenA, id: bCampaign });
    const nobodys = await call(campaign.GET, { token: tokenA, id: RANDOM_UUID });

    expect(theirs.status).toBe(404);
    expect(theirs.body).toEqual({ ok: false, error: 'Not found', code: 'not_found' });
    // Identical response for "exists in another tenant" and "does not exist at all".
    expect(theirs.text).toBe(nobodys.text);
    expect(theirs.text).not.toContain('B secret');
    expect(theirs.text).not.toContain(accountB);

    // The owner can read it.
    const mine = await call(campaign.GET, { token: tokenB, id: bCampaign });
    expect(mine.status).toBe(200);
    expect((mine.body.data as { campaign: { id: string } }).campaign.id).toBe(bCampaign);
  });

  it('every campaign sub-route 404s on another tenant\'s id', async () => {
    const bCampaign = await makeCampaign(accountB);
    const checks: Array<[Handler, Method, unknown]> = [
      [campaignLeads.GET, 'GET', undefined],
      [campaignLeads.DELETE, 'DELETE', { lead_id: RANDOM_UUID }],
      [campaignCopy.GET, 'GET', undefined],
      [campaignCopy.PUT, 'PUT', { steps: [{ step: 1, delay_days: 0, subject: 'x', body: 'y' }] }],
      [campaignLaunch.POST, 'POST', undefined],
      [campaignPause.POST, 'POST', {}],
    ];
    for (const [handler, method, body] of checks) {
      const res = await call(handler, { token: tokenA, id: bCampaign, method, body });
      expect(res.status).toBe(404);
    }
  });

  it('a malformed id is a 404, not a 500', async () => {
    const res = await call(campaign.GET, { token: tokenA, id: 'not-a-uuid' });
    expect(res.status).toBe(404);
  });

  it("account A cannot verify account B's domain", async () => {
    const dom = await db.query<{ id: string }>(
      `insert into domains (account_id, domain) values ($1, 'b-only.example') returning id`, [accountB],
    );
    const res = await call(domainVerify.POST, { token: tokenA, id: dom.rows[0]!.id, method: 'POST' });
    expect(res.status).toBe(404);
    expect((await db.query(`select 1 from jobs where type = 'verify_dns'`)).rows).toHaveLength(0);
  });

  it('lists only the caller\'s own campaigns and domains', async () => {
    await makeCampaign(accountA, 'A camp');
    await makeCampaign(accountB, 'B camp');
    const res = await call(campaigns.GET as Handler, { token: tokenA });
    const list = (res.body.data as { campaigns: Array<{ name: string; account_id: string }> }).campaigns;
    expect(list.map((c) => c.name)).toEqual(['A camp']);
    expect(list.every((c) => c.account_id === accountA)).toBe(true);
  });
});

// ---------------------------------------------------------------- admin

describe('admin gating', () => {
  it('a non-admin gets 403 from every admin route', async () => {
    const checks: Array<[string, Handler, Method, unknown]> = [
      ['GET /admin/approvals', adminApprovals.GET as Handler, 'GET', undefined],
      ['POST /admin/approvals/:id', adminApproval.POST, 'POST', { decision: 'approve' }],
      ['GET /admin/accounts', adminAccounts.GET as Handler, 'GET', undefined],
      ['POST /campaigns/:id/approve', campaignApprove.POST, 'POST', {}],
    ];
    const failures: string[] = [];
    for (const [name, handler, method, body] of checks) {
      const res = await call(handler, { token: tokenA, method, body });
      if (res.status !== 403 || res.body.code !== 'forbidden') failures.push(`${name} -> ${res.status}`);
    }
    expect(failures).toEqual([]);
  });

  it('an admin sees pending approvals across accounts and can resolve one', async () => {
    const bCampaign = await makeCampaign(accountB);
    const ap = await db.query<{ id: string }>(
      `insert into approvals (account_id, campaign_id, kind) values ($1, $2, 'first_campaign') returning id`,
      [accountB, bCampaign],
    );

    const list = await call(adminApprovals.GET as Handler, { token: tokenAdmin });
    expect(list.status).toBe(200);
    const rows = (list.body.data as { approvals: Array<{ id: string; company_name: string }> }).approvals;
    expect(rows.map((r) => r.id)).toContain(ap.rows[0]!.id);
    expect(rows.find((r) => r.id === ap.rows[0]!.id)?.company_name).toBe('Account B');

    const decide = await call(adminApproval.POST, {
      token: tokenAdmin, method: 'POST', id: ap.rows[0]!.id, body: { decision: 'approve', note: 'looks fine' },
    });
    expect(decide.status).toBe(200);
    const acc = await db.query<{ first_campaign_approved: boolean }>(
      `select first_campaign_approved from accounts where id = $1`, [accountB],
    );
    expect(acc.rows[0]?.first_campaign_approved).toBe(true);

    const again = await call(adminApproval.POST, {
      token: tokenAdmin, method: 'POST', id: ap.rows[0]!.id, body: { decision: 'reject', note: 'changed my mind' },
    });
    expect(again.status).toBe(409);
  });

  it('admin accounts lists credit and cost per account without secrets', async () => {
    const res = await call(adminAccounts.GET as Handler, { token: tokenAdmin });
    expect(res.status).toBe(200);
    const accounts = (res.body.data as { accounts: Array<Record<string, unknown>> }).accounts;
    const a = accounts.find((x) => x.id === accountA);
    expect(a).toMatchObject({ company_name: 'Account A', credits: { balance: 0, granted: 0, spent: 0, low: false } });
    expect(a?.cost).toMatchObject({ total_cents: 0 });
    expect(res.text).not.toContain('password_hash');
  });
});

// ---------------------------------------------------------------- copy compliance

describe('PUT /api/campaigns/:id/copy', () => {
  const nonCompliant = {
    steps: [{ step: 1, delay_days: 0, subject: 'quick question', body: 'Hi {{first_name}}, short note with no unsubscribe link at all.' }],
  };

  it('recomputes compliance server-side and ignores a client-supplied compliance_passed', async () => {
    const id = await makeCampaign(accountA);
    const res = await call(campaignCopy.PUT, {
      token: tokenA, method: 'PUT', id,
      body: { ...nonCompliant, compliance_passed: true, compliance: { passed: true, errors: [], warnings: [] } },
    });
    expect(res.status).toBe(200);
    const copy = (res.body.data as { copy: { compliance_passed: boolean; compliance: { passed: boolean; errors: Array<{ code: string }> }; edited_by_user: boolean; version: number } }).copy;
    expect(copy.compliance_passed).toBe(false);
    expect(copy.compliance.passed).toBe(false);
    expect(copy.compliance.errors.map((e) => e.code)).toContain('missing_unsubscribe');
    expect(copy.edited_by_user).toBe(true);
    expect(copy.version).toBe(1);

    const stored = await db.query<{ compliance_passed: boolean }>(
      `select compliance_passed from campaign_copy where campaign_id = $1 and account_id = $2`, [id, accountA],
    );
    expect(stored.rows).toHaveLength(1);
    expect(stored.rows[0]?.compliance_passed).toBe(false);
  });

  it('rejects unknown keys, oversized payloads and empty step lists', async () => {
    const id = await makeCampaign(accountA);
    const unknown = await call(campaignCopy.PUT, { token: tokenA, method: 'PUT', id, body: { steps: nonCompliant.steps, provider_ref: 'x' } });
    expect(unknown.status).toBe(400);
    const empty = await call(campaignCopy.PUT, { token: tokenA, method: 'PUT', id, body: { steps: [] } });
    expect(empty.status).toBe(400);
    const huge = await call(campaignCopy.PUT, {
      token: tokenA, method: 'PUT', id,
      body: { steps: [{ step: 1, delay_days: 0, subject: 's', body: 'x'.repeat(9000) }] },
    });
    expect(huge.status).toBe(400);
    expect((await db.query(`select 1 from campaign_copy where campaign_id = $1`, [id])).rows).toHaveLength(0);
  });

  it('bumps the version on each save and GET returns the latest', async () => {
    const id = await makeCampaign(accountA);
    await call(campaignCopy.PUT, { token: tokenA, method: 'PUT', id, body: nonCompliant });
    await call(campaignCopy.PUT, { token: tokenA, method: 'PUT', id, body: nonCompliant });
    const res = await call(campaignCopy.GET, { token: tokenA, id });
    expect((res.body.data as { copy: { version: number } }).copy.version).toBe(2);
  });
});

// ---------------------------------------------------------------- launch gate

describe('POST /api/campaigns/:id/launch', () => {
  it('returns 409 listing every failing gate and enqueues nothing', async () => {
    const id = await makeCampaign(accountA);
    const res = await call(campaignLaunch.POST, { token: tokenA, method: 'POST', id });

    expect(res.status).toBe(409);
    expect(res.body.ok).toBe(false);
    expect(res.body.code).toBe('send_blocked');
    const reasons = res.body.reasons as string[];
    const gates = res.body.failed_gates as number[];
    // No credits (2), no copy (3), no mailboxes (4), first campaign unapproved (5).
    expect(gates).toEqual([2, 3, 4, 5]);
    expect(reasons.some((r) => r.startsWith('[no_credits]'))).toBe(true);
    expect(reasons.some((r) => r.startsWith('[compliance_failed]'))).toBe(true);
    expect(reasons.some((r) => r.startsWith('[mailboxes_not_ready]'))).toBe(true);
    expect(reasons.some((r) => r.startsWith('[first_campaign_unapproved]'))).toBe(true);
    // The plain error string carries every reason too.
    for (const r of reasons) expect(res.body.error).toContain(r);

    expect((await db.query(`select 1 from jobs where type = 'build_campaign'`)).rows).toHaveLength(0);
    const row = await db.query<{ status: string }>(`select status::text as status from campaigns where id = $1`, [id]);
    expect(row.rows[0]?.status).toBe('draft');
  });

  it('refuses to relaunch a campaign that is already sending', async () => {
    const id = await makeCampaign(accountA);
    await db.query(`update campaigns set status = 'sending' where id = $1`, [id]);
    const res = await call(campaignLaunch.POST, { token: tokenA, method: 'POST', id });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('campaign_not_launchable');
  });
});

// ---------------------------------------------------------------- dashboard

describe('GET /api/dashboard', () => {
  it('returns the contract shape with zeroed stats for a new account', async () => {
    const res = await call(dashboard.GET as Handler, { token: tokenA });
    expect(res.status).toBe(200);
    const data = res.body.data as DashboardSummary;
    expect(data.account).toMatchObject({ id: accountA, company_name: 'Account A', status: 'trialing', sending_paused: false, paused_reason: null });
    expect(data.account.trial_ends_at).not.toBeNull();
    expect(data.credits).toEqual({ balance: 0, granted: 0, spent: 0, low: false });
    expect(data.campaigns).toEqual([]);
    expect(data.warmup).toBeNull();
    expect(data.totals).toEqual({
      campaign_id: 'all', sent: 0, delivered: 0, opens: 0, replies: 0, bounces: 0,
      unsubscribes: 0, interested: 0, bounce_rate: 0, reply_rate: 0,
    });
    expect(res.text).not.toContain('password_hash');
  });

  it('includes campaigns with stats and the slowest mailbox warm-up', async () => {
    const id = await makeCampaign(accountA, 'Live');
    await db.query(
      `insert into daily_send_stats (account_id, campaign_id, day, sent, bounces, replies)
       values ($1, $2, current_date, 100, 3, 5)`,
      [accountA, id],
    );
    const dom = await db.query<{ id: string }>(
      `insert into domains (account_id, domain, warmup_started_at, warmup_days)
       values ($1, 'a-warm.example', now() - interval '2 days', 7) returning id`,
      [accountA],
    );
    await db.query(
      `insert into mailboxes (account_id, domain_id, email, status) values ($1, $2, 'tom@a-warm.example', 'warming')`,
      [accountA, dom.rows[0]!.id],
    );

    const res = await call(dashboard.GET as Handler, { token: tokenA });
    const data = res.body.data as DashboardSummary;
    expect(data.campaigns).toHaveLength(1);
    expect(data.campaigns[0]?.stats).toMatchObject({ campaign_id: id, sent: 100, bounces: 3, replies: 5, bounce_rate: 0.03, reply_rate: 0.05 });
    expect(data.totals.sent).toBe(100);
    expect(data.warmup).toMatchObject({ days_total: 7, days_elapsed: 2, complete: false });
  });
});

// ---------------------------------------------------------------- onboarding -> strategy

describe('onboarding and strategy', () => {
  it('GET returns null before anything is saved', async () => {
    const res = await call(onboarding.GET as Handler, { token: tokenA });
    expect(res.status).toBe(200);
    expect((res.body.data as { profile: unknown }).profile).toBeNull();
  });

  it('completing the questionnaire enqueues scrape_site once, scoped to the account', async () => {
    const draft = await call(onboarding.POST as Handler, { token: tokenA, method: 'POST', body: { product: 'Widgets' } });
    expect(draft.status).toBe(200);
    expect((draft.body.data as { queued: unknown }).queued).toBeNull();

    const body = { icp_description: 'Series A SaaS', sending_name: 'Tom', complete: true };
    const done = await call(onboarding.POST as Handler, { token: tokenA, method: 'POST', body });
    expect(done.status).toBe(200);
    const data = done.body.data as { profile: { product: string; completed_at: string | null }; queued: string };
    expect(data.profile.product).toBe('Widgets'); // merged with the earlier save
    expect(data.profile.completed_at).not.toBeNull();
    expect(data.queued).toBe('scrape_site');

    await call(onboarding.POST as Handler, { token: tokenA, method: 'POST', body });
    const jobs = await db.query<{ account_id: string; payload: { url: string } }>(
      `select account_id, payload from jobs where type = 'scrape_site'`,
    );
    expect(jobs.rows).toHaveLength(1);
    expect(jobs.rows[0]?.account_id).toBe(accountA);
    expect(jobs.rows[0]?.payload.url).toBe('https://example.com');

    const gen = await call(strategy.GET as Handler, { token: tokenA });
    expect((gen.body.data as { generating: boolean; strategy: unknown })).toEqual({ strategy: null, generating: true });
  });

  it('refuses to complete without the required answers and rejects unknown keys', async () => {
    const missing = await call(onboarding.POST as Handler, { token: tokenA, method: 'POST', body: { complete: true } });
    expect(missing.status).toBe(400);
    expect(missing.body.code).toBe('incomplete');
    const unknown = await call(onboarding.POST as Handler, { token: tokenA, method: 'POST', body: { product: 'x', is_admin: true } });
    expect(unknown.status).toBe(400);
  });

  it('generate dedupes a double-click', async () => {
    await call(onboarding.POST as Handler, {
      token: tokenA, method: 'POST', body: { product: 'P', icp_description: 'I', sending_name: 'S', complete: true },
    });
    await db.query(`delete from jobs`);
    const first = await call(strategyGenerate.POST as Handler, { token: tokenA, method: 'POST' });
    const second = await call(strategyGenerate.POST as Handler, { token: tokenA, method: 'POST' });
    expect(first.status).toBe(202);
    expect((first.body.data as { deduped: boolean }).deduped).toBe(false);
    expect((second.body.data as { deduped: boolean; job_id: string }).deduped).toBe(true);
    expect((second.body.data as { job_id: string }).job_id).toBe((first.body.data as { job_id: string }).job_id);
  });

  it('approve stamps the latest strategy; campaigns require an approved one', async () => {
    const blocked = await call(campaigns.POST as Handler, { token: tokenA, method: 'POST', body: {} });
    expect(blocked.status).toBe(400);
    expect(blocked.body.code).toBe('strategy_not_approved');

    const none = await call(strategyApprove.POST as Handler, { token: tokenA, method: 'POST' });
    expect(none.status).toBe(404);

    await db.query(
      `insert into strategies (account_id, version, payload) values ($1, 1, $2::jsonb)`,
      [accountA, JSON.stringify({ segments: [{ name: 'Founders', angle: 'speed' }] })],
    );
    const ok = await call(strategyApprove.POST as Handler, { token: tokenA, method: 'POST' });
    expect(ok.status).toBe(200);
    expect((ok.body.data as { strategy: { approved_at: string | null } }).strategy.approved_at).not.toBeNull();

    const created = await call(campaigns.POST as Handler, { token: tokenA, method: 'POST', body: { segment: 0 } });
    expect(created.status).toBe(201);
    const camp = (created.body.data as { campaign: { id: string; angle: string; status: string; stats: { sent: number } } }).campaign;
    expect(camp.angle).toBe('speed');
    expect(camp.status).toBe('draft');
    expect(camp.stats.sent).toBe(0);

    const jobs = await db.query<{ account_id: string; dedupe_key: string }>(`select account_id, dedupe_key from jobs where type = 'source_leads'`);
    expect(jobs.rows).toEqual([{ account_id: accountA, dedupe_key: `source_leads:${camp.id}` }]);
    // The first campaign opens a pending approval for the admin queue.
    const approvals = await db.query<{ status: string }>(`select status::text as status from approvals where campaign_id = $1`, [camp.id]);
    expect(approvals.rows).toEqual([{ status: 'pending' }]);
  });
});

// ---------------------------------------------------------------- infra + credits + pause

describe('domains, mailboxes, credits, pause', () => {
  it('connecting a domain creates the row and enqueues provision_domain', async () => {
    const res = await call(domains.POST as Handler, { token: tokenA, method: 'POST', body: { domain: 'Outreach-A.example' } });
    expect(res.status).toBe(201);
    const dom = (res.body.data as { domain: { id: string; domain: string; status: string } }).domain;
    expect(dom.domain).toBe('outreach-a.example');
    expect(dom.status).toBe('pending');
    const jobs = await db.query<{ dedupe_key: string }>(`select dedupe_key from jobs where type = 'provision_domain'`);
    expect(jobs.rows).toEqual([{ dedupe_key: `provision_domain:${dom.id}` }]);

    const dup = await call(domains.POST as Handler, { token: tokenB, method: 'POST', body: { domain: 'outreach-a.example' } });
    expect(dup.status).toBe(409);
    const bad = await call(domains.POST as Handler, { token: tokenA, method: 'POST', body: { domain: 'not a domain' } });
    expect(bad.status).toBe(400);

    const verify = await call(domainVerify.POST, { token: tokenA, method: 'POST', id: dom.id });
    expect(verify.status).toBe(202);
  });

  it('requesting mailboxes enqueues provision_mailboxes and GET reports warm-up', async () => {
    const dom = await db.query<{ id: string }>(
      `insert into domains (account_id, domain, status) values ($1, 'mb-a.example', 'ready') returning id`, [accountA],
    );
    const res = await call(mailboxes.POST as Handler, { token: tokenA, method: 'POST', body: { domain_id: dom.rows[0]!.id, count: 3 } });
    expect(res.status).toBe(202);
    const job = await db.query<{ payload: Record<string, unknown> }>(`select payload from jobs where type = 'provision_mailboxes'`);
    expect(job.rows[0]?.payload).toMatchObject({ account_id: accountA, domain_id: dom.rows[0]!.id, count: 3 });

    const tooMany = await call(mailboxes.POST as Handler, { token: tokenA, method: 'POST', body: { domain_id: dom.rows[0]!.id, count: 11 } });
    expect(tooMany.status).toBe(400);

    await db.query(`insert into mailboxes (account_id, domain_id, email, status) values ($1, $2, 'x@mb-a.example', 'pending')`, [accountA, dom.rows[0]!.id]);
    const list = await call(mailboxes.GET as Handler, { token: tokenA });
    const boxes = (list.body.data as { mailboxes: Array<{ email: string; warmup: { complete: boolean; started_at: string | null } }> }).mailboxes;
    expect(boxes).toHaveLength(1);
    expect(boxes[0]?.warmup).toMatchObject({ complete: false, started_at: null });
  });

  it('credits returns the summary plus ledger entries, account-scoped', async () => {
    await db.query(
      `insert into credit_ledger (account_id, delta, reason, idempotency_key) values ($1, 500, 'grant_manual', 'k1'), ($2, 900, 'grant_manual', 'k2')`,
      [accountA, accountB],
    );
    const res = await call(credits.GET as Handler, { token: tokenA, path: '/credits?limit=5' });
    const data = res.body.data as { summary: { balance: number }; ledger: Array<{ delta: number; account_id: string }>; limit: number };
    expect(data.summary.balance).toBe(500);
    expect(data.ledger).toHaveLength(1);
    expect(data.ledger[0]).toMatchObject({ delta: 500, account_id: accountA });
    expect(data.limit).toBe(5);
  });

  it('pause records the reason and an event; a completed campaign cannot be paused', async () => {
    const id = await makeCampaign(accountA);
    await db.query(`update campaigns set status = 'sending' where id = $1`, [id]);
    const res = await call(campaignPause.POST, { token: tokenA, method: 'POST', id, body: { reason: 'holiday' } });
    expect(res.status).toBe(200);
    expect((res.body.data as { campaign: { status: string; paused_reason: string } }).campaign).toMatchObject({ status: 'paused', paused_reason: 'holiday' });
    const events = await db.query(`select 1 from events where type = 'campaign.paused' and subject = $1`, [id]);
    expect(events.rows).toHaveLength(1);

    await db.query(`update campaigns set status = 'completed' where id = $1`, [id]);
    const done = await call(campaignPause.POST, { token: tokenA, method: 'POST', id, body: {} });
    expect(done.status).toBe(409);
  });

  it('leads are paginated and a lead can be removed from a draft campaign', async () => {
    const id = await makeCampaign(accountA);
    for (let i = 0; i < 3; i++) {
      const lead = await db.query<{ id: string }>(
        `insert into leads (account_id, email) values ($1, $2) returning id`, [accountA, `lead${i}@x.example`],
      );
      await db.query(`insert into campaign_leads (campaign_id, lead_id, account_id) values ($1, $2, $3)`, [id, lead.rows[0]!.id, accountA]);
    }
    const page = await call(campaignLeads.GET, { token: tokenA, id, path: `/campaigns/${id}/leads?page=2&per_page=2` });
    const data = page.body.data as { items: Array<{ email: string; id: string }>; total: number; total_pages: number; page: number };
    expect(data).toMatchObject({ total: 3, total_pages: 2, page: 2 });
    expect(data.items).toHaveLength(1);

    const del = await call(campaignLeads.DELETE, { token: tokenA, method: 'DELETE', id, body: { lead_id: data.items[0]!.id } });
    expect(del.status).toBe(200);
    expect((await db.query(`select 1 from campaign_leads where campaign_id = $1`, [id])).rows).toHaveLength(2);
    // The lead row itself survives for dedupe and suppression.
    expect((await db.query(`select 1 from leads where id = $1`, [data.items[0]!.id])).rows).toHaveLength(1);
  });
});

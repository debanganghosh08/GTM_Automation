/**
 * Job handlers against the real schema and the mock providers. Each case proves
 * one of the pipeline's promises: idempotency (I5), suppression before insert
 * (I3), the free-trial lead cap, compliance halting the copy stage, the send
 * gates refusing a build, credits spent once per campaign-day (I7), and an
 * unsubscribe reply writing a suppression row.
 */

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { freshDb, dropDb, makeAccount } from '../helpers/db';
import type { Db } from '../../src/lib/db';
import type { CampaignCopy, GtmStrategy, Job, JobType, LlmProvider, Providers } from '../../src/lib/contracts';
import type { JobDeps } from '../../src/jobs/registry';
import { JOB_TYPES } from '../../src/jobs/registry';
import { HANDLERS } from '../../src/jobs/handlers';
import { buildLeadQuery } from '../../src/jobs/handlers/source-leads';
import { getProviders, resetProviders } from '../../src/providers';
import { MockLlmProvider } from '../../src/providers/mock/llm';
import { __resetMockSending, __setMockSendingClock } from '../../src/providers/mock/sending';
import { __resetMockMailboxes } from '../../src/providers/mock/mailboxes';
import { __resetMockDomains } from '../../src/providers/mock/domains';
import { grantCredits } from '../../src/lib/ledger';
import { env } from '../../src/lib/env';

let db: Db;
let providers: Providers;

beforeAll(async () => {
  db = await freshDb();
  resetProviders();
  __resetMockSending();
  __resetMockMailboxes();
  __resetMockDomains();
  providers = await getProviders();
});
afterAll(async () => {
  __setMockSendingClock(null);
  await dropDb();
});

beforeEach(async () => {
  await db.query('delete from jobs');
});

// ---------------------------------------------------------------- helpers

function makeJob(type: JobType, accountId: string, payload: Record<string, unknown> = {}): Job {
  return {
    id: randomUUID(),
    account_id: accountId,
    type,
    payload: { account_id: accountId, ...payload },
    status: 'running',
    dedupe_key: null,
    attempts: 1,
    max_attempts: 5,
    run_after: new Date().toISOString(),
    last_error: null,
    result: null,
  };
}

function depsWith(override: Partial<Providers> = {}): JobDeps {
  return { db, providers: async () => ({ ...providers, ...override }) };
}

async function run(job: Job, deps: JobDeps = depsWith()) {
  return HANDLERS[job.type](job, deps);
}

async function seedOnboarding(accountId: string, sendingName = 'Sam Fixture'): Promise<void> {
  await db.query(
    `insert into onboarding_profiles (account_id, product, icp_description, offer, sending_name, target_titles, completed_at)
     values ($1, 'An outbound engine', 'Founders at small B2B companies', 'Done-for-you outbound', $2, '["Founder"]'::jsonb, now())
     on conflict (account_id) do update set sending_name = excluded.sending_name, updated_at = now()`,
    [accountId, sendingName],
  );
}

async function mockStrategy(): Promise<GtmStrategy> {
  const out = await new MockLlmProvider().json<GtmStrategy>({ system: '', user: '', schema_name: 'gtm_strategy', schema: {} });
  return out.value;
}

async function seedApprovedStrategy(accountId: string): Promise<string> {
  const payload = await mockStrategy();
  const res = await db.query<{ id: string }>(
    `insert into strategies (account_id, version, payload, model, prompt_version, approved_at)
     values ($1, 1, $2::jsonb, 'mock', 'v001', now()) returning id`,
    [accountId, JSON.stringify(payload)],
  );
  return res.rows[0]!.id;
}

async function makeCampaign(accountId: string, opts: { strategyId?: string | null; target?: number; status?: string; name?: string } = {}): Promise<string> {
  const res = await db.query<{ id: string }>(
    `insert into campaigns (account_id, strategy_id, name, status, target_lead_count)
     values ($1, $2, $3, $4::campaign_status, $5) returning id`,
    [accountId, opts.strategyId ?? null, opts.name ?? 'Test campaign', opts.status ?? 'draft', opts.target ?? 20],
  );
  return res.rows[0]!.id;
}

async function count(sql: string, params: unknown[]): Promise<number> {
  const res = await db.query<{ n: string | number }>(sql, params);
  return Number(res.rows[0]?.n ?? 0);
}

/** An LLM that returns copy with no unsubscribe link in step 1 (a compliance ERROR). */
function badCopyLlm(): LlmProvider {
  const base = new MockLlmProvider();
  return {
    name: 'bad-copy',
    async json<T>(input: Parameters<LlmProvider['json']>[0]) {
      const out = await base.json<CampaignCopy>(input);
      if (input.schema_name === 'campaign_copy') {
        const steps = out.value.steps.map((s) => ({ ...s, body: s.body.replace('{{unsubscribe_link}}', '') }));
        return { ...out, value: { steps } as unknown as T };
      }
      return out as unknown as { value: T; model: string; input_tokens: number; output_tokens: number };
    },
  };
}

// ---------------------------------------------------------------- registry

describe('handlers index', () => {
  it('covers every JobType in the contract', () => {
    for (const t of JOB_TYPES) expect(typeof HANDLERS[t]).toBe('function');
    expect(Object.keys(HANDLERS).sort()).toEqual([...JOB_TYPES].sort());
  });
});

// ---------------------------------------------------------------- generate_strategy

describe('generate_strategy', () => {
  it('is idempotent: two runs produce one strategy row, and force makes a new version', async () => {
    const account = await makeAccount(db, 'Strategy Co');
    await seedOnboarding(account);

    const first = await run(makeJob('generate_strategy', account));
    expect(first.ok).toBe(true);
    expect(first.detail?.version).toBe(1);

    const second = await run(makeJob('generate_strategy', account));
    expect(second.ok).toBe(true);
    expect(second.detail?.skipped).toBe('strategy is current');

    expect(await count('select count(*) as n from strategies where account_id = $1', [account])).toBe(1);
    const row = await db.query<{ prompt_version: string; model: string }>(
      'select prompt_version, model from strategies where account_id = $1', [account],
    );
    expect(row.rows[0]?.prompt_version).toBe('v001');
    expect(row.rows[0]?.model).toContain('mock/');

    // An onboarding edit after generation makes the next run regenerate.
    await db.query(`update onboarding_profiles set product = 'Edited', updated_at = now() + interval '1 second' where account_id = $1`, [account]);
    const third = await run(makeJob('generate_strategy', account));
    expect(third.detail?.version).toBe(2);
    expect(await count('select count(*) as n from strategies where account_id = $1', [account])).toBe(2);
  });

  it('scrape_site stores the scrape and enqueues generate_strategy without failing on a bad URL', async () => {
    const account = await makeAccount(db, 'Scrape Co');
    const res = await run(makeJob('scrape_site', account, { url: 'not a url' }));
    expect(res.ok).toBe(true);
    expect(res.next?.[0]?.type).toBe('generate_strategy');
    const row = await db.query<{ site_scrape: { error?: string } | null }>(
      'select site_scrape from onboarding_profiles where account_id = $1', [account],
    );
    expect(row.rows[0]?.site_scrape?.error).toBeTruthy();
  });
});

// ---------------------------------------------------------------- source_leads

describe('source_leads', () => {
  it('excludes suppressed emails and domains before inserting (I3)', async () => {
    const account = await makeAccount(db, 'Leads Co');
    const strategyId = await seedApprovedStrategy(account);
    const campaign = await makeCampaign(account, { strategyId, target: 12 });

    // Find out what the mock will return for this exact query, then suppress two of them.
    const strategy = await mockStrategy();
    const preview = await providers.leads.search(buildLeadQuery(strategy, null, 12, []));
    const byEmail = preview.leads[0]!;
    const byDomain = preview.leads[1]!;
    await db.query(`insert into suppressions (account_id, email, reason) values ($1, $2, 'test')`, [account, byEmail.email.toUpperCase()]);
    await db.query(`insert into suppressions (account_id, domain, reason) values (null, $1, 'test-global')`, [byDomain.company_domain]);

    const res = await run(makeJob('source_leads', account, { campaign_id: campaign, limit: 12 }));
    expect(res.ok).toBe(true);
    expect(res.detail?.purchased).toBe(12);
    expect(res.detail?.suppressed).toBe(1);        // the email: returned by the vendor, dropped by us
    expect(res.detail?.inserted).toBe(11);
    expect(res.next?.[0]?.type).toBe('verify_leads');

    expect(await count('select count(*) as n from leads where account_id = $1 and lower(email) = lower($2)', [account, byEmail.email])).toBe(0);
    expect(await count('select count(*) as n from leads where account_id = $1 and lower(email) = lower($2)', [account, byDomain.email])).toBe(0);
    expect(await count(`select count(*) as n from leads where account_id = $1 and split_part(lower(email), '@', 2) = $2`, [account, byDomain.company_domain])).toBe(0);
    expect(await count('select count(*) as n from leads where account_id = $1', [account])).toBe(11);
    expect(await count(`select count(*) as n from cost_ledger where account_id = $1 and category = 'lead_data'`, [account])).toBe(1);
  });

  it('re-running the same job does not buy twice', async () => {
    const account = await makeAccount(db, 'Leads Twice Co');
    const strategyId = await seedApprovedStrategy(account);
    const campaign = await makeCampaign(account, { strategyId, target: 5 });
    const job = makeJob('source_leads', account, { campaign_id: campaign, limit: 5 });
    await run(job);
    const again = await run(job);
    expect(again.detail?.skipped).toBe('this job already purchased leads');
    expect(await count(`select count(*) as n from cost_ledger where account_id = $1 and category = 'lead_data'`, [account])).toBe(1);
  });

  it('honours the free-trial lead cap', async () => {
    const account = await makeAccount(db, 'Capped Co');
    const strategyId = await seedApprovedStrategy(account);
    const campaign = await makeCampaign(account, { strategyId, target: 50 });
    const cap = env.freeTrialLeadCap;
    // Fill the account to five under the cap with leads that were "bought" earlier.
    await db.query(
      `insert into leads (account_id, email) select $1, 'cap' || g || '@already-bought.test' from generate_series(1, $2::int) g`,
      [account, cap - 5],
    );

    const res = await run(makeJob('source_leads', account, { campaign_id: campaign, limit: 50 }));
    expect(res.ok).toBe(true);
    expect(res.detail?.limit).toBe(5);
    expect(res.detail?.purchased).toBe(5);
    expect(res.detail?.truncated).toBe(true);
    expect(res.detail?.cap).toEqual({ cap, already_purchased: cap - 5, remaining: 5 });
    expect(await count('select count(*) as n from leads where account_id = $1', [account])).toBe(cap);

    // At the cap: nothing is bought, the truncation is reported, the pipeline still moves on.
    const atCap = await run(makeJob('source_leads', account, { campaign_id: campaign, limit: 50 }));
    expect(atCap.ok).toBe(true);
    expect(atCap.detail?.purchased).toBe(0);
    expect(atCap.detail?.truncated).toBe(true);
    expect(atCap.next?.[0]?.type).toBe('verify_leads');
    expect(await count('select count(*) as n from leads where account_id = $1', [account])).toBe(cap);
  });
});

// ---------------------------------------------------------------- verify_leads

describe('verify_leads', () => {
  it('verifies, attaches only valid leads up to the target, and never a suppressed one', async () => {
    const account = await makeAccount(db, 'Verify Co');
    const strategyId = await seedApprovedStrategy(account);
    const campaign = await makeCampaign(account, { strategyId, target: 10 });
    await run(makeJob('source_leads', account, { campaign_id: campaign, limit: 40 }));

    const res = await run(makeJob('verify_leads', account, { campaign_id: campaign }));
    expect(res.ok).toBe(true);
    expect(res.detail?.verified).toBe(40);
    expect(res.next?.[0]?.type).toBe('generate_copy');

    const attached = await db.query<{ verification: string }>(
      `select l.verification::text as verification from campaign_leads cl join leads l on l.id = cl.lead_id
       where cl.campaign_id = $1 and cl.account_id = $2`, [campaign, account],
    );
    expect(attached.rows.length).toBe(10);
    for (const r of attached.rows) expect(r.verification).toBe('valid');
    expect(await count(`select count(*) as n from leads where account_id = $1 and verification = 'unverified'`, [account])).toBe(0);

    const again = await run(makeJob('verify_leads', account, { campaign_id: campaign }));
    expect(again.detail?.verified).toBe(0);
    expect(again.detail?.attached).toBe(0);
  });
});

// ---------------------------------------------------------------- generate_copy

describe('generate_copy', () => {
  it('stores compliant copy and moves the campaign to awaiting_review with no next job', async () => {
    const account = await makeAccount(db, 'Copy Co');
    await seedOnboarding(account);
    const strategyId = await seedApprovedStrategy(account);
    const campaign = await makeCampaign(account, { strategyId, status: 'awaiting_copy' });

    const res = await run(makeJob('generate_copy', account, { campaign_id: campaign }));
    expect(res.ok).toBe(true);
    expect(res.detail?.compliance_passed).toBe(true);
    expect(res.next).toBeUndefined();
    const row = await db.query<{ compliance_passed: boolean; prompt_version: string; status: string }>(
      `select cc.compliance_passed, cc.prompt_version, c.status::text as status
       from campaign_copy cc join campaigns c on c.id = cc.campaign_id where cc.campaign_id = $1`, [campaign],
    );
    expect(row.rows[0]).toMatchObject({ compliance_passed: true, prompt_version: 'v001', status: 'awaiting_review' });

    const again = await run(makeJob('generate_copy', account, { campaign_id: campaign }));
    expect(again.detail?.skipped).toBeTruthy();
    expect(await count('select count(*) as n from campaign_copy where campaign_id = $1', [campaign])).toBe(1);
  });

  it('halts on failing compliance: awaiting_review, compliance_passed=false, nothing enqueued', async () => {
    const account = await makeAccount(db, 'Bad Copy Co');
    await seedOnboarding(account);
    const strategyId = await seedApprovedStrategy(account);
    const campaign = await makeCampaign(account, { strategyId, status: 'awaiting_copy' });

    const res = await run(makeJob('generate_copy', account, { campaign_id: campaign }), depsWith({ llm: badCopyLlm() }));
    expect(res.ok).toBe(true);
    expect(res.detail?.compliance_passed).toBe(false);
    expect(res.detail?.halted).toBe(true);
    expect(res.detail?.errors).toContain('missing_unsubscribe');
    expect(res.next).toBeUndefined();

    const camp = await db.query<{ status: string; error: string | null }>(
      'select status::text as status, error from campaigns where id = $1', [campaign],
    );
    expect(camp.rows[0]?.status).toBe('awaiting_review');
    expect(camp.rows[0]?.error).toContain('missing_unsubscribe');
    const copy = await db.query<{ compliance_passed: boolean; compliance: { passed: boolean } }>(
      'select compliance_passed, compliance from campaign_copy where campaign_id = $1', [campaign],
    );
    expect(copy.rows[0]?.compliance_passed).toBe(false);
    expect(copy.rows[0]?.compliance.passed).toBe(false);
    expect(await count(`select count(*) as n from events where account_id = $1 and type = 'copy.compliance_failed'`, [account])).toBe(1);
  });
});

// ---------------------------------------------------------------- build_campaign

describe('build_campaign', () => {
  it('refuses when assertCanSend fails and creates nothing at the vendor', async () => {
    const account = await makeAccount(db, 'Gated Co');
    const strategyId = await seedApprovedStrategy(account);
    const campaign = await makeCampaign(account, { strategyId, status: 'approved' });
    // No credits, no copy, no mailboxes, no approval: several gates fail at once.

    const res = await run(makeJob('build_campaign', account, { campaign_id: campaign }));
    expect(res.ok).toBe(false);
    expect(res.detail?.reason).toBe('send gates failed');
    const reasons = res.detail?.reasons as string[];
    expect(reasons.length).toBeGreaterThan(0);
    expect(reasons.join(' ')).toContain('[no_credits]');
    expect(reasons.join(' ')).toContain('[compliance_failed]');
    expect(reasons.join(' ')).toContain('[mailboxes_not_ready]');
    expect(res.next).toBeUndefined();

    const camp = await db.query<{ status: string; provider_ref: string | null; error: string | null }>(
      'select status::text as status, provider_ref, error from campaigns where id = $1', [campaign],
    );
    expect(camp.rows[0]?.provider_ref).toBeNull();
    expect(camp.rows[0]?.status).toBe('approved');
    expect(camp.rows[0]?.error).toContain('build refused');
    expect(await count(`select count(*) as n from events where account_id = $1 and type = 'campaign.build_refused'`, [account])).toBe(1);
  });
});

// ---------------------------------------------------------------- sync_stats

describe('sync_stats', () => {
  it('spends credits once for the same campaign-day across two runs (I7)', async () => {
    const account = await makeAccount(db, 'Stats Co');
    await grantCredits({ accountId: account, amount: 1_000, reason: 'grant_manual', idempotencyKey: 'test-grant' }, db);
    await db.query('update accounts set first_campaign_approved = true where id = $1', [account]);
    const strategyId = await seedApprovedStrategy(account);
    const campaign = await makeCampaign(account, { strategyId, status: 'sending', name: 'Stats campaign' });

    // A ready mailbox on a warmed domain, so the guardrails do not pause the campaign.
    const dom = await db.query<{ id: string }>(
      `insert into domains (account_id, domain, status, warmup_started_at, warmup_days, dns_verified_at)
       values ($1, 'stats-co.test', 'ready', now() - interval '10 days', 7, now() - interval '10 days') returning id`, [account],
    );
    await db.query(
      `insert into mailboxes (account_id, domain_id, email, status, sender_email_id, warmup_started_at, daily_cap)
       values ($1, $2, 'sam@stats-co.test', 'ready', 'sender-1', now() - interval '10 days', 50)`, [account, dom.rows[0]!.id],
    );

    // Drive the mock sending platform directly: 30 leads, launched, clock frozen => 25 sent.
    const frozen = Date.now();
    __setMockSendingClock(() => frozen);
    const made = await providers.sending.createCampaign({ name: 'Stats campaign', steps: [], timezone: 'UTC' });
    await providers.sending.uploadLeads({
      provider_ref: made.provider_ref,
      leads: Array.from({ length: 30 }, (_, i) => ({ email: `lead${i}@stats-leads.test`, fields: {} })),
    });
    await providers.sending.launch({ provider_ref: made.provider_ref });
    await db.query(`update campaigns set provider = 'mock', provider_ref = $2, launched_at = now() where id = $1`, [campaign, made.provider_ref]);

    const first = await run(makeJob('sync_stats', account, { campaign_id: campaign }));
    expect(first.ok).toBe(true);
    const r1 = (first.detail?.results as Array<Record<string, unknown>>)[0]!;
    expect(r1.cumulative_sent).toBe(25);
    expect(r1.credits_spent).toBe(25);
    expect(r1.paused).toEqual([]);
    expect(first.next?.[0]).toMatchObject({ type: 'sync_stats', dedupe_key: `sync_stats:${campaign}` });

    const second = await run(makeJob('sync_stats', account, { campaign_id: campaign }));
    const r2 = (second.detail?.results as Array<Record<string, unknown>>)[0]!;
    expect(r2.credits_spent).toBe(0);
    expect(r2.billed_after).toBe(25);

    const ledger = await db.query<{ n: string | number; total: string | number }>(
      `select count(*) as n, coalesce(sum(delta), 0) as total from credit_ledger
       where account_id = $1 and campaign_id = $2 and reason = 'spend_email_sent'`, [account, campaign],
    );
    expect(Number(ledger.rows[0]?.n)).toBe(1);
    expect(Number(ledger.rows[0]?.total)).toBe(-25);
    expect(await count('select count(*) as n from daily_send_stats where campaign_id = $1', [campaign])).toBe(1);
    const stats = await db.query<{ sent: number }>('select sent from daily_send_stats where campaign_id = $1', [campaign]);
    expect(Number(stats.rows[0]?.sent)).toBe(25);

    // More sends later the same day bill only the delta.
    __setMockSendingClock(() => frozen + 10 * 2_000);
    const third = await run(makeJob('sync_stats', account, { campaign_id: campaign }));
    const r3 = (third.detail?.results as Array<Record<string, unknown>>)[0]!;
    expect(r3.cumulative_sent).toBe(30);
    expect(r3.credits_spent).toBe(5);
    __setMockSendingClock(null);
  });
});

// ---------------------------------------------------------------- classify_replies

describe('classify_replies', () => {
  it('writes a suppression row for an unsubscribe reply and marks the lead unsubscribed', async () => {
    const account = await makeAccount(db, 'Replies Co');
    const campaign = await makeCampaign(account, { status: 'sending' });
    const lead = await db.query<{ id: string }>(
      `insert into leads (account_id, email, verification) values ($1, 'Opt.Out@replies-co.test', 'valid') returning id`, [account],
    );
    const leadId = lead.rows[0]!.id;
    await db.query(`insert into campaign_leads (campaign_id, lead_id, account_id, status) values ($1, $2, $3, 'queued')`, [campaign, leadId, account]);
    await db.query(
      `insert into reply_messages (account_id, campaign_id, lead_id, provider_ref, from_email, subject, body_preview, received_at)
       values ($1, $2, $3, 'reply-1', 'opt.out@replies-co.test', 're: quick question', 'Please remove me from your list. Unsubscribe.', now()),
              ($1, $2, null, 'reply-2', 'someone@replies-co.test', 're: quick question', 'Sure, send over more detail.', now())`,
      [account, campaign, leadId],
    );

    const res = await run(makeJob('classify_replies', account, { campaign_id: campaign }));
    expect(res.ok).toBe(true);
    expect(res.detail?.classified).toBe(2);
    expect(res.detail?.suppressed).toBe(1);

    const replies = await db.query<{ provider_ref: string; sentiment: string; classified_by: string }>(
      'select provider_ref, sentiment::text as sentiment, classified_by from reply_messages where account_id = $1 order by provider_ref', [account],
    );
    expect(replies.rows.map((r) => [r.provider_ref, r.sentiment])).toEqual([['reply-1', 'unsubscribe'], ['reply-2', 'interested']]);
    expect(replies.rows[0]?.classified_by).toContain('classify-v001');

    expect(await count(`select count(*) as n from suppressions where account_id = $1 and lower(email) = 'opt.out@replies-co.test'`, [account])).toBe(1);
    const cl = await db.query<{ status: string }>('select status::text as status from campaign_leads where lead_id = $1', [leadId]);
    expect(cl.rows[0]?.status).toBe('unsubscribed');

    const again = await run(makeJob('classify_replies', account, { campaign_id: campaign }));
    expect(again.detail?.classified).toBe(0);
    expect(await count('select count(*) as n from suppressions where account_id = $1', [account])).toBe(1);
  });
});

// ---------------------------------------------------------------- infra chain

describe('provision_domain -> verify_dns -> provision_mailboxes -> warmup_monitor', () => {
  it('runs the mock chain end to end and records one cost row per mailbox', async () => {
    const account = await makeAccount(db, 'Infra Co');
    await seedOnboarding(account, 'Tom Smith');
    const dom = await db.query<{ id: string }>(
      `insert into domains (account_id, domain, status, source, warmup_days) values ($1, 'infra-co-purchased.test', 'pending', 'purchased', 0) returning id`,
      [account],
    );
    const domainId = dom.rows[0]!.id;

    const p = await run(makeJob('provision_domain', account, { domain_id: domainId, mailbox_count: 2 }));
    expect(p.ok).toBe(true);
    expect(p.next?.[0]?.type).toBe('verify_dns');
    let d = await db.query<{ status: string; provider_ref: string | null }>('select status::text as status, provider_ref from domains where id = $1', [domainId]);
    expect(d.rows[0]).toMatchObject({ status: 'dns_pending' });
    expect(d.rows[0]?.provider_ref).toBeTruthy();
    // Re-run: no second registration, no second cost row.
    await run(makeJob('provision_domain', account, { domain_id: domainId, mailbox_count: 2 }));
    expect(await count(`select count(*) as n from cost_ledger where account_id = $1 and category = 'domain'`, [account])).toBe(1);

    const v = await run(makeJob('verify_dns', account, p.next![0]!.payload!));
    expect(v.ok).toBe(true);
    expect(v.detail?.status).toBe('warming');
    expect(v.next?.[0]?.type).toBe('provision_mailboxes');
    d = await db.query('select status::text as status, provider_ref from domains where id = $1', [domainId]);
    expect(d.rows[0]?.status).toBe('warming');

    const m = await run(makeJob('provision_mailboxes', account, v.next![0]!.payload!));
    expect(m.ok).toBe(true);
    expect(m.detail?.inserted).toBe(2);
    expect(m.next?.[0]?.type).toBe('warmup_monitor');
    await run(makeJob('provision_mailboxes', account, v.next![0]!.payload!));
    expect(await count('select count(*) as n from mailboxes where domain_id = $1', [domainId])).toBe(2);
    expect(await count(`select count(*) as n from cost_ledger where account_id = $1 and category = 'mailbox'`, [account])).toBe(2);

    // Mock reports warming on the first poll and ready on the second; warmup_days is 0 here.
    const w1 = await run(makeJob('warmup_monitor', account, { domain_id: domainId }));
    expect(w1.ok).toBe(true);
    expect(w1.next?.[0]?.type).toBe('warmup_monitor');
    const w2 = await run(makeJob('warmup_monitor', account, { domain_id: domainId }));
    expect(w2.detail?.status).toBe('ready');
    expect(w2.next).toBeUndefined();
    expect(await count(`select count(*) as n from mailboxes where domain_id = $1 and status = 'ready'`, [domainId])).toBe(2);
    d = await db.query('select status::text as status, provider_ref from domains where id = $1', [domainId]);
    expect(d.rows[0]?.status).toBe('ready');
  });

  it('verify_dns gives up after the deadline with a clear error', async () => {
    const account = await makeAccount(db, 'Stuck DNS Co');
    const dom = await db.query<{ id: string }>(
      `insert into domains (account_id, domain, status, source, dns_records)
       values ($1, 'stuck-dns.test', 'dns_pending', 'connected',
               '[{"type":"TXT","host":"@","value":"v=spf1 include:_spf.google.com -all","purpose":"spf"}]'::jsonb) returning id`,
      [account],
    );
    const domainId = dom.rows[0]!.id;
    const longAgo = new Date(Date.now() - 49 * 3_600_000).toISOString();
    const res = await run(makeJob('verify_dns', account, { domain_id: domainId, first_attempt_at: longAgo, attempt: 5 }));
    expect(res.ok).toBe(false);
    expect(res.detail?.status).toBe('failed');
    const d = await db.query<{ status: string; error: string | null }>('select status::text as status, error from domains where id = $1', [domainId]);
    expect(d.rows[0]?.status).toBe('failed');
    expect(d.rows[0]?.error).toContain('DNS not verified');
  });
});

// ---------------------------------------------------------------- trial_ending_notice

describe('trial_ending_notice', () => {
  it('writes one events row per trial end date', async () => {
    const account = await makeAccount(db, 'Trial Co');
    const a = await run(makeJob('trial_ending_notice', account));
    const b = await run(makeJob('trial_ending_notice', account));
    expect(a.detail?.email_sent).toBe(false);
    expect(b.detail?.skipped).toBe('notice already recorded');
    expect(await count(`select count(*) as n from events where account_id = $1 and type = 'trial.ending_notice'`, [account])).toBe(1);
  });
});

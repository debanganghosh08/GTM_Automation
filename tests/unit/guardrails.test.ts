/**
 * Sending gates (SPEC §5, I6) and guardrail enforcement.
 *
 * `passingFixture` builds an account that clears all seven gates; each gate test
 * breaks exactly one thing and asserts the matching reason token.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { freshDb, dropDb, makeAccount } from '../helpers/db';
import type { Db } from '../../src/lib/db';
import { grantCredits } from '../../src/lib/ledger';
import {
  GATE,
  assertCanSend,
  bounceRate,
  dailyCapFor,
  enforceGuardrails,
  pauseSending,
  rampedCap,
  resumeSending,
  warmupProgress,
} from '../../src/lib/guardrails';

let db: Db;
let seq = 0;

beforeAll(async () => {
  db = await freshDb();
});
afterAll(dropDb);

interface Fixture {
  accountId: string;
  campaignId: string;
  domainId: string;
  mailboxIds: string[];
}

interface FixtureOptions {
  credits?: number;
  mailboxCaps?: number[];
  accountCap?: number;
  campaignCap?: number;
  /** ISO timestamp for domain + mailbox warm-up start. Default: 10 days ago. */
  warmupStartedAt?: string | null;
  warmupDays?: number;
  campaignStatus?: string;
  withApproval?: boolean;
  withCopy?: boolean;
}

async function passingFixture(opts: FixtureOptions = {}): Promise<Fixture> {
  const n = ++seq;
  const accountId = await makeAccount(db, `Co ${n}`);
  const credits = opts.credits ?? 1000;
  const mailboxCaps = opts.mailboxCaps ?? [20, 20];
  const warmupStartedAt =
    opts.warmupStartedAt === undefined ? new Date(Date.now() - 10 * 86_400_000).toISOString() : opts.warmupStartedAt;

  await db.query(`update accounts set daily_send_cap = $2 where id = $1`, [accountId, opts.accountCap ?? 50]);
  if (credits > 0) {
    await grantCredits({ accountId, amount: credits, reason: 'grant_manual', idempotencyKey: `fixture:${n}` });
  }

  const domain = await db.query<{ id: string }>(
    `insert into domains (account_id, domain, status, warmup_started_at, warmup_days)
     values ($1, $2, 'ready', $3::timestamptz, $4) returning id`,
    [accountId, `co${n}.example.com`, warmupStartedAt, opts.warmupDays ?? 7],
  );
  const domainId = domain.rows[0]!.id;

  const mailboxIds: string[] = [];
  for (const [i, cap] of mailboxCaps.entries()) {
    const mb = await db.query<{ id: string }>(
      `insert into mailboxes (account_id, domain_id, email, status, warmup_started_at, daily_cap)
       values ($1, $2, $3, 'ready', $4::timestamptz, $5) returning id`,
      [accountId, domainId, `sender${i}@co${n}.example.com`, warmupStartedAt, cap],
    );
    mailboxIds.push(mb.rows[0]!.id);
  }

  const campaign = await db.query<{ id: string }>(
    `insert into campaigns (account_id, name, status, daily_cap)
     values ($1, 'First', $2::campaign_status, $3) returning id`,
    [accountId, opts.campaignStatus ?? 'sending', opts.campaignCap ?? 50],
  );
  const campaignId = campaign.rows[0]!.id;

  if (opts.withCopy !== false) {
    await db.query(
      `insert into campaign_copy (campaign_id, account_id, steps, compliance_passed) values ($1, $2, '[]'::jsonb, true)`,
      [campaignId, accountId],
    );
  }
  if (opts.withApproval !== false) {
    await db.query(
      `insert into approvals (account_id, campaign_id, kind, status, decided_at)
       values ($1, $2, 'first_campaign', 'approved', now())`,
      [accountId, campaignId],
    );
  }
  return { accountId, campaignId, domainId, mailboxIds };
}

async function addStats(
  f: Fixture,
  daysAgo: number,
  sent: number,
  bounces: number,
  campaignId = f.campaignId,
): Promise<void> {
  await db.query(
    `insert into daily_send_stats (account_id, campaign_id, day, sent, bounces)
     values ($1, $2, current_date - $3::integer, $4, $5)
     on conflict (campaign_id, day) do update set sent = excluded.sent, bounces = excluded.bounces`,
    [f.accountId, campaignId, daysAgo, sent, bounces],
  );
}

function tokens(reasons: string[]): string[] {
  return reasons.map((r) => r.match(/^\[([a-z_]+)\]/)?.[1] ?? '');
}

describe('assertCanSend', () => {
  it('allows sending when all seven gates pass', async () => {
    const f = await passingFixture();
    const res = await assertCanSend(f.accountId, f.campaignId);
    expect(res.reasons).toEqual([]);
    expect(res.failed_gates).toEqual([]);
    expect(res.allowed).toBe(true);
  });

  it('gate 1: fails when sending is paused on the account', async () => {
    const f = await passingFixture();
    await pauseSending(f.accountId, 'test');
    const res = await assertCanSend(f.accountId, f.campaignId);
    expect(res.allowed).toBe(false);
    expect(tokens(res.reasons)).toEqual([GATE.account_paused]);
    expect(res.failed_gates).toEqual([1]);
  });

  it('gate 1: fails when the account status is not trialing or active', async () => {
    const f = await passingFixture();
    await db.query(`update accounts set status = 'cancelled' where id = $1`, [f.accountId]);
    const res = await assertCanSend(f.accountId, f.campaignId);
    expect(tokens(res.reasons)).toEqual([GATE.account_status]);

    await db.query(`update accounts set status = 'active' where id = $1`, [f.accountId]);
    expect((await assertCanSend(f.accountId, f.campaignId)).allowed).toBe(true);
  });

  it('gate 2: fails with no credit balance', async () => {
    const f = await passingFixture({ credits: 0 });
    const res = await assertCanSend(f.accountId, f.campaignId);
    expect(tokens(res.reasons)).toEqual([GATE.no_credits]);
    expect(res.failed_gates).toEqual([2]);
  });

  it('gate 3: fails when the latest copy has not passed compliance, or there is no copy', async () => {
    const f = await passingFixture();
    await db.query(
      `insert into campaign_copy (campaign_id, account_id, version, steps, compliance_passed) values ($1, $2, 2, '[]'::jsonb, false)`,
      [f.campaignId, f.accountId],
    );
    const res = await assertCanSend(f.accountId, f.campaignId);
    expect(tokens(res.reasons)).toEqual([GATE.compliance_failed]);
    expect(res.reasons[0]).toContain('v2');

    const g = await passingFixture({ withCopy: false });
    expect(tokens((await assertCanSend(g.accountId, g.campaignId)).reasons)).toEqual([GATE.compliance_failed]);
  });

  it('gate 4: fails when any mailbox in use is not ready, or there are none', async () => {
    const f = await passingFixture();
    await db.query(`update mailboxes set status = 'warming' where id = $1`, [f.mailboxIds[0]]);
    const res = await assertCanSend(f.accountId, f.campaignId);
    expect(tokens(res.reasons)).toEqual([GATE.mailboxes_not_ready]);
    expect(res.reasons[0]).toContain('sender0@');
    expect(res.failed_gates).toEqual([4]);

    // A failed mailbox is not "in use": the remaining ready one is enough.
    await db.query(`update mailboxes set status = 'failed' where id = $1`, [f.mailboxIds[0]]);
    expect((await assertCanSend(f.accountId, f.campaignId)).allowed).toBe(true);

    const g = await passingFixture({ mailboxCaps: [] });
    expect(tokens((await assertCanSend(g.accountId, g.campaignId)).reasons)).toEqual([GATE.mailboxes_not_ready]);
  });

  it('gate 5: fails when the first campaign has no approved approval row', async () => {
    const f = await passingFixture({ withApproval: false });
    const res = await assertCanSend(f.accountId, f.campaignId);
    expect(tokens(res.reasons)).toEqual([GATE.first_campaign_unapproved]);
    expect(res.failed_gates).toEqual([5]);

    // A pending or rejected row does not count.
    await db.query(
      `insert into approvals (account_id, campaign_id, kind, status) values ($1, $2, 'first_campaign', 'rejected')`,
      [f.accountId, f.campaignId],
    );
    expect(tokens((await assertCanSend(f.accountId, f.campaignId)).reasons)).toEqual([GATE.first_campaign_unapproved]);

    // The account flag alone satisfies the gate.
    await db.query(`update accounts set first_campaign_approved = true where id = $1`, [f.accountId]);
    expect((await assertCanSend(f.accountId, f.campaignId)).allowed).toBe(true);
  });

  it('gate 5: a later campaign needs no approval of its own, but cannot skip the first one', async () => {
    const f = await passingFixture({ withApproval: false });
    const second = await db.query<{ id: string }>(
      `insert into campaigns (account_id, name, status, daily_cap, created_at)
       values ($1, 'Second', 'sending', 50, now() + interval '1 minute') returning id`,
      [f.accountId],
    );
    const secondId = second.rows[0]!.id;
    await db.query(
      `insert into campaign_copy (campaign_id, account_id, steps, compliance_passed) values ($1, $2, '[]'::jsonb, true)`,
      [secondId, f.accountId],
    );

    expect(tokens((await assertCanSend(f.accountId, secondId)).reasons)).toEqual([GATE.first_campaign_unapproved]);

    await db.query(
      `insert into approvals (account_id, campaign_id, kind, status) values ($1, $2, 'first_campaign', 'approved')`,
      [f.accountId, f.campaignId],
    );
    expect((await assertCanSend(f.accountId, secondId)).allowed).toBe(true);
    expect((await assertCanSend(f.accountId, f.campaignId)).allowed).toBe(true);
  });

  it('gate 6: fails when the trailing bounce rate reaches the threshold', async () => {
    const f = await passingFixture();
    // Yesterday, so the daily cap (gate 7) is not touched; 3/100 = 3% = default threshold.
    await addStats(f, 1, 100, 3);
    const res = await assertCanSend(f.accountId, f.campaignId);
    expect(tokens(res.reasons)).toEqual([GATE.bounce_rate]);
    expect(res.failed_gates).toEqual([6]);

    await addStats(f, 1, 100, 2);
    expect((await assertCanSend(f.accountId, f.campaignId)).allowed).toBe(true);

    // Stats outside the 7-day window do not count.
    await addStats(f, 8, 10, 10);
    expect((await assertCanSend(f.accountId, f.campaignId)).allowed).toBe(true);
  });

  it("gate 7: fails once today's sends reach min(account, campaign, mailboxes)", async () => {
    const f = await passingFixture(); // cap = min(50, 50, 20 + 20) = 40
    expect(await dailyCapFor(f.accountId, f.campaignId)).toBe(40);
    await addStats(f, 0, 39, 0);
    expect((await assertCanSend(f.accountId, f.campaignId)).allowed).toBe(true);

    await addStats(f, 0, 40, 0);
    const res = await assertCanSend(f.accountId, f.campaignId);
    expect(tokens(res.reasons)).toEqual([GATE.daily_cap_reached]);
    expect(res.failed_gates).toEqual([7]);
  });

  it('gate 7: counts every campaign on the account against the account cap', async () => {
    const f = await passingFixture({ accountCap: 30, mailboxCaps: [100] });
    const other = await db.query<{ id: string }>(
      `insert into campaigns (account_id, name, status) values ($1, 'Other', 'sending') returning id`,
      [f.accountId],
    );
    await addStats(f, 0, 30, 0, other.rows[0]!.id);
    const res = await assertCanSend(f.accountId, f.campaignId);
    expect(tokens(res.reasons)).toEqual([GATE.daily_cap_reached]);
    expect(res.reasons[0]).toContain('Account has sent 30');
  });

  it('reports every failing gate, not only the first', async () => {
    const f = await passingFixture({ credits: 0, withCopy: false, withApproval: false });
    await pauseSending(f.accountId, 'test');
    const res = await assertCanSend(f.accountId, f.campaignId);
    expect(res.allowed).toBe(false);
    expect(res.failed_gates).toEqual([1, 2, 3, 5]);
    expect(tokens(res.reasons)).toEqual([
      GATE.account_paused, GATE.no_credits, GATE.compliance_failed, GATE.first_campaign_unapproved,
    ]);
  });

  it("refuses a campaign that belongs to another account (I2)", async () => {
    const a = await passingFixture();
    const b = await passingFixture();
    const res = await assertCanSend(a.accountId, b.campaignId);
    expect(res.allowed).toBe(false);
    expect(tokens(res.reasons)).toEqual([GATE.campaign_not_found]);
  });
});

describe('warmupProgress', () => {
  const start = new Date('2026-10-01T00:00:00Z');

  it('is not started and not complete with a null start', () => {
    const p = warmupProgress({ warmup_started_at: null, warmup_days: 7 }, start);
    expect(p).toEqual({ started_at: null, days_total: 7, days_elapsed: 0, percent: 0, ready_at: null, complete: false });
  });

  it('counts whole days elapsed and completes only at days_total', () => {
    const src = { warmup_started_at: start.toISOString(), warmup_days: 7 };
    expect(warmupProgress(src, start)).toMatchObject({ days_elapsed: 0, percent: 0, complete: false });
    expect(warmupProgress(src, new Date('2026-10-04T12:00:00Z'))).toMatchObject({ days_elapsed: 3, percent: 42, complete: false });
    expect(warmupProgress(src, new Date('2026-10-07T23:59:59Z'))).toMatchObject({ days_elapsed: 6, complete: false });
    expect(warmupProgress(src, new Date('2026-10-08T00:00:00Z'))).toMatchObject({ days_elapsed: 7, percent: 100, complete: true });
    expect(warmupProgress(src, new Date('2026-12-01T00:00:00Z'))).toMatchObject({ days_elapsed: 7, percent: 100, complete: true });
    expect(warmupProgress(src, start).ready_at).toBe('2026-10-08T00:00:00.000Z');
  });

  it('accepts a Date start and falls back to the configured duration', () => {
    const p = warmupProgress({ warmup_started_at: start }, new Date('2026-10-02T00:00:00Z'));
    expect(p.days_total).toBe(7);
    expect(p.days_elapsed).toBe(1);
  });

  it('treats zero warm-up days as complete', () => {
    expect(warmupProgress({ warmup_started_at: null, warmup_days: 0 }, start).complete).toBe(true);
    expect(warmupProgress({ warmup_started_at: start, warmup_days: 0 }, start).complete).toBe(true);
  });
});

describe('warm-up ramp', () => {
  const start = new Date('2026-10-01T00:00:00Z');
  const day = (n: number, hours = 12) => new Date(start.getTime() + (n - 1) * 86_400_000 + hours * 3_600_000);

  it('rampedCap: day 1 of 7 with a cap of 50 gives 7 and day 7 gives 50', () => {
    const src = { warmup_started_at: start.toISOString(), warmup_days: 7 };
    expect(rampedCap(50, src, day(1))).toBe(7);
    expect(rampedCap(50, src, day(2))).toBe(14);
    expect(rampedCap(50, src, day(6))).toBe(42);
    expect(rampedCap(50, src, day(7))).toBe(50);
    expect(rampedCap(50, src, day(30))).toBe(50);
  });

  it('rampedCap: never below 1 while the cap is positive, 0 when the cap is 0', () => {
    const src = { warmup_started_at: start.toISOString(), warmup_days: 7 };
    expect(rampedCap(3, src, day(1))).toBe(1);
    expect(rampedCap(0, src, day(1))).toBe(0);
    expect(rampedCap(50, { warmup_started_at: null, warmup_days: 7 }, day(1))).toBe(7);
  });

  it('dailyCapFor ramps the combined cap over the warm-up window', async () => {
    const f = await passingFixture({ mailboxCaps: [25, 25], warmupStartedAt: start.toISOString() });
    expect(await dailyCapFor(f.accountId, f.campaignId, day(1))).toBe(7);
    expect(await dailyCapFor(f.accountId, f.campaignId, day(7))).toBe(50);
    expect(await dailyCapFor(f.accountId, f.campaignId, day(9))).toBe(50);
  });

  it('dailyCapFor takes the minimum of account, campaign and ready mailbox caps', async () => {
    const f = await passingFixture({ accountCap: 30, campaignCap: 100, mailboxCaps: [25, 25] });
    expect(await dailyCapFor(f.accountId, f.campaignId)).toBe(30);
    await db.query(`update campaigns set daily_cap = 12 where id = $1`, [f.campaignId]);
    expect(await dailyCapFor(f.accountId, f.campaignId)).toBe(12);
    await db.query(`update mailboxes set status = 'warming' where id = $1`, [f.mailboxIds[0]]);
    await db.query(`update campaigns set daily_cap = 100 where id = $1`, [f.campaignId]);
    expect(await dailyCapFor(f.accountId, f.campaignId)).toBe(25);
    await db.query(`update mailboxes set status = 'warming' where id = $1`, [f.mailboxIds[1]]);
    expect(await dailyCapFor(f.accountId, f.campaignId)).toBe(0);
  });
});

describe('bounceRate', () => {
  it('is 0, not NaN, for a campaign with no sends', async () => {
    const f = await passingFixture();
    const rate = await bounceRate(f.accountId, f.campaignId);
    expect(rate).toBe(0);
    expect(Number.isNaN(rate)).toBe(false);
    await addStats(f, 0, 0, 0);
    expect(await bounceRate(f.accountId, f.campaignId)).toBe(0);
  });

  it('divides bounces by sent over the trailing window only', async () => {
    const f = await passingFixture();
    await addStats(f, 0, 50, 1);
    await addStats(f, 3, 50, 4);
    await addStats(f, 10, 100, 100);
    expect(await bounceRate(f.accountId, f.campaignId)).toBeCloseTo(0.05, 10);
    expect(await bounceRate(f.accountId, f.campaignId, 1)).toBeCloseTo(0.02, 10);
    expect(await bounceRate(f.accountId, f.campaignId, 30)).toBeCloseTo(105 / 200, 10);
  });
});

describe('enforceGuardrails', () => {
  async function pausedEvents(accountId: string): Promise<number> {
    const res = await db.query<{ n: string }>(
      `select count(*) as n from events where account_id = $1 and type = 'campaign.paused'`,
      [accountId],
    );
    return Number(res.rows[0]!.n);
  }

  it('pauses a campaign over the bounce threshold and does nothing on a second run', async () => {
    const f = await passingFixture();
    await addStats(f, 1, 100, 5);

    const first = await enforceGuardrails(f.accountId);
    expect(first.checked).toBe(1);
    expect(first.paused.length).toBe(1);
    expect(first.paused[0]!.campaign_id).toBe(f.campaignId);
    expect(first.paused[0]!.bounce_rate).toBeCloseTo(0.05, 10);
    expect(tokens(first.paused[0]!.reasons)).toEqual([GATE.bounce_rate]);

    const row = await db.query<{ status: string; paused_reason: string | null }>(
      `select status, paused_reason from campaigns where id = $1 and account_id = $2`,
      [f.campaignId, f.accountId],
    );
    expect(row.rows[0]!.status).toBe('paused');
    expect(row.rows[0]!.paused_reason).toContain(GATE.bounce_rate);
    expect(await pausedEvents(f.accountId)).toBe(1);

    const second = await enforceGuardrails(f.accountId);
    expect(second.paused).toEqual([]);
    expect(await pausedEvents(f.accountId)).toBe(1);
  });

  it('leaves a healthy campaign alone and ignores inactive ones', async () => {
    const f = await passingFixture();
    await addStats(f, 1, 100, 1);
    await db.query(`insert into campaigns (account_id, name, status) values ($1, 'Draft', 'draft')`, [f.accountId]);
    const res = await enforceGuardrails(f.accountId);
    expect(res.checked).toBe(1);
    expect(res.paused).toEqual([]);
    expect(await pausedEvents(f.accountId)).toBe(0);
  });

  it('does not pause for the non-pausing gates (compliance, daily cap)', async () => {
    const f = await passingFixture({ withCopy: false });
    await addStats(f, 0, 40, 0);
    const res = await enforceGuardrails(f.accountId);
    expect(res.paused).toEqual([]);
    const row = await db.query<{ status: string }>(`select status from campaigns where id = $1`, [f.campaignId]);
    expect(row.rows[0]!.status).toBe('sending');
  });

  it('pauses when credits run out or the account is paused', async () => {
    const f = await passingFixture({ credits: 0 });
    const res = await enforceGuardrails(f.accountId);
    expect(tokens(res.paused[0]?.reasons ?? [])).toEqual([GATE.no_credits]);

    const g = await passingFixture();
    await pauseSending(g.accountId, 'subscription_cancelled');
    const res2 = await enforceGuardrails(g.accountId);
    expect(tokens(res2.paused[0]?.reasons ?? [])).toEqual([GATE.account_paused]);
  });
});

describe('pauseSending / resumeSending', () => {
  it('sets the account flags, writes events, and is idempotent', async () => {
    const f = await passingFixture();
    expect(await pauseSending(f.accountId, 'subscription_cancelled')).toEqual({ changed: true });
    expect(await pauseSending(f.accountId, 'subscription_cancelled')).toEqual({ changed: false });

    let acct = await db.query<{ sending_paused: boolean; paused_reason: string | null }>(
      `select sending_paused, paused_reason from accounts where id = $1`,
      [f.accountId],
    );
    expect(acct.rows[0]).toEqual({ sending_paused: true, paused_reason: 'subscription_cancelled' });

    expect(await resumeSending(f.accountId)).toEqual({ changed: true });
    expect(await resumeSending(f.accountId)).toEqual({ changed: false });
    acct = await db.query(`select sending_paused, paused_reason from accounts where id = $1`, [f.accountId]);
    expect(acct.rows[0]).toEqual({ sending_paused: false, paused_reason: null });

    const events = await db.query<{ type: string }>(
      `select type from events where account_id = $1 order by created_at asc`,
      [f.accountId],
    );
    expect(events.rows.map((e) => e.type)).toEqual(['account.sending_paused', 'account.sending_resumed']);
  });
});

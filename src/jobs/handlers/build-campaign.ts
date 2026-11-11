/**
 * build_campaign — stage 5, step 4. The EmailBison sequence from VENDOR_NOTES §1:
 * createCampaign -> attachSenders -> uploadLeads -> setSchedule.
 *
 * assertCanSend runs FIRST (SPEC §5, all seven gates). A failing gate aborts
 * with the reasons in the result and on `campaigns.error`; nothing is created.
 *
 * Idempotency: the provider_ref is stored the moment createCampaign returns, so
 * a re-run attaches and uploads against the same vendor campaign; only
 * campaign_leads still `pending` are uploaded and each uploaded batch is marked
 * `queued` with the provider_ref before the next batch goes. attachSenders and
 * setSchedule are naturally repeatable.
 *
 * Suppression is checked once more at upload time (I3: "before every upload").
 * `{{unsubscribe_link}}` is substituted per lead with a signed URL.
 *
 * On success: status `scheduled`, then launch_campaign is enqueued (it re-checks
 * the gates because the state may have moved).
 *
 * Payload: { account_id, campaign_id }
 */

import { assertCanSend, dailyCapFor } from '../../lib/guardrails';
import { unsubscribeUrl } from '../../lib/unsubscribe';
import type { CampaignStatus, CopyStep, Job, JobResult } from '../../lib/contracts';
import type { JobDeps } from '../registry';
import { accountIdOf, done, logEvent, notSuppressedSql, requireString, stringArray, terminal } from './_shared';

/** EmailBison accepts at most 500 leads per request (VENDOR_NOTES §1 step 5). */
export const UPLOAD_BATCH = 500;
export const MAX_UPLOAD_PER_JOB = 20_000;

interface CampaignRow {
  id: string;
  name: string;
  status: CampaignStatus;
  timezone: string;
  send_window_start: string;
  send_window_end: string;
  send_days: unknown;
  daily_cap: number;
  provider: string | null;
  provider_ref: string | null;
}

interface LeadRow {
  campaign_lead_id: string;
  email: string;
  first_name: string | null;
  last_name: string | null;
  company_name: string | null;
  title: string | null;
  industry: string | null;
}

function field(v: string | null): string {
  return v ?? '';
}

export async function buildCampaign(job: Job, deps: JobDeps): Promise<JobResult> {
  const accountId = accountIdOf(job);
  if (!accountId) return terminal('no account_id on job');
  const campaignId = requireString(job, 'campaign_id');
  const { db } = deps;

  const campRes = await db.query<CampaignRow>(
    `select id, name, status, timezone, send_window_start, send_window_end, send_days, daily_cap, provider, provider_ref
     from campaigns where id = $1 and account_id = $2`,
    [campaignId, accountId],
  );
  const campaign = campRes.rows[0];
  if (!campaign) return terminal('campaign not found on this account', { campaign_id: campaignId });
  if (campaign.status === 'sending') return done({ skipped: 'campaign is already sending', campaign_id: campaignId });

  // --- gates first. Nothing is created until every one passes.
  const check = await assertCanSend(accountId, campaignId);
  if (!check.allowed) {
    const reason = `build refused: ${check.reasons.join('; ')}`.slice(0, 2000);
    await db.query(`update campaigns set error = $3, updated_at = now() where id = $1 and account_id = $2`,
      [campaignId, accountId, reason]);
    await logEvent(db, accountId, 'campaign.build_refused', campaignId, {
      campaign_id: campaignId, reasons: check.reasons, failed_gates: check.failed_gates,
    });
    return terminal('send gates failed', { campaign_id: campaignId, reasons: check.reasons, failed_gates: check.failed_gates });
  }

  const copyRes = await db.query<{ id: string; version: number; steps: CopyStep[] }>(
    `select id, version, steps from campaign_copy
     where campaign_id = $1 and account_id = $2 and compliance_passed = true
     order by version desc limit 1`,
    [campaignId, accountId],
  );
  const copy = copyRes.rows[0];
  if (!copy || !Array.isArray(copy.steps) || copy.steps.length === 0) {
    return terminal('no compliant copy version to build from', { campaign_id: campaignId });
  }

  const sendersRes = await db.query<{ sender_email_id: string }>(
    `select sender_email_id from mailboxes
     where account_id = $1 and status = 'ready' and sender_email_id is not null order by email`,
    [accountId],
  );
  const senderIds = sendersRes.rows.map((r) => r.sender_email_id);
  if (senderIds.length === 0) return terminal('no ready mailbox has a sender id in the sending platform', { campaign_id: campaignId });

  await db.query(
    `update campaigns set status = 'building', error = null, updated_at = now()
     where id = $1 and account_id = $2 and status <> 'building'`,
    [campaignId, accountId],
  );

  const providers = await deps.providers();
  const sending = providers.sending;

  // 1. create (once)
  let providerRef = campaign.provider_ref;
  let created = false;
  if (!providerRef) {
    const made = await sending.createCampaign({ name: campaign.name, steps: copy.steps, timezone: campaign.timezone });
    providerRef = made.provider_ref;
    created = true;
    await db.query(
      `update campaigns set provider = $3, provider_ref = $4, updated_at = now() where id = $1 and account_id = $2`,
      [campaignId, accountId, sending.name, providerRef],
    );
  }

  // 2. senders
  await sending.attachSenders({ provider_ref: providerRef, sender_email_ids: senderIds });

  // 3. leads, pending only, suppression-filtered, in vendor-sized batches
  const leadsRes = await db.query<LeadRow>(
    `select cl.id as campaign_lead_id, l.email, l.first_name, l.last_name, l.company_name, l.title, l.industry
     from campaign_leads cl join leads l on l.id = cl.lead_id and l.account_id = cl.account_id
     where cl.campaign_id = $1 and cl.account_id = $2 and cl.status = 'pending'
       and ${notSuppressedSql('l', '$2')}
     order by cl.created_at asc
     limit $3`,
    [campaignId, accountId, MAX_UPLOAD_PER_JOB + 1],
  );
  const uploadTruncated = leadsRes.rows.length > MAX_UPLOAD_PER_JOB;
  const toUpload = leadsRes.rows.slice(0, MAX_UPLOAD_PER_JOB);

  const sendingName = await db.query<{ sending_name: string | null }>(
    `select sending_name from onboarding_profiles where account_id = $1`, [accountId],
  );
  const senderName = sendingName.rows[0]?.sending_name ?? '';

  let uploaded = 0;
  let rejected = 0;
  let batches = 0;
  for (let i = 0; i < toUpload.length; i += UPLOAD_BATCH) {
    const batch = toUpload.slice(i, i + UPLOAD_BATCH);
    const res = await sending.uploadLeads({
      provider_ref: providerRef,
      leads: batch.map((l) => ({
        email: l.email,
        fields: {
          first_name: field(l.first_name),
          last_name: field(l.last_name),
          company_name: field(l.company_name),
          title: field(l.title),
          industry: field(l.industry),
          sending_name: senderName,
          unsubscribe_link: unsubscribeUrl({ accountId, email: l.email, campaignId }),
        },
      })),
    });
    uploaded += res.uploaded;
    rejected += res.rejected;
    batches += 1;
    // Array literal rather than a driver-serialised array: identical on pg and PGlite.
    const idList = `{${batch.map((l) => l.campaign_lead_id).join(',')}}`;
    await db.query(
      `update campaign_leads set status = 'queued', provider_ref = $3
       where account_id = $2 and campaign_id = $4 and status = 'pending' and id = any($1::uuid[])`,
      [idList, accountId, providerRef, campaignId],
    );
  }

  const queuedRes = await db.query<{ n: string | number }>(
    `select count(*) as n from campaign_leads where campaign_id = $1 and account_id = $2 and status = 'queued'`,
    [campaignId, accountId],
  );
  const queued = Number(queuedRes.rows[0]?.n ?? 0);
  if (queued === 0) {
    await db.query(`update campaigns set error = 'no leads to send to', updated_at = now() where id = $1 and account_id = $2`,
      [campaignId, accountId]);
    return terminal('campaign has no uploadable leads', { campaign_id: campaignId, uploaded, rejected });
  }

  // 4. schedule, with today's ramped cap (never above the campaign's own cap)
  const ramped = await dailyCapFor(accountId, campaignId);
  const dailyCap = Math.max(1, Math.min(Number(campaign.daily_cap), ramped > 0 ? ramped : Number(campaign.daily_cap)));
  const days = stringArray(campaign.send_days);
  await sending.setSchedule({
    provider_ref: providerRef,
    timezone: campaign.timezone,
    window_start: campaign.send_window_start,
    window_end: campaign.send_window_end,
    days: days.length > 0 ? days : ['mon', 'tue', 'wed', 'thu', 'fri'],
    daily_cap: dailyCap,
  });

  await db.query(
    `update campaigns set status = 'scheduled', error = null, updated_at = now() where id = $1 and account_id = $2`,
    [campaignId, accountId],
  );

  const detail = {
    campaign_id: campaignId,
    provider: sending.name,
    provider_ref: providerRef,
    created,
    copy_version: Number(copy.version),
    senders: senderIds.length,
    uploaded,
    rejected,
    batches,
    queued,
    upload_truncated: uploadTruncated,
    daily_cap: dailyCap,
    status: 'scheduled',
  };
  await logEvent(db, accountId, 'campaign.built', campaignId, detail);

  return done(detail, [{
    type: 'launch_campaign',
    payload: { account_id: accountId, campaign_id: campaignId },
    dedupe_key: `launch_campaign:${campaignId}`,
  }]);
}

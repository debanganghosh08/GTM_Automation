/**
 * classify_replies — stage 6. Runs the CHEAP model over unclassified replies and
 * stores `sentiment` + `classified_by`. An `unsubscribe` verdict writes a
 * suppression row (I3) and marks the lead's in-flight sends unsubscribed.
 *
 * Confidence floor: an `interested` verdict under CONFIDENCE_FLOOR is stored as
 * `unclear` so a hesitant model never inflates the interested count; the UI
 * shows it for a human read (contracts.ts, ReplyClassification).
 *
 * Idempotent: only `sentiment is null` rows are touched, each updated the moment
 * its verdict lands; suppression inserts are `on conflict do nothing`. Bounded
 * to MAX_PER_RUN replies; the rest wait for the next run.
 *
 * The classifier prompt is inline (no prompts/classify directory exists yet);
 * CLASSIFY_PROMPT_VERSION is written to `classified_by` with the model name.
 *
 * Payload: { account_id, campaign_id? }
 */

import type { Job, JobResult, ReplyClassification, ReplySentiment } from '../../lib/contracts';
import type { JobDeps } from '../registry';
import { accountIdOf, done, errText, logEvent, payloadString, terminal } from './_shared';

export const MAX_PER_RUN = 200;
export const CONFIDENCE_FLOOR = 0.6;
export const CLASSIFY_PROMPT_VERSION = 'classify-v001';

const SENTIMENTS: ReadonlySet<string> = new Set<ReplySentiment>([
  'interested', 'not_interested', 'objection', 'out_of_office', 'referral', 'unsubscribe', 'unclear',
]);

export const REPLY_CLASSIFICATION_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    sentiment: { type: 'string', enum: [...SENTIMENTS] },
    confidence: { type: 'number', description: 'Your own confidence in the sentiment, 0 to 1.' },
    reason: { type: 'string', description: 'One short sentence quoting the words that decided it.' },
  },
  required: ['sentiment', 'confidence', 'reason'],
  additionalProperties: false,
};

export const CLASSIFY_SYSTEM_PROMPT = [
  'You classify a single reply to a cold outbound email. Return ONE JSON object and nothing else.',
  'Sentiments: interested (asks for more, pricing, a call, says yes), not_interested (declines),',
  'objection (raises a blocker but does not decline outright), out_of_office (auto-responder),',
  'referral (points to another person), unsubscribe (asks to be removed or to stop emailing),',
  'unclear (anything else). Prefer unsubscribe over not_interested whenever the reply asks to stop.',
  'confidence is your own estimate from 0 to 1. Quote the deciding words in reason. Never invent intent.',
].join('\n');

interface ReplyRow {
  id: string;
  lead_id: string | null;
  campaign_id: string | null;
  from_email: string | null;
  subject: string | null;
  body_preview: string | null;
}

export async function classifyReplies(job: Job, deps: JobDeps): Promise<JobResult> {
  const accountId = accountIdOf(job);
  if (!accountId) return terminal('no account_id on job');
  const campaignId = payloadString(job, 'campaign_id');
  const { db } = deps;

  const pending = campaignId
    ? await db.query<ReplyRow>(
        `select id, lead_id, campaign_id, from_email, subject, body_preview from reply_messages
         where account_id = $1 and campaign_id = $2 and sentiment is null
         order by received_at asc nulls last, created_at asc limit $3`,
        [accountId, campaignId, MAX_PER_RUN + 1],
      )
    : await db.query<ReplyRow>(
        `select id, lead_id, campaign_id, from_email, subject, body_preview from reply_messages
         where account_id = $1 and sentiment is null
         order by received_at asc nulls last, created_at asc limit $2`,
        [accountId, MAX_PER_RUN + 1],
      );
  const truncated = pending.rows.length > MAX_PER_RUN;
  const rows = pending.rows.slice(0, MAX_PER_RUN);
  if (rows.length === 0) return done({ campaign_id: campaignId, classified: 0, truncated: false });

  const providers = await deps.providers();
  const counts: Record<string, number> = {};
  let classified = 0;
  let suppressed = 0;
  let downgraded = 0;
  const errors: Record<string, unknown>[] = [];

  for (const r of rows) {
    let verdict: ReplyClassification;
    let model: string;
    try {
      const out = await providers.llm.json<ReplyClassification>({
        system: CLASSIFY_SYSTEM_PROMPT,
        user: `Subject: ${r.subject ?? ''}\n\n${(r.body_preview ?? '').slice(0, 4000)}`,
        schema_name: 'reply_classification',
        schema: REPLY_CLASSIFICATION_SCHEMA,
        model: 'cheap',
        max_tokens: 200,
        cache_system: true,
      });
      verdict = out.value;
      model = out.model;
    } catch (err) {
      errors.push({ reply_id: r.id, error: errText(err) });
      continue;
    }

    let sentiment: ReplySentiment = SENTIMENTS.has(verdict.sentiment) ? verdict.sentiment : 'unclear';
    const confidence = Number.isFinite(verdict.confidence) ? Math.max(0, Math.min(1, verdict.confidence)) : 0;
    if (sentiment === 'interested' && confidence < CONFIDENCE_FLOOR) {
      sentiment = 'unclear';
      downgraded += 1;
    }

    const upd = await db.query(
      `update reply_messages set sentiment = $3::reply_sentiment, classified_by = $4
       where id = $1 and account_id = $2 and sentiment is null`,
      [r.id, accountId, sentiment, `${model}/${CLASSIFY_PROMPT_VERSION}`],
    );
    if (upd.rowCount === 0) continue; // another worker got there first
    classified += 1;
    counts[sentiment] = (counts[sentiment] ?? 0) + 1;

    if (sentiment === 'unsubscribe' && r.from_email) {
      const email = r.from_email.trim().toLowerCase();
      const sup = await db.query(
        `insert into suppressions (account_id, email, reason) values ($1, $2, 'reply_unsubscribe')
         on conflict do nothing`,
        [accountId, email],
      );
      suppressed += sup.rowCount;
      await db.query(
        `update campaign_leads cl set status = 'unsubscribed'
         from leads l
         where cl.lead_id = l.id and cl.account_id = $1 and lower(l.email) = $2
           and cl.status in ('pending', 'queued', 'sent')`,
        [accountId, email],
      );
      await logEvent(db, accountId, 'reply.unsubscribe', r.campaign_id, {
        reply_id: r.id, campaign_id: r.campaign_id, lead_id: r.lead_id, confidence,
      });
    }
  }

  return done({ campaign_id: campaignId, classified, counts, suppressed, downgraded, errors, truncated }, truncated
    ? [{ type: 'classify_replies', payload: { account_id: accountId, ...(campaignId ? { campaign_id: campaignId } : {}) },
        dedupe_key: `classify_replies:${campaignId ?? accountId}` }]
    : undefined);
}

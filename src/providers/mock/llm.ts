/**
 * Mock LLM. Returns a fixture shaped to `schema_name`, so the strategy and
 * copy pages render offline and the compliance checker has real input.
 *
 * The copy fixture obeys docs/VENDOR_NOTES.md §2 on purpose: word limits per
 * step, no em dashes, no buzzwords, a P.S. opt-out line and `{{unsubscribe_link}}`
 * in every body. If a checker rule changes, this fixture is the first test of it.
 *
 * An unknown schema_name throws so a missing fixture never degrades to `{}`.
 */

import type { CampaignCopy, GtmStrategy, LlmProvider, ReplySentiment } from '../../lib/contracts';
import { env } from '../../lib/env';

const GTM_STRATEGY: GtmStrategy = {
  positioning:
    'An outbound engine for teams that have product-market fit but no time to run prospecting themselves. (Placeholder strategy from the mock LLM.)',
  icp: {
    summary: 'Founders and revenue leaders at 20 to 200 person B2B companies who sell a considered purchase and have no dedicated SDR team.',
    titles: ['Founder', 'CEO', 'VP Sales', 'Head of Growth', 'Revenue Operations Lead'],
    industries: ['Software', 'Professional Services', 'Logistics'],
    geos: ['United States', 'United Kingdom', 'Canada'],
    headcount_min: 20,
    headcount_max: 200,
    exclusions: ['Agencies', 'Competitors', 'Existing customers'],
  },
  segments: [
    {
      name: 'Founder-led sales',
      description: 'Founders still closing most deals themselves and feeling the ceiling on their own calendar.',
      signals: ['no SDR hires on the team page', 'founder posts about pipeline on LinkedIn'],
      angle: 'Get the founder out of top-of-funnel without hiring a team.',
      estimated_size: 1_200,
    },
    {
      name: 'First sales hire in seat',
      description: 'Companies with one or two AEs and no one feeding them meetings.',
      signals: ['hiring SDRs', 'raised seed or series A in the last 12 months'],
      angle: 'Keep the new reps closing instead of list building.',
      estimated_size: 800,
    },
    {
      name: 'Outbound that stalled',
      description: 'Teams that tried a tool or an agency, saw deliverability drop, and stopped.',
      signals: ['sending domain has no DMARC record', 'churned from a known outbound tool'],
      angle: 'A warmed, monitored setup that does not land in spam.',
      estimated_size: 500,
    },
  ],
  offer: {
    headline: 'Qualified conversations without building an outbound team',
    body: 'We build the list, verify it, warm the inboxes, write the sequence and send on your behalf. You review the first campaign before anything goes out and only pay for emails that actually send.',
    proof_points: [],
    risk_reversal: 'Review and approve every first campaign before a single email is sent.',
  },
  sequence_plan: [
    { step: 1, delay_days: 0, purpose: 'Name a specific pain and ask whether it is a priority.', channel: 'email' },
    { step: 2, delay_days: 3, purpose: 'Show the outcome as a short before-and-after, soft ask to read a plan.', channel: 'email' },
    { step: 3, delay_days: 4, purpose: 'Polite last touch with an easy way back in.', channel: 'email' },
  ],
  rationale:
    'The inputs describe a product sold to busy operators, so the sequence leads with a pain they already feel and keeps every ask small. Three touches over a week is enough to be noticed without becoming noise.',
  assumptions: [
    'Assumed the buyer is the person who feels the pain, not procurement.',
    'Assumed no existing outbound tooling the customer wants to keep.',
    'Proof points were left empty because none were supplied at onboarding; the generator must not invent them.',
  ],
};

const CAMPAIGN_COPY: CampaignCopy = {
  steps: [
    {
      step: 1,
      delay_days: 0,
      subject: '{quick question|pipeline question|outbound at {{company_name}}}',
      body: [
        '{{first_name}}, saw that {{company_name}} is growing its {{industry}} team.',
        '',
        'Most teams at that stage lose weeks of selling time to list building and inbox setup.',
        '',
        'We run the whole outbound motion for you, without adding headcount or another tool to babysit.',
        '',
        'Worth a look, or not a priority right now?',
        '',
        '{{sending_name}}',
        '',
        'P.S. If this is not relevant, reply "no" and I will not write again. Opt out here: {{unsubscribe_link}}',
      ].join('\n'),
      note: 'Pain first, soft question, no calendar ask on the first touch.',
    },
    {
      step: 2,
      delay_days: 3,
      subject: '{quick question|pipeline question|outbound at {{company_name}}}',
      body: [
        '{{first_name}}, following up on my last note.',
        '',
        'Here is what the teams we work with usually see in the first month.',
        '',
        'A clean, verified list of buyers who look like their best customers.',
        '',
        'A sending setup that lands in the inbox instead of the spam folder.',
        '',
        'A steady flow of replies without pulling anyone off their day job.',
        '',
        'The {{title}} usually reviews the first campaign and then lets it run.',
        '',
        'If I sent over a short plan for {{company_name}}, would you read it?',
        '',
        '{{sending_name}}',
        '',
        'P.S. Not the right fit? Reply "no" and this is the last you hear from me. Opt out here: {{unsubscribe_link}}',
      ].join('\n'),
      note: 'Outcomes, not features. Still a soft ask.',
    },
    {
      step: 3,
      delay_days: 4,
      subject: '{quick question|pipeline question|outbound at {{company_name}}}',
      body: [
        '{{first_name}}, last note from me.',
        '',
        'I will assume outbound is not a priority at {{company_name}} right now.',
        '',
        'If that changes, just reply here and I will pick it back up.',
        '',
        '{{sending_name}}',
        '',
        'P.S. To opt out for good, reply "no" or use this link: {{unsubscribe_link}}',
      ].join('\n'),
      note: 'Soft breakup. Names itself as the last touch and leaves the door open.',
    },
  ],
};

interface ReplyClassification {
  sentiment: ReplySentiment;
  confidence: number;
  reason: string;
}

/** Keyword rules so the demo classifier behaves sensibly on the mock replies. */
function classifyReply(text: string): ReplyClassification {
  const t = text.toLowerCase();
  const rule = (sentiment: ReplySentiment, reason: string): ReplyClassification => ({ sentiment, confidence: 0.9, reason });
  if (/unsubscribe|remove me|stop emailing/.test(t)) return rule('unsubscribe', 'Asked to be removed.');
  if (/out of (the )?office|automatic reply|on leave|back on/.test(t)) return rule('out_of_office', 'Auto-responder language.');
  if (/not my area|copied here|talk to our|right person|forward/.test(t)) return rule('referral', 'Points to someone else.');
  if (/not interested|no thanks|not looking|not right now|happy with/.test(t)) return rule('not_interested', 'Declined.');
  if (/already use|too expensive|budget|concern|but we/.test(t)) return rule('objection', 'Raises a blocker.');
  if (/interest|send over|more detail|pricing|tell me more|sounds relevant|yes/.test(t)) return rule('interested', 'Asks for more.');
  return { sentiment: 'unclear', confidence: 0.4, reason: 'No clear signal in the text.' };
}

const FIXTURES: Record<string, (user: string) => unknown> = {
  gtm_strategy: () => structuredClone(GTM_STRATEGY),
  campaign_copy: () => structuredClone(CAMPAIGN_COPY),
  reply_classification: (user) => classifyReply(user),
};

export function mockLlmSchemaNames(): string[] {
  return Object.keys(FIXTURES);
}

export class MockLlmProvider implements LlmProvider {
  readonly name = 'mock-anthropic';

  async json<T>(input: {
    system: string;
    user: string;
    schema_name: string;
    schema: Record<string, unknown>;
    model?: 'strategy' | 'copy' | 'cheap';
    max_tokens?: number;
    cache_system?: boolean;
  }): Promise<{ value: T; model: string; input_tokens: number; output_tokens: number }> {
    const fixture = FIXTURES[input.schema_name];
    if (!fixture) {
      throw new Error(
        `MockLlmProvider has no fixture for schema_name "${input.schema_name}". ` +
          `Known: ${mockLlmSchemaNames().join(', ')}. Add one in src/providers/mock/llm.ts.`,
      );
    }
    const value = fixture(input.user) as T;
    const modelKey = input.model ?? 'cheap';
    return {
      value,
      model: `mock/${env.models[modelKey]}`,
      // Roughly four characters per token, the usual back-of-envelope figure.
      input_tokens: Math.ceil((input.system.length + input.user.length) / 4),
      output_tokens: Math.ceil(JSON.stringify(value).length / 4),
    };
  }
}

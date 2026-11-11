/**
 * Mock sending platform. Campaigns live in a module-level Map for the life of
 * the process. Once launched, a campaign "sends" at a fixed pace so the
 * dashboard has a funnel to show, and replies are generated with stable
 * provider_refs so a re-sync never duplicates them.
 *
 * Time comes from an injectable clock (default Date.now) so tests can freeze it.
 */

import type { CampaignStats, CopyStep, IsoTimestamp, SendingProvider } from '../../lib/contracts';
import { fnv1a, pick } from './hash';

type Clock = () => number;

interface MockSender {
  sender_email_id: string;
  email: string;
}

interface MockSchedule {
  timezone: string;
  window_start: string;
  window_end: string;
  days: string[];
  daily_cap: number;
}

interface MockCampaign {
  ref: string;
  name: string;
  steps: CopyStep[];
  timezone: string;
  sender_email_ids: string[];
  leads: Map<string, Record<string, string>>;
  schedule: MockSchedule | null;
  state: 'draft' | 'running' | 'paused';
  launched_at: number | null;
  /** Active sending time accumulated before the current run (pauses stop the clock). */
  active_ms: number;
  run_started_at: number | null;
  bounce_rate: number;
}

// Funnel ratios. Bounce rate is per-campaign so guardrail tests can trip it.
const OPEN_RATE = 0.4;
const REPLY_RATE = 0.04;
const DEFAULT_BOUNCE_RATE = 0.015;
const UNSUBSCRIBE_RATE = 0.005;
const INTERESTED_SHARE_OF_REPLIES = 0.3;

/** First batch goes out at launch, then one more email every SEND_INTERVAL_MS. */
const INITIAL_BATCH = 25;
const SEND_INTERVAL_MS = 2_000;
const REPLY_SPACING_MS = 20_000;
const DAY_MS = 86_400_000;

const REPLY_FIXTURES: ReadonlyArray<{ subject: string; body: string }> = [
  { subject: 're: quick question', body: 'Sure, this sounds relevant. Can you send over more detail on how it works?' },
  { subject: 're: quick question', body: 'Thanks but we are not looking at this right now. Please remove me from your list.' },
  { subject: 'Automatic reply: quick question', body: 'I am out of the office until next week with limited access to email.' },
  { subject: 're: quick question', body: 'Not my area. You want to talk to our head of growth, copied here.' },
  { subject: 're: quick question', body: 'Interesting. What does pricing look like for a team our size?' },
  { subject: 're: quick question', body: 'We already use a tool for this and are happy with it. No thanks.' },
  { subject: 're: quick question', body: 'Unsubscribe.' },
];

const campaigns = new Map<string, MockCampaign>();
const senders = new Map<string, MockSender>();
let nextCampaignSeq = 1;
let moduleClock: Clock | null = null;

function clockNow(local: Clock | null): number {
  return (local ?? moduleClock ?? Date.now)();
}

function requireCampaign(ref: string): MockCampaign {
  const campaign = campaigns.get(ref);
  if (!campaign) throw new Error(`mock-sending: unknown campaign provider_ref "${ref}"`);
  return campaign;
}

function activeMs(campaign: MockCampaign, now: number): number {
  const current = campaign.run_started_at === null ? 0 : Math.max(0, now - campaign.run_started_at);
  return campaign.active_ms + current;
}

function sentCount(campaign: MockCampaign, now: number): number {
  if (campaign.launched_at === null) return 0;
  const uploaded = campaign.leads.size;
  const elapsed = activeMs(campaign, now);
  const byPace = INITIAL_BATCH + Math.floor(elapsed / SEND_INTERVAL_MS);
  const dailyCap = campaign.schedule?.daily_cap;
  const byCap = dailyCap === undefined ? Infinity : dailyCap * (Math.floor(elapsed / DAY_MS) + 1);
  return Math.max(0, Math.min(uploaded, byPace, byCap));
}

function funnel(campaign: MockCampaign, now: number): Omit<CampaignStats, 'campaign_id' | 'bounce_rate' | 'reply_rate'> {
  const sent = sentCount(campaign, now);
  const bounces = Math.min(sent, Math.round(sent * campaign.bounce_rate));
  const replies = Math.round(sent * REPLY_RATE);
  return {
    sent,
    delivered: sent - bounces,
    opens: Math.round(sent * OPEN_RATE),
    replies,
    bounces,
    unsubscribes: Math.round(sent * UNSUBSCRIBE_RATE),
    interested: Math.round(replies * INTERESTED_SHARE_OF_REPLIES),
  };
}

/** Mock mailboxes register here so listSenders mirrors what was provisioned. */
export function __registerMockSender(sender: MockSender): void {
  senders.set(sender.sender_email_id, sender);
}

export function __resetMockSending(): void {
  campaigns.clear();
  senders.clear();
  nextCampaignSeq = 1;
  moduleClock = null;
}

/** Forces a bounce rate (0..1) on one campaign so guardrail tests can trip auto-pause. */
export function __setMockBounceRate(ref: string, rate: number): void {
  if (!(rate >= 0 && rate <= 1)) throw new Error(`mock-sending: bounce rate must be in [0, 1], got ${rate}`);
  requireCampaign(ref).bounce_rate = rate;
}

/** Replaces the default clock for every instance that was not given its own. */
export function __setMockSendingClock(now: Clock | null): void {
  moduleClock = now;
}

export class MockSendingProvider implements SendingProvider {
  readonly name = 'mock-emailbison';
  private readonly clock: Clock | null;

  constructor(options: { now?: Clock } = {}) {
    this.clock = options.now ?? null;
  }

  private now(): number {
    return clockNow(this.clock);
  }

  async listSenders(): Promise<Array<{ sender_email_id: string; email: string }>> {
    return [...senders.values()].map((s) => ({ ...s }));
  }

  async createCampaign(input: { name: string; steps: CopyStep[]; timezone: string }): Promise<{ provider_ref: string }> {
    const ref = `mock-campaign-${nextCampaignSeq}`;
    nextCampaignSeq += 1;
    campaigns.set(ref, {
      ref,
      name: input.name,
      steps: input.steps.map((s) => ({ ...s })),
      timezone: input.timezone,
      sender_email_ids: [],
      leads: new Map(),
      schedule: null,
      state: 'draft',
      launched_at: null,
      active_ms: 0,
      run_started_at: null,
      bounce_rate: DEFAULT_BOUNCE_RATE,
    });
    return { provider_ref: ref };
  }

  async attachSenders(input: { provider_ref: string; sender_email_ids: string[] }): Promise<void> {
    const campaign = requireCampaign(input.provider_ref);
    campaign.sender_email_ids = [...new Set([...campaign.sender_email_ids, ...input.sender_email_ids])];
  }

  async uploadLeads(input: {
    provider_ref: string;
    leads: Array<{ email: string; fields: Record<string, string> }>;
  }): Promise<{ uploaded: number; rejected: number }> {
    const campaign = requireCampaign(input.provider_ref);
    let uploaded = 0;
    let rejected = 0;
    for (const lead of input.leads) {
      const email = lead.email.trim().toLowerCase();
      const valid = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
      if (!valid || campaign.leads.has(email)) {
        rejected += 1;
        continue;
      }
      campaign.leads.set(email, { ...lead.fields });
      uploaded += 1;
    }
    return { uploaded, rejected };
  }

  async setSchedule(input: {
    provider_ref: string;
    timezone: string;
    window_start: string;
    window_end: string;
    days: string[];
    daily_cap: number;
  }): Promise<void> {
    const campaign = requireCampaign(input.provider_ref);
    campaign.schedule = {
      timezone: input.timezone,
      window_start: input.window_start,
      window_end: input.window_end,
      days: [...input.days],
      daily_cap: input.daily_cap,
    };
  }

  async launch(input: { provider_ref: string }): Promise<void> {
    const campaign = requireCampaign(input.provider_ref);
    if (campaign.state === 'running') return;
    const now = this.now();
    if (campaign.launched_at === null) campaign.launched_at = now;
    campaign.run_started_at = now;
    campaign.state = 'running';
  }

  async pause(input: { provider_ref: string }): Promise<void> {
    const campaign = requireCampaign(input.provider_ref);
    if (campaign.state !== 'running') return;
    campaign.active_ms = activeMs(campaign, this.now());
    campaign.run_started_at = null;
    campaign.state = 'paused';
  }

  async getStats(input: { provider_ref: string }): Promise<Omit<CampaignStats, 'campaign_id' | 'bounce_rate' | 'reply_rate'>> {
    return funnel(requireCampaign(input.provider_ref), this.now());
  }

  async getReplies(input: { provider_ref: string; since?: IsoTimestamp }): Promise<Array<{
    provider_ref: string;
    from_email: string;
    subject: string | null;
    body_preview: string | null;
    received_at: IsoTimestamp;
  }>> {
    const campaign = requireCampaign(input.provider_ref);
    if (campaign.launched_at === null) return [];
    const now = this.now();
    const sinceMs = input.since ? Date.parse(input.since) : Number.NEGATIVE_INFINITY;
    const leadEmails = [...campaign.leads.keys()];
    if (leadEmails.length === 0) return [];

    const total = funnel(campaign, now).replies;
    const seed = fnv1a(campaign.ref);
    const out = [];
    for (let i = 0; i < total; i++) {
      // Fixed offsets from launch keep every reply's timestamp stable across calls.
      const receivedMs = campaign.launched_at + (i + 1) * REPLY_SPACING_MS;
      if (receivedMs > now || receivedMs <= sinceMs) continue;
      const fixture = pick(REPLY_FIXTURES, seed + i);
      out.push({
        provider_ref: `${campaign.ref}:reply:${i + 1}`,
        from_email: pick(leadEmails, i),
        subject: fixture.subject,
        body_preview: fixture.body,
        received_at: new Date(receivedMs).toISOString(),
      });
    }
    return out;
  }
}

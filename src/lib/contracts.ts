/**
 * GTM Autopilot — shared contracts.
 *
 * This file is the single source of truth for every module boundary. Modules talk
 * to each other ONLY through these types. If you need to change a type here,
 * that is a contract change: update docs/SPEC.md in the same commit.
 *
 * Mirrors supabase/migrations/0001_init.sql.
 */

// ---------------------------------------------------------------- primitives

export type Uuid = string;
export type IsoTimestamp = string;

export type AccountStatus = 'trialing' | 'active' | 'past_due' | 'paused' | 'cancelled';
export type DomainStatus =
  | 'pending' | 'purchasing' | 'dns_pending' | 'verifying' | 'warming' | 'ready' | 'failed';
export type MailboxStatus = 'pending' | 'provisioning' | 'warming' | 'ready' | 'paused' | 'failed';
export type CampaignStatus =
  | 'draft' | 'awaiting_copy' | 'awaiting_review' | 'pending_approval' | 'approved'
  | 'building' | 'scheduled' | 'sending' | 'paused' | 'completed' | 'failed';
export type LeadVerification = 'unverified' | 'valid' | 'invalid' | 'risky' | 'catch_all' | 'unknown';
export type SendStatus =
  | 'pending' | 'queued' | 'sent' | 'bounced' | 'replied' | 'unsubscribed' | 'failed' | 'skipped';
export type ReplySentiment =
  | 'interested' | 'not_interested' | 'objection' | 'out_of_office' | 'referral' | 'unsubscribe' | 'unclear';
export type JobStatus = 'pending' | 'running' | 'succeeded' | 'failed' | 'dead';
export type ApprovalStatus = 'pending' | 'approved' | 'rejected';

// ---------------------------------------------------------------- domain rows

export interface Account {
  id: Uuid;
  company_name: string;
  website_url: string | null;
  status: AccountStatus;
  daily_send_cap: number;
  bounce_pause_threshold: number;
  first_campaign_approved: boolean;
  sending_paused: boolean;
  paused_reason: string | null;
  trial_ends_at: IsoTimestamp | null;
  created_at: IsoTimestamp;
  updated_at: IsoTimestamp;
}

export interface User {
  id: Uuid;
  account_id: Uuid;
  email: string;
  password_hash: string | null;
  name: string | null;
  is_admin: boolean;
  created_at: IsoTimestamp;
}

export interface RedemptionCode {
  code: string;
  partner: string;
  credits_granted: number;
  trial_days: number;
  max_redemptions: number | null;
  times_redeemed: number;
  expires_at: IsoTimestamp | null;
  active: boolean;
}

// ---------------------------------------------------------------- stage 2: onboarding

/** Questionnaire answers. Every field optional until `completed_at` is set. */
export interface OnboardingProfile {
  id: Uuid;
  account_id: Uuid;
  product: string | null;
  icp_description: string | null;
  offer: string | null;
  proof_points: string[];
  sending_name: string | null;
  target_titles: string[];
  target_industries: string[];
  target_geos: string[];
  headcount_min: number | null;
  headcount_max: number | null;
  exclusions: string[];
  site_scrape: SiteScrape | null;
  completed_at: IsoTimestamp | null;
}

/** Output of the `scrape_site` job. Best-effort: every field may be null. */
export interface SiteScrape {
  url: string;
  fetched_at: IsoTimestamp;
  title: string | null;
  description: string | null;
  headings: string[];
  value_props: string[];
  customers_mentioned: string[];
  raw_text_excerpt: string | null;
  truncated: boolean;
  error?: string;
}

// ---------------------------------------------------------------- stage 3: strategy

/** Output of `generate_strategy`. Stored in strategies.payload. */
export interface GtmStrategy {
  positioning: string;
  icp: {
    summary: string;
    titles: string[];
    industries: string[];
    geos: string[];
    headcount_min: number | null;
    headcount_max: number | null;
    exclusions: string[];
  };
  segments: StrategySegment[];
  offer: {
    headline: string;
    body: string;
    proof_points: string[];
    risk_reversal: string | null;
  };
  sequence_plan: SequenceStepPlan[];
  /** Why this strategy, in the customer's own context. Shown on the strategy page. */
  rationale: string;
  /** Anything the model could not determine from the inputs. Shown as "we assumed". */
  assumptions: string[];
}

export interface StrategySegment {
  name: string;
  description: string;
  /** Buying signals to filter the list on, e.g. "hiring SDRs", "raised seed <12mo". */
  signals: string[];
  angle: string;
  estimated_size: number | null;
}

export interface SequenceStepPlan {
  step: number;
  /** Days after the previous step. Step 1 is always 0. */
  delay_days: number;
  purpose: string;
  channel: 'email';
}

// ---------------------------------------------------------------- stage 5: leads

export interface Lead {
  id: Uuid;
  account_id: Uuid;
  email: string;
  first_name: string | null;
  last_name: string | null;
  title: string | null;
  company_name: string | null;
  company_domain: string | null;
  linkedin_url: string | null;
  industry: string | null;
  headcount: number | null;
  country: string | null;
  source: string | null;
  signals: string[];
  enrichment: Record<string, unknown> | null;
  verification: LeadVerification;
  verified_at: IsoTimestamp | null;
  cost_cents: number;
}

/** Input to a lead-sourcing provider. Derived from the approved strategy. */
export interface LeadSearchQuery {
  titles: string[];
  industries: string[];
  geos: string[];
  headcount_min?: number | null;
  headcount_max?: number | null;
  signals?: string[];
  exclude_domains?: string[];
  limit: number;
}

/** A provider's raw result, before it becomes a Lead row. */
export interface SourcedLead {
  email: string;
  first_name?: string | null;
  last_name?: string | null;
  title?: string | null;
  company_name?: string | null;
  company_domain?: string | null;
  linkedin_url?: string | null;
  industry?: string | null;
  headcount?: number | null;
  country?: string | null;
  signals?: string[];
  raw?: Record<string, unknown>;
}

export interface LeadSearchResult {
  leads: SourcedLead[];
  /** Why the provider stopped. Never hide truncation. */
  stop_reason: 'limit_reached' | 'exhausted' | 'rate_limited' | 'error';
  cost_cents: number;
  provider: string;
  error?: string;
}

export interface VerificationResult {
  email: string;
  status: LeadVerification;
  provider: string;
}

// ---------------------------------------------------------------- stage 5: copy

/** Output of `generate_copy`. Stored in campaign_copy.steps. */
export interface CampaignCopy {
  steps: CopyStep[];
}

export interface CopyStep {
  step: number;
  delay_days: number;
  /** Spintax allowed: {a|b}. Keep subjects lowercase and under ~6 words. */
  subject: string;
  /**
   * Body with merge tags. Supported tags are exactly MERGE_TAGS below;
   * the compliance checker rejects any other {{tag}}.
   */
  body: string;
  /** Per-step rationale for the reviewer. Not sent. */
  note?: string;
}

export const MERGE_TAGS = [
  'first_name', 'last_name', 'company_name', 'title', 'industry',
  'sending_name', 'unsubscribe_link',
] as const;
export type MergeTag = (typeof MERGE_TAGS)[number];

/** Result of the automatic compliance + spam checker. Blocks send when `passed` is false. */
export interface ComplianceReport {
  passed: boolean;
  errors: ComplianceIssue[];
  warnings: ComplianceIssue[];
  checked_at: IsoTimestamp;
}

export interface ComplianceIssue {
  code: ComplianceCode;
  step?: number;
  message: string;
  evidence?: string;
}

export type ComplianceCode =
  | 'missing_unsubscribe'
  | 'unknown_merge_tag'
  | 'spam_word'
  | 'subject_too_long'
  | 'body_too_long'
  | 'body_too_short'
  | 'all_caps'
  | 'excessive_punctuation'
  | 'link_count'
  | 'missing_sender_identity'
  | 'empty_step';

// ---------------------------------------------------------------- stage 4: infra

export interface Domain {
  id: Uuid;
  account_id: Uuid;
  domain: string;
  status: DomainStatus;
  source: 'connected' | 'purchased';
  registrar: string | null;
  redirect_to: string | null;
  dns_records: DnsRecord[];
  dns_verified_at: IsoTimestamp | null;
  warmup_started_at: IsoTimestamp | null;
  warmup_days: number;
  provider_ref: string | null;
  error: string | null;
}

export interface DnsRecord {
  type: 'TXT' | 'MX' | 'CNAME' | 'A';
  host: string;
  value: string;
  priority?: number;
  /** What this record is for, shown in the UI next to the copy button. */
  purpose: 'spf' | 'dkim' | 'dmarc' | 'mx' | 'tracking' | 'verification';
  verified?: boolean;
}

export interface Mailbox {
  id: Uuid;
  account_id: Uuid;
  domain_id: Uuid;
  email: string;
  display_name: string | null;
  status: MailboxStatus;
  provider: string | null;
  provider_ref: string | null;
  /** Sender id in the sending platform. Attach via `sender_email_ids`. */
  sender_email_id: string | null;
  warmup_started_at: IsoTimestamp | null;
  daily_cap: number;
  cost_cents: number;
  error: string | null;
}

/** Warm-up progress for the UI progress bar. */
export interface WarmupProgress {
  started_at: IsoTimestamp | null;
  days_total: number;
  days_elapsed: number;
  percent: number;
  ready_at: IsoTimestamp | null;
  /** Honest copy for the UI: sending cannot start before this. */
  complete: boolean;
}

// ---------------------------------------------------------------- campaigns

export interface Campaign {
  id: Uuid;
  account_id: Uuid;
  strategy_id: Uuid | null;
  name: string;
  angle: string | null;
  status: CampaignStatus;
  target_lead_count: number;
  daily_cap: number;
  timezone: string;
  send_window_start: string;
  send_window_end: string;
  send_days: string[];
  provider: string | null;
  provider_ref: string | null;
  launched_at: IsoTimestamp | null;
  paused_reason: string | null;
  error: string | null;
}

/**
 * Output of the cheap-model reply classifier. `confidence` is the model's own
 * estimate; a low value routes the reply to the UI for a human read rather than
 * counting it as interested.
 */
export interface ReplyClassification {
  sentiment: ReplySentiment;
  confidence: number;
  reason: string;
}

export interface CampaignStats {
  campaign_id: Uuid;
  sent: number;
  delivered: number;
  opens: number;
  replies: number;
  bounces: number;
  unsubscribes: number;
  interested: number;
  bounce_rate: number;
  reply_rate: number;
}

export interface DashboardSummary {
  account: Pick<Account, 'id' | 'company_name' | 'status' | 'sending_paused' | 'paused_reason' | 'trial_ends_at'>;
  credits: CreditSummary;
  campaigns: Array<Campaign & { stats: CampaignStats }>;
  warmup: WarmupProgress | null;
  totals: CampaignStats;
}

// ---------------------------------------------------------------- money

export interface CreditSummary {
  balance: number;
  granted: number;
  spent: number;
  /** True when balance is under 10% of the original grant. */
  low: boolean;
}

export interface LedgerEntry {
  id: Uuid;
  account_id: Uuid;
  delta: number;
  reason: CreditReason;
  campaign_id: Uuid | null;
  idempotency_key: string;
  metadata: Record<string, unknown> | null;
  created_at: IsoTimestamp;
}

export type CreditReason =
  | 'grant_redemption' | 'grant_manual' | 'grant_renewal'
  | 'spend_email_sent' | 'refund_bounce' | 'adjustment';

export type CostCategory = 'lead_data' | 'verification' | 'mailbox' | 'domain' | 'llm' | 'other';

// ---------------------------------------------------------------- jobs

/** Every pipeline stage is a job. Handlers must be idempotent. */
export type JobType =
  | 'scrape_site'
  | 'generate_strategy'
  | 'provision_domain'
  | 'verify_dns'
  | 'provision_mailboxes'
  | 'warmup_monitor'
  | 'source_leads'
  | 'verify_leads'
  | 'generate_copy'
  | 'build_campaign'
  | 'launch_campaign'
  | 'sync_stats'
  | 'sync_replies'
  | 'classify_replies'
  | 'enforce_guardrails'
  | 'trial_ending_notice';

export interface Job<P = Record<string, unknown>> {
  id: Uuid;
  account_id: Uuid | null;
  type: JobType;
  payload: P;
  status: JobStatus;
  dedupe_key: string | null;
  attempts: number;
  max_attempts: number;
  run_after: IsoTimestamp;
  last_error: string | null;
  result: Record<string, unknown> | null;
}

/** What a handler returns. Throwing marks the job for retry. */
export interface JobResult {
  ok: boolean;
  detail?: Record<string, unknown>;
  /** Jobs to enqueue next. The runner enqueues these in the same transaction. */
  next?: Array<{ type: JobType; payload?: Record<string, unknown>; dedupe_key?: string; delay_ms?: number }>;
}

// Per-job payloads.
export interface ScrapeSitePayload { account_id: Uuid; url: string }
export interface GenerateStrategyPayload { account_id: Uuid }
export interface ProvisionDomainPayload { account_id: Uuid; domain_id: Uuid }
export interface ProvisionMailboxesPayload { account_id: Uuid; domain_id: Uuid; count: number }
export interface SourceLeadsPayload { account_id: Uuid; campaign_id: Uuid; limit: number }
export interface VerifyLeadsPayload { account_id: Uuid; campaign_id: Uuid }
export interface GenerateCopyPayload { account_id: Uuid; campaign_id: Uuid }
export interface BuildCampaignPayload { account_id: Uuid; campaign_id: Uuid }
export interface LaunchCampaignPayload { account_id: Uuid; campaign_id: Uuid }
export interface SyncStatsPayload { account_id?: Uuid; campaign_id?: Uuid }

// ---------------------------------------------------------------- provider interfaces

/**
 * Every external vendor sits behind one of these. Each has a `mock` implementation
 * (deterministic, offline, used by tests and by `PROVIDER_MODE=mock`) and a `live`
 * implementation. Swapping is an env change, never a code change.
 */

export interface LeadProvider {
  readonly name: string;
  search(query: LeadSearchQuery): Promise<LeadSearchResult>;
}

export interface VerificationProvider {
  readonly name: string;
  verify(emails: string[]): Promise<VerificationResult[]>;
}

export interface SendingProvider {
  readonly name: string;
  listSenders(): Promise<Array<{ sender_email_id: string; email: string }>>;
  createCampaign(input: {
    name: string;
    steps: CopyStep[];
    timezone: string;
  }): Promise<{ provider_ref: string }>;
  /** Attaches senders. Implementations must send `sender_email_ids`. */
  attachSenders(input: { provider_ref: string; sender_email_ids: string[] }): Promise<void>;
  uploadLeads(input: {
    provider_ref: string;
    leads: Array<{ email: string; fields: Record<string, string> }>;
  }): Promise<{ uploaded: number; rejected: number }>;
  setSchedule(input: {
    provider_ref: string;
    timezone: string;
    window_start: string;
    window_end: string;
    days: string[];
    daily_cap: number;
  }): Promise<void>;
  launch(input: { provider_ref: string }): Promise<void>;
  pause(input: { provider_ref: string }): Promise<void>;
  getStats(input: { provider_ref: string }): Promise<Omit<CampaignStats, 'campaign_id' | 'bounce_rate' | 'reply_rate'>>;
  getReplies(input: { provider_ref: string; since?: IsoTimestamp }): Promise<Array<{
    provider_ref: string;
    from_email: string;
    subject: string | null;
    body_preview: string | null;
    received_at: IsoTimestamp;
  }>>;
}

export interface DomainProvider {
  readonly name: string;
  checkAvailability(domain: string): Promise<{ available: boolean; price_cents: number | null }>;
  register(input: { domain: string; years?: number }): Promise<{ provider_ref: string; price_cents: number }>;
  setDnsRecords(input: { domain: string; records: DnsRecord[] }): Promise<void>;
  getDnsRecords(input: { domain: string }): Promise<DnsRecord[]>;
}

export interface MailboxProvider {
  readonly name: string;
  provision(input: {
    domain: string;
    count: number;
    display_name: string;
    /** Name seeds produce address permutations, e.g. "Tom Smith" -> t.smith@. */
    name_seeds?: string[];
  }): Promise<Array<{
    email: string;
    provider_ref: string;
    sender_email_id: string | null;
    cost_cents: number;
    status: MailboxStatus;
  }>>;
  getStatus(input: { provider_ref: string }): Promise<{ status: MailboxStatus; error?: string }>;
}

export interface BillingProvider {
  readonly name: string;
  createCheckoutSession(input: {
    account_id: Uuid;
    email: string;
    code?: string;
    trial_days: number;
    price_cents: number;
    success_url: string;
    cancel_url: string;
  }): Promise<{ url: string; session_id: string }>;
  verifyWebhook(rawBody: string, signature: string): Promise<{ id: string; type: string; data: unknown }>;
  cancelSubscription(input: { stripe_subscription_id: string }): Promise<void>;
}

export interface LlmProvider {
  readonly name: string;
  /** Returns parsed JSON matching the caller's schema, or throws after retries. */
  json<T>(input: {
    system: string;
    user: string;
    schema_name: string;
    schema: Record<string, unknown>;
    model?: 'strategy' | 'copy' | 'cheap';
    max_tokens?: number;
    cache_system?: boolean;
  }): Promise<{ value: T; model: string; input_tokens: number; output_tokens: number }>;
}

export interface ScrapeProvider {
  readonly name: string;
  scrape(url: string): Promise<SiteScrape>;
}

export interface Providers {
  leads: LeadProvider;
  leadsOverflow: LeadProvider;
  verification: VerificationProvider;
  sending: SendingProvider;
  domains: DomainProvider;
  mailboxes: MailboxProvider;
  billing: BillingProvider;
  llm: LlmProvider;
  scrape: ScrapeProvider;
}

// ---------------------------------------------------------------- API envelope

export type ApiResponse<T> = { ok: true; data: T } | { ok: false; error: string; code?: string };

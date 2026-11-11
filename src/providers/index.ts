/**
 * Provider registry.
 *
 * Every external vendor is reached through an interface in lib/contracts.ts.
 * This file picks the mock or live implementation per provider and caches it.
 *
 * Rules:
 *  - A live provider with no credential throws MissingCredentialError. It must never
 *    fall back to mock silently: a "working" demo that quietly sends nothing is worse
 *    than a loud failure.
 *  - Imports are dynamic so the mock bundle never pulls a vendor SDK into a build that
 *    does not use it.
 */

import { providerMode } from '../lib/env';
import type {
  BillingProvider, DomainProvider, LeadProvider, LlmProvider, MailboxProvider,
  Providers, ScrapeProvider, SendingProvider, VerificationProvider,
} from '../lib/contracts';

const cache = new Map<string, unknown>();

async function pick<T>(key: string, mock: () => Promise<T>, live: () => Promise<T>): Promise<T> {
  const mode = providerMode(key);
  const cacheKey = `${key}:${mode}`;
  const hit = cache.get(cacheKey);
  if (hit) return hit as T;
  const made = mode === 'live' ? await live() : await mock();
  cache.set(cacheKey, made);
  return made;
}

export async function getLeadProvider(): Promise<LeadProvider> {
  return pick<LeadProvider>(
    'leads',
    async () => new (await import('./mock/leads')).MockLeadProvider(),
    async () => new (await import('./live/prospeo')).ProspeoLeadProvider(),
  );
}

/** Overflow source, used when the primary is rate limited (brief §7). */
export async function getLeadOverflowProvider(): Promise<LeadProvider> {
  return pick<LeadProvider>(
    'leads_overflow',
    async () => new (await import('./mock/leads')).MockLeadProvider('mock-overflow'),
    async () => new (await import('./live/getleads')).GetLeadsProvider(),
  );
}

export async function getVerificationProvider(): Promise<VerificationProvider> {
  return pick<VerificationProvider>(
    'verification',
    async () => new (await import('./mock/verification')).MockVerificationProvider(),
    async () => new (await import('./live/truelist')).TrueListProvider(),
  );
}

export async function getSendingProvider(): Promise<SendingProvider> {
  return pick<SendingProvider>(
    'sending',
    async () => new (await import('./mock/sending')).MockSendingProvider(),
    async () => new (await import('./live/emailbison')).EmailBisonProvider(),
  );
}

export async function getDomainProvider(): Promise<DomainProvider> {
  return pick<DomainProvider>(
    'domains',
    async () => new (await import('./mock/domains')).MockDomainProvider(),
    async () => new (await import('./live/namecheap')).NamecheapProvider(),
  );
}

export async function getMailboxProvider(): Promise<MailboxProvider> {
  return pick<MailboxProvider>(
    'mailboxes',
    async () => new (await import('./mock/mailboxes')).MockMailboxProvider(),
    async () => new (await import('./live/inboxkit')).InboxKitProvider(),
  );
}

export async function getBillingProvider(): Promise<BillingProvider> {
  return pick<BillingProvider>(
    'billing',
    async () => new (await import('./mock/billing')).MockBillingProvider(),
    async () => new (await import('./live/stripe')).StripeBillingProvider(),
  );
}

export async function getLlmProvider(): Promise<LlmProvider> {
  return pick<LlmProvider>(
    'llm',
    async () => new (await import('./mock/llm')).MockLlmProvider(),
    async () => new (await import('./live/anthropic')).AnthropicProvider(),
  );
}

export async function getScrapeProvider(): Promise<ScrapeProvider> {
  return pick<ScrapeProvider>(
    'scrape',
    async () => new (await import('./mock/scrape')).MockScrapeProvider(),
    async () => new (await import('./live/scrape')).HttpScrapeProvider(),
  );
}

/** Everything at once, for job handlers that touch several vendors. */
export async function getProviders(): Promise<Providers> {
  const [leads, leadsOverflow, verification, sending, domains, mailboxes, billing, llm, scrape] =
    await Promise.all([
      getLeadProvider(), getLeadOverflowProvider(), getVerificationProvider(),
      getSendingProvider(), getDomainProvider(), getMailboxProvider(),
      getBillingProvider(), getLlmProvider(), getScrapeProvider(),
    ]);
  return { leads, leadsOverflow, verification, sending, domains, mailboxes, billing, llm, scrape };
}

/** Tests call this between cases so a stubbed provider does not leak. */
export function resetProviders(): void {
  cache.clear();
}

/** Tests and the e2e harness use this to inject a specific implementation. */
export function overrideProvider(key: string, mode: 'mock' | 'live', impl: unknown): void {
  cache.set(`${key}:${mode}`, impl);
}

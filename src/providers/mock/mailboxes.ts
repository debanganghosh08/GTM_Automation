/**
 * Mock mailbox reseller. Addresses are name permutations of the seeds, in the
 * order a human would pick them (t.smith, tom.smith, tom, ...), round-robin
 * across seeds. Numeric suffixes appear only once every permutation is used.
 *
 * Provisioned mailboxes are registered with the mock sending platform so
 * `listSenders` there returns them, mirroring Inbox Kit -> EmailBison.
 */

import type { MailboxProvider, MailboxStatus } from '../../lib/contracts';
import { env } from '../../lib/env';
import { fnv1a, hex8 } from './hash';
import { __registerMockSender } from './sending';

const FALLBACK_SEEDS = ['Alex Placeholder', 'Sam Fixture'] as const;

interface MockMailbox {
  email: string;
  polls: number;
}

const mailboxes = new Map<string, MockMailbox>();

function splitSeed(seed: string): { first: string; last: string } | null {
  const parts = seed.trim().split(/\s+/).map((p) => p.toLowerCase().replace(/[^a-z]/g, '')).filter(Boolean);
  const first = parts[0];
  if (!first) return null;
  const last = parts.length > 1 ? parts[parts.length - 1] ?? '' : '';
  return { first, last };
}

function patterns(first: string, last: string): string[] {
  if (!last) return [first];
  return [
    `${first.charAt(0)}.${last}`,
    `${first}.${last}`,
    first,
    `${first}${last}`,
    `${first}.${last.charAt(0)}`,
    `${last}.${first}`,
    `${first.charAt(0)}${last}`,
    last,
  ];
}

export function mockMailboxLocalParts(seeds: string[], count: number): string[] {
  const names = seeds.map(splitSeed).filter((s): s is { first: string; last: string } => s !== null);
  const source = names.length ? names : FALLBACK_SEEDS.map(splitSeed).filter((s): s is { first: string; last: string } => s !== null);
  const perSeed = source.map((n) => patterns(n.first, n.last));
  const longest = Math.max(0, ...perSeed.map((p) => p.length));

  const out: string[] = [];
  const seen = new Set<string>();
  for (let round = 0; round < longest && out.length < count; round++) {
    for (const list of perSeed) {
      if (out.length >= count) break;
      const candidate = list[round];
      if (candidate === undefined || seen.has(candidate)) continue;
      seen.add(candidate);
      out.push(candidate);
    }
  }

  // Only reached when the seeds cannot cover `count` on their own.
  let suffix = 2;
  while (out.length < count) {
    for (const list of perSeed) {
      if (out.length >= count) break;
      const base = list[1] ?? list[0];
      if (base === undefined) continue;
      const candidate = `${base}${suffix}`;
      if (seen.has(candidate)) continue;
      seen.add(candidate);
      out.push(candidate);
    }
    suffix += 1;
  }
  return out;
}

export function __resetMockMailboxes(): void {
  mailboxes.clear();
}

export class MockMailboxProvider implements MailboxProvider {
  readonly name = 'mock-inboxkit';

  async provision(input: {
    domain: string;
    count: number;
    display_name: string;
    name_seeds?: string[];
  }): Promise<Array<{
    email: string;
    provider_ref: string;
    sender_email_id: string | null;
    cost_cents: number;
    status: MailboxStatus;
  }>> {
    const domain = input.domain.trim().toLowerCase();
    const seeds = input.name_seeds?.length ? input.name_seeds : [input.display_name];
    const count = Math.max(0, Math.floor(input.count));

    return mockMailboxLocalParts(seeds, count).map((local) => {
      const email = `${local}@${domain}`;
      const id = hex8(fnv1a(`mailbox:${email}`));
      const provider_ref = `mock-mailbox-${id}`;
      const sender_email_id = `mock-sender-${id}`;
      if (!mailboxes.has(provider_ref)) mailboxes.set(provider_ref, { email, polls: 0 });
      __registerMockSender({ sender_email_id, email });
      return { email, provider_ref, sender_email_id, cost_cents: env.mailboxPriceCents, status: 'provisioning' };
    });
  }

  /** First poll reports `warming`, every later poll `ready`. */
  async getStatus(input: { provider_ref: string }): Promise<{ status: MailboxStatus; error?: string }> {
    const mailbox = mailboxes.get(input.provider_ref);
    if (!mailbox) return { status: 'failed', error: `mock-inboxkit: unknown mailbox provider_ref "${input.provider_ref}"` };
    mailbox.polls += 1;
    return { status: mailbox.polls === 1 ? 'warming' : 'ready' };
  }
}

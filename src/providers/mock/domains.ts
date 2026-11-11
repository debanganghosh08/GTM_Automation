/**
 * Mock registrar. Availability is a function of the name, registration is
 * instant, and DNS "propagates" the moment records are set.
 */

import type { DnsRecord, DomainProvider } from '../../lib/contracts';
import { fnv1a, hex8 } from './hash';

const PRICE_CENTS = 1_200;
const AVAILABLE_PERCENT = 70;

const registered = new Map<string, { provider_ref: string; years: number }>();
const dns = new Map<string, DnsRecord[]>();

function normalise(domain: string): string {
  return domain.trim().toLowerCase().replace(/\.$/, '');
}

export function mockDomainAvailable(domain: string): boolean {
  const name = normalise(domain);
  if (registered.has(name)) return false;
  return fnv1a(`domain:${name}`) % 100 < AVAILABLE_PERCENT;
}

export function __resetMockDomains(): void {
  registered.clear();
  dns.clear();
}

export class MockDomainProvider implements DomainProvider {
  readonly name = 'mock-registrar';

  async checkAvailability(domain: string): Promise<{ available: boolean; price_cents: number | null }> {
    const available = mockDomainAvailable(domain);
    return { available, price_cents: available ? PRICE_CENTS : null };
  }

  async register(input: { domain: string; years?: number }): Promise<{ provider_ref: string; price_cents: number }> {
    const name = normalise(input.domain);
    const existing = registered.get(name);
    if (existing) return { provider_ref: existing.provider_ref, price_cents: PRICE_CENTS * existing.years };
    if (!mockDomainAvailable(name)) {
      throw new Error(`mock-registrar: "${name}" is not available. Check availability before registering.`);
    }
    const years = Math.max(1, Math.floor(input.years ?? 1));
    const provider_ref = `mock-domain-${hex8(fnv1a(name))}`;
    registered.set(name, { provider_ref, years });
    return { provider_ref, price_cents: PRICE_CENTS * years };
  }

  async setDnsRecords(input: { domain: string; records: DnsRecord[] }): Promise<void> {
    dns.set(normalise(input.domain), input.records.map((r) => ({ ...r, verified: true })));
  }

  async getDnsRecords(input: { domain: string }): Promise<DnsRecord[]> {
    return (dns.get(normalise(input.domain)) ?? []).map((r) => ({ ...r }));
  }
}

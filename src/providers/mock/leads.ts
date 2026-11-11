/**
 * Mock lead source. Synthetic leads seeded by a hash of the query, so the same
 * query always yields the same people and a larger limit extends the same list
 * rather than reshuffling it.
 *
 * Every email is on a `.test` domain (RFC 6761, never resolvable). Nothing here
 * can reach a real inbox.
 */

import type { LeadProvider, LeadSearchQuery, LeadSearchResult, SourcedLead } from '../../lib/contracts';
import { fnv1a, pick, seededRng, slug } from './hash';

const COST_PER_LEAD_CENTS = 2;

const FIRST_NAMES = [
  'Avery', 'Blake', 'Casey', 'Dana', 'Ellis', 'Finley', 'Harper', 'Jordan',
  'Kai', 'Logan', 'Morgan', 'Parker', 'Quinn', 'Reese', 'Riley', 'Rowan',
  'Sage', 'Taylor', 'Wren', 'Zion',
] as const;

// Surnames chosen to read as obviously synthetic.
const LAST_NAMES = [
  'Testman', 'Sampleton', 'Mockridge', 'Fixture', 'Placeholder', 'Stubbs',
  'Dummyson', 'Fakely', 'Specimen', 'Example',
] as const;

const COMPANY_WORDS = [
  'Northwind', 'Fabrikam', 'Contoso', 'Globex', 'Initech', 'Umbrella', 'Vandelay',
  'Hooli', 'Acme', 'Wayne', 'Stark', 'Pied Piper', 'Dunder', 'Wonka', 'Oscorp',
] as const;

const COMPANY_SUFFIXES = ['Labs', 'Systems', 'Group', 'Partners', 'Works', 'Co'] as const;

const DEFAULT_TITLES = ['Head of Sales', 'VP Marketing', 'Founder', 'Revenue Operations Lead'] as const;
const DEFAULT_INDUSTRIES = ['Software', 'Professional Services', 'Logistics'] as const;
const DEFAULT_GEOS = ['United States', 'United Kingdom', 'Canada'] as const;

/** Stable key for everything that shapes the list except the limit. */
function queryKey(query: LeadSearchQuery): string {
  return JSON.stringify({
    titles: [...query.titles].sort(),
    industries: [...query.industries].sort(),
    geos: [...query.geos].sort(),
    headcount_min: query.headcount_min ?? null,
    headcount_max: query.headcount_max ?? null,
    signals: [...(query.signals ?? [])].sort(),
  });
}

function makeLead(seed: number, index: number, query: LeadSearchQuery): SourcedLead {
  const rng = seededRng(seed ^ Math.imul(index + 1, 0x9e3779b1));
  const roll = (): number => Math.floor(rng() * 0x7fffffff);

  const first = pick(FIRST_NAMES, roll());
  const last = pick(LAST_NAMES, roll());
  const companyName = `${pick(COMPANY_WORDS, roll())} ${pick(COMPANY_SUFFIXES, roll())}`;
  // The index keeps every company domain, and so every email, unique in the pool.
  const companyDomain = `${slug(companyName)}-${index + 1}.test`;

  const titles = query.titles.length ? query.titles : DEFAULT_TITLES;
  const industries = query.industries.length ? query.industries : DEFAULT_INDUSTRIES;
  const geos = query.geos.length ? query.geos : DEFAULT_GEOS;

  const min = query.headcount_min ?? 10;
  const max = query.headcount_max ?? Math.max(min, 500);
  const headcount = min + Math.floor(rng() * (Math.max(max, min) - min + 1));

  const signals = (query.signals ?? []).filter(() => rng() < 0.5);

  return {
    email: `${first.toLowerCase()}.${last.toLowerCase()}@${companyDomain}`,
    first_name: first,
    last_name: last,
    title: pick(titles, roll()),
    company_name: companyName,
    company_domain: companyDomain,
    linkedin_url: `https://linkedin.test/in/${first.toLowerCase()}-${last.toLowerCase()}-${index + 1}`,
    industry: pick(industries, roll()),
    headcount,
    country: pick(geos, roll()),
    signals,
    raw: { mock: true, index },
  };
}

export class MockLeadProvider implements LeadProvider {
  readonly name: string;

  constructor(name = 'mock-prospeo') {
    this.name = name;
  }

  async search(query: LeadSearchQuery): Promise<LeadSearchResult> {
    const seed = fnv1a(`${this.name}:${queryKey(query)}`);
    // The synthetic pool is finite so callers exercise the `exhausted` path.
    const poolSize = 200 + (seed % 800);
    const limit = Math.max(0, Math.floor(query.limit));
    const excluded = new Set((query.exclude_domains ?? []).map((d) => d.toLowerCase()));

    const leads: SourcedLead[] = [];
    let index = 0;
    while (leads.length < limit && index < poolSize) {
      const lead = makeLead(seed, index, query);
      index += 1;
      if (lead.company_domain && excluded.has(lead.company_domain)) continue;
      leads.push(lead);
    }

    return {
      leads,
      stop_reason: leads.length >= limit ? 'limit_reached' : 'exhausted',
      cost_cents: leads.length * COST_PER_LEAD_CENTS,
      provider: this.name,
    };
  }
}

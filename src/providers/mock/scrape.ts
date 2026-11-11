/**
 * Mock site scraper. Shapes a plausible SiteScrape from the hostname alone, so
 * onboarding renders something without a network.
 */

import type { ScrapeProvider, SiteScrape } from '../../lib/contracts';
import { fnv1a, pick } from './hash';

type Clock = () => number;

const VALUE_PROPS = [
  'Cut the time your team spends on manual work',
  'See every account in one place',
  'Get set up in a day, not a quarter',
  'Priced for growing teams',
  'Support from people who have done the job',
  'Works with the tools you already run',
] as const;

const CUSTOMERS = [
  'Northwind Labs', 'Fabrikam Systems', 'Contoso Group', 'Globex Partners', 'Initech Works',
] as const;

function brandFromHost(host: string): string {
  const label = host.replace(/^www\./, '').split('.')[0] ?? host;
  return label
    .split(/[-_]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ') || 'Placeholder Co';
}

export class MockScrapeProvider implements ScrapeProvider {
  readonly name = 'mock-scrape';
  private readonly now: Clock;

  constructor(options: { now?: Clock } = {}) {
    this.now = options.now ?? Date.now;
  }

  async scrape(url: string): Promise<SiteScrape> {
    const fetched_at = new Date(this.now()).toISOString();
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return {
        url,
        fetched_at,
        title: null,
        description: null,
        headings: [],
        value_props: [],
        customers_mentioned: [],
        raw_text_excerpt: null,
        truncated: false,
        error: `mock-scrape: "${url}" is not a valid URL`,
      };
    }

    const brand = brandFromHost(parsed.hostname);
    const seed = fnv1a(`scrape:${parsed.hostname}`);
    const valueProps = [0, 1, 2].map((i) => pick(VALUE_PROPS, seed + i * 7));
    const customers = [0, 1].map((i) => pick(CUSTOMERS, seed + i * 11));
    const description = `${brand} helps growing teams do more with less. (Placeholder description from the mock scraper.)`;

    return {
      url,
      fetched_at,
      title: `${brand} | Placeholder site`,
      description,
      headings: [`Why ${brand}`, 'How it works', 'Customers', 'Pricing'],
      value_props: [...new Set(valueProps)],
      customers_mentioned: [...new Set(customers)],
      raw_text_excerpt: `${brand}. ${description} ${valueProps.join('. ')}. Trusted by ${customers.join(' and ')}.`,
      truncated: false,
    };
  }
}

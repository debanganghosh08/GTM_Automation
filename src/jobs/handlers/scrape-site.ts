/**
 * scrape_site — stage 2. Best-effort scrape of the customer's website, stored on
 * their onboarding profile. A scrape failure never fails the pipeline: the error
 * lands in `site_scrape.error` and strategy generation proceeds without it.
 *
 * Idempotent: a stored scrape of the same URL without an error is reused, so a
 * re-run after a crash does not fetch twice.
 */

import type { Job, JobResult, SiteScrape } from '../../lib/contracts';
import type { JobDeps } from '../registry';
import { accountIdOf, done, errText, payloadString, terminal } from './_shared';

function failedScrape(url: string, error: string): SiteScrape {
  return {
    url,
    fetched_at: new Date().toISOString(),
    title: null,
    description: null,
    headings: [],
    value_props: [],
    customers_mentioned: [],
    raw_text_excerpt: null,
    truncated: false,
    error,
  };
}

export async function scrapeSite(job: Job, deps: JobDeps): Promise<JobResult> {
  const accountId = accountIdOf(job);
  if (!accountId) return terminal('no account_id on job');
  const { db } = deps;

  const next: JobResult['next'] = [
    { type: 'generate_strategy', payload: { account_id: accountId }, dedupe_key: `generate_strategy:${accountId}` },
  ];

  // Make sure the profile row exists so there is somewhere to store the result.
  await db.query(
    `insert into onboarding_profiles (account_id) values ($1) on conflict (account_id) do nothing`,
    [accountId],
  );
  const profile = await db.query<{ site_scrape: SiteScrape | null; website_url: string | null }>(
    `select p.site_scrape, a.website_url
     from onboarding_profiles p join accounts a on a.id = p.account_id
     where p.account_id = $1`,
    [accountId],
  );
  const row = profile.rows[0];
  if (!row) return terminal('account not found', { account_id: accountId });

  const url = payloadString(job, 'url') ?? row.website_url;
  if (!url) {
    return done({ skipped: 'no url to scrape', account_id: accountId }, next);
  }

  const existing = row.site_scrape;
  if (existing && existing.url === url && !existing.error) {
    return done({ reused: true, url, fetched_at: existing.fetched_at }, next);
  }

  let scrape: SiteScrape;
  try {
    const providers = await deps.providers();
    scrape = await providers.scrape.scrape(url);
  } catch (err) {
    scrape = failedScrape(url, errText(err));
  }

  await db.query(
    `update onboarding_profiles set site_scrape = $2::jsonb, updated_at = now() where account_id = $1`,
    [accountId, JSON.stringify(scrape)],
  );

  return done(
    {
      url,
      ok: !scrape.error,
      error: scrape.error ?? null,
      headings: scrape.headings.length,
      value_props: scrape.value_props.length,
      truncated: scrape.truncated,
    },
    next,
  );
}

/**
 * Registers every job handler. Importing this module is enough (scripts/worker.ts
 * and the tick route do that); `registerAllHandlers()` is exported for code that
 * clears the registry between tests and needs to put the real handlers back.
 *
 * Every JobType in the contract has a handler here. If you add a JobType, add its
 * handler to HANDLERS; the `satisfies Record<JobType, ...>` makes a missing one a
 * compile error, and tests/unit/jobs.test.ts checks NOT_YET_IMPLEMENTED agrees.
 */

import type { JobType } from '../../lib/contracts';
import { registerHandler, type JobHandler } from '../registry';
import { scrapeSite } from './scrape-site';
import { generateStrategy } from './generate-strategy';
import { provisionDomain } from './provision-domain';
import { verifyDns } from './verify-dns';
import { provisionMailboxes } from './provision-mailboxes';
import { warmupMonitor } from './warmup-monitor';
import { sourceLeads } from './source-leads';
import { verifyLeads } from './verify-leads';
import { generateCopy } from './generate-copy';
import { buildCampaign } from './build-campaign';
import { launchCampaign } from './launch-campaign';
import { syncStats } from './sync-stats';
import { syncReplies } from './sync-replies';
import { classifyReplies } from './classify-replies';
import { enforceGuardrailsJob } from './enforce-guardrails';
import { trialEndingNotice } from './trial-ending-notice';

export const HANDLERS = {
  scrape_site: scrapeSite,
  generate_strategy: generateStrategy,
  provision_domain: provisionDomain,
  verify_dns: verifyDns,
  provision_mailboxes: provisionMailboxes,
  warmup_monitor: warmupMonitor,
  source_leads: sourceLeads,
  verify_leads: verifyLeads,
  generate_copy: generateCopy,
  build_campaign: buildCampaign,
  launch_campaign: launchCampaign,
  sync_stats: syncStats,
  sync_replies: syncReplies,
  classify_replies: classifyReplies,
  enforce_guardrails: enforceGuardrailsJob,
  trial_ending_notice: trialEndingNotice,
} satisfies Record<JobType, JobHandler>;

export function registerAllHandlers(): void {
  for (const [type, fn] of Object.entries(HANDLERS) as Array<[JobType, JobHandler]>) {
    registerHandler(type, fn);
  }
}

registerAllHandlers();

export {
  scrapeSite, generateStrategy, provisionDomain, verifyDns, provisionMailboxes, warmupMonitor,
  sourceLeads, verifyLeads, generateCopy, buildCampaign, launchCampaign, syncStats, syncReplies,
  classifyReplies, enforceGuardrailsJob, trialEndingNotice,
};

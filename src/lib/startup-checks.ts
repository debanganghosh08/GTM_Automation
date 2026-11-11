/**
 * Production configuration guard.
 *
 * The app is deliberately easy to run offline: empty DATABASE_URL falls back to an
 * embedded database, PROVIDER_MODE defaults to mock, and the secrets have dev
 * defaults. Every one of those is a catastrophe in production:
 *
 *   - a dev SESSION_SECRET means anyone can forge unsubscribe tokens, and sessions
 *     are signed with a value published in this repo
 *   - mock billing exposes a route that grants 30,000 credits with no payment
 *   - an embedded database means every signup is written to a container filesystem
 *     and lost on the next deploy
 *
 * So production must refuse to boot rather than run in a dangerous shape. This runs
 * from instrumentation.ts, which Next executes once per server start.
 *
 * Nothing here changes product behaviour; it only decides whether the process is
 * allowed to start.
 */

import { env } from './env';

/**
 * Reads straight from process.env rather than the cached `env` object. `env` is
 * evaluated once at import, so a validator that used it could not see the real
 * deployment values (and could not be tested).
 */
function raw(name: string): string {
  return process.env[name]?.trim() ?? '';
}

/** Mirrors env.providerMode, but reading live values. */
function mode(provider: string): 'mock' | 'live' {
  const specific = raw(`PROVIDER_${provider.toUpperCase()}`);
  const value = specific || raw('PROVIDER_MODE') || 'mock';
  return value === 'live' ? 'live' : 'mock';
}

const DEV_DEFAULTS = new Set(['dev-only-change-me', 'changeme', 'secret', '']);

/** Secrets that must be long enough to resist offline brute force. */
const MIN_SECRET_LENGTH = 32;

export interface CheckResult {
  errors: string[];
  warnings: string[];
}

/**
 * Returns what is wrong with the current configuration for the given environment.
 * Pure: takes no action, so it is testable.
 */
export function checkConfiguration(nodeEnv = raw('NODE_ENV') || 'development'): CheckResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const isProduction = nodeEnv === 'production';

  // ------------------------------------------------------------ secrets
  const sessionSecret = raw('SESSION_SECRET') || 'dev-only-change-me';
  const cronSecret = raw('CRON_SECRET') || 'dev-only-change-me';
  const appUrl = raw('APP_URL') || 'http://localhost:3000';
  const stripeSecretKey = raw('STRIPE_SECRET_KEY');

  const secrets: Array<[string, string]> = [
    ['SESSION_SECRET', sessionSecret],
    ['CRON_SECRET', cronSecret],
  ];
  for (const [name, value] of secrets) {
    if (DEV_DEFAULTS.has(value)) {
      const message = `${name} is still the development default. Generate one with "openssl rand -base64 48".`;
      if (isProduction) errors.push(message);
      else warnings.push(message);
    } else if (value.length < MIN_SECRET_LENGTH) {
      const message = `${name} is only ${value.length} characters; use at least ${MIN_SECRET_LENGTH}.`;
      if (isProduction) errors.push(message);
      else warnings.push(message);
    }
  }

  if (isProduction && sessionSecret === cronSecret && sessionSecret.length > 0) {
    errors.push('SESSION_SECRET and CRON_SECRET must be different values.');
  }

  // ------------------------------------------------------------ database
  if (isProduction && !raw('DATABASE_URL')) {
    errors.push(
      'DATABASE_URL is empty, so the app would fall back to an embedded database. '
      + 'Every signup would be written to ephemeral container storage and lost on deploy. '
      + 'Set it to the PostgreSQL connection string.',
    );
  }

  // ------------------------------------------------------------ billing
  // The single most dangerous misconfiguration: mock billing leaves
  // /api/mock/checkout-complete able to grant a full credit balance for free.
  if (isProduction && mode('billing') !== 'live') {
    errors.push(
      'Billing is in mock mode in production. /api/mock/checkout-complete would grant '
      + `${env.launchCredits} credits with no payment. Set PROVIDER_MODE=live (or PROVIDER_BILLING=live).`,
    );
  }

  if (isProduction) {
    if (!stripeSecretKey) errors.push('STRIPE_SECRET_KEY is not set.');
    if (!raw('STRIPE_WEBHOOK_SECRET')) {
      errors.push('STRIPE_WEBHOOK_SECRET is not set, so every webhook would be rejected and no subscription would activate.');
    }
    if (!raw('STRIPE_PRICE_ID')) errors.push('STRIPE_PRICE_ID is not set, so checkout cannot be created.');
    if (stripeSecretKey.startsWith('sk_test_')) {
      warnings.push('STRIPE_SECRET_KEY is a test-mode key while NODE_ENV is production. No real payment will be taken.');
    }
  }

  // ------------------------------------------------------------ app URL
  if (isProduction) {
    if (appUrl.startsWith('http://')) {
      errors.push(
        `APP_URL is "${appUrl}". Session cookies are set Secure in production, so the app `
        + 'cannot work over plain HTTP. Use an https:// origin.',
      );
    }
    if (appUrl.includes('localhost') || appUrl.includes('127.0.0.1')) {
      errors.push(`APP_URL points at localhost ("${appUrl}"); unsubscribe and checkout links would be unreachable.`);
    }
  }

  // ------------------------------------------------------------ sending providers
  // Mock sending in production is safe for recipients (nothing is sent) but silently
  // fraudulent to the customer, who is paying for emails that never go out.
  if (isProduction) {
    for (const p of ['sending', 'leads', 'verification', 'mailboxes', 'llm'] as const) {
      if (mode(p) !== 'live') {
        warnings.push(
          `Provider "${p}" is in mock mode in production. Customers would be charged for work that is simulated.`,
        );
      }
    }
    if (!raw('ANTHROPIC_API_KEY') && mode('llm') === 'live') {
      errors.push('PROVIDER llm is live but ANTHROPIC_API_KEY is not set.');
    }
  }

  // ------------------------------------------------------------ abuse limits
  if (env.freeTrialLeadCap <= 0) {
    warnings.push('FREE_TRIAL_LEAD_CAP is 0 or negative, so free accounts have no lead-purchase cap.');
  }
  if (env.warmupDays < 1) {
    warnings.push('WARMUP_DAYS is below 1. New domains need warm-up; sending immediately damages deliverability.');
  }

  return { errors, warnings };
}

/**
 * Runs the checks and halts the process in production when anything is wrong.
 * In development it prints warnings and continues, so offline work is unaffected.
 */
export function assertConfiguration(nodeEnv = raw('NODE_ENV') || 'development'): void {
  const { errors, warnings } = checkConfiguration(nodeEnv);

  for (const w of warnings) console.warn(`[config] warning: ${w}`);

  if (errors.length === 0) {
    if (nodeEnv === 'production') console.log('[config] production configuration checks passed');
    return;
  }

  const report = errors.map((e, i) => `  ${i + 1}. ${e}`).join('\n');
  const message = `Refusing to start: ${errors.length} configuration problem(s).\n${report}`;

  if (nodeEnv === 'production') {
    console.error(`[config] ${message}`);
    // Fail closed. A process that exits is a visible outage; a process that runs
    // with mock billing quietly gives the product away.
    throw new Error(message);
  }
  console.warn(`[config] ${message}\n  (development: continuing anyway)`);
}

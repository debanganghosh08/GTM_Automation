/**
 * Configuration. Read env once, in one place, with sane defaults.
 * Nothing else in the codebase touches process.env directly.
 */

function str(key: string, fallback = ''): string {
  return process.env[key]?.trim() || fallback;
}

function int(key: string, fallback: number): number {
  const raw = process.env[key]?.trim();
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : fallback;
}

export type ProviderMode = 'mock' | 'live';

/** Per-provider mode, falling back to PROVIDER_MODE, falling back to mock. */
export function providerMode(provider?: string): ProviderMode {
  const specific = provider ? str(`PROVIDER_${provider.toUpperCase()}`) : '';
  const value = specific || str('PROVIDER_MODE', 'mock');
  return value === 'live' ? 'live' : 'mock';
}

export const env = {
  appUrl: str('APP_URL', 'http://localhost:3000'),
  sessionSecret: str('SESSION_SECRET', 'dev-only-change-me'),
  cronSecret: str('CRON_SECRET', 'dev-only-change-me'),
  nodeEnv: str('NODE_ENV', 'development'),

  // Offer terms. The brief: 30,000 credits, 30-day trial, $2,000/month, ~$30/mailbox.
  launchCredits: int('LAUNCH_CREDITS', 30_000),
  trialDays: int('TRIAL_DAYS', 30),
  subscriptionPriceCents: int('SUBSCRIPTION_PRICE_CENTS', 200_000),
  mailboxPriceCents: int('MAILBOX_PRICE_CENTS', 3_000),
  warmupDays: int('WARMUP_DAYS', 7),

  // Free-trial cost control (brief §7): cap lead purchases up front, release the rest
  // as sends happen, so an account cannot burn our data spend before paying.
  freeTrialLeadCap: int('FREE_TRIAL_LEAD_CAP', 5_000),

  anthropicApiKey: str('ANTHROPIC_API_KEY'),
  models: {
    strategy: str('MODEL_STRATEGY', 'claude-sonnet-5-5'),
    copy: str('MODEL_COPY', 'claude-sonnet-5-5'),
    cheap: str('MODEL_CHEAP', 'claude-haiku-5-5'),
  },

  stripe: {
    secretKey: str('STRIPE_SECRET_KEY'),
    webhookSecret: str('STRIPE_WEBHOOK_SECRET'),
    priceId: str('STRIPE_PRICE_ID'),
  },

  emailbison: {
    baseUrl: str('EMAILBISON_BASE_URL', 'https://send.roister.ai'),
    apiToken: str('EMAILBISON_API_TOKEN'),
  },

  prospeoApiKey: str('PROSPEO_API_KEY'),
  getleadsApiKey: str('GETLEADS_API_KEY'),
  /**
   * GetLeads' own terms forbid using their unlimited plan to power a product, and
   * reselling their database needs a written agreement. The provider refuses to run
   * unless this is explicitly true. See docs/VENDOR_NOTES.md §4.
   *
   * A getter, not a value: everything else here is read once at import, but this
   * flag is toggled per-test, so it must be evaluated on each read.
   */
  get getleadsSaasApproved(): boolean {
    return str('GETLEADS_SAAS_APPROVED') === 'true';
  },
  truelistApiKey: str('TRUELIST_API_KEY'),
  inboxkitApiKey: str('INBOXKIT_API_KEY'),

  registrar: {
    // Porkbun is the default: Namecheap's API needs 20+ domains or $50 spent plus IP
    // whitelisting, and GoDaddy v3 needs a billing method on file. Porkbun has a
    // sandbox, idempotency keys and a default spend cap.
    provider: str('REGISTRAR_PROVIDER', 'porkbun'),
    porkbunApiKey: str('PORKBUN_API_KEY'),
    porkbunSecretApiKey: str('PORKBUN_SECRET_API_KEY'),
    namecheapApiUser: str('NAMECHEAP_API_USER'),
    namecheapApiKey: str('NAMECHEAP_API_KEY'),
    namecheapClientIp: str('NAMECHEAP_CLIENT_IP'),
  },
} as const;

/** Thrown by a live provider when its credential is missing, so it never silently no-ops. */
export class MissingCredentialError extends Error {
  constructor(provider: string, envVar: string) {
    super(
      `${provider} is in live mode but ${envVar} is not set. ` +
        `Set ${envVar}, or set PROVIDER_MODE=mock to run offline.`,
    );
    this.name = 'MissingCredentialError';
  }
}

export function requireCredential(provider: string, envVar: string, value: string): string {
  if (!value) throw new MissingCredentialError(provider, envVar);
  return value;
}

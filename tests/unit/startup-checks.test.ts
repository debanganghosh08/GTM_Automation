/**
 * Production configuration guard.
 *
 * These assert that the app REFUSES to boot in a shape that would give the product
 * away or lose customer data. Each case here is a real deployment mistake.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { checkConfiguration } from '../../src/lib/startup-checks';

const SAVED = { ...process.env };

afterEach(() => {
  // Restore exactly, including keys the test added.
  for (const k of Object.keys(process.env)) if (!(k in SAVED)) delete process.env[k];
  Object.assign(process.env, SAVED);
});

/** A configuration that should pass every production check. */
function validProduction(): void {
  process.env.SESSION_SECRET = 'a'.repeat(48);
  process.env.CRON_SECRET = 'b'.repeat(48);
  process.env.DATABASE_URL = 'postgresql://user:pass@db.example.com:5432/app';
  process.env.PROVIDER_MODE = 'live';
  process.env.STRIPE_SECRET_KEY = 'sk_live_example';
  process.env.STRIPE_WEBHOOK_SECRET = 'whsec_example';
  process.env.STRIPE_PRICE_ID = 'price_example';
  process.env.APP_URL = 'https://autopilot.example.com';
  process.env.ANTHROPIC_API_KEY = 'sk-ant-example';
}

describe('production configuration', () => {
  it('passes when everything is set properly', () => {
    validProduction();
    const { errors } = checkConfiguration('production');
    expect(errors).toEqual([]);
  });

  it('refuses a development SESSION_SECRET', () => {
    validProduction();
    process.env.SESSION_SECRET = 'dev-only-change-me';
    const { errors } = checkConfiguration('production');
    expect(errors.some((e) => e.includes('SESSION_SECRET'))).toBe(true);
  });

  it('refuses a short secret', () => {
    validProduction();
    process.env.SESSION_SECRET = 'tooshort';
    const { errors } = checkConfiguration('production');
    expect(errors.some((e) => e.includes('SESSION_SECRET'))).toBe(true);
  });

  it('refuses reusing one secret for both purposes', () => {
    validProduction();
    const same = 'c'.repeat(48);
    process.env.SESSION_SECRET = same;
    process.env.CRON_SECRET = same;
    const { errors } = checkConfiguration('production');
    expect(errors.some((e) => e.includes('must be different'))).toBe(true);
  });

  it('refuses an empty DATABASE_URL, which would silently use ephemeral storage', () => {
    validProduction();
    delete process.env.DATABASE_URL;
    const { errors } = checkConfiguration('production');
    expect(errors.some((e) => e.includes('DATABASE_URL'))).toBe(true);
  });

  it('refuses mock billing in production — this is the free-subscription hole', () => {
    validProduction();
    process.env.PROVIDER_MODE = 'mock';
    const { errors } = checkConfiguration('production');
    expect(errors.some((e) => e.includes('mock mode') && e.includes('credits'))).toBe(true);
  });

  it('refuses mock billing even when only the per-provider override is mock', () => {
    validProduction();
    process.env.PROVIDER_BILLING = 'mock';
    const { errors } = checkConfiguration('production');
    expect(errors.some((e) => e.includes('Billing is in mock mode'))).toBe(true);
  });

  it('refuses a missing Stripe webhook secret', () => {
    validProduction();
    delete process.env.STRIPE_WEBHOOK_SECRET;
    const { errors } = checkConfiguration('production');
    expect(errors.some((e) => e.includes('STRIPE_WEBHOOK_SECRET'))).toBe(true);
  });

  it('refuses a plain-HTTP or localhost APP_URL in production', () => {
    validProduction();
    process.env.APP_URL = 'http://autopilot.example.com';
    expect(checkConfiguration('production').errors.some((e) => e.includes('APP_URL'))).toBe(true);

    process.env.APP_URL = 'https://localhost:3000';
    expect(checkConfiguration('production').errors.some((e) => e.includes('localhost'))).toBe(true);
  });

  it('warns but does not block when a test-mode Stripe key is used in production', () => {
    validProduction();
    process.env.STRIPE_SECRET_KEY = 'sk_test_example';
    const { errors, warnings } = checkConfiguration('production');
    expect(errors).toEqual([]);
    expect(warnings.some((w) => w.includes('test-mode'))).toBe(true);
  });

  it('lets development run with defaults, reporting warnings instead of errors', () => {
    process.env.SESSION_SECRET = 'dev-only-change-me';
    process.env.CRON_SECRET = 'dev-only-change-me';
    delete process.env.DATABASE_URL;
    process.env.PROVIDER_MODE = 'mock';
    const { errors, warnings } = checkConfiguration('development');
    expect(errors).toEqual([]);
    expect(warnings.length).toBeGreaterThan(0);
  });
});

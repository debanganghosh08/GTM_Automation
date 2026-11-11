/**
 * Seeds the data the product needs to run: partner redemption codes and an admin
 * user. Safe to re-run — every insert is idempotent.
 *
 * Usage: npm run seed [-- --admin-email you@example.com --admin-password secret]
 */

import { getDb } from '../src/lib/db';
import { migrate } from '../src/lib/migrate';
import { env } from '../src/lib/env';
import { hashPassword } from '../src/lib/auth';

interface CodeSeed {
  code: string;
  partner: string;
  credits: number;
  trialDays: number;
  maxRedemptions: number | null;
}

/**
 * The launch offer is 30,000 credits + a 30-day free month, pushed through a
 * partner newsletter. One code per partner so redemptions are attributable.
 */
const CODES: CodeSeed[] = [
  { code: 'LAUNCH30K', partner: 'direct', credits: env.launchCredits, trialDays: env.trialDays, maxRedemptions: null },
  { code: 'NETWORK30K', partner: 'startup-network', credits: env.launchCredits, trialDays: env.trialDays, maxRedemptions: 2000 },
  { code: 'DEMO', partner: 'internal-demo', credits: 500, trialDays: env.trialDays, maxRedemptions: 50 },
];

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main() {
  const db = await getDb();
  await migrate(db, { silent: true });

  for (const c of CODES) {
    await db.query(
      `insert into redemption_codes (code, partner, credits_granted, trial_days, max_redemptions)
       values ($1, $2, $3, $4, $5)
       on conflict (code) do update
         set partner = excluded.partner,
             credits_granted = excluded.credits_granted,
             trial_days = excluded.trial_days,
             max_redemptions = excluded.max_redemptions,
             active = true`,
      [c.code, c.partner, c.credits, c.trialDays, c.maxRedemptions],
    );
    console.log(`  code ${c.code}: ${c.credits} credits, ${c.trialDays}-day trial`);
  }

  const adminEmail = arg('admin-email');
  const adminPassword = arg('admin-password');
  if (adminEmail && adminPassword) {
    const acc = await db.query<{ id: string }>(
      `insert into accounts (company_name, status) values ('SparqLabs (admin)', 'active') returning id`,
    );
    const accountId = acc.rows[0]!.id;
    const hash = await hashPassword(adminPassword);
    await db.query(
      `insert into users (account_id, email, password_hash, name, is_admin)
       values ($1, $2, $3, 'Admin', true)
       on conflict (lower(email)) do update set is_admin = true, password_hash = excluded.password_hash`,
      [accountId, adminEmail.toLowerCase(), hash],
    );
    console.log(`  admin user: ${adminEmail}`);
  } else {
    console.log('  (no admin created — pass --admin-email and --admin-password to make one)');
  }

  console.log('seed complete');
  await db.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

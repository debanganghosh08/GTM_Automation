/**
 * Live vendor smoke test.
 *
 * The build brief says to test with a real run rather than mocks. That needs
 * credentials, so this is the script to run once they exist. It is deliberately
 * READ-ONLY by default: it proves each vendor answers, that the credential works,
 * and that the response has the shape our code expects, WITHOUT creating campaigns,
 * buying domains or sending anything.
 *
 *   npm run live-smoke              # read-only checks
 *   npm run live-smoke -- --write   # also exercises bounded write paths (see below)
 *
 * Nothing here sends email. The --write flag creates a paused draft campaign in
 * EmailBison and nothing else; it never launches.
 */

import { env, providerMode } from '../src/lib/env';
import { getDb } from '../src/lib/db';

const WRITE = process.argv.includes('--write');

type Status = 'pass' | 'fail' | 'skip';
interface Check {
  vendor: string;
  what: string;
  status: Status;
  detail: string;
}

const checks: Check[] = [];

function record(vendor: string, what: string, status: Status, detail: string) {
  checks.push({ vendor, what, status, detail });
  const mark = status === 'pass' ? 'PASS' : status === 'fail' ? 'FAIL' : 'SKIP';
  console.log(`  [${mark}] ${vendor}: ${what}${detail ? ` — ${detail}` : ''}`);
}

async function json(url: string, init: RequestInit = {}): Promise<{ status: number; body: unknown }> {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(20_000) });
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  return { status: res.status, body };
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

// ---------------------------------------------------------------- vendors

async function checkDatabase() {
  const db = await getDb();
  const res = await db.query<{ n: string }>(`select count(*)::text as n from schema_migrations`);
  record('database', `${db.backend} reachable`, 'pass', `${res.rows[0]?.n ?? '0'} migrations applied`);
  if (db.backend === 'pglite') {
    record('database', 'using embedded Postgres', 'skip', 'set DATABASE_URL to test Supabase');
  }
}

async function checkEmailBison() {
  if (!env.emailbison.apiToken) return record('emailbison', 'token', 'skip', 'EMAILBISON_API_TOKEN not set');
  const base = env.emailbison.baseUrl.replace(/\/+$/, '');
  const headers = { Authorization: `Bearer ${env.emailbison.apiToken}`, Accept: 'application/json' };

  const senders = await json(`${base}/api/sender-emails`, { headers });
  if (senders.status !== 200 || !isObject(senders.body)) {
    return record('emailbison', 'GET /api/sender-emails', 'fail', `status ${senders.status}`);
  }
  const data = (senders.body as { data?: unknown }).data;
  const count = Array.isArray(data) ? data.length : 0;
  record('emailbison', 'GET /api/sender-emails', 'pass', `${count} sender(s) on this page`);

  // The field name our whole send path depends on. Confirm the spec is still live.
  const spec = await json(`${base}/api/reference.openapi`, {});
  if (spec.status === 200) {
    record('emailbison', 'OpenAPI spec reachable', 'pass', 'diff it against reference/roister-openapi.json');
  } else {
    record('emailbison', 'OpenAPI spec reachable', 'fail', `status ${spec.status}`);
  }

  if (WRITE) {
    const created = await json(`${base}/api/campaigns`, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: `smoke-${Date.now()}`, type: 'outbound' }),
    });
    const id = isObject(created.body) && isObject(created.body.data) ? created.body.data.id : undefined;
    if (created.status >= 200 && created.status < 300 && id !== undefined) {
      record('emailbison', 'POST /api/campaigns (draft only)', 'pass', `id ${String(id)} — delete this by hand`);
    } else {
      record('emailbison', 'POST /api/campaigns', 'fail', `status ${created.status}`);
    }
  }
}

async function checkProspeo() {
  if (!env.prospeoApiKey) return record('prospeo', 'key', 'skip', 'PROSPEO_API_KEY not set');
  // account-information is the one free endpoint, so it costs nothing to verify.
  const res = await json('https://api.prospeo.io/account-information', {
    headers: { 'X-KEY': env.prospeoApiKey, 'Content-Type': 'application/json' },
  });
  if (res.status === 200 && isObject(res.body)) {
    const credits = isObject(res.body.response) ? res.body.response['remaining_credits'] : undefined;
    record('prospeo', 'GET /account-information', 'pass', `remaining credits: ${String(credits ?? 'unknown')}`);
  } else {
    record('prospeo', 'GET /account-information', 'fail', `status ${res.status}`);
  }
}

async function checkTrueList() {
  if (!env.truelistApiKey) return record('truelist', 'key', 'skip', 'TRUELIST_API_KEY not set');
  const res = await json('https://api.truelist.io/me', {
    headers: { Authorization: `Bearer ${env.truelistApiKey}` },
  });
  record('truelist', 'GET /me', res.status === 200 ? 'pass' : 'fail', `status ${res.status}`);
}

async function checkInboxKit() {
  if (!env.inboxkitApiKey) return record('inboxkit', 'key', 'skip', 'INBOXKIT_API_KEY not set');
  const res = await json('https://api.inboxkit.com/v1/api/workspaces/list', {
    headers: { Authorization: `Bearer ${env.inboxkitApiKey}` },
  });
  if (res.status === 200) {
    record('inboxkit', 'GET /v1/api/workspaces/list', 'pass', 'copy the workspace id into X-Workspace-Id');
  } else {
    record('inboxkit', 'GET /v1/api/workspaces/list', 'fail', `status ${res.status}`);
  }
}

async function checkStripe() {
  if (!env.stripe.secretKey) return record('stripe', 'key', 'skip', 'STRIPE_SECRET_KEY not set');
  if (!env.stripe.secretKey.startsWith('sk_test_')) {
    record('stripe', 'test mode', 'fail', 'key is not sk_test_ — run the smoke test in test mode first');
  }
  const { default: Stripe } = await import('stripe');
  const stripe = new Stripe(env.stripe.secretKey);
  try {
    if (env.stripe.priceId) {
      const price = await stripe.prices.retrieve(env.stripe.priceId);
      const amount = price.unit_amount ?? 0;
      const matches = amount === env.subscriptionPriceCents;
      record(
        'stripe',
        'price matches config',
        matches ? 'pass' : 'fail',
        `${amount} cents ${price.recurring ? `/ ${price.recurring.interval}` : '(not recurring!)'}`,
      );
    } else {
      record('stripe', 'STRIPE_PRICE_ID', 'skip', 'not set');
    }
    if (!env.stripe.webhookSecret) {
      record('stripe', 'webhook secret', 'fail', 'STRIPE_WEBHOOK_SECRET not set — webhooks will be rejected');
    }
  } catch (err) {
    record('stripe', 'API call', 'fail', err instanceof Error ? err.message : String(err));
  }
}

async function checkAnthropic() {
  if (!env.anthropicApiKey) return record('anthropic', 'key', 'skip', 'ANTHROPIC_API_KEY not set');
  const { default: Anthropic } = await import('@anthropic-ai/sdk');
  const client = new Anthropic({ apiKey: env.anthropicApiKey });
  try {
    // Smallest possible structured-output call, to prove the model id and the
    // output_config shape both work before the pipeline depends on them.
    const msg = await client.messages.create({
      model: env.models.cheap,
      max_tokens: 64,
      messages: [{ role: 'user', content: 'Reply with {"ok": true}.' }],
      output_config: {
        format: {
          type: 'json_schema',
          schema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'], additionalProperties: false },
        },
      },
    } as Parameters<typeof client.messages.create>[0]);
    const stop = (msg as { stop_reason?: string }).stop_reason;
    record('anthropic', `${env.models.cheap} structured output`, stop === 'end_turn' ? 'pass' : 'fail', `stop_reason: ${stop}`);
  } catch (err) {
    record('anthropic', 'messages.create', 'fail', err instanceof Error ? err.message : String(err));
  }
}

// ---------------------------------------------------------------- main

async function main() {
  console.log('GTM Autopilot — live vendor smoke test');
  console.log(`mode: ${WRITE ? 'READ + bounded WRITE' : 'read-only'}\n`);

  for (const p of ['leads', 'verification', 'sending', 'domains', 'mailboxes', 'billing', 'llm', 'scrape']) {
    if (providerMode(p) === 'mock') console.log(`  note: provider "${p}" is in mock mode`);
  }
  console.log('');

  await checkDatabase();
  await checkEmailBison();
  await checkProspeo();
  await checkTrueList();
  await checkInboxKit();
  await checkStripe();
  await checkAnthropic();

  const failed = checks.filter((c) => c.status === 'fail');
  const skipped = checks.filter((c) => c.status === 'skip');
  console.log(
    `\n${checks.length - failed.length - skipped.length} passed, ${failed.length} failed, ${skipped.length} skipped`,
  );

  if (failed.length > 0) {
    console.log('\nFailures:');
    for (const f of failed) console.log(`  ${f.vendor}: ${f.what} — ${f.detail}`);
  }
  console.log('\nThis script never sends email. A real send still needs a launched campaign.');
  process.exit(failed.length > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

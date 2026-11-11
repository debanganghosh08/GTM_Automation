/**
 * Test database helper. Every suite gets a fresh embedded Postgres in a temp dir,
 * migrated from the real migration files — so tests exercise the production schema,
 * not a hand-maintained copy of it.
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { getDb, resetDb, type Db } from '../../src/lib/db';
import { migrate } from '../../src/lib/migrate';

let dir: string | null = null;

export async function freshDb(): Promise<Db> {
  await resetDb();
  // DATABASE_URL must be empty so getDb() picks the embedded backend.
  delete process.env.DATABASE_URL;
  dir = await mkdtemp(path.join(tmpdir(), 'gtm-test-'));
  const db = await getDb({ dataDir: dir });
  await migrate(db, { silent: true });
  return db;
}

export async function dropDb(): Promise<void> {
  await resetDb();
  if (dir) {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
    dir = null;
  }
}

/** Creates an account and returns its id. */
export async function makeAccount(db: Db, name = 'Test Co'): Promise<string> {
  const res = await db.query<{ id: string }>(
    `insert into accounts (company_name, website_url, trial_ends_at)
     values ($1, 'https://example.com', now() + interval '30 days') returning id`,
    [name],
  );
  return res.rows[0]!.id;
}

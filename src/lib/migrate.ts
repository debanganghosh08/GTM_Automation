/**
 * Migration runner. Applies every .sql file in supabase/migrations in name order,
 * once, inside a transaction, recording what ran in schema_migrations.
 *
 * Deliberately dependency-free so it works against PGlite and Supabase alike.
 */

import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import type { Db } from './db';

const MIGRATIONS_DIR = path.join(process.cwd(), 'supabase', 'migrations');

export async function migrate(db: Db, opts: { silent?: boolean } = {}): Promise<string[]> {
  await db.query(`
    create table if not exists schema_migrations (
      name       text primary key,
      applied_at timestamptz not null default now()
    )
  `);

  const applied = new Set(
    (await db.query<{ name: string }>('select name from schema_migrations')).rows.map((r) => r.name),
  );

  const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith('.sql')).sort();
  const ran: string[] = [];

  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = await readFile(path.join(MIGRATIONS_DIR, file), 'utf8');
    // A migration script holds many statements, so it goes through exec(), which
    // does not use a prepared statement. PGlite's exec() wraps the script in its own
    // implicit transaction; Postgres runs a multi-statement query the same way.
    await db.exec(sql);
    await db.query('insert into schema_migrations (name) values ($1)', [file]);
    ran.push(file);
    if (!opts.silent) console.log(`  applied ${file}`);
  }

  return ran;
}

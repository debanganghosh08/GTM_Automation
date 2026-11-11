/**
 * Database access.
 *
 * One query interface over two backends:
 *   - PGlite (embedded Postgres) when DATABASE_URL is empty — local dev and tests.
 *   - node-postgres when DATABASE_URL is set — Supabase in production.
 *
 * Both are real PostgreSQL, so the same migrations and the same SQL run on each.
 * Nothing above this file knows which one is in use.
 */

import type { Pool as PgPool } from 'pg';

export interface QueryResult<T> {
  rows: T[];
  rowCount: number;
}

export interface Db {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<QueryResult<T>>;
  /**
   * Runs a multi-statement SQL script (no parameters). Needed because a prepared
   * statement can only carry one command, so migrations cannot go through query().
   */
  exec(sql: string): Promise<void>;
  /** Runs fn inside a transaction, rolling back if it throws. */
  tx<T>(fn: (db: Db) => Promise<T>): Promise<T>;
  close(): Promise<void>;
  readonly backend: 'pglite' | 'postgres';
}

// ---------------------------------------------------------------- postgres

class PostgresDb implements Db {
  readonly backend = 'postgres' as const;
  constructor(private pool: PgPool) {}

  async query<T = Record<string, unknown>>(sql: string, params: unknown[] = []) {
    const res = await this.pool.query(sql, params as never[]);
    return { rows: res.rows as T[], rowCount: res.rowCount ?? 0 };
  }

  async exec(sql: string) {
    await this.pool.query(sql);
  }

  async tx<T>(fn: (db: Db) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    const scoped: Db = {
      backend: 'postgres',
      query: async <U = Record<string, unknown>>(sql: string, params: unknown[] = []) => {
        const res = await client.query(sql, params as never[]);
        return { rows: res.rows as U[], rowCount: res.rowCount ?? 0 };
      },
      exec: async (sql: string) => {
        await client.query(sql);
      },
      // Nested tx reuses the same client; Postgres has no real nesting without savepoints,
      // and no caller needs them.
      tx: async <U>(inner: (db: Db) => Promise<U>) => inner(scoped),
      close: async () => {},
    };
    try {
      await client.query('BEGIN');
      const out = await fn(scoped);
      await client.query('COMMIT');
      return out;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  async close() {
    await this.pool.end();
  }
}

// ---------------------------------------------------------------- pglite

type PgliteQueryable = {
  query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[]; affectedRows?: number }>;
  exec: (sql: string) => Promise<unknown>;
};

type PgliteInstance = PgliteQueryable & {
  /** Holds PGlite's internal mutex for the duration, so transactions serialise. */
  transaction: <T>(fn: (tx: PgliteQueryable) => Promise<T>) => Promise<T>;
  close: () => Promise<void>;
};

/** Wraps a PGlite transaction handle so it satisfies Db without re-entering transaction(). */
class PgliteTxDb implements Db {
  readonly backend = 'pglite' as const;
  // NB: this field must not be called `tx` -- a TypeScript parameter property of
  // that name becomes an own property and shadows the tx() method below.
  constructor(private handle: PgliteQueryable) {}

  async query<T = Record<string, unknown>>(sql: string, params: unknown[] = []) {
    const res = await this.handle.query(sql, params);
    const rows = res.rows as T[];
    return { rows, rowCount: res.affectedRows ?? rows.length };
  }

  async exec(sql: string) {
    await this.handle.exec(sql);
  }

  /**
   * Already inside a transaction. PGlite holds a single mutex, so calling
   * transaction() again here would deadlock. Reuse this handle instead; Postgres
   * has no true nesting without savepoints and no caller needs them.
   */
  async tx<T>(fn: (db: Db) => Promise<T>): Promise<T> {
    return fn(this);
  }

  async close() {
    // The owning PgliteDb closes the instance.
  }
}

class PgliteDb implements Db {
  readonly backend = 'pglite' as const;
  constructor(private pg: PgliteInstance) {}

  async query<T = Record<string, unknown>>(sql: string, params: unknown[] = []) {
    const res = await this.pg.query(sql, params);
    const rows = res.rows as T[];
    // PGlite reports affectedRows for writes and nothing for reads.
    return { rows, rowCount: res.affectedRows ?? rows.length };
  }

  async exec(sql: string) {
    await this.pg.exec(sql);
  }

  /**
   * Uses PGlite's own transaction(), which holds its internal mutex for the whole
   * callback. Hand-rolled BEGIN/COMMIT on the shared connection does NOT isolate:
   * two concurrent tx() calls interleave their statements and Postgres warns
   * "there is already a transaction in progress". Anything relying on
   * `select ... for update` across statements would silently lose isolation.
   */
  async tx<T>(fn: (db: Db) => Promise<T>): Promise<T> {
    return this.pg.transaction(async (handle) => fn(new PgliteTxDb(handle)));
  }

  async close() {
    await this.pg.close();
  }
}

// ---------------------------------------------------------------- factory

let instance: Db | null = null;

/**
 * Returns the process-wide database handle, creating it on first call.
 * `dataDir` only applies to PGlite; pass 'memory://' for tests.
 */
export async function getDb(opts: { dataDir?: string } = {}): Promise<Db> {
  if (instance) return instance;

  const url = process.env.DATABASE_URL?.trim();
  const isProduction = process.env.NODE_ENV === 'production';

  if (!url && isProduction) {
    // Second line of defence behind the boot guard. Falling back to the embedded
    // database here would write every signup and credit grant to a container
    // filesystem that is read-only on Vercel and discarded on the next deploy.
    throw new Error(
      'DATABASE_URL is not set. Refusing to fall back to the embedded database in production, '
      + 'because customer data would be written to ephemeral storage and lost.',
    );
  }

  if (url) {
    // `pg` 8.x is CommonJS. Under ESM its named exports are not statically analysable,
    // so `const { Pool } = await import('pg')` binds undefined and the next line throws
    // "Pool is not a constructor". Only the default export carries the class. This is the
    // one place the real-Postgres path is constructed, so the fault stayed invisible for
    // as long as every run used the embedded database. Both shapes are read so a future
    // pg release with genuine ESM named exports keeps working.
    const pgModule = await import('pg');
    const Pool = pgModule.default?.Pool ?? pgModule.Pool;
    const isLocal = url.includes('localhost') || url.includes('127.0.0.1');
    instance = new PostgresDb(
      new Pool({
        connectionString: url,
        // Each serverless instance keeps its own pool, so a high max multiplied by
        // many instances exhausts the server's connection limit. Keep it small and
        // point DATABASE_URL at a transaction pooler (Supavisor on port 6543).
        max: Number.parseInt(process.env.DATABASE_POOL_MAX ?? '', 10) || 5,
        // Without these a request waits forever for a connection, so a spike turns
        // into hung requests rather than fast failures.
        connectionTimeoutMillis: 5_000,
        idleTimeoutMillis: 10_000,
        // A runaway query cannot hold a pooled connection indefinitely.
        statement_timeout: 15_000,
        query_timeout: 20_000,
        ssl: isLocal
          ? undefined
          : {
              // Verify the certificate. The previous `rejectUnauthorized: false`
              // accepted any certificate, so anything on the network path could read
              // or alter traffic that carries password hashes and session tokens.
              // Supply the provider's CA via DATABASE_CA_CERT when it is not in the
              // system trust store.
              rejectUnauthorized: true,
              ca: process.env.DATABASE_CA_CERT?.trim() || undefined,
            },
      }),
    );
  } else {
    const { PGlite } = await import('@electric-sql/pglite');
    const dataDir = opts.dataDir ?? process.env.PGLITE_DIR ?? '.pglite';
    const pg = (await PGlite.create(dataDir)) as unknown as PgliteInstance;
    instance = new PgliteDb(pg);
  }
  return instance;
}

/** Test helper: drops the cached handle so the next getDb() builds a fresh one. */
export async function resetDb(): Promise<void> {
  if (instance) await instance.close().catch(() => {});
  instance = null;
}

/** Convenience for one-off reads. */
export async function q<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
  const db = await getDb();
  const res = await db.query<T>(sql, params);
  return res.rows;
}

/** Convenience for a single expected row. */
export async function q1<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T | null> {
  const rows = await q<T>(sql, params);
  return rows[0] ?? null;
}

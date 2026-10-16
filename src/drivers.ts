import { PGlite } from '@electric-sql/pglite';
import pg from 'pg';
import type { Row } from './diff.js';

export interface DriverResult {
  rows: Row[];
  rowCount: number;
}

/** A single dedicated connection. Transactions span multiple calls on it. */
export interface Driver {
  query(sql: string, params?: unknown[]): Promise<DriverResult>;
  /** Runs a multi-statement script (operator setup only, never exposed to the agent). */
  exec(sql: string): Promise<void>;
  close(): Promise<void>;
}

/**
 * Connection spec:
 *   memory                      in-memory embedded Postgres (tests, demos)
 *   pglite:<dir>                embedded Postgres persisted in a directory
 *   postgres://user:pw@host/db  a real Postgres or Supabase database
 */
export async function openDriver(spec: string): Promise<Driver> {
  if (spec === 'memory' || spec.startsWith('pglite:')) {
    const dir = spec === 'memory' ? undefined : spec.slice('pglite:'.length);
    const db = new PGlite(dir);
    await db.waitReady;
    return {
      async query(sql, params) {
        const res = await db.query<Row>(sql, params as unknown[] | undefined);
        return { rows: res.rows, rowCount: res.affectedRows ?? res.rows.length };
      },
      async exec(sql) {
        await db.exec(sql);
      },
      async close() {
        await db.close();
      },
    };
  }

  if (/^postgres(ql)?:\/\//i.test(spec)) {
    const client = new pg.Client({ connectionString: spec });
    await client.connect();
    return {
      async query(sql, params) {
        const res = await client.query(sql, params as unknown[] | undefined);
        return { rows: res.rows as Row[], rowCount: res.rowCount ?? res.rows.length };
      },
      async exec(sql) {
        await client.query(sql);
      },
      async close() {
        await client.end();
      },
    };
  }

  throw new Error(`Unsupported --db value. Use "memory", "pglite:<dir>" or a postgres:// URL.`);
}

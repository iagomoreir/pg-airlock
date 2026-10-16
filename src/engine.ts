import { randomBytes } from 'node:crypto';
import { classify } from './sql.js';
import { diffTables, jsonSafe, type Row, type Snapshot, type TableDiff } from './diff.js';
import type { Driver } from './drivers.js';
import { Journal } from './journal.js';
import {
  AirlockError,
  type Proposal,
  type QueryResult,
  type Resolution,
  type Risk,
} from './types.js';

export interface EngineOptions {
  /** How long a change may wait for a human before it is rolled back. */
  ttlMs?: number;
  /** Tables larger than this get a counts-only diff instead of a row-level one. */
  maxSnapshotRows?: number;
  /** Max rows returned to the agent from a single read. */
  maxReadRows?: number;
  /** statement_timeout for agent reads. A runaway read would otherwise block approvals. */
  readTimeoutMs?: number;
  /** statement_timeout for the proposed write and the diff snapshots. */
  writeTimeoutMs?: number;
  journal?: Journal;
}

interface TableSnap {
  qualified: string | null;
  keyColumns: string[];
  snapshot: Snapshot | null;
}

const HISTORY_LIMIT = 200;

/**
 * Wraps one database connection. Reads run in a READ ONLY transaction. Writes
 * run inside an open transaction that is held until a human commits or rolls
 * it back, with a before/after diff computed from inside that transaction.
 * Only one change can be pending at a time.
 */
export class Engine {
  private chain: Promise<unknown> = Promise.resolve();
  private current: { proposal: Proposal; timer: NodeJS.Timeout } | null = null;
  private readonly history = new Map<string, Proposal>();
  private readonly ttlMs: number;
  private readonly maxSnapshotRows: number;
  private readonly maxReadRows: number;
  private readonly readTimeoutMs: number;
  private readonly writeTimeoutMs: number;
  private readonly journal: Journal;

  constructor(
    private readonly driver: Driver,
    options: EngineOptions = {},
  ) {
    this.ttlMs = options.ttlMs ?? 10 * 60 * 1000;
    this.maxSnapshotRows = options.maxSnapshotRows ?? 5000;
    this.maxReadRows = options.maxReadRows ?? 200;
    this.readTimeoutMs = Math.max(1, Math.floor(options.readTimeoutMs ?? 10_000));
    this.writeTimeoutMs = Math.max(1, Math.floor(options.writeTimeoutMs ?? 60_000));
    this.journal = options.journal ?? new Journal(null);
  }

  private lock<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn);
    this.chain = run.catch(() => undefined);
    return run;
  }

  // ---------------------------------------------------------------- reads

  async read(sql: string, params?: unknown[]): Promise<QueryResult> {
    const cls = classify(sql);
    if (cls.kind === 'blocked') throw new AirlockError('blocked', cls.reason ?? 'statement not allowed');
    if (cls.kind !== 'read') {
      throw new AirlockError('not_a_read', 'This statement changes data. Use db_execute so a human can review it.');
    }

    return this.lock(async () => {
      const pendingChangeId = this.current?.proposal.id;
      let res;
      if (this.current) {
        // Run inside the pending transaction so the agent sees its own change, but:
        //  - read-only, so a SELECT cannot call a function that writes into the held transaction
        //    (it would be committed together with the change the human approved), and
        //  - ALWAYS rolled back to the savepoint, so even a read that slips through leaves nothing behind.
        await this.driver.query('SAVEPOINT pg_airlock_read');
        try {
          await this.driver.query('SET LOCAL transaction_read_only = on');
          await this.driver.query(`SET LOCAL statement_timeout = ${this.readTimeoutMs}`);
          res = await this.driver.query(sql, params);
        } catch (err) {
          throw new AirlockError('sql_error', (err as Error).message);
        } finally {
          await this.driver.query('ROLLBACK TO SAVEPOINT pg_airlock_read').catch(() => undefined);
          await this.driver.query('RELEASE SAVEPOINT pg_airlock_read').catch(() => undefined);
        }
      } else {
        await this.driver.query('BEGIN READ ONLY');
        try {
          await this.driver.query(`SET LOCAL statement_timeout = ${this.readTimeoutMs}`);
          res = await this.driver.query(sql, params);
        } catch (err) {
          throw new AirlockError('sql_error', (err as Error).message);
        } finally {
          await this.driver.query('ROLLBACK').catch(() => undefined);
        }
      }
      const truncated = res.rows.length > this.maxReadRows;
      const rows = jsonSafe(truncated ? res.rows.slice(0, this.maxReadRows) : res.rows);
      return { rows, rowCount: res.rows.length, truncated, ...(pendingChangeId ? { pendingChangeId } : {}) };
    });
  }

  // --------------------------------------------------------------- writes

  async propose(sql: string, params?: unknown[]): Promise<Proposal> {
    const cls = classify(sql);
    if (cls.kind === 'blocked') {
      await this.journal.append({ event: 'rejected_statement', detail: { sql, reason: cls.reason } });
      throw new AirlockError('blocked', cls.reason ?? 'statement not allowed');
    }
    if (cls.kind === 'read') {
      throw new AirlockError('not_a_write', 'This statement only reads data. Use db_query.');
    }

    const kind: 'write' | 'ddl' = cls.kind;

    return this.lock(async () => {
      if (this.current) {
        throw new AirlockError(
          'pending_exists',
          `Change ${this.current.proposal.id} is still waiting for human approval. Wait until it is resolved (poll db_status) before proposing another change.`,
          { pendingChangeId: this.current.proposal.id },
        );
      }

      await this.driver.query('BEGIN');
      try {
        await this.driver.query(`SET LOCAL statement_timeout = ${this.writeTimeoutMs}`);
        const before = new Map<string, TableSnap>();
        for (const t of cls.tables) before.set(t, await this.snapshot(t));

        const res = await this.driver.query(sql, params);

        const diff: TableDiff[] = [];
        const warnings: string[] = [];
        let unresolved = false;
        for (const t of cls.tables) {
          const b = before.get(t)!;
          const a = await this.snapshot(t);
          const keyColumns = b.keyColumns.length > 0 ? b.keyColumns : a.keyColumns;
          const d = diffTables(t, keyColumns, b.snapshot, a.snapshot);
          diff.push(d);
          if (b.qualified === null && a.qualified === null) {
            unresolved = true;
            warnings.push(`Could not find table ${t} before or after the statement: no diff is available for it.`);
          }
          if (!d.rowLevel && (b.snapshot || a.snapshot)) {
            warnings.push(`Table ${t} has more than ${this.maxSnapshotRows} rows: only row counts are shown, not a row-level diff.`);
          }
          if (d.rowLevel && keyColumns.length === 0 && (d.updated > 0 || d.deleted > 0 || d.inserted > 0) && b.snapshot) {
            warnings.push(`Table ${t} has no primary key: updated rows appear as a delete plus an insert.`);
          }
        }
        if (cls.tables.length === 0) {
          warnings.push('Could not determine which tables this statement touches: no row-level diff is available.');
        }
        const hidden = kind === 'write' ? await this.hiddenEffects(cls.tables) : [];
        for (const h of hidden) warnings.push(h);
        if (kind === 'ddl' && cls.tables.length > 0) {
          warnings.push('Schema changes (columns, indexes, constraints) are not shown in the row diff; read the SQL itself.');
        }
        if (kind === 'ddl' && cls.tables.length === 0) {
          warnings.push('This schema change has no row-level diff; read the SQL itself.');
        }

        const now = new Date();
        const proposal: Proposal = {
          id: `chg_${randomBytes(5).toString('hex')}`,
          sql,
          ...(params ? { params: jsonSafe(params) } : {}),
          kind,
          verb: cls.verb,
          status: 'pending',
          createdAt: now.toISOString(),
          expiresAt: new Date(now.getTime() + this.ttlMs).toISOString(),
          rowsAffected: res.rowCount,
          returning: jsonSafe(res.rows.slice(0, 20)),
          tables: cls.tables,
          diff,
          risk: unresolved
            ? 'high'
            : this.raiseForHidden(this.assessRisk(cls.destructive, kind, cls.tables.length, res.rowCount, diff), hidden.length > 0),
          warnings,
        };

        const timer = setTimeout(() => {
          void this.settle(proposal.id, 'rollback', 'expired', 'system', 'No decision within the time limit.').catch(
            () => undefined,
          );
        }, this.ttlMs);
        timer.unref();
        this.current = { proposal, timer };

        await this.journal.append({
          event: 'proposed',
          id: proposal.id,
          actor: 'agent',
          detail: { sql, risk: proposal.risk, rowsAffected: proposal.rowsAffected, diff },
        });
        return proposal;
      } catch (err) {
        await this.driver.query('ROLLBACK').catch(() => undefined);
        const message = err instanceof Error ? err.message : String(err);
        await this.journal.append({ event: 'error', actor: 'agent', detail: { sql, message } });
        if (err instanceof AirlockError) throw err;
        throw new AirlockError('sql_error', message);
      }
    });
  }

  /** Triggers and cascading foreign keys can change tables the statement never names, so the diff cannot show them. */
  private async hiddenEffects(tables: string[]): Promise<string[]> {
    const out: string[] = [];
    for (const t of tables) {
      try {
        const trg = await this.driver.query(
          `SELECT count(*)::int AS n FROM pg_trigger WHERE tgrelid = to_regclass($1) AND NOT tgisinternal`,
          [t],
        );
        if (Number(trg.rows[0]?.['n'] ?? 0) > 0) {
          out.push(`Table ${t} has triggers: they ran as part of this change and may have modified other tables that are not in the diff above.`);
        }
        const fk = await this.driver.query(
          `SELECT count(*)::int AS n FROM pg_constraint WHERE contype = 'f' AND confrelid = to_regclass($1) AND (confdeltype IN ('c','n','d') OR confupdtype IN ('c','n','d'))`,
          [t],
        );
        if (Number(fk.rows[0]?.['n'] ?? 0) > 0) {
          out.push(`Other tables reference ${t} with cascading foreign keys: rows in those tables may have changed too and are not in the diff above.`);
        }
      } catch {
        /* catalog lookup is best effort */
      }
    }
    return out;
  }

  private raiseForHidden(risk: Proposal['risk'], hidden: boolean): Proposal['risk'] {
    return hidden && risk === 'low' ? 'medium' : risk;
  }

  private assessRisk(
    destructive: boolean,
    kind: 'write' | 'ddl',
    tableCount: number,
    rowsAffected: number,
    diff: TableDiff[],
  ): Risk {
    if (destructive) return 'high';
    if (tableCount === 0) return 'high';
    if (rowsAffected >= 1000) return 'high';
    if (diff.some((d) => !d.rowLevel && (d.inserted + d.updated + d.deleted > 0 || d.rowCountBefore !== d.rowCountAfter))) {
      return 'high';
    }
    if (kind === 'ddl' || tableCount > 1 || rowsAffected >= 100) return 'medium';
    return 'low';
  }

  private async resolveTable(name: string): Promise<string | null> {
    const res = await this.driver.query('SELECT to_regclass($1)::text AS name', [name]);
    const value = res.rows[0]?.['name'];
    return typeof value === 'string' ? value : null;
  }

  private async keyColumnsOf(qualified: string): Promise<string[]> {
    const res = await this.driver.query(
      `SELECT a.attname AS col
         FROM pg_index i
         JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY (i.indkey)
        WHERE i.indrelid = $1::regclass AND i.indisprimary
        ORDER BY array_position(i.indkey::int2[], a.attnum)`,
      [qualified],
    );
    return res.rows.map((r) => String(r['col']));
  }

  private async snapshot(name: string): Promise<TableSnap> {
    const qualified = await this.resolveTable(name);
    if (!qualified) return { qualified: null, keyColumns: [], snapshot: null };
    const keyColumns = await this.keyColumnsOf(qualified);
    const countRes = await this.driver.query(`SELECT count(*)::int AS n FROM ${qualified}`);
    const count = Number(countRes.rows[0]?.['n'] ?? 0);
    if (count > this.maxSnapshotRows) return { qualified, keyColumns, snapshot: { count, rows: null } };
    const rowsRes = await this.driver.query(`SELECT * FROM ${qualified}`);
    return { qualified, keyColumns, snapshot: { count, rows: jsonSafe(rowsRes.rows as Row[]) } };
  }

  // ------------------------------------------------------------- decisions

  commit(id: string, actor = 'human'): Promise<Proposal> {
    return this.settle(id, 'commit', 'approved', actor);
  }

  rollback(id: string, actor = 'human', reason?: string): Promise<Proposal> {
    return this.settle(id, 'rollback', 'rejected', actor, reason);
  }

  private settle(
    id: string,
    action: 'commit' | 'rollback',
    resolution: Resolution,
    actor: string,
    reason?: string,
  ): Promise<Proposal> {
    return this.lock(async () => {
      const cur = this.current;
      if (!cur || cur.proposal.id !== id) {
        const past = this.history.get(id);
        if (past) {
          throw new AirlockError('already_resolved', `Change ${id} was already ${past.status.replace('_', ' ')}.`, {
            status: past.status,
          });
        }
        throw new AirlockError('not_found', `No change with id ${id}.`);
      }

      clearTimeout(cur.timer);
      const proposal = cur.proposal;
      this.current = null;

      let finalAction = action;
      let finalResolution = resolution;
      let finalReason = reason;
      if (action === 'commit') {
        try {
          await this.driver.query('COMMIT');
        } catch (err) {
          await this.driver.query('ROLLBACK').catch(() => undefined);
          finalAction = 'rollback';
          finalResolution = 'error';
          finalReason = `Commit failed: ${(err as Error).message}`;
        }
      } else {
        await this.driver.query('ROLLBACK').catch(() => undefined);
      }

      proposal.status = finalAction === 'commit' ? 'committed' : 'rolled_back';
      proposal.resolution = finalResolution;
      proposal.resolvedAt = new Date().toISOString();
      proposal.resolvedBy = actor;
      if (finalReason) proposal.reason = finalReason;

      this.history.set(proposal.id, proposal);
      if (this.history.size > HISTORY_LIMIT) {
        const oldest = this.history.keys().next().value;
        if (oldest) this.history.delete(oldest);
      }

      await this.journal.append({
        event: proposal.status === 'committed' ? 'committed' : finalResolution === 'expired' ? 'expired' : 'rolled_back',
        id: proposal.id,
        actor,
        detail: { sql: proposal.sql, resolution: finalResolution, ...(finalReason ? { reason: finalReason } : {}) },
      });

      if (finalResolution === 'error') {
        throw new AirlockError('commit_failed', finalReason ?? 'commit failed', { id });
      }
      return proposal;
    });
  }

  // --------------------------------------------------------------- queries

  pending(): Proposal | null {
    return this.current?.proposal ?? null;
  }

  get(id: string): Proposal | null {
    if (this.current?.proposal.id === id) return this.current.proposal;
    return this.history.get(id) ?? null;
  }

  async close(): Promise<void> {
    const cur = this.current;
    if (cur) {
      await this.settle(cur.proposal.id, 'rollback', 'expired', 'system', 'Server shut down.').catch(() => undefined);
    }
    await this.chain;
    await this.driver.close();
  }
}

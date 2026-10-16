import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Engine } from './engine.js';
import { AirlockError, type Proposal } from './types.js';

/** The complete set of tools the agent can see. None of them can commit. */
export const AGENT_TOOLS = ['db_schema', 'db_query', 'db_execute', 'db_status'] as const;

function ok(payload: unknown) {
  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify(payload, (_k, v) => (typeof v === 'bigint' ? v.toString() : v), 2),
      },
    ],
  };
}

function fail(err: unknown) {
  const e = err instanceof AirlockError ? err : new AirlockError('sql_error', (err as Error).message);
  return {
    isError: true,
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify({ error: e.code, message: e.message, ...(e.details ?? {}) }, null, 2),
      },
    ],
  };
}

function summarize(p: Proposal) {
  return p.diff.map((d) => ({
    table: d.table,
    inserted: d.inserted,
    updated: d.updated,
    deleted: d.deleted,
    ...(d.existedBefore && !d.existsAfter ? { dropped: true } : {}),
    ...(!d.existedBefore && d.existsAfter ? { created: true } : {}),
  }));
}

function statusPayload(p: Proposal) {
  const base = {
    changeId: p.id,
    status: p.status,
    risk: p.risk,
    rowsAffected: p.rowsAffected,
    summary: summarize(p),
    warnings: p.warnings,
  };
  if (p.status === 'pending') {
    return {
      ...base,
      applied: false,
      expiresAt: p.expiresAt,
      message:
        'NOT applied yet. A human must review and approve this change. Do not assume it will be applied. Reads you make now include this pending change, so treat what you see as provisional. Poll db_status with this changeId.',
    };
  }
  if (p.status === 'committed') {
    return { ...base, applied: true, message: 'APPLIED. The human approved this change; it is now permanent.' };
  }
  const why =
    p.resolution === 'expired'
      ? 'it timed out waiting for approval'
      : p.resolution === 'error'
        ? 'it failed to commit'
        : 'the human rejected it';
  return {
    ...base,
    applied: false,
    ...(p.reason ? { reason: p.reason } : {}),
    message: `NOT APPLIED: this change was rolled back (${why}). The database does not contain it. Discard any assumptions or earlier reads that depended on it, re-read the current state, and adjust your plan before continuing.`,
  };
}

export function createMcpServer(engine: Engine): McpServer {
  const server = new McpServer(
    { name: 'pg-airlock', version: '0.1.0' },
    {
      instructions:
        'Database access with human review. db_query reads data. db_execute proposes a change that a human must approve before it is applied; it returns immediately with status "pending". Never assume a change is applied until db_status reports "committed".',
    },
  );

  server.registerTool(
    'db_schema',
    {
      description: 'List tables and columns in the database.',
      inputSchema: {},
    },
    async () => {
      try {
        const r = await engine.read(
          `SELECT table_schema, table_name, column_name, data_type, is_nullable
             FROM information_schema.columns
            WHERE table_schema NOT IN ('pg_catalog', 'information_schema')
            ORDER BY table_schema, table_name, ordinal_position`,
        );
        const tables: Record<string, string[]> = {};
        for (const row of r.rows) {
          const key = row['table_schema'] === 'public' ? String(row['table_name']) : `${row['table_schema']}.${row['table_name']}`;
          (tables[key] ??= []).push(
            `${row['column_name']} ${row['data_type']}${row['is_nullable'] === 'NO' ? ' NOT NULL' : ''}`,
          );
        }
        return ok({ tables, ...(r.pendingChangeId ? { pendingChangeId: r.pendingChangeId } : {}) });
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    'db_query',
    {
      description:
        'Run ONE read-only SQL statement (SELECT / WITH ... SELECT / SHOW / EXPLAIN). Runs in a read-only transaction. Results are capped; add LIMIT or aggregate for large tables.',
      inputSchema: { sql: z.string().min(1).describe('A single read-only SQL statement') },
    },
    async ({ sql }) => {
      try {
        return ok(await engine.read(sql));
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    'db_execute',
    {
      description:
        'Propose ONE data or schema change (INSERT / UPDATE / DELETE / DDL). It is executed in a held transaction so a human can review the exact row-level diff, then committed or rolled back. Returns immediately with status "pending"; the change is NOT applied until a human approves. Only one change can be pending at a time.',
      inputSchema: { sql: z.string().min(1).describe('A single INSERT/UPDATE/DELETE/DDL statement') },
    },
    async ({ sql }) => {
      try {
        return ok(statusPayload(await engine.propose(sql)));
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    'db_status',
    {
      description:
        'Check whether a proposed change was approved (committed), rejected or expired (rolled back), or is still pending.',
      inputSchema: { changeId: z.string().min(1).describe('The changeId returned by db_execute') },
    },
    async ({ changeId }) => {
      const p = engine.get(changeId);
      if (!p) return fail(new AirlockError('not_found', `No change with id ${changeId}.`));
      return ok(statusPayload(p));
    },
  );

  return server;
}

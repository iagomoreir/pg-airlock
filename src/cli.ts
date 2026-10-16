#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { createInterface } from 'node:readline/promises';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { openDriver } from './drivers.js';
import { Engine } from './engine.js';
import { Journal } from './journal.js';
import { startApprovalServer } from './approval.js';
import { createMcpServer } from './mcp.js';
import { formatProposal } from './format.js';
import type { Proposal } from './types.js';

const HELP = `pg-airlock: human-reviewed, reversible database changes for AI agents

Usage:
  pg-airlock serve --db <spec> [options]   Run the MCP server (stdio) + local approval API
  pg-airlock pending                       Show the change waiting for approval
  pg-airlock show <id>                     Show one change in full
  pg-airlock commit <id> [--yes]           Approve and apply a change
  pg-airlock rollback <id> [--reason "."]  Reject a change and undo it
  pg-airlock log [-n 20]                   Show the audit journal

serve options:
  --db <spec>          memory | pglite:<dir> | postgres://user:pw@host/db   (or env PG_AIRLOCK_DB)
  --ttl <seconds>      Auto-rollback a pending change after this long (default 600)
  --max-rows <n>       Largest table that gets a row-level diff (default 5000)
  --port <n>           Fixed port for the approval API (default: random free port)
  --init <file.sql>    Run a SQL script once at startup, as the operator (seed data for demos)

All commands accept --state-dir <dir> (default ~/.pg-airlock, or env PG_AIRLOCK_HOME).
`;

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    db: { type: 'string' },
    ttl: { type: 'string' },
    'max-rows': { type: 'string' },
    port: { type: 'string' },
    init: { type: 'string' },
    'state-dir': { type: 'string' },
    yes: { type: 'boolean', short: 'y' },
    reason: { type: 'string' },
    n: { type: 'string', short: 'n' },
    help: { type: 'boolean', short: 'h' },
  },
});

const stateDir = values['state-dir'] ?? process.env['PG_AIRLOCK_HOME'] ?? join(homedir(), '.pg-airlock');
const [command, arg] = positionals;

function die(message: string, code = 1): never {
  process.stderr.write(message + '\n');
  process.exit(code);
}

async function serve(): Promise<void> {
  const spec = values.db ?? process.env['PG_AIRLOCK_DB'];
  if (!spec) die('Missing --db. Example: pg-airlock serve --db postgres://user:pw@localhost:5432/mydb');

  const driver = await openDriver(spec);
  if (values.init) await driver.exec(await readFile(values.init, 'utf8'));
  const journal = new Journal(join(stateDir, 'journal.jsonl'));
  const engine = new Engine(driver, {
    journal,
    ...(values.ttl ? { ttlMs: Number(values.ttl) * 1000 } : {}),
    ...(values['max-rows'] ? { maxSnapshotRows: Number(values['max-rows']) } : {}),
  });
  const approval = await startApprovalServer(engine, {
    stateDir,
    journal,
    ...(values.port ? { port: Number(values.port) } : {}),
  });
  const mcp = createMcpServer(engine);

  let closing = false;
  const shutdown = async (): Promise<void> => {
    if (closing) return;
    closing = true;
    await engine.close().catch(() => undefined);
    await approval.close().catch(() => undefined);
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
  mcp.server.onclose = () => void shutdown();

  await mcp.connect(new StdioServerTransport());
  // stdout belongs to the MCP protocol; everything human-readable goes to stderr.
  process.stderr.write(
    `[pg-airlock] ready. Approval API on 127.0.0.1:${approval.port}. Review changes with: pg-airlock pending\n`,
  );
}

async function api(method: 'GET' | 'POST', path: string, body?: unknown): Promise<any> {
  let state: { port: number; token: string };
  try {
    state = JSON.parse(await readFile(join(stateDir, 'server.json'), 'utf8'));
  } catch {
    die(`No running pg-airlock server found in ${stateDir}. Start one with "pg-airlock serve" (same --state-dir).`);
  }
  let res: Response;
  try {
    res = await fetch(`http://127.0.0.1:${state.port}${path}`, {
      method,
      headers: { 'x-pg-airlock-token': state.token, 'content-type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  } catch {
    die('Could not reach the pg-airlock server. Is it still running?');
  }
  const json: any = await res.json();
  if (!res.ok) die(`${json.error ?? res.status}: ${json.message ?? ''}`);
  return json;
}

async function confirm(question: string): Promise<boolean> {
  if (!process.stdin.isTTY) die('Refusing to prompt without a terminal. Re-run with --yes to confirm non-interactively.');
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question(question);
  rl.close();
  return /^y(es)?$/i.test(answer.trim());
}

async function main(): Promise<void> {
  if (values.help || !command) {
    process.stdout.write(HELP);
    return;
  }

  switch (command) {
    case 'serve':
      return serve();

    case 'pending': {
      const { pending } = (await api('GET', '/pending')) as { pending: Proposal | null };
      process.stdout.write(pending ? formatProposal(pending) + '\n' : 'Nothing is waiting for approval.\n');
      return;
    }

    case 'show': {
      if (!arg) die('Usage: pg-airlock show <id>');
      const { change } = (await api('GET', `/changes/${arg}`)) as { change: Proposal };
      process.stdout.write(formatProposal(change) + '\n');
      return;
    }

    case 'commit': {
      if (!arg) die('Usage: pg-airlock commit <id> [--yes]');
      const { change } = (await api('GET', `/changes/${arg}`)) as { change: Proposal };
      process.stdout.write(formatProposal(change) + '\n\n');
      if (change.status !== 'pending') die(`Nothing to do: change is already ${change.status.replace('_', ' ')}.`, 0);
      if (!values.yes && !(await confirm('Commit this change? [y/N] '))) die('Not committed.', 0);
      const res = (await api('POST', `/changes/${arg}/commit`)) as { change: Proposal };
      process.stdout.write(`Committed ${res.change.id}.\n`);
      return;
    }

    case 'rollback': {
      if (!arg) die('Usage: pg-airlock rollback <id> [--reason "..."]');
      const res = (await api('POST', `/changes/${arg}/rollback`, values.reason ? { reason: values.reason } : {})) as {
        change: Proposal;
      };
      process.stdout.write(`Rolled back ${res.change.id}. The database is unchanged.\n`);
      return;
    }

    case 'log': {
      const n = values.n ? Number(values.n) : 20;
      const { entries } = (await api('GET', `/journal?n=${n}`)) as { entries: Array<Record<string, any>> };
      if (entries.length === 0) process.stdout.write('Journal is empty.\n');
      for (const e of entries) {
        const sql = typeof e['detail']?.sql === 'string' ? String(e['detail'].sql).replace(/\s+/g, ' ').slice(0, 90) : '';
        process.stdout.write(`${e['ts']}  ${String(e['event']).padEnd(18)} ${e['id'] ?? '-'}  ${e['actor'] ?? ''}  ${sql}\n`);
      }
      return;
    }

    default:
      die(`Unknown command "${command}".\n\n${HELP}`);
  }
}

main().catch((err) => die(err instanceof Error ? err.message : String(err)));

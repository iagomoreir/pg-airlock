import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { Engine } from './engine.js';
import type { Journal } from './journal.js';
import { AirlockError } from './types.js';

export interface ApprovalServer {
  port: number;
  token: string;
  close(): Promise<void>;
}

export interface ApprovalOptions {
  stateDir: string;
  journal: Journal;
  /** 0 picks a free port. */
  port?: number;
  token?: string;
}

function send(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body, (_k, v) => (typeof v === 'bigint' ? v.toString() : v));
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(text);
}

function tokenOk(provided: string | undefined, expected: string): boolean {
  if (!provided) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > 64 * 1024) throw new Error('request body too large');
    chunks.push(chunk as Buffer);
  }
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
}

/**
 * Local HTTP API that humans (via the CLI) use to approve or reject changes.
 * It is deliberately a different channel from the MCP tools the agent sees:
 * the agent has no tool that can commit.
 */
export async function startApprovalServer(engine: Engine, opts: ApprovalOptions): Promise<ApprovalServer> {
  const token = opts.token ?? randomBytes(24).toString('hex');

  const server: Server = createServer((req, res) => {
    void handle(req, res).catch((err) => {
      if (err instanceof AirlockError) {
        const status = err.code === 'not_found' ? 404 : 409;
        send(res, status, { error: err.code, message: err.message });
      } else {
        send(res, 500, { error: 'internal', message: (err as Error).message });
      }
    });
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // Defend against DNS rebinding and browser-originated requests.
    const host = req.headers.host ?? '';
    if (!/^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(host) || req.headers.origin) {
      return send(res, 403, { error: 'forbidden', message: 'local CLI access only' });
    }
    if (!tokenOk(req.headers['x-pg-airlock-token'] as string | undefined, token)) {
      return send(res, 401, { error: 'unauthorized', message: 'missing or invalid token' });
    }

    const url = new URL(req.url ?? '/', 'http://localhost');
    const method = req.method ?? 'GET';

    if (method === 'GET' && url.pathname === '/pending') {
      return send(res, 200, { pending: engine.pending() });
    }

    if (method === 'GET' && url.pathname === '/journal') {
      const n = Math.min(Number(url.searchParams.get('n') ?? 50) || 50, 500);
      return send(res, 200, { entries: await opts.journal.tail(n) });
    }

    const m = /^\/changes\/([\w-]+)(?:\/(commit|rollback))?$/.exec(url.pathname);
    if (m) {
      const id = m[1]!;
      const action = m[2];
      if (method === 'GET' && !action) {
        const p = engine.get(id);
        if (!p) return send(res, 404, { error: 'not_found', message: `No change with id ${id}.` });
        return send(res, 200, { change: p });
      }
      if (method === 'POST' && action === 'commit') {
        const p = await engine.commit(id, 'human-cli');
        return send(res, 200, { change: p });
      }
      if (method === 'POST' && action === 'rollback') {
        const body = await readJson(req);
        const reason = typeof body['reason'] === 'string' ? body['reason'] : undefined;
        const p = await engine.rollback(id, 'human-cli', reason);
        return send(res, 200, { change: p });
      }
    }

    return send(res, 404, { error: 'not_found', message: 'unknown route' });
  }

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port ?? 0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;

  const stateFile = join(opts.stateDir, 'server.json');
  await mkdir(opts.stateDir, { recursive: true, mode: 0o700 });
  await writeFile(stateFile, JSON.stringify({ port, token, pid: process.pid, startedAt: new Date().toISOString() }), {
    mode: 0o600,
  });

  return {
    port,
    token,
    async close() {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(stateFile, { force: true });
    },
  };
}

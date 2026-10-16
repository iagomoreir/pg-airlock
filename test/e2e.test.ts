import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { request } from 'node:http';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { AGENT_TOOLS } from '../src/mcp.js';

const run = promisify(execFile);
const CLI = resolve('dist/cli.js');

let stateDir: string;
let client: Client;

/** What the human types in a terminal. */
async function human(...args: string[]): Promise<string> {
  const { stdout } = await run(process.execPath, [CLI, ...args, '--state-dir', stateDir]);
  return stdout;
}

/** What the agent does through MCP. */
async function agent(name: string, args: Record<string, unknown> = {}) {
  const res = (await client.callTool({ name, arguments: args })) as {
    isError?: boolean;
    content: Array<{ type: string; text: string }>;
  };
  return { isError: res.isError === true, data: JSON.parse(res.content[0]!.text) as any };
}

before(async () => {
  stateDir = await mkdtemp(join(tmpdir(), 'pg-airlock-e2e-'));
  client = new Client({ name: 'test-agent', version: '1.0.0' });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [CLI, 'serve', '--db', 'memory', '--state-dir', stateDir],
      stderr: 'ignore',
    }),
  );
});

after(async () => {
  await client.close().catch(() => undefined);
  await rm(stateDir, { recursive: true, force: true });
});

test('the agent can see exactly four tools and none of them can commit', async () => {
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((t) => t.name).sort(), [...AGENT_TOOLS].sort());
  for (const t of tools) assert.doesNotMatch(t.name, /commit|approve|rollback/);
});

test('agent proposes, human commits, agent sees it applied', async () => {
  const create = await agent('db_execute', { sql: 'CREATE TABLE t (id int PRIMARY KEY, v text)' });
  assert.equal(create.data.status, 'pending');
  assert.equal(create.data.applied, false);

  const pendingText = await human('pending');
  assert.match(pendingText, /PENDING/);
  assert.match(pendingText, /CREATE TABLE t/);
  assert.match(pendingText, /new table/);

  // While it is pending the agent cannot stack another change on top of it.
  const second = await agent('db_execute', { sql: "INSERT INTO t VALUES (1,'a')" });
  assert.equal(second.isError, true);
  assert.equal(second.data.error, 'pending_exists');

  await human('commit', create.data.changeId, '--yes');
  const status = await agent('db_status', { changeId: create.data.changeId });
  assert.equal(status.data.status, 'committed');
  assert.equal(status.data.applied, true);

  const schema = await agent('db_schema');
  assert.ok(schema.data.tables.t);
});

test('agent proposes, human rejects, agent is told to discard its assumptions', async () => {
  const ins = await agent('db_execute', { sql: "INSERT INTO t VALUES (1,'a'), (2,'b')" });
  assert.equal(ins.data.status, 'pending');
  assert.equal(ins.data.summary[0].inserted, 2);

  const during = await agent('db_query', { sql: 'SELECT count(*)::int AS n FROM t' });
  assert.equal(during.data.rows[0].n, 2);
  assert.equal(during.data.pendingChangeId, ins.data.changeId);

  const shown = await human('show', ins.data.changeId);
  assert.match(shown, /\+ id=1 v="a"/);

  await human('rollback', ins.data.changeId, '--reason', 'wrong table');
  const status = await agent('db_status', { changeId: ins.data.changeId });
  assert.equal(status.data.status, 'rolled_back');
  assert.equal(status.data.applied, false);
  assert.match(status.data.message, /Discard any assumptions/);
  assert.equal(status.data.reason, 'wrong table');

  const after = await agent('db_query', { sql: 'SELECT count(*)::int AS n FROM t' });
  assert.equal(after.data.rows[0].n, 0);
  assert.equal(after.data.pendingChangeId, undefined);
});

test('the agent cannot commit by smuggling transaction control through SQL', async () => {
  const ins = await agent('db_execute', { sql: "INSERT INTO t VALUES (9,'z')" });
  for (const sql of ['COMMIT', 'END', 'SELECT 1; COMMIT', "DO $$ BEGIN COMMIT; END $$", 'ROLLBACK']) {
    for (const tool of ['db_query', 'db_execute']) {
      const r = await agent(tool, { sql });
      assert.equal(r.isError, true, `${tool}: ${sql}`);
    }
  }
  const still = await agent('db_status', { changeId: ins.data.changeId });
  assert.equal(still.data.status, 'pending');
  await human('rollback', ins.data.changeId);
  const n = await agent('db_query', { sql: 'SELECT count(*)::int AS n FROM t' });
  assert.equal(n.data.rows[0].n, 0);
});

test('committing the same change twice is a no-op, not a second write', async () => {
  const ins = await agent('db_execute', { sql: "INSERT INTO t VALUES (5,'x')" });
  await human('commit', ins.data.changeId, '--yes');
  const again = await run(process.execPath, [CLI, 'commit', ins.data.changeId, '--yes', '--state-dir', stateDir]);
  assert.match(again.stderr, /already committed/);
  assert.doesNotMatch(again.stdout, /^Committed/m);
  const n = await agent('db_query', { sql: 'SELECT count(*)::int AS n FROM t' });
  assert.equal(n.data.rows[0].n, 1);
});

test('the approval API rejects missing tokens, foreign hosts and browser origins', async () => {
  const { port, token } = JSON.parse(await readFile(join(stateDir, 'server.json'), 'utf8')) as {
    port: number;
    token: string;
  };

  const call = (headers: Record<string, string>) =>
    new Promise<number>((resolveStatus, reject) => {
      const req = request({ host: '127.0.0.1', port, path: '/pending', method: 'GET', headers }, (res) => {
        res.resume();
        resolveStatus(res.statusCode ?? 0);
      });
      req.on('error', reject);
      req.end();
    });

  assert.equal(await call({}), 401);
  assert.equal(await call({ 'x-pg-airlock-token': 'wrong' }), 401);
  assert.equal(await call({ 'x-pg-airlock-token': token, host: 'evil.example.com' }), 403);
  assert.equal(await call({ 'x-pg-airlock-token': token, origin: 'http://evil.example.com' }), 403);
  assert.equal(await call({ 'x-pg-airlock-token': token }), 200);

  const mode = (await stat(join(stateDir, 'server.json'))).mode & 0o777;
  assert.equal(mode, 0o600);
});

test('every decision lands in the audit journal', async () => {
  const log = await human('log', '-n', '50');
  assert.match(log, /proposed/);
  assert.match(log, /committed/);
  assert.match(log, /rolled_back/);
  assert.match(log, /rejected_statement/);
  assert.match(log, /human-cli/);
});

/**
 * Real end-to-end demo: an MCP client plays the agent, the CLI plays the human.
 * Nothing is mocked. Run with: npm run demo
 */
import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const run = promisify(execFile);
const CLI = resolve('dist/cli.js');
const stateDir = await mkdtemp(join(tmpdir(), 'pg-airlock-demo-'));

const client = new Client({ name: 'demo-agent', version: '1.0.0' });
await client.connect(
  new StdioClientTransport({
    command: process.execPath,
    args: [CLI, 'serve', '--db', 'memory', '--init', resolve('examples/seed.sql'), '--state-dir', stateDir],
    stderr: 'ignore',
  }),
);

const say = (s = '') => process.stdout.write(s + '\n');

async function agent(tool: string, args: Record<string, unknown>) {
  const label = Object.values(args)[0];
  say(`agent> ${tool}  ${typeof label === 'string' ? label : ''}`);
  const res = (await client.callTool({ name: tool, arguments: args })) as {
    isError?: boolean;
    content: Array<{ text: string }>;
  };
  const data = JSON.parse(res.content[0]!.text);
  return { isError: res.isError === true, data };
}

async function human(...args: string[]) {
  say(`you $ pg-airlock ${args.join(' ')}`);
  const { stdout } = await run(process.execPath, [CLI, ...args, '--state-dir', stateDir]);
  say(stdout.trimEnd().split('\n').map((l) => '  ' + l).join('\n'));
  say();
}

const show = (label: string, value: unknown) => say(`  ${label}: ${value}`);

say('--- 1. The agent means to upgrade ONE customer, but forgets the WHERE clause ---');
say();
const bad = await agent('db_execute', { sql: "UPDATE customers SET plan = 'pro'" });
show('status', bad.data.status);
show('risk', bad.data.risk);
show('message', String(bad.data.message).split('. ')[0] + '.');
say();
await human('pending');
await human('rollback', bad.data.changeId, '--reason', '"missing WHERE"');

const after = await agent('db_status', { changeId: bad.data.changeId });
show('status', after.data.status);
show('message', after.data.message);
say();

say('--- 2. The agent corrects itself ---');
say();
const good = await agent('db_execute', { sql: "UPDATE customers SET plan = 'pro' WHERE name = 'Bruno'" });
show('status', good.data.status);
show('risk', good.data.risk);
say();
await human('commit', good.data.changeId, '--yes');
const done = await agent('db_status', { changeId: good.data.changeId });
show('status', done.data.status);
show('message', done.data.message);
say();

say('--- 3. The agent tries to approve its own change ---');
say();
const next = await agent('db_execute', { sql: "DELETE FROM customers WHERE plan = 'free'" });
show('status', next.data.status);
const sneaky = await agent('db_execute', { sql: 'COMMIT' });
show('error', `${sneaky.data.error}: ${sneaky.data.message}`);
const stillPending = await agent('db_status', { changeId: next.data.changeId });
show('status', stillPending.data.status);
say();
await human('rollback', next.data.changeId);

say('--- Audit journal ---');
say();
await human('log', '-n', '20');

await client.close();
await rm(stateDir, { recursive: true, force: true });

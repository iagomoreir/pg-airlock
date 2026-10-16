import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { openDriver } from '../src/drivers.js';
import { Engine } from '../src/engine.js';
import { classify } from '../src/sql.js';
import { AirlockError } from '../src/types.js';

let engine: Engine;

async function setup(opts: ConstructorParameters<typeof Engine>[1] = {}) {
  const driver = await openDriver('memory');
  await driver.query('CREATE TABLE users (id serial PRIMARY KEY, email text NOT NULL, plan text NOT NULL)');
  await driver.query(
    "INSERT INTO users (email, plan) VALUES ('a@x.com','free'), ('b@x.com','free'), ('c@x.com','pro')",
  );
  await driver.query('CREATE TABLE notes (body text)');
  engine = new Engine(driver, opts);
}

beforeEach(() => setup());
afterEach(async () => {
  await engine.close();
});

const plans = async () =>
  (await engine.read('SELECT id, plan FROM users ORDER BY id')).rows.map((r) => `${r['id']}:${r['plan']}`);

test('reads work and cannot write', async () => {
  const r = await engine.read('SELECT count(*)::int AS n FROM users');
  assert.equal(r.rows[0]?.['n'], 3);
  await assert.rejects(engine.read("UPDATE users SET plan='x'"), (e: AirlockError) => e.code === 'not_a_read');
});

test('a write stays pending, shows a diff, and rollback restores the data', async () => {
  const p = await engine.propose("UPDATE users SET plan = 'pro' WHERE id = 1");
  assert.equal(p.status, 'pending');
  assert.equal(p.rowsAffected, 1);
  assert.equal(p.risk, 'low');
  const d = p.diff[0]!;
  assert.equal(d.table, 'users');
  assert.deepEqual(d.keyColumns, ['id']);
  assert.equal(d.updated, 1);
  assert.deepEqual(d.changes[0]?.changedColumns, ['plan']);
  assert.equal(d.changes[0]?.before?.['plan'], 'free');
  assert.equal(d.changes[0]?.after?.['plan'], 'pro');

  // The agent sees its own pending change, flagged as pending.
  const during = await engine.read('SELECT plan FROM users WHERE id = 1');
  assert.equal(during.rows[0]?.['plan'], 'pro');
  assert.equal(during.pendingChangeId, p.id);

  const done = await engine.rollback(p.id, 'tester', 'not what I wanted');
  assert.equal(done.status, 'rolled_back');
  assert.equal(done.resolution, 'rejected');
  assert.deepEqual(await plans(), ['1:free', '2:free', '3:pro']);
  assert.equal((await engine.read('SELECT 1 AS x')).pendingChangeId, undefined);
});

test('commit makes the change permanent', async () => {
  const p = await engine.propose("UPDATE users SET plan = 'pro' WHERE id = 1");
  const done = await engine.commit(p.id, 'tester');
  assert.equal(done.status, 'committed');
  assert.deepEqual(await plans(), ['1:pro', '2:free', '3:pro']);
});

test('insert and delete are reported per row', async () => {
  const ins = await engine.propose("INSERT INTO users (email, plan) VALUES ('d@x.com','free') RETURNING id");
  assert.equal(ins.diff[0]?.inserted, 1);
  assert.equal(ins.returning.length, 1);
  await engine.commit(ins.id);

  const del = await engine.propose("DELETE FROM users WHERE email = 'd@x.com'");
  assert.equal(del.diff[0]?.deleted, 1);
  assert.equal(del.diff[0]?.changes[0]?.op, 'delete');
  await engine.rollback(del.id);
  assert.equal((await engine.read('SELECT count(*)::int AS n FROM users')).rows[0]?.['n'], 4);
});

test('UPDATE/DELETE without WHERE is high risk', async () => {
  const p = await engine.propose("UPDATE users SET plan = 'free'");
  assert.equal(p.risk, 'high');
  assert.equal(p.rowsAffected, 3);
  await engine.rollback(p.id);
  assert.deepEqual(await plans(), ['1:free', '2:free', '3:pro']);
});

test('only one change may be pending at a time', async () => {
  const p = await engine.propose("UPDATE users SET plan = 'pro' WHERE id = 1");
  await assert.rejects(
    engine.propose("UPDATE users SET plan = 'pro' WHERE id = 2"),
    (e: AirlockError) => e.code === 'pending_exists' && e.details?.['pendingChangeId'] === p.id,
  );
  await engine.rollback(p.id);
});

test('a failing write leaves nothing pending and the database untouched', async () => {
  await assert.rejects(engine.propose("UPDATE users SET nope = 1 WHERE id = 1"), (e: AirlockError) => e.code === 'sql_error');
  assert.equal(engine.pending(), null);
  assert.deepEqual(await plans(), ['1:free', '2:free', '3:pro']);
  const p = await engine.propose("UPDATE users SET plan = 'pro' WHERE id = 1");
  await engine.rollback(p.id);
});

test('a failing read during a pending change does not poison it', async () => {
  const p = await engine.propose("UPDATE users SET plan = 'pro' WHERE id = 1");
  await assert.rejects(engine.read('SELECT * FROM missing_table'), (e: AirlockError) => e.code === 'sql_error');
  const done = await engine.commit(p.id);
  assert.equal(done.status, 'committed');
  assert.deepEqual(await plans(), ['1:pro', '2:free', '3:pro']);
});

test('DROP TABLE is high risk, shows all rows deleted, and rollback brings the table back', async () => {
  const p = await engine.propose('DROP TABLE users');
  assert.equal(p.risk, 'high');
  assert.equal(p.diff[0]?.deleted, 3);
  assert.equal(p.diff[0]?.existsAfter, false);
  await engine.rollback(p.id);
  assert.equal((await engine.read('SELECT count(*)::int AS n FROM users')).rows[0]?.['n'], 3);
});

test('CREATE TABLE and ALTER TABLE go through approval too', async () => {
  const c = await engine.propose('CREATE TABLE things (id int PRIMARY KEY)');
  assert.equal(c.kind, 'ddl');
  assert.equal(c.diff[0]?.existedBefore, false);
  assert.equal(c.diff[0]?.existsAfter, true);
  await engine.rollback(c.id);
  await assert.rejects(engine.read('SELECT * FROM things'), (e: AirlockError) => e.code === 'sql_error');
});

test('data-modifying CTEs are treated as writes', async () => {
  await assert.rejects(
    engine.read("WITH x AS (DELETE FROM users RETURNING *) SELECT * FROM x"),
    (e: AirlockError) => e.code === 'not_a_read',
  );
  const p = await engine.propose('WITH x AS (DELETE FROM users WHERE id = 1 RETURNING *) SELECT * FROM x');
  assert.equal(p.diff[0]?.deleted, 1);
  await engine.rollback(p.id);
});

test('transaction control and other escape hatches are blocked', async () => {
  for (const sql of [
    'COMMIT',
    'ROLLBACK',
    'BEGIN',
    'SAVEPOINT x',
    "SET statement_timeout = 0",
    "COPY users TO '/tmp/x'",
    "DO $$ BEGIN PERFORM 1; COMMIT; END $$",
    "SELECT 1; COMMIT",
    "SELECT 1; DROP TABLE users",
    "SELECT * INTO newtable FROM users",
    "SELECT pg_read_file('/etc/passwd')",
    'EXPLAIN ANALYZE DELETE FROM users',
  ]) {
    await assert.rejects(engine.propose(sql), (e: AirlockError) => e.code === 'blocked', sql);
    await assert.rejects(engine.read(sql), (e: AirlockError) => e.code === 'blocked', sql);
  }
  assert.equal(engine.pending(), null);
  assert.deepEqual(await plans(), ['1:free', '2:free', '3:pro']);
});

test('literals and comments cannot hide a second statement', () => {
  assert.equal(classify("SELECT 'a;b'").kind, 'read');
  assert.equal(classify("SELECT 1 -- ; DROP TABLE x").kind, 'read');
  assert.equal(classify("SELECT 1 /* ; DROP TABLE x */").kind, 'read');
  assert.equal(classify("SELECT 'a\\'; DROP TABLE x; --'").kind, 'blocked');
  assert.equal(classify("SELECT E'a\\'; DROP TABLE x; --'").kind, 'read');
  assert.equal(classify('SELECT $$;$$').kind, 'read');
  assert.equal(classify('DELETE FROM users;').kind, 'write');
});

test('ON CONFLICT DO UPDATE does not add a bogus table', () => {
  const c = classify("INSERT INTO users (id, email, plan) VALUES (1,'a','b') ON CONFLICT (id) DO UPDATE SET plan = 'x'");
  assert.deepEqual(c.tables, ['users']);
});

test('pending changes expire and roll back by themselves', async () => {
  await engine.close();
  await setup({ ttlMs: 50 });
  const p = await engine.propose("UPDATE users SET plan = 'pro' WHERE id = 1");
  await new Promise((r) => setTimeout(r, 200));
  const after = engine.get(p.id)!;
  assert.equal(after.status, 'rolled_back');
  assert.equal(after.resolution, 'expired');
  assert.deepEqual(await plans(), ['1:free', '2:free', '3:pro']);
});

test('resolving twice or resolving an unknown id fails clearly', async () => {
  const p = await engine.propose("UPDATE users SET plan = 'pro' WHERE id = 1");
  await engine.commit(p.id);
  await assert.rejects(engine.commit(p.id), (e: AirlockError) => e.code === 'already_resolved');
  await assert.rejects(engine.rollback('chg_nope'), (e: AirlockError) => e.code === 'not_found');
});

test('large tables fall back to a counts-only diff', async () => {
  await engine.close();
  await setup({ maxSnapshotRows: 2 });
  const p = await engine.propose("DELETE FROM users WHERE id = 1");
  assert.equal(p.diff[0]?.rowLevel, false);
  assert.equal(p.diff[0]?.deleted, 1);
  assert.equal(p.risk, 'high');
  assert.ok(p.warnings.some((w) => w.includes('only row counts')));
  await engine.rollback(p.id);
});

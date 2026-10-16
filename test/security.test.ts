import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { openDriver, type Driver } from '../src/drivers.js';
import { Engine, type EngineOptions } from '../src/engine.js';
import { classify } from '../src/sql.js';
import { AirlockError } from '../src/types.js';

let driver: Driver;
let engine: Engine;

async function setup(opts: EngineOptions = {}) {
  driver = await openDriver('memory');
  await driver.exec(`
    CREATE TABLE users (id serial PRIMARY KEY, email text NOT NULL, plan text NOT NULL);
    INSERT INTO users (email, plan) VALUES ('a@x.com','free'), ('b@x.com','free');
    CREATE TABLE notes (body text);
    CREATE SEQUENCE counter;
    -- A perfectly ordinary VOLATILE helper that writes. Exactly what an RPC function in Supabase looks like.
    CREATE FUNCTION sneaky() RETURNS int LANGUAGE sql VOLATILE AS $$
      INSERT INTO notes (body) VALUES ('written by a SELECT') RETURNING 1
    $$;
    CREATE VIEW innocent AS SELECT id, sneaky() AS s FROM users;
  `);
  engine = new Engine(driver, opts);
}

beforeEach(() => setup());
afterEach(async () => {
  await engine.close();
});

const notesCount = async () =>
  (await engine.read('SELECT count(*)::int AS n FROM notes')).rows[0]?.['n'];

test('a SELECT calling a writing function cannot smuggle data into a pending change', async () => {
  const p = await engine.propose("UPDATE users SET plan = 'pro' WHERE id = 1");

  await assert.rejects(engine.read('SELECT sneaky()'), (e: AirlockError) => e.code === 'sql_error');
  await assert.rejects(engine.read('SELECT * FROM innocent'), (e: AirlockError) => e.code === 'sql_error');
  await assert.rejects(engine.read('VALUES (sneaky())'), (e: AirlockError) => e.code === 'sql_error');

  // The human approves the change they were shown. Nothing else may come along.
  await engine.commit(p.id);
  assert.equal(await notesCount(), 0);
});

test('reads never leave anything behind, even ones that succeed while a change is pending', async () => {
  const p = await engine.propose("UPDATE users SET plan = 'pro' WHERE id = 1");
  await assert.rejects(engine.read("SELECT nextval('counter')"), (e: AirlockError) => e.code === 'sql_error');
  await engine.commit(p.id);
  const next = await driver.query("SELECT is_called FROM counter");
  assert.equal(next.rows[0]?.['is_called'], false);
});

test('EXPLAIN ANALYSE (British spelling) and option forms are blocked like EXPLAIN ANALYZE', async () => {
  for (const sql of [
    'EXPLAIN ANALYSE DELETE FROM users',
    'explain analyse delete from users',
    'EXPLAIN (ANALYSE) DELETE FROM users',
    'EXPLAIN (ANALYZE true) DELETE FROM users',
    'EXPLAIN (ANALYSE, VERBOSE) DELETE FROM users',
    'EXPLAIN (FORMAT JSON, ANALYZE) DELETE FROM users',
    'EXPLAIN\nANALYZE\nDELETE FROM users',
  ]) {
    assert.equal(classify(sql).kind, 'blocked', sql);
  }
  assert.equal(classify('EXPLAIN SELECT * FROM users').kind, 'read');
  assert.equal(classify('EXPLAIN (FORMAT JSON) SELECT * FROM users').kind, 'read');
});

test('EXPLAIN ANALYSE cannot delete data while a change is pending', async () => {
  const p = await engine.propose("UPDATE users SET plan = 'pro' WHERE id = 1");
  await assert.rejects(engine.read('EXPLAIN ANALYSE DELETE FROM users'), (e: AirlockError) => e.code === 'blocked');
  await engine.commit(p.id);
  assert.equal((await engine.read('SELECT count(*)::int AS n FROM users')).rows[0]?.['n'], 2);
});

test('functions with effects outside the data model are denied, in any case', () => {
  for (const sql of [
    "SELECT pg_notify('chan','payload')",
    "SELECT PG_NOTIFY('chan','payload')",
    "VALUES (pg_notify('chan','payload'))",
    'SELECT pg_try_advisory_lock(1)',
    'SELECT pg_try_advisory_xact_lock(1)',
    'SELECT pg_advisory_lock(1)',
    'SELECT pg_advisory_unlock(1)',
    'SELECT pg_advisory_unlock_all()',
    'SELECT pg_sleep(60)',
    "SELECT pg_read_file('/etc/passwd')",
    "SELECT PG_READ_FILE('/etc/passwd')",
    "SELECT set_config('transaction_read_only','off',true)",
    'SELECT pg_terminate_backend(1)',
  ]) {
    assert.equal(classify(sql).kind, 'blocked', sql);
  }
});

test('a hostile table name cannot break out of the snapshot queries', async () => {
  await driver.exec(`CREATE TABLE "we ird; DROP TABLE users; --" (id int PRIMARY KEY, v int); INSERT INTO "we ird; DROP TABLE users; --" VALUES (1, 1);`);
  const p = await engine.propose(`UPDATE "we ird; DROP TABLE users; --" SET v = 2 WHERE id = 1`);
  assert.equal(p.diff[0]?.updated, 1);
  assert.equal(p.diff[0]?.table, '"we ird; DROP TABLE users; --"');
  await engine.rollback(p.id);
  assert.equal((await engine.read('SELECT count(*)::int AS n FROM users')).rows[0]?.['n'], 2);
});

test('a read made while a change is pending sees that change, and the change survives the read', async () => {
  const p = await engine.propose("UPDATE users SET plan = 'pro' WHERE id = 1");
  const r1 = await engine.read('SELECT plan FROM users WHERE id = 1');
  const r2 = await engine.read('SELECT plan FROM users WHERE id = 1');
  assert.equal(r1.rows[0]?.['plan'], 'pro');
  assert.equal(r2.rows[0]?.['plan'], 'pro');
  assert.equal(r1.pendingChangeId, p.id);
  await engine.commit(p.id);
  assert.equal((await engine.read('SELECT plan FROM users WHERE id = 1')).rows[0]?.['plan'], 'pro');
});

test('triggers and cascading foreign keys that can touch tables outside the diff are flagged', async () => {
  await driver.exec(`
    CREATE TABLE audit (id serial PRIMARY KEY, body text);
    CREATE FUNCTION trg() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN INSERT INTO audit(body) VALUES ('via trigger'); RETURN NEW; END $$;
    CREATE TRIGGER t AFTER UPDATE ON users FOR EACH ROW EXECUTE FUNCTION trg();
    CREATE TABLE orders (id int PRIMARY KEY, user_id int REFERENCES users(id) ON DELETE CASCADE);
  `);
  const p = await engine.propose("UPDATE users SET plan = 'pro' WHERE id = 1");
  assert.ok(p.warnings.some((w) => /has triggers/.test(w)), p.warnings.join('|'));
  assert.ok(p.warnings.some((w) => /cascading foreign keys/.test(w)));
  assert.notEqual(p.risk, 'low');
  assert.deepEqual(p.diff.map((d) => d.table), ['users']);
  await engine.rollback(p.id);
});

test('a wrapper function around pg_notify queues nothing that survives a read', async () => {
  // The notification is queued inside the read's savepoint and discarded with it (verified on Postgres 16).
  await driver.exec(`CREATE FUNCTION wrap() RETURNS int LANGUAGE sql AS $$ SELECT 1 FROM (SELECT pg_notify('c','x')) s $$;`);
  const p = await engine.propose("UPDATE users SET plan = 'pro' WHERE id = 1");
  await engine.read('SELECT wrap()');
  await engine.commit(p.id);
});

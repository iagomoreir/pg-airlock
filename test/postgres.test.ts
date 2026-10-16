import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { openDriver } from '../src/drivers.js';
import { Engine } from '../src/engine.js';
import { AirlockError } from '../src/types.js';

// Runs only against a real Postgres: PG_AIRLOCK_TEST_PG=postgres://user@host:port/db npm test
const url = process.env['PG_AIRLOCK_TEST_PG'];
const opts = { skip: url ? false : 'set PG_AIRLOCK_TEST_PG to run against a real Postgres' };

const tag = randomBytes(3).toString('hex');
const T = `au_${tag}_accounts`;
const SEQ = `au_${tag}_seq`;

let engine: Engine;
let observer: pg.Client;

before(async () => {
  if (!url) return;
  observer = new pg.Client({ connectionString: url });
  await observer.connect();
  await observer.query(
    `CREATE TABLE ${T} (id bigserial PRIMARY KEY, owner text NOT NULL, balance numeric(12,2) NOT NULL, meta jsonb, created timestamptz DEFAULT now())`,
  );
  await observer.query(`CREATE SEQUENCE ${SEQ}`);
  await observer.query(
    `INSERT INTO ${T} (owner, balance, meta) VALUES ('ana', 100.50, '{"tier":"gold"}'), ('bruno', 20, NULL), ('carla', 0, '{}')`,
  );
  engine = new Engine(await openDriver(url));
});

after(async () => {
  if (!url) return;
  await engine.close();
  await observer.query(`DROP TABLE IF EXISTS ${T}; DROP SEQUENCE IF EXISTS ${SEQ};`);
  await observer.end();
});

const observed = async () =>
  (await observer.query(`SELECT owner, balance::text AS balance FROM ${T} ORDER BY id`)).rows
    .map((r) => `${r.owner}:${r.balance}`)
    .join(',');

test('a pending change is invisible to every other connection until it is committed', opts, async () => {
  const p = await engine.propose(`UPDATE ${T} SET balance = balance + 50 WHERE owner = 'bruno'`);
  assert.equal(p.status, 'pending');
  assert.equal(p.rowsAffected, 1);
  assert.equal(p.risk, 'low');

  // The agent's own connection sees it; an independent connection does not.
  const mine = await engine.read(`SELECT balance::text AS b FROM ${T} WHERE owner = 'bruno'`);
  assert.equal(mine.rows[0]?.['b'], '70.00');
  assert.equal(await observed(), 'ana:100.50,bruno:20.00,carla:0.00');

  await engine.commit(p.id);
  assert.equal(await observed(), 'ana:100.50,bruno:70.00,carla:0.00');
});

test('rollback leaves no trace, and the diff handles bigint, numeric and jsonb', opts, async () => {
  const before = await observed();
  const p = await engine.propose(`UPDATE ${T} SET balance = 0, meta = '{"tier":"none"}' WHERE owner = 'ana'`);
  const d = p.diff[0]!;
  assert.deepEqual(d.keyColumns, ['id']);
  assert.equal(d.updated, 1);
  assert.deepEqual([...(d.changes[0]?.changedColumns ?? [])].sort(), ['balance', 'meta']);
  assert.deepEqual(d.changes[0]?.before?.['meta'], { tier: 'gold' });
  assert.deepEqual(d.changes[0]?.after?.['meta'], { tier: 'none' });
  await engine.rollback(p.id);
  assert.equal(await observed(), before);
});

test('a destructive statement is flagged and fully reversible, including DROP TABLE', opts, async () => {
  const del = await engine.propose(`DELETE FROM ${T}`);
  assert.equal(del.risk, 'high');
  assert.equal(del.diff[0]?.deleted, 3);
  assert.equal((await observer.query(`SELECT count(*)::int AS n FROM ${T}`)).rows[0].n, 3);
  await engine.rollback(del.id);

  const drop = await engine.propose(`DROP TABLE ${T}`);
  assert.equal(drop.risk, 'high');
  assert.equal(drop.diff[0]?.existsAfter, false);
  assert.equal(drop.diff[0]?.deleted, 3);
  await engine.rollback(drop.id);
  assert.equal((await observer.query(`SELECT count(*)::int AS n FROM ${T}`)).rows[0].n, 3);
});

test('reads cannot sneak in side effects: Postgres itself enforces READ ONLY', opts, async () => {
  await assert.rejects(
    engine.read(`SELECT nextval('${SEQ}')`),
    (e: AirlockError) => e.code === 'sql_error' && /read-only/i.test(e.message),
  );
  assert.equal((await observer.query(`SELECT is_called FROM ${SEQ}`)).rows[0].is_called, false);
});

test('expired approval releases locks held by the pending transaction', opts, async () => {
  await engine.close();
  engine = new Engine(await openDriver(url!), { ttlMs: 100 });
  const p = await engine.propose(`UPDATE ${T} SET balance = 1 WHERE owner = 'carla'`);
  assert.equal(p.status, 'pending');

  // While pending, the row is locked for other writers...
  await observer.query('BEGIN');
  await observer.query(`SET LOCAL lock_timeout = '50ms'`);
  await assert.rejects(observer.query(`UPDATE ${T} SET balance = 2 WHERE owner = 'carla'`), /lock timeout/);
  await observer.query('ROLLBACK');

  // ...and the TTL gives the lock back.
  await new Promise((r) => setTimeout(r, 400));
  assert.equal(engine.get(p.id)?.resolution, 'expired');
  await observer.query(`UPDATE ${T} SET balance = 2 WHERE owner = 'carla'`);
  assert.equal(await observed(), 'ana:100.50,bruno:70.00,carla:2.00');
});

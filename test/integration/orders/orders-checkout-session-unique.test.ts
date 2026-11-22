// Integration tests of "one order per checkout session" as a database rule (decision 048): the unique index orders_checkout_session_uq
// (orders without a session are not limited), and the check of its migration, which stops and names the sessions when rows break the rule.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { type Database } from '@src/infra/db';
import { type TestApp, createTestApp } from '../../support/app';
import { B2cGateway, b2cWorld, paidOrder } from '../../support/b2c';
import { GatewayTestModule } from '../../support/billing';
import { TestClock } from '../../support/clock';
import { closeTestDb, pgErrorOf, resetDb, testDb } from '../../support/db';
import { insertOrderRow, orderRow } from '../../support/orders';

const clock = new TestClock('2026-11-21T12:00:00.000Z');
const fake = new B2cGateway();
let t: TestApp;
let db: Database;

beforeAll(async () => {
  ({ db } = await testDb());
  t = await createTestApp({ clock, imports: [GatewayTestModule] });
});
afterAll(async () => {
  await fake.stop();
  await resetDb();
  await t.close();
  await closeTestDb();
});
beforeEach(async () => {
  clock.set('2026-11-21T12:00:00.000Z');
  fake.reset();
  await resetDb();
});

/** The check block of the migration, between its markers. */
function migrationCheck(): string {
  const dir = join(import.meta.dir, '../../../drizzle');
  const name = readdirSync(dir).find((file) => file.endsWith('_payments_integrity.sql'));
  if (!name) throw new Error('The payments integrity migration is missing.');
  const text = readFileSync(join(dir, name), 'utf8');
  const begin = text.indexOf('-- check:begin');
  const end = text.indexOf('-- check:end');
  expect(begin).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(begin);
  return text.slice(begin, end);
}

describe('one order per checkout session (decision 048)', () => {
  it('a second order with the checkout session of another order is refused by orders_checkout_session_uq', async () => {
    const world = await b2cWorld(t, db, fake);
    const paid = await paidOrder(t, clock, world);
    const first = await orderRow(db, paid.orderId);
    expect(first.checkoutSessionId).not.toBeNull();
    // A copy with explicit columns: its own id, no public token of any kind, the same checkout session.
    const error = await pgErrorOf(
      insertOrderRow(db, {
        serviceId: first.serviceId,
        customerId: first.customerId,
        source: 'store',
        currency: first.currency,
        checkoutSessionId: first.checkoutSessionId,
      }),
    );
    expect(error).toMatchObject({ code: '23505', constraint: 'orders_checkout_session_uq' });
    // Orders without a checkout session are not limited.
    for (let i = 0; i < 2; i += 1) {
      await insertOrderRow(db, { serviceId: first.serviceId, customerId: first.customerId, source: 'store' });
    }
  });

  it("the migration's check names the duplicated sessions", async () => {
    const check = migrationCheck();
    const { pool } = await testDb();
    const client = await pool.connect();
    try {
      await client.query('begin');
      // A table of the same name in this session's own schema: the shared test database's orders are never touched.
      await client.query('create temp table orders (checkout_session_id bigint) on commit drop');
      await client.query('insert into orders (checkout_session_id) values (7), (7), (9), (11), (11), (null), (null)');
      const failure = await client.query(check).then(
        () => undefined,
        (error: unknown) => error as Error,
      );
      expect(failure?.message).toBe(
        'orders_checkout_session_uq: checkout sessions with more than one order: 7, 11. Keep the order each session names ' +
          '(checkout_sessions.order_id), clear checkout_session_id on the other orders, then migrate again (docs/OPERATIONS.md).',
      );
      await client.query('rollback');
      await client.query('begin');
      await client.query('create temp table orders (checkout_session_id bigint) on commit drop');
      await client.query('insert into orders (checkout_session_id) values (7), (9), (null), (null)');
      // Data that keeps the rule passes the check.
      await client.query(check);
    } finally {
      await client.query('rollback').catch(() => undefined);
      client.release();
    }
  });
});

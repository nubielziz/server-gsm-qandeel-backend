// Integration tests of the orders participant of the guest-order claim (decision 064): the store orders of the guest row move to the account
// that proved the mailbox; nothing else moves; a row another request holds makes the participant stop at once (SQLSTATE 55P03), never wait.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { asc, eq } from 'drizzle-orm';
import { schema as s } from '@src/infra/db';
import { GuestClaimParticipants, ORDERS_PARTICIPANT } from '@src/modules/identity';
import { OrdersGuestClaimParticipant } from '@src/modules/orders/application/guest-claim.participant';
import { type TestApp, createTestApp } from '../../support/app';
import { clearIdentityCaches } from '../../support/auth';
import { closeTestDb, pgErrorOf, resetDb, testDb } from '../../support/db';
import { IMEIS, insertOrderRow, type OrdersWorld, ordersWorld } from '../../support/orders';
import { makeCustomer } from '../../support/store';

let t: TestApp;
let world: OrdersWorld;

beforeAll(async () => {
  t = await createTestApp();
});
beforeEach(async () => {
  await resetDb();
  await clearIdentityCaches(t);
  world = await ordersWorld((await testDb()).db);
});
afterAll(async () => {
  await resetDb();
  await clearIdentityCaches(t);
  await t.close();
  await closeTestDb();
});

const participant = () => t.app.get(OrdersGuestClaimParticipant, { strict: false });

/** A guest row with two shop orders, a retail account that proved the mailbox, and a merchant order that must stay where it is. */
async function claimWorld() {
  const { db, merchant, auto } = world;
  const guest = await makeCustomer(t, { guest: true, email: 'sam@example.com', name: 'Sam Buyer' });
  const account = await makeCustomer(t, { email: 'sam@example.com', name: 'Sam Buyer' });
  const first = await insertOrderRow(db, {
    accountId: guest.id,
    serviceId: auto.serviceId,
    source: 'store',
    imei: IMEIS[0],
  });
  const second = await insertOrderRow(db, {
    accountId: guest.id,
    serviceId: auto.serviceId,
    source: 'store',
    imei: IMEIS[1],
  });
  const merchants = await insertOrderRow(db, { accountId: merchant.id, serviceId: auto.serviceId, imei: IMEIS[2] });
  return { guest, account, first, second, merchants };
}

describe('the orders participant of the guest claim', () => {
  it('is registered as the orders participant, so its count is the claimedOrders of the answer', () => {
    expect(t.app.get(GuestClaimParticipants, { strict: false }).names()).toContain(ORDERS_PARTICIPANT);
  });

  it("moves the guest row's store orders to the account and leaves every other order alone", async () => {
    const { db, merchant } = world;
    const { guest, account, first, second, merchants } = await claimWorld();
    const moved = await db.transaction((tx) => participant().move(tx, { guestId: guest.id, accountId: account.id }));
    expect(moved).toBe(2);
    const rows = await db.select().from(s.orders).orderBy(s.orders.id);
    expect(rows.map((row) => [row.id, row.accountId])).toEqual([
      [first.id, account.id],
      [second.id, account.id],
      [merchants.id, merchant.id],
    ]);
    // The door and the rest of the order are untouched: the orders are still shop orders.
    expect(rows.slice(0, 2).every((row) => row.source === 'store' && row.legacyClientId === null)).toBe(true);
    // A second claim finds nothing left to move.
    expect(await db.transaction((tx) => participant().move(tx, { guestId: guest.id, accountId: account.id }))).toBe(0);
  });

  it('moves nothing for a guest row without orders', async () => {
    const { db } = world;
    const { account } = await claimWorld();
    const lonely = await makeCustomer(t, { guest: true, email: 'nobody@example.com' });
    expect(await db.transaction((tx) => participant().move(tx, { guestId: lonely.id, accountId: account.id }))).toBe(0);
  });

  it('stops at once with the lock error when another request holds one of the orders, and moves nothing', async () => {
    const { db } = world;
    const { guest, account, first, second } = await claimWorld();
    const { pool } = await testDb();
    const holder = await pool.connect();
    try {
      await holder.query('begin');
      await holder.query('select id from orders where id = $1 for update', [second.id]);
      const error = await pgErrorOf(
        db.transaction((tx) => participant().move(tx, { guestId: guest.id, accountId: account.id })),
      );
      // 55P03 is lock_not_available: the claim catches it and answers busy instead of waiting.
      expect(error.code).toBe('55P03');
    } finally {
      await holder.query('rollback');
      holder.release();
    }
    const rows = await db.select().from(s.orders).where(eq(s.orders.accountId, guest.id)).orderBy(asc(s.orders.id));
    expect(rows.map((row) => row.id)).toEqual([first.id, second.id]);
  });
});

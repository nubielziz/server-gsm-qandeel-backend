// Integration tests of the order reads over the one account type (decision 064): the staff list and detail name the buyer
// `account` with its rank whatever the door, filter by `accountId` (`clientId` is its alias) and `rankId` and refuse `customerId`, mask the
// address unless the caller may read accounts, resolve the old actors of the timeline through the map of old numbers, and the account's own
// reads (the portal, the dashboard, cancel, verify and Dhru) see the merchant doors only, never the account's own shop order.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { eq, sql } from 'drizzle-orm';
import { type Database, schema as s } from '@src/infra/db';
import { ShopOrders } from '@src/modules/orders';
import { CURRENT_ORDER_EVENT_ACTOR_TYPES } from '@src/modules/orders/db/schema';
import { type AdminApi, adminWith } from '../../support/admin-api';
import { accountRow } from '../../support/accounts';
import { type TestApp, createTestApp } from '../../support/app';
import { clearIdentityCaches } from '../../support/auth';
import { TestClock } from '../../support/clock';
import { closeTestDb, resetDb, testDb } from '../../support/db';
import { mapLegacyClient, mapLegacyCustomer } from '../../support/legacy-accounts';
import { clearApiKeyCaches, credentialsFor, dhruClient } from '../../support/machine-orders';
import { IMEIS, eventsOf, insertOrderRow, json, type OrdersWorld, ordersWorld, portalFor } from '../../support/orders';
import { makeCustomer } from '../../support/store';

const clock = new TestClock();
let t: TestApp;
let world: OrdersWorld;
let staff: AdminApi;

beforeAll(async () => {
  t = await createTestApp({ clock });
});
beforeEach(async () => {
  await resetDb();
  await clearIdentityCaches(t);
  await clearApiKeyCaches(t);
  world = await ordersWorld((await testDb()).db);
  // clients:read shows the address in full (decision 047); a role without it reads it masked.
  staff = await adminWith(t, ['orders:*', 'clients:read']);
});
afterAll(async () => {
  await resetDb();
  await clearIdentityCaches(t);
  await t.close();
  await closeTestDb();
});

/** The rank an account holds now, as the console reads it. */
async function rankOf(
  db: Database,
  accountId: number,
): Promise<{ id: number; name: string; kind: 'merchant' | 'retail' }> {
  const [row] = await db
    .select({ id: s.clientGroups.id, name: s.clientGroups.name, kind: s.clientGroups.kind })
    .from(s.clients)
    .innerJoin(s.clientGroups, eq(s.clientGroups.id, s.clients.groupId))
    .where(eq(s.clients.id, accountId));
  return { id: row!.id, name: row!.name, kind: row!.kind === 'b2b' ? 'merchant' : 'retail' };
}

/** The ids of a list answer. */
const idsOf = (rows: Array<{ id: number }>): number[] => rows.map((row) => row.id);

/**
 * Three orders: a portal order of the merchant (the merchant door), a shop order of a guest, and a shop order of the same merchant account
 * (paid first in the shop, as it did when it held the retail rank).
 */
async function threeOrders() {
  const { db, merchant, auto } = world;
  const guest = await makeCustomer(t, { guest: true, email: 'sam@example.com', name: 'Sam Buyer' });
  const portal = await insertOrderRow(db, { accountId: merchant.id, serviceId: auto.serviceId, imei: IMEIS[0] });
  const shopOfGuest = await insertOrderRow(db, {
    accountId: guest.id,
    serviceId: auto.serviceId,
    imei: IMEIS[1],
    source: 'store',
  });
  const shopOfMerchant = await insertOrderRow(db, {
    accountId: merchant.id,
    serviceId: auto.serviceId,
    imei: IMEIS[2],
    source: 'store',
  });
  return { guest, portal, shopOfGuest, shopOfMerchant };
}

describe('GET /admin/orders: the buyer account', () => {
  it('names the account with its rank on every row, whatever the door, and carries no client or customer key', async () => {
    const { db, merchant } = world;
    const { guest, portal, shopOfGuest, shopOfMerchant } = await threeOrders();
    const res = await staff.get('/admin/orders?_sort=id&_order=asc');
    expect(res.status).toBe(200);
    expect(idsOf(res.body)).toEqual([portal.id, shopOfGuest.id, shopOfMerchant.id]);
    const merchantRank = await rankOf(db, merchant.id);
    const merchantRow = await accountRow(merchant.id);
    expect(res.body[0]).toMatchObject({
      channel: 'b2b',
      source: 'portal',
      account: { id: merchant.id, name: 'Cairo GSM Lab', email: merchantRow.email, rank: merchantRank, guest: false },
    });
    expect(res.body[1]).toMatchObject({
      channel: 'b2c',
      source: 'store',
      account: {
        id: guest.id,
        name: 'Sam Buyer',
        email: 'sam@example.com',
        rank: await rankOf(db, guest.id),
        guest: true,
      },
    });
    expect(res.body[1].account.rank.kind).toBe('retail');
    // The shop order of a merchant account stays a shop order: the door tells the channel, the rank is the buyer's rank today.
    expect(res.body[2]).toMatchObject({ channel: 'b2c', account: { id: merchant.id, rank: { kind: 'merchant' } } });
    for (const row of res.body) {
      expect(Object.keys(row)).not.toContain('client');
      expect(Object.keys(row)).not.toContain('customer');
    }
    const one = await staff.get(`/admin/orders/${shopOfGuest.id}`);
    expect(one.body.account).toEqual(res.body[1].account);
  });

  it("masks the account's address for a caller without clients:read and shows it in full with it", async () => {
    const { merchant } = world;
    await threeOrders();
    const email = (await accountRow(merchant.id)).email;
    const masked = await adminWith(t, ['orders:read']);
    const maskedRows = (await masked.get('/admin/orders?_sort=id&_order=asc')).body as Array<{
      account: { email: string };
    }>;
    expect(maskedRows[0]!.account.email).toMatch(/^.{2}•••@/);
    expect(maskedRows[0]!.account.email).not.toBe(email);
    expect(maskedRows[1]!.account.email).toBe('sa•••@example.com');
    const full = (await staff.get('/admin/orders?_sort=id&_order=asc')).body as Array<{ account: { email: string } }>;
    expect(full[0]!.account.email).toBe(email);
    expect(full[1]!.account.email).toBe('sam@example.com');
  });

  it("filters by accountId on both doors, by its alias clientId, by the buyer's rank, and refuses customerId with 422", async () => {
    const { db, merchant } = world;
    const { guest, portal, shopOfGuest, shopOfMerchant } = await threeOrders();
    const get = async (query: string) => idsOf((await staff.get(`/admin/orders?${query}&_sort=id&_order=asc`)).body);
    // Both channels of the merchant account.
    expect(await get(`accountId=${merchant.id}`)).toEqual([portal.id, shopOfMerchant.id]);
    expect(await get(`clientId=${merchant.id}`)).toEqual([portal.id, shopOfMerchant.id]);
    expect(await get(`accountId=${guest.id}`)).toEqual([shopOfGuest.id]);
    expect(await get(`rankId=${(await rankOf(db, guest.id)).id}`)).toEqual([shopOfGuest.id]);
    expect(await get(`rankId=${(await rankOf(db, merchant.id)).id}`)).toEqual([portal.id, shopOfMerchant.id]);
    expect(await get('channel=b2c')).toEqual([shopOfGuest.id, shopOfMerchant.id]);
    // An old customer number is not an account number: it is not a filter any more.
    const refused = await staff.get(`/admin/orders?customerId=${guest.id}`);
    expect(refused.status).toBe(422);
    expect((await staff.get(`/admin/orders/export?customerId=${guest.id}`)).status).toBe(422);
  });

  it("searches the account's name and never its address", async () => {
    const { shopOfGuest } = await threeOrders();
    const found = await staff.get('/admin/orders?q=Sam%20Buyer');
    expect(idsOf(found.body)).toEqual([shopOfGuest.id]);
    expect(found.total).toBe(1);
    // The address is not searched: a search by address would leak it to a caller who only sees it masked.
    const byAddress = await staff.get('/admin/orders?q=sam%40example.com');
    expect(byAddress.body).toEqual([]);
    expect(byAddress.total).toBe(0);
  });
});

describe('GET /admin/orders/:id/events: the account of the actor', () => {
  /**
   * Inserts an order event written before the accounts merged. The new rows are held to the current words by a NOT VALID check, so the
   * check is dropped and put back inside one transaction, the way the old rows came to be.
   */
  async function insertOldEvent(orderId: number, actorType: 'client' | 'customer', actorId: number): Promise<void> {
    const { db } = await testDb();
    await db.transaction(async (tx) => {
      await tx.execute(sql`alter table order_events drop constraint order_events_actor_type_current_check`);
      await tx
        .insert(s.orderEvents)
        .values({ orderId, type: 'note', actorType, actorId, data: { message: 'An old note' } });
      await tx.execute(
        sql.raw(
          `alter table order_events add constraint order_events_actor_type_current_check check (actor_type in (${CURRENT_ORDER_EVENT_ACTOR_TYPES.map((word) => `'${word}'`).join(', ')})) not valid`,
        ),
      );
    });
  }

  it('names the account an account actor is, and nobody for the system', async () => {
    const { merchant, auto } = world;
    const placed = await (
      await portalFor(t, merchant.id)
    ).post('/client/orders', { serviceId: auto.serviceId, imei: IMEIS[0] });
    expect(placed.statusCode).toBe(201);
    const id = json(placed).orders[0].id as number;
    const events = (await staff.get(`/admin/orders/${id}/events`)).body as Array<{
      type: string;
      actor: { type: string; id: number | null; name: string | null };
      account: { id: number } | null;
    }>;
    expect(events[0]).toMatchObject({
      type: 'created',
      actor: { type: 'account', id: merchant.id, name: 'Cairo GSM Lab' },
      account: { id: merchant.id },
    });
    expect(events[1]).toMatchObject({ type: 'hold', actor: { type: 'system' }, account: null });
    expect((await eventsOf(world.db, id))[0]!.actorType).toBe('account');
  });

  it('resolves an old client row to the same account and an old customer row through the map, never to the account of the same number', async () => {
    const { db, merchant, auto } = world;
    const buyer = await makeCustomer(t, { name: 'Daniel Whitmore' });
    const order = await insertOrderRow(db, { accountId: buyer.id, serviceId: auto.serviceId, source: 'store' });
    // The buyer's old customer number is, on purpose, the same number as the merchant's account number: reading it as an account id would
    // name the merchant. The map says it is the buyer.
    await mapLegacyCustomer(db, merchant.id, buyer.id);
    await mapLegacyClient(db, merchant.id);
    await insertOldEvent(order.id, 'customer', merchant.id);
    await insertOldEvent(order.id, 'client', merchant.id);
    await insertOldEvent(order.id, 'customer', 987_654);
    const events = (await staff.get(`/admin/orders/${order.id}/events`)).body as Array<{
      actor: { type: string; id: number | null; name: string | null };
      account: { id: number } | null;
    }>;
    // The old customer number equals the merchant's account number on purpose: it must read as the buyer, not as the merchant.
    expect(events[0]).toMatchObject({
      actor: { type: 'customer', id: merchant.id, name: 'Daniel Whitmore' },
      account: { id: buyer.id },
    });
    expect(events[1]).toMatchObject({
      actor: { type: 'client', id: merchant.id, name: 'Cairo GSM Lab' },
      account: { id: merchant.id },
    });
    // A number the map does not know is an unknown actor, never another person.
    expect(events[2]).toMatchObject({ actor: { type: 'customer', id: 987_654, name: null }, account: null });
  });
});

describe('the account reads its own orders of the merchant doors only', () => {
  it("lists, shows and counts the portal order, and leaves out the account's own shop order", async () => {
    const { merchant } = world;
    const { portal, shopOfMerchant } = await threeOrders();
    const me = await portalFor(t, merchant.id);
    const list = await me.get('/client/orders');
    expect(list.statusCode).toBe(200);
    expect(idsOf(json(list))).toEqual([portal.id]);
    expect(list.headers['x-total-count']).toBe('1');
    expect((await me.get(`/client/orders/${portal.id}`)).statusCode).toBe(200);
    expect((await me.get(`/client/orders/${shopOfMerchant.id}`)).statusCode).toBe(404);
    const dashboard = json(await me.get('/client/dashboard'));
    expect(dashboard.counts).toEqual({ pending: 1, processing: 0, completed: 0, rejected: 0 });
    expect(dashboard.openOrders).toBe(1);
    expect(idsOf(dashboard.latestOrders)).toEqual([portal.id]);
    const exported = await t.app.inject({ method: 'GET', url: '/client/orders/export', headers: me.session.headers });
    expect(exported.body.split('\r\n').filter(Boolean)).toHaveLength(2);
  });

  it("answers 404 to a cancel or a verification of the account's own shop order and writes no refund, no event and no money", async () => {
    const { db, merchant, auto } = world;
    await db.update(s.services).set({ allowCancel: true, allowVerify: true }).where(eq(s.services.id, auto.serviceId));
    const { shopOfMerchant } = await threeOrders();
    await db
      .update(s.orders)
      .set({ status: 'completed', dispatchState: 'done', completedAt: clock.now() })
      .where(eq(s.orders.id, shopOfMerchant.id));
    const eventsBefore = (await eventsOf(db, shopOfMerchant.id)).length;
    const me = await portalFor(t, merchant.id);
    expect((await me.post(`/client/orders/${shopOfMerchant.id}/cancel`)).statusCode).toBe(404);
    expect((await me.post(`/client/orders/${shopOfMerchant.id}/verify`)).statusCode).toBe(404);
    expect(await db.select().from(s.refunds)).toHaveLength(0);
    expect(await db.select().from(s.ledgerTransactions).where(eq(s.ledgerTransactions.refType, 'order'))).toHaveLength(
      0,
    );
    expect((await eventsOf(db, shopOfMerchant.id)).length).toBe(eventsBefore);
    expect((await db.select().from(s.orders).where(eq(s.orders.id, shopOfMerchant.id)))[0]!.status).toBe('completed');
  });

  it("does not find the account's own shop order through Dhru, and finds its portal order", async () => {
    const { db, merchant } = world;
    const { portal, shopOfMerchant } = await threeOrders();
    const dhru = dhruClient(t, await credentialsFor(t, db, merchant.id));
    const found = await dhru.call('getimeiorder', { ID: portal.id });
    expect(found.SUCCESS?.[0]).toMatchObject({ STATUS: 0 });
    const missing = await dhru.call('getimeiorder', { ID: shopOfMerchant.id });
    expect(missing.ERROR?.[0]?.MESSAGE).toBe('Order not found');
  });

  it("lists the account's shop orders through the ShopOrders seam, never its portal orders", async () => {
    const { db, merchant } = world;
    const { shopOfMerchant } = await threeOrders();
    const page = await t.app.get(ShopOrders, { strict: false }).listShopOrders(db, merchant.id, {
      range: { start: 0, end: 25, limit: 25 },
      sort: [{ field: 'createdAt', order: 'desc' }],
      filters: [],
      search: undefined,
      extra: {},
    });
    expect(page.total).toBe(1);
    expect(page.rows.map((row) => row.id)).toEqual([shopOfMerchant.id]);
  });
});

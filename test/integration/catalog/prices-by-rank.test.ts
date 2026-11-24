// Integration tests of prices by rank (decision 064): a fixed client price and the price resolver are for accounts of a
// merchant rank only (422 `retail_rank` on `clientId`, on create, change and resolve; the rows of a lowered account stay and apply again
// after a raise); the price change scan watches merchant ranks and their merchant-door orders only; every rank answers its `rankKind`
// and its `accountCount`; and a guest made from a merchant's email is a separate row of the retail rank, priced from the retail row.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { eq } from 'drizzle-orm';
import { DbService, schema as s } from '@src/infra/db';
import { PriceChangeScan, PriceResolver } from '@src/modules/catalog';
import { AccountDirectory } from '@src/modules/identity';
import { makeAccount } from '../../support/accounts';
import { type AdminApi, adminWith } from '../../support/admin-api';
import { type TestApp, createTestApp } from '../../support/app';
import { clearIdentityCaches } from '../../support/auth';
import { DAY, TestClock } from '../../support/clock';
import { closeTestDb, resetDb, testDb } from '../../support/db';
import { insertOrderRow } from '../../support/orders';
import { insertUsd } from '../../support/portal-orders';
import {
  insertAtt,
  insertClientPriceRow,
  insertDemoGroups,
  insertGroupPrice,
  insertMerchantIn,
} from '../../support/pricing';

const clock = new TestClock('2026-11-01T10:00:00.000Z');
let t: TestApp;
let admin: AdminApi;

beforeAll(async () => {
  t = await createTestApp({ clock });
});
beforeEach(async () => {
  clock.set('2026-11-01T10:00:00.000Z');
  await resetDb();
  await clearIdentityCaches(t);
  admin = await adminWith(t, ['pricing:*', 'groups:read', 'catalog:read'], { name: 'Rami K.' });
});
afterAll(async () => {
  await resetDb();
  await clearIdentityCaches(t);
  await t.close();
  await closeTestDb();
});

const ago = (days: number) => new Date(clock.nowMs() - days * DAY);
const priceRow = async (id: number) =>
  (await (await testDb()).db.select().from(s.serviceClientPrices).where(eq(s.serviceClientPrices.id, id)))[0];
const events = async () =>
  (await testDb()).db
    .select()
    .from(s.outboxEvents)
    .where(eq(s.outboxEvents.type, 'service.price_changed'))
    .orderBy(s.outboxEvents.id);

/** The four demo ranks, the AT&T unlock (base price 17.28, floor 14.31) and a merchant of the Standard rank. */
async function world() {
  const { db } = await testDb();
  const groups = await insertDemoGroups(db);
  const { serviceId } = await insertAtt(db);
  const merchant = await insertMerchantIn(db, groups.standard, { name: 'Erbil' });
  await insertUsd(db);
  return { db, groups, serviceId, merchant };
}

const retailRankError = { field: 'clientId', code: 'retail_rank', message: expect.any(String) };

describe('a fixed client price is for a merchant rank only', () => {
  it('refuses a create for a retail account and for a guest: 422 retail_rank on clientId, nothing written', async () => {
    const { db, serviceId } = await world();
    const shopper = await makeAccount(t, { rank: 'retail' });
    const guest = await makeAccount(t, { rank: 'retail', guest: true });
    for (const account of [shopper, guest]) {
      const res = await admin.post('/admin/client-prices', { clientId: account.id, serviceId, price: '15.2000' });
      expect(res.status, String(account.id)).toBe(422);
      expect(res.body.errors).toEqual([retailRankError]);
    }
    expect(await db.select().from(s.serviceClientPrices)).toEqual([]);
    expect(await db.select().from(s.auditLogs)).toEqual([]);
  });

  it('still creates the price for an account of a merchant rank', async () => {
    const { serviceId, merchant } = await world();
    const res = await admin.post('/admin/client-prices', { clientId: merchant, serviceId, price: '15.2000' });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ clientId: merchant, serviceId, price: '15.2000' });
  });

  it('refuses a change while the account is on the retail rank, keeps the row, and works again after a raise', async () => {
    const { db, groups, serviceId, merchant } = await world();
    const id = await insertClientPriceRow(db, serviceId, merchant, '15.2000', 'Agreed');
    await db.update(s.clients).set({ groupId: groups.retail }).where(eq(s.clients.id, merchant));

    for (const change of [{ price: '15.5000' }, { note: 'new note' }]) {
      const refused = await admin.patch(`/admin/client-prices/${id}`, change);
      expect(refused.status).toBe(422);
      expect(refused.body.errors).toEqual([retailRankError]);
    }
    expect(await priceRow(id)).toMatchObject({ price: '15.2000', note: 'Agreed' });
    // The row is still listed for the account.
    const listed = await admin.get(`/admin/client-prices?clientId=${merchant}&_start=0&_end=200`);
    expect(listed.body.map((row: { id: number }) => row.id)).toEqual([id]);

    // A raise back to a merchant rank: the row applies again, and it can be changed.
    await db.update(s.clients).set({ groupId: groups.standard }).where(eq(s.clients.id, merchant));
    const resolved = await admin.get(`/admin/pricing/resolve?serviceId=${serviceId}&clientId=${merchant}`);
    expect(resolved.body).toMatchObject({ source: 'client', price: '15.2000' });
    const changed = await admin.patch(`/admin/client-prices/${id}`, { price: '15.5000' });
    expect(changed.status).toBe(200);
    expect(changed.body.price).toBe('15.5000');
  });

  it('lets a price of a lowered account be deleted', async () => {
    const { db, groups, serviceId, merchant } = await world();
    const id = await insertClientPriceRow(db, serviceId, merchant, '15.2000');
    await db.update(s.clients).set({ groupId: groups.retail }).where(eq(s.clients.id, merchant));
    expect((await admin.delete(`/admin/client-prices/${id}`)).status).toBe(204);
    expect(await priceRow(id)).toBeUndefined();
  });
});

describe('GET /admin/pricing/resolve is for a merchant rank only', () => {
  it('answers 422 retail_rank on clientId for a retail account and for a guest', async () => {
    const { serviceId } = await world();
    const shopper = await makeAccount(t, { rank: 'retail' });
    const guest = await makeAccount(t, { rank: 'retail', guest: true });
    for (const account of [shopper, guest]) {
      const res = await admin.get(`/admin/pricing/resolve?serviceId=${serviceId}&clientId=${account.id}`);
      expect(res.status, String(account.id)).toBe(422);
      expect(res.body.errors).toEqual([retailRankError]);
    }
  });

  it('resolves a merchant, and an unknown account is still 404', async () => {
    const { serviceId, merchant } = await world();
    const res = await admin.get(`/admin/pricing/resolve?serviceId=${serviceId}&clientId=${merchant}`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ source: 'base', price: '17.2800' });
    expect((await admin.get(`/admin/pricing/resolve?serviceId=${serviceId}&clientId=999999`)).status).toBe(404);
  });
});

describe('the price change scan watches merchant ranks only', () => {
  it('skips a retail buyer with a recent shop order, and still announces a merchant whose price changed', async () => {
    const { db, serviceId, merchant } = await world();
    const shopper = await makeAccount(t, { rank: 'retail' });
    await insertOrderRow(db, {
      accountId: shopper.id,
      serviceId,
      source: 'store',
      unitPrice: '10.0000',
      totalPrice: '10.0000',
      createdAt: ago(1),
    });
    await insertOrderRow(db, {
      accountId: merchant,
      serviceId,
      source: 'portal',
      unitPrice: '10.0000',
      totalPrice: '10.0000',
      createdAt: ago(1),
    });

    // The shop order is not looked at (checked counts the merchant only); the merchant paid 10 and would pay 17.28 now.
    expect(await t.app.get(PriceChangeScan).run()).toEqual({ checked: 1, announced: 1 });
    const [event] = await events();
    expect(event?.payload).toMatchObject({ clientId: merchant, serviceId, previousPrice: '10.0000', price: '17.2800' });
  });

  it('skips a merchant lowered to the retail rank, and a retail account raised to a merchant rank that has ordered through the shop only', async () => {
    const { db, groups, serviceId, merchant } = await world();
    await insertOrderRow(db, {
      accountId: merchant,
      serviceId,
      source: 'portal',
      unitPrice: '10.0000',
      totalPrice: '10.0000',
      createdAt: ago(1),
    });
    // Raised from the retail rank: its only order is a shop order, paid at the retail price.
    const raised = await makeAccount(t, { rank: 'retail' });
    await insertOrderRow(db, {
      accountId: raised.id,
      serviceId,
      source: 'store',
      unitPrice: '20.0000',
      totalPrice: '20.0000',
      createdAt: ago(2),
    });
    await db
      .update(s.clients)
      .set({ groupId: groups.standard, username: 'raised-merchant' })
      .where(eq(s.clients.id, raised.id));

    expect(await t.app.get(PriceChangeScan).run()).toEqual({ checked: 1, announced: 1 });

    // Lowered to the retail rank: it pays the shop price now, so the scan leaves it alone.
    await db.update(s.clients).set({ groupId: groups.retail }).where(eq(s.clients.id, merchant));
    expect(await t.app.get(PriceChangeScan).run()).toEqual({ checked: 0, announced: 0 });
  });
});

describe('every rank answers its kind and its account count', () => {
  it('lists rankKind and accountCount for the merchant ranks and the retail rank, any status, guests included', async () => {
    const { db, groups } = await world();
    await insertMerchantIn(db, groups.standard, { status: 'suspended' });
    await makeAccount(t, { rank: 'retail' });
    await makeAccount(t, { rank: 'retail', status: 'blocked' });
    await makeAccount(t, { rank: 'retail', guest: true });

    const res = await admin.get('/admin/client-groups?_start=0&_end=200&_sort=sort&_order=asc');
    expect(res.status).toBe(200);
    const byId = new Map<number, { rankKind: string; accountCount: number; kind: string }>(
      res.body.map((row: { id: number; rankKind: string; accountCount: number; kind: string }) => [row.id, row]),
    );
    expect(byId.get(groups.standard)).toMatchObject({ kind: 'b2b', rankKind: 'merchant', accountCount: 2 });
    expect(byId.get(groups.wholesale)).toMatchObject({ kind: 'b2b', rankKind: 'merchant', accountCount: 0 });
    expect(byId.get(groups.vip)).toMatchObject({ kind: 'b2b', rankKind: 'merchant', accountCount: 0 });
    expect(byId.get(groups.retail)).toMatchObject({ kind: 'b2c_retail', rankKind: 'retail', accountCount: 3 });
    for (const row of res.body) expect(row).not.toHaveProperty('merchantCount');

    const one = await admin.get(`/admin/client-groups/${groups.retail}`);
    expect(one.body).toMatchObject({ rankKind: 'retail', accountCount: 3 });
  });
});

describe("a merchant's email at checkout is priced from the retail row", () => {
  it('makes a separate guest row of the retail rank, which the resolver prices at the retail group price', async () => {
    const { db, groups, serviceId, merchant } = await world();
    await insertGroupPrice(db, serviceId, groups.standard, '16.0000');
    await insertGroupPrice(db, serviceId, groups.retail, '18.5000');
    const [row] = await db.select({ email: s.clients.email }).from(s.clients).where(eq(s.clients.id, merchant));

    const guest = await t.app
      .get(DbService)
      .runInTransaction(({ tx }) => t.app.get(AccountDirectory).findOrCreateGuest(tx, { email: row!.email }));
    expect(guest.created).toBe(true);
    expect(guest.account.id).not.toBe(merchant);
    expect(guest.account.hasAccount).toBe(false);
    expect(guest.account.groupId).toBe(groups.retail);

    const resolver = t.app.get(PriceResolver);
    const asGuest = await resolver.resolve(db, { serviceId, groupId: guest.account.groupId, clientId: null });
    const asMerchant = await resolver.resolve(db, { serviceId, groupId: groups.standard, clientId: merchant });
    expect(asGuest?.price.toWire()).toBe('18.5000');
    expect(asMerchant?.price.toWire()).toBe('16.0000');
  });
});

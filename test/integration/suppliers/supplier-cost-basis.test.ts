// What every price floor is built on, from the supplier side: a supplier is kept in the base currency (USD), so one credit is worth
// one dollar (`credit_rate` 1); a sync whose supplier reports its account in another currency saves nothing; and the effective cost
// of a service follows its first link an order can use, through a sync that drops a service and a pause or resume of a supplier.
// Real Postgres and Redis, the fake Dhru supplier.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { eq } from 'drizzle-orm';
import { EncryptionService } from '@src/infra/crypto';
import { type Database, schema as s } from '@src/infra/db';
import { PriceResolver, RetailPrices, recomputeEffectiveCost } from '@src/modules/catalog';
import { SupplierSync } from '@src/modules/suppliers';
import { type AdminApi, adminWith } from '../../support/admin-api';
import { type TestApp, createTestApp } from '../../support/app';
import { clearIdentityCaches } from '../../support/auth';
import { insertCategory, insertService } from '../../support/catalog';
import { closeTestDb, resetDb, testDb } from '../../support/db';
import { insertUsd } from '../../support/fixtures';
import { catalogVersionOf, insertDemoGroups } from '../../support/pricing';
import { FakeDhruSupplier, SupplierTestModule, insertFakeSupplier, linkService, logsOf } from '../../support/suppliers';

let t: TestApp;
let db: Database;
let admin: AdminApi;
const fake = new FakeDhruSupplier();

beforeAll(async () => {
  ({ db } = await testDb());
  t = await createTestApp({ imports: [SupplierTestModule] });
});
beforeEach(async () => {
  await resetDb();
  await clearIdentityCaches(t);
  admin = await adminWith(t, ['*'], { name: 'Nadia R.' });
  fake.reset();
  fake.currency = 'USD';
});
afterAll(async () => {
  await fake.stop();
  await resetDb();
  await clearIdentityCaches(t);
  await t.close();
  await closeTestDb();
});

const connectBody = (overrides: Record<string, unknown> = {}) => ({
  name: 'Gulf Unlock Hub',
  driver: 'dhru',
  baseUrl: fake.url,
  username: fake.username,
  apiKey: fake.apiKey,
  currency: 'USD',
  ...overrides,
});

const sync = (supplierId: number) => t.app.get(SupplierSync, { strict: false }).run(supplierId, { audit: false });

async function supplierRow(id: number) {
  const [row] = await db.select().from(s.suppliers).where(eq(s.suppliers.id, id));
  return row!;
}

async function effectiveOf(serviceId: number): Promise<string> {
  const [row] = await db
    .select({ effectiveCost: s.services.effectiveCost })
    .from(s.services)
    .where(eq(s.services.id, serviceId));
  return row!.effectiveCost;
}

/** Inserts a supplier that is never called. */
async function bareSupplier(name: string): Promise<number> {
  const [row] = await db
    .insert(s.suppliers)
    .values({ name, driver: 'dhru', baseUrl: 'http://127.0.0.1:9', username: 'x', paramFormat: 'dhru_xml' })
    .returning({ id: s.suppliers.id });
  return row!.id;
}

describe('a supplier is kept in the base currency', () => {
  it('refuses to add a supplier in another currency (422 on currency) and saves nothing', async () => {
    const refused = await admin.post('/admin/suppliers', connectBody({ currency: 'KWD' }));
    expect(refused.status).toBe(422);
    expect(refused.body.errors).toEqual([expect.objectContaining({ field: 'currency', code: 'unsupported' })]);
    expect(await db.select().from(s.suppliers)).toHaveLength(0);

    const added = await admin.post('/admin/suppliers', connectBody());
    expect(added.status).toBe(201);
    expect(added.body).toMatchObject({ currency: 'USD', creditRate: '1.00000000' });
  });

  it('refuses to change a supplier to another currency (422 on currency) and keeps its own', async () => {
    const added = await admin.post('/admin/suppliers', connectBody());
    const id = added.body.id as number;
    const refused = await admin.patch(`/admin/suppliers/${id}`, { currency: 'EUR', maxConcurrency: 2 });
    expect(refused.status).toBe(422);
    expect(refused.body.errors).toEqual([expect.objectContaining({ field: 'currency', code: 'unsupported' })]);
    expect(await supplierRow(id)).toMatchObject({ currency: 'USD', maxConcurrency: 5 });

    const kept = await admin.patch(`/admin/suppliers/${id}`, { currency: 'USD', maxConcurrency: 2 });
    expect(kept.status).toBe(200);
    expect(kept.body).toMatchObject({ currency: 'USD', maxConcurrency: 2 });
  });

  it('saves no price and no balance when the supplier reports another currency than its own', async () => {
    const id = await insertFakeSupplier(db, t.app.get(EncryptionService), fake);
    fake.currency = 'KWD';
    const refused = await sync(id);
    expect(refused).toMatchObject({ ok: false, code: 'SUPPLIER_UNAVAILABLE' });
    if (!refused.ok) expect(refused.detail).toContain('KWD');
    expect(await db.select().from(s.supplierServices).where(eq(s.supplierServices.supplierId, id))).toHaveLength(0);
    expect(await supplierRow(id)).toMatchObject({ balance: '0.0000', balanceCheckedAt: null, pricesSyncedAt: null });
    // Both calls were made and logged.
    expect((await logsOf(db, id)).map((log) => log.action)).toEqual(['imeiservicelist', 'accountinfo']);

    // A price saved by an earlier sync stays as it was.
    fake.currency = 'USD';
    expect((await sync(id)).ok).toBe(true);
    fake.currency = 'KWD';
    fake.services[0]!.credit = '3.0000';
    expect((await sync(id)).ok).toBe(false);
    const [kept] = await db
      .select({ credit: s.supplierServices.credit })
      .from(s.supplierServices)
      .where(eq(s.supplierServices.remoteId, fake.services[0]!.id));
    expect(kept!.credit).toBe('13.5000');
  });

  it('syncs a supplier that reports its own currency in small letters, or no currency', async () => {
    const id = await insertFakeSupplier(db, t.app.get(EncryptionService), fake);
    fake.currency = 'usd';
    expect((await sync(id)).ok).toBe(true);
    fake.currency = '';
    expect((await sync(id)).ok).toBe(true);
  });
});

describe('the effective cost follows the first link an order can use', () => {
  it('moves to the next supplier when the first stops listing the service, and holds every price to that cost', async () => {
    await insertUsd(db);
    const groups = await insertDemoGroups(db);
    const categoryId = await insertCategory(db, { name: 'Carrier unlock' });
    const serviceId = await insertService(db, categoryId, {
      cost: '0.0000',
      effectiveCost: '0.0000',
      basePrice: '3.0000',
      minProfit: null,
    });
    fake.services = [
      { id: '4411', group: 'Carrier unlock', type: 'IMEI', name: 'Unlock', credit: '1.0000', time: '1 h' },
    ];
    const first = await insertFakeSupplier(db, t.app.get(EncryptionService), fake);
    await linkService(db, serviceId, first, { remoteId: '4411', credit: '1.0000', priority: 1 });
    await linkService(db, serviceId, await bareSupplier('Second supplier'), {
      remoteId: '9001',
      credit: '8.0000',
      priority: 2,
    });
    await recomputeEffectiveCost(db, [serviceId]);
    expect(await effectiveOf(serviceId)).toBe('1.0000');

    fake.services = [];
    const before = await catalogVersionOf(t);
    expect((await sync(first)).ok).toBe(true);
    expect(await effectiveOf(serviceId)).toBe('8.0000');
    expect(await catalogVersionOf(t)).not.toBe(before);

    // Cost 8.00 plus the default minimum profit (6 %, 0.48): every price is held to 8.48.
    const groupPrice = await admin.put(`/admin/services/${serviceId}/group-prices`, {
      prices: [{ groupId: groups.standard, price: '2.0000' }],
    });
    expect(groupPrice.status).toBe(422);
    expect(groupPrice.body.errors[0]).toMatchObject({ field: 'prices.0.price' });
    const basePrice = await admin.patch(`/admin/services/${serviceId}`, { basePrice: '2.0000' });
    expect(basePrice.status).toBe(422);
    expect(basePrice.body.errors[0]).toMatchObject({ field: 'basePrice', code: 'below_floor' });
    const resolved = await t.app.get(PriceResolver).resolve(db, { serviceId, groupId: groups.standard });
    expect(resolved!.floor.toWire()).toBe('8.4800');
    expect(resolved!.price.toWire()).toBe('8.4800');
    const quote = (await t.app.get(RetailPrices).quotes(db, [serviceId])).get(serviceId)!;
    expect(quote.cost.toWire()).toBe('8.0000');

    // The first supplier lists it again: the cost goes back to it.
    fake.services = [
      { id: '4411', group: 'Carrier unlock', type: 'IMEI', name: 'Unlock', credit: '1.0000', time: '1 h' },
    ];
    expect((await sync(first)).ok).toBe(true);
    expect(await effectiveOf(serviceId)).toBe('1.0000');
  });

  it('follows a pause, a resume and a disable of a supplier, and moves the catalog price version', async () => {
    const categoryId = await insertCategory(db, { name: 'Carrier unlock' });
    const serviceId = await insertService(db, categoryId, {
      cost: '0.0000',
      effectiveCost: '0.0000',
      basePrice: '20.0000',
    });
    const first = await bareSupplier('First supplier');
    await linkService(db, serviceId, first, { remoteId: 'a1', credit: '1.0000', priority: 1 });
    await linkService(db, serviceId, await bareSupplier('Second supplier'), {
      remoteId: 'b1',
      credit: '8.0000',
      priority: 2,
    });
    await recomputeEffectiveCost(db, [serviceId]);

    for (const [status, cost] of [
      ['paused', '8.0000'],
      ['active', '1.0000'],
      ['disabled', '8.0000'],
      ['active', '1.0000'],
    ] as const) {
      const before = await catalogVersionOf(t);
      const res = await admin.patch(`/admin/suppliers/${first}`, { status });
      expect(res.status).toBe(200);
      expect(await effectiveOf(serviceId)).toBe(cost);
      expect(await catalogVersionOf(t)).not.toBe(before);
    }

    // A change that leaves the status alone moves nothing.
    const before = await catalogVersionOf(t);
    expect((await admin.patch(`/admin/suppliers/${first}`, { maxConcurrency: 3 })).status).toBe(200);
    expect(await catalogVersionOf(t)).toBe(before);
  });
});

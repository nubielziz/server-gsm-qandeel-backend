// Integration tests of the storefront availability flag (feature 22, slice B): `in_stock` / `on_request` follows inventory imports, voids
// and sales, respects fixed packs, and its SQL test (the filter) equals the domain rule.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { eq } from 'drizzle-orm';
import { DbService, schema as s } from '../../src/infra/db';
import { InventoryStock, StorefrontServices, coversSmallestOrder } from '../../src/modules/catalog';
import { type AdminApi, adminWith } from '../support/admin-api';
import { type TestApp, createTestApp } from '../support/app';
import { clearIdentityCaches } from '../support/auth';
import { insertInventoryCodes } from '../support/catalog';
import { closeTestDb, resetDb, testDb } from '../support/db';
import { insertService } from '../support/catalog';
import { insertCustomerRow, insertStoreOrder, storefrontWorld } from '../support/storefront';

let t: TestApp;
let admin: AdminApi;

beforeAll(async () => {
  t = await createTestApp();
});
beforeEach(async () => {
  await resetDb();
  await clearIdentityCaches(t);
  admin = await adminWith(t, ['inventory:*', 'catalog:*']);
});
afterAll(async () => {
  await resetDb();
  await clearIdentityCaches(t);
  await t.close();
  await closeTestDb();
});

const cards = async () =>
  (await t.app.inject({ method: 'GET', url: '/store/v1/services' })).json<
    Array<{ slug: string; availability: string }>
  >();
const availabilityOf = async (slug: string) => (await cards()).find((card) => card.slug === slug)?.availability;
const inStockSlugs = async () =>
  (await t.app.inject({ method: 'GET', url: '/store/v1/services?availability=in_stock' }))
    .json<Array<{ slug: string }>>()
    .map((card) => card.slug);

describe('availability of a storefront card', () => {
  it('turns in_stock after an inventory import and back to on_request after a void', async () => {
    const { db } = await testDb();
    const world = await storefrontWorld(db);
    expect(await availabilityOf(world.icloud.slug)).toBe('on_request');
    expect(await inStockSlugs()).toEqual([]);

    const imported = await admin.post(`/admin/services/${world.icloud.serviceId}/inventory/import`, {
      codes: ['AAAAAA-111111', 'BBBBBB-222222'],
    });
    expect(imported.body.imported).toBe(2);
    expect(await availabilityOf(world.icloud.slug)).toBe('in_stock');
    expect(await inStockSlugs()).toEqual([world.icloud.slug]);

    const ids = (await db.select().from(s.inventoryCodes)).map((row) => row.id);
    await admin.post('/admin/inventory-codes/void', { ids });
    expect(await availabilityOf(world.icloud.slug)).toBe('on_request');
    expect(await inStockSlugs()).toEqual([]);
  });

  it('turns on_request when a sale takes the last code, and reserved or sold codes never count', async () => {
    const { db } = await testDb();
    const world = await storefrontWorld(db);
    // A real import, so the code can be decrypted when the order takes it.
    await admin.post(`/admin/services/${world.icloud.serviceId}/inventory/import`, { codes: ['ONLY-CODE-1'] });
    const [only] = (await db.select().from(s.inventoryCodes)).map((row) => row.id);
    await insertInventoryCodes(db, world.icloud.serviceId, 3, { status: 'reserved' });
    expect(await availabilityOf(world.icloud.slug)).toBe('in_stock');

    // The placement of an order claims the code and marks it sold inside its transaction.
    const orderId = await insertStoreOrder(db, world.icloud.serviceId, await insertCustomerRow(db));
    await t.app.get(DbService).runInTransaction(async ({ tx }) => {
      const claim = await t.app.get(InventoryStock, { strict: false }).claim(tx, world.icloud.serviceId, 1);
      expect(claim?.ids).toEqual([only!]);
      await t.app.get(InventoryStock, { strict: false }).sell(tx, claim!, orderId);
    });
    expect(await availabilityOf(world.icloud.slug)).toBe('on_request');
  });

  it('needs the smallest pack when packs are set, and the minimum quantity otherwise', async () => {
    const { db } = await testDb();
    const world = await storefrontWorld(db);
    await db.update(s.services).set({ minQty: 3, maxQty: 10 }).where(eq(s.services.id, world.icloud.serviceId));
    await db
      .update(s.services)
      .set({ minQty: 1, maxQty: 50, qtyOptions: [5, 10] })
      .where(eq(s.services.id, world.att.serviceId));
    await insertInventoryCodes(db, world.icloud.serviceId, 2);
    await insertInventoryCodes(db, world.att.serviceId, 4);
    expect(await availabilityOf(world.icloud.slug)).toBe('on_request');
    expect(await availabilityOf(world.att.slug)).toBe('on_request');
    await insertInventoryCodes(db, world.icloud.serviceId, 1);
    await insertInventoryCodes(db, world.att.serviceId, 1);
    expect(await availabilityOf(world.icloud.slug)).toBe('in_stock');
    expect(await availabilityOf(world.att.slug)).toBe('in_stock');
  });

  it('keeps the SQL test and the domain rule equal over minimum quantities, packs and stock levels', async () => {
    const { db } = await testDb();
    const world = await storefrontWorld(db);
    const services = t.app.get(StorefrontServices, { strict: false });
    const shapes: Array<{ minQty: number; maxQty: number; qtyOptions: number[] }> = [
      { minQty: 1, maxQty: 1, qtyOptions: [] },
      { minQty: 4, maxQty: 9, qtyOptions: [] },
      { minQty: 1, maxQty: 30, qtyOptions: [10, 5, 20] },
      { minQty: 2, maxQty: 30, qtyOptions: [25] },
    ];
    for (const [index, shape] of shapes.entries()) {
      for (const stock of [0, 1, 3, 4, 5, 10, 11]) {
        const serviceId = await insertService(db, world.icloud.categoryId, {
          name: `Shape ${index}/${stock}`,
          ...shape,
        });
        await insertInventoryCodes(db, serviceId, stock);
        await insertInventoryCodes(db, serviceId, 2, { status: 'sold' });
        const sql = (await services.inStockIds(db, [serviceId])).has(serviceId);
        expect(sql, `shape ${index} stock ${stock}`).toBe(coversSmallestOrder(stock, shape.minQty, shape.qtyOptions));
      }
    }
    expect((await services.inStockIds(db, [])).size).toBe(0);
  });
});

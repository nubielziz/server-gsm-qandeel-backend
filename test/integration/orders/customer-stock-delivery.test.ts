// The storefront's placement of a paid checkout and the code stock (decision 069): an order of a service delivered from code stock is
// delivered from its codes at once, as a merchant's is; codes held by any other service are never taken, and its order goes the usual way.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { asc, eq } from 'drizzle-orm';
import { type Database, schema as s } from '@src/infra/db';
import { adminWith } from '../../support/admin-api';
import { type TestApp, createTestApp } from '../../support/app';
import { clearIdentityCaches } from '../../support/auth';
import { B2cGateway, type B2cWorld, b2cWorld, paidOrder } from '../../support/b2c';
import { GatewayTestModule } from '../../support/billing';
import { insertInventoryCodes, markStockService } from '../../support/catalog';
import { TestClock } from '../../support/clock';
import { closeTestDb, resetDb, testDb } from '../../support/db';
import { orderRow } from '../../support/orders';

const clock = new TestClock('2026-11-07T12:00:00.000Z');
const fake = new B2cGateway();
let t: TestApp;
let db: Database;
let world: B2cWorld;

beforeAll(async () => {
  ({ db } = await testDb());
  t = await createTestApp({ clock, imports: [GatewayTestModule] });
});
afterAll(async () => {
  await fake.stop();
  await resetDb();
  await clearIdentityCaches(t);
  await t.close();
  await closeTestDb();
});
beforeEach(async () => {
  clock.set('2026-11-07T12:00:00.000Z');
  fake.reset();
  await resetDb();
  await clearIdentityCaches(t);
  world = await b2cWorld(t, db, fake);
});

const codesOf = (serviceId: number) =>
  db
    .select({ status: s.inventoryCodes.status, orderId: s.inventoryCodes.orderId })
    .from(s.inventoryCodes)
    .where(eq(s.inventoryCodes.serviceId, serviceId))
    .orderBy(asc(s.inventoryCodes.id));

describe('the placement of a paid shop order', () => {
  it('delivers an order of a service delivered from code stock from its codes at once', async () => {
    await markStockService(db, world.icloud.serviceId);
    const staff = await adminWith(t, ['inventory:write']);
    // A real import, so the code can be decrypted when the order takes it.
    const imported = await staff.post(`/admin/services/${world.icloud.serviceId}/inventory/import`, {
      codes: ['GSM-STOCK-0001', 'GSM-STOCK-0002'],
    });
    expect(imported.status).toBe(200);

    const paid = await paidOrder(t, clock, world);
    expect(await orderRow(db, paid.orderId)).toMatchObject({
      status: 'completed',
      dispatchState: 'done',
      resultCode: 'GSM-STOCK-0001',
    });
    expect(await codesOf(world.icloud.serviceId)).toEqual([
      { status: 'sold', orderId: paid.orderId },
      { status: 'available', orderId: null },
    ]);
  });

  it('never takes codes of a service that is not delivered from code stock: the order goes the usual way', async () => {
    // Codes put on the service by mistake: the helper stocks them, then the service is a plain one again.
    await insertInventoryCodes(db, world.icloud.serviceId, 2);
    await markStockService(db, world.icloud.serviceId, false);

    const paid = await paidOrder(t, clock, world);
    const order = await orderRow(db, paid.orderId);
    expect(order).toMatchObject({ status: 'pending', resultCode: null });
    expect(order.dispatchState).not.toBe('done');
    expect(await codesOf(world.icloud.serviceId)).toEqual([
      { status: 'available', orderId: null },
      { status: 'available', orderId: null },
    ]);
  });
});

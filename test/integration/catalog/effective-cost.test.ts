// The effective cost (user rule 9, RESOLUTIONS catalog-1): the cost every price floor of the catalog starts from. It follows the
// first link an order could really be sent through (the link is switched on, its supplier is active and still lists the service),
// the rule of the automatic dispatch; with no such link it keeps the highest cost of the switched-on links. Real Postgres.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { eq } from 'drizzle-orm';
import { type Database, schema as s } from '@src/infra/db';
import { recomputeEffectiveCost } from '@src/modules/catalog';
import { insertCategory, insertService } from '../../support/catalog';
import { closeTestDb, resetDb, testDb } from '../../support/db';
import { linkService } from '../../support/suppliers';

let db: Database;

beforeAll(async () => {
  ({ db } = await testDb());
});
beforeEach(async () => {
  await resetDb();
});
afterAll(async () => {
  await resetDb();
  await closeTestDb();
});

/** Inserts a supplier that is never called. */
async function supplier(name: string): Promise<number> {
  const [row] = await db
    .insert(s.suppliers)
    .values({ name, driver: 'dhru', baseUrl: 'http://127.0.0.1:9', username: 'x', paramFormat: 'dhru_xml' })
    .returning({ id: s.suppliers.id });
  return row!.id;
}

/** A service with a cheap first link (1.00) and a costlier second one (8.00), its effective cost worked out once. */
async function twoLinks() {
  const categoryId = await insertCategory(db, { name: 'Carrier unlock' });
  const serviceId = await insertService(db, categoryId, {
    cost: '0.0000',
    effectiveCost: '0.0000',
    basePrice: '20.0000',
  });
  const first = await supplier('First supplier');
  const second = await supplier('Second supplier');
  const one = await linkService(db, serviceId, first, { remoteId: 'a1', credit: '1.0000', priority: 1 });
  const two = await linkService(db, serviceId, second, { remoteId: 'b1', credit: '8.0000', priority: 2 });
  await recomputeEffectiveCost(db, [serviceId]);
  // As after a base price save: no earlier cost is shown.
  await db.update(s.services).set({ costWas: null }).where(eq(s.services.id, serviceId));
  return { serviceId, first, second, one, two };
}

async function effectiveOf(serviceId: number) {
  const [row] = await db
    .select({ effectiveCost: s.services.effectiveCost, costWas: s.services.costWas })
    .from(s.services)
    .where(eq(s.services.id, serviceId));
  return row!;
}

const setStatus = (id: number, status: 'active' | 'paused' | 'disabled') =>
  db.update(s.suppliers).set({ status }).where(eq(s.suppliers.id, id));
const setListed = (supplierServiceId: number, isAvailable: boolean) =>
  db.update(s.supplierServices).set({ isAvailable }).where(eq(s.supplierServices.id, supplierServiceId));

describe('recomputeEffectiveCost', () => {
  it('takes the first link by priority whose supplier is active and still lists the service', async () => {
    const { serviceId } = await twoLinks();
    expect((await effectiveOf(serviceId)).effectiveCost).toBe('1.0000');
  });

  it('takes the next usable link when the first supplier no longer lists the service, and back when it lists it again', async () => {
    const { serviceId, one } = await twoLinks();
    await setListed(one.supplierServiceId, false);
    expect(await recomputeEffectiveCost(db, [serviceId])).toEqual([serviceId]);
    expect(await effectiveOf(serviceId)).toEqual({ effectiveCost: '8.0000', costWas: '1.0000' });

    await setListed(one.supplierServiceId, true);
    expect(await recomputeEffectiveCost(db, [serviceId])).toEqual([serviceId]);
    expect((await effectiveOf(serviceId)).effectiveCost).toBe('1.0000');
  });

  it('skips a link whose supplier is paused or disabled', async () => {
    const { serviceId, first } = await twoLinks();
    for (const status of ['paused', 'disabled'] as const) {
      await setStatus(first, status);
      await recomputeEffectiveCost(db, [serviceId]);
      expect((await effectiveOf(serviceId)).effectiveCost).toBe('8.0000');
      await setStatus(first, 'active');
      await recomputeEffectiveCost(db, [serviceId]);
      expect((await effectiveOf(serviceId)).effectiveCost).toBe('1.0000');
    }
  });

  it('keeps the highest cost of the switched-on links when no link can take an order, and ignores a switched-off one', async () => {
    const { serviceId, first, two } = await twoLinks();
    const third = await supplier('Third supplier');
    await linkService(db, serviceId, third, { remoteId: 'c1', credit: '50.0000', priority: 3, isActive: false });
    await setStatus(first, 'paused');
    await setListed(two.supplierServiceId, false);
    await recomputeEffectiveCost(db, [serviceId]);
    expect((await effectiveOf(serviceId)).effectiveCost).toBe('8.0000');
  });

  it('never goes under the service cost, which is all there is with no switched-on link', async () => {
    const categoryId = await insertCategory(db, { name: 'Carrier unlock' });
    const serviceId = await insertService(db, categoryId, { cost: '5.0000', effectiveCost: '5.0000' });
    const only = await supplier('Only supplier');
    await linkService(db, serviceId, only, { remoteId: 'd1', credit: '9.0000', isActive: false });
    expect(await recomputeEffectiveCost(db, [serviceId])).toEqual([]);
    expect((await effectiveOf(serviceId)).effectiveCost).toBe('5.0000');
  });
});

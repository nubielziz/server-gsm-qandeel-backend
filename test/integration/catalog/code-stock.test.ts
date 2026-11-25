// Services sold as codes and a service's own cost on the admin routes (decision 069): the three row fields (`stockDelivery`,
// `stockAvailable`, `ownCost`) and the list filter `stockDelivery`, create and change of the flag and the own cost (0 to 1,000,000,000;
// a create with an own cost judges its base price against the floor like a change), the two refusals that guard the stock (the flag goes
// off only without available codes; only a stock service takes an import), and an own cost that moves the effective cost, the floor, the
// "cost changed" mark, the catalog price version and the audit row like a supplier cost change.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { asc, eq } from 'drizzle-orm';
import { type Database, schema as s } from '@src/infra/db';
import { type AdminApi, adminWith } from '../../support/admin-api';
import { type TestApp, createTestApp } from '../../support/app';
import { clearIdentityCaches } from '../../support/auth';
import { insertCategory, insertInventoryCodes, insertService, insertSupplierLink } from '../../support/catalog';
import { closeTestDb, resetDb, testDb } from '../../support/db';
import { catalogVersionOf } from '../../support/pricing';

let t: TestApp;
let db: Database;
let admin: AdminApi;
let categoryId: number;

beforeAll(async () => {
  ({ db } = await testDb());
  t = await createTestApp();
});
beforeEach(async () => {
  await resetDb();
  await clearIdentityCaches(t);
  admin = await adminWith(t, ['catalog:*', 'inventory:*', 'pricing:*'], { name: 'Rami K.' });
  categoryId = await insertCategory(db, { name: 'Gift cards', type: 'server' });
});
afterAll(async () => {
  await resetDb();
  await clearIdentityCaches(t);
  await t.close();
  await closeTestDb();
});

/** A server service of the gift-card category; every column can be overridden. */
const giftCard = (values: Partial<typeof s.services.$inferInsert> = {}) =>
  insertService(db, categoryId, { type: 'server', basePrice: '10.0000', minProfit: '0.5000', ...values });
const rowOf = async (id: number) => (await admin.get(`/admin/services/${id}`)).body as Record<string, unknown>;
const auditsOf = async (action: string) =>
  (await db.select().from(s.auditLogs).orderBy(asc(s.auditLogs.id))).filter((row) => row.action === action);
const codesOf = (serviceId: number) =>
  db.select().from(s.inventoryCodes).where(eq(s.inventoryCodes.serviceId, serviceId)).orderBy(asc(s.inventoryCodes.id));

describe('the service row', () => {
  it('says whether the service delivers from code stock, how many codes are available and its own cost', async () => {
    const stocked = await giftCard({ name: 'iTunes 10 USD', cost: '4.7000', effectiveCost: '4.7000' });
    await insertInventoryCodes(db, stocked, 3);
    // Reserved, sold and void codes are not available.
    await insertInventoryCodes(db, stocked, 1, { status: 'reserved' });
    await insertInventoryCodes(db, stocked, 2, { status: 'sold' });
    await insertInventoryCodes(db, stocked, 1, { status: 'void' });
    const plain = await giftCard({ name: 'Unlock' });

    const list = await admin.get('/admin/services?_sort=name&_order=asc');
    expect(list.status).toBe(200);
    expect(
      list.body.map((row: Record<string, unknown>) => [row.name, row.stockDelivery, row.stockAvailable, row.ownCost]),
    ).toEqual([
      ['iTunes 10 USD', true, 3, '4.7000'],
      ['Unlock', false, 0, '0.0000'],
    ]);
    expect(await rowOf(stocked)).toMatchObject({
      stockDelivery: true,
      stockAvailable: 3,
      ownCost: '4.7000',
      cost: '4.7000',
    });
    expect(await rowOf(plain)).toMatchObject({ stockDelivery: false, stockAvailable: 0, ownCost: '0.0000' });
  });

  it('filters the list by stockDelivery, an equality filter that combines with the others (the Inventory menu)', async () => {
    const stocked = await giftCard({ name: 'iTunes 10 USD', stockDelivery: true });
    const plain = await giftCard({ name: 'Unlock' });
    const ids = (body: Array<{ id: number }>) => body.map((row) => row.id);

    const on = await admin.get('/admin/services?stockDelivery=true');
    expect(on.status).toBe(200);
    expect(ids(on.body)).toEqual([stocked]);
    expect(on.total).toBe(1);
    const off = await admin.get('/admin/services?stockDelivery=false');
    expect(ids(off.body)).toEqual([plain]);
    expect(off.total).toBe(1);
    expect((await admin.get('/admin/services?stockDelivery=true&status=disabled')).body).toEqual([]);
    expect((await admin.get('/admin/services?stockDelivery=yes')).status).toBe(422);
  });
});

describe('POST /admin/services', () => {
  const body = (values: Record<string, unknown> = {}) => ({
    name: 'Google Play 25 USD',
    code: `GP-25-${crypto.randomUUID().slice(0, 6)}`,
    categoryId,
    type: 'server',
    slaMinutes: 5,
    basePrice: '27.5000',
    ...values,
  });

  it('creates a stock service with its own cost: the effective cost starts at it with no "cost changed" mark, and the audit holds both', async () => {
    const res = await admin.post('/admin/services', body({ stockDelivery: true, ownCost: '24.5000' }));
    expect(res.status).toBe(201);
    // The default minimum profit: max(6 % of 24.50, 0.02) = 1.47.
    expect(res.body).toMatchObject({
      stockDelivery: true,
      stockAvailable: 0,
      ownCost: '24.5000',
      cost: '24.5000',
      costChangedFrom: null,
      floorPrice: '25.9700',
      belowFloor: false,
    });
    const [audit] = await auditsOf('created service');
    expect(audit!.after).toMatchObject({ ownCost: '24.5000', stockDelivery: true });
  });

  it('starts without code stock and at a cost of 0 when the keys are left out, and refuses a negative own cost on the field', async () => {
    const res = await admin.post('/admin/services', body());
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ stockDelivery: false, stockAvailable: 0, ownCost: '0.0000', cost: '0.0000' });
    const refused = await admin.post('/admin/services', body({ ownCost: '-1.0000' }));
    expect(refused.status).toBe(422);
    expect(refused.body.errors[0].field).toBe('ownCost');
  });

  it('with an own cost, refuses a base price under the floor it sets exactly as a change does, and writes nothing', async () => {
    const refused = await admin.post('/admin/services', body({ ownCost: '27.0000', basePrice: '27.5000' }));
    expect(refused.status).toBe(422);
    expect(refused.body.code).toBe('VALIDATION_FAILED');
    // The default minimum profit: max(6 % of 27.00, 0.02) = 1.62.
    expect(refused.body.errors).toEqual([
      {
        field: 'basePrice',
        code: 'below_floor',
        message: 'Below the floor. Cost $27.00 plus minimum profit $1.62 is $28.62.',
      },
    ]);
    expect(await db.select().from(s.services)).toEqual([]);
    expect(await auditsOf('created service')).toEqual([]);

    // The same figures sent to a change get the same answer.
    const id = await giftCard({ basePrice: '27.5000', minProfit: null });
    const changed = await admin.patch(`/admin/services/${id}`, { ownCost: '27.0000', basePrice: '27.5000' });
    expect(changed.status).toBe(422);
    expect(changed.body.errors).toEqual(refused.body.errors);

    // An own cost of 0 sent is judged too (the floor is the least minimum profit, 0.02); with no own cost the new service costs 0 and its
    // base price is not judged, as before (the row says it is under the floor).
    const zero = await admin.post('/admin/services', body({ ownCost: '0.0000', basePrice: '0.0100' }));
    expect(zero.status).toBe(422);
    expect(zero.body.errors[0]).toMatchObject({ field: 'basePrice', code: 'below_floor' });
    const unjudged = await admin.post('/admin/services', body({ basePrice: '0.0100' }));
    expect(unjudged.status).toBe(201);
    expect(unjudged.body).toMatchObject({ cost: '0.0000', floorPrice: '0.0200', belowFloor: true });
    // At the floor is not under it.
    expect((await admin.post('/admin/services', body({ ownCost: '27.0000', basePrice: '28.6200' }))).status).toBe(201);
  });

  it('takes an own cost up to 1000000000.0000 (decision 051) and refuses anything above on the field with a 422', async () => {
    const edge = await admin.post(
      '/admin/services',
      body({ ownCost: '1000000000.0000', basePrice: '2000000000.0000' }),
    );
    expect(edge.status).toBe(201);
    // The default minimum profit: 6 % of 1,000,000,000.
    expect(edge.body).toMatchObject({
      ownCost: '1000000000.0000',
      cost: '1000000000.0000',
      floorPrice: '1060000000.0000',
      belowFloor: false,
    });
    for (const ownCost of ['1000000000.0001', '99999999999999.9999']) {
      const refused = await admin.post('/admin/services', body({ ownCost, basePrice: '2000000000.0000' }));
      expect(refused.status, ownCost).toBe(422);
      expect(refused.body.code).toBe('VALIDATION_FAILED');
      expect(refused.body.errors).toHaveLength(1);
      expect(refused.body.errors[0]).toMatchObject({ field: 'ownCost', message: 'Use at most 1000000000.0000.' });
    }
  });
});

describe('PATCH /admin/services/:id with stockDelivery', () => {
  it('refuses to turn it off while codes are available, names how many, and changes nothing', async () => {
    const id = await giftCard();
    const [first] = await insertInventoryCodes(db, id, 2);
    const refused = await admin.patch(`/admin/services/${id}`, { stockDelivery: false, name: 'Renamed' });
    expect(refused.status).toBe(422);
    expect(refused.body.errors).toEqual([
      { field: 'stockDelivery', code: 'codes_in_stock', message: 'Void the 2 codes in stock first.' },
    ]);
    expect(await rowOf(id)).toMatchObject({
      stockDelivery: true,
      stockAvailable: 2,
      name: expect.not.stringContaining('Renamed'),
    });

    expect((await admin.post('/admin/inventory-codes/void', { ids: [first] })).status).toBe(200);
    const one = await admin.patch(`/admin/services/${id}`, { stockDelivery: false });
    expect(one.body.errors[0].message).toBe('Void the 1 code in stock first.');
  });

  it('turns it off once no code is available (sold and void codes stay as history), and on again; the audit holds both values', async () => {
    const id = await giftCard();
    await insertInventoryCodes(db, id, 2, { status: 'sold' });
    await insertInventoryCodes(db, id, 1, { status: 'void' });
    const off = await admin.patch(`/admin/services/${id}`, { stockDelivery: false });
    expect(off.status).toBe(200);
    expect(off.body).toMatchObject({ stockDelivery: false, stockAvailable: 0 });
    const on = await admin.patch(`/admin/services/${id}`, { stockDelivery: true });
    expect(on.body).toMatchObject({ stockDelivery: true });
    const audits = await auditsOf('edited service');
    expect(
      audits.map((row) => [row.before, row.after].map((side) => (side as { stockDelivery: boolean }).stockDelivery)),
    ).toEqual([
      [true, false],
      [false, true],
    ]);
  });
});

describe('POST /admin/services/:id/inventory/import', () => {
  it('refuses codes for a service not delivered from code stock and stores nothing, then takes them once the flag is on', async () => {
    const id = await giftCard();
    const refused = await admin.post(`/admin/services/${id}/inventory/import`, {
      codes: ['ITUNES-0001', 'ITUNES-0002'],
    });
    expect(refused.status).toBe(422);
    expect(refused.body.errors).toEqual([
      {
        field: 'codes',
        code: 'not_stock_service',
        message: 'Turn on Delivered from code stock for this service first.',
      },
    ]);
    expect(await codesOf(id)).toEqual([]);
    expect(await auditsOf('imported inventory codes')).toEqual([]);

    expect((await admin.patch(`/admin/services/${id}`, { stockDelivery: true })).status).toBe(200);
    const imported = await admin.post(`/admin/services/${id}/inventory/import`, {
      codes: ['ITUNES-0001', 'ITUNES-0002'],
    });
    expect(imported.status).toBe(200);
    expect(imported.body.imported).toBe(2);
    expect(await rowOf(id)).toMatchObject({ stockDelivery: true, stockAvailable: 2 });
  });
});

describe('PATCH /admin/services/:id with ownCost', () => {
  it('moves the effective cost, the floor, the "cost changed" mark and the price version like a supplier cost change, and audits it', async () => {
    // A supplier link at 5.00 sets the effective cost; the own cost starts at 0.
    const id = await giftCard({ effectiveCost: '5.0000' });
    await insertSupplierLink(db, id, { credit: '5.0000' });
    const before = await catalogVersionOf(t);

    const raised = await admin.patch(`/admin/services/${id}`, { ownCost: '8.0000' });
    expect(raised.status).toBe(200);
    expect(raised.body).toMatchObject({
      ownCost: '8.0000',
      cost: '8.0000',
      costChangedFrom: '5.0000',
      floorPrice: '8.5000',
      belowFloor: false,
    });
    // The version moves after the commit: cached price lists, the price change scan and the follow pass start from the new cost.
    expect(await catalogVersionOf(t)).not.toBe(before);
    const [audit] = await auditsOf('edited service');
    expect(audit).toMatchObject({ entityId: id, before: { ownCost: '0.0000' }, after: { ownCost: '8.0000' } });

    // A second rise keeps the first previous cost; the base price is under the floor now, which the row says.
    expect((await admin.patch(`/admin/services/${id}`, { ownCost: '12.0000' })).body).toMatchObject({
      cost: '12.0000',
      costChangedFrom: '5.0000',
      floorPrice: '12.5000',
      belowFloor: true,
    });
    // Under the supplier's cost the effective cost is the supplier's again.
    expect((await admin.patch(`/admin/services/${id}`, { ownCost: '2.0000' })).body).toMatchObject({
      ownCost: '2.0000',
      cost: '5.0000',
      costChangedFrom: '5.0000',
    });
    const [stored] = await db.select().from(s.services).where(eq(s.services.id, id));
    expect(stored).toMatchObject({ cost: '2.0000', effectiveCost: '5.0000' });
  });

  it('judges a base price sent with it against the new floor, and writes nothing when it is under', async () => {
    const id = await giftCard();
    const refused = await admin.patch(`/admin/services/${id}`, { ownCost: '9.8000', basePrice: '10.0000' });
    expect(refused.status).toBe(422);
    expect(refused.body.errors[0]).toMatchObject({ field: 'basePrice', code: 'below_floor' });
    expect(await rowOf(id)).toMatchObject({ ownCost: '0.0000', cost: '0.0000', basePrice: '10.0000' });

    // A base price saved with it answers the "cost changed" mark at once (RESOLUTIONS catalog-14).
    const saved = await admin.patch(`/admin/services/${id}`, { ownCost: '9.0000', basePrice: '9.5000' });
    expect(saved.status).toBe(200);
    expect(saved.body).toMatchObject({ ownCost: '9.0000', cost: '9.0000', basePrice: '9.5000', costChangedFrom: null });
  });

  it('takes up to 1000000000.0000 (decision 051) and refuses anything above on the field with a 422, changing nothing', async () => {
    const id = await giftCard();
    const edge = await admin.patch(`/admin/services/${id}`, { ownCost: '1000000000.0000' });
    expect(edge.status).toBe(200);
    expect(edge.body).toMatchObject({
      ownCost: '1000000000.0000',
      cost: '1000000000.0000',
      floorPrice: '1000000000.5000',
      belowFloor: true,
    });
    for (const ownCost of ['1000000000.0001', '99999999999999.9999']) {
      const refused = await admin.patch(`/admin/services/${id}`, { ownCost });
      expect(refused.status, ownCost).toBe(422);
      expect(refused.body.errors).toHaveLength(1);
      expect(refused.body.errors[0]).toMatchObject({ field: 'ownCost', message: 'Use at most 1000000000.0000.' });
    }
    expect(await rowOf(id)).toMatchObject({ ownCost: '1000000000.0000', cost: '1000000000.0000' });
  });

  it('needs pricing:update, like the base price and the minimum profit (decision 046)', async () => {
    const id = await giftCard();
    const editor = await adminWith(t, ['catalog:read', 'catalog:update']);
    expect((await editor.patch(`/admin/services/${id}`, { ownCost: '1.0000' })).status).toBe(403);
    expect((await editor.patch(`/admin/services/${id}`, { stockDelivery: true })).status).toBe(200);
    expect(await rowOf(id)).toMatchObject({ ownCost: '0.0000', stockDelivery: true });
  });

  it('takes an own cost alone, and the same cost again writes nothing new', async () => {
    const id = await giftCard();
    expect((await admin.patch(`/admin/services/${id}`, { ownCost: '3.0000' })).body).toMatchObject({
      ownCost: '3.0000',
    });
    const [first] = await db.select().from(s.services).where(eq(s.services.id, id));
    expect((await admin.patch(`/admin/services/${id}`, { ownCost: '3.0000' })).body).toMatchObject({
      ownCost: '3.0000',
      cost: '3.0000',
      costChangedFrom: '0.0000',
    });
    const [second] = await db.select().from(s.services).where(eq(s.services.id, id));
    expect(second!.costWas).toBe(first!.costWas);
  });
});

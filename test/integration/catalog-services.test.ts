// Integration tests of the service routes (feature 4a): list with the worked-out figures and filters, show with parts, create,
// change (floor, cost_was, category/type invariant, code), archive-or-delete, and the effective cost function.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { eq } from 'drizzle-orm';
import { Money } from '../../src/common/money';
import { schema as s } from '../../src/infra/db';
import { defaultMinProfit, recomputeEffectiveCost } from '../../src/modules/catalog';
import { type AdminApi, adminWith } from '../support/admin-api';
import { type TestApp, createTestApp } from '../support/app';
import { clearIdentityCaches, insertMerchant } from '../support/auth';
import { insertCategory, insertService, insertSupplierLink } from '../support/catalog';
import { MINUTE, TestClock } from '../support/clock';
import { closeTestDb, resetDb, testDb } from '../support/db';
import { insertOrder, insertUsd } from '../support/fixtures';

const clock = new TestClock();
let t: TestApp;
let admin: AdminApi;

beforeAll(async () => {
  t = await createTestApp({ clock });
});
beforeEach(async () => {
  clock.reset();
  await resetDb();
  await clearIdentityCaches(t);
  admin = await adminWith(t, ['catalog:*'], { name: 'Rami K.' });
});
afterAll(async () => {
  await resetDb();
  await clearIdentityCaches(t);
  await t.close();
  await closeTestDb();
});

const auditRows = async () => (await testDb()).db.select().from(s.auditLogs).orderBy(s.auditLogs.id);
const serviceRow = async (id: number) =>
  (await (await testDb()).db.select().from(s.services).where(eq(s.services.id, id)))[0];

/** The demo's AT&T unlock: cost 13.5, price 17.28, own minimum profit 0.81. */
async function insertAtt(categoryId: number, values: Partial<typeof s.services.$inferInsert> = {}) {
  const { db } = await testDb();
  return insertService(db, categoryId, {
    name: 'AT&T USA Premier Unlock',
    code: 'IMEI-ATT-USA',
    cost: '13.5000',
    effectiveCost: '13.5000',
    basePrice: '17.2800',
    minProfit: '0.8100',
    slaMinutes: 1440,
    ...values,
  });
}

describe('GET /admin/services', () => {
  it('works out cost, minimum profit, floor, margin and below-floor in SQL, with the default minimum profit policy', async () => {
    const { db } = await testDb();
    const category = await insertCategory(db, { name: 'Carrier unlock' });
    const att = await insertAtt(category);
    const chrome = await insertService(db, category, {
      name: 'Chrome 1 month',
      code: 'SRV-CHM-1M',
      cost: '19.8000',
      effectiveCost: '19.8000',
      costWas: '17.0000',
      basePrice: '19.5000',
      minProfit: null,
    });

    const res = await admin.get('/admin/services?_start=0&_end=25&_sort=name&_order=asc');
    expect(res.status).toBe(200);
    expect(res.total).toBe(2);
    expect(res.body[0]).toEqual({
      id: att,
      name: 'AT&T USA Premier Unlock',
      code: 'IMEI-ATT-USA',
      type: 'imei',
      status: 'active',
      executionMode: 'auto',
      categoryId: category,
      category: { id: category, name: 'Carrier unlock' },
      basePrice: '17.2800',
      cost: '13.5000',
      costChangedFrom: null,
      minProfit: '0.8100',
      floorPrice: '14.3100',
      marginPct: '21.8750',
      belowFloor: false,
      slaMinutes: 1440,
      supplier: null,
      fallbackSupplier: null,
      // The merchant's cancel and verification are off until staff switch them on.
      allowCancel: false,
      allowVerify: false,
      verifyWindowH: 0,
    });
    // No own minimum profit: max(round(6 % of 19.80, 2), 0.02) = 1.19, so the floor is 20.99 and the price 19.50 is under it.
    expect(res.body[1]).toMatchObject({
      id: chrome,
      cost: '19.8000',
      costChangedFrom: '17.0000',
      minProfit: '1.1900',
      floorPrice: '20.9900',
      marginPct: '-1.5385',
      belowFloor: true,
    });
  });

  it('agrees with the domain rule for the default minimum profit on many costs', async () => {
    const { db } = await testDb();
    const category = await insertCategory(db);
    const costs = [
      '0.0000',
      '0.0800',
      '0.4159',
      '0.4167',
      '0.2475',
      '8.2500',
      '13.5000',
      '99.9999',
      '1234.5678',
      '0.0001',
    ];
    for (let i = 0; i < 25; i++) costs.push((Math.floor(Math.random() * 5_000_000) / 10_000).toFixed(4));
    const ids = new Map<number, string>();
    for (const cost of costs)
      ids.set(await insertService(db, category, { cost, effectiveCost: cost, minProfit: null }), cost);
    const res = await admin.get('/admin/services?_start=0&_end=100');
    expect(res.body.length).toBe(costs.length);
    for (const row of res.body) {
      const cost = Money.of(ids.get(row.id)!);
      expect(row.minProfit).toBe(defaultMinProfit(cost).toWire());
      expect(row.floorPrice).toBe(cost.add(defaultMinProfit(cost)).toWire());
    }
  });

  it('filters by type, status, category and below-floor, which combine, and hides archived services', async () => {
    const { db } = await testDb();
    const apple = await insertCategory(db, { name: 'Apple' });
    const server = await insertCategory(db, { name: 'Credits', type: 'server' });
    const ok = await insertService(db, apple, {
      name: 'Alpha',
      cost: '1.0000',
      effectiveCost: '1.0000',
      basePrice: '5.0000',
    });
    const low = await insertService(db, apple, {
      name: 'Bravo',
      cost: '5.0000',
      effectiveCost: '5.0000',
      basePrice: '5.0000',
    });
    const off = await insertService(db, apple, {
      name: 'Charlie',
      status: 'disabled',
      cost: '5.0000',
      effectiveCost: '5.0000',
      basePrice: '5.1000',
    });
    const credits = await insertService(db, server, { name: 'Delta', type: 'server' });
    await insertService(db, apple, { name: 'Gone', status: 'disabled', archivedAt: new Date() });
    const ids = (body: Array<{ id: number }>) => body.map((row) => row.id);

    expect(ids((await admin.get('/admin/services')).body)).toEqual([ok, low, off, credits]);
    expect(ids((await admin.get('/admin/services?type=server')).body)).toEqual([credits]);
    expect(ids((await admin.get('/admin/services?status=disabled')).body)).toEqual([off]);
    expect(ids((await admin.get(`/admin/services?categoryId=${apple}`)).body)).toEqual([ok, low, off]);
    expect(ids((await admin.get('/admin/services?belowFloor=true')).body)).toEqual([low, off]);
    expect(ids((await admin.get('/admin/services?belowFloor=false')).body)).toEqual([ok, credits]);
    // The header count of the console: below the floor and still active.
    const header = await admin.get('/admin/services?belowFloor=true&status=active&_start=0&_end=1');
    expect(header.total).toBe(1);
    expect(ids(header.body)).toEqual([low]);
    expect((await admin.get('/admin/services?type=phone')).status).toBe(422);
  });

  it('searches name, code and category name, and sorts by cost and base price on the effective cost', async () => {
    const { db } = await testDb();
    const apple = await insertCategory(db, { name: 'Apple' });
    const credits = await insertCategory(db, { name: 'Z3X credits', type: 'server' });
    const a = await insertService(db, apple, {
      name: 'Alpha',
      code: 'IMEI-A',
      cost: '2.0000',
      effectiveCost: '9.0000',
      basePrice: '12.0000',
    });
    const b = await insertService(db, apple, {
      name: 'Bravo',
      code: 'IMEI-B',
      cost: '3.0000',
      effectiveCost: '3.0000',
      basePrice: '4.0000',
    });
    const c = await insertService(db, credits, { name: 'Charlie', type: 'server', code: 'SRV-C' });
    const ids = (body: Array<{ id: number }>) => body.map((row) => row.id);
    expect(ids((await admin.get('/admin/services?q=alpha')).body)).toEqual([a]);
    expect(ids((await admin.get('/admin/services?q=imei-b')).body)).toEqual([b]);
    expect(ids((await admin.get('/admin/services?q=z3x')).body)).toEqual([c]);
    // The effective cost (9) is what sorts, not the stored cost (2).
    expect(ids((await admin.get('/admin/services?_sort=cost&_order=desc&q=imei')).body)).toEqual([a, b]);
    expect(ids((await admin.get('/admin/services?_sort=basePrice&_order=asc&q=imei')).body)).toEqual([b, a]);
    expect((await admin.get('/admin/services?_sort=code')).status).toBe(422);
  });

  it('shows the suppliers of the first two active links by priority', async () => {
    const { db } = await testDb();
    const category = await insertCategory(db);
    const id = await insertService(db, category);
    await insertSupplierLink(db, id, { supplier: 'Third', priority: 3 });
    await insertSupplierLink(db, id, { supplier: 'Second', priority: 2 });
    await insertSupplierLink(db, id, { supplier: 'Off', priority: 1, isActive: false });
    await insertSupplierLink(db, id, { supplier: 'First', priority: 1 });
    const res = await admin.get('/admin/services');
    expect(res.body[0].supplier.name).toBe('First');
    expect(res.body[0].fallbackSupplier.name).toBe('Second');
  });

  it('needs catalog:read', async () => {
    const other = await adminWith(t, ['groups:read']);
    expect((await other.get('/admin/services')).status).toBe(403);
  });
});

describe('GET /admin/services/:id', () => {
  it('shows the row with fields in order, options and group prices; archived and unknown services are 404', async () => {
    const { db } = await testDb();
    const category = await insertCategory(db);
    const id = await insertAtt(category);
    await db.insert(s.serviceFields).values([
      { serviceId: id, key: 'b', label: 'B', sort: 1 },
      {
        serviceId: id,
        key: 'a',
        label: 'A',
        sort: 0,
        fieldType: 'select',
        options: ['x', 'y'],
        required: true,
        supplierKey: 'user',
      },
    ]);
    await db.insert(s.serviceOptions).values([
      { serviceId: id, list: 'model', value: 'iphone15', label: 'iPhone 15' },
      { serviceId: id, list: 'network', value: 'att', label: 'AT&T', supplierValue: 'ATT' },
    ]);
    const [group] = await db.insert(s.clientGroups).values({ name: 'VIP' }).returning({ id: s.clientGroups.id });
    await db.insert(s.serviceGroupPrices).values({ serviceId: id, groupId: group!.id, price: '15.9' });

    const res = await admin.get(`/admin/services/${id}`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id, code: 'IMEI-ATT-USA', floorPrice: '14.3100' });
    expect(res.body.fields).toEqual([
      {
        key: 'a',
        label: 'A',
        fieldType: 'select',
        required: true,
        options: ['x', 'y'],
        regex: '',
        supplierKey: 'user',
      },
      { key: 'b', label: 'B', fieldType: 'text', required: false, options: [], regex: '', supplierKey: '' },
    ]);
    expect(res.body.options).toEqual([
      { list: 'model', value: 'iphone15', label: 'iPhone 15', supplierValue: '' },
      { list: 'network', value: 'att', label: 'AT&T', supplierValue: 'ATT' },
    ]);
    expect(res.body.groupPrices).toEqual([{ groupId: group!.id, price: '15.9000' }]);

    const archived = await insertService(db, category, { status: 'disabled', archivedAt: new Date() });
    expect((await admin.get(`/admin/services/${archived}`)).status).toBe(404);
    expect((await admin.get('/admin/services/999999')).body.code).toBe('NOT_FOUND');
  });
});

describe('POST /admin/services', () => {
  const body = (categoryId: number) => ({
    name: ' New Check ',
    code: ' IMEI-NEW-1 ',
    categoryId,
    type: 'imei',
    slaMinutes: 90,
    basePrice: '2.5000',
  });

  it('creates an active auto service with the server defaults, its figures and an audit row', async () => {
    const { db } = await testDb();
    const category = await insertCategory(db, { name: 'Apple' });
    const res = await admin.post('/admin/services', body(category));
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      name: 'New Check',
      code: 'IMEI-NEW-1',
      type: 'imei',
      status: 'active',
      executionMode: 'auto',
      categoryId: category,
      category: { id: category, name: 'Apple' },
      basePrice: '2.5000',
      cost: '0.0000',
      costChangedFrom: null,
      minProfit: '0.0200',
      floorPrice: '0.0200',
      marginPct: '100.0000',
      belowFloor: false,
      slaMinutes: 90,
      supplier: null,
      fallbackSupplier: null,
    });
    const row = (await serviceRow(res.body.id))!;
    expect(row).toMatchObject({
      priceMode: 'fixed',
      duplicateRule: 'block_open',
      fulfillment: 'auto',
      status: 'active',
      effectiveCost: '0.0000',
      cost: '0.0000',
      minProfit: null,
      deliveryTime: '1 h 30 min',
      archivedAt: null,
    });
    const [audit] = await auditRows();
    expect(audit).toMatchObject({
      actorId: admin.staffId,
      action: 'created service',
      entityType: 'service',
      entityId: res.body.id,
      entityLabel: 'New Check',
    });
  });

  it('accepts the merchant switches (cancel, verify and its window), stores them and audits them', async () => {
    const { db } = await testDb();
    const category = await insertCategory(db, { name: 'Apple' });
    const res = await admin.post('/admin/services', {
      ...body(category),
      allowCancel: true,
      allowVerify: true,
      verifyWindowH: 48,
    });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ allowCancel: true, allowVerify: true, verifyWindowH: 48 });
    expect(await serviceRow(res.body.id)).toMatchObject({ allowCancel: true, allowVerify: true, verifyWindowH: 48 });
    const [audit] = await auditRows();
    expect(audit).toMatchObject({ action: 'created service', entityType: 'service', entityId: res.body.id });
    expect(audit!.after).toMatchObject({ allowCancel: true, allowVerify: true, verifyWindowH: 48 });
  });

  it('keeps the switches off when the body leaves them out (the console never sends them)', async () => {
    const { db } = await testDb();
    const category = await insertCategory(db, { name: 'Apple' });
    const res = await admin.post('/admin/services', body(category));
    expect(res.body).toMatchObject({ allowCancel: false, allowVerify: false, verifyWindowH: 0 });
    expect(await serviceRow(res.body.id)).toMatchObject({ allowCancel: false, allowVerify: false, verifyWindowH: 0 });
  });

  it('refuses a verification window outside 0 to 720 hours, on the field', async () => {
    const { db } = await testDb();
    const category = await insertCategory(db, { name: 'Apple' });
    for (const verifyWindowH of [-1, 721, 1.5]) {
      const res = await admin.post('/admin/services', { ...body(category), verifyWindowH });
      expect(res.status, String(verifyWindowH)).toBe(422);
      expect(res.body.errors[0].field).toBe('verifyWindowH');
    }
    expect((await admin.post('/admin/services', { ...body(category), verifyWindowH: 720 })).status).toBe(201);
  });

  it('refuses a code another live service has, in any case, with the owner in the message (409 CODE_TAKEN)', async () => {
    const { db } = await testDb();
    const category = await insertCategory(db);
    await insertAtt(category);
    const res = await admin.post('/admin/services', { ...body(category), code: 'imei-att-usa' });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('CODE_TAKEN');
    expect(res.body.errors).toEqual([
      expect.objectContaining({
        field: 'code',
        message: 'The code imei-att-usa is already used by AT&T USA Premier Unlock.',
      }),
    ]);
  });

  it('answers 409 CODE_TAKEN, never 500, when two creates race on a code', async () => {
    const { db } = await testDb();
    const category = await insertCategory(db);
    const results = await Promise.all(Array.from({ length: 4 }, () => admin.post('/admin/services', body(category))));
    expect(results.map((r) => r.status).sort()).toEqual([201, 409, 409, 409]);
  });

  it('frees the code of an archived service', async () => {
    const { db } = await testDb();
    const category = await insertCategory(db);
    await insertService(db, category, { code: 'IMEI-NEW-1', status: 'disabled', archivedAt: new Date() });
    expect((await admin.post('/admin/services', body(category))).status).toBe(201);
  });

  it('refuses a type that differs from the category type, an unknown category and a price of zero, on the field', async () => {
    const { db } = await testDb();
    const category = await insertCategory(db, { name: 'Apple', type: 'imei' });
    const mismatch = await admin.post('/admin/services', { ...body(category), type: 'file' });
    expect(mismatch.status).toBe(422);
    expect(mismatch.body.errors).toEqual([
      expect.objectContaining({ field: 'categoryId', message: 'Apple holds imei services.' }),
    ]);
    const unknown = await admin.post('/admin/services', body(999999));
    expect(unknown.body.errors[0].field).toBe('categoryId');
    const zero = await admin.post('/admin/services', { ...body(category), basePrice: '0.0000' });
    expect(zero.status).toBe(422);
    expect(zero.body.errors[0].field).toBe('basePrice');
    const bad = await admin.post('/admin/services', {
      name: '',
      code: '',
      categoryId: category,
      type: 'imei',
      slaMinutes: 0,
      basePrice: '1',
    });
    expect(bad.body.errors.map((e: { field: string }) => e.field).sort()).toEqual([
      'basePrice',
      'code',
      'name',
      'slaMinutes',
    ]);
    expect(await db.select().from(s.services)).toEqual([]);
  });

  it('needs catalog:create', async () => {
    const other = await adminWith(t, ['catalog:read']);
    expect((await other.post('/admin/services', body(1))).status).toBe(403);
  });
});

describe('PATCH /admin/services/:id', () => {
  it('changes only the keys sent (the switches), derives the delivery time and audits the change', async () => {
    const { db } = await testDb();
    const category = await insertCategory(db);
    const id = await insertAtt(category);
    const off = await admin.patch(`/admin/services/${id}`, { status: 'disabled' });
    expect(off.body).toMatchObject({ status: 'disabled', basePrice: '17.2800', executionMode: 'auto' });
    expect((await admin.patch(`/admin/services/${id}`, { executionMode: 'manual' })).body.executionMode).toBe('manual');
    const renamed = await admin.patch(`/admin/services/${id}`, {
      name: 'AT&T Unlock',
      slaMinutes: 120,
      code: 'imei-att-usa',
    });
    expect(renamed.body).toMatchObject({ name: 'AT&T Unlock', slaMinutes: 120, code: 'imei-att-usa' });
    expect((await serviceRow(id))!.deliveryTime).toBe('2 hours');
    const audits = await auditRows();
    expect(audits.length).toBe(3);
    expect(audits[0]).toMatchObject({ action: 'edited service', entityType: 'service', entityId: id });
    expect(audits[0]!.before).toMatchObject({ status: 'active' });
    expect(audits[0]!.after).toMatchObject({ status: 'disabled' });
  });

  it('sets the merchant switches, changes them one by one and audits the change', async () => {
    const { db } = await testDb();
    const category = await insertCategory(db);
    const id = await insertAtt(category);
    const on = await admin.patch(`/admin/services/${id}`, { allowCancel: true, allowVerify: true, verifyWindowH: 24 });
    expect(on.status).toBe(200);
    expect(on.body).toMatchObject({ allowCancel: true, allowVerify: true, verifyWindowH: 24 });
    // Only the key sent changes; a window of 0 means no window.
    const window = await admin.patch(`/admin/services/${id}`, { verifyWindowH: 0 });
    expect(window.body).toMatchObject({ allowCancel: true, allowVerify: true, verifyWindowH: 0 });
    expect(await serviceRow(id)).toMatchObject({ allowCancel: true, allowVerify: true, verifyWindowH: 0 });
    const off = await admin.patch(`/admin/services/${id}`, { allowCancel: false });
    expect(off.body).toMatchObject({ allowCancel: false, allowVerify: true });
    const audits = await auditRows();
    expect(audits.map((row) => row.action)).toEqual(['edited service', 'edited service', 'edited service']);
    expect(audits[0]!.before).toMatchObject({ allowCancel: false, allowVerify: false, verifyWindowH: 0 });
    expect(audits[0]!.after).toMatchObject({ allowCancel: true, allowVerify: true, verifyWindowH: 24 });
    // The switches are part of the reads: the list and the detail say them too.
    const list = await admin.get('/admin/services?_start=0&_end=25');
    expect(list.body[0]).toMatchObject({ allowCancel: false, allowVerify: true, verifyWindowH: 0 });
    expect((await admin.get(`/admin/services/${id}`)).body).toMatchObject({ allowCancel: false, allowVerify: true });
  });

  it('refuses a verification window outside 0 to 720 hours, on the field', async () => {
    const { db } = await testDb();
    const id = await insertAtt(await insertCategory(db));
    for (const verifyWindowH of [-1, 721]) {
      const res = await admin.patch(`/admin/services/${id}`, { verifyWindowH });
      expect(res.status, String(verifyWindowH)).toBe(422);
      expect(res.body.errors[0].field).toBe('verifyWindowH');
    }
    expect((await admin.patch(`/admin/services/${id}`, { verifyWindowH: 720 })).status).toBe(200);
  });

  it('returns the floor and margin after a price change, and refuses a price under the floor on basePrice', async () => {
    const { db } = await testDb();
    const category = await insertCategory(db);
    const id = await insertAtt(category);
    const ok = await admin.patch(`/admin/services/${id}`, { basePrice: '15.0000' });
    expect(ok.body).toMatchObject({
      basePrice: '15.0000',
      floorPrice: '14.3100',
      marginPct: '10.0000',
      belowFloor: false,
    });
    const refused = await admin.patch(`/admin/services/${id}`, { basePrice: '14.0000' });
    expect(refused.status).toBe(422);
    expect(refused.body.errors).toEqual([
      expect.objectContaining({
        field: 'basePrice',
        message: 'Below the floor. Cost $13.50 plus minimum profit $0.81 is $14.31.',
      }),
    ]);
    expect((await serviceRow(id))!.basePrice).toBe('15.0000');
    // Exactly the floor is allowed.
    expect((await admin.patch(`/admin/services/${id}`, { basePrice: '14.3100' })).status).toBe(200);
    expect((await admin.patch(`/admin/services/${id}`, { basePrice: '0.0000' })).body.errors[0].field).toBe(
      'basePrice',
    );
    void db;
  });

  it('checks the price against the minimum profit being saved, and null goes back to the default policy', async () => {
    const { db } = await testDb();
    const category = await insertCategory(db);
    const id = await insertAtt(category);
    // A higher minimum profit raises the floor in the same request: 13.50 + 2.00 = 15.50.
    const refused = await admin.patch(`/admin/services/${id}`, { basePrice: '15.0000', minProfit: '2.0000' });
    expect(refused.body.errors[0].message).toBe('Below the floor. Cost $13.50 plus minimum profit $2.00 is $15.50.');
    // Saving only the minimum profit may leave the price under the new floor.
    const profit = await admin.patch(`/admin/services/${id}`, { minProfit: '2.0000' });
    expect(profit.body).toMatchObject({ minProfit: '2.0000', floorPrice: '15.5000', belowFloor: false });
    const lower = await admin.patch(`/admin/services/${id}`, { minProfit: '5.0000' });
    expect(lower.status).toBe(200);
    expect(lower.body.belowFloor).toBe(true);
    // null: the default policy, 6 % of 13.50 = 0.81.
    const reset = await admin.patch(`/admin/services/${id}`, { minProfit: null });
    expect(reset.body).toMatchObject({ minProfit: '0.8100', floorPrice: '14.3100' });
    expect((await serviceRow(id))!.minProfit).toBeNull();
    expect((await admin.patch(`/admin/services/${id}`, { minProfit: '-1.0000' })).body.errors[0].field).toBe(
      'minProfit',
    );
    void db;
  });

  it('clears costChangedFrom when a base price is saved, not for a minimum-profit-only change', async () => {
    const { db } = await testDb();
    const category = await insertCategory(db);
    const id = await insertAtt(category, { costWas: '12.0000' });
    expect((await admin.patch(`/admin/services/${id}`, { minProfit: '0.5000' })).body.costChangedFrom).toBe('12.0000');
    expect((await admin.patch(`/admin/services/${id}`, { basePrice: '17.2800' })).body.costChangedFrom).toBeNull();
    expect((await serviceRow(id))!.costWas).toBeNull();
    void db;
  });

  it('uses the cost of the first active supplier link as the effective cost for the floor', async () => {
    const { db } = await testDb();
    const category = await insertCategory(db);
    const id = await insertAtt(category);
    // The supplier now charges 20 credits at 1.1 = 22.00, above the service cost of 13.50.
    await insertSupplierLink(db, id, { credit: '20', creditRate: '1.1' });
    const refused = await admin.patch(`/admin/services/${id}`, { basePrice: '22.5000' });
    // 22.00 + the own minimum profit 0.81 = 22.81.
    expect(refused.status).toBe(422);
    expect(refused.body.errors[0].message).toBe('Below the floor. Cost $22.00 plus minimum profit $0.81 is $22.81.');
    const ok = await admin.patch(`/admin/services/${id}`, { basePrice: '23.0000' });
    expect(ok.body).toMatchObject({ cost: '22.0000', floorPrice: '22.8100', costChangedFrom: null });
  });

  it('keeps the category and the type in agreement, naming the field that was sent', async () => {
    const { db } = await testDb();
    const apple = await insertCategory(db, { name: 'Apple', type: 'imei' });
    const files = await insertCategory(db, { name: 'Files', type: 'file' });
    const id = await insertAtt(apple);
    const byCategory = await admin.patch(`/admin/services/${id}`, { categoryId: files });
    expect(byCategory.status).toBe(422);
    expect(byCategory.body.errors).toEqual([
      expect.objectContaining({ field: 'categoryId', message: 'Files holds file services.' }),
    ]);
    const byType = await admin.patch(`/admin/services/${id}`, { type: 'file' });
    expect(byType.body.errors).toEqual([
      expect.objectContaining({ field: 'type', message: 'Apple holds imei services.' }),
    ]);
    const both = await admin.patch(`/admin/services/${id}`, { categoryId: files, type: 'file' });
    expect(both.status).toBe(200);
    expect(both.body).toMatchObject({ categoryId: files, type: 'file', category: { id: files, name: 'Files' } });
    expect((await admin.patch(`/admin/services/${id}`, { categoryId: 999999 })).body.errors[0].field).toBe(
      'categoryId',
    );
  });

  it('refuses a code another live service has (409), allows its own, and answers 404 for archived and unknown services', async () => {
    const { db } = await testDb();
    const category = await insertCategory(db);
    const id = await insertAtt(category);
    await insertService(db, category, { code: 'OTHER-1', name: 'Other' });
    const taken = await admin.patch(`/admin/services/${id}`, { code: 'other-1' });
    expect(taken.status).toBe(409);
    expect(taken.body.code).toBe('CODE_TAKEN');
    expect(taken.body.errors[0].message).toBe('The code other-1 is already used by Other.');
    expect((await admin.patch(`/admin/services/${id}`, { code: 'IMEI-ATT-USA' })).status).toBe(200);
    const archived = await insertService(db, category, { status: 'disabled', archivedAt: new Date() });
    expect((await admin.patch(`/admin/services/${archived}`, { name: 'X' })).status).toBe(404);
    expect((await admin.patch('/admin/services/999999', { name: 'X' })).status).toBe(404);
    expect((await admin.patch(`/admin/services/${id}`, {})).status).toBe(422);
  });

  it('needs catalog:update', async () => {
    const other = await adminWith(t, ['catalog:read', 'catalog:create']);
    expect((await other.patch('/admin/services/1', { name: 'X' })).status).toBe(403);
  });
});

describe('DELETE /admin/services/:id', () => {
  it('hard deletes a service nothing refers to, with its parts and its service pricing rules', async () => {
    const { db } = await testDb();
    const category = await insertCategory(db);
    const id = await insertAtt(category);
    const other = await insertService(db, category);
    await db.insert(s.serviceFields).values({ serviceId: id, key: 'a', label: 'A' });
    await db.insert(s.serviceOptions).values({ serviceId: id, list: 'model', value: 'x', label: 'X' });
    const [group] = await db.insert(s.clientGroups).values({ name: 'VIP' }).returning({ id: s.clientGroups.id });
    await db.insert(s.serviceGroupPrices).values({ serviceId: id, groupId: group!.id, price: '5' });
    const rules = await db
      .insert(s.pricingRules)
      .values([
        { scope: 'service', targetId: id, kind: 'discount', percent: '2' },
        { scope: 'service', targetId: other, kind: 'discount', percent: '2' },
      ])
      .returning({ id: s.pricingRules.id });

    const res = await admin.delete(`/admin/services/${id}`);
    expect(res.status).toBe(204);
    expect((await db.select().from(s.services)).map((row) => row.id)).toEqual([other]);
    expect(await db.select().from(s.serviceFields)).toEqual([]);
    expect(await db.select().from(s.serviceOptions)).toEqual([]);
    expect(await db.select().from(s.serviceGroupPrices)).toEqual([]);
    expect((await db.select().from(s.pricingRules)).map((r) => r.id)).toEqual([rules[1]!.id]);
    const [audit] = await auditRows();
    expect(audit).toMatchObject({
      action: 'deleted service',
      entityType: 'service',
      entityId: id,
      entityLabel: 'AT&T USA Premier Unlock',
    });
    expect(audit!.before).toMatchObject({ removedPricingRuleIds: [rules[0]!.id] });
    expect((await admin.delete(`/admin/services/${id}`)).status).toBe(404);
  });

  /** Each kind of reference makes the delete an archive. */
  const references: Array<[string, (serviceId: number) => Promise<void>]> = [
    [
      'an order',
      async (serviceId) => {
        const { db } = await testDb();
        await insertUsd(db);
        const clientId = await insertMerchant(db);
        await insertOrder(db, { clientId, serviceId });
      },
    ],
    [
      'a supplier link',
      async (serviceId) => {
        await insertSupplierLink((await testDb()).db, serviceId);
      },
    ],
    [
      'an inventory code',
      async (serviceId) => {
        await (
          await testDb()
        ).db
          .insert(s.inventoryCodes)
          .values({ serviceId, codeEnc: 'x', codeHash: 'h', codeLast4: '1234', batchRef: 'B-0001' });
      },
    ],
    [
      'a storefront listing',
      async (serviceId) => {
        await (await testDb()).db.insert(s.serviceListings).values({ serviceId, slug: 'att', publicTitle: 'AT&T' });
      },
    ],
    [
      'a help article',
      async (serviceId) => {
        await (
          await testDb()
        ).db
          .insert(s.helpArticles)
          .values({ category: 'Unlock', question: 'How?', answerMd: 'Like this', serviceId });
      },
    ],
  ];
  for (const [name, refer] of references) {
    it(`archives a service that has ${name}: disabled, hidden everywhere, rules off, code freed`, async () => {
      const { db } = await testDb();
      const category = await insertCategory(db);
      const id = await insertAtt(category);
      await refer(id);
      const [rule] = await db
        .insert(s.pricingRules)
        .values({ scope: 'service', targetId: id, kind: 'discount', percent: '2' })
        .returning({ id: s.pricingRules.id });
      await db.insert(s.serviceFields).values({ serviceId: id, key: 'a', label: 'A' });
      clock.advance(5 * MINUTE);

      const res = await admin.delete(`/admin/services/${id}`);
      expect(res.status).toBe(204);
      const row = (await serviceRow(id))!;
      expect(row.status).toBe('disabled');
      expect(row.archivedAt?.getTime()).toBe(clock.nowMs());
      expect((await db.select().from(s.pricingRules).where(eq(s.pricingRules.id, rule!.id)))[0]!.isActive).toBe(false);
      expect(await db.select().from(s.serviceFields)).toHaveLength(1);

      expect((await admin.get('/admin/services')).total).toBe(0);
      expect((await admin.get(`/admin/services/${id}`)).status).toBe(404);
      expect((await admin.patch(`/admin/services/${id}`, { name: 'X' })).status).toBe(404);
      expect((await admin.put(`/admin/services/${id}/fields`, { fields: [] })).status).toBe(404);
      expect((await admin.put(`/admin/services/${id}/options`, { options: [] })).status).toBe(404);
      expect((await admin.delete(`/admin/services/${id}`)).status).toBe(404);
      // The code is free again for a new live service.
      const again = await admin.post('/admin/services', {
        name: 'Again',
        code: 'IMEI-ATT-USA',
        categoryId: category,
        type: 'imei',
        slaMinutes: 5,
        basePrice: '3.0000',
      });
      expect(again.status).toBe(201);
      const [audit] = (await auditRows()).slice(0, 1);
      expect(audit).toMatchObject({ action: 'archived service', entityType: 'service', entityId: id });
      expect(audit!.after).toMatchObject({ status: 'disabled', deactivatedPricingRuleIds: [rule!.id] });
    });
  }

  it('answers 404 for an unknown service and needs catalog:delete', async () => {
    expect((await admin.delete('/admin/services/999999')).status).toBe(404);
    const other = await adminWith(t, ['catalog:read', 'catalog:update']);
    expect((await other.delete('/admin/services/1')).status).toBe(403);
  });
});

describe('recomputeEffectiveCost', () => {
  it('takes the larger of the cost and the first active link cost, keeps the first previous cost and skips unchanged services', async () => {
    const { db } = await testDb();
    const category = await insertCategory(db);
    const id = await insertService(db, category, { cost: '5.0000', effectiveCost: '5.0000' });
    const untouched = await insertService(db, category, { cost: '1.0000', effectiveCost: '1.0000' });

    // No link: the cost itself.
    expect(await recomputeEffectiveCost(db, [id, untouched])).toEqual([]);
    // First active link by priority: 4 credits at 2.5 = 10.00.
    await insertSupplierLink(db, id, { credit: '4', creditRate: '2.5', priority: 2 });
    await insertSupplierLink(db, id, { credit: '100', creditRate: '9', priority: 1, isActive: false });
    expect(await recomputeEffectiveCost(db, [id, untouched, id])).toEqual([id]);
    expect(await serviceRow(id)).toMatchObject({ effectiveCost: '10.0000', costWas: '5.0000', cost: '5.0000' });
    // A cheaper link by priority: the effective cost falls to the service cost, cost_was stays.
    const cheap = await insertSupplierLink(db, id, { credit: '1', creditRate: '1', priority: 0 });
    await recomputeEffectiveCost(db, [id]);
    expect(await serviceRow(id)).toMatchObject({ effectiveCost: '5.0000', costWas: '5.0000' });
    // A later rise keeps the first previous value (coalesce): the cheap link now charges 7 credits.
    await db
      .update(s.supplierServices)
      .set({ credit: '7.0000' })
      .where(eq(s.supplierServices.id, cheap.supplierServiceId));
    await recomputeEffectiveCost(db, [id]);
    expect(await serviceRow(id)).toMatchObject({ effectiveCost: '7.0000', costWas: '5.0000' });
    expect(await recomputeEffectiveCost(db, [])).toEqual([]);
  });

  it('rounds the supplier cost half-up to four decimals', async () => {
    const { db } = await testDb();
    const category = await insertCategory(db);
    const id = await insertService(db, category, { cost: '0.0000', effectiveCost: '0.0000' });
    // 3.3333 credits x 1.12345678 = 3.74482... -> 3.7448 ; and a half case: 1.0001 x 1.5 = 1.50015 -> 1.5002
    await insertSupplierLink(db, id, { credit: '1.0001', creditRate: '1.5' });
    await recomputeEffectiveCost(db, [id]);
    expect((await serviceRow(id))!.effectiveCost).toBe('1.5002');
  });
});

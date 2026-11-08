// Integration tests of the staff IMEI log (feature 18, GET /admin/imei-checks and /:id, RESOLUTIONS b2c-3, b2c-4, B78): the decrypted
// IMEI, the mask of an erased one, the order, customer and supplier joins, the filters, the sorts and the search by IMEI, TAC and text.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { eq } from 'drizzle-orm';
import { schema as s } from '../../src/infra/db';
import { type AdminApi, adminWith } from '../support/admin-api';
import { type TestApp, createTestApp } from '../support/app';
import { clearIdentityCaches } from '../support/auth';
import { insertSupplierLink } from '../support/catalog';
import { closeTestDb, resetDb, testDb } from '../support/db';
import { type OrdersWorld, ordersWorld } from '../support/orders';
import { insertHeldOrder, insertImeiCheck } from '../support/risk';

let t: TestApp;
let staff: AdminApi;
let world: OrdersWorld;

beforeAll(async () => {
  t = await createTestApp();
});
beforeEach(async () => {
  await resetDb();
  await clearIdentityCaches(t);
  world = await ordersWorld((await testDb()).db);
  staff = await adminWith(t, ['risk:read']);
});
afterAll(async () => {
  await resetDb();
  await clearIdentityCaches(t);
  await t.close();
  await closeTestDb();
});

const IMEI_A = '353890113898412';
const IMEI_B = '354607111076240';
const IMEI_C = '352905112490861';

describe('GET /admin/imei-checks', () => {
  it('answers the decrypted IMEI and the shape the console reads, newest first', async () => {
    const { db } = world;
    await insertImeiCheck(t, db, IMEI_A, {
      tac: null,
      country: 'GB',
      ip: '203.0.113.25',
      result: { stage: 'basic', checksum: 'valid' },
      createdAt: new Date('2026-11-07T10:00:00.000Z'),
    });
    await insertImeiCheck(t, db, IMEI_B, {
      model: 'Galaxy S23',
      brand: 'Samsung',
      createdAt: new Date('2026-11-08T10:00:00.000Z'),
    });
    const res = await staff.get('/admin/imei-checks');
    expect(res.status).toBe(200);
    expect(res.total).toBe(2);
    expect(res.res.headers['cache-control']).toBe('no-store');
    expect(res.body.map((row: { imei: string }) => row.imei)).toEqual([IMEI_B, IMEI_A]);
    expect(res.body[1]).toMatchObject({
      brand: 'Apple',
      model: 'iPhone 13',
      checkType: 'basic',
      status: 'unknown',
      source: 'storefront_free',
      country: 'GB',
      ip: '203.0.113.25',
      orderId: null,
      customer: null,
      supplier: null,
      result: { stage: 'basic', checksum: 'valid' },
      cost: '0.0000',
      price: '0.0000',
      cachedUntil: null,
    });
    expect(res.body[0].updatedAt).toBeUndefined();
  });

  it('shows the TAC and bullets for an erased IMEI, and fifteen bullets when the TAC is unknown', async () => {
    const { db } = world;
    await db.insert(s.tacCatalog).values({ tac: '35389011', brand: 'Apple', model: 'A2633', source: 'test' });
    const known = await insertImeiCheck(t, db, IMEI_A, { tac: '35389011' });
    const unknown = await insertImeiCheck(t, db, IMEI_B);
    await db
      .update(s.imeiChecks)
      .set({ imeiEnc: null, imeiHash: null, cachedUntil: null })
      .where(eq(s.imeiChecks.id, known.id));
    await db.update(s.imeiChecks).set({ imeiEnc: null, imeiHash: null }).where(eq(s.imeiChecks.id, unknown.id));
    const one = await staff.get(`/admin/imei-checks/${known.id}`);
    expect(one.body.imei).toBe('35389011•••••••');
    expect(one.body.imei).toHaveLength(15);
    expect((await staff.get(`/admin/imei-checks/${unknown.id}`)).body.imei).toBe('•'.repeat(15));
  });

  it('joins the order the check led to, the customer and the supplier', async () => {
    const { db } = world;
    const held = await insertHeldOrder(world, { imei: IMEI_A });
    const link = await insertSupplierLink(db, world.auto.serviceId, { supplier: 'UnlockBase' });
    const check = await insertImeiCheck(t, db, IMEI_A, {
      customerId: held.customerId,
      checkoutSessionId: held.sessionId,
      supplierId: link.supplierId,
      source: 'pre_order',
      checkType: 'blacklist',
      status: 'clean',
      cost: '0.0400',
    });
    const res = await staff.get(`/admin/imei-checks/${check.id}`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      orderId: held.orderId,
      customer: { id: held.customerId, name: 'Jack Turner' },
      supplier: { id: link.supplierId, name: 'UnlockBase' },
      source: 'pre_order',
      cost: '0.0400',
    });
  });

  it('filters by check type, status and source, sorts and pages', async () => {
    const { db } = world;
    await insertImeiCheck(t, db, IMEI_A, {
      checkType: 'blacklist',
      status: 'blacklisted',
      source: 'pre_order',
      model: 'B',
      createdAt: new Date('2026-11-01T00:00:00.000Z'),
    });
    await insertImeiCheck(t, db, IMEI_B, {
      checkType: 'icloud',
      status: 'clean',
      model: 'A',
      createdAt: new Date('2026-11-02T00:00:00.000Z'),
    });
    await insertImeiCheck(t, db, IMEI_C, {
      checkType: 'basic',
      status: 'unknown',
      model: 'C',
      createdAt: new Date('2026-11-03T00:00:00.000Z'),
    });
    expect((await staff.get('/admin/imei-checks?status=blacklisted')).total).toBe(1);
    expect((await staff.get('/admin/imei-checks?source=pre_order')).body[0].imei).toBe(IMEI_A);
    expect((await staff.get('/admin/imei-checks?checkType=icloud&checkType=basic')).total).toBe(2);
    expect(
      (await staff.get('/admin/imei-checks?_sort=model&_order=asc')).body.map((row: { model: string }) => row.model),
    ).toEqual(['A', 'B', 'C']);
    expect((await staff.get('/admin/imei-checks?_sort=status&_order=desc')).status).toBe(200);
    const page = await staff.get('/admin/imei-checks?_start=1&_end=2');
    expect(page.body).toHaveLength(1);
    expect(page.total).toBe(3);
    // The console's four count calls.
    expect((await staff.get('/admin/imei-checks?_start=0&_end=1')).total).toBe(3);
    expect((await staff.get('/admin/imei-checks?status=bogus')).status).toBe(422);
  });

  it('searches a full IMEI through its hash, a TAC or a longer start of it, and text through brand and model', async () => {
    const { db } = world;
    await db.insert(s.tacCatalog).values([
      { tac: '35389011', brand: 'Apple', model: 'A2633', source: 'test' },
      { tac: '35460711', brand: 'Google', model: 'GVU6C', source: 'test' },
    ]);
    await insertImeiCheck(t, db, IMEI_A, { tac: '35389011', brand: 'Apple', model: 'iPhone 13' });
    await insertImeiCheck(t, db, IMEI_B, { tac: '35460711', brand: 'Google', model: 'Pixel 7' });
    const ids = async (q: string) =>
      (await staff.get(`/admin/imei-checks?q=${encodeURIComponent(q)}`)).body.map((row: { imei: string }) => row.imei);
    expect(await ids(IMEI_A)).toEqual([IMEI_A]);
    expect(await ids('35 389011 3898412')).toEqual([IMEI_A]);
    expect(await ids('35389011')).toEqual([IMEI_A]);
    expect(await ids('3538901138')).toEqual([IMEI_A]);
    expect(await ids('3546')).toEqual([IMEI_B]);
    expect(await ids('pixel')).toEqual([IMEI_B]);
    expect(await ids('APPLE')).toEqual([IMEI_A]);
    expect(await ids('353890113898499')).toEqual([]);
    expect(await ids('100%')).toEqual([]);
  });

  it('does not match an erased IMEI by its number any more', async () => {
    const { db } = world;
    const check = await insertImeiCheck(t, db, IMEI_A);
    await db.update(s.imeiChecks).set({ imeiEnc: null, imeiHash: null }).where(eq(s.imeiChecks.id, check.id));
    expect((await staff.get(`/admin/imei-checks?q=${IMEI_A}`)).body).toEqual([]);
  });

  it('answers 404 for an unknown check and needs risk:read', async () => {
    expect((await staff.get('/admin/imei-checks/999999')).status).toBe(404);
    const none = await adminWith(t, ['risk:create']);
    expect((await none.get('/admin/imei-checks')).status).toBe(403);
    expect((await none.get('/admin/imei-checks/1')).status).toBe(403);
  });
});

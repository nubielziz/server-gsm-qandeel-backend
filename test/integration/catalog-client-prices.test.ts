// Integration tests of the client price routes (feature 4b): list with the service join, floor and groupPrice (catalog-16),
// create (floor of the merchant's group, PRICE_EXISTS, unknown service, merchant, turned-off service), change, delete, audit with
// the demo's verbs, permissions and the price version.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { eq } from 'drizzle-orm';
import { schema as s } from '../../src/infra/db';
import { type AdminApi, adminWith } from '../support/admin-api';
import { type TestApp, createTestApp } from '../support/app';
import { clearIdentityCaches } from '../support/auth';
import { insertService } from '../support/catalog';
import { closeTestDb, resetDb, testDb } from '../support/db';
import {
  catalogVersionOf,
  insertAtt,
  insertClientPriceRow,
  insertDemoGroups,
  insertGroupPrice,
  insertMerchantIn,
  insertRule,
} from '../support/pricing';

let t: TestApp;
let admin: AdminApi;

beforeAll(async () => {
  t = await createTestApp();
});
beforeEach(async () => {
  await resetDb();
  await clearIdentityCaches(t);
  admin = await adminWith(t, ['pricing:*'], { name: 'Rami K.' });
});
afterAll(async () => {
  await resetDb();
  await clearIdentityCaches(t);
  await t.close();
  await closeTestDb();
});

const auditRows = async () => (await testDb()).db.select().from(s.auditLogs).orderBy(s.auditLogs.id);
const priceRow = async (id: number) =>
  (await (await testDb()).db.select().from(s.serviceClientPrices).where(eq(s.serviceClientPrices.id, id)))[0];

/** The demo: Cairo (VIP) and Erbil (Standard) with the AT&T unlock, a VIP group price of 15.90 and the 2 % category promo. */
async function world() {
  const { db } = await testDb();
  const groups = await insertDemoGroups(db);
  const { categoryId, serviceId } = await insertAtt(db);
  await insertGroupPrice(db, serviceId, groups.vip, '15.9000');
  await insertRule(db, { scope: 'category', targetId: categoryId, kind: 'discount', percent: '2' });
  const cairo = await insertMerchantIn(db, groups.vip, { name: 'Cairo' });
  const erbil = await insertMerchantIn(db, groups.standard, { name: 'Erbil' });
  return { db, groups, categoryId, serviceId, cairo, erbil };
}

describe('GET /admin/client-prices', () => {
  it("lists a merchant's prices with the service, its floor and what the merchant pays without the override", async () => {
    const { db, serviceId, cairo, erbil, categoryId } = await world();
    const priceId = await insertClientPriceRow(db, serviceId, cairo, '15.2000', 'Agreed');
    const other = await insertService(db, categoryId, {
      name: 'Z other',
      code: 'OTHER',
      basePrice: '2.0000',
      cost: '1',
      effectiveCost: '1',
    });
    await insertClientPriceRow(db, other, erbil, '2.0000');

    const res = await admin.get(`/admin/client-prices?clientId=${cairo}&_start=0&_end=200`);
    expect(res.status).toBe(200);
    expect(res.total).toBe(1);
    expect(res.body).toEqual([
      {
        id: priceId,
        serviceId,
        clientId: cairo,
        price: '15.2000',
        note: 'Agreed',
        createdAt: expect.any(String),
        service: {
          id: serviceId,
          name: 'AT&T USA Premier Unlock',
          type: 'imei',
          basePrice: '17.2800',
          floorPrice: '14.3100',
        },
        // VIP group price 15.90 (fixed, no rule or discount), not the client price.
        groupPrice: '15.9000',
      },
    ]);
  });

  it('shows groupPrice after rule, discount and rounding for a group without a fixed price (catalog-16)', async () => {
    const { db, serviceId, erbil } = await world();
    await insertClientPriceRow(db, serviceId, erbil, '15.0000');
    const res = await admin.get(`/admin/client-prices?clientId=${erbil}`);
    // Standard: 17.28 x 0.98 = 16.9344, rounded to 16.93.
    expect(res.body[0].groupPrice).toBe('16.9300');
  });

  it('filters by serviceId, sorts by service name (default) and by price, searches the service, and hides archived services', async () => {
    const { db, serviceId, cairo, categoryId } = await world();
    const b = await insertService(db, categoryId, {
      name: 'Bravo',
      code: 'BRV',
      basePrice: '5.0000',
      cost: '1',
      effectiveCost: '1',
    });
    const a = await insertService(db, categoryId, {
      name: 'Alpha',
      code: 'ALP',
      basePrice: '9.0000',
      cost: '1',
      effectiveCost: '1',
    });
    const gone = await insertService(db, categoryId, {
      name: 'Archived one',
      code: 'GONE',
      basePrice: '3.0000',
      status: 'disabled',
      archivedAt: new Date(),
    });
    await insertClientPriceRow(db, serviceId, cairo, '15.2000');
    await insertClientPriceRow(db, b, cairo, '4.0000');
    await insertClientPriceRow(db, a, cairo, '8.0000');
    await insertClientPriceRow(db, gone, cairo, '2.0000');

    const byName = await admin.get(`/admin/client-prices?clientId=${cairo}`);
    expect(byName.total).toBe(3);
    expect(byName.body.map((row: { service: { name: string } }) => row.service.name)).toEqual([
      'Alpha',
      'AT&T USA Premier Unlock',
      'Bravo',
    ]);
    const byPrice = await admin.get(`/admin/client-prices?clientId=${cairo}&_sort=price&_order=desc`);
    expect(byPrice.body.map((row: { price: string }) => row.price)).toEqual(['15.2000', '8.0000', '4.0000']);
    expect((await admin.get(`/admin/client-prices?serviceId=${b}`)).body).toHaveLength(1);
    expect((await admin.get(`/admin/client-prices?q=brv`)).body).toHaveLength(1);
    expect((await admin.get(`/admin/client-prices?_sort=nope`)).status).toBe(422);
  });

  it('needs pricing:read', async () => {
    const limited = await adminWith(t, ['catalog:read']);
    expect((await limited.get('/admin/client-prices')).status).toBe(403);
  });
});

describe('POST /admin/client-prices', () => {
  it('creates a fixed price, answers 201 with the joins, records the staff member and audits like the demo', async () => {
    const { serviceId, erbil } = await world();
    const res = await admin.post('/admin/client-prices', {
      clientId: erbil,
      serviceId,
      price: '15.2000',
      note: 'Agreed on the call',
    });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      serviceId,
      clientId: erbil,
      price: '15.2000',
      note: 'Agreed on the call',
      service: { id: serviceId, basePrice: '17.2800', floorPrice: '14.3100' },
      groupPrice: '16.9300',
    });
    expect((await priceRow(res.body.id))?.createdBy).toBe(admin.staffId);
    const [audit] = await auditRows();
    expect(audit).toMatchObject({
      action: 'set client price for',
      entityType: 'merchant',
      entityId: erbil,
      entityLabel: 'Erbil, IMEI-ATT-USA',
    });
    expect(audit?.after).toEqual({ price: '15.2000', note: 'Agreed on the call' });
  });

  it('allows a price at the floor and omits an empty note', async () => {
    const { serviceId, erbil } = await world();
    const res = await admin.post('/admin/client-prices', { clientId: erbil, serviceId, price: '14.3100' });
    expect(res.status).toBe(201);
    expect(res.body.note).toBe('');
  });

  it("refuses a price under the floor of the merchant's group with the demo wording on price", async () => {
    const { db, serviceId, erbil, cairo, categoryId } = await world();
    // A rule that asks for a bigger minimum profit for VIP only; the service's own 0.81 still wins, so clear it first.
    await db.update(s.services).set({ minProfit: null }).where(eq(s.services.id, serviceId));
    await insertRule(db, {
      scope: 'category',
      targetId: categoryId,
      groupId: (await db.select().from(s.clients).where(eq(s.clients.id, cairo)))[0]!.groupId,
      minProfit: '4',
    });

    const standard = await admin.post('/admin/client-prices', { clientId: erbil, serviceId, price: '14.3000' });
    expect(standard.status).toBe(422);
    expect(standard.body.errors).toEqual([
      {
        field: 'price',
        code: 'below_floor',
        message: 'Below the floor of $14.31 (cost $13.50 plus $0.81 minimum profit).',
      },
    ]);
    const vip = await admin.post('/admin/client-prices', { clientId: cairo, serviceId, price: '15.9000' });
    expect(vip.status).toBe(422);
    expect(vip.body.errors[0].message).toBe('Below the floor of $17.50 (cost $13.50 plus $4.00 minimum profit).');
    expect(await auditRows()).toHaveLength(0);
  });

  it('answers 409 PRICE_EXISTS for a second price for the same merchant and service', async () => {
    const { db, serviceId, erbil } = await world();
    await insertClientPriceRow(db, serviceId, erbil, '15.0000');
    const res = await admin.post('/admin/client-prices', { clientId: erbil, serviceId, price: '16.0000' });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('PRICE_EXISTS');
  });

  it('answers 409 PRICE_EXISTS for two creates at the same moment, and writes one row', async () => {
    const { db, serviceId, erbil } = await world();
    const results = await Promise.all([
      admin.post('/admin/client-prices', { clientId: erbil, serviceId, price: '16.0000' }),
      admin.post('/admin/client-prices', { clientId: erbil, serviceId, price: '16.5000' }),
    ]);
    expect(results.map((result) => result.status).sort()).toEqual([201, 409]);
    expect(await db.select().from(s.serviceClientPrices).where(eq(s.serviceClientPrices.clientId, erbil))).toHaveLength(
      1,
    );
  });

  it('answers 422 on serviceId for an unknown, archived or turned-off service, and on clientId for an unknown merchant', async () => {
    const { db, erbil, categoryId, serviceId } = await world();
    const archived = await insertService(db, categoryId, { status: 'disabled', archivedAt: new Date() });
    const off = await insertService(db, categoryId, { status: 'disabled' });
    const field = async (body: Record<string, unknown>) => {
      const res = await admin.post('/admin/client-prices', { price: '20.0000', ...body });
      expect(res.status).toBe(422);
      return res.body.errors[0] as { field: string; message: string };
    };
    expect((await field({ clientId: erbil, serviceId: 9999 })).field).toBe('serviceId');
    expect((await field({ clientId: erbil, serviceId: archived })).field).toBe('serviceId');
    expect(await field({ clientId: erbil, serviceId: off })).toMatchObject({
      field: 'serviceId',
      message: 'This service is turned off.',
    });
    expect((await field({ clientId: 9999, serviceId })).field).toBe('clientId');
  });

  it('answers 422 for a price that is not above zero or not written with four decimals', async () => {
    const { serviceId, erbil } = await world();
    for (const price of ['0.0000', '-1.0000', '15', 'abc']) {
      const res = await admin.post('/admin/client-prices', { clientId: erbil, serviceId, price });
      expect(res.status, price).toBe(422);
      expect(res.body.errors[0].field).toBe('price');
    }
  });

  it('needs pricing:create and a CSRF token', async () => {
    const { serviceId, erbil } = await world();
    const body = { clientId: erbil, serviceId, price: '16.0000' };
    const reader = await adminWith(t, ['pricing:read', 'pricing:update']);
    expect((await reader.post('/admin/client-prices', body)).status).toBe(403);
    expect((await admin.withoutCsrf('POST', '/admin/client-prices', body)).status).toBe(403);
  });

  it('moves the catalog price version after a create', async () => {
    const { serviceId, erbil } = await world();
    const before = await catalogVersionOf(t);
    await admin.post('/admin/client-prices', { clientId: erbil, serviceId, price: '15.0000' });
    expect(await catalogVersionOf(t)).not.toBe(before);
  });
});

describe('PATCH /admin/client-prices/:id', () => {
  it('changes the price and the note, and clears the note with an empty string', async () => {
    const { db, serviceId, erbil } = await world();
    const id = await insertClientPriceRow(db, serviceId, erbil, '15.0000', 'Old note');

    const price = await admin.patch(`/admin/client-prices/${id}`, { price: '15.5000' });
    expect(price.status).toBe(200);
    expect(price.body).toMatchObject({ price: '15.5000', note: 'Old note' });
    const note = await admin.patch(`/admin/client-prices/${id}`, { note: '' });
    expect(note.body).toMatchObject({ price: '15.5000', note: '' });

    const audits = await auditRows();
    expect(audits.map((audit) => audit.action)).toEqual(['set client price for', 'set client price for']);
    expect(audits[0]?.before).toEqual({ price: '15.0000', note: 'Old note' });
    expect(audits[0]?.after).toEqual({ price: '15.5000', note: 'Old note' });
  });

  it('applies the same floor check as create, and leaves a note-only change alone', async () => {
    const { db, serviceId, erbil } = await world();
    const id = await insertClientPriceRow(db, serviceId, erbil, '15.0000');
    const res = await admin.patch(`/admin/client-prices/${id}`, { price: '14.0000' });
    expect(res.status).toBe(422);
    expect(res.body.errors[0]).toMatchObject({ field: 'price' });
    expect((await priceRow(id))?.price).toBe('15.0000');
    // A price that sits under a floor that rose since is still editable by note.
    await db.update(s.services).set({ effectiveCost: '16.0000', cost: '16.0000' }).where(eq(s.services.id, serviceId));
    expect((await admin.patch(`/admin/client-prices/${id}`, { note: 'still fine' })).status).toBe(200);
  });

  it('answers 404 for an unknown price and for a price of an archived service, and 422 for an empty body', async () => {
    const { db, serviceId, erbil, categoryId } = await world();
    expect((await admin.patch('/admin/client-prices/9999', { note: 'x' })).status).toBe(404);
    const archived = await insertService(db, categoryId, { status: 'disabled', archivedAt: new Date() });
    const hidden = await insertClientPriceRow(db, archived, erbil, '1.0000');
    expect((await admin.patch(`/admin/client-prices/${hidden}`, { note: 'x' })).status).toBe(404);
    const id = await insertClientPriceRow(db, serviceId, erbil, '15.0000');
    expect((await admin.patch(`/admin/client-prices/${id}`, {})).status).toBe(422);
  });

  it('needs pricing:update', async () => {
    const { db, serviceId, erbil } = await world();
    const id = await insertClientPriceRow(db, serviceId, erbil, '15.0000');
    const creator = await adminWith(t, ['pricing:create', 'pricing:read']);
    expect((await creator.patch(`/admin/client-prices/${id}`, { note: 'x' })).status).toBe(403);
  });
});

describe('DELETE /admin/client-prices/:id', () => {
  it('deletes the price, answers 204, audits like the demo and moves the price version', async () => {
    const { db, serviceId, erbil } = await world();
    const id = await insertClientPriceRow(db, serviceId, erbil, '15.0000');
    const before = await catalogVersionOf(t);
    const res = await admin.delete(`/admin/client-prices/${id}`);
    expect(res.status).toBe(204);
    expect(await priceRow(id)).toBeUndefined();
    const [audit] = await auditRows();
    expect(audit).toMatchObject({
      action: 'removed client price for',
      entityType: 'merchant',
      entityId: erbil,
      entityLabel: 'Erbil, IMEI-ATT-USA',
    });
    expect(audit?.before).toEqual({ price: '15.0000', note: '' });
    expect(await catalogVersionOf(t)).not.toBe(before);
  });

  it('answers 404 for an unknown price, and needs pricing:delete', async () => {
    const { db, serviceId, erbil } = await world();
    expect((await admin.delete('/admin/client-prices/9999')).status).toBe(404);
    const id = await insertClientPriceRow(db, serviceId, erbil, '15.0000');
    const limited = await adminWith(t, ['pricing:read', 'pricing:update']);
    expect((await limited.delete(`/admin/client-prices/${id}`)).status).toBe(403);
  });
});

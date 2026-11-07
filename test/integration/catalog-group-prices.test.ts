// Integration tests of PUT /admin/services/:id/group-prices (feature 4b): replace-all, the floors (merchant group rows and the
// storefront row, unchanged rows included), repeated and unknown groups, 404, permissions, audit and the price version.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { eq } from 'drizzle-orm';
import { schema as s } from '../../src/infra/db';
import { type AdminApi, adminWith } from '../support/admin-api';
import { type TestApp, createTestApp } from '../support/app';
import { clearIdentityCaches } from '../support/auth';
import { insertCategory, insertService } from '../support/catalog';
import { closeTestDb, resetDb, testDb } from '../support/db';
import { catalogVersionOf, insertAtt, insertDemoGroups, insertGroupPrice, insertRule } from '../support/pricing';

let t: TestApp;
let admin: AdminApi;

beforeAll(async () => {
  t = await createTestApp();
});
beforeEach(async () => {
  await resetDb();
  await clearIdentityCaches(t);
  admin = await adminWith(t, ['pricing:*', 'catalog:read'], { name: 'Rami K.' });
});
afterAll(async () => {
  await resetDb();
  await clearIdentityCaches(t);
  await t.close();
  await closeTestDb();
});

const auditRows = async () => (await testDb()).db.select().from(s.auditLogs).orderBy(s.auditLogs.id);
const stored = async (serviceId: number) =>
  (await testDb()).db
    .select({ groupId: s.serviceGroupPrices.groupId, price: s.serviceGroupPrices.price })
    .from(s.serviceGroupPrices)
    .where(eq(s.serviceGroupPrices.serviceId, serviceId))
    .orderBy(s.serviceGroupPrices.groupId);
const put = (serviceId: number, prices: Array<{ groupId: number; price: string }>) =>
  admin.put(`/admin/services/${serviceId}/group-prices`, { prices });

describe('PUT /admin/services/:id/group-prices', () => {
  it('replaces the whole set, answers the saved prices by group id and audits the change', async () => {
    const { db } = await testDb();
    const groups = await insertDemoGroups(db);
    const { serviceId } = await insertAtt(db);
    await insertGroupPrice(db, serviceId, groups.wholesale, '16.0000');

    const res = await put(serviceId, [
      { groupId: groups.vip, price: '15.9000' },
      { groupId: groups.standard, price: '17.0000' },
    ]);
    expect(res.status).toBe(200);
    expect(res.body).toEqual([
      { groupId: groups.standard, price: '17.0000' },
      { groupId: groups.vip, price: '15.9000' },
    ]);
    // Wholesale was left out and lost its fixed price.
    expect(await stored(serviceId)).toEqual(res.body);

    const [audit] = await auditRows();
    expect(audit).toMatchObject({
      action: 'changed group prices of',
      entityType: 'service',
      entityId: serviceId,
      entityLabel: 'AT&T USA Premier Unlock',
      actorName: 'Rami K.',
    });
    expect(audit?.before).toEqual({ [`group ${groups.wholesale}`]: '16.0000' });
    expect(audit?.after).toEqual({ [`group ${groups.standard}`]: '17.0000', [`group ${groups.vip}`]: '15.9000' });
  });

  it('accepts an empty set: every fixed group price goes', async () => {
    const { db } = await testDb();
    const groups = await insertDemoGroups(db);
    const { serviceId } = await insertAtt(db);
    await insertGroupPrice(db, serviceId, groups.vip, '15.9000');
    const res = await put(serviceId, []);
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
    expect(await stored(serviceId)).toEqual([]);
  });

  it('refuses a merchant group price under its floor with the demo wording on prices.N.price, and saves nothing', async () => {
    const { db } = await testDb();
    const groups = await insertDemoGroups(db);
    const { serviceId } = await insertAtt(db);
    await insertGroupPrice(db, serviceId, groups.vip, '15.9000');

    const res = await put(serviceId, [
      { groupId: groups.standard, price: '17.0000' },
      { groupId: groups.wholesale, price: '14.3000' },
    ]);
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('VALIDATION_FAILED');
    expect(res.body.errors).toEqual([
      {
        field: 'prices.1.price',
        code: 'invalid',
        message: 'Below the floor of $14.31 (cost $13.50 plus $0.81 minimum profit).',
      },
    ]);
    expect(await stored(serviceId)).toEqual([{ groupId: groups.vip, price: '15.9000' }]);
    expect(await auditRows()).toHaveLength(0);
  });

  it('holds a group to its own floor: a rule that asks for a minimum profit for that group only', async () => {
    const { db } = await testDb();
    const groups = await insertDemoGroups(db);
    const { categoryId, serviceId } = await insertAtt(db, { minProfit: null });
    await insertRule(db, { scope: 'category', targetId: categoryId, groupId: groups.vip, minProfit: '3' });

    const res = await put(serviceId, [
      { groupId: groups.standard, price: '14.3000' },
      { groupId: groups.vip, price: '15.0000' },
    ]);
    // Standard: default policy 6 % of 13.50 = 0.81, floor 14.31 (14.30 is under it); VIP: 13.50 + 3.00 = 16.50.
    expect(res.status).toBe(422);
    expect(res.body.errors.map((error: { field: string; message: string }) => [error.field, error.message])).toEqual([
      ['prices.0.price', 'Below the floor of $14.31 (cost $13.50 plus $0.81 minimum profit).'],
      ['prices.1.price', 'Below the floor of $16.50 (cost $13.50 plus $3.00 minimum profit).'],
    ]);
  });

  it('holds the storefront row to max(round(base x 1.10, 2), floor) and checks unchanged rows too', async () => {
    const { db } = await testDb();
    const groups = await insertDemoGroups(db);
    const { serviceId } = await insertAtt(db);
    // Stored before, under today's storefront floor of 19.01: re-sending it unchanged is refused.
    await insertGroupPrice(db, serviceId, groups.retail, '18.0000');

    const refused = await put(serviceId, [{ groupId: groups.retail, price: '18.0000' }]);
    expect(refused.status).toBe(422);
    expect(refused.body.errors).toEqual([
      { field: 'prices.0.price', code: 'invalid', message: 'Below the storefront floor of $19.01.' },
    ]);

    const accepted = await put(serviceId, [{ groupId: groups.retail, price: '19.0100' }]);
    expect(accepted.status).toBe(200);
  });

  it('names the later occurrence of a repeated group and an unknown group, together with floor problems', async () => {
    const { db } = await testDb();
    const groups = await insertDemoGroups(db);
    const { serviceId } = await insertAtt(db);
    const res = await put(serviceId, [
      { groupId: groups.vip, price: '15.9000' },
      { groupId: groups.wholesale, price: '1.0000' },
      { groupId: groups.vip, price: '16.0000' },
      { groupId: 9999, price: '16.0000' },
    ]);
    expect(res.status).toBe(422);
    expect(res.body.errors.map((error: { field: string; message: string }) => [error.field, error.message])).toEqual([
      ['prices.1.price', 'Below the floor of $14.31 (cost $13.50 plus $0.81 minimum profit).'],
      ['prices.2.groupId', 'Listed twice'],
      ['prices.3.groupId', 'This group does not exist.'],
    ]);
  });

  it('refuses a price that is not above zero on prices.N.price', async () => {
    const { db } = await testDb();
    const groups = await insertDemoGroups(db);
    const { serviceId } = await insertAtt(db);
    const zero = await put(serviceId, [{ groupId: groups.vip, price: '0.0000' }]);
    expect(zero.status).toBe(422);
    expect(zero.body.errors[0].field).toBe('prices.0.price');
    const text = await put(serviceId, [{ groupId: groups.vip, price: '15.9' }]);
    expect(text.status).toBe(422);
  });

  it('answers 404 for an unknown or archived service', async () => {
    const { db } = await testDb();
    const groups = await insertDemoGroups(db);
    const categoryId = await insertCategory(db);
    const archived = await insertService(db, categoryId, { status: 'disabled', archivedAt: new Date() });
    expect((await put(9999, [])).status).toBe(404);
    expect((await put(archived, [{ groupId: groups.vip, price: '15.9000' }])).status).toBe(404);
  });

  it('needs pricing:update and a CSRF token', async () => {
    const { db } = await testDb();
    const groups = await insertDemoGroups(db);
    const { serviceId } = await insertAtt(db);
    const body = { prices: [{ groupId: groups.vip, price: '15.9000' }] };
    const readOnly = await adminWith(t, ['pricing:read']);
    expect((await readOnly.put(`/admin/services/${serviceId}/group-prices`, body)).status).toBe(403);
    expect((await admin.withoutCsrf('PUT', `/admin/services/${serviceId}/group-prices`, body)).status).toBe(403);
    expect((await admin.anonymous('PUT', `/admin/services/${serviceId}/group-prices`, body)).status).toBe(401);
    expect(await stored(serviceId)).toEqual([]);
  });

  it('moves the catalog price version after a save and not after a refusal', async () => {
    const { db } = await testDb();
    const groups = await insertDemoGroups(db);
    const { serviceId } = await insertAtt(db);
    const before = await catalogVersionOf(t);

    expect((await put(serviceId, [{ groupId: groups.vip, price: '1.0000' }])).status).toBe(422);
    expect(await catalogVersionOf(t)).toBe(before);
    expect((await put(serviceId, [{ groupId: groups.vip, price: '15.9000' }])).status).toBe(200);
    expect(await catalogVersionOf(t)).not.toBe(before);
  });

  it('serialises two saves of the same service: the last whole set wins, never a mix', async () => {
    const { db } = await testDb();
    const groups = await insertDemoGroups(db);
    const { serviceId } = await insertAtt(db);
    const [a, b] = await Promise.all([
      put(serviceId, [
        { groupId: groups.standard, price: '17.0000' },
        { groupId: groups.vip, price: '15.9000' },
      ]),
      put(serviceId, [{ groupId: groups.wholesale, price: '16.0000' }]),
    ]);
    expect([a.status, b.status]).toEqual([200, 200]);
    const rows = await stored(serviceId);
    const sets = [
      [
        { groupId: groups.standard, price: '17.0000' },
        { groupId: groups.vip, price: '15.9000' },
      ],
      [{ groupId: groups.wholesale, price: '16.0000' }],
    ];
    expect(sets).toContainEqual(rows);
  });
});

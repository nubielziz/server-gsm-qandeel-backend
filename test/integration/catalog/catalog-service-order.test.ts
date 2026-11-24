// Integration tests of the stored order of services (decision 063): POST /admin/services/order saves positions in one transaction with one
// audit entry, refuses what is wrong without saving anything, and the lists merchants read (the portal catalog, the price list, the Dhru
// service list) follow it: category position, then the service's position, then the name.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { eq } from 'drizzle-orm';
import { schema as s } from '@src/infra/db';
import { type AdminApi, adminWith } from '../../support/admin-api';
import { type TestApp, createTestApp } from '../../support/app';
import { clearIdentityCaches, openSession } from '../../support/auth';
import { insertCategory, insertService } from '../../support/catalog';
import { closeTestDb, resetDb, testDb } from '../../support/db';
import { clearApiKeyCaches, credentialsFor, dhruClient } from '../../support/machine-orders';
import { catalogVersionOf, insertDemoGroups, insertMerchantIn } from '../../support/pricing';

let t: TestApp;
/** A staff member who may change the catalog, one who may only read it, and an Owner. */
let editor: AdminApi;
let readerOnly: AdminApi;

beforeAll(async () => {
  t = await createTestApp();
});
beforeEach(async () => {
  await resetDb();
  await clearIdentityCaches(t);
  await clearApiKeyCaches(t);
  editor = await adminWith(t, ['catalog:update', 'catalog:read']);
  readerOnly = await adminWith(t, ['catalog:read']);
});
afterAll(async () => {
  await resetDb();
  await clearIdentityCaches(t);
  await t.close();
  await closeTestDb();
});

const ORDER = '/admin/services/order';
const auditRows = async () => (await testDb()).db.select().from(s.auditLogs).orderBy(s.auditLogs.id);
const sortOf = async (id: number) =>
  (await (await testDb()).db.select({ sort: s.services.sort }).from(s.services).where(eq(s.services.id, id)))[0]!.sort;

/** Two categories (the first one first for merchants) with three and one services, and a merchant in the standard group. */
async function world() {
  const { db } = await testDb();
  const groups = await insertDemoGroups(db);
  const first = await insertCategory(db, { name: 'First category', sort: 1 });
  const second = await insertCategory(db, { name: 'Second category', sort: 2 });
  const make = (category: number, name: string, code: string) => insertService(db, category, { name, code });
  const zulu = await make(first, 'Zulu', 'IMEI-ZULU');
  const mike = await make(first, 'Mike', 'IMEI-MIKE');
  const alpha = await make(first, 'Alpha', 'IMEI-ALPHA');
  const yankee = await make(second, 'Yankee', 'IMEI-YANKEE');
  const merchant = await insertMerchantIn(db, groups.standard);
  return { db, groups, first, second, zulu, mike, alpha, yankee, merchant };
}

/** The portal's catalog as a merchant reads it: the names in the order of the answer. */
async function portalNames(merchant: number, query = ''): Promise<string[]> {
  const session = await openSession(t, { type: 'account', id: merchant });
  const res = await t.app.inject({ method: 'GET', url: `/client/services${query}`, headers: session.headers });
  expect(res.statusCode).toBe(200);
  return res.json<Array<{ name: string }>>().map((row) => row.name);
}

describe('POST /admin/services/order: the save', () => {
  it('saves the positions, says how many services changed, and the list and the detail read them', async () => {
    const { zulu, mike, alpha, yankee } = await world();
    const res = await editor.post(ORDER, {
      items: [
        { id: zulu, sort: 1 },
        { id: mike, sort: 2 },
        { id: alpha, sort: 3 },
      ],
    });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ updated: 3 });
    expect([await sortOf(zulu), await sortOf(mike), await sortOf(alpha), await sortOf(yankee)]).toEqual([1, 2, 3, 0]);
    expect((await editor.get(`/admin/services/${mike}`)).body).toMatchObject({ id: mike, sort: 2 });
    const list = await editor.get('/admin/services?_sort=sort&_order=asc');
    expect(list.body.map((row: { name: string; sort: number }) => [row.name, row.sort])).toEqual([
      ['Zulu', 1],
      ['Mike', 2],
      ['Alpha', 3],
      ['Yankee', 0],
    ]);
  });

  it('leaves a service that is already at its position alone and counts only the ones that moved', async () => {
    const { db, zulu, mike } = await world();
    await db.update(s.services).set({ sort: 4 }).where(eq(s.services.id, zulu));
    const before = (await db.select().from(s.services).where(eq(s.services.id, zulu)))[0]!;
    const res = await editor.post(ORDER, {
      items: [
        { id: zulu, sort: 4 },
        { id: mike, sort: 9 },
      ],
    });
    expect(res.body).toEqual({ updated: 1 });
    expect((await db.select().from(s.services).where(eq(s.services.id, zulu)))[0]).toEqual(before);
    expect(await sortOf(mike)).toBe(9);
    expect((await editor.post(ORDER, { items: [{ id: mike, sort: 9 }] })).body).toEqual({ updated: 0 });
  });

  it('accepts the bounds of a position and a service listed alone', async () => {
    const { zulu, mike } = await world();
    expect((await editor.post(ORDER, { items: [{ id: zulu, sort: 0 }] })).status).toBe(200);
    expect((await editor.post(ORDER, { items: [{ id: mike, sort: 1_000_000 }] })).body).toEqual({ updated: 1 });
    expect(await sortOf(mike)).toBe(1_000_000);
  });

  it('writes one audit entry with the old and new positions of the services that changed', async () => {
    const { db, zulu, mike, alpha } = await world();
    await db.update(s.services).set({ sort: 5 }).where(eq(s.services.id, mike));
    await editor.post(ORDER, {
      items: [
        { id: zulu, sort: 1 },
        { id: mike, sort: 5 },
        { id: alpha, sort: 3 },
      ],
    });
    const audits = await auditRows();
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      actorId: editor.staffId,
      action: 'changed the order of',
      entityType: 'service',
      entityLabel: '3 services',
      before: { services: 3, changed: 2, sorts: { 'IMEI-ZULU': 0, 'IMEI-ALPHA': 0 } },
      after: { services: 3, changed: 2, sorts: { 'IMEI-ZULU': 1, 'IMEI-ALPHA': 3 } },
    });
  });

  it('writes an audit entry also when nothing moved, and names one service in the singular', async () => {
    const { zulu } = await world();
    await editor.post(ORDER, { items: [{ id: zulu, sort: 0 }] });
    expect(await auditRows()).toMatchObject([
      { entityLabel: '1 service', after: { services: 1, changed: 0, sorts: {} } },
    ]);
  });

  it('moves the catalog price version only when a position changed, so cached price lists start over', async () => {
    const { zulu } = await world();
    const before = await catalogVersionOf(t);
    await editor.post(ORDER, { items: [{ id: zulu, sort: 0 }] });
    expect(await catalogVersionOf(t)).toBe(before);
    await editor.post(ORDER, { items: [{ id: zulu, sort: 3 }] });
    expect(await catalogVersionOf(t)).not.toBe(before);
  });

  it('applies two saves of the same services one after the other, never a mix of the two', async () => {
    const { zulu, mike, alpha } = await world();
    const one = {
      items: [
        { id: zulu, sort: 1 },
        { id: mike, sort: 1 },
        { id: alpha, sort: 1 },
      ],
    };
    // The same services in the other order: the locks are taken in id order, so neither save waits for the other forever.
    const two = {
      items: [
        { id: alpha, sort: 2 },
        { id: mike, sort: 2 },
        { id: zulu, sort: 2 },
      ],
    };
    const [first, second] = await Promise.all([editor.post(ORDER, one), editor.post(ORDER, two)]);
    expect([first.status, second.status]).toEqual([200, 200]);
    const positions = [await sortOf(zulu), await sortOf(mike), await sortOf(alpha)];
    expect([
      [1, 1, 1],
      [2, 2, 2],
    ]).toContainEqual(positions);
    expect(await auditRows()).toHaveLength(2);
  });
});

describe('POST /admin/services/order: what is refused', () => {
  const problems = (res: { body: { errors: Array<{ field: string; code: string }> } }) =>
    res.body.errors.map((error) => `${error.field}:${error.code}`);

  it('refuses an empty list and more than 500 services', async () => {
    await world();
    const empty = await editor.post(ORDER, { items: [] });
    expect(empty.status).toBe(422);
    expect(empty.body.errors).toContainEqual(expect.objectContaining({ field: 'items' }));
    const many = await editor.post(ORDER, {
      items: Array.from({ length: 501 }, (_, index) => ({ id: index + 1, sort: 1 })),
    });
    expect(many.status).toBe(422);
    expect(many.body.errors).toContainEqual(expect.objectContaining({ field: 'items' }));
    expect((await editor.post(ORDER, {})).status).toBe(422);
  });

  it('refuses a position that is not a whole number from 0 to 1000000, and an id that is not an id', async () => {
    const { zulu } = await world();
    for (const sort of [-1, 1.5, 1_000_001, '3', null]) {
      const res = await editor.post(ORDER, { items: [{ id: zulu, sort }] });
      expect(res.status, String(sort)).toBe(422);
      expect(res.body.errors).toContainEqual(expect.objectContaining({ field: 'items.0.sort' }));
    }
    for (const id of [0, -4, 'one', null]) {
      const res = await editor.post(ORDER, { items: [{ id, sort: 1 }] });
      expect(res.status, String(id)).toBe(422);
      expect(res.body.errors).toContainEqual(expect.objectContaining({ field: 'items.0.id' }));
    }
    expect(await sortOf(zulu)).toBe(0);
  });

  it('names a service listed twice (the later one), an unknown service and an archived one, all together, and saves nothing', async () => {
    const { db, first, zulu, mike, alpha } = await world();
    const gone = await insertService(db, first, { name: 'Gone', status: 'disabled', archivedAt: new Date() });
    const res = await editor.post(ORDER, {
      items: [
        { id: zulu, sort: 7 },
        { id: mike, sort: 8 },
        { id: zulu, sort: 9 },
        { id: 999_999, sort: 1 },
        { id: gone, sort: 2 },
        { id: alpha, sort: 3 },
      ],
    });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('VALIDATION_FAILED');
    expect(problems(res)).toEqual(['items.2.id:duplicate', 'items.3.id:unknown', 'items.4.id:unknown']);
    expect(res.body.errors[1].message).toContain('999999');
    // Not one position was written, and no audit entry either: the transaction is one.
    expect([await sortOf(zulu), await sortOf(mike), await sortOf(alpha)]).toEqual([0, 0, 0]);
    expect(await auditRows()).toHaveLength(0);
  });

  it('is for staff who may change the catalog: a reader, a forged request and a signed-out one are refused', async () => {
    const { zulu } = await world();
    const request = { items: [{ id: zulu, sort: 4 }] };
    const refused = await readerOnly.post(ORDER, request);
    expect(refused.status).toBe(403);
    expect(refused.body).toMatchObject({ code: 'FORBIDDEN' });
    expect((await editor.withoutCsrf('POST', ORDER, request)).status).toBe(403);
    expect((await editor.anonymous('POST', ORDER, request)).status).toBe(401);
    expect(await sortOf(zulu)).toBe(0);
    expect(await auditRows()).toHaveLength(0);
  });
});

describe('the lists merchants and API clients read follow the order', () => {
  it('orders the portal catalog by category position, then the service position, then the name', async () => {
    const { zulu, mike, alpha, merchant, first, db } = await world();
    // Nobody has numbered a service yet: the name decides, as it did before.
    expect(await portalNames(merchant)).toEqual(['Alpha', 'Mike', 'Zulu', 'Yankee']);
    await editor.post(ORDER, {
      items: [
        { id: zulu, sort: 1 },
        { id: mike, sort: 2 },
        { id: alpha, sort: 3 },
      ],
    });
    expect(await portalNames(merchant)).toEqual(['Zulu', 'Mike', 'Alpha', 'Yankee']);
    // The category position still comes first.
    await db.update(s.serviceCategories).set({ sort: 3 }).where(eq(s.serviceCategories.id, first));
    expect(await portalNames(merchant)).toEqual(['Yankee', 'Zulu', 'Mike', 'Alpha']);
    await db.update(s.serviceCategories).set({ sort: 1 }).where(eq(s.serviceCategories.id, first));
    // Services nobody numbered sort before the numbered ones (position 0), by name.
    await editor.post(ORDER, {
      items: [
        { id: zulu, sort: 0 },
        { id: mike, sort: 0 },
      ],
    });
    expect(await portalNames(merchant)).toEqual(['Mike', 'Zulu', 'Alpha', 'Yankee']);
  });

  it('keeps the sort the caller asks for in the portal catalog: by name, or by category descending', async () => {
    const { zulu, alpha, merchant } = await world();
    await editor.post(ORDER, {
      items: [
        { id: zulu, sort: 1 },
        { id: alpha, sort: 9 },
      ],
    });
    expect(await portalNames(merchant, '?_sort=name&_order=asc')).toEqual(['Alpha', 'Mike', 'Yankee', 'Zulu']);
    expect(await portalNames(merchant, '?_sort=category&_order=desc')).toEqual(['Yankee', 'Alpha', 'Zulu', 'Mike']);
  });

  it('orders the price list the same way', async () => {
    const { zulu, mike, alpha, merchant } = await world();
    await editor.post(ORDER, {
      items: [
        { id: alpha, sort: 1 },
        { id: mike, sort: 2 },
        { id: zulu, sort: 3 },
      ],
    });
    const session = await openSession(t, { type: 'account', id: merchant });
    const res = await t.app.inject({
      method: 'GET',
      url: '/client/prices/export',
      headers: { ...session.headers, 'sec-fetch-site': 'same-origin' },
    });
    expect(res.statusCode).toBe(200);
    // The code is the second column of each line after the header.
    const codes = res.body
      .trim()
      .split('\r\n')
      .slice(1)
      .map((line) => line.split(',')[1]);
    expect(codes).toEqual(['IMEI-ALPHA', 'IMEI-MIKE', 'IMEI-ZULU', 'IMEI-YANKEE']);
  });

  it('builds the Dhru groups in the order of the category position', async () => {
    const { db, first, zulu, mike, alpha, merchant } = await world();
    await editor.post(ORDER, {
      items: [
        { id: alpha, sort: 1 },
        { id: mike, sort: 2 },
        { id: zulu, sort: 3 },
      ],
    });
    const creds = await credentialsFor(t, db, merchant);
    const groupNames = async () => Object.keys((await dhruClient(t, creds).call('imeiservicelist')).SUCCESS[0].LIST);
    expect(await groupNames()).toEqual(['First category', 'Second category']);
    await db.update(s.serviceCategories).set({ sort: 5 }).where(eq(s.serviceCategories.id, first));
    expect(await groupNames()).toEqual(['Second category', 'First category']);
  });
});

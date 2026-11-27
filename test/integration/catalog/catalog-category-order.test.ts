// Integration tests of the stored order of categories (decision 078): POST /admin/service-categories/order saves the positions of some
// categories in one transaction with one audit entry and one move of the catalog price version, refuses what is wrong without saving
// anything, and the lists merchants read follow it. The single `PATCH /admin/service-categories/:id` stays and is checked beside it.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { eq } from 'drizzle-orm';
import { schema as s } from '@src/infra/db';
import { type AdminApi, adminWith } from '../../support/admin-api';
import { type TestApp, createTestApp } from '../../support/app';
import { clearIdentityCaches, openSession } from '../../support/auth';
import { insertCategory, insertService } from '../../support/catalog';
import { closeTestDb, resetDb, testDb } from '../../support/db';
import { catalogVersionOf, insertDemoGroups, insertMerchantIn } from '../../support/pricing';

let t: TestApp;
/** A staff member who may change the catalog, and one who may only read it. */
let editor: AdminApi;
let readerOnly: AdminApi;

beforeAll(async () => {
  t = await createTestApp();
});
beforeEach(async () => {
  await resetDb();
  await clearIdentityCaches(t);
  editor = await adminWith(t, ['catalog:update', 'catalog:read']);
  readerOnly = await adminWith(t, ['catalog:read']);
});
afterAll(async () => {
  await resetDb();
  await clearIdentityCaches(t);
  await t.close();
  await closeTestDb();
});

const ORDER = '/admin/service-categories/order';
const auditRows = async () => (await testDb()).db.select().from(s.auditLogs).orderBy(s.auditLogs.id);
const outboxRows = async () => (await testDb()).db.select().from(s.outboxEvents).orderBy(s.outboxEvents.id);
const sortOf = async (id: number) =>
  (
    await (
      await testDb()
    ).db
      .select({ sort: s.serviceCategories.sort })
      .from(s.serviceCategories)
      .where(eq(s.serviceCategories.id, id))
  )[0]!.sort;

/** Three categories of two types (positions 1, 2, 3), each with one service, and a merchant in the standard group. */
async function world() {
  const { db } = await testDb();
  const groups = await insertDemoGroups(db);
  const apple = await insertCategory(db, { name: 'Apple', sort: 1 });
  const samsung = await insertCategory(db, { name: 'Samsung', sort: 2 });
  const server = await insertCategory(db, { name: 'Server tools', type: 'server', sort: 3 });
  await insertService(db, apple, { name: 'Apple unlock', code: 'IMEI-APPLE' });
  await insertService(db, samsung, { name: 'Samsung unlock', code: 'IMEI-SAMSUNG' });
  await insertService(db, server, { name: 'Server credit', code: 'SRV-CREDIT', type: 'server' });
  const merchant = await insertMerchantIn(db, groups.standard);
  return { db, apple, samsung, server, merchant };
}

/** The portal's catalog as a merchant reads it: the names in the order of the answer. */
async function portalNames(merchant: number): Promise<string[]> {
  const session = await openSession(t, { type: 'account', id: merchant });
  const res = await t.app.inject({ method: 'GET', url: '/client/services', headers: session.headers });
  expect(res.statusCode).toBe(200);
  return res.json<Array<{ name: string }>>().map((row) => row.name);
}

describe('POST /admin/service-categories/order: the save', () => {
  it('saves the positions of categories of both types, says how many changed, and the list reads them', async () => {
    const { apple, samsung, server } = await world();
    const res = await editor.post(ORDER, {
      items: [
        { id: server, sort: 1 },
        { id: apple, sort: 2 },
        { id: samsung, sort: 3 },
      ],
    });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ updated: 3 });
    expect([await sortOf(server), await sortOf(apple), await sortOf(samsung)]).toEqual([1, 2, 3]);
    const list = await editor.get('/admin/service-categories?_start=0&_end=200&_sort=sort&_order=asc');
    expect(list.body.map((row: { name: string; sort: number }) => [row.name, row.sort])).toEqual([
      ['Server tools', 1],
      ['Apple', 2],
      ['Samsung', 3],
    ]);
  });

  it('moves only the categories that are sent: the others keep their position', async () => {
    const { apple, samsung, server } = await world();
    expect((await editor.post(ORDER, { items: [{ id: samsung, sort: 9 }] })).body).toEqual({ updated: 1 });
    expect([await sortOf(apple), await sortOf(samsung), await sortOf(server)]).toEqual([1, 9, 3]);
  });

  it('leaves a category that is already at its position alone and counts only the ones that moved', async () => {
    const { db, apple, samsung } = await world();
    const before = (await db.select().from(s.serviceCategories).where(eq(s.serviceCategories.id, apple)))[0]!;
    const res = await editor.post(ORDER, {
      items: [
        { id: apple, sort: 1 },
        { id: samsung, sort: 9 },
      ],
    });
    expect(res.body).toEqual({ updated: 1 });
    expect((await db.select().from(s.serviceCategories).where(eq(s.serviceCategories.id, apple)))[0]).toEqual(before);
    expect(await sortOf(samsung)).toBe(9);
    expect((await editor.post(ORDER, { items: [{ id: samsung, sort: 9 }] })).body).toEqual({ updated: 0 });
  });

  it('accepts the bounds of a position and a category listed alone', async () => {
    const { apple, samsung } = await world();
    expect((await editor.post(ORDER, { items: [{ id: apple, sort: 0 }] })).body).toEqual({ updated: 1 });
    expect((await editor.post(ORDER, { items: [{ id: samsung, sort: 1_000_000 }] })).body).toEqual({ updated: 1 });
    expect(await sortOf(samsung)).toBe(1_000_000);
  });

  it('writes one audit entry that names the categories that moved with their old and new positions', async () => {
    const { apple, samsung, server } = await world();
    await editor.post(ORDER, {
      items: [
        { id: apple, sort: 1 },
        { id: samsung, sort: 5 },
        { id: server, sort: 2 },
      ],
    });
    const audits = await auditRows();
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      actorId: editor.staffId,
      action: 'changed the order of',
      entityType: 'category',
      entityLabel: '3 categories',
      before: {
        categories: 3,
        changed: 2,
        sorts: { [`Samsung (#${samsung})`]: 2, [`Server tools (#${server})`]: 3 },
      },
      after: {
        categories: 3,
        changed: 2,
        sorts: { [`Samsung (#${samsung})`]: 5, [`Server tools (#${server})`]: 2 },
      },
    });
  });

  it('writes an audit entry also when nothing moved, and names one category in the singular', async () => {
    const { apple } = await world();
    await editor.post(ORDER, { items: [{ id: apple, sort: 1 }] });
    expect(await auditRows()).toMatchObject([
      {
        entityLabel: '1 category',
        before: { categories: 1, changed: 0, sorts: {} },
        after: { categories: 1, changed: 0, sorts: {} },
      },
    ]);
  });

  it('moves the catalog price version once, and only when a position changed, so cached price lists start over', async () => {
    const { apple, samsung } = await world();
    const before = await catalogVersionOf(t);
    await editor.post(ORDER, { items: [{ id: apple, sort: 1 }] });
    expect(await catalogVersionOf(t)).toBe(before);
    await editor.post(ORDER, {
      items: [
        { id: apple, sort: 2 },
        { id: samsung, sort: 1 },
      ],
    });
    const after = await catalogVersionOf(t);
    expect(after).not.toBe(before);
    // Two categories moved, one version move: the next save of nothing leaves it where it is.
    await editor.post(ORDER, { items: [{ id: apple, sort: 2 }] });
    expect(await catalogVersionOf(t)).toBe(after);
  });

  it('writes no search signal: the index holds a category name and id, never its position', async () => {
    const { apple, samsung } = await world();
    await editor.post(ORDER, {
      items: [
        { id: apple, sort: 2 },
        { id: samsung, sort: 1 },
      ],
    });
    expect((await outboxRows()).filter((row) => row.type === 'catalog.category_changed')).toEqual([]);
  });

  it('applies two saves of the same categories one after the other, never a mix of the two', async () => {
    const { apple, samsung, server } = await world();
    const one = {
      items: [
        { id: apple, sort: 1 },
        { id: samsung, sort: 1 },
        { id: server, sort: 1 },
      ],
    };
    // The same categories in the other order: the locks are taken in id order, so neither save waits for the other forever.
    const two = {
      items: [
        { id: server, sort: 2 },
        { id: samsung, sort: 2 },
        { id: apple, sort: 2 },
      ],
    };
    const [first, second] = await Promise.all([editor.post(ORDER, one), editor.post(ORDER, two)]);
    expect([first.status, second.status]).toEqual([200, 200]);
    const positions = [await sortOf(apple), await sortOf(samsung), await sortOf(server)];
    expect([
      [1, 1, 1],
      [2, 2, 2],
    ]).toContainEqual(positions);
    expect(await auditRows()).toHaveLength(2);
  });

  it('keeps the single PATCH of a category position working beside it', async () => {
    const { apple } = await world();
    const res = await editor.patch(`/admin/service-categories/${apple}`, { sort: 7 });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: apple, sort: 7 });
    expect(await sortOf(apple)).toBe(7);
  });
});

describe('POST /admin/service-categories/order: what is refused', () => {
  const problems = (res: { body: { errors: Array<{ field: string; code: string }> } }) =>
    res.body.errors.map((error) => `${error.field}:${error.code}`);

  it('refuses an empty list and more than 500 categories', async () => {
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
    const { apple } = await world();
    for (const sort of [-1, 1.5, 1_000_001, '3', null]) {
      const res = await editor.post(ORDER, { items: [{ id: apple, sort }] });
      expect(res.status, String(sort)).toBe(422);
      expect(res.body.errors).toContainEqual(expect.objectContaining({ field: 'items.0.sort' }));
    }
    for (const id of [0, -4, 'one', null]) {
      const res = await editor.post(ORDER, { items: [{ id, sort: 1 }] });
      expect(res.status, String(id)).toBe(422);
      expect(res.body.errors).toContainEqual(expect.objectContaining({ field: 'items.0.id' }));
    }
    expect(await sortOf(apple)).toBe(1);
  });

  it('names a category listed twice (the later one) and an unknown one, all together, and saves nothing', async () => {
    const { apple, samsung, server } = await world();
    const before = await catalogVersionOf(t);
    const res = await editor.post(ORDER, {
      items: [
        { id: apple, sort: 7 },
        { id: samsung, sort: 8 },
        { id: apple, sort: 9 },
        { id: 999_999, sort: 1 },
        { id: server, sort: 3 },
      ],
    });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('VALIDATION_FAILED');
    expect(problems(res)).toEqual(['items.2.id:duplicate', 'items.3.id:unknown']);
    expect(res.body.errors[1].message).toContain('999999');
    // Not one position was written, and no audit entry or version move either: the transaction is one.
    expect([await sortOf(apple), await sortOf(samsung), await sortOf(server)]).toEqual([1, 2, 3]);
    expect(await auditRows()).toHaveLength(0);
    expect(await catalogVersionOf(t)).toBe(before);
  });

  it('is for staff who may change the catalog: a reader, a forged request and a signed-out one are refused', async () => {
    const { apple } = await world();
    const request = { items: [{ id: apple, sort: 4 }] };
    const refused = await readerOnly.post(ORDER, request);
    expect(refused.status).toBe(403);
    expect(refused.body).toMatchObject({ code: 'FORBIDDEN' });
    expect((await editor.withoutCsrf('POST', ORDER, request)).status).toBe(403);
    expect((await editor.anonymous('POST', ORDER, request)).status).toBe(401);
    expect(await sortOf(apple)).toBe(1);
    expect(await auditRows()).toHaveLength(0);
  });
});

describe('the lists merchants read follow the order of categories', () => {
  it('orders the portal catalog by category position after one call', async () => {
    const { apple, samsung, merchant } = await world();
    expect(await portalNames(merchant)).toEqual(['Apple unlock', 'Samsung unlock', 'Server credit']);
    await editor.post(ORDER, {
      items: [
        { id: samsung, sort: 1 },
        { id: apple, sort: 2 },
      ],
    });
    expect(await portalNames(merchant)).toEqual(['Samsung unlock', 'Apple unlock', 'Server credit']);
  });
});

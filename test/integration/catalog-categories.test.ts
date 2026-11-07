// Integration tests of the service category routes (feature 4a): list with live service counts, show, create, change and delete,
// the name rule within a type, the type invariant with services, and the delete guards (live and archived services).
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { eq } from 'drizzle-orm';
import { schema as s } from '../../src/infra/db';
import { type AdminApi, adminWith } from '../support/admin-api';
import { type TestApp, createTestApp } from '../support/app';
import { clearIdentityCaches } from '../support/auth';
import { insertCategory, insertService } from '../support/catalog';
import { closeTestDb, resetDb, testDb } from '../support/db';

let t: TestApp;
let admin: AdminApi;

beforeAll(async () => {
  t = await createTestApp();
});
beforeEach(async () => {
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

describe('GET /admin/service-categories', () => {
  it('lists categories by sort with the live service count (archived services are not counted)', async () => {
    const { db } = await testDb();
    const apple = await insertCategory(db, { name: 'Apple', sort: 2 });
    const samsung = await insertCategory(db, { name: 'Samsung', sort: 1, allowedGroupIds: [] });
    await insertService(db, apple);
    await insertService(db, apple);
    await insertService(db, apple, { status: 'disabled', archivedAt: new Date() });

    const res = await admin.get('/admin/service-categories?_start=0&_end=200&_sort=sort&_order=asc');
    expect(res.status).toBe(200);
    expect(res.total).toBe(2);
    expect(res.body).toEqual([
      { id: samsung, name: 'Samsung', type: 'imei', allowedGroupIds: [], sort: 1, isActive: true, serviceCount: 0 },
      { id: apple, name: 'Apple', type: 'imei', allowedGroupIds: [], sort: 2, isActive: true, serviceCount: 2 },
    ]);
    expect((await admin.get('/admin/service-categories?q=app')).total).toBe(1);
    expect((await admin.get('/admin/service-categories?_sort=type')).status).toBe(422);
  });

  it('needs catalog:read', async () => {
    const other = await adminWith(t, ['groups:read']);
    expect((await other.get('/admin/service-categories')).status).toBe(403);
  });
});

describe('GET /admin/service-categories/:id', () => {
  it('shows one category and answers 404 for an unknown id', async () => {
    const { db } = await testDb();
    const id = await insertCategory(db, { name: 'Apple' });
    const res = await admin.get(`/admin/service-categories/${id}`);
    expect(res.body).toMatchObject({ id, name: 'Apple', serviceCount: 0 });
    const missing = await admin.get('/admin/service-categories/999999');
    expect(missing.status).toBe(404);
    expect(missing.body.code).toBe('NOT_FOUND');
  });
});

describe('POST /admin/service-categories', () => {
  it('creates a category, takes the last sort by default, keeps the group list and audits it', async () => {
    const { db } = await testDb();
    const [group] = await db.insert(s.clientGroups).values({ name: 'VIP' }).returning({ id: s.clientGroups.id });
    await insertCategory(db, { sort: 7 });
    const res = await admin.post('/admin/service-categories', {
      name: '  Carrier unlock ',
      type: 'imei',
      allowedGroupIds: [group!.id, group!.id],
    });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      name: 'Carrier unlock',
      type: 'imei',
      allowedGroupIds: [group!.id],
      sort: 8,
      isActive: true,
      serviceCount: 0,
    });
    const [audit] = await auditRows();
    expect(audit).toMatchObject({
      actorId: admin.staffId,
      action: 'created category',
      entityType: 'category',
      entityId: res.body.id,
      entityLabel: 'Carrier unlock',
    });
  });

  it('refuses a name repeated within the type in any case, but allows it in another type', async () => {
    const { db } = await testDb();
    await insertCategory(db, { name: 'Apple', type: 'imei' });
    const refused = await admin.post('/admin/service-categories', { name: ' APPLE ', type: 'imei' });
    expect(refused.status).toBe(422);
    expect(refused.body.errors).toEqual([
      expect.objectContaining({ field: 'name', message: 'A imei category with this name already exists.' }),
    ]);
    expect((await admin.post('/admin/service-categories', { name: 'Apple', type: 'file' })).status).toBe(201);
  });

  it('maps a race on the same name to 422, never 500', async () => {
    const results = await Promise.all(
      Array.from({ length: 4 }, () => admin.post('/admin/service-categories', { name: 'Racing', type: 'server' })),
    );
    expect(results.map((r) => r.status).sort()).toEqual([201, 422, 422, 422]);
    const losers = results.filter((r) => r.status === 422);
    expect(losers.every((r) => r.body.errors[0].field === 'name')).toBe(true);
  });

  it('refuses a bad type, a blank name, a bad sort and unknown groups on the field', async () => {
    const bad = await admin.post('/admin/service-categories', { name: ' ', type: 'phone', sort: -1 });
    expect(bad.status).toBe(422);
    expect(bad.body.errors.map((e: { field: string }) => e.field).sort()).toEqual(['name', 'sort', 'type']);
    const unknown = await admin.post('/admin/service-categories', {
      name: 'X',
      type: 'imei',
      allowedGroupIds: [404, 405],
    });
    expect(unknown.status).toBe(422);
    expect(unknown.body.errors[0]).toMatchObject({
      field: 'allowedGroupIds',
      message: 'Unknown merchant groups: 404, 405.',
    });
    expect(await (await testDb()).db.select().from(s.serviceCategories)).toEqual([]);
  });

  it('needs catalog:create', async () => {
    const other = await adminWith(t, ['catalog:read']);
    expect((await other.post('/admin/service-categories', { name: 'X', type: 'imei' })).status).toBe(403);
  });
});

describe('PATCH /admin/service-categories/:id', () => {
  it('changes only the keys sent and answers the service count', async () => {
    const { db } = await testDb();
    const id = await insertCategory(db, { name: 'Apple', sort: 1 });
    await insertService(db, id);
    const res = await admin.patch(`/admin/service-categories/${id}`, { isActive: false, sort: 9 });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ name: 'Apple', isActive: false, sort: 9, serviceCount: 1 });
    const [audit] = await auditRows();
    expect(audit).toMatchObject({ action: 'edited category', entityType: 'category', entityId: id });
    expect(audit!.before).toMatchObject({ isActive: true, sort: 1 });
    expect(audit!.after).toMatchObject({ isActive: false, sort: 9 });
  });

  it('checks the name against the new type too, even when only the type changes', async () => {
    const { db } = await testDb();
    await insertCategory(db, { name: 'Apple', type: 'file' });
    const id = await insertCategory(db, { name: 'Apple', type: 'imei' });
    const refused = await admin.patch(`/admin/service-categories/${id}`, { type: 'file' });
    expect(refused.status).toBe(422);
    expect(refused.body.errors[0].field).toBe('name');
    expect((await admin.patch(`/admin/service-categories/${id}`, { type: 'remote' })).body.type).toBe('remote');
    // The same name in another case of its own is fine.
    expect((await admin.patch(`/admin/service-categories/${id}`, { name: 'APPLE' })).status).toBe(200);
  });

  it('refuses a type change while live services are in it, and lets archived services follow the change', async () => {
    const { db } = await testDb();
    const id = await insertCategory(db, { name: 'Apple', type: 'imei' });
    const live = await insertService(db, id);
    const archived = await insertService(db, id, { status: 'disabled', archivedAt: new Date() });
    const refused = await admin.patch(`/admin/service-categories/${id}`, { type: 'file' });
    expect(refused.status).toBe(422);
    expect(refused.body.errors[0]).toMatchObject({
      field: 'type',
      message: '1 service in this category is imei. Move them first.',
    });
    await db.delete(s.services).where(eq(s.services.id, live));
    const moved = await admin.patch(`/admin/service-categories/${id}`, { type: 'file' });
    expect(moved.status).toBe(200);
    const [row] = await db.select().from(s.services).where(eq(s.services.id, archived));
    expect(row!.type).toBe('file');
  });

  it('refuses unknown groups, an empty body and an unknown id', async () => {
    const { db } = await testDb();
    const id = await insertCategory(db);
    expect((await admin.patch(`/admin/service-categories/${id}`, { allowedGroupIds: [99] })).body.errors[0].field).toBe(
      'allowedGroupIds',
    );
    expect((await admin.patch(`/admin/service-categories/${id}`, {})).status).toBe(422);
    expect((await admin.patch('/admin/service-categories/999999', { name: 'X' })).status).toBe(404);
  });
});

describe('DELETE /admin/service-categories/:id', () => {
  it('deletes a free category with its category pricing rules and audits it', async () => {
    const { db } = await testDb();
    const id = await insertCategory(db, { name: 'Apple' });
    const other = await insertCategory(db, { name: 'Samsung' });
    const rules = await db
      .insert(s.pricingRules)
      .values([
        { scope: 'category', targetId: id, kind: 'discount', percent: '2' },
        { scope: 'category', targetId: other, kind: 'margin', percent: '3' },
        { scope: 'global', kind: 'margin', percent: '1' },
      ])
      .returning({ id: s.pricingRules.id });
    const res = await admin.delete(`/admin/service-categories/${id}`);
    expect(res.status).toBe(204);
    expect((await db.select().from(s.serviceCategories)).map((c) => c.id)).toEqual([other]);
    expect((await db.select().from(s.pricingRules)).map((r) => r.id)).toEqual([rules[1]!.id, rules[2]!.id]);
    const [audit] = await auditRows();
    expect(audit).toMatchObject({
      action: 'deleted category',
      entityType: 'category',
      entityId: id,
      entityLabel: 'Apple',
    });
    expect(audit!.before).toMatchObject({ removedPricingRuleIds: [rules[0]!.id] });
  });

  it('refuses a category with live services, with the count in the detail', async () => {
    const { db } = await testDb();
    const id = await insertCategory(db, { name: 'Apple' });
    await insertService(db, id);
    await insertService(db, id);
    const res = await admin.delete(`/admin/service-categories/${id}`);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('CATEGORY_IN_USE');
    expect(res.body.detail).toBe('Apple still has 2 services. Move them to another category first.');
    expect((await db.select().from(s.serviceCategories)).length).toBe(1);
  });

  it('refuses a category with only archived services, and says to turn it off', async () => {
    const { db } = await testDb();
    const id = await insertCategory(db, { name: 'Apple' });
    await insertService(db, id, { status: 'disabled', archivedAt: new Date() });
    const res = await admin.delete(`/admin/service-categories/${id}`);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('CATEGORY_IN_USE');
    expect(res.body.detail).toBe(
      'Apple still has 1 archived service kept for order history, so it cannot be deleted. Turn it off instead.',
    );
  });

  it('answers 404 and needs catalog:delete', async () => {
    expect((await admin.delete('/admin/service-categories/999999')).status).toBe(404);
    const { db } = await testDb();
    const id = await insertCategory(db);
    const other = await adminWith(t, ['catalog:read', 'catalog:update']);
    expect((await other.delete(`/admin/service-categories/${id}`)).status).toBe(403);
  });
});

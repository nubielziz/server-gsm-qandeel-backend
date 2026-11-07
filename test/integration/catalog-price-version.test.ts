// The catalog price version (decision 022, user rule 9 (c)): every write that can change a resolved price moves it after the
// commit, and a refused write does not. The writers of feature 4a (services, groups, categories) are covered here; the
// writers of feature 4b have their own tests next to their routes.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { CATALOG_VERSION_NAME, CatalogPriceVersion } from '../../src/modules/catalog';
import { CacheKeys, CacheService } from '../../src/infra/cache';
import { type AdminApi, adminWith } from '../support/admin-api';
import { type TestApp, createTestApp } from '../support/app';
import { clearIdentityCaches } from '../support/auth';
import { insertCategory } from '../support/catalog';
import { closeTestDb, resetDb, testDb } from '../support/db';
import { catalogVersionOf, insertAtt, insertDemoGroups } from '../support/pricing';

let t: TestApp;
let admin: AdminApi;

beforeAll(async () => {
  t = await createTestApp();
});
beforeEach(async () => {
  await resetDb();
  await clearIdentityCaches(t);
  admin = await adminWith(t, ['catalog:*', 'groups:*'], { name: 'Rami K.' });
});
afterAll(async () => {
  await resetDb();
  await clearIdentityCaches(t);
  await t.close();
  await closeTestDb();
});

/** Runs a write and tells whether it moved the version. */
async function moves(write: () => Promise<{ status: number }>, expected: number): Promise<boolean> {
  const before = await catalogVersionOf(t);
  const res = await write();
  expect(res.status).toBe(expected);
  return (await catalogVersionOf(t)) !== before;
}

describe('the catalog price version', () => {
  it('stays the same between reads and moves on bump, which empties every versioned key at once', async () => {
    const version = t.app.get(CatalogPriceVersion);
    const keys = t.app.get(CacheKeys);
    const cache = t.app.get(CacheService);
    const key = keys.session('probe');
    const first = await version.versioned(key);
    expect(await version.versioned(key)).toBe(first);
    expect(first).toMatch(/:v\d+$/);
    await cache.getOrLoad(first, 60, () => Promise.resolve('cached list'));
    expect(await version.bump()).toBeNumber();
    const second = await version.versioned(key);
    expect(second).not.toBe(first);
    expect(await cache.getOrLoad(second, 60, () => Promise.resolve('fresh list'))).toBe('fresh list');
    expect(CATALOG_VERSION_NAME).toBe('catalog');
  });

  it('moves after a service is created, repriced, edited and deleted', async () => {
    const { db } = await testDb();
    const category = await insertCategory(db, { name: 'Carrier unlock' });
    const created = {
      name: 'New',
      code: 'NEW',
      categoryId: category,
      type: 'imei',
      slaMinutes: 60,
      basePrice: '5.0000',
    };
    let id = 0;
    expect(
      await moves(async () => {
        const res = await admin.post('/admin/services', created);
        id = res.body.id;
        return res;
      }, 201),
    ).toBe(true);
    expect(await moves(() => admin.patch(`/admin/services/${id}`, { basePrice: '6.0000' }), 200)).toBe(true);
    expect(await moves(() => admin.patch(`/admin/services/${id}`, { status: 'disabled' }), 200)).toBe(true);
    expect(await moves(() => admin.delete(`/admin/services/${id}`), 204)).toBe(true);
  });

  it('does not move when a service write is refused', async () => {
    const { db } = await testDb();
    const { serviceId } = await insertAtt(db);
    expect(await moves(() => admin.patch(`/admin/services/${serviceId}`, { basePrice: '1.0000' }), 422)).toBe(false);
    expect(await moves(() => admin.patch('/admin/services/9999', { basePrice: '20.0000' }), 404)).toBe(false);
    expect(await moves(() => admin.delete('/admin/services/9999'), 404)).toBe(false);
  });

  it('moves when a group discount changes or a group is deleted, and not for a rename', async () => {
    const { db } = await testDb();
    const groups = await insertDemoGroups(db);
    const extra = await admin.post('/admin/client-groups', { name: 'Resellers', discountPercent: '3' });
    expect(extra.status).toBe(201);
    expect(await moves(() => admin.patch(`/admin/client-groups/${groups.vip}`, { name: 'VIP plus' }), 200)).toBe(false);
    expect(await moves(() => admin.patch(`/admin/client-groups/${groups.vip}`, { discountPercent: '9' }), 200)).toBe(
      true,
    );
    expect(await moves(() => admin.delete(`/admin/client-groups/${extra.body.id}`), 204)).toBe(true);
    expect(await moves(() => admin.delete('/admin/client-groups/9999'), 404)).toBe(false);
  });

  it('moves when a category changes or is deleted', async () => {
    const { db } = await testDb();
    const category = await insertCategory(db, { name: 'Temporary' });
    expect(await moves(() => admin.patch(`/admin/service-categories/${category}`, { isActive: false }), 200)).toBe(
      true,
    );
    expect(await moves(() => admin.delete(`/admin/service-categories/${category}`), 204)).toBe(true);
    expect(await moves(() => admin.patch('/admin/service-categories/9999', { isActive: false }), 404)).toBe(false);
  });

  it('reports a failed bump instead of throwing, and works again afterwards', async () => {
    const version = t.app.get(CatalogPriceVersion);
    const cache = t.app.get(CacheService);
    const original = cache.bumpVersion.bind(cache);
    cache.bumpVersion = () => Promise.reject(new Error('redis is down'));
    try {
      expect(await version.bump()).toBeUndefined();
    } finally {
      cache.bumpVersion = original;
    }
    expect(await version.bump()).toBeNumber();
  });
});

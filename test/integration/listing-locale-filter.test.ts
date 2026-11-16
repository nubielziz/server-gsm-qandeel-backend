// Integration test of the `locale` filter of GET /admin/service-listings (feature 29, slice B1): the console's pin picker lists the
// English listings only (`?locale=en`); an unknown language is a 422.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { type AdminApi, adminWith } from '../support/admin-api';
import { type TestApp, createTestApp } from '../support/app';
import { clearIdentityCaches } from '../support/auth';
import { closeTestDb, resetDb, testDb } from '../support/db';
import { insertListingRow, listingWorld } from '../support/storefront';

let t: TestApp;
let admin: AdminApi;

beforeAll(async () => {
  t = await createTestApp();
});
beforeEach(async () => {
  await resetDb();
  await clearIdentityCaches(t);
  admin = await adminWith(t, ['storefront:read']);
});
afterAll(async () => {
  await resetDb();
  await t.close();
  await closeTestDb();
});

describe('GET /admin/service-listings?locale=', () => {
  it('lists the listings of one language, counted in x-total-count, and combines with the search', async () => {
    const { db } = await testDb();
    const world = await listingWorld(db);
    const english = await insertListingRow(db, world.att, { publicTitle: 'AT&T USA Unlock', locale: 'en' });
    const arabic = await insertListingRow(db, world.att, { publicTitle: 'فك شبكة AT&T', locale: 'ar' });
    const check = await insertListingRow(db, world.check, { publicTitle: 'iCloud Check', locale: 'en' });

    const en = await admin.get('/admin/service-listings?locale=en&_sort=id&_order=asc');
    expect(en.status).toBe(200);
    expect(en.body.map((row: { id: number }) => row.id)).toEqual([english, check]);
    expect(en.total).toBe(2);
    const ar = await admin.get('/admin/service-listings?locale=ar');
    expect(ar.body.map((row: { id: number; locale: string }) => [row.id, row.locale])).toEqual([[arabic, 'ar']]);
    expect(ar.total).toBe(1);
    const both = await admin.get('/admin/service-listings');
    expect(both.total).toBe(3);
    const searched = await admin.get('/admin/service-listings?locale=en&q=icloud');
    expect(searched.body.map((row: { id: number }) => row.id)).toEqual([check]);
  });

  it('refuses a language the shop does not have', async () => {
    const res = await admin.get('/admin/service-listings?locale=fr');
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('VALIDATION_FAILED');
  });
});

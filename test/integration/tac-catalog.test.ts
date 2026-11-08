// Integration tests of the TAC catalog routes (feature 14b, GET and POST /admin/tac-catalog, GET and PATCH /admin/tac-catalog/:id;
// RESOLUTIONS catalog-7 and catalog-8): search, filter and sort, the wire form of an unknown year, TAC_TAKEN, the year bounds from the
// clock, the TAC that IMEI checks already used, permissions and the audit trail.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { asc, eq } from 'drizzle-orm';
import { schema as s } from '../../src/infra/db';
import { type TestApp, createTestApp } from '../support/app';
import { clearIdentityCaches, signInStaff } from '../support/auth';
import { TestClock } from '../support/clock';
import { closeTestDb, resetDb, testDb } from '../support/db';

const clock = new TestClock('2026-11-07T10:00:00.000Z');
let t: TestApp;

beforeAll(async () => {
  t = await createTestApp({ clock });
});
afterAll(async () => {
  await resetDb();
  await t.close();
  await closeTestDb();
});
beforeEach(async () => {
  clock.set('2026-11-07T10:00:00.000Z');
  await resetDb();
  await clearIdentityCaches(t);
});

type Staff = Awaited<ReturnType<typeof signInStaff>>;
const get = (staff: Staff, url: string) => t.app.inject({ method: 'GET', url, headers: staff.session.headers });
const send = (staff: Staff, method: 'POST' | 'PATCH', url: string, payload: unknown) =>
  t.app.inject({ method, url, headers: staff.session.mutationHeaders, payload: payload as never });
const problem = (res: { json: () => unknown }) =>
  res.json() as { code: string; errors?: Array<{ field: string; message: string }> };

/** The demo's eight TACs (src/features/storefront mocks seed), one of them without a year. */
async function seedTacs(): Promise<void> {
  const { db } = await testDb();
  await db.insert(s.tacCatalog).values([
    {
      tac: '35389011',
      brand: 'Apple',
      model: 'A2633',
      marketingName: 'iPhone 13',
      releaseYear: 2021,
      source: 'import',
    },
    {
      tac: '35925410',
      brand: 'Apple',
      model: 'A2889',
      marketingName: 'iPhone 14 Pro',
      releaseYear: 2022,
      source: 'import',
    },
    {
      tac: '35290511',
      brand: 'Samsung',
      model: 'SM-S911B',
      marketingName: 'Galaxy S23',
      releaseYear: 2023,
      source: 'import',
    },
    { tac: '35460711', brand: 'Google', model: 'GVU6C', marketingName: 'Pixel 7', releaseYear: null, source: 'import' },
  ]);
}
const tacs = (res: { json: () => unknown }) => (res.json() as Array<{ tac: string }>).map((row) => row.tac);

describe('GET /admin/tac-catalog', () => {
  it('lists entries by TAC with x-total-count, sending 0 for an unknown year (catalog-8)', async () => {
    await seedTacs();
    const staff = await signInStaff(t, ['catalog:read']);
    const res = await get(staff, '/admin/tac-catalog');
    expect(res.statusCode).toBe(200);
    expect(res.headers['x-total-count']).toBe('4');
    expect(tacs(res)).toEqual(['35290511', '35389011', '35460711', '35925410']);
    expect(res.json<Array<Record<string, unknown>>>()[2]).toEqual({
      id: expect.any(Number),
      tac: '35460711',
      brand: 'Google',
      model: 'GVU6C',
      marketingName: 'Pixel 7',
      releaseYear: 0,
      source: 'import',
    });
  });

  it('searches the TAC prefix, the brand, the model code and the marketing name, ignoring case', async () => {
    await seedTacs();
    const staff = await signInStaff(t, ['catalog:read']);
    expect(tacs(await get(staff, '/admin/tac-catalog?q=3538'))).toEqual(['35389011']);
    expect(tacs(await get(staff, '/admin/tac-catalog?q=APPLE'))).toEqual(['35389011', '35925410']);
    expect(tacs(await get(staff, '/admin/tac-catalog?q=sm-s9'))).toEqual(['35290511']);
    expect(tacs(await get(staff, '/admin/tac-catalog?q=pixel'))).toEqual(['35460711']);
    expect(tacs(await get(staff, '/admin/tac-catalog?q=nothing'))).toEqual([]);
    // The percent sign is text, not a wildcard.
    expect(tacs(await get(staff, '/admin/tac-catalog?q=%25'))).toEqual([]);
  });

  it('filters by brand, sorts (an unknown year first in ascending order, like 0), and pages', async () => {
    await seedTacs();
    const staff = await signInStaff(t, ['catalog:read']);
    expect(tacs(await get(staff, '/admin/tac-catalog?brand=Apple'))).toEqual(['35389011', '35925410']);
    expect(tacs(await get(staff, '/admin/tac-catalog?_sort=releaseYear&_order=asc'))).toEqual([
      '35460711',
      '35389011',
      '35925410',
      '35290511',
    ]);
    expect(tacs(await get(staff, '/admin/tac-catalog?_sort=releaseYear&_order=desc')).at(-1)).toBe('35460711');
    expect(tacs(await get(staff, '/admin/tac-catalog?_sort=brand&_order=desc'))[0]).toBe('35290511');
    expect(tacs(await get(staff, '/admin/tac-catalog?_sort=model&_order=asc'))[0]).toBe('35389011');
    const page = await get(staff, '/admin/tac-catalog?_start=1&_end=3');
    expect(tacs(page)).toEqual(['35389011', '35460711']);
    expect(page.headers['x-total-count']).toBe('4');
    expect((await get(staff, '/admin/tac-catalog?_sort=source')).statusCode).toBe(422);
  });

  it('needs catalog:read', async () => {
    const staff = await signInStaff(t, ['orders:read']);
    expect((await get(staff, '/admin/tac-catalog')).statusCode).toBe(403);
    expect((await t.app.inject({ method: 'GET', url: '/admin/tac-catalog' })).statusCode).toBe(401);
  });
});

describe('GET /admin/tac-catalog/:id', () => {
  it('shows one entry, and answers 404 for an unknown id', async () => {
    await seedTacs();
    const { db } = await testDb();
    const [row] = await db.select().from(s.tacCatalog).where(eq(s.tacCatalog.tac, '35389011'));
    const staff = await signInStaff(t, ['catalog:read']);
    const res = await get(staff, `/admin/tac-catalog/${row!.id}`);
    expect(res.json()).toEqual({
      id: row!.id,
      tac: '35389011',
      brand: 'Apple',
      model: 'A2633',
      marketingName: 'iPhone 13',
      releaseYear: 2021,
      source: 'import',
    });
    const missing = await get(staff, '/admin/tac-catalog/999999');
    expect(missing.statusCode).toBe(404);
    expect(problem(missing).code).toBe('NOT_FOUND');
  });
});

describe('POST /admin/tac-catalog', () => {
  it('adds an entry with source manual, trimmed text, a missing year stored as unknown and sent as 0, and audits it', async () => {
    const staff = await signInStaff(t, ['catalog:create']);
    const res = await send(staff, 'POST', '/admin/tac-catalog', {
      tac: ' 86741205 ',
      brand: ' Xiaomi ',
      model: ' 23021RAAEG ',
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toEqual({
      id: expect.any(Number),
      tac: '86741205',
      brand: 'Xiaomi',
      model: '23021RAAEG',
      marketingName: '',
      releaseYear: 0,
      source: 'manual',
    });
    const { db } = await testDb();
    const [row] = await db.select().from(s.tacCatalog);
    expect(row).toMatchObject({ releaseYear: null, createdAt: new Date('2026-11-07T10:00:00.000Z') });
    const [audit] = await db.select().from(s.auditLogs);
    expect(audit).toMatchObject({
      action: 'added TAC entry',
      entityType: 'tac_entry',
      entityId: row!.id,
      entityLabel: '86741205 Xiaomi 23021RAAEG',
      before: null,
      after: { tac: '86741205', brand: 'Xiaomi', model: '23021RAAEG', marketingName: '', releaseYear: 0 },
    });

    const full = await send(staff, 'POST', '/admin/tac-catalog', {
      tac: '35691211',
      brand: 'Apple',
      model: 'A2221',
      marketingName: 'iPhone 11',
      releaseYear: 2019,
    });
    expect(full.json()).toMatchObject({ marketingName: 'iPhone 11', releaseYear: 2019, source: 'manual' });
  });

  it('answers 409 TAC_TAKEN on tac for a TAC already in the catalog, also when two requests race', async () => {
    await seedTacs();
    const staff = await signInStaff(t, ['catalog:create']);
    const taken = await send(staff, 'POST', '/admin/tac-catalog', { tac: '35389011', brand: 'Apple', model: 'A2633' });
    expect(taken.statusCode).toBe(409);
    expect(problem(taken)).toMatchObject({ code: 'TAC_TAKEN', errors: [{ field: 'tac' }] });

    const body = { tac: '12345678', brand: 'Acme', model: 'X1' };
    const results = await Promise.all([
      send(staff, 'POST', '/admin/tac-catalog', body),
      send(staff, 'POST', '/admin/tac-catalog', body),
    ]);
    expect(results.map((res) => res.statusCode).sort()).toEqual([201, 409]);
  });

  it('answers 422 on each bad field, with the year bounds taken from the clock', async () => {
    const staff = await signInStaff(t, ['catalog:create']);
    const bad = await send(staff, 'POST', '/admin/tac-catalog', { tac: '1234', brand: ' ', model: '' });
    expect(bad.statusCode).toBe(422);
    expect(
      problem(bad)
        .errors?.map((e) => e.field)
        .sort(),
    ).toEqual(['brand', 'model', 'tac']);

    const year = (releaseYear: unknown) =>
      send(staff, 'POST', '/admin/tac-catalog', { tac: '12345678', brand: 'Acme', model: 'X1', releaseYear });
    for (const releaseYear of [0, null, 1989, 2028, 2020.5, '2020']) {
      const res = await year(releaseYear);
      expect(res.statusCode, String(releaseYear)).toBe(422);
      expect(
        problem(res).errors?.map((e) => e.field),
        String(releaseYear),
      ).toEqual(['releaseYear']);
    }
    // Next year is allowed; the clock decides which year that is.
    expect((await year(2027)).statusCode).toBe(201);
    // A new year: the staff session of the old one has ended, so sign in again.
    clock.set('2027-01-02T00:00:00.000Z');
    const { db } = await testDb();
    await db.delete(s.tacCatalog);
    const later = await signInStaff(t, ['catalog:create']);
    const nextYear = (releaseYear: number) =>
      send(later, 'POST', '/admin/tac-catalog', { tac: '12345678', brand: 'Acme', model: 'X1', releaseYear });
    expect((await nextYear(2029)).statusCode).toBe(422);
    expect((await nextYear(2028)).statusCode).toBe(201);
  });

  it('needs catalog:create and the CSRF token', async () => {
    const reader = await signInStaff(t, ['catalog:read']);
    expect(
      (await send(reader, 'POST', '/admin/tac-catalog', { tac: '12345678', brand: 'A', model: 'B' })).statusCode,
    ).toBe(403);
    const writer = await signInStaff(t, ['catalog:create']);
    const noToken = await t.app.inject({
      method: 'POST',
      url: '/admin/tac-catalog',
      headers: writer.session.headers,
      payload: { tac: '12345678', brand: 'A', model: 'B' },
    });
    expect(problem(noToken).code).toBe('CSRF_FAILED');
  });
});

describe('PATCH /admin/tac-catalog/:id', () => {
  async function entry(tac = '35389011'): Promise<number> {
    await seedTacs();
    const { db } = await testDb();
    const [row] = await db.select().from(s.tacCatalog).where(eq(s.tacCatalog.tac, tac));
    return row!.id;
  }

  it('changes the fields sent and audits the old and new values; a year cannot be cleared', async () => {
    const id = await entry();
    const staff = await signInStaff(t, ['catalog:update']);
    const res = await send(staff, 'PATCH', `/admin/tac-catalog/${id}`, {
      brand: ' Apple Inc ',
      marketingName: 'iPhone 13 (128 GB)',
      releaseYear: 2022,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      id,
      tac: '35389011',
      brand: 'Apple Inc',
      marketingName: 'iPhone 13 (128 GB)',
      releaseYear: 2022,
    });
    const { db } = await testDb();
    const [audit] = await db.select().from(s.auditLogs).orderBy(asc(s.auditLogs.id));
    expect(audit).toMatchObject({
      action: 'edited TAC entry',
      entityType: 'tac_entry',
      entityId: id,
      before: { brand: 'Apple', marketingName: 'iPhone 13', releaseYear: 2021 },
      after: { brand: 'Apple Inc', marketingName: 'iPhone 13 (128 GB)', releaseYear: 2022 },
    });
    for (const releaseYear of [0, null]) {
      expect((await send(staff, 'PATCH', `/admin/tac-catalog/${id}`, { releaseYear })).statusCode).toBe(422);
    }
    const empty = await send(staff, 'PATCH', `/admin/tac-catalog/${id}`, { brand: ' ' });
    expect(empty.statusCode).toBe(422);
    expect(problem(empty).errors?.map((e) => e.field)).toEqual(['brand']);
  });

  it('changes the TAC while no IMEI check used the old one, and refuses it with 422 on tac once one did (catalog-7)', async () => {
    const id = await entry();
    const staff = await signInStaff(t, ['catalog:update']);
    const moved = await send(staff, 'PATCH', `/admin/tac-catalog/${id}`, { tac: '35389099' });
    expect(moved.statusCode).toBe(200);
    expect(moved.json()).toMatchObject({ tac: '35389099' });

    const { db } = await testDb();
    const check = (tac: string) =>
      db.insert(s.imeiChecks).values({ tac, checkType: 'basic', source: 'storefront_free', status: 'clean' });
    await check('35389099');
    await check('35389099');
    const refused = await send(staff, 'PATCH', `/admin/tac-catalog/${id}`, { tac: '35389100' });
    expect(refused.statusCode).toBe(422);
    expect(problem(refused)).toMatchObject({
      code: 'VALIDATION_FAILED',
      errors: [
        { field: 'tac', message: '2 IMEI checks already use TAC 35389099; add a new entry for the new TAC instead.' },
      ],
    });
    const [row] = await db.select().from(s.tacCatalog).where(eq(s.tacCatalog.id, id));
    expect(row!.tac).toBe('35389099');
    // The same TAC again, or a change of the other fields, is fine.
    expect(
      (await send(staff, 'PATCH', `/admin/tac-catalog/${id}`, { tac: '35389099', model: 'A2634' })).statusCode,
    ).toBe(200);
  });

  it('answers 409 TAC_TAKEN when another entry has the new TAC, 422 on a malformed TAC, and 404 for an unknown id', async () => {
    const id = await entry();
    const staff = await signInStaff(t, ['catalog:update']);
    const taken = await send(staff, 'PATCH', `/admin/tac-catalog/${id}`, { tac: '35925410' });
    expect(taken.statusCode).toBe(409);
    expect(problem(taken)).toMatchObject({ code: 'TAC_TAKEN', errors: [{ field: 'tac' }] });
    const malformed = await send(staff, 'PATCH', `/admin/tac-catalog/${id}`, { tac: '35925' });
    expect(problem(malformed).errors?.map((e) => e.field)).toEqual(['tac']);
    expect((await send(staff, 'PATCH', '/admin/tac-catalog/999999', { brand: 'Acme' })).statusCode).toBe(404);
    // An empty edit changes nothing, and a staff write is still audited.
    expect((await send(staff, 'PATCH', `/admin/tac-catalog/${id}`, {})).statusCode).toBe(200);
    const { db } = await testDb();
    expect(await db.select().from(s.auditLogs)).toHaveLength(1);
  });

  it('needs catalog:update', async () => {
    const id = await entry();
    const reader = await signInStaff(t, ['catalog:create']);
    expect((await send(reader, 'PATCH', `/admin/tac-catalog/${id}`, { brand: 'Acme' })).statusCode).toBe(403);
  });
});

// Integration test of migration 0005 (feature 4a): a default merchant group and the storefront retail group always exist. The
// migration SQL is run again on the emptied test database, in each starting state the real databases can be in, and the invite
// route that answered 500 on a fresh database (seen at runtime on 2026-11-07) is called afterwards.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { schema as s } from '../../src/infra/db';
import { adminWith } from '../support/admin-api';
import { type TestApp, createTestApp } from '../support/app';
import { clearIdentityCaches } from '../support/auth';
import { closeTestDb, resetDb, testDb } from '../support/db';

const MIGRATION = readFileSync(join(import.meta.dir, '../../drizzle/0005_default_client_groups.sql'), 'utf8');
let t: TestApp;

beforeAll(async () => {
  t = await createTestApp();
});
beforeEach(async () => {
  await resetDb();
  await clearIdentityCaches(t);
});
afterAll(async () => {
  await resetDb();
  await clearIdentityCaches(t);
  await t.close();
  await closeTestDb();
});

async function migrate(): Promise<void> {
  const { pool } = await testDb();
  await pool.query(MIGRATION);
}
const groups = async () => (await testDb()).db.select().from(s.clientGroups).orderBy(s.clientGroups.id);

describe('migration 0005, default client groups', () => {
  it('adds the default merchant group and the storefront retail group to an empty table', async () => {
    await migrate();
    const rows = await groups();
    expect(
      rows.map((g) => [
        g.name,
        g.kind,
        g.isDefault,
        g.earnThreshold,
        g.depositLimit,
        g.overdraftAllowed,
        g.discountPercent,
      ]),
    ).toEqual([
      ['Standard', 'b2b', true, '0.0000', '0.0000', false, '0.0000'],
      ['Storefront retail', 'b2c_retail', false, '0.0000', '0.0000', false, '0.0000'],
    ]);
  });

  it('is safe to run again: it adds nothing to a database that has both', async () => {
    await migrate();
    await migrate();
    expect(await groups()).toHaveLength(2);
  });

  it('marks an existing merchant group as the default instead of adding one, and still adds the retail group', async () => {
    const { db } = await testDb();
    await db.insert(s.clientGroups).values([
      { name: 'Wholesale', sort: 5 },
      { name: 'Premium', sort: 2 },
    ]);
    await migrate();
    const rows = await groups();
    expect(rows.filter((g) => g.isDefault).map((g) => g.name)).toEqual(['Premium']);
    expect(rows.map((g) => g.name).sort()).toEqual(['Premium', 'Storefront retail', 'Wholesale']);
  });

  it('keeps an existing default group and an existing retail group, and changes nothing', async () => {
    const { db } = await testDb();
    await db.insert(s.clientGroups).values([
      { name: 'Mine', isDefault: true },
      { name: 'Shop', kind: 'b2c_retail' },
    ]);
    await migrate();
    expect((await groups()).map((g) => g.name)).toEqual(['Mine', 'Shop']);
  });

  it('picks other names when the usual ones are taken', async () => {
    const { db } = await testDb();
    // Only a retail group called Standard, and a b2b non-default... none: the default needs a new name.
    await db.insert(s.clientGroups).values({ name: 'standard', kind: 'b2c_retail' });
    await migrate();
    const rows = await groups();
    expect(rows.find((g) => g.isDefault)?.name).toBe('Default merchant group');
    await resetDb();
    await db.insert(s.clientGroups).values({ name: 'Storefront retail', isDefault: true });
    await migrate();
    expect((await groups()).find((g) => g.kind === 'b2c_retail')?.name).toBe('Storefront retail (storefront)');
  });

  it('lets a merchant be invited on a fresh database (it answered 500 before)', async () => {
    await migrate();
    const admin = await adminWith(t, ['clients:*', 'wallet:*', 'groups:*'], { name: 'Rami K.' });
    const { db } = await testDb();
    await db
      .insert(s.currencies)
      .values({ code: 'USD', name: 'US dollar', rateToBase: '1', decimals: 2 })
      .onConflictDoNothing();
    const res = await admin.post('/admin/clients', {
      name: 'First Merchant',
      email: 'first@example.com',
      country: 'JO',
      invite: true,
    });
    expect(res.status).toBe(201);
    expect(res.body.group).toMatchObject({ name: 'Standard' });
    // The default group is protected by the group routes.
    const standard = (await groups()).find((g) => g.isDefault)!;
    expect((await admin.delete(`/admin/client-groups/${standard.id}`)).body.code).toBe('GROUP_IN_USE');
    expect((await admin.patch(`/admin/client-groups/${standard.id}`, { isDefault: false })).body.code).toBe(
      'DEFAULT_GROUP_REQUIRED',
    );
  });
});

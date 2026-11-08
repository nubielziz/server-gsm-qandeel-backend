// The customers and TAC seed (feature 14b): the demo's customers and TACs appear with the ids, names, statuses and risk words of the
// frontend mocks, through the real API, and a second run changes nothing.
import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from 'bun:test';
import { existsSync } from 'node:fs';
import { eq } from 'drizzle-orm';
import { seedCustomerDevCredentials } from '../../scripts/seed/customers';
import { demoStatePath, loadDemoState } from '../../scripts/seed/demo-state';
import { runSeed } from '../../scripts/seed/run';
import { PasswordHasher } from '../../src/infra/crypto';
import { schema as s } from '../../src/infra/db';
import { IpRuleCache } from '../../src/modules/identity';
import { MaintenanceService } from '../../src/modules/platform';
import { type AdminApi, adminWith } from '../support/admin-api';
import { type TestApp, createTestApp } from '../support/app';
import { clearIdentityCaches } from '../support/auth';
import { closeTestDb, resetDb, testDb } from '../support/db';
import { StoreClient, clearStoreRateLimits } from '../support/store';

setDefaultTimeout(180_000);

const frontendPresent = existsSync(demoStatePath());
let t: TestApp;
let staff: AdminApi;

beforeAll(async () => {
  if (!frontendPresent) return;
  t = await createTestApp();
  await resetDb();
  await clearIdentityCaches(t);
  await clearStoreRateLimits(t);
  const { db } = await testDb();
  await runSeed(db, await loadDemoState(), t.config);
  // The seed wrote IP rules and the allowlist switch straight to Postgres: drop any snapshot another file left in the shared cache.
  await t.app.get(IpRuleCache).invalidate();
  staff = await adminWith(t, ['customers:*', 'catalog:*']);
});
/**
 * Empties the database and every cache the seed filled.
 *
 * Why: the seed writes the demo's IP rules (an admin allowlist), and every test app shares the cache Redis: a snapshot left behind
 * would refuse the next file's `/admin` requests with `403 IP_NOT_ALLOWED` (test/README.md, request pipeline tests).
 */
async function cleanUp(): Promise<void> {
  await resetDb();
  await clearIdentityCaches(t);
  await t.app.get(IpRuleCache).invalidate();
  await t.app.get(MaintenanceService).invalidate();
}

afterAll(async () => {
  if (!frontendPresent) return;
  await cleanUp();
  await t.close();
  await closeTestDb();
});

describe.skipIf(!frontendPresent)('the customers seed', () => {
  it("writes the demo's 30 customers by their demo ids, with the currency of the country and `medium` for the demo's `med`", async () => {
    const { db } = await testDb();
    // The growth seed (feature 19) adds a guest customer per left checkout from id 900 000; the demo's own customers come first.
    const rows = (await db.select().from(s.customers).orderBy(s.customers.id)).filter((row) => row.id < 900_000);
    expect(rows).toHaveLength(30);
    expect(rows.map((row) => row.id)).toEqual(Array.from({ length: 30 }, (_, index) => index + 1));
    expect(rows[0]).toMatchObject({
      id: 1,
      name: 'Daniel Whitmore',
      email: 'daniel.whitmore@mail.example',
      country: 'GB',
      currency: 'GBP',
      locale: 'en',
      hasAccount: true,
      status: 'active',
      riskLevel: 'low',
      createdBy: null,
      totalSpent: '0.0000',
    });
    expect(rows.filter((row) => row.status === 'blocked')).toHaveLength(1);
    expect(rows.filter((row) => row.status === 'suspended')).toHaveLength(1);
    expect(rows.filter((row) => row.riskLevel === 'medium').length).toBeGreaterThan(0);
    // Every account has a credentials row without a password; guests have none.
    const credentials = await db.select().from(s.customerCredentials);
    expect(credentials).toHaveLength(rows.filter((row) => row.hasAccount).length);
    expect(credentials.every((row) => row.passwordHash === null)).toBe(true);
  });

  it('shows through the admin routes as the console expects, and the detail answers for a seeded customer', async () => {
    // Descending, so the demo's named customers come before the growth seed's nameless guests (an empty name sorts first).
    const list = await staff.get('/admin/customers?_start=0&_end=100&_sort=name&_order=desc');
    expect(list.status).toBe(200);
    // Every customer row counts, the growth seed's guests included.
    const { db } = await testDb();
    expect(list.total).toBe((await db.select({ id: s.customers.id }).from(s.customers)).length);
    const named = list.body.filter((row: { name: string }) => row.name !== '');
    expect(named).toHaveLength(30);
    expect(named.at(-1)).toMatchObject({ name: 'Ana Costa', currencyCode: 'EUR', ordersCount: 0 });
    const blocked = await staff.get('/admin/customers?status=blocked');
    expect(blocked.total).toBe(1);
    expect(blocked.body[0]).toMatchObject({ riskLevel: 'high', status: 'blocked' });
    const detail = await staff.get('/admin/customers/1');
    expect(detail.status).toBe(200);
    expect(detail.body).toMatchObject({ id: 1, name: 'Daniel Whitmore', account: { mustChangePassword: false } });
  });

  it("writes the demo's eight TACs with the model code and the marketing name the console shows", async () => {
    const list = await staff.get('/admin/tac-catalog?_sort=tac&_order=asc');
    expect(list.total).toBe(8);
    expect(list.body.find((row: { tac: string }) => row.tac === '35389011')).toEqual({
      id: expect.any(Number),
      tac: '35389011',
      brand: 'Apple',
      model: 'A2633',
      marketingName: 'iPhone 13',
      releaseYear: 2021,
      source: 'import',
    });
  });

  it('is idempotent: a second run inserts nothing', async () => {
    const { db } = await testDb();
    const reports = await runSeed(db, await loadDemoState(), t.config);
    for (const report of reports.filter((r) =>
      ['customers', 'customer_credentials', 'tac_catalog'].includes(r.table),
    )) {
      expect(report.inserted, report.table).toBe(0);
    }
  });

  it('gives the accounts the development password once, and only to the ones that do not have to change a password', async () => {
    const { db } = await testDb();
    const first = await seedCustomerDevCredentials(db, t.config);
    expect(first.inserted).toBeGreaterThan(0);
    const second = await seedCustomerDevCredentials(db, t.config);
    expect(second.inserted).toBe(0);
    const [account] = await db
      .select()
      .from(s.customerCredentials)
      .where(eq(s.customerCredentials.mustChangePassword, false))
      .limit(1);
    expect(await t.app.get(PasswordHasher).verify(account!.passwordHash!, 'demo-password')).toBe(true);
    const customer = (await db.select().from(s.customers).where(eq(s.customers.id, account!.customerId)))[0]!;
    const login = await new StoreClient(t, '198.18.99.9').login(customer.email, 'demo-password');
    expect(login.statusCode).toBe(200);
  });

  // Keep this test last: it empties the database.
  it('leaves no IP rule snapshot behind: after the clean-up an admin request from any address is not refused by the allowlist', async () => {
    const { db } = await testDb();
    expect((await db.select().from(s.ipRules)).length).toBeGreaterThan(0);
    // The seeded rules are in force and cached from the admin requests above.
    const refused = await t.app.inject({ method: 'GET', url: '/admin/auth/me', remoteAddress: '203.0.113.77' });
    expect(refused.statusCode).toBe(403);
    expect(refused.json().code).toBe('IP_NOT_ALLOWED');

    await cleanUp();
    const after = await t.app.inject({ method: 'GET', url: '/admin/auth/me', remoteAddress: '203.0.113.78' });
    expect(after.statusCode).toBe(401);
  });
});

// The customers and TAC seed (feature 14b, decision 064): the demo's customers and TACs appear with the ids, names and statuses of the
// frontend mocks, through the real API (the demo's customer cN is the retail account 100 + N), and a second run changes nothing.
import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from 'bun:test';
import { existsSync } from 'node:fs';
import { and, between, eq, isNotNull } from 'drizzle-orm';
import { seedCustomerDevCredentials } from '../../../scripts/seed/customers';
import { demoStatePath, loadDemoState } from '../../../scripts/seed/demo-state';
import { runSeed } from '../../../scripts/seed/run';
import { PasswordHasher } from '@src/infra/crypto';
import { schema as s } from '@src/infra/db';
import { IpRuleCache } from '@src/modules/identity';
import { MaintenanceService } from '@src/modules/platform';
import { type AdminApi, adminWith } from '../../support/admin-api';
import { type TestApp, createTestApp } from '../../support/app';
import { clearIdentityCaches } from '../../support/auth';
import { closeTestDb, resetDb, testDb } from '../../support/db';
import { STORE_ORIGIN, StoreClient, clearStoreRateLimits } from '../../support/store';

setDefaultTimeout(180_000);

const frontendPresent = existsSync(demoStatePath());
let t: TestApp;
let staff: AdminApi;

beforeAll(async () => {
  if (!frontendPresent) return;
  t = await createTestApp({ env: { SHOP_ORIGINS: STORE_ORIGIN } });
  await resetDb();
  await clearIdentityCaches(t);
  await clearStoreRateLimits(t);
  const { db } = await testDb();
  await runSeed(db, await loadDemoState(), t.config);
  // The seed wrote IP rules and the allowlist switch straight to Postgres: drop any snapshot another file left in the shared cache.
  await t.app.get(IpRuleCache).invalidate();
  staff = await adminWith(t, ['clients:*', 'customers:privacy', 'catalog:*']);
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

/** The ids of the demo's 30 customers: the customer cN is the account 100 + N. */
const DEMO_FIRST_ID = 101;
const DEMO_LAST_ID = 130;

describe.skipIf(!frontendPresent)('the customers seed', () => {
  it("writes the demo's 30 customers as retail accounts by their demo ids, with the currency of the country and the demo's statuses", async () => {
    const { db } = await testDb();
    const rows = await db
      .select()
      .from(s.clients)
      .where(between(s.clients.id, DEMO_FIRST_ID, DEMO_LAST_ID))
      .orderBy(s.clients.id);
    expect(rows).toHaveLength(30);
    expect(rows.map((row) => row.id)).toEqual(Array.from({ length: 30 }, (_, index) => index + DEMO_FIRST_ID));
    const [retail] = await db
      .select({ id: s.clientGroups.id })
      .from(s.clientGroups)
      .where(eq(s.clientGroups.kind, 'b2c_retail'));
    expect(rows.every((row) => row.groupId === retail!.id)).toBe(true);
    expect(rows[0]).toMatchObject({
      id: DEMO_FIRST_ID,
      name: 'Daniel Whitmore',
      email: 'daniel.whitmore@mail.example',
      country: 'GB',
      currency: 'GBP',
      hasAccount: true,
      status: 'active',
      createdBy: null,
    });
    expect(rows.filter((row) => row.status === 'blocked')).toHaveLength(1);
    expect(rows.filter((row) => row.status === 'suspended')).toHaveLength(1);
    // The seed gives no account a password (the development password is a separate step), and a retail account has no username.
    expect(rows.filter((row) => row.hasAccount).every((row) => row.passwordHash === null)).toBe(true);
    expect(rows.every((row) => row.username === null)).toBe(true);
  });

  it('shows through the admin routes as the console expects, and the detail answers for a seeded account', async () => {
    // Descending, so the demo's named customers come before the growth seed's nameless guests (an empty name sorts first).
    const list = await staff.get('/admin/clients?rankKind=retail&_start=0&_end=100&_sort=name&_order=desc');
    expect(list.status).toBe(200);
    // Every retail row counts, the growth seed's guests included.
    const { db } = await testDb();
    const retailRows = await db
      .select({ id: s.clients.id })
      .from(s.clients)
      .innerJoin(s.clientGroups, eq(s.clientGroups.id, s.clients.groupId))
      .where(eq(s.clientGroups.kind, 'b2c_retail'));
    expect(list.total).toBe(retailRows.length);
    const named = list.body.filter((row: { name: string }) => row.name !== '');
    expect(named).toHaveLength(30);
    // The storefront money seeder (feature 16) runs after this one and gives the demo's customers their orders: Ana Costa has two.
    expect(named.at(-1)).toMatchObject({ name: 'Ana Costa', currencyCode: 'EUR', ordersCount: 2 });
    const blocked = await staff.get('/admin/clients?rankKind=retail&status=blocked');
    expect(blocked.total).toBe(1);
    expect(blocked.body[0]).toMatchObject({ status: 'blocked' });
    expect(blocked.body[0]).not.toHaveProperty('riskLevel');
    const detail = await staff.get(`/admin/clients/${DEMO_FIRST_ID}`);
    expect(detail.status).toBe(200);
    expect(detail.body).toMatchObject({
      id: DEMO_FIRST_ID,
      name: 'Daniel Whitmore',
      rank: { kind: 'retail' },
      security: { mustChangePassword: false },
    });
  });

  it("writes the demo's eight TACs with the model code and the marketing name, and no route serves them (decision 068)", async () => {
    const { db } = await testDb();
    const rows = await db.select().from(s.tacCatalog).orderBy(s.tacCatalog.tac);
    expect(rows).toHaveLength(8);
    expect(rows.find((row) => row.tac === '35389011')).toMatchObject({
      tac: '35389011',
      brand: 'Apple',
      model: 'A2633',
      marketingName: 'iPhone 13',
      releaseYear: 2021,
      source: 'import',
    });
    // The catalogue keeps its rows and the risk queue reads them, but the four admin routes were retired.
    expect((await staff.get('/admin/tac-catalog?_sort=tac&_order=asc')).status).toBe(404);
    expect((await staff.get('/admin/tac-catalog/1')).status).toBe(404);
    expect((await staff.post('/admin/tac-catalog', { tac: '35123456', brand: 'Harvest', model: 'H1' })).status).toBe(
      404,
    );
    expect((await staff.patch('/admin/tac-catalog/1', { brand: 'Other' })).status).toBe(404);
  });

  it('is idempotent: a second run inserts nothing', async () => {
    const { db } = await testDb();
    const reports = await runSeed(db, await loadDemoState(), t.config);
    for (const report of reports.filter((r) => ['clients', 'customers', 'tac_catalog'].includes(r.table))) {
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
      .from(s.clients)
      .where(
        and(
          between(s.clients.id, DEMO_FIRST_ID, DEMO_LAST_ID),
          eq(s.clients.mustChangePassword, false),
          isNotNull(s.clients.passwordHash),
        ),
      )
      .limit(1);
    expect(await t.app.get(PasswordHasher).verify(account!.passwordHash!, 'demo-password')).toBe(true);
    const login = await new StoreClient(t, '198.18.99.9').login(account!.email, 'demo-password');
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

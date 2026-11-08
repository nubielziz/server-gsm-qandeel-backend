// The growth seed (feature 19, `bun run db:seed`): the demo's 238 left checkouts appear with their ids, services, baskets, recovery state and
// marketing answers through the real routes (list, filter, funnel), and a second run changes nothing. Needs the frontend checkout.
import { afterAll, beforeAll, beforeEach, describe, expect, it, setDefaultTimeout } from 'bun:test';
import { existsSync } from 'node:fs';
import { eq } from 'drizzle-orm';
import { schema as s } from '../../src/infra/db';
import { seedCatalog } from '../../scripts/seed/catalog';
import { demoStatePath, loadDemoState } from '../../scripts/seed/demo-state';
import { agreedToMarketing, seedGrowth } from '../../scripts/seed/growth';
import { seedIdentity } from '../../scripts/seed/identity';
import { seedMoney } from '../../scripts/seed/money';
import { type AdminApi, adminWith } from '../support/admin-api';
import { type TestApp, createTestApp } from '../support/app';
import { clearIdentityCaches } from '../support/auth';
import { closeTestDb, resetDb, testDb } from '../support/db';
import { insertRecoveryTemplate } from '../support/growth';

setDefaultTimeout(180_000);

const frontendPresent = existsSync(demoStatePath());
let t: TestApp;
let admin: AdminApi;

/** Runs the seeders the checkouts need: identity, money (the currencies), catalog (the services), then growth. */
async function seed() {
  const { db } = await testDb();
  const demo = await loadDemoState();
  return db.transaction(async (tx) => {
    await seedIdentity(tx, demo);
    await seedMoney(tx, demo);
    await seedCatalog(tx, demo);
    return seedGrowth(tx, demo);
  });
}

beforeAll(async () => {
  if (frontendPresent) t = await createTestApp();
});
afterAll(async () => {
  if (!frontendPresent) return;
  await resetDb();
  await clearIdentityCaches(t);
  await t.close();
  await closeTestDb();
});

describe.skipIf(!frontendPresent)('the growth seed through the console routes', () => {
  beforeEach(async () => {
    await resetDb();
    await clearIdentityCaches(t);
    admin = await adminWith(t, ['growth:*', 'reports:growth']);
  });

  it('writes the 238 checkouts of the demo with its ids and one guest customer per address, and a second run adds nothing', async () => {
    const first = await seed();
    expect(first.map((report) => [report.table, report.inserted, report.existing])).toEqual([
      ['customers', 227, 0],
      ['checkout_sessions', 238, 0],
      ['consent_records', expect.any(Number), 0],
    ]);
    const again = await seed();
    expect(again.map((report) => report.inserted)).toEqual([0, 0, 0]);
    const { db } = await testDb();
    const ck3001 = (await db.select().from(s.checkoutSessions).where(eq(s.checkoutSessions.id, 3001)))[0];
    expect(ck3001).toMatchObject({
      email: 'jo10@post.example',
      serviceId: 7,
      currency: 'USD',
      status: 'expired',
      utm: { source: 'Blog' },
    });
    expect(ck3001?.recoveryEmailedAt?.getTime()).toBe(ck3001!.createdAt.getTime() + 60 * 60_000);
  });

  it("lists them through the console route with the demo baskets, the recovery state and the mock's marketing answers", async () => {
    await seed();
    const { db } = await testDb();
    await insertRecoveryTemplate(db);
    const list = await admin.get('/admin/checkouts/abandoned?_start=0&_end=500&_sort=createdAt&_order=desc');
    expect(list.status).toBe(200);
    // The last 30 days of the demo's checkouts, the paid ones only when they were emailed.
    expect(list.total).toBeGreaterThan(100);
    const row3001 = (await admin.get('/admin/checkouts/abandoned?q=jo10@post&_start=0&_end=5')).body[0];
    expect(row3001).toMatchObject({
      id: 3001,
      email: 'jo•••@post.example',
      grossAmount: '11.9900',
      fxRate: '1.00000000',
      currencyCode: 'USD',
      utm: { source: 'Blog' },
      orderId: null,
      marketingConsent: agreedToMarketing(3001),
    });
    expect(row3001.serviceName).toEqual(expect.any(String));
    // The filter and the flag agree on the seeded data too.
    const flagged = list.body.filter((row: { canRecover: boolean }) => row.canRecover).length;
    expect((await admin.get('/admin/checkouts/abandoned?canRecover=true&_start=0&_end=1')).total).toBe(flagged);
    for (const row of list.body) {
      if (row.canRecover) {
        expect(row.marketingConsent).toBe(true);
        expect(row.recoveryEmailedAt).toBeNull();
      }
    }
    const funnel = await admin.get('/admin/reports/funnel?days=90');
    expect(funnel.body.paymentStarted).toBeGreaterThan(0);
  });
});

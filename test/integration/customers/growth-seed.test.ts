// The growth seed (feature 19, `bun run db:seed`): the demo's 238 checkouts that were left appear with their ids, services, baskets and marketing
// answers, the funnel route counts them, and a second run changes nothing. Needs the frontend checkout.
import { afterAll, beforeAll, beforeEach, describe, expect, it, setDefaultTimeout } from 'bun:test';
import { existsSync } from 'node:fs';
import { asc, eq } from 'drizzle-orm';
import { schema as s } from '@src/infra/db';
import { seedCatalog } from '../../../scripts/seed/catalog';
import { demoStatePath, loadDemoState } from '../../../scripts/seed/demo-state';
import { agreedToMarketing, seedGrowth } from '../../../scripts/seed/growth';
import { seedIdentity } from '../../../scripts/seed/identity';
import { seedMoney } from '../../../scripts/seed/money';
import { type AdminApi, adminWith } from '../../support/admin-api';
import { type TestApp, createTestApp } from '../../support/app';
import { clearIdentityCaches } from '../../support/auth';
import { closeTestDb, resetDb, testDb } from '../../support/db';

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

describe.skipIf(!frontendPresent)('the growth seed', () => {
  beforeEach(async () => {
    await resetDb();
    await clearIdentityCaches(t);
    admin = await adminWith(t, ['reports:growth']);
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
      grossAmount: '11.9900',
      status: 'expired',
      utm: { source: 'Blog' },
      orderId: null,
    });
    // Nothing is written to the column of the retired reminder.
    expect((await db.select().from(s.checkoutSessions)).every((row) => row.recoveryEmailedAt === null)).toBe(true);
    const [guest] = await db.select().from(s.clients).where(eq(s.clients.id, ck3001!.accountId!));
    expect(guest).toMatchObject({ email: 'jo10@post.example', hasAccount: false });
    // The mock's marketing answer of the checkout: a grant for the buyers who agreed, a withdrawal after a grant, or no record.
    const answers = await db
      .select()
      .from(s.consentRecords)
      .where(eq(s.consentRecords.checkoutSessionId, 3001))
      .orderBy(asc(s.consentRecords.id));
    if (agreedToMarketing(3001)) expect(answers.map((record) => record.granted)).toEqual([true]);
    else expect(answers.at(-1)?.granted ?? false).toBe(false);
  });

  it('is counted by the funnel route: every seeded checkout is a started payment, the converted ones are paid', async () => {
    await seed();
    const funnel = await admin.get('/admin/reports/funnel?days=90');
    expect(funnel.status).toBe(200);
    expect(funnel.body.paymentStarted).toBeGreaterThan(0);
    expect(funnel.body.paid).toBeLessThanOrEqual(funnel.body.paymentStarted);
  });
});

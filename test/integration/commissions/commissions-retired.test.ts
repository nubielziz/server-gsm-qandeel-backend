// Commissions are retired (decision 062): an order that completes, is reopened and completes again settles exactly as before, and a
// plan that is still stored accrues nothing. The three tables stay in the database, unread and unwritten; the journals they posted stay
// in the ledger. Staff replies, the worker's supplier results and stock deliveries all end in the same transition, so one path proves it.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { eq } from 'drizzle-orm';
import { schema as s } from '@src/infra/db';
import { type AdminApi, adminWith } from '../../support/admin-api';
import { type TestApp, createTestApp } from '../../support/app';
import { clearIdentityCaches } from '../../support/auth';
import { TestClock } from '../../support/clock';
import { closeTestDb, resetDb, testDb } from '../../support/db';
import { insertWalletMerchant } from '../../support/money';
import { IMEIS, type OrdersWorld, json, orderRow, ordersWorld, portalFor, walletOf } from '../../support/orders';

const clock = new TestClock('2026-11-05T08:00:00.000Z');
let t: TestApp;
let world: OrdersWorld;
let staff: AdminApi;

beforeAll(async () => {
  t = await createTestApp({ clock });
});
beforeEach(async () => {
  await resetDb();
  await clearIdentityCaches(t);
  world = await ordersWorld((await testDb()).db);
  staff = await adminWith(t, ['orders:*']);
});
afterAll(async () => {
  await resetDb();
  await clearIdentityCaches(t);
  await t.close();
  await closeTestDb();
});

/** Stored the way the retired feature left them: a referrer, a plan of each kind and a current assignment for the merchant. */
async function storeRetiredRows(): Promise<{ plan: number }> {
  const { db } = await testDb();
  const referrer = await insertWalletMerchant(db, { name: 'Old Referrer' });
  await db.update(s.clients).set({ referredById: referrer.id }).where(eq(s.clients.id, world.merchant.id));
  const [plan] = await db
    .insert(s.commissionPlans)
    .values({ name: 'Old rebate', kind: 'rebate', basis: 'Own order revenue', percent: '3.0000', period: 'monthly' })
    .returning({ id: s.commissionPlans.id });
  await db.insert(s.commissionAssignments).values({ planId: plan!.id, beneficiaryId: world.merchant.id, scope: 'own' });
  return { plan: plan!.id };
}

describe('an order completes while commission plans are still stored', () => {
  it('settles as before and accrues nothing, on completion, reopen and a second completion', async () => {
    const { db } = await testDb();
    await storeRetiredRows();
    const placed = await (
      await portalFor(t, world.merchant.id)
    ).post('/client/orders', {
      serviceId: world.auto.serviceId,
      imei: IMEIS[0],
    });
    expect(placed.statusCode).toBe(201);
    const id = json(placed).orders[0].id as number;

    expect((await staff.post(`/admin/orders/${id}/reply`, { code: 'Unlocked: 8842' })).status).toBe(204);
    expect(await orderRow(db, id)).toMatchObject({ status: 'completed' });
    expect(await walletOf(db, world.merchant.id)).toEqual({ wallet: '82.7200', hold: '0.0000' });
    expect(await db.select().from(s.commissionAccruals)).toEqual([]);

    expect((await staff.post(`/admin/orders/${id}/reopen`, {})).status).toBe(204);
    expect((await staff.post(`/admin/orders/${id}/reply`, { code: 'Unlocked: 8842' })).status).toBe(204);
    expect(await db.select().from(s.commissionAccruals)).toEqual([]);

    // No journal of the retired kind was posted: the ledger holds only what the order itself wrote.
    const kinds = new Set(
      (await db.select({ kind: s.ledgerTransactions.kind }).from(s.ledgerTransactions)).map((r) => r.kind),
    );
    expect(kinds.has('commission')).toBe(false);
  });

  it('leaves the stored plans and assignments as they were', async () => {
    const { db } = await testDb();
    const { plan } = await storeRetiredRows();
    const before = await db.select().from(s.commissionPlans);
    const beforeAssignments = await db.select().from(s.commissionAssignments);
    const placed = await (
      await portalFor(t, world.merchant.id)
    ).post('/client/orders', {
      serviceId: world.auto.serviceId,
      imei: IMEIS[0],
    });
    const id = json(placed).orders[0].id as number;
    expect((await staff.post(`/admin/orders/${id}/reply`, { code: 'Unlocked: 8842' })).status).toBe(204);
    expect(await db.select().from(s.commissionPlans)).toEqual(before);
    expect(await db.select().from(s.commissionAssignments)).toEqual(beforeAssignments);
    expect(before.map((row) => row.id)).toEqual([plan]);
  });
});

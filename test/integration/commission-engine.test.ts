// The commission engine of feature 11 (RULES commissions 1 and 4, user rule 5): a completed merchant order accrues for the referrer's
// referral plan and for the merchant's own rebate plan, once per beneficiary, with the rate of that moment; a reopen or a refund
// reverses the accrual (before approval: status `reversed`; after approval: the wallet gives the commission back with a reversing
// entry, even below the credit limit); a storefront order accrues nothing. Everything runs inside the order's own transaction.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { eq } from 'drizzle-orm';
import { Money } from '../../src/common/money';
import { DbService, schema as s } from '../../src/infra/db';
import { insertAccrualOnce } from '../../src/modules/commissions/infra/accrual.repository';
import { adjust, b2cPay, postTransaction } from '../../src/modules/money';
import { OrderCompletionListeners, OrderTransitions } from '../../src/modules/orders';
import { type AdminApi, adminWith } from '../support/admin-api';
import { type TestApp, createTestApp } from '../support/app';
import { clearIdentityCaches, signInStaff } from '../support/auth';
import { TestClock } from '../support/clock';
import {
  type CommissionsWorld,
  accrualsOfOrder,
  assignPlan,
  commissionsWorld,
  ledgerRowsOf,
  placeOrder,
} from '../support/commissions';
import { closeTestDb, resetDb, testDb } from '../support/db';
import { accountFigures, ledgerTotals } from '../support/money';
import { IMEIS, insertOrderRow, orderRow, systemBalance, walletOf } from '../support/orders';

const clock = new TestClock('2026-11-05T08:00:00.000Z');
let t: TestApp;
let world: CommissionsWorld;
let staff: AdminApi;

beforeAll(async () => {
  t = await createTestApp({ clock });
});
beforeEach(async () => {
  clock.set('2026-11-05T08:00:00.000Z');
  await resetDb();
  await clearIdentityCaches(t);
  world = await commissionsWorld((await testDb()).db);
  staff = await adminWith(t, ['orders:*', 'commissions:*']);
});
afterAll(async () => {
  await resetDb();
  await clearIdentityCaches(t);
  await t.close();
  await closeTestDb();
});

const reply = (orderId: number) => staff.post(`/admin/orders/${orderId}/reply`, { code: 'Unlocked: 8842' });

/** Places an order of the merchant and completes it with a staff reply. */
async function completedOrder(imei: string = IMEIS[0], clientId: number = world.merchant.id): Promise<number> {
  const id = await placeOrder(t, clientId, world.auto.serviceId, imei);
  expect((await reply(id)).status).toBe(204);
  return id;
}

describe('an order completes', () => {
  it("accrues the referrer's referral plan on the order's revenue, with the rate of that moment and nothing in the ledger", async () => {
    const { db, agent, plans, merchant } = world;
    await assignPlan(db, agent.id, plans.referral);
    const id = await completedOrder();
    const [accrual, ...others] = await accrualsOfOrder(db, id);
    expect(others).toEqual([]);
    expect(accrual).toMatchObject({
      planId: plans.referral,
      beneficiaryId: agent.id,
      orderId: id,
      period: '2026-11',
      basisAmount: '17.2800',
      percent: '3.0000',
      amount: '0.5184',
      status: 'accrued',
      approvedAt: null,
      ledgerTxId: null,
      reversedAt: null,
    });
    expect(accrual!.createdAt.toISOString()).toBe('2026-11-05T08:00:00.000Z');
    // "no ledger entry": the expense is booked at approval, not at accrual (B43).
    expect(await walletOf(db, agent.id)).toEqual({ wallet: '0.0000', hold: '0.0000' });
    expect(await systemBalance(db, 'commission_expense')).toBe('0.0000');
    expect(await ledgerRowsOf(db, 'commission', 'accrual')).toEqual([]);
    // The order itself settled as before.
    expect(await walletOf(db, merchant.id)).toEqual({ wallet: '82.7200', hold: '0.0000' });
  });

  it('cuts the period at the completion month in UTC', async () => {
    const { db, agent, plans } = world;
    await assignPlan(db, agent.id, plans.referral);
    const id = await placeOrder(t, world.merchant.id, world.auto.serviceId);
    clock.set('2026-12-01T00:00:00.000Z');
    staff = await adminWith(t, ['orders:*', 'commissions:*']);
    expect((await reply(id)).status).toBe(204);
    expect((await accrualsOfOrder(db, id))[0]).toMatchObject({ period: '2026-12' });
  });

  it('keeps the rate it was earned at when the plan changes later, and the next order earns the new rate', async () => {
    const { db, agent, plans } = world;
    await assignPlan(db, agent.id, plans.referral);
    const first = await completedOrder(IMEIS[0]);
    expect((await staff.patch(`/admin/commission-plans/${plans.referral}`, { percent: '5' })).status).toBe(200);
    const second = await completedOrder(IMEIS[1]);
    expect((await accrualsOfOrder(db, first))[0]).toMatchObject({ percent: '3.0000', amount: '0.5184' });
    expect((await accrualsOfOrder(db, second))[0]).toMatchObject({ percent: '5.0000', amount: '0.8640' });
  });

  it("pays the order's own merchant a rebate and the referrer a referral commission on the same order", async () => {
    const { db, agent, plans, merchant } = world;
    await assignPlan(db, agent.id, plans.referral);
    await assignPlan(db, merchant.id, plans.rebate);
    const id = await completedOrder();
    const rows = await accrualsOfOrder(db, id);
    // The merchant's own rebate is written first.
    expect(rows.map((row) => [row.beneficiaryId, row.planId, row.amount])).toEqual([
      [merchant.id, plans.rebate, '0.2592'],
      [agent.id, plans.referral, '0.5184'],
    ]);
  });

  it('pays nothing when nobody is on a plan, the plan is switched off, or the assignment ended', async () => {
    const { db, agent, plans } = world;
    expect(await accrualsOfOrder(db, await completedOrder(IMEIS[0]))).toEqual([]);

    const assignment = await assignPlan(db, agent.id, plans.referral);
    await db.update(s.commissionPlans).set({ isActive: false }).where(eq(s.commissionPlans.id, plans.referral));
    expect(await accrualsOfOrder(db, await completedOrder(IMEIS[1]))).toEqual([]);

    await db.update(s.commissionPlans).set({ isActive: true }).where(eq(s.commissionPlans.id, plans.referral));
    await db
      .update(s.commissionAssignments)
      .set({ endsAt: clock.now() })
      .where(eq(s.commissionAssignments.id, assignment));
    expect(await accrualsOfOrder(db, await completedOrder(IMEIS[2]))).toEqual([]);
  });

  it('pays nothing for an agent plan of the wrong kind: a rebate plan does not pay on referred merchants', async () => {
    const { db, agent, plans } = world;
    await assignPlan(db, agent.id, plans.rebate);
    expect(await accrualsOfOrder(db, await completedOrder())).toEqual([]);
  });

  it('accrues once per order and beneficiary: a repeated completion call changes nothing', async () => {
    const { db, agent, plans } = world;
    await assignPlan(db, agent.id, plans.referral);
    const id = await completedOrder();
    // The machine refuses a second reply on a completed order; nothing new is written either.
    expect((await reply(id)).status).toBe(409);
    expect(await accrualsOfOrder(db, id)).toHaveLength(1);
  });

  it('skips an accrual that rounds to zero and keeps one that rounds up to a hundredth of a cent', async () => {
    const { db, agent, plans, merchant, auto } = world;
    await assignPlan(db, agent.id, plans.referral);
    await db.update(s.commissionPlans).set({ percent: '0.5000' }).where(eq(s.commissionPlans.id, plans.referral));
    const open = (price: string) =>
      insertOrderRow(db, {
        clientId: merchant.id,
        serviceId: auto.serviceId,
        status: 'processing',
        dispatchState: 'operator',
        unitPrice: price,
        totalPrice: price,
      });
    const tiny = await open('0.0010');
    const small = await open('0.0150');
    expect((await reply(tiny.id)).status).toBe(204);
    expect((await reply(small.id)).status).toBe(204);
    // 0.0010 x 0.5 / 100 = 0.000005 rounds to nothing; 0.0150 x 0.5 / 100 = 0.000075 rounds half up to 0.0001.
    expect(await accrualsOfOrder(db, tiny.id)).toEqual([]);
    expect((await accrualsOfOrder(db, small.id)).map((row) => row.amount)).toEqual(['0.0001']);
  });

  it('never writes an accrual of 0: not for a plan stored at 0 percent, not for an order priced at 0, not through the writer', async () => {
    const { db, agent, plans, merchant, auto } = world;
    await assignPlan(db, agent.id, plans.referral);
    // The table allows a rate of 0 (the plan screens ask for 0.5 or more), so a seeded plan can have one.
    await db.update(s.commissionPlans).set({ percent: '0.0000' }).where(eq(s.commissionPlans.id, plans.referral));
    const open = (price: string) =>
      insertOrderRow(db, {
        clientId: merchant.id,
        serviceId: auto.serviceId,
        status: 'processing',
        dispatchState: 'operator',
        unitPrice: price,
        totalPrice: price,
      });
    const free = await open('0.0000');
    const paid = await open('17.2800');
    expect((await reply(free.id)).status).toBe(204);
    expect((await reply(paid.id)).status).toBe(204);
    expect(await accrualsOfOrder(db, free.id)).toEqual([]);
    expect(await accrualsOfOrder(db, paid.id)).toEqual([]);

    // The one function that inserts accruals refuses an amount that is not above 0, whoever calls it.
    const written = await insertAccrualOnce(db, {
      planId: plans.referral,
      beneficiaryId: agent.id,
      orderId: paid.id,
      period: '2026-11',
      basisAmount: '17.2800',
      percent: '3.0000',
      amount: '0.0000',
      status: 'accrued',
      createdAt: clock.now(),
    });
    expect(written).toBeUndefined();
    expect(await db.select().from(s.commissionAccruals)).toEqual([]);
  });
});

describe('a storefront order', () => {
  it('accrues nothing: it has no merchant', async () => {
    const { db, agent, plans, auto } = world;
    await assignPlan(db, agent.id, plans.referral);
    const [customer] = await db
      .insert(s.customers)
      .values({ email: `c-${crypto.randomUUID()}@example.com`, name: 'Jack Turner' })
      .returning({ id: s.customers.id });
    const order = await insertOrderRow(db, {
      customerId: customer!.id,
      serviceId: auto.serviceId,
      source: 'store',
      dispatchState: 'manual',
      unitPrice: '12.4900',
      totalPrice: '12.4900',
      taxAmount: '2.5000',
    });
    await db.transaction((tx) =>
      postTransaction(
        tx,
        {
          ...b2cPay({ net: Money.of('12.49'), vat: Money.of('2.50') }),
          refId: order.id,
          idempotencyKey: `test:pay:${order.id}`,
          currency: 'USD',
          createdBy: { type: 'system', id: null },
        },
        clock.now(),
      ),
    );
    expect((await reply(order.id)).status).toBe(204);
    expect(await orderRow(db, order.id)).toMatchObject({ status: 'completed' });
    expect(await accrualsOfOrder(db, order.id)).toEqual([]);
    expect((await staff.post(`/admin/orders/${order.id}/reopen`, {})).status).toBe(204);
  });
});

describe('an order is reopened or refunded before its commission is approved', () => {
  it('reverses the accrual on a reopen, and a completion after it accrues again (the reversed row does not block it)', async () => {
    const { db, agent, plans } = world;
    await assignPlan(db, agent.id, plans.referral);
    const id = await completedOrder();
    clock.advance(60_000);
    expect((await staff.post(`/admin/orders/${id}/reopen`, {})).status).toBe(204);
    const [reversed] = await accrualsOfOrder(db, id);
    expect(reversed).toMatchObject({ status: 'reversed', approvedAt: null, ledgerTxId: null });
    expect(reversed!.reversedAt?.toISOString()).toBe('2026-11-05T08:01:00.000Z');
    // Before approval there is no money to give back.
    expect(await ledgerRowsOf(db, 'commission', 'accrual')).toEqual([]);

    expect((await reply(id)).status).toBe(204);
    const rows = await accrualsOfOrder(db, id);
    expect(rows.map((row) => row.status)).toEqual(['reversed', 'accrued']);
    expect(rows[1]).toMatchObject({ amount: '0.5184', reversedAt: null });
  });

  it('reverses the accrual on a B2B refund, and the approval skips it with the reason', async () => {
    const { db, agent, plans } = world;
    await assignPlan(db, agent.id, plans.referral);
    const id = await completedOrder();
    expect((await staff.post(`/admin/orders/${id}/refund`, { reason: 'Wrong IMEI' })).status).toBe(204);
    const [row] = await accrualsOfOrder(db, id);
    expect(row).toMatchObject({ status: 'reversed' });
    const approval = await staff.post('/admin/commission-accruals/approve', { ids: [row!.id] });
    expect(approval.status).toBe(200);
    expect(approval.body).toEqual({
      approved: 0,
      total: '0.0000',
      skipped: [{ id: row!.id, reason: 'Reversed: the order was refunded or reopened.' }],
    });
  });

  it("reverses every beneficiary's accrual of the order", async () => {
    const { db, agent, plans, merchant } = world;
    await assignPlan(db, agent.id, plans.referral);
    await assignPlan(db, merchant.id, plans.rebate);
    const id = await completedOrder();
    expect((await staff.post(`/admin/orders/${id}/reopen`, {})).status).toBe(204);
    expect((await accrualsOfOrder(db, id)).map((row) => row.status)).toEqual(['reversed', 'reversed']);
  });

  it('is rolled back with the reopen: a reopen that fails leaves the accrual alone', async () => {
    const { db, agent, plans } = world;
    await assignPlan(db, agent.id, plans.referral);
    const id = await completedOrder();
    const stale = await staff.post(`/admin/orders/${id}/reject`, { reason: 'late' });
    expect(stale.status).toBe(409);
    expect((await accrualsOfOrder(db, id)).map((row) => row.status)).toEqual(['accrued']);
  });
});

describe('an order is reopened or refunded after its commission was approved', () => {
  async function approvedOrder(): Promise<{ orderId: number; accrualId: number; ledgerTxId: number }> {
    const { db, agent, plans } = world;
    await assignPlan(db, agent.id, plans.referral);
    const orderId = await completedOrder();
    const [accrual] = await accrualsOfOrder(db, orderId);
    const approval = await staff.post('/admin/commission-accruals/approve', { ids: [accrual!.id] });
    expect(approval.body).toEqual({ approved: 1, total: '0.5184', skipped: [] });
    const [paid] = await accrualsOfOrder(db, orderId);
    expect(paid).toMatchObject({ status: 'approved' });
    return { orderId, accrualId: accrual!.id, ledgerTxId: paid!.ledgerTxId! };
  }

  it('keeps the accrual approved and takes the commission back with a reversing entry (Dr wallet, Cr commission_expense)', async () => {
    const { db, agent } = world;
    const { orderId, accrualId, ledgerTxId } = await approvedOrder();
    expect(await walletOf(db, agent.id)).toEqual({ wallet: '0.5184', hold: '0.0000' });
    expect(await systemBalance(db, 'commission_expense')).toBe('0.5184');
    clock.advance(3_600_000);
    // An hour later the first session has expired: sign in again.
    staff = await adminWith(t, ['orders:*', 'commissions:*']);

    expect((await staff.post(`/admin/orders/${orderId}/reopen`, {})).status).toBe(204);
    const [row] = await accrualsOfOrder(db, orderId);
    expect(row).toMatchObject({ status: 'approved', ledgerTxId });
    expect(row!.approvedAt).not.toBeNull();
    expect(row!.reversedAt?.toISOString()).toBe('2026-11-05T09:00:00.000Z');

    const entries = await ledgerRowsOf(db, 'commission', 'accrual');
    expect(entries).toHaveLength(2);
    expect(entries[1]).toMatchObject({
      key: `reverse:accrual:${accrualId}`,
      refId: accrualId,
      memo: `Reversal of commission JRN-${ledgerTxId} for ORD-${orderId}`,
      createdByType: 'staff',
      createdById: staff.staffId,
    });
    expect(await walletOf(db, agent.id)).toEqual({ wallet: '0.0000', hold: '0.0000' });
    expect(await systemBalance(db, 'commission_expense')).toBe('0.0000');
    expect((await ledgerTotals(db)).sum).toBe('0.0000');
  });

  it('pays again after the order completes again: a new accrual, which the next approval pays', async () => {
    const { db, agent } = world;
    const { orderId } = await approvedOrder();
    expect((await staff.post(`/admin/orders/${orderId}/reopen`, {})).status).toBe(204);
    expect((await reply(orderId)).status).toBe(204);
    const rows = await accrualsOfOrder(db, orderId);
    expect(rows.map((row) => [row.status, row.reversedAt === null])).toEqual([
      ['approved', false],
      ['accrued', true],
    ]);
    const approval = await staff.post('/admin/commission-accruals/approve', { ids: [rows[1]!.id] });
    expect(approval.body).toMatchObject({ approved: 1, total: '0.5184' });
    expect(await walletOf(db, agent.id)).toEqual({ wallet: '0.5184', hold: '0.0000' });
    // A second reopen reverses the new accrual with its own key.
    expect((await staff.post(`/admin/orders/${orderId}/reopen`, {})).status).toBe(204);
    expect((await ledgerRowsOf(db, 'commission', 'accrual')).map((entry) => entry.key)).toEqual([
      expect.stringMatching(/^commission:/),
      `reverse:accrual:${rows[0]!.id}`,
      expect.stringMatching(/^commission:/),
      `reverse:accrual:${rows[1]!.id}`,
    ]);
    expect(await walletOf(db, agent.id)).toEqual({ wallet: '0.0000', hold: '0.0000' });
  });

  it('may take the agent wallet below its credit limit: the reversal is never refused', async () => {
    const { db, agent } = world;
    const { orderId } = await approvedOrder();
    // The agent spent the commission already (no credit limit): the wallet is at zero.
    await db.transaction((tx) =>
      postTransaction(
        tx,
        {
          ...adjust({ clientId: agent.id, amount: Money.of('0.5184'), direction: 'debit' }),
          refId: agent.id,
          idempotencyKey: 'test:spent',
          currency: 'USD',
          createdBy: { type: 'system', id: null },
        },
        clock.now(),
      ),
    );
    expect(await walletOf(db, agent.id)).toEqual({ wallet: '0.0000', hold: '0.0000' });
    expect((await staff.post(`/admin/orders/${orderId}/refund`, { reason: 'Chargeback' })).status).toBe(204);
    expect(await walletOf(db, agent.id)).toEqual({ wallet: '-0.5184', hold: '0.0000' });
    expect((await accountFigures(db, 'client_wallet', { type: 'client', id: agent.id }))!.overdraftLimit).toBe(
      '0.0000',
    );
    expect((await ledgerTotals(db)).sum).toBe('0.0000');
    expect((await accrualsOfOrder(db, orderId))[0]).toMatchObject({ status: 'approved' });
  });

  it('posts the reversal once even when two reopens race', async () => {
    const { db } = world;
    const { orderId } = await approvedOrder();
    const [a, b] = await Promise.all([
      staff.post(`/admin/orders/${orderId}/reopen`, {}),
      staff.post(`/admin/orders/${orderId}/reopen`, {}),
    ]);
    expect([a.status, b.status].sort()).toEqual([204, 409]);
    const reversals = (await ledgerRowsOf(db, 'commission', 'accrual')).filter((entry) =>
      entry.key.startsWith('reverse:'),
    );
    expect(reversals).toHaveLength(1);
    expect(await systemBalance(db, 'commission_expense')).toBe('0.0000');
  });
});

describe('the other ways an order completes', () => {
  it("accrues when stocked codes complete the order at placement, with the placement time as the completion's month", async () => {
    const { db, agent, plans, auto } = world;
    await assignPlan(db, agent.id, plans.referral);
    const stocker = await signInStaff(t, ['inventory:write']);
    const imported = await t.app.inject({
      method: 'POST',
      url: `/admin/services/${auto.serviceId}/inventory/import`,
      headers: stocker.session.mutationHeaders,
      payload: { codes: ['GSM-STOCK-0001'] },
    });
    expect(imported.statusCode).toBeLessThan(300);
    const id = await placeOrder(t, world.merchant.id, auto.serviceId);
    expect(await orderRow(db, id)).toMatchObject({ status: 'completed', resultCode: 'GSM-STOCK-0001' });
    expect(await accrualsOfOrder(db, id)).toMatchObject([
      { beneficiaryId: agent.id, amount: '0.5184', status: 'accrued', period: '2026-11' },
    ]);
  });

  it("accrues when a supplier's result completes the order (the worker path through OrderTransitions)", async () => {
    const { db, agent, plans, auto, merchant } = world;
    await assignPlan(db, agent.id, plans.referral);
    const id = await placeOrder(t, merchant.id, auto.serviceId);
    await db
      .update(s.orders)
      .set({ status: 'processing', dispatchState: 'sent', supplierId: auto.supplierId, supplierRef: 'REF-1' })
      .where(eq(s.orders.id, id));
    const transitions = t.app.get(OrderTransitions, { strict: false });
    await t.app.get(DbService).runInTransaction(({ tx }) =>
      transitions.apply(tx, {
        orderId: id,
        action: { kind: 'supplierResult', result: 'completed' },
        actor: { type: 'supplier', id: auto.supplierId },
        code: 'Unlocked',
      }),
    );
    expect(await orderRow(db, id)).toMatchObject({ status: 'completed' });
    expect(await accrualsOfOrder(db, id)).toMatchObject([
      { beneficiaryId: agent.id, amount: '0.5184', status: 'accrued' },
    ]);
  });

  it('rolls the completion back when the accrual cannot be written (one transaction)', async () => {
    const { db, agent, plans } = world;
    await assignPlan(db, agent.id, plans.referral);
    const id = await placeOrder(t, world.merchant.id, world.auto.serviceId);
    const listeners = t.app.get(OrderCompletionListeners, { strict: false });
    // The last test of the file: the failing listener lives and dies with this app.
    listeners.add({
      orderCompleted: () => Promise.reject(new Error('listener failed')),
      orderReversed: () => Promise.resolve(),
    });
    expect((await reply(id)).status).toBe(500);
    expect(await orderRow(db, id)).toMatchObject({ status: 'pending' });
    expect(await accrualsOfOrder(db, id)).toEqual([]);
    expect(await walletOf(db, world.merchant.id)).toEqual({ wallet: '82.7200', hold: '17.2800' });
  });
});

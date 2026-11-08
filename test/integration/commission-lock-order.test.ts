// Lock order between a reversal and a commission approval (feature 11): a refund or reopen takes the order's commission accruals before
// any wallet, like the approval does, so with a rebate plan (the merchant is its own agent) the two never wait for each other in a circle
// (Postgres 40P01: the losing request is rolled back and answers a retryable 409). One test forces the bad interleaving; the other races the two requests several times.
import { afterAll, beforeAll, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import { sql } from 'drizzle-orm';
import { type Database } from '../../src/infra/db';
import { OrderLedger } from '../../src/modules/orders/application/order-ledger';
import { type AdminApi, adminWith } from '../support/admin-api';
import { type TestApp, createTestApp } from '../support/app';
import { clearIdentityCaches } from '../support/auth';
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
import { eventually } from '../support/infra';
import { ledgerTotals } from '../support/money';
import { IMEIS, systemBalance, walletOf } from '../support/orders';

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

/** Places an order of the merchant, which is its own agent through a rebate plan, and completes it with a staff reply. */
async function completedRebateOrder(imei: string): Promise<{ orderId: number; accrualId: number }> {
  const orderId = await placeOrder(t, world.merchant.id, world.auto.serviceId, imei);
  const replied = await staff.post(`/admin/orders/${orderId}/reply`, { code: 'Unlocked: 8842' });
  expect(replied.status).toBe(204);
  const [accrual] = await accrualsOfOrder(world.db, orderId);
  expect(accrual).toMatchObject({ beneficiaryId: world.merchant.id, status: 'accrued' });
  return { orderId, accrualId: accrual!.id };
}

/** How many sessions of this database are waiting for a lock right now. */
async function sessionsWaitingForALock(db: Database): Promise<number> {
  const result = await db.execute<{ waiting: number }>(
    sql`select count(*)::int as waiting from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock'`,
  );
  return result.rows[0]!.waiting;
}

describe('an approval and a refund of the same rebate-plan order', () => {
  it('do not deadlock when the refund holds the merchant wallet and the approval holds the accrual (the bad interleaving, forced)', async () => {
    const { db, merchant, plans } = world;
    await assignPlan(db, merchant.id, plans.rebate);
    const { orderId, accrualId } = await completedRebateOrder(IMEIS[0]);

    // Pause the refund right after its ledger move: it holds the merchant wallet there. Before the fix the approval then took the
    // accrual and waited for that wallet, and the refund came back for the accrual: a circle, which Postgres ends with 40P01.
    // OrderLedger has one instance per module graph (admin and engine), so the prototype is what gets watched.
    const move = OrderLedger.prototype.move;
    const reached = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const spy = spyOn(OrderLedger.prototype, 'move').mockImplementation(async function (
      this: OrderLedger,
      ...args: Parameters<OrderLedger['move']>
    ) {
      const moved = await move.apply(this, args);
      if (args[2] === 'refund') {
        reached.resolve();
        await release.promise;
      }
      return moved;
    });
    try {
      const refund = staff.post(`/admin/orders/${orderId}/refund`, { reason: 'Chargeback' });
      await reached.promise;
      const approval = staff.post('/admin/commission-accruals/approve', { ids: [accrualId] });
      // The approval is now stuck behind the refund on a lock (the accrual with the fix, the wallet without it).
      await eventually(async () => ((await sessionsWaitingForALock(db)) > 0 ? true : undefined));
      release.resolve();
      const [refunded, approved] = await Promise.all([refund, approval]);

      expect(refunded.status).toBe(204);
      expect(approved.status).toBe(200);
      // The refund won the accrual: it is reversed and the approval skips it, paying nothing.
      expect(approved.body).toEqual({
        approved: 0,
        total: '0.0000',
        skipped: [{ id: accrualId, reason: 'Reversed: the order was refunded or reopened.' }],
      });
      expect((await accrualsOfOrder(db, orderId))[0]).toMatchObject({ status: 'reversed' });
      expect(await ledgerRowsOf(db, 'commission', 'accrual')).toEqual([]);
      expect(await walletOf(db, merchant.id)).toEqual({ wallet: '100.0000', hold: '0.0000' });
      expect((await ledgerTotals(db)).sum).toBe('0.0000');
    } finally {
      release.resolve();
      spy.mockRestore();
    }
  });

  it('never fail with a 500 when they race, round after round', async () => {
    const { db, merchant, plans } = world;
    await assignPlan(db, merchant.id, plans.rebate);
    const rounds = IMEIS.length;
    for (let round = 0; round < rounds; round += 1) {
      const { orderId, accrualId } = await completedRebateOrder(IMEIS[round]!);
      // Alternate who is sent first, so both orders of arrival are tried.
      const calls = [
        () => staff.post('/admin/commission-accruals/approve', { ids: [accrualId] }),
        () => staff.post(`/admin/orders/${orderId}/refund`, { reason: 'Chargeback' }),
      ];
      const [first, second] = await Promise.all(
        round % 2 === 0 ? calls.map((call) => call()) : calls.reverse().map((call) => call()),
      );
      const [approval, refund] = round % 2 === 0 ? [first!, second!] : [second!, first!];
      expect(refund.status).toBe(204);
      expect(approval.status).toBe(200);

      // Whoever won, the books agree: the order is refunded, and a commission paid before the refund was taken back.
      const [accrual] = await accrualsOfOrder(db, orderId);
      if (accrual!.status === 'reversed') {
        expect(approval.body.approved).toBe(0);
      } else {
        expect(accrual).toMatchObject({ status: 'approved' });
        expect(accrual!.reversedAt).not.toBeNull();
      }
      expect(await walletOf(db, merchant.id)).toEqual({ wallet: '100.0000', hold: '0.0000' });
      expect(await systemBalance(db, 'commission_expense')).toBe('0.0000');
      expect((await ledgerTotals(db)).sum).toBe('0.0000');
    }
  });
});

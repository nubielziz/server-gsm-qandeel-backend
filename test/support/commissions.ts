// Helpers for the commissions and reports tests (feature 11): the orders world plus two agents (referrers of the two merchants), three
// plans, direct inserts of assignments and accruals, and reads of what the engine wrote.
import { and, asc, eq } from 'drizzle-orm';
import { Money } from '../../src/common/money';
import { type Database, schema as s } from '../../src/infra/db';
import type { CommissionAccrual } from '../../src/modules/commissions/db/schema';
import { order as orderEvent, postTransaction } from '../../src/modules/money';
import type { TestApp } from './app';
import { insertWalletMerchant } from './money';
import { IMEIS, type OrdersWorld, json, ordersWorld, portalFor } from './orders';

/** What `commissionsWorld` builds on top of the orders world. */
export interface CommissionsWorld extends OrdersWorld {
  /** The referrer of `merchant`. */
  readonly agent: { id: number; name: string };
  /** The referrer of `other`. */
  readonly partner: { id: number; name: string };
  /** The plans: Referral 3 percent, Partner 5 percent (both referral kind) and Volume rebate 1.5 percent (rebate kind). */
  readonly plans: { referral: number; partner: number; rebate: number };
}

/**
 * Builds the world of the commission tests: the orders world (`merchant` with 100 USD, `other`, an automatic service priced 17.28,
 * cost 13.50), two agents that referred the two merchants, and three active plans. Nobody is on a plan yet.
 *
 * @param db the test database
 * @returns the world
 */
export async function commissionsWorld(db: Database): Promise<CommissionsWorld> {
  const world = await ordersWorld(db);
  const agent = await insertWalletMerchant(db, { name: 'Zain Mobile Hub' });
  const partner = await insertWalletMerchant(db, { name: 'Atlas Partners' });
  await db.update(s.clients).set({ referredById: agent.id }).where(eq(s.clients.id, world.merchant.id));
  await db.update(s.clients).set({ referredById: partner.id }).where(eq(s.clients.id, world.other.id));
  const [referral, partnerPlan, rebate] = await db
    .insert(s.commissionPlans)
    .values([
      {
        name: 'Referral',
        kind: 'referral',
        basis: 'Order revenue of referred merchants',
        percent: '3.0000',
        period: 'monthly',
      },
      {
        name: 'Partner',
        kind: 'referral',
        basis: 'Order revenue of referred merchants',
        percent: '5.0000',
        period: 'monthly',
      },
      { name: 'Volume rebate', kind: 'rebate', basis: 'Own order revenue', percent: '1.5000', period: 'monthly' },
    ])
    .returning({ id: s.commissionPlans.id });
  return { ...world, agent, partner, plans: { referral: referral!.id, partner: partnerPlan!.id, rebate: rebate!.id } };
}

/**
 * Puts a merchant on a plan straight in the table (the scope follows the plan's kind), for tests that are not about assigning.
 *
 * @param db the test database
 * @param beneficiaryId the merchant
 * @param planId the plan
 * @returns the assignment id
 */
export async function assignPlan(db: Database, beneficiaryId: number, planId: number): Promise<number> {
  const [plan] = await db.select().from(s.commissionPlans).where(eq(s.commissionPlans.id, planId));
  const [row] = await db
    .insert(s.commissionAssignments)
    .values({ planId, beneficiaryId, scope: plan!.kind === 'referral' ? 'referrals' : 'own' })
    .returning({ id: s.commissionAssignments.id });
  return row!.id;
}

/**
 * Places an order of a service through the merchant portal, like the merchant would.
 *
 * @param t the running test app
 * @param clientId the merchant
 * @param serviceId the service
 * @param imei an IMEI (default the first of the shared list)
 * @returns the order id
 */
export async function placeOrder(
  t: TestApp,
  clientId: number,
  serviceId: number,
  imei: string = IMEIS[0],
): Promise<number> {
  const res = await (await portalFor(t, clientId)).post('/client/orders', { serviceId, imei });
  if (res.statusCode !== 201) throw new Error(`placing the order failed: ${res.statusCode} ${res.body}`);
  return json(res).orders[0].id as number;
}

/**
 * Reads the accruals of an order (all of them, reversed ones too), oldest first.
 *
 * @param db the test database
 * @param orderId the order
 * @returns the rows
 */
export async function accrualsOfOrder(db: Database, orderId: number): Promise<CommissionAccrual[]> {
  return db
    .select()
    .from(s.commissionAccruals)
    .where(eq(s.commissionAccruals.orderId, orderId))
    .orderBy(asc(s.commissionAccruals.id));
}

/**
 * Reads the ledger transactions of one kind and reference type, oldest first: id, key, memo and the reference id.
 *
 * @param db the test database
 * @param kind the ledger kind (`commission`)
 * @param refType the reference type (`accrual`)
 * @returns the rows
 */
export async function ledgerRowsOf(db: Database, kind: string, refType: 'accrual' | 'order' | 'client') {
  return db
    .select({
      id: s.ledgerTransactions.id,
      key: s.ledgerTransactions.idempotencyKey,
      memo: s.ledgerTransactions.memo,
      refId: s.ledgerTransactions.refId,
      createdByType: s.ledgerTransactions.createdByType,
      createdById: s.ledgerTransactions.createdById,
    })
    .from(s.ledgerTransactions)
    .where(and(eq(s.ledgerTransactions.kind, kind), eq(s.ledgerTransactions.refType, refType)))
    .orderBy(asc(s.ledgerTransactions.id));
}

/** What `insertAccrual` takes: the beneficiary, the plan, the order and the figures; everything else has the usual defaults. */
export interface AccrualSeed {
  readonly beneficiaryId: number;
  readonly planId: number;
  readonly orderId: number;
  readonly amount?: string;
  readonly basisAmount?: string;
  readonly percent?: string;
  readonly status?: 'accrued' | 'approved' | 'reversed';
  readonly period?: string;
  readonly createdAt?: Date;
  readonly approvedAt?: Date;
  readonly reversedAt?: Date;
}

/**
 * Inserts an accrual straight into the table (an `approved` one gets an approval time, a `reversed` one a reversal time).
 *
 * @param db the test database
 * @param seed the accrual
 * @returns the stored row
 */
export async function insertAccrual(db: Database, seed: AccrualSeed): Promise<CommissionAccrual> {
  const status = seed.status ?? 'accrued';
  const createdAt = seed.createdAt ?? new Date();
  const [row] = await db
    .insert(s.commissionAccruals)
    .values({
      planId: seed.planId,
      beneficiaryId: seed.beneficiaryId,
      orderId: seed.orderId,
      period: seed.period ?? createdAt.toISOString().slice(0, 7),
      basisAmount: seed.basisAmount ?? '10.0000',
      percent: seed.percent ?? '3.0000',
      amount: seed.amount ?? '0.3000',
      status,
      approvedAt: status === 'approved' ? (seed.approvedAt ?? createdAt) : null,
      reversedAt: status === 'accrued' ? null : (seed.reversedAt ?? (status === 'reversed' ? createdAt : null)),
      createdAt,
    })
    .returning();
  return row!;
}

/**
 * Moves an order's price from a merchant's wallet to its hold (the `order` money event), as an open order does, so the exposure
 * report has a reserved amount to show.
 *
 * @param db the test database
 * @param clientId the merchant
 * @param amount the price held, e.g. `'17.28'`
 * @returns the ledger transaction id
 */
export async function placeOrderHold(db: Database, clientId: number, amount: string): Promise<number> {
  const posted = await db.transaction((tx) =>
    postTransaction(
      tx,
      {
        ...orderEvent({ clientId, amount: Money.of(amount) }),
        refId: clientId,
        idempotencyKey: `test:hold:${crypto.randomUUID()}`,
        currency: 'USD',
        createdBy: { type: 'system', id: null },
      },
      new Date('2026-11-07T12:00:00.000Z'),
    ),
  );
  return posted.id;
}

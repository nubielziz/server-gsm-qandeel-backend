// Integration tests of the money participant of the guest-order claim (decision 064): the payments, the receipt invoices,
// the refunds and the disputes of a guest row move to the retail account that proved the mailbox; the claim gives up with `busy` (it never
// waits) while a payment of the guest row is pending, while the guest row has a ledger account, and while another request holds one of the rows.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { eq } from 'drizzle-orm';
import type { PoolClient } from 'pg';
import { type Database, pgErrorInfo, schema as s } from '@src/infra/db';
import { GuestClaimBusy } from '@src/modules/identity';
import { GUEST_CLAIM_MONEY_NAME, moveGuestClaimMoney } from '@src/modules/money/application/guest-claim.participant';
import { type TestApp, createTestApp } from '../../support/app';
import { clearIdentityCaches } from '../../support/auth';
import { GatewayTestModule } from '../../support/billing';
import {
  type B2cWorld,
  B2cGateway,
  type PaidOrder,
  b2cWorld,
  disputeEvent,
  hook,
  json,
  openCheckout,
  paidOrder,
  pay,
} from '../../support/b2c';
import { TestClock } from '../../support/clock';
import { closeTestDb, resetDb, testDb } from '../../support/db';
import { makeAccount } from '../../support/accounts';
import { rejectionOf } from '../../support/rejection';

const clock = new TestClock('2026-11-07T12:00:00.000Z');
const fake = new B2cGateway();
let t: TestApp;
let db: Database;
let world: B2cWorld;

beforeAll(async () => {
  ({ db } = await testDb());
  t = await createTestApp({ clock, imports: [GatewayTestModule] });
});
afterAll(async () => {
  await fake.stop();
  await resetDb();
  await t.close();
  await closeTestDb();
});
beforeEach(async () => {
  clock.set('2026-11-07T12:00:00.000Z');
  fake.reset();
  await resetDb();
  await clearIdentityCaches(t);
  world = await b2cWorld(t, db, fake);
});

/** A guest checkout that was paid: the order, the payment, the receipt invoice, and the guest row (an email that never signed up). */
async function guestOrder(email = 'guest@mail.example'): Promise<{ paid: PaidOrder; guestId: number }> {
  const paid = await paidOrder(t, clock, world, { email });
  const [payment] = await db.select().from(s.payments).where(eq(s.payments.id, paid.paymentId));
  return { paid, guestId: payment!.accountId };
}

/** A retail account with a login (the one that proves the mailbox of the guest row). */
const retailAccount = () => makeAccount({ rank: 'retail' });

/** Runs the participant the way the claim does: in a transaction, inside a savepoint. */
const claim = (guestId: number, accountId: number) =>
  db.transaction((tx) => tx.transaction((savepoint) => moveGuestClaimMoney(savepoint, { guestId, accountId })));

/** What belongs to an account: the ids of its payments, receipt invoices, refunds and disputes. */
async function owned(accountId: number) {
  const ids = async (rows: Promise<Array<{ id: number }>>) => (await rows).map((row) => row.id);
  return {
    payments: await ids(db.select({ id: s.payments.id }).from(s.payments).where(eq(s.payments.accountId, accountId))),
    invoices: await ids(db.select({ id: s.invoices.id }).from(s.invoices).where(eq(s.invoices.accountId, accountId))),
    refunds: await ids(db.select({ id: s.refunds.id }).from(s.refunds).where(eq(s.refunds.accountId, accountId))),
    disputes: await ids(db.select({ id: s.disputes.id }).from(s.disputes).where(eq(s.disputes.accountId, accountId))),
  };
}

describe('the money participant of the guest-order claim', () => {
  it('registers under the name money', () => {
    expect(GUEST_CLAIM_MONEY_NAME).toBe('money');
  });

  it('moves the payments, the receipt invoices, the refunds and the disputes of the guest row, and leaves the rest alone', async () => {
    const { paid, guestId } = await guestOrder();
    const [refund] = await db
      .insert(s.refunds)
      .values({
        paymentId: paid.paymentId,
        orderId: paid.orderId,
        accountId: guestId,
        amount: '1.0000',
        currency: 'GBP',
        reason: 'Asked by the buyer',
        method: 'original',
        status: 'rejected',
        requestedByType: 'system',
      })
      .returning();
    const body = disputeEvent('evt_claim_open', { dispute: 'dp_claim', intent: paid.intent });
    expect((await hook(t, clock, 'disputes', world.gateway.code, body)).statusCode).toBe(200);
    const other = await guestOrder('other@mail.example');
    const account = await retailAccount();
    const before = await owned(guestId);
    expect(before.payments).toEqual([paid.paymentId]);
    expect(before.refunds).toEqual([refund!.id]);
    expect(before.invoices).toHaveLength(1);
    expect(before.disputes).toHaveLength(1);
    const [stamp] = await db.select({ at: s.refunds.updatedAt }).from(s.refunds).where(eq(s.refunds.id, refund!.id));

    expect(await claim(guestId, account.id)).toBe(4);
    expect(await owned(account.id)).toEqual(before);
    expect(await owned(guestId)).toEqual({ payments: [], invoices: [], refunds: [], disputes: [] });
    // Another guest row keeps its records, and a refund keeps the time of its send: an owner change is not a new send.
    expect((await owned(other.guestId)).payments).toEqual([other.paid.paymentId]);
    const [after] = await db.select({ at: s.refunds.updatedAt }).from(s.refunds).where(eq(s.refunds.id, refund!.id));
    expect(after!.at).toEqual(stamp!.at);
    // A second claim finds nothing left to move.
    expect(await claim(guestId, account.id)).toBe(0);
  });

  it('gives up while a payment of the guest row is pending, and moves nothing', async () => {
    const { token } = await openCheckout(t, world, { email: 'pending@mail.example' });
    const started = json(await pay(t, token, undefined));
    const [payment] = await db.select().from(s.payments).where(eq(s.payments.id, started.payment.id));
    const account = await retailAccount();
    const error = await rejectionOf(claim(payment!.accountId, account.id));
    expect(error).toBeInstanceOf(GuestClaimBusy);
    expect((await owned(payment!.accountId)).payments).toEqual([started.payment.id]);
    expect((await owned(account.id)).payments).toEqual([]);
  });

  it('gives up while the guest row has a ledger account', async () => {
    const { guestId } = await guestOrder();
    await db.insert(s.ledgerAccounts).values({
      kind: 'customer_wallet',
      ownerType: 'account',
      ownerId: guestId,
      currency: 'USD',
    });
    const account = await retailAccount();
    expect(await rejectionOf(claim(guestId, account.id))).toBeInstanceOf(GuestClaimBusy);
    expect((await owned(account.id)).payments).toEqual([]);
  });

  it('never waits for a row another request holds: the lock error is raised at once and nothing moves', async () => {
    const { paid, guestId } = await guestOrder();
    const account = await retailAccount();
    const { pool } = await testDb();
    const holder: PoolClient = await pool.connect();
    try {
      // What a dispute webhook or a refund approval holds: the payment row.
      await holder.query('begin');
      await holder.query('select id from payments where id = $1 for update', [paid.paymentId]);
      const error = await rejectionOf(claim(guestId, account.id));
      expect(pgErrorInfo(error)?.code).toBe('55P03');
    } finally {
      await holder.query('rollback').catch(() => undefined);
      holder.release();
    }
    expect((await owned(guestId)).payments).toEqual([paid.paymentId]);
    expect((await owned(account.id)).payments).toEqual([]);
  });
});

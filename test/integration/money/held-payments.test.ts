// Integration tests of POST /admin/held-payments/:id/close (decision 048): staff close a storefront payment held for staff, paid back by
// hand (a completed refund without an order) or found to hold no money (the payment fails, so a real confirmation can still pay its
// checkout); the refusals.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { eq } from 'drizzle-orm';
import { type Database, schema as s } from '@src/infra/db';
import { HOLD_MARK_KEY, holdMarkOf } from '@src/modules/money/domain/b2c-money';
import { adminWith } from '../../support/admin-api';
import { type TestApp, createTestApp } from '../../support/app';
import { clearIdentityCaches } from '../../support/auth';
import {
  type B2cWorld,
  B2cGateway,
  b2cWorld,
  hook,
  intents,
  json,
  openCheckout,
  pay,
  storefrontEvent,
} from '../../support/b2c';
import { GatewayTestModule, insertInvoiceRow, insertPendingPayment } from '../../support/billing';
import { TestClock } from '../../support/clock';
import { closeTestDb, resetDb, testDb } from '../../support/db';
import { insertWalletMerchant } from '../../support/money';
import { auditRows } from '../../support/risk';

const clock = new TestClock('2026-11-21T12:00:00.000Z');
const fake = new B2cGateway();
let t: TestApp;
let db: Database;
let world: B2cWorld;
let counter = 0;

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
  clock.set('2026-11-21T12:00:00.000Z');
  fake.reset();
  await resetDb();
  await clearIdentityCaches(t);
  world = await b2cWorld(t, db, fake);
});

const unique = () => `${++counter}_${crypto.randomUUID().slice(0, 6)}`;
const paymentRow = async (id: number) => (await db.select().from(s.payments).where(eq(s.payments.id, id)))[0]!;
const refundRows = () => db.select().from(s.refunds);
const orders = () => db.select().from(s.orders);
const confirm = (body: string) => hook(t, clock, 'payments', world.gateway.code, body);
const NOTE = 'Refunded in full from the gateway dashboard.';

/** A payment held for staff: `amount` for another amount than the checkout's, `unknown` for a payment the gateway does not know. */
async function held(kind: 'amount' | 'unknown') {
  const { token } = await openCheckout(t, world);
  const { payment } = json(await pay(t, token, undefined));
  const intent = `pi_held_${unique()}`;
  // The confirmation and the gateway's record agree on another amount than the checkout's: the stored event states 1.00.
  const body = storefrontEvent(`evt_${unique()}`, payment.reference, {
    amount: kind === 'amount' ? '1.00' : payment.amount,
    intent,
  });
  if (kind === 'unknown') intents.delete(intent);
  expect((await confirm(body)).statusCode).toBe(200);
  const row = await paymentRow(payment.id);
  expect(row).toMatchObject({ status: 'pending', reviewRequired: true });
  // The hold recorded whether the gateway's record showed money received (decision 048).
  expect(holdMarkOf(row.raw)).toBe(kind === 'amount');
  return { payment: payment as { id: number; reference: string; amount: string }, intent };
}

/** Switches the automatic return off, so a payment held for another amount waits for staff. */
const noRefunds = () =>
  db.update(s.paymentGateways).set({ supportsRefunds: false }).where(eq(s.paymentGateways.id, world.gateway.id));
const RECEIVED = "The gateway's record shows this payment was received: send it back, then close it as returned.";

describe('POST /admin/held-payments/:id/close', () => {
  it('returned records a completed hand refund and an audit row; a later confirmation changes nothing', async () => {
    await db
      .update(s.paymentGateways)
      .set({ supportsRefunds: false })
      .where(eq(s.paymentGateways.id, world.gateway.id));
    const { payment, intent } = await held('amount');
    expect(await refundRows()).toHaveLength(0);
    const admin = await adminWith(t, ['refunds:approve'], { name: 'Layla Haddad' });
    const res = await admin.post(`/admin/held-payments/${payment.id}/close`, { outcome: 'returned', note: NOTE });
    expect(res.status).toBe(204);
    const [refund] = await refundRows();
    expect(refund).toMatchObject({
      paymentId: payment.id,
      orderId: null,
      // an orderless return names its payment's account
      accountId: (await paymentRow(payment.id)).accountId,
      amount: '1.0000',
      currency: 'GBP',
      method: 'manual',
      status: 'completed',
      requestedByType: 'staff',
      requestedById: admin.staffId,
      approvedBy: admin.staffId,
      note: NOTE,
      reason: 'Paid back by hand by staff',
    });
    const closed = await paymentRow(payment.id);
    expect(closed).toMatchObject({ status: 'pending', reviewRequired: true, reviewedBy: admin.staffId });
    expect(closed.reviewNote).toEndWith(`Paid back by hand by staff (RF-${refund!.id}).`);
    const [audit] = await auditRows(db, 'payment', payment.id);
    expect(audit).toMatchObject({ action: 'closed held payment', entityLabel: `PAY-${payment.id}, 1.0000 GBP` });
    expect(audit!.after).toMatchObject({ outcome: 'returned', refundId: refund!.id, note: NOTE });
    // A later confirmation of the payment, now for the full amount, changes nothing.
    const later = storefrontEvent(`evt_${unique()}`, payment.reference, { amount: payment.amount, intent });
    const answer = await confirm(later);
    expect(json(answer)).toEqual({ received: true, duplicate: true });
    expect(await orders()).toHaveLength(0);
    expect(await refundRows()).toHaveLength(1);
  });

  it('not_received fails the held payment; a later confirmation the gateway confirms captures it', async () => {
    const { payment, intent } = await held('unknown');
    const admin = await adminWith(t, ['refunds:approve']);
    const res = await admin.post(`/admin/held-payments/${payment.id}/close`, {
      outcome: 'not_received',
      note: 'The gateway dashboard shows no such payment.',
    });
    expect(res.status).toBe(204);
    const closed = await paymentRow(payment.id);
    expect(closed).toMatchObject({ status: 'failed', reviewRequired: false, reviewedBy: admin.staffId });
    expect(closed.reviewNote).toBe(
      'The gateway does not report this payment as paid. Closed by staff: no money was received.',
    );
    expect(await refundRows()).toHaveLength(0);
    const [audit] = await auditRows(db, 'payment', payment.id);
    expect(audit!.after).toMatchObject({ outcome: 'not_received', refundId: null });
    // Still inside the price lock and its grace: the real confirmation pays the checkout.
    const real = storefrontEvent(`evt_${unique()}`, payment.reference, { amount: payment.amount, intent });
    expect((await confirm(real)).statusCode).toBe(200);
    expect(await paymentRow(payment.id)).toMatchObject({ status: 'captured' });
    expect(await orders()).toHaveLength(1);
  });

  it('not_received is refused for a payment whose record showed its money received, and returned closes it', async () => {
    await noRefunds();
    const { payment } = await held('amount');
    const admin = await adminWith(t, ['refunds:approve']);
    const refused = await admin.post(`/admin/held-payments/${payment.id}/close`, {
      outcome: 'not_received',
      note: 'The gateway dashboard shows no such payment.',
    });
    expect(refused.status).toBe(409);
    expect(refused.body).toMatchObject({ code: 'CONFLICT', detail: RECEIVED });
    expect(await paymentRow(payment.id)).toMatchObject({ status: 'pending', reviewRequired: true, reviewedBy: null });
    expect(await auditRows(db, 'payment', payment.id)).toHaveLength(0);
    const res = await admin.post(`/admin/held-payments/${payment.id}/close`, { outcome: 'returned', note: NOTE });
    expect(res.status).toBe(204);
    expect(await refundRows()).toEqual([expect.objectContaining({ paymentId: payment.id, status: 'completed' })]);
  });

  it('a payment the record did not show as paid can be closed either way', async () => {
    const { payment } = await held('unknown');
    const admin = await adminWith(t, ['refunds:approve']);
    const res = await admin.post(`/admin/held-payments/${payment.id}/close`, { outcome: 'returned', note: NOTE });
    expect(res.status).toBe(204);
    expect(await refundRows()).toEqual([expect.objectContaining({ paymentId: payment.id, status: 'completed' })]);
  });

  it('a payment held before the mark existed accepts both outcomes', async () => {
    await noRefunds();
    const admin = await adminWith(t, ['refunds:approve']);
    const unmark = async (id: number) => {
      const { [HOLD_MARK_KEY]: mark, ...raw } = (await paymentRow(id)).raw;
      expect(mark).toEqual({ moneyReceived: true });
      await db.update(s.payments).set({ raw }).where(eq(s.payments.id, id));
      expect(holdMarkOf((await paymentRow(id)).raw)).toBeUndefined();
    };
    const first = (await held('amount')).payment;
    await unmark(first.id);
    const notReceived = await admin.post(`/admin/held-payments/${first.id}/close`, {
      outcome: 'not_received',
      note: 'The gateway dashboard shows no such payment.',
    });
    expect(notReceived.status).toBe(204);
    expect(await paymentRow(first.id)).toMatchObject({ status: 'failed', reviewRequired: false });
    const second = (await held('amount')).payment;
    await unmark(second.id);
    const returned = await admin.post(`/admin/held-payments/${second.id}/close`, { outcome: 'returned', note: NOTE });
    expect(returned.status).toBe(204);
    expect(await refundRows()).toEqual([expect.objectContaining({ paymentId: second.id, status: 'completed' })]);
  });

  it('is refused for an unknown id or a top-up, a payment that is not held, one whose money is being sent back, a short note, and without refunds:approve', async () => {
    const admin = await adminWith(t, ['refunds:approve']);
    const close = (id: number, body: Record<string, unknown> = { outcome: 'returned', note: NOTE }) =>
      admin.post(`/admin/held-payments/${id}/close`, body);
    expect((await close(999_999)).status).toBe(404);
    const merchant = await insertWalletMerchant(db);
    const invoice = await insertInvoiceRow(db, merchant.id, { gatewayId: world.gateway.id });
    const topUp = await insertPendingPayment(db, invoice, world.gateway.id, { reviewRequired: true });
    expect((await close(topUp.id)).status).toBe(404);
    // A payment that is not held: still waiting for its confirmation.
    const { token } = await openCheckout(t, world);
    const { payment: open } = json(await pay(t, token, undefined));
    const notHeld = await close(open.id);
    expect(notHeld.status).toBe(409);
    expect(notHeld.body).toMatchObject({ code: 'CONFLICT', detail: `PAY-${open.id} is not held for staff.` });
    // A held payment whose money the gateway is sending back.
    const { payment } = await held('amount');
    const [refund] = await refundRows();
    const returning = await close(payment.id);
    expect(returning.status).toBe(409);
    expect(returning.body.detail).toBe(
      `PAY-${payment.id} is already being sent back or was sent back (RF-${refund!.id}).`,
    );
    const short = await close(payment.id, { outcome: 'returned', note: 'too short' });
    expect(short.status).toBe(422);
    const viewer = await adminWith(t, ['refunds:read']);
    expect(
      (await viewer.post(`/admin/held-payments/${payment.id}/close`, { outcome: 'returned', note: NOTE })).status,
    ).toBe(403);
    expect(await auditRows(db, 'payment')).toHaveLength(0);
  });
});

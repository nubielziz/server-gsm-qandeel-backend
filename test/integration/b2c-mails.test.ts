// Integration tests of the customer emails of the storefront money flows (feature 16, decision 033, brief 16 "the decline emails the customer"):
// `order.received` when a payment captures and places the order, `order.completed` and `order.failed` when the order is delivered or rejected and
// refunded, `payment.failed` when the gateway says a payment failed and `refund.declined` when staff decline a refund. Each flow writes exactly one
// notification of the right event to the right customer, in the customer's language, and none when the flow is rolled back.
import { afterAll, beforeAll, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import { eq } from 'drizzle-orm';
import { type Database, schema as s } from '../../src/infra/db';
import { RefundProcessModule, RefundSender } from '../../src/modules/money';
import { NOTIFICATION_SEND_EVENT, NotificationService } from '../../src/modules/platform';
import { OrderSupplierMoves } from '../../src/modules/orders';
import { type AdminApi, adminWith } from '../support/admin-api';
import { type TestApp, createTestApp } from '../support/app';
import { clearIdentityCaches, signInStaff } from '../support/auth';
import { GatewayTestModule } from '../support/billing';
import {
  type B2cWorld,
  B2cGateway,
  type PaidOrder,
  b2cWorld,
  hook,
  json,
  openCheckout,
  paidOrder,
  pay,
  storefrontEvent,
} from '../support/b2c';
import { TestClock } from '../support/clock';
import { closeTestDb, resetDb, testDb } from '../support/db';
import { mailbox, notificationRows, sendAllQueued, seedDefaultTemplates } from '../support/notifications';
import { ledgerTotals } from '../support/money';
import { orderRow } from '../support/orders';

const clock = new TestClock('2026-11-07T12:00:00.000Z');
const fake = new B2cGateway();
let t: TestApp;
let db: Database;
let world: B2cWorld;
let staff: AdminApi;

beforeAll(async () => {
  ({ db } = await testDb());
  t = await createTestApp({ clock, imports: [GatewayTestModule, RefundProcessModule] });
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
  await seedDefaultTemplates(db);
  mailbox(t).reset();
  world = await b2cWorld(t, db, fake);
  staff = await adminWith(t, ['refunds:*', 'orders:*'], { name: 'Layla Haddad' });
});

const eventId = () => `evt_${crypto.randomUUID()}`;
const mails = (event?: string) =>
  notificationRows(db).then((rows) => rows.filter((row) => event === undefined || row.event === event));
const sendEvents = () => db.select().from(s.outboxEvents).where(eq(s.outboxEvents.type, NOTIFICATION_SEND_EVENT));
/** The placeholder values a notification row holds. */
const variablesOf = (row: { payload: unknown }): Record<string, string> =>
  (row.payload as { variables: Record<string, string> }).variables;
const customerOf = async (paid: PaidOrder) => (await orderRow(db, paid.orderId)).customerId!;

/** Writes the message and then fails, as a flow whose later step breaks: everything the flow wrote, the message included, must vanish. */
function failAfterTheMail() {
  const original = NotificationService.prototype.enqueue;
  return spyOn(NotificationService.prototype, 'enqueue').mockImplementation(async function (
    this: NotificationService,
    work,
    input,
  ) {
    await original.call(this, work, input);
    throw new Error('a step after the mail failed');
  });
}

/** Inserts a refund request of a customer (the customer's own request route belongs to the support feature). */
async function request(paid: PaidOrder, values: Partial<typeof s.refunds.$inferInsert> = {}) {
  const customerId = await customerOf(paid);
  const [row] = await db
    .insert(s.refunds)
    .values({
      paymentId: paid.paymentId,
      orderId: paid.orderId,
      customerId,
      amount: paid.charged,
      currency: 'GBP',
      reason: 'The code did not work',
      method: 'original',
      status: 'requested',
      requestedByType: 'customer',
      requestedById: customerId,
      createdAt: clock.now(),
      updatedAt: clock.now(),
      ...values,
    })
    .returning();
  return row!;
}

describe('order.received', () => {
  it('is written with the capture: one email to the buyer with the order, the amount paid and the service; none before the payment', async () => {
    const { token } = await openCheckout(t, world, { email: 'sam@mail.example' });
    const started = json(await pay(t, token, undefined));
    expect(await mails()).toHaveLength(0);

    const body = storefrontEvent(eventId(), started.payment.reference, { amount: started.payment.amount });
    expect((await hook(t, clock, 'payments', world.gateway.code, body)).statusCode).toBe(200);
    const [order] = await db.select().from(s.orders);
    const rows = await mails();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      event: 'order.received',
      recipientType: 'customer',
      recipientId: order!.customerId,
      channel: 'email',
      status: 'queued',
      payload: {
        variables: {
          customerName: 'there',
          orderId: `SF-${order!.id}`,
          amount: '3.84 GBP',
          service: 'iCloud Clean / Lost Check',
          device: '',
        },
      },
    });
    expect(await sendEvents()).toHaveLength(1);

    // The worker sends it: to the customer's address, with the template's texts filled in.
    await sendAllQueued(t);
    expect(mailbox(t).sent).toHaveLength(1);
    expect(mailbox(t).sent[0]).toMatchObject({
      to: 'sam@mail.example',
      subject: `Your order SF-${order!.id} is confirmed`,
    });
    expect(mailbox(t).sent[0]!.text).toContain('We received 3.84 GBP for "iCloud Clean / Lost Check"');

    // The same confirmation delivered again is a duplicate: no second email.
    await hook(t, clock, 'payments', world.gateway.code, body);
    expect(await mails()).toHaveLength(1);
  });

  it('a payment held for review, or a duplicate payment for a paid checkout, sends no order email', async () => {
    const { token } = await openCheckout(t, world);
    const first = json(await pay(t, token, undefined, 'k1')).payment;
    const second = json(await pay(t, token, undefined, 'k2')).payment;
    // Another amount than the quote: held, no order.
    await hook(
      t,
      clock,
      'payments',
      world.gateway.code,
      storefrontEvent(eventId(), first.reference, { amount: '1.00' }),
    );
    expect(await mails()).toHaveLength(0);
    await hook(
      t,
      clock,
      'payments',
      world.gateway.code,
      storefrontEvent(eventId(), second.reference, { amount: second.amount, intent: 'pi_second' }),
    );
    expect((await mails()).map((row) => row.event)).toEqual(['order.received']);
    // The first payment is confirmed correctly later: it is the duplicate of an already paid checkout.
    await hook(
      t,
      clock,
      'payments',
      world.gateway.code,
      storefrontEvent(eventId(), first.reference, { amount: first.amount, intent: 'pi_first' }),
    );
    expect((await mails()).map((row) => row.event)).toEqual(['order.received']);
  });

  it('an order delivered from stock at once is also told as completed', async () => {
    const owner = await signInStaff(t, ['inventory:write']);
    const imported = await t.app.inject({
      method: 'POST',
      url: `/admin/services/${world.icloud.serviceId}/inventory/import`,
      headers: owner.session.mutationHeaders,
      payload: { codes: ['GSM-STOCK-0001'] },
    });
    expect(imported.statusCode).toBeLessThan(300);
    const paid = await paidOrder(t, clock, world);
    expect(await orderRow(db, paid.orderId)).toMatchObject({ status: 'completed' });
    const rows = await mails();
    expect(rows.map((row) => row.event)).toEqual(['order.received', 'order.completed']);
    expect(rows.every((row) => row.recipientId === rows[0]!.recipientId)).toBe(true);
  });

  it('is rolled back with the capture: nothing is written when a later step fails', async () => {
    const { token } = await openCheckout(t, world);
    const started = json(await pay(t, token, undefined));
    const failing = failAfterTheMail();
    try {
      const body = storefrontEvent(eventId(), started.payment.reference, { amount: started.payment.amount });
      expect((await hook(t, clock, 'payments', world.gateway.code, body)).statusCode).toBe(500);
    } finally {
      failing.mockRestore();
    }
    expect(await db.select().from(s.orders)).toHaveLength(0);
    expect((await db.select().from(s.payments))[0]).toMatchObject({ status: 'pending' });
    expect(await mails()).toHaveLength(0);
    expect(await sendEvents()).toHaveLength(0);
    expect((await ledgerTotals(db)).transactions).toBe(0);
  });
});

describe('order.completed', () => {
  it('is written with the delivery: one email to the buyer, none for the other transitions', async () => {
    const paid = await paidOrder(t, clock, world, { email: 'ann@mail.example' });
    expect((await mails()).map((row) => row.event)).toEqual(['order.received']);
    expect((await staff.post(`/admin/orders/${paid.orderId}/accept`, {})).status).toBe(204);
    expect((await mails()).map((row) => row.event)).toEqual(['order.received']);

    expect((await staff.post(`/admin/orders/${paid.orderId}/reply`, { code: 'Unlocked' })).status).toBe(204);
    const rows = await mails('order.completed');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      recipientType: 'customer',
      recipientId: await customerOf(paid),
      channel: 'email',
      payload: {
        variables: {
          customerName: 'there',
          orderId: `SF-${paid.orderId}`,
          service: 'iCloud Clean / Lost Check',
          device: '',
        },
      },
    });
    await sendAllQueued(t);
    expect(mailbox(t).sent.map((mail) => [mail.to, mail.subject])).toEqual([
      ['ann@mail.example', `Your order SF-${paid.orderId} is confirmed`],
      ['ann@mail.example', 'Your unlock is ready'],
    ]);
  });

  it('uses the customer’s language when a template of it exists, and the English one when it does not', async () => {
    const paid = await paidOrder(t, clock, world, { email: 'jan@mail.example' });
    await db.insert(s.notificationTemplates).values({
      event: 'order.completed',
      channel: 'email',
      audience: 'customer',
      locale: 'de',
      subject: 'Ihre Bestellung {{orderId}} ist fertig',
      body: 'Hallo {{customerName}}, "{{service}}" ist fertig.',
      isActive: true,
    });
    const customerId = await customerOf(paid);
    await db.update(s.customers).set({ locale: 'de' }).where(eq(s.customers.id, customerId));
    expect((await staff.post(`/admin/orders/${paid.orderId}/reply`, { code: 'Unlocked' })).status).toBe(204);
    await sendAllQueued(t);
    expect(mailbox(t).sent.at(-1)).toMatchObject({
      to: 'jan@mail.example',
      subject: `Ihre Bestellung SF-${paid.orderId} ist fertig`,
    });

    // A customer who reads French has no French template: the English one is used.
    const other = await paidOrder(t, clock, world, { email: 'luc@mail.example' });
    await db
      .update(s.customers)
      .set({ locale: 'fr', name: 'Luc Martin' })
      .where(eq(s.customers.id, await customerOf(other)));
    expect((await staff.post(`/admin/orders/${other.orderId}/reply`, { code: 'Unlocked' })).status).toBe(204);
    await sendAllQueued(t);
    expect(mailbox(t).sent.at(-1)).toMatchObject({
      to: 'luc@mail.example',
      subject: 'Your unlock is ready',
    });
    expect(mailbox(t).sent.at(-1)!.text).toContain('Hi Luc Martin,');
  });

  it('sends nothing when the template is switched off or the order is rolled back', async () => {
    const paid = await paidOrder(t, clock, world);
    const failing = failAfterTheMail();
    try {
      expect((await staff.post(`/admin/orders/${paid.orderId}/reply`, { code: 'Unlocked' })).status).toBe(500);
    } finally {
      failing.mockRestore();
    }
    expect(await orderRow(db, paid.orderId)).toMatchObject({ status: 'pending' });
    expect((await mails()).map((row) => row.event)).toEqual(['order.received']);

    await db
      .update(s.notificationTemplates)
      .set({ isActive: false })
      .where(eq(s.notificationTemplates.event, 'order.completed'));
    expect((await staff.post(`/admin/orders/${paid.orderId}/reply`, { code: 'Unlocked' })).status).toBe(204);
    expect((await mails()).map((row) => row.event)).toEqual(['order.received']);
  });
});

describe('order.failed', () => {
  it('is written with the rejection and the refund: one email with the amount that goes back, none for a staff reply', async () => {
    const paid = await paidOrder(t, clock, world, { email: 'ann@mail.example' });
    expect((await staff.post(`/admin/orders/${paid.orderId}/reject`, { reason: 'Cannot be unlocked' })).status).toBe(
      204,
    );
    const rows = await mails('order.failed');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      recipientType: 'customer',
      recipientId: await customerOf(paid),
      payload: {
        variables: { orderId: `SF-${paid.orderId}`, amount: '3.84 GBP', service: 'iCloud Clean / Lost Check' },
      },
    });
    expect(await mails('order.completed')).toHaveLength(0);
    await sendAllQueued(t);
    expect(mailbox(t).sent.at(-1)).toMatchObject({
      to: 'ann@mail.example',
      subject: `We couldn’t unlock order SF-${paid.orderId}`,
    });
    expect(mailbox(t).sent.at(-1)!.text).toContain('we have refunded 3.84 GBP');
  });

  it('is written when a supplier rejects the order, and when staff approve a refund of an open order', async () => {
    const supplierRejected = await paidOrder(t, clock, world, { email: 'a@mail.example' });
    await db
      .update(s.orders)
      .set({ status: 'processing', dispatchState: 'sent' })
      .where(eq(s.orders.id, supplierRejected.orderId));
    const moves = t.app.get(OrderSupplierMoves, { strict: false });
    await db.transaction((tx) =>
      moves.settle(tx, { orderId: supplierRejected.orderId, result: 'rejected', supplierId: 1, text: 'Blacklisted' }),
    );
    expect((await mails('order.failed')).map((row) => variablesOf(row)['orderId'])).toEqual([
      `SF-${supplierRejected.orderId}`,
    ]);

    const approved = await paidOrder(t, clock, world, { email: 'b@mail.example' });
    const refund = await request(approved);
    expect((await staff.post(`/admin/refunds/${refund.id}/approve`, {})).status).toBe(200);
    expect((await mails('order.failed')).map((row) => variablesOf(row)['orderId'])).toEqual([
      `SF-${supplierRejected.orderId}`,
      `SF-${approved.orderId}`,
    ]);
  });

  it('with autoRefundFailed off the customer is told when staff approve the request, not when the supplier rejects', async () => {
    const settings = await adminWith(t, ['settings:storefront', 'settings:read']);
    expect((await settings.patch('/admin/storefront/settings', { autoRefundFailed: false })).status).toBe(200);
    const paid = await paidOrder(t, clock, world);
    await db.update(s.orders).set({ status: 'processing', dispatchState: 'sent' }).where(eq(s.orders.id, paid.orderId));
    const moves = t.app.get(OrderSupplierMoves, { strict: false });
    await db.transaction((tx) =>
      moves.settle(tx, { orderId: paid.orderId, result: 'rejected', supplierId: 1, text: 'Blacklisted' }),
    );
    // The order failed, but nothing went back yet: no "refunded" email.
    expect(await mails('order.failed')).toHaveLength(0);
    const [refund] = await db.select().from(s.refunds);
    expect((await staff.post(`/admin/refunds/${refund!.id}/approve`, {})).status).toBe(200);
    const rows = await mails('order.failed');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ payload: { variables: { orderId: `SF-${paid.orderId}`, amount: '3.84 GBP' } } });
    // Paying the refund out afterwards writes nothing more.
    expect(await t.app.get(RefundSender, { strict: false }).send(refund!.id, false)).toBe('completed');
    expect(await mails('order.failed')).toHaveLength(1);
  });

  it('is rolled back with the rejection', async () => {
    const paid = await paidOrder(t, clock, world);
    const failing = failAfterTheMail();
    try {
      expect((await staff.post(`/admin/orders/${paid.orderId}/reject`, { reason: 'Cannot be unlocked' })).status).toBe(
        500,
      );
    } finally {
      failing.mockRestore();
    }
    expect(await orderRow(db, paid.orderId)).toMatchObject({ status: 'pending' });
    expect(await db.select().from(s.refunds)).toHaveLength(0);
    expect((await mails()).map((row) => row.event)).toEqual(['order.received']);
    expect(await sendEvents()).toHaveLength(1);
  });
});

describe('payment.failed', () => {
  async function pending(email = 'sam@mail.example') {
    const { token } = await openCheckout(t, world, { email });
    return json(await pay(t, token, undefined)).payment as { id: number; reference: string; amount: string };
  }
  const failure = (payment: { reference: string; amount: string }) =>
    storefrontEvent(eventId(), payment.reference, {
      amount: payment.amount,
      type: 'checkout.session.async_payment_failed',
      paymentStatus: 'unpaid',
    });

  it('is written when the gateway says the payment failed: one email to the buyer, and a repeat sends no second one', async () => {
    const payment = await pending();
    const body = failure(payment);
    expect((await hook(t, clock, 'payments', world.gateway.code, body)).statusCode).toBe(200);
    expect((await db.select().from(s.payments))[0]).toMatchObject({ status: 'failed' });
    const rows = await mails();
    expect(rows).toHaveLength(1);
    const [row] = rows;
    expect(row).toMatchObject({
      event: 'payment.failed',
      recipientType: 'customer',
      channel: 'email',
      payload: { variables: { customerName: 'there', amount: '3.84 GBP' } },
    });
    const [stored] = await db.select().from(s.payments);
    expect(row!.recipientId).toBe(stored!.customerId!);
    await sendAllQueued(t);
    expect(mailbox(t).sent[0]).toMatchObject({ to: 'sam@mail.example', subject: 'Your payment didn’t go through' });

    await hook(t, clock, 'payments', world.gateway.code, failure(payment));
    expect(await mails()).toHaveLength(1);
  });

  it('sends nothing for a payment that is already captured, and nothing for progress events', async () => {
    const paid = await paidOrder(t, clock, world);
    const before = (await mails()).length;
    await hook(
      t,
      clock,
      'payments',
      world.gateway.code,
      storefrontEvent(eventId(), paid.reference, {
        amount: paid.charged,
        type: 'checkout.session.async_payment_failed',
        paymentStatus: 'unpaid',
      }),
    );
    expect(await mails()).toHaveLength(before);
    const payment = await pending('ann@mail.example');
    await hook(
      t,
      clock,
      'payments',
      world.gateway.code,
      storefrontEvent(eventId(), payment.reference, { amount: payment.amount, paymentStatus: 'unpaid' }),
    );
    expect(await mails('payment.failed')).toHaveLength(0);
  });

  it('is rolled back with the payment update', async () => {
    const payment = await pending();
    const failing = failAfterTheMail();
    try {
      expect((await hook(t, clock, 'payments', world.gateway.code, failure(payment))).statusCode).toBe(500);
    } finally {
      failing.mockRestore();
    }
    expect((await db.select().from(s.payments))[0]).toMatchObject({ status: 'pending' });
    expect(await mails()).toHaveLength(0);
    expect(await sendEvents()).toHaveLength(0);
  });
});

describe('refund.declined', () => {
  it('is written with the decline: one email to the customer with the order, the amount and the reason staff wrote', async () => {
    const paid = await paidOrder(t, clock, world, { email: 'sam@mail.example' });
    const refund = await request(paid);
    const res = await staff.post(`/admin/refunds/${refund.id}/decline`, {
      reason: 'The code was delivered and works.',
    });
    expect(res.status).toBe(200);
    const rows = await mails('refund.declined');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      recipientType: 'customer',
      recipientId: await customerOf(paid),
      channel: 'email',
      payload: {
        variables: {
          customerName: 'there',
          orderId: `SF-${paid.orderId}`,
          amount: '3.84 GBP',
          reason: 'The code was delivered and works.',
        },
      },
    });
    await sendAllQueued(t);
    const mail = mailbox(t).sent.find((sent) => sent.subject.startsWith('About your refund request'));
    expect(mail).toMatchObject({
      to: 'sam@mail.example',
      subject: `About your refund request for order SF-${paid.orderId}`,
    });
    expect(mail!.text).toContain('Reason: The code was delivered and works.');
    expect(mail!.text).toContain('refund request of 3.84 GBP');

    // A second decline is refused (the refund is no longer waiting) and writes no second email.
    expect((await staff.post(`/admin/refunds/${refund.id}/decline`, { reason: 'Still a sentence here.' })).status).toBe(
      409,
    );
    expect(await mails('refund.declined')).toHaveLength(1);
  });

  it('writes nothing for a decline that is refused, and is rolled back when the audit row cannot be written', async () => {
    const paid = await paidOrder(t, clock, world);
    const refund = await request(paid);
    expect((await staff.post(`/admin/refunds/${refund.id}/decline`, { reason: 'No' })).status).toBe(422);
    expect(await mails('refund.declined')).toHaveLength(0);

    const failing = failAfterTheMail();
    try {
      expect(
        (await staff.post(`/admin/refunds/${refund.id}/decline`, { reason: 'The code was delivered and works.' }))
          .status,
      ).toBe(500);
    } finally {
      failing.mockRestore();
    }
    expect((await db.select().from(s.refunds).where(eq(s.refunds.id, refund.id)))[0]).toMatchObject({
      status: 'requested',
    });
    expect(await mails('refund.declined')).toHaveLength(0);
    expect(await db.select().from(s.auditLogs).where(eq(s.auditLogs.action, 'declined refund'))).toHaveLength(0);
  });

  it('uses the template staff edited, and sends nothing when they switched it off', async () => {
    const paid = await paidOrder(t, clock, world);
    await db
      .update(s.notificationTemplates)
      .set({ subject: 'Refund {{orderId}}: no', body: 'Sorry {{customerName}}: {{reason}}' })
      .where(eq(s.notificationTemplates.event, 'refund.declined'));
    const first = await request(paid);
    await staff.post(`/admin/refunds/${first.id}/decline`, { reason: 'Edited text applies here.' });
    await sendAllQueued(t);
    expect(mailbox(t).sent.at(-1)).toMatchObject({
      subject: `Refund SF-${paid.orderId}: no`,
      text: 'Sorry there: Edited text applies here.',
    });

    await db
      .update(s.notificationTemplates)
      .set({ isActive: false })
      .where(eq(s.notificationTemplates.event, 'refund.declined'));
    const second = await request(paid);
    expect((await staff.post(`/admin/refunds/${second.id}/decline`, { reason: 'Switched off, no mail.' })).status).toBe(
      200,
    );
    expect(await mails('refund.declined')).toHaveLength(1);
  });
});

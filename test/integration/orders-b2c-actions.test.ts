// Staff actions on a storefront (B2C) order (feature 5): the ledger side of the engine for an order paid by a customer. Storefront orders
// are created by features 14a and 16; these tests insert one, post its payment as feature 16 will, and check what a reply, a reject, a
// reopen and a second reject do: customer funds to revenue, the refund of an undelivered order, the revenue back to customer funds, and
// `USE_REFUNDS` for an order delivered before.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { Money } from '../../src/common/money';
import { schema as s } from '../../src/infra/db';
import { b2cPay, postTransaction } from '../../src/modules/money';
import { type AdminApi, adminWith } from '../support/admin-api';
import { type TestApp, createTestApp } from '../support/app';
import { clearIdentityCaches } from '../support/auth';
import { closeTestDb, resetDb, testDb } from '../support/db';
import { ledgerTotals } from '../support/money';
import {
  eventsOf,
  insertOrderRow,
  ledgerOf,
  type OrdersWorld,
  orderRow,
  ordersWorld,
  outboxOf,
  systemBalance,
} from '../support/orders';

let t: TestApp;
let world: OrdersWorld;
let staff: AdminApi;

beforeAll(async () => {
  t = await createTestApp();
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

/** A paid storefront order: net 12.49, VAT 2.50, the payment posted as `b2c_pay`. */
async function paidOrder(): Promise<number> {
  const { db, auto } = world;
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
      new Date(),
    ),
  );
  return order.id;
}

describe('a storefront order', () => {
  it('a reply delivers it: customer funds become revenue (b2c_deliver)', async () => {
    const { db } = world;
    const id = await paidOrder();
    expect((await staff.post(`/admin/orders/${id}/reply`, { code: 'Unlocked' })).status).toBe(204);
    expect(await systemBalance(db, 'customer_funds')).toBe('0.0000');
    expect(await systemBalance(db, 'revenue')).toBe('12.4900');
    expect(await systemBalance(db, 'vat_payable')).toBe('2.5000');
    expect((await ledgerOf(db, id)).map((entry) => [entry.kind, entry.key])).toEqual([
      ['b2c_payment', `test:pay:${id}`],
      ['order_settle', `order:${id}:settle`],
    ]);
    expect((await outboxOf(db, 'order.status_changed', id))[0]!.payload).toMatchObject({
      clientId: null,
      toStatus: 'completed',
    });
    expect((await ledgerTotals(db)).sum).toBe('0.0000');
  });

  it('a reject before delivery refunds the payment in full: customer funds and VAT go back to the gateway account', async () => {
    const { db } = world;
    const id = await paidOrder();
    expect((await staff.post(`/admin/orders/${id}/reject`, { reason: 'Cannot be unlocked' })).status).toBe(204);
    expect(await systemBalance(db, 'customer_funds')).toBe('0.0000');
    expect(await systemBalance(db, 'vat_payable')).toBe('0.0000');
    // The gateway account holds only the two 100 USD deposits that funded the merchants: payment and refund cancel out.
    expect(await systemBalance(db, 'gateway_clearing')).toBe('200.0000');
    expect((await ledgerOf(db, id)).at(-1)).toEqual({ kind: 'refund', key: `order:${id}:refund` });
    expect((await eventsOf(db, id)).slice(-2).map((event) => event.type)).toEqual(['rejected', 'refund']);
  });

  it('a reopen returns the revenue to customer funds; a reject after it is refunded from /admin/refunds (USE_REFUNDS)', async () => {
    const { db } = world;
    const id = await paidOrder();
    await staff.post(`/admin/orders/${id}/reply`, { code: 'Unlocked' });
    expect((await staff.post(`/admin/orders/${id}/reopen`, {})).status).toBe(204);
    expect(await systemBalance(db, 'revenue')).toBe('0.0000');
    expect(await systemBalance(db, 'customer_funds')).toBe('12.4900');
    expect((await orderRow(db, id)).status).toBe('processing');
    const refused = await staff.post(`/admin/orders/${id}/reject`, { reason: 'Customer asked' });
    expect(refused.status).toBe(409);
    expect(refused.body).toMatchObject({ code: 'USE_REFUNDS' });
    // The order stays open and the money stays where it is.
    expect((await orderRow(db, id)).status).toBe('processing');
    expect(await systemBalance(db, 'customer_funds')).toBe('12.4900');
    expect((await ledgerTotals(db)).sum).toBe('0.0000');
  });
});

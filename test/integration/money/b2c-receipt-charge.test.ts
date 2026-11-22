// Integration tests of the paid receipt of a storefront card payment: it states the amount the payment charged, in the payment's currency,
// even when the currency's decimals changed between the quote, the payment page and the gateway's confirmation (the ledger keeps the USD
// gross the checkout locked).
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { eq, sql } from 'drizzle-orm';
import { type Database, schema as s } from '@src/infra/db';
import { Money } from '@src/common/money';
import { RefundProcessModule } from '@src/modules/money';
import { type AdminApi, adminWith } from '../../support/admin-api';
import { type TestApp, createTestApp } from '../../support/app';
import { clearIdentityCaches } from '../../support/auth';
import { B2cGateway, type B2cWorld, b2cWorld, hook, json, openCheckout, pay, storefrontEvent } from '../../support/b2c';
import { GatewayTestModule } from '../../support/billing';
import { TestClock } from '../../support/clock';
import { closeTestDb, resetDb, testDb } from '../../support/db';
import { seedDefaultTemplates } from '../../support/notifications';
import { STORE_ORIGIN, clearStoreRateLimits } from '../../support/store';

const clock = new TestClock('2026-11-10T12:00:00.000Z');
const fake = new B2cGateway();
let t: TestApp;
let db: Database;
let world: B2cWorld;

beforeAll(async () => {
  ({ db } = await testDb());
  t = await createTestApp({
    clock,
    imports: [GatewayTestModule, RefundProcessModule],
    env: { SHOP_ORIGINS: STORE_ORIGIN },
  });
});
afterAll(async () => {
  await fake.stop();
  await resetDb();
  await t.close();
  await closeTestDb();
});
beforeEach(async () => {
  clock.set('2026-11-10T12:00:00.000Z');
  fake.reset();
  await resetDb();
  await clearIdentityCaches(t);
  await clearStoreRateLimits(t);
  world = await b2cWorld(t, db, fake);
  await seedDefaultTemplates(db);
});

const gbpId = async () => (await db.select().from(s.currencies).where(eq(s.currencies.code, 'GBP')))[0]!.id;
const setDecimals = async (staff: AdminApi, decimals: number) =>
  expect((await staff.patch(`/admin/currencies/${await gbpId()}`, { decimals })).status).toBe(200);

/** Confirms a payment at the gateway for exactly what it charged, and reads the payment, its receipt and the USD capture journal. */
async function confirm(payment: { id: number; reference: string; amount: string; currency: string }, n: number) {
  const body = storefrontEvent(`evt_receipt_${n}`, payment.reference, {
    amount: payment.amount,
    currency: payment.currency,
    intent: `pi_receipt_${n}`,
  });
  expect((await hook(t, clock, 'payments', world.gateway.code, body)).statusCode).toBe(200);
  const [row] = await db.select().from(s.payments).where(eq(s.payments.id, payment.id));
  const [invoice] = await db.select().from(s.invoices).where(eq(s.invoices.id, row!.invoiceId!));
  const journal = await db.execute<{ account: string; amount: string }>(
    sql`select a.kind as account, e.amount::text as amount from ledger_entries e join ledger_accounts a on a.id = e.account_id
        join ledger_transactions x on x.id = e.transaction_id where x.idempotency_key = ${`payment:${payment.id}:capture`}
        order by a.kind`,
  );
  return { row: row!, invoice: invoice!, journal: journal.rows };
}

/** The receipt states the charge: its gross and total are the payment's amount and currency, and its net and tax add up to it. */
function expectReceiptOfCharge(found: Awaited<ReturnType<typeof confirm>>) {
  expect(found.row.status).toBe('captured');
  expect(found.invoice).toMatchObject({
    kind: 'receipt',
    amount: found.row.amount,
    total: found.row.amount,
    currency: found.row.currency,
  });
  expect(Money.of(found.invoice.netAmount).add(Money.of(found.invoice.taxAmount)).toWire()).toBe(found.row.amount);
}

describe('the paid receipt of a storefront payment', () => {
  it('states what the payment charged when the decimals changed after the payment page opened', async () => {
    const staff = await adminWith(t, ['settings:update', 'currencies:update']);
    const { token, session } = await openCheckout(t, world, { serviceId: world.att.serviceId });
    const started = await pay(t, token, undefined);
    expect(started.statusCode).toBe(201);
    const { payment } = json(started);
    expect(payment.amount).toBe(Money.of(session.amounts.display.gross).toWire());
    await setDecimals(staff, 0);
    const found = await confirm(payment, 1);
    expectReceiptOfCharge(found);
    expect(found.invoice.total).toBe(Money.of(session.amounts.display.gross).toWire());
    expect(found.journal.find((line) => line.account === 'gateway_clearing')?.amount).toBe(
      Money.of(session.amounts.usd.gross).toWire(),
    );
  });

  it('states what the payment charged when the decimals changed between the quote and the payment page', async () => {
    const staff = await adminWith(t, ['settings:update', 'currencies:update']);
    const { token } = await openCheckout(t, world, { serviceId: world.att.serviceId });
    await setDecimals(staff, 0);
    const started = await pay(t, token, undefined);
    expect(started.statusCode).toBe(201);
    const { payment } = json(started);
    await setDecimals(staff, 2);
    const found = await confirm(payment, 2);
    expectReceiptOfCharge(found);
    expect(found.invoice.total).toBe(payment.amount);
  });
});

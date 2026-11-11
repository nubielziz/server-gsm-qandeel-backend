// Integration tests of the customer wallet in the privacy actions (feature 21, plan § 5.6.10): anonymize is refused while the store balance
// is not zero or a top-up waits for review, voids unpaid top-ups otherwise; the data export holds the balance and its masked statement.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { eq } from 'drizzle-orm';
import { schema as s } from '../../src/infra/db';
import { type AdminApi, adminWith } from '../support/admin-api';
import { type TestApp, createTestApp } from '../support/app';
import { clearIdentityCaches } from '../support/auth';
import { TestClock } from '../support/clock';
import { fundCustomer, insertWalletTemplates, walletSettings } from '../support/customer-wallet';
import { closeTestDb, resetDb, testDb } from '../support/db';
import { insertUsd } from '../support/fixtures';
import { CONSOLE_ORIGIN } from '../support/staff-console';
import { customerRow, makeCustomer } from '../support/store';

const clock = new TestClock('2026-11-10T09:00:00.000Z');
let t: TestApp;
let staff: AdminApi;

beforeAll(async () => {
  t = await createTestApp({ clock, env: { CORS_ORIGINS: CONSOLE_ORIGIN } });
});
beforeEach(async () => {
  clock.set('2026-11-10T09:00:00.000Z');
  await resetDb();
  await clearIdentityCaches(t);
  const { db } = await testDb();
  await insertUsd(db);
  await walletSettings(t, db);
  await insertWalletTemplates(db);
  staff = await adminWith(t, ['customers:privacy', 'customers:read', 'wallet:read', 'wallet:adjust']);
});
afterAll(async () => {
  await resetDb();
  await clearIdentityCaches(t);
  await t.close();
  await closeTestDb();
});

async function topUpInvoice(customerId: number, number: string, withPendingPayment = false) {
  const { db } = await testDb();
  const [gateway] = await db
    .insert(s.paymentGateways)
    .values({ code: `cliq-${number}`, driver: 'manual', name: 'CliQ', isManual: true, audience: 'b2c' })
    .returning({ id: s.paymentGateways.id });
  const [invoice] = await db
    .insert(s.invoices)
    .values({
      number,
      customerId,
      kind: 'topup',
      amount: '20',
      netAmount: '20',
      total: '20',
      currency: 'USD',
      gatewayId: gateway!.id,
    })
    .returning({ id: s.invoices.id });
  if (withPendingPayment) {
    await db.insert(s.payments).values({
      invoiceId: invoice!.id,
      customerId,
      purpose: 'topup',
      gatewayId: gateway!.id,
      amount: '20',
      currency: 'USD',
      status: 'pending',
      methodType: 'bank',
    });
  }
  return invoice!.id;
}

const anonymize = (id: number) => staff.post(`/admin/customers/${id}/anonymize`);

describe('POST /admin/customers/:id/anonymize with a store balance', () => {
  it('is refused while the balance is not zero, and goes through once it is brought to zero', async () => {
    const customer = await makeCustomer(t);
    const { db } = await testDb();
    await fundCustomer(db, customer.id, '15');
    const refused = await anonymize(customer.id);
    expect(refused.status).toBe(409);
    expect(refused.body).toMatchObject({ code: 'CONFLICT' });
    expect(refused.body.detail).toContain('15.0000 USD');
    expect((await customerRow(customer.id)).status).toBe('active');
    await staff.post(
      `/admin/customers/${customer.id}/wallet/adjust`,
      { amount: '15.0000', direction: 'debit', reason: 'Closing the balance' },
      { 'idempotency-key': 'close' },
    );
    expect((await anonymize(customer.id)).status).toBe(204);
    expect((await customerRow(customer.id)).status).toBe('anonymized');
  });

  it('is refused while a top-up waits for review, and voids an unpaid top-up', async () => {
    const waiting = await makeCustomer(t);
    await topUpInvoice(waiting.id, 'INV-2026-0001', true);
    expect((await anonymize(waiting.id)).status).toBe(409);

    const unpaid = await makeCustomer(t);
    const invoiceId = await topUpInvoice(unpaid.id, 'INV-2026-0002');
    expect((await anonymize(unpaid.id)).status).toBe(204);
    const { db } = await testDb();
    const [invoice] = await db.select().from(s.invoices).where(eq(s.invoices.id, invoiceId));
    expect(invoice).toMatchObject({ status: 'void', idempotencyKey: null });
  });

  it('lets a customer without a wallet be anonymized as before', async () => {
    const customer = await makeCustomer(t);
    expect((await anonymize(customer.id)).status).toBe(204);
  });
});

describe('GET /admin/customers/:id/export with a store balance', () => {
  it('holds the balance and its lines with the staff reason hidden', async () => {
    const customer = await makeCustomer(t);
    const { db } = await testDb();
    await fundCustomer(db, customer.id, '40', clock.now());
    await staff.post(
      `/admin/customers/${customer.id}/wallet/adjust`,
      { amount: '4.0000', direction: 'debit', reason: 'Secret staff note' },
      { 'idempotency-key': 'x' },
    );
    const res = await t.app.inject({
      method: 'GET',
      url: `/admin/customers/${customer.id}/export`,
      headers: { ...staff.session.headers, 'sec-fetch-site': 'same-site' },
      remoteAddress: '127.0.0.1',
    });
    expect(res.statusCode).toBe(200);
    const file = res.json();
    expect(file.format).toBe(1);
    expect(file.wallet).toMatchObject({ currency: 'USD', balance: '36.0000' });
    expect(file.wallet.entries).toEqual([
      expect.objectContaining({ kind: 'deposit', amount: '40.0000', balanceAfter: '40.0000' }),
      expect.objectContaining({
        kind: 'adjustment',
        memo: 'Balance adjustment',
        amount: '-4.0000',
        balanceAfter: '36.0000',
      }),
    ]);
    expect(res.body).not.toContain('Secret staff note');
  });
});

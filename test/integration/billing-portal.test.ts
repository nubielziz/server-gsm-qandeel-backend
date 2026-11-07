// Integration tests of the merchant portal's billing routes (map stage 8, MISMATCHES B162 and B163): the payment methods open to the
// merchant's group, top-up invoices through a manual and an automatic gateway (a local server plays the gateway), the limits of
// catalog-17, the receipt upload with its refusals, and what a merchant never sees of another merchant.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { eq } from 'drizzle-orm';
import { type Database, schema as s } from '../../src/infra/db';
import { adminWith } from '../support/admin-api';
import { type TestApp, createTestApp } from '../support/app';
import { clearIdentityCaches, insertMerchant } from '../support/auth';
import {
  FakeGateway,
  GatewayTestModule,
  insertGateway,
  insertInvoiceRow,
  insertPendingPayment,
  insertProofFile,
} from '../support/billing';
import { DAY, TestClock } from '../support/clock';
import { closeTestDb, resetDb, testDb } from '../support/db';
import { insertWalletMerchant } from '../support/money';
import { portalFor } from '../support/webhooks';

const clock = new TestClock('2026-11-01T10:00:00.000Z');
const fake = new FakeGateway();
let t: TestApp;
let db: Database;

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
  clock.set('2026-11-01T10:00:00.000Z');
  fake.reset();
  await resetDb();
  await clearIdentityCaches(t);
});

/** A merchant with a portal session, its group limit per deposit and a country. */
async function merchant(depositLimit = '0') {
  const made = await insertWalletMerchant(db, { name: 'Zain Mobile Hub' });
  const [client] = await db.select().from(s.clients).where(eq(s.clients.id, made.id));
  await db.update(s.clientGroups).set({ depositLimit }).where(eq(s.clientGroups.id, client!.groupId));
  await db.update(s.clients).set({ country: 'JO' }).where(eq(s.clients.id, made.id));
  return { ...made, groupId: client!.groupId, portal: await portalFor(t, made.id) };
}

const bank = (overrides: Partial<typeof s.paymentGateways.$inferInsert> = {}) =>
  insertGateway(t, db, {
    code: 'bank',
    name: 'Bank transfer',
    isManual: true,
    minAmount: '50',
    maxAmount: '5000',
    instructions: 'IBAN JO94 0001',
    ...overrides,
  });
const card = (overrides: Record<string, unknown> = {}) =>
  insertGateway(t, db, {
    code: 'card',
    name: 'Card gateway',
    driver: 'card',
    feePercent: '2.9',
    feeFixed: '0.3',
    apiBase: fake.url,
    audience: 'both',
    ...overrides,
  });

describe('GET /client/payment-methods', () => {
  it('lists the active methods of the merchant group by name, with the group limit folded into the maximum', async () => {
    const { portal, groupId } = await merchant('1000');
    await card();
    await bank();
    await insertGateway(t, db, { code: 'b2c', name: 'Storefront only', audience: 'b2c' });
    await insertGateway(t, db, { code: 'off', name: 'Switched off', isActive: false, audience: 'b2b' });
    await insertGateway(t, db, { code: 'vip', name: 'VIP only', audience: 'b2b', allowedGroupIds: [groupId + 1000] });
    await insertGateway(t, db, {
      code: 'mine',
      name: 'Mine',
      audience: 'b2b',
      allowedGroupIds: [groupId],
      maxAmount: '300',
    });
    const res = await portal.call('GET', '/client/payment-methods');
    expect(res.status).toBe(200);
    expect(res.total).toBe(3);
    expect(res.body.map((row: { name: string }) => row.name)).toEqual(['Bank transfer', 'Card gateway', 'Mine']);
    // The group limit (1000) is below the card's 2000... and above Mine's own 300: the lower of the two wins.
    expect(res.body.map((row: { maxAmount: string }) => row.maxAmount)).toEqual(['1000.0000', '1000.0000', '300.0000']);
  });

  it('answers the fields of B162 and nothing secret', async () => {
    const { portal } = await merchant('1000');
    await card({ maxAmount: '0', holdHours: 2 });
    await bank({ maxAmount: '5000' });
    const res = await portal.call('GET', '/client/payment-methods');
    const [first, second] = res.body;
    expect(first).toEqual({
      id: expect.any(Number),
      code: 'bank',
      name: 'Bank transfer',
      kind: 'manual',
      methodType: 'bank',
      feePercent: '0.0000',
      feeFixed: '0.0000',
      minAmount: '50.0000',
      maxAmount: '1000.0000',
      currency: 'USD',
      holdHours: 0,
      instructions: 'IBAN JO94 0001',
    });
    expect(second).toMatchObject({
      kind: 'automatic',
      methodType: 'card',
      maxAmount: '1000.0000',
      holdHours: 2,
      instructions: '',
    });
    expect(JSON.stringify(res.body)).not.toMatch(/secret|config|webhook|allowedGroupIds/i);
  });

  it('refuses a merchant that waits for approval', async () => {
    const pending = await portalFor(t, await insertMerchant(db, { status: 'pending' }));
    expect((await pending.call('GET', '/client/payment-methods')).body.code).toBe('ACCOUNT_PENDING_APPROVAL');
  });
});

describe('POST /client/invoices', () => {
  it('writes a top-up invoice through a manual method and answers the instructions', async () => {
    const { portal, id } = await merchant();
    const gatewayId = await bank({ feePercent: '1', feeFixed: '0.5' });
    const res = await portal.call('POST', '/client/invoices', { amount: '100', gatewayId });
    expect(res.status).toBe(201);
    expect(res.body.instructions).toBe('IBAN JO94 0001');
    expect(res.body.invoice).toMatchObject({
      kind: 'topup',
      status: 'open',
      amount: '100.0000',
      fee: '1.5000',
      netAmount: '98.5000',
      taxAmount: '0.0000',
      total: '100.0000',
      currency: 'USD',
      description: null,
      gateway: { id: gatewayId, name: 'Bank transfer' },
      dueAt: new Date(clock.nowMs() + 14 * DAY).toISOString(),
      paidAt: null,
    });
    expect(res.body.paymentUrl).toBeUndefined();
    const [row] = await db.select().from(s.invoices).where(eq(s.invoices.id, res.body.invoice.id));
    expect(row).toMatchObject({ clientId: id, taxCountry: 'JO' });
    expect(row!.number).toBe(`INV-2026-${String(row!.id).padStart(4, '0')}`);
    // A portal write writes no audit row (B121) and no ledger entry.
    expect(await db.select().from(s.auditLogs)).toHaveLength(0);
    expect(await db.select().from(s.ledgerTransactions)).toHaveLength(0);
  });

  it('opens a checkout at an automatic gateway with its API credential and answers the payment address', async () => {
    const { portal } = await merchant();
    const gatewayId = await card();
    const res = await portal.call('POST', '/client/invoices', { amount: '100', gatewayId });
    expect(res.status).toBe(201);
    expect(res.body.paymentUrl).toMatch(/^https:\/\/pay\.example\/cs_/);
    expect(res.body.instructions).toBeUndefined();
    expect(res.body.invoice).toMatchObject({ fee: '3.2000', netAmount: '96.8000', total: '100.0000' });
    const [request] = fake.requests;
    expect(request).toMatchObject({ method: 'POST', path: '/v1/checkout/sessions' });
    expect(request!.headers.authorization).toBe('Bearer sk_test_gateway_secret_1234');
    const form = new URLSearchParams(request!.body);
    expect(form.get('client_reference_id')).toBe(res.body.invoice.number);
    expect(form.get('line_items[0][price_data][unit_amount]')).toBe('10000');
    const detail = await portal.call('GET', `/client/invoices/${res.body.invoice.id}`);
    expect(detail.body.paymentUrl).toBe(res.body.paymentUrl);
  });

  it('writes nothing when the gateway fails', async () => {
    const { portal } = await merchant();
    const gatewayId = await card();
    fake.failWith = 500;
    const res = await portal.call('POST', '/client/invoices', { amount: '100', gatewayId });
    expect(res.status).toBe(502);
    expect(res.body.code).toBe('GATEWAY_ERROR');
    expect(await db.select().from(s.invoices)).toHaveLength(0);
  });

  it('refuses a method the merchant may not use and each amount problem on amount', async () => {
    const { portal, groupId } = await merchant('800');
    const gatewayId = await bank({ feeFixed: '60' });
    const hidden = await insertGateway(t, db, { code: 'vip', audience: 'b2b', allowedGroupIds: [groupId + 1000] });
    const b2c = await insertGateway(t, db, { code: 'shop', audience: 'b2c' });
    for (const id of [hidden, b2c, 99999]) {
      const res = await portal.call('POST', '/client/invoices', { amount: '100', gatewayId: id });
      expect(res.status).toBe(422);
      expect(res.body.errors[0].field).toBe('gatewayId');
    }
    const cases: Array<[string, RegExp]> = [
      ['10', /minimum/],
      ['6000', /maximum/],
      ['900', /limit per deposit/],
      ['55', /fee/],
      ['abc', /amount like/],
      ['-5', /amount like/],
    ];
    for (const [amount, message] of cases) {
      const res = await portal.call('POST', '/client/invoices', { amount, gatewayId });
      expect(res.status, amount).toBe(422);
      expect(res.body.errors[0], amount).toMatchObject({ field: 'amount' });
      expect(res.body.errors[0].message, amount).toMatch(message);
    }
    expect(await db.select().from(s.invoices)).toHaveLength(0);
  });

  it('refuses a request without the CSRF token', async () => {
    const { portal } = await merchant();
    const gatewayId = await bank();
    expect((await portal.withoutCsrf('POST', '/client/invoices', { amount: '100', gatewayId })).status).toBe(403);
  });
});

describe('POST /client/invoices/:id/receipt', () => {
  it('queues a pending payment for staff review and shows it on the invoice', async () => {
    const { portal, id } = await merchant();
    const gatewayId = await bank();
    const invoice = (await portal.call('POST', '/client/invoices', { amount: '100', gatewayId })).body.invoice;
    const fileId = await insertProofFile(db, id);
    const res = await portal.call('POST', `/client/invoices/${invoice.id}/receipt`, {
      fileId,
      reference: ' TRX-5521 ',
    });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      amount: '100.0000',
      feeAmount: '0.0000',
      currency: 'USD',
      status: 'pending',
      methodType: 'bank',
      reference: 'TRX-5521',
      receiptFileId: fileId,
      capturedAt: null,
    });
    const detail = await portal.call('GET', `/client/invoices/${invoice.id}`);
    expect(detail.body.payments).toHaveLength(1);
    expect(detail.body.instructions).toBe('IBAN JO94 0001');
    // Staff see it in the review queue and approve it: the wallet is credited and the invoice paid.
    const admin = await adminWith(t, ['payments:approve', 'payments:read']);
    const queue = await admin.get('/admin/payments?status=pending');
    expect(queue.body[0]).toMatchObject({
      id: res.body.id,
      gatewayTxnId: 'TRX-5521',
      receiptFileId: fileId,
      invoiceId: invoice.id,
    });
    expect((await admin.post(`/admin/payments/${res.body.id}/approve`)).body.client.walletBalance).toBe('100.0000');
    const paid = await portal.call('GET', `/client/invoices/${invoice.id}`);
    expect(paid.body.invoice.status).toBe('paid');
    expect(paid.body.instructions).toBeUndefined();
  });

  it('lets a staff-issued invoice be paid by naming the manual method used', async () => {
    const { portal, id } = await merchant();
    const gatewayId = await bank();
    const invoice = await insertInvoiceRow(db, id, { kind: 'manual', description: 'Support', fee: '0.0000' });
    const fileId = await insertProofFile(db, id);
    const missing = await portal.call('POST', `/client/invoices/${invoice.id}/receipt`, { fileId });
    expect(missing.status).toBe(422);
    expect(missing.body.errors[0].field).toBe('gatewayId');
    const automatic = await portal.call('POST', `/client/invoices/${invoice.id}/receipt`, {
      fileId,
      gatewayId: await card(),
    });
    expect(automatic.body.errors[0].field).toBe('gatewayId');
    const ok = await portal.call('POST', `/client/invoices/${invoice.id}/receipt`, { fileId, gatewayId });
    expect(ok.status).toBe(201);
    expect((await db.select().from(s.invoices).where(eq(s.invoices.id, invoice.id)))[0]!.gatewayId).toBe(gatewayId);
  });

  it('refuses another merchant, an invoice that is not open, an automatic gateway and a receipt already waiting', async () => {
    const { portal, id } = await merchant();
    const other = await merchant();
    const gatewayId = await bank();
    const autoId = await card();
    const fileId = await insertProofFile(db, id);
    const mine = await insertInvoiceRow(db, id, { gatewayId });
    expect((await other.portal.call('POST', `/client/invoices/${mine.id}/receipt`, { fileId })).status).toBe(404);
    expect((await portal.call('POST', '/client/invoices/99999/receipt', { fileId })).status).toBe(404);

    const paid = await insertInvoiceRow(db, id, { gatewayId, status: 'paid' });
    expect((await portal.call('POST', `/client/invoices/${paid.id}/receipt`, { fileId })).body.detail).toBe(
      'This invoice is already paid.',
    );
    const voided = await insertInvoiceRow(db, id, { gatewayId, status: 'void' });
    expect((await portal.call('POST', `/client/invoices/${voided.id}/receipt`, { fileId })).body.detail).toBe(
      'This invoice was cancelled.',
    );
    const online = await insertInvoiceRow(db, id, { gatewayId: autoId });
    const refused = await portal.call('POST', `/client/invoices/${online.id}/receipt`, { fileId });
    expect(refused.status).toBe(409);
    expect(refused.body.detail).toBe('This invoice is paid online: no receipt is needed.');

    expect((await portal.call('POST', `/client/invoices/${mine.id}/receipt`, { fileId })).status).toBe(201);
    const waiting = await portal.call('POST', `/client/invoices/${mine.id}/receipt`, { fileId });
    expect(waiting.status).toBe(409);
    expect(waiting.body.detail).toBe('A receipt for this invoice is waiting for review.');
  });

  it("refuses a file that is unknown, another owner's or of the wrong type, and a reference already used", async () => {
    const { portal, id } = await merchant();
    const other = await merchant();
    const gatewayId = await bank();
    const invoice = await insertInvoiceRow(db, id, { gatewayId });
    const later = await insertInvoiceRow(db, id, { gatewayId });
    for (const fileId of [
      99999,
      await insertProofFile(db, other.id),
      await insertProofFile(db, id, { mime: 'text/html', filename: 'x.html' }),
    ]) {
      const res = await portal.call('POST', `/client/invoices/${invoice.id}/receipt`, { fileId });
      expect(res.status).toBe(422);
      expect(res.body.errors[0].field).toBe('fileId');
    }
    const fileId = await insertProofFile(db, id);
    expect(
      (await portal.call('POST', `/client/invoices/${invoice.id}/receipt`, { fileId, reference: 'R'.repeat(65) })).body
        .errors[0].field,
    ).toBe('reference');
    expect(
      (await portal.call('POST', `/client/invoices/${invoice.id}/receipt`, { fileId, reference: 'SAME' })).status,
    ).toBe(201);
    const taken = await portal.call('POST', `/client/invoices/${later.id}/receipt`, { fileId, reference: 'SAME' });
    expect(taken.status).toBe(422);
    expect(taken.body.errors[0].field).toBe('reference');
  });
});

describe('GET /client/invoices', () => {
  it('lists only the merchant own invoices without receipts, with filters, sorts and the exact total', async () => {
    const { portal, id } = await merchant();
    const other = await merchant();
    const gatewayId = await bank();
    const a = await insertInvoiceRow(db, id, { amount: '100.0000', gatewayId });
    await insertInvoiceRow(db, id, { amount: '300.0000', status: 'paid', paidAt: clock.now(), kind: 'manual' });
    await insertInvoiceRow(db, other.id, { amount: '999.0000' });
    const [customer] = await db
      .insert(s.customers)
      .values({ email: 'c@example.com' })
      .returning({ id: s.customers.id });
    await insertInvoiceRow(db, id, { kind: 'receipt', customerId: customer!.id, amount: '5.0000' });
    const all = await portal.call('GET', '/client/invoices?_sort=total&_order=desc');
    expect(all.status).toBe(200);
    expect(all.total).toBe(2);
    expect(all.body.map((row: { total: string }) => row.total)).toEqual(['300.0000', '100.0000']);
    expect(all.body[1].gateway).toEqual({ id: gatewayId, name: 'Bank transfer' });
    expect((await portal.call('GET', '/client/invoices?status=paid')).total).toBe(1);
    expect((await portal.call('GET', '/client/invoices?kind=manual')).total).toBe(1);
    expect((await portal.call('GET', `/client/invoices?q=${a.number}`)).total).toBe(1);
    expect((await portal.call('GET', '/client/invoices?_sort=dueAt')).status).toBe(200);
    expect((await portal.call('GET', '/client/invoices?_sort=clientId')).status).toBe(422);
  });

  it('never shows another merchant an invoice, a receipt, or the payments of one', async () => {
    const { portal, id } = await merchant();
    const other = await merchant();
    const gatewayId = await bank();
    const theirs = await insertInvoiceRow(db, other.id, { gatewayId });
    await insertPendingPayment(db, theirs, gatewayId);
    expect((await portal.call('GET', `/client/invoices/${theirs.id}`)).status).toBe(404);
    const [customer] = await db
      .insert(s.customers)
      .values({ email: 'c@example.com' })
      .returning({ id: s.customers.id });
    const receipt = await insertInvoiceRow(db, id, { kind: 'receipt', customerId: customer!.id });
    expect((await portal.call('GET', `/client/invoices/${receipt.id}`)).status).toBe(404);
    expect((await portal.call('GET', '/client/invoices/99999')).status).toBe(404);
  });
});

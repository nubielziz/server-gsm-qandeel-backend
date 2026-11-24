// Integration tests of what backs a manual top-up, on the merchant portal and on the storefront balance: the receipt is a file its owner
// uploaded through the upload routes, never a document the shop stored for that owner (an invoice PDF, a tax receipt); a bank reference
// of a manual method is compared and stored in one form (upper case, no white space, dashes or invisible (control, format and
// default-ignorable) characters, full-width forms folded, digits of any script read as ASCII digits), a reference that still holds a
// character other than printable ASCII is refused,
// a pending or approved payment keeps it, and a rejected one releases it, so the payer who made the transfer can still name it.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { eq } from 'drizzle-orm';
import { type Database, pgErrorInfo, schema as s } from '@src/infra/db';
import { FileUploadService, MAX_UPLOAD_BYTES, StoredFiles } from '@src/modules/platform';
import { adminWith } from '../../support/admin-api';
import { type TestApp, createTestApp } from '../../support/app';
import { clearIdentityCaches } from '../../support/auth';
import { GatewayTestModule, insertGateway, insertInvoiceRow, insertPendingPayment } from '../../support/billing';
import { TestClock } from '../../support/clock';
import { insertWalletTemplates, walletSettings } from '../../support/customer-wallet';
import { closeTestDb, resetDb, testDb } from '../../support/db';
import { insertUsd } from '../../support/fixtures';
import { PORTAL_ORIGIN } from '../../support/merchant-portal';
import { insertWalletMerchant } from '../../support/money';
import { STORE_ORIGIN, StoreClient, clearStoreRateLimits, makeCustomer } from '../../support/store';
import { portalFor } from '../../support/portal-orders';

const clock = new TestClock('2026-11-10T09:00:00.000Z');
let t: TestApp;
let db: Database;

beforeAll(async () => {
  ({ db } = await testDb());
  t = await createTestApp({
    clock,
    imports: [GatewayTestModule],
    env: { SHOP_ORIGINS: `${STORE_ORIGIN},${PORTAL_ORIGIN}` },
  });
});
beforeEach(async () => {
  clock.set('2026-11-10T09:00:00.000Z');
  await resetDb();
  await clearIdentityCaches(t);
  await clearStoreRateLimits(t);
  await insertUsd(db);
  await walletSettings(t, db);
  await insertWalletTemplates(db);
});
afterAll(async () => {
  await resetDb();
  await clearIdentityCaches(t);
  await t.close();
  await closeTestDb();
});

/** A manual method open to merchants and storefront customers alike. */
const bank = () =>
  insertGateway(t, db, {
    code: 'bank',
    driver: 'manual',
    name: 'Bank transfer',
    isManual: true,
    audience: 'both',
    minAmount: '5',
    maxAmount: '5000',
  });

async function merchant(name: string) {
  const made = await insertWalletMerchant(db, { name });
  await db.update(s.clients).set({ country: 'JO' }).where(eq(s.clients.id, made.id));
  return { ...made, portal: await portalFor(t, made.id) };
}

async function shopper() {
  const customer = await makeCustomer(t, { name: 'Daniel Rivera' });
  const store = new StoreClient(t);
  expect((await store.login(customer.email)).statusCode).toBe(200);
  return { customer, store };
}

/** The bytes of a PDF of its own: every receipt of these tests is another transfer. */
const pdfBytes = () => Buffer.from(`%PDF-1.4\n% transfer ${crypto.randomUUID()}\n%%EOF\n`);

/** A receipt the merchant uploaded through the upload service (`POST /client/files`). */
const uploadedByMerchant = async (clientId: number) =>
  (
    await t.app
      .get(FileUploadService)
      .upload(clientId, { filename: 'transfer.pdf', mime: 'application/pdf', data: pdfBytes() })
  ).id;

/** A receipt the customer uploaded through the upload service (`POST /store/v1/files`). */
const uploadedByCustomer = async (customerId: number) =>
  (
    await t.app
      .get(FileUploadService)
      .uploadForCustomer(
        customerId,
        { filename: 'transfer.pdf', mime: 'application/pdf', data: pdfBytes() },
        MAX_UPLOAD_BYTES,
      )
  ).id;

const createTopUp = (store: StoreClient, gatewayId: number) =>
  store.call(
    'POST',
    '/store/v1/me/wallet/top-ups',
    { amount: '50', gatewayId },
    { headers: { 'idempotency-key': crypto.randomUUID() } },
  );

const customerReceipt = (store: StoreClient, id: number, body: unknown) =>
  store.call('POST', `/store/v1/me/wallet/top-ups/${id}/receipt`, body, {
    headers: { 'idempotency-key': crypto.randomUUID() },
  });

/** The PDF of an invoice once the render after the commit has stored it (a new one when `previous` is given). */
async function pdfOf(invoiceId: number, previous: number | null): Promise<number> {
  for (let i = 0; i < 50; i++) {
    const [row] = await db.select().from(s.invoices).where(eq(s.invoices.id, invoiceId));
    if (row!.pdfFileId !== null && row!.pdfFileId !== previous) return row!.pdfFileId;
    await Bun.sleep(100);
  }
  throw new Error(`invoice ${invoiceId} has no new PDF`);
}

const referencesOnFile = async () =>
  (await db.select({ ref: s.payments.gatewayTxnId, status: s.payments.status }).from(s.payments))
    .map((row) => `${row.ref}:${row.status}`)
    .sort();

describe('the receipt of a manual top-up', () => {
  it("refuses the PDFs the shop stored for a merchant's invoice, and takes a file the merchant uploaded", async () => {
    const { portal, id } = await merchant('Zain Mobile Hub');
    const gatewayId = await bank();
    const admin = await adminWith(t, ['payments:approve', 'payments:read']);
    const first = (await portal.call('POST', '/client/invoices', { amount: '100', gatewayId })).body.invoice;
    const openPdf = await pdfOf(first.id, null);
    const paid = await portal.call('POST', `/client/invoices/${first.id}/receipt`, {
      fileId: await uploadedByMerchant(id),
    });
    expect(paid.status).toBe(201);
    expect((await admin.post(`/admin/payments/${paid.body.id}/approve`)).status).toBe(200);
    const paidPdf = await pdfOf(first.id, openPdf);
    const [stored] = await db.select().from(s.files).where(eq(s.files.id, paidPdf));
    expect(stored).toMatchObject({ ownerType: 'client', ownerId: id, mime: 'application/pdf' });

    const second = (await portal.call('POST', '/client/invoices', { amount: '100', gatewayId })).body.invoice;
    for (const fileId of [paidPdf, openPdf]) {
      const res = await portal.call('POST', `/client/invoices/${second.id}/receipt`, { fileId, reference: 'TRX-9001' });
      expect(res.status, `file ${fileId}`).toBe(422);
      expect(res.body.errors[0]).toMatchObject({ field: 'fileId', code: 'invalid' });
    }
    expect(await db.select().from(s.payments).where(eq(s.payments.invoiceId, second.id))).toHaveLength(0);
    const own = await portal.call('POST', `/client/invoices/${second.id}/receipt`, {
      fileId: await uploadedByMerchant(id),
    });
    expect(own.status).toBe(201);
    expect(own.body).toMatchObject({ status: 'pending', amount: '100.0000' });
  });

  it('refuses a tax receipt the shop stored for a customer, and takes a file the customer uploaded', async () => {
    const gatewayId = await bank();
    const { customer, store } = await shopper();
    const topUp = (await createTopUp(store, gatewayId)).json();
    // The storefront stores the tax receipt of a paid order as the customer's file, under its own area (OrderReceipts).
    const taxReceipt = await t.app.get(StoredFiles).store(db, {
      ownerType: 'customer',
      ownerId: customer.id,
      filename: 'INV-2026-0042.pdf',
      mime: 'application/pdf',
      bytes: pdfBytes(),
      area: 'receipts',
    });
    const refused = await customerReceipt(store, topUp.id, { fileId: taxReceipt.id });
    expect(refused.statusCode).toBe(422);
    expect(refused.json().errors[0]).toMatchObject({ field: 'fileId', code: 'invalid' });
    expect(await db.select().from(s.payments)).toHaveLength(0);
    const own = await customerReceipt(store, topUp.id, { fileId: await uploadedByCustomer(customer.id) });
    expect(own.statusCode).toBe(201);
    expect(own.json()).toMatchObject({ status: 'in_review', receiptUploaded: true });
  });
});

describe('the bank reference of a manual method', () => {
  it('stores the reference in one form and refuses every way of writing a live one, from another merchant or a customer', async () => {
    const gatewayId = await bank();
    const first = await merchant('First Mobile');
    const second = await merchant('Second Mobile');
    const claim = await first.portal.call(
      'POST',
      `/client/invoices/${(await insertInvoiceRow(db, first.id, { gatewayId })).id}/receipt`,
      {
        fileId: await uploadedByMerchant(first.id),
        reference: ' ft-2611 0177 88 ',
      },
    );
    expect(claim.status).toBe(201);
    expect(claim.body.reference).toBe('FT2611017788');

    const invoice = await insertInvoiceRow(db, second.id, { gatewayId });
    const fileId = await uploadedByMerchant(second.id);
    for (const reference of [
      'FT2611017788',
      'ft2611017788',
      'FT-2611-0177-88',
      'Ft 2611017788',
      'FT\u20132611017788',
      'FT2611\u0001017788',
      'FT2611\u0085017788',
      'FT2611\u200b017788',
      'FT\u00ad2611017788',
      'FT2611\u034f017788',
      'FT2611\u3164017788',
      'FT\u0662\u0666\u0661\u0661\u0660\u0661\u0667\u0667\u0668\u0668',
      '\uff26\uff34\uff12\uff16\uff11\uff11\uff10\uff11\uff17\uff17\uff18\uff18',
    ]) {
      const res = await second.portal.call('POST', `/client/invoices/${invoice.id}/receipt`, { fileId, reference });
      expect(res.status, reference).toBe(422);
      expect(res.body.errors[0]).toMatchObject({ field: 'reference', code: 'taken' });
    }
    const { customer, store } = await shopper();
    const topUp = (await createTopUp(store, gatewayId)).json();
    const fromCustomer = await customerReceipt(store, topUp.id, {
      fileId: await uploadedByCustomer(customer.id),
      reference: 'ft 2611-017788',
    });
    expect(fromCustomer.statusCode).toBe(422);
    expect(fromCustomer.json().errors[0]).toMatchObject({ field: 'reference', code: 'taken' });
    expect(await referencesOnFile()).toEqual(['FT2611017788:pending']);
  });

  it('refuses a reference with a character other than printable ASCII on both receipt routes, and stores nothing', async () => {
    const gatewayId = await bank();
    const { portal, id } = await merchant('Zain Mobile Hub');
    const invoice = await insertInvoiceRow(db, id, { gatewayId });
    const fileId = await uploadedByMerchant(id);
    for (const reference of ['F\u04222611017788', '\u03a4F2611017788', 'FT2611\u0301017788', 'FT2611\ue000017788']) {
      const res = await portal.call('POST', `/client/invoices/${invoice.id}/receipt`, { fileId, reference });
      expect(res.status, reference).toBe(422);
      expect(res.body.errors[0]).toMatchObject({
        field: 'reference',
        code: 'invalid',
        message: 'Type the reference as the bank printed it, in Latin letters and digits.',
      });
    }
    const { customer, store } = await shopper();
    const topUp = (await createTopUp(store, gatewayId)).json();
    const customerFileId = await uploadedByCustomer(customer.id);
    for (const reference of ['F\u04222611017788', 'FT2611\u0301017788']) {
      const fromCustomer = await customerReceipt(store, topUp.id, { fileId: customerFileId, reference });
      expect(fromCustomer.statusCode, reference).toBe(422);
      expect(fromCustomer.json().errors[0]).toMatchObject({ field: 'reference', code: 'invalid' });
    }
    expect(await db.select().from(s.payments)).toHaveLength(0);
  });

  it('lets staff find a payment by its reference as it was typed', async () => {
    const gatewayId = await bank();
    const { portal, id } = await merchant('Zain Mobile Hub');
    const claim = await portal.call(
      'POST',
      `/client/invoices/${(await insertInvoiceRow(db, id, { gatewayId })).id}/receipt`,
      { fileId: await uploadedByMerchant(id), reference: 'ft-2611 0177 88' },
    );
    expect(claim.status).toBe(201);
    const staff = await adminWith(t, ['payments:read']);
    for (const q of ['FT-2611-0177-88', 'ft2611', '2611 0177']) {
      const found = await staff.get(`/admin/payments?q=${encodeURIComponent(q)}`);
      expect(found.status, q).toBe(200);
      expect(
        found.body.map((row: { id: number }) => row.id),
        q,
      ).toEqual([claim.body.id]);
    }
  });

  it('frees the reference of a rejected claim for the payer, and keeps the one of an approved payment', async () => {
    const gatewayId = await bank();
    const admin = await adminWith(t, ['payments:approve', 'payments:read']);
    const first = await merchant('First Mobile');
    const payer = await merchant('Second Mobile');
    const claim = await first.portal.call(
      'POST',
      `/client/invoices/${(await insertInvoiceRow(db, first.id, { gatewayId })).id}/receipt`,
      {
        fileId: await uploadedByMerchant(first.id),
        reference: 'FT2611017788',
      },
    );
    expect(claim.status).toBe(201);

    const invoice = await insertInvoiceRow(db, payer.id, { gatewayId });
    const fileId = await uploadedByMerchant(payer.id);
    const send = () =>
      payer.portal.call('POST', `/client/invoices/${invoice.id}/receipt`, { fileId, reference: 'ft-2611017788' });
    const waiting = await send();
    expect(waiting.status).toBe(422);
    expect(waiting.body.errors[0]).toMatchObject({ field: 'reference', code: 'taken' });

    expect((await admin.post(`/admin/payments/${claim.body.id}/reject`, { reason: 'Not received.' })).status).toBe(200);
    const accepted = await send();
    expect(accepted.status).toBe(201);
    expect(accepted.body).toMatchObject({ status: 'pending', reference: 'FT2611017788' });
    expect((await admin.post(`/admin/payments/${accepted.body.id}/approve`)).status).toBe(200);

    // An approved payment keeps its reference, for merchants and customers alike.
    const again = await first.portal.call(
      'POST',
      `/client/invoices/${(await insertInvoiceRow(db, first.id, { gatewayId })).id}/receipt`,
      {
        fileId: await uploadedByMerchant(first.id),
        reference: 'FT2611017788',
      },
    );
    expect(again.status).toBe(422);
    expect(again.body.errors[0]).toMatchObject({ field: 'reference', code: 'taken' });
    const { customer, store } = await shopper();
    const topUp = (await createTopUp(store, gatewayId)).json();
    const fromCustomer = await customerReceipt(store, topUp.id, {
      fileId: await uploadedByCustomer(customer.id),
      reference: 'FT2611017788',
    });
    expect(fromCustomer.statusCode).toBe(422);
    expect(await referencesOnFile()).toEqual(['FT2611017788:approved', 'FT2611017788:rejected']);
  });

  it('frees the reference of a rejected storefront claim too', async () => {
    const gatewayId = await bank();
    const admin = await adminWith(t, ['payments:approve', 'payments:read']);
    const { customer, store } = await shopper();
    const topUp = (await createTopUp(store, gatewayId)).json();
    expect(
      (
        await customerReceipt(store, topUp.id, {
          fileId: await uploadedByCustomer(customer.id),
          reference: 'CLIQ-7781',
        })
      ).statusCode,
    ).toBe(201);
    const [claim] = await db.select().from(s.payments);
    const payer = await merchant('Zain Mobile Hub');
    const invoice = await insertInvoiceRow(db, payer.id, { gatewayId });
    const fileId = await uploadedByMerchant(payer.id);
    const send = () =>
      payer.portal.call('POST', `/client/invoices/${invoice.id}/receipt`, { fileId, reference: 'cliq7781' });
    expect((await send()).status).toBe(422);
    expect((await admin.post(`/admin/payments/${claim!.id}/reject`, { reason: 'Not received.' })).status).toBe(200);
    expect((await send()).status).toBe(201);
    expect(await referencesOnFile()).toEqual(['CLIQ7781:pending', 'CLIQ7781:rejected']);
  });

  it('compares a reference stored as it was typed in the same form', async () => {
    const gatewayId = await bank();
    const first = await merchant('First Mobile');
    const second = await merchant('Second Mobile');
    await insertPendingPayment(db, await insertInvoiceRow(db, first.id, { gatewayId }), gatewayId, {
      gatewayTxnId: 'cliq-77 12',
      receiptFileId: await uploadedByMerchant(first.id),
    });
    const res = await second.portal.call(
      'POST',
      `/client/invoices/${(await insertInvoiceRow(db, second.id, { gatewayId })).id}/receipt`,
      {
        fileId: await uploadedByMerchant(second.id),
        reference: 'CLIQ7712',
      },
    );
    expect(res.status).toBe(422);
    expect(res.body.errors[0]).toMatchObject({ field: 'reference', code: 'taken' });
  });

  it('lets one of two receipts that name one reference at the same moment through', async () => {
    const gatewayId = await bank();
    for (let round = 0; round < 4; round += 1) {
      const first = await merchant(`First Mobile ${round}`);
      const second = await merchant(`Second Mobile ${round}`);
      const [a, b] = [
        await insertInvoiceRow(db, first.id, { gatewayId }),
        await insertInvoiceRow(db, second.id, { gatewayId }),
      ];
      const [fa, fb] = [await uploadedByMerchant(first.id), await uploadedByMerchant(second.id)];
      const [ra, rb] = await Promise.all([
        first.portal.call('POST', `/client/invoices/${a.id}/receipt`, { fileId: fa, reference: `TRX-${round}-5521` }),
        second.portal.call('POST', `/client/invoices/${b.id}/receipt`, { fileId: fb, reference: `trx ${round} 5521` }),
      ]);
      expect([ra.status, rb.status].sort()).toEqual([201, 422]);
      const refused = ra.status === 422 ? ra.body : rb.body;
      expect(refused.errors[0]).toMatchObject({ field: 'reference', code: 'taken' });
    }
  });

  it('keeps one payment per gateway reference without a receipt whatever its status, and one live receipt payment per reference', async () => {
    const gatewayId = await bank();
    const { id } = await merchant('Zain Mobile Hub');
    const invoice = () => insertInvoiceRow(db, id, { gatewayId });
    const insert = async (overrides: Partial<typeof s.payments.$inferInsert>) =>
      insertPendingPayment(db, await invoice(), gatewayId, overrides).then(
        () => 'inserted',
        (error: unknown) => pgErrorInfo(error)?.constraint,
      );
    // A gateway's own reference (no receipt) names one payment for good: a repeated confirmation creates nothing.
    expect(await insert({ gatewayTxnId: 'pi_1', status: 'rejected', methodType: 'card' })).toBe('inserted');
    expect(await insert({ gatewayTxnId: 'pi_1', methodType: 'card' })).toBe('payments_gateway_txn_uq');
    // A bank reference on a receipt: a rejected claim leaves it free, a live one holds it.
    expect(await insert({ gatewayTxnId: 'FT1', status: 'rejected', receiptFileId: await uploadedByMerchant(id) })).toBe(
      'inserted',
    );
    expect(await insert({ gatewayTxnId: 'FT1', receiptFileId: await uploadedByMerchant(id) })).toBe('inserted');
    expect(await insert({ gatewayTxnId: 'FT1', status: 'approved', receiptFileId: await uploadedByMerchant(id) })).toBe(
      'payments_gateway_txn_uq',
    );
  });
});

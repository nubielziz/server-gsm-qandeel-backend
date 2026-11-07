// Integration tests of the staff routes on invoices (map stage 8): the list with its filters, search and sorts, one invoice, and
// issuing a manual invoice (the number, the tax and due-date rules of user rule 3, the audit row and the PDF copy).
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { eq } from 'drizzle-orm';
import { schema as s } from '../../src/infra/db';
import { StorageService } from '../../src/infra/storage';
import { adminWith } from '../support/admin-api';
import { type TestApp, createTestApp } from '../support/app';
import { clearIdentityCaches } from '../support/auth';
import { insertInvoiceRow } from '../support/billing';
import { DAY, TestClock } from '../support/clock';
import { closeTestDb, resetDb, testDb } from '../support/db';
import { insertWalletMerchant } from '../support/money';

const clock = new TestClock('2026-11-01T10:00:00.000Z');
let t: TestApp;

beforeAll(async () => {
  t = await createTestApp({ clock });
});
afterAll(async () => {
  await resetDb();
  await t.close();
  await closeTestDb();
});
beforeEach(async () => {
  clock.set('2026-11-01T10:00:00.000Z');
  await resetDb();
  await clearIdentityCaches(t);
});

describe('POST /admin/invoices', () => {
  it('issues a manual invoice: number, no fee, tax from the setting, due in 14 days, audited, with a PDF copy', async () => {
    const { db } = await testDb();
    const merchant = await insertWalletMerchant(db, { name: 'Zain Mobile Hub' });
    await db.update(s.clients).set({ country: 'JO' }).where(eq(s.clients.id, merchant.id));
    const admin = await adminWith(t, ['invoices:create', 'invoices:read']);
    const res = await admin.post('/admin/invoices', {
      clientId: merchant.id,
      amount: '250',
      description: 'Priority support',
    });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      kind: 'manual',
      status: 'open',
      amount: '250.0000',
      fee: '0.0000',
      netAmount: '250.0000',
      taxAmount: '0.0000',
      taxRate: '0.0000',
      taxCountry: 'JO',
      customerVatId: '',
      total: '250.0000',
      currency: 'USD',
      client: { id: merchant.id, name: 'Zain Mobile Hub' },
      customer: null,
      orderId: null,
      description: 'Priority support',
      dueAt: new Date(clock.nowMs() + 14 * DAY).toISOString(),
      paidAt: null,
      createdAt: '2026-11-01T10:00:00.000Z',
    });
    expect(res.body.number).toBe(`INV-2026-${String(res.body.id).padStart(4, '0')}`);
    // No ledger entry at issue.
    expect(await db.select().from(s.ledgerTransactions)).toHaveLength(0);
    const [audit] = await db.select().from(s.auditLogs);
    expect(audit).toMatchObject({ action: 'issued invoice for', entityType: 'invoice', entityId: res.body.id });
    expect(audit!.entityLabel).toBe(`Zain Mobile Hub (${res.body.number})`);

    // The PDF copy is rendered after the commit and stored as the merchant's file.
    const read = await admin.get(`/admin/invoices/${res.body.id}`);
    expect(read.body.pdfFileId).toEqual(expect.any(Number));
    const [file] = await db.select().from(s.files).where(eq(s.files.id, read.body.pdfFileId));
    expect(file).toMatchObject({
      mime: 'application/pdf',
      ownerType: 'client',
      ownerId: merchant.id,
      filename: `${res.body.number}.pdf`,
    });
    const object = await t.app.get(StorageService).get(file!.key);
    const chunks: Buffer[] = [];
    for await (const chunk of object!.body) chunks.push(Buffer.from(chunk as Uint8Array));
    expect(Buffer.concat(chunks).subarray(0, 5).toString()).toBe('%PDF-');
  });

  it('adds the B2B VAT rate of the setting to the total and reads a bad setting as no tax', async () => {
    const { db } = await testDb();
    const merchant = await insertWalletMerchant(db);
    await db.update(s.clients).set({ country: 'JO' }).where(eq(s.clients.id, merchant.id));
    await db.insert(s.settings).values({ key: 'billing.b2b_vat_rate_percent', value: 16 });
    const admin = await adminWith(t, ['invoices:create']);
    const taxed = await admin.post('/admin/invoices', { clientId: merchant.id, amount: '100', description: 'Work' });
    expect(taxed.body).toMatchObject({
      taxRate: '16.0000',
      taxAmount: '16.0000',
      netAmount: '100.0000',
      total: '116.0000',
    });
    await db.update(s.settings).set({ value: 'lots' }).where(eq(s.settings.key, 'billing.b2b_vat_rate_percent'));
    await clearIdentityCaches(t);
    const free = await admin.post('/admin/invoices', { clientId: merchant.id, amount: '100', description: 'Work' });
    expect(free.body).toMatchObject({ taxAmount: '0.0000', total: '100.0000' });
  });

  it('refuses with the field: an unknown merchant, no billing country, a bad amount, an empty description', async () => {
    const { db } = await testDb();
    const noCountry = await insertWalletMerchant(db);
    const admin = await adminWith(t, ['invoices:create']);
    const unknown = await admin.post('/admin/invoices', { clientId: 99999, amount: '10', description: 'x' });
    expect(unknown.status).toBe(422);
    expect(unknown.body.errors[0].field).toBe('clientId');
    const country = await admin.post('/admin/invoices', { clientId: noCountry.id, amount: '10', description: 'x' });
    expect(country.body.errors[0]).toMatchObject({
      field: 'clientId',
      message: 'This merchant has no billing country.',
    });
    const bad = await admin.post('/admin/invoices', { clientId: noCountry.id, amount: '0', description: ' ' });
    expect(bad.body.errors.map((error: { field: string }) => error.field).sort()).toEqual([
      'amount',
      'clientId',
      'description',
    ]);
    expect(await db.select().from(s.invoices)).toHaveLength(0);
  });

  it('refuses a caller who may only read invoices', async () => {
    const reader = await adminWith(t, ['invoices:read']);
    expect((await reader.post('/admin/invoices', { clientId: 1, amount: '1', description: 'x' })).status).toBe(403);
  });
});

describe('GET /admin/invoices', () => {
  it('lists invoices with filters, search by number and name, sorts, ranges and the exact total', async () => {
    const { db } = await testDb();
    const zain = await insertWalletMerchant(db, { name: 'Zain Mobile Hub' });
    const gulf = await insertWalletMerchant(db, { name: 'Gulf Digital' });
    const [customer] = await db
      .insert(s.customers)
      .values({ email: 'dana@example.com', name: 'Dana Customer' })
      .returning({ id: s.customers.id });
    const open = await insertInvoiceRow(db, zain.id, { amount: '100.0000', description: 'Annual fee', kind: 'manual' });
    await insertInvoiceRow(db, zain.id, { amount: '300.0000', status: 'paid', paidAt: clock.now() });
    await insertInvoiceRow(db, gulf.id, { amount: '200.0000', status: 'void' });
    await insertInvoiceRow(db, zain.id, {
      kind: 'receipt',
      clientId: null,
      customerId: customer!.id,
      amount: '20.0000',
      status: 'paid',
    });
    const admin = await adminWith(t, ['invoices:read']);

    const all = await admin.get('/admin/invoices?_start=0&_end=2&_sort=total&_order=desc');
    expect(all.status).toBe(200);
    expect(all.total).toBe(4);
    expect(all.body.map((row: { total: string }) => row.total)).toEqual(['300.0000', '200.0000']);
    expect((await admin.get('/admin/invoices?status=open')).body[0]).toMatchObject({
      id: open.id,
      description: 'Annual fee',
    });
    expect((await admin.get('/admin/invoices?status=paid&status=void')).total).toBe(3);
    expect((await admin.get('/admin/invoices?kind=manual')).total).toBe(1);
    expect((await admin.get(`/admin/invoices?clientId=${gulf.id}`)).total).toBe(1);
    expect((await admin.get('/admin/invoices?q=gulf')).total).toBe(1);
    expect((await admin.get(`/admin/invoices?q=${open.number}`)).body[0].id).toBe(open.id);
    const byCustomer = await admin.get('/admin/invoices?q=dana');
    expect(byCustomer.body[0]).toMatchObject({
      kind: 'receipt',
      client: null,
      customer: { id: customer!.id, name: 'Dana Customer', email: 'dana@example.com' },
    });
    expect((await admin.get('/admin/invoices?_sort=status')).status).toBe(200);
    expect((await admin.get('/admin/invoices?status=bogus')).status).toBe(422);
    expect((await admin.get('/admin/invoices?_sort=number')).status).toBe(422);
  });

  it('reads one invoice, answers 404 for an unknown id and 403 without invoices:read', async () => {
    const { db } = await testDb();
    const merchant = await insertWalletMerchant(db, { name: 'Zain' });
    const invoice = await insertInvoiceRow(db, merchant.id, { description: '' });
    const admin = await adminWith(t, ['invoices:read']);
    const res = await admin.get(`/admin/invoices/${invoice.id}`);
    expect(res.body).toMatchObject({ id: invoice.id, description: null, client: { name: 'Zain' } });
    expect((await admin.get('/admin/invoices/99999')).status).toBe(404);
    const other = await adminWith(t, ['payments:read']);
    expect((await other.get(`/admin/invoices/${invoice.id}`)).status).toBe(403);
  });
});

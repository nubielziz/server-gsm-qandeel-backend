// The storefront money seed (feature 16): the demo's storefront orders, payments, receipts, refunds and disputes appear through the real API with the
// ids, amounts and states of the frontend mock (src/features/refunds/mocks/seed.ts), tied to the journals the money seed replayed; a second run
// changes nothing.
import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from 'bun:test';
import { existsSync } from 'node:fs';
import { eq, sql } from 'drizzle-orm';
import { seedB2c } from '../../scripts/seed/b2c';
import { loadDemoState, demoStatePath } from '../../scripts/seed/demo-state';
import { SEEDERS, runSeed } from '../../scripts/seed/run';
import { schema as s } from '../../src/infra/db';
import { type AdminApi, adminWith } from '../support/admin-api';
import { type TestApp, createTestApp } from '../support/app';
import { clearIdentityCaches } from '../support/auth';
import { closeTestDb, resetDb, testDb } from '../support/db';
import { ledgerTotals } from '../support/money';
import { freshClientIp } from '../support/pipeline-routes';

setDefaultTimeout(180_000);

const frontendPresent = existsSync(demoStatePath());
let t: TestApp;
let staff: AdminApi;

beforeAll(async () => {
  if (!frontendPresent) return;
  t = await createTestApp();
  await resetDb();
  await clearIdentityCaches(t);
  const { db } = await testDb();
  await runSeed(db, await loadDemoState(), t.config);
  staff = await adminWith(t, ['refunds:*', 'disputes:*', 'reports:finance', 'orders:read']);
});
afterAll(async () => {
  if (!frontendPresent) return;
  await resetDb();
  await clearIdentityCaches(t);
  await t.close();
  await closeTestDb();
});

describe.skipIf(!frontendPresent)('the storefront money seed', () => {
  it('writes the 104 storefront orders with a paid session, a captured payment and a receipt each, under the demo ids', async () => {
    const { db } = await testDb();
    const orders = (await db.select().from(s.orders)).filter((order) => order.customerId !== null);
    expect(orders).toHaveLength(104);
    expect(
      orders.every((order) => order.clientId === null && order.source === 'store' && order.publicToken?.length === 22),
    ).toBe(true);
    expect(Math.min(...orders.map((order) => order.id))).toBe(20400);
    expect(Math.max(...orders.map((order) => order.id))).toBe(20503);
    const payments = (await db.select().from(s.payments)).filter((payment) => payment.purpose === 'order');
    expect(payments).toHaveLength(104);
    // A payment takes the id of its order, like the mock.
    expect(payments.every((payment) => payment.id === payment.orderId)).toBe(true);
    // The growth seed's left checkouts (ids from 3000, feature 19) have no order; this seeder's sessions are the ones with an order.
    const sessions = (await db.select().from(s.checkoutSessions)).filter((session) => session.orderId !== null);
    expect(sessions).toHaveLength(104);
    expect(
      sessions.every(
        (session) => session.status === 'paid' && session.orderId === session.id && session.imeiEnc !== null,
      ),
    ).toBe(true);
    const receipts = (await db.select().from(s.invoices)).filter((invoice) => invoice.kind === 'receipt');
    expect(receipts).toHaveLength(104);
    // The customers are 14b's: the customers seeder wrote all 30 before this one ran, and this one added none (the growth seed's
    // guests start at id 900 000).
    expect((await db.select().from(s.customers)).filter((customer) => customer.id < 900_000)).toHaveLength(30);
    expect(await db.select().from(s.refunds)).toHaveLength(11);
    expect(await db.select().from(s.disputes)).toHaveLength(5);

    const first = orders.find((order) => order.id === 20400)!;
    expect(first).toMatchObject({
      status: 'completed',
      totalPrice: '12.9900',
      taxAmount: '2.6000',
      taxCountry: 'GB',
      currency: 'USD',
    });
    expect(payments.find((payment) => payment.id === 20400)).toMatchObject({
      status: 'chargeback',
      methodType: 'card',
      brand: 'Visa •••• 4417',
      currency: 'GBP',
      // USD 15.59 at 0.79.
      amount: '12.3200',
      gatewayTxnId: 'pi_3Q607xK4205',
      threeDs: false,
    });
    expect(payments.find((payment) => payment.methodType === 'crypto')).toMatchObject({
      gatewayId: 2,
      brand: 'USDT TRC-20',
    });
    // The held ones wait in the review queue, and the books still sum to zero (the seed posted nothing).
    expect(orders.filter((order) => order.dispatchState === 'held')).toHaveLength(4);
    expect((await ledgerTotals(db)).sum).toBe('0.0000');
  });

  it('shows the refunds of the demo through the API, by their demo ids, with the journals of the books', async () => {
    const list = await staff.get('/admin/refunds?_end=50&_sort=id&_order=asc');
    expect(list.status).toBe(200);
    expect(list.total).toBe(11);
    expect(list.body.map((refund: { id: number }) => refund.id)).toEqual([
      1001, 1002, 1003, 1004, 1005, 1006, 1007, 1008, 1009, 1010, 1011,
    ]);
    const byStatus = (status: string) =>
      list.body.filter((refund: { status: string }) => refund.status === status).length;
    expect([byStatus('requested'), byStatus('completed'), byStatus('failed')]).toEqual([3, 7, 1]);
    const request = list.body.find((refund: { id: number }) => refund.id === 1007);
    expect(request).toMatchObject({
      orderId: 20467,
      status: 'requested',
      method: 'original',
      currency: 'CAD',
      reason: 'Unlock did not work: phone still asks for a code',
      requestedBy: { type: 'customer', name: null },
      approvedBy: null,
      netAmount: null,
      taxAmount: null,
      partial: false,
    });
    const partial = list.body.find((refund: { id: number }) => refund.id === 1010);
    expect(partial).toMatchObject({
      status: 'completed',
      partial: true,
      gatewayRefundId: 're_05474685',
      amount: '7.2000',
    });
    expect(partial.netAmount).not.toBeNull();
    const failed = list.body.find((refund: { id: number }) => refund.id === 1011);
    expect(failed).toMatchObject({ status: 'failed', note: expect.stringContaining('card issuer declined') });
    const system = list.body.find((refund: { id: number }) => refund.id === 1001);
    expect(system).toMatchObject({ requestedBy: { type: 'system', name: 'System' }, status: 'completed' });
    expect((await staff.get('/admin/refunds?status=requested')).total).toBe(3);
  });

  it('shows the disputes of the demo with their deadlines, and the single read builds the evidence pack', async () => {
    const list = await staff.get('/admin/disputes');
    expect(list.total).toBe(5);
    const byId = (id: number) => list.body.find((dispute: { id: number }) => dispute.id === id);
    expect(byId(2001)).toMatchObject({
      status: 'lost',
      orderId: 20400,
      reasonCode: 'fraudulent',
      currency: 'GBP',
      amount: '15.5900',
    });
    expect(byId(2002)).toMatchObject({ status: 'won' });
    expect(byId(2003)).toMatchObject({ status: 'under_review' });
    expect(byId(2005)).toMatchObject({ status: 'needs_response', reasonCode: 'product_not_received' });
    // The ones that wait for an answer come first, soonest deadline first.
    expect(list.body.slice(0, 2).map((dispute: { status: string }) => dispute.status)).toEqual([
      'needs_response',
      'needs_response',
    ]);
    const one = await staff.get('/admin/disputes/2005');
    expect(one.body.evidence).toHaveLength(6);
    expect(one.body.evidence.find((line: { key: string }) => line.key === 'consents').ok).toBe(true);
    expect(['strong', 'fair', 'weak']).toContain(one.body.strength);
    const { db } = await testDb();
    // Only the lost dispute carries a chargeback journal.
    const lost = (await db.select().from(s.disputes).where(eq(s.disputes.status, 'lost')))[0]!;
    expect(lost.ledgerTxId).not.toBeNull();
    expect(
      (
        await db
          .select()
          .from(s.disputes)
          .where(sql`${s.disputes.ledgerTxId} is not null`)
      ).length,
    ).toBe(1);
  });

  it('feeds the reports from the seeded books', async () => {
    const payments = await staff.get('/admin/reports/payments');
    expect(payments.status).toBe(200);
    expect(payments.body.methods.map((row: { method: string }) => row.method)).toEqual(['card', 'wallet', 'crypto']);
    expect(payments.body.total).toBe(104 - 0);
    const volume = payments.body.methods.reduce((sum: number, row: { volume: string }) => sum + Number(row.volume), 0);
    expect(volume).toBeGreaterThan(1000);
    expect(payments.body.totals.chargebackLoss).not.toBe('0.0000');
    const vat = await staff.get('/admin/reports/vat?from=2025-01-01&to=2030-12-31');
    expect(vat.status).toBe(200);
    expect(vat.body.rows.length).toBeGreaterThan(0);
    expect(vat.body.rows.every((row: { country: string }) => row.country !== '')).toBe(true);
  });

  it('lets a buyer track a seeded order and read its receipt', async () => {
    const { db } = await testDb();
    const [order] = await db.select().from(s.orders).where(eq(s.orders.id, 20401));
    const tracking = await t.app.inject({
      method: 'GET',
      url: `/store/v1/orders/${order!.publicToken}`,
      remoteAddress: freshClientIp(),
    });
    expect(tracking.statusCode).toBe(200);
    expect(tracking.json()).toMatchObject({ status: 'completed' });
    const receipt = await t.app.inject({
      method: 'GET',
      url: `/store/v1/orders/${order!.publicToken}/receipt`,
      remoteAddress: freshClientIp(),
    });
    expect(receipt.statusCode).toBe(200);
    expect(receipt.rawPayload.subarray(0, 5).toString()).toBe('%PDF-');
  });

  it('a second run changes nothing', async () => {
    const { db } = await testDb();
    const reports = await db.transaction(async (tx) => seedB2c(tx, await loadDemoState(), t.config));
    expect(reports.map((report) => [report.table, report.inserted])).toEqual([
      ['checkout_sessions', 0],
      ['orders', 0],
      ['order_events', 0],
      ['consent_records', 0],
      ['invoices', 0],
      ['payments', 0],
      ['refunds', 0],
      ['disputes', 0],
    ]);
    expect(await db.select().from(s.orders)).toHaveLength(864);
  });

  it('uses the customers that exist and adds none: without the customers seeder there is no customer row and no storefront order', async () => {
    const { db } = await testDb();
    await resetDb();
    const demo = await loadDemoState();
    const reports = await db.transaction(async (tx) => {
      const written = [];
      // The growth seeder is left out too: it makes a guest customer of its own for each left checkout (feature 19).
      for (const seeder of SEEDERS.filter((seeder) => seeder.module !== 'customers' && seeder.module !== 'growth')) {
        for (const report of await seeder.run(tx, demo, t.config)) written.push({ module: seeder.module, ...report });
      }
      return written;
    });
    expect(await db.select().from(s.customers)).toHaveLength(0);
    expect((await db.select().from(s.orders)).filter((order) => order.customerId !== null)).toHaveLength(0);
    expect(reports.filter((report) => report.module === 'b2c').map((report) => report.table)).not.toContain(
      'customers',
    );
  });
});

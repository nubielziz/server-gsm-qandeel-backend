// End-to-end walk of the map scenario `b2c-paid` (a paid storefront order, docs/slices/money.json steps 3 to 8, 15 and 16) on the real application,
// a stand-in card gateway and a fake Dhru supplier: the price and tax the checkout locks, the hosted payment, the signed confirmation that
// creates the order in one transaction, the gateway fee, the delivery by the supplier and the tax receipt. The steps share one story, so the tests
// of this file run in order. The customer emails of step 16 are the notifications feature's (12a); the receipt itself is read here.
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { eq } from 'drizzle-orm';
import { EncryptionService } from '../../src/infra/crypto';
import { schema as s } from '../../src/infra/db';
import { RedisService } from '../../src/infra/redis';
import { ReceiptRenderModule } from '../../src/modules/money';
import { SupplierDispatch, SupplierPoll } from '../../src/modules/suppliers';
import { type TestApp, createTestApp } from '../support/app';
import { clearIdentityCaches } from '../support/auth';
import { GatewayTestModule } from '../support/billing';
import {
  type B2cWorld,
  B2cGateway,
  b2cWorld,
  hook,
  json,
  openCheckout,
  pay,
  renderReceipts,
  storefrontEvent,
} from '../support/b2c';
import { MINUTE, TestClock } from '../support/clock';
import { closeTestDb, resetDb, testDb } from '../support/db';
import { accountFigures, ledgerTotals } from '../support/money';
import { eventsOf, ledgerOf, orderRow, outboxOf, systemBalance } from '../support/orders';
import { freshClientIp } from '../support/pipeline-routes';
import { deleteBullKeys, testBullPrefix } from '../support/queues';
import { FakeDhruSupplier, SupplierTestModule, insertFakeSupplier, linkService } from '../support/suppliers';

const gateway = new B2cGateway();
const supplier = new FakeDhruSupplier();
const clock = new TestClock('2026-11-07T12:00:00.000Z');
const prefix = testBullPrefix();
let t: TestApp;
let world: B2cWorld;
let supplierId = 0;
let token = '';
let trackingToken = '';
let paymentId = 0;
let paymentReference = '';
let orderId = 0;
let intent = '';
let confirmation = '';

beforeAll(async () => {
  t = await createTestApp({
    clock,
    imports: [GatewayTestModule, SupplierTestModule, ReceiptRenderModule],
    env: { BULL_PREFIX: prefix },
  });
  await resetDb();
  await clearIdentityCaches(t);
  world = await b2cWorld(t, (await testDb()).db, gateway);
  supplierId = await insertFakeSupplier(world.db, t.app.get(EncryptionService, { strict: false }), supplier);
  await linkService(world.db, world.att.serviceId, supplierId, { credit: '13.5000' });
});
afterAll(async () => {
  await gateway.stop();
  await supplier.stop();
  await resetDb();
  await deleteBullKeys(t.app.get(RedisService, { strict: false }).queue, prefix);
  await t.close();
  await closeTestDb();
});

const payments = () => world.db.select().from(s.payments);

describe('scenario b2c-paid: a storefront order is paid and delivered', () => {
  it('step 3: the price comes from the Retail group with the buyer country VAT, and the exchange rate is locked on the session', async () => {
    ({ token } = await openCheckout(t, world, {
      serviceId: world.att.serviceId,
      email: 'jack@mail.example',
      country: 'GB',
    }));
    const [session] = await world.db.select().from(s.checkoutSessions);
    expect(session).toMatchObject({
      status: 'open',
      serviceId: world.att.serviceId,
      currency: 'GBP',
      netAmount: '25.9900',
      taxAmount: '5.2000',
      grossAmount: '31.1900',
      taxRate: '20.0000',
      taxCountry: 'GB',
    });
    // 0.79 plus the 1.5 % markup of the currency.
    expect(session!.fxRate).toBe('0.80185000');
    expect(session!.orderId).toBeNull();
    expect(await world.db.select().from(s.orders)).toHaveLength(0);
  });

  it('step 4: the payment opens a hosted page at the gateway for the locked amount with an idempotency key and 3-D Secure; no order yet', async () => {
    const res = await pay(t, token, undefined, 'key-b2c-paid-1');
    expect(res.statusCode).toBe(201);
    const body = json(res);
    paymentId = body.payment.id;
    paymentReference = body.payment.reference;
    expect(body).toMatchObject({
      payment: { status: 'pending', method: 'card', currency: 'GBP', amount: '25.0100' },
      gateway: { code: 'card-b2c', supports3ds: true },
      paymentUrl: expect.stringMatching(/^https:\/\/pay\.example\/cs_/),
    });
    const call = gateway.calls('/v1/checkout/sessions')[0]!;
    const form = new URLSearchParams(call.body);
    expect(form.get('line_items[0][price_data][unit_amount]')).toBe('2501');
    expect(form.get('line_items[0][price_data][currency]')).toBe('gbp');
    expect(form.get('client_reference_id')).toBe(paymentReference);
    expect(form.get('payment_method_options[card][request_three_d_secure]')).toBe('any');
    expect(call.headers['idempotency-key']).toBe(paymentReference);
    const [payment] = await payments();
    expect(payment).toMatchObject({
      id: paymentId,
      status: 'pending',
      purpose: 'order',
      amount: '25.0100',
      orderId: null,
    });
    expect(await world.db.select().from(s.orders)).toHaveLength(0);
    expect((await ledgerTotals(world.db)).transactions).toBe(0);
  });

  it('step 5: the customer pays on the gateway page: nothing exists yet and nothing goes to the supplier', async () => {
    expect(await world.db.select().from(s.orders)).toHaveLength(0);
    expect(await world.db.select().from(s.outboxEvents)).toHaveLength(0);
    expect(supplier.callsOf('placeimeiorder')).toHaveLength(0);
    const shown = json(
      await t.app.inject({
        method: 'GET',
        url: `/store/v1/checkout-sessions/${token}`,
        remoteAddress: freshClientIp(),
      }),
    );
    expect(shown).toMatchObject({ status: 'open', trackingToken: null });
  });

  it('step 6: the signed confirmation is verified and handled once; a repeat of it changes nothing', async () => {
    intent = 'pi_b2c_paid';
    confirmation = storefrontEvent('evt_b2c_paid', paymentReference, { amount: '25.0100', currency: 'GBP', intent });
    const first = await hook(t, clock, 'payments', world.gateway.code, confirmation);
    expect(first.statusCode).toBe(200);
    const again = await hook(t, clock, 'payments', world.gateway.code, confirmation);
    expect(again.statusCode).toBe(200);
    expect(await world.db.select().from(s.orders)).toHaveLength(1);
    expect(await payments()).toHaveLength(1);
  });

  it('step 7: in one transaction the payment is captured and the session paid, the order has a customer and a public token, and the capture is booked', async () => {
    const [payment] = await payments();
    const [session] = await world.db.select().from(s.checkoutSessions);
    const [order] = await world.db.select().from(s.orders);
    orderId = order!.id;
    expect(payment).toMatchObject({
      status: 'captured',
      orderId,
      gatewayTxnId: intent,
      brand: 'Visa •••• 4242',
      threeDs: true,
      cardFingerprint: 'fp_1',
    });
    expect(payment!.capturedAt?.toISOString()).toBe('2026-11-07T12:00:00.000Z');
    expect(session).toMatchObject({ status: 'paid', orderId });
    expect(order).toMatchObject({
      customerId: session!.customerId,
      clientId: null,
      source: 'store',
      status: 'pending',
      dispatchState: 'pending',
      totalPrice: '25.9900',
      taxAmount: '5.2000',
      currency: 'USD',
      checkoutSessionId: session!.id,
    });
    expect(order!.publicToken).toHaveLength(22);
    trackingToken = order!.publicToken!;
    expect((await eventsOf(world.db, orderId)).map((event) => event.type)).toEqual(['created', 'paid']);
    // Dr gateway_clearing 31.19, Cr customer_funds 25.99, Cr vat_payable 5.20.
    expect((await ledgerOf(world.db, orderId))[0]).toEqual({
      kind: 'b2c_payment',
      key: `payment:${paymentId}:capture`,
    });
    expect(await systemBalance(world.db, 'customer_funds')).toBe('25.9900');
    expect(await systemBalance(world.db, 'vat_payable')).toBe('5.2000');
    // The dispatch job is queued for the supplier; the buyer's page now shows the tracking token.
    expect(await outboxOf(world.db, 'order.dispatch_requested', orderId)).toHaveLength(1);
    const shown = json(
      await t.app.inject({
        method: 'GET',
        url: `/store/v1/checkout-sessions/${token}`,
        remoteAddress: freshClientIp(),
      }),
    );
    expect(shown).toMatchObject({ status: 'paid', trackingToken });
  });

  it('step 8: the gateway fee is booked as an expense', async () => {
    // 2.9 % of 31.19 is 0.9045, plus the fixed 0.30.
    expect((await ledgerOf(world.db, orderId)).map((entry) => entry.kind)).toEqual(['b2c_payment', 'gateway_fee']);
    expect(await systemBalance(world.db, 'gateway_fees')).toBe('1.2045');
    expect(await systemBalance(world.db, 'gateway_clearing')).toBe('29.9855');
    expect((await ledgerTotals(world.db)).sum).toBe('0.0000');
  });

  it('the worker sends the paid order to the supplier through the primary link', async () => {
    const outcome = await t.app.get(SupplierDispatch, { strict: false }).run(orderId, { lastAttempt: false });
    expect(outcome.status).toBe('sent');
    expect(supplier.callsOf('placeimeiorder')).toHaveLength(1);
    expect(await orderRow(world.db, orderId)).toMatchObject({
      status: 'processing',
      supplierId,
      supplierRef: supplier.referenceOf(1),
    });
  });

  it('step 15: on delivery customer funds become revenue at the sale price without VAT, the supplier cost is booked, the VAT stays', async () => {
    supplier.finish(supplier.referenceOf(1), 4, 'UNLOCKED-OK');
    clock.advance(MINUTE + 1000);
    expect(await t.app.get(SupplierPoll, { strict: false }).check(orderId, { type: 'system' })).toEqual({
      kind: 'completed',
    });
    expect(await orderRow(world.db, orderId)).toMatchObject({ status: 'completed', resultCode: 'UNLOCKED-OK' });
    expect((await ledgerOf(world.db, orderId)).map((entry) => entry.kind)).toEqual([
      'b2c_payment',
      'gateway_fee',
      'order_settle',
    ]);
    expect(await systemBalance(world.db, 'customer_funds')).toBe('0.0000');
    expect(await systemBalance(world.db, 'revenue')).toBe('25.9900');
    expect(await systemBalance(world.db, 'cogs')).toBe('13.5000');
    expect(await systemBalance(world.db, 'vat_payable')).toBe('5.2000');
    expect((await accountFigures(world.db, 'supplier_prepaid', { type: 'supplier', id: supplierId }))?.balance).toBe(
      '-13.5000',
    );
    expect((await ledgerTotals(world.db)).sum).toBe('0.0000');
    expect((await eventsOf(world.db, orderId)).at(-1)?.type).toBe('settle');
  });

  it('step 16: the buyer reads the result on the tracking page and downloads the tax receipt', async () => {
    const tracking = json(
      await t.app.inject({ method: 'GET', url: `/store/v1/orders/${trackingToken}`, remoteAddress: freshClientIp() }),
    );
    expect(tracking).toMatchObject({ status: 'completed', result: { code: 'UNLOCKED-OK' } });
    // The worker's receipt job draws and stores the PDF after the capture; the download then serves that copy.
    expect(await renderReceipts(t)).toEqual(['stored']);
    const receipt = await t.app.inject({
      method: 'GET',
      url: `/store/v1/orders/${trackingToken}/receipt`,
      remoteAddress: freshClientIp(),
    });
    expect(receipt.statusCode).toBe(200);
    expect(receipt.headers['content-type']).toBe('application/pdf');
    expect(receipt.rawPayload.subarray(0, 5).toString()).toBe('%PDF-');
    const [invoice] = await world.db.select().from(s.invoices).where(eq(s.invoices.orderId, orderId));
    expect(invoice).toMatchObject({
      kind: 'receipt',
      status: 'paid',
      netAmount: '20.8400',
      taxAmount: '4.1700',
      taxRate: '20.0000',
      taxCountry: 'GB',
      total: '25.0100',
      currency: 'GBP',
    });
    expect(invoice!.pdfFileId).not.toBeNull();
  });
});

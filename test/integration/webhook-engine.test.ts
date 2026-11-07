// Integration tests of the webhook delivery engine (feature 7b, decisions 019, 020, 023; ALIGNMENT § 7): the fan-out of a merchant
// event into deliveries, the signed send to a local stand-in endpoint, the retry schedule with its 8 attempts, the guarded
// writes of a job that runs twice, the SSRF guard at send time, and the manual retry. Real Postgres and Redis; the stand-in
// endpoint is a local Bun server and the clock is a TestClock (the waits are the row's `next_retry_at`, never a sleep).
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { eq } from 'drizzle-orm';
import { CacheKeys } from '../../src/infra/cache';
import { EncryptionService, verifyWebhookSignature } from '../../src/infra/crypto';
import { type Database, schema as s } from '../../src/infra/db';
import { QueuesService, UnrecoverableError } from '../../src/infra/queues';
import { RedisService } from '../../src/infra/redis';
import { OutboxService, WebhookDeliveries, WebhookFanOut } from '../../src/modules/platform';
import type { OutboxJobData, OutboxPayload } from '../../src/modules/platform';
import { WebhookDeliveryAdminService } from '../../src/modules/platform/webhooks/webhook-delivery-admin.service';
import { type TestApp, createTestApp } from '../support/app';
import { insertMerchant } from '../support/auth';
import { MINUTE, TestClock } from '../support/clock';
import { closeTestDb, resetDb, testDb } from '../support/db';
import { deleteBullKeys, testBullPrefix } from '../support/queues';
import { expectRejection } from '../support/rejection';
import {
  TEST_ENDPOINT_SECRET,
  WebhookReceiver,
  WebhookTestModule,
  insertDelivery,
  insertEndpoint,
  insertOrder,
  insertUsd,
  resetWebhookPolicy,
  testWebhookPolicy,
} from '../support/webhooks';
import { RateLimitService } from '../../src/infra/rate-limit';

const prefix = testBullPrefix();
const clock = new TestClock('2026-11-01T10:00:00.000Z');
const receiver = new WebhookReceiver();
let t: TestApp;
let db: Database;

beforeAll(async () => {
  ({ db } = await testDb());
  t = await createTestApp({ clock, env: { BULL_PREFIX: prefix }, imports: [WebhookTestModule] });
});
afterAll(async () => {
  await receiver.stop();
  await deleteBullKeys(t.app.get(RedisService).queue, prefix);
  await resetDb();
  await t.close();
  await closeTestDb();
});
beforeEach(async () => {
  clock.set('2026-11-01T10:00:00.000Z');
  resetWebhookPolicy();
  receiver.reset();
  await resetDb();
  // The ids start again after resetDb, and the queue keeps a finished job under its id: forget the jobs and the retry budgets.
  await deleteBullKeys(t.app.get(RedisService).queue, prefix);
  const cache = t.app.get(RedisService).cache;
  const found = await cache.keys(`${t.app.get(CacheKeys).rateLimit('webhook-retry')}:*`);
  if (found.length > 0) await cache.del(...found);
});
afterEach(() => {
  receiver.reset();
});

const encryption = () => t.app.get(EncryptionService);
const deliveries = () => t.app.get(WebhookDeliveries);
const fanOut = () => t.app.get(WebhookFanOut);
const rows = () => db.select().from(s.webhookDeliveries).orderBy(s.webhookDeliveries.id);
const rowOf = async (id: number) =>
  (await db.select().from(s.webhookDeliveries).where(eq(s.webhookDeliveries.id, id)))[0]!;
const endpointOf = async (id: number) =>
  (await db.select().from(s.webhookEndpoints).where(eq(s.webhookEndpoints.id, id)))[0]!;
const jobOf = (deliveryId: number, attempt: number) =>
  t.app.get(QueuesService).queue('merchant-webhooks').getJob(`webhook-${deliveryId}-${attempt}`);

/** Writes an outbox event the way a feature does (in its own transaction) and returns the job the relay would add for it. */
async function emit(
  type: string,
  aggregateType: string,
  aggregateId: number,
  payload: OutboxPayload,
): Promise<OutboxJobData> {
  const row = await db.transaction((tx) =>
    t.app.get(OutboxService).add(tx, { type, aggregateType, aggregateId, payload }),
  );
  return { eventId: row.id, type, aggregateType, aggregateId, payload, requestId: `test-${row.id}` };
}

/** A merchant with one active endpoint at the stand-in server. */
async function subscribed(
  events: string[] = ['order.status_changed'],
  overrides: Partial<typeof s.webhookEndpoints.$inferInsert> = {},
) {
  const clientId = await insertMerchant(db, { name: 'Zain Mobile Hub' });
  const endpointId = await insertEndpoint(encryption(), db, clientId, { url: receiver.url, events, ...overrides });
  return { clientId, endpointId };
}

describe('fan-out of order.status_changed', () => {
  it('creates one delivery per subscribed, active endpoint of the merchant, with the public fields of the order', async () => {
    const zain = await insertMerchant(db, { name: 'Zain Mobile Hub' });
    const other = await insertMerchant(db);
    const on = await insertEndpoint(encryption(), db, zain, { events: ['order.status_changed', 'invoice.paid'] });
    const second = await insertEndpoint(encryption(), db, zain, {
      events: ['order.status_changed'],
      url: 'https://b.example.com/',
    });
    await insertEndpoint(encryption(), db, zain, { events: ['wallet.low_balance'] });
    await insertEndpoint(encryption(), db, zain, { events: ['order.status_changed'], isActive: false });
    await insertEndpoint(encryption(), db, other, { events: ['order.status_changed'] });
    const { orderId, serviceId } = await insertOrder(db, zain, { serviceName: 'iPhone iCloud Clean' });

    const job = await emit('order.status_changed', 'orders', orderId, {
      orderId,
      clientId: zain,
      fromStatus: 'processing',
      toStatus: 'completed',
    });
    const result = await fanOut().run(job);
    expect(result).toEqual({ endpoints: 2, created: 2 });

    const made = await rows();
    expect(made.map((row) => row.endpointId)).toEqual([on, second]);
    const [first] = made;
    expect(first).toMatchObject({ event: 'order.status_changed', attempt: 1, status: 'pending', responseCode: null });
    expect(first?.nextRetryAt?.toISOString()).toBe(clock.now().toISOString());
    expect(first?.eventId).toMatch(/^evt_[0-9a-f]{24}$/);
    expect(made[1]?.eventId).toBe(first?.eventId);
    expect(first?.payload).toEqual({
      id: first?.eventId,
      type: 'order.status_changed',
      createdAt: expect.any(String),
      data: {
        orderId,
        serviceId,
        serviceName: 'iPhone iCloud Clean',
        status: 'completed',
        previousStatus: 'processing',
        imei: '356938035643809',
        quantity: 1,
        unitPrice: '4.5000',
        totalPrice: '4.5000',
        currency: 'USD',
        resultCode: 'CLEAN',
        resultComment: 'Device is clean',
        placedAt: '2026-11-01T09:30:00.000Z',
        completedAt: '2026-11-01T09:42:10.000Z',
      },
    });
    // Never the cost, the supplier or an internal note.
    const text = JSON.stringify(first?.payload);
    for (const secret of [
      'unitCost',
      'totalCost',
      'adminNote',
      'internal: supplier was slow',
      'supplier',
      'dispatch',
    ]) {
      expect(text, secret).not.toContain(secret);
    }
    for (const delivery of made)
      expect((await jobOf(delivery.id, 1))?.data).toMatchObject({ deliveryId: delivery.id, attempt: 1 });
  });

  it('takes the envelope time from the outbox row, not from the moment the worker runs', async () => {
    const { clientId } = await subscribed();
    const { orderId } = await insertOrder(db, clientId);
    const job = await emit('order.status_changed', 'orders', orderId, {
      orderId,
      clientId,
      fromStatus: 'pending',
      toStatus: 'processing',
    });
    const [event] = await db.select().from(s.outboxEvents).where(eq(s.outboxEvents.id, job.eventId));
    clock.advance(30 * MINUTE);
    await fanOut().run(job);
    expect(((await rows())[0]?.payload as { createdAt: string }).createdAt).toBe(event!.createdAt.toISOString());
  });

  it('is safe to run twice: no second delivery, and the job of a delivery whose first run died is still added', async () => {
    const { clientId, endpointId } = await subscribed();
    const { orderId } = await insertOrder(db, clientId);
    const job = await emit('order.status_changed', 'orders', orderId, {
      orderId,
      clientId,
      fromStatus: 'pending',
      toStatus: 'processing',
    });
    expect(await fanOut().run(job)).toEqual({ endpoints: 1, created: 1 });
    expect(await fanOut().run(job)).toEqual({ endpoints: 1, created: 0 });
    expect(await rows()).toHaveLength(1);
    // The first run committed the row and died before the queue took the job: the retry adds it.
    const [row] = await rows();
    await t.app.get(QueuesService).queue('merchant-webhooks').remove(`webhook-${row!.id}-1`);
    expect(await jobOf(row!.id, 1)).toBeUndefined();
    await fanOut().run(job);
    expect(await jobOf(row!.id, 1)).toBeDefined();
    expect((await rows()).filter((delivery) => delivery.endpointId === endpointId)).toHaveLength(1);
  });

  it('is safe to run at the same time', async () => {
    const { clientId } = await subscribed();
    const { orderId } = await insertOrder(db, clientId);
    const job = await emit('order.status_changed', 'orders', orderId, {
      orderId,
      clientId,
      fromStatus: 'pending',
      toStatus: 'processing',
    });
    const results = await Promise.all([fanOut().run(job), fanOut().run(job), fanOut().run(job)]);
    expect(results.reduce((sum, result) => sum + result.created, 0)).toBe(1);
    expect(await rows()).toHaveLength(1);
  });

  it('gives each status change of one order its own event', async () => {
    const { clientId } = await subscribed();
    const { orderId } = await insertOrder(db, clientId);
    await fanOut().run(
      await emit('order.status_changed', 'orders', orderId, {
        orderId,
        clientId,
        fromStatus: 'pending',
        toStatus: 'processing',
      }),
    );
    await fanOut().run(
      await emit('order.status_changed', 'orders', orderId, {
        orderId,
        clientId,
        fromStatus: 'processing',
        toStatus: 'completed',
      }),
    );
    const made = await rows();
    expect(made).toHaveLength(2);
    expect(made[0]?.eventId).not.toBe(made[1]?.eventId);
    expect(made.map((row) => (row.payload as { data: { status: string } }).data.status)).toEqual([
      'processing',
      'completed',
    ]);
  });

  it('does nothing for a merchant without a subscribed endpoint, an unknown event type, or a source that is gone', async () => {
    const clientId = await insertMerchant(db);
    const { orderId } = await insertOrder(db, clientId);
    const payload = { orderId, clientId, fromStatus: 'pending', toStatus: 'processing' };
    expect(await fanOut().run(await emit('order.status_changed', 'orders', orderId, payload))).toEqual({
      endpoints: 0,
      created: 0,
      skipped: 'no_subscriber',
    });
    expect(
      await fanOut().run({
        ...(await emit('order.status_changed', 'orders', orderId, payload)),
        type: 'order.completed',
      }),
    ).toEqual({
      endpoints: 0,
      created: 0,
      skipped: 'unknown_event',
    });
    const subscribedMerchant = await subscribed();
    expect(
      await fanOut().run(
        await emit('order.status_changed', 'orders', 99999, {
          orderId: 99999,
          clientId: subscribedMerchant.clientId,
          fromStatus: 'a',
          toStatus: 'b',
        }),
      ),
    ).toEqual({ endpoints: 1, created: 0, skipped: 'source_gone' });
    // An order of another merchant is not sent to this one.
    const foreign = await insertOrder(db, clientId);
    expect(
      await fanOut().run(
        await emit('order.status_changed', 'orders', foreign.orderId, {
          orderId: foreign.orderId,
          clientId: subscribedMerchant.clientId,
          fromStatus: 'pending',
          toStatus: 'processing',
        }),
      ),
    ).toMatchObject({ created: 0, skipped: 'source_gone' });
    expect(await rows()).toEqual([]);
  });

  it('fails for good when an event carries no merchant', async () => {
    const job = await emit('order.status_changed', 'orders', 5, { orderId: 5 });
    const error = await expectRejection(fanOut().run(job), Error);
    expect(error).toBeInstanceOf(UnrecoverableError);
  });
});

describe('fan-out of the other events', () => {
  it('wallet.low_balance carries the currency, the available balance and the threshold', async () => {
    const { clientId } = await subscribed(['wallet.low_balance']);
    const job = await emit('wallet.low_balance', 'ledger_accounts', 7, {
      clientId,
      currency: 'USD',
      available: '42.5000',
      threshold: '50.0000',
    });
    expect(await fanOut().run(job)).toEqual({ endpoints: 1, created: 1 });
    expect((await rows())[0]?.payload).toMatchObject({
      type: 'wallet.low_balance',
      data: { currency: 'USD', available: '42.5000', threshold: '50.0000' },
    });
  });

  it('invoice.paid carries the invoice number, amount and paid time', async () => {
    const { clientId } = await subscribed(['invoice.paid']);
    await insertUsd(db);
    const [invoice] = await db
      .insert(s.invoices)
      .values({
        number: 'INV-2026-0311',
        clientId,
        kind: 'manual',
        amount: '250.0000',
        netAmount: '250.0000',
        total: '250.0000',
        currency: 'USD',
        status: 'paid',
        paidAt: new Date('2026-11-01T11:05:00.000Z'),
      })
      .returning({ id: s.invoices.id });
    const job = await emit('invoice.paid', 'invoices', invoice!.id, { invoiceId: invoice!.id, clientId });
    expect(await fanOut().run(job)).toEqual({ endpoints: 1, created: 1 });
    expect((await rows())[0]?.payload).toMatchObject({
      type: 'invoice.paid',
      data: {
        invoiceId: invoice!.id,
        number: 'INV-2026-0311',
        amount: '250.0000',
        currency: 'USD',
        paidAt: '2026-11-01T11:05:00.000Z',
      },
    });
  });

  it('service.price_changed carries the service and both prices, and the same change found twice is one delivery', async () => {
    const { clientId } = await subscribed(['service.price_changed']);
    const { serviceId } = await insertOrder(db, clientId, { serviceName: 'iPhone iCloud Clean' });
    const change = { clientId, serviceId, previousPrice: '4.5000', price: '4.8000', currency: 'USD' };
    expect(await fanOut().run(await emit('service.price_changed', 'services', serviceId, change))).toEqual({
      endpoints: 1,
      created: 1,
    });
    expect(await fanOut().run(await emit('service.price_changed', 'services', serviceId, change))).toEqual({
      endpoints: 1,
      created: 0,
    });
    expect(await rows()).toHaveLength(1);
    expect((await rows())[0]?.payload).toMatchObject({
      type: 'service.price_changed',
      data: {
        serviceId,
        serviceName: 'iPhone iCloud Clean',
        previousPrice: '4.5000',
        price: '4.8000',
        currency: 'USD',
      },
    });
    // A different change is a new event.
    await fanOut().run(await emit('service.price_changed', 'services', serviceId, { ...change, price: '5.0000' }));
    expect(await rows()).toHaveLength(2);
  });
});

describe('sending an attempt', () => {
  async function pendingDelivery(overrides: Partial<typeof s.webhookDeliveries.$inferInsert> = {}) {
    const merchant = await subscribed();
    const id = await insertDelivery(db, merchant.endpointId, overrides);
    return { ...merchant, id };
  }

  it('posts the signed envelope and marks the delivery delivered', async () => {
    const { id, endpointId } = await pendingDelivery();
    await db.update(s.webhookEndpoints).set({ failureCount: 4 }).where(eq(s.webhookEndpoints.id, endpointId));
    receiver.answer({ status: 200, body: '{"received":true}' });
    const result = await deliveries().deliver({ deliveryId: id, attempt: 1 });
    expect(result).toEqual({ outcome: 'delivered', responseCode: 200 });

    const [request] = receiver.requests;
    expect(receiver.requests).toHaveLength(1);
    expect(request).toMatchObject({ method: 'POST', path: '/hooks/gsm' });
    expect(request?.headers['content-type']).toBe('application/json');
    const delivery = await rowOf(id);
    expect(request?.headers['x-gsm-event-id']).toBe(delivery.eventId);
    expect(JSON.parse(request!.body)).toEqual(delivery.payload);
    // The signature is `t=<unix>,v1=<hex HMAC-SHA256 of "<t>.<body>">` with the endpoint's secret, over the exact bytes sent.
    const header = request!.headers['x-gsm-signature']!;
    expect(header).toMatch(/^t=\d+,v1=[0-9a-f]{64}$/);
    expect(
      verifyWebhookSignature(TEST_ENDPOINT_SECRET, header, request!.body, {
        nowSeconds: Math.floor(clock.nowMs() / 1000),
      }),
    ).toMatchObject({ valid: true });
    expect(
      verifyWebhookSignature('wrong-secret', header, request!.body, { nowSeconds: Math.floor(clock.nowMs() / 1000) }),
    ).toMatchObject({ valid: false });
    expect(header.split(',')[0]).toBe(`t=${Math.floor(clock.nowMs() / 1000)}`);

    expect(delivery).toMatchObject({
      status: 'delivered',
      attempt: 1,
      responseCode: 200,
      responseBody: '{"received":true}',
      error: null,
      nextRetryAt: null,
    });
    expect((await endpointOf(endpointId)).failureCount).toBe(0);
    // A delivered delivery gets no further job.
    expect(await jobOf(id, 2)).toBeUndefined();
  });

  it('counts any 2xx as delivered', async () => {
    const { id } = await pendingDelivery();
    receiver.answer(204);
    expect((await deliveries().deliver({ deliveryId: id, attempt: 1 })).outcome).toBe('delivered');
  });

  it('after a refusal keeps the answer, schedules the next attempt with a growing wait and adds its job', async () => {
    const { id, endpointId } = await pendingDelivery();
    receiver.answer({ status: 500, body: '{"error":"internal"}' });
    const result = await deliveries().deliver({ deliveryId: id, attempt: 1 });
    expect(result).toEqual({ outcome: 'retry_scheduled', responseCode: 500 });
    const delivery = await rowOf(id);
    expect(delivery).toMatchObject({
      status: 'pending',
      attempt: 2,
      responseCode: 500,
      responseBody: '{"error":"internal"}',
      error: null,
    });
    const wait = delivery.nextRetryAt!.getTime() - clock.nowMs();
    expect(wait).toBeGreaterThanOrEqual(8 * MINUTE);
    expect(wait).toBeLessThanOrEqual(10 * MINUTE);
    expect((await endpointOf(endpointId)).failureCount).toBe(1);
    const job = await jobOf(id, 2);
    expect(job?.data).toEqual(expect.objectContaining({ deliveryId: id, attempt: 2 }));
    expect(job?.opts.delay).toBeGreaterThanOrEqual(8 * MINUTE - 5);
    expect(job?.opts.delay).toBeLessThanOrEqual(10 * MINUTE);

    receiver.answer(502);
    clock.advance(10 * MINUTE);
    await deliveries().deliver({ deliveryId: id, attempt: 2 });
    const third = await rowOf(id);
    expect(third).toMatchObject({ attempt: 3, responseCode: 502 });
    const secondWait = third.nextRetryAt!.getTime() - clock.nowMs();
    expect(secondWait).toBeGreaterThanOrEqual(16 * MINUTE);
    expect(secondWait).toBeLessThanOrEqual(20 * MINUTE);
  });

  it('records a call that got no answer as responseCode null with the reason, and retries it', async () => {
    const merchant = await subscribed(['order.status_changed'], { url: 'http://127.0.0.1:1/nothing-listens' });
    const id = await insertDelivery(db, merchant.endpointId);
    const result = await deliveries().deliver({ deliveryId: id, attempt: 1 });
    expect(result).toEqual({ outcome: 'retry_scheduled' });
    expect(await rowOf(id)).toMatchObject({
      status: 'pending',
      attempt: 2,
      responseCode: null,
      responseBody: null,
      error: 'The endpoint could not be reached (the connection failed).',
    });
  });

  it('does not follow a redirect: the 3xx is the answer and counts as a refusal', async () => {
    const { id } = await pendingDelivery();
    receiver.answer(302);
    expect(await deliveries().deliver({ deliveryId: id, attempt: 1 })).toEqual({
      outcome: 'retry_scheduled',
      responseCode: 302,
    });
    expect(receiver.requests).toHaveLength(1);
  });

  it('gives up after the eighth attempt: failed, no next attempt, no more waiting, every failure counted', async () => {
    const { id, endpointId } = await pendingDelivery();
    receiver.answer(...Array.from({ length: 8 }, () => 503 as const));
    for (let attempt = 1; attempt <= 8; attempt++) {
      const result = await deliveries().deliver({ deliveryId: id, attempt });
      expect(result.outcome, `attempt ${attempt}`).toBe(attempt < 8 ? 'retry_scheduled' : 'failed');
      const row = await rowOf(id);
      if (attempt < 8) expect(row).toMatchObject({ status: 'pending', attempt: attempt + 1 });
      clock.advance(11 * 60 * MINUTE);
    }
    expect(await rowOf(id)).toMatchObject({ status: 'failed', attempt: 8, responseCode: 503, nextRetryAt: null });
    expect(receiver.requests).toHaveLength(8);
    expect((await endpointOf(endpointId)).failureCount).toBe(8);
    expect(await jobOf(id, 9)).toBeUndefined();
  });

  it('gives up at once, without any call, when the address is no longer public (SSRF guard at send time)', async () => {
    testWebhookPolicy.allowPrivateNetwork = false;
    testWebhookPolicy.httpsOnly = true;
    const merchant = await subscribed(['order.status_changed'], { url: 'https://private.example.com/hook' });
    const id = await insertDelivery(db, merchant.endpointId);
    const result = await deliveries().deliver({ deliveryId: id, attempt: 1 });
    expect(result).toEqual({ outcome: 'failed' });
    const row = await rowOf(id);
    expect(row).toMatchObject({ status: 'failed', attempt: 1, responseCode: null, nextRetryAt: null });
    expect(row.error).toContain('not allowed');
    expect(row.error).toContain('private.example.com');
    expect(receiver.requests).toEqual([]);
  });

  it('fails a delivery whose endpoint was switched off meanwhile, without a call', async () => {
    const { id, endpointId } = await pendingDelivery();
    await db.update(s.webhookEndpoints).set({ isActive: false }).where(eq(s.webhookEndpoints.id, endpointId));
    expect(await deliveries().deliver({ deliveryId: id, attempt: 1 })).toEqual({ outcome: 'failed' });
    expect(await rowOf(id)).toMatchObject({ status: 'failed', error: 'The endpoint is switched off.' });
    expect(receiver.requests).toEqual([]);
  });

  it('keeps a long or binary answer within the stored limit and without NUL characters', async () => {
    const { id } = await pendingDelivery();
    receiver.answer({ status: 500, body: `${'x'.repeat(10_000)}\u0000tail` });
    await deliveries().deliver({ deliveryId: id, attempt: 1 });
    const row = await rowOf(id);
    expect(row.responseBody?.length).toBe(4096);
    expect(row.responseBody).not.toContain('\u0000');
  });

  it('does nothing for a job whose delivery is gone, finished, or whose attempt it has not reached', async () => {
    const { id, endpointId } = await pendingDelivery();
    expect(await deliveries().deliver({ deliveryId: 999999, attempt: 1 })).toEqual({
      outcome: 'skipped',
      skipped: 'gone',
    });
    expect(await deliveries().deliver({ deliveryId: id, attempt: 2 })).toEqual({
      outcome: 'skipped',
      skipped: 'stale',
    });
    await deliveries().deliver({ deliveryId: id, attempt: 1 });
    expect(await deliveries().deliver({ deliveryId: id, attempt: 1 })).toEqual({
      outcome: 'skipped',
      skipped: 'not_pending',
    });
    expect(receiver.requests).toHaveLength(1);
    // Deleting the endpoint deletes the delivery with it.
    await db.delete(s.webhookEndpoints).where(eq(s.webhookEndpoints.id, endpointId));
    expect(await deliveries().deliver({ deliveryId: id, attempt: 1 })).toEqual({ outcome: 'skipped', skipped: 'gone' });
  });

  it('a job for an attempt the delivery has moved past only makes sure the current attempt has its job', async () => {
    const { id } = await pendingDelivery({ attempt: 3, nextRetryAt: new Date(clock.nowMs() + 40 * MINUTE) });
    expect(await deliveries().deliver({ deliveryId: id, attempt: 2 })).toEqual({ outcome: 'resumed' });
    expect(receiver.requests).toEqual([]);
    const job = await jobOf(id, 3);
    expect(job?.opts.delay).toBeGreaterThan(39 * MINUTE);
    expect(await rowOf(id)).toMatchObject({ attempt: 3, status: 'pending' });
  });

  it('records one result when two jobs run the same attempt at once (at-least-once send, one write)', async () => {
    const { id } = await pendingDelivery();
    const results = await Promise.all([
      deliveries().deliver({ deliveryId: id, attempt: 1 }),
      deliveries().deliver({ deliveryId: id, attempt: 1 }),
    ]);
    expect(results.filter((result) => result.outcome === 'delivered')).toHaveLength(1);
    expect(results.filter((result) => result.outcome === 'skipped')).toHaveLength(1);
    expect(await rowOf(id)).toMatchObject({ status: 'delivered', attempt: 1 });
    // The receiver can drop the repeat by the event id, which is the same on both.
    const ids = new Set(receiver.requests.map((request) => request.headers['x-gsm-event-id']));
    expect(ids.size).toBe(1);
  });

  it('signs the test event and sends the same id on every retry', async () => {
    const { id } = await pendingDelivery({ event: 'ping' });
    receiver.answer(500, 200);
    await deliveries().deliver({ deliveryId: id, attempt: 1 });
    clock.advance(10 * MINUTE);
    await deliveries().deliver({ deliveryId: id, attempt: 2 });
    const [first, second] = receiver.requests;
    expect(first?.headers['x-gsm-event-id']).toBe(second?.headers['x-gsm-event-id']);
    expect(first?.headers['x-gsm-signature']).not.toBe(second?.headers['x-gsm-signature']);
    expect(await rowOf(id)).toMatchObject({ status: 'delivered', attempt: 2 });
  });
});

describe('a manual retry', () => {
  it('sends the same payload again as a new attempt, and one more failure does not start a new ladder', async () => {
    const staff = t.app.get(WebhookDeliveryAdminService);
    const merchant = await subscribed();
    const id = await insertDelivery(db, merchant.endpointId, {
      status: 'failed',
      attempt: 8,
      responseCode: 500,
      nextRetryAt: null,
    });
    const before = (await rowOf(id)).payload;
    await staff.retry(id);
    receiver.answer(500);
    expect(await deliveries().deliver({ deliveryId: id, attempt: 9 })).toEqual({
      outcome: 'failed',
      responseCode: 500,
    });
    expect(await rowOf(id)).toMatchObject({ status: 'failed', attempt: 9, nextRetryAt: null });
    expect(JSON.parse(receiver.requests[0]!.body)).toEqual(before);

    await t.app.get(RateLimitService).reset('webhook-retry', String(id));
    await staff.retry(id);
    receiver.answer(200);
    expect(await deliveries().deliver({ deliveryId: id, attempt: 10 })).toEqual({
      outcome: 'delivered',
      responseCode: 200,
    });
    expect(await rowOf(id)).toMatchObject({ status: 'delivered', attempt: 10 });
  });

  it('a job of the attempt it replaced finds the row moved on and sends nothing', async () => {
    const staff = t.app.get(WebhookDeliveryAdminService);
    const merchant = await subscribed();
    const id = await insertDelivery(db, merchant.endpointId, {
      attempt: 2,
      nextRetryAt: new Date(clock.nowMs() + 20 * MINUTE),
    });
    await staff.retry(id);
    expect(await deliveries().deliver({ deliveryId: id, attempt: 2 })).toEqual({ outcome: 'resumed' });
    expect(receiver.requests).toEqual([]);
    expect(await deliveries().deliver({ deliveryId: id, attempt: 3 })).toMatchObject({ outcome: 'delivered' });
  });
});

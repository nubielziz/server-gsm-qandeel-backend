// End-to-end test of the merchant webhook pipeline (feature 7b, decision 020) the way the worker process wires it: an outbox event
// is written in a transaction, the relay hands it to the `merchant-webhooks` queue, the queue worker fans it out into a delivery,
// the delivery job sends the signed request to a local stand-in endpoint, and a refusal schedules the next attempt as a delayed job.
// Real Postgres, real Redis (a private BullMQ prefix), real workers; the waits are polls for the effect (`eventually`).
import { Global, Module } from '@nestjs/common';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { eq } from 'drizzle-orm';
import { CryptoModule, EncryptionService, verifyWebhookSignature } from '../../src/infra/crypto';
import { DbModule, DbService, schema as s } from '../../src/infra/db';
import { OutboundHttpModule } from '../../src/infra/http';
import { MetricsModule } from '../../src/infra/metrics';
import { QueueWorkersModule, QueuesModule, QueuesService } from '../../src/infra/queues';
import { RedisModule, RedisService } from '../../src/infra/redis';
import {
  OutboxRelay,
  OutboxRelayModule,
  OutboxRouteRegistry,
  OutboxService,
  WEBHOOK_TARGET_POLICY,
  WebhookDeliveryModule,
} from '../../src/modules/platform';
import { OutboxListener } from '../../src/modules/platform/outbox/outbox-listener';
import { insertMerchant } from '../support/auth';
import { TEST_DATABASE_URL, closeTestDb, testDb } from '../support/db';
import { type InfraHarness, createInfra, eventually } from '../support/infra';
import { deleteBullKeys, testBullPrefix } from '../support/queues';
import {
  TEST_ENDPOINT_SECRET,
  WebhookReceiver,
  insertEndpoint,
  insertOrder,
  testWebhookPolicy,
} from '../support/webhooks';

const prefix = testBullPrefix();
const receiver = new WebhookReceiver();
let harness: InfraHarness;

/** Gives the delivery engine the test policy (a local server over plain http), as the worker would never have it. */
@Global()
@Module({
  providers: [{ provide: WEBHOOK_TARGET_POLICY, useValue: testWebhookPolicy }],
  exports: [WEBHOOK_TARGET_POLICY],
})
class PolicyModule {}

beforeAll(async () => {
  await testDb();
  const noListener = { onApplicationBootstrap: () => undefined, onModuleDestroy: () => undefined, listening: false };
  harness = await createInfra({
    modules: [
      MetricsModule,
      RedisModule,
      DbModule,
      CryptoModule,
      OutboundHttpModule,
      QueuesModule,
      QueueWorkersModule,
      OutboxRelayModule,
      PolicyModule,
      WebhookDeliveryModule,
    ],
    env: { DATABASE_URL_TEST: TEST_DATABASE_URL, BULL_PREFIX: prefix },
    overrides: [[OutboxListener, noListener]],
  });
  // What feature 5 registers in production.
  harness.get(OutboxRouteRegistry).register({ type: 'order.status_changed', queue: 'merchant-webhooks' });
});
afterAll(async () => {
  await receiver.stop();
  await harness.close();
  const cleaner = await createInfra({ modules: [MetricsModule, RedisModule] });
  await deleteBullKeys(cleaner.get(RedisService).queue, prefix);
  await cleaner.close();
  await closeTestDb();
}, 30_000);
beforeEach(() => {
  receiver.reset();
});

/** A merchant with an endpoint at the stand-in server and an order, and the outbox event of a status change. */
async function statusChange(toStatus: string) {
  const { db } = await testDb();
  const clientId = await insertMerchant(db, { name: 'Zain Mobile Hub' });
  const endpointId = await insertEndpoint(harness.get(EncryptionService), db, clientId, { url: receiver.url });
  const { orderId } = await insertOrder(db, clientId, { serviceName: 'iPhone iCloud Clean' });
  const event = await harness.get(DbService).runInTransaction(({ tx }) =>
    harness.get(OutboxService).add(tx, {
      type: 'order.status_changed',
      aggregateType: 'orders',
      aggregateId: orderId,
      payload: { orderId, clientId, fromStatus: 'processing', toStatus },
    }),
  );
  return { db, clientId, endpointId, orderId, event };
}

describe('the pipeline from the outbox to the merchant', () => {
  it('relays the event, fans it out, sends the signed request and marks the delivery delivered', async () => {
    const { db, endpointId, event } = await statusChange('completed');
    expect(await harness.get(OutboxRelay).run()).toMatchObject({ relayed: 1 });

    const delivery = await eventually(async () => {
      const [row] = await db.select().from(s.webhookDeliveries).where(eq(s.webhookDeliveries.endpointId, endpointId));
      return row?.status === 'delivered' ? row : undefined;
    }, 10_000);
    expect(delivery).toMatchObject({ attempt: 1, responseCode: 200, event: 'order.status_changed' });

    expect(receiver.requests).toHaveLength(1);
    const request = receiver.requests[0]!;
    const envelope = JSON.parse(request.body);
    expect(envelope).toMatchObject({
      id: delivery.eventId,
      type: 'order.status_changed',
      createdAt: expect.any(String),
      data: { status: 'completed', previousStatus: 'processing', serviceName: 'iPhone iCloud Clean' },
    });
    expect(request.headers['x-gsm-event-id']).toBe(envelope.id);
    expect(
      verifyWebhookSignature(TEST_ENDPOINT_SECRET, request.headers['x-gsm-signature']!, request.body, {
        nowSeconds: Math.floor(Date.now() / 1000),
      }),
    ).toMatchObject({ valid: true });
    const [outbox] = await db.select().from(s.outboxEvents).where(eq(s.outboxEvents.id, event.id));
    expect(outbox?.processedAt).not.toBeNull();
  });

  it('after a refusal keeps the delivery pending on its next attempt, with a delayed job, and the merchant sees what it answered', async () => {
    receiver.answer({ status: 503, body: 'maintenance' });
    const { db, endpointId } = await statusChange('rejected');
    await harness.get(OutboxRelay).run();

    const delivery = await eventually(async () => {
      const [row] = await db.select().from(s.webhookDeliveries).where(eq(s.webhookDeliveries.endpointId, endpointId));
      return row?.responseCode === 503 ? row : undefined;
    }, 10_000);
    expect(delivery).toMatchObject({ status: 'pending', attempt: 2, responseBody: 'maintenance', error: null });
    expect(delivery.nextRetryAt!.getTime()).toBeGreaterThan(Date.now() + 7 * 60_000);

    const job = await harness.get(QueuesService).queue('merchant-webhooks').getJob(`webhook-${delivery.id}-2`);
    expect(job?.name).toBe('webhook.deliver');
    expect(await job?.getState()).toBe('delayed');
    expect(receiver.requests).toHaveLength(1);
  });
});

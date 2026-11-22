// Integration tests of the lost-work pass of merchant webhook deliveries (decision 055) on the real application, Postgres and the queue
// Redis (a private BullMQ prefix, no worker running in the app): an overdue pending delivery whose job is missing gets its job
// `webhook-<delivery>-<attempt>` again, a finished job of that id is replaced, and a live job or a delivery that is not overdue is left
// alone. The clock moves; the due time is the clock's.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { Worker } from 'bullmq';
import { EncryptionService } from '@src/infra/crypto';
import { type Database } from '@src/infra/db';
import { QueuesService, UnrecoverableError, queueJobId } from '@src/infra/queues';
import { RedisService } from '@src/infra/redis';
import { LostWorkModule, LostWorkReconcile } from '@src/modules/platform';
import { type TestApp, createTestApp } from '../../support/app';
import { insertMerchant } from '../../support/auth';
import { HOUR, MINUTE, TestClock } from '../../support/clock';
import { closeTestDb, resetDb, testDb } from '../../support/db';
import { deleteBullKeys, testBullPrefix, waitForState } from '../../support/queues';
import { insertDelivery, insertEndpoint } from '../../support/webhooks';

const prefix = testBullPrefix();
const clock = new TestClock('2026-11-22T09:00:00.000Z');
let t: TestApp;
let db: Database;

beforeAll(async () => {
  ({ db } = await testDb());
  t = await createTestApp({ clock, env: { BULL_PREFIX: prefix }, imports: [LostWorkModule] });
});
beforeEach(async () => {
  clock.set('2026-11-22T09:00:00.000Z');
  await resetDb();
  await deleteBullKeys(t.app.get(RedisService).queue, prefix);
});
afterAll(async () => {
  await resetDb();
  await deleteBullKeys(t.app.get(RedisService).queue, prefix);
  await t.close();
  await closeTestDb();
});

const queue = () => t.app.get(QueuesService).queue('merchant-webhooks');
const reconcile = () => t.app.get(LostWorkReconcile, { strict: false }).run();
const jobIdOf = (deliveryId: number, attempt = 1) => queueJobId('webhook', deliveryId, attempt);

/** A pending first attempt of a merchant's delivery, due now by the clock. */
async function pendingDelivery(): Promise<number> {
  const clientId = await insertMerchant(db);
  const endpointId = await insertEndpoint(t.app.get(EncryptionService), db, clientId);
  return insertDelivery(db, endpointId, { nextRetryAt: clock.now() });
}

describe('the webhook delivery pass of the lost-work reconcile (decision 055)', () => {
  it('re-adds the job of an overdue pending delivery whose job was lost', async () => {
    const deliveryId = await pendingDelivery();
    clock.advance(11 * MINUTE);
    const result = await reconcile();
    expect(result.passes.webhook_deliveries).toMatchObject({ checked: 1, requested: 1, unknown: 0 });
    expect(await queue().getJobState(jobIdOf(deliveryId))).toBe('waiting');
    expect((await queue().getJob(jobIdOf(deliveryId)))?.data).toEqual({ deliveryId, attempt: 1 });
    // A second run finds the job waiting and adds nothing.
    expect((await reconcile()).passes.webhook_deliveries).toMatchObject({ checked: 1, requested: 0 });
  });

  it('replaces a finished job of the same id', async () => {
    const deliveryId = await pendingDelivery();
    // A job of that id that ran and failed without moving the row (a worker that takes it and throws for good).
    const worker = new Worker('merchant-webhooks', () => Promise.reject(new UnrecoverableError('lost on the way')), {
      connection: t.app.get(RedisService).createWorkerConnection(),
      prefix,
    });
    try {
      await queue().add('webhook.deliver', { deliveryId, attempt: 1 }, { jobId: jobIdOf(deliveryId), attempts: 1 });
      await waitForState(() => queue().getJob(jobIdOf(deliveryId)), 'failed');
    } finally {
      await worker.close();
    }
    clock.advance(11 * MINUTE);
    expect((await reconcile()).passes.webhook_deliveries).toMatchObject({ checked: 1, requested: 1 });
    expect(await queue().getJobState(jobIdOf(deliveryId))).toBe('waiting');
  });

  it('leaves a delivery whose job is waiting or delayed, and one that is not overdue', async () => {
    const waiting = await pendingDelivery();
    const delayed = await pendingDelivery();
    await queue().add('webhook.deliver', { deliveryId: waiting, attempt: 1 }, { jobId: jobIdOf(waiting) });
    await queue().add('webhook.deliver', { deliveryId: delayed, attempt: 1 }, { jobId: jobIdOf(delayed), delay: HOUR });
    clock.advance(11 * MINUTE);
    const notOverdue = await pendingDelivery();
    clock.advance(5 * MINUTE);
    const result = await reconcile();
    expect(result.passes.webhook_deliveries).toMatchObject({ checked: 2, requested: 0 });
    expect(await queue().getJobState(jobIdOf(waiting))).toBe('waiting');
    expect(await queue().getJobState(jobIdOf(delayed))).toBe('delayed');
    expect(await queue().getJobState(jobIdOf(notOverdue))).toBe('unknown');
  });
});

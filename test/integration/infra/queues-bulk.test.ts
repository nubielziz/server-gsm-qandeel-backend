// Integration tests of the bulk side of the queues (feature 23, slice B, plan section 8.2): `QueuesService.addBulk` adds many jobs with
// the queue defaults and the request id, leaves a taken job id alone, hands over in slices, and fails at once with UNAVAILABLE while the
// queue Redis is down; the worker of `notification-broadcasts` is created with the queue's limiter and the other workers without one.
import { afterAll, describe, expect, it } from 'bun:test';
import { Injectable } from '@nestjs/common';
import type { Worker } from 'bullmq';
import { AppError } from '@src/common/errors';
import { runWithRequestId } from '@src/common/request-id';
import { MetricsModule } from '@src/infra/metrics';
import {
  type JobProcessor,
  QUEUES,
  QueueProcessor,
  QueueWorkers,
  QueueWorkersModule,
  QueuesModule,
  QueuesService,
  queueJobId,
} from '@src/infra/queues';
import { RedisModule, RedisService } from '@src/infra/redis';
import { type InfraHarness, createInfra, deadRedisUrl } from '../../support/infra';
import { deleteBullKeys, testBullPrefix } from '../../support/queues';
import { expectRejection } from '../../support/rejection';

const base = testBullPrefix();
const open: InfraHarness[] = [];
async function infra(group: string, options: Parameters<typeof createInfra>[0] = {}): Promise<InfraHarness> {
  const harness = await createInfra({ ...options, env: { BULL_PREFIX: `${base}-${group}`, ...options.env } });
  open.push(harness);
  return harness;
}
afterAll(async () => {
  await Promise.all(open.map((harness) => harness.close().catch(() => undefined)));
  const cleaner = await createInfra({ modules: [MetricsModule, RedisModule] });
  await deleteBullKeys(cleaner.get(RedisService).queue, base);
  await cleaner.close();
}, 30_000);

describe('QueuesService.addBulk', () => {
  it('adds every job with the queue defaults and the request id, and leaves a taken id alone', async () => {
    const harness = await infra('bulk', { modules: [MetricsModule, RedisModule, QueuesModule] });
    const queues = harness.get(QueuesService);
    const jobs = [1, 2, 3].map((id) => ({
      jobName: 'notification.send',
      data: { notificationId: id, channel: 'email' },
      options: { jobId: queueJobId('notification', id) },
    }));
    expect(await runWithRequestId('req-bulk-1', () => queues.addBulk('notification-broadcasts', jobs))).toBe(3);
    // A repeat (a chunk that ran again, the reconciler) creates nothing new and keeps the first job's data.
    expect(
      await queues.addBulk('notification-broadcasts', [
        {
          jobName: 'notification.send',
          data: { notificationId: 1, channel: 'telegram' },
          options: { jobId: 'notification-1' },
        },
      ]),
    ).toBe(1);
    const waiting = await queues.queue('notification-broadcasts').getJobs(['waiting', 'prioritized']);
    expect(waiting.map((job) => job.id).sort()).toEqual(['notification-1', 'notification-2', 'notification-3']);
    const first = waiting.find((job) => job.id === 'notification-1')!;
    expect(first.data).toEqual({ notificationId: 1, channel: 'email', requestId: 'req-bulk-1' });
    expect(first.opts.attempts).toBe(QUEUES['notification-broadcasts'].attempts);
    expect(first.opts.backoff).toMatchObject({ type: 'exponential', delay: 60_000 });
  });

  it('hands over more than one slice of 1 000', async () => {
    const harness = await infra('slices', { modules: [MetricsModule, RedisModule, QueuesModule] });
    const queues = harness.get(QueuesService);
    const jobs = Array.from({ length: 2_100 }, (_, index) => ({
      jobName: 'notification.send',
      data: { notificationId: index + 1, channel: 'email' },
      options: { jobId: queueJobId('notification', index + 1) },
    }));
    expect(await queues.addBulk('notification-broadcasts', jobs)).toBe(2_100);
    expect(await queues.queue('notification-broadcasts').getWaitingCount()).toBe(2_100);
    expect(await queues.addBulk('notification-broadcasts', [])).toBe(0);
  });

  it('fails at once with 503 UNAVAILABLE while the queue Redis is down', async () => {
    const dead = await deadRedisUrl();
    const harness = await infra('down', {
      modules: [MetricsModule, RedisModule, QueuesModule],
      env: { REDIS_QUEUE_URL_TEST: dead, REDIS_CACHE_URL_TEST: dead },
    });
    const started = performance.now();
    const reason = await expectRejection(
      harness
        .get(QueuesService)
        .addBulk('notification-broadcasts', [
          { jobName: 'notification.send', data: { notificationId: 1, channel: 'email' } },
        ]),
      AppError,
    );
    expect(performance.now() - started).toBeLessThan(750);
    expect(reason).toMatchObject({ code: 'UNAVAILABLE', status: 503, retryAfterSeconds: 5 });
  });
});

@Injectable()
@QueueProcessor('notification-broadcasts', 'notification.send')
class BroadcastEcho implements JobProcessor<object, string> {
  process(): Promise<string> {
    return Promise.resolve('sent');
  }
}

@Injectable()
@QueueProcessor('maintenance', 'echo')
class MaintenanceEcho implements JobProcessor<object, string> {
  process(): Promise<string> {
    return Promise.resolve('done');
  }
}

describe('the worker of notification-broadcasts', () => {
  it('has the queue limiter (30 jobs a second across workers); a queue without one gets none', async () => {
    const harness = await infra('limiter', {
      modules: [MetricsModule, RedisModule, QueuesModule, QueueWorkersModule],
      providers: [BroadcastEcho, MaintenanceEcho],
    });
    const workers = harness.get(QueueWorkers);
    await workers.whenReady();
    // The worker objects are private to the service: the test reads the options BullMQ was given.
    const map = Reflect.get(workers, 'workers') as Map<string, Worker>;
    expect(map.get('notification-broadcasts')?.opts.limiter).toEqual({ max: 30, duration: 1000 });
    expect(map.get('maintenance')?.opts.limiter).toBeUndefined();
  });
});

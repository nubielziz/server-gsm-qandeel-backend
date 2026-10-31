// Integration tests of the BullMQ base (decisions 006, 020) on the test queue Redis (database 1): producers with the queue
// defaults, de-duplication by job id, the request id on jobs, the queue gauge, idempotent scheduler upserts, producers that
// fail fast while Redis is down and recover by themselves, and workers (processors found by decorator, retries with
// backoff, permanent failures, a graceful close that waits for the running job, the drain deadline, a Redis outage).
// Every group uses its own BULL_PREFIX and the file deletes its keys at the end; nothing here flushes the database.
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { Injectable } from '@nestjs/common';
import { AppError } from '../../src/common/errors';
import { getRequestId, runWithRequestId } from '../../src/common/request-id';
import { parseEnv } from '../../src/config';
import { MetricsModule, MetricsService } from '../../src/infra/metrics';
import {
  type Job,
  type JobProcessor,
  JobSchedulerRegistry,
  JobSchedulerRunner,
  QUEUES,
  QUEUE_NAMES,
  QUEUE_WORKERS_OPTIONS,
  QueueProcessor,
  QueueWorkers,
  QueueWorkersModule,
  QueuesModule,
  QueuesService,
  UnrecoverableError,
  queueJobId,
} from '../../src/infra/queues';
import { RedisModule, RedisService } from '../../src/infra/redis';
import { type InfraHarness, createForwarder, createInfra, deadRedisUrl, eventually } from '../support/infra';
import { metricValue } from '../support/metrics';
import { bullKeys, deleteBullKeys, testBullPrefix, waitForState } from '../support/queues';
import { expectRejection } from '../support/rejection';

const base = testBullPrefix();
/** The BULL_PREFIX of a group of tests: groups never see each other's jobs. */
const prefixOf = (group: string): string => `${base}-${group}`;
const open: InfraHarness[] = [];
async function infra(group: string, options: Parameters<typeof createInfra>[0] = {}): Promise<InfraHarness> {
  const harness = await createInfra({ ...options, env: { BULL_PREFIX: prefixOf(group), ...options.env } });
  open.push(harness);
  return harness;
}
afterAll(async () => {
  // Close everything first: a closing queue or worker still writes keys.
  await Promise.all(open.map((harness) => harness.close().catch(() => undefined)));
  const cleaner = await createInfra({ modules: [MetricsModule, RedisModule] });
  await deleteBullKeys(cleaner.get(RedisService).queue, base);
  await cleaner.close();
}, 30_000);

const scrape = (harness: InfraHarness) => harness.get(MetricsService).render();

describe('producers', () => {
  let harness: InfraHarness;
  let queues: QueuesService;

  beforeAll(async () => {
    harness = await infra('producers', { modules: [MetricsModule, RedisModule, QueuesModule] });
    queues = harness.get(QueuesService);
  });

  it('has one producer for each of the ten queues, under BULL_PREFIX', async () => {
    expect(queues.list().map(([name]) => name)).toEqual([...QUEUE_NAMES]);
    expect(QUEUE_NAMES).toHaveLength(10);
    const redis = harness.get(RedisService).queue;
    await eventually(async () => {
      const keys = await bullKeys(redis, prefixOf('producers'));
      return QUEUE_NAMES.every((name) => keys.includes(`${prefixOf('producers')}:${name}:meta`)) ? true : undefined;
    });
    expect(harness.config.redis.bullPrefix).toBe(prefixOf('producers'));
  });

  it('applies the retry and retention defaults of the queue, and keeps them in Redis', async () => {
    const job = await queues.add('supplier-dispatch', 'dispatch', { orderId: 1 });
    expect(job.opts).toMatchObject({
      attempts: 3,
      backoff: { type: 'exponential', delay: 5_000, jitter: 0.5 },
      removeOnComplete: { age: 86_400, count: 10_000 },
      removeOnFail: { age: 1_209_600 },
    });
    const stored = await queues.queue('supplier-dispatch').getJob(job.id as string);
    expect(stored?.opts).toMatchObject({
      attempts: 3,
      backoff: { type: 'exponential', delay: 5_000, jitter: 0.5 },
      removeOnComplete: { age: 86_400, count: 10_000 },
      removeOnFail: { age: 1_209_600 },
    });
    expect(stored?.data).toEqual({ orderId: 1 });
    expect(QUEUES['supplier-dispatch'].maxStalledCount).toBe(0);
  });

  it('adds a job once when the same job id is added again (decision 020, idempotent enqueue)', async () => {
    const jobId = queueJobId('outbox', 777_001);
    const first = await queues.add('notifications', 'send', { id: 1 }, { jobId });
    const again = await queues.add('notifications', 'send', { id: 2 }, { jobId });
    await queues.add('notifications', 'send', { id: 3 }, { jobId });
    expect(first.id).toBe('outbox-777001');
    expect(again.id).toBe(first.id);
    const waiting = await queues.queue('notifications').getWaiting();
    expect(waiting.filter((job) => job.id === jobId)).toHaveLength(1);
    // The first payload wins: the later adds changed nothing.
    expect(waiting.find((job) => job.id === jobId)?.data).toEqual({ id: 1 });
  });

  it('answers a mistake in the call with the BullMQ error, not with UNAVAILABLE', async () => {
    for (const jobId of ['outbox:1', '12345']) {
      const reason = await expectRejection(queues.add('files', 'x', {}, { jobId }), /Custom Id cannot/);
      expect(reason, jobId).not.toBeInstanceOf(AppError);
    }
  });

  it('keeps the request id of the caller on the job, and never overwrites one the caller set', async () => {
    const inside = await runWithRequestId('req-queue-1', () => queues.add('supplier-poll', 'poll', { orderId: 1 }));
    expect(inside.data).toEqual({ orderId: 1, requestId: 'req-queue-1' });
    const explicit = await runWithRequestId('req-queue-1', () =>
      queues.add('supplier-poll', 'poll', { orderId: 2, requestId: 'explicit-1' }),
    );
    expect(explicit.data).toEqual({ orderId: 2, requestId: 'explicit-1' });
    const outside = await queues.add('supplier-poll', 'poll', { orderId: 3 });
    expect(outside.data).toEqual({ orderId: 3 });
    expect(getRequestId()).toBeUndefined();
  });

  it('counts the jobs of every queue per state on scrape, and shows a paused queue', async () => {
    const queue = queues.queue('supplier-poll');
    const waiting = await queue.getWaitingCount();
    expect(waiting).toBe(3);
    let text = await scrape(harness);
    expect(metricValue(text, 'bullmq_queue_jobs', { queue: 'supplier-poll', state: 'waiting' })).toBe(waiting);
    expect(metricValue(text, 'bullmq_queue_jobs', { queue: 'supplier-poll', state: 'active' })).toBe(0);
    expect(text).toContain('bullmq_queue_jobs{queue="outbox-relay",state="delayed"}');
    expect(metricValue(text, 'bullmq_queue_paused', { queue: 'supplier-poll' })).toBe(0);

    await queue.pause();
    try {
      text = await scrape(harness);
      expect(metricValue(text, 'bullmq_queue_paused', { queue: 'supplier-poll' })).toBe(1);
      expect(metricValue(text, 'bullmq_queue_paused', { queue: 'imports' })).toBe(0);
    } finally {
      await queue.resume();
    }
  });
});

describe('schedulers', () => {
  const boot = async () => {
    const harness = await infra('schedulers', {
      modules: [MetricsModule, RedisModule, QueuesModule, QueueWorkersModule],
    });
    const registry = harness.get(JobSchedulerRegistry);
    registry.register({
      id: 'test-every',
      queue: 'supplier-sync',
      jobName: 'noop',
      every: 60_000,
      description: 'Test schedule, every minute.',
    });
    registry.register({
      id: 'test-cron',
      queue: 'supplier-poll',
      jobName: 'noop',
      pattern: '30 2 * * *',
      tz: 'UTC',
      data: { kind: 'nightly' },
      description: 'Test schedule, nightly.',
    });
    return harness;
  };

  it('upserts the registered schedulers idempotently: every boot and every sync leaves one scheduler and one next job', async () => {
    const first = await boot();
    const runner = first.get(JobSchedulerRunner);
    const queues = first.get(QueuesService);
    expect(await runner.sync()).toBe(0);
    const keysAfterFirst = await bullKeys(first.get(RedisService).queue, prefixOf('schedulers'));
    await runner.sync();
    await runner.sync();

    // A second worker boots later: it registers the same schedulers and syncs them.
    const second = await boot();
    expect(await second.get(JobSchedulerRunner).sync()).toBe(0);

    for (const [queue, id] of [
      ['supplier-sync', 'test-every'],
      ['supplier-poll', 'test-cron'],
    ] as const) {
      const schedulers = await queues.queue(queue).getJobSchedulers();
      expect(
        schedulers.filter((scheduler) => scheduler.key === id),
        `${queue}/${id}`,
      ).toHaveLength(1);
      // Exactly one next job per scheduler, however many times it was upserted (an `every` job may already be due).
      const counts = await queues.queue(queue).getJobCounts('waiting', 'delayed');
      expect((counts.waiting ?? 0) + (counts.delayed ?? 0), `${queue} next jobs`).toBe(1);
    }
    const cron = (await queues.queue('supplier-poll').getJobSchedulers()).find(
      (scheduler) => scheduler.key === 'test-cron',
    );
    expect(cron?.pattern).toBe('30 2 * * *');
    expect(cron?.next).toBeGreaterThan(Date.now());
    expect(await bullKeys(first.get(RedisService).queue, prefixOf('schedulers'))).toEqual(keysAfterFirst);
  });

  it('removes a retired scheduler on the next sync', async () => {
    const harness = await infra('schedulers', {
      modules: [MetricsModule, RedisModule, QueuesModule, QueueWorkersModule],
    });
    const queue = harness.get(QueuesService).queue('supplier-sync');
    expect((await queue.getJobSchedulers()).some((scheduler) => scheduler.key === 'test-every')).toBe(true);
    harness.get(JobSchedulerRegistry).retire('supplier-sync', 'test-every');
    expect(await harness.get(JobSchedulerRunner).sync()).toBe(0);
    expect((await queue.getJobSchedulers()).some((scheduler) => scheduler.key === 'test-every')).toBe(false);
  });
});

describe('a queue Redis that is down', () => {
  it('lets the app start, and a producer fails at once with 503 UNAVAILABLE instead of waiting (decision 006)', async () => {
    const dead = await deadRedisUrl();
    const started = performance.now();
    const harness = await infra('down', {
      modules: [MetricsModule, RedisModule, QueuesModule],
      env: { REDIS_QUEUE_URL_TEST: dead, REDIS_CACHE_URL_TEST: dead },
    });
    expect(performance.now() - started).toBeLessThan(5_000);
    const queues = harness.get(QueuesService);
    for (let attempt = 0; attempt < 3; attempt++) {
      const before = performance.now();
      const reason = await expectRejection(queues.add('supplier-dispatch', 'dispatch', { orderId: attempt }), AppError);
      expect(performance.now() - before).toBeLessThan(750);
      expect(reason).toMatchObject({ code: 'UNAVAILABLE', status: 503, retryAfterSeconds: 5 });
    }
    // The scrape still answers, without series for a queue it cannot read.
    const text = await scrape(harness);
    expect(text).toContain('# HELP bullmq_queue_jobs');
    expect(text).not.toContain('bullmq_queue_jobs{');
  });

  it('works again by itself once Redis is back, with the producer that was built while it was away', async () => {
    const real = new URL(parseEnv({ NODE_ENV: 'test' }).redis.queueUrl);
    const forwarder = await createForwarder({ host: real.hostname, port: Number(real.port) });
    const url = `redis://127.0.0.1:${forwarder.port}/1`;
    // Redis is away while the app starts.
    const harness = await infra('down-recover', {
      modules: [MetricsModule, RedisModule, QueuesModule],
      env: { REDIS_QUEUE_URL_TEST: url },
    });
    const queues = harness.get(QueuesService);
    await expectRejection(queues.add('imports', 'x', {}), AppError);

    await forwarder.start();
    try {
      const job = await eventually(
        async () => queues.add('imports', 'x', { n: 1 }, { jobId: queueJobId('recover', 1) }).catch(() => undefined),
        15_000,
      );
      expect(job.id).toBe('recover-1');
      // And it fails fast again when Redis goes away a second time.
      await forwarder.stop();
      await eventually(() => (harness.get(RedisService).queue.status === 'ready' ? undefined : true), 5_000);
      const before = performance.now();
      await expectRejection(queues.add('imports', 'x', { n: 2 }), AppError);
      expect(performance.now() - before).toBeLessThan(750);
    } finally {
      await forwarder.stop();
    }
  }, 30_000);
});

/** What the test processors saw. */
const seen = {
  echo: [] as Array<{ id: string | undefined; n: number; requestId: string | undefined }>,
  flaky: new Map<string, number>(),
  slow: { started: false, finished: false },
  hang: { started: false, release: (): void => undefined },
};

@Injectable()
@QueueProcessor('maintenance', 'echo')
class EchoProcessor implements JobProcessor<{ n: number }, number> {
  process(job: Job<{ n: number }, number, string>): Promise<number> {
    seen.echo.push({ id: job.id, n: job.data.n, requestId: getRequestId() });
    return Promise.resolve(job.data.n * 2);
  }
}

@Injectable()
@QueueProcessor('files')
class FlakyProcessor implements JobProcessor<{ key: string; failTimes?: number; fatal?: boolean }, string> {
  process(job: Job<{ key: string; failTimes?: number; fatal?: boolean }, string, string>): Promise<string> {
    const calls = (seen.flaky.get(job.data.key) ?? 0) + 1;
    seen.flaky.set(job.data.key, calls);
    if (job.data.fatal) return Promise.reject(new UnrecoverableError('this can never work'));
    if (calls <= (job.data.failTimes ?? 0)) return Promise.reject(new Error(`transient failure ${calls}`));
    return Promise.resolve('ok');
  }
}

@Injectable()
@QueueProcessor('imports')
class SlowProcessor implements JobProcessor<object, string> {
  async process(): Promise<string> {
    seen.slow.started = true;
    await Bun.sleep(600);
    seen.slow.finished = true;
    return 'slow done';
  }
}

@Injectable()
@QueueProcessor('alerts')
class HangingProcessor implements JobProcessor<object, string> {
  process(): Promise<string> {
    seen.hang.started = true;
    return new Promise((resolve) => {
      seen.hang.release = () => resolve('released');
    });
  }
}

const workerModules = [MetricsModule, RedisModule, QueuesModule, QueueWorkersModule];

describe('workers', () => {
  let harness: InfraHarness;
  let queues: QueuesService;

  beforeAll(async () => {
    harness = await infra('workers', {
      modules: workerModules,
      providers: [EchoProcessor, FlakyProcessor, SlowProcessor],
    });
    queues = harness.get(QueuesService);
    await harness.get(QueueWorkers).whenReady();
  });

  it('starts one worker for each queue that has a processor, and none for the others', () => {
    expect(harness.get(QueueWorkers).queues().sort()).toEqual(['files', 'imports', 'maintenance']);
  });

  it('runs a job on the processor of its job name, with the request id of the job as the current request id', async () => {
    const job = await runWithRequestId('req-worker-1', () => queues.add('maintenance', 'echo', { n: 21 }));
    const done = await waitForState(() => queues.queue('maintenance').getJob(job.id as string), 'completed');
    expect(done.returnvalue).toBe(42);
    expect(seen.echo.find((entry) => entry.id === job.id)).toEqual({ id: job.id, n: 21, requestId: 'req-worker-1' });

    const text = await scrape(harness);
    expect(
      metricValue(text, 'queue_jobs_processed_total', { queue: 'maintenance', job: 'echo', outcome: 'completed' }),
    ).toBe(1);
    expect(metricValue(text, 'queue_job_duration_seconds_count', { queue: 'maintenance', job: 'echo' })).toBe(1);
  });

  it('gives a job without a request id a fresh one, so every log line of a job has an id', async () => {
    const job = await queues.add('maintenance', 'echo', { n: 1 });
    await waitForState(() => queues.queue('maintenance').getJob(job.id as string), 'completed');
    const entry = seen.echo.find((candidate) => candidate.id === job.id);
    expect(entry?.requestId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('runs a job id that was added three times only once', async () => {
    const jobId = queueJobId('dedupe', 1);
    await Promise.all([1, 2, 3].map(() => queues.add('maintenance', 'echo', { n: 5 }, { jobId })));
    await waitForState(() => queues.queue('maintenance').getJob(jobId), 'completed');
    await Bun.sleep(150);
    expect(seen.echo.filter((entry) => entry.id === jobId)).toHaveLength(1);
  });

  it('retries a transient failure with the queue backoff and stops when it works', async () => {
    const job = await queues.add(
      'files',
      'export',
      { key: 'transient', failTimes: 2 },
      // The queue default is 10 s; a test cannot wait that long.
      { backoff: { type: 'exponential', delay: 20, jitter: 0 } },
    );
    const done = await waitForState(() => queues.queue('files').getJob(job.id as string), 'completed');
    expect(seen.flaky.get('transient')).toBe(3);
    expect(done.attemptsMade).toBe(3);
    expect(done.returnvalue).toBe('ok');
    const text = await scrape(harness);
    expect(metricValue(text, 'queue_jobs_processed_total', { queue: 'files', job: 'export', outcome: 'failed' })).toBe(
      2,
    );
  });

  it('does not retry a permanent failure (UnrecoverableError), although attempts are left', async () => {
    const job = await queues.add('files', 'export', { key: 'fatal', fatal: true });
    const failed = await waitForState(() => queues.queue('files').getJob(job.id as string), 'failed');
    await Bun.sleep(100);
    expect(seen.flaky.get('fatal')).toBe(1);
    expect(failed.failedReason).toBe('this can never work');
    expect(failed.opts.attempts).toBe(3);
  });

  it('fails a job whose name has no processor at once, and does not retry it', async () => {
    const job = await queues.add('maintenance', 'not_a_job', {});
    const failed = await waitForState(() => queues.queue('maintenance').getJob(job.id as string), 'failed');
    expect(failed.failedReason).toBe('Queue "maintenance" has no processor for job "not_a_job".');
    expect(failed.attemptsMade).toBe(1);
  });

  it('on shutdown lets the job that is running finish, then closes (decision 001)', async () => {
    const job = await queues.add('imports', 'bulk', { importId: 1 });
    await eventually(() => (seen.slow.started ? true : undefined));
    expect(seen.slow.finished).toBe(false);

    // Close the app while the job runs; a second, separate connection reads what happened.
    const observer = await infra('workers', { modules: [MetricsModule, RedisModule, QueuesModule] });
    await harness.close();
    expect(seen.slow.finished, 'the app closed before the running job finished').toBe(true);
    const stored = await observer
      .get(QueuesService)
      .queue('imports')
      .getJob(job.id as string);
    expect(await stored?.getState()).toBe('completed');
    expect(stored?.returnvalue).toBe('slow done');
  });
});

describe('the drain deadline', () => {
  it('drops the workers after shutdownGraceMs when a job will not finish, and says so', async () => {
    const harness = await infra('drain', {
      modules: workerModules,
      providers: [HangingProcessor],
      overrides: [[QUEUE_WORKERS_OPTIONS, { shutdownGraceMs: 300 }]],
    });
    const queues = harness.get(QueuesService);
    await harness.get(QueueWorkers).whenReady();
    await queues.add('alerts', 'evaluate', { ruleId: 1 });
    await eventually(() => (seen.hang.started ? true : undefined));

    const started = performance.now();
    await harness.close();
    expect(performance.now() - started).toBeLessThan(4_000);
    expect(harness.logger.lines.some((line) => line.includes('still had jobs running after 300 ms'))).toBe(true);
    seen.hang.release();
  });
});

describe('workers and schedulers when the queue Redis was down at startup', () => {
  it('start working and create their schedulers by themselves once Redis is reachable', async () => {
    const real = new URL(parseEnv({ NODE_ENV: 'test' }).redis.queueUrl);
    const forwarder = await createForwarder({ host: real.hostname, port: Number(real.port) });
    const url = `redis://127.0.0.1:${forwarder.port}/1`;
    // The forwarder is not started: Redis is away while the worker process boots.
    const harness = await infra('down-start', {
      modules: workerModules,
      providers: [EchoProcessor],
      env: { REDIS_QUEUE_URL_TEST: url },
    });
    const queues = harness.get(QueuesService);
    harness.get(JobSchedulerRegistry).register({
      id: 'late-every',
      queue: 'supplier-sync',
      jobName: 'noop',
      every: 60_000,
      description: 'Test schedule, every minute.',
    });
    // The sync that runs while Redis is away fails, and a retry is planned instead of an exception.
    expect(await harness.get(JobSchedulerRunner).sync()).toBe(1);

    await forwarder.start();
    try {
      await eventually(async () => {
        const schedulers = await queues
          .queue('supplier-sync')
          .getJobSchedulers()
          .catch(() => []);
        return schedulers.some((scheduler) => scheduler.key === 'late-every') ? true : undefined;
      }, 30_000);
      const job = await eventually(
        async () =>
          queues.add('maintenance', 'echo', { n: 3 }, { jobId: queueJobId('late', 1) }).catch(() => undefined),
        15_000,
      );
      const done = await waitForState(() => queues.queue('maintenance').getJob(job.id as string), 'completed', 15_000);
      expect(done.returnvalue).toBe(6);
    } finally {
      await forwarder.stop();
    }
  }, 60_000);
});

describe('workers and a queue Redis that goes away', () => {
  it('keep working after the connection drops and comes back (the Redis restart of decision 006)', async () => {
    const real = new URL(parseEnv({ NODE_ENV: 'test' }).redis.queueUrl);
    const forwarder = await createForwarder({ host: real.hostname, port: Number(real.port) });
    await forwarder.start();
    const url = `redis://127.0.0.1:${forwarder.port}/1`;
    const harness = await infra('outage', {
      modules: workerModules,
      providers: [EchoProcessor],
      env: { REDIS_QUEUE_URL_TEST: url },
    });
    const queues = harness.get(QueuesService);
    await harness.get(QueueWorkers).whenReady();
    try {
      const before = await queues.add('maintenance', 'echo', { n: 1 }, { jobId: queueJobId('outage', 1) });
      await waitForState(() => queues.queue('maintenance').getJob(before.id as string), 'completed');

      await forwarder.stop();
      await Bun.sleep(1_200);
      await forwarder.start();

      const after = await eventually(
        async () =>
          queues.add('maintenance', 'echo', { n: 2 }, { jobId: queueJobId('outage', 2) }).catch(() => undefined),
        15_000,
      );
      const done = await waitForState(
        () => queues.queue('maintenance').getJob(after.id as string),
        'completed',
        15_000,
      );
      expect(done.returnvalue).toBe(4);
    } finally {
      await forwarder.stop();
    }
  }, 40_000);
});

// Restart of the real queue Redis container while a worker runs (decision 006): the producer fails fast while Redis is away,
// the worker picks up again by itself, and a job that was waiting before the restart is still there (AOF). It restarts the
// compose container with `docker restart`, so it runs only when GSM_TEST_DOCKER=1 is set:
//   GSM_TEST_DOCKER=1 bun test test/integration/queue-redis-restart.test.ts
// The container name is gsm-backend-redis-queue-1 (override: GSM_TEST_REDIS_QUEUE_CONTAINER). Never run it while another
// checkout uses the same Redis: the restart cuts every connection of the shared instance for a few seconds.
import { afterAll, describe, expect, it } from 'bun:test';
import { Injectable } from '@nestjs/common';
import { AppError } from '../../src/common/errors';
import { MetricsModule } from '../../src/infra/metrics';
import {
  type Job,
  type JobProcessor,
  QueueProcessor,
  QueueWorkers,
  QueueWorkersModule,
  QueuesModule,
  QueuesService,
  queueJobId,
} from '../../src/infra/queues';
import { RedisModule, RedisService } from '../../src/infra/redis';
import { type InfraHarness, createInfra, eventually } from '../support/infra';
import { deleteBullKeys, testBullPrefix, waitForState } from '../support/queues';

const enabled = process.env.GSM_TEST_DOCKER === '1';
const container = process.env.GSM_TEST_REDIS_QUEUE_CONTAINER ?? 'gsm-backend-redis-queue-1';
const prefix = testBullPrefix();
const open: InfraHarness[] = [];

afterAll(async () => {
  await Promise.all(open.map((harness) => harness.close().catch(() => undefined)));
  if (!enabled) return;
  const cleaner = await createInfra({ modules: [MetricsModule, RedisModule] });
  await deleteBullKeys(cleaner.get(RedisService).queue, prefix);
  await cleaner.close();
}, 30_000);

@Injectable()
@QueueProcessor('maintenance', 'echo')
class EchoProcessor implements JobProcessor<{ n: number }, number> {
  process(job: Job<{ n: number }, number, string>): Promise<number> {
    return Promise.resolve(job.data.n * 2);
  }
}

/** `docker restart <container>`, which stops the container and starts it again. */
async function restartRedis(): Promise<void> {
  const docker = Bun.spawn(['docker', 'restart', container], { stdout: 'pipe', stderr: 'pipe' });
  const code = await docker.exited;
  if (code !== 0) throw new Error(`docker restart ${container} failed: ${await new Response(docker.stderr).text()}`);
}

describe.skipIf(!enabled)('the queue Redis container restarts (GSM_TEST_DOCKER=1)', () => {
  it('makes the producer fail fast meanwhile, lets the worker carry on by itself, and keeps waiting jobs', async () => {
    const harness = await createInfra({
      modules: [MetricsModule, RedisModule, QueuesModule, QueueWorkersModule],
      providers: [EchoProcessor],
      env: { BULL_PREFIX: prefix },
    });
    open.push(harness);
    const queues = harness.get(QueuesService);
    const redis = harness.get(RedisService);
    await harness.get(QueueWorkers).whenReady();

    // A job that waits on a queue nobody works on, and one that the worker finishes, before the restart.
    const waiting = await queues.add('notifications', 'send', { id: 1 }, { jobId: queueJobId('restart', 1) });
    const before = await queues.add('maintenance', 'echo', { n: 1 }, { jobId: queueJobId('restart', 2) });
    await waitForState(() => queues.queue('maintenance').getJob(before.id as string), 'completed');

    // Add jobs without pause while the container restarts: while Redis is away every attempt must fail at once.
    let restarted = false;
    const restarting = restartRedis().finally(() => {
      restarted = true;
    });
    const failures: Array<{ ms: number; error: unknown }> = [];
    let attempt = 0;
    while (!restarted) {
      const started = performance.now();
      try {
        await queues.add('notifications', 'send', { id: 100 + attempt }, { jobId: queueJobId('during', attempt++) });
      } catch (error) {
        failures.push({ ms: performance.now() - started, error });
      }
      await Bun.sleep(25);
    }
    await restarting;
    expect(failures.length, 'no attempt met the restart: it was too quick to observe').toBeGreaterThan(0);
    for (const { ms, error } of failures) {
      expect(error).toBeInstanceOf(AppError);
      expect(error).toMatchObject({ code: 'UNAVAILABLE', status: 503 });
      expect(ms).toBeLessThan(1_000);
    }

    // Redis is back (it may still be loading its data): the producer and the worker work again without a restart.
    await eventually(
      async () => ((await redis.queue.ping().catch(() => undefined)) === 'PONG' ? true : undefined),
      30_000,
    );
    const after = await eventually(
      async () =>
        queues.add('maintenance', 'echo', { n: 2 }, { jobId: queueJobId('restart', 3) }).catch(() => undefined),
      30_000,
    );
    const done = await waitForState(() => queues.queue('maintenance').getJob(after.id as string), 'completed', 30_000);
    expect(done.returnvalue).toBe(4);

    // The job that was waiting survived the restart (AOF), untouched.
    const kept = await queues.queue('notifications').getJob(waiting.id as string);
    expect(kept?.data).toMatchObject({ id: 1 });
    expect(await kept?.getState()).toBe('waiting');
  }, 120_000);
});

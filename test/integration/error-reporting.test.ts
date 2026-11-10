// Integration test of the job-failure side of Sentry reporting (decision 015, feature 24D) on the test queue Redis: a job that fails
// for good delivers one scrubbed event tagged with its queue and job; a failed attempt that is retried delivers none.
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { Injectable } from '@nestjs/common';
import { MetricsModule } from '../../src/infra/metrics';
import { ERROR_REPORTER_OPTIONS, ErrorReporter, type SentryTransportFactory } from '../../src/infra/observability';
import {
  type Job,
  type JobProcessor,
  QueueProcessor,
  QueueWorkers,
  QueueWorkersModule,
  QueuesModule,
  QueuesService,
  UnrecoverableError,
} from '../../src/infra/queues';
import { RedisModule, RedisService } from '../../src/infra/redis';
import { type InfraHarness, createInfra, eventually } from '../support/infra';
import { deleteBullKeys, testBullPrefix, waitForState } from '../support/queues';

const prefix = testBullPrefix();
const events: { tags?: Record<string, string>; exception?: { values?: { value?: string }[] } }[] = [];
const transport: SentryTransportFactory = () => ({
  send: (envelope) => {
    for (const [header, payload] of envelope[1] as unknown as [{ type: string }, (typeof events)[number]][]) {
      if (header.type === 'event') events.push(payload);
    }
    return Promise.resolve({});
  },
  flush: () => Promise.resolve(true),
});

@Injectable()
@QueueProcessor('files')
class FailingProcessor implements JobProcessor<{ mode: 'permanent' | 'once' | 'retries'; key: string }, string> {
  private readonly calls = new Map<string, number>();
  process(job: Job<{ mode: 'permanent' | 'once' | 'retries'; key: string }, string, string>): Promise<string> {
    const calls = (this.calls.get(job.data.key) ?? 0) + 1;
    this.calls.set(job.data.key, calls);
    if (job.data.mode === 'permanent')
      return Promise.reject(new UnrecoverableError('cannot work for rania@example.com'));
    if (job.data.mode === 'once' && calls === 1) return Promise.reject(new Error('transient'));
    if (job.data.mode === 'retries') return Promise.reject(new Error('always fails'));
    return Promise.resolve('ok');
  }
}

describe('worker failures and Sentry', () => {
  let harness: InfraHarness;
  let queues: QueuesService;
  let reporter: ErrorReporter;

  beforeAll(async () => {
    harness = await createInfra({
      modules: [MetricsModule, RedisModule, QueuesModule, QueueWorkersModule],
      providers: [FailingProcessor],
      env: { BULL_PREFIX: prefix, SENTRY_DSN: 'https://publickey@o0.ingest.sentry.io/1' },
      overrides: [[ERROR_REPORTER_OPTIONS, { transport }]],
    });
    queues = harness.get(QueuesService);
    reporter = harness.get(ErrorReporter);
    await harness.get(QueueWorkers).whenReady();
  });

  afterAll(async () => {
    await harness.close();
    const cleaner = await createInfra({ modules: [MetricsModule, RedisModule] });
    await deleteBullKeys(cleaner.get(RedisService).queue, prefix);
    await cleaner.close();
  }, 30_000);

  it('reports a permanent failure once, scrubbed, tagged with the queue and the job', async () => {
    expect(reporter.enabled).toBe(true);
    const job = await queues.add('files', 'export', { mode: 'permanent', key: 'p1' });
    await waitForState(() => queues.queue('files').getJob(job.id as string), 'failed');
    await eventually(async () => ((await reporter.flush()) && events.length > 0 ? true : undefined));
    expect(events).toHaveLength(1);
    expect(events[0]?.tags).toEqual({ process: 'worker', queue: 'files', job: 'export' });
    expect(events[0]?.exception?.values?.[0]?.value).toBe('cannot work for r***@example.com');
  });

  it('reports nothing for an attempt that is retried and then works', async () => {
    const before = events.length;
    const job = await queues.add(
      'files',
      'export',
      { mode: 'once', key: 'o1' },
      { backoff: { type: 'exponential', delay: 0, jitter: 0 } },
    );
    await waitForState(() => queues.queue('files').getJob(job.id as string), 'completed');
    await reporter.flush();
    expect(events).toHaveLength(before);
  });

  it('reports once, on the last attempt, a job that exhausts its retries', async () => {
    const before = events.length;
    const job = await queues.add(
      'files',
      'export',
      { mode: 'retries', key: 'r1' },
      { attempts: 3, backoff: { type: 'exponential', delay: 0, jitter: 0 } },
    );
    const failed = await waitForState(() => queues.queue('files').getJob(job.id as string), 'failed');
    expect(failed.attemptsMade).toBe(3);
    await eventually(async () => ((await reporter.flush()) && events.length > before ? true : undefined));
    expect(events).toHaveLength(before + 1);
    expect(events[before]?.tags).toEqual({ process: 'worker', queue: 'files', job: 'export' });
  });
});

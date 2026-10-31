// The worker side of the queues (decisions 001, 020): one BullMQ Worker per queue that has a processor, started when the
// worker process boots and drained in onModuleDestroy. Only src/worker.module.ts imports it; the API never runs jobs.
import { Inject, Injectable, Logger, type OnApplicationBootstrap, type OnModuleDestroy } from '@nestjs/common';
import { DiscoveryService } from '@nestjs/core';
import { type Job, UnrecoverableError, Worker } from 'bullmq';
import type { Redis } from 'ioredis';
import { Counter, Histogram } from 'prom-client';
import { LogThrottle } from '../../common/log-throttle';
import { generateRequestId, isSafeRequestId, runWithRequestId } from '../../common/request-id';
import { TimeoutError, withTimeout } from '../../common/timeout';
import { APP_CONFIG, type AppConfig } from '../../config';
import { MetricsService } from '../metrics';
import { RedisService, withoutCredentials } from '../redis';
import {
  COMPLETED_JOB_MAX_AGE_SECONDS,
  COMPLETED_JOB_MAX_COUNT,
  FAILED_JOB_MAX_AGE_SECONDS,
  QUEUES,
  type QueueName,
} from './queue-definitions';
import { type QueueHandlers, buildProcessorTable, findQueueProcessors, handlerFor } from './queue-processor';

/** Injection token of {@link QueueWorkersOptions}. */
export const QUEUE_WORKERS_OPTIONS = Symbol.for('gsm.QUEUE_WORKERS_OPTIONS');

/** Settings of {@link QueueWorkers}; the module provides the defaults, tests replace them. */
export interface QueueWorkersOptions {
  /**
   * How long a shutdown waits for the jobs a worker is running before it drops the worker's connections anyway. The jobs
   * it abandons are given back to the queue as stalled (and run again), so processors must be idempotent.
   */
  readonly shutdownGraceMs: number;
}

/** A worker repeats its connection error on every reconnect attempt; one line per queue and interval is logged. */
const ERROR_LOG_INTERVAL_MS = 30_000;

/** The default of {@link QueueWorkersOptions}: 25 s, inside the 30 s most orchestrators wait before they kill a process. */
export const DEFAULT_QUEUE_WORKERS_OPTIONS: QueueWorkersOptions = { shutdownGraceMs: 25_000 };

/**
 * Takes the request id a job carries, or makes one, so every log line of the job has an id.
 *
 * @param job the job being run
 * @returns the `requestId` of the job's data when it is safe, else a new id
 */
function requestIdOf(job: Job): string {
  const data: unknown = job.data;
  const candidate = typeof data === 'object' && data !== null ? (data as { requestId?: unknown }).requestId : undefined;
  return isSafeRequestId(candidate) ? candidate : generateRequestId();
}

/**
 * Starts the BullMQ workers of the process and stops them gracefully.
 *
 * Why: decision 020 runs all async work in the worker process, and decision 001 requires that a SIGTERM lets the jobs
 * that are running finish before any connection closes. The workers close in `onModuleDestroy`; the database pool, the
 * Redis clients and the producers close later, in `onApplicationShutdown`. Each worker uses the queue's concurrency
 * and stall rule from the registry, shares one worker connection (`maxRetriesPerRequest: null`, reconnects for ever,
 * so the workers pick up again by themselves after a queue-Redis restart) and gets its own blocking connection from
 * BullMQ. While a job runs, the request id it carries is the current request id, so logs and follow-up outbox rows keep it.
 *
 * Side effects: reads and writes the BullMQ keys of the queues that have processors; counts
 * `queue_jobs_processed_total{queue,job,outcome}` and observes `queue_job_duration_seconds{queue,job}`; logs failures.
 *
 * @see docs/queues.md and docs/decisions/001-runtime-bun.md
 */
@Injectable()
export class QueueWorkers implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(QueueWorkers.name);
  private readonly throttle = new LogThrottle(ERROR_LOG_INTERVAL_MS);
  private readonly workers = new Map<QueueName, Worker>();
  private readonly processed: Counter<'queue' | 'job' | 'outcome'>;
  private readonly duration: Histogram<'queue' | 'job'>;

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(QUEUE_WORKERS_OPTIONS) private readonly options: QueueWorkersOptions,
    private readonly redis: RedisService,
    private readonly discovery: DiscoveryService,
    metrics: MetricsService,
  ) {
    this.processed = new Counter({
      name: 'queue_jobs_processed_total',
      help: 'Jobs a worker finished, by queue, job name and outcome (completed or failed; a retried job counts per attempt).',
      labelNames: ['queue', 'job', 'outcome'],
      registers: [metrics.registry],
    });
    this.duration = new Histogram({
      name: 'queue_job_duration_seconds',
      help: 'Time a worker spent on one attempt of a job, by queue and job name.',
      labelNames: ['queue', 'job'],
      buckets: [0.01, 0.05, 0.1, 0.5, 1, 2.5, 5, 10, 30, 60, 300],
      registers: [metrics.registry],
    });
  }

  /**
   * Finds the processors and starts one worker for each queue that has one.
   *
   * Why: this runs after every module's `onModuleInit`, so the processors and schedules of all modules exist. It does not
   * wait for Redis: workers connect (and reconnect) in the background, and the process starts even when the queue Redis
   * is down.
   *
   * @throws {Error} when the processors are misconfigured (see {@link buildProcessorTable}); the worker must not start
   */
  onApplicationBootstrap(): void {
    const table = buildProcessorTable(findQueueProcessors(this.discovery));
    if (table.size === 0) {
      this.logger.log('No queue processors are registered; no queue worker started.');
      return;
    }
    const connection = this.redis.createWorkerConnection();
    for (const [queue, handlers] of table) this.workers.set(queue, this.start(queue, handlers, connection));
    this.logger.log(`Queue workers started: ${[...table.keys()].join(', ')}`);
  }

  /**
   * The queues this process works on.
   *
   * @returns queue names, in the order the workers were started
   */
  queues(): QueueName[] {
    return [...this.workers.keys()];
  }

  /**
   * Waits until every worker is connected and ready to take jobs. Tests use it; the app does not need it.
   *
   * @returns resolves when all workers are ready; rejects when one cannot connect
   */
  async whenReady(): Promise<void> {
    await Promise.all([...this.workers.values()].map((worker) => worker.waitUntilReady()));
  }

  /**
   * Stops taking jobs, lets the running ones finish, then closes the workers' connections.
   *
   * Why: decision 001. A job that has not finished after `shutdownGraceMs` is abandoned (it comes back as stalled).
   * Runs in `onModuleDestroy`, before the pool and the Redis clients close in `onApplicationShutdown`.
   */
  async onModuleDestroy(): Promise<void> {
    const workers = [...this.workers.entries()];
    this.workers.clear();
    await Promise.all(workers.map(([queue, worker]) => this.drain(queue, worker)));
  }

  private start(queue: QueueName, handlers: QueueHandlers, connection: Redis): Worker {
    const definition = QUEUES[queue];
    const worker = new Worker(queue, (job: Job) => this.run(queue, handlers, job), {
      connection,
      prefix: this.config.redis.bullPrefix,
      concurrency: definition.concurrency,
      maxStalledCount: definition.maxStalledCount,
      // The producer's defaults already carry these; they cover jobs that were added some other way.
      removeOnComplete: { age: COMPLETED_JOB_MAX_AGE_SECONDS, count: COMPLETED_JOB_MAX_COUNT },
      removeOnFail: { age: FAILED_JOB_MAX_AGE_SECONDS },
    });
    // Without an error listener BullMQ would throw the first connection error as an uncaught exception.
    worker.on('error', (error: Error) => {
      const allowed = this.throttle.attempt(`worker:${queue}:error`);
      if (!allowed) return;
      const more = allowed.suppressed > 0 ? ` (${allowed.suppressed} similar errors not logged)` : '';
      this.logger.warn(`Worker ${queue} error: ${withoutCredentials(error.message)}${more}`);
    });
    worker.on('failed', (job: Job | undefined, error: Error) => {
      const attempts = job?.opts.attempts ?? 1;
      // BullMQ fails a job that stalled too often with its own message, whatever the attempts left.
      const final =
        error instanceof UnrecoverableError ||
        /stalled more than allowable limit/.test(error.message) ||
        (job?.attemptsMade ?? attempts) >= attempts;
      // A scheduled job (the outbox tick, every second) fails again and again while its dependency is down: one line per
      // interval is enough. Jobs of events are about one order or one delivery each, so every failure is logged.
      let more = '';
      if (job?.repeatJobKey !== undefined) {
        const allowed = this.throttle.attempt(`failed:${queue}/${job.name}:${error.message}`);
        if (!allowed) return;
        if (allowed.suppressed > 0) more = ` (${allowed.suppressed} similar failures not logged)`;
      }
      const text = `Job ${queue}/${job?.name ?? '?'} ${job?.id ?? '?'} failed (attempt ${job?.attemptsMade ?? '?'} of ${attempts}${final ? ', no more retries' : ''}): ${error.message}${more}`;
      if (final) this.logger.error(text);
      else this.logger.warn(text);
    });
    worker.on('stalled', (jobId: string) => {
      this.logger.warn(
        `Job ${queue}/${jobId} stalled: its worker stopped renewing the lock; it goes back to the queue.`,
      );
    });
    return worker;
  }

  /** Runs one job: picks the processor, binds the request id and records the metrics. */
  private async run(queue: QueueName, handlers: QueueHandlers, job: Job): Promise<unknown> {
    const processor = handlerFor(handlers, job.name);
    if (!processor) throw new UnrecoverableError(`Queue "${queue}" has no processor for job "${job.name}".`);
    const stopTimer = this.duration.startTimer({ queue, job: job.name });
    try {
      const result: unknown = await runWithRequestId(requestIdOf(job), () => processor.instance.process(job));
      this.processed.inc({ queue, job: job.name, outcome: 'completed' });
      return result;
    } catch (error) {
      this.processed.inc({ queue, job: job.name, outcome: 'failed' });
      throw error;
    } finally {
      stopTimer();
    }
  }

  private async drain(queue: QueueName, worker: Worker): Promise<void> {
    // With the queue Redis away a worker cannot report any job as finished, so waiting for the running ones only delays
    // the shutdown: close at once; BullMQ gives those jobs back as stalled when Redis returns.
    const force = this.redis.queue.status !== 'ready';
    try {
      await withTimeout(worker.close(force), this.options.shutdownGraceMs, `Worker ${queue} drain`);
    } catch (error) {
      if (error instanceof TimeoutError) {
        this.logger.warn(
          `Worker ${queue} still had jobs running after ${this.options.shutdownGraceMs} ms; dropping its connections. Those jobs will run again as stalled.`,
        );
      } else {
        this.logger.warn(`Worker ${queue} did not close cleanly: ${withoutCredentials(String(error))}`);
      }
      await worker.disconnect().catch(() => undefined);
    }
  }
}

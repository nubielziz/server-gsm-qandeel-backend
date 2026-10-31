// The BullMQ producers of a process (decision 020): one Queue per registered queue, on the shared queue-Redis client.
// Both the API and the worker produce; only the worker runs processors (QueueWorkers).
import { Inject, Injectable, Logger, type OnApplicationShutdown, type OnModuleInit } from '@nestjs/common';
import { type Job, type JobsOptions, Queue } from 'bullmq';
import { AppError } from '../../common/errors';
import { LogThrottle } from '../../common/log-throttle';
import { getRequestId } from '../../common/request-id';
import { withTimeout } from '../../common/timeout';
import { APP_CONFIG, type AppConfig } from '../../config';
import { RedisService, withoutCredentials } from '../redis';
import { QUEUE_NAMES, type QueueName, defaultJobOptions } from './queue-definitions';
import { isQueueUnavailableError } from './queue-errors';

/** A producer for the jobs this backend creates: `data` is a plain object, the result is not used. */
export type JobQueue = Queue<object, unknown, string>;
/** A job as this backend creates it. */
export type QueuedJob = Job<object, unknown, string>;

/** Queue errors repeat while Redis is down; one line per interval is logged (the Redis client logs the cause itself). */
const ERROR_LOG_INTERVAL_MS = 30_000;
/** A producer left waiting this long for a close is dropped, so a dead Redis cannot hold up the shutdown. */
const CLOSE_WAIT_MS = 2_000;

/**
 * Owns one BullMQ `Queue` per registered queue and adds jobs to them.
 *
 * Why: decision 020 puts every piece of async work on a named queue with its own defaults, and decision 006 wants a
 * producer to fail fast when the queue Redis is down. The queues use the process-wide producer client (no offline
 * queue) and `skipWaitingForReady` + `skipVersionCheck`: without them a `Queue` waits for the connection's first
 * `ready` and `add` hangs while Redis is down at startup; with only `skipWaitingForReady` the `Queue` stays broken for
 * ever after the first failure. With both, `add` rejects at once while Redis is away and works again by itself when it
 * is back (`test/integration/queues.test.ts` proves both).
 *
 * Side effects: `onModuleInit` creates the queues (the constructor never touches Redis, so the OpenAPI generator can
 * build the app offline); `add` writes BullMQ keys under `BULL_PREFIX` on the queue Redis; `onApplicationShutdown` closes
 * the queues (the shared Redis client is closed by `RedisService`).
 *
 * @see docs/decisions/006-redis-topology.md and docs/decisions/020-outbox-and-queues.md
 */
@Injectable()
export class QueuesService implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(QueuesService.name);
  private readonly throttle = new LogThrottle(ERROR_LOG_INTERVAL_MS);
  private readonly queues = new Map<QueueName, JobQueue>();

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly redis: RedisService,
  ) {}

  /** Creates the producers. They do not wait for Redis, so the app starts even when the queue Redis is down. */
  onModuleInit(): void {
    for (const name of QUEUE_NAMES) this.queues.set(name, this.create(name));
  }

  /**
   * Returns the producer of a queue, for reads (counts, schedulers) and for features BullMQ offers directly.
   * Prefer {@link QueuesService.add} for adding jobs: it fails with `UNAVAILABLE` when Redis is down.
   *
   * @param name a registered queue
   * @returns the BullMQ `Queue`
   * @throws {Error} when the module has not been initialised yet (a programming error)
   */
  queue(name: QueueName): JobQueue {
    const queue = this.queues.get(name);
    if (!queue) throw new Error(`The queues are not initialised yet (asked for "${name}"): wait for onModuleInit.`);
    return queue;
  }

  /**
   * Lists every producer.
   *
   * @returns queue name and `Queue` pairs, in registry order
   */
  list(): ReadonlyArray<readonly [QueueName, JobQueue]> {
    return [...this.queues];
  }

  /**
   * Adds a job to a queue.
   *
   * Why: this is the one door for producers. It keeps the current request id on the job (`data.requestId`) so one id
   * joins API, outbox, worker and supplier logs (decision 012), applies the queue's retry and retention defaults
   * (decision 020), and turns "Redis is down" into a `503 UNAVAILABLE` the caller can keep in Postgres (the outbox).
   *
   * Idempotency: pass a deterministic `jobId` (`queueJobId('order-poll', orderId)`); adding the same id again while the
   * first job is retained creates nothing.
   *
   * @param name the queue
   * @param jobName the job name; processors may be registered per job name
   * @param data ids only: no secrets, no personal data (CLAUDE.md, jobs)
   * @param options BullMQ job options on top of the queue's defaults (`jobId`, `delay`, `priority`, ...)
   * @returns the job (an existing one when the `jobId` was already taken)
   * @throws {AppError} `UNAVAILABLE` when the queue Redis cannot take the job right now
   * @throws {Error} the BullMQ error for a mistake in the call (a `jobId` with ":" or only digits, an oversized payload)
   */
  async add(name: QueueName, jobName: string, data: object, options?: JobsOptions): Promise<QueuedJob> {
    const requestId = getRequestId();
    const payload = requestId !== undefined && !('requestId' in data) ? { ...data, requestId } : data;
    try {
      return await this.queue(name).add(jobName, payload, options);
    } catch (error) {
      if (!isQueueUnavailableError(error)) throw error;
      throw new AppError('UNAVAILABLE', {
        detail: 'The job queue is not available right now.',
        cause: error,
        retryAfterSeconds: 5,
      });
    }
  }

  /** Closes the producers; never throws, because a dead Redis must not block the shutdown. */
  async onApplicationShutdown(): Promise<void> {
    const queues = [...this.queues.values()];
    this.queues.clear();
    await Promise.all(
      queues.map((queue) =>
        withTimeout(queue.close(), CLOSE_WAIT_MS, `Closing queue ${queue.name}`).catch(() =>
          queue.disconnect().catch(() => undefined),
        ),
      ),
    );
  }

  private create(name: QueueName): JobQueue {
    const queue: JobQueue = new Queue<object, unknown, string>(name, {
      connection: this.redis.queue,
      prefix: this.config.redis.bullPrefix,
      skipWaitingForReady: true,
      skipVersionCheck: true,
      defaultJobOptions: defaultJobOptions(name),
    });
    // Without an error listener BullMQ would throw the first connection error as an uncaught exception.
    queue.on('error', (error: Error) => {
      const allowed = this.throttle.attempt('queue:error');
      if (!allowed) return;
      const more = allowed.suppressed > 0 ? ` (${allowed.suppressed} similar errors not logged)` : '';
      this.logger.warn(`Queue ${name} error: ${withoutCredentials(error.message)}${more}`);
    });
    return queue;
  }
}

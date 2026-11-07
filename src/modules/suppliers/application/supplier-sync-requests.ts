// SupplierSyncRequests: how the API asks the worker for a sync and waits for its counts (resolution orders-suppliers-6, B25): it adds a
// `supplier_sync` job to the `supplier-sync` queue and waits on the queue's events for up to `timeout_ms + 5 s`.
import { Inject, Injectable, type OnApplicationShutdown } from '@nestjs/common';
import { QueueEvents } from 'bullmq';
import type { Redis } from 'ioredis';
import { CLOCK, type Clock } from '../../../common/clock';
import { AppError } from '../../../common/errors';
import { withTimeout } from '../../../common/timeout';
import { APP_CONFIG, type AppConfig } from '../../../config';
import { QueuesService, queueJobId } from '../../../infra/queues';
import { RedisService } from '../../../infra/redis';
import type { SyncOutcome } from './supplier-sync';

/** The job name of a supplier sync on the `supplier-sync` queue. */
export const SUPPLIER_SYNC_JOB = 'supplier_sync';

/** The data of a sync job: the supplier and who asked (ids only). */
export interface SupplierSyncJobData {
  readonly supplierId: number;
  /** `api` when staff asked (the route writes the audit row), `schedule` for the scheduled run. */
  readonly trigger: 'api' | 'schedule';
}

/** How the wait for a requested sync ended. */
export type SyncAnswer = { readonly state: 'done'; readonly outcome: SyncOutcome } | { readonly state: 'waiting' };

/** How long the API waits beyond the supplier's own timeout (the two calls of a sync, the transaction). */
export const SYNC_WAIT_MARGIN_MS = 5_000;

/** How long the first sync request waits for the events connection to be ready. */
const READY_WAIT_MS = 3_000;

/**
 * Requests a sync from the worker and waits for it.
 *
 * Why: B25 and orders-suppliers-6: the console needs the counts in the answer, but the work belongs to the worker (decision 020). The
 * job runs once (`attempts: 1`): a staff click is its own retry. A job still running when the wait ends is not stopped; the caller
 * answers `504 SUPPLIER_TIMEOUT` and the work finishes in the background.
 *
 * Side effects: adds a job to `supplier-sync`; holds one `QueueEvents` connection on the queue Redis, closed at shutdown.
 */
@Injectable()
export class SupplierSyncRequests implements OnApplicationShutdown {
  private events: QueueEvents | undefined;
  private connection: Redis | undefined;

  constructor(
    private readonly queues: QueuesService,
    private readonly redis: RedisService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /**
   * Queues a sync and waits for its outcome.
   *
   * @param supplierId the supplier
   * @param waitMs how long to wait (`timeout_ms + 5 s`)
   * @returns the outcome, or `waiting` when the job is still running after `waitMs`
   * @throws {AppError} `UNAVAILABLE` when the queue Redis cannot be reached
   * @throws {Error} when the job itself failed (an unexpected error in the worker)
   */
  async request(supplierId: number, waitMs: number): Promise<SyncAnswer> {
    const events = this.eventsOf();
    // With the queue Redis down the events connection never becomes ready: answer at once instead of holding the request.
    await withTimeout(events.waitUntilReady(), READY_WAIT_MS, 'Connecting to the queue events').catch(
      (error: unknown) => {
        throw new AppError('UNAVAILABLE', {
          detail: 'The job queue is not available right now.',
          cause: error,
          retryAfterSeconds: 5,
        });
      },
    );
    const data: SupplierSyncJobData = { supplierId, trigger: 'api' };
    const job = await this.queues.add('supplier-sync', SUPPLIER_SYNC_JOB, data, {
      jobId: queueJobId('manual-sync', supplierId, this.clock.nowMs()),
      attempts: 1,
    });
    try {
      return { state: 'done', outcome: (await job.waitUntilFinished(events, waitMs)) as SyncOutcome };
    } catch (error) {
      if (error instanceof Error && /timed out before finishing/i.test(error.message)) return { state: 'waiting' };
      throw error;
    }
  }

  /** Closes the events connection. */
  async onApplicationShutdown(): Promise<void> {
    const events = this.events;
    this.events = undefined;
    await events?.close().catch(() => undefined);
    this.connection?.disconnect();
    this.connection = undefined;
  }

  private eventsOf(): QueueEvents {
    if (!this.events) {
      this.connection = this.redis.createWorkerConnection();
      this.events = new QueueEvents('supplier-sync', {
        connection: this.connection,
        prefix: this.config.redis.bullPrefix,
      });
      this.events.on('error', () => undefined);
    }
    return this.events;
  }
}

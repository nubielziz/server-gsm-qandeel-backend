// Creates the repeating jobs of the JobSchedulerRegistry in Redis on every worker boot (decision 020): upsert is idempotent.
// Only the worker process runs it; if the queue Redis is down at boot it keeps trying in the background.
import { Injectable, Logger, type OnApplicationBootstrap, type OnModuleDestroy } from '@nestjs/common';
import type { RepeatOptions } from 'bullmq';
import { withoutCredentials } from '../redis';
import { type JobSchedulerSpec, JobSchedulerRegistry } from './job-schedulers';
import { QueuesService } from './queues.service';

/** The wait before the first retry of a failed sync, and the longest wait between retries. */
const RETRY_FIRST_MS = 1_000;
const RETRY_MAX_MS = 30_000;

/**
 * Turns a spec into BullMQ's repeat options.
 *
 * @param spec the schedule
 * @returns `{ every }` or `{ pattern, tz }`
 */
export function repeatOptionsOf(spec: JobSchedulerSpec): Omit<RepeatOptions, 'key'> {
  return spec.every !== undefined ? { every: spec.every } : { pattern: spec.pattern, tz: spec.tz ?? 'UTC' };
}

/**
 * Upserts every registered scheduler, and removes the retired ones, when the worker starts.
 *
 * Why: decision 020 says schedulers are created by `upsertJobScheduler` on every worker boot, so a fresh Redis or a new
 * deploy needs no manual step and two workers booting together create each schedule once. Upserting the same id and
 * settings changes nothing. If the queue Redis is down at boot the sync is retried with a growing wait (1 s up to 30 s)
 * until it works, so the worker does not need a restart when Redis comes back.
 *
 * Side effects: writes BullMQ scheduler keys (and the next delayed job of each scheduler) on the queue Redis.
 */
@Injectable()
export class JobSchedulerRunner implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(JobSchedulerRunner.name);
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private retryDelayMs = RETRY_FIRST_MS;
  private stopped = false;

  constructor(
    private readonly registry: JobSchedulerRegistry,
    private readonly queues: QueuesService,
  ) {}

  /** Runs the first sync; a failure starts the background retries instead of stopping the worker. */
  async onApplicationBootstrap(): Promise<void> {
    await this.sync();
  }

  /**
   * Upserts all registered schedulers once.
   *
   * @returns the number of schedulers that could not be written (0 when all are in place; the rest is retried later)
   */
  async sync(): Promise<number> {
    const failures: string[] = [];
    for (const spec of this.registry.list()) {
      try {
        await this.queues.queue(spec.queue).upsertJobScheduler(spec.id, repeatOptionsOf(spec), {
          name: spec.jobName,
          data: spec.data ?? {},
          ...(spec.jobOptions ? { opts: spec.jobOptions } : {}),
        });
      } catch (error) {
        failures.push(`${spec.queue}/${spec.id}: ${withoutCredentials(String(error))}`);
      }
    }
    for (const { queue, id } of this.registry.retired()) {
      try {
        await this.queues.queue(queue).removeJobScheduler(id);
      } catch (error) {
        failures.push(`${queue}/${id} (retire): ${withoutCredentials(String(error))}`);
      }
    }
    if (failures.length === 0) {
      this.retryDelayMs = RETRY_FIRST_MS;
      this.logger.log(`${this.registry.list().length} job schedulers are in place.`);
      return 0;
    }
    this.logger.warn(
      `${failures.length} job schedulers could not be written; retrying in ${this.retryDelayMs} ms: ${failures.join('; ')}`,
    );
    this.scheduleRetry();
    return failures.length;
  }

  /** Stops the retries; the schedulers stay in Redis for the next worker. */
  onModuleDestroy(): void {
    this.stopped = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
  }

  private scheduleRetry(): void {
    if (this.stopped || this.retryTimer) return;
    const delay = this.retryDelayMs;
    this.retryDelayMs = Math.min(delay * 2, RETRY_MAX_MS);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined;
      void this.sync();
    }, delay);
  }
}

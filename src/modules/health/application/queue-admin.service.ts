// The queue board's data and actions (`/admin/system/queues*`): live BullMQ counters, failed jobs, retry and pause, on the queue
// Redis through the `QueuesService` of decision 020. Both writes are audited with the demo's verb phrases (ANSWERS audit Q3).
import { Inject, Injectable } from '@nestjs/common';
import { CLOCK, type Clock } from '../../../common/clock';
import { AppError } from '../../../common/errors';
import { DbService } from '../../../infra/db';
import { QUEUE_NAMES, type QueueName, QueuesService, isQueueName } from '../../../infra/queues';
import { AuditService, OutboxService } from '../../platform';
import { type Measure, SPEC, measure } from '../domain/measure';
import { jobSubject, queueState } from '../domain/queue-verdict';
import { PrometheusClient } from './prometheus.client';
import { withoutCredentials } from '../../../infra/redis';

/** The longest failure text the failed-jobs list sends. */
const MAX_FAILED_REASON_LENGTH = 500;

/** The gauge `QueueMetrics` publishes for the age of the oldest waiting job; the trend charts it. */
export const OLDEST_WAITING_GAUGE = 'bullmq_queue_oldest_waiting_age_seconds';
const RATE_WINDOW_MS = 5 * 60_000;
const RATE_SAMPLE = 500;

/** The counters of one queue (wire shape of `QueueStats`). */
export interface QueueStatsView {
  name: string;
  state: 'ok' | 'warn' | 'crit' | 'unknown';
  paused: boolean;
  waiting: number;
  active: number;
  delayed: number;
  failed: number;
  oldestAge: Measure;
  ratePerMin: Measure;
  workers: number;
}

/** One failed job (wire shape of `FailedJob`). */
export interface FailedJobView {
  id: string;
  name: string;
  failedReason: string;
  attemptsMade: number;
  maxAttempts: number;
  failedAt: string;
  subject: string | null;
}

/**
 * Reads and controls the BullMQ queues for the System health pages.
 *
 * Why: the Queues tab shows what waits, runs and fails in the ten queues and lets staff retry failed jobs or pause a queue during an
 * incident; the console never talks to Redis. Jobs carry ids only (decision 020), so a failed job's payload is never sent: only a
 * `<kind> #<id>` subject.
 *
 * Side effects: reads the queue Redis; `retry` moves failed jobs back to waiting; `pause` pauses or resumes a queue for every worker;
 * both write one `audit_logs` row.
 */
@Injectable()
export class QueueAdminService {
  constructor(
    private readonly queues: QueuesService,
    private readonly db: DbService,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
    private readonly prom: PrometheusClient,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /**
   * The counters of every queue, the oldest waiting job of all and its 24-hour trend.
   *
   * @returns the queues in registry order
   * @throws {AppError} `UNAVAILABLE` when the queue Redis does not answer
   */
  async overview(): Promise<{
    queues: QueueStatsView[];
    oldestAge: Measure;
    trend: Array<{ at: string; value: number | null }>;
  }> {
    const queues = await this.guard(() => Promise.all(QUEUE_NAMES.map((name) => this.stats(name))));
    const oldest = Math.max(0, ...queues.map((queue) => queue.oldestAge.value ?? 0));
    return { queues, oldestAge: measure(SPEC.queueAge, oldest), trend: await this.trend() };
  }

  /**
   * The counters of one queue.
   *
   * @param name a registered queue
   * @returns its stats
   */
  async stats(name: QueueName): Promise<QueueStatsView> {
    const queue = this.queues.queue(name);
    const now = this.clock.nowMs();
    const [counts, paused, workers, oldest, finished] = await Promise.all([
      queue.getJobCounts('waiting', 'prioritized', 'active', 'delayed', 'failed'),
      queue.isPaused(),
      queue.getWorkersCount(),
      queue.getJobs(['waiting'], 0, 0, true),
      queue.getJobs(['completed'], 0, RATE_SAMPLE - 1, false),
    ]);
    let waiting = (counts.waiting ?? 0) + (counts.prioritized ?? 0);
    let oldestAge = Math.max(0, (now - (oldest[0]?.timestamp ?? now)) / 1000);
    if (name === 'outbox-relay') {
      // The outbox backlog is the relay queue's waiting work (B94): the rows not relayed yet, not the relay's own ticks.
      const backlog = await this.outbox.backlog(this.db.db);
      waiting = backlog.pending;
      oldestAge = backlog.oldestAgeSeconds;
    }
    const recent = finished.filter((job) => (job.finishedOn ?? 0) >= now - RATE_WINDOW_MS).length;
    const failed = counts.failed ?? 0;
    return {
      name,
      state: queueState({ oldestAgeSeconds: oldestAge, failed, paused, workers }),
      paused,
      waiting,
      active: counts.active ?? 0,
      delayed: counts.delayed ?? 0,
      failed,
      oldestAge: measure(SPEC.queueAge, oldestAge),
      ratePerMin: measure(SPEC.queueRate, recent / (RATE_WINDOW_MS / 60_000)),
      workers,
    };
  }

  /**
   * The failed jobs of a queue, newest failure first.
   *
   * @param name the queue name from the path
   * @param range the page (`start` inclusive, `end` exclusive)
   * @returns the rows and the number of failed jobs
   * @throws {AppError} `NOT_FOUND` for an unknown queue
   */
  async failed(name: string, range: { start: number; end: number }): Promise<{ rows: FailedJobView[]; total: number }> {
    const queue = this.queues.queue(this.known(name));
    const [jobs, total] = await this.guard(() =>
      Promise.all([queue.getJobs(['failed'], range.start, range.end - 1, false), queue.getFailedCount()]),
    );
    return {
      total,
      rows: jobs.map((job) => ({
        id: String(job.id ?? ''),
        name: job.name,
        // A failure message can quote a URL with its credentials (a connection error): those are cut, and the text is capped.
        failedReason: withoutCredentials(job.failedReason ?? '').slice(0, MAX_FAILED_REASON_LENGTH),
        attemptsMade: job.attemptsMade,
        maxAttempts: job.opts.attempts ?? 1,
        failedAt: new Date(job.finishedOn ?? job.timestamp).toISOString(),
        subject: jobSubject(job.data),
      })),
    };
  }

  /**
   * Moves one failed job, or every failed job, back to waiting.
   *
   * @param name the queue name from the path
   * @param body exactly one of `jobId` and `all`
   * @returns how many jobs were moved
   * @throws {AppError} `VALIDATION_FAILED` (field `jobId`) for neither or both; `NOT_FOUND` for an unknown queue or a job that did not fail
   */
  async retry(
    name: string,
    body: { jobId?: string | undefined; all?: true | undefined },
  ): Promise<{ retried: number }> {
    if ((body.jobId === undefined) === (body.all === undefined)) {
      throw new AppError('VALIDATION_FAILED', {
        errors: [{ field: 'jobId', code: 'invalid', message: 'Send either a jobId or all: true.' }],
      });
    }
    const queueName = this.known(name);
    const queue = this.queues.queue(queueName);
    let retried = 0;
    await this.guard(async () => {
      if (body.jobId !== undefined) {
        const job = await queue.getJob(body.jobId);
        if (!job || !(await job.isFailed())) {
          throw new AppError('NOT_FOUND', { detail: `There is no failed job "${body.jobId}" in queue ${queueName}.` });
        }
        await job.retry('failed');
        retried = 1;
      } else {
        retried = await queue.getFailedCount();
        if (retried > 0) await queue.retryJobs({ state: 'failed' });
      }
    });
    await this.db.runInTransaction(({ tx }) =>
      this.audit.record(tx, {
        action: 'retried failed jobs in',
        entityType: 'queue',
        entityLabel: queueName,
        after: body.jobId !== undefined ? { jobId: body.jobId, retried } : { all: true, retried },
      }),
    );
    return { retried };
  }

  /**
   * Pauses or resumes a queue.
   *
   * @param name the queue name from the path
   * @param body `paused` and, to pause, a `reason` of 3 or more characters
   * @returns the queue's counters after the change
   * @throws {AppError} `VALIDATION_FAILED` (field `reason`) when pausing without a reason; `NOT_FOUND` for an unknown queue
   */
  async pause(name: string, body: { paused: boolean; reason?: string | undefined }): Promise<QueueStatsView> {
    const queueName = this.known(name);
    const reason = body.reason?.trim() ?? '';
    if (body.paused && reason.length < 3) {
      throw new AppError('VALIDATION_FAILED', {
        errors: [{ field: 'reason', code: 'invalid', message: 'Say why the queue is paused (3 characters or more).' }],
      });
    }
    const queue = this.queues.queue(queueName);
    const wasPaused = await this.guard(async () => {
      const before = await queue.isPaused();
      // Pausing a paused queue keeps the original pause (and its audit entry's reason).
      if (body.paused && !before) await queue.pause();
      if (!body.paused && before) await queue.resume();
      return before;
    });
    await this.db.runInTransaction(({ tx }) =>
      this.audit.record(tx, {
        action: body.paused ? 'paused queue' : 'resumed queue',
        entityType: 'queue',
        entityLabel: queueName,
        before: { paused: wasPaused },
        after: body.paused ? { paused: true, reason, alreadyPaused: wasPaused } : { paused: false },
      }),
    );
    return this.guard(() => this.stats(queueName));
  }

  /** The oldest waiting job over the last 24 hours, 96 points; null points when Prometheus does not answer. */
  private async trend(): Promise<Array<{ at: string; value: number | null }>> {
    const now = this.clock.now();
    const step = 900;
    const end = new Date(Math.floor(now.getTime() / 1000 / step) * step * 1000);
    const start = new Date(end.getTime() - 95 * step * 1000);
    const stamps = Array.from({ length: 96 }, (_, i) => start.getTime() / 1000 + i * step);
    let values = new Map<number, number>();
    try {
      const rows = await this.prom.queryRange(
        `max(max_over_time(${OLDEST_WAITING_GAUGE}[${step}s]))`,
        start,
        end,
        step,
      );
      values = new Map((rows[0]?.values ?? []).map(([at, value]) => [at, value]));
    } catch {
      // Prometheus is optional: this read must not fail for it (docs/contract/endpoints/health.md).
    }
    return stamps.map((at) => {
      const value = values.get(at);
      return {
        at: new Date(at * 1000).toISOString(),
        value: value === undefined || !Number.isFinite(value) ? null : Math.round(value),
      };
    });
  }

  private known(name: string): QueueName {
    if (!isQueueName(name)) throw new AppError('NOT_FOUND', { detail: `There is no queue "${name}".` });
    return name;
  }

  private async guard<T>(work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError('UNAVAILABLE', {
        detail: 'The queue Redis is not answering right now.',
        cause: error,
        retryAfterSeconds: 5,
      });
    }
  }
}

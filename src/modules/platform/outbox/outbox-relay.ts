// The outbox relay (platform module, decision 020): moves pending outbox_events rows to BullMQ, exactly once per row.
// Runs only in the worker process: a one-second scheduler tick and a Postgres NOTIFY wake-up both call run().
import { Inject, Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';
import { CLOCK, type Clock } from '../../../common/clock';
import { AppError } from '../../../common/errors';
import { LogThrottle } from '../../../common/log-throttle';
import { DbService } from '../../../infra/db';
import { type QueueName, QueuesService, queueJobId } from '../../../infra/queues';
import { jobDataOf } from './outbox-payload';
import { OutboxRelayMetrics } from './outbox-relay.metrics';
import { OutboxRouteRegistry } from './outbox-routes';
import {
  type PendingOutboxEvent,
  lockPendingOutboxEvents,
  markOutboxFailed,
  markOutboxRelayed,
} from './outbox.repository';

/** Rows locked and relayed per transaction (decision 020). */
export const RELAY_BATCH_SIZE = 100;
/** Failures repeat on every pass; one line per reason and interval is logged. */
const LOG_INTERVAL_MS = 30_000;

/**
 * What one {@link OutboxRelay.run} call did, summed over its passes.
 *
 * Why: the tick job returns it as its result, so the job list shows what the relay did last.
 */
export interface RelayResult {
  /** Events handed to their queues. */
  readonly relayed: number;
  /** Events that could not be handed over (unknown type, queue refused the job); they are retried with a growing wait. */
  readonly failed: number;
  /** True when the pass stopped early because the queue Redis was unavailable; nothing is lost, the rows stay pending. */
  readonly queueUnavailable: boolean;
}

interface Pass {
  readonly selected: number;
  readonly relayed: ReadonlyArray<{ readonly queue: QueueName; readonly lagSeconds: number }>;
  readonly failed: number;
  readonly queueUnavailable: boolean;
}

/**
 * Hands pending outbox events to their queues.
 *
 * Why: decision 020. One pass is one transaction: select the oldest pending rows `FOR UPDATE SKIP LOCKED`, add one BullMQ
 * job per row (`jobId = outbox-<id>`) to the queue its event type maps to, and set `processed_at` in the same transaction.
 * A crash between the enqueue and the commit rolls the rows back and the next pass adds the same job ids again, which
 * BullMQ ignores while the first jobs are retained. `SKIP LOCKED` lets a second worker, or a NOTIFY wake-up beside the
 * tick, work on the same backlog without taking a row twice. When the queue Redis is down the pass stops and keeps every
 * row pending (no attempt is counted: the rows are not at fault); a row that cannot be handed over for its own reason
 * (no queue registered for its type, BullMQ refuses the job) counts an attempt and waits `2^attempts` seconds (at most
 * five minutes) before it is tried again.
 *
 * Single flight: calls that arrive while a run is going share it, and a call that arrives after its last look at the
 * table makes it look once more, so an event committed meanwhile is never left for the next tick.
 *
 * Side effects: reads and updates `outbox_events`; adds jobs to BullMQ queues; counts `outbox_events_relayed_total`,
 * `outbox_relay_lag_seconds` and `outbox_relay_failures_total`.
 *
 * @see docs/queues.md and docs/decisions/020-outbox-and-queues.md
 */
@Injectable()
export class OutboxRelay implements OnModuleDestroy {
  private readonly logger = new Logger(OutboxRelay.name);
  private readonly throttle = new LogThrottle(LOG_INTERVAL_MS);
  private flight: Promise<RelayResult> | undefined;
  private again = false;
  private closing = false;

  constructor(
    private readonly db: DbService,
    private readonly queues: QueuesService,
    private readonly routes: OutboxRouteRegistry,
    private readonly metrics: OutboxRelayMetrics,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /**
   * Relays everything that is pending now (in batches of 100) and returns.
   *
   * @returns what the run did; resolves with zeros when the relay is shutting down
   * @throws {Error} when the database fails (the rows stay pending; the next tick tries again)
   */
  run(): Promise<RelayResult> {
    if (this.closing) return Promise.resolve({ relayed: 0, failed: 0, queueUnavailable: false });
    if (this.flight) {
      this.again = true;
      return this.flight;
    }
    // loop() awaits before it can return, so its `finally` cannot clear `flight` before this assignment.
    const flight = this.loop();
    this.flight = flight;
    return flight;
  }

  /** Starts a run in the background and logs a failure instead of throwing it: used by the NOTIFY wake-up. */
  wake(): void {
    this.run().catch((error: unknown) => {
      const allowed = this.throttle.attempt('run:error');
      if (allowed)
        this.logger.warn(`Outbox relay run failed: ${error instanceof Error ? error.message : String(error)}`);
    });
  }

  /** Stops starting new passes and waits for the one that is running. */
  async onModuleDestroy(): Promise<void> {
    this.closing = true;
    await this.flight?.catch(() => undefined);
  }

  private async loop(): Promise<RelayResult> {
    const total = { relayed: 0, failed: 0, queueUnavailable: false };
    try {
      for (;;) {
        this.again = false;
        for (;;) {
          if (this.closing) break;
          const pass = await this.pass();
          total.relayed += pass.relayed.length;
          total.failed += pass.failed;
          total.queueUnavailable ||= pass.queueUnavailable;
          if (pass.queueUnavailable || pass.selected < RELAY_BATCH_SIZE) break;
        }
        // Checked right after the last await, with no await before `finally` clears `flight`: a wake-up cannot slip in
        // between. With the queue Redis down another look would only fail again, so the next tick does it.
        if (!this.again || this.closing || total.queueUnavailable) return total;
      }
    } finally {
      this.flight = undefined;
    }
  }

  private async pass(): Promise<Pass> {
    let pass: Pass;
    try {
      pass = await this.db.runInTransaction(async ({ tx }) => {
        const now = this.clock.now();
        const rows = await lockPendingOutboxEvents(tx, RELAY_BATCH_SIZE, now);
        const relayed: Array<{ id: number; queue: QueueName; lagSeconds: number }> = [];
        const failed: number[] = [];
        let queueUnavailable = false;
        for (const row of rows) {
          const outcome = await this.relayRow(row);
          if (outcome === 'unavailable') {
            queueUnavailable = true;
            break;
          }
          if (outcome === 'failed') failed.push(row.id);
          else relayed.push({ id: row.id, queue: outcome.queue, lagSeconds: row.lagSeconds });
        }
        await markOutboxRelayed(
          tx,
          relayed.map((entry) => entry.id),
          now,
        );
        await markOutboxFailed(tx, failed, now);
        return { selected: rows.length, relayed, failed: failed.length, queueUnavailable };
      });
    } catch (error) {
      this.metrics.recordFailure('database_error');
      throw error;
    }
    // The transaction committed: only now do the rows count as relayed.
    const byQueue = new Map<QueueName, number[]>();
    for (const entry of pass.relayed) byQueue.set(entry.queue, [...(byQueue.get(entry.queue) ?? []), entry.lagSeconds]);
    for (const [queue, lags] of byQueue) this.metrics.recordRelayed(queue, lags);
    if (pass.queueUnavailable) {
      this.metrics.recordFailure('queue_unavailable');
      this.logFailure(
        'queue_unavailable',
        'The queue Redis is not available; outbox events stay pending until it is back.',
      );
    }
    return pass;
  }

  /** Adds the job of one row. Returns the queue it went to, `failed` for a fault of the row, or `unavailable`. */
  private async relayRow(row: PendingOutboxEvent): Promise<{ queue: QueueName } | 'failed' | 'unavailable'> {
    const route = this.routes.get(row.type);
    if (!route) {
      this.metrics.recordFailure('unmapped_type');
      this.logFailure(
        'unmapped_type',
        `No queue is registered for the outbox event type "${row.type}" (event ${row.id}); it stays pending.`,
      );
      return 'failed';
    }
    try {
      await this.queues.add(route.queue, route.jobName ?? row.type, jobDataOf(row), {
        jobId: queueJobId('outbox', row.id),
      });
      return { queue: route.queue };
    } catch (error) {
      if (error instanceof AppError && error.code === 'UNAVAILABLE') return 'unavailable';
      this.metrics.recordFailure('enqueue_error');
      this.logFailure(
        'enqueue_error',
        `Outbox event ${row.id} (${row.type}) could not be added to ${route.queue}: ${error instanceof Error ? error.message : String(error)}`,
      );
      return 'failed';
    }
  }

  private logFailure(reason: string, message: string): void {
    const allowed = this.throttle.attempt(`failure:${reason}`);
    if (!allowed) return;
    const more = allowed.suppressed > 0 ? ` (${allowed.suppressed} similar failures not logged)` : '';
    this.logger.warn(`${message}${more}`);
  }
}

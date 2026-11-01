// Prometheus metrics of the outbox relay (platform module, decision 015): throughput, lag, failures and the backlog.
import { Injectable } from '@nestjs/common';
import { Counter, Gauge, Histogram } from 'prom-client';
import { withTimeout } from '../../../common/timeout';
import { DbService } from '../../../infra/db';
import { MetricsService } from '../../../infra/metrics';
import type { QueueName } from '../../../infra/queues';
import { OutboxService } from './outbox.service';
import type { OutboxBacklog } from './outbox.types';

/** Why a row was not handed to its queue. */
export type RelayFailureReason = 'unmapped_type' | 'enqueue_error' | 'queue_unavailable' | 'database_error';

/** A scrape must not wait for a stalled database. */
const SCRAPE_WAIT_MS = 1_500;

/**
 * The relay's counters, the lag histogram and the two backlog gauges.
 *
 * Why: decision 015 asks for lag and throughput of the outbox: `outbox_events_relayed_total{queue}` is the throughput,
 * `outbox_relay_lag_seconds` the time between the commit of an event and its hand-over to a queue,
 * `outbox_relay_failures_total{reason}` what went wrong, and `outbox_pending_events` / `outbox_oldest_pending_age_seconds`
 * the backlog that the System health queue board shows for the `outbox-relay` queue. The gauges read the table when the
 * registry is scraped; when the database cannot be read they are left out of the scrape.
 */
@Injectable()
export class OutboxRelayMetrics {
  private readonly relayed: Counter<'queue'>;
  private readonly failures: Counter<'reason'>;
  private readonly lag: Histogram;
  private snapshot: Promise<OutboxBacklog | undefined> | undefined;

  constructor(
    metrics: MetricsService,
    private readonly db: DbService,
    private readonly outbox: OutboxService,
  ) {
    this.relayed = new Counter({
      name: 'outbox_events_relayed_total',
      help: 'Outbox events handed to their queue, by queue.',
      labelNames: ['queue'],
      registers: [metrics.registry],
    });
    this.failures = new Counter({
      name: 'outbox_relay_failures_total',
      help: 'Outbox events the relay could not hand over, by reason.',
      labelNames: ['reason'],
      registers: [metrics.registry],
    });
    this.lag = new Histogram({
      name: 'outbox_relay_lag_seconds',
      help: 'Seconds from writing an outbox event to handing it to its queue.',
      buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 30, 60, 300],
      registers: [metrics.registry],
    });
    const pending: Gauge = new Gauge({
      name: 'outbox_pending_events',
      help: 'Outbox events not yet handed to a queue.',
      registers: [metrics.registry],
      collect: async () => {
        const backlog = await this.read();
        // `reset()` would leave a 0 behind for a gauge without labels: an unreadable table must not look like an empty one.
        if (backlog) pending.set(backlog.pending);
        else pending.remove();
      },
    });
    const oldest: Gauge = new Gauge({
      name: 'outbox_oldest_pending_age_seconds',
      help: 'Age of the oldest outbox event that is not yet handed to a queue; 0 when none waits.',
      registers: [metrics.registry],
      collect: async () => {
        const backlog = await this.read();
        if (backlog) oldest.set(backlog.oldestAgeSeconds);
        else oldest.remove();
      },
    });
  }

  /**
   * Counts events handed over after their transaction committed.
   *
   * @param queue the queue they went to
   * @param lagSeconds the wait of each event, by the injected clock
   */
  recordRelayed(queue: QueueName, lagSeconds: readonly number[]): void {
    this.relayed.inc({ queue }, lagSeconds.length);
    for (const lag of lagSeconds) this.lag.observe(Math.max(0, lag));
  }

  /**
   * Counts a failure.
   *
   * @param reason what went wrong
   */
  recordFailure(reason: RelayFailureReason): void {
    this.failures.inc({ reason });
  }

  /**
   * Reads the backlog once per scrape: the registry collects both gauges in the same turn of the event loop, so the first
   * fetches and the other shares the result; the next turn forgets it, so the next scrape reads fresh numbers.
   */
  private read(): Promise<OutboxBacklog | undefined> {
    if (!this.snapshot) {
      this.snapshot = withTimeout(this.outbox.backlog(this.db.db), SCRAPE_WAIT_MS, 'Reading the outbox backlog').catch(
        () => undefined,
      );
      setImmediate(() => {
        this.snapshot = undefined;
      });
    }
    return this.snapshot;
  }
}

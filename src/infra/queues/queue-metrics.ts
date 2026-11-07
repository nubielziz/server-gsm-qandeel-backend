// Prometheus gauges of every BullMQ queue (jobs per state, paused flag), read from the queue Redis when the registry is scraped.
import { Inject, Injectable } from '@nestjs/common';
import { Gauge } from 'prom-client';
import { CLOCK, type Clock } from '../../common/clock';
import { withTimeout } from '../../common/timeout';
import { MetricsService } from '../metrics';
import type { QueueName } from './queue-definitions';
import { QueuesService } from './queues.service';

/** The states BullMQ counts (a paused queue keeps its jobs as `waiting`); every one is a series. */
export const QUEUE_JOB_STATES = [
  'waiting',
  'active',
  'delayed',
  'failed',
  'completed',
  'prioritized',
  'waiting-children',
] as const;

/** A scrape must not wait for a stalled Redis. */
const SCRAPE_WAIT_MS = 1_500;

interface QueueReading {
  readonly queue: QueueName;
  readonly counts: Readonly<Record<string, number>>;
  readonly paused: boolean;
  /** When the oldest waiting job was added (ms since the epoch), or `null` when nothing waits. */
  readonly oldestWaitingAt: number | null;
}

/**
 * Publishes `bullmq_queue_jobs{queue,state}` and `bullmq_queue_paused{queue}`.
 *
 * Why: decision 015 wants BullMQ gauges per queue and state, read on scrape; the System health trend (oldest waiting
 * job, backlog), the alert rules and the "queue left paused" warning chart them. Both the API and the worker expose the
 * gauges (every process sees the same queues), so a dashboard takes `max by (queue, state)` and still has data when the
 * worker is the thing that died.
 *
 * Side effects: sends `getJobCounts` and `isPaused` for each queue to the queue Redis on every scrape of `/metrics`. When a
 * queue cannot be read its series are left out of the scrape (a missing series, not a stale number).
 */
@Injectable()
export class QueueMetrics {
  private snapshot: Promise<QueueReading[]> | undefined;

  constructor(
    metrics: MetricsService,
    private readonly queues: QueuesService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {
    const jobs: Gauge<'queue' | 'state'> = new Gauge({
      name: 'bullmq_queue_jobs',
      help: 'Jobs in a BullMQ queue, by queue and state.',
      labelNames: ['queue', 'state'],
      registers: [metrics.registry],
      collect: async () => {
        const readings = await this.read();
        jobs.reset();
        for (const { queue, counts } of readings) {
          for (const state of QUEUE_JOB_STATES) jobs.set({ queue, state }, counts[state] ?? 0);
        }
      },
    });
    const paused: Gauge<'queue'> = new Gauge({
      name: 'bullmq_queue_paused',
      help: '1 when a BullMQ queue is paused (workers take no jobs), else 0.',
      labelNames: ['queue'],
      registers: [metrics.registry],
      collect: async () => {
        const readings = await this.read();
        paused.reset();
        for (const reading of readings) paused.set({ queue: reading.queue }, reading.paused ? 1 : 0);
      },
    });
    const oldest: Gauge<'queue'> = new Gauge({
      name: 'bullmq_queue_oldest_waiting_age_seconds',
      help: 'Seconds since the oldest waiting job of a BullMQ queue was added; 0 when nothing waits.',
      labelNames: ['queue'],
      registers: [metrics.registry],
      collect: async () => {
        const readings = await this.read();
        oldest.reset();
        for (const reading of readings) {
          const age =
            reading.oldestWaitingAt === null ? 0 : Math.max(0, (this.clock.nowMs() - reading.oldestWaitingAt) / 1000);
          oldest.set({ queue: reading.queue }, age);
        }
      },
    });
  }

  /**
   * Reads every queue once per scrape: the registry collects all gauges in the same turn of the event loop, so the first
   * gauge fetches and the other one shares the result; the next turn forgets it, so the next scrape reads fresh numbers.
   */
  private read(): Promise<QueueReading[]> {
    if (!this.snapshot) {
      this.snapshot = this.fetch();
      setImmediate(() => {
        this.snapshot = undefined;
      });
    }
    return this.snapshot;
  }

  private async fetch(): Promise<QueueReading[]> {
    const readings = await Promise.all(
      this.queues.list().map(async ([queue, producer]): Promise<QueueReading | undefined> => {
        try {
          const [counts, paused, oldest] = await withTimeout(
            Promise.all([
              producer.getJobCounts(...QUEUE_JOB_STATES),
              producer.isPaused(),
              producer.getJobs(['waiting'], 0, 0, true),
            ]),
            SCRAPE_WAIT_MS,
            `Reading queue ${queue}`,
          );
          return { queue, counts, paused, oldestWaitingAt: oldest[0]?.timestamp ?? null };
        } catch {
          // Unreachable queue Redis: this queue has no series in the scrape.
          return undefined;
        }
      }),
    );
    return readings.filter((reading): reading is QueueReading => reading !== undefined);
  }
}

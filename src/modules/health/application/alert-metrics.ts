// The values of the eleven alert metrics (feature 12b): where each one is read from, per subject. The evaluator asks for a metric and gets one
// reading per supplier, per queue or one for the platform, from the sources feature 9 already reads (Prometheus, Postgres, the queues, Redis).
import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { CLOCK, type Clock } from '../../../common/clock';
import { DbService } from '../../../infra/db';
import { QUEUE_NAMES, QueuesService } from '../../../infra/queues';
import { RedisService } from '../../../infra/redis';
import { OutboxService } from '../../platform';
import { SYSTEM_SUBJECT, type AlertSubject } from '../domain/alert-evaluation';
import { INTEGRITY_JOB } from '../domain/integrity';
import type { MetricKey } from '../domain/metric-registry';
import { stuckOrders, suppliersForHealth, supplierCalls, webhookOutcomes } from '../infra/foreign-reads.repository';
import { PrometheusClient } from './prometheus.client';
import { expressions } from './traffic.service';

/** One measured value of one subject; `null` is "no data" (no calls in the window, no sample yet). */
export interface Reading {
  readonly subject: AlertSubject;
  readonly value: number | null;
}

/** The single reading of a metric that belongs to the whole platform. */
const system = (value: number | null): Reading[] => [{ subject: SYSTEM_SUBJECT, value }];

const finite = (value: number | undefined): number | null =>
  value === undefined || !Number.isFinite(value) ? null : value;

function infoNumber(info: string, key: string): number | null {
  const match = new RegExp(`^${key}:(\\d+(?:\\.\\d+)?)`, 'm').exec(info);
  return match ? Number(match[1]) : null;
}

/**
 * Reads the value of an alert metric.
 *
 * Why: RESOLUTIONS health-commissions-13 and -14 give every metric a unit and a subject; the numbers come from the sources the System health
 * pages read, so an alert and the page that shows it agree. A source that does not answer throws (`MONITORING_UNAVAILABLE` for Prometheus, a
 * Redis or queue error): the evaluator skips that rule for the run and says so in the run's result (ANSWERS Q15: rules on Postgres, BullMQ, Redis or
 * supplier-log metrics still work while Prometheus is down).
 *
 * Side effects: reads Postgres, both Redis roles, the queues and Prometheus; no writes.
 */
@Injectable()
export class AlertMetricReader {
  constructor(
    private readonly db: DbService,
    private readonly redis: RedisService,
    private readonly queues: QueuesService,
    private readonly outbox: OutboxService,
    private readonly prometheus: PrometheusClient,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /**
   * Reads one metric.
   *
   * @param metric the registry key
   * @param windowSeconds the rule's window: the period a rate or percentile is measured over (the other metrics read the moment)
   * @param now the clock's time, taken once per evaluation run
   * @returns one reading per subject; a subject that no longer exists has none
   * @throws {AppError} `MONITORING_UNAVAILABLE` when a Prometheus metric cannot be read; any other error when its store does not answer
   */
  async read(metric: MetricKey, windowSeconds: number, now: Date): Promise<Reading[]> {
    const since = new Date(now.getTime() - windowSeconds * 1000);
    switch (metric) {
      case 'supplier.timeout_rate':
        return this.supplierRate(since, (calls) => calls.timeouts);
      case 'supplier.error_rate':
        return this.supplierRate(since, (calls) => calls.errors);
      case 'supplier.balance':
        return this.supplierBalance();
      case 'api.p95':
        return this.prometheusValue(expressions(`${windowSeconds}s`, '', '').p95, now);
      case 'api.rate5xx':
        return this.prometheusValue(expressions(`${windowSeconds}s`, '', '').rate5xx, now);
      case 'queue.oldest_age':
        return this.queueAges(now);
      case 'orders.past_sla':
        return system((await stuckOrders(this.db.db, now)).reduce((sum, row) => sum + row.count, 0));
      case 'ledger.mismatch_count':
        return system(await this.mismatchCount());
      case 'db.connection_usage':
        return system(await this.connectionUsage());
      case 'redis.memory_usage':
        return system(await this.redisMemory());
      case 'webhooks.success_rate': {
        const { delivered, failed } = await webhookOutcomes(this.db.db, since);
        return system(delivered + failed === 0 ? null : (delivered / (delivered + failed)) * 100);
      }
    }
  }

  /** Percent of the calls of each supplier that timed out or failed in the window; a disabled supplier has its checks off and is left out. */
  private async supplierRate(
    since: Date,
    pick: (calls: { total: number; errors: number; timeouts: number }) => number,
  ): Promise<Reading[]> {
    const [suppliers, calls] = await Promise.all([suppliersForHealth(this.db.db), supplierCalls(this.db.db, since)]);
    return suppliers
      .filter((supplier) => supplier.status !== 'disabled')
      .map((supplier) => {
        const figures = calls.get(supplier.id);
        return {
          subject: { type: 'supplier', id: supplier.id, label: supplier.name },
          value: figures && figures.total > 0 ? (pick(figures) / figures.total) * 100 : null,
        };
      });
  }

  /** The balance of each supplier in its own currency; a supplier whose balance was never read has no value (its 0 is not a reading). */
  private async supplierBalance(): Promise<Reading[]> {
    const suppliers = await suppliersForHealth(this.db.db);
    return suppliers
      .filter((supplier) => supplier.status !== 'disabled')
      .map((supplier) => ({
        subject: { type: 'supplier', id: supplier.id, label: supplier.name },
        value: supplier.balanceCheckedAt === null ? null : Number(supplier.balance),
      }));
  }

  private async prometheusValue(promql: string, now: Date): Promise<Reading[]> {
    const rows = await this.prometheus.query(promql, now);
    return system(finite(rows[0]?.value));
  }

  /** The age in seconds of the oldest waiting job of each queue (the outbox relay's age is the age of its oldest unrelayed event). */
  private async queueAges(now: Date): Promise<Reading[]> {
    return Promise.all(
      QUEUE_NAMES.map(async (name): Promise<Reading> => {
        let age: number;
        if (name === 'outbox-relay') {
          age = (await this.outbox.backlog(this.db.db)).oldestAgeSeconds;
        } else {
          const [oldest] = await this.queues.queue(name).getJobs(['waiting'], 0, 0, true);
          age = Math.max(0, (now.getTime() - (oldest?.timestamp ?? now.getTime())) / 1000);
        }
        return { subject: { type: 'queue', id: null, label: name }, value: age };
      }),
    );
  }

  /** The mismatch count of the newest succeeded integrity run; `null` before the first run. */
  private async mismatchCount(): Promise<number | null> {
    const result = await this.db.db.execute<{ n: string | null }>(sql`
      select result->>'mismatchCount' as n from job_runs
      where job = ${INTEGRITY_JOB} and status = 'succeeded'
      order by started_at desc, id desc limit 1`);
    const text = result.rows[0]?.n;
    return text === undefined || text === null ? null : finite(Number(text));
  }

  private async connectionUsage(): Promise<number | null> {
    const result = await this.db.db.execute<{ used: number; max: number }>(
      sql`select (select count(*) from pg_stat_activity where datname = current_database())::int as used, current_setting('max_connections')::int as max`,
    );
    const row = result.rows[0];
    return row && row.max > 0 ? (row.used / row.max) * 100 : null;
  }

  /** The fuller of the two Redis roles (both set `maxmemory`, decision 006); a role with no limit has no usage. */
  private async redisMemory(): Promise<number | null> {
    const infos = await Promise.all([this.redis.cache.info('memory'), this.redis.queue.info('memory')]);
    const usages = infos.flatMap((info) => {
      const used = infoNumber(info, 'used_memory');
      const max = infoNumber(info, 'maxmemory');
      return used === null || max === null || max <= 0 ? [] : [(used / max) * 100];
    });
    return usages.length === 0 ? null : Math.max(...usages);
  }
}

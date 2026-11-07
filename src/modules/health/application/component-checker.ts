// The checker behind the `service_checks` rows (health module, resolutions health-commissions-6, -7): one pass checks the core
// components and every active supplier and writes one row each. Run once a minute by the worker (jobs/health-processors.ts).
import { Inject, Injectable, Optional } from '@nestjs/common';
import { CLOCK, type Clock } from '../../../common/clock';
import { DbService } from '../../../infra/db';
import { HealthRegistry } from '../../../infra/health';
import { QUEUE_NAMES, QueuesService } from '../../../infra/queues';
import { CacheKeys } from '../../../infra/cache';
import { RedisService } from '../../../infra/redis';
import type { CheckStatus, NewServiceCheck } from '../db/schema';
import { API_HEARTBEAT_NAME } from './api-heartbeat';
import { insertChecks } from '../infra/service-checks.repository';
import { suppliersForHealth, supplierCalls } from '../infra/foreign-reads.repository';
import { suppliers as suppliersApi } from '../infra/sibling-modules';

const HEARTBEAT_FRESH_MS = 90_000;
const INDICATOR_TIMEOUT_MS = 2_000;
const QUARTER_HOUR_MS = 15 * 60_000;

/** The injection token of an optional mail check (feature 12a provides one). */
export const MAIL_PROBE = Symbol.for('gsm.MAIL_PROBE');

/** What a probe reports: the status and a short English text when it is not ok. */
export interface ProbeResult {
  readonly status: CheckStatus;
  readonly detail?: string | null;
}

/** A check of one component (the mail relay), provided by the module that owns the component. */
export interface HealthProbe {
  check(): Promise<ProbeResult>;
}

/** What one pass did, for the run's `result`. */
export interface CheckerReport {
  readonly checked: number;
  readonly down: number;
  readonly degraded: number;
  readonly cacheEvictedKeys: number | null;
  readonly cacheHits: number | null;
  readonly cacheMisses: number | null;
}

const INDICATORS: Readonly<Record<string, string>> = {
  postgres: 'postgres',
  redis: 'redis',
  redis_queue: 'redis_queue',
  storage: 'storage',
};

function infoNumber(info: string, key: string): number | null {
  const match = new RegExp(`^${key}:(\\d+)`, 'm').exec(info);
  return match ? Number(match[1]) : null;
}

/**
 * Checks the platform's components and records the results.
 *
 * Why: the System health pages, the uptime figures and the alert rules of feature 12b all read `service_checks`; this is the only
 * writer. `detail` is null when a component is ok and a short English text when it is degraded or down (never an error text from a
 * driver: those carry hostnames). A disabled supplier gets no row (the page says "checks are off"); a supplier with no calls in the
 * last 15 minutes gets `unknown`. Gateway checks (`gateway:<id>`) arrive with the billing feature.
 *
 * Side effects: inserts `service_checks` rows; reads the infrastructure indicators, the cache Redis heartbeat and `INFO`, the queue
 * workers and the supplier call log; all times come from the injected clock.
 */
@Injectable()
export class ComponentChecker {
  constructor(
    private readonly db: DbService,
    private readonly registry: HealthRegistry,
    private readonly queues: QueuesService,
    private readonly redis: RedisService,
    private readonly keys: CacheKeys,
    @Inject(CLOCK) private readonly clock: Clock,
    @Optional() @Inject(MAIL_PROBE) private readonly mail?: HealthProbe,
  ) {}

  /**
   * Runs one pass.
   *
   * @returns the counts of the pass and the cache Redis counters it sampled
   * @throws {Error} when the rows cannot be written (Postgres down); the job is retried by its queue
   */
  async runOnce(): Promise<CheckerReport> {
    const now = this.clock.now();
    const rows: NewServiceCheck[] = [];
    const add = (
      component: string,
      result: ProbeResult,
      latencyMs: number | null,
      ids: Partial<NewServiceCheck> = {},
    ) =>
      rows.push({
        component,
        status: result.status,
        latencyMs,
        detail: result.status === 'degraded' || result.status === 'down' ? (result.detail ?? null) : null,
        checkedAt: now,
        ...ids,
      });

    for (const indicator of this.registry.list()) {
      const component = INDICATORS[indicator.name];
      if (!component) continue;
      const [result, ms] = await this.timed(async () => {
        try {
          const outcome = await Promise.race([
            indicator.check(),
            new Promise<never>((_resolve, reject) =>
              setTimeout(() => reject(new Error('timeout')), INDICATOR_TIMEOUT_MS).unref(),
            ),
          ]);
          return outcome === false
            ? ({ status: 'down', detail: 'Check failed' } as const)
            : ({ status: 'ok' } as const);
        } catch (error) {
          return {
            status: 'down',
            detail:
              error instanceof Error && error.message === 'timeout'
                ? `Timed out after ${INDICATOR_TIMEOUT_MS} ms`
                : 'Check failed',
          } as const;
        }
      });
      add(component, result, ms);
    }
    const [apiResult] = await this.timed(() => this.apiHeartbeat(now));
    add('api', apiResult, null);
    add('workers', await this.workers(), null);
    if (this.mail)
      add('mail', await this.mail.check().catch(() => ({ status: 'down', detail: 'Check failed' }) as const), null);
    await this.suppliers(now, add);
    await insertChecks(this.db.db, rows);
    return {
      checked: rows.length,
      down: rows.filter((r) => r.status === 'down').length,
      degraded: rows.filter((r) => r.status === 'degraded').length,
      ...(await this.cacheCounters()),
    };
  }

  private async timed<T>(work: () => Promise<T>): Promise<[T, number]> {
    const started = performance.now();
    const result = await work();
    return [result, Math.max(0, Math.round(performance.now() - started))];
  }

  private async apiHeartbeat(now: Date): Promise<ProbeResult> {
    let beat: string | null;
    try {
      beat = await this.redis.cache.get(this.keys.heartbeat(API_HEARTBEAT_NAME));
    } catch {
      return { status: 'unknown' };
    }
    if (beat === null) return { status: 'down', detail: 'No heartbeat from the API in the last 2 minutes' };
    const age = now.getTime() - new Date(beat).getTime();
    return age > HEARTBEAT_FRESH_MS
      ? { status: 'degraded', detail: `The last API heartbeat is ${Math.round(age / 1000)} s old` }
      : { status: 'ok' };
  }

  private async workers(): Promise<ProbeResult> {
    try {
      const counts = await Promise.all(QUEUE_NAMES.map((name) => this.queues.queue(name).getWorkersCount()));
      const idle = counts.filter((count) => count === 0).length;
      if (idle === counts.length) return { status: 'down', detail: 'No worker is connected to any queue' };
      return idle > 0
        ? { status: 'degraded', detail: `${idle} of ${counts.length} queues have no worker` }
        : { status: 'ok' };
    } catch {
      return { status: 'down', detail: 'The queue Redis does not answer' };
    }
  }

  private async suppliers(
    now: Date,
    add: (component: string, result: ProbeResult, latencyMs: number | null, ids?: Partial<NewServiceCheck>) => unknown,
  ): Promise<void> {
    const { supplierHealth } = await suppliersApi();
    const [suppliers, calls] = await Promise.all([
      suppliersForHealth(this.db.db),
      supplierCalls(this.db.db, new Date(now.getTime() - QUARTER_HOUR_MS)),
    ]);
    for (const supplier of suppliers) {
      if (supplier.status === 'disabled') continue;
      const figure = calls.get(supplier.id) ?? { total: 0, errors: 0, timeouts: 0, p50Ms: null };
      const status = supplierHealth({ status: supplier.status, check: null, calls: figure });
      const failed = Math.round(((figure.errors + figure.timeouts) / Math.max(figure.total, 1)) * 100);
      add(
        `supplier:${supplier.id}`,
        { status, detail: `${failed}% of calls failed in the last 15 minutes` },
        figure.p50Ms,
        { supplierId: supplier.id },
      );
    }
  }

  private async cacheCounters(): Promise<Pick<CheckerReport, 'cacheEvictedKeys' | 'cacheHits' | 'cacheMisses'>> {
    try {
      const info = await this.redis.cache.info('stats');
      return {
        cacheEvictedKeys: infoNumber(info, 'evicted_keys'),
        cacheHits: infoNumber(info, 'keyspace_hits'),
        cacheMisses: infoNumber(info, 'keyspace_misses'),
      };
    } catch {
      return { cacheEvictedKeys: null, cacheHits: null, cacheMisses: null };
    }
  }
}

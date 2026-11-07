// The System health overview (`GET /admin/system/health`): the verdict, the components with their uptime, the open alerts and
// incidents, the build and the maintenance state, built from `service_checks` and cached for a few seconds.
import { Inject, Injectable } from '@nestjs/common';
import { CLOCK, type Clock } from '../../../common/clock';
import { APP_CONFIG, type AppConfig } from '../../../config';
import { CacheKeys, CacheService } from '../../../infra/cache';
import { DbService } from '../../../infra/db';
import { RedisService } from '../../../infra/redis';
import { MaintenanceService } from '../../platform';
import type { CheckStatus } from '../db/schema';
import {
  CHECKS_ARE_OFF,
  CORE_COMPONENTS,
  CORE_NAMES,
  bucketStarts,
  overallStatus,
  uptimePercent,
} from '../domain/checks';
import { type Measure, SPEC, latencySpec, measure } from '../domain/measure';
import {
  ALERT_EVALUATION_JOB,
  alertTrend,
  alertsEvaluatedSince,
  lastIncidentResolvedAt,
  openAlerts,
  openIncidents,
} from '../infra/alerts-read.repository';
import { gatewaysForHealth, suppliersForHealth } from '../infra/foreign-reads.repository';
import { componentStates, platformUptime, uptimeCounts } from '../infra/service-checks.repository';
import { orUnavailable, isDatabaseDown } from './database-guard';
import { AppError } from '../../../common/errors';
import { PrometheusClient } from './prometheus.client';

/** Seconds the snapshot is cached. */
export const SNAPSHOT_TTL_SECONDS = 10;
/** A component whose newest check is older than this is `unknown`: the checker is not running (a stale "ok" is not health). */
export const STALE_CHECK_MS = 5 * 60_000;
const DAY_MS = 86_400_000;
const LAST_COPY_TTL_SECONDS = 86_400;

/** One component of the snapshot (wire shape of `HealthComponent`). */
export interface ComponentView {
  key: string;
  name: string;
  kind: 'core' | 'supplier' | 'gateway';
  status: CheckStatus;
  since: string | null;
  latency: Measure;
  uptime: { h24: Measure; d7: Measure; d30: Measure };
  lastCheckedAt: string | null;
  detail: string | null;
  supplierId: number | null;
  gatewayId: number | null;
}

/** The list of components every health read shares: the core keys, every supplier, every gateway, in that order. */
export interface ComponentRef {
  readonly key: string;
  readonly name: string;
  readonly kind: 'core' | 'supplier' | 'gateway';
  readonly supplierId: number | null;
  readonly gatewayId: number | null;
  /** A disabled supplier: no checks run, and the page says so. */
  readonly checksOff: boolean;
}

/** The snapshot, as the route sends it (maintenance is read live and added by {@link HealthSnapshotService.get}). */
export type HealthSnapshot = Record<string, unknown> & { components: ComponentView[]; status: string };

/**
 * Builds the System health overview.
 *
 * Why: the page and the maintenance banner of every admin page poll this route (B89): the answer is built from the latest
 * `service_checks` row of every component and cached 10 s in the cache Redis; the maintenance state is read live on top of it. A
 * copy of the last good snapshot outlives Postgres: while the database is down the route serves it with `postgres` down and the
 * status `outage` instead of failing (B89), and answers `503 DATABASE_UNAVAILABLE` only when no copy exists.
 *
 * Side effects: reads Postgres, one Prometheus query, the cache Redis; writes the two snapshot keys.
 */
@Injectable()
export class HealthSnapshotService {
  constructor(
    private readonly db: DbService,
    private readonly cache: CacheService,
    private readonly keys: CacheKeys,
    private readonly redis: RedisService,
    private readonly prom: PrometheusClient,
    private readonly maintenance: MaintenanceService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /**
   * The snapshot with the live maintenance state.
   *
   * @returns the overview
   * @throws {AppError} `DATABASE_UNAVAILABLE` when Postgres is down and no earlier snapshot exists
   */
  async get(): Promise<HealthSnapshot & { maintenance: unknown }> {
    const snapshot = await this.cache.getOrLoad(this.keys.healthSnapshot(), SNAPSHOT_TTL_SECONDS, () =>
      this.loadOrLast(),
    );
    return { ...snapshot, maintenance: await this.maintenance.state() };
  }

  /**
   * The components every health read lists.
   *
   * @returns core, suppliers and gateways
   */
  async components(): Promise<ComponentRef[]> {
    const [suppliers, gateways] = await orUnavailable(() =>
      Promise.all([suppliersForHealth(this.db.db), gatewaysForHealth(this.db.db)]),
    );
    return [
      ...CORE_COMPONENTS.map((key) => ({
        key,
        name: CORE_NAMES[key],
        kind: 'core' as const,
        supplierId: null,
        gatewayId: null,
        checksOff: false,
      })),
      ...suppliers.map((supplier) => ({
        key: `supplier:${supplier.id}`,
        name: supplier.name,
        kind: 'supplier' as const,
        supplierId: supplier.id,
        gatewayId: null,
        checksOff: supplier.status === 'disabled',
      })),
      ...gateways.map((gateway) => ({
        key: `gateway:${gateway.id}`,
        name: gateway.name,
        kind: 'gateway' as const,
        supplierId: null,
        gatewayId: gateway.id,
        checksOff: false,
      })),
    ];
  }

  private async loadOrLast(): Promise<HealthSnapshot> {
    try {
      const snapshot = await this.build();
      await this.redis.cache
        .set(this.keys.healthSnapshot(true), JSON.stringify(snapshot), 'EX', LAST_COPY_TTL_SECONDS)
        .catch(() => undefined);
      return snapshot;
    } catch (error) {
      const down = isDatabaseDown(error) || (error instanceof AppError && error.code === 'DATABASE_UNAVAILABLE');
      if (!down) throw error;
      const last = await this.redis.cache.get(this.keys.healthSnapshot(true)).catch(() => null);
      if (last === null)
        throw new AppError('DATABASE_UNAVAILABLE', {
          detail: 'The database is not answering right now.',
          cause: error,
        });
      return this.asOutage(JSON.parse(last) as HealthSnapshot);
    }
  }

  /** The last good snapshot with Postgres marked down and the overall status `outage` (B89). */
  private asOutage(last: HealthSnapshot): HealthSnapshot {
    const now = this.clock.now().toISOString();
    return {
      ...last,
      status: 'outage',
      since: now,
      checkedAt: now,
      components: last.components.map((component) =>
        component.key === 'postgres'
          ? { ...component, status: 'down', since: now, lastCheckedAt: now, detail: 'The database is not answering' }
          : component,
      ),
    };
  }

  private async monitoring(): Promise<{
    status: 'available' | 'unavailable';
    detail: string | null;
    lastScrapeAt: string | null;
  }> {
    if (!this.prom.configured) {
      return { status: 'unavailable', detail: 'Prometheus is not configured (PROMETHEUS_URL).', lastScrapeAt: null };
    }
    try {
      const rows = await this.prom.query('max(timestamp(up{job=~".*api.*"}))', this.clock.now());
      const at = rows[0]?.value;
      return {
        status: 'available',
        detail: null,
        lastScrapeAt: at !== undefined && Number.isFinite(at) ? new Date(at * 1000).toISOString() : null,
      };
    } catch {
      return { status: 'unavailable', detail: 'Prometheus does not answer.', lastScrapeAt: null };
    }
  }

  private async build(): Promise<HealthSnapshot> {
    const now = this.clock.now();
    const db = this.db.db;
    const [refs, states, counts, uptime, alerts, incidents, resolvedAt, evaluated, monitoring] = await Promise.all([
      this.components(),
      componentStates(db, now),
      uptimeCounts(db, now),
      platformUptime(db, now),
      openAlerts(db),
      openIncidents(db),
      lastIncidentResolvedAt(db),
      alertsEvaluatedSince(db, new Date(now.getTime() - 10 * 60_000)),
      this.monitoring(),
    ]);

    const components: ComponentView[] = refs.map((ref) => {
      const state = states.get(ref.key);
      const fresh = state !== undefined && now.getTime() - state.checkedAt.getTime() <= STALE_CHECK_MS;
      const status: CheckStatus = ref.checksOff || !state || !fresh ? 'unknown' : state.status;
      const figure = counts.get(ref.key);
      const window = (total: number | undefined, failed: number | undefined): Measure =>
        measure(SPEC.uptime, uptimePercent(total ?? 0, failed ?? 0));
      return {
        key: ref.key,
        name: ref.name,
        kind: ref.kind,
        status,
        since: ref.checksOff || !state ? null : (fresh ? state.since : state.checkedAt).toISOString(),
        latency: measure(latencySpec(ref.key), ref.checksOff || !fresh ? null : (state?.latencyMs ?? null)),
        uptime: {
          h24: window(figure?.total24, figure?.failed24),
          d7: window(figure?.total7, figure?.failed7),
          d30: window(figure?.total30, figure?.failed30),
        },
        lastCheckedAt: ref.checksOff || !state ? null : state.checkedAt.toISOString(),
        detail: ref.checksOff
          ? CHECKS_ARE_OFF
          : status === 'degraded' || status === 'down'
            ? (state?.detail ?? null)
            : null,
        supplierId: ref.supplierId,
        gatewayId: ref.gatewayId,
      };
    });

    const core = Object.fromEntries(components.filter((c) => c.kind === 'core').map((c) => [c.key, c.status]));
    const openCritical = alerts.filter((alert) => alert.severity === 'critical');
    const problem = components.filter((component) => component.status === 'down' || component.status === 'degraded');
    const status = overallStatus({
      core,
      anyComponentProblem: problem.length > 0,
      openCriticalAlert: openCritical.length > 0,
      monitoringAvailable: monitoring.status === 'available',
    });
    const since =
      status === 'outage' || status === 'degraded'
        ? new Date(
            Math.min(
              ...problem.map((component) => new Date(component.since ?? now).getTime()),
              ...openCritical.map((alert) => alert.startedAt.getTime()),
            ),
          )
        : status === 'operational'
          ? resolvedAt
          : monitoring.lastScrapeAt === null
            ? null
            : new Date(monitoring.lastScrapeAt);

    const points = bucketStarts(now, 900, 96);
    const trend = await alertTrend(db, points);
    const windows = uptime.windows;
    const dailyBase = uptime.daily[0]
      ? new Date(`${uptime.daily[0].day}T00:00:00.000Z`).getTime()
      : now.getTime() - 29 * DAY_MS;
    const openCount = alerts.length;
    return {
      status,
      since: since?.toISOString() ?? null,
      checkedAt: now.toISOString(),
      monitoring,
      build: {
        version: this.config.build.version,
        commit: this.config.build.commit,
        environment: this.config.env,
        deployedAt: this.config.build.deployedAt ? new Date(this.config.build.deployedAt).toISOString() : null,
      },
      components,
      uptime: {
        h24: measure(SPEC.uptime, uptimePercent(windows.h24.minutes, windows.h24.down)),
        d7: measure(SPEC.uptime, uptimePercent(windows.d7.minutes, windows.d7.down)),
        d30: measure(SPEC.uptime, uptimePercent(windows.d30.minutes, windows.d30.down)),
        daily: uptime.daily.map((day, index) => ({
          at: new Date(dailyBase + index * DAY_MS).toISOString(),
          value: day.minutes === 0 ? null : Math.round(uptimePercent(day.minutes, day.down)! * 100) / 100,
        })),
      },
      alerts: {
        open:
          openCount === 0 && !evaluated
            ? { value: null, unit: 'count', state: 'unknown', warn: 1 }
            : {
                value: openCount,
                unit: 'count',
                state: openCritical.length > 0 ? 'crit' : openCount > 0 ? 'warn' : 'ok',
                warn: 1,
              },
        critical: openCritical.length,
        items: alerts.map((alert) => ({
          id: alert.id,
          ruleName: alert.ruleName,
          severity: alert.severity,
          status: alert.status,
          subjectLabel: alert.subjectLabel,
          startedAt: alert.startedAt.toISOString(),
        })),
        trend: points.map((point, index) => ({ at: point.toISOString(), value: trend[index] ?? 0 })),
      },
      incidents: incidents.map((incident) => ({
        id: incident.id,
        title: incident.title,
        severity: incident.severity,
        status: incident.status,
        components: incident.components,
        startedAt: incident.startedAt.toISOString(),
      })),
    };
  }
}

/** The job name 12b's alert evaluator records its runs under (re-exported for it). */
export { ALERT_EVALUATION_JOB };

// The check history of the components (`GET /admin/system/checks`): uptime bars and response times per component over a range.
import { Inject, Injectable } from '@nestjs/common';
import { CLOCK, type Clock } from '../../../common/clock';
import { AppError } from '../../../common/errors';
import { CacheKeys, CacheService } from '../../../infra/cache';
import { DbService } from '../../../infra/db';
import { CHECK_RANGES, type TimeRange, bucketStarts, bucketStatus, uptimePercent } from '../domain/checks';
import { type Measure, SPEC, latencySpec, measure } from '../domain/measure';
import { checkBuckets, latestLatencies } from '../infra/service-checks.repository';
import { orUnavailable } from './database-guard';
import { HealthSnapshotService } from './health-snapshot.service';

/** Seconds a history answer is cached: the all-components 7-day read aggregates a lot of rows. */
const CACHE_SECONDS = 30;

/** The answer of `GET /admin/system/checks`. */
export interface ChecksAnswer {
  range: TimeRange;
  bucketSeconds: number;
  components: Array<{
    key: string;
    name: string;
    uptime: Measure;
    latency: Measure;
    buckets: Array<{ start: string; status: string; checks: number; failures: number; latencyMs: number | null }>;
  }>;
}

/**
 * Builds the check history.
 *
 * Why: the Overview shows one uptime strip per component and the response-time chart of the picked component; both come from
 * `service_checks` grouped in buckets of 1 to 180 minutes (docs/contract/endpoints/health.md). An unknown component key is 404.
 *
 * Side effects: reads Postgres; caches each (range, component) answer 30 s.
 */
@Injectable()
export class ChecksHistoryService {
  constructor(
    private readonly db: DbService,
    private readonly cache: CacheService,
    private readonly keys: CacheKeys,
    private readonly snapshot: HealthSnapshotService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /**
   * The history of one component or of all.
   *
   * @param range the window
   * @param component one stored component key, or `undefined` for all
   * @returns the buckets and uptime per component
   * @throws {AppError} `NOT_FOUND` for an unknown component key; `DATABASE_UNAVAILABLE` when Postgres is down
   */
  async history(range: TimeRange, component: string | undefined): Promise<ChecksAnswer> {
    const refs = await this.snapshot.components();
    const picked = component === undefined ? refs : refs.filter((ref) => ref.key === component);
    if (component !== undefined && picked.length === 0) {
      throw new AppError('NOT_FOUND', { detail: `There is no component "${component}".` });
    }
    return this.cache.getOrLoad(this.keys.healthChecks(range, component ?? 'all'), CACHE_SECONDS, () =>
      orUnavailable(async () => {
        const now = this.clock.now();
        const { bucketSeconds, buckets } = CHECK_RANGES[range];
        const starts = bucketStarts(now, bucketSeconds, buckets);
        const from = starts[0] as Date;
        const [byComponent, latencies] = await Promise.all([
          checkBuckets(this.db.db, from, bucketSeconds, component),
          latestLatencies(
            this.db.db,
            picked.map((ref) => ref.key),
            from,
          ),
        ]);
        return {
          range,
          bucketSeconds,
          components: picked.map((ref) => {
            const counts = byComponent.get(ref.key);
            let checks = 0;
            let failures = 0;
            const rows = starts.map((start) => {
              const found = counts?.get(start.getTime() / 1000 / bucketSeconds);
              const total = found ? found.down + found.degraded + found.ok + found.unknown : 0;
              checks += total;
              failures += found?.down ?? 0;
              return {
                start: start.toISOString(),
                status: bucketStatus(found),
                checks: total,
                failures: found?.down ?? 0,
                latencyMs: found?.p95 ?? null,
              };
            });
            return {
              key: ref.key,
              name: ref.name,
              uptime: measure(SPEC.uptime, uptimePercent(checks, failures)),
              latency: measure(latencySpec(ref.key), ref.checksOff ? null : (latencies.get(ref.key) ?? null)),
              buckets: rows,
            };
          }),
        };
      }),
    );
  }
}

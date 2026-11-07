// Pure rules of the System health checks: the component keys, the time ranges and their buckets, the worst-of folds and the
// overall verdict (RESOLUTIONS health-commissions-6, -7; docs/contract/endpoints/health.md `GET /admin/system/health` and `/checks`).
import type { CheckStatus } from '../db/schema';

/** The core components the checker writes (`service_checks.component` as is); suppliers and gateways add `supplier:<id>` and `gateway:<id>`. */
export const CORE_COMPONENTS = ['api', 'postgres', 'redis', 'redis_queue', 'storage', 'workers', 'mail'] as const;
/** One core component key. */
export type CoreComponent = (typeof CORE_COMPONENTS)[number];

/** The words the console shows for the core components. */
export const CORE_NAMES: Readonly<Record<CoreComponent, string>> = {
  api: 'API',
  postgres: 'Postgres',
  redis: 'Redis (cache)',
  redis_queue: 'Redis (queue)',
  storage: 'File storage',
  workers: 'Queue workers',
  mail: 'Email relay',
};

/** The detail text of a supplier whose checks are switched off (a disabled supplier has no check row). */
export const CHECKS_ARE_OFF = 'checks are off';

/** The windows of the history charts and ranked lists (`?range=`). */
export const TIME_RANGES = ['1h', '6h', '24h', '7d'] as const;
/** One window. */
export type TimeRange = (typeof TIME_RANGES)[number];

/** How a range is cut for check history: the bucket width and how many buckets (the last one still filling). */
export const CHECK_RANGES: Readonly<Record<TimeRange, { readonly bucketSeconds: number; readonly buckets: number }>> = {
  '1h': { bucketSeconds: 60, buckets: 60 },
  '6h': { bucketSeconds: 300, buckets: 72 },
  '24h': { bucketSeconds: 1_800, buckets: 48 },
  '7d': { bucketSeconds: 10_800, buckets: 56 },
};

/** How a range is cut for traffic series (Prometheus `query_range` step and points). */
export const METRIC_RANGES: Readonly<Record<TimeRange, { readonly bucketSeconds: number; readonly points: number }>> = {
  '1h': { bucketSeconds: 60, points: 60 },
  '6h': { bucketSeconds: 300, points: 72 },
  '24h': { bucketSeconds: 900, points: 96 },
  '7d': { bucketSeconds: 3_600, points: 168 },
};

/** The length of a range in seconds. */
export const RANGE_SECONDS: Readonly<Record<TimeRange, number>> = {
  '1h': 3_600,
  '6h': 21_600,
  '24h': 86_400,
  '7d': 604_800,
};

/**
 * Starts of the buckets of a range, oldest first, aligned to multiples of the bucket width.
 *
 * Why: every component and every request sees the same buckets, and the last bucket is the one `now` falls in (still filling).
 *
 * @param now the clock's time
 * @param bucketSeconds the bucket width
 * @param count how many buckets
 * @returns the start of each bucket
 */
export function bucketStarts(now: Date, bucketSeconds: number, count: number): Date[] {
  const last = Math.floor(now.getTime() / 1000 / bucketSeconds);
  return Array.from({ length: count }, (_, i) => new Date((last - (count - 1 - i)) * bucketSeconds * 1000));
}

/** What the database says about one component in one bucket. */
export interface BucketCounts {
  readonly down: number;
  readonly degraded: number;
  readonly ok: number;
  readonly unknown: number;
  readonly p95: number | null;
}

/**
 * The status of a bucket: the worst check in it.
 *
 * Why: `down > degraded > ok`; a bucket with no check, or only `unknown` rows (a supplier with no calls), is `unknown`.
 *
 * @param counts the check counts of the bucket, or `undefined` for none
 * @returns the bucket status
 */
export function bucketStatus(counts: BucketCounts | undefined): CheckStatus {
  if (!counts) return 'unknown';
  if (counts.down > 0) return 'down';
  if (counts.degraded > 0) return 'degraded';
  return counts.ok > 0 ? 'ok' : 'unknown';
}

/**
 * Uptime as a percentage.
 *
 * Why: `(checks - failures) / checks x 100`; a component without checks has no uptime (`null`), never 100.
 *
 * @param checks how many checks ran
 * @param failures how many were `down`
 * @returns 0 to 100, or `null`
 */
export function uptimePercent(checks: number, failures: number): number | null {
  return checks <= 0 ? null : ((checks - failures) / checks) * 100;
}

/** The overall status of the platform (the console's `OverallStatus`). */
export type OverallStatus = 'operational' | 'degraded' | 'outage' | 'unknown';

/** What the overall status is decided from. */
export interface OverallInput {
  /** The latest status of every core component, by key. */
  readonly core: Readonly<Record<string, CheckStatus>>;
  /** Whether any component (core, supplier or gateway) is down or degraded. */
  readonly anyComponentProblem: boolean;
  readonly openCriticalAlert: boolean;
  readonly monitoringAvailable: boolean;
}

/**
 * The overall status.
 *
 * Why: B89: `outage` when a core component is down; `degraded` when any component is down or degraded or a critical alert is
 * open; otherwise `operational`, but never while monitoring is unavailable (then `unknown`, unless the checks prove an outage
 * or a degradation): a platform nobody can measure is not shown green.
 *
 * @param input the facts
 * @returns the status
 */
export function overallStatus(input: OverallInput): OverallStatus {
  if (Object.values(input.core).includes('down')) return 'outage';
  if (input.anyComponentProblem || input.openCriticalAlert) return 'degraded';
  return input.monitoringAvailable ? 'operational' : 'unknown';
}

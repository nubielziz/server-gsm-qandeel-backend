// The System health API traffic page (`GET /admin/system/metrics` and `/errors`): PromQL over `http_request_duration_seconds` and
// `api_errors_total`, shaped into measures and series (decision 015, MISMATCHES B90, B91, B114, B115).
import { Inject, Injectable } from '@nestjs/common';
import { CLOCK, type Clock } from '../../../common/clock';
import { METRIC_RANGES, type TimeRange, RANGE_SECONDS } from '../domain/checks';
import { type Measure, type MeasureSpec, SPEC, measure } from '../domain/measure';
import { type PromMatrix, type PromVector, PrometheusClient } from './prometheus.client';

/** The surfaces of the API, in the order the console lists them, with the words it shows. */
export const SURFACE_LABELS: Readonly<Record<string, string>> = {
  v1: 'REST v1',
  dhru: 'Dhru',
  client: 'Merchant portal',
  store: 'Storefront',
  admin: 'Admin',
  hooks: 'Webhooks',
};

/** One point of a series. */
export interface Point {
  readonly at: string;
  readonly value: number | null;
}

/** The series of one surface over the range. */
export interface SurfaceSeries {
  requestsPerMin: Point[];
  p50: Point[];
  p95: Point[];
  p99: Point[];
  rate4xx: Point[];
  rate5xx: Point[];
}

/** The traffic of one surface. */
export interface SurfaceMetrics {
  readonly surface: string;
  readonly label: string;
  readonly requestsPerMin: Measure;
  readonly p50: Measure;
  readonly p95: Measure;
  readonly p99: Measure;
  readonly rate4xx: Measure;
  readonly rate5xx: Measure;
  readonly count429: Measure;
  readonly series: SurfaceSeries;
}

/** The answer of `GET /admin/system/metrics`. */
export interface ApiMetrics {
  readonly range: TimeRange;
  readonly bucketSeconds: number;
  readonly total: SurfaceMetrics;
  readonly surfaces: SurfaceMetrics[];
  readonly slowest: Array<{ method: string; path: string; surface: string; p95: Measure; requestsPerMin: number }>;
}

/** The answer of `GET /admin/system/errors`. */
export interface ApiErrors {
  readonly range: TimeRange;
  readonly total: number;
  readonly groups: Array<{
    code: string;
    status: number;
    method: string;
    endpoint: string;
    surface: string;
    count: number;
    firstSeenAt: string;
    lastSeenAt: string;
    lastRequestId: string | null;
    sentryUrl: string | null;
  }>;
}

const COUNT = 'http_request_duration_seconds_count';
const BUCKET = 'http_request_duration_seconds_bucket';
const NOW_WINDOW = '5m';

/** The PromQL of the six figures of a surface, for a rate window and an optional surface selector. */
function expressions(window: string, scope: string, groupBy: string): Record<keyof SurfaceSeries | 'count429', string> {
  const sel = (extra: string): string => `{${[scope, extra].filter((part) => part !== '').join(',')}}`;
  const by = groupBy === '' ? '' : ` by (${groupBy})`;
  const quantile = (q: number): string =>
    `histogram_quantile(${q}, sum by (le${groupBy === '' ? '' : `, ${groupBy}`}) (rate(${BUCKET}${sel('')}[${window}]))) * 1000`;
  const total = `sum${by} (rate(${COUNT}${sel('')}[${window}]))`;
  const errors5xx = `sum${by} (rate(${COUNT}${sel('status=~"5.."')}[${window}]))`;
  // 503 MAINTENANCE is planned, not a failure: it is taken out of the 5xx rate (B114).
  const maintenance = `(sum${by} (rate(api_errors_total${sel('code="MAINTENANCE"')}[${window}])) or (${errors5xx} * 0))`;
  return {
    requestsPerMin: `${total} * 60`,
    p50: quantile(0.5),
    p95: quantile(0.95),
    p99: quantile(0.99),
    rate4xx: `100 * sum${by} (rate(${COUNT}${sel('status=~"4.."')}[${window}])) / ${total}`,
    rate5xx: `100 * clamp_min(${errors5xx} - ${maintenance}, 0) / ${total}`,
    count429: `sum${by} (increase(${COUNT}${sel('status="429"')}[${window}]))`,
  };
}

function finite(value: number | undefined): number | null {
  return value === undefined || !Number.isFinite(value) ? null : value;
}

/**
 * Reads the API traffic and errors from Prometheus.
 *
 * Why: B90: history over 1 hour to 7 days cannot come from the process registries, so a Prometheus server (`PROMETHEUS_URL`)
 * is queried with PromQL; without it the routes answer `503 MONITORING_UNAVAILABLE` and `GET /admin/system/health` says
 * `monitoring.status unavailable`. Percentages are 0 to 100 JSON numbers (B115).
 *
 * Side effects: reads only (HTTP to Prometheus).
 */
@Injectable()
export class TrafficService {
  constructor(
    private readonly prom: PrometheusClient,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /**
   * The API performance per surface.
   *
   * @param range the window of the series and of the slowest list
   * @param surface one surface, or `undefined` for all of them
   * @returns the measures "now" (last 5 minutes), the series and the slowest endpoints
   * @throws {AppError} `MONITORING_UNAVAILABLE` when Prometheus is not configured or does not answer
   */
  async metrics(range: TimeRange, surface: string | undefined): Promise<ApiMetrics> {
    const now = this.clock.now();
    const { bucketSeconds, points } = METRIC_RANGES[range];
    const end = new Date(Math.floor(now.getTime() / 1000 / bucketSeconds) * bucketSeconds * 1000);
    const start = new Date(end.getTime() - (points - 1) * bucketSeconds * 1000);
    const window = bucketSeconds <= 300 ? NOW_WINDOW : `${bucketSeconds}s`;
    const scope = surface === undefined ? '' : `surface="${surface}"`;
    const names = surface === undefined ? Object.keys(SURFACE_LABELS) : [surface];

    const nowBy = expressions(NOW_WINDOW, scope, 'surface');
    const nowAll = expressions(NOW_WINDOW, scope, '');
    const rangeBy = expressions(window, scope, 'surface');
    const rangeAll = expressions(window, scope, '');
    const keys = Object.keys(nowBy) as Array<keyof typeof nowBy>;
    const seriesKeys = keys.filter((key): key is keyof SurfaceSeries => key !== 'count429');

    const [nowByRows, nowAllRows, rangeByRows, rangeAllRows, slowest] = await Promise.all([
      Promise.all(keys.map((key) => this.prom.query(nowBy[key], now))),
      Promise.all(keys.map((key) => this.prom.query(nowAll[key], now))),
      Promise.all(seriesKeys.map((key) => this.prom.queryRange(rangeBy[key], start, end, bucketSeconds))),
      Promise.all(seriesKeys.map((key) => this.prom.queryRange(rangeAll[key], start, end, bucketSeconds))),
      this.slowest(range, scope, now),
    ]);

    const stamps = Array.from({ length: points }, (_, i) => start.getTime() / 1000 + i * bucketSeconds);
    const seriesOf = (rows: PromMatrix[] | undefined, label: string | undefined): Point[] => {
      const found = rows?.find((row) => (label === undefined ? true : row.metric.surface === label));
      const bySecond = new Map((found?.values ?? []).map(([at, value]) => [at, value]));
      return stamps.map((at) => ({ at: new Date(at * 1000).toISOString(), value: finite(bySecond.get(at)) }));
    };
    const build = (
      label: string,
      surfaceName: string,
      vectors: PromVector[][],
      matrices: PromMatrix[][],
      pick: string | undefined,
    ): SurfaceMetrics => {
      const value = (key: keyof typeof nowBy): number | null => {
        const rows = vectors[keys.indexOf(key)] ?? [];
        const row = pick === undefined ? rows[0] : rows.find((candidate) => candidate.metric.surface === pick);
        return finite(row?.value);
      };
      const spec = (base: MeasureSpec, key: keyof typeof nowBy): Measure => measure(base, value(key));
      const series = Object.fromEntries(
        seriesKeys.map((key) => [key, seriesOf(matrices[seriesKeys.indexOf(key)], pick)]),
      ) as unknown as SurfaceSeries;
      const requests = value('requestsPerMin');
      return {
        surface: surfaceName,
        label,
        // Without a value there is nothing to judge: traffic has no limits, so it reads ok only when there is a number.
        requestsPerMin:
          requests === null ? { value: null, unit: 'per_min', state: 'unknown' } : measure(SPEC.traffic, requests),
        p50: spec(SPEC.apiP50, 'p50'),
        p95: spec(SPEC.apiP95, 'p95'),
        p99: spec(SPEC.apiP99, 'p99'),
        rate4xx: spec(SPEC.rate4xx, 'rate4xx'),
        rate5xx: spec(SPEC.rate5xx, 'rate5xx'),
        // A 429 count with no samples at all means none were answered: zero is a real value for a counter.
        count429: measure(SPEC.count429, value('count429') ?? (requests === null ? null : 0)),
        series,
      };
    };

    const surfaces = names.map((name) => build(SURFACE_LABELS[name] ?? name, name, nowByRows, rangeByRows, name));
    const total =
      surface === undefined
        ? build('All surfaces', 'total', nowAllRows, rangeAllRows, undefined)
        : { ...(surfaces[0] as SurfaceMetrics) };
    return { range, bucketSeconds, total, surfaces, slowest };
  }

  /**
   * The most frequent API errors.
   *
   * @param range the window
   * @param surface one surface, or `undefined` for all of them
   * @returns the total and the top 10 groups
   * @throws {AppError} `MONITORING_UNAVAILABLE` when Prometheus is not configured or does not answer
   */
  async errors(range: TimeRange, surface: string | undefined): Promise<ApiErrors> {
    const now = this.clock.now();
    const seconds = RANGE_SECONDS[range];
    const { bucketSeconds } = METRIC_RANGES[range];
    const scope = surface === undefined ? '' : `{surface="${surface}"}`;
    const groupBy = 'code, method, route, status, surface';
    const end = new Date(Math.floor(now.getTime() / 1000 / bucketSeconds) * bucketSeconds * 1000);
    const start = new Date(end.getTime() - (seconds - bucketSeconds));
    const [counts, totals, seen] = await Promise.all([
      this.prom.query(`sum by (${groupBy}) (increase(api_errors_total${scope}[${seconds}s]))`, now),
      this.prom.query(`sum (increase(api_errors_total${scope}[${seconds}s]))`, now),
      this.prom.queryRange(
        `sum by (${groupBy}) (increase(api_errors_total${scope}[${bucketSeconds}s]))`,
        start,
        end,
        bucketSeconds,
      ),
    ]);
    const keyOf = (metric: Readonly<Record<string, string>>): string =>
      [metric.code, metric.method, metric.route, metric.status, metric.surface].join('|');
    const seenBy = new Map(seen.map((row) => [keyOf(row.metric), row.values.filter(([, value]) => value > 0.0001)]));
    const groups = counts
      .map((row) => ({ row, count: Math.round(row.value) }))
      .filter(({ count }) => count > 0)
      .sort((a, b) => b.count - a.count)
      .slice(0, 10)
      .map(({ row, count }) => {
        const times = seenBy.get(keyOf(row.metric)) ?? [];
        const first = times[0]?.[0] ?? end.getTime() / 1000;
        const last = times[times.length - 1]?.[0] ?? first;
        return {
          code: row.metric.code ?? 'UNKNOWN',
          status: Number(row.metric.status ?? 0),
          method: row.metric.method ?? '',
          endpoint: row.metric.route ?? '',
          surface: row.metric.surface ?? '',
          count,
          firstSeenAt: new Date(first * 1000).toISOString(),
          lastSeenAt: new Date(Math.max(last, first) * 1000).toISOString(),
          lastRequestId: null,
          sentryUrl: null,
        };
      });
    return { range, total: Math.round(totals[0]?.value ?? 0), groups };
  }

  private async slowest(range: TimeRange, scope: string, now: Date): Promise<ApiMetrics['slowest']> {
    const seconds = RANGE_SECONDS[range];
    const selector = `{${[scope, 'route!="unmatched"'].filter((part) => part !== '').join(',')}}`;
    const by = 'method, route, surface';
    const [p95, rate] = await Promise.all([
      this.prom.query(
        `topk(10, histogram_quantile(0.95, sum by (le, ${by}) (rate(${BUCKET}${selector}[${seconds}s]))) * 1000)`,
        now,
      ),
      this.prom.query(`sum by (${by}) (rate(${COUNT}${selector}[${seconds}s])) * 60`, now),
    ]);
    const rates = new Map(
      rate.map((row) => [`${row.metric.method}|${row.metric.route}|${row.metric.surface}`, row.value]),
    );
    return p95
      .filter((row) => Number.isFinite(row.value))
      .sort((a, b) => b.value - a.value)
      .slice(0, 10)
      .map((row) => ({
        method: row.metric.method ?? '',
        path: row.metric.route ?? '',
        surface: row.metric.surface ?? '',
        p95: measure(SPEC.apiP95, row.value),
        requestsPerMin:
          Math.round((rates.get(`${row.metric.method}|${row.metric.route}|${row.metric.surface}`) ?? 0) * 100) / 100,
      }));
  }
}

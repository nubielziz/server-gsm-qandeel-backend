// The server's verdict on a measured number: the thresholds of every figure on the System health and Dashboard pages and the
// `Measure` builder (system-health design, ASSUMED_CONTRACTS § system-health). Pure; the console only draws what these decide.

/** Unit of a measured value (the console's `MeasureUnit`). */
export type MeasureUnit = 'ms' | 's' | 'percent' | 'per_min' | 'count' | 'bytes';
/** The verdict on one number; `unknown` means no data and is never shown as healthy. */
export type MetricState = 'ok' | 'warn' | 'crit' | 'unknown';
/** Which side of the thresholds is bad. */
export type ThresholdDirection = 'above' | 'below';

/** One measured number with the verdict and the thresholds the server applied (the console's `Measure`). */
export interface Measure {
  readonly value: number | null;
  readonly unit: MeasureUnit;
  readonly state: MetricState;
  readonly warn?: number;
  readonly crit?: number;
  readonly direction?: ThresholdDirection;
}

/** The limits of one kind of figure; no limits means informational (always `ok` with a value). */
export interface MeasureSpec {
  readonly unit: MeasureUnit;
  readonly warn?: number;
  readonly crit?: number;
  readonly direction?: ThresholdDirection;
}

/**
 * The limits of every figure of the System health pages.
 *
 * Why: the console never compares a value with a limit itself (ASSUMED_CONTRACTS): it prints `state`, and draws `warn` and
 * `crit` on charts. The numbers are those of the design brief (KPI row) and of the console's mock, which the pages were built
 * against.
 */
export const SPEC = {
  uptime: { unit: 'percent', warn: 99.9, crit: 99.5, direction: 'below' },
  apiP95: { unit: 'ms', warn: 800, crit: 1500, direction: 'above' },
  apiP50: { unit: 'ms', warn: 400, crit: 800, direction: 'above' },
  apiP99: { unit: 'ms', warn: 2000, crit: 4000, direction: 'above' },
  rate5xx: { unit: 'percent', warn: 0.5, crit: 2, direction: 'above' },
  rate4xx: { unit: 'percent', warn: 8, crit: 20, direction: 'above' },
  count429: { unit: 'count', warn: 20, crit: 100, direction: 'above' },
  traffic: { unit: 'per_min' },
  queueAge: { unit: 's', warn: 120, crit: 600, direction: 'above' },
  queueRate: { unit: 'per_min' },
  pastSla: { unit: 'count', warn: 5, crit: 20, direction: 'above' },
  alertsOpen: { unit: 'count', warn: 1 },
  dispatch: { unit: 's', warn: 120, crit: 300, direction: 'above' },
  success: { unit: 'percent', warn: 97, crit: 90, direction: 'below' },
  failure: { unit: 'percent', warn: 3, crit: 10, direction: 'above' },
  supplierLatency: { unit: 'ms', warn: 2000, crit: 5000, direction: 'above' },
  supplierErrors: { unit: 'percent', warn: 5, crit: 20, direction: 'above' },
  webhookSuccess: { unit: 'percent', warn: 97, crit: 90, direction: 'below' },
  webhookAge: { unit: 's', warn: 300, crit: 1800, direction: 'above' },
  connections: { unit: 'percent', warn: 70, crit: 90, direction: 'above' },
  poolWait: { unit: 'ms', warn: 50, crit: 500, direction: 'above' },
  lockWait: { unit: 's', warn: 5, crit: 30, direction: 'above' },
  replicaLag: { unit: 's', warn: 5, crit: 30, direction: 'above' },
  memory: { unit: 'percent', warn: 75, crit: 90, direction: 'above' },
  evictions: { unit: 'per_min', warn: 10, crit: 100, direction: 'above' },
  hitRate: { unit: 'percent', warn: 90, crit: 70, direction: 'below' },
  clients: { unit: 'count', warn: 400, crit: 900, direction: 'above' },
  redisLatency: { unit: 'ms', warn: 5, crit: 25, direction: 'above' },
} as const satisfies Record<string, MeasureSpec>;

/**
 * Rounds a value the way its unit is sent.
 *
 * Why: percentages keep two decimals, rates one, small times one decimal (a Redis answer in 0.4 ms must not read as 0), the
 * rest whole numbers; the state is worked out on the rounded value so the page and the verdict agree.
 *
 * @param unit the unit of the value
 * @param value the raw value
 * @returns the rounded value
 */
export function roundFor(unit: MeasureUnit, value: number): number {
  const places =
    unit === 'percent' ? 2 : unit === 'per_min' ? 1 : (unit === 's' || unit === 'ms') && value < 10 ? 1 : 0;
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}

/**
 * The verdict on one value.
 *
 * Why: "no value" is `unknown`, never `ok`; a limit is crossed when the value is strictly beyond it on the bad side.
 *
 * @param spec the limits of the figure
 * @param value the (rounded) value, or `null` for no data
 * @returns `unknown`, `crit`, `warn` or `ok`
 */
export function stateOf(spec: MeasureSpec, value: number | null): MetricState {
  if (value === null || !Number.isFinite(value)) return 'unknown';
  const direction = spec.direction ?? 'above';
  const beyond = (limit: number | undefined): boolean =>
    limit !== undefined && (direction === 'above' ? value > limit : value < limit);
  if (beyond(spec.crit)) return 'crit';
  return beyond(spec.warn) ? 'warn' : 'ok';
}

/**
 * Builds a `Measure`.
 *
 * @param spec the limits of the figure
 * @param value the raw value, or `null` for no data
 * @returns the rounded value with its unit, state and the limits that were applied
 */
export function measure(spec: MeasureSpec, value: number | null): Measure {
  const rounded = value === null || !Number.isFinite(value) ? null : roundFor(spec.unit, value);
  return {
    value: rounded,
    unit: spec.unit,
    state: stateOf(spec, rounded),
    ...(spec.warn === undefined ? {} : { warn: spec.warn }),
    ...(spec.crit === undefined ? {} : { crit: spec.crit }),
    ...(spec.direction === undefined ? {} : { direction: spec.direction }),
  };
}

/**
 * The worst of some states: crit, then warn, then unknown, then ok.
 *
 * @param states the states of the parts
 * @returns the state of the whole
 */
export function worst(states: readonly MetricState[]): MetricState {
  for (const state of ['crit', 'warn', 'unknown'] as const) if (states.includes(state)) return state;
  return 'ok';
}

/**
 * The limits of a component's response time (the health check's latency).
 *
 * Why: the console draws them on the response-time chart; core components differ (an object-storage call is slower than a
 * Redis `PING`), a supplier or gateway has the loosest limits (design brief § Components).
 *
 * @param key the component key (`postgres`, `supplier:3`, `gateway:1`, ...)
 * @returns the limits in milliseconds
 */
export function latencySpec(key: string): MeasureSpec {
  const limits: Record<string, readonly [number, number]> = {
    api: [300, 1000],
    postgres: [100, 500],
    redis: [50, 250],
    redis_queue: [50, 250],
    storage: [800, 2000],
    workers: [200, 1000],
    mail: [1500, 4000],
  };
  const [warn, crit] = limits[key] ?? (key.startsWith('supplier:') ? [2000, 5000] : [1500, 4000]);
  return { unit: 'ms', warn, crit, direction: 'above' };
}

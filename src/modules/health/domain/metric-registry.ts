// The registry of the metrics an alert rule can watch: eleven keys with a fixed unit and a fixed kind of subject (feature 12b,
// RESOLUTIONS health-commissions-13 and -14, ANSWERS system-health Q30). Pure.
import type { AlertSubjectType, AlertUnit } from '../db/schema';

/**
 * The eleven metrics a rule can watch.
 *
 * Why: B101 and ANSWERS Q30: "the metric comes from a fixed list" owned by the server; the console offers these keys and the
 * OpenAPI document carries them as an enum, so an unknown key is `422` on `metric`.
 */
export const METRIC_KEYS = [
  'supplier.timeout_rate',
  'supplier.error_rate',
  'supplier.balance',
  'api.p95',
  'api.rate5xx',
  'queue.oldest_age',
  'orders.past_sla',
  'ledger.mismatch_count',
  'db.connection_usage',
  'redis.memory_usage',
  'webhooks.success_rate',
] as const;

/** One key of {@link METRIC_KEYS}. */
export type MetricKey = (typeof METRIC_KEYS)[number];

/** What a metric is about: the subject types a metric can raise (a subset of the alert subject types). */
export type MetricSubject = Extract<AlertSubjectType, 'system' | 'supplier' | 'queue'>;

/** Where a metric's value comes from. */
export type MetricSource = 'postgres' | 'prometheus' | 'redis' | 'bullmq';

/**
 * What a rule's window means for a metric.
 *
 * - `measured`: the value is a rate or a percentile computed over the window (the rule's window is part of the query).
 * - `held`: the value is a reading of the moment (a balance, a queue age, a count, a usage); the rule fires only when the reading was on the bad
 *   side of the threshold in every evaluation of the whole window, and resolves only when it was back in range for the whole window (the console
 *   prints such a rule as "> 20 for 5m"; the map's step 10 closes an alert after "three consecutive minutes" of recovery).
 * - `run`: the value is the outcome of a discrete run (`ledger.mismatch_count` is what the newest integrity run found): there is no stretch of
 *   time to hold, so the reading is judged as soon as it exists (scenario system-integrity steps 2 and 7: a run that finds a difference fires the
 *   alert at once, a clean run resolves it at once).
 */
export type WindowMode = 'measured' | 'held' | 'run';

/** The facts about one metric. */
export interface MetricSpec {
  /** The wire unit of the value and the threshold; `null` is "no unit" (a supplier balance is in the supplier's own currency). */
  readonly unit: AlertUnit | null;
  /** One alert per supplier (`supplier`), per queue (`queue`), or one for the whole platform (`system`). */
  readonly subject: MetricSubject;
  /** What the rule's window means for this metric, see {@link WindowMode}. */
  readonly window: WindowMode;
  /** The store the value is read from: with `prometheus`, a Prometheus outage means the rule cannot be evaluated (Q15). */
  readonly source: MetricSource;
}

/**
 * The fixed facts of every metric.
 *
 * Why: RESOLUTIONS health-commissions-13 fixes the units (`'%'` is always `percent`, "no unit" is `null`) and -14 fixes the
 * subject: `supplier.*` raise a `supplier` alert, `queue.oldest_age` a `queue` alert, everything else `system`.
 */
export const METRICS: Readonly<Record<MetricKey, MetricSpec>> = {
  'supplier.timeout_rate': { unit: 'percent', subject: 'supplier', window: 'measured', source: 'postgres' },
  'supplier.error_rate': { unit: 'percent', subject: 'supplier', window: 'measured', source: 'postgres' },
  'supplier.balance': { unit: null, subject: 'supplier', window: 'held', source: 'postgres' },
  'api.p95': { unit: 'ms', subject: 'system', window: 'measured', source: 'prometheus' },
  'api.rate5xx': { unit: 'percent', subject: 'system', window: 'measured', source: 'prometheus' },
  'queue.oldest_age': { unit: 's', subject: 'queue', window: 'held', source: 'bullmq' },
  'orders.past_sla': { unit: 'count', subject: 'system', window: 'held', source: 'postgres' },
  'ledger.mismatch_count': { unit: 'count', subject: 'system', window: 'run', source: 'postgres' },
  'db.connection_usage': { unit: 'percent', subject: 'system', window: 'held', source: 'postgres' },
  'redis.memory_usage': { unit: 'percent', subject: 'system', window: 'held', source: 'redis' },
  'webhooks.success_rate': { unit: 'percent', subject: 'system', window: 'measured', source: 'postgres' },
};

/**
 * Tells whether a text is a metric of the registry.
 *
 * @param text any text
 * @returns true for one of the eleven keys
 */
export function isMetricKey(text: string): text is MetricKey {
  return (METRIC_KEYS as readonly string[]).includes(text);
}

/**
 * The unit of a metric as the wire sends it.
 *
 * Why: the server sets the unit from the metric, never from the request (B101), and a metric change recomputes it.
 *
 * @param metric a stored metric text
 * @returns the unit; `null` for a metric with no unit and for a key the registry no longer knows
 */
export function unitOf(metric: string): AlertUnit | null {
  return isMetricKey(metric) ? METRICS[metric].unit : null;
}

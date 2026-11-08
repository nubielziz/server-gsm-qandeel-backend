// Pure figures of the reports (stage 11, routes /admin/reports/*): the day window of a date range, the defaults of the profit report, the
// rejection rate, the ranking of profit rows. SQL does the adding up; these functions decide what is counted and how it is shown.
import { Money } from '../../../common/money';

/** What the profit report can be split by. */
export const PROFIT_GROUPS = ['day', 'service', 'supplier', 'client'] as const;

/** One value of {@link PROFIT_GROUPS}. */
export type ProfitGroup = (typeof PROFIT_GROUPS)[number];

/**
 * The time zone that cuts the days of a report.
 *
 * Why: RESOLUTIONS money-10 and ANSWERS finance Q7: "one business time-zone setting, default UTC". No such setting exists yet, so
 * every report day is a UTC day; this constant (and the SQL `at time zone`) is the one place to change when a setting arrives.
 */
export const REPORT_TIME_ZONE = 'UTC';

const DAY_MS = 86_400_000;
/** The default range of the profit report: this many days ending today (the console's middle preset). */
export const DEFAULT_PROFIT_DAYS = 30;

/**
 * Turns an inclusive range of days into the half-open time window to query.
 *
 * Why: the console sends `from` and `to` as whole days, both included (finance Q7): the window starts at the first day's midnight
 * and ends at the next midnight after the last day.
 *
 * @param from the first day, `YYYY-MM-DD`
 * @param to the last day, `YYYY-MM-DD`
 * @returns `[start, end)` as times
 */
export function dayWindow(from: string, to: string): { start: Date; end: Date } {
  return { start: new Date(`${from}T00:00:00.000Z`), end: new Date(Date.parse(`${to}T00:00:00.000Z`) + DAY_MS) };
}

/**
 * Tells whether a range is in order.
 *
 * @param from the first day
 * @param to the last day
 * @returns true when `from` is not after `to`
 */
export function isOrderedRange(from: string, to: string): boolean {
  return from <= to;
}

/**
 * The range the profit report uses for what the client leaves out: the last 30 days ending on `to`, and `to` is today by default.
 *
 * @param now the clock's time
 * @param to the last day the client asked for, if any
 * @returns the first and the last day as `YYYY-MM-DD`
 */
export function defaultProfitRange(now: Date, to?: string): { from: string; to: string } {
  const last = to ?? now.toISOString().slice(0, 10);
  const from = new Date(Date.parse(`${last}T00:00:00.000Z`) - (DEFAULT_PROFIT_DAYS - 1) * DAY_MS)
    .toISOString()
    .slice(0, 10);
  return { from, to: last };
}

/** One group of the profit report as the database adds it up. */
export interface ProfitBucket {
  readonly key: string;
  readonly label: string;
  readonly orders: number;
  readonly revenue: Money;
  readonly cost: Money;
}

/** One row of the profit report. */
export interface ProfitRowFigures {
  readonly key: string;
  readonly label: string;
  readonly orders: number;
  readonly revenue: string;
  readonly cost: string;
  readonly profit: string;
}

/**
 * Turns the groups into the rows of the report, in the report's order, and adds the totals.
 *
 * Why: the doc of `GET /admin/reports/profit`: profit is revenue minus cost (it may be negative); `day` rows run oldest first, every
 * other split ranks by profit, highest first (ties by label, then key, so the order never flickers).
 *
 * @param groupBy what the report is split by
 * @param buckets the groups with their sums
 * @returns the rows and the totals over all of them
 */
export function profitRows(
  groupBy: ProfitGroup,
  buckets: readonly ProfitBucket[],
): { rows: ProfitRowFigures[]; totals: { orders: number; revenue: string; cost: string; profit: string } } {
  const withProfit = buckets.map((bucket) => ({ bucket, profit: bucket.revenue.sub(bucket.cost) }));
  withProfit.sort((a, b) => {
    if (groupBy === 'day') return a.bucket.key.localeCompare(b.bucket.key);
    return (
      b.profit.cmp(a.profit) || a.bucket.label.localeCompare(b.bucket.label) || a.bucket.key.localeCompare(b.bucket.key)
    );
  });
  const revenue = Money.sum(buckets.map((bucket) => bucket.revenue));
  const cost = Money.sum(buckets.map((bucket) => bucket.cost));
  return {
    rows: withProfit.map(({ bucket, profit }) => ({
      key: bucket.key,
      label: bucket.label,
      orders: bucket.orders,
      revenue: bucket.revenue.toWire(),
      cost: bucket.cost.toWire(),
      profit: profit.toWire(),
    })),
    totals: {
      orders: buckets.reduce((sum, bucket) => sum + bucket.orders, 0),
      revenue: revenue.toWire(),
      cost: cost.toWire(),
      profit: revenue.sub(cost).toWire(),
    },
  };
}

/**
 * The share of a supplier's finished orders that were rejected.
 *
 * Why: the supplier report's `rejectionRate`: `rejected / (completed + rejected) x 100`, or `null` when nothing finished yet.
 *
 * @param completed completed orders
 * @param rejected rejected orders
 * @returns a percent from 0 to 100, or `null`
 */
export function rejectionRate(completed: number, rejected: number): number | null {
  const finished = completed + rejected;
  return finished === 0 ? null : (rejected / finished) * 100;
}

/**
 * Rounds a duration in seconds to one decimal.
 *
 * @param seconds the mean from the database, or `null` when no order finished
 * @returns the rounded mean, or `null`
 */
export function roundSeconds(seconds: number | null): number | null {
  return seconds === null ? null : Math.round(seconds * 10) / 10;
}

/**
 * The money a wallet owes beyond zero: the credit in use.
 *
 * Why: the exposure report's `overdraftUsed` is `max(0, -balance)`. It is not capped at the credit limit: a limit that was lowered
 * below the credit in use (user rule 2) still shows what is really out.
 *
 * @param balance the wallet balance (negative while credit is used)
 * @returns the credit in use, zero for a wallet with money in it
 */
export function overdraftUsed(balance: Money): Money {
  return balance.isNegative() ? balance.neg() : Money.zero();
}

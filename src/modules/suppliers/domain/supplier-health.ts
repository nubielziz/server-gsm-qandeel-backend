// How a supplier is doing and how long its prepaid balance lasts (resolutions orders-suppliers-5, -7, health-commissions-8). Pure:
// the repository supplies the numbers. The system health view of feature 9 reuses these functions.
import { Decimal } from 'decimal.js';

/** The health words of the shared computation (the `service_checks` words, `CHECK_STATUSES`). */
export type SupplierHealthWord = 'ok' | 'degraded' | 'down' | 'unknown';

/** The words the suppliers page reads (`Supplier.health`). */
export type SupplierPageHealth = 'up' | 'degraded' | 'down';

/** Calls of one supplier over a window, counted by outcome. */
export interface CallCounts {
  readonly total: number;
  readonly errors: number;
  readonly timeouts: number;
}

/** The latest periodic check of a supplier (`service_checks`, written by feature 9). */
export interface LatestCheck {
  readonly status: SupplierHealthWord;
  /** Milliseconds since the check ran. */
  readonly ageMs: number;
}

/** Failure rate (errors plus timeouts, percent of calls) from which a supplier is `degraded`. */
export const DEGRADED_FAILURE_PERCENT = 5;
/** Failure rate from which a supplier is `down`: the critical level of the system health view. */
export const DOWN_FAILURE_PERCENT = 20;
/** A periodic check older than this is ignored in favour of the calls (the check runs every minute). */
export const CHECK_MAX_AGE_MS = 10 * 60_000;
/** With fewer calls than this, a failure rate is too noisy to call a supplier `down`. */
export const MIN_CALLS_FOR_DOWN = 5;

/**
 * Judges a supplier by its calls of the last 15 minutes.
 *
 * Why: health-commissions-8: errors and timeouts are counted apart but both are failures; no calls means `unknown`.
 *
 * @param calls the counts
 * @returns `unknown` without calls, else `down` / `degraded` / `ok` by the failure rate
 */
export function healthFromCalls(calls: CallCounts): SupplierHealthWord {
  if (calls.total <= 0) return 'unknown';
  const failurePercent = ((calls.errors + calls.timeouts) / calls.total) * 100;
  if (failurePercent >= DOWN_FAILURE_PERCENT) return calls.total >= MIN_CALLS_FOR_DOWN ? 'down' : 'degraded';
  return failurePercent >= DEGRADED_FAILURE_PERCENT ? 'degraded' : 'ok';
}

/**
 * The one shared health of a supplier.
 *
 * Why: orders-suppliers-5: the suppliers page and `GET /admin/system/suppliers` share one computation; the latest periodic check
 * decides while it is fresh, the calls decide otherwise; a disabled supplier is `unknown`.
 *
 * @param input the supplier's switch, its latest check and its recent calls
 * @returns the health word
 */
export function supplierHealth(input: {
  readonly status: 'active' | 'disabled' | 'paused';
  readonly check: LatestCheck | null;
  readonly calls: CallCounts;
}): SupplierHealthWord {
  if (input.status === 'disabled') return 'unknown';
  if (input.check && input.check.status !== 'unknown' && input.check.ageMs <= CHECK_MAX_AGE_MS)
    return input.check.status;
  return healthFromCalls(input.calls);
}

/**
 * Maps the shared health onto the suppliers page's three words.
 *
 * Why: orders-suppliers-5: `ok` is `up`, and a supplier with no checks yet (`unknown`) reads as `up`.
 *
 * @param word the shared health
 * @returns `up`, `degraded` or `down`
 */
export function toPageHealth(word: SupplierHealthWord): SupplierPageHealth {
  return word === 'degraded' ? 'degraded' : word === 'down' ? 'down' : 'up';
}

/**
 * Days the balance lasts at the 7-day spending rate.
 *
 * Why: orders-suppliers-7: `(balance x credit_rate) / (spend of the last 7 days / 7)`, rounded to one decimal, `null` when
 * nothing was spent.
 *
 * @param input the balance in supplier credits, the credit rate and the 7-day supplier cost (USD) of completed orders
 * @returns the days, or `null`
 */
export function runwayDays(input: { balance: string; creditRate: string; weeklySpend: string }): number | null {
  const spend = new Decimal(input.weeklySpend);
  if (spend.lte(0)) return null;
  const value = new Decimal(input.balance).mul(input.creditRate).div(spend.div(7));
  return value.toDecimalPlaces(1, Decimal.ROUND_HALF_UP).toNumber();
}

/**
 * The server's call on a low balance.
 *
 * Why: orders-suppliers-7: below the alert amount (both in the supplier's own credits) or less than two days left.
 *
 * @param input the balance, the alert amount and the runway
 * @returns true when the balance is low
 */
export function isLowBalance(input: { balance: string; lowBalanceAlert: string; runwayDays: number | null }): boolean {
  return new Decimal(input.balance).lt(input.lowBalanceAlert) || (input.runwayDays !== null && input.runwayDays < 2);
}

/**
 * Share of calls that worked, as a percentage with one decimal.
 *
 * @param ok calls that worked
 * @param total all calls
 * @returns 0 to 100, or `null` without calls
 */
export function successRate(ok: number, total: number): number | null {
  return total <= 0 ? null : Math.round((ok / total) * 1000) / 10;
}

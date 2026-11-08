// Commission arithmetic: the amount of an accrual, the period it belongs to and the sentence the audit trail prints for an amount.
// Rules: RULES commissions 1 and 4, resolution health-commissions-3 (feature 11).
import { Money } from '../../../common/money';

/**
 * The time zone that cuts months and days for commissions and reports.
 *
 * Why: RESOLUTIONS money-10 and ANSWERS finance Q7 say "one business time-zone setting, default UTC". No such setting exists
 * yet, so every day and month boundary of feature 11 is UTC; the single place that would read a setting is the caller of
 * {@link periodOf}.
 */
export const BUSINESS_TIME_ZONE = 'UTC';

/**
 * The commission of an order: its revenue times the plan's rate, rounded half up to 4 decimals.
 *
 * Why: RULES commissions 1 and 5: `amount = basis_amount x percent / 100`, with the percent the plan had when the order completed
 * (a later rate change never touches an accrual).
 *
 * @param basis the order's revenue (`orders.total_price`)
 * @param percent the plan's rate as stored (`3.0000` is 3 percent)
 * @returns the commission, 4 decimals
 */
export function accrualAmount(basis: Money, percent: string): Money {
  return basis.pct(percent);
}

/**
 * The accrual period of a completion: its month as `YYYY-MM`.
 *
 * Why: RULES commissions 1: `period` is the completion month in the business time zone ({@link BUSINESS_TIME_ZONE}, UTC).
 *
 * @param completedAt when the order completed
 * @returns the month, for example `2026-11`
 */
export function periodOf(completedAt: Date): string {
  return completedAt.toISOString().slice(0, 7);
}

/**
 * Writes an amount the way the demo's audit labels do: a dollar sign and at least two decimals, without needless zeros.
 *
 * Why: the demo logs `Zain Mobile Hub, 3 accruals, $1.05` (46-p-commissions.js); the audit screen prints the label as is.
 *
 * @param amount the amount
 * @returns for example `$1.05` for `1.0500` and `$0.2166` for `0.2166`
 */
export function moneyText(amount: Money): string {
  const [whole = '0', fraction = ''] = amount.toWire().split('.');
  const trimmed = fraction.replace(/0+$/, '');
  return `$${whole}.${trimmed.length < 2 ? trimmed.padEnd(2, '0') : trimmed}`;
}

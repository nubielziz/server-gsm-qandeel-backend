// Commission arithmetic: the amount of an accrual, the cap of an order's commissions by its margin (decision 049), the period it
// belongs to and the sentence the audit trail prints for an amount. Rules: RULES commissions 1 and 4, resolution health-commissions-3
// (feature 11).
import { Money } from '../../../common/money';
import type { CurrentPlan } from './accrual-rules';
import { planRateInBounds } from './plan-input';

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

/**
 * What one order may still pay in commissions: its margin (revenue minus cost) minus the commissions it already holds, never below zero.
 *
 * Why: decision 049: commissions are paid out of the margin, so together they never exceed it.
 *
 * @param revenue the order's `total_price`
 * @param cost the order's `total_cost`
 * @param alreadyAccrued the live accruals of the order (`accrued`, or `approved` and not paid back)
 * @returns the room left, 4 decimals
 */
export function commissionRoom(revenue: Money, cost: Money, alreadyAccrued: Money): Money {
  const room = revenue.sub(cost).sub(alreadyAccrued);
  return room.isPositive() ? room : Money.zero();
}

/** One accrual to write, and whether the margin cut it. */
export interface CappedAccrual {
  readonly plan: CurrentPlan;
  readonly amount: Money;
  readonly capped: boolean;
}

/**
 * The accruals of one completed order: each plan's rate of the revenue, in the order given, together never more than the room.
 *
 * Why: decision 049 (RULES commissions 1 amended): the order's own rebate comes first (the order `accruingPlans` returns), then the
 * referral. A plan whose stored rate is outside 0.5 to 15 percent, and an amount of zero, accrue nothing.
 *
 * @param basis the order's revenue
 * @param room what the order may still pay ({@link commissionRoom})
 * @param plans the plans that accrue, in order
 * @returns the accruals to write and the plans skipped for their rate
 */
export function cappedAccruals(
  basis: Money,
  room: Money,
  plans: readonly CurrentPlan[],
): { accruals: CappedAccrual[]; outOfBounds: CurrentPlan[] } {
  const accruals: CappedAccrual[] = [];
  const outOfBounds: CurrentPlan[] = [];
  let left = room;
  for (const plan of plans) {
    if (!planRateInBounds(plan.percent)) {
      outOfBounds.push(plan);
      continue;
    }
    const full = accrualAmount(basis, plan.percent);
    const amount = full.cmp(left) > 0 ? left : full;
    if (!amount.isPositive()) continue;
    accruals.push({ plan, amount, capped: amount.cmp(full) < 0 });
    left = left.sub(amount);
  }
  return { accruals, outOfBounds };
}

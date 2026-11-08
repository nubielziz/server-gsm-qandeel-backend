// The rules of a commission plan's input: the rate range and format, and the scope an assignment gets from its plan's kind.
// Rules: RULES commissions 5 to 7 and 9, ANSWERS commissions Q5 and Q6 (feature 11).
import { Money } from '../../../common/money';
import type { CommissionPlanKind } from '../db/schema';

/** The lowest rate a plan may pay, in percent (the demo's rule). */
export const MIN_PLAN_PERCENT = '0.5';
/** The highest rate a plan may pay, in percent (the demo's rule). */
export const MAX_PLAN_PERCENT = '15';

/** What an assignment covers: the orders of the merchants the agent referred, or the agent's own orders. */
export type AssignmentScope = 'referrals' | 'own';

const RATE_FORMAT = /^\d{1,3}(\.\d{1,4})?$/;

/**
 * Judges the rate a plan is saved with.
 *
 * Why: RULES commissions 5: a rate is 0.5 to 15 percent. The console only checks that it is above 0 and at most 100, so the
 * server's sentence is the demo's own (`Enter a rate between 0.5 and 15.`).
 *
 * @param text the rate as typed, for example `3.5`
 * @returns the sentence for the `percent` field, or `undefined` when the rate is acceptable
 */
export function planRateProblem(text: string): string | undefined {
  if (!RATE_FORMAT.test(text)) return 'Enter the rate as a number with at most 4 decimals, for example 3.5.';
  const rate = Money.of(text);
  if (rate.cmp(Money.of(MIN_PLAN_PERCENT)) < 0 || rate.cmp(Money.of(MAX_PLAN_PERCENT)) > 0) {
    return `Enter a rate between ${MIN_PLAN_PERCENT} and ${MAX_PLAN_PERCENT}.`;
  }
  return undefined;
}

/**
 * Writes an accepted rate the way the table stores it: 4 decimals.
 *
 * @param text a rate that passed {@link planRateProblem}
 * @returns for example `3.5000`
 */
export function normalisePercent(text: string): string {
  return Money.of(text).toWire();
}

/**
 * The scope an assignment gets from its plan: a referral plan covers the orders of referred merchants, a rebate plan the
 * merchant's own orders.
 *
 * Why: ANSWERS commissions Q6: the server sets the scope; the console never sends it.
 *
 * @param kind the plan's kind
 * @returns `referrals` or `own`
 */
export function scopeOf(kind: CommissionPlanKind): AssignmentScope {
  return kind === 'referral' ? 'referrals' : 'own';
}

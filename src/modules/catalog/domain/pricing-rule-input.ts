// Checks of a pricing rule before it is saved: the field problems the console shows under the rule form
// (POST/PATCH /admin/pricing-rules). Pure, so the merged rule of a PATCH is judged exactly like a new one.
import { Decimal } from 'decimal.js';
import type { PricingRuleKind, PricingScope } from '../db/schema';

/** The values of a rule as the form edits them (money and percent as decimal text). */
export interface RuleDraft {
  readonly scope: PricingScope;
  readonly targetId: number | null;
  readonly groupId: number | null;
  readonly kind: PricingRuleKind;
  readonly percent: string;
  readonly fixed: string;
  readonly minProfit: string;
  readonly priority: number;
  readonly startsAt: Date | null;
  readonly endsAt: Date | null;
}

/** One problem, on the field the console highlights. */
export interface RuleProblem {
  readonly field: string;
  readonly message: string;
}

/** The largest percent a margin may add. */
export const MAX_MARGIN_PERCENT = 1000;
/** The largest percent a discount or a promo may take off. */
export const MAX_DISCOUNT_PERCENT = 100;

/**
 * Judges the numbers and dates of a rule.
 *
 * Why: the console's rule form (RULES services 4): amounts are 0 or more (the kind gives the direction), at least one of
 * percent and fixed is above zero (else the rule does nothing), a discount cannot take more than all of the price, and the
 * window must run forwards (the table's CHECK needs `ends_at > starts_at`). Whether the target and the group exist is the use
 * case's job: it needs the database.
 *
 * @param draft the rule as it would be saved
 * @returns the problems, empty when the numbers and dates are fine
 */
export function ruleNumberProblems(draft: RuleDraft): RuleProblem[] {
  const problems: RuleProblem[] = [];
  const percent = new Decimal(draft.percent);
  const fixed = new Decimal(draft.fixed);
  const limit = draft.kind === 'margin' ? MAX_MARGIN_PERCENT : MAX_DISCOUNT_PERCENT;
  if (percent.gt(limit)) {
    problems.push({
      field: 'percent',
      message:
        draft.kind === 'margin'
          ? `A margin can add at most ${MAX_MARGIN_PERCENT}%.`
          : `A ${draft.kind} cannot take off more than ${MAX_DISCOUNT_PERCENT}%.`,
    });
  } else if (percent.isZero() && fixed.isZero()) {
    problems.push({ field: 'percent', message: 'Enter a percent or a fixed amount.' });
  }
  if (draft.startsAt && draft.endsAt && draft.endsAt.getTime() <= draft.startsAt.getTime()) {
    problems.push({ field: 'endsAt', message: 'The end date is before the start date.' });
  }
  return problems;
}

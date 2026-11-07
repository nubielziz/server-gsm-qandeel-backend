// The decision of the nightly merchant group promotion (user rule 1, ANSWERS merchants Q7), as a pure function: which group, if
// any, a merchant moves to given what it has spent.
import { Money } from '../../../common/money';

/** A group a merchant can be promoted into. */
export interface PromotionTarget {
  readonly id: number;
  /** The spend in USD that earns the group; above zero for every target. */
  readonly earnThreshold: Money;
  /** Whether merchants of the group may have a credit limit above zero (user rule 2, ip-3). */
  readonly overdraftAllowed: boolean;
}

/** The group a merchant is in now. */
export interface CurrentGroup {
  readonly id: number;
  readonly earnThreshold: Money;
}

/**
 * Picks the group a merchant is promoted into, or none.
 *
 * Why: user rule 1: the nightly job promotes a merchant, never demotes, to the merchant group with the highest `earn_threshold`
 * above zero that the merchant's cumulative completed-order spend reaches (threshold <= spend), and only when that threshold is
 * above the threshold of the group the merchant is in. A group at 0 is never a target (the caller only passes groups above
 * zero, and this function ignores any other), the storefront retail group is never a target (it is not passed), and a merchant
 * that staff moved to a higher group by hand stays there (nothing above its threshold is reachable). Equal thresholds go to the
 * lower group id, so the answer is stable. A second run finds the merchant already in the target and picks nothing.
 *
 * @param spend the merchant's cumulative completed spend in USD
 * @param current the group the merchant is in now
 * @param targets the groups that can be targets, in any order
 * @returns the target group, or `undefined` when the merchant stays
 */
export function decidePromotion(
  spend: Money,
  current: CurrentGroup,
  targets: readonly PromotionTarget[],
): PromotionTarget | undefined {
  let best: PromotionTarget | undefined;
  for (const target of targets) {
    if (!target.earnThreshold.isPositive()) continue;
    if (target.earnThreshold.cmp(spend) > 0) continue;
    if (target.earnThreshold.cmp(current.earnThreshold) <= 0) continue;
    const better =
      best === undefined ||
      target.earnThreshold.cmp(best.earnThreshold) > 0 ||
      (target.earnThreshold.cmp(best.earnThreshold) === 0 && target.id < best.id);
    if (better) best = target;
  }
  return best;
}

/**
 * Tells whether a promotion would break the credit rule: the target group does not allow credit while the merchant has a credit
 * limit.
 *
 * Why: RESOLUTIONS identity-platform-3 (ip-3): a merchant cannot sit in a group without overdraft while its credit limit is above
 * zero; the job skips such a promotion (and logs it) instead of changing the merchant's credit.
 *
 * @param target the group the merchant would move to
 * @param creditLimit the merchant's credit limit
 * @returns true when the move must be skipped
 */
export function breaksCreditRule(target: Pick<PromotionTarget, 'overdraftAllowed'>, creditLimit: Money): boolean {
  return !target.overdraftAllowed && creditLimit.isPositive();
}

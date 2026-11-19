// A retail price rule as the application reads it (decision 040, feature 31): the row with its amounts as Money and the
// server's label, mapped once for the price writer, the pricing reads and the admin routes.
import { Money } from '../../../common/money';
import type { RetailRounding, RetailRuleScope, ServiceType } from '../db/schema';
import { ruleLabel } from '../domain/retail-rule';
import type { RetailRuleRow } from '../infra/retail-price-rule.repository';

/** A retail price rule with its amounts as Money and its label. */
export interface RetailRule {
  readonly id: number;
  readonly scope: RetailRuleScope;
  readonly serviceType: ServiceType | null;
  readonly categoryId: number | null;
  readonly categoryName: string | null;
  /** Percent units as decimal text with four decimals (`'30.0000'`). */
  readonly percent: string;
  readonly fixed: Money;
  readonly rounding: RetailRounding;
  readonly roundFrom: Money;
  readonly autoFollowPercent: number;
  readonly isActive: boolean;
  readonly deletedAt: Date | null;
  /** The clock's time of the create and of the last edit. */
  readonly changedAt: Date;
  readonly updatedAt: Date;
  /** The server's words for the rule (`IMEI +30%`). */
  readonly label: string;
  /** The services whose price this rule wrote last. */
  readonly following: number;
}

/**
 * Maps a rule row to a {@link RetailRule}.
 *
 * Why: the price writer, `RetailPricing` and the admin routes read the same rule; one mapper keeps the label and the amounts
 * the same everywhere.
 *
 * @param row the rule with its category name and follower count
 * @returns the rule
 */
export function retailRuleOf(row: RetailRuleRow): RetailRule {
  const { rule } = row;
  const fixed = Money.of(rule.fixed);
  return {
    id: rule.id,
    scope: rule.scope,
    serviceType: rule.serviceType,
    categoryId: rule.categoryId,
    categoryName: row.categoryName,
    percent: rule.percent,
    fixed,
    rounding: rule.rounding,
    roundFrom: Money.of(rule.roundFrom),
    autoFollowPercent: rule.autoFollowPercent,
    isActive: rule.isActive,
    deletedAt: rule.deletedAt,
    changedAt: rule.changedAt,
    updatedAt: rule.updatedAt,
    label: ruleLabel({
      scope: rule.scope,
      serviceType: rule.serviceType,
      categoryName: row.categoryName,
      percent: rule.percent,
      fixed,
      rounding: rule.rounding,
    }),
    following: row.following,
  };
}

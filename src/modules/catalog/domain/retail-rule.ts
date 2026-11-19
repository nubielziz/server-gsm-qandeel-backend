// Retail price rules as pure functions (decision 040, plan 31 sections 3.3 and 3.4): which rule prices a service, the price a
// rule gives (cost plus a percent plus a fixed amount, never under the floor, rounded up), its label, and the publish and follow
// limit on a moving cost. Exact decimals (decision 011): no float ever touches a price.
import { Decimal } from 'decimal.js';
import { Money } from '../../../common/money';
import type { RetailRounding, RetailRuleScope, ServiceType } from '../db/schema';
import { dollars } from './service-figures';

/** Exact decimals, whatever the global Decimal settings are (a cost of 14 digits times a percent of 4 decimals stays exact). */
const D = Decimal.clone({ precision: 40, rounding: Decimal.ROUND_HALF_UP });

const dec = (value: Money): Decimal => new D(value.toWire());

/** The largest percent a rule may add (plan 31 section 3.3, the CHECK of `retail_price_rules.percent`). */
export const RETAIL_RULE_MAX_PERCENT = 1000;

/** The largest fixed amount and `roundFrom` a rule may carry, in dollars. */
export const RETAIL_RULE_MAX_AMOUNT = 100_000;

/** The largest `autoFollowPercent` (a whole number). */
export const RETAIL_RULE_MAX_AUTO_FOLLOW = 1000;

/** The default `autoFollowPercent`: a cost that moves more than 25 % waits for staff. */
export const DEFAULT_AUTO_FOLLOW_PERCENT = 25;

/** The default `roundFrom`: prices under $5.00 keep their cent. */
export const DEFAULT_ROUND_FROM = '5.0000';

/** The most following services a rule preview works out (plan 31 section 5.3); the figures cover the first by service id. */
export const RULE_PREVIEW_LIMIT = 2000;

/** The most lines a rule preview lists: the largest changes. */
export const RULE_PREVIEW_LINES = 100;

/** The figures of a rule that make its price. */
export interface RetailRuleFigures {
  /** Percent units as decimal text: `'30.0000'` is +30 %. */
  readonly percent: string;
  readonly fixed: Money;
  readonly rounding: RetailRounding;
  readonly roundFrom: Money;
}

/** What the evaluator needs of a service's quote: the effective cost and the storefront floor (both from `RetailPrices.quotes`). */
export interface RetailRuleQuote {
  readonly cost: Money;
  readonly floor: Money;
}

/**
 * What a rule gives a service: a price, or no price because the cost is 0.
 *
 * Why: a cost of 0 is never priced by a rule (plan 31 section 3.2): it is not a product, or one a person must price.
 */
export type RetailRulePrice =
  | {
      readonly kind: 'price';
      /** A whole number of cents, never under the floor, never under `raw`. */
      readonly price: Money;
      /** `cost x (1 + percent / 100) + fixed`, rounded half up to 4 decimals (for display). */
      readonly raw: Money;
      /** True when `raw` was under the floor and the floor was used instead. */
      readonly atFloor: boolean;
    }
  | { readonly kind: 'no_cost' };

/** Rounds a non-negative amount up to the next multiple of `step` (`step` > 0). */
function upToStep(value: Decimal, step: Decimal): Decimal {
  return value.div(step).toDecimalPlaces(0, Decimal.ROUND_CEIL).mul(step);
}

/** The rounding style applied to an amount in whole cents: always upwards, never below the amount. */
function roundUp(cents: Decimal, rounding: RetailRounding): Decimal {
  switch (rounding) {
    case 'cent':
      return cents;
    case 'step_0.05':
      return upToStep(cents, new D('0.05'));
    case 'step_0.10':
      return upToStep(cents, new D('0.1'));
    case 'ends_99':
      // The smallest n.99 that is not below: n = ceil(cents - 0.99). 13.00 -> 13.99, 13.99 -> 13.99, 18.00 -> 18.99.
      return cents.minus('0.99').toDecimalPlaces(0, Decimal.ROUND_CEIL).plus('0.99');
  }
}

/**
 * Works out the price a retail rule gives a service.
 *
 * Why: decision 040, plan 31 section 3.3: `raw = cost x (1 + percent / 100) + fixed`; `base = max(raw, floor)`; the base rounded
 * up to the cent (the shop charges cents rounded up, fact 4); then, from `roundFrom` on, the rounding style, always upwards.
 * The result is a whole number of cents, never under the floor and never under `raw`. A cost of 0 gives no price.
 *
 * @param rule the rule's percent, fixed amount, rounding and `roundFrom`
 * @param quote the effective cost and the storefront floor of the service, read in the same transaction
 * @returns the price (with `atFloor` when the floor lifted it), or `no_cost`
 * @throws {RangeError} when the cost is negative or the price does not fit `numeric(18,4)`
 */
export function evaluateRetailRule(rule: RetailRuleFigures, quote: RetailRuleQuote): RetailRulePrice {
  if (quote.cost.isNegative()) throw new RangeError('A cost cannot be negative.');
  if (quote.cost.isZero()) return { kind: 'no_cost' };
  const raw = dec(quote.cost)
    .mul(new D(1).plus(new D(rule.percent).div(100)))
    .plus(dec(rule.fixed));
  const floor = dec(quote.floor);
  const atFloor = raw.lt(floor);
  const base = atFloor ? floor : raw;
  const cents = base.toDecimalPlaces(2, Decimal.ROUND_CEIL);
  const price = cents.gte(dec(rule.roundFrom)) ? roundUp(cents, rule.rounding) : cents;
  return {
    kind: 'price',
    price: Money.of(price.toFixed(2)),
    raw: Money.of(raw.toDecimalPlaces(4, Decimal.ROUND_HALF_UP).toFixed(4)),
    atFloor,
  };
}

/** What {@link pickRetailRule} reads of a rule. */
export interface PickableRetailRule {
  readonly scope: RetailRuleScope;
  readonly serviceType: ServiceType | null;
  readonly categoryId: number | null;
  readonly isActive: boolean;
  readonly deletedAt: Date | null;
}

/** What {@link pickRetailRule} reads of a service. */
export interface RetailRuleTarget {
  readonly type: ServiceType;
  readonly categoryId: number;
}

/**
 * Picks the rule that prices a service: the active rule of its category, else of its type, else the global one.
 *
 * Why: decision 040, plan 31 section 3.3: the most specific active rule wins; an inactive or deleted rule counts nowhere.
 *
 * @param rules the rules to choose from (any order; inactive and deleted ones are skipped)
 * @param service the service's type and category
 * @returns the rule, or `undefined` when none matches
 */
export function pickRetailRule<R extends PickableRetailRule>(
  rules: readonly R[],
  service: RetailRuleTarget,
): R | undefined {
  const live = rules.filter((rule) => rule.isActive && rule.deletedAt === null);
  return (
    live.find((rule) => rule.scope === 'category' && rule.categoryId === service.categoryId) ??
    live.find((rule) => rule.scope === 'type' && rule.serviceType === service.type) ??
    live.find((rule) => rule.scope === 'global')
  );
}

/** One refusal of a rule's target fields: the field and the sentence. */
export interface RetailRuleTargetProblem {
  readonly field: 'serviceType' | 'categoryId';
  readonly message: string;
}

/**
 * Judges the target fields of a new rule against its scope.
 *
 * Why: plan 31 section 5.3: `global` has neither target, `type` has `serviceType` only, `category` has `categoryId` only (the
 * CHECK `retail_price_rules_target_check` is the backstop); a field that does not fit the scope is `422` with the code
 * `invalid`, decided before the first write.
 *
 * @param scope the rule's scope
 * @param serviceType the type sent, or `null`
 * @param categoryId the category sent, or `null`
 * @returns the problems (empty when the target fits)
 */
export function retailRuleTargetProblems(
  scope: RetailRuleScope,
  serviceType: ServiceType | null,
  categoryId: number | null,
): RetailRuleTargetProblem[] {
  const problems: RetailRuleTargetProblem[] = [];
  if (scope === 'type' && serviceType === null) {
    problems.push({ field: 'serviceType', message: 'Choose the service type.' });
  }
  if (scope !== 'type' && serviceType !== null) {
    problems.push({ field: 'serviceType', message: 'Only a rule for a service type names one.' });
  }
  if (scope === 'category' && categoryId === null) {
    problems.push({ field: 'categoryId', message: 'Choose the category.' });
  }
  if (scope !== 'category' && categoryId !== null) {
    problems.push({ field: 'categoryId', message: 'Only a rule for a category names one.' });
  }
  return problems;
}

/** The words of a service type in a label. */
const TYPE_WORDS: Readonly<Record<ServiceType, string>> = {
  imei: 'IMEI',
  server: 'Server',
  remote: 'Remote',
  file: 'File',
};

/** The words of a rounding style in a label (`cent` says nothing). */
const ROUNDING_WORDS: Readonly<Record<RetailRounding, string>> = {
  cent: '',
  'step_0.05': 'rounded up to $0.05',
  'step_0.10': 'rounded up to $0.10',
  ends_99: 'ends in .99',
};

/** What {@link ruleLabel} reads of a rule. */
export interface LabelledRetailRule {
  readonly scope: RetailRuleScope;
  readonly serviceType: ServiceType | null;
  /** The category's name, for a category rule. */
  readonly categoryName: string | null;
  readonly percent: string;
  readonly fixed: Money;
  readonly rounding: RetailRounding;
}

/**
 * Writes the server's words for a rule: `Every service +25%, ends in .99`, `IMEI +30%`, `AT&T USA +20% +$0.50`.
 *
 * Why: plan 31 section 5.3: the console shows the label as it is, and the history of a price (a change, a publish row) names
 * the rule by it even after the rule was deleted.
 *
 * @param rule the rule's target and figures
 * @returns the label
 */
export function ruleLabel(rule: LabelledRetailRule): string {
  const target =
    rule.scope === 'global'
      ? 'Every service'
      : rule.scope === 'type'
        ? rule.serviceType === null
          ? 'One service type'
          : TYPE_WORDS[rule.serviceType]
        : (rule.categoryName ?? 'A deleted category');
  const percent = new D(rule.percent).toFixed();
  const fixed = rule.fixed.isPositive() ? ` +${dollars(rule.fixed)}` : '';
  const rounding = ROUNDING_WORDS[rule.rounding];
  return `${target} +${percent}%${fixed}${rounding === '' ? '' : `, ${rounding}`}`;
}

/**
 * Tells whether a cost moved by more than a limit: `abs(to - from) x 100 > from x percent`.
 *
 * Why: decision 040, plan 31 section 3.4: a supplier's wrong cost for one sync must not become a shop price nobody saw. The
 * follow pass compares the cost a price was worked out from with the cost of now, the publisher the preview's cost with the cost
 * of now. Exact decimals and no division: a move of exactly the limit is followed; a `from` of 0 makes any other cost a jump;
 * a limit of 0 makes any move a jump (the safe side).
 *
 * @param from the earlier cost
 * @param to the cost of now
 * @param percent the limit in whole percent (`autoFollowPercent`)
 * @returns true when the move is over the limit
 * @throws {RangeError} when the limit is not a whole number from 0 to 1000
 */
export function costMoved(from: Money, to: Money, percent: number): boolean {
  if (!Number.isSafeInteger(percent) || percent < 0 || percent > RETAIL_RULE_MAX_AUTO_FOLLOW) {
    throw new RangeError('The limit is a whole percent from 0 to 1000.');
  }
  const move = dec(to).minus(dec(from)).abs().mul(100);
  return move.gt(dec(from).mul(percent));
}

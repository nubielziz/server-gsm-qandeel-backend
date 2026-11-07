// The price resolver as pure functions (user rule 8, RESOLUTIONS catalog-4): which fixed price or rule decides, the group
// discount, the rounding steps, the floor clamp and the trace the console draws (GET /admin/pricing/resolve). Exact decimals
// (decision 011); the loader that feeds it is application/price-resolver.ts.
import { Decimal } from 'decimal.js';
import { Money } from '../../../common/money';
import type { PricingRounding, PricingRuleKind, PricingScope } from '../db/schema';
import { defaultMinProfit, dollars } from './service-figures';

/** Exact decimals with half-up rounding, whatever the global Decimal settings are. */
const D = Decimal.clone({ precision: 40, rounding: Decimal.ROUND_HALF_UP });

/** What the resolver needs to know about a service. */
export interface PricedService {
  readonly id: number;
  readonly name: string;
  readonly categoryId: number;
  readonly categoryName: string;
  readonly basePrice: Money;
  /** The effective cost (RESOLUTIONS catalog-1): the floor starts from it. */
  readonly effectiveCost: Money;
  /** The service's own minimum profit; `null` follows the rules and then the default policy. */
  readonly minProfit: Money | null;
}

/** What the resolver needs to know about a merchant group. */
export interface PricedGroup {
  readonly id: number;
  readonly name: string;
  /** The group discount as the database prints it (`'4.0000'` is 4 %). */
  readonly discountPercent: string;
}

/** A pricing rule as the resolver reads it (the row plus the name of its target). */
export interface PricingRuleInput {
  readonly id: number;
  readonly scope: PricingScope;
  readonly targetId: number | null;
  /** The category or service name, for the trace note. */
  readonly targetName: string;
  readonly groupId: number | null;
  readonly kind: PricingRuleKind;
  /** Percent units, as the database prints it (`'2.0000'` is 2 %). */
  readonly percent: string;
  readonly fixed: string;
  readonly rounding: PricingRounding;
  readonly minProfit: string;
  readonly priority: number;
  readonly isActive: boolean;
  readonly startsAt: Date | null;
  readonly endsAt: Date | null;
}

/** One step of the trace (the console's `PriceStep`, and the shape an order's `pricing_snapshot` keeps). */
export interface PriceStep {
  readonly id: 'client' | 'group' | 'base' | 'category' | 'discount' | 'rounding';
  readonly label: string;
  /** `win` decided the price, `apply` changed it, `skip` was passed over, `none` was not set. */
  readonly state: 'win' | 'apply' | 'skip' | 'none';
  /** A price (4-decimal text), or a signed fraction (a number) for the `category` and `discount` steps. */
  readonly value: string | number | null;
  /** The running price after the step, when the step changed or decided it. */
  readonly after: string | null;
  readonly note: string;
}

/** Where the price before rules came from. */
export type PriceSource = 'client' | 'group' | 'base';

/** The outcome of one resolution. */
export interface PriceResolution {
  /** The final price, after the floor clamp. */
  readonly price: Money;
  /** The price before the clamp (after the rule, the discount and the rounding steps). */
  readonly rawPrice: Money;
  readonly floor: Money;
  readonly clamped: boolean;
  readonly source: PriceSource;
  /** The effective cost (so `cost + minProfit = floor`). */
  readonly cost: Money;
  /** The minimum profit that counts: the service's, else the first rule's with one, else the default policy. */
  readonly minProfit: Money;
  /** `price - cost`. */
  readonly margin: Money;
  /** `margin / price x 100`, four decimals. */
  readonly marginPct: string;
  readonly steps: readonly PriceStep[];
  /** The rule that adjusted the price (or would have, were the price not fixed), `null` when none matched. */
  readonly ruleId: number | null;
}

/** The inputs of {@link resolveServicePrice}. */
export interface ResolveInput {
  readonly service: PricedService;
  /** The merchant's group; `null` without a merchant (then only rules for every group match, and there is no discount). */
  readonly group: PricedGroup | null;
  readonly clientPrice: Money | null;
  readonly groupPrice: Money | null;
  /** Every rule that could matter (active or not, any scope): the resolver filters them. */
  readonly rules: readonly PricingRuleInput[];
  /** The time the rule windows are judged at (the clock's now). */
  readonly at: Date;
}

const SCOPE_RANK: Readonly<Record<PricingScope, number>> = { service: 0, category: 1, global: 2 };
const SCOPE_LABEL: Readonly<Record<PricingScope, string>> = {
  service: 'Service rule',
  category: 'Category rule',
  global: 'Global rule',
};

const dec = (value: Money | string): Decimal => new D(typeof value === 'string' ? value : value.toWire());

/** Writes an exact decimal as 4-decimal money text (it must already have at most 4 decimals). */
const wire = (value: Decimal): string => Money.of(value.toFixed(4)).toWire();

/** Rounds half-up to cents and writes the result as money text. */
const cents = (value: Decimal): string => wire(value.toDecimalPlaces(2, Decimal.ROUND_HALF_UP));

/** A percent without trailing zeros: `'4.0000'` is `4`, `'2.5000'` is `2.5`. */
function percentText(percent: string): string {
  const text = new D(percent).toFixed(4);
  return text.includes('.') ? text.replace(/\.?0+$/, '') : text;
}

/**
 * Tells whether a rule is in force at a moment for a merchant group and a service.
 *
 * Why: catalog-4 step 4: active, inside its window (`starts_at` null or at most now, `ends_at` null or after now), for every
 * group or the merchant's, and aimed at this service, its category or everything. Without a merchant (`groupId` null) only
 * rules for every group match.
 *
 * @param rule the rule
 * @param service the service (its id and category)
 * @param groupId the merchant's group, or `null` without a merchant
 * @param at the moment to judge the window at
 * @returns true when the rule can apply
 */
export function ruleMatches(
  rule: PricingRuleInput,
  service: Pick<PricedService, 'id' | 'categoryId'>,
  groupId: number | null,
  at: Date,
): boolean {
  if (!rule.isActive) return false;
  if (rule.startsAt !== null && rule.startsAt.getTime() > at.getTime()) return false;
  if (rule.endsAt !== null && rule.endsAt.getTime() <= at.getTime()) return false;
  if (rule.groupId !== null && rule.groupId !== groupId) return false;
  if (rule.scope === 'service') return rule.targetId === service.id;
  if (rule.scope === 'category') return rule.targetId === service.categoryId;
  return true;
}

/**
 * Lists the rules that match, in the resolver's order: scope (service, category, global), then priority ascending, then the
 * rules of one group before the rules for every group, then id.
 *
 * Why: catalog-4: the first rule decides the price step and the rounding; the first rule with a minimum profit sets the floor.
 *
 * @param rules every rule that might matter
 * @param service the service (its id and category)
 * @param groupId the merchant's group, or `null` without a merchant
 * @param at the moment to judge the windows at
 * @returns the matching rules, best first
 */
export function orderedRules(
  rules: readonly PricingRuleInput[],
  service: Pick<PricedService, 'id' | 'categoryId'>,
  groupId: number | null,
  at: Date,
): PricingRuleInput[] {
  return rules
    .filter((rule) => ruleMatches(rule, service, groupId, at))
    .sort(
      (a, b) =>
        SCOPE_RANK[a.scope] - SCOPE_RANK[b.scope] ||
        a.priority - b.priority ||
        Number(b.groupId !== null) - Number(a.groupId !== null) ||
        a.id - b.id,
    );
}

/**
 * Picks the minimum profit a matching rule asks for: the first rule in resolver order with one above zero.
 *
 * @param ordered the matching rules from {@link orderedRules}
 * @returns the rule's minimum profit, or `null` when none of them sets one
 */
export function ruleMinProfit(ordered: readonly PricingRuleInput[]): Money | null {
  const rule = ordered.find((candidate) => dec(candidate.minProfit).gt(0));
  return rule ? Money.of(rule.minProfit) : null;
}

/**
 * Works out the minimum profit that counts and the floor for a service and a group.
 *
 * Why: catalog-1 and catalog-4: `services.min_profit` when set, else the first matching rule's `min_profit` above zero (rules
 * for every group only when there is no merchant group), else the default policy. The floor is the effective cost plus it.
 *
 * @param service the service
 * @param groupId the merchant group, or `null` for a context without a merchant
 * @param rules every rule that might matter
 * @param at the moment to judge the rule windows at
 * @returns the minimum profit and the floor price
 */
export function floorFor(
  service: PricedService,
  groupId: number | null,
  rules: readonly PricingRuleInput[],
  at: Date,
): { readonly minProfit: Money; readonly floor: Money } {
  const minProfit =
    service.minProfit ??
    ruleMinProfit(orderedRules(rules, service, groupId, at)) ??
    defaultMinProfit(service.effectiveCost);
  return { minProfit, floor: service.effectiveCost.add(minProfit) };
}

/**
 * Writes the sentence a price under its floor is refused with.
 *
 * Why: RESOLUTIONS catalog-12 and the console's client price dialog show this exact wording under the price field.
 *
 * @param cost the effective cost
 * @param minProfit the minimum profit that counts
 * @returns `Below the floor of $X (cost $Y plus $Z minimum profit).`
 */
export function belowFloorMessage(cost: Money, minProfit: Money): string {
  return `Below the floor of ${dollars(cost.add(minProfit))} (cost ${dollars(cost)} plus ${dollars(minProfit)} minimum profit).`;
}

/**
 * The lowest retail price the storefront accepts: `max(round(base_price x 1.10, 2), floor)`.
 *
 * Why: RESOLUTIONS catalog-12 and b2c-7: the b2c_retail row of the group prices and `PATCH /admin/service-listings` use the
 * same function, so the two routes never disagree.
 *
 * @param basePrice the service's base price
 * @param floor the floor of the b2c_retail group (effective cost plus its minimum profit)
 * @returns the storefront floor
 */
export function storefrontFloor(basePrice: Money, floor: Money): Money {
  const markup = Money.of(dec(basePrice).mul('1.1').toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toFixed(2));
  return markup.cmp(floor) >= 0 ? markup : floor;
}

/**
 * Rounds a price to the style a rule asks for.
 *
 * Why: catalog-4 step 6: `nearest_0.05` and `nearest_0.10` round half-up to that step; `ends_99` is the whole dollars plus
 * 0.99 (so 17.28 becomes 17.99, and 17.99 stays).
 *
 * @param price the price, already rounded to cents
 * @param rounding the rule's rounding
 * @returns the rounded price
 */
export function applyRounding(price: Decimal, rounding: PricingRounding): Decimal {
  switch (rounding) {
    case 'none':
      return price;
    case 'nearest_0.05':
      return price.div('0.05').toDecimalPlaces(0, Decimal.ROUND_HALF_UP).mul('0.05');
    case 'nearest_0.10':
      return price.div('0.1').toDecimalPlaces(0, Decimal.ROUND_HALF_UP).mul('0.1');
    case 'ends_99':
      return price.floor().plus('0.99');
  }
}

/** The words of the rounding note. */
const ROUNDING_NOTE: Readonly<Record<PricingRounding, string>> = {
  none: '',
  'nearest_0.05': 'Rounded to the nearest $0.05',
  'nearest_0.10': 'Rounded to the nearest $0.10',
  ends_99: 'Prices end in .99',
};

/** Describes what a rule did in the trace: `Carrier unlock discount -2%`, `All services margin +5% and +$0.50`. */
function ruleNote(rule: PricingRuleInput): string {
  const sign = rule.kind === 'margin' ? '+' : '-';
  const pieces: string[] = [];
  if (dec(rule.percent).gt(0)) pieces.push(`${sign}${percentText(rule.percent)}%`);
  if (dec(rule.fixed).gt(0)) pieces.push(`${sign}${dollars(Money.of(rule.fixed))}`);
  const target = rule.scope === 'global' ? 'All services' : rule.targetName;
  return `${target} ${rule.kind} ${pieces.join(' and ')}`.trim();
}

/**
 * Resolves the price of one service for one merchant group (and one merchant, when a client price is given).
 *
 * Why: user rule 8 and RESOLUTIONS catalog-4, step by step: a client price wins, else a group price, else the base price; one
 * pricing rule (margin adds, discount and promo subtract) and the group discount adjust a price that no fixed price decided;
 * the result is rounded half-up to cents; the rule's own rounding follows; then the floor (effective cost plus minimum profit)
 * clamps it. Fixed prices skip the rule, the discount and both roundings. Every step is reported in the order and with the
 * ids the console's trace draws.
 *
 * @param input the service, group, fixed prices, rules and the moment
 * @returns the price, the raw price, the floor, the margin and the steps
 */
export function resolveServicePrice(input: ResolveInput): PriceResolution {
  const { service, group, clientPrice, groupPrice, at } = input;
  const groupId = group?.id ?? null;
  const ordered = orderedRules(input.rules, service, groupId, at);
  const winner = ordered[0];
  const fixedPrice = clientPrice ?? groupPrice;
  const fixed = fixedPrice !== null;
  const skipNote = 'Skipped, a fixed price applies';
  const groupName = group?.name ?? 'the merchant';
  const steps: PriceStep[] = [];

  steps.push({
    id: 'client',
    label: 'Client override',
    state: clientPrice ? 'win' : 'none',
    value: clientPrice?.toWire() ?? null,
    after: clientPrice?.toWire() ?? null,
    note: clientPrice ? 'Fixed price set for this merchant' : 'None for this merchant',
  });
  steps.push({
    id: 'group',
    label: 'Group service price',
    state: clientPrice ? 'skip' : groupPrice ? 'win' : 'none',
    value: groupPrice?.toWire() ?? null,
    after: !clientPrice && groupPrice ? groupPrice.toWire() : null,
    note: clientPrice
      ? 'Skipped, client override wins'
      : groupPrice
        ? `${groupName} price for this service`
        : `None for the ${groupName} group`,
  });

  const cost = dec(service.effectiveCost);
  const base = dec(service.basePrice);
  steps.push({
    id: 'base',
    label: 'Base price',
    state: fixed ? 'skip' : 'apply',
    value: service.basePrice.toWire(),
    after: fixed ? null : cents(base),
    note: fixed
      ? skipNote
      : cost.gt(0)
        ? `Cost ${dollars(service.effectiveCost)} plus ${base.div(cost).minus(1).mul(100).toDecimalPlaces(1).toFixed(1)}% markup`
        : 'No cost on record',
  });

  let running = fixed ? dec(fixedPrice) : base;

  // Step 4: the rule. The label names the winning rule's scope; with no rule the demo's "Category rule" stands.
  const ruleLabel = winner ? SCOPE_LABEL[winner.scope] : 'Category rule';
  if (fixed) {
    steps.push({ id: 'category', label: ruleLabel, state: 'skip', value: null, after: null, note: skipNote });
  } else if (winner) {
    const direction = winner.kind === 'margin' ? 1 : -1;
    const before = running;
    running = before
      .mul(new D(1).plus(dec(winner.percent).div(100).mul(direction)))
      .plus(dec(winner.fixed).mul(direction));
    const fraction = before.isZero()
      ? new D(0)
      : running.div(before).minus(1).toDecimalPlaces(4, Decimal.ROUND_HALF_UP);
    steps.push({
      id: 'category',
      label: ruleLabel,
      state: 'apply',
      value: fraction.toNumber(),
      after: cents(running),
      note: ruleNote(winner),
    });
  } else {
    steps.push({
      id: 'category',
      label: ruleLabel,
      state: 'none',
      value: null,
      after: null,
      note: `No rule for ${service.categoryName}`,
    });
  }

  // Step 5: the group discount.
  const discount = group ? dec(group.discountPercent).div(100) : new D(0);
  if (fixed) {
    steps.push({
      id: 'discount',
      label: 'Group discount',
      state: 'skip',
      value: discount.isZero() ? null : discount.toNumber(),
      after: null,
      note: skipNote,
    });
  } else {
    if (!discount.isZero()) running = running.mul(new D(1).minus(discount));
    steps.push({
      id: 'discount',
      label: 'Group discount',
      state: discount.isZero() ? 'none' : 'apply',
      value: discount.isZero() ? null : discount.toNumber(),
      after: discount.isZero() ? null : cents(running),
      note: discount.isZero()
        ? `${groupName} group has no discount`
        : `${groupName} group -${percentText(group!.discountPercent)}%`,
    });
  }

  // Cents once, then the rule's own rounding (not for a fixed price: it is exactly what staff typed).
  let raw = fixed ? running : running.toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
  if (!fixed && winner && winner.rounding !== 'none') {
    raw = applyRounding(raw, winner.rounding);
    steps.push({
      id: 'rounding',
      label: 'Rounding',
      state: 'apply',
      value: wire(raw),
      after: wire(raw),
      note: ROUNDING_NOTE[winner.rounding],
    });
  }

  const rawPrice = Money.of(raw.toFixed(4));
  const { minProfit, floor } = floorFor(service, groupId, input.rules, at);
  const clamped = rawPrice.cmp(floor) < 0;
  const price = clamped ? floor : rawPrice;
  const margin = price.sub(service.effectiveCost);
  const marginPct = price.isPositive()
    ? dec(margin).mul(100).div(dec(price)).toDecimalPlaces(4, Decimal.ROUND_HALF_UP).toFixed(4)
    : '0.0000';

  return {
    price,
    rawPrice,
    floor,
    clamped,
    source: clientPrice ? 'client' : groupPrice ? 'group' : 'base',
    cost: service.effectiveCost,
    minProfit,
    margin,
    marginPct,
    steps,
    ruleId: winner?.id ?? null,
  };
}

// Unit tests of the price resolver, step by step with the demo's worked examples (reference/gsm-admin 10-data.js resolveWith,
// RULES services 3, RESOLUTIONS catalog-4): fixed prices, the rule step and its order, the group discount, both roundings and
// the floor clamp.
import { describe, expect, it } from 'bun:test';
import { Decimal } from 'decimal.js';
import { Money } from '../../../common/money';
import {
  type PricedGroup,
  type PricedService,
  type PricingRuleInput,
  applyRounding,
  belowFloorMessage,
  floorFor,
  orderedRules,
  resolveServicePrice,
  ruleMatches,
  ruleMinProfit,
  storefrontFloor,
} from './price-resolution';

const AT = new Date('2026-11-07T12:00:00.000Z');
const m = (text: string) => Money.of(text);

const CARRIER = 4;
/** The demo's AT&T unlock: cost 13.50, price 17.28, own minimum profit 0.81 (floor 14.31). */
const att: PricedService = {
  id: 5,
  name: 'AT&T USA Premier Unlock',
  categoryId: CARRIER,
  categoryName: 'Carrier unlock',
  basePrice: m('17.28'),
  effectiveCost: m('13.5'),
  minProfit: m('0.81'),
};
/** The demo's iCloud check: cost 0.08, price 0.13, default minimum profit 0.02 (floor 0.10). */
const icloud: PricedService = {
  id: 1,
  name: 'iCloud Clean / Lost Check',
  categoryId: 1,
  categoryName: 'Apple',
  basePrice: m('0.13'),
  effectiveCost: m('0.08'),
  minProfit: null,
};
const standard: PricedGroup = { id: 1, name: 'Standard', discountPercent: '0.0000' };
const wholesale: PricedGroup = { id: 2, name: 'Wholesale', discountPercent: '4.0000' };
const vip: PricedGroup = { id: 3, name: 'VIP', discountPercent: '8.0000' };

let nextRuleId = 1;
const rule = (overrides: Partial<PricingRuleInput> = {}): PricingRuleInput => ({
  id: nextRuleId++,
  scope: 'category',
  targetId: CARRIER,
  targetName: 'Carrier unlock',
  groupId: null,
  kind: 'discount',
  percent: '2.0000',
  fixed: '0.0000',
  rounding: 'none',
  minProfit: '0.0000',
  priority: 100,
  isActive: true,
  startsAt: null,
  endsAt: null,
  ...overrides,
});
/** The demo's one category rule: Carrier unlock minus 2 %. */
const promo = rule();

const resolve = (
  service: PricedService,
  group: PricedGroup | null,
  options: { clientPrice?: string; groupPrice?: string; rules?: PricingRuleInput[]; at?: Date } = {},
) =>
  resolveServicePrice({
    service,
    group,
    clientPrice: options.clientPrice ? m(options.clientPrice) : null,
    groupPrice: options.groupPrice ? m(options.groupPrice) : null,
    rules: options.rules ?? [],
    at: options.at ?? AT,
  });

describe('resolveServicePrice: the demo examples', () => {
  it('prices the base price when nothing else applies (Standard, no rule)', () => {
    const result = resolve(att, standard);
    expect(result.price.toWire()).toBe('17.2800');
    expect(result.rawPrice.toWire()).toBe('17.2800');
    expect(result.floor.toWire()).toBe('14.3100');
    expect(result.clamped).toBe(false);
    expect(result.source).toBe('base');
    expect(result.cost.toWire()).toBe('13.5000');
    expect(result.minProfit.toWire()).toBe('0.8100');
    expect(result.margin.toWire()).toBe('3.7800');
    expect(result.marginPct).toBe('21.8750');
    expect(result.steps.map((step) => [step.id, step.state])).toEqual([
      ['client', 'none'],
      ['group', 'none'],
      ['base', 'apply'],
      ['category', 'none'],
      ['discount', 'none'],
    ]);
    expect(result.steps[2]).toMatchObject({
      label: 'Base price',
      value: '17.2800',
      after: '17.2800',
      note: 'Cost $13.50 plus 28.0% markup',
    });
    expect(result.steps[3]).toMatchObject({ label: 'Category rule', note: 'No rule for Carrier unlock' });
    expect(result.steps[4]).toMatchObject({ note: 'Standard group has no discount' });
  });

  it('applies the category rule: Carrier unlock minus 2 % gives 17.28 x 0.98 = 16.9344, rounded to 16.93', () => {
    const result = resolve(att, standard, { rules: [promo] });
    expect(result.price.toWire()).toBe('16.9300');
    expect(result.ruleId).toBe(promo.id);
    expect(result.steps[3]).toEqual({
      id: 'category',
      label: 'Category rule',
      state: 'apply',
      value: -0.02,
      after: '16.9300',
      note: 'Carrier unlock discount -2%',
    });
  });

  it('applies the group discount after the rule and rounds once at the end (Wholesale 4 %)', () => {
    const result = resolve(att, wholesale, { rules: [promo] });
    // 17.28 x 0.98 x 0.96 = 16.257024
    expect(result.price.toWire()).toBe('16.2600');
    expect(result.steps[4]).toMatchObject({
      id: 'discount',
      state: 'apply',
      value: 0.04,
      after: '16.2600',
      note: 'Wholesale group -4%',
    });
  });

  it('uses the group price as a fixed price and skips the rule and the discount (VIP, AT&T 15.90)', () => {
    const result = resolve(att, vip, { groupPrice: '15.9', rules: [promo] });
    expect(result.price.toWire()).toBe('15.9000');
    expect(result.source).toBe('group');
    expect(result.steps.map((step) => [step.id, step.state])).toEqual([
      ['client', 'none'],
      ['group', 'win'],
      ['base', 'skip'],
      ['category', 'skip'],
      ['discount', 'skip'],
    ]);
    expect(result.steps[1]).toMatchObject({ value: '15.9000', after: '15.9000', note: 'VIP price for this service' });
    expect(result.steps[2]).toMatchObject({ value: '17.2800', after: null, note: 'Skipped, a fixed price applies' });
    expect(result.steps[4]).toMatchObject({ value: 0.08, note: 'Skipped, a fixed price applies' });
  });

  it('lets a client price win over the group price (Cairo, VIP, AT&T 15.20)', () => {
    const result = resolve(att, vip, { clientPrice: '15.2', groupPrice: '15.9', rules: [promo] });
    expect(result.price.toWire()).toBe('15.2000');
    expect(result.source).toBe('client');
    expect(result.steps[0]).toMatchObject({
      state: 'win',
      value: '15.2000',
      note: 'Fixed price set for this merchant',
    });
    expect(result.steps[1]).toMatchObject({ state: 'skip', note: 'Skipped, client override wins' });
  });

  it('does not round a fixed price: it is what staff typed', () => {
    const result = resolve(att, standard, { clientPrice: '15.1234' });
    expect(result.price.toWire()).toBe('15.1234');
    expect(result.rawPrice.toWire()).toBe('15.1234');
  });

  it('raises a price under the floor to the floor and says so (iCloud check for VIP: 0.13 x 0.92 = 0.1196 is 0.12)', () => {
    const rounded = resolve(icloud, vip);
    expect(rounded.price.toWire()).toBe('0.1200');
    expect(rounded.clamped).toBe(false);
    const clamped = resolve(icloud, vip, { groupPrice: '0.05' });
    expect(clamped.rawPrice.toWire()).toBe('0.0500');
    expect(clamped.price.toWire()).toBe('0.1000');
    expect(clamped.floor.toWire()).toBe('0.1000');
    expect(clamped.clamped).toBe(true);
    expect(clamped.margin.toWire()).toBe('0.0200');
    expect(clamped.marginPct).toBe('20.0000');
  });

  it('a client price at the floor is not clamped (m1, iCloud check 0.10)', () => {
    const result = resolve(icloud, standard, { clientPrice: '0.1' });
    expect(result.price.toWire()).toBe('0.1000');
    expect(result.clamped).toBe(false);
  });

  it('says "No cost on record" instead of a markup when the cost is zero', () => {
    const free = { ...icloud, effectiveCost: m('0') };
    expect(resolve(free, standard).steps[2]?.note).toBe('No cost on record');
  });
});

describe('the rule step', () => {
  it('adds a margin with a percent and a fixed amount: p x (1 + pct) + fixed', () => {
    const margin = rule({ kind: 'margin', percent: '5.0000', fixed: '0.5000' });
    const result = resolve(att, standard, { rules: [margin] });
    // 17.28 x 1.05 + 0.50 = 18.644
    expect(result.price.toWire()).toBe('18.6400');
    expect(result.steps[3]).toMatchObject({
      state: 'apply',
      value: 0.0789,
      note: 'Carrier unlock margin +5% and +$0.50',
    });
  });

  it('takes a fixed amount off for a promo: p x (1 - pct) - fixed', () => {
    const result = resolve(att, standard, { rules: [rule({ kind: 'promo', percent: '10.0000', fixed: '1.0000' })] });
    // 17.28 x 0.90 - 1 = 14.552, rounded to 14.55, which is the floor of 14.31 or more
    expect(result.price.toWire()).toBe('14.5500');
    expect(result.steps[3]?.note).toBe('Carrier unlock promo -10% and -$1.00');
  });

  it('labels the step by the scope of the winning rule', () => {
    const service = rule({ scope: 'service', targetId: att.id, targetName: att.name });
    const global = rule({ scope: 'global', targetId: null, targetName: '' });
    expect(resolve(att, standard, { rules: [service] }).steps[3]?.label).toBe('Service rule');
    expect(resolve(att, standard, { rules: [global] }).steps[3]).toMatchObject({
      label: 'Global rule',
      note: 'All services discount -2%',
    });
    expect(resolve(att, standard, { rules: [promo] }).steps[3]?.label).toBe('Category rule');
  });

  it('keeps the rule step label of the demo when a fixed price skips it', () => {
    const result = resolve(att, standard, { clientPrice: '15.2', rules: [rule({ scope: 'global', targetId: null })] });
    expect(result.steps[3]).toMatchObject({ id: 'category', label: 'Global rule', state: 'skip', value: null });
  });
});

describe('orderedRules and ruleMatches', () => {
  const ids = (rules: PricingRuleInput[], service = att, groupId: number | null = 1) =>
    orderedRules(rules, service, groupId, AT).map((candidate) => candidate.id);

  it('orders by scope (service, category, global), then priority, then group-specific first, then id', () => {
    const global = rule({ id: 101, scope: 'global', targetId: null, priority: 0 });
    const category = rule({ id: 102, scope: 'category', priority: 5 });
    const serviceRule = rule({ id: 103, scope: 'service', targetId: att.id, priority: 900 });
    const lowPriority = rule({ id: 104, scope: 'category', priority: 1 });
    const forGroup = rule({ id: 105, scope: 'category', priority: 1, groupId: 1 });
    const later = rule({ id: 106, scope: 'category', priority: 1 });
    expect(ids([global, category, serviceRule, lowPriority, forGroup, later])).toEqual([103, 105, 104, 106, 102, 101]);
  });

  it('skips rules that are off, outside their window, for another group, or aimed elsewhere', () => {
    const off = rule({ id: 201, isActive: false });
    const notYet = rule({ id: 202, startsAt: new Date(AT.getTime() + 1) });
    const over = rule({ id: 203, endsAt: AT });
    const otherGroup = rule({ id: 204, groupId: 2 });
    const otherCategory = rule({ id: 205, targetId: 99 });
    const otherService = rule({ id: 206, scope: 'service', targetId: 99 });
    const open = rule({ id: 207, startsAt: AT, endsAt: new Date(AT.getTime() + 1000) });
    expect(ids([off, notYet, over, otherGroup, otherCategory, otherService, open])).toEqual([207]);
  });

  it('starts a window at its first instant and ends it just before its last (starts_at <= now < ends_at)', () => {
    const windowed = rule({ startsAt: AT, endsAt: new Date(AT.getTime() + 1) });
    expect(ruleMatches(windowed, att, 1, AT)).toBe(true);
    expect(ruleMatches(windowed, att, 1, new Date(AT.getTime() - 1))).toBe(false);
    expect(ruleMatches(windowed, att, 1, new Date(AT.getTime() + 1))).toBe(false);
  });

  it('without a merchant group only the rules for every group match', () => {
    const forEveryone = rule({ id: 301 });
    const forGroup = rule({ id: 302, groupId: 1 });
    expect(ids([forEveryone, forGroup], att, null)).toEqual([301]);
    expect(ids([forEveryone, forGroup], att, 1)).toEqual([302, 301]);
  });

  it('applies only the first rule to the price', () => {
    const first = rule({ scope: 'service', targetId: att.id, targetName: att.name, percent: '10.0000' });
    const second = rule({ percent: '50.0000' });
    expect(resolve(att, standard, { rules: [second, first] }).price.toWire()).toBe('15.5500');
  });
});

describe('the rounding step', () => {
  const at = (rounding: PricingRuleInput['rounding']) => rule({ rounding });

  it('rounds half-up to the nearest 0.05 or 0.10 and ends in .99, after the cents rounding', () => {
    // 16.93 after the 2 % promo
    const five = resolve(att, standard, { rules: [at('nearest_0.05')] });
    expect(five.price.toWire()).toBe('16.9500');
    expect(five.steps.at(-1)).toEqual({
      id: 'rounding',
      label: 'Rounding',
      state: 'apply',
      value: '16.9500',
      after: '16.9500',
      note: 'Rounded to the nearest $0.05',
    });
    expect(resolve(att, standard, { rules: [at('nearest_0.10')] }).price.toWire()).toBe('16.9000');
    const ends = resolve(att, standard, { rules: [at('ends_99')] });
    expect(ends.price.toWire()).toBe('16.9900');
    expect(ends.rawPrice.toWire()).toBe('16.9900');
    expect(ends.steps.at(-1)?.note).toBe('Prices end in .99');
  });

  it('is not a step when the rule has no rounding or a fixed price decided', () => {
    expect(resolve(att, standard, { rules: [at('none')] }).steps.map((step) => step.id)).not.toContain('rounding');
    const fixed = resolve(att, standard, { clientPrice: '15.2', rules: [at('ends_99')] });
    expect(fixed.steps.map((step) => step.id)).not.toContain('rounding');
    expect(fixed.price.toWire()).toBe('15.2000');
  });

  it('is clamped to the floor like any raw price', () => {
    const result = resolve(icloud, standard, {
      rules: [
        rule({ scope: 'global', targetId: null, kind: 'discount', percent: '50.0000', rounding: 'nearest_0.10' }),
      ],
    });
    // 0.13 x 0.5 = 0.065, rounds to 0.07 in cents, to the nearest 0.10 is 0.10, which equals the floor
    expect(result.rawPrice.toWire()).toBe('0.1000');
    expect(result.price.toWire()).toBe('0.1000');
    expect(result.clamped).toBe(false);
  });

  it('applyRounding follows the rules of the three styles', () => {
    const d = (text: string) => new Decimal(text);
    expect(applyRounding(d('1.02'), 'nearest_0.05').toFixed(2)).toBe('1.00');
    expect(applyRounding(d('1.025'), 'nearest_0.05').toFixed(2)).toBe('1.05');
    expect(applyRounding(d('1.05'), 'nearest_0.10').toFixed(2)).toBe('1.10');
    expect(applyRounding(d('1.04'), 'nearest_0.10').toFixed(2)).toBe('1.00');
    expect(applyRounding(d('17.28'), 'ends_99').toFixed(2)).toBe('17.99');
    expect(applyRounding(d('17.99'), 'ends_99').toFixed(2)).toBe('17.99');
    expect(applyRounding(d('0.40'), 'ends_99').toFixed(2)).toBe('0.99');
    expect(applyRounding(d('5.13'), 'none').toFixed(2)).toBe('5.13');
  });
});

describe('the minimum profit and the floor', () => {
  it("uses the service's own minimum profit first", () => {
    const hungry = rule({ minProfit: '5.0000' });
    const quote = floorFor(att, 1, [hungry], AT);
    expect(quote.minProfit.toWire()).toBe('0.8100');
    expect(quote.floor.toWire()).toBe('14.3100');
  });

  it('then the first matching rule in resolver order that sets one, skipping rules without', () => {
    const noProfit = rule({ id: 401, scope: 'service', targetId: icloud.id, minProfit: '0.0000' });
    const category = rule({ id: 402, scope: 'category', targetId: icloud.categoryId, minProfit: '0.0500' });
    const global = rule({ id: 403, scope: 'global', targetId: null, minProfit: '0.2000' });
    expect(floorFor(icloud, 1, [global, category, noProfit], AT).minProfit.toWire()).toBe('0.0500');
    expect(floorFor(icloud, 1, [global], AT).minProfit.toWire()).toBe('0.2000');
    expect(ruleMinProfit(orderedRules([global, category], icloud, 1, AT))?.toWire()).toBe('0.0500');
  });

  it('then the default policy: max(round(6 % of the cost, 2), 0.02)', () => {
    expect(floorFor(icloud, 1, [], AT).minProfit.toWire()).toBe('0.0200');
    expect(floorFor({ ...icloud, effectiveCost: m('9.8') }, 1, [], AT).minProfit.toWire()).toBe('0.5900');
  });

  it('counts the rules of the merchant group only when there is a merchant group', () => {
    const forGroup = rule({ scope: 'category', targetId: icloud.categoryId, groupId: 2, minProfit: '0.3000' });
    expect(floorFor(icloud, null, [forGroup], AT).minProfit.toWire()).toBe('0.0200');
    expect(floorFor(icloud, 1, [forGroup], AT).minProfit.toWire()).toBe('0.0200');
    expect(floorFor(icloud, 2, [forGroup], AT).minProfit.toWire()).toBe('0.3000');
  });

  it('clamps the resolved price to the floor the rules set', () => {
    const rich = rule({ scope: 'category', targetId: icloud.categoryId, minProfit: '0.1000' });
    const result = resolve(icloud, standard, { rules: [rich] });
    expect(result.floor.toWire()).toBe('0.1800');
    expect(result.price.toWire()).toBe('0.1800');
    expect(result.clamped).toBe(true);
  });
});

describe('floor messages and the storefront floor', () => {
  it('words the refusal as the console shows it', () => {
    expect(belowFloorMessage(m('13.5'), m('0.81'))).toBe(
      'Below the floor of $14.31 (cost $13.50 plus $0.81 minimum profit).',
    );
    expect(belowFloorMessage(m('0.0825'), m('0.02'))).toBe(
      'Below the floor of $0.1025 (cost $0.0825 plus $0.02 minimum profit).',
    );
  });

  it('is max(round(base x 1.10, 2), floor)', () => {
    expect(storefrontFloor(m('17.28'), m('14.31')).toWire()).toBe('19.0100');
    expect(storefrontFloor(m('1.00'), m('2.50')).toWire()).toBe('2.5000');
    expect(storefrontFloor(m('0.13'), m('0.10')).toWire()).toBe('0.1400');
  });
});

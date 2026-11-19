// Unit tests of the retail price rules (decision 040, plan 31 sections 3.3, 3.4 and 8.1): every worked number of 3.3, each
// rounding style around its steps, roundFrom, the limits, the properties over the 1157 real supplier costs, the precedence of
// pickRetailRule, the label and the cost limit costMoved.
import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Money } from '../../../common/money';
import { RETAIL_ROUNDINGS, type RetailRounding } from '../db/schema';
import { storefrontFloor } from './price-resolution';
import {
  type PickableRetailRule,
  type RetailRuleFigures,
  costMoved,
  evaluateRetailRule,
  pickRetailRule,
  retailRuleTargetProblems,
  ruleLabel,
} from './retail-rule';
import { defaultMinProfit } from './service-figures';

const m = (value: string) => Money.of(value);

/** The storefront floor of a Quick add service under the default policy: base = cost + 6 % (at least 0.02), floor of both. */
function defaultFloor(cost: Money): Money {
  const minProfit = defaultMinProfit(cost);
  return storefrontFloor(cost.add(minProfit), cost.add(minProfit));
}

const rule = (
  percent: string,
  rounding: RetailRounding,
  extra: Partial<RetailRuleFigures> = {},
): RetailRuleFigures => ({
  percent,
  fixed: m('0'),
  rounding,
  roundFrom: m('5'),
  ...extra,
});

/** The price a rule gives a cost under the default floor, as wire text (or `no_cost`). */
function priceOf(cost: string, figures: RetailRuleFigures, floor?: string): string {
  const quote = { cost: m(cost), floor: floor === undefined ? defaultFloor(m(cost)) : m(floor) };
  const result = evaluateRetailRule(figures, quote);
  return result.kind === 'price' ? result.price.toWire() : result.kind;
}

describe('evaluateRetailRule: the worked numbers of plan 31 section 3.3', () => {
  it('reads the default floors the plan names', () => {
    expect(defaultFloor(m('10')).toWire()).toBe('11.6600');
    expect(defaultFloor(m('0.50')).toWire()).toBe('0.5800');
    expect(defaultFloor(m('0.0030')).toWire()).toBe('0.0300');
  });

  it('cost 10.0000, +30 %, ends_99: 13.00, then 13.99', () => {
    const result = evaluateRetailRule(rule('30', 'ends_99'), { cost: m('10'), floor: m('11.66') });
    expect(result).toEqual({ kind: 'price', price: m('13.99'), raw: m('13'), atFloor: false });
  });

  it('cost 10.0000, +10 %: 11.00 is lifted to the floor 11.66, then 11.99 (atFloor)', () => {
    const result = evaluateRetailRule(rule('10', 'ends_99'), { cost: m('10'), floor: m('11.66') });
    expect(result).toEqual({ kind: 'price', price: m('11.99'), raw: m('11'), atFloor: true });
  });

  it('cost 26.50, +30 %: 34.45, then 34.99', () => {
    expect(priceOf('26.50', rule('30', 'ends_99'))).toBe('34.9900');
  });

  it('cost 100, +30 %: 130.00, then 130.99', () => {
    expect(priceOf('100', rule('30', 'ends_99'))).toBe('130.9900');
  });

  it('a raw of 17.995 gives 18.00, then 18.99: never down (the trap of applyRounding)', () => {
    // 17.995 = cost 13.8423... is awkward, so the fixed amount makes the raw: 10 x 1.00 + 7.995.
    expect(priceOf('10', rule('0', 'ends_99', { fixed: m('7.995') }), '1')).toBe('18.9900');
  });

  it('cost 0.50 (floor 0.58), +30 %: 0.65, under roundFrom so no .99', () => {
    expect(priceOf('0.50', rule('30', 'ends_99'))).toBe('0.6500');
  });

  it('cost 0.0030 (floor 0.03), +30 %: 0.0039 is lifted to 0.03', () => {
    const result = evaluateRetailRule(rule('30', 'ends_99'), { cost: m('0.003'), floor: m('0.03') });
    expect(result).toEqual({ kind: 'price', price: m('0.03'), raw: m('0.0039'), atFloor: true });
  });

  it('cost 0.011, +30 % and fixed 0.50: 0.5143, then 0.52 (rounded up to the cent)', () => {
    const result = evaluateRetailRule(rule('30', 'ends_99', { fixed: m('0.5') }), {
      cost: m('0.011'),
      floor: defaultFloor(m('0.011')),
    });
    expect(result).toEqual({ kind: 'price', price: m('0.52'), raw: m('0.5143'), atFloor: false });
  });

  it('cost 0 gives no price', () => {
    expect(evaluateRetailRule(rule('30', 'ends_99'), { cost: m('0'), floor: m('0.02') })).toEqual({ kind: 'no_cost' });
  });

  it('refuses a negative cost', () => {
    expect(() => evaluateRetailRule(rule('30', 'cent'), { cost: m('-1'), floor: m('0') })).toThrow(RangeError);
  });
});

describe('evaluateRetailRule: each rounding style at, just under and just over a step', () => {
  // The floor is set low so the raw price decides; the fixed amount sets the raw exactly (cost 1, +0 %).
  const at = (raw: string, rounding: RetailRounding) =>
    priceOf('1', rule('0', rounding, { fixed: m(raw).sub(m('1')) }), '0.01');

  it('cent: rounds up to the cent only', () => {
    expect(at('12.3400', 'cent')).toBe('12.3400');
    expect(at('12.3401', 'cent')).toBe('12.3500');
    expect(at('12.3399', 'cent')).toBe('12.3400');
  });

  it('step_0.05: the next multiple of 0.05', () => {
    expect(at('12.3500', 'step_0.05')).toBe('12.3500');
    expect(at('12.3499', 'step_0.05')).toBe('12.3500');
    expect(at('12.3501', 'step_0.05')).toBe('12.4000');
    expect(at('12.3100', 'step_0.05')).toBe('12.3500');
  });

  it('step_0.10: the next multiple of 0.10', () => {
    expect(at('12.4000', 'step_0.10')).toBe('12.4000');
    expect(at('12.3999', 'step_0.10')).toBe('12.4000');
    expect(at('12.4001', 'step_0.10')).toBe('12.5000');
  });

  it('ends_99: the smallest n.99 that is not below', () => {
    expect(at('12.9900', 'ends_99')).toBe('12.9900');
    expect(at('12.9899', 'ends_99')).toBe('12.9900');
    expect(at('12.9901', 'ends_99')).toBe('13.9900');
    expect(at('13.0000', 'ends_99')).toBe('13.9900');
    expect(at('12.0000', 'ends_99')).toBe('12.9900');
  });
});

describe('evaluateRetailRule: roundFrom, fixed alone and the limits', () => {
  const withFrom = (raw: string, roundFrom: string) =>
    priceOf('1', rule('0', 'ends_99', { fixed: m(raw).sub(m('1')), roundFrom: m(roundFrom) }), '0.01');

  it('applies the style from roundFrom on, and keeps the cent under it', () => {
    expect(withFrom('5.0000', '5')).toBe('5.9900');
    // 4.9999 is 5.00 in cents, which is at roundFrom: the style applies.
    expect(withFrom('4.9999', '5')).toBe('5.9900');
    expect(withFrom('4.9800', '4.99')).toBe('4.9800');
    expect(withFrom('4.9900', '5')).toBe('4.9900');
    expect(withFrom('4.2000', '0')).toBe('4.9900');
  });

  it('a fixed amount alone (0 %) is added to the cost', () => {
    expect(priceOf('20', rule('0', 'cent', { fixed: m('2.5') }), '1')).toBe('22.5000');
    // Under the default policy the floor (23.32) wins over cost 20 + 2.50.
    expect(priceOf('20', rule('0', 'cent', { fixed: m('2.5') }))).toBe('23.3200');
  });

  it('works at the limits: +1000 % and the largest fixed amount, exactly', () => {
    const result = evaluateRetailRule(rule('1000.0000', 'cent', { fixed: m('100000') }), {
      cost: m('99999.9999'),
      floor: m('1'),
    });
    // 99999.9999 x 11 + 100000 = 1199999.9989, rounded up to the cent.
    expect(result).toEqual({ kind: 'price', price: m('1200000'), raw: m('1199999.9989'), atFloor: false });
  });

  it('a percent with four decimals stays exact', () => {
    // 10 x 1.123456... is cut to four decimals by the contract; 12.3456 % of 10 is 1.23456.
    expect(priceOf('10', rule('12.3456', 'cent'), '1')).toBe('11.2400');
  });
});

describe('evaluateRetailRule: properties over the 1157 costs of the fixture (made-up figures of every size)', () => {
  const fixture = JSON.parse(
    readFileSync(join(import.meta.dir, '../../../../test/fixtures/publish/supplier-names.json'), 'utf8'),
  ) as { cost: string }[];
  const costs = [...new Set(fixture.map((row) => row.cost))]
    .map((cost) => m(cost))
    .filter((cost) => cost.isPositive())
    .sort((a, b) => a.cmp(b));

  it('reads the fixture', () => {
    expect(fixture).toHaveLength(1157);
    expect(costs.length).toBeGreaterThan(100);
  });

  for (const rounding of RETAIL_ROUNDINGS) {
    for (const percent of ['0', '10', '30', '100']) {
      it(`${rounding}, +${percent} %: at or above the floor and raw, whole cents, never lower for a higher cost`, () => {
        let previous: Money | undefined;
        for (const cost of costs) {
          const floor = defaultFloor(cost);
          const result = evaluateRetailRule(rule(percent, rounding), { cost, floor });
          if (result.kind !== 'price') throw new Error(`no price for ${cost.toWire()}`);
          expect(result.price.cmp(floor)).toBeGreaterThanOrEqual(0);
          expect(result.price.cmp(result.raw)).toBeGreaterThanOrEqual(0);
          expect(result.price.toWire().endsWith('00')).toBe(true);
          if (previous !== undefined) expect(result.price.cmp(previous)).toBeGreaterThanOrEqual(0);
          previous = result.price;
        }
      });
    }
  }
});

describe('pickRetailRule', () => {
  const base = { isActive: true, deletedAt: null, serviceType: null, categoryId: null } as const;
  const global: PickableRetailRule & { id: number } = { ...base, id: 1, scope: 'global' };
  const imei: PickableRetailRule & { id: number } = { ...base, id: 2, scope: 'type', serviceType: 'imei' };
  const category: PickableRetailRule & { id: number } = { ...base, id: 3, scope: 'category', categoryId: 7 };
  const service = { type: 'imei', categoryId: 7 } as const;

  it('takes the category over the type over the global rule', () => {
    expect(pickRetailRule([global, imei, category], service)?.id).toBe(3);
    expect(pickRetailRule([global, imei], service)?.id).toBe(2);
    expect(pickRetailRule([global], service)?.id).toBe(1);
    expect(pickRetailRule([global, imei, category], { type: 'server', categoryId: 8 })?.id).toBe(1);
  });

  it('skips an inactive rule and a deleted rule', () => {
    expect(pickRetailRule([global, imei, { ...category, isActive: false }], service)?.id).toBe(2);
    expect(
      pickRetailRule([global, { ...imei, isActive: false, deletedAt: new Date('2026-11-17T00:00:00Z') }], service)?.id,
    ).toBe(1);
    // A deleted rule is never active (the CHECK), but the pick does not trust that alone.
    expect(pickRetailRule([{ ...global, deletedAt: new Date('2026-11-17T00:00:00Z') }], service)).toBeUndefined();
  });

  it('answers undefined with no rule', () => {
    expect(pickRetailRule([], service)).toBeUndefined();
    expect(pickRetailRule([{ ...category, categoryId: 9 }], { type: 'file', categoryId: 7 })).toBeUndefined();
  });
});

describe('ruleLabel', () => {
  it('writes the target, the percent, the fixed amount and the rounding', () => {
    const figures = { fixed: m('0'), rounding: 'cent', serviceType: null, categoryName: null } as const;
    expect(ruleLabel({ ...figures, scope: 'global', percent: '25.0000', rounding: 'ends_99' })).toBe(
      'Every service +25%, ends in .99',
    );
    expect(ruleLabel({ ...figures, scope: 'type', serviceType: 'imei', percent: '30.0000' })).toBe('IMEI +30%');
    expect(
      ruleLabel({ ...figures, scope: 'category', categoryName: 'AT&T USA', percent: '20.0000', fixed: m('0.5') }),
    ).toBe('AT&T USA +20% +$0.50');
    expect(
      ruleLabel({ ...figures, scope: 'type', serviceType: 'server', percent: '2.5000', rounding: 'step_0.10' }),
    ).toBe('Server +2.5%, rounded up to $0.10');
  });
});

describe('retailRuleTargetProblems', () => {
  it('accepts the target of each scope and refuses the fields that do not fit', () => {
    expect(retailRuleTargetProblems('global', null, null)).toEqual([]);
    expect(retailRuleTargetProblems('type', 'imei', null)).toEqual([]);
    expect(retailRuleTargetProblems('category', null, 4)).toEqual([]);
    expect(retailRuleTargetProblems('global', 'imei', 4).map((p) => p.field)).toEqual(['serviceType', 'categoryId']);
    expect(retailRuleTargetProblems('type', null, 4).map((p) => p.field)).toEqual(['serviceType', 'categoryId']);
    expect(retailRuleTargetProblems('category', 'server', null).map((p) => p.field)).toEqual([
      'serviceType',
      'categoryId',
    ]);
  });
});

describe('costMoved', () => {
  it('a move of exactly the limit is not a move, one unit more is', () => {
    expect(costMoved(m('10'), m('12.5'), 25)).toBe(false);
    expect(costMoved(m('10'), m('12.5001'), 25)).toBe(true);
    expect(costMoved(m('10'), m('10'), 25)).toBe(false);
  });

  it('a fall counts as a rise', () => {
    expect(costMoved(m('10'), m('7.5'), 25)).toBe(false);
    expect(costMoved(m('10'), m('7.4999'), 25)).toBe(true);
    expect(costMoved(m('100'), m('10'), 25)).toBe(true);
    expect(costMoved(m('10'), m('100'), 25)).toBe(true);
  });

  it('from 0: any other cost is a jump', () => {
    expect(costMoved(m('0'), m('0.0001'), 1000)).toBe(true);
    expect(costMoved(m('0'), m('0'), 25)).toBe(false);
  });

  it('a limit of 0: any move is a jump', () => {
    expect(costMoved(m('10'), m('10.0001'), 0)).toBe(true);
    expect(costMoved(m('10'), m('10'), 0)).toBe(false);
  });

  it('refuses a limit that is not a whole percent from 0 to 1000', () => {
    expect(() => costMoved(m('1'), m('2'), 1.5)).toThrow(RangeError);
    expect(() => costMoved(m('1'), m('2'), -1)).toThrow(RangeError);
    expect(() => costMoved(m('1'), m('2'), 1001)).toThrow(RangeError);
  });
});

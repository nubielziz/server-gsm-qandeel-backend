// Unit tests of the price grid row (decision 063): the figures come from fixed inputs, the group prices from the price resolver's own
// result: a fixed price, no fixed price (the discount applies), a cost that is not on record, a shop price from a rule and a typed one.
import { describe, expect, it } from 'bun:test';
import { Money } from '@src/common/money';
import {
  type GridGroupInput,
  type GridService,
  costIsKnown,
  gridRow,
  marginOver,
} from '@src/modules/catalog/domain/price-grid';
import {
  type PricedGroup,
  type PricedService,
  type PricingRuleInput,
  resolveServicePrice,
} from '@src/modules/catalog/domain/price-resolution';

const AT = new Date('2026-11-23T12:00:00.000Z');
const m = (text: string) => Money.of(text);

const standard: PricedGroup = { id: 1, name: 'Standard', discountPercent: '0.0000' };
const wholesale: PricedGroup = { id: 2, name: 'Wholesale', discountPercent: '4.0000' };
const vip: PricedGroup = { id: 3, name: 'VIP', discountPercent: '8.0000' };

/** The demo's AT&T unlock: cost 13.50, base price 17.28, own minimum profit 0.81 (floor 14.31). */
const att: PricedService = {
  id: 5,
  name: 'AT&T USA Premier Unlock',
  categoryId: 4,
  categoryName: 'Carrier unlock',
  basePrice: m('17.28'),
  effectiveCost: m('13.5'),
  minProfit: m('0.81'),
};

/** The grid's view of a service, as the use case builds it from the list row. */
const gridService = (priced: PricedService, values: Partial<GridService> = {}): GridService => ({
  id: priced.id,
  name: priced.name,
  code: 'IMEI-ATT-USA',
  status: 'active',
  sort: 0,
  categoryId: priced.categoryId,
  supplier: { id: 3, name: 'DHRU Pro' },
  effectiveCost: priced.effectiveCost,
  costChangedFrom: null,
  basePrice: priced.basePrice,
  floorPrice: m('14.31'),
  belowFloor: false,
  ...values,
});

/** What the use case hands the row: the resolver's answer for each group, with the group's stored fixed price. */
function cells(
  service: PricedService,
  groups: ReadonlyArray<{ group: PricedGroup; fixed?: string }>,
  rules: readonly PricingRuleInput[] = [],
): GridGroupInput[] {
  return groups.map(({ group, fixed }) => ({
    groupId: group.id,
    fixedPrice: fixed === undefined ? null : m(fixed),
    resolution: resolveServicePrice({
      service,
      group,
      clientPrice: null,
      groupPrice: fixed === undefined ? null : m(fixed),
      rules,
      at: AT,
    }),
  }));
}

describe('gridRow', () => {
  it('gives a group with a fixed price that price and its margin, and a group without one the discounted base price', () => {
    const row = gridRow({
      service: gridService(att),
      retail: { price: null, source: null },
      groups: cells(att, [{ group: standard }, { group: wholesale }, { group: vip, fixed: '15.2000' }]),
    });
    expect(row.basePrice).toBe('17.2800');
    expect(row.baseMargin).toBe('3.7800');
    expect(row.groupPrices).toEqual([
      // No fixed price, no discount: the base price.
      { groupId: 1, fixedPrice: null, price: '17.2800', margin: '3.7800' },
      // No fixed price, 4 % off: 17.28 x 0.96 = 16.5888, half-up to cents.
      { groupId: 2, fixedPrice: null, price: '16.5900', margin: '3.0900' },
      // A fixed price is exactly what staff typed (it skips the discount).
      { groupId: 3, fixedPrice: '15.2000', price: '15.2000', margin: '1.7000' },
    ]);
  });

  it('keeps the order of the groups it is given', () => {
    const row = gridRow({
      service: gridService(att),
      retail: { price: null, source: null },
      groups: cells(att, [{ group: vip }, { group: standard }]),
    });
    expect(row.groupPrices.map((cell) => cell.groupId)).toEqual([3, 1]);
  });

  it('shows the price the resolver charges, not the fixed price, when the floor clamps it', () => {
    // A fixed price under the floor (the cost moved after it was saved): the merchant pays the floor, the grid shows both.
    const row = gridRow({
      service: gridService(att),
      retail: { price: null, source: null },
      groups: cells(att, [{ group: standard, fixed: '14.0000' }]),
    });
    expect(row.groupPrices).toEqual([{ groupId: 1, fixedPrice: '14.0000', price: '14.3100', margin: '0.8100' }]);
  });

  it('takes the margin of a price from the same figures as the resolver: a rule that lowers the price lowers the margin', () => {
    const promo: PricingRuleInput = {
      id: 1,
      scope: 'category',
      targetId: 4,
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
    };
    const groups = cells(att, [{ group: standard }], [promo]);
    expect(groups[0]!.resolution.price.toWire()).toBe('16.9300');
    const row = gridRow({ service: gridService(att), retail: { price: null, source: null }, groups });
    expect(row.groupPrices[0]).toEqual({ groupId: 1, fixedPrice: null, price: '16.9300', margin: '3.4300' });
    // The base price column is the stored base price: the rule is a group's business.
    expect(row.baseMargin).toBe('3.7800');
  });

  it('says null for the cost and every margin while no cost is on record, and still gives every price', () => {
    const fresh: PricedService = { ...att, effectiveCost: m('0'), minProfit: null };
    const row = gridRow({
      service: gridService(fresh, { floorPrice: m('0.02') }),
      retail: { price: m('25.9900'), source: 'manual' },
      groups: cells(fresh, [{ group: standard }, { group: vip, fixed: '15.2000' }]),
    });
    expect(row.cost).toBeNull();
    expect(row.baseMargin).toBeNull();
    expect(row.retailMargin).toBeNull();
    expect(row.basePrice).toBe('17.2800');
    expect(row.retailPrice).toBe('25.9900');
    expect(row.groupPrices).toEqual([
      { groupId: 1, fixedPrice: null, price: '17.2800', margin: null },
      { groupId: 3, fixedPrice: '15.2000', price: '15.2000', margin: null },
    ]);
  });

  it('gives a negative margin to a price under the cost', () => {
    const dear: PricedService = { ...att, effectiveCost: m('20'), minProfit: m('0') };
    const row = gridRow({
      service: gridService(dear, { floorPrice: m('20'), belowFloor: true }),
      retail: { price: m('18.0000'), source: 'rule' },
      groups: [],
    });
    expect(row.cost).toBe('20.0000');
    expect(row.baseMargin).toBe('-2.7200');
    expect(row.retailMargin).toBe('-2.0000');
    expect(row.belowFloor).toBe(true);
    expect(row.floorPrice).toBe('20.0000');
  });

  it('names a shop price that follows a rule "rule" and one a person typed "manual" (the service rows\' words), with its margin', () => {
    const base = { service: gridService(att), groups: [] };
    const rule = gridRow({ ...base, retail: { price: m('22.0000'), source: 'rule' } });
    expect([rule.retailPrice, rule.retailPriceSource, rule.retailMargin]).toEqual(['22.0000', 'rule', '8.5000']);
    const typed = gridRow({ ...base, retail: { price: m('25.9900'), source: 'manual' } });
    expect([typed.retailPrice, typed.retailPriceSource, typed.retailMargin]).toEqual(['25.9900', 'manual', '12.4900']);
  });

  it('leaves the shop columns null for a service with no shop price', () => {
    const row = gridRow({ service: gridService(att), retail: { price: null, source: null }, groups: [] });
    expect([row.retailPrice, row.retailPriceSource, row.retailMargin]).toEqual([null, null, null]);
    expect(row.groupPrices).toEqual([]);
  });

  it('carries the facts of the service row: status, position, supplier, the older cost and the floor', () => {
    const row = gridRow({
      service: gridService(att, { status: 'disabled', sort: 7, costChangedFrom: m('12.0000'), supplier: null }),
      retail: { price: null, source: null },
      groups: [],
    });
    expect(row).toMatchObject({
      id: 5,
      code: 'IMEI-ATT-USA',
      status: 'disabled',
      sort: 7,
      categoryId: 4,
      supplier: null,
      cost: '13.5000',
      costChangedFrom: '12.0000',
      floorPrice: '14.3100',
      belowFloor: false,
    });
  });
});

describe('costIsKnown and marginOver', () => {
  it('treats a zero cost as not on record', () => {
    expect(costIsKnown(m('0'))).toBe(false);
    expect(costIsKnown(m('0.0001'))).toBe(true);
    expect(marginOver(m('5'), m('0'))).toBeNull();
    expect(marginOver(m('5'), m('3.25'))?.toWire()).toBe('1.7500');
    expect(marginOver(m('2'), m('3.25'))?.toWire()).toBe('-1.2500');
  });
});

// Unit tests of what the price grid reads from a loaded pricing context (decision 063): the merchant groups in the order of the groups
// page, and the stored fixed price of a service and a group next to the price the resolver gives.
import { describe, expect, it } from 'bun:test';
import { Money } from '@src/common/money';
import { PricingContext } from '@src/modules/catalog/application/price-resolver';
import type { PricedService } from '@src/modules/catalog/domain/price-resolution';
import type { LoadedPricing, PricedGroupRow } from '@src/modules/catalog/infra/pricing-data.repository';

const AT = new Date('2026-11-23T12:00:00.000Z');
const m = (text: string) => Money.of(text);

const service: PricedService = {
  id: 5,
  name: 'AT&T USA Premier Unlock',
  categoryId: 4,
  categoryName: 'Carrier unlock',
  basePrice: m('17.28'),
  effectiveCost: m('13.5'),
  minProfit: m('0.81'),
};

const group = (id: number, name: string, sort: number, kind = 'b2b', discountPercent = '0.0000'): PricedGroupRow => ({
  id,
  name,
  kind,
  sort,
  discountPercent,
});

/** Groups whose ids are not in the order of their `sort`, and the shop's retail group. */
const groups = [
  group(1, 'Standard', 3),
  group(2, 'Wholesale', 1, 'b2b', '4.0000'),
  group(3, 'VIP', 2, 'b2b', '8.0000'),
  group(4, 'Storefront retail', 0, 'b2c_retail'),
];

function context(groupPrices: Array<[number, number, string]> = []): PricingContext {
  const data: LoadedPricing = {
    services: new Map([[service.id, service]]),
    groups: new Map(groups.map((row) => [row.id, row])),
    groupPrices: new Map(groupPrices.map(([serviceId, groupId, price]) => [`${serviceId}|${groupId}`, m(price)])),
    clientPrices: new Map(),
    rules: [],
  };
  return new PricingContext(data, AT);
}

describe('PricingContext.merchantGroupsBySort', () => {
  it('lists the merchant groups by sort, then id, and leaves the shop group out', () => {
    expect(
      context()
        .merchantGroupsBySort()
        .map((row) => row.name),
    ).toEqual(['Wholesale', 'VIP', 'Standard']);
  });

  it('breaks a tie of sort by id', () => {
    const tied: LoadedPricing = {
      services: new Map(),
      groups: new Map([group(9, 'Nine', 1), group(7, 'Seven', 1), group(8, 'Eight', 0)].map((row) => [row.id, row])),
      groupPrices: new Map(),
      clientPrices: new Map(),
      rules: [],
    };
    expect(new PricingContext(tied, AT).merchantGroupsBySort().map((row) => row.id)).toEqual([8, 7, 9]);
  });

  it('keeps merchantGroups in id order, as the resolve page reads it', () => {
    expect(
      context()
        .merchantGroups()
        .map((row) => row.id),
    ).toEqual([1, 2, 3]);
  });
});

describe('PricingContext.groupFixedPrice', () => {
  it('gives the stored price of a group, as stored, or null', () => {
    const loaded = context([[5, 3, '15.2000']]);
    expect(loaded.groupFixedPrice(5, 3)?.toWire()).toBe('15.2000');
    expect(loaded.groupFixedPrice(5, 2)).toBeNull();
    expect(loaded.groupFixedPrice(6, 3)).toBeNull();
  });

  it('is the price the resolver starts from, which the floor may still raise', () => {
    // A fixed price under the floor (14.31): stored as typed, charged at the floor.
    const loaded = context([[5, 1, '14.0000']]);
    expect(loaded.groupFixedPrice(5, 1)?.toWire()).toBe('14.0000');
    expect(loaded.resolve({ serviceId: 5, groupId: 1 })?.price.toWire()).toBe('14.3100');
  });
});

// Unit tests of the wire view of a publish row (feature 31, plan 31 section 5.2): the price apply would store for each mode, the margin
// of it, the name of the rule and the join facts.
import { describe, expect, it } from 'bun:test';
import type { ListingPublishItem } from '@src/modules/storefront/db/schema';
import { itemView, retailPriceOf } from '@src/modules/storefront/publish/domain/publish-view';

function stored(overrides: Partial<ListingPublishItem> = {}): ListingPublishItem {
  return {
    id: 301,
    runId: 12,
    serviceId: 88,
    detected: { title: 'T', slug: 't', brand: 'Apple', brandKind: 'device', carrier: '', country: '' },
    title: 'T',
    slug: 't',
    brand: 'Apple',
    carrier: '',
    country: '',
    slugSource: 'auto',
    priceMode: 'rule',
    priceOverride: null,
    replacesPrice: null,
    existingPrice: null,
    cost: '10.0000',
    floorPrice: '11.6600',
    ruleId: 2,
    rulePrice: '13.9900',
    state: 'ready',
    blockedReason: null,
    flags: ['price_at_floor'],
    included: true,
    edited: false,
    evaluatedAt: new Date('2026-11-18T09:00:04.000Z'),
    result: null,
    resultReason: null,
    resultDetail: null,
    listingId: null,
    publishedPrice: null,
    finishedAt: null,
    createdAt: new Date('2026-11-18T09:00:00.000Z'),
    updatedAt: new Date('2026-11-18T09:00:00.000Z'),
    ...overrides,
  };
}

const SERVICE = { name: 'AT&T Unlock', code: 'ATT', type: 'imei', categoryName: 'Carrier unlock' } as const;

describe('retailPriceOf: the price apply would store', () => {
  it('is the typed price for manual, the price the service has for keep and the rule price for rule', () => {
    expect(retailPriceOf(stored({ priceMode: 'manual', priceOverride: '25.0000' }))).toBe('25.0000');
    expect(retailPriceOf(stored({ priceMode: 'keep', existingPrice: '20.0000' }))).toBe('20.0000');
    expect(retailPriceOf(stored({ priceMode: 'rule' }))).toBe('13.9900');
  });

  it('is null when the mode has no price (no rule, or a cost of 0)', () => {
    expect(retailPriceOf(stored({ priceMode: 'rule', rulePrice: null }))).toBeNull();
  });
});

describe('itemView', () => {
  it('shows an empty detection for a row the naming has not reached: a preview being prepared, or one that failed', () => {
    const view = itemView({
      item: stored({
        detected: {},
        evaluatedAt: null,
        state: 'blocked',
        included: false,
        ruleId: null,
        rulePrice: null,
      }),
      service: SERVICE,
      listingListed: null,
      ruleLabel: null,
    });
    expect(view.detected).toEqual({ title: '', slug: '', brand: '', brandKind: null, carrier: '', country: '' });
    expect(view.evaluatedAt).toBeNull();
    expect(view.retailPrice).toBeNull();
  });

  it('shows the row with its service, its rule label, the price and the margin of that price', () => {
    const view = itemView({ item: stored(), service: SERVICE, listingListed: null, ruleLabel: 'IMEI +30%' });
    expect(view).toMatchObject({
      id: 301,
      serviceId: 88,
      service: { id: 88, name: 'AT&T Unlock', code: 'ATT', type: 'imei', categoryName: 'Carrier unlock' },
      rule: { id: 2, label: 'IMEI +30%' },
      retailPrice: '13.9900',
      marginPct: '28.5204',
      flags: ['price_at_floor'],
      evaluatedAt: '2026-11-18T09:00:04.000Z',
      listingListed: null,
    });
  });

  it('has no margin without a price, no rule without a label, and carries the result and the listing', () => {
    const view = itemView({
      item: stored({
        rulePrice: null,
        ruleId: 2,
        result: 'published',
        listingId: 9,
        publishedPrice: '13.9900',
        evaluatedAt: null,
      }),
      service: SERVICE,
      listingListed: true,
      ruleLabel: null,
    });
    expect(view).toMatchObject({
      retailPrice: null,
      marginPct: null,
      rule: null,
      result: 'published',
      listingId: 9,
      listingListed: true,
      publishedPrice: '13.9900',
      evaluatedAt: null,
    });
  });

  it('shows a margin below zero for a price under the cost', () => {
    const view = itemView({
      item: stored({ priceMode: 'manual', priceOverride: '8.0000' }),
      service: SERVICE,
      listingListed: null,
      ruleLabel: null,
    });
    expect(view.marginPct).toBe('-25.0000');
  });
});

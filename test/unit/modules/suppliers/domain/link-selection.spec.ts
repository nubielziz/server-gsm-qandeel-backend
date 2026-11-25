// Unit tests of the choice of a supplier link: the cost of a link, the automatic pick that never fails over to a costlier one, and the
// reason a waiting order stops for when none fits (decision 069 for a service delivered from code stock).
import { describe, expect, it } from 'bun:test';
import { Money } from '@src/common/money';
import {
  NO_STOCK_NO_SUPPLIER_MESSAGE,
  type RoutingLink,
  linkUnitCost,
  noLinkReason,
  pickLink,
} from '@src/modules/suppliers/domain/link-selection';

const link = (overrides: Partial<RoutingLink> = {}): RoutingLink => ({
  linkId: 1,
  priority: 1,
  supplierId: 1,
  supplierName: 'Nordic GSM',
  supplierStatus: 'active',
  supplierServiceId: 10,
  available: true,
  credit: '10.0000',
  creditRate: '1.00000000',
  ...overrides,
});

describe('linkUnitCost', () => {
  it('is credit x credit rate rounded half up to 4 decimals', () => {
    expect(linkUnitCost({ credit: '19.8000', creditRate: '1.00000000' }).toWire()).toBe('19.8000');
    expect(linkUnitCost({ credit: '3.3333', creditRate: '1.12345678' }).toWire()).toBe('3.7448');
  });
});

describe('pickLink', () => {
  const price = Money.of('12.0000');

  it('takes the first link by priority whose supplier is active and whose cost is not above the price', () => {
    const choice = pickLink([link(), link({ linkId: 2, priority: 2, supplierId: 2, supplierServiceId: 20 })], price);
    expect(choice).toMatchObject({ ok: true, link: { supplierServiceId: 10 } });
  });

  it('skips a paused or disabled supplier and a service the supplier no longer lists (system-alert step 8)', () => {
    const choice = pickLink(
      [
        link({ supplierStatus: 'paused' }),
        link({ linkId: 2, priority: 2, supplierServiceId: 20, available: false }),
        link({ linkId: 3, priority: 3, supplierServiceId: 30, credit: '8.0000' }),
      ],
      price,
    );
    expect(choice).toMatchObject({ ok: true, link: { supplierServiceId: 30 } });
  });

  it('accepts a cost equal to the price and never fails over to a costlier link (B117 (6))', () => {
    expect(pickLink([link({ credit: '12.0000' })], price).ok).toBe(true);
    const refused = pickLink([link({ credit: '12.0001' }), link({ linkId: 2, priority: 2, credit: '15.0000' })], price);
    expect(refused).toMatchObject({ ok: false, reason: 'costs_more' });
    expect(refused.ok ? '' : refused.message).toContain('12.0001');
  });

  it('says why nothing fits: no link, or every supplier unavailable', () => {
    expect(pickLink([], price)).toMatchObject({ ok: false, reason: 'no_link' });
    expect(pickLink([link({ supplierStatus: 'disabled' })], price)).toMatchObject({
      ok: false,
      reason: 'supplier_unavailable',
    });
  });
});

describe('noLinkReason', () => {
  const price = Money.of('12.0000');

  it('tells staff to deliver an order of a stock service by hand when no supplier can take it', () => {
    for (const links of [[], [link({ supplierStatus: 'paused' })], [link({ available: false })]]) {
      const choice = pickLink(links, price);
      if (choice.ok) throw new Error('expected no link');
      expect(noLinkReason(choice, true)).toBe(NO_STOCK_NO_SUPPLIER_MESSAGE);
    }
    expect(NO_STOCK_NO_SUPPLIER_MESSAGE).toBe('No codes in stock and no supplier: deliver it by hand.');
  });

  it('keeps the reason of a costlier supplier, and every reason of any other service', () => {
    const costly = pickLink([link({ credit: '15.0000' })], price);
    const none = pickLink([], price);
    if (costly.ok || none.ok) throw new Error('expected no link');
    expect(noLinkReason(costly, true)).toBe(costly.message);
    expect(noLinkReason(none, false)).toBe('No active supplier is linked to this service.');
    expect(noLinkReason(costly, false)).toBe(costly.message);
  });
});

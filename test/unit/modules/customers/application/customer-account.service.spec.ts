// Unit tests of the wire shape of the retail account's shop orders (decision 064, `GET /store/v1/me/orders`): the order as the orders module
// lists it, with the tracking token revealed by the service, becomes the wire order the account page shows.
import { describe, expect, it } from 'bun:test';
import { toShopOrder } from '@src/modules/customers/application/customer-account.service';
import type { ShopOrderRow } from '@src/modules/orders';

const row: ShopOrderRow = {
  id: 4021,
  status: 'completed',
  serviceId: 7,
  serviceName: 'Vodafone UK iPhone Unlock',
  imei: '353890110012345',
  quantity: 1,
  totalPrice: '13.7500',
  taxAmount: '2.7500',
  currency: 'GBP',
  publicToken: null,
  publicTokenEnc: 'v1:sealed',
  createdAt: new Date('2026-10-30T14:20:00.000Z'),
  completedAt: new Date('2026-10-30T14:31:00.000Z'),
};

describe('toShopOrder', () => {
  it('shapes an order for the account page, with the revealed tracking token and ISO dates', () => {
    expect(toShopOrder(row, 'Tq8Zr3LmV1xN7cHk2YwB5dFa9PsJ4uE6')).toEqual({
      id: 4021,
      status: 'completed',
      service: { id: 7, name: 'Vodafone UK iPhone Unlock' },
      imei: '353890110012345',
      quantity: 1,
      totalPrice: '13.7500',
      taxAmount: '2.7500',
      currency: 'GBP',
      trackingToken: 'Tq8Zr3LmV1xN7cHk2YwB5dFa9PsJ4uE6',
      createdAt: '2026-10-30T14:20:00.000Z',
      completedAt: '2026-10-30T14:31:00.000Z',
    });
  });

  it('sends an erased IMEI as an empty string, an open order without a completion time, and no token as null', () => {
    const open = toShopOrder({ ...row, imei: null, status: 'processing', completedAt: null }, null);
    expect(open).toMatchObject({ imei: '', status: 'processing', completedAt: null, trackingToken: null });
  });
});

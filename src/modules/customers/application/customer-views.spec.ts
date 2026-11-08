// Unit tests of the customer wire builders: the list row, the detail, the store account and the store order.
import { describe, expect, it } from 'bun:test';
import type { Customer } from '../db/schema';
import type { CustomerRow } from '../infra/customer.repository';
import { toStoreMe, toStoreOrder, toWireCustomer, toWireDetail } from './customer-views';

const at = (iso: string) => new Date(iso);

function customer(overrides: Partial<Customer> = {}): Customer {
  return {
    id: 7,
    email: 'a@example.com',
    emailVerifiedAt: at('2026-10-01T00:00:00.000Z'),
    name: 'A',
    phone: '',
    country: 'GB',
    locale: 'en',
    currency: 'GBP',
    hasAccount: true,
    createdBy: null,
    marketingOptIn: false,
    riskLevel: 'low',
    status: 'active',
    suspendedAt: null,
    suspendedReason: null,
    suspendedBy: null,
    internalNotes: '',
    lastLoginAt: null,
    firstOrderAt: null,
    totalSpent: '0.0000',
    anonymizedAt: null,
    createdAt: at('2026-09-01T00:00:00.000Z'),
    updatedAt: at('2026-09-01T00:00:00.000Z'),
    ...overrides,
  };
}

const row = (overrides: Partial<CustomerRow> = {}): CustomerRow => ({
  customer: customer(),
  currencyId: 2,
  ordersCount: 3,
  lastOrderAt: at('2026-10-30T14:20:00.000Z'),
  ...overrides,
});

describe('toWireCustomer', () => {
  it('sends the currency as id and code, dates as ISO text and no updatedAt', () => {
    const wire = toWireCustomer(row());
    expect(wire).toMatchObject({
      id: 7,
      currency: 2,
      currencyCode: 'GBP',
      emailVerifiedAt: '2026-10-01T00:00:00.000Z',
      ordersCount: 3,
      lastOrderAt: '2026-10-30T14:20:00.000Z',
      suspendedAt: null,
    });
    expect(wire).not.toHaveProperty('updatedAt');
  });

  it('sends null for both currency fields when the customer has none', () => {
    const wire = toWireCustomer(row({ customer: customer({ currency: null }), currencyId: null }));
    expect(wire).toMatchObject({ currency: null, currencyCode: null });
  });
});

describe('toWireDetail', () => {
  const parts = {
    counts: { refunds: 1, tickets: 2, disputes: 0 },
    risk: { highestScore: 61, signals: [{ text: 'New device', orderId: 9 }] },
    consents: null,
    account: null,
  };

  it('copies the order figures into stats and gives a guest no account', () => {
    const detail = toWireDetail(row({ customer: customer({ hasAccount: false, totalSpent: '27.5000' }) }), parts);
    expect(detail.stats).toEqual({
      orders: 3,
      spent: '27.5000',
      lastOrderAt: '2026-10-30T14:20:00.000Z',
      refunds: 1,
      tickets: 2,
      disputes: 0,
    });
    expect(detail.account).toBeNull();
    expect(detail.latestConsents).toBeNull();
    expect(detail.risk).toEqual({ highestScore: 61, signals: [{ text: 'New device', orderId: 9 }] });
  });

  it('labels the consent documents and reads emailVerified from the customer', () => {
    const detail = toWireDetail(row({ customer: customer({ emailVerifiedAt: null }) }), {
      ...parts,
      account: {
        mustChangePassword: true,
        passwordChangedAt: null,
        resetSentAt: at('2026-11-01T00:00:00.000Z'),
        activeSessions: 2,
        lastIp: '203.0.113.1',
      },
      consents: {
        orderId: 5,
        records: [
          {
            purpose: 'terms',
            documentType: 'terms',
            documentVersion: '3.2',
            at: at('2026-10-30T14:19:19.000Z'),
            ip: '203.0.113.1',
          },
          {
            purpose: 'withdrawal_waiver',
            documentType: null,
            documentVersion: null,
            at: at('2026-10-30T14:19:22.000Z'),
            ip: '203.0.113.1',
          },
        ],
      },
    });
    expect(detail.account).toEqual({
      emailVerified: false,
      mustChangePassword: true,
      passwordChangedAt: null,
      resetSentAt: '2026-11-01T00:00:00.000Z',
      activeSessions: 2,
      lastIp: '203.0.113.1',
    });
    expect(detail.latestConsents?.records.map((record) => record.document)).toEqual(['Terms of service v3.2', null]);
  });
});

describe('toStoreMe and toStoreOrder', () => {
  it('shows the customer to themselves, with the currency code and whether a password exists', () => {
    expect(toStoreMe(customer({ phone: '1' }), true)).toEqual({
      id: 7,
      email: 'a@example.com',
      emailVerifiedAt: '2026-10-01T00:00:00.000Z',
      name: 'A',
      phone: '1',
      country: 'GB',
      locale: 'en',
      currency: 'GBP',
      marketingOptIn: false,
      hasPassword: true,
      createdAt: '2026-09-01T00:00:00.000Z',
    });
  });

  it('sends an erased IMEI as an empty string and an order without a page as a null token', () => {
    const order = toStoreOrder({
      id: 4,
      status: 'processing',
      serviceId: 1,
      serviceName: 'Unlock',
      imei: null,
      quantity: 1,
      totalPrice: '5.0000',
      taxAmount: '0.0000',
      currency: 'GBP',
      publicToken: null,
      createdAt: at('2026-11-05T10:00:00.000Z'),
      completedAt: null,
    });
    expect(order).toMatchObject({
      imei: '',
      trackingToken: null,
      completedAt: null,
      service: { id: 1, name: 'Unlock' },
    });
  });
});

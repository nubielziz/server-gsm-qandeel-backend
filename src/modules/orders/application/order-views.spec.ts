// Unit tests of what a merchant may do with an order (the portal's `canCancel` and `canVerify`) and of when a review reason is sent.
import { describe, expect, it } from 'bun:test';
import type { Order } from '../db/schema';
import type { OrderRow } from '../infra/order-read.repository';
import { canCancel, canVerify, carriesReason } from './order-views';

const NOW = new Date('2026-11-07T12:00:00.000Z');
const HOUR = 3_600_000;

function row(
  order: Partial<Order>,
  rules: Partial<Pick<OrderRow, 'allowCancel' | 'allowVerify' | 'verifyWindowH'>> = {},
): OrderRow {
  return {
    order: {
      status: 'pending',
      dispatchState: 'pending',
      verificationStatus: null,
      completedAt: null,
      ...order,
    } as Order,
    serviceName: 'Service',
    slaMinutes: 60,
    allowCancel: true,
    allowVerify: true,
    verifyWindowH: 24,
    categoryName: null,
    clientName: null,
    customerName: null,
    customerEmail: null,
    supplierName: null,
    ...rules,
  };
}

describe('canCancel', () => {
  it('is true for an open order that was never sent, when the service allows it', () => {
    for (const dispatchState of ['pending', 'manual', 'held'] as const) {
      expect(canCancel(row({ dispatchState }))).toBe(true);
    }
  });

  it('is false once the order was sent or is being worked on, when closed, and when the service forbids it', () => {
    for (const dispatchState of ['sent', 'operator', 'needs_attention', 'done'] as const) {
      expect(canCancel(row({ dispatchState }))).toBe(false);
    }
    expect(canCancel(row({ status: 'completed', dispatchState: 'done' }))).toBe(false);
    expect(canCancel(row({}, { allowCancel: false }))).toBe(false);
  });
});

describe('canVerify', () => {
  const completed = (hoursAgo: number, overrides: Partial<Order> = {}) =>
    row({
      status: 'completed',
      dispatchState: 'done',
      completedAt: new Date(NOW.getTime() - hoursAgo * HOUR),
      ...overrides,
    });

  it('is true inside the window, once, when the service allows it', () => {
    expect(canVerify(completed(1), NOW)).toBe(true);
    expect(canVerify(completed(24), NOW)).toBe(true);
    expect(canVerify(completed(25), NOW)).toBe(false);
    expect(canVerify(completed(1, { verificationStatus: 'requested' }), NOW)).toBe(false);
    expect(canVerify({ ...completed(1), allowVerify: false }, NOW)).toBe(false);
  });

  it('is false for an order that is not completed and for a window of zero hours', () => {
    expect(canVerify(row({}), NOW)).toBe(false);
    expect(canVerify(row({ status: 'rejected', dispatchState: 'done', completedAt: NOW }), NOW)).toBe(false);
    expect(canVerify({ ...completed(1), verifyWindowH: 0 }, NOW)).toBe(false);
  });
});

describe('carriesReason', () => {
  it('is true only in the queues a person works', () => {
    expect(carriesReason({ status: 'pending', dispatchState: 'manual', verificationStatus: null })).toBe(true);
    expect(carriesReason({ status: 'processing', dispatchState: 'needs_attention', verificationStatus: null })).toBe(
      true,
    );
    expect(carriesReason({ status: 'completed', dispatchState: 'done', verificationStatus: 'requested' })).toBe(true);
    expect(carriesReason({ status: 'pending', dispatchState: 'held', verificationStatus: null })).toBe(true);
    expect(carriesReason({ status: 'pending', dispatchState: 'pending', verificationStatus: null })).toBe(false);
    expect(carriesReason({ status: 'processing', dispatchState: 'operator', verificationStatus: null })).toBe(false);
  });
});

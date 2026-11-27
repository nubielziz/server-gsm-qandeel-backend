// Unit tests of what a merchant may do with an order (the portal's `canCancel` and `canVerify`, until when and why not: decision 075), of
// when a review reason is sent and of the buyer account the staff row and the timeline name (decision 064).
import { describe, expect, it } from 'bun:test';
import type { Order, OrderEvent } from '@src/modules/orders/db/schema';
import type { OrderRow } from '@src/modules/orders/infra/order-read.repository';
import { CANCEL_WINDOW_MS } from '@src/modules/orders/domain/merchant-actions';
import {
  cancelBlockedReason,
  cancelDeadline,
  canCancel,
  canVerify,
  carriesReason,
  toMerchantOrder,
  toStaffEvent,
  toStaffOrder,
  verifyBlockedReason,
  verifyDeadline,
  withActionFacts,
} from '@src/modules/orders/application/order-views';

const NOW = new Date('2026-11-07T12:00:00.000Z');
const HOUR = 3_600_000;

function row(
  order: Partial<Order>,
  rules: Partial<
    Pick<
      OrderRow,
      | 'allowCancel'
      | 'allowVerify'
      | 'verifyWindowH'
      | 'everDispatched'
      | 'accountName'
      | 'accountEmail'
      | 'accountHasAccount'
      | 'rankId'
      | 'rankName'
      | 'rankKind'
    >
  > = {},
): OrderRow {
  return {
    order: {
      status: 'pending',
      dispatchState: 'pending',
      verificationStatus: null,
      completedAt: null,
      sentAt: null,
      ...order,
    } as Order,
    serviceName: 'Service',
    slaMinutes: 60,
    everDispatched: false,
    allowCancel: true,
    allowVerify: true,
    verifyWindowH: 24,
    categoryName: null,
    accountName: 'Casablanca Unlock',
    accountEmail: 'billing@casablanca-unlock.example',
    accountHasAccount: true,
    rankId: 2,
    rankName: 'Wholesale',
    rankKind: 'merchant',
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

  it('is false while a send is in flight (dispatching, or pending with sent_at set by an earlier release)', () => {
    expect(canCancel(row({ dispatchState: 'dispatching', sentAt: NOW }))).toBe(false);
    expect(canCancel(row({ status: 'processing', dispatchState: 'dispatching', sentAt: NOW }))).toBe(false);
    expect(canCancel(row({ dispatchState: 'pending', sentAt: NOW }))).toBe(false);
  });

  it('is false once the order was ever claimed for a supplier call, even when it reads pending, manual or held again', () => {
    for (const dispatchState of ['pending', 'manual', 'held'] as const) {
      expect(canCancel(row({ dispatchState }, { everDispatched: true }))).toBe(false);
      expect(canCancel(row({ dispatchState }, { everDispatched: false }))).toBe(true);
    }
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

describe('cancelDeadline: the end of the cancel window (decision 075)', () => {
  const placedAt = new Date(NOW.getTime() - 30_000);
  const end = new Date(placedAt.getTime() + CANCEL_WINDOW_MS).toISOString();
  const website = (order: Partial<Order> = {}, rules: Parameters<typeof row>[1] = {}) =>
    row({ source: 'portal', placedAt, ...order }, rules);

  it('is placed_at plus two minutes for a cancellable website order waiting for its first send', () => {
    expect(cancelDeadline(website(), NOW)).toBe(end);
    expect(cancelDeadline(website(), new Date(placedAt.getTime() + CANCEL_WINDOW_MS))).toBeNull();
  });

  it('is null for a cancellable manual or held order, a Dhru order, and whenever the order cannot be cancelled', () => {
    expect(cancelDeadline(website({ dispatchState: 'manual' }), NOW)).toBeNull();
    expect(cancelDeadline(website({ dispatchState: 'held' }), NOW)).toBeNull();
    expect(cancelDeadline(website({ source: 'dhru' }), NOW)).toBeNull();
    expect(cancelDeadline(website({}, { allowCancel: false }), NOW)).toBeNull();
    expect(cancelDeadline(website({}, { everDispatched: true }), NOW)).toBeNull();
    expect(cancelDeadline(website({ dispatchState: 'dispatching', sentAt: NOW }), NOW)).toBeNull();
  });
});

describe('cancelBlockedReason', () => {
  it('is null exactly when the order can be cancelled', () => {
    for (const dispatchState of ['pending', 'manual', 'held'] as const) {
      expect(cancelBlockedReason(row({ dispatchState }))).toBeNull();
    }
  });

  it('says closed first for a completed or rejected order, whatever the service allows', () => {
    expect(cancelBlockedReason(row({ status: 'completed', dispatchState: 'done' }))).toBe('closed');
    expect(cancelBlockedReason(row({ status: 'rejected', dispatchState: 'done' }, { allowCancel: false }))).toBe(
      'closed',
    );
  });

  it('says not_allowed for an open order of a service without cancellation, even one already sent', () => {
    expect(cancelBlockedReason(row({}, { allowCancel: false }))).toBe('not_allowed');
    expect(cancelBlockedReason(row({ status: 'processing', dispatchState: 'sent' }, { allowCancel: false }))).toBe(
      'not_allowed',
    );
  });

  it('says already_sent for the facts the machine answers ALREADY_SENT to', () => {
    expect(cancelBlockedReason(row({ status: 'processing', dispatchState: 'sent' }))).toBe('already_sent');
    expect(cancelBlockedReason(row({ dispatchState: 'dispatching', sentAt: NOW }))).toBe('already_sent');
    expect(cancelBlockedReason(row({ dispatchState: 'pending', sentAt: NOW }))).toBe('already_sent');
    expect(cancelBlockedReason(row({ dispatchState: 'pending' }, { everDispatched: true }))).toBe('already_sent');
    expect(cancelBlockedReason(row({ dispatchState: 'needs_attention' }, { everDispatched: true }))).toBe(
      'already_sent',
    );
  });

  it('says in_progress for anything else (staff work on it, or it waits for a person)', () => {
    expect(cancelBlockedReason(row({ status: 'processing', dispatchState: 'operator' }))).toBe('in_progress');
    expect(cancelBlockedReason(row({ dispatchState: 'needs_attention' }))).toBe('in_progress');
  });
});

describe('verifyDeadline and verifyBlockedReason', () => {
  const completedAt = new Date(NOW.getTime() - HOUR);
  const completed = (overrides: Partial<Order> = {}, rules: Parameters<typeof row>[1] = {}) =>
    row({ status: 'completed', dispatchState: 'done', completedAt, ...overrides }, rules);

  it('gives completed_at plus the window and no reason while a verification can be asked for', () => {
    expect(verifyDeadline(completed(), NOW)).toBe(new Date(completedAt.getTime() + 24 * HOUR).toISOString());
    expect(verifyBlockedReason(completed(), NOW)).toBeNull();
  });

  it('says already_requested first, then not_allowed, then not_completed, then window_passed', () => {
    for (const verificationStatus of ['requested', 'accepted', 'refunded'] as const) {
      expect(verifyBlockedReason(completed({ verificationStatus }, { allowVerify: false }), NOW)).toBe(
        'already_requested',
      );
    }
    expect(verifyBlockedReason(completed({}, { allowVerify: false }), NOW)).toBe('not_allowed');
    expect(verifyBlockedReason(row({}, { allowVerify: false }), NOW)).toBe('not_allowed');
    expect(verifyBlockedReason(row({}), NOW)).toBe('not_completed');
    expect(verifyBlockedReason(row({ status: 'rejected', dispatchState: 'done', completedAt }), NOW)).toBe(
      'not_completed',
    );
    expect(verifyBlockedReason(completed({ completedAt: new Date(NOW.getTime() - 25 * HOUR) }), NOW)).toBe(
      'window_passed',
    );
    expect(verifyBlockedReason(completed({}, { verifyWindowH: 0 }), NOW)).toBe('window_passed');
    expect(verifyDeadline(completed({}, { verifyWindowH: 0 }), NOW)).toBeNull();
  });
});

describe('toMerchantOrder: the four facts agree with canCancel and canVerify in every state', () => {
  const placedAt = new Date(NOW.getTime() - 30_000);
  const statuses = ['pending', 'processing', 'completed', 'rejected'] as const;
  const dispatchStates = [
    'pending',
    'dispatching',
    'held',
    'manual',
    'operator',
    'sent',
    'needs_attention',
    'done',
  ] as const;
  const verifications = [null, 'requested', 'accepted', 'refunded'] as const;

  it('cancelBlocked is null exactly when canCancel, verifyBlocked exactly when canVerify, and a deadline only with its action', () => {
    let states = 0;
    for (const status of statuses)
      for (const dispatchState of dispatchStates)
        for (const source of ['portal', 'dhru'] as const)
          for (const sentAt of [null, NOW])
            for (const everDispatched of [false, true])
              for (const allowCancel of [false, true])
                for (const verificationStatus of verifications)
                  for (const completedHoursAgo of [null, 1, 30])
                    for (const verifyWindowH of [0, 24]) {
                      const view = toMerchantOrder(
                        row(
                          {
                            id: 1,
                            status,
                            dispatchState,
                            source,
                            sentAt,
                            placedAt,
                            createdAt: placedAt,
                            verificationStatus,
                            completedAt:
                              completedHoursAgo === null ? null : new Date(NOW.getTime() - completedHoursAgo * HOUR),
                          },
                          { everDispatched, allowCancel, allowVerify: allowCancel, verifyWindowH },
                        ),
                        NOW,
                      );
                      const label = JSON.stringify({
                        status,
                        dispatchState,
                        source,
                        sentAt,
                        everDispatched,
                        allowCancel,
                      });
                      expect(view.cancelBlocked === null, label).toBe(view.canCancel);
                      expect(view.verifyBlocked === null, label).toBe(view.canVerify);
                      if (view.cancelUntil !== null) expect(view.canCancel, label).toBe(true);
                      if (view.verifyUntil !== null) expect(view.canVerify, label).toBe(true);
                      states += 1;
                    }
    expect(states).toBeGreaterThan(1000);
  });

  it('shows the window of a website order just placed, and none on Dhru', () => {
    const fresh = row({ id: 1, source: 'portal', placedAt, createdAt: placedAt });
    expect(toMerchantOrder(fresh, NOW)).toMatchObject({
      canCancel: true,
      cancelUntil: new Date(placedAt.getTime() + CANCEL_WINDOW_MS).toISOString(),
      cancelBlocked: null,
      canVerify: false,
      verifyUntil: null,
      verifyBlocked: 'not_completed',
    });
    const dhru = row({ id: 2, source: 'dhru', placedAt, createdAt: placedAt });
    expect(toMerchantOrder(dhru, NOW)).toMatchObject({ canCancel: true, cancelUntil: null, cancelBlocked: null });
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

describe('toStaffOrder: the buyer account', () => {
  const placed = new Date('2026-11-07T10:00:00.000Z');
  const order = (overrides: Partial<Order>): Partial<Order> => ({
    id: 48101,
    accountId: 8,
    serviceId: 5,
    type: 'imei',
    source: 'dhru',
    status: 'pending',
    dispatchState: 'pending',
    verificationStatus: null,
    imei: '352905112490861',
    quantity: 1,
    inputs: {},
    unitPrice: '16.2600',
    totalPrice: '16.2600',
    unitCost: '13.5000',
    totalCost: '13.5000',
    taxAmount: '0.0000',
    currency: 'USD',
    pricingSnapshot: {},
    supplierId: null,
    supplierRef: null,
    resultCode: null,
    resultComment: null,
    resultFileId: null,
    inputFileId: null,
    adminNote: null,
    createdAt: placed,
    sentAt: null,
    completedAt: null,
    ...overrides,
  });
  const extras = { attempts: 0, reason: null };

  it('replaces the client and customer keys with one account: id, name, masked address, rank and guest flag', () => {
    const view = toStaffOrder(row(order({})), extras, 'masked');
    expect(view.account).toEqual({
      id: 8,
      name: 'Casablanca Unlock',
      email: 'bi•••@casablanca-unlock.example',
      rank: { id: 2, name: 'Wholesale', kind: 'merchant' },
      guest: false,
    });
    expect(view).not.toHaveProperty('client');
    expect(view).not.toHaveProperty('customer');
  });

  it('shows the address in full only to a caller who may read accounts', () => {
    expect(toStaffOrder(row(order({})), extras, 'full').account.email).toBe('billing@casablanca-unlock.example');
    expect(toStaffOrder(row(order({})), extras, 'masked').account.email).not.toContain('billing@');
  });

  it('names a guest of the shop with the retail rank, and never falls back to the full address for a name that is empty', () => {
    const guest = row(order({ source: 'store' }), {
      accountName: '',
      accountEmail: 'daniel@example.com',
      accountHasAccount: false,
      rankId: 4,
      rankName: 'Storefront retail',
      rankKind: 'retail',
    });
    const view = toStaffOrder(guest, extras, 'full');
    expect(view.account.guest).toBe(true);
    expect(view.account.rank).toEqual({ id: 4, name: 'Storefront retail', kind: 'retail' });
    expect(view.account.name).toBe('da•••@example.com');
    expect(view.account.email).toBe('daniel@example.com');
  });

  it('tells the channel from the door, whatever rank the buyer has now', () => {
    for (const source of ['portal', 'dhru', 'v1', 'admin'] as const) {
      expect(toStaffOrder(row(order({ source })), extras, 'masked').channel, source).toBe('b2b');
    }
    // A shop order of an account that is a merchant today is still a shop order.
    expect(toStaffOrder(row(order({ source: 'store' })), extras, 'masked').channel).toBe('b2c');
    expect(toStaffOrder(row(order({ source: 'store' })), extras, 'masked').account.rank.kind).toBe('merchant');
  });
});

describe('toStaffEvent: the account of the actor', () => {
  const event = (actorType: OrderEvent['actorType'], actorId: number | null): OrderEvent => ({
    id: 1,
    orderId: 48101,
    type: 'created',
    fromStatus: null,
    toStatus: null,
    actorType,
    actorId,
    data: { message: 'Order received via Portal' },
    createdAt: new Date('2026-11-07T10:00:00.000Z'),
  });

  it('names the account an account actor is, and resolves an old client or customer row to the account it was', () => {
    expect(toStaffEvent(event('account', 8), { name: 'Casablanca Unlock', accountId: 8 }).account).toEqual({ id: 8 });
    // An old customer number 7 that the map points at account 108: the answer says 108, never 7.
    const old = toStaffEvent(event('customer', 7), { name: 'Daniel Whitmore', accountId: 108 });
    expect(old.actor).toEqual({ type: 'customer', id: 7, name: 'Daniel Whitmore' });
    expect(old.account).toEqual({ id: 108 });
  });

  it('has no account for staff, a supplier, the system, or an old number the map does not know', () => {
    expect(toStaffEvent(event('staff', 3), { name: 'Amal', accountId: null }).account).toBeNull();
    expect(toStaffEvent(event('system', null), undefined).account).toBeNull();
    expect(toStaffEvent(event('customer', 99), undefined)).toMatchObject({
      actor: { type: 'customer', id: 99, name: null },
      account: null,
    });
  });
});

describe('withActionFacts: an answer stored before decision 075', () => {
  it('fills the four missing keys from the stored flags: no deadline, a reason only where the flag is false', () => {
    expect(withActionFacts({ id: 9, canCancel: false, canVerify: false })).toEqual({
      id: 9,
      canCancel: false,
      canVerify: false,
      cancelUntil: null,
      cancelBlocked: 'in_progress',
      verifyUntil: null,
      verifyBlocked: 'not_completed',
    });
    expect(withActionFacts({ canCancel: true, canVerify: true })).toEqual({
      canCancel: true,
      canVerify: true,
      cancelUntil: null,
      cancelBlocked: null,
      verifyUntil: null,
      verifyBlocked: null,
    });
  });

  it('leaves an answer that has the keys as it was stored', () => {
    const stored = {
      canCancel: true,
      canVerify: false,
      cancelUntil: '2026-11-27T10:02:00.000Z',
      cancelBlocked: null,
      verifyUntil: null,
      verifyBlocked: 'not_allowed' as const,
    };
    expect(withActionFacts(stored)).toEqual(stored);
  });
});

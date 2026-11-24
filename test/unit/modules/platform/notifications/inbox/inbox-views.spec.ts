// Unit tests of the text an inbox item shows (feature 23, plan section 9.2; decision 064): an event item is read with the text of the audience
// it was made for (named by its occurrence key: the door of an order, the kind of a wallet), else the audience of the reader's rank, and a
// campaign item with the link of the reader's audience.
import { describe, expect, it } from 'bun:test';
import { NotificationEventRegistry } from '@src/modules/platform/notifications/notification-events';
import { InboxTextRegistry } from '@src/modules/platform/notifications/inbox/inbox-texts';
import {
  UNKNOWN_EVENT_TITLE,
  inboxText,
  storedAudienceOf,
} from '@src/modules/platform/notifications/inbox/inbox-views';
import type { InboxRow } from '@src/modules/platform/notifications/inbox/inbox.repository';

const texts = new InboxTextRegistry(new NotificationEventRegistry());

/** An event item of an account, with the key of its occurrence. */
function eventItem(event: string, dedupeKey: string | null, variables: Record<string, string>): InboxRow {
  return { item: { event, dedupeKey, variables, campaignId: null }, campaign: null } as unknown as InboxRow;
}

describe('storedAudienceOf', () => {
  it('reads the audience out of the key of an occurrence', () => {
    expect(storedAudienceOf('inapp:customer:order.completed:order-4021-completed')).toBe('customer');
    expect(storedAudienceOf('inapp:merchant:wallet.low_balance:outbox-9')).toBe('merchant');
    expect(storedAudienceOf('inapp:staff:broadcast.test:campaign-test-1-1')).toBe('staff');
  });

  it('reads nothing from a missing key or a key of another shape', () => {
    expect(storedAudienceOf(null)).toBeUndefined();
    expect(storedAudienceOf('')).toBeUndefined();
    expect(storedAudienceOf('inapp:account:order.completed:x')).toBeUndefined();
    expect(storedAudienceOf('campaign-1:email:account-4')).toBeUndefined();
  });
});

describe('inboxText', () => {
  const variables = { orderId: '4021', service: 'Vodafone UK iPhone Unlock' };

  it('shows the text of the audience the item was made for, whatever audience the reader has now', () => {
    // An order of the shop door of an account that holds a merchant rank: the item says customer, the reader is a merchant rank.
    const row = eventItem('order.completed', 'inapp:customer:order.completed:shop-1', variables);
    expect(inboxText(row, { audience: 'merchant', name: 'Zain' }, texts)).toMatchObject({
      title: 'Order 4021 completed',
      link: '/account/orders',
    });
    // A merchant item read by an account that holds the retail rank now keeps the merchant text.
    const low = eventItem('wallet.low_balance', 'inapp:merchant:wallet.low_balance:outbox-9', {
      available: '10.00',
      currency: 'USD',
      threshold: '50.00',
    });
    expect(inboxText(low, { audience: 'customer', name: 'Dana' }, texts).title).toBe('Low wallet balance');
  });

  it('falls back to the audience of the reader for an item with no occurrence key', () => {
    const row = eventItem('order.completed', null, variables);
    expect(inboxText(row, { audience: 'customer', name: 'Dana' }, texts).title).toBe('Order 4021 completed');
    // The merchant audience has no in-app text for an order result: there is nothing to show but the plain title.
    expect(inboxText(row, { audience: 'merchant', name: 'Zain' }, texts)).toEqual({
      title: UNKNOWN_EVENT_TITLE,
      body: '',
      link: null,
    });
  });

  it('shows the plain title for an event whose text is no longer registered', () => {
    const row = eventItem('retired.event', 'inapp:customer:retired.event:x', {});
    expect(inboxText(row, { audience: 'customer', name: 'Dana' }, texts).title).toBe(UNKNOWN_EVENT_TITLE);
  });

  it('shows a campaign item with the link of the reader’s audience and the reader’s name', () => {
    const row = {
      item: { event: null, dedupeKey: null, variables: {}, campaignId: 3 },
      campaign: {
        content: { title: 'Maintenance for {{name}}', body: 'Read-only on Friday.' },
        link: { customer: '/account/orders', merchant: '/account/wallet' },
      },
    } as unknown as InboxRow;
    expect(inboxText(row, { audience: 'merchant', name: 'Zain' }, texts)).toEqual({
      title: 'Maintenance for Zain',
      body: 'Read-only on Friday.',
      link: '/account/wallet',
    });
    expect(inboxText(row, { audience: 'customer', name: 'Dana' }, texts).link).toBe('/account/orders');
  });
});

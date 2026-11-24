// Unit tests of the pure part of the recipient reads (platform module, decision 064): the audience of a message can differ from
// the audience of the rank its account holds when the row is sent (the door of an order, the kind of a wallet). The reads of the tables are
// proved by the integration tests.
import { describe, expect, it } from 'bun:test';
import { type Recipient, withAudience } from '@src/modules/platform/notifications/notification-foreign-reads';

const account: Recipient = {
  type: 'account',
  id: 12,
  audience: 'merchant',
  name: 'Zain Mobile Hub',
  email: 'ops@zainmobilehub.example',
  prefs: { events: {} },
  suspended: false,
  inboxEligible: true,
};
const staff: Recipient = { ...account, type: 'staff', audience: 'staff', prefs: {} };

describe('withAudience', () => {
  it('gives an account the audience the message was made for and keeps everything else', () => {
    const shop = withAudience(account, 'customer');
    expect(shop).toEqual({ ...account, audience: 'customer' });
    // The row it came from is not changed.
    expect(account.audience).toBe('merchant');
  });

  it('keeps the audience of the rank when the message names none', () => {
    expect(withAudience(account, undefined)).toBe(account);
  });

  it('never changes a staff recipient', () => {
    expect(withAudience(staff, 'customer')).toBe(staff);
    expect(withAudience(staff, 'merchant')).toBe(staff);
  });
});

// Unit tests of the merchant preference rules (feature 12a, MISMATCHES B165).
import { describe, expect, it } from 'bun:test';
import {
  applyPreferences,
  channelsFor,
  choiceFor,
  parseThreshold,
  savedChoices,
  thresholdOf,
} from '@src/modules/platform/notifications/merchant-preferences';
import {
  BUILT_IN_EVENTS,
  type NotificationEventDefinition,
} from '@src/modules/platform/notifications/notification-events';

const event = (key: string, audience = 'merchant'): NotificationEventDefinition => {
  const found = BUILT_IN_EVENTS.find((definition) => definition.key === key && definition.audience === audience);
  if (!found) throw new Error(`no event ${key}`);
  return found;
};

describe('choiceFor', () => {
  it('reads an event never saved as email on', () => {
    expect(choiceFor(event('wallet.low_balance'), {})).toEqual({ email: true });
    expect(choiceFor(event('wallet.low_balance'), null)).toEqual({ email: true });
  });

  it('keeps the order results off until the merchant opts in', () => {
    expect(choiceFor(event('order.completed'), {})).toEqual({ email: false });
    expect(choiceFor(event('order.completed'), { events: { 'order.completed': { email: true } } })).toEqual({
      email: true,
    });
  });

  it('uses the saved choice and ignores a wrong type', () => {
    const prefs = {
      events: { 'wallet.low_balance': { email: false }, 'invoice.paid': { email: 'yes' } },
    };
    expect(choiceFor(event('wallet.low_balance'), prefs)).toEqual({ email: false });
    expect(choiceFor(event('invoice.paid'), prefs)).toEqual({ email: true });
    expect(choiceFor(event('invoice.paid'), { events: 'nope' })).toEqual({ email: true });
  });

  it('reads a preference that an older save stored with a Telegram switch as if the switch was not there', () => {
    const prefs = {
      events: { 'wallet.low_balance': { email: false, telegram: true }, 'order.completed': { telegram: true } },
    };
    expect(choiceFor(event('wallet.low_balance'), prefs)).toEqual({ email: false });
    expect(choiceFor(event('order.completed'), prefs)).toEqual({ email: false });
    expect(savedChoices(prefs).get('wallet.low_balance')).toEqual({ email: false });
  });

  it('never lets a merchant switch off a transactional event', () => {
    const off = { events: { 'merchant.password_reset': { email: false } } };
    expect(choiceFor(event('merchant.password_reset'), off)).toEqual({ email: true });
  });
});

describe('channelsFor', () => {
  it('is email while the choice is on and nothing while it is off', () => {
    const prefs = { events: { 'wallet.low_balance': { email: true, telegram: true } } };
    expect(channelsFor(event('wallet.low_balance'), prefs)).toEqual(['email']);
    expect(channelsFor(event('wallet.low_balance'), { events: { 'wallet.low_balance': { email: false } } })).toEqual(
      [],
    );
    expect(channelsFor(event('order.completed'), {})).toEqual([]);
  });
});

describe('thresholds', () => {
  it('reads and normalises the stored threshold', () => {
    expect(thresholdOf({ lowBalanceThreshold: '50' })).toBe('50.0000');
    expect(thresholdOf({ lowBalanceThreshold: '12.5' })).toBe('12.5000');
    expect(thresholdOf({ lowBalanceThreshold: 50 })).toBeNull();
    expect(thresholdOf({ lowBalanceThreshold: '-1' })).toBeNull();
    expect(thresholdOf({})).toBeNull();
  });

  it('accepts zero or more with up to four decimals', () => {
    expect(parseThreshold(' 25 ')).toBe('25.0000');
    expect(parseThreshold('0')).toBe('0.0000');
    expect(parseThreshold('0.12345')).toBeUndefined();
    expect(parseThreshold('-1')).toBeUndefined();
    expect(parseThreshold('ten')).toBeUndefined();
    expect(parseThreshold('')).toBeUndefined();
  });
});

describe('applyPreferences', () => {
  it('replaces the listed events, keeps the others and the keys it does not know, and sets the threshold', () => {
    const stored = {
      lowBalanceThreshold: '10.0000',
      other: 'kept',
      // A choice stored for an event that no longer exists is data like any other key: it is kept, never read.
      events: { 'deposit.approved': { email: false, telegram: false } },
    };
    const next = applyPreferences(stored, {
      lowBalanceThreshold: '25.0000',
      events: [{ event: 'wallet.low_balance', email: true }],
    });
    expect(next).toEqual({
      lowBalanceThreshold: '25.0000',
      other: 'kept',
      events: {
        'deposit.approved': { email: false, telegram: false },
        'wallet.low_balance': { email: true },
      },
    });
    expect(stored.lowBalanceThreshold).toBe('10.0000');
  });

  it('writes the email switch only, over an event that an older save stored with a Telegram switch', () => {
    const next = applyPreferences(
      { events: { 'wallet.low_balance': { email: true, telegram: true } } },
      { lowBalanceThreshold: null, events: [{ event: 'wallet.low_balance', email: false }] },
    );
    expect(next).toEqual({ events: { 'wallet.low_balance': { email: false } } });
  });

  it('removes the threshold for null and starts from nothing', () => {
    expect(applyPreferences({ lowBalanceThreshold: '10.0000' }, { lowBalanceThreshold: null, events: [] })).toEqual({
      events: {},
    });
    expect(applyPreferences(null, { lowBalanceThreshold: null, events: [] })).toEqual({ events: {} });
  });
});

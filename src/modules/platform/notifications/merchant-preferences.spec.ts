// Unit tests of the merchant preference rules (feature 12a, MISMATCHES B165).
import { describe, expect, it } from 'bun:test';
import {
  applyPreferences,
  channelsFor,
  choiceFor,
  parseThreshold,
  savedChoices,
  thresholdOf,
  withoutTelegram,
} from './merchant-preferences';
import { BUILT_IN_EVENTS, type NotificationEventDefinition } from './notification-events';

const event = (key: string, audience = 'merchant'): NotificationEventDefinition => {
  const found = BUILT_IN_EVENTS.find((definition) => definition.key === key && definition.audience === audience);
  if (!found) throw new Error(`no event ${key}`);
  return found;
};

describe('choiceFor', () => {
  it('reads an event never saved as email on and Telegram off', () => {
    expect(choiceFor(event('wallet.low_balance'), {})).toEqual({ email: true, telegram: false });
    expect(choiceFor(event('wallet.low_balance'), null)).toEqual({ email: true, telegram: false });
  });

  it('keeps the order results off until the merchant opts in', () => {
    expect(choiceFor(event('order.completed'), {})).toEqual({ email: false, telegram: false });
    expect(choiceFor(event('order.completed'), { events: { 'order.completed': { email: true } } })).toEqual({
      email: true,
      telegram: false,
    });
  });

  it('uses the saved choice, field by field, and ignores a wrong type', () => {
    const prefs = {
      events: { 'wallet.low_balance': { email: false, telegram: true }, 'deposit.approved': { email: 'yes' } },
    };
    expect(choiceFor(event('wallet.low_balance'), prefs)).toEqual({ email: false, telegram: true });
    expect(choiceFor(event('deposit.approved'), prefs)).toEqual({ email: true, telegram: false });
    expect(choiceFor(event('deposit.approved'), { events: 'nope' })).toEqual({ email: true, telegram: false });
  });

  it('never lets a merchant switch off a transactional event, and never offers it a channel the event lacks', () => {
    const off = { events: { 'merchant.password_reset': { email: false, telegram: true } } };
    expect(choiceFor(event('merchant.password_reset'), off)).toEqual({ email: true, telegram: false });
    expect(choiceFor(event('telegram.linked'), off)).toEqual({ email: false, telegram: true });
  });
});

describe('channelsFor', () => {
  it('leaves Telegram out when no chat is linked', () => {
    const prefs = { events: { 'wallet.low_balance': { email: true, telegram: true } } };
    expect(channelsFor(event('wallet.low_balance'), prefs, true)).toEqual(['email', 'telegram']);
    expect(channelsFor(event('wallet.low_balance'), prefs, false)).toEqual(['email']);
    expect(channelsFor(event('order.completed'), {}, true)).toEqual([]);
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

describe('applyPreferences and withoutTelegram', () => {
  it('replaces the listed events, keeps the others and the keys it does not know, and sets the threshold', () => {
    const stored = {
      lowBalanceThreshold: '10.0000',
      other: 'kept',
      events: { 'deposit.approved': { email: false, telegram: false } },
    };
    const next = applyPreferences(stored, {
      lowBalanceThreshold: '25.0000',
      events: [{ event: 'wallet.low_balance', email: true, telegram: true }],
    });
    expect(next).toEqual({
      lowBalanceThreshold: '25.0000',
      other: 'kept',
      events: {
        'deposit.approved': { email: false, telegram: false },
        'wallet.low_balance': { email: true, telegram: true },
      },
    });
    expect(stored.lowBalanceThreshold).toBe('10.0000');
  });

  it('removes the threshold for null and starts from nothing', () => {
    expect(applyPreferences({ lowBalanceThreshold: '10.0000' }, { lowBalanceThreshold: null, events: [] })).toEqual({
      events: {},
    });
    expect(applyPreferences(null, { lowBalanceThreshold: null, events: [] })).toEqual({ events: {} });
  });

  it('turns every Telegram switch off and keeps the email ones', () => {
    const next = withoutTelegram({
      events: { 'wallet.low_balance': { email: true, telegram: true } },
      lowBalanceThreshold: '5.0000',
    });
    expect(next).toEqual({
      events: { 'wallet.low_balance': { email: true, telegram: false } },
      lowBalanceThreshold: '5.0000',
    });
    expect(savedChoices(next).get('wallet.low_balance')).toEqual({ email: true, telegram: false });
  });
});

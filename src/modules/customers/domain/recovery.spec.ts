// Unit tests of the abandoned-checkout recovery rules (feature 19): the verdict order, the two time bounds, the link and the words of the mail.
import { describe, expect, it } from 'bun:test';
import {
  DEFAULT_ABANDONED_MINUTES,
  UNKNOWN_DEVICE,
  deviceName,
  greetingName,
  isPaid,
  recoveryBounds,
  recoveryLink,
  recoveryVerdict,
  type RecoverySession,
} from './recovery';

const at = (iso: string) => new Date(iso);
const NOW = at('2026-11-07T12:00:00.000Z');

const session = (changes: Partial<RecoverySession> = {}): RecoverySession => ({
  createdAt: at('2026-11-07T10:00:00.000Z'),
  recoveryEmailedAt: null,
  orderId: null,
  status: 'expired',
  customerActive: true,
  ...changes,
});

describe('recoveryBounds', () => {
  it('puts the due time `delay` minutes back and the end of recovery 30 days back', () => {
    const { dueBefore, notBefore } = recoveryBounds(NOW, 60);
    expect(dueBefore.toISOString()).toBe('2026-11-07T11:00:00.000Z');
    expect(notBefore.toISOString()).toBe('2026-10-08T12:00:00.000Z');
  });
});

describe('isPaid', () => {
  it('counts an order or the paid status', () => {
    expect(isPaid({ orderId: 9, status: 'expired' })).toBe(true);
    expect(isPaid({ orderId: null, status: 'paid' })).toBe(true);
    expect(isPaid({ orderId: null, status: 'open' })).toBe(false);
  });
});

describe('recoveryVerdict', () => {
  const verdict = (s: RecoverySession | undefined, consent = true, delay = DEFAULT_ABANDONED_MINUTES) =>
    recoveryVerdict(s, consent, NOW, delay);

  it('lets a due, unpaid, never-emailed checkout of a customer who agreed through', () => {
    expect(verdict(session())).toBeNull();
  });

  it('answers not_found for a missing checkout', () => {
    expect(verdict(undefined)).toBe('not_found');
  });

  it('checks in the mock order: already_emailed, already_paid, no_marketing_consent, then the age', () => {
    const everything = session({
      recoveryEmailedAt: at('2026-11-07T11:30:00.000Z'),
      orderId: 4,
      createdAt: at('2026-11-07T11:59:00.000Z'),
    });
    expect(verdict(everything, false)).toBe('already_emailed');
    expect(verdict({ ...everything, recoveryEmailedAt: null }, false)).toBe('already_paid');
    expect(verdict(session({ createdAt: at('2026-11-07T11:59:00.000Z') }), false)).toBe('no_marketing_consent');
    expect(verdict(session({ createdAt: at('2026-11-07T11:59:00.000Z') }))).toBe('too_recent');
  });

  it('leaves out a customer who is suspended or blocked, after the consent check and before the age', () => {
    const away = session({ customerActive: false, createdAt: at('2026-11-07T11:59:00.000Z') });
    expect(verdict(away)).toBe('recipient_suspended');
    expect(verdict(away, false)).toBe('no_marketing_consent');
    expect(verdict({ ...away, orderId: 3 })).toBe('already_paid');
  });

  it('is due from exactly `delay` minutes after the checkout and recoverable until exactly 30 days after it', () => {
    expect(verdict(session({ createdAt: at('2026-11-07T11:00:00.000Z') }))).toBeNull();
    expect(verdict(session({ createdAt: at('2026-11-07T11:00:00.001Z') }))).toBe('too_recent');
    expect(verdict(session({ createdAt: at('2026-10-08T12:00:00.000Z') }))).toBeNull();
    expect(verdict(session({ createdAt: at('2026-10-08T11:59:59.999Z') }))).toBe('expired');
  });

  it('uses the delay it is given', () => {
    const young = session({ createdAt: at('2026-11-07T11:40:00.000Z') });
    expect(verdict(young, true, 60)).toBe('too_recent');
    expect(verdict(young, true, 15)).toBeNull();
  });
});

describe('recoveryLink', () => {
  it('points at the storefront resume page with the token in the query', () => {
    expect(recoveryLink('https://shop.example.com', 'Zk3b0jY8mQe1xVn7hT2cLw')).toBe(
      'https://shop.example.com/checkout/resume?token=Zk3b0jY8mQe1xVn7hT2cLw',
    );
  });

  it('escapes a token that has characters of a URL', () => {
    expect(recoveryLink('https://shop.example.com', 'a b&c')).toBe(
      'https://shop.example.com/checkout/resume?token=a%20b%26c',
    );
  });
});

describe('deviceName', () => {
  it('prefers the marketing name, then brand and model, then "your phone"', () => {
    expect(deviceName({ brand: 'Apple', model: 'A2633', marketingName: 'iPhone 13' })).toBe('iPhone 13');
    expect(deviceName({ brand: 'Samsung', model: 'SM-S911B', marketingName: '  ' })).toBe('Samsung SM-S911B');
    expect(deviceName({ brand: '', model: '', marketingName: '' })).toBe(UNKNOWN_DEVICE);
    expect(deviceName(undefined)).toBe(UNKNOWN_DEVICE);
  });
});

describe('greetingName', () => {
  it('greets a guest with no name as "there"', () => {
    expect(greetingName('')).toBe('there');
    expect(greetingName('  ')).toBe('there');
    expect(greetingName(' Sam ')).toBe('Sam');
  });
});

// Unit tests of the notification event registry (feature 12a): the built-in events are consistent and extendable.
import { describe, expect, it } from 'bun:test';
import {
  BUILT_IN_EVENTS,
  CUSTOMER_MAIL_EVENT_KEYS,
  NotificationEventRegistry,
  isEventKey,
} from './notification-events';

describe('the built-in events', () => {
  it('give every variable a sample and use well-formed keys', () => {
    for (const definition of BUILT_IN_EVENTS) {
      expect(isEventKey(definition.key), definition.key).toBe(true);
      for (const name of definition.variables)
        expect(definition.sample[name], `${definition.key}.${name}`).not.toBe('');
      expect(definition.channels.length).toBeGreaterThan(0);
    }
  });

  it('list the merchant events 12a wires and the customer events of the console', () => {
    const registry = new NotificationEventRegistry();
    const merchant = registry
      .list()
      .filter((definition) => definition.audience === 'merchant')
      .map((definition) => definition.key);
    expect(merchant).toEqual(
      expect.arrayContaining([
        'merchant.email_verification',
        'merchant.password_reset',
        'merchant.invited',
        'wallet.low_balance',
        'service.price_changed',
        'deposit.approved',
        'invoice.paid',
        'order.completed',
        'order.failed',
      ]),
    );
    expect(registry.get('order.completed', 'customer')?.variables).toContain('customerName');
    expect(registry.get('order.completed', 'merchant')?.variables).toContain('merchantName');
    expect(registry.get('order.completed', 'staff')).toBeUndefined();
    expect(registry.has('support.reply')).toBe(true);
    expect(registry.has('nope.nothing')).toBe(false);
  });

  it('register the two alert events for the staff audience, sent by email and Telegram, with the variables the messages need (feature 12b)', () => {
    const registry = new NotificationEventRegistry();
    for (const key of ['alert.fired', 'alert.resolved']) {
      const definition = registry.get(key, 'staff');
      expect(definition, key).toBeDefined();
      expect(definition?.channels).toEqual(['email', 'telegram']);
      expect(definition?.transactional).toBe(true);
      expect(definition?.variables).toEqual([
        'ruleName',
        'severity',
        'metric',
        'value',
        'threshold',
        'subject',
        'detail',
      ]);
      // An alert is not a merchant's or a customer's message.
      expect(registry.get(key, 'merchant')).toBeUndefined();
      expect(registry.get(key, 'customer')).toBeUndefined();
    }
    expect(registry.merchantPreferenceEvents().map((definition) => definition.key)).not.toContain('alert.fired');
  });

  it('register the four customer account mails as transactional email events, next to the six console events', () => {
    const registry = new NotificationEventRegistry();
    for (const key of CUSTOMER_MAIL_EVENT_KEYS) {
      expect(registry.get(key, 'customer'), key).toMatchObject({
        channels: ['email'],
        transactional: true,
        variables: ['customerName', 'link', 'expiresAt'],
      });
      expect(registry.get(key, 'merchant'), key).toBeUndefined();
    }
    const consoleEvents = registry
      .list()
      .filter((definition) => definition.audience === 'customer' && !definition.transactional)
      .map((definition) => definition.key);
    expect(consoleEvents).toEqual([
      'order.received',
      'order.completed',
      'order.failed',
      'support.reply',
      'checkout.abandoned',
      'payment.failed',
    ]);
  });

  it('offer a merchant the non-transactional merchant events only', () => {
    const keys = new NotificationEventRegistry().merchantPreferenceEvents().map((definition) => definition.key);
    expect(keys).toEqual([
      'wallet.low_balance',
      'service.price_changed',
      'deposit.approved',
      'invoice.paid',
      'order.completed',
      'order.failed',
    ]);
  });
});

describe('NotificationEventRegistry.register', () => {
  const extra = {
    key: 'alert.opened',
    audience: 'staff' as const,
    label: 'Alert opened',
    description: 'x',
    channels: ['email' as const],
    variables: ['title'],
    sample: { title: 'Queue is late' },
    transactional: false,
    defaultEmail: true,
    defaultTelegram: false,
  };

  it('lets a later feature add an event, once', () => {
    const registry = new NotificationEventRegistry();
    registry.register(extra);
    expect(registry.get('alert.opened', 'staff')?.label).toBe('Alert opened');
    expect(() => registry.register(extra)).toThrow(/already registered/);
  });

  it('refuses a bad key, a variable without a sample and an event without a channel', () => {
    const registry = new NotificationEventRegistry();
    expect(() => registry.register({ ...extra, key: 'Alert' })).toThrow(/not an event key/);
    expect(() => registry.register({ ...extra, variables: ['title', 'more'] })).toThrow(/no sample/);
    expect(() => registry.register({ ...extra, channels: [] })).toThrow(/at least one channel/);
  });
});

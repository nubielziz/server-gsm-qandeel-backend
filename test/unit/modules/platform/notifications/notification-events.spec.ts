// Unit tests of the notification event registry (feature 12a): the built-in events are consistent and extendable.
import { describe, expect, it } from 'bun:test';
import { IDENTITY_MAIL_EVENTS } from '@src/modules/identity/application/mail/identity-mail-events';
import { IDENTITY_DEFAULT_TEMPLATES } from '@src/modules/identity/application/mail/identity-templates';
import { DEFAULT_TEMPLATES } from '@src/modules/platform/notifications/default-templates';
import { protectedTemplateProblems } from '@src/modules/platform/notifications/template-rules';
import { BROADCAST_EVENTS } from '@src/modules/platform/notifications/campaigns/broadcast-events';
import { CUSTOMER_WALLET_EVENTS } from '@src/modules/money/application/customer-wallet-notifications';
import { SUPPORT_EVENTS } from '@src/modules/support/application/support-events';
import { SUPPORT_DEFAULT_TEMPLATES } from '@src/modules/support/application/support-templates';
import {
  BUILT_IN_EVENTS,
  CUSTOMER_MAIL_EVENT_KEYS,
  NotificationEventRegistry,
  RETAIL_PRICES_FOLLOWED_EVENT,
  isEventKey,
} from '@src/modules/platform/notifications/notification-events';

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

  it('register the hourly message about retail prices for the staff audience, sent by email and Telegram (feature 31)', () => {
    const registry = new NotificationEventRegistry();
    const definition = registry.get(RETAIL_PRICES_FOLLOWED_EVENT, 'staff');
    expect(definition).toMatchObject({
      channels: ['email', 'telegram'],
      transactional: true,
      variables: ['changed', 'waiting', 'detached', 'link'],
    });
    expect(registry.get(RETAIL_PRICES_FOLLOWED_EVENT, 'merchant')).toBeUndefined();
    expect(registry.get(RETAIL_PRICES_FOLLOWED_EVENT, 'customer')).toBeUndefined();
    expect(registry.merchantPreferenceEvents().map((one) => one.key)).not.toContain(RETAIL_PRICES_FOLLOWED_EVENT);
  });

  it('sample the link of the hourly message about retail prices with the Catalog address of the shop price rules (decision 060)', () => {
    const definition = new NotificationEventRegistry().get(RETAIL_PRICES_FOLLOWED_EVENT, 'staff');
    expect(definition?.sample.link).toBe('https://console.example.com/catalog?view=settings&tab=shop-prices');
  });

  it('register the four customer account mails as transactional email events, next to the seven console events', () => {
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
      .filter(
        (definition) =>
          definition.audience === 'customer' &&
          !(CUSTOMER_MAIL_EVENT_KEYS as readonly string[]).includes(definition.key),
      )
      .map((definition) => [definition.key, definition.transactional]);
    // Feature 23, S6: the events that report on the customer's own purchase or ticket are transactional (a suspended or blocked
    // customer still hears about an order they paid for); the abandoned-checkout reminder is marketing and is not.
    expect(consoleEvents).toEqual([
      ['order.received', true],
      ['order.completed', true],
      ['order.failed', true],
      ['support.reply', true],
      ['checkout.abandoned', false],
      ['payment.failed', true],
      ['refund.declined', true],
      // Decision 047: the notice of a staff change of an account's email, which goes to the address before the change.
      ['customer.security_notice', true],
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

describe('the flags of decision 047', () => {
  /** A registry the way both processes build it at boot: the platform's events and texts, then identity's and support's. */
  const booted = (): NotificationEventRegistry => {
    const registry = new NotificationEventRegistry();
    for (const definition of [...IDENTITY_MAIL_EVENTS, ...SUPPORT_EVENTS]) registry.register(definition);
    registry.registerBuiltInTemplates(IDENTITY_DEFAULT_TEMPLATES);
    registry.registerBuiltInTemplates(SUPPORT_DEFAULT_TEMPLATES);
    return registry;
  };
  const keysOf = (registry: NotificationEventRegistry, flag: 'security' | 'secretLink' | 'namedAddress'): string[] =>
    registry
      .list()
      .filter((definition) => definition[flag] === true)
      .map((definition) => `${definition.audience}:${definition.key}`)
      .sort();

  it('marks exactly the link mails of accounts, the ticket links and the reminder as secret links', () => {
    expect(keysOf(booted(), 'secretLink')).toEqual(
      [
        'merchant:merchant.email_verification',
        'merchant:merchant.password_reset',
        'merchant:merchant.invited',
        'customer:customer.magic_link',
        'customer:customer.password_reset',
        'customer:customer.invited',
        'customer:customer.email_verification',
        'staff:staff.invited',
        'staff:staff.password_reset',
        'customer:support.reply',
        'customer:support.ticket_received',
        'customer:support.csat_survey',
        'customer:checkout.abandoned',
      ].sort(),
    );
    // The merchant's reply link is a portal page by id, and the retail message links a console page.
    const registry = booted();
    expect(registry.get('support.reply', 'merchant')?.secretLink).toBeUndefined();
    expect(registry.get('retail.prices_followed', 'staff')?.secretLink).toBeUndefined();
  });

  it('marks exactly the account link mails and the notices as security mails, and the two staff-action notices as named-address events', () => {
    const registry = booted();
    expect(keysOf(registry, 'security')).toEqual(
      [
        'merchant:merchant.email_verification',
        'merchant:merchant.password_reset',
        'merchant:merchant.invited',
        'customer:customer.magic_link',
        'customer:customer.password_reset',
        'customer:customer.invited',
        'customer:customer.email_verification',
        'staff:staff.invited',
        'staff:staff.password_reset',
        'merchant:merchant.security_notice',
        'merchant:merchant.portal_api_key_created',
        'customer:customer.security_notice',
      ].sort(),
    );
    expect(keysOf(registry, 'namedAddress')).toEqual([
      'customer:customer.security_notice',
      'merchant:merchant.security_notice',
    ]);
    // Ticket mails and the reminder stay switchable.
    for (const [key, audience] of [
      ['support.ticket_received', 'customer'],
      ['support.csat_survey', 'customer'],
      ['support.reply', 'customer'],
      ['checkout.abandoned', 'customer'],
    ] as const) {
      expect(registry.get(key, audience)?.security, key).toBeUndefined();
    }
  });

  it('has a shipped email text for every security event, and every shipped text of a security or secret-link event keeps the rules of its event', () => {
    const registry = booted();
    for (const definition of registry.list()) {
      const shipped = registry.builtInTemplate({
        event: definition.key,
        channel: 'email',
        audience: definition.audience,
      });
      const label = `${definition.audience}:${definition.key}`;
      if (definition.security === true) expect(shipped, label).toBeDefined();
      if ((definition.secretLink === true || definition.security === true) && shipped !== undefined)
        expect(protectedTemplateProblems(definition, shipped), label).toEqual([]);
    }
    // The reminder is the one link event without a shipped text (no marketing words the owner never chose).
    expect(
      registry.builtInTemplate({ event: 'checkout.abandoned', channel: 'email', audience: 'customer' }),
    ).toBeUndefined();
  });

  it('classifies every event whose variables include a link: a secret link, or one of two named exceptions', () => {
    // Every registration site of the application: the platform's own events, identity's, support's, the customer wallet's and the campaigns'.
    const registry = booted();
    for (const definition of [...CUSTOMER_WALLET_EVENTS, ...BROADCAST_EVENTS]) registry.register(definition);
    // A link that is a page by id, not a credential: the merchant's support reply (a portal page) and the staff notice about followed prices.
    const NOT_SECRET = ['merchant:support.reply', 'staff:retail.prices_followed'];
    const withLink = registry.list().filter((definition) => definition.variables.includes('link'));
    const label = (definition: { audience: string; key: string }) => `${definition.audience}:${definition.key}`;
    expect(
      withLink
        .filter((definition) => definition.secretLink !== true)
        .map(label)
        .sort(),
    ).toEqual(NOT_SECRET);
    // The other way round: a flag that names a link the event does not have would be a mistake.
    for (const definition of registry.list().filter((event) => event.secretLink === true)) {
      expect(definition.variables, label(definition)).toContain('link');
    }
    expect(withLink.length).toBeGreaterThan(NOT_SECRET.length);
  });

  it('refuses a shipped text registered twice', () => {
    const registry = new NotificationEventRegistry();
    expect(() => registry.registerBuiltInTemplates([DEFAULT_TEMPLATES[0]!])).toThrow(/already registered/);
  });

  it('refuses a security event that is not transactional', () => {
    const registry = new NotificationEventRegistry();
    expect(() =>
      registry.register({
        key: 'alert.opened',
        audience: 'staff',
        label: 'x',
        description: 'x',
        channels: ['email'],
        variables: [],
        sample: {},
        transactional: false,
        defaultEmail: true,
        defaultTelegram: false,
        security: true,
      }),
    ).toThrow(/must be transactional/);
  });
});

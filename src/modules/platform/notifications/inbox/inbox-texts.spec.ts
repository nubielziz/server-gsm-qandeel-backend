// Unit tests of the in-app text registry (feature 23, plan section 9.2): every built-in text has English and Arabic, names a registered
// event and uses only its variables; the registry refuses duplicates and empty texts; rendering picks the language.
import { describe, expect, it } from 'bun:test';
import { BROADCAST_EVENTS } from '../campaigns/broadcast-events';
import { NotificationEventRegistry } from '../notification-events';
import { placeholdersOf } from '../template-rules';
import { BUILT_IN_INBOX_TEXTS } from './built-in-inbox-texts';
import { type InboxTextDefinition, InboxTextRegistry, inboxTextProblems, renderInboxText } from './inbox-texts';

const events = (): NotificationEventRegistry => {
  const registry = new NotificationEventRegistry();
  for (const definition of BROADCAST_EVENTS) registry.register(definition);
  return registry;
};

const LINK = /^\/(?!\/)[A-Za-z0-9\-._~/]*$/;

describe('BUILT_IN_INBOX_TEXTS', () => {
  it('covers the storefront order and payment mails, a merchant low balance and paid invoice, and the campaign test', () => {
    expect(BUILT_IN_INBOX_TEXTS.map((text) => `${text.audience}:${text.event}`).sort()).toEqual([
      'customer:order.completed',
      'customer:order.failed',
      'customer:order.received',
      'customer:payment.failed',
      'customer:refund.declined',
      'merchant:invoice.paid',
      'merchant:wallet.low_balance',
      'staff:broadcast.test',
    ]);
  });

  it('uses only registered events and their own variables, in both languages', () => {
    expect(inboxTextProblems(BUILT_IN_INBOX_TEXTS, events())).toEqual([]);
  });

  it('uses the same placeholders in English and Arabic', () => {
    for (const text of BUILT_IN_INBOX_TEXTS) {
      const en = placeholdersOf(`${text.texts.en.title}\n${text.texts.en.body}`).sort();
      const ar = placeholdersOf(`${text.texts.ar.title}\n${text.texts.ar.body}`).sort();
      expect(ar, text.event).toEqual(en);
    }
  });

  it('links to a site path without a language prefix, when it links', () => {
    for (const text of BUILT_IN_INBOX_TEXTS) {
      if (text.link !== undefined) {
        expect(text.link, text.event).toMatch(LINK);
        expect(text.link, text.event).not.toMatch(/^\/(en|ar)\//);
      }
    }
  });
});

describe('InboxTextRegistry', () => {
  const extra: InboxTextDefinition = {
    audience: 'merchant',
    event: 'order.completed',
    category: 'order',
    texts: { en: { title: 'Done {{orderId}}', body: 'b' }, ar: { title: 'تم {{orderId}}', body: 'ب' } },
  };

  it('starts with the built-in texts and finds one by audience and event', () => {
    const registry = new InboxTextRegistry(events());
    expect(registry.list()).toHaveLength(BUILT_IN_INBOX_TEXTS.length);
    expect(registry.get('customer', 'order.completed')?.category).toBe('order');
    expect(registry.get('merchant', 'order.completed')).toBeUndefined();
  });

  it('refuses a second text for one audience and event, and an empty text', () => {
    const registry = new InboxTextRegistry(events());
    registry.register(extra);
    expect(() => registry.register(extra)).toThrow('exists');
    expect(() =>
      registry.register({ ...extra, event: 'order.failed', texts: { ...extra.texts, ar: { title: ' ', body: 'b' } } }),
    ).toThrow('empty');
  });

  it('fails the boot for a text that uses a variable its event lacks, or an event the audience does not have', () => {
    const registry = new InboxTextRegistry(events());
    registry.register({ ...extra, texts: { ...extra.texts, en: { title: '{{secret}}', body: 'b' } } });
    expect(() => registry.onApplicationBootstrap()).toThrow('secret');
    expect(inboxTextProblems([{ ...extra, event: 'no.such.event' }], events())[0]).toContain('does not have');
  });
});

describe('renderInboxText', () => {
  const text = BUILT_IN_INBOX_TEXTS.find((item) => item.event === 'order.completed')!;

  it('renders English or Arabic with the stored values and the link', () => {
    const variables = { orderId: 'GSM-1', service: 'Unlock' };
    expect(renderInboxText(text, 'en', variables)).toMatchObject({
      title: 'Order GSM-1 completed',
      link: '/account/orders',
      locale: 'en',
    });
    expect(renderInboxText(text, 'ar-JO', variables).locale).toBe('ar');
    expect(renderInboxText(text, 'ar', variables).title).toContain('GSM-1');
  });

  it('never turns values into markup (plain text)', () => {
    expect(renderInboxText(text, 'en', { orderId: '<b>1</b>', service: 's' }).title).toBe('Order <b>1</b> completed');
  });
});

// Unit tests of the default templates (features 12a, 14b, 12b, 16 and 31): they use only their event's placeholders, cover every merchant
// event the platform wires, the four customer account mails, both alert events, the five storefront mails of feature 16 and the hourly
// message about retail prices, migrations 0011, 0012, 0015, 0018 and 0044 together insert exactly these rows, and `defaultTemplatesSql()`
// writes today's shape (no language, decision 039).
import { describe, expect, it } from 'bun:test';
import { insertedTemplates } from '../../../../test/support/applied-templates';
import { DEFAULT_TEMPLATES, defaultTemplatesSql } from './default-templates';
import {
  BUILT_IN_EVENTS,
  CUSTOMER_MAIL_EVENT_KEYS,
  MERCHANT_MAIL_EVENT_KEYS,
  NotificationEventRegistry,
} from './notification-events';
import { checkTemplateFields } from './template-rules';

const registry = new NotificationEventRegistry();

describe('DEFAULT_TEMPLATES', () => {
  it('belong to a registered event and channel, use only that event’s placeholders, and give an email a subject', () => {
    for (const template of DEFAULT_TEMPLATES) {
      const label = `${template.event} ${template.channel}`;
      const definition = registry.get(template.event, template.audience);
      expect(definition, label).toBeDefined();
      expect(definition?.channels, label).toContain(template.channel);
      expect(checkTemplateFields(template, definition!.variables), label).toEqual([]);
    }
  });

  it('are unique per event, channel and audience', () => {
    const keys = DEFAULT_TEMPLATES.map((t) => `${t.event}|${t.channel}|${t.audience}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('cover the three merchant mails, and every merchant event with each of its channels', () => {
    const has = (event: string, channel: string) =>
      DEFAULT_TEMPLATES.some((t) => t.event === event && t.channel === channel);
    for (const key of MERCHANT_MAIL_EVENT_KEYS) expect(has(key, 'email'), key).toBe(true);
    for (const definition of BUILT_IN_EVENTS.filter((event) => event.audience === 'merchant')) {
      for (const channel of definition.channels)
        expect(has(definition.key, channel), `${definition.key} ${channel}`).toBe(true);
    }
  });

  it('word each alert message with the rule, the subject, the value against the limit and the detail', () => {
    for (const template of DEFAULT_TEMPLATES.filter((t) => t.event.startsWith('alert.'))) {
      const label = `${template.event} ${template.channel}`;
      for (const name of ['ruleName', 'subject', 'metric', 'value', 'threshold', 'detail'])
        expect(template.body, `${label} {{${name}}}`).toContain(`{{${name}}}`);
    }
  });

  it('give the links the merchant mails need: the link and its expiry', () => {
    for (const key of MERCHANT_MAIL_EVENT_KEYS) {
      const template = DEFAULT_TEMPLATES.find((t) => t.event === key)!;
      expect(template.body).toContain('{{link}}');
      expect(template.body).toContain('{{expiresAt}}');
    }
  });

  it('cover the four customer account mails with an English email that holds the link, its expiry and the name', () => {
    for (const key of CUSTOMER_MAIL_EVENT_KEYS) {
      const template = DEFAULT_TEMPLATES.find(
        (t) => t.event === key && t.audience === 'customer' && t.channel === 'email',
      );
      expect(template, key).toBeDefined();
      expect(template!.subject, key).not.toBe('');
      for (const placeholder of ['{{customerName}}', '{{link}}', '{{expiresAt}}'])
        expect(template!.body, `${key} ${placeholder}`).toContain(placeholder);
    }
  });
});

/** The migrations that insert default templates, oldest first. */
const MIGRATIONS = [
  '0011_notifications_delivery.sql',
  '0012_customer_mail_templates.sql',
  '0015_alert_templates.sql',
  '0018_refund_declined_template.sql',
  '0044_retail_follow_templates.sql',
] as const;

/** The customer events feature 16 sends through `StorefrontMails`, with the placeholder each one's text must use to say what it is about. */
const STOREFRONT_MAILS: ReadonlyArray<readonly [event: string, placeholder: string]> = [
  ['order.received', '{{amount}}'],
  ['order.completed', '{{orderId}}'],
  ['order.failed', '{{amount}}'],
  ['payment.failed', '{{amount}}'],
  ['refund.declined', '{{reason}}'],
];

describe('the storefront mails of feature 16', () => {
  it('each ship an English, active-by-default email to the customer, so a migrated database sends them without the development seed', () => {
    for (const [event, placeholder] of STOREFRONT_MAILS) {
      const template = DEFAULT_TEMPLATES.find((t) => t.event === event && t.audience === 'customer');
      expect(template, event).toMatchObject({ channel: 'email' });
      expect(template!.subject, event).not.toBe('');
      expect(template!.body, `${event} ${placeholder}`).toContain(placeholder);
      expect(template!.body, `${event} name`).toContain('{{customerName}}');
      // No mail carries a file, so no text may promise one.
      expect(`${template!.subject} ${template!.body}`, event).not.toMatch(/attach/i);
    }
  });

  it('are exactly the events StorefrontMails writes: each is a customer event of the registry that reaches the customer by email only', () => {
    for (const [event] of STOREFRONT_MAILS) {
      expect(registry.get(event, 'customer')?.channels, event).toEqual(['email']);
    }
  });
});

describe('the refund declined mail', () => {
  it('has an English email that names the order, the amount and the reason staff gave', () => {
    const template = DEFAULT_TEMPLATES.find((t) => t.event === 'refund.declined' && t.audience === 'customer');
    expect(template).toMatchObject({ channel: 'email' });
    expect(template!.subject).toContain('{{orderId}}');
    for (const placeholder of ['{{customerName}}', '{{orderId}}', '{{amount}}', '{{reason}}'])
      expect(template!.body, placeholder).toContain(placeholder);
    expect(registry.get('refund.declined', 'customer')).toMatchObject({
      channels: ['email'],
      variables: ['customerName', 'orderId', 'amount', 'reason'],
    });
    expect(registry.get('refund.declined', 'merchant')).toBeUndefined();
  });
});

describe('the migrations that insert the default templates', () => {
  /** The rows each migration inserts, with the key and the texts the code holds (the files keep their `locale` column). */
  const shipped = MIGRATIONS.flatMap((file) =>
    insertedTemplates(file).map((row) => ({ file, row, key: `${row.event}|${row.channel}|${row.audience}` })),
  );

  it('insert only English rows, each a default of the code with the same event, channel, audience, subject and body', () => {
    const defaults: readonly object[] = DEFAULT_TEMPLATES;
    for (const { file, row } of shipped) {
      // A migration written after decision 039 has no language column at all.
      expect(row.locale ?? 'en', file).toBe('en');
      const { event, channel, audience, subject, body } = row;
      expect(defaults, `${file} ${event} ${channel}`).toContainEqual({ event, channel, audience, subject, body });
    }
  });

  it('together insert every default template, each once', () => {
    const inserted = shipped.map(({ key }) => key).sort();
    const expected = DEFAULT_TEMPLATES.map((t) => `${t.event}|${t.channel}|${t.audience}`).sort();
    expect(inserted).toEqual(expected);
  });
});

describe('defaultTemplatesSql()', () => {
  it('writes every default without a language, switched on, keeping a template that exists (one per event, channel and audience)', () => {
    const insert = defaultTemplatesSql();
    expect(insert).toStartWith(
      'INSERT INTO "notification_templates" ("event", "channel", "audience", "subject", "body", "is_active") VALUES',
    );
    expect(insert).toEndWith('ON CONFLICT ("event", "channel", "audience") DO NOTHING;');
    expect(insert).not.toContain('locale');
    expect(insert.match(/, true\)/g)).toHaveLength(DEFAULT_TEMPLATES.length);
    // A quote in a text is doubled, so no text can end the literal.
    expect(defaultTemplatesSql([{ ...DEFAULT_TEMPLATES[0]!, subject: "It's here" }])).toContain("'It''s here'");
  });
});

describe('the alert templates (feature 12b)', () => {
  it('are the two alert events by email and Telegram, for the staff audience', () => {
    const alerts = DEFAULT_TEMPLATES.filter(
      (template) => template.audience === 'staff' && template.event.startsWith('alert.'),
    );
    expect(alerts.map((template) => `${template.event}:${template.channel}`)).toEqual([
      'alert.fired:email',
      'alert.fired:telegram',
      'alert.resolved:email',
      'alert.resolved:telegram',
    ]);
  });
});

describe('the retail price templates (feature 31)', () => {
  const templates = DEFAULT_TEMPLATES.filter((template) => template.event === 'retail.prices_followed');

  it('are one email and one Telegram text for the staff audience, under the brand', () => {
    expect(templates.map((template) => `${template.audience}:${template.channel}`)).toEqual([
      'staff:email',
      'staff:telegram',
    ]);
    expect(templates[0]!.subject).toContain('IMEI-HUB');
    expect(templates[1]!.body).toContain('IMEI-HUB');
  });

  it('say the three counts and where to read them', () => {
    for (const template of templates) {
      for (const name of ['changed', 'waiting', 'detached', 'link'])
        expect(template.body, `${template.channel} {{${name}}}`).toContain(`{{${name}}}`);
    }
  });
});

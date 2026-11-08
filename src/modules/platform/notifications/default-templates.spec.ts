// Unit tests of the default templates (features 12a, 14b and 12b): they use only their event's placeholders, cover every merchant event the
// platform wires, the four customer account mails and both alert events, and the data sections of migrations 0011, 0012 and 0015 together are
// exactly what `defaultTemplatesSql()` writes.
import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
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

  it('are unique per event, channel, audience and language', () => {
    const keys = DEFAULT_TEMPLATES.map((t) => `${t.event}|${t.channel}|${t.audience}|${t.locale}`);
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
    for (const template of DEFAULT_TEMPLATES.filter((t) => t.audience === 'staff')) {
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
      expect(template!.locale).toBe('en');
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
] as const;

/** The `event|channel|audience|locale` key of every row an INSERT in a migration holds (a row starts with two spaces and a bracket). */
function keysInInsert(insert: string): string[] {
  return [...insert.matchAll(/^ {2}\('([^']+)', '([^']+)', '([^']+)', '([^']+)', /gm)].map((m) =>
    m.slice(1, 5).join('|'),
  );
}

describe('the migrations that insert the default templates', () => {
  const insertOf = (file: string): string => {
    const migration = readFileSync(new URL(`../../../../drizzle/${file}`, import.meta.url), 'utf8');
    const start = migration.indexOf('INSERT INTO "notification_templates"');
    expect(start, file).toBeGreaterThan(0);
    return migration.slice(start).trim();
  };

  it('each hold exactly the INSERT that defaultTemplatesSql() writes for the templates it names', () => {
    for (const file of MIGRATIONS) {
      const insert = insertOf(file);
      const keys = new Set(keysInInsert(insert));
      expect(keys.size, file).toBeGreaterThan(0);
      const templates = DEFAULT_TEMPLATES.filter((t) => keys.has(`${t.event}|${t.channel}|${t.audience}|${t.locale}`));
      expect(templates.length, file).toBe(keys.size);
      expect(insert, file).toBe(defaultTemplatesSql(templates));
    }
  });

  it('together insert every default template, each once', () => {
    const inserted = MIGRATIONS.flatMap((file) => keysInInsert(insertOf(file))).sort();
    const expected = DEFAULT_TEMPLATES.map((t) => `${t.event}|${t.channel}|${t.audience}|${t.locale}`).sort();
    expect(inserted).toEqual(expected);
  });
});

describe('the alert templates (feature 12b)', () => {
  it('are the two alert events by email and Telegram, for the staff audience', () => {
    const staff = DEFAULT_TEMPLATES.filter((template) => template.audience === 'staff');
    expect(staff.map((template) => `${template.event}:${template.channel}`)).toEqual([
      'alert.fired:email',
      'alert.fired:telegram',
      'alert.resolved:email',
      'alert.resolved:telegram',
    ]);
  });
});

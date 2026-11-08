// Unit tests of the default templates (feature 12a): they use only their event's placeholders, cover every merchant event the platform wires, and the
// data section of migration 0009 is exactly what `defaultTemplatesSql()` writes, so the two cannot drift.
import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { DEFAULT_TEMPLATES, defaultTemplatesSql } from './default-templates';
import { BUILT_IN_EVENTS, MERCHANT_MAIL_EVENT_KEYS, NotificationEventRegistry } from './notification-events';
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

  it('give the links the merchant mails need: the link and its expiry', () => {
    for (const key of MERCHANT_MAIL_EVENT_KEYS) {
      const template = DEFAULT_TEMPLATES.find((t) => t.event === key)!;
      expect(template.body).toContain('{{link}}');
      expect(template.body).toContain('{{expiresAt}}');
    }
  });
});

describe('migration 0009', () => {
  it('holds exactly the INSERT that defaultTemplatesSql() writes', () => {
    const migration = readFileSync(
      new URL('../../../../drizzle/0011_notifications_delivery.sql', import.meta.url),
      'utf8',
    );
    const start = migration.indexOf('INSERT INTO "notification_templates"');
    expect(start).toBeGreaterThan(0);
    expect(migration.slice(start).trim()).toBe(defaultTemplatesSql());
  });
});

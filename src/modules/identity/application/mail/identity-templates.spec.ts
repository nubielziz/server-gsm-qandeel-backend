// Unit tests of the identity events and their default templates (feature 20): every template belongs to a registered event and channel and
// uses only that event's placeholders, merchant events have English and Arabic, staff events English, and the custom migration is exactly
// what `identityTemplatesSql()` writes.
import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { NotificationEventRegistry } from '../../../platform';
import { IDENTITY_MAIL_EVENTS } from './identity-mail-events';
import { IDENTITY_DEFAULT_TEMPLATES, IDENTITY_TEMPLATES_MIGRATION, identityTemplatesSql } from './identity-templates';

const placeholdersOf = (text: string): string[] => [
  ...new Set([...text.matchAll(/\{\{\s*([A-Za-z][A-Za-z0-9_]*)\s*\}\}/g)].map((match) => match[1]!)),
];

function registry(): NotificationEventRegistry {
  const events = new NotificationEventRegistry();
  for (const definition of IDENTITY_MAIL_EVENTS) events.register(definition);
  return events;
}

describe('IDENTITY_MAIL_EVENTS', () => {
  it('register next to the platform events (no duplicate key) and every variable has a sample', () => {
    const events = registry();
    expect(IDENTITY_MAIL_EVENTS.map((e) => e.key)).toEqual([
      'merchant.approved',
      'merchant.suspended',
      'merchant.reactivated',
      'merchant.kyc_approved',
      'merchant.kyc_rejected',
      'merchant.security_notice',
      'staff.invited',
      'staff.password_reset',
    ]);
    for (const definition of IDENTITY_MAIL_EVENTS) {
      expect(events.get(definition.key, definition.audience)).toBeDefined();
      for (const name of definition.variables) expect(definition.sample[name], name).toBeTruthy();
    }
  });

  it('are transactional email events: always sent, never in a merchant’s preferences', () => {
    for (const definition of IDENTITY_MAIL_EVENTS) {
      expect(definition.transactional, definition.key).toBe(true);
      expect(definition.channels, definition.key).toEqual(['email']);
      expect(definition.defaultEmail, definition.key).toBe(true);
      expect(definition.defaultTelegram, definition.key).toBe(false);
    }
    const preferences = registry().merchantPreferenceEvents();
    expect(preferences.some((event) => IDENTITY_MAIL_EVENTS.some((own) => own.key === event.key))).toBe(false);
  });
});

describe('IDENTITY_DEFAULT_TEMPLATES', () => {
  it('belong to a registered event and channel, use only that event’s placeholders, and have a subject and a body', () => {
    const events = registry();
    expect(IDENTITY_DEFAULT_TEMPLATES).toHaveLength(14);
    for (const template of IDENTITY_DEFAULT_TEMPLATES) {
      const label = `${template.event} ${template.channel} ${template.audience} ${template.locale}`;
      const definition = events.get(template.event, template.audience);
      expect(definition, label).toBeDefined();
      expect(definition?.channels, label).toContain(template.channel);
      const unknown = [...placeholdersOf(template.subject), ...placeholdersOf(template.body)].filter(
        (name) => !definition!.variables.includes(name),
      );
      expect(unknown, label).toEqual([]);
      expect(template.subject.trim(), label).not.toBe('');
      expect(template.body.trim(), label).not.toBe('');
    }
  });

  it('are unique per event, channel, audience and language', () => {
    const keys = IDENTITY_DEFAULT_TEMPLATES.map((t) => `${t.event}|${t.channel}|${t.audience}|${t.locale}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('give every merchant event an English and an Arabic email and every staff event an English one', () => {
    const has = (event: string, audience: string, locale: string) =>
      IDENTITY_DEFAULT_TEMPLATES.some(
        (t) => t.event === event && t.audience === audience && t.locale === locale && t.channel === 'email',
      );
    for (const definition of IDENTITY_MAIL_EVENTS) {
      expect(has(definition.key, definition.audience, 'en'), `${definition.key} en`).toBe(true);
      if (definition.audience === 'merchant')
        expect(has(definition.key, 'merchant', 'ar'), `${definition.key} ar`).toBe(true);
    }
  });

  it('carry the staff link and its expiry in both staff mails, and the reason in the KYC rejection', () => {
    for (const key of ['staff.invited', 'staff.password_reset']) {
      const template = IDENTITY_DEFAULT_TEMPLATES.find((t) => t.event === key)!;
      expect(template.body).toContain('{{link}}');
      expect(template.body).toContain('{{expiresAt}}');
    }
    for (const locale of ['en', 'ar']) {
      const template = IDENTITY_DEFAULT_TEMPLATES.find(
        (t) => t.event === 'merchant.kyc_rejected' && t.locale === locale,
      )!;
      expect(template.body).toContain('{{reason}}');
    }
  });

  it('never put the staff reason of a suspension in the suspension mail', () => {
    for (const template of IDENTITY_DEFAULT_TEMPLATES.filter((t) => t.event === 'merchant.suspended')) {
      expect(placeholdersOf(template.body)).toEqual(['merchantName']);
    }
  });
});

describe(`migration ${IDENTITY_TEMPLATES_MIGRATION}`, () => {
  it('holds exactly the INSERT that identityTemplatesSql() writes', () => {
    const migration = readFileSync(
      new URL(`../../../../../drizzle/${IDENTITY_TEMPLATES_MIGRATION}`, import.meta.url),
      'utf8',
    );
    const start = migration.indexOf('INSERT INTO "notification_templates"');
    expect(start).toBeGreaterThanOrEqual(0);
    expect(migration.slice(start).trim()).toBe(identityTemplatesSql());
  });
});

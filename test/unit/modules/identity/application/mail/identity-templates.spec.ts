// Unit tests of the identity events and their default templates (feature 20): every template belongs to a registered event and channel and
// uses only that event's placeholders, every event has one English email, the custom migration that shipped them holds each row, and
// `identityTemplatesSql()` writes today's shape (no language, decision 039).
import { describe, expect, it } from 'bun:test';
import { insertedTemplates } from '../../../../../support/applied-templates';
import { NotificationEventRegistry } from '@src/modules/platform';
import { IDENTITY_MAIL_EVENTS } from '@src/modules/identity/application/mail/identity-mail-events';
import {
  IDENTITY_DEFAULT_TEMPLATES,
  IDENTITY_TEMPLATES_MIGRATION,
  identityTemplatesSql,
} from '@src/modules/identity/application/mail/identity-templates';

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
    expect(IDENTITY_DEFAULT_TEMPLATES).toHaveLength(8);
    for (const template of IDENTITY_DEFAULT_TEMPLATES) {
      const label = `${template.event} ${template.channel} ${template.audience}`;
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

  it('are unique per event, channel and audience', () => {
    const keys = IDENTITY_DEFAULT_TEMPLATES.map((t) => `${t.event}|${t.channel}|${t.audience}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('give every identity event, merchant or staff, one email in English', () => {
    for (const definition of IDENTITY_MAIL_EVENTS) {
      const own = IDENTITY_DEFAULT_TEMPLATES.filter(
        (t) => t.event === definition.key && t.audience === definition.audience && t.channel === 'email',
      );
      expect(own, definition.key).toHaveLength(1);
      expect(`${own[0]!.subject} ${own[0]!.body}`, definition.key).toMatch(/^[\x20-\x7e\n’]+$/);
    }
  });

  it('carry the staff link and its expiry in both staff mails, and the reason in the KYC rejection', () => {
    for (const key of ['staff.invited', 'staff.password_reset']) {
      const template = IDENTITY_DEFAULT_TEMPLATES.find((t) => t.event === key)!;
      expect(template.body).toContain('{{link}}');
      expect(template.body).toContain('{{expiresAt}}');
    }
    const rejected = IDENTITY_DEFAULT_TEMPLATES.find((t) => t.event === 'merchant.kyc_rejected')!;
    expect(rejected.body).toContain('{{reason}}');
  });

  it('never put the staff reason of a suspension in the suspension mail', () => {
    for (const template of IDENTITY_DEFAULT_TEMPLATES.filter((t) => t.event === 'merchant.suspended')) {
      expect(placeholdersOf(template.body)).toEqual(['merchantName']);
    }
  });
});

describe(`migration ${IDENTITY_TEMPLATES_MIGRATION}`, () => {
  it('holds every template of the code, in English, with the same event, channel, audience, subject and body', () => {
    const shipped = insertedTemplates(IDENTITY_TEMPLATES_MIGRATION);
    // The file also holds the Arabic rows it shipped with (migration 0035 deletes them): every English row is one of the code's.
    const english = shipped.filter((row) => row.locale === 'en');
    expect(english).toHaveLength(IDENTITY_DEFAULT_TEMPLATES.length);
    for (const template of IDENTITY_DEFAULT_TEMPLATES)
      expect(english, template.event).toContainEqual({ ...template, locale: 'en' });
  });
});

describe('identityTemplatesSql()', () => {
  it('writes every identity template without a language, keeping a template that exists', () => {
    const insert = identityTemplatesSql();
    expect(insert).toContain('("event", "channel", "audience", "subject", "body", "is_active")');
    expect(insert).toEndWith('ON CONFLICT ("event", "channel", "audience") DO NOTHING;');
    expect(insert.match(/, true\)/g)).toHaveLength(IDENTITY_DEFAULT_TEMPLATES.length);
  });
});

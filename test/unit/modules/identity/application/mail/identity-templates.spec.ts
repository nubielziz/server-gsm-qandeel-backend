// Unit tests of the identity events and their default templates (feature 20): every template belongs to a registered event and channel and
// uses only that event's placeholders, every event has one English email, the custom migration that shipped them holds each row (except
// the events whose text is only shipped with the code), and `identityTemplatesSql()` writes today's shape (no language, decision 039).
import { describe, expect, it } from 'bun:test';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { appliedMigration, insertedTemplates } from '../../../../../support/applied-templates';
import { NotificationEventRegistry } from '@src/modules/platform';
import {
  IDENTITY_MAIL_EVENTS,
  PASSWORD_SET_SENTENCE,
} from '@src/modules/identity/application/mail/identity-mail-events';
import {
  IDENTITY_DEFAULT_TEMPLATES,
  IDENTITY_SHIPPED_TEXT_ONLY,
  IDENTITY_TEMPLATES_MIGRATION,
  identityTemplatesSql,
} from '@src/modules/identity/application/mail/identity-templates';

// The events that were retired after migration 0025 inserted their rows: the two of the document check (decision 061) and the approval mail
// (decision 062). The applied file still inserts their rows and a later migration deletes them again, so they are the only rows of the file
// that the code no longer has. A migration is found by the end of its name, not its number: the number is given again when the branch is merged.
const DRIZZLE = join(import.meta.dir, '../../../../../../drizzle');
const RETIRED: ReadonlyArray<{ readonly events: readonly string[]; readonly migration: string | undefined }> = [
  {
    events: ['merchant.kyc_approved', 'merchant.kyc_rejected'],
    migration: readdirSync(DRIZZLE).find((file) => file.endsWith('_merchant_verification_retired.sql')),
  },
  {
    events: ['merchant.approved'],
    migration: readdirSync(DRIZZLE).find((file) => file.endsWith('_retired_features.sql')),
  },
];
const RETIRED_EVENTS = RETIRED.flatMap((entry) => entry.events);

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
      'merchant.suspended',
      'merchant.reactivated',
      'merchant.security_notice',
      'merchant.portal_api_key_created',
      'staff.invited',
      'staff.password_reset',
      'customer.no_account',
      'customer.sign_up_link',
      'customer.sign_up_existing',
      'customer.password_set',
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
    }
    const preferences = registry().merchantPreferenceEvents();
    expect(preferences.some((event) => IDENTITY_MAIL_EVENTS.some((own) => own.key === event.key))).toBe(false);
  });
});

describe('IDENTITY_DEFAULT_TEMPLATES', () => {
  it('belong to a registered event and channel, use only that event’s placeholders, and have a subject and a body', () => {
    const events = registry();
    expect(IDENTITY_DEFAULT_TEMPLATES).toHaveLength(10);
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

  it('give every identity event, merchant, staff or customer, one email in English', () => {
    for (const definition of IDENTITY_MAIL_EVENTS) {
      const own = IDENTITY_DEFAULT_TEMPLATES.filter(
        (t) => t.event === definition.key && t.audience === definition.audience && t.channel === 'email',
      );
      expect(own, definition.key).toHaveLength(1);
      expect(`${own[0]!.subject} ${own[0]!.body}`, definition.key).toMatch(/^[\x20-\x7e\n’]+$/);
    }
  });

  it('carry the staff link and its expiry in both staff mails', () => {
    for (const key of ['staff.invited', 'staff.password_reset']) {
      const template = IDENTITY_DEFAULT_TEMPLATES.find((t) => t.event === key)!;
      expect(template.body).toContain('{{link}}');
      expect(template.body).toContain('{{expiresAt}}');
    }
  });

  it('give the note to an address without an account what was asked and the sign-up page, and no link (decision 079)', () => {
    const note = IDENTITY_DEFAULT_TEMPLATES.find((t) => t.event === 'customer.no_account')!;
    expect(note.audience).toBe('customer');
    expect(placeholdersOf(note.body).sort()).toEqual(['change', 'signUpUrl']);
    expect(note.body).not.toContain('{{link}}');
    expect(IDENTITY_SHIPPED_TEXT_ONLY).toContain('customer.no_account');
  });

  it('tell the two mails of a sign-up apart: "finish creating your account" and "you already have an account" (decision 079, S3)', () => {
    const finish = IDENTITY_DEFAULT_TEMPLATES.find((t) => t.event === 'customer.sign_up_link')!;
    expect(finish.subject).toBe('Finish creating your account');
    expect(finish.body).toContain('{{link}}');
    expect(finish.body).toContain(
      'If you did not ask for this, ignore this email: no account is made until the link is opened.',
    );
    const existing = IDENTITY_DEFAULT_TEMPLATES.find((t) => t.event === 'customer.sign_up_existing')!;
    expect(existing.subject).toBe('You already have an account');
    expect(existing.body).toContain('You already have an account. Nothing was changed.');
    expect(existing.body).toContain('{{link}}');
    for (const event of ['customer.sign_up_link', 'customer.sign_up_existing']) {
      expect(IDENTITY_SHIPPED_TEXT_ONLY, event).toContain(event);
      expect(registry().get(event, 'customer'), event).toMatchObject({ security: true, secretLink: true });
    }
  });

  it('tell the owner of an account that its sign-up finish set a password, without naming support (decision 079, re-review)', () => {
    const mail = IDENTITY_DEFAULT_TEMPLATES.find((t) => t.event === 'customer.password_set')!;
    expect(mail.audience).toBe('customer');
    expect(mail.subject).toBe('A password was set for your account');
    expect(placeholdersOf(mail.body).sort()).toEqual(['change', 'customerName']);
    expect(placeholdersOf(mail.subject)).toEqual([]);
    // Filled with the sentence the code sends, the body is the text of the brief and says nothing about the support team's change.
    expect(mail.body.replace('{{customerName}}', 'Daniel Whitmore').replace('{{change}}', PASSWORD_SET_SENTENCE)).toBe(
      'Hi Daniel Whitmore,\n\nA password was set for your account just now, when its sign-up was finished.\n\n' +
        'If this was you, there is nothing to do. If it was not you, ask for a sign-in link on the sign-in page, then change the ' +
        'password in your account settings, or contact our support team.',
    );
    expect(mail.body).not.toContain('Our support team made this change');
    expect(IDENTITY_SHIPPED_TEXT_ONLY).toContain('customer.password_set');
    // A security mail with no link: a stored template may not drop `{{change}}`, and it is never stopped for lack of a template.
    expect(registry().get('customer.password_set', 'customer')).toMatchObject({ security: true, transactional: true });
    expect(registry().get('customer.password_set', 'customer')?.secretLink).toBeUndefined();
    expect(registry().get('customer.password_set', 'customer')?.namedAddress).toBeUndefined();
  });

  it('never put the staff reason of a suspension in the suspension mail', () => {
    for (const template of IDENTITY_DEFAULT_TEMPLATES.filter((t) => t.event === 'merchant.suspended')) {
      expect(placeholdersOf(template.body)).toEqual(['merchantName']);
    }
  });
});

describe(`migration ${IDENTITY_TEMPLATES_MIGRATION}`, () => {
  it('holds every template of the code that a migration installs, in English, with the same event, channel, audience, subject and body', () => {
    const shipped = insertedTemplates(IDENTITY_TEMPLATES_MIGRATION);
    // The file also holds the Arabic rows it shipped with (migration 0035 deletes them): every English row is one of the code's.
    const english = shipped.filter((row) => row.locale === 'en' && !RETIRED_EVENTS.includes(row.event));
    const installed = IDENTITY_DEFAULT_TEMPLATES.filter(
      (template) => !IDENTITY_SHIPPED_TEXT_ONLY.includes(template.event),
    );
    expect(english).toHaveLength(installed.length);
    for (const template of installed) expect(english, template.event).toContainEqual({ ...template, locale: 'en' });
  });

  it('still shows the retired events in the applied file, and a later migration deletes their stored rows', () => {
    const inMigration = insertedTemplates(IDENTITY_TEMPLATES_MIGRATION).map((row) => row.event);
    for (const { events, migration } of RETIRED) {
      expect(migration, events.join(', ')).toBeDefined();
      const deleting = appliedMigration(migration ?? 'missing');
      for (const event of events) {
        expect(inMigration, event).toContain(event);
        expect(
          IDENTITY_DEFAULT_TEMPLATES.some((template) => template.event === event),
          event,
        ).toBe(false);
        expect(
          IDENTITY_MAIL_EVENTS.some((definition) => definition.key === event),
          event,
        ).toBe(false);
        expect(deleting, event).toContain(`'${event}'`);
      }
      expect(deleting).toContain('DELETE FROM "notification_templates"');
    }
  });

  it('names only events of the code as shipped with the code alone, and none of them is in the migration', () => {
    const inMigration = insertedTemplates(IDENTITY_TEMPLATES_MIGRATION).map((row) => row.event);
    for (const event of IDENTITY_SHIPPED_TEXT_ONLY) {
      expect(
        IDENTITY_DEFAULT_TEMPLATES.some((template) => template.event === event),
        event,
      ).toBe(true);
      expect(inMigration, event).not.toContain(event);
    }
  });

  it('keeps the notice of a key made in the portal free of the support team, and the text of the staff notice as it was', () => {
    const portal = IDENTITY_DEFAULT_TEMPLATES.find((t) => t.event === 'merchant.portal_api_key_created')!;
    expect(portal.body).toContain('{{change}}');
    expect(`${portal.subject} ${portal.body}`).not.toMatch(/support/i);
    const staff = IDENTITY_DEFAULT_TEMPLATES.find((t) => t.event === 'merchant.security_notice')!;
    expect(staff.body).toContain('Our support team made this change to your account: {{change}}.');
  });
});

describe('identityTemplatesSql()', () => {
  it('writes every identity template without a language, keeping a template that exists', () => {
    const insert = identityTemplatesSql();
    expect(insert).toContain('("event", "channel", "audience", "subject", "body", "is_active")');
    expect(insert).toEndWith('ON CONFLICT ("event", "channel", "audience") DO NOTHING;');
    // The event shipped with the code alone has no stored row in production, so the test database gets none either.
    expect(insert.match(/, true\)/g)).toHaveLength(
      IDENTITY_DEFAULT_TEMPLATES.length - IDENTITY_SHIPPED_TEXT_ONLY.length,
    );
    expect(insert).not.toContain('merchant.portal_api_key_created');
    expect(insert).not.toContain('customer.no_account');
    expect(insert).not.toContain('customer.sign_up_link');
    expect(insert).not.toContain('customer.sign_up_existing');
    expect(insert).not.toContain('customer.password_set');
  });
});

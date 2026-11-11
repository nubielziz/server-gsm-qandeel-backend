// Unit tests of the Arabic default templates (feature 23, plan section 9.4): every English merchant or customer row of the platform has an
// Arabic twin with exactly the same placeholders, each row belongs to a registered event and channel, no staff alert is translated, and the
// migration that inserts the rows holds exactly what `arabicTemplatesSql()` writes.
import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { ARABIC_DEFAULT_TEMPLATES, arabicTemplatesSql } from './arabic-templates';
import { ARABIC_TEMPLATES_MIGRATION } from './campaigns/migration-names';
import { DEFAULT_TEMPLATES } from './default-templates';
import { NotificationEventRegistry } from './notification-events';
import { looksLikeHtml, placeholdersOf } from './template-rules';

const keyOf = (t: { event: string; channel: string; audience: string }) => `${t.event}|${t.channel}|${t.audience}`;
const placeholders = (t: { subject: string; body: string }) => placeholdersOf(`${t.subject}\n${t.body}`).sort();
/** The support module's events and templates are checked by its own spec (platform imports no module). */
const SUPPORT_KEYS = new Set([
  'support.reply|email|customer',
  'support.ticket_received|email|customer',
  'support.csat_survey|email|customer',
  'support.reply|email|merchant',
  'support.reply|telegram|merchant',
]);
const platformRows = ARABIC_DEFAULT_TEMPLATES.filter((t) => !SUPPORT_KEYS.has(keyOf(t)));

describe('ARABIC_DEFAULT_TEMPLATES', () => {
  it('hold 31 rows: 26 for the platform’s merchant and customer rows and 5 for the support module’s', () => {
    expect(ARABIC_DEFAULT_TEMPLATES).toHaveLength(31);
    expect(platformRows).toHaveLength(26);
  });

  it('give every English merchant or customer row of the platform an Arabic row with the same event, channel and audience', () => {
    const english = DEFAULT_TEMPLATES.filter((t) => t.audience !== 'staff')
      .map(keyOf)
      .sort();
    expect(english).toHaveLength(26);
    expect(platformRows.map(keyOf).sort()).toEqual(english);
  });

  it('keep exactly the placeholders of the English row', () => {
    for (const arabic of platformRows) {
      const english = DEFAULT_TEMPLATES.find((t) => keyOf(t) === keyOf(arabic))!;
      expect(placeholders(arabic), keyOf(arabic)).toEqual(placeholders(english));
    }
  });

  it('translate no staff alert, and are unique per event, channel and audience', () => {
    expect(ARABIC_DEFAULT_TEMPLATES.some((t) => t.audience === 'staff')).toBe(false);
    const keys = ARABIC_DEFAULT_TEMPLATES.map(keyOf);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('belong to a registered event and channel, use only that event’s placeholders, and are plain Arabic text', () => {
    const events = new NotificationEventRegistry();
    for (const template of platformRows) {
      const label = keyOf(template);
      const definition = events.get(template.event, template.audience);
      expect(definition, label).toBeDefined();
      expect(definition?.channels, label).toContain(template.channel);
      expect(
        placeholders(template).filter((name) => !definition!.variables.includes(name)),
        label,
      ).toEqual([]);
    }
    for (const template of ARABIC_DEFAULT_TEMPLATES) {
      const label = keyOf(template);
      expect(template.locale).toBe('ar');
      expect(template.body, label).toMatch(/[؀-ۿ]/);
      expect(looksLikeHtml(template.body), label).toBe(false);
      // An email has a subject; a Telegram message has none (like its English row).
      if (template.channel === 'email') expect(template.subject.trim(), label).not.toBe('');
      else expect(template.subject, label).toBe('');
    }
  });

  it('use Latin digits only', () => {
    for (const template of ARABIC_DEFAULT_TEMPLATES) {
      expect(`${template.subject}${template.body}`, keyOf(template)).not.toMatch(/[٠-٩۰-۹]/);
    }
  });
});

describe(`migration ${ARABIC_TEMPLATES_MIGRATION}`, () => {
  it('holds exactly the INSERT that arabicTemplatesSql() writes', () => {
    const migration = readFileSync(
      new URL(`../../../../drizzle/${ARABIC_TEMPLATES_MIGRATION}.sql`, import.meta.url),
      'utf8',
    );
    const start = migration.indexOf('INSERT INTO "notification_templates"');
    expect(start).toBeGreaterThan(0);
    expect(migration.slice(start).trim()).toBe(arabicTemplatesSql());
  });
});

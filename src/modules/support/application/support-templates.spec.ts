// Unit tests of the support events and their default templates (feature 17): every template belongs to a registered event and channel and
// uses only that event's placeholders, every event is covered, and the data section of migration 0012 is exactly what
// `supportTemplatesSql()` writes, so the two cannot drift.
import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { NotificationEventRegistry } from '../../platform';
import { SUPPORT_EVENTS } from './support-events';
import { SUPPORT_DEFAULT_TEMPLATES, supportTemplatesSql } from './support-templates';

/** The `{{placeholders}}` of a text, once each (the platform's own reader is not part of its public API). */
const placeholdersOf = (text: string): string[] => [
  ...new Set([...text.matchAll(/\{\{\s*([A-Za-z][A-Za-z0-9_]*)\s*\}\}/g)].map((match) => match[1]!)),
];

/** The registry the way the API and the worker build it: the platform's events, then the support module's. */
function registry(): NotificationEventRegistry {
  const events = new NotificationEventRegistry();
  for (const definition of SUPPORT_EVENTS) events.register(definition);
  return events;
}

describe('SUPPORT_EVENTS', () => {
  it('register next to the platform events, and each variable has a sample for the preview', () => {
    const events = registry();
    expect(events.get('support.ticket_received', 'customer')).toBeDefined();
    expect(events.get('support.csat_survey', 'customer')).toBeDefined();
    expect(events.get('support.reply', 'merchant')?.channels).toEqual(['email', 'telegram']);
    for (const definition of SUPPORT_EVENTS) {
      for (const name of definition.variables) expect(definition.sample[name], name).toBeTruthy();
    }
  });

  it('keeps a merchant’s support reply out of their preferences (the answer to their own ticket is always sent)', () => {
    const preferences = registry().merchantPreferenceEvents();
    expect(preferences.some((event) => event.key === 'support.reply')).toBe(false);
  });

  it('give the customer’s support.reply (widened in the platform’s list) the reply, the ticket and the link', () => {
    const reply = registry().get('support.reply', 'customer');
    expect(reply?.variables).toEqual(['customerName', 'ticketNumber', 'subject', 'message', 'link']);
    expect(reply?.channels).toEqual(['email']);
    for (const name of reply?.variables ?? []) expect(reply?.sample[name], name).toBeTruthy();
  });
});

describe('SUPPORT_DEFAULT_TEMPLATES', () => {
  it('belong to a registered event and channel, use only that event’s placeholders, and give an email a subject', () => {
    const events = registry();
    for (const template of SUPPORT_DEFAULT_TEMPLATES) {
      const label = `${template.event} ${template.channel} ${template.audience}`;
      const definition = events.get(template.event, template.audience);
      expect(definition, label).toBeDefined();
      expect(definition?.channels, label).toContain(template.channel);
      const unknown = [...placeholdersOf(template.subject), ...placeholdersOf(template.body)].filter(
        (name) => !definition!.variables.includes(name),
      );
      expect(unknown, label).toEqual([]);
      expect(template.body.trim(), label).not.toBe('');
      if (template.channel === 'email') expect(template.subject.trim(), label).not.toBe('');
    }
  });

  it('are unique per event, channel, audience and language', () => {
    const keys = SUPPORT_DEFAULT_TEMPLATES.map((t) => `${t.event}|${t.channel}|${t.audience}|${t.locale}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('cover every support event with each of its channels, and the customer’s links carry the ticket link', () => {
    const has = (event: string, channel: string, audience: string) =>
      SUPPORT_DEFAULT_TEMPLATES.some((t) => t.event === event && t.channel === channel && t.audience === audience);
    for (const definition of SUPPORT_EVENTS) {
      for (const channel of definition.channels) {
        expect(has(definition.key, channel, definition.audience), `${definition.key} ${channel}`).toBe(true);
      }
    }
    expect(has('support.reply', 'email', 'customer')).toBe(true);
    for (const key of ['support.reply', 'support.ticket_received', 'support.csat_survey']) {
      const template = SUPPORT_DEFAULT_TEMPLATES.find((t) => t.event === key && t.audience === 'customer')!;
      expect(template.body, key).toContain('{{link}}');
    }
  });
});

describe('migration 0012', () => {
  it('holds exactly the INSERT that supportTemplatesSql() writes', () => {
    const migration = readFileSync(new URL('../../../../drizzle/0016_support_tickets.sql', import.meta.url), 'utf8');
    const start = migration.indexOf('INSERT INTO "notification_templates"');
    expect(start).toBeGreaterThan(0);
    expect(migration.slice(start).trim()).toBe(supportTemplatesSql());
  });
});

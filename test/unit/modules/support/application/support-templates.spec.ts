// Unit tests of the support events and their default templates (feature 17): every template belongs to a registered event and channel and
// uses only that event's placeholders, every event is covered, every row of the code is found in migration 0016 or made by an update of
// migration 0032 (the files keep the shape they shipped with), and `supportTemplatesSql()` and `supportReplyLinkSql()` write today's shape.
import { describe, expect, it } from 'bun:test';
import { bodyUpdates, insertedTemplates } from '../../../../support/applied-templates';
import { NotificationEventRegistry } from '@src/modules/platform';
import { SUPPORT_EVENTS } from '@src/modules/support/application/support-events';
import {
  CONVERSATION_LINK_LINE,
  SUPPORT_DEFAULT_TEMPLATES,
  supportReplyLinkSql,
  supportTemplatesSql,
  withConversationLink,
} from '@src/modules/support/application/support-templates';

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

  it('are unique per event, channel and audience', () => {
    const keys = SUPPORT_DEFAULT_TEMPLATES.map((t) => `${t.event}|${t.channel}|${t.audience}`);
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

const keyOf = (t: { event: string; channel: string; audience: string }) => `${t.event}|${t.channel}|${t.audience}`;

describe('migrations 0016_support_tickets and 0032_support_reply_link', () => {
  // The English rows of 0016 as they shipped, and the guarded updates of 0032 (the files also hold the Arabic rows migration 0035 deletes).
  const shipped = insertedTemplates('0016_support_tickets.sql').filter((row) => row.locale === 'en');
  const updates = bodyUpdates('0032_support_reply_link.sql').filter((row) => row.locale === 'en');

  it('ship every template of the code: as 0016 inserted it, or with the body 0032 gives the row 0016 shipped', () => {
    expect(shipped.map(keyOf).sort()).toEqual(SUPPORT_DEFAULT_TEMPLATES.map(keyOf).sort());
    for (const template of SUPPORT_DEFAULT_TEMPLATES) {
      const first = shipped.find((row) => keyOf(row) === keyOf(template))!;
      expect(first.subject, keyOf(template)).toBe(template.subject);
      const update = updates.find((row) => keyOf(row) === keyOf(template));
      if (update === undefined) {
        expect(first.body, keyOf(template)).toBe(template.body);
      } else {
        // 0032 changes a row only while it still holds the body 0016 shipped, and leaves it with the body the code has today.
        expect(update.from, keyOf(template)).toBe(first.body);
        expect(update.to, keyOf(template)).toBe(template.body);
      }
    }
    // The updates are the merchant's two replies.
    expect(updates.map(keyOf).sort()).toEqual(['support.reply|email|merchant', 'support.reply|telegram|merchant']);
  });

  it('are installed today by supportTemplatesSql(), without a language', () => {
    const insert = supportTemplatesSql();
    expect(insert).toContain('("event", "channel", "audience", "subject", "body", "is_active")');
    expect(insert).toEndWith('ON CONFLICT ("event", "channel", "audience") DO NOTHING;');
    expect(insert.match(/, true\)/g)).toHaveLength(SUPPORT_DEFAULT_TEMPLATES.length);
    expect(insert).toContain(CONVERSATION_LINK_LINE);
  });
});

describe('the conversation link of the merchant reply (feature 28, migration 0032)', () => {
  it('ends the merchant email and Telegram reply with the portal link, and leaves every other template alone', () => {
    const merchant = SUPPORT_DEFAULT_TEMPLATES.filter((t) => t.event === 'support.reply' && t.audience === 'merchant');
    expect(merchant).toHaveLength(2);
    for (const template of merchant) expect(template.body.endsWith(CONVERSATION_LINK_LINE)).toBe(true);
    const customer = SUPPORT_DEFAULT_TEMPLATES.find((t) => t.event === 'support.reply' && t.audience === 'customer')!;
    expect(withConversationLink(customer)).toBe(customer);
    expect(withConversationLink({ ...merchant[0]!, body: 'x' }).body).toBe(`x\n${CONVERSATION_LINK_LINE}`);
  });

  it('is written by supportReplyLinkSql() as two guarded updates, without a language, that 0032 holds for English', () => {
    const sql = supportReplyLinkSql();
    // Two rows (email and Telegram), each only where the body is still the shipped one.
    expect(sql.match(/AND "body" = /g)).toHaveLength(2);
    expect(sql).not.toContain('locale');
    for (const update of bodyUpdates('0032_support_reply_link.sql').filter((row) => row.locale === 'en')) {
      const quote = (text: string) => `'${text.replace(/'/g, "''")}'`;
      expect(sql).toContain(
        `UPDATE "notification_templates" SET "body" = ${quote(update.to)}\nWHERE "event" = ${quote(update.event)} AND "channel" = ` +
          `${quote(update.channel)} AND "audience" = ${quote(update.audience)} AND "body" = ${quote(update.from)};`,
      );
    }
  });
});

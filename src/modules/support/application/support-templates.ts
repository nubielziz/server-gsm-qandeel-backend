// The default templates of the support events (feature 17): English email and Telegram texts. Migration 0012 inserts the same rows; a test
// keeps the two equal. The console edits them afterwards (Settings > Customer emails).
import type { DefaultTemplate } from '../../platform';

/**
 * The templates the support events start with.
 *
 * Why: a missing template sends nothing (RULES settings 10), so the reply, the receipt and the survey come with the migration. They
 * live here and not in the platform's `DEFAULT_TEMPLATES`: that list is checked against its own migration.
 */
export const SUPPORT_DEFAULT_TEMPLATES: readonly DefaultTemplate[] = [
  {
    event: 'support.reply',
    channel: 'email',
    audience: 'customer',
    locale: 'en',
    subject: 'Re: {{subject}} ({{ticketNumber}})',
    body: 'Hi {{customerName}},\n\n{{message}}\n\nTicket {{ticketNumber}}: {{subject}}\nRead the whole conversation or reply here: {{link}}',
  },
  {
    event: 'support.ticket_received',
    channel: 'email',
    audience: 'customer',
    locale: 'en',
    subject: 'We got your message ({{ticketNumber}})',
    body: 'Hi {{customerName}},\n\nWe received your message "{{subject}}" and opened ticket {{ticketNumber}}. Our team will answer by email.\n\nYou can follow the ticket and add details here: {{link}}\n\nPlease keep this email: the link is private to you.',
  },
  {
    event: 'support.csat_survey',
    channel: 'email',
    audience: 'customer',
    locale: 'en',
    subject: 'How did we do? ({{ticketNumber}})',
    body: 'Hi {{customerName}},\n\nWe marked your ticket {{ticketNumber}} "{{subject}}" as resolved. Please tell us how we did, it takes five seconds:\n\n{{link}}\n\nIf your problem is not solved, write on the same page and we will reopen the ticket.',
  },
  {
    event: 'support.reply',
    channel: 'email',
    audience: 'merchant',
    locale: 'en',
    subject: 'Re: {{subject}} ({{ticketNumber}})',
    body: 'Hi {{merchantName}},\n\n{{message}}\n\nTicket {{ticketNumber}}: {{subject}}',
  },
  {
    event: 'support.reply',
    channel: 'telegram',
    audience: 'merchant',
    locale: 'en',
    subject: '',
    body: 'Support replied on {{ticketNumber}} ({{subject}}):\n{{message}}',
  },
];

/**
 * Writes the support templates as the SQL the migration holds.
 *
 * Why: the migration is plain SQL, so the text is written once here and pasted; a test runs the migration's data section against this
 * function, so the two cannot drift (the same pattern as the platform's `defaultTemplatesSql`).
 *
 * @returns one `INSERT ... ON CONFLICT DO NOTHING` statement for every support template
 */
export function supportTemplatesSql(): string {
  const quote = (text: string) => `'${text.replace(/'/g, "''")}'`;
  const rows = SUPPORT_DEFAULT_TEMPLATES.map(
    (t) =>
      `  (${quote(t.event)}, ${quote(t.channel)}, ${quote(t.audience)}, ${quote(t.locale)}, ${quote(t.subject)}, ${quote(t.body)}, true)`,
  );
  return [
    'INSERT INTO "notification_templates" ("event", "channel", "audience", "locale", "subject", "body", "is_active") VALUES',
    `${rows.join(',\n')}`,
    'ON CONFLICT ("event", "channel", "audience", "locale") DO NOTHING;',
  ].join('\n');
}

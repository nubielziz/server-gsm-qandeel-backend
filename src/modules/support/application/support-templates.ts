// The default templates of the support events (feature 17): English email and Telegram texts. Migration `0016_support_tickets` inserts the
// rows as they first shipped; migration `0032_support_reply_link` adds the conversation link to the merchant's reply (feature 28). Tests
// keep both migrations equal to this file. The console edits the templates afterwards (Settings > Customer emails).
import { ARABIC_DEFAULT_TEMPLATES, type DefaultTemplate } from '../../platform';

/** The templates as migration 0016 shipped them (the merchant's reply had no link: the portal had no ticket page yet). */
const SHIPPED_IN_0016: readonly DefaultTemplate[] = [
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
 * The line migration 0032 appends to the merchant's reply templates, per language.
 *
 * Why: feature 28 gives the merchant portal a ticket page (`/merchant/support/<id>`), so the reply mail and Telegram message link to it.
 */
export const CONVERSATION_LINK_LINES: Readonly<Record<'en' | 'ar', string>> = {
  en: 'Open the conversation: {{link}}',
  ar: 'افتح المحادثة: {{link}}',
};

/** A template row as far as the conversation link cares. */
interface TemplateText {
  readonly event: string;
  readonly channel: string;
  readonly audience: string;
  readonly locale: string;
  readonly body: string;
}

/** True for the merchant's `support.reply` rows (email and Telegram) that get the conversation link. */
const takesConversationLink = (template: TemplateText): boolean =>
  template.event === 'support.reply' &&
  template.audience === 'merchant' &&
  (template.locale === 'en' || template.locale === 'ar');

/**
 * A template with the conversation link appended (only the merchant's `support.reply` rows change).
 *
 * Why: migration 0032 appends exactly this text where the body still equals the shipped default; the same function makes the current
 * defaults, so code and migration cannot drift.
 *
 * @param template a default template row
 * @returns the row with the link line appended, or the row itself
 */
export function withConversationLink<T extends TemplateText>(template: T): T {
  if (!takesConversationLink(template)) return template;
  // An email ends with the ticket line, where the link follows directly; a Telegram message ends with the reply, so a blank line parts them.
  const gap = template.channel === 'email' ? '\n' : '\n\n';
  return { ...template, body: `${template.body}${gap}${CONVERSATION_LINK_LINES[template.locale as 'en' | 'ar']}` };
}

/**
 * The templates the support events start with today.
 *
 * Why: a missing template sends nothing (RULES settings 10), so the reply, the receipt and the survey come with the migrations. They
 * live here and not in the platform's `DEFAULT_TEMPLATES`: that list is checked against its own migration. The merchant's reply carries
 * the conversation link since feature 28 (migration 0032).
 */
export const SUPPORT_DEFAULT_TEMPLATES: readonly DefaultTemplate[] = SHIPPED_IN_0016.map(withConversationLink);

const quote = (text: string) => `'${text.replace(/'/g, "''")}'`;

/**
 * Writes the support templates as the SQL migration 0016 holds (the rows as they first shipped).
 *
 * Why: the migration is plain SQL, so the text is written once here and pasted; a test runs the migration's data section against this
 * function, so the two cannot drift (the same pattern as the platform's `defaultTemplatesSql`).
 *
 * @returns one `INSERT ... ON CONFLICT DO NOTHING` statement for every support template of 0016
 */
export function supportTemplatesSql(): string {
  const rows = SHIPPED_IN_0016.map(
    (t) =>
      `  (${quote(t.event)}, ${quote(t.channel)}, ${quote(t.audience)}, ${quote(t.locale)}, ${quote(t.subject)}, ${quote(t.body)}, true)`,
  );
  return [
    'INSERT INTO "notification_templates" ("event", "channel", "audience", "locale", "subject", "body", "is_active") VALUES',
    `${rows.join(',\n')}`,
    'ON CONFLICT ("event", "channel", "audience", "locale") DO NOTHING;',
  ].join('\n');
}

/**
 * Writes the guarded updates of migration 0032: the conversation link is appended to the merchant's reply templates, English (0016) and
 * Arabic (0027), only where the body still equals the shipped default.
 *
 * Why: feature 28 (plan § 3.1): a template staff edited keeps their text; a test keeps the migration equal to this function.
 *
 * @returns one `UPDATE` per template, separated by statement breakpoints
 */
export function supportReplyLinkSql(): string {
  const shipped = [...SHIPPED_IN_0016, ...ARABIC_DEFAULT_TEMPLATES].filter(takesConversationLink);
  return shipped
    .map(
      (t) =>
        `UPDATE "notification_templates" SET "body" = ${quote(withConversationLink(t).body)}\n` +
        `WHERE "event" = ${quote(t.event)} AND "channel" = ${quote(t.channel)} AND "audience" = ${quote(t.audience)} ` +
        `AND "locale" = ${quote(t.locale)} AND "body" = ${quote(t.body)};`,
    )
    .join('--> statement-breakpoint\n');
}

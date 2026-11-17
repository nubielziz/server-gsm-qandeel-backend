// The default templates of the support events (feature 17): English email and Telegram texts. Migration `0016_support_tickets` inserted the
// rows as they first shipped; migration `0032_support_reply_link` added the conversation link to the merchant's reply (feature 28). A spec
// finds every row of this file in them. The console edits the templates afterwards (Settings > Customer emails).
import { type DefaultTemplate, templatesInsertSql } from '../../platform';

/** The templates as migration 0016 shipped them (the merchant's reply had no link: the portal had no ticket page yet). */
const SHIPPED_IN_0016: readonly DefaultTemplate[] = [
  {
    event: 'support.reply',
    channel: 'email',
    audience: 'customer',
    subject: 'Re: {{subject}} ({{ticketNumber}})',
    body: 'Hi {{customerName}},\n\n{{message}}\n\nTicket {{ticketNumber}}: {{subject}}\nRead the whole conversation or reply here: {{link}}',
  },
  {
    event: 'support.ticket_received',
    channel: 'email',
    audience: 'customer',
    subject: 'We got your message ({{ticketNumber}})',
    body: 'Hi {{customerName}},\n\nWe received your message "{{subject}}" and opened ticket {{ticketNumber}}. Our team will answer by email.\n\nYou can follow the ticket and add details here: {{link}}\n\nPlease keep this email: the link is private to you.',
  },
  {
    event: 'support.csat_survey',
    channel: 'email',
    audience: 'customer',
    subject: 'How did we do? ({{ticketNumber}})',
    body: 'Hi {{customerName}},\n\nWe marked your ticket {{ticketNumber}} "{{subject}}" as resolved. Please tell us how we did, it takes five seconds:\n\n{{link}}\n\nIf your problem is not solved, write on the same page and we will reopen the ticket.',
  },
  {
    event: 'support.reply',
    channel: 'email',
    audience: 'merchant',
    subject: 'Re: {{subject}} ({{ticketNumber}})',
    body: 'Hi {{merchantName}},\n\n{{message}}\n\nTicket {{ticketNumber}}: {{subject}}',
  },
  {
    event: 'support.reply',
    channel: 'telegram',
    audience: 'merchant',
    subject: '',
    body: 'Support replied on {{ticketNumber}} ({{subject}}):\n{{message}}',
  },
];

/**
 * The line migration 0032 appends to the merchant's reply templates.
 *
 * Why: feature 28 gives the merchant portal a ticket page (`/merchant/support/<id>`), so the reply mail and Telegram message link to it.
 */
export const CONVERSATION_LINK_LINE = 'Open the conversation: {{link}}';

/** A template row as far as the conversation link cares. */
interface TemplateText {
  readonly event: string;
  readonly channel: string;
  readonly audience: string;
  readonly body: string;
}

/** True for the merchant's `support.reply` rows (email and Telegram) that get the conversation link. */
const takesConversationLink = (template: TemplateText): boolean =>
  template.event === 'support.reply' && template.audience === 'merchant';

/**
 * A template with the conversation link appended (only the merchant's `support.reply` rows change).
 *
 * Why: migration 0032 appended exactly this text where the body still equalled the shipped default; the same function makes the current
 * defaults, so code and migration cannot drift.
 *
 * @param template a default template row
 * @returns the row with the link line appended, or the row itself
 */
export function withConversationLink<T extends TemplateText>(template: T): T {
  if (!takesConversationLink(template)) return template;
  // An email ends with the ticket line, where the link follows directly; a Telegram message ends with the reply, so a blank line parts them.
  const gap = template.channel === 'email' ? '\n' : '\n\n';
  return { ...template, body: `${template.body}${gap}${CONVERSATION_LINK_LINE}` };
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
 * Writes the support templates as the SQL that installs them today (the merchant's reply with its link; no language, one per event,
 * channel and audience).
 *
 * Why: the text is written once here; migrations 0016 and 0032 keep the shape they shipped with (decision 027), so the spec finds every
 * row of this file in them, and the test support runs this SQL.
 *
 * @returns one `INSERT ... ON CONFLICT DO NOTHING` statement for every support template
 */
export function supportTemplatesSql(): string {
  return templatesInsertSql(SUPPORT_DEFAULT_TEMPLATES);
}

/**
 * Writes the guarded updates of migration 0032 in today's shape: the conversation link is appended to the merchant's reply templates
 * (email and Telegram) only where the body still equals the default migration 0016 shipped.
 *
 * Why: feature 28 (plan § 3.1): a template staff edited keeps their text. Migration 0032 holds these updates with the language it was
 * written for (`"locale" = 'en'`) and for the Arabic rows that migration 0035 deletes; the spec finds each of today's updates in it.
 *
 * @returns one `UPDATE` per template, separated by statement breakpoints
 */
export function supportReplyLinkSql(): string {
  return SHIPPED_IN_0016.filter(takesConversationLink)
    .map(
      (t) =>
        `UPDATE "notification_templates" SET "body" = ${quote(withConversationLink(t).body)}\n` +
        `WHERE "event" = ${quote(t.event)} AND "channel" = ${quote(t.channel)} AND "audience" = ${quote(t.audience)} ` +
        `AND "body" = ${quote(t.body)};`,
    )
    .join('--> statement-breakpoint\n');
}

// The default templates of the support events (feature 17): English email texts. Migration `0016_support_tickets` inserted the
// rows as they first shipped; migration `0032_support_reply_link` added the conversation link to the merchant's reply (feature 28); the migration
// `..._public_abuse_limits` replaced the receipt text where it was not edited (decision 053). A spec finds every row of this file in them. The
// console edits the templates afterwards (Settings > Customer emails).
import { type DefaultTemplate, templatesInsertSql } from '../../platform';

/**
 * The templates as migration 0016 shipped them (the merchant's reply had no link: the portal had no ticket page yet), without the
 * customer's survey mail that the retirement migration of decision 062 deletes.
 *
 * Why: the list mirrors the migrations, which the unit spec compares with it. It still holds the merchant's reply on the channel that was
 * retired (decision 062): {@link SUPPORT_DEFAULT_TEMPLATES} leaves it out and a data step deletes the stored row.
 */
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
 * Why: feature 28 gives a merchant rank a ticket page in the account area (`/account/support/<id>`, decision 064), so the reply mail links to it.
 */
export const CONVERSATION_LINK_LINE = 'Open the conversation: {{link}}';

/** A template row as far as the conversation link cares. */
interface TemplateText {
  readonly event: string;
  readonly channel: string;
  readonly audience: string;
  readonly body: string;
}

/** True for the merchant's `support.reply` rows that get the conversation link. */
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
 * The receipt of a new ticket: fixed wording, the ticket number and the link.
 *
 * Why: decision 053. The receipt goes to an address anyone can type on the contact form, so it repeats nothing a visitor typed (no name,
 * no subject).
 */
export const RECEIPT_BODY =
  'Hello,\n\nWe received your message and opened ticket {{ticketNumber}}. Our team will answer by email.\n\nYou can follow the ticket and add details here: {{link}}\n\nPlease keep this email: the link is private to you.';

/**
 * The merchant's receipt: the same fixed wording as the customer's, for a merchant rank whose address was typed on the public form.
 *
 * Why: decision 064: the public form files a ticket under the login account of the typed address whatever its rank, and the link in
 * the receipt proves the address, so a merchant rank gets the receipt too. Migration 0016 shipped no merchant receipt: the accounts expand
 * migration inserts this row ({@link supportMerchantReceiptSql}).
 */
export const MERCHANT_RECEIPT_TEMPLATE: DefaultTemplate = {
  event: 'support.ticket_received',
  channel: 'email',
  audience: 'merchant',
  subject: 'We got your message ({{ticketNumber}})',
  body: RECEIPT_BODY,
};

/** The customer's receipt row (event `support.ticket_received`, email) as migration 0016 shipped it. */
const isReceipt = (template: TemplateText): boolean =>
  template.event === 'support.ticket_received' && template.channel === 'email' && template.audience === 'customer';

/** A template with the receipt text of decision 053 (only the customer's receipt row changes; its subject stays). */
function withReceiptText<T extends TemplateText>(template: T): T {
  return isReceipt(template) ? { ...template, body: RECEIPT_BODY } : template;
}

/**
 * The templates the support events start with today.
 *
 * Why: a missing template sends nothing (RULES settings 10), so the reply and the receipt come with the migrations. They
 * live here and not in the platform's `DEFAULT_TEMPLATES`: that list is checked against its own migration. The merchant's reply carries
 * the conversation link since feature 28 (migration 0032); the receipt holds no typed text since decision 053.
 */
export const SUPPORT_DEFAULT_TEMPLATES: readonly DefaultTemplate[] = [
  ...SHIPPED_IN_0016.filter((template) => template.channel === 'email')
    .map(withConversationLink)
    .map(withReceiptText),
  MERCHANT_RECEIPT_TEMPLATE,
];

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
 * (as 0032 shipped them) only where the body still equals the default migration 0016 shipped.
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

/**
 * Writes the insert of the merchant's receipt template: the one row the accounts expand migration adds (decision 064).
 *
 * Why: a missing template sends nothing (RULES settings 10), and the receipt of a merchant rank is what confirms its address on the public
 * form. The row is new, so the statement is the plain `INSERT ... ON CONFLICT DO NOTHING` of {@link templatesInsertSql} (a text staff
 * edited later is never overwritten, and a second run changes nothing). The migration holds exactly this statement; a spec keeps them equal.
 *
 * @returns one `INSERT` statement
 */
export function supportMerchantReceiptSql(): string {
  return templatesInsertSql([MERCHANT_RECEIPT_TEMPLATE]);
}

/**
 * Writes the guarded update of the feature-43 migration: the customer's receipt gets the text of decision 053 only where its body still
 * equals the text migration 0016 shipped.
 *
 * Why: decision 053. A template staff edited keeps their words (a `{{customerName}}` or `{{subject}}` left in it is shown as written and the
 * editor refuses to save it again until it is removed). The migration holds exactly this statement; a spec keeps them equal.
 *
 * @returns one `UPDATE` statement
 */
export function supportReceiptTextSql(): string {
  const shipped = SHIPPED_IN_0016.find(isReceipt);
  if (!shipped) throw new Error('The receipt template is missing from the shipped list');
  return (
    `UPDATE "notification_templates" SET "body" = ${quote(RECEIPT_BODY)}\n` +
    `WHERE "event" = ${quote(shipped.event)} AND "channel" = ${quote(shipped.channel)} AND "audience" = ${quote(shipped.audience)} ` +
    `AND "body" = ${quote(shipped.body)};`
  );
}

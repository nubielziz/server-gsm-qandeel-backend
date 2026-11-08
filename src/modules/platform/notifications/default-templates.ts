// The default templates of the merchant events (platform module, feature 12a): English email and Telegram texts. Migration 0009 inserts
// the same rows into a fresh database (a test keeps the two equal); the console edits them afterwards.
import type { NotificationAudience, NotificationChannel } from '../db/schema';

/** One default template, as the migration inserts it. */
export interface DefaultTemplate {
  readonly event: string;
  readonly channel: NotificationChannel;
  readonly audience: NotificationAudience;
  readonly locale: 'en';
  readonly subject: string;
  readonly body: string;
}

const LINK_FOOTER = 'The link works once and stops working at {{expiresAt}}.';

/**
 * The templates every installation starts with.
 *
 * Why: "a registry entry for each, with its default template seeded (English)" (brief 12a). Without them the merchant mails would
 * send nothing (a missing template sends nothing), so they come with the migration, not with the development seed.
 */
export const DEFAULT_TEMPLATES: readonly DefaultTemplate[] = [
  {
    event: 'merchant.email_verification',
    channel: 'email',
    audience: 'merchant',
    locale: 'en',
    subject: 'Confirm your email address',
    body: `Hi {{merchantName}},\n\nPlease confirm your email address to finish creating your GSM account:\n\n{{link}}\n\n${LINK_FOOTER} If you did not create an account, you can ignore this email.`,
  },
  {
    event: 'merchant.password_reset',
    channel: 'email',
    audience: 'merchant',
    locale: 'en',
    subject: 'Reset your password',
    body: `Hi {{merchantName}},\n\nUse this link to choose a new password:\n\n{{link}}\n\n${LINK_FOOTER} If you did not ask for a new password, you can ignore this email: your password stays as it is.`,
  },
  {
    event: 'merchant.invited',
    channel: 'email',
    audience: 'merchant',
    locale: 'en',
    subject: 'Your GSM merchant account is ready',
    body: `Hi {{merchantName}},\n\nOur team created a GSM merchant account for you. Choose your password here to sign in:\n\n{{link}}\n\n${LINK_FOOTER}`,
  },
  {
    event: 'wallet.low_balance',
    channel: 'email',
    audience: 'merchant',
    locale: 'en',
    subject: 'Your wallet balance is low',
    body: 'Hi {{merchantName}},\n\nYour available balance is {{available}} {{currency}}, below your alert level of {{threshold}} {{currency}}. Top up your wallet to keep your orders going.',
  },
  {
    event: 'wallet.low_balance',
    channel: 'telegram',
    audience: 'merchant',
    locale: 'en',
    subject: '',
    body: 'Low balance: {{available}} {{currency}} available (your alert level is {{threshold}} {{currency}}).',
  },
  {
    event: 'service.price_changed',
    channel: 'email',
    audience: 'merchant',
    locale: 'en',
    subject: 'Price changes on services you ordered',
    body: 'Hi {{merchantName}},\n\nThe price of {{count}} service(s) you ordered in the last 30 days changed:\n\n{{changes}}\n\nYour catalog and price list already show the new prices.',
  },
  {
    event: 'service.price_changed',
    channel: 'telegram',
    audience: 'merchant',
    locale: 'en',
    subject: '',
    body: 'Price changes on services you ordered ({{count}}):\n{{changes}}',
  },
  {
    event: 'deposit.approved',
    channel: 'email',
    audience: 'merchant',
    locale: 'en',
    subject: 'Your deposit of {{amount}} {{currency}} was approved',
    body: 'Hi {{merchantName}},\n\nYour deposit of {{amount}} {{currency}} was approved and your wallet is topped up.',
  },
  {
    event: 'deposit.approved',
    channel: 'telegram',
    audience: 'merchant',
    locale: 'en',
    subject: '',
    body: 'Deposit approved: {{amount}} {{currency}} was added to your wallet.',
  },
  {
    event: 'invoice.paid',
    channel: 'email',
    audience: 'merchant',
    locale: 'en',
    subject: 'Invoice {{invoiceNumber}} is paid',
    body: 'Hi {{merchantName}},\n\nInvoice {{invoiceNumber}} ({{amount}} {{currency}}) was paid and the amount is in your wallet.',
  },
  {
    event: 'invoice.paid',
    channel: 'telegram',
    audience: 'merchant',
    locale: 'en',
    subject: '',
    body: 'Invoice {{invoiceNumber}} is paid: {{amount}} {{currency}} was added to your wallet.',
  },
  {
    event: 'order.completed',
    channel: 'email',
    audience: 'merchant',
    locale: 'en',
    subject: 'Order {{orderId}} is complete',
    body: 'Hi {{merchantName}},\n\nOrder {{orderId}} ({{service}}) is complete. {{resultComment}}\n\nThe result is in your panel.',
  },
  {
    event: 'order.completed',
    channel: 'telegram',
    audience: 'merchant',
    locale: 'en',
    subject: '',
    body: 'Order {{orderId}} is complete. The result is in your panel.',
  },
  {
    event: 'order.failed',
    channel: 'email',
    audience: 'merchant',
    locale: 'en',
    subject: 'Order {{orderId}} was rejected',
    body: 'Hi {{merchantName}},\n\nOrder {{orderId}} ({{service}}) was rejected. {{resultComment}}\n\nThe amount went back to your wallet.',
  },
  {
    event: 'order.failed',
    channel: 'telegram',
    audience: 'merchant',
    locale: 'en',
    subject: '',
    body: 'Order {{orderId}} was rejected. {{resultComment}}',
  },
  {
    event: 'telegram.linked',
    channel: 'telegram',
    audience: 'merchant',
    locale: 'en',
    subject: '',
    body: 'Linked to {{merchantName}}.',
  },
  {
    event: 'telegram.unlinked',
    channel: 'telegram',
    audience: 'merchant',
    locale: 'en',
    subject: '',
    body: 'Telegram notifications for {{merchantName}} are off. Create a new link in the portal to connect this chat again.',
  },
];

/**
 * Writes the default templates as the SQL the migration holds.
 *
 * Why: the migration is plain SQL, so the text is written once here and pasted; a test runs the migration's data section and
 * compares it with this list, so the two cannot drift.
 *
 * @returns one `INSERT ... ON CONFLICT DO NOTHING` statement for every template
 */
export function defaultTemplatesSql(): string {
  const quote = (text: string) => `'${text.replace(/'/g, "''")}'`;
  const rows = DEFAULT_TEMPLATES.map(
    (t) =>
      `  (${quote(t.event)}, ${quote(t.channel)}, ${quote(t.audience)}, ${quote(t.locale)}, ${quote(t.subject)}, ${quote(t.body)}, true)`,
  );
  return [
    'INSERT INTO "notification_templates" ("event", "channel", "audience", "locale", "subject", "body", "is_active") VALUES',
    `${rows.join(',\n')}`,
    'ON CONFLICT ("event", "channel", "audience", "locale") DO NOTHING;',
  ].join('\n');
}

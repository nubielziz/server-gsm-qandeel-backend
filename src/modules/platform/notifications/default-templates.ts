// The default templates of the merchant events, the customer account mails, the alert messages and the storefront order, payment and
// refund mails (platform module, features 12a, 14b, 12b and 16): English email and Telegram texts. Migrations 0011 (merchant), 0012
// (customer mails), 0015 (alerts) and 0017 (storefront mails) insert the same rows into a fresh database (a test keeps code and
// migrations equal); the console edits them afterwards.
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
 * Why: "a registry entry for each, with its default template seeded (English)" (brief 12a). Without them the merchant mails, the
 * customer account mails (feature 14b) and the storefront mails feature 16 sends (order received, completed and failed, payment failed, refund
 * declined) would send nothing (a missing template sends nothing), so they come with the migrations, not with the development seed. The
 * storefront texts are the demo's (`TEXTS` of the console's Customer emails tab) without "Your receipt is attached": no mail carries a file.
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
  {
    event: 'alert.fired',
    channel: 'email',
    audience: 'staff',
    locale: 'en',
    subject: 'Alert ({{severity}}): {{ruleName}} - {{subject}}',
    body: '{{ruleName}} fired on {{subject}} (severity: {{severity}}).\n\n{{metric}} is {{value}} (limit {{threshold}}).\n{{detail}}\n\nOpen System health, Alerts and incidents, in the admin console to acknowledge it.',
  },
  {
    event: 'alert.fired',
    channel: 'telegram',
    audience: 'staff',
    locale: 'en',
    subject: '',
    body: 'ALERT {{severity}}: {{ruleName}} on {{subject}}. {{metric}} is {{value}} (limit {{threshold}}). {{detail}}',
  },
  {
    event: 'alert.resolved',
    channel: 'email',
    audience: 'staff',
    locale: 'en',
    subject: 'Resolved: {{ruleName}} - {{subject}}',
    body: '{{ruleName}} on {{subject}} is resolved (severity was {{severity}}).\n\n{{metric}} is {{value}} (limit {{threshold}}).\n{{detail}}',
  },
  {
    event: 'alert.resolved',
    channel: 'telegram',
    audience: 'staff',
    locale: 'en',
    subject: '',
    body: 'RESOLVED: {{ruleName}} on {{subject}}. {{metric}} is {{value}} (limit {{threshold}}). {{detail}}',
  },
  {
    event: 'customer.magic_link',
    channel: 'email',
    audience: 'customer',
    locale: 'en',
    subject: 'Your sign-in link',
    body: `Hi {{customerName}},\n\nUse this link to sign in to your GSM account:\n\n{{link}}\n\n${LINK_FOOTER} If you did not ask for it, you can ignore this email.`,
  },
  {
    event: 'customer.password_reset',
    channel: 'email',
    audience: 'customer',
    locale: 'en',
    subject: 'Reset your password',
    body: `Hi {{customerName}},\n\nUse this link to choose a new password:\n\n{{link}}\n\n${LINK_FOOTER} If you did not ask for a new password, you can ignore this email: your password stays as it is.`,
  },
  {
    event: 'customer.invited',
    channel: 'email',
    audience: 'customer',
    locale: 'en',
    subject: 'Your GSM account is ready',
    body: `Hi {{customerName}},\n\nOur team created a GSM account for you. Choose your password here to sign in:\n\n{{link}}\n\n${LINK_FOOTER}`,
  },
  {
    event: 'customer.email_verification',
    channel: 'email',
    audience: 'customer',
    locale: 'en',
    subject: 'Confirm your email address',
    body: `Hi {{customerName}},\n\nThe email address of your GSM account was changed to this one. Confirm it here:\n\n{{link}}\n\n${LINK_FOOTER} If this is not your account, you can ignore this email.`,
  },
  {
    event: 'order.received',
    channel: 'email',
    audience: 'customer',
    locale: 'en',
    subject: 'Your order {{orderId}} is confirmed',
    body: 'Hi {{customerName}}, thanks for your order. We received {{amount}} for "{{service}}". We will email you the result as soon as the carrier confirms it, usually within a few hours.',
  },
  {
    event: 'order.completed',
    channel: 'email',
    audience: 'customer',
    locale: 'en',
    subject: 'Your unlock is ready',
    body: 'Hi {{customerName}}, good news: the carrier confirmed the unlock for {{orderId}}. Insert a SIM from another network and restart the phone. If anything is unclear, just reply to this email.',
  },
  {
    event: 'order.failed',
    channel: 'email',
    audience: 'customer',
    locale: 'en',
    subject: 'We couldn’t unlock order {{orderId}}',
    body: 'Hi {{customerName}}, the carrier rejected this unlock, so we have refunded {{amount}} to your card. It can take 5 to 10 days to appear. We are sorry it did not work out.',
  },
  {
    event: 'payment.failed',
    channel: 'email',
    audience: 'customer',
    locale: 'en',
    subject: 'Your payment didn’t go through',
    body: 'Hi {{customerName}}, the payment of {{amount}} for your unlock was declined by your bank, so we did not start it. Nothing was charged. You can try again or use another card.',
  },
  {
    event: 'refund.declined',
    channel: 'email',
    audience: 'customer',
    locale: 'en',
    subject: 'About your refund request for order {{orderId}}',
    body: 'Hi {{customerName}},\n\nWe looked at your refund request of {{amount}} for order {{orderId}} and we could not approve it.\n\nReason: {{reason}}\n\nIf you have more details that could change this, reply to this email and we will look again.',
  },
];

/**
 * Writes default templates as the SQL a migration holds.
 *
 * Why: the migrations are plain SQL, so the text is written once here and pasted; a test compares the data section of each
 * migration with this function's output for the templates that migration holds, so code and migrations cannot drift.
 *
 * @param templates the templates one migration inserts (default: all of them)
 * @returns one `INSERT ... ON CONFLICT DO NOTHING` statement for them
 */
export function defaultTemplatesSql(templates: readonly DefaultTemplate[] = DEFAULT_TEMPLATES): string {
  const quote = (text: string) => `'${text.replace(/'/g, "''")}'`;
  const rows = templates.map(
    (t) =>
      `  (${quote(t.event)}, ${quote(t.channel)}, ${quote(t.audience)}, ${quote(t.locale)}, ${quote(t.subject)}, ${quote(t.body)}, true)`,
  );
  return [
    'INSERT INTO "notification_templates" ("event", "channel", "audience", "locale", "subject", "body", "is_active") VALUES',
    `${rows.join(',\n')}`,
    'ON CONFLICT ("event", "channel", "audience", "locale") DO NOTHING;',
  ].join('\n');
}

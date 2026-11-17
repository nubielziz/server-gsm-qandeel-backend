// The notification events of the customer wallet (feature 21): what a storefront customer is told about their store balance, with English
// default templates. Migration `CUSTOMER_WALLET_RULES_MIGRATION` inserted them (with Arabic twins that migration 0035 deletes); a spec finds
// every row of this file in it.
import { type NotificationEventDefinition, templatesInsertSql } from '../../platform';

/**
 * The file name (without `.sql`) of the custom migration of feature 21: the "below zero ⇒ frozen" trigger and the wallet templates.
 *
 * Why: lead rule L3: the lead renumbers migrations at merge, so every spec reads the name from this one constant.
 */
export const CUSTOMER_WALLET_RULES_MIGRATION = '0023_customer_wallet_rules';

/** A top-up was credited to the store balance. */
export const WALLET_TOPUP_CREDITED_EVENT = 'wallet.topup_credited';
/** Staff rejected a top-up. */
export const WALLET_TOPUP_REJECTED_EVENT = 'wallet.topup_rejected';
/** Staff added to or deducted from the store balance. */
export const WALLET_ADJUSTED_EVENT = 'wallet.adjusted';
/** The store balance was put on hold (staff or a top-up dispute). */
export const WALLET_FROZEN_EVENT = 'wallet.frozen';
/** An order paid from the store balance was refunded to it. */
export const WALLET_ORDER_REFUNDED_EVENT = 'wallet.order_refunded';

const SAMPLE = {
  customerName: 'Daniel',
  amount: '50.00 USD',
  balance: '62.49 USD',
  reference: 'PAY-1042',
  reason: 'The transfer did not reach our account.',
  change: '+10.00 USD',
  orderId: '48102',
  service: 'Vodafone UK iPhone Unlock',
} as const;

const customerEvent = (
  spec: Pick<NotificationEventDefinition, 'key' | 'label' | 'description' | 'variables'>,
): NotificationEventDefinition => ({
  ...spec,
  audience: 'customer',
  channels: ['email'],
  sample: Object.fromEntries(spec.variables.map((name) => [name, SAMPLE[name as keyof typeof SAMPLE] ?? ''])),
  transactional: true,
  defaultEmail: true,
  defaultTelegram: false,
});

/**
 * The events this feature registers.
 *
 * Why: plan 21 § 5.8: a customer is told when money reaches, leaves or is held on their store balance; these are about their own money,
 * so they are transactional (always sent, never a preference).
 */
export const CUSTOMER_WALLET_EVENTS: readonly NotificationEventDefinition[] = [
  customerEvent({
    key: WALLET_TOPUP_CREDITED_EVENT,
    label: 'Balance topped up',
    description: 'A customer top-up was credited to the store balance.',
    variables: ['customerName', 'amount', 'balance', 'reference'],
  }),
  customerEvent({
    key: WALLET_TOPUP_REJECTED_EVENT,
    label: 'Top-up rejected',
    description: 'Staff rejected a customer top-up; nothing was added to the balance.',
    variables: ['customerName', 'amount', 'reason', 'reference'],
  }),
  customerEvent({
    key: WALLET_ADJUSTED_EVENT,
    label: 'Balance adjusted',
    description: 'Staff added to or deducted from a customer store balance.',
    variables: ['customerName', 'change', 'balance'],
  }),
  customerEvent({
    key: WALLET_FROZEN_EVENT,
    label: 'Balance on hold',
    description: 'Paying from the customer store balance was put on hold.',
    variables: ['customerName'],
  }),
  customerEvent({
    key: WALLET_ORDER_REFUNDED_EVENT,
    label: 'Refund to balance',
    description: 'An order paid from the store balance was refunded to it.',
    variables: ['customerName', 'orderId', 'amount', 'service'],
  }),
];

/** One default template of a wallet event (an email to the customer). */
export interface CustomerWalletTemplate {
  readonly event: string;
  readonly channel: 'email';
  readonly audience: 'customer';
  readonly subject: string;
  readonly body: string;
}

const template = (event: string, subject: string, body: string): CustomerWalletTemplate => ({
  event,
  channel: 'email',
  audience: 'customer',
  subject,
  body,
});

/**
 * The five default templates (one English email per event), with the plan's exact texts.
 *
 * Why: a missing template sends nothing (RULES settings 10), so the wallet mails come with the migration. English only (decision 039).
 */
export const CUSTOMER_WALLET_TEMPLATES: readonly CustomerWalletTemplate[] = [
  template(
    WALLET_TOPUP_CREDITED_EVENT,
    'Your balance was topped up',
    'Hi {{customerName}},\n\nWe added {{amount}} to your store balance (top-up {{reference}}). Your balance is now {{balance}}.\n\nIf you did not make this top-up, reply to this email.',
  ),
  template(
    WALLET_TOPUP_REJECTED_EVENT,
    'We could not accept your top-up {{reference}}',
    'Hi {{customerName}},\n\nWe could not accept your top-up of {{amount}} ({{reference}}).\n\nReason: {{reason}}\n\nNothing was added to your balance. You can start a new top-up, or reply to this email if you think this is a mistake.',
  ),
  template(
    WALLET_ADJUSTED_EVENT,
    'Your store balance changed',
    'Hi {{customerName}},\n\nOur team changed your store balance by {{change}}. Your balance is now {{balance}}.\n\nIf you did not expect this, reply to this email.',
  ),
  template(
    WALLET_FROZEN_EVENT,
    'Your store balance is on hold',
    'Hi {{customerName}},\n\nPaying from your store balance is on hold while we review a payment on your account. Your orders and your sign-in are not affected.\n\nReply to this email if you need help.',
  ),
  template(
    WALLET_ORDER_REFUNDED_EVENT,
    'We returned {{amount}} to your store balance',
    'Hi {{customerName}},\n\nWe refunded {{amount}} for order {{orderId}} ("{{service}}") to your store balance. You can use it for another order.',
  ),
];

/**
 * Writes the wallet templates as the SQL that installs them (today's shape: no language, one per event, channel and audience).
 *
 * Why: the text is written once here; the applied migration keeps the shape it shipped with (decision 027), so the spec finds every row
 * of this file in it, and the test support runs this SQL.
 *
 * @returns one `INSERT ... ON CONFLICT DO NOTHING` statement for every wallet template
 */
export function customerWalletTemplatesSql(): string {
  return templatesInsertSql(CUSTOMER_WALLET_TEMPLATES);
}

// The notification events of the customer wallet (feature 21): what a storefront customer is told about their store balance, with English and
// Arabic default templates. Migration `CUSTOMER_WALLET_RULES_MIGRATION` inserts the same rows; a spec keeps the two equal (lead rule L2).
import type { NotificationEventDefinition } from '../../platform';

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

/** One default template of a wallet event, in English or Arabic. */
export interface CustomerWalletTemplate {
  readonly event: string;
  readonly channel: 'email';
  readonly audience: 'customer';
  readonly locale: 'en' | 'ar';
  readonly subject: string;
  readonly body: string;
}

const template = (event: string, locale: 'en' | 'ar', subject: string, body: string): CustomerWalletTemplate => ({
  event,
  channel: 'email',
  audience: 'customer',
  locale,
  subject,
  body,
});

/**
 * The ten default templates (five events, English and Arabic), with the plan's exact texts.
 *
 * Why: a missing template sends nothing (RULES settings 10); lead rule L2: customer events ship `en` and `ar` defaults.
 */
export const CUSTOMER_WALLET_TEMPLATES: readonly CustomerWalletTemplate[] = [
  template(
    WALLET_TOPUP_CREDITED_EVENT,
    'en',
    'Your balance was topped up',
    'Hi {{customerName}},\n\nWe added {{amount}} to your store balance (top-up {{reference}}). Your balance is now {{balance}}.\n\nIf you did not make this top-up, reply to this email.',
  ),
  template(
    WALLET_TOPUP_CREDITED_EVENT,
    'ar',
    'تم شحن رصيدك',
    'مرحباً {{customerName}}،\n\nأضفنا {{amount}} إلى رصيدك في المتجر (عملية الشحن {{reference}}). رصيدك الآن {{balance}}.\n\nإذا لم تقم بهذه العملية، ردّ على هذه الرسالة.',
  ),
  template(
    WALLET_TOPUP_REJECTED_EVENT,
    'en',
    'We could not accept your top-up {{reference}}',
    'Hi {{customerName}},\n\nWe could not accept your top-up of {{amount}} ({{reference}}).\n\nReason: {{reason}}\n\nNothing was added to your balance. You can start a new top-up, or reply to this email if you think this is a mistake.',
  ),
  template(
    WALLET_TOPUP_REJECTED_EVENT,
    'ar',
    'تعذّر قبول عملية الشحن {{reference}}',
    'مرحباً {{customerName}}،\n\nتعذّر علينا قبول عملية شحن الرصيد بمبلغ {{amount}} ({{reference}}).\n\nالسبب: {{reason}}\n\nلم يُضَف أي مبلغ إلى رصيدك. يمكنك بدء عملية شحن جديدة، أو الرد على هذه الرسالة إذا كنت ترى أن هناك خطأ.',
  ),
  template(
    WALLET_ADJUSTED_EVENT,
    'en',
    'Your store balance changed',
    'Hi {{customerName}},\n\nOur team changed your store balance by {{change}}. Your balance is now {{balance}}.\n\nIf you did not expect this, reply to this email.',
  ),
  template(
    WALLET_ADJUSTED_EVENT,
    'ar',
    'تغيّر رصيدك في المتجر',
    'مرحباً {{customerName}}،\n\nعدّل فريقنا رصيدك في المتجر بمقدار {{change}}. رصيدك الآن {{balance}}.\n\nإذا لم تكن تتوقع ذلك، ردّ على هذه الرسالة.',
  ),
  template(
    WALLET_FROZEN_EVENT,
    'en',
    'Your store balance is on hold',
    'Hi {{customerName}},\n\nPaying from your store balance is on hold while we review a payment on your account. Your orders and your sign-in are not affected.\n\nReply to this email if you need help.',
  ),
  template(
    WALLET_FROZEN_EVENT,
    'ar',
    'رصيدك في المتجر موقوف مؤقتاً',
    'مرحباً {{customerName}}،\n\nأوقفنا الدفع من رصيدك في المتجر مؤقتاً ريثما نراجع عملية دفع في حسابك. طلباتك وتسجيل دخولك لا يتأثران.\n\nردّ على هذه الرسالة إذا احتجت إلى مساعدة.',
  ),
  template(
    WALLET_ORDER_REFUNDED_EVENT,
    'en',
    'We returned {{amount}} to your store balance',
    'Hi {{customerName}},\n\nWe refunded {{amount}} for order {{orderId}} ("{{service}}") to your store balance. You can use it for another order.',
  ),
  template(
    WALLET_ORDER_REFUNDED_EVENT,
    'ar',
    'أعدنا {{amount}} إلى رصيدك في المتجر',
    'مرحباً {{customerName}}،\n\nأعدنا {{amount}} عن الطلب {{orderId}} («{{service}}») إلى رصيدك في المتجر. يمكنك استخدامه في طلب آخر.',
  ),
];

/**
 * Writes the wallet templates as the SQL the migration holds.
 *
 * Why: the migration is plain SQL, so the text is written once here and pasted; a spec compares the migration's data section with this
 * function (the support module's pattern).
 *
 * @returns one `INSERT ... ON CONFLICT DO NOTHING` statement for every wallet template
 */
export function customerWalletTemplatesSql(): string {
  const quote = (text: string) => `'${text.replace(/'/g, "''")}'`;
  const rows = CUSTOMER_WALLET_TEMPLATES.map(
    (t) =>
      `  (${quote(t.event)}, ${quote(t.channel)}, ${quote(t.audience)}, ${quote(t.locale)}, ${quote(t.subject)}, ${quote(t.body)}, true)`,
  );
  return [
    'INSERT INTO "notification_templates" ("event", "channel", "audience", "locale", "subject", "body", "is_active") VALUES',
    rows.join(',\n'),
    'ON CONFLICT ("event", "channel", "audience", "locale") DO NOTHING;',
  ].join('\n');
}

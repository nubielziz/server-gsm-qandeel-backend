// The registry of notification events (platform module, feature 12a): the only list of events a template, a preference or a
// notification can be about. Built-in events are data here; later features add their own with NotificationEventRegistry.register.
import { Injectable } from '@nestjs/common';
import type { NotificationAudience, NotificationChannel } from '../db/schema';

/**
 * One event a notification can be about, for one audience.
 *
 * Why: RULES settings 10 and B165: templates are created only for registered events (422 on `event`), the placeholders of a
 * template come only from the event's variables, and a merchant's preferences list the merchant events it may turn off. The same
 * key can exist for two audiences (`order.completed` goes to a customer and to a merchant) with its own variables and texts.
 */
export interface NotificationEventDefinition {
  /** The dot-separated lower-case key, as stored in `notifications.event` and `notification_templates.event`. */
  readonly key: string;
  readonly audience: NotificationAudience;
  /** The name shown in a merchant's preferences and in staff's lists. */
  readonly label: string;
  /** What triggers it, for the docs. */
  readonly description: string;
  /** The channels a template for this event may use. */
  readonly channels: readonly NotificationChannel[];
  /** The `{{placeholders}}` a template of this event may use; every one has a sample for the preview. */
  readonly variables: readonly string[];
  /** Sample values of the variables for `POST /admin/notification-templates/:id/preview`. */
  readonly sample: Readonly<Record<string, string>>;
  /**
   * A transactional message is always sent and never listed in a merchant's preferences (the verification, reset and invitation
   * links, the Telegram replies): the recipient cannot work without it.
   */
  readonly transactional: boolean;
  /** Whether a merchant that never saved this event gets it by email (B165: yes, except the opt-in order results). */
  readonly defaultEmail: boolean;
  /** Whether a merchant that never saved this event gets it on Telegram (always off until chosen). */
  readonly defaultTelegram: boolean;
  /** True for an event that is collected and sent once a day (the price change digest, user rule 9). */
  readonly digest?: boolean;
}

/** Sample data of the merchant events: what a made-up merchant would see. */
const MERCHANT_SAMPLE = {
  merchantName: 'Zain Mobile Hub',
  link: 'https://portal.example.com/set-password?token=example',
  expiresAt: '2026-11-01 11:00 UTC',
  currency: 'USD',
  available: '42.5000',
  threshold: '50.0000',
  amount: '250.0000',
  invoiceNumber: 'INV-2026-0042',
  orderId: '48102',
  service: 'Vodafone UK iPhone Unlock',
  resultCode: 'UNLOCKED',
  resultComment: 'The carrier confirmed the unlock.',
  count: '2',
  changes: '- Vodafone UK iPhone Unlock: 12.00 to 12.50 USD\n- O2 UK iPhone Unlock: 9.80 to 10.20 USD',
} as const;

/** Sample data of the customer events: the sample order of the demo's preview (`NOTIF_SAMPLE`), and a sample link for the account mails. */
const CUSTOMER_SAMPLE = {
  customerName: 'Daniel',
  orderId: 'SF-20431',
  amount: '£14.39',
  service: 'Vodafone UK iPhone Unlock',
  device: 'iPhone 13',
  link: 'https://shop.example.com/sign-in?token=example',
  expiresAt: '2026-11-01 11:00 UTC',
} as const;

/** Sample data of the staff events: an alert of a made-up rule, the way the messages word it (feature 12b). */
const STAFF_SAMPLE = {
  ruleName: 'Supplier timeouts',
  severity: 'critical',
  metric: 'supplier.timeout_rate',
  value: '25%',
  threshold: '20%',
  subject: 'Supplier Bosphorus Unlock',
  detail: 'The limit is above 20% over 3 min.',
} as const;

/** Picks the samples of the listed variables; a variable with no sample is a programming error that the unit test catches. */
function samplesOf(
  source: Readonly<Record<string, string>>,
  variables: readonly string[],
): Readonly<Record<string, string>> {
  return Object.fromEntries(variables.map((name) => [name, source[name] ?? '']));
}

function merchantEvent(
  spec: Omit<NotificationEventDefinition, 'audience' | 'sample' | 'defaultTelegram' | 'defaultEmail'> &
    Partial<Pick<NotificationEventDefinition, 'defaultEmail'>>,
): NotificationEventDefinition {
  return {
    ...spec,
    audience: 'merchant',
    sample: samplesOf(MERCHANT_SAMPLE, spec.variables),
    defaultEmail: spec.defaultEmail ?? true,
    defaultTelegram: false,
  };
}

/**
 * A staff event: always sent (it carries no preference), to the ops recipients named by the configuration, not to a staff member's row.
 *
 * Why: feature 12b, RULES health 6: the messages of alerts go to the ops mailbox and chat (`ALERTS_EMAIL_TO`, `ALERTS_TELEGRAM_CHAT_ID`).
 */
function staffEvent(
  spec: Omit<NotificationEventDefinition, 'audience' | 'sample' | 'defaultTelegram' | 'defaultEmail' | 'transactional'>,
): NotificationEventDefinition {
  return {
    ...spec,
    audience: 'staff',
    sample: samplesOf(STAFF_SAMPLE, spec.variables),
    transactional: true,
    defaultEmail: false,
    defaultTelegram: false,
  };
}

function customerEvent(
  spec: Omit<
    NotificationEventDefinition,
    'audience' | 'sample' | 'defaultTelegram' | 'defaultEmail' | 'transactional'
  > &
    Partial<Pick<NotificationEventDefinition, 'transactional'>>,
): NotificationEventDefinition {
  return {
    ...spec,
    audience: 'customer',
    sample: samplesOf(CUSTOMER_SAMPLE, spec.variables),
    transactional: spec.transactional ?? false,
    defaultEmail: true,
    defaultTelegram: false,
  };
}

/** The outbox event types of the three merchant mails (feature 2b); the processors live in the identity module. */
export const MERCHANT_MAIL_EVENT_KEYS = [
  'merchant.email_verification',
  'merchant.password_reset',
  'merchant.invited',
] as const;

/** The outbox event types of the four customer account mails (feature 14b); the processors live in the customers module. */
export const CUSTOMER_MAIL_EVENT_KEYS = [
  'customer.magic_link',
  'customer.password_reset',
  'customer.invited',
  'customer.email_verification',
] as const;

/** The event of the bot's answer when a merchant links a chat. */
export const TELEGRAM_LINKED_EVENT = 'telegram.linked';
/** The event of the bot's answer when a merchant sends `/stop`. */
export const TELEGRAM_UNLINKED_EVENT = 'telegram.unlinked';

/**
 * The events built into the platform: the merchant events 12a wires now, the four transactional customer account mails of
 * feature 14b (sign-in link, password reset, invitation, email verification), the customer events the console's templates list
 * (their producers are the storefront, support and recovery features), and the two staff events of the alerts (feature 12b).
 *
 * Why: "a registry entry for each, with its default template seeded" (brief 12a); the customer events exist so the console's
 * Customer emails tab can be edited before the storefront sends them.
 */
export const BUILT_IN_EVENTS: readonly NotificationEventDefinition[] = [
  merchantEvent({
    key: 'merchant.email_verification',
    label: 'Verify your email address',
    description: 'Sent after a merchant registers: the link that confirms the address.',
    channels: ['email'],
    variables: ['merchantName', 'link', 'expiresAt'],
    transactional: true,
  }),
  merchantEvent({
    key: 'merchant.password_reset',
    label: 'Reset your password',
    description: 'Sent when a merchant asks for a new password: the link that sets it.',
    channels: ['email'],
    variables: ['merchantName', 'link', 'expiresAt'],
    transactional: true,
  }),
  merchantEvent({
    key: 'merchant.invited',
    label: 'Invitation to the portal',
    description: 'Sent when staff create a merchant: the link where the merchant chooses a password.',
    channels: ['email'],
    variables: ['merchantName', 'link', 'expiresAt'],
    transactional: true,
  }),
  merchantEvent({
    key: 'wallet.low_balance',
    label: 'Low wallet balance',
    description: 'The available balance fell below the merchant’s alert threshold (`lowBalanceThreshold`).',
    channels: ['email', 'telegram'],
    variables: ['merchantName', 'currency', 'available', 'threshold'],
    transactional: false,
  }),
  merchantEvent({
    key: 'service.price_changed',
    label: 'Price changes',
    description:
      'A daily digest of the services the merchant ordered in the last 30 days whose price changed (user rule 9): at most one a day.',
    channels: ['email', 'telegram'],
    variables: ['merchantName', 'count', 'changes'],
    transactional: false,
    digest: true,
  }),
  merchantEvent({
    key: 'deposit.approved',
    label: 'Deposit approved',
    description: 'A deposit was approved and the wallet was credited.',
    channels: ['email', 'telegram'],
    variables: ['merchantName', 'amount', 'currency'],
    transactional: false,
  }),
  merchantEvent({
    key: 'invoice.paid',
    label: 'Invoice paid',
    description: 'An invoice was paid and its amount credited to the wallet.',
    channels: ['email', 'telegram'],
    variables: ['merchantName', 'invoiceNumber', 'amount', 'currency'],
    transactional: false,
  }),
  merchantEvent({
    key: 'order.completed',
    label: 'Order completed',
    description: 'One of the merchant’s orders was completed. Off until the merchant chooses it.',
    channels: ['email', 'telegram'],
    variables: ['merchantName', 'orderId', 'service', 'resultCode', 'resultComment'],
    transactional: false,
    defaultEmail: false,
  }),
  merchantEvent({
    key: 'order.failed',
    label: 'Order failed',
    description: 'One of the merchant’s orders was rejected. Off until the merchant chooses it.',
    channels: ['email', 'telegram'],
    variables: ['merchantName', 'orderId', 'service', 'resultCode', 'resultComment'],
    transactional: false,
    defaultEmail: false,
  }),
  merchantEvent({
    key: TELEGRAM_LINKED_EVENT,
    label: 'Telegram linked',
    description: 'The bot’s answer when a merchant connects a Telegram chat.',
    channels: ['telegram'],
    variables: ['merchantName'],
    transactional: true,
  }),
  merchantEvent({
    key: TELEGRAM_UNLINKED_EVENT,
    label: 'Telegram unlinked',
    description: 'The bot’s answer when a merchant sends /stop.',
    channels: ['telegram'],
    variables: ['merchantName'],
    transactional: true,
  }),
  staffEvent({
    key: 'alert.fired',
    label: 'Alert fired',
    description:
      'A rule of the System health page fired: sent once to the ops email and Telegram chat, and again after the reminder interval until a staff member acknowledges it.',
    channels: ['email', 'telegram'],
    variables: ['ruleName', 'severity', 'metric', 'value', 'threshold', 'subject', 'detail'],
  }),
  staffEvent({
    key: 'alert.resolved',
    label: 'Alert resolved',
    description:
      'An alert closed: its value stayed in range, or its rule was switched off or deleted. Sent once to the ops email and Telegram chat.',
    channels: ['email', 'telegram'],
    variables: ['ruleName', 'severity', 'metric', 'value', 'threshold', 'subject', 'detail'],
  }),
  customerEvent({
    key: 'order.received',
    label: 'Order received',
    description: 'A storefront order was paid and accepted.',
    channels: ['email'],
    variables: ['customerName', 'orderId', 'amount', 'service', 'device'],
  }),
  customerEvent({
    key: 'order.completed',
    label: 'Order completed',
    description: 'A storefront order was completed.',
    channels: ['email'],
    variables: ['customerName', 'orderId', 'service', 'device'],
  }),
  customerEvent({
    key: 'order.failed',
    label: 'Order failed',
    description: 'A storefront order could not be completed and was refunded.',
    channels: ['email'],
    variables: ['customerName', 'orderId', 'amount', 'service', 'device'],
  }),
  // Feature 17 widened the variables: a reply email carries the reply, the ticket and the link to the ticket page (12a had only the name).
  {
    ...customerEvent({
      key: 'support.reply',
      label: 'Support reply',
      description: 'Support answered a ticket.',
      channels: ['email'],
      variables: ['customerName', 'ticketNumber', 'subject', 'message', 'link'],
    }),
    sample: {
      customerName: 'Daniel',
      ticketNumber: 'T-1042',
      subject: 'Where is my unlock?',
      message:
        'Hi Daniel, your order is with the carrier and should finish within the hour. I will update you when it moves.',
      link: 'https://shop.example.com/support/tickets/example',
    },
  },
  customerEvent({
    key: 'checkout.abandoned',
    label: 'Abandoned checkout',
    description: 'A checkout was started and not paid.',
    channels: ['email'],
    variables: ['customerName', 'device'],
  }),
  customerEvent({
    key: 'payment.failed',
    label: 'Payment failed',
    description: 'The customer’s payment was declined.',
    channels: ['email'],
    variables: ['customerName', 'amount'],
  }),
  customerEvent({
    key: 'customer.magic_link',
    label: 'Sign-in link',
    description: 'Sent when a storefront customer asks for a sign-in link: the link that signs them in.',
    channels: ['email'],
    variables: ['customerName', 'link', 'expiresAt'],
    transactional: true,
  }),
  customerEvent({
    key: 'customer.password_reset',
    label: 'Reset your password',
    description: 'Sent when a customer asks for a new password, or staff send a reset link: the link that sets it.',
    channels: ['email'],
    variables: ['customerName', 'link', 'expiresAt'],
    transactional: true,
  }),
  customerEvent({
    key: 'customer.invited',
    label: 'Invitation to the account',
    description:
      'Sent when staff create a storefront account in link mode: the link where the customer chooses a password.',
    channels: ['email'],
    variables: ['customerName', 'link', 'expiresAt'],
    transactional: true,
  }),
  customerEvent({
    key: 'customer.email_verification',
    label: 'Verify your email address',
    description:
      'Sent to the new address after staff change the email of an account: the link that confirms it and signs in.',
    channels: ['email'],
    variables: ['customerName', 'link', 'expiresAt'],
    transactional: true,
  }),
];

const KEY_PATTERN = /^[a-z]+(\.[a-z_]+)+$/;

/**
 * Tells whether a text looks like an event key: lower-case words separated by dots, such as `order.completed`.
 *
 * Why: the shape of the key is checked before the registry is asked, so a typo reads "use the event key" and an unknown but
 * well-formed key reads "unknown event".
 *
 * @param text any text
 * @returns true for a well-formed key
 */
export function isEventKey(text: string): boolean {
  return KEY_PATTERN.test(text);
}

/**
 * The registry of notification events.
 *
 * Why: see {@link NotificationEventDefinition}. The API validates template writes and preferences against it and the worker
 * reads the variables of an event from it; both load the same class, so both see the same list. A feature that adds events
 * of its own calls `register` in `onModuleInit`.
 */
@Injectable()
export class NotificationEventRegistry {
  private readonly events = new Map<string, NotificationEventDefinition>();

  constructor() {
    for (const definition of BUILT_IN_EVENTS) this.register(definition);
  }

  /**
   * Adds an event.
   *
   * @param definition the event and its variables
   * @throws {Error} when the key and audience exist already, a variable has no sample, or no channel is given (boot-time mistakes)
   */
  register(definition: NotificationEventDefinition): void {
    const id = `${definition.audience}:${definition.key}`;
    if (this.events.has(id))
      throw new Error(`The notification event "${definition.key}" is already registered for ${definition.audience}.`);
    if (!isEventKey(definition.key))
      throw new Error(`"${definition.key}" is not an event key (lower-case words and dots).`);
    if (definition.channels.length === 0) throw new Error(`The event "${definition.key}" needs at least one channel.`);
    for (const name of definition.variables) {
      if (definition.sample[name] === undefined)
        throw new Error(`The variable "${name}" of "${definition.key}" has no sample.`);
    }
    this.events.set(id, definition);
  }

  /**
   * Finds an event of one audience.
   *
   * @param key the event key
   * @param audience who receives it
   * @returns the definition, or `undefined` when that audience has no such event
   */
  get(key: string, audience: NotificationAudience): NotificationEventDefinition | undefined {
    return this.events.get(`${audience}:${key}`);
  }

  /**
   * Tells whether any audience has an event with this key.
   *
   * @param key the event key
   * @returns true when at least one audience has it
   */
  has(key: string): boolean {
    return this.list().some((definition) => definition.key === key);
  }

  /**
   * Lists every event.
   *
   * @returns the definitions in registration order
   */
  list(): readonly NotificationEventDefinition[] {
    return [...this.events.values()];
  }

  /**
   * Lists the merchant events a merchant may switch on or off: the audience is `merchant` and the event is not transactional.
   *
   * Why: B165: the portal's preferences list exactly these; the transactional mails are always sent.
   *
   * @returns the definitions in registration order
   */
  merchantPreferenceEvents(): readonly NotificationEventDefinition[] {
    return this.list().filter((definition) => definition.audience === 'merchant' && !definition.transactional);
  }
}

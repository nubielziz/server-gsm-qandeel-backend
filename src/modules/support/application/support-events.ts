// The notification events of the support module (feature 17): what a customer is told about a ticket (received, answered, please rate)
// and what a merchant gets when staff answer their ticket. Registered with the platform's registry at boot, in the API and the worker.
import type { NotificationEventDefinition } from '../../platform';

/** Support answered a ticket: the customer's email (built into the platform's registry) and the merchant's email or Telegram message. */
export const SUPPORT_REPLY_EVENT = 'support.reply';
/** A ticket was opened: the customer's receipt (map step 3 of scenario b2c-ticket). */
export const SUPPORT_TICKET_RECEIVED_EVENT = 'support.ticket_received';
/** A ticket was resolved: the customer's satisfaction survey (map steps 7 and 8). */
export const SUPPORT_CSAT_SURVEY_EVENT = 'support.csat_survey';

const CUSTOMER_SAMPLE = {
  customerName: 'Daniel',
  ticketNumber: 'T-1042',
  subject: 'Where is my unlock?',
  link: 'https://shop.example.com/support/tickets/example',
} as const;

const customerEvent = (
  spec: Pick<NotificationEventDefinition, 'key' | 'label' | 'description' | 'variables'>,
): NotificationEventDefinition => ({
  ...spec,
  audience: 'customer',
  channels: ['email'],
  sample: Object.fromEntries(
    spec.variables.map((name) => [name, CUSTOMER_SAMPLE[name as keyof typeof CUSTOMER_SAMPLE] ?? '']),
  ),
  transactional: false,
  defaultEmail: true,
  defaultTelegram: false,
});

/**
 * The events this module registers.
 *
 * Why: the brief of feature 17: the receipt of a ticket, the survey after a resolve and the reply to a merchant's ticket are events with
 * default templates. The customer's `support.reply` is not here: 12a registered it for the console's Customer emails tab and this
 * feature widened its variables in the platform's list (`BUILT_IN_EVENTS`), because a reply email must carry the reply and the link.
 * A merchant's `support.reply` is transactional (the answer to their own ticket is always sent, never a preference).
 */
export const SUPPORT_EVENTS: readonly NotificationEventDefinition[] = [
  customerEvent({
    key: SUPPORT_TICKET_RECEIVED_EVENT,
    label: 'Ticket received',
    description: 'A customer opened a support ticket: the receipt with the link to follow it.',
    variables: ['customerName', 'ticketNumber', 'subject', 'link'],
  }),
  customerEvent({
    key: SUPPORT_CSAT_SURVEY_EVENT,
    label: 'Satisfaction survey',
    description: 'Staff resolved a ticket: the link where the customer rates the help they got.',
    variables: ['customerName', 'ticketNumber', 'subject', 'link'],
  }),
  {
    key: SUPPORT_REPLY_EVENT,
    audience: 'merchant',
    label: 'Support reply',
    description: 'Staff answered a merchant’s support ticket.',
    channels: ['email', 'telegram'],
    variables: ['merchantName', 'ticketNumber', 'subject', 'message'],
    sample: {
      merchantName: 'Zain Mobile Hub',
      ticketNumber: 'T-1043',
      subject: 'Invoice question',
      message: 'Hi, the invoice was issued in USD. I attached the statement to your portal.',
    },
    transactional: true,
    defaultEmail: true,
    defaultTelegram: false,
  },
];

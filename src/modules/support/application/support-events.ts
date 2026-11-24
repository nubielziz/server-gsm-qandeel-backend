// The notification events of the support module (feature 17): what a requester is told about a ticket (received, answered). The text follows
// the rank kind of the requester (decision 064): a retail rank gets the customer texts, a merchant rank the merchant texts. Registered with
// the platform's registry at boot, in the API and the worker.
import type { NotificationEventDefinition } from '../../platform';

/** Support answered a ticket: the customer's email (built into the platform's registry) and the merchant's email. */
export const SUPPORT_REPLY_EVENT = 'support.reply';
/** A ticket was opened on the public form or from an order link: the receipt (map step 3 of scenario b2c-ticket), in a customer and a merchant text. */
export const SUPPORT_TICKET_RECEIVED_EVENT = 'support.ticket_received';

const CUSTOMER_SAMPLE = {
  customerName: 'Daniel',
  ticketNumber: 'T-1042',
  subject: 'Where is my unlock?',
  link: 'https://shop.example.com/support/tickets/example',
} as const;

const customerEvent = (
  spec: Pick<NotificationEventDefinition, 'key' | 'label' | 'description' | 'variables'> &
    Partial<Pick<NotificationEventDefinition, 'transactional' | 'secretLink'>>,
): NotificationEventDefinition => ({
  ...spec,
  audience: 'customer',
  channels: ['email'],
  sample: Object.fromEntries(
    spec.variables.map((name) => [name, CUSTOMER_SAMPLE[name as keyof typeof CUSTOMER_SAMPLE] ?? '']),
  ),
  transactional: spec.transactional ?? false,
  defaultEmail: true,
});

/**
 * The events this module registers.
 *
 * Why: the brief of feature 17: the receipt of a ticket and the reply to a merchant's ticket are events with default templates. The
 * customer's `support.reply` is not here: 12a registered it for the console's Customer emails tab and this feature widened its variables in
 * the platform's list (`BUILT_IN_EVENTS`), because a reply email must carry the reply and the link. A merchant's `support.reply` is transactional (the answer to their own ticket is always sent, never a preference); since feature 28 it
 * carries `link`, the conversation in the merchant portal.
 *
 * Decision 064: the receipt has a merchant text too. The public form files a ticket under the login account of the typed address whatever
 * its rank, and the link in the receipt is what proves the address, so a merchant rank gets it as well; the audience of a mail to an
 * account is its rank kind. Same fixed wording, same two variables.
 */
export const SUPPORT_EVENTS: readonly NotificationEventDefinition[] = [
  customerEvent({
    key: SUPPORT_TICKET_RECEIVED_EVENT,
    label: 'Ticket received',
    description:
      'A customer opened a support ticket: the receipt with the ticket number and the link to follow it. It repeats nothing the customer typed (decision 053).',
    variables: ['ticketNumber', 'link'],
    // Feature 23, S6: the receipt holds the only link to the ticket, so a suspended or blocked customer still gets it.
    transactional: true,
    // Decision 047: the link is the ticket's capability token, a credential: its template keeps the link rules.
    secretLink: true,
  }),
  {
    key: SUPPORT_REPLY_EVENT,
    audience: 'merchant',
    label: 'Support reply',
    description: 'Staff answered a merchant’s support ticket.',
    channels: ['email'],
    // `link` (feature 28): the ticket page of the account area, `<STORE_BASE_URL>/account/support/<id>` (decision 064).
    variables: ['merchantName', 'ticketNumber', 'subject', 'message', 'link'],
    sample: {
      merchantName: 'Zain Mobile Hub',
      ticketNumber: 'T-1043',
      subject: 'Invoice question',
      message: 'Hi, the invoice was issued in USD. I attached the statement to your portal.',
      link: 'https://shop.example.com/account/support/1043',
    },
    transactional: true,
    defaultEmail: true,
  },
  {
    key: SUPPORT_TICKET_RECEIVED_EVENT,
    audience: 'merchant',
    label: 'Ticket received',
    description:
      'Someone wrote on the contact form with the address of a merchant account: the receipt with the ticket number and the link that confirms the address. It repeats nothing that was typed (decision 053).',
    channels: ['email'],
    variables: ['ticketNumber', 'link'],
    sample: { ticketNumber: 'T-1043', link: 'https://shop.example.com/support/tickets/example' },
    // The receipt holds the only link to the ticket, so a suspended or blocked account still gets it (like the customer's).
    transactional: true,
    defaultEmail: true,
    // Decision 047: the link is the ticket's capability token, a credential: its template keeps the link rules.
    secretLink: true,
  },
];

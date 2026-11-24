// The in-app texts the platform ships (feature 23, plan section 9.2): the storefront order and payment mails, a merchant's low balance and
// paid invoice, and a campaign's test. English only (decision 039). Links are site paths without the language prefix (checked against
// the storefront's routes).
import type { InboxTextDefinition } from './inbox-texts';

/**
 * The built-in in-app texts.
 *
 * Why: S9: in-app items for the customer's order, payment and refund mails and for a merchant's low balance and paid invoice; not
 * for merchant order results (thousands a day on the API) nor for mails that carry a secret link.
 */
export const BUILT_IN_INBOX_TEXTS: readonly InboxTextDefinition[] = [
  {
    audience: 'customer',
    event: 'order.received',
    category: 'order',
    link: '/account/orders',
    text: { title: 'Order {{orderId}} received', body: 'We received your order for {{service}} and started on it.' },
  },
  {
    audience: 'customer',
    event: 'order.completed',
    category: 'order',
    link: '/account/orders',
    text: { title: 'Order {{orderId}} completed', body: 'Your order for {{service}} is complete.' },
  },
  {
    audience: 'customer',
    event: 'order.failed',
    category: 'order',
    link: '/account/orders',
    text: {
      title: 'Order {{orderId}} could not be completed',
      body: 'We could not complete your order for {{service}}. {{amount}} was refunded.',
    },
  },
  {
    audience: 'customer',
    event: 'payment.failed',
    category: 'payment',
    link: '/account/orders',
    text: { title: 'Payment declined', body: 'Your payment of {{amount}} was declined. Please try again.' },
  },
  {
    audience: 'customer',
    event: 'refund.declined',
    category: 'payment',
    link: '/account/orders',
    text: { title: 'Refund declined for order {{orderId}}', body: '{{reason}}' },
  },
  {
    audience: 'merchant',
    event: 'wallet.low_balance',
    category: 'wallet',
    link: '/account/wallet',
    text: {
      title: 'Low wallet balance',
      body: 'Your available balance is {{available}} {{currency}}, below your alert of {{threshold}} {{currency}}.',
    },
  },
  {
    audience: 'merchant',
    event: 'invoice.paid',
    category: 'billing',
    link: '/account/invoices',
    text: {
      title: 'Invoice {{invoiceNumber}} paid',
      body: '{{amount}} {{currency}} was credited to your wallet.',
    },
  },
  {
    audience: 'staff',
    event: 'broadcast.test',
    category: 'announcement',
    text: { title: '[Test] {{title}}', body: '{{body}}' },
  },
];

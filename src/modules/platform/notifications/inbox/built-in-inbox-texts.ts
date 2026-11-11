// The in-app texts the platform ships (feature 23, plan section 9.2): the storefront order and payment mails, a merchant's low balance and
// paid invoice, and a campaign's test. Links are site paths without the language prefix (checked against the storefront's routes).
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
    texts: {
      en: { title: 'Order {{orderId}} received', body: 'We received your order for {{service}} and started on it.' },
      ar: { title: 'تم استلام طلبك {{orderId}}', body: 'استلمنا طلبك لخدمة {{service}} وبدأنا العمل عليه.' },
    },
  },
  {
    audience: 'customer',
    event: 'order.completed',
    category: 'order',
    link: '/account/orders',
    texts: {
      en: { title: 'Order {{orderId}} completed', body: 'Your order for {{service}} is complete.' },
      ar: { title: 'تم تنفيذ طلبك {{orderId}}', body: 'تم تنفيذ طلبك لخدمة {{service}} بنجاح.' },
    },
  },
  {
    audience: 'customer',
    event: 'order.failed',
    category: 'order',
    link: '/account/orders',
    texts: {
      en: {
        title: 'Order {{orderId}} could not be completed',
        body: 'We could not complete your order for {{service}}. {{amount}} was refunded.',
      },
      ar: {
        title: 'تعذّر تنفيذ طلبك {{orderId}}',
        body: 'لم نتمكن من تنفيذ طلبك لخدمة {{service}}. تمت إعادة المبلغ {{amount}}.',
      },
    },
  },
  {
    audience: 'customer',
    event: 'payment.failed',
    category: 'payment',
    link: '/account/orders',
    texts: {
      en: { title: 'Payment declined', body: 'Your payment of {{amount}} was declined. Please try again.' },
      ar: { title: 'تم رفض الدفع', body: 'تم رفض دفعتك بقيمة {{amount}}. يُرجى المحاولة مرة أخرى.' },
    },
  },
  {
    audience: 'customer',
    event: 'refund.declined',
    category: 'payment',
    link: '/account/orders',
    texts: {
      en: { title: 'Refund declined for order {{orderId}}', body: '{{reason}}' },
      ar: { title: 'تم رفض الاسترداد للطلب {{orderId}}', body: '{{reason}}' },
    },
  },
  {
    audience: 'merchant',
    event: 'wallet.low_balance',
    category: 'wallet',
    link: '/merchant/wallet',
    texts: {
      en: {
        title: 'Low wallet balance',
        body: 'Your available balance is {{available}} {{currency}}, below your alert of {{threshold}} {{currency}}.',
      },
      ar: {
        title: 'رصيد المحفظة منخفض',
        body: 'رصيدك المتاح {{available}} {{currency}}، وهو أقل من حد التنبيه {{threshold}} {{currency}}.',
      },
    },
  },
  {
    audience: 'merchant',
    event: 'invoice.paid',
    category: 'billing',
    link: '/merchant/invoices',
    texts: {
      en: {
        title: 'Invoice {{invoiceNumber}} paid',
        body: '{{amount}} {{currency}} was credited to your wallet.',
      },
      ar: { title: 'تم دفع الفاتورة {{invoiceNumber}}', body: 'تمت إضافة {{amount}} {{currency}} إلى محفظتك.' },
    },
  },
  {
    audience: 'staff',
    event: 'broadcast.test',
    category: 'announcement',
    texts: {
      en: { title: '[Test] {{title}}', body: '{{body}}' },
      ar: { title: '[تجربة] {{title}}', body: '{{body}}' },
    },
  },
];

// Feature 28 (support as a live chat, slice B2): the account surfaces beyond the map (decisions 035 and 037, plan
// docs/briefs/28-support-live-chat.md § 3.2 routes 6-14 and § 5): a signed-in customer's own tickets and a merchant's whole ticket
// conversation by id. The chat engine's own routes (the ticket link's stream, typing, read mark and files; the console's) are 28.mjs.
import { R } from '../lib/map-additions.mjs';

const ACCOUNTS = 'B217';
const THREAD = ['support_tickets', 'ticket_messages'];
const WITH_ORDERS = [...THREAD, 'orders'];
const WITH_FILES = [...THREAD, 'files'];

export const rows = [
  R('store', 'support', 'GET', '/store/v1/me/tickets', 'تذاكري', 'جلسة الزبون', 28, THREAD, {
    en: "The signed-in customer's own tickets, with the link token of each.",
    module: 'support',
    spec: ACCOUNTS,
    successStatus: 200,
  }),
  R('store', 'support', 'POST', '/store/v1/me/tickets', 'فتح تذكرة من الحساب', 'جلسة الزبون', 28, WITH_ORDERS, {
    en: 'Open a ticket when signed in (no anti-bot check; the answer carries the ticket link token).',
    module: 'support',
    spec: ACCOUNTS,
    successStatus: 201,
  }),
  R('client', 'growth', 'GET', '/client/tickets', 'تذاكر التاجر', 'جلسة', 28, THREAD, {
    en: "The merchant's own tickets.",
    module: 'support',
    spec: ACCOUNTS,
    successStatus: 200,
  }),
  R('client', 'growth', 'POST', '/client/tickets', 'فتح تذكرة جديدة من بوابة التاجر', 'جلسة', 28, WITH_ORDERS, {
    en: 'Open a ticket from the merchant portal.',
    module: 'support',
    spec: ACCOUNTS,
    successStatus: 201,
  }),
  R('client', 'growth', 'GET', '/client/tickets/:id', 'محادثة تذكرة التاجر', 'جلسة', 28, THREAD, {
    en: 'One of the merchant’s tickets with its conversation.',
    module: 'support',
    spec: ACCOUNTS,
    successStatus: 200,
  }),
  R('client', 'growth', 'POST', '/client/tickets/:id/messages', 'رد التاجر على التذكرة', 'جلسة', 28, THREAD, {
    en: 'Write on one of the merchant’s tickets.',
    module: 'support',
    spec: ACCOUNTS,
    successStatus: 201,
  }),
  R('client', 'growth', 'POST', '/client/tickets/:id/read', 'تعليم رسائل الدعم كمقروءة للتاجر', 'جلسة', 28, THREAD, {
    en: "Mark support's messages of one of the merchant’s tickets as seen.",
    module: 'support',
    spec: ACCOUNTS,
    successStatus: 204,
  }),
  R('client', 'growth', 'POST', '/client/tickets/:id/typing', 'التاجر يكتب الآن', 'جلسة', 28, THREAD, {
    en: 'The merchant is typing on one of its tickets.',
    module: 'support',
    spec: ACCOUNTS,
    successStatus: 204,
  }),
  R('client', 'growth', 'GET', '/client/tickets/:id/files/:fileId', 'تنزيل مرفق تذكرة التاجر', 'جلسة', 28, WITH_FILES, {
    en: 'Download an attachment of one of the merchant’s tickets (presigned link).',
    module: 'support',
    spec: ACCOUNTS,
    successStatus: 302,
  }),
];

// Feature 28 (support as a live chat, slice B1): the routes beyond the map (decisions 035 and 037, plan
// docs/briefs/28-support-live-chat.md § 3.2 and § 5): the ticket link's live stream, read mark and attachments, and the console's
// read mark and attachments. The account routes (signed-in customer, merchant) are 28b.mjs.
import { R } from '../lib/map-additions.mjs';

const CHAT = 'B218';
const THREAD = ['support_tickets', 'ticket_messages'];
const FILES = ['support_tickets', 'ticket_messages', 'files'];

export const rows = [
  R(
    'store',
    'support',
    'GET',
    '/store/v1/tickets/:token/stream',
    'بثّ مباشر لأحداث التذكرة',
    'رمز التذكرة',
    28,
    THREAD,
    {
      en: "The ticket's live events (server-sent events).",
      module: 'support',
      spec: CHAT,
      successStatus: 200,
    },
  ),
  R(
    'store',
    'support',
    'POST',
    '/store/v1/tickets/:token/read',
    'تعليم رسائل الدعم كمقروءة',
    'رمز التذكرة',
    28,
    THREAD,
    {
      en: "Mark support's messages as seen.",
      module: 'support',
      spec: CHAT,
      successStatus: 204,
    },
  ),
  R('store', 'support', 'POST', '/store/v1/tickets/:token/files', 'إرفاق ملف بالتذكرة', 'رمز التذكرة', 28, FILES, {
    en: 'Upload an attachment for the ticket.',
    module: 'support',
    spec: CHAT,
    successStatus: 201,
  }),
  R('store', 'support', 'GET', '/store/v1/tickets/:token/files/:fileId', 'تنزيل مرفق', 'رمز التذكرة', 28, FILES, {
    en: 'Download an attachment of the ticket (presigned link).',
    module: 'support',
    spec: CHAT,
    successStatus: 302,
  }),
  R(
    'admin',
    'support',
    'POST',
    '/admin/support-tickets/:id/read',
    'تعليم رسائل التذكرة كمقروءة',
    'support:read',
    28,
    THREAD,
    {
      en: "Mark the requester's messages as seen.",
      module: 'support',
      spec: CHAT,
      successStatus: 204,
    },
  ),
  R(
    'admin',
    'support',
    'POST',
    '/admin/support-tickets/:id/files',
    'إرفاق ملف برد أو ملاحظة',
    'support:reply',
    28,
    [...FILES, 'audit_logs'],
    {
      en: 'Upload an attachment for a reply or a note.',
      module: 'support',
      spec: CHAT,
      successStatus: 201,
    },
  ),
  R(
    'admin',
    'support',
    'GET',
    '/admin/support-tickets/:id/files/:fileId',
    'تنزيل مرفق التذكرة',
    'support:read',
    28,
    FILES,
    {
      en: 'Download an attachment of the ticket (presigned link).',
      module: 'support',
      spec: CHAT,
      successStatus: 302,
    },
  ),
];

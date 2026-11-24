// Route contracts of the support chat (feature 28, routes beyond the map: scripts/map-additions/28.mjs; plan
// docs/briefs/28-support-live-chat.md § 3.2): the ticket link's live stream, read mark, attachment upload and download, and the
// console's read mark, upload and download. The events are documented in docs/contract/realtime-events.md.
import { z } from 'zod';
import { defineRoute, zId, zIdParam, zIsoDateTime, zUploadedFile } from '../../../common/contract';

const TOKEN_PARAMS = z.object({ token: z.string().min(16).max(128).describe('The ticket token.') });
const TOKEN_FILE_PARAMS = TOKEN_PARAMS.extend({ fileId: zIdParam.describe('The attachment.') });
const ID_PARAMS = z.object({ id: zIdParam });
const ID_FILE_PARAMS = ID_PARAMS.extend({ fileId: zIdParam.describe('The attachment.') });

/** A stored attachment as the two upload routes answer it (the shape of the platform's upload routes). */
export const UploadedAttachmentSchema = z.object({
  id: zId.describe('What `fileIds` of the next message takes.'),
  filename: z.string().describe('The base name of the file, without control characters, at most 200 characters.'),
  size: z.number().int().min(1).describe('Bytes, at most 5 MiB.'),
  mime: z.string().describe('`application/pdf`, `image/jpeg` or `image/png`.'),
  sha256: z.string().describe('Hex SHA-256 of the content.'),
  createdAt: zIsoDateTime,
});

const UPLOAD_EXAMPLE = {
  id: 7002,
  filename: 'screen.jpg',
  size: 182044,
  mime: 'image/jpeg',
  sha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
  createdAt: '2026-11-08T10:58:00.000Z',
} as const;

const ReadBody = z.object({
  upToMessageId: zId.describe('The newest message of the other side the page shows.'),
});

const UPLOAD_RULES =
  'One file (`multipart/form-data`, one part named `file`): a PDF, JPEG or PNG of 1 byte to 5 MiB whose content starts with the ' +
  "type's magic bytes. Another type, or a content that is not what it claims, is `422` on `file` (`type`); an empty file `422` " +
  '(`empty`); more than 5 MiB `413`: a body over 5 MiB is refused before it is parsed, whether or not it declares its length. The answer is the stored file; its id ' +
  'goes into `fileIds` of the next message. There is no virus scan: files are never shown inline, only downloaded through a link.';

const DOWNLOAD_RULES =
  'Redirects (`302`) to a presigned object-storage link that expires after 5 minutes (`Content-Disposition: attachment` with the ' +
  'stored file name, `Cache-Control: no-store`). Open it in a new tab; never show the file inline.';

/** `GET /store/v1/tickets/:token/stream`. */
export const storeTicketStream = defineRoute({
  key: 'GET /store/v1/tickets/:token/stream',
  summary: 'Live events of a support ticket',
  description:
    'A server-sent event stream (`text/event-stream`) of the ticket the token opens: `ready` first, `hb` every 15 seconds, then ' +
    '`ticket.message.created` (a new public message, with `id: t<message id>`), `ticket.updated` and `ticket.read`, in the requester ' +
    'view (docs/contract/realtime-events.md); never an internal note or a staff name. ' +
    'The ticket is matched by `number` (`ticketId` is null). A reconnect sends the last event id back (`Last-Event-ID`, or ' +
    '`cursor`) and gets the messages it missed, at most 100, else `resync`. No cookie is involved: the token in the path is the ' +
    'credential, as for the other ticket routes. At most 3 streams per ticket and 30 per address (`429`), 20 opens a minute per ' +
    'ticket; ended after 15 minutes (`bye max_age`) and at once when the link stops working (`bye session_ended`, an anonymized ' +
    'customer: the token then answers `404`). `503 UNAVAILABLE` when live updates are switched off: the page keeps refreshing every ' +
    '30 seconds. Lookups count against the token limit (30 a minute per address).',
  tags: ['support-tickets'],
  surface: 'store',
  access: 'ticket-token',
  params: TOKEN_PARAMS,
  query: z.object({
    cursor: z
      .string()
      .max(64)
      .optional()
      .describe('The last event id the page saw (`t5521`), for a new stream that should replay what it missed.'),
  }),
  headers: z.object({
    'last-event-id': z
      .string()
      .max(64)
      .optional()
      .describe('Sent by the browser on its own reconnect; it wins over `cursor`.'),
  }),
  success: { status: 200, contentType: 'text/event-stream' },
  errors: ['NOT_FOUND', 'VALIDATION_FAILED', 'RATE_LIMITED', 'UNAVAILABLE'],
});

/** `POST /store/v1/tickets/:token/read`. */
export const storeTicketRead = defineRoute({
  key: 'POST /store/v1/tickets/:token/read',
  summary: 'Mark support’s messages as seen',
  description:
    'Moves the customer’s seen mark to `upToMessageId`, a support message of this ticket (send it when the page is visible and shows ' +
    'it). The mark only moves forward: an older or the same id is a `204` that changes nothing. Support then sees `Seen` under its ' +
    'reply, and an unseen email reply is not mailed. Any other id (a message of another ticket, the customer’s own, one that does not ' +
    'exist) is `422` on `upToMessageId` (`unknown_message`). Counted against `ticket-chat` (120 a minute per address).',
  tags: ['support-tickets'],
  surface: 'store',
  access: 'ticket-token',
  params: TOKEN_PARAMS,
  body: ReadBody,
  success: { status: 204 },
  errors: ['NOT_FOUND', 'VALIDATION_FAILED', 'RATE_LIMITED'],
  examples: { request: { upToMessageId: 9001 } },
});

/** `POST /store/v1/tickets/:token/files`. */
export const uploadStoreTicketFile = defineRoute({
  key: 'POST /store/v1/tickets/:token/files',
  summary: 'Upload an attachment for a support ticket',
  description:
    `${UPLOAD_RULES} The file belongs to the ticket's customer. A resolved ticket is closed for the customer: \`409 TICKET_RESOLVED\` ` +
    'and nothing is stored (staff reopen the ticket first). Counted against `upload` (20 a minute per address). A ticket link can upload ' +
    '20 files (50 MiB) in 24 hours, and its customer 30 (100 MiB) (`422` on `file`, `quota`; decision 053).',
  tags: ['support-tickets'],
  surface: 'store',
  access: 'ticket-token',
  params: TOKEN_PARAMS,
  bodyType: 'multipart',
  body: z.object({ file: zUploadedFile }),
  success: { status: 201, schema: UploadedAttachmentSchema },
  errors: ['NOT_FOUND', 'TICKET_RESOLVED', 'VALIDATION_FAILED', 'PAYLOAD_TOO_LARGE', 'RATE_LIMITED', 'UNAVAILABLE'],
  examples: { response: UPLOAD_EXAMPLE },
});

/** `GET /store/v1/tickets/:token/files/:fileId`. */
export const openStoreTicketFile = defineRoute({
  key: 'GET /store/v1/tickets/:token/files/:fileId',
  summary: 'Download an attachment of a support ticket',
  description:
    `${DOWNLOAD_RULES} The file must be an attachment of a message of this ticket the customer can see: a file of an internal ` +
    'note, of another ticket, or in no message is `404`, like an unknown id.',
  tags: ['support-tickets'],
  surface: 'store',
  access: 'ticket-token',
  params: TOKEN_FILE_PARAMS,
  success: { status: 302 },
  errors: ['NOT_FOUND', 'VALIDATION_FAILED', 'UNAVAILABLE'],
});

/** `POST /admin/support-tickets/:id/read`. */
export const markSupportTicketRead = defineRoute({
  key: 'POST /admin/support-tickets/:id/read',
  summary: 'Mark the requester’s messages as seen',
  description:
    'Moves the staff side’s seen mark to `upToMessageId`, a message the requester wrote on this ticket (send it when the thread is ' +
    'visible and the window has focus). Staff are one party: the requester sees `Seen`, never who. The mark only moves forward: an ' +
    'older or the same id is a `204` that changes nothing. Another id (a note, a staff reply, a message of another ticket) is `422` on ' +
    '`upToMessageId` (`unknown_message`). Writes no audit row: it is the staff side’s own read mark, not an admin change (the reason ' +
    'of `audit: false`).',
  tags: ['support-tickets'],
  surface: 'admin',
  access: 'staff-permission',
  permission: 'support:read',
  audit: false,
  params: ID_PARAMS,
  body: ReadBody,
  success: { status: 204 },
  errors: ['UNAUTHORIZED', 'FORBIDDEN', 'CSRF_FAILED', 'NOT_FOUND', 'VALIDATION_FAILED'],
  examples: { request: { upToMessageId: 9002 } },
});

/** `POST /admin/support-tickets/:id/files`. */
export const uploadSupportTicketFile = defineRoute({
  key: 'POST /admin/support-tickets/:id/files',
  summary: 'Upload an attachment for a reply or a note',
  description: `${UPLOAD_RULES} The file belongs to the staff member. Audited as \`attached file to ticket\`. A multipart body is read only with a live staff session.`,
  tags: ['support-tickets'],
  surface: 'admin',
  access: 'staff-permission',
  permission: 'support:reply',
  params: ID_PARAMS,
  bodyType: 'multipart',
  body: z.object({ file: zUploadedFile }),
  success: { status: 201, schema: UploadedAttachmentSchema },
  errors: [
    'UNAUTHORIZED',
    'FORBIDDEN',
    'CSRF_FAILED',
    'NOT_FOUND',
    'VALIDATION_FAILED',
    'PAYLOAD_TOO_LARGE',
    'RATE_LIMITED',
    'UNAVAILABLE',
  ],
  examples: { response: { ...UPLOAD_EXAMPLE, filename: 'statement.pdf', mime: 'application/pdf' } },
});

/** `GET /admin/support-tickets/:id/files/:fileId`. */
export const openSupportTicketFile = defineRoute({
  key: 'GET /admin/support-tickets/:id/files/:fileId',
  summary: 'Download an attachment of a ticket',
  description:
    `${DOWNLOAD_RULES} Any attachment of a message of this ticket, internal notes included; anything else is \`404\`. A file that is also an identity document or a payment receipt writes the same audit row as \`GET /admin/files/:id\` (decision 047); the permission stays \`support:read\`. A requester's ` +
    'file is not virus-scanned (the console says so).',
  tags: ['support-tickets'],
  surface: 'admin',
  access: 'staff-permission',
  permission: 'support:read',
  params: ID_FILE_PARAMS,
  success: { status: 302 },
  errors: ['UNAUTHORIZED', 'FORBIDDEN', 'NOT_FOUND', 'VALIDATION_FAILED', 'UNAVAILABLE'],
});

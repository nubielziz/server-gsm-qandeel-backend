// Schemas the support contracts share (feature 17): the words of a ticket, a message as staff read it and the limits of the texts; the
// attachments, the file ids a message carries and the bodies that may be files only (feature 28).
import { z } from 'zod';
import { zId, zIsoDateTime } from '../../../common/contract';
import {
  TICKET_AUTHOR_TYPES,
  TICKET_CATEGORIES,
  TICKET_CHANNELS,
  TICKET_PRIORITIES,
  TICKET_REQUESTER_TYPES,
} from '../db/schema';
import { WIRE_TICKET_STATUSES } from '../domain/ticket-status';

/** The longest text of a reply, a note, a customer message or a template: a Telegram message holds 4096 characters. */
export const MAX_MESSAGE_LENGTH = 4000;

/**
 * A message text: trimmed, not empty, at most {@link MAX_MESSAGE_LENGTH} characters.
 *
 * @param empty the message under the field when the text is empty (the console's own wording)
 * @returns the zod schema of the text
 */
export function messageText(empty: string): z.ZodString {
  return z.string().trim().min(1, empty).max(MAX_MESSAGE_LENGTH, `Use at most ${MAX_MESSAGE_LENGTH} characters.`);
}

/** The ticket category words (the demo's `TICKET_CATS`); reply templates use them too. */
export const TicketCategorySchema = z.enum(TICKET_CATEGORIES, 'Choose a category.');

/** The status words the console and the storefront know (`pending_customer` is `pending`; there is no `closed`). */
export const WireStatusSchema = z.enum(WIRE_TICKET_STATUSES);

/** Priority, which sets the reply target: 2 hours for high, 8 for normal, 24 for low. */
export const TicketPrioritySchema = z.enum(TICKET_PRIORITIES, 'Choose high, normal or low.');

/**
 * The text of a key a feature added to an existing answer: the server always sends it, and the schema keeps it optional until the
 * console reads it (feature 28, as feature 25 did). The lead makes these keys required after the merges.
 */
export const ALWAYS_SENT = 'Always sent; optional in the schema until the console merge.';

/** One file of a message: a PDF, JPEG or PNG, downloaded only through its presigned link (feature 28). */
export const AttachmentSchema = z.object({
  id: zId,
  filename: z.string().describe('The stored base name: the download is saved under it. Never shown inline.'),
  mime: z.string().describe('`application/pdf`, `image/jpeg` or `image/png`.'),
  size: z.number().int().min(1).describe('Bytes, at most 5 MiB.'),
});

/** The attachments of a message, in the order they were attached. */
export const AttachmentsSchema = z
  .array(AttachmentSchema)
  .optional()
  .describe(`The files of the message, oldest first; empty when it has none. ${ALWAYS_SENT}`);

/**
 * The files a new message carries: ids of uploads of the sender (at most 5).
 *
 * Why: feature 28, rule 8: a file is uploaded first (the ticket page and the console have their upload routes, a merchant the portal's
 * `POST /client/files`) and attached by id; the ownership, type and size are checked when the message is written.
 */
export const FileIdsSchema = z
  .array(zId)
  .max(5, 'Attach at most 5 files.')
  .optional()
  .describe(
    "Files to attach, uploaded by the sender: each must be the sender's own PDF, JPEG or PNG of at most 5 MiB (`422` on `fileIds` " +
      'with `unknown_file`, `not_yours`, `type` or `too_large`).',
  );

/** The text of a message that may be files only: trimmed, at most {@link MAX_MESSAGE_LENGTH} characters, `''` allowed. */
export const MessageBodyText = z
  .string()
  .trim()
  .max(MAX_MESSAGE_LENGTH, `Use at most ${MAX_MESSAGE_LENGTH} characters.`);

/**
 * The check of a body that may be files only: `body` may be `''` only when `fileIds` has an entry.
 *
 * Why: feature 28 (plan § 3.2): a message may be files only; an empty text without files keeps the route's own message, with the code an
 * empty text always had (`too_small`).
 *
 * @param empty the message under `body` when there is neither a text nor a file
 * @returns the refinement to pass to `superRefine`
 */
export function textOrFiles(
  empty: string,
): (value: { readonly body: string; readonly fileIds?: readonly number[] | undefined }, ctx: z.RefinementCtx) => void {
  return (value, ctx) => {
    if (value.body === '' && (value.fileIds ?? []).length === 0) {
      ctx.addIssue({
        code: 'too_small',
        origin: 'string',
        minimum: 1,
        inclusive: true,
        path: ['body'],
        message: empty,
      });
    }
  };
}

/**
 * A message body that may be files only: `{ body, fileIds? }`.
 *
 * @param empty the message under `body` when there is neither a text nor a file
 * @returns the zod schema of the body
 */
export function messageBody(empty: string) {
  return z.object({ body: MessageBodyText, fileIds: FileIdsSchema }).superRefine(textOrFiles(empty));
}

/** One message of a thread as staff read it. */
export const TicketMessageSchema = z.object({
  id: zId,
  ticketId: zId,
  authorType: z.enum(TICKET_AUTHOR_TYPES),
  authorId: zId.nullable().describe('The customer, merchant or staff member; null for the system.'),
  authorName: z.string().describe("Joined: 'System' for the system, 'Deleted customer' after an anonymize."),
  body: z.string(),
  isInternal: z.boolean().describe('A note the customer never sees (and the system messages).'),
  fileIds: z.array(zId),
  attachments: AttachmentsSchema,
  createdAt: zIsoDateTime,
});

/** The channels of a ticket. */
export const TicketChannelSchema = z.enum(TICKET_CHANNELS);

/** Who wrote a ticket. */
export const RequesterTypeSchema = z.enum(TICKET_REQUESTER_TYPES);

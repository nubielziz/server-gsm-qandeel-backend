// Schemas the support contracts share (feature 17): the words of a ticket, a message as staff read it and the limits of the texts.
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
  createdAt: zIsoDateTime,
});

/** The channels of a ticket. */
export const TicketChannelSchema = z.enum(TICKET_CHANNELS);

/** Who wrote a ticket. */
export const RequesterTypeSchema = z.enum(TICKET_REQUESTER_TYPES);

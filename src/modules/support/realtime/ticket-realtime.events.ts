// The live events of the support chat (feature 28, plan § 3.4; docs/contract/realtime-events.md): the zod schemas of their data, one for
// the staff view and one for the requester view of each event. The source parses every frame before it is written; the requester views
// are strict objects, so a key the requester must not see (a staff name, the assignee, the priority) can never pass.
import { z } from 'zod';
import { zId, zIsoDateTime } from '../../../common/contract';
import { StoreMessageSchema } from '../contracts/store-tickets.contracts';
import { AttachmentSchema, TicketMessageSchema, WireStatusSchema } from '../contracts/shared';
import { TicketRowSchema } from '../contracts/tickets.contracts';

/** A message was written; the only ticket event with an `id` (`t<message id>`), so a reconnect replays it. */
export const TICKET_MESSAGE_CREATED_EVENT = 'ticket.message.created';
/** The ticket changed (status, assignee, priority, a new message, a new ticket). */
export const TICKET_UPDATED_EVENT = 'ticket.updated';
/** A side's seen mark moved. */
export const TICKET_READ_EVENT = 'ticket.read';

const zLive = z.boolean().describe('False for a message replayed after a reconnect (no sound, no alert).');

/**
 * The staff view of `ticket.message.created`: the message as the thread shows it, notes and system messages included.
 *
 * Why: the console appends it to the open thread and alerts for a requester message (rule 5).
 */
export const zStaffMessageCreated = z.object({
  ticketId: zId,
  message: TicketMessageSchema,
  live: zLive,
});

/** The staff view of `ticket.updated`: the inbox row as `GET /admin/support-tickets` lists it. */
export const zStaffTicketUpdated = z.object({ ticket: TicketRowSchema });

/** The staff view of `ticket.read`: which side marked, up to which message, when. */
export const zStaffTicketRead = z.object({
  ticketId: zId,
  by: z.enum(['requester', 'staff']),
  upToMessageId: zId,
  at: zIsoDateTime,
});

/**
 * The ticket a requester event is about: the id for a ticket opened in the portal (it has no link token and the portal addresses tickets by
 * id), `null` for a ticket that has a link token (the page is the token's; a token is never put in an event), and the number the page matches.
 */
const requesterTicket = {
  ticketId: zId.nullable(),
  number: z.string(),
};

/** A message as the requester reads it, strictly: nothing beyond `id`, `from`, `body`, `createdAt` and `attachments`. */
const zRequesterMessage = StoreMessageSchema.extend({ attachments: z.array(AttachmentSchema.strict()) }).strict();

/**
 * The requester view of `ticket.message.created`: a public message only (never an internal note or a system message).
 *
 * Why: the security core of the chat (plan § 3.4): the requester's streams get the storefront's view of a message and nothing else.
 */
export const zRequesterMessageCreated = z.strictObject({
  ...requesterTicket,
  message: zRequesterMessage,
  live: zLive,
});

/** The requester view of `ticket.updated`: what the ticket page shows, with no staff name, assignee, priority or timer. */
export const zRequesterTicketUpdated = z.strictObject({
  ...requesterTicket,
  status: WireStatusSchema,
  updatedAt: zIsoDateTime,
  resolvedAt: zIsoDateTime.nullable(),
  hasUnread: z.boolean(),
});

/** The requester view of `ticket.read`: `you` marked (another tab) or `support` saw the requester's messages; never who. */
export const zRequesterTicketRead = z.strictObject({
  ...requesterTicket,
  by: z.enum(['you', 'support']),
  upToMessageId: zId,
  at: zIsoDateTime,
});

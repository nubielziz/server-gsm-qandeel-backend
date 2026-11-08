// Turns stored tickets and messages into what the routes answer (feature 17): the inbox row, the detail with its thread, and the
// storefront's smaller view. Pure mapping: the one place the status codec and the `late` rule are applied to a row.
import type { z } from 'zod';
import type { TicketDetailSchema, TicketRowSchema } from '../contracts/tickets.contracts';
import type { StoreMessageSchema, StoreTicketSchema } from '../contracts/store-tickets.contracts';
import type { TicketMessageSchema } from '../contracts/shared';
import type { SupportTicket } from '../db/schema';
import type { ReplyChannel } from '../domain/reply-channels';
import { isLate } from '../domain/ticket-sla';
import { toWireStatus } from '../domain/ticket-status';
import type { MessageRow, TicketRow } from '../infra/ticket.repository';

/** A ticket as the inbox lists it. */
export type TicketRowView = z.infer<typeof TicketRowSchema>;
/** A ticket with its thread and reply channels. */
export type TicketDetailView = z.infer<typeof TicketDetailSchema>;
/** A message as staff read it. */
export type TicketMessageView = z.infer<typeof TicketMessageSchema>;
/** A ticket as the customer reads it. */
export type StoreTicketView = z.infer<typeof StoreTicketSchema>;
/** A message as the customer reads it. */
export type StoreMessageView = z.infer<typeof StoreMessageSchema>;

const iso = (date: Date | null): string | null => (date === null ? null : date.toISOString());

/**
 * Builds the inbox row of a ticket.
 *
 * @param row the ticket with its joined names
 * @param lastPublicAt the time of its latest public message
 * @param now the injected clock's time, for `late`
 * @returns the row as the console reads it
 */
export function toTicketView(row: TicketRow, lastPublicAt: Date | undefined, now: Date): TicketRowView {
  const { ticket } = row;
  return {
    id: ticket.id,
    number: ticket.number,
    subject: ticket.subject,
    channel: ticket.channel,
    requesterType: ticket.requesterType,
    requesterId: ticket.requesterId,
    requester: { name: row.requesterName, email: row.requesterEmail },
    orderId: ticket.orderId,
    category: ticket.category,
    priority: ticket.priority,
    status: toWireStatus(ticket.status),
    assigneeId: ticket.assigneeId,
    assignee: ticket.assigneeId === null ? null : { id: ticket.assigneeId, name: row.assigneeName ?? 'Staff' },
    slaDueAt: iso(ticket.slaDueAt),
    firstResponseAt: iso(ticket.firstResponseAt),
    resolvedAt: iso(ticket.resolvedAt),
    csatScore: ticket.csatScore,
    createdAt: ticket.createdAt.toISOString(),
    updatedAt: ticket.updatedAt.toISOString(),
    lastPublicAt: iso(lastPublicAt ?? null),
    late: isLate(ticket.slaDueAt, ticket.status, now),
  };
}

/**
 * Builds a message as staff read it.
 *
 * @param row the message with its author's name
 * @returns the message with `authorName` joined
 */
export function toMessageView(row: MessageRow): TicketMessageView {
  const { message } = row;
  return {
    id: message.id,
    ticketId: message.ticketId,
    authorType: message.authorType,
    authorId: message.authorId,
    authorName: row.authorName,
    body: message.body,
    isInternal: message.isInternal,
    fileIds: message.fileIds,
    createdAt: message.createdAt.toISOString(),
  };
}

/**
 * Builds the detail of a ticket.
 *
 * @param row the ticket with its joined names
 * @param lastPublicAt the time of its latest public message
 * @param messages the whole thread, oldest first
 * @param replyChannels the channels a reply may use
 * @param now the injected clock's time
 * @returns the detail as the console reads it
 */
export function toDetailView(
  row: TicketRow,
  lastPublicAt: Date | undefined,
  messages: readonly MessageRow[],
  replyChannels: readonly ReplyChannel[],
  now: Date,
): TicketDetailView {
  return {
    ...toTicketView(row, lastPublicAt, now),
    messages: messages.map(toMessageView),
    replyChannels: [...replyChannels],
  };
}

/**
 * Builds a message as the customer reads it.
 *
 * @param row the message
 * @returns the message, `you` for the requester's side and `support` for staff
 */
export function toStoreMessage(
  row: Pick<MessageRow['message'], 'id' | 'authorType' | 'body' | 'createdAt'>,
): StoreMessageView {
  return {
    id: row.id,
    from: row.authorType === 'staff' ? 'support' : 'you',
    body: row.body,
    createdAt: row.createdAt.toISOString(),
  };
}

/**
 * Builds the customer's view of a ticket.
 *
 * Why: the storefront shows the conversation without internal notes and system messages (the caller leaves them out of `messages`), a
 * status in the console's words, and whether the survey can be answered. No staff name, assignee, priority or timer appears.
 *
 * @param ticket the stored ticket
 * @param messages the public messages, oldest first
 * @returns the view
 */
export function toStoreTicket(ticket: SupportTicket, messages: readonly MessageRow[]): StoreTicketView {
  return {
    number: ticket.number,
    subject: ticket.subject,
    category: ticket.category,
    status: toWireStatus(ticket.status),
    orderId: ticket.orderId,
    createdAt: ticket.createdAt.toISOString(),
    updatedAt: ticket.updatedAt.toISOString(),
    resolvedAt: iso(ticket.resolvedAt),
    csatScore: ticket.csatScore,
    canRate: ticket.status === 'resolved' && ticket.csatScore === null,
    messages: messages.map((row) => toStoreMessage(row.message)),
  };
}

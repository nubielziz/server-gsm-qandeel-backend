// Turns stored tickets into what the account routes answer (feature 28, slice B2): the rows of my tickets and of the merchant's tickets
// (with `hasUnread`, never stored) and a merchant's ticket with its conversation. Pure mapping, like ticket-views.ts, whose message view it reuses.
import type { z } from 'zod';
import type { ClientTicketRowSchema, ClientTicketSchema } from '../contracts/client-tickets.contracts';
import type { MyTicketRowSchema } from '../contracts/my-tickets.contracts';
import type { SupportTicket } from '../db/schema';
import { hasUnread } from '../domain/seen';
import { toWireStatus } from '../domain/ticket-status';
import type { AccountTicketRow } from '../infra/account-ticket.repository';
import type { MessageRow } from '../infra/ticket.repository';
import { type AttachmentFiles, toStoreMessage } from './ticket-views';

/** A ticket of the list of a signed-in customer's tickets. */
export type MyTicketRowView = z.infer<typeof MyTicketRowSchema>;
/** A ticket of a merchant's list. */
export type ClientTicketRowView = z.infer<typeof ClientTicketRowSchema>;
/** A merchant's ticket with its conversation. */
export type ClientTicketView = z.infer<typeof ClientTicketSchema>;

const iso = (date: Date | null): string | null => (date === null ? null : date.toISOString());

/** The fields both lists show: the ticket's words and times, the latest public message and the requester's own `hasUnread`. */
function rowFields(row: AccountTicketRow) {
  const { ticket } = row;
  return {
    number: ticket.number,
    subject: ticket.subject,
    category: ticket.category,
    status: toWireStatus(ticket.status),
    orderId: ticket.orderId,
    createdAt: ticket.createdAt.toISOString(),
    updatedAt: ticket.updatedAt.toISOString(),
    lastMessageAt: iso(row.lastMessageAt),
    lastMessageFrom: row.lastMessageFrom,
    // The requester's side of the seen marks: support wrote after the newest support message the requester marked.
    hasUnread: hasUnread(ticket.lastStaffMessageId, ticket.requesterSeenMessageId),
  };
}

/**
 * Builds a row of the signed-in customer's list.
 *
 * Why: rule 6: each row links to the existing token page, so it carries the ticket's link token (the list is the customer's own, behind
 * their session).
 *
 * @param row the ticket with its latest public message
 * @param token the ticket's link token (a customer's ticket that has none is not listed)
 * @returns the row as the storefront reads it
 */
export function toMyTicketRow(row: AccountTicketRow, token: string): MyTicketRowView {
  return { ...rowFields(row), token };
}

/**
 * Builds a row of a merchant's list.
 *
 * Why: rule 7: a merchant's ticket has no link token; the routes take the ticket id, which the row carries instead.
 *
 * @param row the ticket with its latest public message
 * @returns the row as the portal reads it
 */
export function toClientTicketRow(row: AccountTicketRow): ClientTicketRowView {
  return { id: row.ticket.id, ...rowFields(row) };
}

/**
 * Builds a merchant's ticket with its conversation.
 *
 * Why: the portal shows the public thread like the storefront does (no note, no system message, no staff name, assignee, priority or
 * timer), and with the seen marks of both sides.
 *
 * @param ticket the stored ticket
 * @param messages the public messages, oldest first
 * @param files the stored files of the thread, by id
 * @returns the ticket with its conversation
 */
export function toClientTicket(
  ticket: SupportTicket,
  messages: readonly MessageRow[],
  files: AttachmentFiles,
): ClientTicketView {
  return {
    id: ticket.id,
    number: ticket.number,
    subject: ticket.subject,
    category: ticket.category,
    status: toWireStatus(ticket.status),
    orderId: ticket.orderId,
    createdAt: ticket.createdAt.toISOString(),
    updatedAt: ticket.updatedAt.toISOString(),
    resolvedAt: iso(ticket.resolvedAt),
    messages: messages.map((row) => toStoreMessage(row.message, files)),
    seenByYou: ticket.requesterSeenMessageId,
    seenBySupport: ticket.staffSeenMessageId,
    seenBySupportAt: iso(ticket.staffSeenAt),
  };
}

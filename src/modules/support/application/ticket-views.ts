// Turns stored tickets and messages into what the routes answer (feature 17): the inbox row, the detail with its thread, and the
// storefront's smaller view. Pure mapping: the one place the status codec and the `late` rule are applied to a row. Feature 28 adds the
// attachments of a message and the seen marks (with `hasUnread`, never stored).
import type { z } from 'zod';
import { type CustomerContact, customerEmailIn } from '../../../common/customer-contact';
import type { FileMeta } from '../../platform';
import type { TicketDetailSchema, TicketRowSchema } from '../contracts/tickets.contracts';
import type { StoreMessageSchema, StoreTicketSchema } from '../contracts/store-tickets.contracts';
import type { AttachmentSchema, TicketMessageSchema } from '../contracts/shared';
import type { SupportTicket, TicketMessage } from '../db/schema';
import type { ReplyChannel } from '../domain/reply-channels';
import { hasUnread } from '../domain/seen';
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

/** One attachment as every answer and live event shows it. */
export type AttachmentView = z.infer<typeof AttachmentSchema>;

/** The stored files of the messages being rendered, by id (`StoredFiles.metaOf`). */
export type AttachmentFiles = ReadonlyMap<number, Pick<FileMeta, 'id' | 'filename' | 'mime' | 'size'>>;

/** No files: for a message that carries none. */
export const NO_FILES: AttachmentFiles = new Map();

const iso = (date: Date | null): string | null => (date === null ? null : date.toISOString());

/**
 * Builds the attachments of a message, in the order they were attached.
 *
 * Why: feature 28, rule 8: a message shows its files by name and size (never inline); a file that is gone (erased with its customer,
 * past the retention) is left out rather than shown broken.
 *
 * @param fileIds the message's `file_ids`
 * @param files the stored files, by id
 * @returns the attachments that still exist
 */
export function toAttachments(fileIds: readonly number[], files: AttachmentFiles): AttachmentView[] {
  return fileIds.flatMap((id) => {
    const file = files.get(id);
    return file ? [{ id: file.id, filename: file.filename, mime: file.mime, size: file.size }] : [];
  });
}

/**
 * Builds the inbox row of a ticket.
 *
 * @param row the ticket with its joined names
 * @param lastPublicAt the time of its latest public message
 * @param now the injected clock's time, for `late`
 * @param contact what the caller may see of a customer's address (decision 047, rule A: a customer requester's address is masked unless
 *   the caller may read customers; a merchant's address stays in full)
 * @returns the row as the console reads it
 */
export function toTicketView(
  row: TicketRow,
  lastPublicAt: Date | undefined,
  now: Date,
  contact: CustomerContact,
): TicketRowView {
  const { ticket } = row;
  return {
    id: ticket.id,
    number: ticket.number,
    subject: ticket.subject,
    channel: ticket.channel,
    requesterType: ticket.requesterType,
    requesterId: ticket.requesterId,
    requester: {
      name: row.requesterName,
      email:
        ticket.requesterType === 'customer' && row.requesterEmail !== null
          ? customerEmailIn(contact, row.requesterEmail)
          : row.requesterEmail,
    },
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
    // Staff's side of the seen marks (feature 28): the requester wrote after the newest message staff marked.
    hasUnread: hasUnread(ticket.lastRequesterMessageId, ticket.staffSeenMessageId),
    requesterSeenMessageId: ticket.requesterSeenMessageId,
    requesterSeenAt: iso(ticket.requesterSeenAt),
    staffSeenMessageId: ticket.staffSeenMessageId,
    staffSeenAt: iso(ticket.staffSeenAt),
  };
}

/**
 * Builds a message as staff read it.
 *
 * @param row the message with its author's name
 * @param files the stored files of the thread, by id
 * @returns the message with `authorName` and its attachments joined
 */
export function toMessageView(row: MessageRow, files: AttachmentFiles): TicketMessageView {
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
    attachments: toAttachments(message.fileIds, files),
    createdAt: message.createdAt.toISOString(),
  };
}

/**
 * Builds the detail of a ticket.
 *
 * @param row the ticket with its joined names
 * @param lastPublicAt the time of its latest public message
 * @param messages the whole thread, oldest first
 * @param files the stored files of the thread, by id
 * @param replyChannels the channels a reply may use
 * @param now the injected clock's time
 * @param contact what the caller may see of a customer's address (decision 047)
 * @returns the detail as the console reads it
 */
export function toDetailView(
  row: TicketRow,
  lastPublicAt: Date | undefined,
  messages: readonly MessageRow[],
  files: AttachmentFiles,
  replyChannels: readonly ReplyChannel[],
  now: Date,
  contact: CustomerContact,
): TicketDetailView {
  return {
    ...toTicketView(row, lastPublicAt, now, contact),
    messages: messages.map((message) => toMessageView(message, files)),
    replyChannels: [...replyChannels],
  };
}

/**
 * Builds a message as the customer reads it.
 *
 * @param row the message (a public one: the caller never passes a note or a system message)
 * @param files the stored files of the thread, by id
 * @returns the message, `you` for the requester's side and `support` for staff, with its attachments
 */
export function toStoreMessage(
  row: Pick<TicketMessage, 'id' | 'authorType' | 'body' | 'createdAt' | 'fileIds'>,
  files: AttachmentFiles,
): StoreMessageView {
  return {
    id: row.id,
    from: row.authorType === 'staff' ? 'support' : 'you',
    body: row.body,
    createdAt: row.createdAt.toISOString(),
    attachments: toAttachments(row.fileIds, files),
  };
}

/**
 * Builds the customer's view of a ticket.
 *
 * Why: the storefront shows the conversation without internal notes and system messages (the caller leaves them out of `messages`), a
 * status in the console's words, and whether the survey can be answered. No staff name, assignee, priority or timer appears. The seen
 * marks (feature 28) say which support message the requester has seen and which of theirs support has seen, never who.
 *
 * @param ticket the stored ticket
 * @param messages the public messages, oldest first
 * @param files the stored files of the thread, by id
 * @returns the view
 */
export function toStoreTicket(
  ticket: SupportTicket,
  messages: readonly MessageRow[],
  files: AttachmentFiles,
): StoreTicketView {
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
    messages: messages.map((row) => toStoreMessage(row.message, files)),
    seenByYou: ticket.requesterSeenMessageId,
    seenBySupport: ticket.staffSeenMessageId,
    seenBySupportAt: iso(ticket.staffSeenAt),
  };
}

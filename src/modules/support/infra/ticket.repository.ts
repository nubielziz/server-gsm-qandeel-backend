// Drizzle queries on `support_tickets` and `ticket_messages` (feature 17): the inbox list with its filters and sorts, one ticket with its
// requester and assignee, the thread with author names, the writes of the use cases, and the token lookup of the ticket page.
import { and, asc, count, desc, eq, inArray, isNull, max, sql, type SQL } from 'drizzle-orm';
import type { ParsedListQuery, ParsedFilter } from '../../../common/contract';
import { type DbExecutor, listOrderBy, listWhere, type ListColumns } from '../../../infra/db';
import { fromWireStatus, type WireTicketStatus } from '../domain/ticket-status';
import type { LastPublicMessage } from '../domain/ticket-sla';
import {
  type NewSupportTicket,
  type NewTicketMessage,
  type SupportTicket,
  type TicketMessage,
  supportTickets,
  ticketMessages,
} from '../db/schema';
import { DELETED_CUSTOMER_NAME, foreignTables as f } from './support-foreign-reads';

/** The sorts of the inbox: `late` first by default (the console sorts `late,updatedAt` descending). */
export type TicketSortField = 'late' | 'updatedAt' | 'createdAt' | 'id';

/** A ticket with the names the list row joins. */
export interface TicketRow {
  readonly ticket: SupportTicket;
  readonly requesterName: string;
  readonly requesterEmail: string | null;
  readonly assigneeName: string | null;
}

/** A message with the name of its author. */
export interface MessageRow {
  readonly message: TicketMessage;
  readonly authorName: string;
}

/**
 * The name a requester shows: the stored name, else their address, else a plain word.
 *
 * Why: a guest customer made by a ticket or a checkout may have no name, and an empty cell in the inbox helps nobody.
 *
 * @param name the stored name
 * @param email the address (never shown for an anonymized customer)
 * @param fallback the word for somebody with neither
 * @returns the display name
 */
function displayName(name: string | null, email: string | null, fallback: string): string {
  const trimmed = (name ?? '').trim();
  return trimmed !== '' ? trimmed : (email ?? fallback);
}

/** The requester's name and address for a row, whatever the requester's kind (anonymized and missing rows read as deleted). */
function requesterOf(row: {
  type: SupportTicket['requesterType'];
  customerName: string | null;
  customerEmail: string | null;
  customerStatus: string | null;
  clientName: string | null;
  clientEmail: string | null;
}): { name: string; email: string | null } {
  if (row.type === 'client') {
    return { name: displayName(row.clientName, row.clientEmail, 'Merchant'), email: row.clientEmail };
  }
  if (row.customerStatus === null || row.customerStatus === 'anonymized') {
    return { name: DELETED_CUSTOMER_NAME, email: null };
  }
  return { name: displayName(row.customerName, row.customerEmail, 'Customer'), email: row.customerEmail };
}

/** What the list and detail queries select. */
const ticketSelect = {
  ticket: supportTickets,
  customerName: f.customers.name,
  customerEmail: f.customers.email,
  customerStatus: f.customers.status,
  clientName: f.clients.name,
  clientEmail: f.clients.email,
  assigneeName: f.staff.name,
};

function toTicketRow(row: {
  ticket: SupportTicket;
  customerName: string | null;
  customerEmail: string | null;
  customerStatus: string | null;
  clientName: string | null;
  clientEmail: string | null;
  assigneeName: string | null;
}): TicketRow {
  const who = requesterOf({ type: row.ticket.requesterType, ...row });
  return {
    ticket: row.ticket,
    requesterName: who.name,
    requesterEmail: who.email,
    assigneeName: row.assigneeName,
  };
}

/** The join conditions of the requester (a customer or a merchant, by the ticket's type) and of the assignee. */
const onCustomer = and(eq(supportTickets.requesterType, 'customer'), eq(f.customers.id, supportTickets.requesterId));
const onClient = and(eq(supportTickets.requesterType, 'client'), eq(f.clients.id, supportTickets.requesterId));
const onAssignee = eq(f.staff.id, supportTickets.assigneeId);

/** True for a ticket whose reply is awaited and overdue, decided against the clock's `now`. */
function lateSql(now: Date): SQL {
  return sql`(${supportTickets.slaDueAt} is not null and ${supportTickets.slaDueAt} < ${now} and ${supportTickets.status} <> 'resolved')`;
}

/** The requester name as SQL, for `q`. */
const requesterNameSql = sql`case when ${supportTickets.requesterType} = 'customer' then ${f.customers.name} else ${f.clients.name} end`;

/**
 * The requester's email address as SQL, for `q`.
 *
 * Why: a guest who gave no name is shown by email, so the inbox must find them by it. An anonymized customer's address is never shown
 * (`requesterOf`), so it is not searchable either.
 */
const requesterEmailSql = sql`case when ${supportTickets.requesterType} = 'customer' then (case when ${f.customers.status} = 'anonymized' then null else ${f.customers.email} end) else ${f.clients.email} end`;

/**
 * Translates the `status` filter's wire words to the stored ones before the list is built.
 *
 * Why: RESOLUTIONS b2c-2: `status=pending` means `status IN ('pending_customer')`; every other word is stored as it is.
 *
 * @param filters the parsed filters
 * @returns the filters with the status values of the database
 */
function storedStatusFilters(filters: readonly ParsedFilter[]): ParsedFilter[] {
  return filters.map((filter) =>
    filter.field === 'status'
      ? { ...filter, values: filter.values.map((value) => fromWireStatus(String(value) as WireTicketStatus)) }
      : filter,
  );
}

/**
 * Lists tickets for `GET /admin/support-tickets`.
 *
 * Why: the inbox (RULES support): filters status (repeated = IN), late, assigneeId, requesterType, requesterId and `q` over the number,
 * subject, requester name and requester email; `late` is a filter and a sort key, both decided in SQL against the clock's `now` (never `now()`), late
 * tickets first by default.
 *
 * @param db the database or a transaction
 * @param query the parsed list request
 * @param now the injected clock's time
 * @returns the page of rows and the exact total
 */
export async function listTicketRows(
  db: DbExecutor,
  query: ParsedListQuery<TicketSortField>,
  now: Date,
): Promise<{ rows: TicketRow[]; total: number }> {
  const columns: ListColumns = {
    id: supportTickets.id,
    number: supportTickets.number,
    subject: supportTickets.subject,
    status: supportTickets.status,
    assigneeId: supportTickets.assigneeId,
    requesterType: supportTickets.requesterType,
    requesterId: supportTickets.requesterId,
    createdAt: supportTickets.createdAt,
    updatedAt: supportTickets.updatedAt,
    late: lateSql(now),
    'requester.name': requesterNameSql,
    'requester.email': requesterEmailSql,
  };
  const where = listWhere({ filters: storedStatusFilters(query.filters), search: query.search }, columns);
  const [rows, [total]] = await Promise.all([
    db
      .select(ticketSelect)
      .from(supportTickets)
      .leftJoin(f.customers, onCustomer)
      .leftJoin(f.clients, onClient)
      .leftJoin(f.staff, onAssignee)
      .where(where)
      .orderBy(...listOrderBy(query.sort, columns, supportTickets.id))
      .limit(query.range.limit)
      .offset(query.range.start),
    db
      .select({ total: count() })
      .from(supportTickets)
      .leftJoin(f.customers, onCustomer)
      .leftJoin(f.clients, onClient)
      .where(where),
  ]);
  return { rows: rows.map(toTicketRow), total: total?.total ?? 0 };
}

/**
 * Reads one ticket with its requester and assignee.
 *
 * @param db the database or a transaction
 * @param id the ticket id
 * @returns the row, or `undefined`
 */
export async function findTicketRow(db: DbExecutor, id: number): Promise<TicketRow | undefined> {
  const rows = await db
    .select(ticketSelect)
    .from(supportTickets)
    .leftJoin(f.customers, onCustomer)
    .leftJoin(f.clients, onClient)
    .leftJoin(f.staff, onAssignee)
    .where(eq(supportTickets.id, id))
    .limit(1);
  return rows[0] && toTicketRow(rows[0]);
}

/**
 * Reads the time of the latest public message of each ticket.
 *
 * @param db the database or a transaction
 * @param ids the tickets of a page
 * @returns ticket id to the latest non-internal message time; a ticket without one is absent
 */
export async function lastPublicTimes(db: DbExecutor, ids: readonly number[]): Promise<Map<number, Date>> {
  if (ids.length === 0) return new Map();
  const rows = await db
    .select({ ticketId: ticketMessages.ticketId, at: max(ticketMessages.createdAt) })
    .from(ticketMessages)
    .where(and(inArray(ticketMessages.ticketId, [...ids]), eq(ticketMessages.isInternal, false)))
    .groupBy(ticketMessages.ticketId);
  return new Map(rows.flatMap((row) => (row.at === null ? [] : [[row.ticketId, row.at] as const])));
}

/**
 * Reads the latest public message of a ticket: who wrote it and when.
 *
 * Why: the next-reply rule (`slaDueAt` in the domain) reads it after every change to the thread, the priority or the status.
 *
 * @param db the transaction
 * @param ticketId the ticket
 * @returns the message's side and time, or `undefined` for a ticket without a public message
 */
export async function lastPublicMessage(db: DbExecutor, ticketId: number): Promise<LastPublicMessage | undefined> {
  const [row] = await db
    .select({ authorType: ticketMessages.authorType, createdAt: ticketMessages.createdAt })
    .from(ticketMessages)
    .where(and(eq(ticketMessages.ticketId, ticketId), eq(ticketMessages.isInternal, false)))
    .orderBy(desc(ticketMessages.createdAt), desc(ticketMessages.id))
    .limit(1);
  return row && { fromRequester: row.authorType === 'customer' || row.authorType === 'client', at: row.createdAt };
}

/**
 * Records that a ticket's satisfaction survey was queued, once.
 *
 * Why: a ticket is asked for its survey once. The column `survey_sent_at` is the record (it does not depend on the words of a system message,
 * which a rewording, a translation or a staff name could break). The guard `survey_sent_at IS NULL` makes the first caller the only winner,
 * so a second resolve after a reopen finds the ticket already asked.
 *
 * Side effects: writes `support_tickets.survey_sent_at`. `updated_at` is set to the same `now` (the resolve wrote it a moment before in the
 * same transaction): without it the table's `$onUpdate` default would stamp the wall clock, not the injected one (decision 031).
 *
 * @param db the transaction (the ticket row is locked by the caller)
 * @param ticketId the ticket
 * @param now the injected clock's time
 * @returns true when this call recorded it (the survey is to be queued); false when the ticket was already asked
 */
export async function markSurveySent(db: DbExecutor, ticketId: number, now: Date): Promise<boolean> {
  const rows = await db
    .update(supportTickets)
    .set({ surveySentAt: now, updatedAt: now })
    .where(and(eq(supportTickets.id, ticketId), isNull(supportTickets.surveySentAt)))
    .returning({ id: supportTickets.id });
  return rows.length > 0;
}

/**
 * Finds a ticket and locks it for the rest of the transaction.
 *
 * Why: a reply, a note, a status change and the customer's own message all read the ticket, decide and write it back; two at once
 * must not both pass the same check (a reply on a ticket another agent just resolved).
 *
 * @param db the transaction
 * @param id the ticket id
 * @returns the ticket, or `undefined`
 */
export async function lockTicket(db: DbExecutor, id: number): Promise<SupportTicket | undefined> {
  const [row] = await db.select().from(supportTickets).where(eq(supportTickets.id, id)).limit(1).for('update');
  return row;
}

/**
 * Finds the id and token of the ticket a token names.
 *
 * Why: the capability guard looks the token up by the unique index before any handler runs; it gets the stored token back so the resolver
 * can compare it in constant time.
 *
 * @param db the database or a transaction
 * @param token the token the visitor sent
 * @returns the ticket id and stored token, or `undefined`
 */
export async function findTicketByToken(
  db: DbExecutor,
  token: string,
): Promise<{ id: number; token: string } | undefined> {
  const [row] = await db
    .select({ id: supportTickets.id, token: supportTickets.token })
    .from(supportTickets)
    .where(eq(supportTickets.token, token))
    .limit(1);
  return row?.token == null ? undefined : { id: row.id, token: row.token };
}

/**
 * Reads a ticket without joining anything.
 *
 * @param db the database or a transaction
 * @param id the ticket id
 * @returns the ticket, or `undefined`
 */
export async function findTicket(db: DbExecutor, id: number): Promise<SupportTicket | undefined> {
  const [row] = await db.select().from(supportTickets).where(eq(supportTickets.id, id)).limit(1);
  return row;
}

/**
 * Inserts a ticket and gives it its number.
 *
 * Why: the number people see is `T-<id>` (RULES support: server-made, `T-1042` style; the migration starts the ids at 1001), so the id is
 * taken from the sequence first and the row is written under it: one insert, no placeholder number and no race.
 *
 * Side effects: advances the id sequence of `support_tickets`.
 *
 * @param db the transaction
 * @param row the new ticket without `id` and `number`
 * @returns the stored ticket
 */
export async function insertTicket(
  db: DbExecutor,
  row: Omit<NewSupportTicket, 'id' | 'number'>,
): Promise<SupportTicket> {
  const reserved = await db.execute<{ id: string }>(
    sql`select nextval(pg_get_serial_sequence('public.support_tickets', 'id')) as id`,
  );
  const id = Number(reserved.rows[0]!.id);
  const [created] = await db
    .insert(supportTickets)
    .overridingSystemValue()
    .values({ ...row, id, number: `T-${id}` })
    .returning();
  return created!;
}

/**
 * Changes a ticket.
 *
 * @param db the transaction
 * @param id the ticket id
 * @param changes the columns to set (callers always set `updatedAt` from the clock)
 * @returns the stored ticket
 */
export async function updateTicket(
  db: DbExecutor,
  id: number,
  changes: Partial<Omit<NewSupportTicket, 'id' | 'number'>>,
): Promise<SupportTicket> {
  const [row] = await db.update(supportTickets).set(changes).where(eq(supportTickets.id, id)).returning();
  return row!;
}

/**
 * Inserts a message of a thread.
 *
 * @param db the transaction
 * @param row the new message
 * @returns the stored message
 */
export async function insertMessage(db: DbExecutor, row: NewTicketMessage): Promise<TicketMessage> {
  const [created] = await db.insert(ticketMessages).values(row).returning();
  return created!;
}

/**
 * Reads one message.
 *
 * @param db the database or a transaction
 * @param id the message id
 * @returns the message, or `undefined`
 */
export async function findMessage(db: DbExecutor, id: number): Promise<TicketMessage | undefined> {
  const [row] = await db.select().from(ticketMessages).where(eq(ticketMessages.id, id)).limit(1);
  return row;
}

/**
 * Reads the thread of a ticket, oldest first, with the author's name.
 *
 * Why: `GET /admin/support-tickets/:id` embeds the thread with internal notes and the joined `authorName` ('System' for the system,
 * 'Deleted customer' after an anonymize); the storefront's read leaves the internal messages out.
 *
 * @param db the database or a transaction
 * @param ticketId the ticket
 * @param publicOnly true to leave out internal notes and system messages
 * @returns the messages in order, each with its author's name
 */
export async function listMessageRows(db: DbExecutor, ticketId: number, publicOnly: boolean): Promise<MessageRow[]> {
  const rows = await db
    .select({
      message: ticketMessages,
      staffName: f.staff.name,
      customerName: f.customers.name,
      customerEmail: f.customers.email,
      customerStatus: f.customers.status,
      clientName: f.clients.name,
      clientEmail: f.clients.email,
    })
    .from(ticketMessages)
    .leftJoin(f.staff, and(eq(ticketMessages.authorType, 'staff'), eq(f.staff.id, ticketMessages.authorId)))
    .leftJoin(f.customers, and(eq(ticketMessages.authorType, 'customer'), eq(f.customers.id, ticketMessages.authorId)))
    .leftJoin(f.clients, and(eq(ticketMessages.authorType, 'client'), eq(f.clients.id, ticketMessages.authorId)))
    .where(
      publicOnly
        ? and(eq(ticketMessages.ticketId, ticketId), eq(ticketMessages.isInternal, false))
        : eq(ticketMessages.ticketId, ticketId),
    )
    .orderBy(asc(ticketMessages.createdAt), asc(ticketMessages.id));
  return rows.map((row) => ({ message: row.message, authorName: authorNameOf(row) }));
}

/**
 * The name a message shows for its author.
 *
 * @param row the message and the joined names
 * @returns the author's name
 */
export function authorNameOf(row: {
  message: Pick<TicketMessage, 'authorType'>;
  staffName: string | null;
  customerName: string | null;
  customerEmail: string | null;
  customerStatus: string | null;
  clientName: string | null;
  clientEmail: string | null;
}): string {
  switch (row.message.authorType) {
    case 'system':
      return 'System';
    case 'staff':
      return row.staffName ?? 'Staff';
    case 'client':
      return displayName(row.clientName, row.clientEmail, 'Merchant');
    case 'customer':
      return requesterOf({ type: 'customer', ...row }).name;
  }
}

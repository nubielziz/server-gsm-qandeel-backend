// Drizzle queries on `support_tickets` and `ticket_messages` (feature 17): the inbox list with its filters and sorts, one ticket with its
// requester and assignee, the thread with author names, the writes of the use cases, and the token lookup of the ticket page. Feature 28
// adds the live chat's reads (one message, the messages after a cursor), the guarded seen marks, the reply-mail sweep and the attachments.
import {
  and,
  asc,
  count,
  desc,
  eq,
  gt,
  inArray,
  isNotNull,
  isNull,
  lte,
  max,
  ne,
  or,
  sql,
  type SQL,
} from 'drizzle-orm';
import type { ParsedListQuery, ParsedFilter } from '../../../common/contract';
import type { SealedCapabilityToken, UnsealedCapabilityToken } from '../../../infra/crypto';
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
 * Finds the ticket a presented link token names, with the stored form to compare and when it was resolved.
 *
 * Why: the capability guard looks the token up by a unique index before any handler runs; it gets the stored form back so the resolver
 * can compare it in constant time, and `resolved_at` for the end of the link (decision 054). The lookup is by the keyed hash; a ticket
 * opened before is found by its plain token until the seal pass ran.
 *
 * @param db the database or a transaction
 * @param lookup the hash of the presented token (`CapabilityTokenVault.hashOf('ticket', …)`) and the token itself
 * @returns the ticket id with its stored hash or plain token and its resolution time, or `undefined`
 */
export async function findTicketByToken(
  db: DbExecutor,
  lookup: { readonly hash: string; readonly token: string },
): Promise<{ id: number; tokenHash: string | null; token: string | null; resolvedAt: Date | null } | undefined> {
  const columns = {
    id: supportTickets.id,
    tokenHash: supportTickets.tokenHash,
    token: supportTickets.token,
    resolvedAt: supportTickets.resolvedAt,
  };
  const [sealed] = await db
    .select(columns)
    .from(supportTickets)
    .where(eq(supportTickets.tokenHash, lookup.hash))
    .limit(1);
  if (sealed) return sealed;
  // Tickets opened before decision 054 keep the token as issued until the seal pass ran.
  const [plain] = await db.select(columns).from(supportTickets).where(eq(supportTickets.token, lookup.token)).limit(1);
  return plain;
}

/**
 * The tickets that still keep their link token as issued, by id.
 *
 * Why: decision 054: the one-off seal pass walks them a page at a time.
 *
 * @param db the database
 * @param afterId the last id of the previous page (0 to start)
 * @param limit the page size
 * @returns the id and plain token of each row
 */
export async function findUnsealedTickets(
  db: DbExecutor,
  afterId: number,
  limit: number,
): Promise<UnsealedCapabilityToken[]> {
  const rows = await db
    .select({ id: supportTickets.id, token: supportTickets.token })
    .from(supportTickets)
    .where(and(isNotNull(supportTickets.token), isNull(supportTickets.tokenHash), gt(supportTickets.id, afterId)))
    .orderBy(asc(supportTickets.id))
    .limit(limit);
  return rows.flatMap((row) => (row.token === null ? [] : [{ id: row.id, token: row.token }]));
}

/**
 * Stores a ticket's link token as its hash and encrypted copy and empties the plain column.
 *
 * Why: decision 054: the seal pass converts each row in one guarded statement, so a row that changed since it was read (a token
 * cleared by an anonymization) is left alone and a repeat finds nothing to do.
 *
 * @param db the database
 * @param row the row as read (id and plain token)
 * @param sealed the token's stored forms
 * @returns true when the row was converted
 */
export async function sealTicketToken(
  db: DbExecutor,
  row: UnsealedCapabilityToken,
  sealed: SealedCapabilityToken,
): Promise<boolean> {
  const changed = await db
    .update(supportTickets)
    // Sealing is not a change of the ticket: updated_at keeps its value, so the inbox order does not move.
    .set({ tokenHash: sealed.hash, tokenEnc: sealed.enc, token: null, updatedAt: sql`${supportTickets.updatedAt}` })
    .where(and(eq(supportTickets.id, row.id), eq(supportTickets.token, row.token), isNull(supportTickets.tokenHash)))
    .returning({ id: supportTickets.id });
  return changed.length === 1;
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
 * Clears the page token of every ticket a customer opened.
 *
 * Why: the token is a capability link kept in an email; once the customer is anonymized nobody may open the thread with it
 * (decision 010, feature 18). The ticket and its messages stay for the books; only the link goes, in every stored form (the plain token,
 * its hash and its encrypted copy, decision 054). `updated_at` is kept so the inbox order does not move.
 *
 * @param db the anonymization's transaction
 * @param customerId the customer
 * @returns how many tickets lost their token
 */
export async function clearTicketTokensOfCustomer(db: DbExecutor, customerId: number): Promise<number> {
  const rows = await db
    .update(supportTickets)
    .set({ token: null, tokenHash: null, tokenEnc: null, updatedAt: sql`${supportTickets.updatedAt}` })
    .where(
      and(
        eq(supportTickets.requesterType, 'customer'),
        eq(supportTickets.requesterId, customerId),
        or(isNotNull(supportTickets.token), isNotNull(supportTickets.tokenHash)),
      ),
    )
    .returning({ id: supportTickets.id });
  return rows.length;
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

/** What a message read with its author's name selects. */
const messageSelect = {
  message: ticketMessages,
  staffName: f.staff.name,
  customerName: f.customers.name,
  customerEmail: f.customers.email,
  customerStatus: f.customers.status,
  clientName: f.clients.name,
  clientEmail: f.clients.email,
};

const onMessageStaff = and(eq(ticketMessages.authorType, 'staff'), eq(f.staff.id, ticketMessages.authorId));
const onMessageCustomer = and(eq(ticketMessages.authorType, 'customer'), eq(f.customers.id, ticketMessages.authorId));
const onMessageClient = and(eq(ticketMessages.authorType, 'client'), eq(f.clients.id, ticketMessages.authorId));

/**
 * A message the requester may see: public and not the system's.
 *
 * Why: the storefront view and every requester stream leave out internal notes and system messages (feature 17; feature 28, the security
 * core of the live chat). Both conditions are written, so a system message can never pass even if it were stored public.
 */
const requesterVisible = and(eq(ticketMessages.isInternal, false), ne(ticketMessages.authorType, 'system'));

/**
 * Reads one message with the name of its author.
 *
 * Why: feature 28: a live `ticket.message.created` renders the message as the thread does (the staff view joins the author's name).
 *
 * @param db the database or a transaction
 * @param id the message id
 * @returns the message and its author's name, or `undefined`
 */
export async function findMessageRow(db: DbExecutor, id: number): Promise<MessageRow | undefined> {
  const [row] = await db
    .select(messageSelect)
    .from(ticketMessages)
    .leftJoin(f.staff, onMessageStaff)
    .leftJoin(f.customers, onMessageCustomer)
    .leftJoin(f.clients, onMessageClient)
    .where(eq(ticketMessages.id, id))
    .limit(1);
  return row && { message: row.message, authorName: authorNameOf(row) };
}

/** Whose messages a reconnecting stream may replay. */
export type MessageScope =
  /** Staff with `support:read`: every message of every ticket, notes and system messages included. */
  | { readonly kind: 'all' }
  /** A signed-in requester: the public messages of their own tickets. */
  | { readonly kind: 'requester'; readonly type: 'customer' | 'client'; readonly id: number }
  /** The holder of a ticket link: the public messages of that ticket. */
  | { readonly kind: 'ticket'; readonly ticketId: number };

/** A message with its author's name and the ticket fields a live event names. */
export interface LiveMessageRow extends MessageRow {
  readonly ticket: Pick<SupportTicket, 'id' | 'number' | 'requesterType' | 'requesterId'>;
}

/**
 * Reads the messages after a cursor that a viewer may see, oldest first.
 *
 * Why: feature 28 (plan § 3.4): a stream that reconnects replays the `ticket.message.created` frames it missed. The scope is part of the
 * query (the requester's own tickets, or the one ticket of a link, public messages only), so nothing of another person can be read.
 *
 * @param db the database or a transaction
 * @param scope whose messages
 * @param after the last message id the stream saw
 * @param limit the most rows to read (the caller asks one more than it replays, to know when to resync)
 * @returns the messages with their author's name and ticket, ascending by id
 */
export async function messageRowsAfter(
  db: DbExecutor,
  scope: MessageScope,
  after: number,
  limit: number,
): Promise<LiveMessageRow[]> {
  const scoped =
    scope.kind === 'all'
      ? undefined
      : scope.kind === 'ticket'
        ? and(eq(ticketMessages.ticketId, scope.ticketId), requesterVisible)
        : and(eq(supportTickets.requesterType, scope.type), eq(supportTickets.requesterId, scope.id), requesterVisible);
  const rows = await db
    .select({
      ...messageSelect,
      ticketNumber: supportTickets.number,
      requesterType: supportTickets.requesterType,
      requesterId: supportTickets.requesterId,
    })
    .from(ticketMessages)
    .innerJoin(supportTickets, eq(supportTickets.id, ticketMessages.ticketId))
    .leftJoin(f.staff, onMessageStaff)
    .leftJoin(f.customers, onMessageCustomer)
    .leftJoin(f.clients, onMessageClient)
    .where(and(gt(ticketMessages.id, after), scoped))
    .orderBy(asc(ticketMessages.id))
    .limit(limit);
  return rows.map((row) => ({
    message: row.message,
    authorName: authorNameOf(row),
    ticket: {
      id: row.message.ticketId,
      number: row.ticketNumber,
      requesterType: row.requesterType,
      requesterId: row.requesterId,
    },
  }));
}

/**
 * The newest message id of all tickets: where a live stream without a cursor starts.
 *
 * @param db the database or a transaction
 * @returns the largest `ticket_messages.id`, or 0
 */
export async function newestMessageId(db: DbExecutor): Promise<number> {
  const [row] = await db.select({ id: max(ticketMessages.id) }).from(ticketMessages);
  return Number(row?.id ?? 0);
}

/**
 * Moves one side's seen mark forward, never back, in one guarded statement.
 *
 * Why: feature 28, rule 3: two tabs or a late request must not move a mark back, and the database decides it (`coalesce(mark, 0) <
 * upTo`), so two calls at once cannot race. The ticket keeps its `updated_at`: reading is not activity (and the table's `$onUpdate`
 * default would stamp the wall clock, decision 031).
 *
 * Side effects: writes `support_tickets.<side>_seen_message_id` and `<side>_seen_at`.
 *
 * @param db the database or a transaction
 * @param ticketId the ticket
 * @param side who marks: `requester` or `staff`
 * @param upTo the newest message the side has seen (checked by the caller to be the other side's message of this ticket)
 * @param now the injected clock's time
 * @returns true when the mark moved; false for a repeat or an older id
 */
export async function markSeen(
  db: DbExecutor,
  ticketId: number,
  side: 'requester' | 'staff',
  upTo: number,
  now: Date,
): Promise<boolean> {
  const mark = side === 'requester' ? supportTickets.requesterSeenMessageId : supportTickets.staffSeenMessageId;
  const changes =
    side === 'requester'
      ? { requesterSeenMessageId: upTo, requesterSeenAt: now }
      : { staffSeenMessageId: upTo, staffSeenAt: now };
  const rows = await db
    .update(supportTickets)
    .set({ ...changes, updatedAt: sql`${supportTickets.updatedAt}` })
    .where(and(eq(supportTickets.id, ticketId), sql`coalesce(${mark}, 0) < ${upTo}`))
    .returning({ id: supportTickets.id });
  return rows.length > 0;
}

/**
 * Locks the tickets whose unseen email replies are due, oldest ticket first, skipping the ones another sweep holds.
 *
 * Why: feature 28, rule 9: the reply-mail sweep runs every minute and may run twice at once; `FOR UPDATE SKIP LOCKED` gives each ticket to
 * one sweep, and the due time is cleared in the same transaction.
 *
 * @param tx the sweep's transaction
 * @param now the injected clock's time
 * @param limit the most tickets of one pass
 * @returns the locked tickets
 */
export async function lockDueReplyMails(tx: DbExecutor, now: Date, limit: number): Promise<SupportTicket[]> {
  return tx
    .select()
    .from(supportTickets)
    .where(lte(supportTickets.replyMailDueAt, now))
    .orderBy(asc(supportTickets.id))
    .limit(limit)
    .for('update', { skipLocked: true });
}

/**
 * Says whether a ticket has an email reply waiting for the sweep.
 *
 * @param db the database or a transaction
 * @param now the injected clock's time
 * @returns true when at least one ticket's `reply_mail_due_at` has passed
 */
export async function anyReplyMailDue(db: DbExecutor, now: Date): Promise<boolean> {
  const [row] = await db
    .select({ id: supportTickets.id })
    .from(supportTickets)
    .where(lte(supportTickets.replyMailDueAt, now))
    .limit(1);
  return row !== undefined;
}

/**
 * Reads the email replies of a ticket that the requester has not seen and no mail carried yet, oldest first.
 *
 * Why: feature 28, rule 9: one mail carries every public staff message on channel `email` after the larger of the requester's mark and
 * the newest mailed reply; the job reads them again with the same filter (and the range of its event), so a reply seen meanwhile drops out.
 *
 * @param db the database or a transaction
 * @param ticketId the ticket
 * @param after the id after which a reply counts (`unseenAfter` of the domain)
 * @param range the first and last message of a mail event, when the job reads them again
 * @returns the replies, ascending by id
 */
export async function unseenEmailReplies(
  db: DbExecutor,
  ticketId: number,
  after: number,
  range?: { readonly from: number; readonly to: number },
): Promise<TicketMessage[]> {
  return db
    .select()
    .from(ticketMessages)
    .where(
      and(
        eq(ticketMessages.ticketId, ticketId),
        eq(ticketMessages.authorType, 'staff'),
        eq(ticketMessages.isInternal, false),
        eq(ticketMessages.notifyChannel, 'email'),
        gt(ticketMessages.id, after),
        range === undefined ? undefined : sql`${ticketMessages.id} between ${range.from} and ${range.to}`,
      ),
    )
    .orderBy(asc(ticketMessages.id));
}

/**
 * Ends the wait of a ticket's email replies: clears the due time and, when a mail was written, records its newest reply.
 *
 * Side effects: writes `support_tickets.reply_mail_due_at` and `reply_mailed_message_id`; `updated_at` stays (a mail is not activity).
 *
 * @param tx the sweep's transaction (the ticket is locked)
 * @param ticketId the ticket
 * @param mailedId the newest reply the mail carries, or `undefined` when nothing was left to mail
 */
export async function finishReplyMail(tx: DbExecutor, ticketId: number, mailedId: number | undefined): Promise<void> {
  await tx
    .update(supportTickets)
    .set({
      replyMailDueAt: null,
      ...(mailedId === undefined ? {} : { replyMailedMessageId: mailedId }),
      updatedAt: sql`${supportTickets.updatedAt}`,
    })
    .where(eq(supportTickets.id, ticketId));
}

/**
 * The ids of every ticket a customer opened.
 *
 * @param db the database or a transaction
 * @param customerId the customer
 * @returns the ticket ids, ascending
 */
export async function ticketIdsOfCustomer(db: DbExecutor, customerId: number): Promise<number[]> {
  const rows = await db
    .select({ id: supportTickets.id })
    .from(supportTickets)
    .where(and(eq(supportTickets.requesterType, 'customer'), eq(supportTickets.requesterId, customerId)))
    .orderBy(asc(supportTickets.id));
  return rows.map((row) => row.id);
}

/**
 * Empties the attachments of every message of some tickets and returns the file ids they held.
 *
 * Why: feature 28, rule 10: an anonymized customer's tickets and the tickets past the attachment retention lose their files; the texts stay
 * (B175). The references go first, in the caller's transaction, so the file rows can then be deleted when nothing else uses them.
 *
 * Side effects: writes `ticket_messages.file_ids`.
 *
 * @param tx the caller's transaction
 * @param ticketIds the tickets
 * @returns every file id their messages held (duplicates possible)
 */
export async function takeFileIdsOfTickets(tx: DbExecutor, ticketIds: readonly number[]): Promise<number[]> {
  if (ticketIds.length === 0) return [];
  const ids = sql`array[${sql.join(
    ticketIds.map((id) => sql`${id}`),
    sql`, `,
  )}]::bigint[]`;
  // RETURNING shows the new row, so the old lists come from the locked sub-select the update joins.
  const result = await tx.execute(sql`
    update ticket_messages m set file_ids = '{}'
    from (
      select id, file_ids from ticket_messages
      where ticket_id = any(${ids}) and cardinality(file_ids) > 0
      for update
    ) old
    where m.id = old.id
    returning old.file_ids as file_ids
  `);
  return (result.rows as { file_ids: (string | number)[] }[]).flatMap((row) => row.file_ids.map(Number));
}

/**
 * Locks the resolved tickets whose attachments are past the retention, skipping tickets another run holds.
 *
 * @param tx the run's transaction
 * @param cutoff tickets resolved before this time
 * @param limit the most tickets of one batch
 * @returns the ticket ids, ascending
 */
export async function lockTicketsPastAttachmentRetention(
  tx: DbExecutor,
  cutoff: Date,
  limit: number,
): Promise<number[]> {
  const rows = await tx
    .select({ id: supportTickets.id })
    .from(supportTickets)
    .where(
      and(
        eq(supportTickets.status, 'resolved'),
        sql`${supportTickets.resolvedAt} < ${cutoff}`,
        sql`exists (select 1 from ${ticketMessages} where ${ticketMessages.ticketId} = ${supportTickets.id} and cardinality(${ticketMessages.fileIds}) > 0)`,
      ),
    )
    .orderBy(asc(supportTickets.id))
    .limit(limit)
    .for('update', { skipLocked: true });
  return rows.map((row) => row.id);
}

/**
 * Says whether a file is attached to a message of a ticket that the viewer may see.
 *
 * Why: feature 28, rule 8: a download is checked on the message of **that** ticket; for the requester only on a public message, so the
 * file of an internal note is a `404` like a file of another ticket.
 *
 * @param db the database or a transaction
 * @param ticketId the ticket of the route
 * @param fileId the file
 * @param requester true for the requester (public messages only), false for staff (every message)
 * @returns true when such a message holds the file
 */
export async function ticketMessageHoldsFile(
  db: DbExecutor,
  ticketId: number,
  fileId: number,
  requester: boolean,
): Promise<boolean> {
  const [row] = await db
    .select({ id: ticketMessages.id })
    .from(ticketMessages)
    .where(
      and(
        eq(ticketMessages.ticketId, ticketId),
        sql`${ticketMessages.fileIds} @> array[${fileId}]::bigint[]`,
        requester ? requesterVisible : undefined,
      ),
    )
    .limit(1);
  return row !== undefined;
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
    .select(messageSelect)
    .from(ticketMessages)
    .leftJoin(f.staff, onMessageStaff)
    .leftJoin(f.customers, onMessageCustomer)
    .leftJoin(f.clients, onMessageClient)
    .where(
      publicOnly ? and(eq(ticketMessages.ticketId, ticketId), requesterVisible) : eq(ticketMessages.ticketId, ticketId),
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

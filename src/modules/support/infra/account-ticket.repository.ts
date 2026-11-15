// Drizzle queries of the account surfaces of the support chat (feature 28, slice B2): a signed-in customer's or merchant's own tickets, each
// with the author of its latest public message, and the one check every merchant route starts with (the ticket is theirs). The inbox
// queries of staff and the live chat's reads are in ticket.repository.ts; nothing here joins a foreign table.
import { and, count, desc, eq, inArray, isNotNull, ne } from 'drizzle-orm';
import type { ParsedFilter, ParsedListQuery } from '../../../common/contract';
import { type DbExecutor, type ListColumns, listOrderBy, listWhere } from '../../../infra/db';
import { type SupportTicket, supportTickets, ticketMessages } from '../db/schema';
import { type WireTicketStatus, fromWireStatus } from '../domain/ticket-status';

/** Who owns the tickets of a list: the signed-in customer or the merchant. */
export interface TicketOwner {
  readonly type: 'customer' | 'client';
  readonly id: number;
}

/** The sorts of both lists (`GET /store/v1/me/tickets`, `GET /client/tickets`). */
export type AccountSortField = 'updatedAt' | 'createdAt';

/** A ticket of the list with its latest public message. */
export interface AccountTicketRow {
  readonly ticket: SupportTicket;
  /** When the newest message the requester sees was written; `null` for a ticket without one. */
  readonly lastMessageAt: Date | null;
  /** Who wrote it: the requester (`you`) or support; `null` for a ticket without a public message. */
  readonly lastMessageFrom: 'you' | 'support' | null;
}

const LIST_COLUMNS: ListColumns = {
  status: supportTickets.status,
  createdAt: supportTickets.createdAt,
  updatedAt: supportTickets.updatedAt,
};

/**
 * Translates the `status` filter's wire words to the stored ones.
 *
 * Why: the lists speak the console's words (`pending`), the table stores `pending_customer` (RESOLUTIONS b2c-2).
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
 * Reads the latest public message of each ticket.
 *
 * Why: the lists show who spoke last and when. A note or a system message is never counted (the requester must not learn of it), so the
 * same two conditions as the live chat's `requesterVisible` are written here.
 *
 * @param db the database or a transaction
 * @param ids the tickets of a page
 * @returns ticket id to the author side and time of its newest public message; a ticket without one is absent
 */
async function latestPublicMessages(
  db: DbExecutor,
  ids: readonly number[],
): Promise<Map<number, { from: 'you' | 'support'; at: Date }>> {
  if (ids.length === 0) return new Map();
  const rows = await db
    .selectDistinctOn([ticketMessages.ticketId], {
      ticketId: ticketMessages.ticketId,
      authorType: ticketMessages.authorType,
      createdAt: ticketMessages.createdAt,
    })
    .from(ticketMessages)
    .where(
      and(
        inArray(ticketMessages.ticketId, [...ids]),
        eq(ticketMessages.isInternal, false),
        ne(ticketMessages.authorType, 'system'),
      ),
    )
    .orderBy(ticketMessages.ticketId, desc(ticketMessages.id));
  return new Map(
    rows.map((row) => [row.ticketId, { from: row.authorType === 'staff' ? 'support' : 'you', at: row.createdAt }]),
  );
}

/**
 * Lists the tickets of one customer or merchant.
 *
 * Why: feature 28, rule 6 and 7: a signed-in customer's tickets are those whose requester is that customer (tickets they filed as a guest
 * with the same address included); a merchant's, those whose requester is that merchant. A customer's ticket without a link token (cleared
 * by an erasure) has no page to open and is left out. The sort is `updatedAt` (default, newest first) or `createdAt`; the only filter is
 * `status`, and there is no search.
 *
 * @param db the database or a transaction
 * @param owner the signed-in customer or merchant
 * @param query the parsed list request
 * @returns the page of tickets with their latest public message, and the exact total
 */
export async function listAccountTickets(
  db: DbExecutor,
  owner: TicketOwner,
  query: ParsedListQuery<AccountSortField>,
): Promise<{ rows: AccountTicketRow[]; total: number }> {
  const where = listWhere(
    { filters: storedStatusFilters(query.filters), search: undefined },
    LIST_COLUMNS,
    and(
      eq(supportTickets.requesterType, owner.type),
      eq(supportTickets.requesterId, owner.id),
      // A link-less ticket of a customer cannot be opened from the list.
      owner.type === 'customer' ? isNotNull(supportTickets.token) : undefined,
    ),
  );
  const [tickets, [total]] = await Promise.all([
    db
      .select()
      .from(supportTickets)
      .where(where)
      .orderBy(...listOrderBy(query.sort, LIST_COLUMNS, supportTickets.id))
      .limit(query.range.limit)
      .offset(query.range.start),
    db.select({ total: count() }).from(supportTickets).where(where),
  ]);
  const latest = await latestPublicMessages(
    db,
    tickets.map((ticket) => ticket.id),
  );
  return {
    rows: tickets.map((ticket) => ({
      ticket,
      lastMessageAt: latest.get(ticket.id)?.at ?? null,
      lastMessageFrom: latest.get(ticket.id)?.from ?? null,
    })),
    total: total?.total ?? 0,
  };
}

/**
 * Reads one ticket if it belongs to the owner.
 *
 * Why: a merchant addresses a ticket by id and a ticket of someone else is `404`, never `403` (plan § 2, rule 7), so ids cannot be probed.
 *
 * @param db the database or a transaction
 * @param owner the signed-in customer or merchant
 * @param id the ticket id of the route
 * @returns the ticket, or `undefined` when there is none with this id or it is somebody else's
 */
export async function findOwnedTicket(
  db: DbExecutor,
  owner: TicketOwner,
  id: number,
): Promise<SupportTicket | undefined> {
  const [row] = await db
    .select()
    .from(supportTickets)
    .where(
      and(
        eq(supportTickets.id, id),
        eq(supportTickets.requesterType, owner.type),
        eq(supportTickets.requesterId, owner.id),
      ),
    )
    .limit(1);
  return row;
}

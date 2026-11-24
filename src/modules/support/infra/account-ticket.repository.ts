// Drizzle queries of the account surfaces of the support chat (feature 28, slice B2): a signed-in account's own tickets, each with the author
// of its latest public message, and the one check every portal route starts with (the ticket is theirs). The inbox queries of staff and the
// live chat's reads are in ticket.repository.ts; nothing here joins a foreign table.
import { and, count, desc, eq, inArray, isNotNull, ne, or } from 'drizzle-orm';
import type { ParsedFilter, ParsedListQuery } from '../../../common/contract';
import { type DbExecutor, type ListColumns, listOrderBy, listWhere } from '../../../infra/db';
import type { RankKind } from '../../identity';
import { type SupportTicket, requesterProven, supportTickets, ticketMessages } from '../db/schema';
import { type WireTicketStatus, fromWireStatus } from '../domain/ticket-status';

/**
 * Who owns the tickets of a list: the signed-in account, and the rank kind it asks with.
 *
 * Why: one account type opens tickets on two surfaces, told apart by the rank kind (decision 064): a retail account reads its tickets as
 * ticket pages (each opens by its link token), a merchant rank in the portal (each opens by its id). The rank kind comes from the
 * session's principal, never from a body.
 */
export interface TicketOwner {
  readonly id: number;
  readonly rankKind: RankKind;
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
 * Lists the tickets of one account.
 *
 * Why: feature 28, rules 6 and 7, and decision 064: an account's tickets are those whose requester is that account, whatever its rank
 * (tickets filed as a guest with the same address included once the address was proven, decision 053). The proof rule applies to every
 * account (decision 064): a ticket of the public form typed with a login account's address stays off its list until its mailed link is used,
 * a merchant rank included. A retail account's list holds only tickets that have a link token (a ticket whose token an erasure cleared has
 * no page to open); the link-less filter is for the shop list only, because a portal ticket has no token and opens by its id. The sort is
 * `updatedAt` (default, newest first) or `createdAt`; the only filter is `status`, and there is no search.
 *
 * @param db the database or a transaction
 * @param owner the signed-in account and its rank kind
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
      eq(supportTickets.requesterType, 'account'),
      eq(supportTickets.requesterId, owner.id),
      // A link-less ticket cannot be opened from the shop list (either stored form of the link counts, decision 054).
      owner.rankKind === 'retail'
        ? or(isNotNull(supportTickets.token), isNotNull(supportTickets.tokenHash))
        : undefined,
      // Decision 053 for every account: a ticket opened with a typed address stays off the account until its mailed link is used.
      requesterProven(),
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
 * Reads one ticket if it belongs to the account.
 *
 * Why: a portal route addresses a ticket by id, and a ticket of someone else is `404`, never `403` (plan § 2, rule 7), so ids cannot be
 * probed. A ticket whose requester address is not proven yet is not the account's to read either (decision 053): it reads as
 * unknown until the mailed link is used.
 *
 * @param db the database or a transaction
 * @param owner the signed-in account
 * @param id the ticket id of the route
 * @returns the ticket, or `undefined` when there is none with this id, it is somebody else's or its address is not proven
 */
export async function findOwnedTicket(
  db: DbExecutor,
  owner: Pick<TicketOwner, 'id'>,
  id: number,
): Promise<SupportTicket | undefined> {
  const [row] = await db
    .select()
    .from(supportTickets)
    .where(
      and(
        eq(supportTickets.id, id),
        eq(supportTickets.requesterType, 'account'),
        eq(supportTickets.requesterId, owner.id),
        requesterProven(),
      ),
    )
    .limit(1);
  return row;
}

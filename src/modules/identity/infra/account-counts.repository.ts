// One aggregate over `clients` for `GET /admin/clients/counts` (identity module): how many accounts of each rank kind, status and sort there are.
import { type SQL, sql } from 'drizzle-orm';
import type { DbExecutor } from '../../../infra/db';
import { CLIENT_STATUSES, type ClientStatus, clients } from '../db/schema';
import { INVITATION_PENDING_SQL } from './client-admin.repository';

/** The numbers of the Accounts page: the chips and the header sentence. */
export interface AccountCounts {
  /** Every row of the table: accounts and guests of any status. */
  readonly all: number;
  /** Rows of the retail rank, guests included. */
  readonly retail: number;
  /** Rows of every other rank. */
  readonly merchant: number;
  /** Rows without a login. */
  readonly guests: number;
  readonly active: number;
  readonly suspended: number;
  readonly blocked: number;
  readonly anonymized: number;
  /** Rows with a login, no password yet and an active status. */
  readonly invitationPending: number;
}

/**
 * Counts the accounts in one pass.
 *
 * Why: the Accounts page shows one chip per rank kind and status and a header sentence; one aggregate (`count(*) filter (where ...)`)
 * keeps them from disagreeing, which a count per chip read at different moments could do. Each status is counted by its own filter, so a
 * status added to the list is counted without another line here.
 *
 * @param db the database or a transaction
 * @param retailGroupId the id of the retail rank (every other rank is a merchant rank)
 * @returns the counts
 */
export async function countAccounts(db: DbExecutor, retailGroupId: number): Promise<AccountCounts> {
  const statuses = Object.fromEntries(
    CLIENT_STATUSES.map((status) => [
      status,
      sql<number>`(count(*) filter (where ${clients.status} = ${status}))::int`,
    ]),
  ) as Record<ClientStatus, SQL<number>>;
  const [row] = await db
    .select({
      all: sql<number>`count(*)::int`,
      retail: sql<number>`(count(*) filter (where ${clients.groupId} = ${retailGroupId}))::int`,
      merchant: sql<number>`(count(*) filter (where ${clients.groupId} <> ${retailGroupId}))::int`,
      guests: sql<number>`(count(*) filter (where not ${clients.hasAccount}))::int`,
      ...statuses,
      invitationPending: sql<number>`(count(*) filter (where ${INVITATION_PENDING_SQL}))::int`,
    })
    .from(clients);
  return (
    row ?? {
      all: 0,
      retail: 0,
      merchant: 0,
      guests: 0,
      active: 0,
      suspended: 0,
      blocked: 0,
      anonymized: 0,
      invitationPending: 0,
    }
  );
}

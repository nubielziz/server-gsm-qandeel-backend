// Drizzle queries on `data_requests` (risk module): the staff list with the account's name, one request, the writes of the routes and
// the requests an account export or anonymization closes. A request belongs to an account (`account_id`, decision 064).
import { and, eq, inArray, sql } from 'drizzle-orm';
import type { ParsedListQuery } from '../../../common/contract';
import { type DbExecutor, type ListColumns, listOrderBy, listWhere, schema as s } from '../../../infra/db';
import {
  type DataRequest,
  type DataRequestKind,
  type DataRequestStatus,
  type NewDataRequest,
  dataRequests,
} from '../db/schema';

/** The sort fields of the request list. */
export type DataRequestSortField = 'requestedAt' | 'dueAt' | 'status';

// Lifecycle order: open, in progress, completed, rejected.
const statusRank = sql`case ${dataRequests.status} when 'open' then 1 when 'in_progress' then 2 when 'completed' then 3 else 4 end`;

const COLUMNS: ListColumns = {
  requestedAt: dataRequests.requestedAt,
  dueAt: dataRequests.dueAt,
  status: statusRank,
  kind: dataRequests.kind,
  accountId: dataRequests.accountId,
};

// The status filter compares words, not the rank used for sorting.
const FILTER_COLUMNS: ListColumns = { ...COLUMNS, status: dataRequests.status };

/** A request with the current name of its account. */
export interface DataRequestRow {
  readonly request: DataRequest;
  readonly accountName: string;
  /** The account's status: an erasure request cannot be completed by hand before it is `anonymized`. */
  readonly accountStatus: string;
}

function selectRows(db: DbExecutor) {
  return db
    .select({ request: dataRequests, accountName: s.clients.name, accountStatus: s.clients.status })
    .from(dataRequests)
    .innerJoin(s.clients, eq(s.clients.id, dataRequests.accountId));
}

/**
 * Lists data requests.
 *
 * @param db the database or a transaction
 * @param query the parsed list request (`status` repeats for IN, `kind`, `accountId`)
 * @returns the page and the exact total
 */
export async function listDataRequestRows(
  db: DbExecutor,
  query: ParsedListQuery<DataRequestSortField>,
): Promise<{ rows: DataRequestRow[]; total: number }> {
  const where = listWhere(query, FILTER_COLUMNS);
  const [rows, [count]] = await Promise.all([
    selectRows(db)
      .where(where)
      .orderBy(...listOrderBy(query.sort, COLUMNS, dataRequests.id))
      .limit(query.range.limit)
      .offset(query.range.start),
    db
      .select({ total: sql<number>`count(*)::int` })
      .from(dataRequests)
      .where(where),
  ]);
  return { rows, total: count?.total ?? 0 };
}

/**
 * Finds one request with its account's name.
 *
 * @param db the database or a transaction
 * @param id the request id
 * @param lock lock the request row for the rest of the transaction
 * @returns the row, or `undefined`
 */
export async function findDataRequestRow(
  db: DbExecutor,
  id: number,
  lock = false,
): Promise<DataRequestRow | undefined> {
  const query = selectRows(db).where(eq(dataRequests.id, id)).limit(1);
  const [row] = await (lock ? query.for('update', { of: dataRequests }) : query);
  return row;
}

/**
 * Finds the account's request of a kind that still waits for an answer.
 *
 * @param db the database or a transaction
 * @param accountId the account
 * @param kind export or erasure
 * @returns the oldest open or in-progress request, or `undefined`
 */
export async function findPendingRequest(
  db: DbExecutor,
  accountId: number,
  kind: DataRequestKind,
): Promise<DataRequest | undefined> {
  const [row] = await db
    .select()
    .from(dataRequests)
    .where(
      and(
        eq(dataRequests.accountId, accountId),
        eq(dataRequests.kind, kind),
        inArray(dataRequests.status, ['open', 'in_progress']),
      ),
    )
    .orderBy(dataRequests.id)
    .limit(1);
  return row;
}

/**
 * Inserts a request.
 *
 * @param db the caller's transaction
 * @param values the row (times from the clock)
 * @returns the stored row
 */
export async function insertDataRequest(db: DbExecutor, values: NewDataRequest): Promise<DataRequest> {
  const [row] = await db.insert(dataRequests).values(values).returning();
  return row!;
}

/** The columns a move changes. */
export interface RequestChanges {
  readonly status: DataRequestStatus;
  readonly note: string;
  readonly handledBy: number | null;
  readonly completedAt: Date | null;
  readonly updatedAt: Date;
  readonly fileId?: number | null;
}

/**
 * Changes a request.
 *
 * @param db the caller's transaction
 * @param id the request id
 * @param changes the new columns
 * @returns the stored row
 */
export async function updateDataRequest(db: DbExecutor, id: number, changes: RequestChanges): Promise<DataRequest> {
  const [row] = await db.update(dataRequests).set(changes).where(eq(dataRequests.id, id)).returning();
  return row!;
}

/**
 * Completes the account's pending requests of a kind.
 *
 * Why: ANSWERS customers Q4: an export closes the open or in-progress export request, an anonymization the erasure request, both
 * `completed` with `completed_at` now and `handled_by` the staff member. With no pending request the action still runs.
 *
 * @param db the caller's transaction
 * @param accountId the account
 * @param kind which kind to close
 * @param staffId the staff member who acted
 * @param now the clock's time
 * @returns the requests that were closed
 */
export async function completePendingRequests(
  db: DbExecutor,
  accountId: number,
  kind: DataRequestKind,
  staffId: number,
  now: Date,
): Promise<DataRequest[]> {
  return db
    .update(dataRequests)
    .set({ status: 'completed', completedAt: now, handledBy: staffId, updatedAt: now })
    .where(
      and(
        eq(dataRequests.accountId, accountId),
        eq(dataRequests.kind, kind),
        inArray(dataRequests.status, ['open', 'in_progress']),
      ),
    )
    .returning();
}

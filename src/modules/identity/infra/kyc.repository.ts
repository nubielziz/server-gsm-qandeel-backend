// Drizzle queries on kyc_submissions and the clients' verification status (map routes /admin/kyc-submissions*, /client/kyc, stage 8).
// The merchant and reviewer rows read around a request are identity's own tables.
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import type { ParsedListQuery } from '../../../common/contract';
import type { DbExecutor } from '../../../infra/db';
import { listOrderBy, listWhere } from '../../../infra/db/list-sql';
import {
  type Client,
  type KycStatus,
  type KycSubmission,
  type NewKycSubmission,
  clients,
  kycSubmissions,
  staffUsers,
} from '../db/schema';

/** The sort fields of the verification request list. */
export type KycSortField = 'createdAt' | 'id';

const COLUMNS = {
  createdAt: kycSubmissions.createdAt,
  id: kycSubmissions.id,
  status: kycSubmissions.status,
  clientId: kycSubmissions.clientId,
};

/**
 * Lists verification requests.
 *
 * @param db the database or a transaction
 * @param query the parsed list request
 * @returns the page of rows and the number matching the filters
 */
export async function listKycRows(
  db: DbExecutor,
  query: ParsedListQuery<KycSortField>,
): Promise<{ rows: KycSubmission[]; total: number }> {
  const where = listWhere(query, COLUMNS);
  const [rows, [counted]] = await Promise.all([
    db
      .select()
      .from(kycSubmissions)
      .where(where)
      .orderBy(...listOrderBy(query.sort, COLUMNS, kycSubmissions.id))
      .limit(query.range.limit)
      .offset(query.range.start),
    db
      .select({ total: sql<number>`count(*)::int` })
      .from(kycSubmissions)
      .where(where),
  ]);
  return { rows, total: counted?.total ?? 0 };
}

/**
 * Finds a request by id.
 *
 * @param db the database or a transaction
 * @param id the request id
 * @param lock lock the row `FOR UPDATE` until the transaction ends
 * @returns the row, or `undefined`
 */
export async function findKyc(db: DbExecutor, id: number, lock = false): Promise<KycSubmission | undefined> {
  const query = db.select().from(kycSubmissions).where(eq(kycSubmissions.id, id)).limit(1);
  const [row] = await (lock ? query.for('update') : query);
  return row;
}

/**
 * Finds a merchant's latest request.
 *
 * @param db the database or a transaction
 * @param clientId the merchant
 * @returns the newest request, or `undefined` when it never submitted
 */
export async function latestKycOf(db: DbExecutor, clientId: number): Promise<KycSubmission | undefined> {
  const [row] = await db
    .select()
    .from(kycSubmissions)
    .where(eq(kycSubmissions.clientId, clientId))
    .orderBy(desc(kycSubmissions.createdAt), desc(kycSubmissions.id))
    .limit(1);
  return row;
}

/**
 * Inserts a request.
 *
 * Side effects: inserts a `kyc_submissions` row.
 *
 * @param db the caller's transaction
 * @param row the new row
 * @returns the stored row
 */
export async function insertKyc(db: DbExecutor, row: NewKycSubmission): Promise<KycSubmission> {
  const [created] = await db.insert(kycSubmissions).values(row).returning();
  return created!;
}

/**
 * Updates a request.
 *
 * Side effects: updates the `kyc_submissions` row.
 *
 * @param db the caller's transaction
 * @param id the request id
 * @param changes the columns to set
 * @returns the stored row
 */
export async function updateKyc(
  db: DbExecutor,
  id: number,
  changes: Partial<NewKycSubmission>,
): Promise<KycSubmission> {
  const [updated] = await db.update(kycSubmissions).set(changes).where(eq(kycSubmissions.id, id)).returning();
  return updated!;
}

/**
 * Reads a merchant and locks its row until the transaction ends.
 *
 * Why: submitting a request reads the verification status and then writes it; two submits of the same merchant must not both pass.
 *
 * @param db the caller's transaction
 * @param clientId the merchant
 * @returns the merchant, or `undefined`
 */
export async function lockClient(db: DbExecutor, clientId: number): Promise<Client | undefined> {
  const [row] = await db.select().from(clients).where(eq(clients.id, clientId)).limit(1).for('update');
  return row;
}

/**
 * Sets a merchant's verification status.
 *
 * Side effects: updates `clients.kyc_status`.
 *
 * @param db the caller's transaction
 * @param clientId the merchant
 * @param status the new status
 * @param now the clock's time
 */
export async function setClientKycStatus(
  db: DbExecutor,
  clientId: number,
  status: KycStatus,
  now: Date,
): Promise<void> {
  await db.update(clients).set({ kycStatus: status, updatedAt: now }).where(eq(clients.id, clientId));
}

/**
 * Reads a merchant's verification status.
 *
 * @param db the database or a transaction
 * @param clientId the merchant
 * @returns `clients.kyc_status`
 */
export async function clientKycStatus(db: DbExecutor, clientId: number): Promise<KycStatus> {
  const [row] = await db.select({ status: clients.kycStatus }).from(clients).where(eq(clients.id, clientId)).limit(1);
  return row?.status ?? 'none';
}

/** A merchant as the verification screen shows it. */
export interface KycClient {
  readonly id: number;
  readonly name: string;
  readonly email: string;
  readonly country: string;
  readonly status: string;
}

/**
 * Reads the merchants and reviewers around a page of requests.
 *
 * @param db the database or a transaction
 * @param clientIds the merchants
 * @param staffIds the reviewers
 * @returns the merchants and the reviewer names, by id
 */
export async function loadKycParties(
  db: DbExecutor,
  clientIds: readonly number[],
  staffIds: readonly number[],
): Promise<{ clients: Map<number, KycClient>; staff: Map<number, string> }> {
  const [clientRows, staffRows] = await Promise.all([
    clientIds.length === 0
      ? []
      : db
          .select({
            id: clients.id,
            name: clients.name,
            email: clients.email,
            country: clients.country,
            status: clients.status,
          })
          .from(clients)
          .where(inArray(clients.id, [...new Set(clientIds)])),
    staffIds.length === 0
      ? []
      : db
          .select({ id: staffUsers.id, name: staffUsers.name })
          .from(staffUsers)
          .where(and(inArray(staffUsers.id, [...new Set(staffIds)]))),
  ]);
  return {
    clients: new Map(clientRows.map((row) => [row.id, row])),
    staff: new Map(staffRows.map((row) => [row.id, row.name])),
  };
}

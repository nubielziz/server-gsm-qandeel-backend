// Drizzle queries of the merchant management routes on `clients` (identity module): the merchant with its referrer, the list,
// and the writes of creating, approving, suspending and moving a merchant. Groups, wallets and order figures are other modules'.
import { eq, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import type { ParsedListQuery } from '../../../common/contract';
import { type DbExecutor, type ListColumns, listOrderBy, listWhere } from '../../../infra/db';
import { type Client, type NewClient, clients } from '../db/schema';

const referrers = alias(clients, 'referrers');

/** A merchant with the merchant who referred it. */
export interface ClientRow {
  readonly client: Client;
  readonly referredBy: { readonly id: number; readonly name: string } | null;
}

const COLUMNS: ListColumns = {
  id: clients.id,
  status: clients.status,
  groupId: clients.groupId,
  name: clients.name,
  email: clients.email,
  company: clients.company,
  username: clients.username,
  country: clients.country,
  createdAt: clients.createdAt,
};

function selectRows(db: DbExecutor) {
  return db
    .select({ client: clients, referrerId: referrers.id, referrerName: referrers.name })
    .from(clients)
    .leftJoin(referrers, eq(referrers.id, clients.referredById));
}

function toRow(row: { client: Client; referrerId: number | null; referrerName: string | null }): ClientRow {
  return {
    client: row.client,
    referredBy: row.referrerId === null ? null : { id: row.referrerId, name: row.referrerName ?? '' },
  };
}

/**
 * Lists merchants for `GET /admin/clients`.
 *
 * @param db the database or a transaction
 * @param query the parsed list request
 * @returns the page of merchants and the exact total
 */
export async function listClientRows(
  db: DbExecutor,
  query: ParsedListQuery<'name' | 'status' | 'createdAt' | 'id'>,
): Promise<{ rows: ClientRow[]; total: number }> {
  const where = listWhere(query, COLUMNS);
  const [rows, [count]] = await Promise.all([
    selectRows(db)
      .where(where)
      .orderBy(...listOrderBy(query.sort, COLUMNS, clients.id))
      .limit(query.range.limit)
      .offset(query.range.start),
    db
      .select({ total: sql<number>`count(*)::int` })
      .from(clients)
      .where(where),
  ]);
  return { rows: rows.map(toRow), total: count?.total ?? 0 };
}

/**
 * Finds one merchant.
 *
 * @param db the database or a transaction
 * @param id the merchant id
 * @returns the merchant with its referrer, or `undefined`
 */
export async function findClientRow(db: DbExecutor, id: number): Promise<ClientRow | undefined> {
  const [row] = await selectRows(db).where(eq(clients.id, id)).limit(1);
  return row ? toRow(row) : undefined;
}

/**
 * Finds a merchant and locks the row for the rest of the transaction.
 *
 * Why: status changes read the status, check the transition and write; the lock keeps two staff members from approving and
 * suspending the same merchant at once.
 *
 * @param db the transaction
 * @param id the merchant id
 * @returns the merchant, or `undefined`
 */
export async function lockClient(db: DbExecutor, id: number): Promise<Client | undefined> {
  const [row] = await db.select().from(clients).where(eq(clients.id, id)).for('update').limit(1);
  return row;
}

/**
 * Tells whether a Dhru username is taken, ignoring case.
 *
 * @param db the database or a transaction
 * @param username the candidate
 * @returns true when a merchant has it
 */
export async function usernameTaken(db: DbExecutor, username: string): Promise<boolean> {
  const [row] = await db
    .select({ id: clients.id })
    .from(clients)
    .where(sql`lower(${clients.username}) = ${username.toLowerCase()}`)
    .limit(1);
  return row !== undefined;
}

/**
 * Inserts a merchant.
 *
 * @param db the database or a transaction
 * @param row the new merchant
 * @returns the stored merchant
 */
export async function insertClientRow(db: DbExecutor, row: NewClient): Promise<Client> {
  const [created] = await db.insert(clients).values(row).returning();
  return created!;
}

/**
 * Changes columns of a merchant.
 *
 * @param db the database or a transaction
 * @param id the merchant id
 * @param changes the columns to write
 * @returns the updated merchant
 */
export async function updateClientRow(
  db: DbExecutor,
  id: number,
  changes: Partial<NewClient>,
): Promise<Client | undefined> {
  const [row] = await db.update(clients).set(changes).where(eq(clients.id, id)).returning();
  return row;
}

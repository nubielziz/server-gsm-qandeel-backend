// Drizzle queries of the merchant management routes on `clients` (identity module): the merchant with its referrer, the list,
// and the writes of creating, approving, suspending and moving a merchant. Groups, wallets and order figures are other modules'.
import { eq, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import type { ParsedListQuery } from '../../../common/contract';
import { type DbExecutor, type ListColumns, listOrderBy, listWhere } from '../../../infra/db';
import { type Client, type NewClient, authTokens, clients, staffUsers } from '../db/schema';

const referrers = alias(clients, 'referrers');
const suspenders = alias(staffUsers, 'suspenders');

/** A merchant with the merchant who referred it, the staff member who suspended it and the age of its newest open links. */
export interface ClientRow {
  readonly client: Client;
  readonly referredBy: { readonly id: number; readonly name: string } | null;
  /** Who suspended the merchant; null when nobody did, or the staff member is gone. */
  readonly suspendedBy: { readonly id: number; readonly name: string } | null;
  /** `created_at` of the newest open (unused, unexpired) invite or reset link. */
  readonly linkSentAt: Date | null;
  /** `created_at` of the newest open `verify_email` link. */
  readonly verificationSentAt: Date | null;
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

/**
 * The newest `created_at` among the merchant's open links of some purposes: unused and not expired at `now`.
 *
 * Why: `security.linkSentAt` and `security.verificationSentAt` tell staff whether a link is still out there; the clock's `now` decides
 * expiry (decision 031). Served by `auth_tokens_subject_idx`.
 */
function newestOpenLink(purposes: readonly string[], now: Date) {
  const list = sql.join(
    purposes.map((purpose) => sql`${purpose}`),
    sql`, `,
  );
  return sql<Date | null>`(
    select max(${authTokens.createdAt}) from ${authTokens}
    where ${authTokens.subjectType} = 'client' and ${authTokens.subjectId} = ${clients.id}
      and ${authTokens.purpose} in (${list}) and ${authTokens.usedAt} is null
      and ${authTokens.expiresAt} > ${now.toISOString()}::timestamptz
  )`.mapWith(authTokens.createdAt);
}

function selectRows(db: DbExecutor, now: Date) {
  return db
    .select({
      client: clients,
      referrerId: referrers.id,
      referrerName: referrers.name,
      suspenderId: suspenders.id,
      suspenderName: suspenders.name,
      linkSentAt: newestOpenLink(['invite', 'reset'], now),
      verificationSentAt: newestOpenLink(['verify_email'], now),
    })
    .from(clients)
    .leftJoin(referrers, eq(referrers.id, clients.referredById))
    .leftJoin(suspenders, eq(suspenders.id, clients.suspendedBy));
}

function toRow(row: {
  client: Client;
  referrerId: number | null;
  referrerName: string | null;
  suspenderId: number | null;
  suspenderName: string | null;
  linkSentAt: Date | null;
  verificationSentAt: Date | null;
}): ClientRow {
  return {
    client: row.client,
    referredBy: row.referrerId === null ? null : { id: row.referrerId, name: row.referrerName ?? '' },
    suspendedBy: row.suspenderId === null ? null : { id: row.suspenderId, name: row.suspenderName ?? '' },
    linkSentAt: row.linkSentAt,
    verificationSentAt: row.verificationSentAt,
  };
}

/**
 * Lists merchants for `GET /admin/clients`.
 *
 * @param db the database or a transaction
 * @param query the parsed list request
 * @param now the current time (the injected clock): decides which links are still open
 * @returns the page of merchants and the exact total
 */
export async function listClientRows(
  db: DbExecutor,
  query: ParsedListQuery<'name' | 'status' | 'createdAt' | 'id'>,
  now: Date,
): Promise<{ rows: ClientRow[]; total: number }> {
  const where = listWhere(query, COLUMNS);
  const [rows, [count]] = await Promise.all([
    selectRows(db, now)
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
 * @param now the current time (the injected clock)
 * @returns the merchant with its referrer, suspender and open-link ages, or `undefined`
 */
export async function findClientRow(db: DbExecutor, id: number, now: Date): Promise<ClientRow | undefined> {
  const [row] = await selectRows(db, now).where(eq(clients.id, id)).limit(1);
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

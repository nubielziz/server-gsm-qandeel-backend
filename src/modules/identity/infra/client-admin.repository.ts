// Drizzle queries of the staff routes on accounts (`clients`, identity module): the union list with its filters and sorts, one account, and the
// writes of making, locking and changing an account row. Groups (ranks), wallets and order figures are other modules'; the order figures and
// the wallet balance reach the queries as SQL fragments the owners register with `AccountListSql`.
import { type SQL, eq, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import type { ParsedFilter, ParsedListQuery } from '../../../common/contract';
import { type DbExecutor, type ListColumns, listOrderBy, listWhere } from '../../../infra/db';
import { type Client, type NewClient, authTokens, clients, staffUsers } from '../db/schema';
import type { AccountListSql } from '../ports/account-list-sql';

const suspenders = alias(staffUsers, 'suspenders');
const creators = alias(staffUsers, 'creators');

/** The fields `GET /admin/clients` may sort by. */
export type AccountSortField =
  'name' | 'createdAt' | 'id' | 'status' | 'country' | 'rank' | 'ordersCount' | 'lastOrderAt' | 'balance';

/** A staff member as a row names one: id and display name. */
export interface PersonRow {
  readonly id: number;
  readonly name: string;
}

/** An account with the staff members it names, the age of its newest open links and its order figures. */
export interface ClientRow {
  readonly client: Client;
  /** Who suspended the account; null when nobody did, or the staff member is gone. */
  readonly suspendedBy: PersonRow | null;
  /** Who made the account; null for a self-made account and for accounts that existed before the column. */
  readonly createdBy: PersonRow | null;
  /** `created_at` of the newest open (unused, unexpired) invite or reset link. */
  readonly linkSentAt: Date | null;
  /** `created_at` of the newest open `verify_email` link. */
  readonly verificationSentAt: Date | null;
  /** Every order of the account, whatever the door and the status (the orders module's figure). */
  readonly ordersCount: number;
  /** `created_at` of the account's newest order, or null. */
  readonly lastOrderAt: Date | null;
}

/** What the list needs besides the request: the registry of SQL fragments and the two facts of the ranks a filter or a sort reads. */
export interface ListContext {
  /** The order figures and the wallet balance, as SQL on the account id. */
  readonly listSql: AccountListSql;
  /** The id of the retail rank: needed when the request filters by `rankKind`. */
  readonly retailGroupId?: number | undefined;
  /** The ids of every rank in rank order (`client_groups.sort`, then id): needed when the request sorts by `rank`. */
  readonly rankOrder?: readonly number[] | undefined;
}

/** The plain columns a wire field maps to; the sorts and filters that need other modules' figures are added per request. */
const COLUMNS = {
  id: clients.id,
  status: clients.status,
  rankId: clients.groupId,
  hasAccount: clients.hasAccount,
  name: clients.name,
  email: clients.email,
  company: clients.company,
  username: clients.username,
  country: clients.country,
  createdAt: clients.createdAt,
} as const satisfies ListColumns;

/** The filters that are not one column: they become their own conditions. */
const CONDITION_FILTERS: ReadonlySet<string> = new Set(['rankKind', 'invitationPending']);

/**
 * The condition of an invitation that waits: the account has a login, no password yet and may act.
 *
 * Why: `invitationPending` of the row, its filter and its count all mean this one thing; the status reading is `canAct` of
 * `identity/accounts/account-status.ts` (only `active` may act), written here as the column test SQL needs.
 */
export const INVITATION_PENDING_SQL: SQL = sql`(${clients.hasAccount} and ${clients.passwordHash} is null and ${clients.status} = 'active')`;

/**
 * The newest `created_at` among the account's open links of some purposes: unused and not expired at `now`.
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
    where ${authTokens.subjectType} = 'account' and ${authTokens.subjectId} = ${clients.id}
      and ${authTokens.purpose} in (${list}) and ${authTokens.usedAt} is null
      and ${authTokens.expiresAt} > ${now.toISOString()}::timestamptz
  )`.mapWith(authTokens.createdAt);
}

/** The id of the account row in a query, as the SQL the order and wallet fragments take. */
const accountIdColumn = sql`${clients.id}`;

/** The order count of the account; 0 when the account never ordered. */
function ordersCountSql(listSql: AccountListSql): SQL {
  return sql`coalesce((${listSql.orderFigure('ordersCount', accountIdColumn)}), 0)`;
}

/** The time of the account's newest order; null when none. */
function lastOrderAtSql(listSql: AccountListSql): SQL {
  return sql`(${listSql.orderFigure('lastOrderAt', accountIdColumn)})`;
}

function selectRows(db: DbExecutor, now: Date, listSql: AccountListSql) {
  return db
    .select({
      client: clients,
      suspenderId: suspenders.id,
      suspenderName: suspenders.name,
      creatorId: creators.id,
      creatorName: creators.name,
      linkSentAt: newestOpenLink(['invite', 'reset'], now),
      verificationSentAt: newestOpenLink(['verify_email'], now),
      ordersCount: sql<number>`(${ordersCountSql(listSql)})::int`,
      // The column only lends its decoder: the fragment is a timestamp the orders module computes.
      lastOrderAt: sql<Date | null>`${lastOrderAtSql(listSql)}`.mapWith(clients.createdAt),
    })
    .from(clients)
    .leftJoin(suspenders, eq(suspenders.id, clients.suspendedBy))
    .leftJoin(creators, eq(creators.id, clients.createdBy));
}

function toRow(row: {
  client: Client;
  suspenderId: number | null;
  suspenderName: string | null;
  creatorId: number | null;
  creatorName: string | null;
  linkSentAt: Date | null;
  verificationSentAt: Date | null;
  ordersCount: number;
  lastOrderAt: Date | null;
}): ClientRow {
  return {
    client: row.client,
    suspendedBy: row.suspenderId === null ? null : { id: row.suspenderId, name: row.suspenderName ?? '' },
    createdBy: row.creatorId === null ? null : { id: row.creatorId, name: row.creatorName ?? '' },
    linkSentAt: row.linkSentAt,
    verificationSentAt: row.verificationSentAt,
    ordersCount: row.ordersCount,
    lastOrderAt: row.lastOrderAt,
  };
}

/**
 * The `ORDER BY` expression of the `rank` sort: the position of the account's rank among all ranks.
 *
 * Why: ranks sort by their own `sort` number, then their id, and that column belongs to the catalog (identity reads no rank table), so
 * the catalog hands over the ids in rank order and this `CASE` turns the order into a number. An account whose rank is not in the list
 * (a rank made after the list was read) sorts after the others.
 *
 * @param order every rank id, in rank order
 * @returns a SQL expression that is an integer
 */
function rankPositionSql(order: readonly number[]): SQL {
  if (order.length === 0) return sql`0`;
  const branches = sql.join(
    order.map((groupId, position) => sql`when ${groupId}::bigint then ${position}::int`),
    sql` `,
  );
  return sql`(case ${clients.groupId} ${branches} else ${order.length}::int end)`;
}

/** `rankKind` of the request as a condition on the rank column: retail is the one retail rank, merchant is every other. */
function rankKindCondition(filter: ParsedFilter, retailGroupId: number | undefined): SQL | undefined {
  if (retailGroupId === undefined) throw new Error('A rankKind filter needs the id of the retail rank.');
  const wantsRetail = filter.values.includes('retail');
  const wantsMerchant = filter.values.includes('merchant');
  // Both kinds listed is every account.
  if (wantsRetail === wantsMerchant) return wantsRetail ? undefined : sql`false`;
  return wantsRetail ? sql`${clients.groupId} = ${retailGroupId}` : sql`${clients.groupId} <> ${retailGroupId}`;
}

/** `invitationPending` of the request: true keeps the waiting invitations, false everything else; both is no restriction. */
function invitationCondition(filter: ParsedFilter): SQL | undefined {
  const wantsPending = filter.values.includes(true);
  const wantsOthers = filter.values.includes(false);
  if (wantsPending === wantsOthers) return wantsPending ? undefined : sql`false`;
  return wantsPending ? INVITATION_PENDING_SQL : sql`not ${INVITATION_PENDING_SQL}`;
}

/** The wire-field to column map of one request: the plain columns plus the sorts that read other modules' figures. */
function sortColumns(query: ParsedListQuery<AccountSortField>, context: ListContext): ListColumns {
  const sorted = (field: AccountSortField): boolean => query.sort.some((key) => key.field === field);
  return {
    ...COLUMNS,
    rank: rankPositionSql(sorted('rank') ? requireRankOrder(context) : []),
    ordersCount: ordersCountSql(context.listSql),
    lastOrderAt: lastOrderAtSql(context.listSql),
    ...(sorted('balance') ? { balance: sql`(${context.listSql.walletBalance(accountIdColumn)})` } : {}),
  };
}

function requireRankOrder(context: ListContext): readonly number[] {
  if (context.rankOrder === undefined) throw new Error('A rank sort needs the ranks in rank order.');
  return context.rankOrder;
}

/**
 * Lists accounts for `GET /admin/clients`.
 *
 * @param db the database or a transaction
 * @param query the parsed list request
 * @param now the current time (the injected clock): decides which links are still open
 * @param context the SQL fragments of the other modules and the rank facts the request needs
 * @returns the page of accounts and the exact total
 * @throws {Error} when the request filters by `rankKind` or sorts by `rank` or `balance` and the context lacks what that needs (a programming error)
 */
export async function listClientRows(
  db: DbExecutor,
  query: ParsedListQuery<AccountSortField>,
  now: Date,
  context: ListContext,
): Promise<{ rows: ClientRow[]; total: number }> {
  const conditions = query.filters
    .filter((filter) => CONDITION_FILTERS.has(filter.field))
    .map((filter) =>
      filter.field === 'rankKind' ? rankKindCondition(filter, context.retailGroupId) : invitationCondition(filter),
    );
  const where = listWhere(
    { filters: query.filters.filter((filter) => !CONDITION_FILTERS.has(filter.field)), search: query.search },
    COLUMNS,
    ...conditions,
  );
  const [rows, [count]] = await Promise.all([
    selectRows(db, now, context.listSql)
      .where(where)
      .orderBy(...listOrderBy(query.sort, sortColumns(query, context), clients.id))
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
 * Finds one account.
 *
 * @param db the database or a transaction
 * @param id the account id
 * @param now the current time (the injected clock)
 * @param listSql the registry of the order figure fragments
 * @returns the account with the staff members it names, its open-link ages and its order figures, or `undefined`
 */
export async function findClientRow(
  db: DbExecutor,
  id: number,
  now: Date,
  listSql: AccountListSql,
): Promise<ClientRow | undefined> {
  const [row] = await selectRows(db, now, listSql).where(eq(clients.id, id)).limit(1);
  return row ? toRow(row) : undefined;
}

/**
 * Finds an account and locks the row for the rest of the transaction.
 *
 * Why: status changes read the status, check the transition and write; the lock keeps two staff members from changing the same account at
 * once.
 *
 * @param db the transaction
 * @param id the account id
 * @returns the account, or `undefined`
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
 * @returns true when an account has it
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
 * Inserts an account.
 *
 * @param db the database or a transaction
 * @param row the new account
 * @returns the stored account
 */
export async function insertClientRow(db: DbExecutor, row: NewClient): Promise<Client> {
  const [created] = await db.insert(clients).values(row).returning();
  return created!;
}

/**
 * Changes columns of an account.
 *
 * @param db the database or a transaction
 * @param id the account id
 * @param changes the columns to write
 * @returns the updated account
 */
export async function updateClientRow(
  db: DbExecutor,
  id: number,
  changes: Partial<NewClient>,
): Promise<Client | undefined> {
  const [row] = await db.update(clients).set(changes).where(eq(clients.id, id)).returning();
  return row;
}

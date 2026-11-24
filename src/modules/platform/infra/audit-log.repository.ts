// Drizzle queries of the audit log routes on `audit_logs` (platform module). The table is append-only: these are reads only;
// the writes are `AuditService.record`.
import { type SQL, eq, inArray, or, and, sql } from 'drizzle-orm';
import type { AnyColumn } from 'drizzle-orm';
import type { ParsedFilter, ParsedListQuery } from '../../../common/contract';
import { type DbExecutor, type ListColumns, listOrderBy, listWhere } from '../../../infra/db';
import { ACCOUNT_ACTOR_WORDS, ACCOUNT_ENTITY_WORDS } from '../audit/audit-entity-types';
import { type AuditLog, auditLogs } from '../db/schema';
import { identity } from './identity-access';

/**
 * Wire field to column. `accountId` has no column (an account is a set of stored pairs): {@link splitAccountFilters} turns it into a
 * condition, and does the same for `entityType` and `actorType` when they ask for `account`.
 */
const COLUMNS: ListColumns = {
  actorType: auditLogs.actorType,
  actorId: auditLogs.actorId,
  entityType: auditLogs.entityType,
  entityId: auditLogs.entityId,
  actorName: auditLogs.actorName,
  action: auditLogs.action,
  entityLabel: auditLogs.entityLabel,
  createdAt: auditLogs.createdAt,
  id: auditLogs.id,
};

const DAY_MS = 86_400_000;

/** An audit row and the account it is about. */
export interface AuditRowWithAccount {
  readonly log: AuditLog;
  /** The account id the row stands for (see {@link accountOfRowSql}); `null` when neither the record nor the actor is an account. */
  readonly accountId: number | null;
}

/** The two halves of an audit pair: the type column and the id column. */
interface PairColumns {
  readonly type: AnyColumn;
  readonly id: AnyColumn;
}

const ENTITY_PAIR: PairColumns = { type: auditLogs.entityType, id: auditLogs.entityId };
const ACTOR_PAIR: PairColumns = { type: auditLogs.actorType, id: auditLogs.actorId };

/** The numbers of a filter's values (an `id` filter parses to numbers). */
function idsOf(filter: ParsedFilter | undefined): number[] {
  return (filter?.values ?? []).map((value) => Number(value));
}

/** The first `eq` filter of a wire field (the contract allows nothing else on these fields). */
function filterOf(filters: readonly ParsedFilter[], field: string): ParsedFilter | undefined {
  return filters.find((filter) => filter.field === field && filter.op === 'eq');
}

/**
 * Rewrites the filter of one stored pair when it asks for `account`.
 *
 * Why: decision 064. Rows written before the accounts were merged say `merchant` or `customer` (or `client` for an actor), and a
 * customer's number is not the account id. The type `account` therefore reads three words, and `account` with an id reads the rows of that one
 * account through `accountHistorySql` (its own pairs, its old merchant number, its old customer numbers), never another person's. Any other
 * type value filters exactly as before; `account` next to another type is read as either.
 *
 * @param filters the parsed filters
 * @param typeField the wire field of the type column (`entityType` or `actorType`)
 * @param idField the wire field of the id column (`entityId` or `actorId`)
 * @param pair the two columns
 * @param words the stored words that mean an account in this column
 * @param history builds the predicate of one account's rows (`accountHistorySql`)
 * @returns the filters that stay plain and the condition that replaces the two fields (`undefined` when the request did not ask for `account`)
 */
function accountPair(
  filters: readonly ParsedFilter[],
  typeField: string,
  idField: string,
  pair: PairColumns,
  words: readonly string[],
  history: (type: SQL, id: SQL, accountId: number) => SQL,
): { rest: readonly ParsedFilter[]; condition: SQL | undefined } {
  const types = (filterOf(filters, typeField)?.values ?? []).map(String);
  if (!types.includes('account')) return { rest: filters, condition: undefined };
  const ids = idsOf(filterOf(filters, idField));
  const others = types.filter((type) => type !== 'account');
  const asAccount =
    ids.length === 0
      ? inArray(pair.type, [...words])
      : or(...ids.map((id) => history(sql`${pair.type}`, sql`${pair.id}`, id)));
  const asOther =
    others.length === 0
      ? undefined
      : and(inArray(pair.type, others), ids.length === 0 ? undefined : inArray(pair.id, ids));
  const condition = asOther === undefined ? asAccount : or(asAccount, asOther);
  return { rest: filters.filter((filter) => filter.field !== typeField && filter.field !== idField), condition };
}

/**
 * Splits the account conditions off a list request.
 *
 * Why: the audit tab of an account asks for `accountId` (or `entityType=account&entityId=<id>`); both mean "every row about this account, under
 * whichever word it was written", which a plain column filter cannot say.
 *
 * @param filters the parsed filters of the request
 * @returns the plain filters and the account conditions (all of them must hold)
 */
async function splitAccountFilters(
  filters: readonly ParsedFilter[],
): Promise<{ rest: readonly ParsedFilter[]; conditions: SQL[] }> {
  const { accountHistorySql } = await identity();
  const conditions: SQL[] = [];
  let rest: readonly ParsedFilter[] = filters.filter((filter) => filter.field !== 'accountId');
  const accountIds = idsOf(filterOf(filters, 'accountId'));
  if (accountIds.length > 0) {
    const history = or(
      ...accountIds.map((id) => accountHistorySql(sql`${ENTITY_PAIR.type}`, sql`${ENTITY_PAIR.id}`, id)),
    );
    if (history) conditions.push(history);
  }
  const entity = accountPair(rest, 'entityType', 'entityId', ENTITY_PAIR, ACCOUNT_ENTITY_WORDS, accountHistorySql);
  rest = entity.rest;
  if (entity.condition) conditions.push(entity.condition);
  const actor = accountPair(rest, 'actorType', 'actorId', ACTOR_PAIR, ACCOUNT_ACTOR_WORDS, accountHistorySql);
  rest = actor.rest;
  if (actor.condition) conditions.push(actor.condition);
  return { rest, conditions };
}

/**
 * The SQL expression of the account a row is about.
 *
 * Why: decision 064. The console links an old row to an account without guessing: the record's account when the record is an
 * account (`account`, `merchant`, or `customer` through the legacy map), else the account that acted (`account`, `client`, `customer`), else
 * `NULL` (staff, system, an unknown pair: shown as no link, never as another account).
 *
 * @returns an expression that gives the account id or `NULL`
 */
async function accountOfRowSql(): Promise<SQL<string | number | null>> {
  const { legacyAccountIdSql } = await identity();
  return sql`coalesce(${legacyAccountIdSql(sql`${ENTITY_PAIR.type}`, sql`${ENTITY_PAIR.id}`)}, ${legacyAccountIdSql(sql`${ACTOR_PAIR.type}`, sql`${ACTOR_PAIR.id}`)})`;
}

/**
 * Lists audit entries for `GET /admin/audit-logs`.
 *
 * @param db the database or a transaction
 * @param query the parsed list request, with the `from` and `to` days (UTC, both included); `accountId`, or `account` as the entity or actor type, reads
 *   one account's rows under every word they were written with
 * @returns the page of entries (each with the account it is about) and the exact total for the filter
 */
export async function listAuditRows(
  db: DbExecutor,
  query: ParsedListQuery<'createdAt' | 'id', { from?: string | undefined; to?: string | undefined }>,
): Promise<{ rows: AuditRowWithAccount[]; total: number }> {
  const { from, to } = query.extra;
  const split = await splitAccountFilters(query.filters);
  // `to` is a whole day: everything before the start of the next day.
  const where = listWhere(
    { filters: split.rest, search: query.search },
    COLUMNS,
    from === undefined ? undefined : sql`${auditLogs.createdAt} >= ${new Date(`${from}T00:00:00.000Z`)}`,
    to === undefined
      ? undefined
      : sql`${auditLogs.createdAt} < ${new Date(Date.parse(`${to}T00:00:00.000Z`) + DAY_MS)}`,
    ...split.conditions,
  );
  const account = await accountOfRowSql();
  const [rows, [count]] = await Promise.all([
    db
      .select({ log: auditLogs, accountId: account })
      .from(auditLogs)
      .where(where)
      .orderBy(...listOrderBy(query.sort, COLUMNS, auditLogs.id))
      .limit(query.range.limit)
      .offset(query.range.start),
    db
      .select({ total: sql<number>`count(*)::int` })
      .from(auditLogs)
      .where(where),
  ]);
  return { rows: rows.map(withAccount), total: count?.total ?? 0 };
}

function withAccount(row: { log: AuditLog; accountId: string | number | null }): AuditRowWithAccount {
  return { log: row.log, accountId: row.accountId === null ? null : Number(row.accountId) };
}

/**
 * Finds one audit entry.
 *
 * @param db the database or a transaction
 * @param id the entry id
 * @returns the entry with the account it is about, or `undefined`
 */
export async function findAuditRow(db: DbExecutor, id: number): Promise<AuditRowWithAccount | undefined> {
  const account = await accountOfRowSql();
  const [row] = await db
    .select({ log: auditLogs, accountId: account })
    .from(auditLogs)
    .where(eq(auditLogs.id, id))
    .limit(1);
  return row === undefined ? undefined : withAccount(row);
}

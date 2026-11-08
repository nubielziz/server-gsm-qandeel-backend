// Drizzle queries on `imei_checks` for the staff log (GET /admin/imei-checks), the retention job and the erasure of a customer's
// checks. The names and the order the log shows come from `foreign-reads.repository.ts`: this file names no other module's table.
import { type SQL, and, eq, inArray, isNotNull, lt, or, sql } from 'drizzle-orm';
import type { ParsedListQuery } from '../../../common/contract';
import { type DbExecutor, type ListColumns, listOrderBy, listWhere } from '../../../infra/db';
import { type ImeiCheck, imeiChecks } from '../db/schema';
import { checkLinks, checkoutSessionIdsOfCustomer } from './foreign-reads.repository';

/** The sort fields of the IMEI log. */
export type ImeiCheckSortField = 'model' | 'checkType' | 'status' | 'createdAt';

const COLUMNS: ListColumns = {
  model: imeiChecks.model,
  brand: imeiChecks.brand,
  checkType: imeiChecks.checkType,
  status: imeiChecks.status,
  source: imeiChecks.source,
  createdAt: imeiChecks.createdAt,
};

/** A check with the names the log joins. */
export interface ImeiCheckRow {
  readonly check: ImeiCheck;
  readonly orderId: number | null;
  readonly customerName: string | null;
  readonly supplierName: string | null;
}

/** Adds the order and the names the log shows to a page of checks. */
async function withLinks(db: DbExecutor, checks: readonly ImeiCheck[]): Promise<ImeiCheckRow[]> {
  const links = await checkLinks(db, checks);
  return checks.map((check) => ({
    check,
    orderId: check.checkoutSessionId === null ? null : (links.orderOfSession.get(check.checkoutSessionId) ?? null),
    customerName: check.customerId === null ? null : (links.customerNames.get(check.customerId) ?? null),
    supplierName: check.supplierId === null ? null : (links.supplierNames.get(check.supplierId) ?? null),
  }));
}

/** How the free-text search was understood. */
export interface ImeiSearch {
  /** The condition to add to the list, or `undefined` for no search. */
  readonly condition: SQL | undefined;
}

/**
 * Lists the IMEI checks.
 *
 * @param db the database or a transaction
 * @param query the parsed list request; its `search` is replaced by `search.condition` (an IMEI cannot be searched as text)
 * @param search the condition made from `q`
 * @returns the page and the exact total
 */
export async function listImeiCheckRows(
  db: DbExecutor,
  query: ParsedListQuery<ImeiCheckSortField>,
  search: ImeiSearch,
): Promise<{ rows: ImeiCheckRow[]; total: number }> {
  const where = listWhere({ filters: query.filters, search: undefined }, COLUMNS, search.condition);
  const [checks, [count]] = await Promise.all([
    db
      .select()
      .from(imeiChecks)
      .where(where)
      .orderBy(...listOrderBy(query.sort, COLUMNS, imeiChecks.id))
      .limit(query.range.limit)
      .offset(query.range.start),
    db
      .select({ total: sql<number>`count(*)::int` })
      .from(imeiChecks)
      .where(where),
  ]);
  return { rows: await withLinks(db, checks), total: count?.total ?? 0 };
}

/**
 * Finds one check with the joined names.
 *
 * @param db the database or a transaction
 * @param id the check id
 * @returns the row, or `undefined`
 */
export async function findImeiCheckRow(db: DbExecutor, id: number): Promise<ImeiCheckRow | undefined> {
  const [check] = await db.select().from(imeiChecks).where(eq(imeiChecks.id, id)).limit(1);
  return check === undefined ? undefined : (await withLinks(db, [check]))[0];
}

/**
 * Builds the search condition of `q`.
 *
 * Why: RESOLUTIONS b2c-3, B78: an IMEI is stored as ciphertext and a keyed hash, so it cannot be searched as text. 15 digits match
 * the hash; 8 to 14 digits match the TAC (its first 8); fewer digits match a TAC prefix; any other text matches the brand or the
 * model, case-insensitively.
 *
 * @param text the search text as typed
 * @param imeiHash a function that gives the keyed hash of an IMEI
 * @returns the condition
 */
export function imeiSearchCondition(text: string, imeiHash: (imei: string) => string): SQL {
  const digits = text.replace(/[\s-]/g, '');
  if (/^\d+$/.test(digits)) {
    if (digits.length === 15) return sql`${imeiChecks.imeiHash} = ${imeiHash(digits)}`;
    if (digits.length >= 8) return sql`${imeiChecks.tac} = ${digits.slice(0, 8)}`;
    return sql`${imeiChecks.tac} like ${`${digits}%`}`;
  }
  const pattern = `%${text.replace(/[\\%_]/g, '\\$&')}%`;
  return sql`(${imeiChecks.brand} ilike ${pattern} or ${imeiChecks.model} ilike ${pattern})`;
}

/**
 * Erases the IMEI of the checks older than a cutoff.
 *
 * Why: RESOLUTIONS b2c-4: erasure nulls `imei_enc`, `imei_hash` and `cached_until` together (the table's CHECK keeps the first two
 * together); the retention job runs it for `imeiRetentionDays`. Batched by id so a long backlog does not lock the table.
 *
 * @param db the database or a transaction
 * @param cutoff checks created before this time lose their IMEI
 * @param now the clock's time, written as `updated_at`
 * @param limit the batch size
 * @returns how many checks were erased
 */
export async function eraseChecksOlderThan(db: DbExecutor, cutoff: Date, now: Date, limit: number): Promise<number> {
  const batch = db
    .select({ id: imeiChecks.id })
    .from(imeiChecks)
    .where(and(isNotNull(imeiChecks.imeiEnc), lt(imeiChecks.createdAt, cutoff)))
    .orderBy(imeiChecks.id)
    .limit(limit);
  const rows = await db
    .update(imeiChecks)
    .set({ imeiEnc: null, imeiHash: null, cachedUntil: null, updatedAt: now })
    .where(inArray(imeiChecks.id, batch))
    .returning({ id: imeiChecks.id });
  return rows.length;
}

/**
 * Erases the IMEI and the address of every check of one customer.
 *
 * Why: anonymization (B50, RESOLUTIONS b2c-4): the checks the customer made while signed in, or from a checkout session of theirs,
 * lose `imei_enc`, `imei_hash` and `cached_until` together; the address goes too (personal data), the brand, model and result stay.
 *
 * @param db the caller's transaction
 * @param customerId the customer
 * @param now the clock's time, written as `updated_at`
 * @returns how many checks were changed
 */
export async function eraseChecksOfCustomer(db: DbExecutor, customerId: number, now: Date): Promise<number> {
  const sessionIds = await checkoutSessionIdsOfCustomer(db, customerId);
  const ofCustomer =
    sessionIds.length === 0
      ? eq(imeiChecks.customerId, customerId)
      : or(eq(imeiChecks.customerId, customerId), inArray(imeiChecks.checkoutSessionId, sessionIds));
  const rows = await db
    .update(imeiChecks)
    .set({ imeiEnc: null, imeiHash: null, cachedUntil: null, ip: null, updatedAt: now })
    .where(and(ofCustomer, or(isNotNull(imeiChecks.imeiEnc), isNotNull(imeiChecks.ip))))
    .returning({ id: imeiChecks.id });
  return rows.length;
}

/**
 * Tells whether an earlier check of an IMEI said blacklisted.
 *
 * Why: the score's signal "IMEI was checked blacklisted before" and the rule that blocks a blacklisted IMEI read our own record of
 * checks (no supplier call is made at payment time).
 *
 * @param db the database or a transaction
 * @param imeiHash the keyed hash of the IMEI
 * @returns true when a stored check of that IMEI has status `blacklisted`
 */
export async function wasCheckedBlacklisted(db: DbExecutor, imeiHash: string): Promise<boolean> {
  const [row] = await db
    .select({ id: imeiChecks.id })
    .from(imeiChecks)
    .where(and(eq(imeiChecks.imeiHash, imeiHash), eq(imeiChecks.status, 'blacklisted')))
    .limit(1);
  return row !== undefined;
}

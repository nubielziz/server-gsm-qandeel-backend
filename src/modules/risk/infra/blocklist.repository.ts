// Drizzle queries on `blocklist_entries` (risk module): the staff list, one entry, the writes of the routes and of the customer block,
// and the match against a set of values at checkout.
import { and, eq, inArray, sql } from 'drizzle-orm';
import type { ParsedListQuery } from '../../../common/contract';
import { type DbExecutor, type ListColumns, listOrderBy, listWhere, schema as s } from '../../../infra/db';
import { type BlocklistEntry, type BlocklistKind, type NewBlocklistEntry, blocklistEntries } from '../db/schema';

/** The sort fields of the blocklist. */
export type BlocklistSortField = 'kind' | 'display' | 'createdAt';

const COLUMNS: ListColumns = {
  kind: blocklistEntries.kind,
  display: blocklistEntries.display,
  reason: blocklistEntries.reason,
  createdAt: blocklistEntries.createdAt,
};

/** An entry with the name of the staff member who added it. */
export interface BlocklistRow {
  readonly entry: BlocklistEntry;
  readonly createdByName: string | null;
}

function selectRows(db: DbExecutor) {
  return db
    .select({ entry: blocklistEntries, createdByName: s.staffUsers.name })
    .from(blocklistEntries)
    .leftJoin(s.staffUsers, eq(s.staffUsers.id, blocklistEntries.createdBy));
}

/**
 * Lists the blocklist.
 *
 * @param db the database or a transaction
 * @param query the parsed list request (`kind` filter; `q` searches display and reason)
 * @returns the page and the exact total
 */
export async function listBlocklistRows(
  db: DbExecutor,
  query: ParsedListQuery<BlocklistSortField>,
): Promise<{ rows: BlocklistRow[]; total: number }> {
  const where = listWhere(query, COLUMNS);
  const [rows, [count]] = await Promise.all([
    selectRows(db)
      .where(where)
      .orderBy(...listOrderBy(query.sort, COLUMNS, blocklistEntries.id))
      .limit(query.range.limit)
      .offset(query.range.start),
    db
      .select({ total: sql<number>`count(*)::int` })
      .from(blocklistEntries)
      .where(where),
  ]);
  return { rows, total: count?.total ?? 0 };
}

/**
 * Finds one entry with its author's name.
 *
 * @param db the database or a transaction
 * @param id the entry id
 * @returns the entry row, or `undefined`
 */
export async function findBlocklistRow(db: DbExecutor, id: number): Promise<BlocklistRow | undefined> {
  const [row] = await selectRows(db).where(eq(blocklistEntries.id, id)).limit(1);
  return row;
}

/**
 * Adds entries, skipping any whose kind and value already exist.
 *
 * Why: RESOLUTIONS b2c-5: `ON CONFLICT (kind, value_hash) DO NOTHING`. An existing entry (from a risk refund, a chargeback, a manual
 * add or another customer's block) is kept unchanged and not linked to this customer.
 *
 * @param db the caller's transaction
 * @param rows the entries to add
 * @returns the entries that were new
 */
export async function insertEntriesIgnoringDuplicates(
  db: DbExecutor,
  rows: readonly NewBlocklistEntry[],
): Promise<BlocklistEntry[]> {
  if (rows.length === 0) return [];
  return db
    .insert(blocklistEntries)
    .values([...rows])
    .onConflictDoNothing({ target: [blocklistEntries.kind, blocklistEntries.valueHash] })
    .returning();
}

/**
 * Deletes one entry.
 *
 * @param db the caller's transaction
 * @param id the entry id
 * @returns the deleted row, or `undefined` when none had that id
 */
export async function deleteEntry(db: DbExecutor, id: number): Promise<BlocklistEntry | undefined> {
  const [row] = await db.delete(blocklistEntries).where(eq(blocklistEntries.id, id)).returning();
  return row;
}

/**
 * Deletes the manual entries one customer's block added.
 *
 * Why: RESOLUTIONS b2c-5: unblocking lifts only what the block added: `WHERE customer_id = :id AND source = 'manual'`.
 *
 * @param db the caller's transaction
 * @param customerId the customer
 * @returns the deleted entries
 */
export async function deleteManualEntriesOfCustomer(db: DbExecutor, customerId: number): Promise<BlocklistEntry[]> {
  return db
    .delete(blocklistEntries)
    .where(and(eq(blocklistEntries.customerId, customerId), eq(blocklistEntries.source, 'manual')))
    .returning();
}

/** A value to look up. */
export interface HashProbe {
  readonly kind: BlocklistKind;
  readonly valueHash: string;
}

/**
 * Finds the entries that match any of the probes and have not expired.
 *
 * @param db the database or a transaction
 * @param probes the (kind, hash) pairs to look up
 * @param now the clock's time (decision 031): an entry past its `expires_at` does not count
 * @returns the matching entries
 */
export async function findLiveMatches(
  db: DbExecutor,
  probes: readonly HashProbe[],
  now: Date,
): Promise<BlocklistEntry[]> {
  if (probes.length === 0) return [];
  const hashes = [...new Set(probes.map((probe) => probe.valueHash))];
  const rows = await db
    .select()
    .from(blocklistEntries)
    .where(
      and(
        inArray(blocklistEntries.valueHash, hashes),
        sql`(${blocklistEntries.expiresAt} is null or ${blocklistEntries.expiresAt} > ${now})`,
      ),
    );
  // The hash index is by value; the kind must match the probe's kind too.
  return rows.filter((row) => probes.some((probe) => probe.kind === row.kind && probe.valueHash === row.valueHash));
}

// Drizzle queries of `retail_price_changes` (decision 040, feature 31, plan 31 sections 3.4, 5.4 and 6.4): the row of every automatic
// change and proposal, the waiting proposal of a service, the list of the console, and what the hourly message reads and marks.
import { and, count, eq, gt, inArray, isNull, or, sql } from 'drizzle-orm';
import type { ParsedListQuery } from '../../../common/contract';
import { type DbExecutor, type ListColumns, listOrderBy, listWhere } from '../../../infra/db';
import {
  type NewRetailPriceChange,
  type RetailChangeReason,
  type RetailChangeResolution,
  type RetailPriceChange,
  retailPriceChanges,
  services,
} from '../db/schema';

/** The sorts of `GET /admin/retail-price-changes`. */
export type RetailChangeSort = 'id' | 'createdAt';

/** A change with the name and code of its service. */
export interface RetailChangeRow {
  readonly change: RetailPriceChange;
  readonly serviceName: string;
  readonly serviceCode: string;
}

/** The figures of a proposal that a rewrite replaces. */
export interface ProposalFigures {
  readonly ruleId: number | null;
  readonly reason: RetailChangeReason;
  readonly oldPrice: string;
  readonly newPrice: string | null;
  readonly oldCost: string;
  readonly newCost: string;
}

/** How a proposal is closed. */
export interface ProposalClosing {
  readonly resolution: RetailChangeResolution;
  readonly resolvedAt: Date;
  /** The staff member who resolved it; `null` when the system closed it. */
  readonly resolvedBy: number | null;
}

/** A row the hourly message reports. */
export interface NotifiedChange {
  readonly id: number;
  readonly kind: RetailPriceChange['kind'];
  readonly resolvedAt: Date | null;
}

/** The lock of the hourly message: passes running side by side send it once. */
const NOTICE_LOCK_NAME = 'retail-follow-notice';

/** A proposal nobody resolved: the rows of `retail_price_changes_open_uq`. */
const isWaiting = and(eq(retailPriceChanges.kind, 'proposed'), isNull(retailPriceChanges.resolvedAt));

const FILTER_COLUMNS: ListColumns = {
  kind: retailPriceChanges.kind,
  serviceId: retailPriceChanges.serviceId,
  waiting: sql<boolean>`(${isWaiting})`,
};

const SORT_COLUMNS: ListColumns = {
  id: retailPriceChanges.id,
  createdAt: retailPriceChanges.createdAt,
};

/**
 * Inserts a change.
 *
 * @param db the caller's transaction (the service row is locked)
 * @param row the change
 * @returns the stored row
 */
export async function insertRetailChange(db: DbExecutor, row: NewRetailPriceChange): Promise<RetailPriceChange> {
  const [created] = await db.insert(retailPriceChanges).values(row).returning();
  return created!;
}

/**
 * Finds a change by id.
 *
 * @param db the database or a transaction
 * @param id the change id
 * @returns the row, or `undefined`
 */
export async function findRetailChange(db: DbExecutor, id: number): Promise<RetailPriceChange | undefined> {
  const [row] = await db.select().from(retailPriceChanges).where(eq(retailPriceChanges.id, id)).limit(1);
  return row;
}

/**
 * Finds the waiting proposal of a service and locks it for the rest of the transaction.
 *
 * @param db the caller's transaction (the service row is locked)
 * @param serviceId the service
 * @returns the proposal, or `undefined` when none waits
 */
export async function lockWaitingProposal(db: DbExecutor, serviceId: number): Promise<RetailPriceChange | undefined> {
  const [row] = await db
    .select()
    .from(retailPriceChanges)
    .where(and(eq(retailPriceChanges.serviceId, serviceId), isWaiting))
    .limit(1)
    .for('update');
  return row;
}

/**
 * Reads the waiting proposals of several services.
 *
 * @param db the database or a transaction
 * @param serviceIds the services
 * @returns the proposals by service id (a service with none is absent)
 */
export async function waitingProposalsOf(
  db: DbExecutor,
  serviceIds: readonly number[],
): Promise<Map<number, RetailPriceChange>> {
  const unique = [...new Set(serviceIds)];
  if (unique.length === 0) return new Map();
  const rows = await db
    .select()
    .from(retailPriceChanges)
    .where(and(inArray(retailPriceChanges.serviceId, unique), isWaiting));
  return new Map(rows.map((row) => [row.serviceId, row]));
}

/**
 * Writes new figures on a waiting proposal; its `notified_at` stays, so the hourly message does not report it again.
 *
 * @param db the caller's transaction (the proposal is locked)
 * @param id the proposal
 * @param figures what it shows now
 */
export async function rewriteProposal(db: DbExecutor, id: number, figures: ProposalFigures): Promise<void> {
  await db
    .update(retailPriceChanges)
    .set(figures)
    .where(and(eq(retailPriceChanges.id, id), isWaiting));
}

/**
 * Closes a waiting proposal.
 *
 * @param db the caller's transaction (the proposal is locked)
 * @param id the proposal
 * @param closing how it closes
 */
export async function closeProposal(db: DbExecutor, id: number, closing: ProposalClosing): Promise<void> {
  await db
    .update(retailPriceChanges)
    .set(closing)
    .where(and(eq(retailPriceChanges.id, id), isWaiting));
}

/**
 * Closes the waiting proposal of a service, if one waits, as no longer needed.
 *
 * @param db the caller's transaction (the service row is locked)
 * @param serviceId the service
 * @param at the clock's time
 */
export async function supersedeWaitingProposal(db: DbExecutor, serviceId: number, at: Date): Promise<void> {
  await db
    .update(retailPriceChanges)
    .set({ resolution: 'superseded', resolvedAt: at })
    .where(and(eq(retailPriceChanges.serviceId, serviceId), isWaiting));
}

/**
 * Lists the changes for `GET /admin/retail-price-changes`.
 *
 * @param db the database or a transaction
 * @param query the parsed list request (`kind`, `waiting` and `serviceId` filters, `id` and `createdAt` sorts, range)
 * @returns the page and the exact total
 */
export async function listRetailChangeRows(
  db: DbExecutor,
  query: ParsedListQuery<RetailChangeSort>,
): Promise<{ rows: RetailChangeRow[]; total: number }> {
  const where = listWhere(query, FILTER_COLUMNS);
  const [rows, [total]] = await Promise.all([
    db
      .select({ change: retailPriceChanges, serviceName: services.name, serviceCode: services.code })
      .from(retailPriceChanges)
      .innerJoin(services, eq(services.id, retailPriceChanges.serviceId))
      .where(where)
      .orderBy(...listOrderBy(query.sort, SORT_COLUMNS, retailPriceChanges.id))
      .limit(query.range.limit)
      .offset(query.range.start),
    db.select({ total: count() }).from(retailPriceChanges).where(where),
  ]);
  return { rows, total: total?.total ?? 0 };
}

/**
 * Takes the lock of the hourly message for the rest of the transaction.
 *
 * Why: plan 31 section 6.4: at most one message an hour. "Was one sent lately?" and the marking must be one step, or two passes that
 * end together would each send one.
 *
 * Side effects: holds `pg_advisory_xact_lock(hashtextextended('retail-follow-notice', 0))` until the transaction ends.
 *
 * @param db the caller's transaction
 */
export async function lockRetailNotice(db: DbExecutor): Promise<void> {
  await db.execute(sql`select pg_advisory_xact_lock(hashtextextended(${NOTICE_LOCK_NAME}, 0))`);
}

/**
 * Tells whether a change waits to be reported by the hourly message.
 *
 * @param db the database or a transaction
 * @returns true when at least one row has no `notified_at`
 */
export async function hasUnnotifiedChange(db: DbExecutor): Promise<boolean> {
  const [row] = await db
    .select({ id: retailPriceChanges.id })
    .from(retailPriceChanges)
    .where(isNull(retailPriceChanges.notifiedAt))
    .limit(1);
  return row !== undefined;
}

/**
 * Tells whether the hourly message went out after a moment.
 *
 * Why: plan 31 section 6.4: at most one message an hour, and a marking that told nobody anything is no message. A proposal closed before
 * it was marked counts for nothing in the message, so it does not count here (`resolved_at` not after `notified_at`), or a marking of
 * nothing but such rows would hold back the next message for an hour. A proposal a message reported while it waited closes after it.
 *
 * @param db the database or a transaction
 * @param since the moment
 * @returns true when a row a message reported was marked after it
 */
export async function notifiedSince(db: DbExecutor, since: Date): Promise<boolean> {
  const [row] = await db
    .select({ id: retailPriceChanges.id })
    .from(retailPriceChanges)
    .where(
      and(
        gt(retailPriceChanges.notifiedAt, since),
        // Only a proposal ever has `resolved_at` (the CHECK of the table).
        or(isNull(retailPriceChanges.resolvedAt), gt(retailPriceChanges.resolvedAt, retailPriceChanges.notifiedAt)),
      ),
    )
    .limit(1);
  return row !== undefined;
}

/**
 * Marks every row the hourly message has not reported yet.
 *
 * @param db the caller's transaction (holds the lock of the message)
 * @param at the clock's time
 * @returns the rows it marked, lowest id first
 */
export async function markChangesNotified(db: DbExecutor, at: Date): Promise<NotifiedChange[]> {
  const rows = await db
    .update(retailPriceChanges)
    .set({ notifiedAt: at })
    .where(isNull(retailPriceChanges.notifiedAt))
    .returning({
      id: retailPriceChanges.id,
      kind: retailPriceChanges.kind,
      resolvedAt: retailPriceChanges.resolvedAt,
    });
  return rows.sort((a, b) => a.id - b.id);
}

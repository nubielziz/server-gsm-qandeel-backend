// Drizzle queries on `supplier_api_logs` (stage 6): write one row per supplier call, list the rows for the console, read one with its
// bodies. The table is an immutable log: rows are inserted and never changed.
import { eq, sql } from 'drizzle-orm';
import type { ParsedListQuery } from '../../../common/contract';
import { type DbExecutor, type ListColumns, listOrderBy, listWhere } from '../../../infra/db';
import { type NewSupplierApiLog, type SupplierApiLog, supplierApiLogs } from '../db/schema';

/** The list fields `GET /admin/supplier-api-logs` can sort on. */
export type SupplierLogListField = 'createdAt' | 'id' | 'durationMs' | 'httpStatus';

const COLUMNS: ListColumns = {
  id: supplierApiLogs.id,
  createdAt: supplierApiLogs.createdAt,
  durationMs: supplierApiLogs.durationMs,
  httpStatus: supplierApiLogs.httpStatus,
  supplierId: supplierApiLogs.supplierId,
  orderId: supplierApiLogs.orderId,
  action: supplierApiLogs.action,
  outcome: supplierApiLogs.outcome,
};

/** A log row without its two bodies (the list). */
export type SupplierLogSummary = Omit<SupplierApiLog, 'request' | 'response'>;

/**
 * Writes one call to the log.
 *
 * @param db the database or the transaction of the change the call caused
 * @param row the call: supplier, order, action, redacted bodies, status, time waited, error and outcome
 * @returns the stored row's id
 */
export async function insertLog(db: DbExecutor, row: NewSupplierApiLog): Promise<number> {
  const [created] = await db.insert(supplierApiLogs).values(row).returning({ id: supplierApiLogs.id });
  return created!.id;
}

/**
 * Lists log rows without their bodies.
 *
 * @param db the database
 * @param query the parsed list request (filters `supplierId`, `orderId`, `action`, `outcome`)
 * @returns the page and the exact total
 */
export async function listLogRows(
  db: DbExecutor,
  query: ParsedListQuery<SupplierLogListField>,
): Promise<{ rows: SupplierLogSummary[]; total: number }> {
  const where = listWhere(query, COLUMNS);
  const [rows, [count]] = await Promise.all([
    db
      .select({
        id: supplierApiLogs.id,
        supplierId: supplierApiLogs.supplierId,
        orderId: supplierApiLogs.orderId,
        action: supplierApiLogs.action,
        httpStatus: supplierApiLogs.httpStatus,
        durationMs: supplierApiLogs.durationMs,
        error: supplierApiLogs.error,
        outcome: supplierApiLogs.outcome,
        createdAt: supplierApiLogs.createdAt,
      })
      .from(supplierApiLogs)
      .where(where)
      .orderBy(...listOrderBy(query.sort, COLUMNS, supplierApiLogs.id))
      .limit(query.range.limit)
      .offset(query.range.start),
    db
      .select({ total: sql<number>`count(*)::int` })
      .from(supplierApiLogs)
      .where(where),
  ]);
  return { rows, total: count?.total ?? 0 };
}

/**
 * Reads one log row with its bodies.
 *
 * @param db the database
 * @param id the row id
 * @returns the row, or `undefined`
 */
export async function findLog(db: DbExecutor, id: number): Promise<SupplierApiLog | undefined> {
  const [row] = await db.select().from(supplierApiLogs).where(eq(supplierApiLogs.id, id)).limit(1);
  return row;
}

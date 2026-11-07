// Drizzle queries of the supplier routes on `suppliers` (stage 6): list, find, lock, insert, change, delete, and the checks a delete
// makes against the tables that reference a supplier.
import { and, eq, inArray, ne, sql } from 'drizzle-orm';
import type { ParsedListQuery } from '../../../common/contract';
import { type DbExecutor, type ListColumns, listOrderBy, listWhere } from '../../../infra/db';
import { schema as s } from '../../../infra/db';
import {
  type NewSupplier,
  type Supplier,
  serviceSupplierLinks,
  supplierApiLogs,
  supplierServices,
  suppliers,
} from '../db/schema';

/** The list fields `GET /admin/suppliers` can sort and filter on. */
export type SupplierListField = 'id' | 'name' | 'status' | 'createdAt';

const COLUMNS: ListColumns = {
  id: suppliers.id,
  name: suppliers.name,
  status: suppliers.status,
  createdAt: suppliers.createdAt,
  baseUrl: suppliers.baseUrl,
  driver: suppliers.driver,
};

/**
 * Lists suppliers.
 *
 * @param db the database or a transaction
 * @param query the parsed list request
 * @returns the page of suppliers and the exact total
 */
export async function listSupplierRows(
  db: DbExecutor,
  query: ParsedListQuery<SupplierListField>,
): Promise<{ rows: Supplier[]; total: number }> {
  const where = listWhere(query, COLUMNS);
  const [rows, [count]] = await Promise.all([
    db
      .select()
      .from(suppliers)
      .where(where)
      .orderBy(...listOrderBy(query.sort, COLUMNS, suppliers.id))
      .limit(query.range.limit)
      .offset(query.range.start),
    db
      .select({ total: sql<number>`count(*)::int` })
      .from(suppliers)
      .where(where),
  ]);
  return { rows, total: count?.total ?? 0 };
}

/**
 * Finds a supplier.
 *
 * @param db the database or a transaction
 * @param id the supplier id
 * @returns the row, or `undefined`
 */
export async function findSupplier(db: DbExecutor, id: number): Promise<Supplier | undefined> {
  const [row] = await db.select().from(suppliers).where(eq(suppliers.id, id)).limit(1);
  return row;
}

/**
 * Finds suppliers by id.
 *
 * @param db the database or a transaction
 * @param ids the supplier ids
 * @returns the rows by id
 */
export async function findSuppliers(db: DbExecutor, ids: readonly number[]): Promise<Map<number, Supplier>> {
  if (ids.length === 0) return new Map();
  const rows = await db
    .select()
    .from(suppliers)
    .where(inArray(suppliers.id, [...ids]));
  return new Map(rows.map((row) => [row.id, row]));
}

/**
 * Finds a supplier and locks it for the rest of the transaction.
 *
 * Why: a change, a delete and a sync of the same supplier must not interleave (the delete checks what references it, the sync
 * rewrites its services).
 *
 * @param db the transaction
 * @param id the supplier id
 * @returns the locked row, or `undefined`
 */
export async function lockSupplier(db: DbExecutor, id: number): Promise<Supplier | undefined> {
  const [row] = await db.select().from(suppliers).where(eq(suppliers.id, id)).limit(1).for('update');
  return row;
}

/**
 * Tells whether a supplier name is taken, ignoring case.
 *
 * @param db the database or a transaction
 * @param name the trimmed name
 * @param exceptId a supplier to leave out (the one being changed)
 * @returns true when another supplier has the name
 */
export async function supplierNameTaken(db: DbExecutor, name: string, exceptId?: number): Promise<boolean> {
  const same = sql`lower(${suppliers.name}) = lower(${name})`;
  const [row] = await db
    .select({ id: suppliers.id })
    .from(suppliers)
    .where(exceptId === undefined ? same : and(same, ne(suppliers.id, exceptId)))
    .limit(1);
  return row !== undefined;
}

/**
 * Inserts a supplier.
 *
 * @param db the transaction
 * @param row the new supplier
 * @returns the stored row
 */
export async function insertSupplier(db: DbExecutor, row: NewSupplier): Promise<Supplier> {
  const [created] = await db.insert(suppliers).values(row).returning();
  return created!;
}

/**
 * Changes a supplier.
 *
 * @param db the transaction
 * @param id the supplier id
 * @param changes the columns that change
 * @returns the updated row, or `undefined` when it is gone
 */
export async function updateSupplier(
  db: DbExecutor,
  id: number,
  changes: Partial<NewSupplier>,
): Promise<Supplier | undefined> {
  const [row] = await db.update(suppliers).set(changes).where(eq(suppliers.id, id)).returning();
  return row;
}

/** Why a supplier cannot be deleted: what still references it. */
export interface SupplierBlockers {
  readonly links: number;
  readonly orderCalls: number;
  readonly imeiChecks: number;
}

/**
 * Counts the records other than orders that block a supplier delete.
 *
 * Why: orders-suppliers-8: a service link to one of its supplier services, a call log row of an order, or an IMEI check that used
 * the supplier keeps it (the foreign keys are `RESTRICT`).
 *
 * @param db the delete's transaction
 * @param supplierId the supplier
 * @returns the three counts
 */
export async function supplierBlockers(db: DbExecutor, supplierId: number): Promise<SupplierBlockers> {
  const [links] = await db
    .select({ total: sql<number>`count(*)::int` })
    .from(serviceSupplierLinks)
    .innerJoin(supplierServices, eq(supplierServices.id, serviceSupplierLinks.supplierServiceId))
    .where(eq(supplierServices.supplierId, supplierId));
  const [calls] = await db
    .select({ total: sql<number>`count(*)::int` })
    .from(supplierApiLogs)
    .where(and(eq(supplierApiLogs.supplierId, supplierId), sql`${supplierApiLogs.orderId} is not null`));
  const [checks] = await db
    .select({ total: sql<number>`count(*)::int` })
    .from(s.imeiChecks)
    .where(eq(s.imeiChecks.supplierId, supplierId));
  return { links: links?.total ?? 0, orderCalls: calls?.total ?? 0, imeiChecks: checks?.total ?? 0 };
}

/**
 * Deletes a supplier and the call logs of its tests and syncs.
 *
 * Why: orders-suppliers-8: the logs that belong to no order are not business history, so a supplier that was only tested or synced
 * can be deleted; its synced services and health checks go with it by their `CASCADE` foreign keys.
 *
 * @param db the delete's transaction (the supplier row is locked and the blockers were checked)
 * @param supplierId the supplier
 */
export async function deleteSupplierRow(db: DbExecutor, supplierId: number): Promise<void> {
  await db.delete(supplierApiLogs).where(eq(supplierApiLogs.supplierId, supplierId));
  await db.delete(suppliers).where(eq(suppliers.id, supplierId));
}

/**
 * Lists the suppliers a scheduled job goes through: every one that is not disabled.
 *
 * @param db the database
 * @returns the suppliers by id
 */
export async function suppliersToSync(db: DbExecutor): Promise<Supplier[]> {
  return db.select().from(suppliers).where(ne(suppliers.status, 'disabled')).orderBy(suppliers.id);
}

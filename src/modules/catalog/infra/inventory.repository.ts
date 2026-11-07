// Drizzle queries of the code inventory routes on `inventory_codes`: the masked list, the batch insert, the batch reference
// sequence and the guarded void.
import { and, eq, inArray, sql } from 'drizzle-orm';
import type { ParsedListQuery } from '../../../common/contract';
import { type DbExecutor, type ListColumns, listOrderBy, listWhere } from '../../../infra/db';
import { type InventoryCode, type NewInventoryCode, inventoryCodes, services } from '../db/schema';

/** A stocked code as the list shows it: everything but the encrypted code and its hash, with the name of its service. */
export type InventoryRow = Pick<
  InventoryCode,
  'id' | 'serviceId' | 'status' | 'orderId' | 'batchRef' | 'codeLast4' | 'createdAt'
> & { readonly serviceName: string };

const COLUMNS: ListColumns = {
  id: inventoryCodes.id,
  createdAt: inventoryCodes.createdAt,
  serviceId: inventoryCodes.serviceId,
  status: inventoryCodes.status,
  batchRef: inventoryCodes.batchRef,
  'service.name': services.name,
};

/**
 * Lists stocked codes for `GET /admin/inventory-codes`; the stored ciphertext and hash are never selected.
 *
 * @param db the database or a transaction
 * @param query the parsed list request
 * @returns the page of codes with their service names, and the exact total
 */
export async function listInventoryRows(
  db: DbExecutor,
  query: ParsedListQuery<'createdAt' | 'id'>,
): Promise<{ rows: InventoryRow[]; total: number }> {
  const where = listWhere(query, COLUMNS);
  const [rows, [count]] = await Promise.all([
    db
      .select({
        id: inventoryCodes.id,
        serviceId: inventoryCodes.serviceId,
        status: inventoryCodes.status,
        orderId: inventoryCodes.orderId,
        batchRef: inventoryCodes.batchRef,
        codeLast4: inventoryCodes.codeLast4,
        createdAt: inventoryCodes.createdAt,
        serviceName: services.name,
      })
      .from(inventoryCodes)
      .innerJoin(services, eq(services.id, inventoryCodes.serviceId))
      .where(where)
      .orderBy(...listOrderBy(query.sort, COLUMNS, inventoryCodes.id))
      .limit(query.range.limit)
      .offset(query.range.start),
    db
      .select({ total: sql<number>`count(*)::int` })
      .from(inventoryCodes)
      .innerJoin(services, eq(services.id, inventoryCodes.serviceId))
      .where(where),
  ]);
  return { rows, total: count?.total ?? 0 };
}

/**
 * Draws the next number of the batch reference sequence.
 *
 * Why: two concurrent imports never share a reference (RESOLUTIONS catalog-15); a sequence is not rolled back, so a failed
 * import leaves a gap.
 *
 * @param db the transaction
 * @returns the sequence value, from 1
 */
export async function nextBatchNumber(db: DbExecutor): Promise<number> {
  const result = await db.execute<{ n: string }>(sql`select nextval('inventory_batch_ref_seq') as n`);
  return Number(result.rows[0]!.n);
}

/**
 * Inserts codes, skipping those whose keyed hash already belongs to a code that is not void.
 *
 * Why: the partial unique index `inventory_codes_code_hash_uq` is the final word on a duplicate, also when two imports race.
 *
 * @param db the transaction
 * @param rows the codes to store (encrypted, with hash and last four characters)
 * @returns how many rows were stored; the rest were duplicates
 */
export async function insertCodeRows(db: DbExecutor, rows: readonly NewInventoryCode[]): Promise<number> {
  if (rows.length === 0) return 0;
  const stored = await db
    .insert(inventoryCodes)
    .values([...rows])
    .onConflictDoNothing()
    .returning({ id: inventoryCodes.id });
  return stored.length;
}

/**
 * Voids the available codes among some ids.
 *
 * Why: only `available` codes may be withdrawn (reserved ones belong to open orders, sold ones were delivered); the status
 * guard in the statement makes a repeat or a race with an order reservation safe.
 *
 * @param db the transaction
 * @param ids the distinct code ids
 * @returns the ids that became void
 */
export async function voidAvailableCodes(db: DbExecutor, ids: readonly number[]): Promise<number[]> {
  if (ids.length === 0) return [];
  const rows = await db
    .update(inventoryCodes)
    .set({ status: 'void' })
    .where(and(inArray(inventoryCodes.id, [...ids]), eq(inventoryCodes.status, 'available')))
    .returning({ id: inventoryCodes.id });
  return rows.map((row) => row.id).sort((a, b) => a - b);
}

/**
 * Locks the oldest available codes of a service for an order being placed.
 *
 * Why: RULES orders 10: an order of a stocked service takes its codes at placement. `FOR UPDATE SKIP LOCKED` lets two placements
 * at the same moment take different codes (each skips the rows the other holds) instead of waiting or taking one code twice; the
 * rows stay locked until the placement commits or rolls back.
 *
 * @param db the placement transaction
 * @param serviceId the service ordered
 * @param count how many codes the order needs
 * @returns the locked rows (id and ciphertext), oldest first; fewer than `count` when the stock is short
 */
export async function lockAvailableCodes(
  db: DbExecutor,
  serviceId: number,
  count: number,
): Promise<Array<Pick<InventoryCode, 'id' | 'codeEnc'>>> {
  return db
    .select({ id: inventoryCodes.id, codeEnc: inventoryCodes.codeEnc })
    .from(inventoryCodes)
    .where(and(eq(inventoryCodes.serviceId, serviceId), eq(inventoryCodes.status, 'available')))
    .orderBy(inventoryCodes.id)
    .limit(count)
    .for('update', { skipLocked: true });
}

/**
 * Marks codes this transaction locked as sold to an order.
 *
 * @param db the placement transaction (the one that locked the rows)
 * @param ids the locked code ids
 * @param orderId the order they were delivered to
 * @returns how many codes became sold
 */
export async function sellLockedCodes(db: DbExecutor, ids: readonly number[], orderId: number): Promise<number> {
  if (ids.length === 0) return 0;
  const rows = await db
    .update(inventoryCodes)
    .set({ status: 'sold', orderId })
    .where(and(inArray(inventoryCodes.id, [...ids]), eq(inventoryCodes.status, 'available')))
    .returning({ id: inventoryCodes.id });
  return rows.length;
}

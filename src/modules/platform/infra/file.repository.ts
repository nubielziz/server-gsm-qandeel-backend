// Drizzle queries of the file download routes on `files` (platform module), plus the one foreign read they need: whether a file is the
// input or result of a merchant's own order.
//
// DEVIATION to resolve when the orders module exports a lookup for it: decision 016 wants this read through the owning module's public
// service. The orders module has none yet, so `ownsOrderFile` reads `orders` with a plain select, like catalog's and money's foreign-read files.
import { and, eq, or, sql } from 'drizzle-orm';
import { type DbExecutor, schema as s } from '../../../infra/db';
import { type NewStoredFile, type StoredFile, files } from '../db/schema';

/**
 * Finds a file by id.
 *
 * @param db the database or a transaction
 * @param id the file id
 * @returns the row, or `undefined`
 */
export async function findFile(db: DbExecutor, id: number): Promise<StoredFile | undefined> {
  const [row] = await db.select().from(files).where(eq(files.id, id)).limit(1);
  return row;
}

/**
 * Records an uploaded file.
 *
 * @param db the database or a transaction
 * @param row the file: where the object is, its name, type, size, SHA-256 and owner
 * @returns the stored row
 */
export async function insertFile(db: DbExecutor, row: NewStoredFile): Promise<StoredFile> {
  const [created] = await db.insert(files).values(row).returning();
  return created!;
}

/**
 * Tells whether a file is the input or the result file of one of a merchant's own orders.
 *
 * @param db the database or a transaction
 * @param clientId the merchant
 * @param fileId the file id
 * @returns true when one of the merchant's orders points at the file
 */
export async function ownsOrderFile(db: DbExecutor, clientId: number, fileId: number): Promise<boolean> {
  const [row] = await db
    .select({ id: s.orders.id })
    .from(s.orders)
    .where(
      and(eq(s.orders.clientId, clientId), or(eq(s.orders.inputFileId, fileId), eq(s.orders.resultFileId, fileId))),
    )
    .limit(1);
  return row !== undefined;
}

/**
 * Deletes a merchant's file row when nothing points at it, and says where the object was.
 *
 * Why: P4a (B166). A Dhru file order stores the upload before it places the order; when the placement is refused the file must not stay.
 * "Nothing points at it" covers every kind of reference: the foreign keys (an order's input or result file, an invoice PDF, a payment receipt,
 * a data request, a storefront image) make the delete fail, and the three tables that keep file ids in an array, which the database cannot
 * enforce (KYC submissions, ticket messages, dispute evidence), are checked in the statement. DEVIATION like {@link ownsOrderFile}: decision
 * 016 wants those reads through the owning modules; this one statement is the single place that names their tables.
 *
 * Side effects: deletes one `files` row.
 *
 * @param db the database or a transaction
 * @param clientId the merchant who must own the file (another owner's file is never touched)
 * @param fileId the file id
 * @returns the bucket and key of the object to delete, or `undefined` when the file is gone, not the merchant's, or still in use
 * @throws a foreign-key violation (`23503`) when a row with a foreign key still points at the file; the caller treats it as "in use"
 */
export async function deleteUnreferencedClientFile(
  db: DbExecutor,
  clientId: number,
  fileId: number,
): Promise<{ bucket: string; key: string } | undefined> {
  const result = await db.execute(sql`
    delete from files
    where id = ${fileId} and owner_type = 'client' and owner_id = ${clientId}
      and not exists (select 1 from kyc_submissions where file_ids @> array[${fileId}]::bigint[])
      and not exists (select 1 from ticket_messages where file_ids @> array[${fileId}]::bigint[])
      and not exists (select 1 from disputes where evidence_file_ids @> array[${fileId}]::bigint[])
    returning bucket, key
  `);
  const row = result.rows[0] as { bucket: string; key: string } | undefined;
  return row;
}

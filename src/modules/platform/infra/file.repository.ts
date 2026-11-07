// Drizzle queries of the file download routes on `files` (platform module), plus the one foreign read they need: whether a file is the
// input or result of a merchant's own order.
//
// DEVIATION to resolve when the orders module exports a lookup for it: decision 016 wants this read through the owning module's public
// service. The orders module has none yet, so `ownsOrderFile` reads `orders` with a plain select, like catalog's and money's foreign-read files.
import { and, eq, or } from 'drizzle-orm';
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

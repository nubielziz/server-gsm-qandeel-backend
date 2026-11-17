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

/**
 * Deletes the file rows of the given ids that nothing points at, and says where their objects were.
 *
 * Why: feature 28 (rules 10): the attachments of an anonymized customer's tickets, and of a ticket resolved longer ago than the retention,
 * are deleted. A file can be in use elsewhere too (a merchant's portal upload may also be its KYC document or an order's input; a staff
 * upload may sit on a second ticket), so only the rows that no reference holds are deleted: the three tables that keep file ids in an
 * array (checked here, the database cannot), and every foreign key (checked here as well, so the statement never fails on one and the
 * caller's transaction, an anonymization, is not broken). The caller empties its own references first, in the same transaction.
 *
 * Side effects: deletes `files` rows.
 *
 * @param db the caller's transaction
 * @param ids the file ids (duplicates are fine)
 * @returns the bucket and key of each deleted row
 */
export async function deleteUnreferencedFiles(
  db: DbExecutor,
  ids: readonly number[],
): Promise<{ id: number; bucket: string; key: string }[]> {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return [];
  const list = sql`array[${sql.join(
    unique.map((id) => sql`${id}`),
    sql`, `,
  )}]::bigint[]`;
  const result = await db.execute(sql`
    delete from files f
    where f.id = any(${list})
      and not exists (select 1 from ticket_messages where file_ids @> array[f.id])
      and not exists (select 1 from kyc_submissions where file_ids @> array[f.id])
      and not exists (select 1 from disputes where evidence_file_ids @> array[f.id])
      and not exists (select 1 from orders where input_file_id = f.id or result_file_id = f.id)
      and not exists (select 1 from invoices where pdf_file_id = f.id)
      and not exists (select 1 from payments where receipt_file_id = f.id)
      and not exists (select 1 from data_requests where file_id = f.id)
      and not exists (select 1 from service_listings where image_file_id = f.id or og_file_id = f.id)
      and not exists (select 1 from payment_gateways where logo_file_id = f.id)
    returning f.id, f.bucket, f.key
  `);
  return (result.rows as { id: string | number; bucket: string; key: string }[]).map((row) => ({
    id: Number(row.id),
    bucket: row.bucket,
    key: row.key,
  }));
}

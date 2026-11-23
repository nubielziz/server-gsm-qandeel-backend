// Drizzle queries of the file download routes on `files` (platform module), plus the one foreign read they need: whether a file is the
// input or result of a merchant's own order.
//
// DEVIATION to resolve when the orders module exports a lookup for it: decision 016 wants this read through the owning module's public
// service. The orders module has none yet, so `ownsOrderFile` reads `orders` with a plain select, like catalog's and money's foreign-read files.
// The same holds for `merchantIsApproved` (decision 053): the identity module exports no reader the platform may import (decision 032), so it
// reads `clients.status` with a plain select. The upload quotas and the janitor of feature 43 live here too (decision 053).
import { and, eq, or, sql, type SQL } from 'drizzle-orm';
import { type DbExecutor, schema as s } from '../../../infra/db';
import { type NewStoredFile, type StoredFile, files } from '../db/schema';
import type { FileReferences } from '../files/file-kinds';

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
 * Counts the files an owner holds under some key prefixes, and their bytes.
 *
 * Why: decision 053. The upload quotas count only the files a person uploaded (keys under `files/` and `tickets-`), so a generated
 * document of the same owner (an invoice PDF, a receipt) never counts against them.
 *
 * @param db the database or a transaction
 * @param owner the merchant or customer who owns the files
 * @param keyPrefixes the object key prefixes that count (at least one)
 * @param since only files created after this time count; `null` counts everything the owner holds
 * @returns the number of files and their total size in bytes
 */
export async function uploadUsage(
  db: DbExecutor,
  owner: { readonly type: 'client' | 'customer'; readonly id: number },
  keyPrefixes: readonly string[],
  since: Date | null,
): Promise<{ files: number; bytes: number }> {
  const prefixes = sql.join(
    keyPrefixes.map((prefix) => sql`starts_with(${files.key}, ${prefix})`),
    sql` or `,
  );
  const result = await db.execute(sql`
    select count(*)::int as files, coalesce(sum(${files.size}), 0)::bigint as bytes
    from ${files}
    where ${files.ownerType} = ${owner.type} and ${files.ownerId} = ${owner.id}
      and (${prefixes})
      ${since === null ? sql`` : sql`and ${files.createdAt} > ${since}`}
  `);
  const row = result.rows[0] as { files: number; bytes: string | number } | undefined;
  return { files: Number(row?.files ?? 0), bytes: Number(row?.bytes ?? 0) };
}

/**
 * Takes the transaction lock of an owner's uploads.
 *
 * Why: decision 053. The quota is checked and the row inserted under this lock, so two uploads of one owner that run together cannot both
 * take the last place (the precedent: `api-key-manage.repository`).
 *
 * Side effects: `pg_advisory_xact_lock`, released at the end of the transaction.
 *
 * @param tx the transaction that will insert the file row
 * @param owner the merchant or customer who owns the file
 */
export async function lockUploadOwner(
  tx: DbExecutor,
  owner: { readonly type: 'client' | 'customer'; readonly id: number },
): Promise<void> {
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended('upload-quota:' || ${owner.type} || ':' || ${String(owner.id)}, 0))`,
  );
}

/**
 * Tells whether a merchant is approved.
 *
 * Why: decision 053. A merchant waiting for approval has a smaller upload quota than an active one.
 *
 * @param db the database or a transaction
 * @param clientId the merchant
 * @returns true when `clients.status` is `active`; a missing row is not approved
 */
export async function merchantIsApproved(db: DbExecutor, clientId: number): Promise<boolean> {
  const [row] = await db
    .select({ status: s.clients.status })
    .from(s.clients)
    .where(eq(s.clients.id, clientId))
    .limit(1);
  return row?.status === 'active';
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
 * Tells whether a file is an upload of a merchant that no record uses yet.
 *
 * Why: REST v1 downloads a merchant's files for an order-reading key. An upload that nothing refers to yet is the merchant's own bytes
 * (the key may have stored it); once a KYC submission, a payment, a ticket or a dispute refers to it, it is a document of that record
 * and not an order file. "Nothing refers to it" is the one list of references, {@link unreferenced}.
 *
 * @param db the database or a transaction
 * @param clientId the merchant who must own the file
 * @param fileId the file id
 * @returns true when the file is owned by the merchant and no record refers to it
 */
export async function isUnreferencedClientUpload(db: DbExecutor, clientId: number, fileId: number): Promise<boolean> {
  const result = await db.execute(sql`
    select 1 as found from files
    where id = ${fileId} and owner_type = 'client' and owner_id = ${clientId}
      and ${unreferenced('files')}
    limit 1
  `);
  return result.rows.length > 0;
}

/**
 * Deletes a merchant's file row when nothing points at it, and says where the object was.
 *
 * Why: P4a (B166). A Dhru file order stores the upload before it places the order; when the placement is refused the file must not stay.
 * "Nothing points at it" is the one list of references, {@link unreferenced}: the tables that keep file ids in an array, which the database
 * cannot enforce (KYC submissions, ticket messages, dispute evidence), and every foreign key (an order's input or result file, an invoice
 * PDF, a payment receipt, a data request, a storefront image, a gateway logo). A reference written at the same moment still makes the
 * delete fail on its foreign key. DEVIATION like {@link ownsOrderFile}: decision 016 wants those reads through the owning modules; that
 * list is the single place that names their tables.
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
      and ${unreferenced('files')}
    returning bucket, key
  `);
  const row = result.rows[0] as { bucket: string; key: string } | undefined;
  return row;
}

/**
 * The condition "nothing references this file": the three array columns and the foreign-key columns that name a file.
 *
 * Why: the one list of references, written once for the delete of known ids and for the janitor (decision 053). The three tables that
 * keep file ids in an array (the database cannot enforce them) and every foreign key are checked, so a statement that uses it never fails
 * on a foreign key and never deletes a file something uses. A new column that names a file must be added here: a tooling test reads the
 * schema and fails, naming the table and column, when a foreign key to `files` or an array column of file ids is missing from this list
 * (`test/tooling/file-references.test.ts`).
 *
 * @param alias the alias of the `files` table in the statement (a plain identifier written by the caller, never user input)
 * @returns the SQL condition
 */
export function unreferenced(alias: string): SQL {
  if (!/^[a-z_][a-z0-9_]*$/.test(alias)) throw new Error(`Not a table alias: ${alias}`);
  const id = sql.raw(`${alias}.id`);
  return sql`
        not exists (select 1 from ticket_messages where file_ids @> array[${id}])
    and not exists (select 1 from kyc_submissions where file_ids @> array[${id}])
    and not exists (select 1 from disputes where evidence_file_ids @> array[${id}])
    and not exists (select 1 from orders where input_file_id = ${id} or result_file_id = ${id})
    and not exists (select 1 from invoices where pdf_file_id = ${id})
    and not exists (select 1 from payments where receipt_file_id = ${id})
    and not exists (select 1 from data_requests where file_id = ${id})
    and not exists (select 1 from service_listings where image_file_id = ${id} or og_file_id = ${id})
    and not exists (select 1 from payment_gateways where logo_file_id = ${id})`;
}

/**
 * Finds the files stored before a time that nothing references, in id order.
 *
 * Why: the janitor of decision 053 deletes the files nothing used for 7 days. It reads a page after the last id it saw, so a file that
 * is kept (something started to use it) is not read again in the same run.
 *
 * @param db the database
 * @param before only files created before this time
 * @param afterId only ids greater than this
 * @param limit the page size
 * @returns the ids, ascending
 */
export async function staleUnreferencedFileIds(
  db: DbExecutor,
  before: Date,
  afterId: number,
  limit: number,
): Promise<number[]> {
  const result = await db.execute(sql`
    select f.id from files f
    where f.id > ${afterId} and f.created_at < ${before} and ${unreferenced('f')}
    order by f.id
    limit ${limit}
  `);
  return (result.rows as { id: string | number }[]).map((row) => Number(row.id));
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
      and ${unreferenced('f')}
    returning f.id, f.bucket, f.key
  `);
  return (result.rows as { id: string | number; bucket: string; key: string }[]).map((row) => ({
    id: Number(row.id),
    bucket: row.bucket,
    key: row.key,
  }));
}

/**
 * Finds out which records use a file: the newest KYC submission and payment that name it, and whether a dispute, an order, an invoice, a
 * ticket message or a data request does.
 *
 * Why: decision 047: a staff download needs the read permission of every kind of record that uses the file, and the newest KYC submission
 * and payment name the audit rows. One statement, the same documented deviation of decision 016 as {@link deleteUnreferencedFiles}, which
 * names these tables too (their owners have no public read of "which record uses this file").
 *
 * @param db the database or a transaction
 * @param fileId the file id
 * @returns what uses the file; the pictures of listings and payment methods are not part of it (they are public)
 */
export async function fileReferencesOf(db: DbExecutor, fileId: number): Promise<FileReferences> {
  const result = await db.execute(sql`
    select
      k.id as kyc_submission_id, k.client_id as kyc_client_id, c.name as kyc_client_name,
      (select p.id from payments p where p.receipt_file_id = ${fileId} order by p.id desc limit 1) as payment_id,
      exists (select 1 from disputes where evidence_file_ids @> array[${fileId}]::bigint[]) as dispute_evidence,
      exists (select 1 from orders where input_file_id = ${fileId} or result_file_id = ${fileId}) as order_file,
      exists (select 1 from invoices where pdf_file_id = ${fileId}) as invoice_document,
      exists (select 1 from ticket_messages where file_ids @> array[${fileId}]::bigint[]) as ticket_attachment,
      exists (select 1 from data_requests where file_id = ${fileId}) as data_export
    from (select 1) one
    left join lateral (
      select id, client_id from kyc_submissions where file_ids @> array[${fileId}]::bigint[] order by id desc limit 1
    ) k on true
    left join clients c on c.id = k.client_id
  `);
  const row = result.rows[0] as {
    kyc_submission_id: string | number | null;
    kyc_client_id: string | number | null;
    kyc_client_name: string | null;
    payment_id: string | number | null;
    dispute_evidence: boolean;
    order_file: boolean;
    invoice_document: boolean;
    ticket_attachment: boolean;
    data_export: boolean;
  };
  return {
    ...(row.kyc_submission_id === null || row.kyc_client_id === null
      ? {}
      : {
          kyc: {
            submissionId: Number(row.kyc_submission_id),
            clientId: Number(row.kyc_client_id),
            clientName: row.kyc_client_name ?? '',
          },
        }),
    ...(row.payment_id === null ? {} : { paymentId: Number(row.payment_id) }),
    disputeEvidence: row.dispute_evidence,
    orderFile: row.order_file,
    invoiceDocument: row.invoice_document,
    ticketAttachment: row.ticket_attachment,
    dataExport: row.data_export,
  };
}

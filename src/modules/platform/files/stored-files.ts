// StoredFiles: the public side of the `files` table for other modules (decision 004): store a generated document in object storage
// and record it, read the metadata of files by id, check which of them a merchant owns, hand out a short download link, delete files
// that nothing uses any more (feature 28) and find the files that hold the same bytes (decision 049). The upload routes are 7a's.
import { randomUUID } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import { AppError } from '../../../common/errors';
import { and, asc, eq, inArray } from 'drizzle-orm';
import { type DbExecutor, onCommit } from '../../../infra/db';
import { DEFAULT_MAX_OBJECT_BYTES, DEFAULT_PRESIGN_SECONDS, StorageService } from '../../../infra/storage';
import { type StoredFile, files } from '../db/schema';
import { deleteUnreferencedFiles } from '../infra/file.repository';

/**
 * The media types a merchant may attach as proof (a bank transfer receipt): PDF, JPEG and PNG.
 *
 * Why: MISMATCHES B161 and B163 accept only these three for the files a merchant uploaded through `POST /client/files`.
 */
export const PROOF_MIME_TYPES: readonly string[] = ['application/pdf', 'image/jpeg', 'image/png'];

/**
 * The area of the files an owner uploaded itself through the upload routes (`POST /client/files`,
 * `POST /store/v1/files`): `FileUploadService` stores them under `files/`.
 *
 * Why: a transfer receipt must be a file its owner uploaded; the documents the platform stores for an owner (invoice PDFs, tax
 * receipts, dispute evidence, ticket attachments) are kept under other areas.
 */
export const UPLOAD_AREA = 'files';

/** What a stored file looks like to the module that asked for it. */
export interface FileMeta {
  readonly id: number;
  readonly filename: string;
  readonly mime: string;
  readonly size: number;
  readonly ownerType: string;
  readonly ownerId: number;
  /**
   * The first segment of the object key: the `area` it was stored under (`invoices`, `receipts`, `tickets-42`), or `files` for an upload
   * of the platform's upload routes.
   *
   * Why: feature 28: a ticket link may attach only the files uploaded through that ticket, which are stored under the ticket's own area.
   */
  readonly area: string;
}

/** A file just stored: its metadata plus the content hash and the time it was recorded (what an upload route answers). */
export interface StoredFileRecord extends FileMeta {
  /** Hex SHA-256 of the content. */
  readonly sha256: string;
  readonly createdAt: Date;
}

/** What {@link StoredFiles.store} writes. */
export interface StoreFileInput {
  /** `client`, `staff` or `customer`: whose file it is (a merchant may download its own, B154). */
  readonly ownerType: 'client' | 'staff' | 'customer';
  readonly ownerId: number;
  /** The download name. */
  readonly filename: string;
  readonly mime: string;
  readonly bytes: Uint8Array;
  /** The first segment of the object key (`invoices`, `receipts`): letters, digits and `-` only. */
  readonly area: string;
}

/** The first segment of an object key (the whole key when it has no `/`). */
function areaOf(key: string): string {
  const slash = key.indexOf('/');
  return slash < 0 ? key : key.slice(0, slash);
}

function metaOf(row: StoredFile): FileMeta {
  return {
    id: row.id,
    filename: row.filename,
    mime: row.mime,
    size: row.size,
    ownerType: row.ownerType,
    ownerId: row.ownerId,
    area: areaOf(row.key),
  };
}

/**
 * Stores generated files and reads file metadata for the other modules.
 *
 * Why: invoice PDFs (decision 030) are written by billing, receipts are checked by the money module, and
 * the `files` table belongs to the platform module (decision 016). The object goes to S3 first and the row follows; a rolled-back
 * caller leaves an unreferenced object, never a row without an object.
 *
 * It also finds the files that hold the same bytes (`sha256Of`, `idsWithSha256`, decision 049).
 *
 * Side effects: `store` puts one object in the bucket and inserts one `files` row.
 */
@Injectable()
export class StoredFiles {
  private readonly logger = new Logger(StoredFiles.name);

  constructor(private readonly storage: StorageService) {}

  /**
   * Stores bytes as a file of an owner.
   *
   * @param db the database or the caller's transaction
   * @param input the owner, the name, the type, the bytes and the key area
   * @returns the stored file's metadata (its id goes into `invoices.pdf_file_id`), its SHA-256 and the time it was recorded
   * @throws {AppError} `UNAVAILABLE` when the object store cannot be reached
   */
  async store(db: DbExecutor, input: StoreFileInput): Promise<StoredFileRecord> {
    const key = `${input.area}/${input.ownerType}-${input.ownerId}/${randomUUID()}`;
    const object = await this.storage.put(key, input.bytes, { contentType: input.mime });
    const [row] = await db
      .insert(files)
      .values({
        bucket: object.bucket,
        key: object.key,
        filename: input.filename,
        mime: input.mime,
        size: object.size,
        sha256: object.sha256,
        ownerType: input.ownerType,
        ownerId: input.ownerId,
      })
      .returning();
    return { ...metaOf(row!), sha256: row!.sha256, createdAt: row!.createdAt };
  }

  /**
   * Reads a stored file's bytes.
   *
   * Why: a generated document that is made once and kept (the storefront tax receipt, decision 030) is served from its stored copy, so every
   * download gives the same bytes.
   *
   * @param db the database or a transaction
   * @param id the file id
   * @returns the metadata and the bytes, or `undefined` when the row or its object is missing
   * @throws {AppError} `UNAVAILABLE` when the object store cannot be reached; `PAYLOAD_TOO_LARGE` for an object over the default limit
   */
  async read(db: DbExecutor, id: number): Promise<{ meta: FileMeta; bytes: Uint8Array } | undefined> {
    const [row] = await db.select().from(files).where(eq(files.id, id)).limit(1);
    if (!row) return undefined;
    if (row.size > DEFAULT_MAX_OBJECT_BYTES) {
      throw new AppError('PAYLOAD_TOO_LARGE', { detail: `The file is larger than ${DEFAULT_MAX_OBJECT_BYTES} bytes.` });
    }
    const object = await this.storage.get(row.key);
    if (!object) return undefined;
    const chunks: Buffer[] = [];
    for await (const chunk of object.body as AsyncIterable<Uint8Array | string>) {
      chunks.push(typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : Buffer.from(chunk));
    }
    return { meta: metaOf(row), bytes: Buffer.concat(chunks) };
  }

  /**
   * Reads the metadata of files by id, with the area of each (the first segment of its key).
   *
   * @param db the database or a transaction
   * @param ids the file ids (duplicates and unknown ids are fine)
   * @returns the files that exist, by id
   */
  async metaOf(db: DbExecutor, ids: readonly number[]): Promise<Map<number, FileMeta>> {
    const unique = [...new Set(ids)];
    if (unique.length === 0) return new Map();
    const rows = await db.select().from(files).where(inArray(files.id, unique));
    return new Map(rows.map((row) => [row.id, metaOf(row)]));
  }

  /**
   * Reads one file if it belongs to the given owner.
   *
   * Why: a merchant may attach only the files it uploaded itself (B161, B163); another owner's id is treated like an unknown one.
   *
   * @param db the database or a transaction
   * @param id the file id
   * @param owner the owner the file must have
   * @returns the file, or `undefined` when it does not exist or belongs to someone else
   */
  async findOwned(
    db: DbExecutor,
    id: number,
    owner: { readonly type: 'client' | 'staff' | 'customer'; readonly id: number },
  ): Promise<FileMeta | undefined> {
    const [row] = await db
      .select()
      .from(files)
      .where(and(eq(files.id, id), eq(files.ownerType, owner.type), eq(files.ownerId, owner.id)))
      .limit(1);
    return row ? metaOf(row) : undefined;
  }

  /**
   * Reads the content hash of a file.
   *
   * Why: decision 049: a transfer receipt backs one live payment, whoever uploaded the copy; every file row keeps the SHA-256 of its
   * bytes, so the caller can lock that content before it looks for the other files that hold it.
   *
   * @param db the database or the caller's transaction
   * @param id the file id
   * @returns the hex SHA-256 of the file's bytes, or `undefined` when no file has this id
   */
  async sha256Of(db: DbExecutor, id: number): Promise<string | undefined> {
    const [row] = await db.select({ sha256: files.sha256 }).from(files).where(eq(files.id, id)).limit(1);
    return row?.sha256;
  }

  /**
   * Lists the files that hold the given bytes.
   *
   * Why: decision 049: the receipt rule looks at every copy of a receipt, whoever uploaded it (`files_sha256_idx` serves the read).
   *
   * @param db the database or the caller's transaction
   * @param sha256 the hex SHA-256 of the content
   * @returns the ids of every file with this hash, ascending (empty when none)
   */
  async idsWithSha256(db: DbExecutor, sha256: string): Promise<number[]> {
    const rows = await db.select({ id: files.id }).from(files).where(eq(files.sha256, sha256)).orderBy(asc(files.id));
    return rows.map((row) => row.id);
  }

  /**
   * Makes the download link of a stored file: a presigned `GET` that lives 5 minutes and saves the file under its stored name.
   *
   * Why: feature 28, rule 8: an attachment is never shown inline; every download is a short link with `Content-Disposition:
   * attachment` (the same lifetime as the file routes, B154). The caller has decided who may read the file.
   *
   * Side effects: none (the signature is computed locally; the object is not checked).
   *
   * @param db the database or a transaction
   * @param id the file id
   * @returns the presigned URL, or `undefined` when no file has this id
   * @throws {RangeError} for a stored key the storage service refuses (a programming error)
   */
  async linkTo(db: DbExecutor, id: number): Promise<string | undefined> {
    const [row] = await db.select().from(files).where(eq(files.id, id)).limit(1);
    if (!row) return undefined;
    return this.storage.presignGet(row.key, { expiresInSeconds: DEFAULT_PRESIGN_SECONDS, filename: row.filename });
  }

  /**
   * Deletes files that nothing uses any more: their rows now, their objects after the commit.
   *
   * Why: feature 28, rule 10: the attachments of an anonymized customer and of a ticket resolved longer ago than the retention are
   * deleted. A file another record still points at (an identity document stored earlier, an order's input, an attachment of another ticket) is kept: the
   * caller first empties its own references in the same transaction. The objects go only once the rows are gone for good, best effort: an
   * object that could not be deleted is logged and is unreachable (no row names it).
   *
   * Side effects: deletes `files` rows in the caller's transaction; after its commit, one `DeleteObject` per deleted row.
   *
   * @param tx the caller's transaction
   * @param ids the file ids (duplicates and unknown ids are fine)
   * @returns the ids of the files that were deleted
   */
  async remove(tx: DbExecutor, ids: readonly number[]): Promise<number[]> {
    const deleted = await deleteUnreferencedFiles(tx, ids);
    if (deleted.length > 0) {
      onCommit(async () => {
        for (const file of deleted) {
          await this.storage.delete(file.key).catch((error: unknown) => {
            this.logger.warn(`Could not delete the object of removed file ${file.id}: ${String(error)}`);
          });
        }
      });
    }
    return deleted.map((file) => file.id);
  }
}

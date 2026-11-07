// StoredFiles: the public side of the `files` table for other modules (decision 004): store a generated document in object storage
// and record it, read the metadata of files by id, and check which of them a merchant owns. The upload routes are 7a's.
import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { and, eq, inArray } from 'drizzle-orm';
import type { DbExecutor } from '../../../infra/db';
import { StorageService } from '../../../infra/storage';
import { type StoredFile, files } from '../db/schema';

/**
 * The media types a merchant may attach as proof (a KYC document, a bank transfer receipt): PDF, JPEG and PNG.
 *
 * Why: MISMATCHES B161 and B163 accept only these three for the files a merchant uploaded through `POST /client/files`.
 */
export const PROOF_MIME_TYPES: readonly string[] = ['application/pdf', 'image/jpeg', 'image/png'];

/** What a stored file looks like to the module that asked for it. */
export interface FileMeta {
  readonly id: number;
  readonly filename: string;
  readonly mime: string;
  readonly size: number;
  readonly ownerType: string;
  readonly ownerId: number;
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

function metaOf(row: StoredFile): FileMeta {
  return {
    id: row.id,
    filename: row.filename,
    mime: row.mime,
    size: row.size,
    ownerType: row.ownerType,
    ownerId: row.ownerId,
  };
}

/**
 * Stores generated files and reads file metadata for the other modules.
 *
 * Why: invoice PDFs (decision 030) are written by billing, KYC documents and receipts are checked by identity and billing, and
 * the `files` table belongs to the platform module (decision 016). The object goes to S3 first and the row follows; a rolled-back
 * caller leaves an unreferenced object, never a row without an object.
 *
 * Side effects: `store` puts one object in the bucket and inserts one `files` row.
 */
@Injectable()
export class StoredFiles {
  constructor(private readonly storage: StorageService) {}

  /**
   * Stores bytes as a file of an owner.
   *
   * @param db the database or the caller's transaction
   * @param input the owner, the name, the type, the bytes and the key area
   * @returns the stored file's metadata (its id goes into `invoices.pdf_file_id`)
   * @throws {AppError} `UNAVAILABLE` when the object store cannot be reached
   */
  async store(db: DbExecutor, input: StoreFileInput): Promise<FileMeta> {
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
    return metaOf(row!);
  }

  /**
   * Reads the metadata of files by id.
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
}

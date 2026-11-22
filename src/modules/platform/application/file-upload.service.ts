// FileUploadService: the one upload path of merchant files (map domain G, B157): `POST /v1/files` for REST v1, `POST /client/files` for the
// merchant portal and the Dhru file order. It checks the file, stores the object in the files bucket and writes the `files` row.
import { randomUUID } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { CLOCK, type Clock } from '../../../common/clock';
import { AppError } from '../../../common/errors';
import { DbService, isForeignKeyViolation } from '../../../infra/db';
import { DEFAULT_MAX_OBJECT_BYTES, StorageService } from '../../../infra/storage';
import { PROOF_MIME_TYPES } from '../files/stored-files';
import {
  CUSTOMER_DAILY_QUOTA,
  MERCHANT_DAILY_QUOTA,
  PENDING_MERCHANT_QUOTA,
  type UploadQuotaRule,
  assertUploadQuota,
} from '../files/upload-quota';
import {
  deleteUnreferencedClientFile,
  insertFile,
  lockUploadOwner,
  merchantIsApproved,
} from '../infra/file.repository';

/** The largest file a merchant may upload: 25 MiB (B157). */
export const MAX_UPLOAD_BYTES = DEFAULT_MAX_OBJECT_BYTES;

/** The longest file name that is kept (B157). */
export const MAX_FILENAME_LENGTH = 200;

/** What an upload route needs to say about a stored file. */
export interface StoredFileView {
  readonly id: number;
  readonly filename: string;
  readonly size: number;
  readonly mime: string;
  readonly sha256: string;
  readonly createdAt: string;
}

/** What the caller hands over: the part of a multipart body, or a file that came another way (a Dhru `FILEDATA`). */
export interface UploadInput {
  readonly filename: string;
  /** The media type the client declared; anything that is not a plain `type/subtype` becomes `application/octet-stream`. */
  readonly mime: string;
  readonly data: Buffer;
}

/** Control (C0, C1), format (bidi, zero-width) and line or paragraph separator characters: never kept in a file name. */
const UNSAFE_NAME_CHARACTERS = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu;

/**
 * Reduces a file name to what is safe to store and show.
 *
 * Why: B157: the name comes from the client; a path (`..\..\x.pdf`, `/etc/passwd`) must not survive, nor control characters
 * (C0 and C1), format characters (the bidi overrides that make `exe.pdf` read as `fdp.exe`, zero-width characters) or line
 * separators, and the stored name is what the download is saved under.
 *
 * @param name the name as sent
 * @returns its base name without control or format characters, at most 200 characters; `file` when nothing is left
 */
export function cleanUploadName(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? '';
  const cleaned = base.replace(UNSAFE_NAME_CHARACTERS, '');
  const trimmed = Array.from(cleaned.trim()).slice(0, MAX_FILENAME_LENGTH).join('').trim();
  return trimmed === '' || trimmed === '.' || trimmed === '..' ? 'file' : trimmed;
}

const MEDIA_TYPE = /^[a-z0-9][a-z0-9!#$&^_.+-]{0,60}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,100}$/;

/**
 * Reads the media type a client declared.
 *
 * @param declared the type as sent (parameters allowed)
 * @returns the lower-case `type/subtype`, or `application/octet-stream` when it is not one
 */
export function cleanMediaType(declared: string): string {
  const base = declared.split(';')[0]?.trim().toLowerCase() ?? '';
  return MEDIA_TYPE.test(base) ? base : 'application/octet-stream';
}

/**
 * Stores the files merchants upload.
 *
 * Why: B157 and RESOLUTIONS identity-platform-16: the input of a File service order, the documents of a KYC submission and the
 * receipt of a bank transfer are files a merchant uploads first and refers to by id. One path keeps the limits and the owner rule in
 * one place: 1 byte to 25 MiB, any media type, the name reduced to a base name, the object in the files bucket under a key built
 * here (never from the name), a `files` row owned by the merchant (`owner_type client`) with the size and the SHA-256. A storefront
 * customer uploads a transfer receipt the same way (feature 21): proof types only, at most 5 MiB, owned by the customer.
 *
 * Quotas (decision 053): a merchant that waits for approval keeps at most 10 uploaded files (50 MiB); an approved merchant uploads at most
 * 500 files (5 GiB) in 24 hours; a customer 30 files (100 MiB) in 24 hours. They are checked before the object is written (no object is
 * stored for an obvious refusal) and again, under a transaction lock of the owner, together with the row insert (exact under concurrency).
 * A refusal is `422 VALIDATION_FAILED` on `file` with the code `quota`.
 *
 * Side effects: one object in storage, one `files` row; the access is logged at info without the file name. An object whose row could
 * not be written is deleted again (best effort).
 *
 * @see docs/contract/MISMATCHES.md (B157)
 */
@Injectable()
export class FileUploadService {
  private readonly logger = new Logger(FileUploadService.name);

  constructor(
    private readonly db: DbService,
    private readonly storage: StorageService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /**
   * Stores one file for a merchant.
   *
   * @param clientId the merchant who owns the file
   * @param input the file name, media type and content
   * @returns the stored file
   * @throws {AppError} `VALIDATION_FAILED` on `file` (`empty`, or `quota`: decision 053), `PAYLOAD_TOO_LARGE` (over 25 MiB), `UNAVAILABLE`
   *   (storage is down)
   */
  async upload(clientId: number, input: UploadInput): Promise<StoredFileView> {
    const rules = (await merchantIsApproved(this.db.db, clientId)) ? [MERCHANT_DAILY_QUOTA] : [PENDING_MERCHANT_QUOTA];
    return this.store({ type: 'client', id: clientId }, input, MAX_UPLOAD_BYTES, rules);
  }

  /**
   * Stores one file for a storefront customer: a receipt (PDF, JPEG or PNG) of at most 5 MiB.
   *
   * Why: plan 21 § 7.1 route 9: a manual top-up needs its transfer receipt, and the store surface is public, so the upload is small and
   * of the proof types only (risk K15). The file is owned by the customer, so only that customer's top-up can use it.
   *
   * Side effects: puts one object into the files bucket; inserts one `files` row (`owner_type 'customer'`).
   *
   * @param customerId the customer who owns the file
   * @param input the file name, media type and content
   * @param maxBytes the largest file (the route's limit)
   * @returns the stored file
   * @throws {AppError} `VALIDATION_FAILED` on `file` (`empty`, `type`, `quota`: decision 053), `PAYLOAD_TOO_LARGE`, `UNAVAILABLE` (storage is down)
   */
  async uploadForCustomer(customerId: number, input: UploadInput, maxBytes: number): Promise<StoredFileView> {
    if (input.data.length > 0 && !PROOF_MIME_TYPES.includes(cleanMediaType(input.mime))) {
      throw new AppError('VALIDATION_FAILED', {
        detail: 'Upload a PDF, JPEG or PNG file.',
        errors: [{ field: 'file', code: 'type', message: 'Upload a PDF, JPEG or PNG file.' }],
      });
    }
    return this.store({ type: 'customer', id: customerId }, input, maxBytes, [CUSTOMER_DAILY_QUOTA]);
  }

  private async store(
    owner: { readonly type: 'client' | 'customer'; readonly id: number },
    input: UploadInput,
    maxBytes: number,
    rules: readonly UploadQuotaRule[],
  ): Promise<StoredFileView> {
    if (input.data.length === 0) {
      throw new AppError('VALIDATION_FAILED', {
        detail: 'The file is empty.',
        errors: [{ field: 'file', code: 'empty', message: 'The file is empty.' }],
      });
    }
    if (input.data.length > maxBytes) {
      throw new AppError('PAYLOAD_TOO_LARGE', {
        detail: `The file is larger than ${Math.round(maxBytes / (1024 * 1024))} MiB.`,
      });
    }
    const filename = cleanUploadName(input.filename);
    const mime = cleanMediaType(input.mime);
    const now = this.clock.now();
    // Decision 053: an obvious refusal stores no object; the count is checked again under the owner's lock with the insert.
    await assertUploadQuota(this.db.db, owner, rules, input.data.length, now);
    const key = `files/${now.getUTCFullYear()}/${String(now.getUTCMonth() + 1).padStart(2, '0')}/${randomUUID()}`;
    const object = await this.storage.put(key, input.data, { contentType: mime, maxBytes });
    try {
      const row = await this.db.runInTransaction(async ({ tx }) => {
        await lockUploadOwner(tx, owner);
        await assertUploadQuota(tx, owner, rules, object.size, now);
        return insertFile(tx, {
          bucket: object.bucket,
          key: object.key,
          filename,
          mime,
          size: object.size,
          sha256: object.sha256,
          ownerType: owner.type,
          ownerId: owner.id,
        });
      });
      this.logger.log(`file ${row.id} uploaded by ${owner.type} ${owner.id} (${row.size} bytes, ${row.mime})`);
      return {
        id: row.id,
        filename: row.filename,
        size: row.size,
        mime: row.mime,
        sha256: row.sha256,
        createdAt: row.createdAt.toISOString(),
      };
    } catch (error) {
      await this.storage.delete(key).catch((cleanup: unknown) => {
        this.logger.warn(`Could not remove the object of a file that was not recorded: ${String(cleanup)}`);
      });
      throw error;
    }
  }

  /**
   * Removes a file the caller stored a moment ago and no longer needs: its row and its object.
   *
   * Why: P4a (B166). The Dhru `placefileorder` stores the upload first and places the order second; when the placement is refused or rolled
   * back (price changed, not enough credit, a duplicate) the file must not stay behind. Nothing is removed when anything still points at the
   * file (an order, a KYC submission, a ticket message, a dispute: see {@link deleteUnreferencedClientFile}), when it is not the merchant's, or
   * when it is already gone. It never throws: cleanup must not hide the refusal that caused it, and an object that could not be deleted is
   * only logged (the row is gone, so the file can no longer be read or attached).
   *
   * Side effects: deletes one `files` row and its object.
   *
   * @param clientId the merchant who owns the file
   * @param fileId the file's id
   * @returns true when the file was removed
   */
  async discard(clientId: number, fileId: number): Promise<boolean> {
    try {
      const object = await deleteUnreferencedClientFile(this.db.db, clientId, fileId);
      if (!object) return false;
      await this.storage.delete(object.key).catch((cleanup: unknown) => {
        this.logger.warn(`Could not remove the object of discarded file ${fileId}: ${String(cleanup)}`);
      });
      return true;
    } catch (error) {
      // A row with a foreign key still points at the file: it is in use, keep it.
      if (!isForeignKeyViolation(error)) {
        this.logger.warn(`Could not discard file ${fileId} of merchant ${clientId}: ${String(error)}`);
      }
      return false;
    }
  }
}

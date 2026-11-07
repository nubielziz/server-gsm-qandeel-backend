// FileUploadService: the one upload path of merchant files (map domain G, B157): `POST /v1/files` for REST v1, `POST /client/files` for the
// merchant portal and the Dhru file order. It checks the file, stores the object in the files bucket and writes the `files` row.
import { randomUUID } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { CLOCK, type Clock } from '../../../common/clock';
import { AppError } from '../../../common/errors';
import { DbService } from '../../../infra/db';
import { DEFAULT_MAX_OBJECT_BYTES, StorageService } from '../../../infra/storage';
import { insertFile } from '../infra/file.repository';

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
 * here (never from the name), a `files` row owned by the merchant (`owner_type client`) with the size and the SHA-256.
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
   * @throws {AppError} `VALIDATION_FAILED` on `file` (empty), `PAYLOAD_TOO_LARGE` (over 25 MiB), `UNAVAILABLE` (storage is down)
   */
  async upload(clientId: number, input: UploadInput): Promise<StoredFileView> {
    if (input.data.length === 0) {
      throw new AppError('VALIDATION_FAILED', {
        detail: 'The file is empty.',
        errors: [{ field: 'file', code: 'empty', message: 'The file is empty.' }],
      });
    }
    if (input.data.length > MAX_UPLOAD_BYTES) {
      throw new AppError('PAYLOAD_TOO_LARGE', { detail: 'The file is larger than 25 MiB.' });
    }
    const filename = cleanUploadName(input.filename);
    const mime = cleanMediaType(input.mime);
    const now = this.clock.now();
    const key = `files/${now.getUTCFullYear()}/${String(now.getUTCMonth() + 1).padStart(2, '0')}/${randomUUID()}`;
    const object = await this.storage.put(key, input.data, { contentType: mime, maxBytes: MAX_UPLOAD_BYTES });
    try {
      const row = await insertFile(this.db.db, {
        bucket: object.bucket,
        key: object.key,
        filename,
        mime,
        size: object.size,
        sha256: object.sha256,
        ownerType: 'client',
        ownerId: clientId,
      });
      this.logger.log(`file ${row.id} uploaded by merchant ${clientId} (${row.size} bytes, ${row.mime})`);
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
}

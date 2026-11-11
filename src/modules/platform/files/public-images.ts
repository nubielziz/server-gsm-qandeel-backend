// PublicImages: the public service pictures of the storefront (feature 22): checked and cleaned bytes stored once under their SHA-256 in the
// private bucket (`media/<sha256>.<ext>`), the public path of a stored picture, and the bytes the public media route serves.
import { createHash } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { and, eq, inArray } from 'drizzle-orm';
import { AppError } from '../../../common/errors';
import { type DbExecutor, isUniqueViolation } from '../../../infra/db';
import { StorageService } from '../../../infra/storage';
import { cleanUploadName } from '../application/file-upload.service';
import { files } from '../db/schema';
import { PUBLIC_IMAGE_MAX_BYTES, inspectImage } from './image-inspect';

/**
 * The name of a public picture: the hex SHA-256 of its cleaned bytes and its extension.
 *
 * Why: the media route builds the object key only from a name that matches this pattern, so no other object of the bucket (a KYC
 * document, an order file, an invoice) can ever be reached through it: their keys never have this form under `media/`.
 */
export const PUBLIC_IMAGE_NAME = /^[0-9a-f]{64}\.(jpg|png|webp)$/;

/** The key prefix of the public pictures; only {@link PublicImages} writes under it. */
export const PUBLIC_IMAGE_PREFIX = 'media/';

/** The public path a picture is served under (root-relative; the site's `/store/v1/*` rewrite reaches it). */
export const PUBLIC_MEDIA_PATH = '/store/v1/media/';

const MIME_OF_EXT = { jpg: 'image/jpeg', png: 'image/png', webp: 'image/webp' } as const;

/** A stored public picture. */
export interface StoredPublicImage {
  /** The `files` row (what `service_listings.image_file_id` points at). */
  readonly fileId: number;
  /** `<sha256>.<ext>`: the last segment of the public path. */
  readonly name: string;
  readonly mime: string;
  readonly width: number;
  readonly height: number;
  /** Bytes after cleaning. */
  readonly size: number;
}

/** What {@link PublicImages.store} needs. */
export interface StorePublicImageInput {
  readonly bytes: Uint8Array;
  /** The name the client sent; reduced to a base name for the `files` row only (never part of the key or the URL). */
  readonly filename: string;
  /** The staff member who uploads it (the `files` owner). */
  readonly staffId: number;
}

/** A picture read for the media route. */
export interface PublicImageBytes {
  readonly bytes: Uint8Array;
  readonly mime: string;
  /** The SHA-256 of the bytes (the name without its extension): the strong ETag. */
  readonly sha256: string;
}

/**
 * Stores, names and reads the public service pictures.
 *
 * Why: feature 22 (§2.6 of its plan): staff upload a picture per service and the storefront shows it to everyone. The bucket stays
 * private (it also holds KYC documents and order files); the API serves the pictures itself from `GET /store/v1/media/:name`, and since
 * the name is the SHA-256 of the bytes the answer never changes and is cached for a year. Every picture passes {@link inspectImage}
 * first (type from the magic bytes, structure walk, limits, metadata removed), so what is stored and served is a clean JPEG, PNG or WebP.
 * The same bytes uploaded twice are one object and one `files` row.
 *
 * Side effects: `store` puts one object under `media/` and inserts one `files` row (`owner_type staff`) unless both exist already.
 */
@Injectable()
export class PublicImages {
  constructor(private readonly storage: StorageService) {}

  /**
   * Checks, cleans and stores a picture (or finds the stored copy of the same bytes).
   *
   * Why: the object is written before the row, outside the caller's transaction; a row that already names the key is reused. A failed
   * row insert leaves the object (its key is shared by identical uploads and the next one reuses it).
   *
   * @param db the database (not a transaction: the row must exist whatever the caller's transaction does)
   * @param input the bytes, the client's file name and the staff member
   * @returns the stored picture
   * @throws {AppError} `VALIDATION_FAILED` on `file` (`empty`, `unsupported_type`, `corrupt`, `animated`, `too_small`,
   *   `too_large_dimensions`, `rotated`); `PAYLOAD_TOO_LARGE` (over 2 MiB); `UNAVAILABLE` (storage is down)
   */
  async store(db: DbExecutor, input: StorePublicImageInput): Promise<StoredPublicImage> {
    const inspected = inspectImage(input.bytes);
    if (!inspected.ok) {
      if (inspected.code === 'too_large') throw new AppError('PAYLOAD_TOO_LARGE', { detail: inspected.message });
      throw new AppError('VALIDATION_FAILED', {
        detail: inspected.message,
        errors: [{ field: 'file', code: inspected.code, message: inspected.message }],
      });
    }
    const sha256 = createHash('sha256').update(inspected.bytes).digest('hex');
    const name = `${sha256}.${inspected.ext}`;
    const key = PUBLIC_IMAGE_PREFIX + name;
    const view = (fileId: number): StoredPublicImage => ({
      fileId,
      name,
      mime: inspected.mime,
      width: inspected.width,
      height: inspected.height,
      size: inspected.bytes.length,
    });
    const known = await this.findByKey(db, key);
    if (known !== undefined) return view(known);
    const object = await this.storage.put(key, inspected.bytes, {
      contentType: inspected.mime,
      maxBytes: PUBLIC_IMAGE_MAX_BYTES,
    });
    try {
      const [row] = await db
        .insert(files)
        .values({
          bucket: object.bucket,
          key,
          filename: cleanUploadName(input.filename),
          mime: inspected.mime,
          size: object.size,
          sha256: object.sha256,
          ownerType: 'staff',
          ownerId: input.staffId,
        })
        .returning({ id: files.id });
      return view(row!.id);
    } catch (error) {
      // Two uploads of the same picture at once: the other one wrote the row; use it.
      if (isUniqueViolation(error, 'files_object_uq')) {
        const raced = await this.findByKey(db, key);
        if (raced !== undefined) return view(raced);
      }
      throw error;
    }
  }

  /**
   * The public paths of stored pictures.
   *
   * @param db the database or a transaction
   * @param fileIds `files` ids (duplicates and `null` are fine)
   * @returns `/store/v1/media/<name>` by file id, for the ids that are public pictures; any other file is absent
   */
  async urlsOf(db: DbExecutor, fileIds: readonly (number | null)[]): Promise<Map<number, string>> {
    const ids = [...new Set(fileIds.filter((id): id is number => id !== null))];
    if (ids.length === 0) return new Map();
    const rows = await db
      .select({ id: files.id, key: files.key })
      .from(files)
      .where(and(inArray(files.id, ids), eq(files.bucket, this.storage.bucket)));
    const out = new Map<number, string>();
    for (const row of rows) {
      const name = row.key.slice(PUBLIC_IMAGE_PREFIX.length);
      if (row.key.startsWith(PUBLIC_IMAGE_PREFIX) && PUBLIC_IMAGE_NAME.test(name))
        out.set(row.id, PUBLIC_MEDIA_PATH + name);
    }
    return out;
  }

  /**
   * Reads a public picture by its name.
   *
   * Why: the media route reads no database row; the name alone builds the key, and only a name of the public form is looked up.
   *
   * @param name the last path segment of the request
   * @returns the bytes, the media type (from the extension) and the SHA-256, or `undefined` for a name of another form or a missing object
   * @throws {AppError} `UNAVAILABLE` when the object store cannot be reached
   */
  async read(name: string): Promise<PublicImageBytes | undefined> {
    if (!PUBLIC_IMAGE_NAME.test(name)) return undefined;
    const object = await this.storage.get(PUBLIC_IMAGE_PREFIX + name);
    if (!object) return undefined;
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of object.body as AsyncIterable<Buffer | string>) {
      const buffer = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk;
      size += buffer.length;
      // Only this class writes under media/, at most 2 MiB; anything larger is not one of ours.
      if (size > PUBLIC_IMAGE_MAX_BYTES) {
        object.body.destroy();
        return undefined;
      }
      chunks.push(buffer);
    }
    const [sha256, ext] = name.split('.') as [string, keyof typeof MIME_OF_EXT];
    return { bytes: Buffer.concat(chunks), mime: MIME_OF_EXT[ext], sha256 };
  }

  private async findByKey(db: DbExecutor, key: string): Promise<number | undefined> {
    const [row] = await db
      .select({ id: files.id })
      .from(files)
      .where(and(eq(files.bucket, this.storage.bucket), eq(files.key, key)))
      .limit(1);
    return row?.id;
  }
}

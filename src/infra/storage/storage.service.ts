// S3-compatible object storage (decision 004): put with size limit and SHA-256, get as a stream, head, delete and short-lived
// presigned download links. MinIO locally, any S3-compatible store in production.
import { createHash } from 'node:crypto';
import type { Readable } from 'node:stream';
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { Inject, Injectable, type OnApplicationShutdown } from '@nestjs/common';
import { CLOCK, type Clock } from '../../common/clock';
import { AppError } from '../../common/errors';
import { APP_CONFIG, type AppConfig } from '../../config';
import { constantTimeEqual } from '../crypto';
import { assertContentType, assertObjectKey, attachmentDisposition } from './storage-names';

/**
 * Default size limit of one stored object: 25 MiB.
 *
 * Why: the API buffers an upload in memory while it hashes it (S3 needs the length before it accepts the body), so the
 * limit also bounds memory per upload.
 */
export const DEFAULT_MAX_OBJECT_BYTES = 25 * 1024 * 1024;
/** The largest limit a caller may ask for. Larger files need a streaming multipart upload (not built yet). */
export const HARD_MAX_OBJECT_BYTES = 64 * 1024 * 1024;
/** Lifetime of a presigned link when the caller gives none: 5 minutes ("short-lived", contract GET /admin/files/:id). */
export const DEFAULT_PRESIGN_SECONDS = 300;
/** The longest lifetime S3 accepts for a signature (SigV4): 7 days. */
export const MAX_PRESIGN_SECONDS = 7 * 24 * 60 * 60;
/** How long the health check waits for the bucket. */
const PING_TIMEOUT_MS = 1_500;

/** What `put` accepts: bytes, text, or a stream (Node `Readable` or a web `ReadableStream`). */
export type StorageBody = Uint8Array | string | AsyncIterable<Uint8Array | string>;

/**
 * Options of {@link StorageService.put}.
 *
 * Why: the files module stores uploads with the type the client declared, a size limit per route and, when the client
 * sent one, the checksum to verify.
 */
export interface PutOptions {
  /** Media type stored with the object and sent on download. */
  readonly contentType: string;
  /** Refuse bodies larger than this many bytes (default 25 MiB, at most 64 MiB). */
  readonly maxBytes?: number;
  /** Hex SHA-256 the client claims; the upload is refused when the content hashes differently. */
  readonly expectedSha256?: string;
}

/**
 * The result of a successful `put`.
 *
 * Why: the `files` table stores bucket, key, size and sha256 (duplicate detection) next to the file name and owner.
 */
export interface StoredObject {
  readonly bucket: string;
  readonly key: string;
  readonly size: number;
  /** Hex SHA-256 of the content. */
  readonly sha256: string;
  readonly contentType: string;
  readonly etag: string | undefined;
}

/** What `head` knows about an object. */
export interface ObjectInfo {
  readonly size: number;
  readonly contentType: string;
  readonly etag: string | undefined;
  readonly lastModified: Date | undefined;
}

/** An object being downloaded: its metadata and the body as a Node stream. The caller must read it or destroy it. */
export interface ObjectStream extends ObjectInfo {
  readonly body: Readable;
}

/** Options of {@link StorageService.presignGet}. */
export interface PresignOptions {
  /** Lifetime of the link in seconds; default 300, at most 7 days. */
  readonly expiresInSeconds?: number;
  /** File name the browser saves the download under; sets `Content-Disposition: attachment`. */
  readonly filename?: string;
  /** Overrides the media type of the download. */
  readonly contentType?: string;
}

/** Why S3 said no: the object is not there. */
function isNotFound(error: unknown): boolean {
  const name = (error as { name?: string } | null)?.name;
  return name === 'NotFound' || name === 'NoSuchKey';
}

/**
 * Turns "S3 cannot be reached or is failing" into `503 UNAVAILABLE`; anything else (access denied, bad request, a bug)
 * stays as it is so it surfaces as a server error with its stack in the log.
 */
function translate(error: unknown): unknown {
  if (error instanceof AppError) return error;
  const status = (error as { $metadata?: { httpStatusCode?: number } } | null)?.$metadata?.httpStatusCode;
  if (status !== undefined && status < 500) return error;
  return new AppError('UNAVAILABLE', { detail: 'File storage is not available right now.', cause: error });
}

/** Reads a body into one buffer, stopping as soon as it exceeds the limit. */
async function collect(body: StorageBody, maxBytes: number): Promise<Buffer> {
  const tooLarge = () => new AppError('PAYLOAD_TOO_LARGE', { detail: `The file is larger than ${maxBytes} bytes.` });
  if (typeof body === 'string' || body instanceof Uint8Array) {
    const data =
      typeof body === 'string' ? Buffer.from(body, 'utf8') : Buffer.from(body.buffer, body.byteOffset, body.byteLength);
    if (data.length > maxBytes) throw tooLarge();
    return data;
  }
  const chunks: Buffer[] = [];
  let size = 0;
  // Leaving the loop early (the throw below) closes the stream.
  for await (const chunk of body) {
    const data =
      typeof chunk === 'string'
        ? Buffer.from(chunk, 'utf8')
        : Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
    size += data.length;
    if (size > maxBytes) throw tooLarge();
    chunks.push(data);
  }
  return Buffer.concat(chunks, size);
}

/**
 * Stores and serves files in the S3-compatible bucket.
 *
 * Why: decision 004: uploads (File services, KYC documents, receipts) and result files live in object storage, not in
 * Postgres; downloads go through short-lived signed links so the API never proxies large files. The app speaks plain S3
 * through `@aws-sdk/client-s3` (path-style for MinIO), so production can use any S3-compatible store.
 *
 * Side effects: network calls to the S3 endpoint; the client is created without connecting and destroyed at shutdown.
 * An unreachable or failing store becomes `503 UNAVAILABLE`.
 *
 * @see docs/decisions/004-local-s3-minio.md
 */
@Injectable()
export class StorageService implements OnApplicationShutdown {
  /** The bucket every object lives in (`S3_BUCKET`); the `files` table stores it next to the key. */
  readonly bucket: string;
  private readonly s3: S3Client;

  constructor(
    @Inject(APP_CONFIG) config: AppConfig,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {
    this.bucket = config.s3.bucket;
    this.s3 = new S3Client({
      endpoint: config.s3.endpoint,
      region: config.s3.region,
      forcePathStyle: config.s3.forcePathStyle,
      credentials: { accessKeyId: config.s3.accessKeyId, secretAccessKey: config.s3.secretAccessKey },
      // Compute checksums only where they are required, so S3-compatible stores that do not know the newer default
      // (CRC32 trailers) keep working; the SHA-256 of `put` is sent explicitly.
      requestChecksumCalculation: 'WHEN_REQUIRED',
      responseChecksumValidation: 'WHEN_REQUIRED',
      // A silent store must not hold a request forever.
      requestHandler: { connectionTimeout: 5_000, requestTimeout: 30_000 },
    });
  }

  /**
   * Stores an object.
   *
   * Why: decision 004. The content is hashed while it is read; S3 verifies the same SHA-256 on its side, so a corrupted
   * transfer is refused instead of stored. Streams are buffered in memory up to the limit, because S3 needs the length.
   *
   * Side effects: one `PutObject`; an existing object under the key is replaced.
   *
   * @param key the object key (letters, digits and `. _ = + -` in `/` segments)
   * @param body bytes, text or a stream
   * @param options content type, size limit and optional expected checksum
   * @returns bucket, key, size, SHA-256 (hex), content type and ETag
   * @throws {AppError} `PAYLOAD_TOO_LARGE` over the limit (the stream is closed at once), `BAD_REQUEST` when
   *   `expectedSha256` does not match, `UNAVAILABLE` when S3 cannot be reached
   * @throws {RangeError} for an invalid key, content type or limit
   */
  async put(key: string, body: StorageBody, options: PutOptions): Promise<StoredObject> {
    assertObjectKey(key);
    assertContentType(options.contentType);
    const maxBytes = options.maxBytes ?? DEFAULT_MAX_OBJECT_BYTES;
    if (!Number.isInteger(maxBytes) || maxBytes < 1 || maxBytes > HARD_MAX_OBJECT_BYTES) {
      throw new RangeError(`maxBytes must be an integer from 1 to ${HARD_MAX_OBJECT_BYTES}, got ${maxBytes}`);
    }
    const data = await collect(body, maxBytes);
    const digest = createHash('sha256').update(data).digest();
    const sha256 = digest.toString('hex');
    if (options.expectedSha256 !== undefined && !constantTimeEqual(sha256, options.expectedSha256.toLowerCase())) {
      throw new AppError('BAD_REQUEST', { detail: 'The checksum does not match the file content.' });
    }
    try {
      const result = await this.s3.send(
        new PutObjectCommand({
          Bucket: this.bucket,
          Key: key,
          Body: data,
          ContentLength: data.length,
          ContentType: options.contentType,
          ChecksumSHA256: digest.toString('base64'),
        }),
      );
      return {
        bucket: this.bucket,
        key,
        size: data.length,
        sha256,
        contentType: options.contentType,
        etag: result.ETag,
      };
    } catch (error) {
      throw translate(error);
    }
  }

  /**
   * Opens an object for download as a stream.
   *
   * Why: the API forwards or inspects files without loading them into memory.
   *
   * @param key the object key
   * @returns the metadata and the body stream (read it to the end or destroy it), or `null` when there is no such object
   * @throws {AppError} `UNAVAILABLE` when S3 cannot be reached
   */
  async get(key: string): Promise<ObjectStream | null> {
    assertObjectKey(key);
    try {
      const result = await this.s3.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
      const body = result.Body as Readable | undefined;
      if (!body || typeof body.pipe !== 'function') throw new Error('S3 returned a body that is not a Node stream');
      return {
        body,
        size: result.ContentLength ?? 0,
        contentType: result.ContentType ?? 'application/octet-stream',
        etag: result.ETag,
        lastModified: result.LastModified,
      };
    } catch (error) {
      if (isNotFound(error)) return null;
      throw translate(error);
    }
  }

  /**
   * Reads the metadata of an object without downloading it.
   *
   * @param key the object key
   * @returns size, type, ETag and modification time, or `null` when there is no such object
   * @throws {AppError} `UNAVAILABLE` when S3 cannot be reached
   */
  async head(key: string): Promise<ObjectInfo | null> {
    assertObjectKey(key);
    try {
      const result = await this.s3.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }));
      return {
        size: result.ContentLength ?? 0,
        contentType: result.ContentType ?? 'application/octet-stream',
        etag: result.ETag,
        lastModified: result.LastModified,
      };
    } catch (error) {
      if (isNotFound(error)) return null;
      throw translate(error);
    }
  }

  /**
   * Deletes an object. Deleting an object that does not exist is not an error (S3 answers 204 either way).
   *
   * Side effects: one `DeleteObject`.
   *
   * @param key the object key
   * @returns resolves when the object is gone
   * @throws {AppError} `UNAVAILABLE` when S3 cannot be reached
   */
  async delete(key: string): Promise<void> {
    assertObjectKey(key);
    try {
      await this.s3.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
    } catch (error) {
      throw translate(error);
    }
  }

  /**
   * Makes a short-lived link that downloads an object without credentials.
   *
   * Why: the file routes answer `302` to such a link (contract GET /admin/files/:id), so downloads go straight from the
   * store to the browser. The link works for anyone who holds it until it expires, so keep the lifetime short and never
   * log it.
   *
   * Side effects: none (the signature is computed locally; the object is not checked).
   *
   * @param key the object key
   * @param options lifetime (default 5 minutes), download file name and media type
   * @returns the signed URL
   * @throws {RangeError} for an invalid key, a lifetime outside 1 second to 7 days, or an invalid content type
   */
  async presignGet(key: string, options: PresignOptions = {}): Promise<string> {
    assertObjectKey(key);
    const expiresIn = options.expiresInSeconds ?? DEFAULT_PRESIGN_SECONDS;
    if (!Number.isInteger(expiresIn) || expiresIn < 1 || expiresIn > MAX_PRESIGN_SECONDS) {
      throw new RangeError(`A link lives from 1 to ${MAX_PRESIGN_SECONDS} seconds, got ${expiresIn}`);
    }
    if (options.contentType !== undefined) assertContentType(options.contentType);
    return getSignedUrl(
      this.s3,
      new GetObjectCommand({
        Bucket: this.bucket,
        Key: key,
        ResponseContentDisposition:
          options.filename === undefined ? undefined : attachmentDisposition(options.filename),
        ResponseContentType: options.contentType,
      }),
      // The signing date comes from the injected clock (decision 031), so the lifetime of a link is counted on the clock the
      // rest of the code uses; the store checks the expiry against its own time.
      { expiresIn, signingDate: this.clock.now() },
    );
  }

  /**
   * Checks that the bucket answers.
   *
   * Why: the `storage` health indicator (non-critical) and readiness probes use it.
   *
   * @returns resolves when the bucket exists and the credentials work
   * @throws {Error} when the store is unreachable, the bucket is missing or the credentials are refused
   */
  async ping(): Promise<void> {
    await this.s3.send(new HeadBucketCommand({ Bucket: this.bucket }), {
      abortSignal: AbortSignal.timeout(PING_TIMEOUT_MS),
    });
  }

  /** Closes the client's connections. */
  onApplicationShutdown(): void {
    this.s3.destroy();
  }
}

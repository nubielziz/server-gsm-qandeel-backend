// Multipart form bodies (decision 026 note, B157): the three routes that accept them (a Dhru call, `POST /v1/files` and `POST /client/files`)
// get their text fields and uploaded files as one plain object before the guards run, so Dhru credentials in a multipart body are read like
// those of a form body, and the maintenance stage sees the Dhru `action`.
import type { FastifyInstance } from 'fastify';
import { AppError } from './errors';
import { requestPath } from './pipeline/request-path';

/**
 * The largest multipart body any route takes: a file of 25 MiB plus the form fields around it.
 *
 * Why: B157 limits an upload to 25 MiB; the body is buffered in memory before it is parsed (the storage service buffers too), so the
 * bound is also the memory one request may use.
 */
export const MULTIPART_MAX_BYTES = 25 * 1024 * 1024 + 256 * 1024;

/**
 * The route templates that accept `multipart/form-data`; every other route answers `415`.
 *
 * Why: only these routes read uploads or Dhru fields from a multipart body; refusing the rest before the body is read keeps the
 * big buffer to the routes that need it.
 */
export const MULTIPART_ROUTES: ReadonlySet<string> = new Set(['/api/index.php', '/v1/files', '/client/files']);

/**
 * A file part of a multipart body.
 *
 * Why: B157: the upload routes need the name, the media type the client declared and the bytes; the class (rather than a plain
 * object) lets a contract tell an upload from a text field that happens to look like one.
 */
export class UploadedFile {
  /**
   * @param fieldName the name of the form part
   * @param filename the file name the client sent (not trusted: reduce it before it is stored or shown)
   * @param mime the media type the client declared (`application/octet-stream` when it sent none)
   * @param data the file content
   */
  constructor(
    readonly fieldName: string,
    readonly filename: string,
    readonly mime: string,
    readonly data: Buffer,
  ) {}

  /** The size of the content in bytes. */
  get size(): number {
    return this.data.length;
  }
}

/** A parsed multipart body: text fields as strings (a repeated field is a list) and files as {@link UploadedFile}. */
export type MultipartBody = Record<string, string | string[] | UploadedFile>;

/** What Bun's multipart parser yields for a file part. */
interface FormPartFile {
  readonly name: string;
  readonly type: string;
  arrayBuffer(): Promise<ArrayBuffer>;
}

/** Field names that must never become keys of the parsed object. */
const FORBIDDEN_FIELDS: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype']);

/**
 * Parses a multipart body held in memory.
 *
 * @param body the raw bytes of the body
 * @param contentType the `Content-Type` header (it carries the boundary)
 * @returns the text fields and the files
 * @throws {AppError} `BAD_REQUEST` when the body is not valid multipart
 */
export async function parseMultipart(body: Buffer, contentType: string): Promise<MultipartBody> {
  let entries: Iterable<[string, string | FormPartFile]>;
  try {
    // eslint-disable-next-line @typescript-eslint/no-deprecated -- the body is already bounded (25 MiB + fields) and buffered; Bun's parser reads it in memory
    const form = await new Response(body, { headers: { 'content-type': contentType } }).formData();
    // The lib typings of FormData only know string values; Bun's parser yields `File` objects for file parts.
    entries = (form as unknown as { entries(): Iterable<[string, string | FormPartFile]> }).entries();
  } catch (error) {
    throw new AppError('BAD_REQUEST', {
      detail: 'The multipart body could not be read. Check the boundary and the form parts.',
      cause: error,
    });
  }
  const out: MultipartBody = {};
  for (const [name, value] of entries) {
    if (FORBIDDEN_FIELDS.has(name)) continue;
    const part =
      typeof value === 'string'
        ? value
        : new UploadedFile(
            name,
            value.name,
            value.type === '' ? 'application/octet-stream' : value.type,
            Buffer.from(await value.arrayBuffer()),
          );
    const known = out[name];
    if (known === undefined) out[name] = part;
    // A repeated text field is a list (a credential given twice is not a credential); a repeated file part keeps the first.
    else if (typeof part === 'string' && typeof known === 'string') out[name] = [known, part];
    else if (typeof part === 'string' && Array.isArray(known)) known.push(part);
  }
  return out;
}

/**
 * Teaches Fastify to read `multipart/form-data` on the routes of {@link MULTIPART_ROUTES} and to refuse it everywhere else.
 *
 * Why: B157 and decision 026: file uploads and multipart Dhru calls. The parser runs before the guards, like the JSON and form
 * parsers, so the body limit is the bound of what an unauthenticated caller can make us buffer; a multipart body on any other route is
 * refused before it is read. Call it once, before the routes are registered (`configureApp`).
 *
 * Side effects: adds a content-type parser and a `preParsing` hook to the Fastify instance.
 *
 * @param fastify the underlying Fastify instance
 */
export function registerMultipartBodies(fastify: FastifyInstance): void {
  fastify.addHook('preParsing', (request, _reply, payload, done) => {
    const multipart = (request.headers['content-type'] ?? '').toLowerCase().startsWith('multipart/form-data');
    if (multipart && !MULTIPART_ROUTES.has(request.routeOptions?.url ?? requestPath(request))) {
      done(new AppError('UNSUPPORTED_MEDIA_TYPE', { detail: 'This endpoint does not accept multipart/form-data.' }));
      return;
    }
    done(null, payload);
  });
  fastify.addContentTypeParser(
    'multipart/form-data',
    { parseAs: 'buffer', bodyLimit: MULTIPART_MAX_BYTES },
    (request, body, done) => {
      parseMultipart(body as Buffer, request.headers['content-type'] ?? '').then(
        (parsed) => done(null, parsed),
        (error: unknown) => done(error as Error),
      );
    },
  );
}

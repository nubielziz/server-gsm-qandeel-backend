// Per-route body limits above the general 1 MiB one (P4a, MISMATCHES B166): the Dhru route reads a form body up to the upload size.
import { Transform, type Readable } from 'node:stream';
import { type FastifyInstance, errorCodes } from 'fastify';
import { AppError } from './errors';
import { MULTIPART_MAX_BYTES } from './multipart';
import { requestPath } from './pipeline/request-path';

/**
 * The routes whose form and multipart bodies may be larger than the general body limit, and by how much.
 *
 * Why: B166. A Dhru `placefileorder` carries its file as `FILEDATA` inside the form field `parameters`, so the general 1 MiB limit cut a file
 * order off at about 590 KB of file before the action ran. The limit here is the multipart one ({@link MULTIPART_MAX_BYTES}: the 25 MiB file
 * limit of the upload routes plus the form fields), so a form and a multipart call of the Dhru endpoint are bound alike. `FILEDATA` is base64
 * inside the base64 `parameters`, so about 13 MiB of file fits a form; a larger file (up to 25 MiB) goes as a multipart file part. Every
 * other route, and every other content type of these routes, keeps the general limit.
 */
export const RAISED_BODY_LIMITS: ReadonlyMap<string, number> = new Map([['/api/index.php', MULTIPART_MAX_BYTES]]);

/**
 * Tells whether a `Content-Type` is a form body (`application/x-www-form-urlencoded` or `multipart/form-data`).
 *
 * Why: only form bodies get the raised limit of {@link RAISED_BODY_LIMITS}; the large-body counter of the per-IP limiter uses the same test.
 *
 * @param contentType the `Content-Type` header, if any
 * @returns true for a form type, with parameters and in any case
 */
export function isFormContentType(contentType: string | undefined): boolean {
  const type = (contentType ?? '').toLowerCase();
  return type.startsWith('application/x-www-form-urlencoded') || type.startsWith('multipart/form-data');
}

/**
 * Tells whether a `Content-Type` is a multipart body (`multipart/form-data`).
 *
 * Why: the over-limit answer differs by form type: a caller who already sends multipart must not be told to send multipart.
 *
 * @param contentType the `Content-Type` header, if any
 * @returns true for `multipart/form-data`, with parameters and in any case
 */
function isMultipartContentType(contentType: string | undefined): boolean {
  return (contentType ?? '').toLowerCase().startsWith('multipart/form-data');
}

/**
 * Passes a body through and fails it with `413` once it is longer than `limit`.
 *
 * Why: a body without a `Content-Length` (chunked) is judged only as it streams in.
 */
function capped(payload: Readable, limit: number): Readable {
  let seen = 0;
  const tap = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      seen += chunk.length;
      // Fastify's own error: its body reader turns any other error of a stream into a 400.
      if (seen > limit) callback(new errorCodes.FST_ERR_CTP_BODY_TOO_LARGE());
      else callback(null, chunk);
    },
  });
  payload.once('error', (error: Error) => tap.destroy(error));
  return payload.pipe(tap);
}

/**
 * Raises the body limit of the routes in {@link RAISED_BODY_LIMITS} for form and multipart bodies only.
 *
 * Why: B166. Fastify has one limit per route for every content type, so the route gets the raised limit and a `preParsing` hook holds any
 * other content type (JSON) of the route to the general limit again: by its declared length before it is read, and while it streams in when it
 * declares none. A form body over the raised limit is refused before it is read, with a sentence that says what to do (a urlencoded form:
 * send the file as a multipart part; a multipart body: a file can be up to 25 MiB).
 *
 * Side effects: adds an `onRoute` and a `preParsing` hook to the Fastify instance. Call it once, before the routes are registered
 * (`configureApp`), after `registerMultipartBodies`.
 *
 * @param fastify the underlying Fastify instance
 * @param generalLimit the general body limit in bytes (`config.http.bodyLimitBytes`)
 */
export function registerRaisedBodyLimits(fastify: FastifyInstance, generalLimit: number): void {
  fastify.addHook('onRoute', (route) => {
    const limit = RAISED_BODY_LIMITS.get(route.url);
    const methods = Array.isArray(route.method) ? route.method : [route.method];
    if (limit !== undefined && methods.includes('POST')) route.bodyLimit = limit;
  });
  fastify.addHook('preParsing', (request, _reply, payload, done) => {
    const raised = RAISED_BODY_LIMITS.get(request.routeOptions?.url ?? requestPath(request));
    if (raised === undefined) {
      done(null, payload);
      return;
    }
    const form = isFormContentType(request.headers['content-type']);
    const limit = form ? raised : generalLimit;
    const declared = Number(request.headers['content-length']);
    if (declared > limit) {
      done(
        new AppError('PAYLOAD_TOO_LARGE', {
          // A urlencoded form is told to switch to a multipart file part; a multipart body already is one, so it only learns the file limit.
          detail: !form
            ? 'The request body is larger than this endpoint accepts.'
            : isMultipartContentType(request.headers['content-type'])
              ? 'The request is too large. A file can be up to 25 MiB.'
              : 'The request is too large. Send a file as a multipart file part, up to 25 MiB.',
        }),
      );
      return;
    }
    // A form body is already bounded by the route's limit as it streams in; any other type is held to the general limit.
    done(null, form ? payload : capped(payload, generalLimit));
  });
}

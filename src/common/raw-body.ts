// The exact bytes of an incoming webhook body (decision 019: signatures cover the raw body, never a re-serialised object).
// Only requests on the `/webhooks` surface are tapped; every other request is parsed as usual.
import { Transform } from 'node:stream';
import type { FastifyInstance } from 'fastify';
import { requestPath } from './pipeline/request-path';
import { surfaceOfPath } from './surface';

/** The bytes read from the socket, per request; a WeakMap, so nothing is added to the request object itself. */
const bodies = new WeakMap<object, Buffer>();

/**
 * Returns the raw body of a webhook request.
 *
 * Why: gateway signatures are computed over the bytes the gateway sent; JSON parsing and serialising again would change
 * spacing, key order or number formatting and break the check. {@link registerRawBodyCapture} keeps the bytes.
 *
 * @param request the Fastify request
 * @returns the bytes of the body, or `undefined` when the request has none, was not tapped (a route outside `/webhooks`) or
 *   was not parsed yet (read it in a guard or handler, never in an `onRequest` hook)
 */
export function rawBodyOf(request: object): Buffer | undefined {
  return bodies.get(request);
}

/**
 * Keeps the raw body of every request on the `/webhooks` surface.
 *
 * Why: the gateway-signature guard (decision 018) verifies the signature over the exact bytes. A `preParsing` tap passes the
 * stream on unchanged, so the body limit, the content-length check and the JSON parser behave as for any other request, and
 * only webhook requests pay for the copy. Call it once, before the routes are registered (`configureApp`).
 *
 * Side effects: adds a `preParsing` hook to the Fastify instance.
 *
 * @param fastify the underlying Fastify instance
 */
export function registerRawBodyCapture(fastify: FastifyInstance): void {
  fastify.addHook('preParsing', (request, _reply, payload, done) => {
    if (surfaceOfPath(requestPath(request)) !== 'hooks') {
      done(null, payload);
      return;
    }
    const chunks: Buffer[] = [];
    const tap = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        chunks.push(chunk);
        callback(null, chunk);
      },
      flush(callback) {
        bodies.set(request, Buffer.concat(chunks));
        callback();
      },
    });
    // A stream error (client abort, body too large) must reach the parser through the tap.
    payload.once('error', (error: Error) => tap.destroy(error));
    done(null, payload.pipe(tap));
  });
}

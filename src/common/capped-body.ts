// A request body that fails once it passes a limit, whether or not it declared a length (decision 053): shared by the Dhru route's JSON bound and the multipart routes.
import { Transform, type Readable } from 'node:stream';
import { errorCodes } from 'fastify';

/**
 * Passes a body through and fails it with `413` once it is longer than `limit`.
 *
 * Why: a body without a `Content-Length` (chunked), or one longer than it says, is judged only as it streams in; a bound that looked
 * at the declared length alone would not hold for the bytes read (decision 053).
 *
 * @param payload the request body stream (Fastify's `preParsing` payload)
 * @param limit the most bytes the body may have
 * @returns the stream to hand back to Fastify: it errors with Fastify's own `FST_ERR_CTP_BODY_TOO_LARGE` (a `413`) at the first chunk that
 *   takes the total over `limit`
 */
export function cappedBody(payload: Readable, limit: number): Readable {
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

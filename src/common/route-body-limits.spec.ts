// Unit tests of the raised body limit of the Dhru endpoint (P4a, B166) on a bare Fastify instance set up like the API's: a 1 MiB limit, a form
// parser limited to it, and the one route whose form bodies may be larger.
import { afterEach, describe, expect, it } from 'bun:test';
import { Readable } from 'node:stream';
import Fastify, { type FastifyInstance } from 'fastify';
import { MULTIPART_MAX_BYTES } from './multipart';
import { RAISED_BODY_LIMITS, isFormContentType, registerRaisedBodyLimits } from './route-body-limits';

const GENERAL = 1024 * 1024;
const FORM = { 'content-type': 'application/x-www-form-urlencoded' };
const JSON_TYPE = { 'content-type': 'application/json' };

let app: FastifyInstance | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
});

/** A Fastify instance with the API's general limit, a form parser bound to it, the raised-limit hooks and two POST routes. */
async function build(): Promise<FastifyInstance> {
  const fastify = Fastify({ bodyLimit: GENERAL });
  fastify.addContentTypeParser(
    'application/x-www-form-urlencoded',
    { parseAs: 'buffer', bodyLimit: GENERAL },
    (_request, body, done) => done(null, { length: (body as Buffer).length }),
  );
  registerRaisedBodyLimits(fastify, GENERAL);
  const echo = (request: { body?: unknown }) => ({ body: request.body });
  fastify.post('/api/index.php', echo);
  fastify.post('/v1/orders', echo);
  await fastify.ready();
  app = fastify;
  return fastify;
}

describe('registerRaisedBodyLimits', () => {
  it('lets the Dhru endpoint read a form body over 1 MiB, up to the multipart limit', async () => {
    const fastify = await build();
    const big = await fastify.inject({
      method: 'POST',
      url: '/api/index.php',
      headers: FORM,
      payload: 'parameters=' + 'a'.repeat(2 * GENERAL),
    });
    expect(big.statusCode).toBe(200);
    expect(big.json().body.length).toBe('parameters='.length + 2 * GENERAL);
    const atLimit = await fastify.inject({
      method: 'POST',
      url: '/api/index.php',
      headers: FORM,
      payload: 'a'.repeat(MULTIPART_MAX_BYTES),
    });
    expect(atLimit.statusCode).toBe(200);
  });

  it('refuses a urlencoded form over the raised limit before it is read, saying how to send a bigger file', async () => {
    const fastify = await build();
    const res = await fastify.inject({
      method: 'POST',
      url: '/api/index.php',
      headers: FORM,
      payload: 'a'.repeat(MULTIPART_MAX_BYTES + 1),
    });
    expect(res.statusCode).toBe(413);
    expect(res.json().message).toBe('The request is too large. Send a file as a multipart file part, up to 25 MiB.');
  });

  it('refuses a multipart body over the raised limit with the file limit only, not an instruction to send multipart', async () => {
    const fastify = await build();
    const res = await fastify.inject({
      method: 'POST',
      url: '/api/index.php',
      headers: { 'content-type': 'multipart/form-data; boundary=x' },
      payload: 'a'.repeat(MULTIPART_MAX_BYTES + 1),
    });
    expect(res.statusCode).toBe(413);
    expect(res.json().message).toBe('The request is too large. A file can be up to 25 MiB.');
    expect(res.json().message).not.toContain('multipart');
  });

  it('keeps every other route at the general limit', async () => {
    const fastify = await build();
    const res = await fastify.inject({
      method: 'POST',
      url: '/v1/orders',
      headers: FORM,
      payload: 'a'.repeat(GENERAL + 1),
    });
    expect(res.statusCode).toBe(413);
    const fits = await fastify.inject({
      method: 'POST',
      url: '/v1/orders',
      headers: FORM,
      payload: 'a'.repeat(GENERAL),
    });
    expect(fits.statusCode).toBe(200);
  });

  it('holds a JSON body of the Dhru endpoint to the general limit, by its length and while it streams in', async () => {
    const fastify = await build();
    const json = (size: number) => JSON.stringify({ parameters: 'a'.repeat(size) });
    expect(
      (await fastify.inject({ method: 'POST', url: '/api/index.php', headers: JSON_TYPE, payload: json(100) }))
        .statusCode,
    ).toBe(200);
    const declared = await fastify.inject({
      method: 'POST',
      url: '/api/index.php',
      headers: JSON_TYPE,
      payload: json(GENERAL),
    });
    expect(declared.statusCode).toBe(413);
    // No Content-Length: a stream, read in chunks.
    const chunks = Array.from({ length: 4 }, () => Buffer.from('a'.repeat(GENERAL / 2)));
    const streamed = await fastify.inject({
      method: 'POST',
      url: '/api/index.php',
      headers: JSON_TYPE,
      payload: Readable.from([Buffer.from('{"parameters":"'), ...chunks, Buffer.from('"}')]),
    });
    expect(streamed.statusCode).toBe(413);
  });
});

describe('RAISED_BODY_LIMITS and isFormContentType', () => {
  it('names the Dhru endpoint only, with the multipart limit', () => {
    expect([...RAISED_BODY_LIMITS]).toEqual([['/api/index.php', MULTIPART_MAX_BYTES]]);
  });

  it('knows form content types, with parameters and in any case', () => {
    expect(isFormContentType('application/x-www-form-urlencoded; charset=utf-8')).toBe(true);
    expect(isFormContentType('Multipart/Form-Data; boundary=x')).toBe(true);
    expect(isFormContentType('application/json')).toBe(false);
    expect(isFormContentType(undefined)).toBe(false);
  });
});

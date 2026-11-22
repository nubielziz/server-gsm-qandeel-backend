// Unit tests of the multipart body parser (decision 026 note, B157): text fields, file parts, the fields that must never become keys, and the
// refusal of a body that is not multipart.
import { afterEach, describe, expect, it } from 'bun:test';
import { Readable } from 'node:stream';
import Fastify, { type FastifyInstance } from 'fastify';
import { AppError } from '@src/common/errors';
import {
  MULTIPART_MAX_BYTES,
  MULTIPART_ROUTES,
  MULTIPART_ROUTE_LIMITS,
  UploadedFile,
  isMultipartContentType,
  parseMultipart,
  registerMultipartBodies,
} from '@src/common/multipart';

/** Encodes a form as a multipart body and its content type, the way a client sends it. */
async function encode(form: FormData): Promise<{ body: Buffer; contentType: string }> {
  const response = new Response(form);
  // The content type (with the boundary) is read before the body is consumed.
  const contentType = response.headers.get('content-type') ?? '';
  return { body: Buffer.from(await response.arrayBuffer()), contentType };
}

describe('parseMultipart', () => {
  it('reads text fields as strings and a file part as an UploadedFile with its name, type and bytes', async () => {
    const form = new FormData();
    form.set('username', 'zain');
    form.set('action', 'placefileorder');
    form.set('file', new File([new Uint8Array([1, 2, 3])], 'flash.bin', { type: 'application/octet-stream' }));
    const { body, contentType } = await encode(form);
    const parsed = await parseMultipart(body, contentType);
    expect(parsed.username).toBe('zain');
    expect(parsed.action).toBe('placefileorder');
    const file = parsed.file;
    expect(file).toBeInstanceOf(UploadedFile);
    expect(file).toMatchObject({ fieldName: 'file', filename: 'flash.bin', mime: 'application/octet-stream', size: 3 });
    expect([...(file as UploadedFile).data]).toEqual([1, 2, 3]);
  });

  it('gives a file with no declared type application/octet-stream', async () => {
    const form = new FormData();
    form.set('file', new File(['x'], 'a.bin'));
    const { body, contentType } = await encode(form);
    expect((await parseMultipart(body, contentType)).file).toMatchObject({ mime: 'application/octet-stream' });
  });

  it('turns a repeated text field into a list (a credential given twice is not a credential) and keeps the first of a repeated file', async () => {
    const form = new FormData();
    form.append('username', 'a');
    form.append('username', 'b');
    form.append('username', 'c');
    form.append('file', new File(['first'], 'one.bin'));
    form.append('file', new File(['second'], 'two.bin'));
    const { body, contentType } = await encode(form);
    const parsed = await parseMultipart(body, contentType);
    expect(parsed.username).toEqual(['a', 'b', 'c']);
    expect((parsed.file as UploadedFile).filename).toBe('one.bin');
  });

  it('never lets a field named __proto__, constructor or prototype become a key', async () => {
    const form = new FormData();
    form.set('__proto__', 'x');
    form.set('constructor', 'y');
    form.set('prototype', 'z');
    form.set('ok', '1');
    const { body, contentType } = await encode(form);
    const parsed = await parseMultipart(body, contentType);
    expect(Object.keys(parsed)).toEqual(['ok']);
    expect(Object.getPrototypeOf(parsed)).toBe(Object.prototype);
  });

  it('answers BAD_REQUEST for a body that is not multipart or has no boundary', async () => {
    for (const [body, type] of [
      [Buffer.from('plain text'), 'multipart/form-data; boundary=xyz'],
      [Buffer.from('--xyz\r\nbroken'), 'multipart/form-data; boundary=xyz'],
      [Buffer.from('anything'), 'multipart/form-data'],
    ] as const) {
      try {
        await parseMultipart(body, type);
        throw new Error('expected a refusal');
      } catch (error) {
        expect(error).toBeInstanceOf(AppError);
        expect((error as AppError).code).toBe('BAD_REQUEST');
      }
    }
  });
});

describe('isMultipartContentType', () => {
  it('knows multipart/form-data with parameters and in any case', () => {
    expect(isMultipartContentType('multipart/form-data; boundary=x')).toBe(true);
    expect(isMultipartContentType('Multipart/Form-Data')).toBe(true);
    expect(isMultipartContentType('multipart/form-data ; boundary=x')).toBe(true);
  });

  it('reads the type the way Fastify picks the body parser: leading whitespace is dropped', () => {
    expect(isMultipartContentType('\u00a0multipart/form-data; boundary=x')).toBe(true);
    expect(isMultipartContentType('\u00a0\u00a0Multipart/Form-Data')).toBe(true);
    expect(isMultipartContentType('\u000b\u000cmultipart/form-data; boundary=x')).toBe(true);
    expect(isMultipartContentType('\ufeffmultipart/form-data; boundary=x')).toBe(true);
  });

  it('is false for any other type and for none', () => {
    expect(isMultipartContentType('application/json')).toBe(false);
    expect(isMultipartContentType('application/x-www-form-urlencoded')).toBe(false);
    expect(isMultipartContentType('text/multipart/form-data')).toBe(false);
    expect(isMultipartContentType('\u00a0application/json')).toBe(false);
    expect(isMultipartContentType('')).toBe(false);
    expect(isMultipartContentType(undefined)).toBe(false);
  });
});

describe('the multipart limits', () => {
  it('leaves room for the form fields around a 25 MiB file, on the routes that take uploads', () => {
    expect(MULTIPART_MAX_BYTES).toBeGreaterThan(25 * 1024 * 1024);
    expect(MULTIPART_MAX_BYTES).toBeLessThan(26 * 1024 * 1024);
    expect([...MULTIPART_ROUTES].sort()).toEqual([
      '/admin/payment-gateways/:id/logo',
      '/admin/service-listings/:id/image',
      '/admin/support-tickets/:id/files',
      '/api/index.php',
      '/client/files',
      '/store/v1/files',
      '/store/v1/tickets/:token/files',
      '/v1/files',
    ]);
  });

  it('bounds the store receipt and the two ticket attachment uploads to 5 MiB plus 64 KiB of form parts (features 21 and 28)', () => {
    const bound = 5 * 1024 * 1024 + 64 * 1024;
    expect(Object.fromEntries(MULTIPART_ROUTE_LIMITS)).toEqual({
      '/store/v1/files': bound,
      '/store/v1/tickets/:token/files': bound,
      '/admin/support-tickets/:id/files': bound,
    });
    for (const route of MULTIPART_ROUTE_LIMITS.keys()) expect(MULTIPART_ROUTES.has(route), route).toBe(true);
  });
});

describe('the per-route bound holds for the bytes read (decision 053)', () => {
  const BOUND = 5 * 1024 * 1024 + 64 * 1024;
  const MIB = 1024 * 1024;
  let app: FastifyInstance | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  /** A bare Fastify with the multipart parser and hooks, and an echo route on a bounded upload route. */
  async function build(): Promise<FastifyInstance> {
    const fastify = Fastify({ bodyLimit: MIB });
    registerMultipartBodies(fastify);
    fastify.post('/store/v1/files', (request) => ({
      size: (request.body as { file?: UploadedFile }).file?.size ?? null,
    }));
    // A route that takes no multipart body: the refusal must come before the body is read.
    fastify.post('/admin/staff', () => ({ ok: true }));
    await fastify.ready();
    app = fastify;
    return fastify;
  }

  const BOUNDARY = 'gsmboundary';
  const head = Buffer.from(
    `--${BOUNDARY}\r\nContent-Disposition: form-data; name="file"; filename="a.pdf"\r\nContent-Type: application/pdf\r\n\r\n`,
  );
  const tail = Buffer.from(`\r\n--${BOUNDARY}--\r\n`);
  const headers = { 'content-type': `multipart/form-data; boundary=${BOUNDARY}` };

  /** The chunks of a valid multipart body whose file part has `size` bytes. */
  const chunksOf = (size: number): Buffer[] => [
    head,
    ...Array.from({ length: Math.ceil(size / MIB) }, (_, index) => Buffer.alloc(Math.min(MIB, size - index * MIB), 97)),
    tail,
  ];

  it('holds the store upload route to its bound while a body without a length streams in', async () => {
    const fastify = await build();
    const res = await fastify.inject({
      method: 'POST',
      url: '/store/v1/files',
      headers,
      payload: Readable.from(chunksOf(6 * MIB)),
    });
    expect(res.statusCode).toBe(413);
  });

  it('still parses a body under the bound without a length', async () => {
    const fastify = await build();
    const res = await fastify.inject({
      method: 'POST',
      url: '/store/v1/files',
      headers,
      payload: Readable.from(chunksOf(MIB)),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ size: MIB });
  });

  it('still refuses a declared length over the bound before reading', async () => {
    const fastify = await build();
    const res = await fastify.inject({
      method: 'POST',
      url: '/store/v1/files',
      headers,
      payload: Buffer.concat(chunksOf(6 * MIB)),
    });
    expect(res.statusCode).toBe(413);
    expect(res.json().message).toBe('The body is larger than this endpoint takes.');
    expect(Buffer.concat(chunksOf(6 * MIB)).length).toBeGreaterThan(BOUND);
  });

  it('refuses a declared length that is not a number', async () => {
    const fastify = await build();
    const res = await fastify.inject({
      method: 'POST',
      url: '/store/v1/files',
      headers: { ...headers, 'content-length': 'many' },
      payload: Buffer.concat(chunksOf(1024)),
    });
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    expect(res.statusCode).toBeLessThan(500);
  });

  it('refuses a multipart body on a route that takes none before reading it, whatever whitespace leads the content type', async () => {
    const fastify = await build();
    for (const type of [
      headers['content-type'],
      `\u00a0${headers['content-type']}`,
      `\u000b${headers['content-type']}`,
    ]) {
      let produced = 0;
      function* chunks() {
        for (let index = 0; index < 30; index += 1) {
          produced += 1;
          yield Buffer.alloc(MIB, 97);
        }
      }
      const res = await fastify.inject({
        method: 'POST',
        url: '/admin/staff',
        headers: { 'content-type': type },
        payload: Readable.from(chunks()),
      });
      expect(res.statusCode, JSON.stringify(type)).toBe(415);
      // The body was never asked for: the refusal came at the headers.
      expect(produced, JSON.stringify(type)).toBeLessThan(5);
    }
  });

  it('holds the store upload route to its bound when the content type starts with whitespace', async () => {
    const fastify = await build();
    const res = await fastify.inject({
      method: 'POST',
      url: '/store/v1/files',
      headers: { 'content-type': `\u00a0${headers['content-type']}` },
      payload: Readable.from(chunksOf(6 * MIB)),
    });
    expect(res.statusCode).toBe(413);
  });
});

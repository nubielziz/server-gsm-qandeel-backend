// Unit tests of the multipart body parser (decision 026 note, B157): text fields, file parts, the fields that must never become keys, and the
// refusal of a body that is not multipart.
import { describe, expect, it } from 'bun:test';
import { AppError } from './errors';
import { MULTIPART_MAX_BYTES, MULTIPART_ROUTES, UploadedFile, parseMultipart } from './multipart';

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

describe('the multipart limits', () => {
  it('leaves room for the form fields around a 25 MiB file, on the three routes that take uploads', () => {
    expect(MULTIPART_MAX_BYTES).toBeGreaterThan(25 * 1024 * 1024);
    expect(MULTIPART_MAX_BYTES).toBeLessThan(26 * 1024 * 1024);
    expect([...MULTIPART_ROUTES].sort()).toEqual(['/api/index.php', '/client/files', '/v1/files']);
  });
});

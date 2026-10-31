// Integration tests of StorageService (decision 004) against the local MinIO test bucket gsm-files-test: put / get / head /
// delete, buffers and streams, the size limit, SHA-256 verification, presigned links, and the behaviour when the store is
// unreachable. Every object lives under tests/<uuid>/ and is deleted afterwards.
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { AppError } from '../../src/common/errors';
import { HealthRegistry } from '../../src/infra/health';
import {
  DEFAULT_MAX_OBJECT_BYTES,
  DEFAULT_PRESIGN_SECONDS,
  HARD_MAX_OBJECT_BYTES,
  StorageService,
} from '../../src/infra/storage';
import { type InfraHarness, createInfra, deadRedisUrl, eventually, freePort, pause } from '../support/infra';
import { expectRejection } from '../support/rejection';

let harness: InfraHarness;
let storage: StorageService;
const created: string[] = [];

beforeAll(async () => {
  harness = await createInfra();
  storage = harness.get(StorageService);
});
afterAll(async () => {
  await Promise.all(created.map((key) => storage.delete(key).catch(() => undefined)));
  await harness.close();
});

/** A key that no other test uses; it is deleted in afterAll. */
function newKey(name = 'file.bin'): string {
  const key = `tests/${randomUUID()}/${name}`;
  created.push(key);
  return key;
}

async function readAll(stream: AsyncIterable<Uint8Array>): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

const sha256 = (data: Uint8Array | string) => createHash('sha256').update(data).digest('hex');

describe('put, get, head, delete', () => {
  it('stores a buffer and reads it back byte for byte, with its metadata', async () => {
    const key = newKey();
    const data = randomBytes(2048);
    const stored = await storage.put(key, data, { contentType: 'application/octet-stream' });
    expect(stored).toMatchObject({
      bucket: harness.config.s3.bucket,
      key,
      size: 2048,
      sha256: sha256(data),
      contentType: 'application/octet-stream',
    });
    expect(stored.etag).toMatch(/^"?[0-9a-f]+"?$/);

    const object = await storage.get(key);
    expect(object).not.toBeNull();
    expect(object!.size).toBe(2048);
    expect(object!.contentType).toBe('application/octet-stream');
    expect(object!.etag).toBe(stored.etag);
    expect(await readAll(object!.body)).toEqual(data);
  });

  it('uses the test bucket, never the development one', () => {
    expect(storage.bucket).toBe('gsm-files-test');
  });

  it('stores text and keeps the content type', async () => {
    const key = newKey('report.csv');
    const stored = await storage.put(key, 'id,name\n1,Rami\n2,ليلى\n', { contentType: 'text/csv; charset=utf-8' });
    expect(stored.size).toBe(Buffer.byteLength('id,name\n1,Rami\n2,ليلى\n'));
    const info = await storage.head(key);
    expect(info).toMatchObject({ size: stored.size, contentType: 'text/csv; charset=utf-8', etag: stored.etag });
    expect(info?.lastModified).toBeInstanceOf(Date);
    expect(Math.abs(Date.now() - info!.lastModified!.getTime())).toBeLessThan(2 * 60 * 1000);
  });

  it('stores an empty file', async () => {
    const key = newKey();
    const stored = await storage.put(key, new Uint8Array(0), { contentType: 'application/octet-stream' });
    expect(stored.size).toBe(0);
    expect(stored.sha256).toBe(sha256(''));
    expect((await storage.head(key))?.size).toBe(0);
    expect((await readAll((await storage.get(key))!.body)).length).toBe(0);
  });

  it('replaces an object stored under the same key', async () => {
    const key = newKey();
    await storage.put(key, 'first', { contentType: 'text/plain' });
    await storage.put(key, 'second version', { contentType: 'text/plain' });
    expect((await readAll((await storage.get(key))!.body)).toString()).toBe('second version');
  });

  it('answers null for an object that does not exist, from get and from head', async () => {
    const key = `tests/${randomUUID()}/missing.bin`;
    expect(await storage.head(key)).toBeNull();
    expect(await storage.get(key)).toBeNull();
  });

  it('deletes an object, and deleting a missing object is not an error', async () => {
    const key = newKey();
    await storage.put(key, 'bye', { contentType: 'text/plain' });
    expect(await storage.head(key)).not.toBeNull();
    await storage.delete(key);
    expect(await storage.head(key)).toBeNull();
    expect(await storage.delete(key)).toBeUndefined();
    expect(await storage.delete(`tests/${randomUUID()}/never-existed`)).toBeUndefined();
  });

  it('refuses invalid keys and content types before talking to S3', async () => {
    for (const key of ['', '../escape', '/absolute', 'a//b', 'with space']) {
      await expectRejection(storage.put(key, 'x', { contentType: 'text/plain' }), RangeError, key);
      await expectRejection(storage.get(key), RangeError, key);
      await expectRejection(storage.head(key), RangeError, key);
      await expectRejection(storage.delete(key), RangeError, key);
      await expectRejection(storage.presignGet(key), RangeError, key);
    }
    await expectRejection(storage.put(newKey(), 'x', { contentType: 'not a type' }), RangeError);
    await expectRejection(storage.put(newKey(), 'x', { contentType: 'text/plain\r\nX: 1' }), RangeError);
  });
});

describe('streams', () => {
  it('stores a Node stream, a web stream and an async generator', async () => {
    const data = randomBytes(300_000);
    const chunks = [data.subarray(0, 100_000), data.subarray(100_000, 250_000), data.subarray(250_000)];
    const sources = {
      node: () => Readable.from(chunks),
      web: () =>
        new ReadableStream<Uint8Array>({
          start(controller) {
            for (const chunk of chunks) controller.enqueue(new Uint8Array(chunk));
            controller.close();
          },
        }),
      generator: async function* () {
        for (const chunk of chunks) {
          await Promise.resolve(); // a real source arrives asynchronously
          yield chunk;
        }
      },
    };
    for (const [name, make] of Object.entries(sources)) {
      const key = newKey(`${name}.bin`);
      const stored = await storage.put(key, make(), { contentType: 'application/octet-stream' });
      expect(stored.size, name).toBe(data.length);
      expect(stored.sha256, name).toBe(sha256(data));
      expect(await readAll((await storage.get(key))!.body), name).toEqual(data);
    }
  });

  it('stores a file of several megabytes from a stream', async () => {
    const data = randomBytes(6 * 1024 * 1024);
    const key = newKey('six-mb.bin');
    const stored = await storage.put(key, Readable.from([data]), { contentType: 'application/octet-stream' });
    expect(stored.size).toBe(data.length);
    expect(sha256(await readAll((await storage.get(key))!.body))).toBe(sha256(data));
  });

  it('streams a download without loading it into memory first (the body is a stream)', async () => {
    const key = newKey();
    await storage.put(key, randomBytes(100_000), { contentType: 'application/octet-stream' });
    const object = await storage.get(key);
    expect(typeof object!.body.pipe).toBe('function');
    const first = await new Promise<Buffer>((resolve) => object!.body.once('data', resolve));
    expect(first.length).toBeGreaterThan(0);
    object!.body.destroy();
  });
});

describe('size limit', () => {
  it('refuses a buffer over the limit with 413 PAYLOAD_TOO_LARGE and stores nothing', async () => {
    const key = newKey();
    const error = await storage
      .put(key, new Uint8Array(1001), { contentType: 'text/plain', maxBytes: 1000 })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).code).toBe('PAYLOAD_TOO_LARGE');
    expect((error as AppError).status).toBe(413);
    expect(await storage.head(key)).toBeNull();
  });

  it('accepts a body of exactly the limit', async () => {
    const key = newKey();
    expect((await storage.put(key, new Uint8Array(1000), { contentType: 'text/plain', maxBytes: 1000 })).size).toBe(
      1000,
    );
  });

  it('stops reading a stream as soon as it is over the limit, and closes it', async () => {
    const key = newKey();
    let produced = 0;
    const source = Readable.from(
      (async function* () {
        for (let i = 0; i < 1000; i++) {
          produced++;
          await Promise.resolve();
          yield Buffer.alloc(1024);
        }
      })(),
    );
    const error = await storage
      .put(key, source, { contentType: 'text/plain', maxBytes: 10 * 1024 })
      .catch((e: unknown) => e);
    expect((error as AppError).code).toBe('PAYLOAD_TOO_LARGE');
    expect(produced, 'the rest of a huge upload is never read').toBeLessThan(50);
    await pause(20);
    expect(source.destroyed).toBe(true);
    expect(await storage.head(key)).toBeNull();
  });

  it('applies a default limit of 25 MiB and refuses limits above 64 MiB', async () => {
    expect(DEFAULT_MAX_OBJECT_BYTES).toBe(25 * 1024 * 1024);
    expect(HARD_MAX_OBJECT_BYTES).toBe(64 * 1024 * 1024);
    for (const maxBytes of [0, -1, 1.5, HARD_MAX_OBJECT_BYTES + 1]) {
      await expectRejection(
        storage.put(newKey(), 'x', { contentType: 'text/plain', maxBytes }),
        RangeError,
        String(maxBytes),
      );
    }
  });
});

describe('SHA-256', () => {
  it('accepts the checksum the client sent, in any letter case', async () => {
    const data = 'checksummed content';
    const key = newKey();
    const stored = await storage.put(key, data, {
      contentType: 'text/plain',
      expectedSha256: sha256(data).toUpperCase(),
    });
    expect(stored.sha256).toBe(sha256(data));
  });

  it('refuses a checksum that does not match, with 400 BAD_REQUEST, and stores nothing', async () => {
    const key = newKey();
    const error = await storage
      .put(key, 'real content', { contentType: 'text/plain', expectedSha256: sha256('other content') })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).code).toBe('BAD_REQUEST');
    expect(await storage.head(key)).toBeNull();
  });

  it('lets S3 verify the same digest: it is stored as the object checksum', async () => {
    const key = newKey();
    const data = randomBytes(1000);
    await storage.put(key, data, { contentType: 'application/octet-stream' });
    // Same content twice gives the same digest, which is what the files table uses to spot duplicate uploads.
    const again = await storage.put(newKey(), data, { contentType: 'application/octet-stream' });
    expect(again.sha256).toBe(sha256(data));
  });
});

describe('presigned links', () => {
  it('download the object without credentials', async () => {
    const key = newKey('invoice.pdf');
    const data = randomBytes(5000);
    await storage.put(key, data, { contentType: 'application/pdf' });
    const url = await storage.presignGet(key);
    expect(url.startsWith(`${harness.config.s3.endpoint}/${harness.config.s3.bucket}/${key}?`)).toBe(true);
    const response = await fetch(url);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/pdf');
    expect(Buffer.from(await response.arrayBuffer())).toEqual(data);
  });

  it('expire after the requested time (default five minutes)', async () => {
    expect(DEFAULT_PRESIGN_SECONDS).toBe(300);
    const key = newKey();
    await storage.put(key, 'short lived', { contentType: 'text/plain' });
    expect(new URL(await storage.presignGet(key)).searchParams.get('X-Amz-Expires')).toBe('300');
    const url = await storage.presignGet(key, { expiresInSeconds: 1 });
    const fresh = await fetch(url);
    expect(fresh.status).toBe(200);
    await fresh.arrayBuffer();
    // Poll instead of sleeping: the store checks the expiry against the machine clock, which may be stepped.
    const expired = await eventually(async () => {
      const response = await fetch(url);
      if (response.status === 403) return response;
      await response.arrayBuffer();
      return undefined;
    }, 15_000);
    expect(await expired.text()).toContain('Request has expired');
  });

  it('make the browser save the file under the given name, safely quoted', async () => {
    const key = newKey();
    await storage.put(key, 'data', { contentType: 'text/csv' });
    const response = await fetch(await storage.presignGet(key, { filename: 'تقرير "Q3"/final.csv' }));
    const disposition = response.headers.get('content-disposition') ?? '';
    expect(disposition).toStartWith('attachment; filename="');
    expect(disposition).toContain("filename*=UTF-8''");
    expect(disposition).not.toMatch(/\/final|"Q3"/);
    await response.arrayBuffer();
  });

  it('can override the content type of the download', async () => {
    const key = newKey();
    await storage.put(key, 'a,b', { contentType: 'application/octet-stream' });
    const response = await fetch(await storage.presignGet(key, { contentType: 'text/csv' }));
    expect(response.headers.get('content-type')).toBe('text/csv');
    await response.arrayBuffer();
  });

  it('are signed locally, so they work for a missing object too (the store answers 404 when it is used)', async () => {
    const url = await storage.presignGet(`tests/${randomUUID()}/missing.bin`);
    const response = await fetch(url);
    expect(response.status).toBe(404);
    await response.arrayBuffer();
  });

  it('refuse a lifetime outside 1 second to 7 days', async () => {
    const key = newKey();
    for (const expiresInSeconds of [0, -5, 1.5, 7 * 24 * 3600 + 1]) {
      await expectRejection(storage.presignGet(key, { expiresInSeconds }), RangeError, String(expiresInSeconds));
    }
    expect(await storage.presignGet(key, { expiresInSeconds: 7 * 24 * 3600 })).toContain('X-Amz-Expires=604800');
    await expectRejection(storage.presignGet(key, { contentType: 'nonsense' }), RangeError);
  });

  it('carry no access key secret', async () => {
    const url = await storage.presignGet(newKey());
    expect(url).not.toContain(harness.config.s3.secretAccessKey);
    expect(url).toContain('X-Amz-Signature=');
  });
});

describe('health', () => {
  it('registers the non-critical storage indicator, and it passes', async () => {
    const indicator = harness
      .get(HealthRegistry)
      .list()
      .find((candidate) => candidate.name === 'storage');
    expect(indicator?.critical).toBe(false);
    expect(await indicator!.check()).not.toBe(false);
    expect(await storage.ping()).toBeUndefined();
  });

  it('fails when the bucket does not exist', async () => {
    const other = await createInfra({ env: { S3_BUCKET_TEST: `no-such-bucket-${randomUUID().slice(0, 8)}` } });
    try {
      await expectRejection(other.get(StorageService).ping());
    } finally {
      await other.close();
    }
  });

  it('fails when the credentials are wrong', async () => {
    const other = await createInfra({ env: { S3_SECRET_ACCESS_KEY: 'wrong-secret-key' } });
    try {
      await expectRejection(other.get(StorageService).ping());
    } finally {
      await other.close();
    }
  });
});

describe('with the store unreachable', () => {
  async function unreachable() {
    return createInfra({
      env: { S3_ENDPOINT: `http://127.0.0.1:${await freePort()}`, REDIS_CACHE_URL_TEST: await deadRedisUrl() },
    });
  }

  it('the app still builds, and every call answers 503 UNAVAILABLE without leaking the endpoint', async () => {
    const down = await unreachable();
    try {
      const service = down.get(StorageService);
      const key = `tests/${randomUUID()}/x.bin`;
      const calls = {
        put: () => service.put(key, 'x', { contentType: 'text/plain' }),
        get: () => service.get(key),
        head: () => service.head(key),
        delete: () => service.delete(key),
      };
      for (const [name, call] of Object.entries(calls)) {
        const started = performance.now();
        const error = await call().catch((e: unknown) => e);
        expect(error, name).toBeInstanceOf(AppError);
        expect((error as AppError).code, name).toBe('UNAVAILABLE');
        expect((error as AppError).status, name).toBe(503);
        expect(String((error as AppError).detail), name).not.toContain('127.0.0.1');
        expect(performance.now() - started, name).toBeLessThan(8_000);
      }
    } finally {
      await down.close();
    }
  });

  it('the health check fails within its deadline instead of hanging', async () => {
    const down = await unreachable();
    try {
      const started = performance.now();
      await expectRejection(down.get(StorageService).ping());
      expect(performance.now() - started).toBeLessThan(2_500);
    } finally {
      await down.close();
    }
  });

  it('presigning needs no connection', async () => {
    const down = await unreachable();
    try {
      expect(await down.get(StorageService).presignGet('tests/offline/x.bin')).toContain('X-Amz-Signature=');
    } finally {
      await down.close();
    }
  });
});

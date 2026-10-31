// GET /health with the real Redis, cache, rate-limit and storage modules (decision 015, map B11): all four dependencies are
// reported, a dependency that is down makes the status "degraded" (never "down": only Postgres is critical), the app starts
// with every dependency unreachable, and the answer reveals no host, port or error text.
import { afterAll, describe, expect, it } from 'bun:test';
import { type TestApp, createTestApp } from '../support/app';
import { deadRedisUrl, freePort } from '../support/infra';
import { migrateTestDb } from '../support/db';

const apps: TestApp[] = [];
async function app(env: Record<string, string> = {}): Promise<TestApp> {
  await migrateTestDb();
  const t = await createTestApp({ env });
  apps.push(t);
  return t;
}
afterAll(async () => {
  await Promise.all(apps.map((t) => t.close()));
});

const health = async (t: TestApp, query = '') => t.app.inject({ method: 'GET', url: `/health${query}` });

describe('GET /health with all infrastructure up', () => {
  it('reports postgres, redis, redis_queue and storage as ok', async () => {
    const res = await health(await app());
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      status: 'ok',
      checks: { postgres: 'ok', redis: 'ok', redis_queue: 'ok', storage: 'ok' },
    });
  });

  it('answers 200 to the strict probe too', async () => {
    expect((await health(await app(), '?strict=1')).statusCode).toBe(200);
  });
});

describe('GET /health with a dependency down', () => {
  it('is degraded, still 200, when the cache Redis is down; the other checks stay ok', async () => {
    const res = await health(await app({ REDIS_CACHE_URL_TEST: await deadRedisUrl() }));
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      status: 'degraded',
      checks: { postgres: 'ok', redis: 'down', redis_queue: 'ok', storage: 'ok' },
    });
  });

  it('is degraded when the queue Redis is down', async () => {
    const res = await health(await app({ REDIS_QUEUE_URL_TEST: await deadRedisUrl() }));
    expect(res.json()).toEqual({
      status: 'degraded',
      checks: { postgres: 'ok', redis: 'ok', redis_queue: 'down', storage: 'ok' },
    });
  });

  it('is degraded when object storage is down', async () => {
    const res = await health(await app({ S3_ENDPOINT: `http://127.0.0.1:${await freePort()}` }));
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      status: 'degraded',
      checks: { postgres: 'ok', redis: 'ok', redis_queue: 'ok', storage: 'down' },
    });
  });

  it('keeps answering 200 to the strict probe while only a non-critical dependency is down', async () => {
    const t = await app({ REDIS_CACHE_URL_TEST: await deadRedisUrl() });
    const strict = await health(t, '?strict=1');
    expect(strict.statusCode).toBe(200);
    expect(strict.json().status).toBe('degraded');
  });

  it('starts and answers when every dependency is unreachable; only Postgres being down makes it "down"', async () => {
    const dead = await deadRedisUrl();
    const t = await app({
      REDIS_CACHE_URL_TEST: dead,
      REDIS_QUEUE_URL_TEST: dead,
      S3_ENDPOINT: `http://127.0.0.1:${await freePort()}`,
    });
    const res = await health(t);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      status: 'degraded',
      checks: { postgres: 'ok', redis: 'down', redis_queue: 'down', storage: 'down' },
    });
  });

  it('never reveals hosts, ports, bucket names or error texts', async () => {
    const dead = await deadRedisUrl();
    const t = await app({ REDIS_CACHE_URL_TEST: dead, S3_ENDPOINT: `http://127.0.0.1:${await freePort()}` });
    const res = await health(t);
    for (const leak of ['127.0.0.1', 'ECONNREFUSED', 'gsm-files', 'localhost', 'Stream', 'bucket', 'Error']) {
      expect(res.body, leak).not.toContain(leak);
    }
    expect(Object.keys(res.json()).sort()).toEqual(['checks', 'status']);
  });
});

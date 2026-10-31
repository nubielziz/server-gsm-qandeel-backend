// Integration tests of the request id (decision 012): kept when safe, generated otherwise, echoed on every response,
// bound to log lines, available to handlers, repeated in problem+json.
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { type TestApp, createTestApp } from '../support/app';
import { logSink } from '../support/log-sink';
import { TestController } from '../support/routes';

const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

let t: TestApp;
beforeAll(async () => {
  t = await createTestApp({ controllers: [TestController], env: { CORS_ORIGINS: 'https://console.example.com' } });
});
afterAll(async () => {
  await t.close();
});

const get = (url: string, headers: Record<string, string> = {}) => t.app.inject({ method: 'GET', url, headers });

describe('X-Request-Id', () => {
  it('keeps a safe incoming id', async () => {
    const res = await get('/health', { 'x-request-id': 'client-id_1.2-3' });
    expect(res.headers['x-request-id']).toBe('client-id_1.2-3');
  });

  it('generates a UUIDv7 when the header is missing', async () => {
    const res = await get('/health');
    expect(res.headers['x-request-id']).toMatch(UUID_V7);
  });

  it('generates a new id when the incoming one is too long or has unsafe characters', async () => {
    for (const bad of ['a'.repeat(65), 'has space', 'semi;colon', 'a,b', '<script>']) {
      const res = await get('/health', { 'x-request-id': bad });
      expect(res.headers['x-request-id']).toMatch(UUID_V7);
    }
    const edge = await get('/health', { 'x-request-id': 'a'.repeat(64) });
    expect(edge.headers['x-request-id']).toBe('a'.repeat(64));
  });

  it('makes a different id for every request', async () => {
    const ids = new Set(
      (await Promise.all(Array.from({ length: 20 }, () => get('/health')))).map((res) => res.headers['x-request-id']),
    );
    expect(ids.size).toBe(20);
  });

  it('is on every kind of response: success, 404, 422, 500, 204 and a CORS preflight', async () => {
    const responses = [
      await get('/health'),
      await get('/nope'),
      await get('/t/items/abc'),
      await get('/t/boom'),
      await t.app.inject({ method: 'DELETE', url: '/t/items/9' }),
      await t.app.inject({
        method: 'OPTIONS',
        url: '/t/items',
        headers: { origin: 'https://console.example.com', 'access-control-request-method': 'POST' },
      }),
    ];
    expect(responses.map((res) => res.statusCode)).toEqual([200, 404, 422, 500, 204, 204]);
    for (const res of responses) expect(res.headers['x-request-id']).toBeTruthy();
  });

  it('is repeated as requestId in every problem body, with the id the caller sent', async () => {
    for (const url of ['/nope', '/t/items/abc', '/t/boom', '/t/app-error']) {
      const res = await get(url, { 'x-request-id': 'trace-me-42' });
      expect(res.headers['x-request-id']).toBe('trace-me-42');
      expect(res.json().requestId).toBe('trace-me-42');
    }
  });

  it('keeps the id of the request when several run at the same time', async () => {
    const ids = Array.from({ length: 10 }, (_, index) => `parallel-${index}`);
    const responses = await Promise.all(ids.map((id) => get('/t/request-id', { 'x-request-id': id })));
    expect(responses.map((res) => res.json().requestId)).toEqual(ids);
    expect(responses.map((res) => res.headers['x-request-id'])).toEqual(ids);
  });
});

describe('request id in the application', () => {
  it('is available to handlers through getRequestId()', async () => {
    const res = await get('/t/request-id', { 'x-request-id': 'handler-check' });
    expect(res.json()).toEqual({ requestId: 'handler-check' });
    const generated = await get('/t/request-id');
    expect(generated.json().requestId).toBe(generated.headers['x-request-id']);
  });

  it('survives parsing of a large JSON body in a POST handler', async () => {
    logSink.clear();
    const body = Object.fromEntries(Array.from({ length: 2000 }, (_, i) => [`k${i}`, 'x'.repeat(100)]));
    const res = await t.app.inject({
      method: 'POST',
      url: '/t/request-id',
      headers: { 'x-request-id': 'post-body-1', 'content-type': 'application/json' },
      payload: JSON.stringify(body),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ requestId: 'post-body-1', keys: 2000 });
    const line = logSink.forRequest('post-body-1').find((entry) => entry.msg === 'whoAmIAfterBody handler ran');
    expect(line?.requestId).toBe('post-body-1');
  });

  it('is bound to log lines written by application code, without passing it around', async () => {
    logSink.clear();
    const res = await get('/t/request-id', { 'x-request-id': 'log-check-1' });
    expect(res.statusCode).toBe(200);
    const lines = logSink.forRequest('log-check-1');
    expect(lines.map((line) => line.msg)).toContain('whoAmI handler ran');
    const handlerLine = lines.find((line) => line.msg === 'whoAmI handler ran');
    expect(handlerLine).toMatchObject({ context: 'TestController', requestId: 'log-check-1', service: 'api' });
  });

  it('is bound to the access log line, with the route template and no query string', async () => {
    logSink.clear();
    await get('/t/items/17?token=super-secret', { 'x-request-id': 'access-log-1' });
    await get('/nope?token=super-secret', { 'x-request-id': 'access-log-2' });
    const notFound = logSink.forRequest('access-log-2').find((line) => line.msg === 'request completed');
    expect(notFound).toMatchObject({
      requestId: 'access-log-2',
      method: 'GET',
      route: 'unmatched',
      status: 404,
      code: 'NOT_FOUND',
      context: 'http',
    });
    expect(typeof notFound?.durationMs).toBe('number');
    expect(JSON.stringify(logSink.lines)).not.toContain('super-secret');
    expect(JSON.stringify(logSink.lines)).not.toContain('/t/items/17');
  });
});

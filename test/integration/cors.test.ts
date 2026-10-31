// Integration tests of CORS (ALIGNMENT § 6): exact origins with credentials, Vary: Origin on every response including
// errors, preflight answered first with the documented methods, headers and Max-Age, exposed headers.
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { type TestApp, createTestApp } from '../support/app';
import { TestController } from '../support/routes';

const CONSOLE = 'https://console.example.com';
const EXPOSED = 'x-total-count, x-request-id, x-csrf-token, retry-after, content-disposition';

let t: TestApp;
let closed: TestApp;
beforeAll(async () => {
  t = await createTestApp({
    controllers: [TestController],
    env: { CORS_ORIGINS: `${CONSOLE},http://localhost:5173`, BODY_LIMIT_BYTES: '2048' },
  });
  closed = await createTestApp({ controllers: [TestController] });
});
afterAll(async () => {
  await t.close();
  await closed.close();
});

const call = (app: TestApp, method: 'GET' | 'POST' | 'OPTIONS', url: string, headers: Record<string, string> = {}) =>
  app.app.inject({ method, url, headers });
const varyHas = (value: string | string[] | number | undefined, name: string) =>
  String(value ?? '')
    .toLowerCase()
    .split(',')
    .map((part) => part.trim())
    .includes(name.toLowerCase());

describe('simple requests', () => {
  it('allows a configured origin with credentials and exposes the console headers', async () => {
    const res = await call(t, 'GET', '/health', { origin: CONSOLE });
    expect(res.headers['access-control-allow-origin']).toBe(CONSOLE);
    expect(res.headers['access-control-allow-credentials']).toBe('true');
    expect(res.headers['access-control-expose-headers']).toBe(EXPOSED);
    expect(varyHas(res.headers.vary, 'origin')).toBe(true);
  });

  it('allows each configured origin and echoes exactly that origin, never a wildcard', async () => {
    const res = await call(t, 'GET', '/health', { origin: 'http://localhost:5173' });
    expect(res.headers['access-control-allow-origin']).toBe('http://localhost:5173');
  });

  it('carries the CORS headers on error responses, so a 401 is not mistaken for a network error', async () => {
    for (const [url, status] of [
      ['/nope', 404],
      ['/t/items/abc', 422],
      ['/t/boom', 500],
      ['/t/rate-limited', 429],
      ['/t/app-error', 422],
    ] as const) {
      const res = await call(t, 'GET', url, { origin: CONSOLE });
      expect(res.statusCode).toBe(status);
      expect(res.headers['access-control-allow-origin']).toBe(CONSOLE);
      expect(res.headers['access-control-allow-credentials']).toBe('true');
      expect(res.headers['access-control-expose-headers']).toBe(EXPOSED);
      expect(varyHas(res.headers.vary, 'origin')).toBe(true);
    }
  });

  it('carries them on a body-too-large and a malformed-JSON answer too', async () => {
    const tooLarge = await t.app.inject({
      method: 'POST',
      url: '/t/any-body',
      headers: { origin: CONSOLE },
      payload: { filler: 'x'.repeat(4096) },
    });
    expect(tooLarge.statusCode).toBe(413);
    expect(tooLarge.headers['access-control-allow-origin']).toBe(CONSOLE);
    expect(varyHas(tooLarge.headers.vary, 'origin')).toBe(true);
    const malformed = await t.app.inject({
      method: 'POST',
      url: '/t/any-body',
      headers: { origin: CONSOLE, 'content-type': 'application/json' },
      payload: '{',
    });
    expect(malformed.statusCode).toBe(400);
    expect(malformed.headers['access-control-allow-origin']).toBe(CONSOLE);
  });

  it('refuses other origins without a wildcard but still varies on Origin', async () => {
    for (const origin of [
      'https://evil.example',
      `${CONSOLE}.evil.example`,
      'http://console.example.com',
      `${CONSOLE}/`,
      'null',
    ]) {
      const res = await call(t, 'GET', '/health', { origin });
      expect(res.headers['access-control-allow-origin']).toBeUndefined();
      expect(varyHas(res.headers.vary, 'origin')).toBe(true);
    }
    const noOrigin = await call(t, 'GET', '/t/boom');
    expect(noOrigin.headers['access-control-allow-origin']).toBeUndefined();
    expect(varyHas(noOrigin.headers.vary, 'origin')).toBe(true);
  });

  it('allows no origin at all when none is configured', async () => {
    const res = await call(closed, 'GET', '/health', { origin: CONSOLE });
    expect(res.statusCode).toBe(200);
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
    const preflight = await call(closed, 'OPTIONS', '/t/items', {
      origin: CONSOLE,
      'access-control-request-method': 'POST',
    });
    expect(preflight.headers['access-control-allow-origin']).toBeUndefined();
  });
});

describe('preflight', () => {
  const preflight = (url: string, headers: Record<string, string> = {}) =>
    call(t, 'OPTIONS', url, {
      origin: CONSOLE,
      'access-control-request-method': 'POST',
      'access-control-request-headers': 'content-type,x-csrf-token',
      ...headers,
    });

  it('answers 204 with the allowed methods, headers, credentials and a 10 minute cache', async () => {
    const res = await preflight('/t/items');
    expect(res.statusCode).toBe(204);
    expect(res.body).toBe('');
    expect(res.headers['access-control-allow-origin']).toBe(CONSOLE);
    expect(res.headers['access-control-allow-credentials']).toBe('true');
    expect(res.headers['access-control-allow-methods']).toBe('GET, POST, PUT, PATCH, DELETE');
    expect(res.headers['access-control-allow-headers']).toBe('Content-Type, X-CSRF-Token, Idempotency-Key, Accept');
    expect(res.headers['access-control-max-age']).toBe('600');
    expect(res.headers['access-control-expose-headers']).toBe(EXPOSED);
    expect(varyHas(res.headers.vary, 'origin')).toBe(true);
    expect(res.headers['content-length']).toBe('0');
  });

  it('is answered before routing, so it works for any path and for routes that do not exist', async () => {
    for (const url of ['/t/items/5', '/admin/staff/1', '/this/does/not/exist', '/health']) {
      const res = await preflight(url);
      expect(res.statusCode).toBe(204);
      expect(res.headers['access-control-allow-origin']).toBe(CONSOLE);
    }
  });

  it('does not allow headers outside the documented list', async () => {
    const res = await preflight('/t/items', { 'access-control-request-headers': 'authorization' });
    expect(res.headers['access-control-allow-headers']).not.toContain('Authorization');
  });

  it('answers an OPTIONS request without Origin like any other request, never with a plain-text 400', async () => {
    const res = await call(t, 'OPTIONS', '/t/items');
    expect(res.statusCode).not.toBe(400);
    expect(res.body).not.toContain('Invalid Preflight Request');
  });

  it('gives a refused origin no permission', async () => {
    const res = await preflight('/t/items', { origin: 'https://evil.example' });
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });
});

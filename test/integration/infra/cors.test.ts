// Integration tests of CORS per surface (ALIGNMENT § 6, decision 045): a listed origin of the path's audience is granted with
// credentials, every other request gets no CORS header; Vary: Origin on every answer, a listed origin's preflight is answered
// first, a refused OPTIONS request goes on like any request. The production template is checked against the real app.
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { type TestApp, createTestApp } from '../../support/app';
import { clearIdentityCaches, productionEnvOnTestInstances } from '../../support/auth';
import { closeTestDb, resetDb } from '../../support/db';
import { templateVariables } from '../../support/env';
import { TestController } from '../../support/routes';
import { SecurityTestController } from '../../support/security-routes';

const CONSOLE = 'https://console.example.com';
const SHOP = 'https://shop.example.com';
const PORTAL = 'https://portal.example.com';
const EXPOSED = 'x-total-count, x-request-id, x-csrf-token, retry-after, content-disposition';
const CONTROLLERS = [TestController, SecurityTestController];

let t: TestApp;
let legacy: TestApp;
let closed: TestApp;
beforeAll(async () => {
  await resetDb();
  t = await createTestApp({
    controllers: CONTROLLERS,
    env: {
      CONSOLE_ORIGINS: `${CONSOLE},http://localhost:5173`,
      SHOP_ORIGINS: `${SHOP},${PORTAL}`,
      BODY_LIMIT_BYTES: '2048',
    },
  });
  legacy = await createTestApp({ controllers: CONTROLLERS, env: { CORS_ORIGINS: CONSOLE } });
  closed = await createTestApp({ controllers: CONTROLLERS });
  // A refused preflight is an ordinary request now: it meets the IP rules, which read the cache.
  for (const app of [t, legacy, closed]) await clearIdentityCaches(app);
});
afterAll(async () => {
  for (const app of [t, legacy, closed]) await app.close();
  await closeTestDb();
});

const call = (app: TestApp, method: 'GET' | 'POST' | 'OPTIONS', url: string, headers: Record<string, string> = {}) =>
  app.app.inject({ method, url, headers });
const varyHas = (value: string | string[] | number | undefined, name: string) =>
  String(value ?? '')
    .toLowerCase()
    .split(',')
    .map((part) => part.trim())
    .includes(name.toLowerCase());
/** Asserts that an answer carries no CORS grant at all, only the `Vary: Origin` of a per-request decision. */
const expectNoGrant = (res: Awaited<ReturnType<typeof call>>, what: string) => {
  expect(res.headers['access-control-allow-origin'], what).toBeUndefined();
  expect(res.headers['access-control-allow-credentials'], what).toBeUndefined();
  expect(res.headers['access-control-expose-headers'], what).toBeUndefined();
  expect(varyHas(res.headers.vary, 'origin'), what).toBe(true);
};

describe('the console surfaces', () => {
  it('grant a console origin with credentials and the exposed headers, echoing exactly that origin', async () => {
    const res = await call(t, 'GET', '/admin/t/probe', { origin: CONSOLE });
    expect(res.statusCode).toBe(200);
    expect(res.headers['access-control-allow-origin']).toBe(CONSOLE);
    expect(res.headers['access-control-allow-credentials']).toBe('true');
    expect(res.headers['access-control-expose-headers']).toBe(EXPOSED);
    expect(varyHas(res.headers.vary, 'origin')).toBe(true);
    const dev = await call(t, 'GET', '/admin/t/probe', { origin: 'http://localhost:5173' });
    expect(dev.headers['access-control-allow-origin']).toBe('http://localhost:5173');
  });

  it('carry the CORS headers on error answers, so a 401 is not mistaken for a network error', async () => {
    for (const [url, status] of [
      ['/admin/nope', 404],
      ['/admin/t/secure', 401],
      ['/admin/t/app-error', 422],
      ['/admin/t/boom', 500],
      ['/admin/t/rate-limited', 429],
    ] as const) {
      const res = await call(t, 'GET', url, { origin: CONSOLE });
      expect(res.statusCode, url).toBe(status);
      expect(res.headers['access-control-allow-origin'], url).toBe(CONSOLE);
      expect(res.headers['access-control-allow-credentials'], url).toBe('true');
      expect(res.headers['access-control-expose-headers'], url).toBe(EXPOSED);
      expect(varyHas(res.headers.vary, 'origin'), url).toBe(true);
    }
  });

  it('carry them on a body-too-large and a malformed-JSON answer too', async () => {
    const tooLarge = await t.app.inject({
      method: 'POST',
      url: '/admin/t/any-body',
      headers: { origin: CONSOLE },
      payload: { filler: 'x'.repeat(4096) },
    });
    expect(tooLarge.statusCode).toBe(413);
    expect(tooLarge.headers['access-control-allow-origin']).toBe(CONSOLE);
    expect(varyHas(tooLarge.headers.vary, 'origin')).toBe(true);
    const malformed = await t.app.inject({
      method: 'POST',
      url: '/admin/t/any-body',
      headers: { origin: CONSOLE, 'content-type': 'application/json' },
      payload: '{',
    });
    expect(malformed.statusCode).toBe(400);
    expect(malformed.headers['access-control-allow-origin']).toBe(CONSOLE);
  });

  it("give the shop's origins, an unlisted origin and no origin nothing on every staff path", async () => {
    const origins = [
      SHOP,
      PORTAL,
      'https://evil.example',
      `${CONSOLE}.evil.example`,
      'http://console.example.com',
      `${CONSOLE}/`,
      'null',
    ];
    for (const path of ['/admin/t/probe', '/admin/nope', '/reference', '/admin/queues']) {
      for (const origin of origins) expectNoGrant(await call(t, 'GET', path, { origin }), `${origin} on ${path}`);
      expectNoGrant(await call(t, 'GET', path), `no origin on ${path}`);
    }
  });
});

describe('the shop surfaces', () => {
  it("grant the shop's origins on /client and /store/v1 and nothing to a console origin", async () => {
    for (const path of ['/client/t/probe', '/store/v1/t/probe']) {
      for (const origin of [SHOP, PORTAL]) {
        const res = await call(t, 'GET', path, { origin });
        expect(res.headers['access-control-allow-origin'], `${origin} on ${path}`).toBe(origin);
        expect(res.headers['access-control-allow-credentials'], `${origin} on ${path}`).toBe('true');
      }
      expectNoGrant(await call(t, 'GET', path, { origin: CONSOLE }), `console on ${path}`);
    }
  });
});

describe('the machine surfaces', () => {
  it('send no CORS grant to any origin', async () => {
    for (const path of ['/health', '/v1/nope', '/webhooks/nope', '/docs', '/openapi.json', '/t/items']) {
      for (const origin of [CONSOLE, SHOP])
        expectNoGrant(await call(t, 'GET', path, { origin }), `${origin} on ${path}`);
    }
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

  it('answers 204 with the methods, headers, credentials and a 10 minute cache to a listed origin of the path', async () => {
    const res = await preflight('/admin/t/probe');
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
    const shop = await preflight('/store/v1/t/probe', { origin: SHOP });
    expect(shop.statusCode).toBe(204);
    expect(shop.headers['access-control-allow-origin']).toBe(SHOP);
  });

  it('is answered before routing, for routes that do not exist too', async () => {
    for (const url of ['/admin/staff/1', '/admin/does/not/exist']) {
      const res = await preflight(url);
      expect(res.statusCode, url).toBe(204);
      expect(res.headers['access-control-allow-origin'], url).toBe(CONSOLE);
    }
    for (const url of ['/store/v1/does-not-exist', '/client/x']) {
      const res = await preflight(url, { origin: SHOP });
      expect(res.statusCode, url).toBe(204);
      expect(res.headers['access-control-allow-origin'], url).toBe(SHOP);
    }
  });

  it('does not allow headers outside the documented list', async () => {
    const res = await preflight('/admin/t/probe', { 'access-control-request-headers': 'authorization' });
    expect(res.headers['access-control-allow-headers']).not.toContain('Authorization');
  });

  it('gives a refused preflight no permission and lets it go on like any request', async () => {
    const res = await preflight('/admin/t/probe', { origin: SHOP });
    expect(res.statusCode).toBe(404);
    expect(String(res.headers['content-type'])).toContain('application/problem+json');
    expect(res.json().code).toBe('NOT_FOUND');
    for (const name of [
      'access-control-allow-origin',
      'access-control-allow-credentials',
      'access-control-allow-methods',
      'access-control-allow-headers',
      'access-control-max-age',
    ]) {
      expect(res.headers[name], name).toBeUndefined();
    }
    const machine = await preflight('/v1/nope');
    expect(machine.statusCode).toBe(404);
    expect(machine.headers['access-control-allow-origin']).toBeUndefined();
    const noOrigin = await call(t, 'OPTIONS', '/admin/t/probe');
    expect(noOrigin.statusCode).toBe(404);
    expect(noOrigin.body).not.toContain('Invalid Preflight Request');
  });
});

describe('the deprecated CORS_ORIGINS', () => {
  it('is read as the origins of both audiences outside production', async () => {
    for (const path of ['/admin/t/probe', '/store/v1/t/probe']) {
      const res = await call(legacy, 'GET', path, { origin: CONSOLE });
      expect(res.headers['access-control-allow-origin'], path).toBe(CONSOLE);
    }
    expectNoGrant(await call(legacy, 'GET', '/health', { origin: CONSOLE }), 'the health route');
  });
});

describe('no origins configured', () => {
  it('grants nothing', async () => {
    const res = await call(closed, 'GET', '/admin/t/probe', { origin: CONSOLE });
    expect(res.statusCode).toBe(200);
    expectNoGrant(res, 'a console origin');
    const preflight = await call(closed, 'OPTIONS', '/admin/t/probe', {
      origin: CONSOLE,
      'access-control-request-method': 'POST',
    });
    expect(preflight.headers['access-control-allow-origin']).toBeUndefined();
  });
});

describe('the production template (decision 045)', () => {
  const template = templateVariables('.env.production.example');
  const fromTemplate = Object.fromEntries(
    ['CONSOLE_BASE_URL', 'STORE_BASE_URL', 'PORTAL_BASE_URL', 'CORS_ORIGINS', 'CONSOLE_ORIGINS', 'SHOP_ORIGINS']
      .filter((name) => template[name] !== undefined)
      .map((name) => [name, template[name] as string]),
  );
  const ADMIN = new URL(template.CONSOLE_BASE_URL as string).origin;
  const SHOP_HOST = new URL(template.STORE_BASE_URL as string).origin;
  let production: TestApp;
  beforeAll(async () => {
    production = await createTestApp({ controllers: CONTROLLERS, env: productionEnvOnTestInstances(fromTemplate) });
    await clearIdentityCaches(production);
  });
  afterAll(async () => {
    await production.close();
  });

  it('lets only the console host read the staff surface', async () => {
    const own = await call(production, 'GET', '/admin/t/probe', { origin: ADMIN });
    expect(own.headers['access-control-allow-origin']).toBe(ADMIN);
    const other = await call(production, 'GET', '/admin/t/probe', { origin: SHOP_HOST });
    expect(other.headers['access-control-allow-origin']).toBeUndefined();
    expect(other.headers['access-control-allow-credentials']).toBeUndefined();
  });

  it('lets only the shop host read the shop surfaces', async () => {
    for (const path of ['/store/v1/t/probe', '/client/t/probe']) {
      const own = await call(production, 'GET', path, { origin: SHOP_HOST });
      expect(own.headers['access-control-allow-origin'], path).toBe(SHOP_HOST);
      const other = await call(production, 'GET', path, { origin: ADMIN });
      expect(other.headers['access-control-allow-origin'], path).toBeUndefined();
      expect(other.headers['access-control-allow-credentials'], path).toBeUndefined();
    }
  });

  it('refuses a session-less staff mutation that comes from the shop host', async () => {
    const post = (origin: string) =>
      production.app.inject({ method: 'POST', url: '/admin/t/sec/login', headers: { origin } });
    const fromShop = await post(SHOP_HOST);
    expect(fromShop.statusCode).toBe(403);
    expect(fromShop.json().code).toBe('CSRF_FAILED');
    expect((await post(ADMIN)).statusCode).toBe(200);
  });
});

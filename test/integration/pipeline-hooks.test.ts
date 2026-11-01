// Integration tests of the request pipeline hooks (decision 018, P2.5b) on the real application: Postgres and the cache Redis
// of the test instances. The order is IP rules, maintenance, per-IP rate limit, all before any guard and after CORS; every
// refusal is problem+json with the CORS and security headers. A stand-in guard answers 401 to every sample route, so a 403,
// 503 or 429 proves its hook ran before authentication.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import type { LightMyRequestResponse } from 'fastify';
import { ErrorFormatterRegistry } from '../../src/common/errors';
import { ipRateLimitKey, parseIpAddress } from '../../src/common/ip-address';
import { PIPELINE_STAGES, RequestPipeline } from '../../src/common/pipeline';
import { CacheKeys } from '../../src/infra/cache';
import { schema as s } from '../../src/infra/db';
import { type LimiterName, RateLimitService } from '../../src/infra/rate-limit';
import { RedisService } from '../../src/infra/redis';
import { IpRuleCache } from '../../src/modules/identity';
import { MaintenanceService } from '../../src/modules/platform';
import { type TestApp, createTestApp } from '../support/app';
import { closeTestDb, resetDb, testDb } from '../support/db';
import { deadRedisUrl } from '../support/infra';
import { logSink } from '../support/log-sink';
import {
  PipelineTestController,
  TestAccessModule,
  freshClientIp as freshIp,
  freshClientPrefix,
} from '../support/pipeline-routes';
import { TestController } from '../support/routes';

const CONSOLE = 'https://console.example.com';
const AUTH = { 'x-test-auth': '1' };

let t: TestApp;
const extraApps: TestApp[] = [];

const DHRU = {
  name: 'test-dhru',
  matches: ({ surface }: { surface: string }) => surface === 'dhru',
  format: ({ error }: { error: { detail: string | undefined } }) => ({
    status: 200,
    contentType: 'application/json; charset=utf-8',
    body: { ERROR: [{ MESSAGE: error.detail }], apiversion: '6.1' },
  }),
};

beforeAll(async () => {
  await resetDb();
  t = await createTestApp({
    controllers: [TestController, PipelineTestController],
    imports: [TestAccessModule],
    env: { CORS_ORIGINS: CONSOLE },
  });
  t.app.get(ErrorFormatterRegistry).register(DHRU);
});
/** Empties the rules and settings and the caches that hold them: the tests of other files share the database and Redis. */
async function clean(): Promise<void> {
  const { db } = await testDb();
  await db.delete(s.ipRules);
  await db.delete(s.settings);
  await t.app.get(IpRuleCache).invalidate();
  await t.app.get(MaintenanceService).invalidate();
}
afterAll(async () => {
  await clean();
  await t.close();
  await Promise.all(extraApps.map((other) => other.close()));
  await closeTestDb();
});
beforeEach(clean);

async function blockEverywhere(ip: string): Promise<void> {
  const { db } = await testDb();
  await db.insert(s.ipRules).values({ kind: 'block', scope: 'all', cidr: ip, reason: 'test' });
  await t.app.get(IpRuleCache).invalidate();
}

async function setMaintenance(value: unknown): Promise<void> {
  const { db } = await testDb();
  await db.delete(s.settings);
  if (value !== undefined) await db.insert(s.settings).values({ key: 'maintenance', value });
  await t.app.get(MaintenanceService).invalidate();
}

const maintenanceOn = (scope: string, extra: Record<string, unknown> = {}) => ({
  enabled: true,
  scope,
  message: 'Checkout is paused while we check the ledger.',
  expectedEndAt: null,
  startedAt: '2026-03-01T11:00:00.000Z',
  startedBy: { id: 1, name: 'Rami K.' },
  ...extra,
});

const get = (url: string, ip: string, headers: Record<string, string> = {}) =>
  t.app.inject({ method: 'GET', url, remoteAddress: ip, headers });
const post = (url: string, ip: string, payload: unknown = {}, headers: Record<string, string> = {}) =>
  t.app.inject({ method: 'POST', url, remoteAddress: ip, headers, payload: payload as never });

/** Uses up a limiter budget for a client address, the way earlier requests would have. */
async function exhaust(limiter: LimiterName, ip: string, points: number): Promise<void> {
  const result = await t.app
    .get(RateLimitService)
    .consume(limiter, ipRateLimitKey(parseIpAddress(ip)), points, { limit: points });
  expect(result.allowed).toBe(true);
}

const refusedAs = (res: LightMyRequestResponse, status: number, code: string) => {
  expect(res.statusCode).toBe(status);
  expect(res.headers['content-type']).toContain('application/problem+json');
  expect(res.json().code).toBe(code);
};

describe('the pipeline in the real application', () => {
  it('has a handler for each of the three stages, and the maintenance check of the Dhru body', () => {
    const pipeline = t.app.get(RequestPipeline);
    expect(pipeline.stagesWithHandlers()).toEqual([...PIPELINE_STAGES]);
    expect(pipeline.stagesWithHandlers('preValidation')).toEqual(['maintenance']);
    expect([...PIPELINE_STAGES]).toEqual(['ip-rules', 'maintenance', 'rate-limit']);
  });
});

describe('an application without Postgres or Redis', () => {
  it('skips the stages it cannot run and says so at start-up', async () => {
    logSink.clear();
    const bare = await createTestApp({ withoutDatabase: true, withoutInfrastructure: true });
    extraApps.push(bare);
    expect(bare.app.get(RequestPipeline).stagesWithHandlers()).toEqual([]);
    const warning = logSink.lines.find((line) =>
      String(line.msg).includes('Request pipeline stages without a handler'),
    );
    expect(warning?.msg).toContain('ip-rules, maintenance, rate-limit');
    expect(
      (await bare.app.inject({ method: 'GET', url: '/store/v1/anything', remoteAddress: freshIp() })).statusCode,
    ).toBe(404);
  });
});

describe('pipeline order: IP rules, then maintenance, then the per-IP limit, all before authentication', () => {
  it('lets a request reach the guard (401) when no hook refuses it', async () => {
    const ip = freshIp();
    for (const url of ['/admin/t/secure', '/store/v1/t/ping', '/v1/t/ping', '/client/t/ping']) {
      refusedAs(await get(url, ip), 401, 'UNAUTHORIZED');
    }
    expect((await get('/store/v1/t/ping', ip, AUTH)).statusCode).toBe(200);
  });

  it('answers a blocked address 403 IP_NOT_ALLOWED before authentication, on every surface, with the CORS headers', async () => {
    const blocked = freshIp();
    await blockEverywhere(blocked);
    const requests: Array<[string, string]> = [
      ['GET', '/admin/t/secure'],
      ['GET', '/store/v1/t/ping'],
      ['GET', '/v1/t/ping'],
      ['GET', '/client/t/ping'],
      ['POST', '/webhooks/t/ping'],
      ['GET', '/store/v1/nope'],
    ];
    for (const [method, url] of requests) {
      const res = await t.app.inject({
        method: method as 'GET',
        url,
        remoteAddress: blocked,
        headers: { origin: CONSOLE },
      });
      refusedAs(res, 403, 'IP_NOT_ALLOWED');
      expect(res.json().detail, url).toBe(`Your network address (${blocked}) is blocked.`);
      expect(res.headers['access-control-allow-origin'], url).toBe(CONSOLE);
      expect(res.headers['access-control-allow-credentials'], url).toBe('true');
      expect(res.headers['access-control-expose-headers'], url).toContain('retry-after');
      expect(res.headers.vary, url).toContain('Origin');
      expect(res.headers['x-request-id'], url).toBeTruthy();
      expect(res.headers['x-content-type-options'], url).toBe('nosniff');
      expect(res.json().requestId, url).toBe(res.headers['x-request-id']);
    }
  });

  it('answers the CORS preflight of a blocked address before the IP rules', async () => {
    const blocked = freshIp();
    await blockEverywhere(blocked);
    const res = await t.app.inject({
      method: 'OPTIONS',
      url: '/admin/t/secure',
      remoteAddress: blocked,
      headers: { origin: CONSOLE, 'access-control-request-method': 'GET' },
    });
    expect(res.statusCode).toBe(204);
    expect(res.headers['access-control-allow-origin']).toBe(CONSOLE);
  });

  it('runs the IP rules first, maintenance second and the rate limit third', async () => {
    const blocked = freshIp();
    const limited = freshIp();
    await blockEverywhere(blocked);
    await setMaintenance(maintenanceOn('all'));
    await exhaust('ip', blocked, 300);
    await exhaust('ip', limited, 300);
    refusedAs(await get('/store/v1/t/ping', blocked), 403, 'IP_NOT_ALLOWED');
    refusedAs(await get('/store/v1/t/ping', limited), 503, 'MAINTENANCE');
    await setMaintenance(undefined);
    refusedAs(await get('/store/v1/t/ping', limited), 429, 'RATE_LIMITED');
    // With every hook satisfied, the request reaches the guard.
    refusedAs(await get('/store/v1/t/ping', freshIp()), 401, 'UNAUTHORIZED');
  });

  it('puts the security headers and the request id on a maintenance refusal and a rate limit refusal too', async () => {
    const ip = freshIp();
    await setMaintenance(maintenanceOn('store'));
    const maintenance = await get('/store/v1/t/ping', ip, { origin: CONSOLE });
    await setMaintenance(undefined);
    await exhaust('ip', ip, 300);
    const limited = await get('/store/v1/t/ping', ip, { origin: CONSOLE });
    for (const res of [maintenance, limited]) {
      expect(res.headers['access-control-allow-origin']).toBe(CONSOLE);
      expect(res.headers['x-content-type-options']).toBe('nosniff');
      expect(res.headers['content-security-policy']).toContain("default-src 'none'");
      expect(res.headers['x-request-id']).toBeTruthy();
      expect(res.headers['cache-control']).toBe('no-store');
    }
    refusedAs(maintenance, 503, 'MAINTENANCE');
    refusedAs(limited, 429, 'RATE_LIMITED');
  });
});

describe('maintenance (scenario system-integrity)', () => {
  const STORE_PING = (ip: string) => get('/store/v1/t/ping', ip, AUTH);
  const STORE_TOKEN = (ip: string) => get('/store/v1/t/orders/abc', ip, AUTH);
  const CHECKOUT = (ip: string) => post('/store/v1/checkout-sessions', ip, {}, AUTH);
  const PAY = (ip: string) => post('/store/v1/checkout-sessions/abc123/pay', ip, {}, AUTH);
  const ORDER = (ip: string) => post('/v1/orders', ip, {}, AUTH);
  const BULK = (ip: string) => post('/v1/orders/bulk', ip, {}, AUTH);
  const V1_READ = (ip: string) => get('/v1/t/ping', ip, AUTH);
  const ADMIN = (ip: string) => get('/admin/t/session', ip, AUTH);
  const CLIENT = (ip: string) => get('/client/t/ping', ip, AUTH);
  const HOOK = (ip: string) => post('/webhooks/t/ping', ip, {}, AUTH);
  const HEALTH = (ip: string) => get('/health', ip);
  // /metrics answers private networks only (or a token): the test address would be refused by its own guard.
  const METRICS = () => get('/metrics', '127.0.0.1');

  const ALWAYS_OPEN = { ADMIN, CLIENT, HOOK, HEALTH, METRICS, V1_READ };
  const SCOPES: Record<string, Array<(ip: string) => Promise<LightMyRequestResponse>>> = {
    store: [STORE_PING, STORE_TOKEN, CHECKOUT, PAY],
    checkout: [CHECKOUT, PAY],
    api_orders: [ORDER, BULK],
    all: [STORE_PING, STORE_TOKEN, CHECKOUT, PAY, ORDER, BULK],
  };
  const EVERY = [STORE_PING, STORE_TOKEN, CHECKOUT, PAY, ORDER, BULK];

  for (const [scope, refused] of Object.entries(SCOPES)) {
    it(`scope "${scope}" answers 503 MAINTENANCE for its requests only; the admin console, the portal, webhooks, health and metrics never`, async () => {
      await setMaintenance(maintenanceOn(scope));
      for (const request of EVERY) {
        const res = await request(freshIp());
        if (refused.includes(request)) refusedAs(res, 503, 'MAINTENANCE');
        else expect(res.statusCode, `${request.name} not refused`).not.toBe(503);
      }
      for (const [name, request] of Object.entries(ALWAYS_OPEN)) {
        const res = await request(freshIp());
        expect(res.statusCode, `${name} under ${scope}`).toBe(200);
      }
    });
  }

  it('sends the message as detail, expectedEndAt next to it, and a Retry-After', async () => {
    const end = new Date(Date.now() + 120_000).toISOString();
    await setMaintenance(maintenanceOn('checkout', { expectedEndAt: end }));
    const res = await CHECKOUT(freshIp());
    refusedAs(res, 503, 'MAINTENANCE');
    expect(res.json()).toMatchObject({
      title: 'The service is in maintenance.',
      detail: 'Checkout is paused while we check the ledger.',
      expectedEndAt: end,
    });
    const wait = Number(res.headers['retry-after']);
    expect(wait).toBeGreaterThanOrEqual(30);
    expect(wait).toBeLessThanOrEqual(300);
  });

  it('is off when the setting was never set, is off, or is not a well-formed state', async () => {
    for (const value of [undefined, { enabled: false }, { enabled: true, scope: 'nowhere' }, 'on', 7]) {
      await setMaintenance(value);
      expect((await STORE_PING(freshIp())).statusCode, JSON.stringify(value)).toBe(200);
    }
  });

  it('follows a change as soon as the state is invalidated, and goes off when switched off', async () => {
    const ip = freshIp();
    await setMaintenance(maintenanceOn('store'));
    expect((await STORE_PING(ip)).statusCode).toBe(503);
    await setMaintenance({
      ...maintenanceOn('store'),
      enabled: false,
      scope: null,
      message: null,
      startedAt: null,
      startedBy: null,
    });
    expect((await STORE_PING(ip)).statusCode).toBe(200);
    await setMaintenance(maintenanceOn('api_orders'));
    expect((await STORE_PING(ip)).statusCode).toBe(200);
    expect((await ORDER(ip)).statusCode).toBe(503);
  });

  it('answers a Dhru order placement in the Dhru envelope (HTTP 200) and leaves the other Dhru actions alone', async () => {
    await setMaintenance(maintenanceOn('api_orders'));
    const ip = freshIp();
    const envelope = { ERROR: [{ MESSAGE: 'Checkout is paused while we check the ledger.' }], apiversion: '6.1' };
    const json = await post('/api/index.php', ip, { action: 'placeimeiorder' });
    expect(json.statusCode).toBe(200);
    expect(json.headers['content-type']).toBe('application/json; charset=utf-8');
    expect(json.json()).toEqual(envelope);
    const form = await t.app.inject({
      method: 'POST',
      url: '/api/index.php',
      remoteAddress: ip,
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: 'username=merchant&apiaccesskey=k&action=placeimeiorder&parameters=e30%3D',
    });
    expect(form.json()).toEqual(envelope);
    // Status calls and account reads of running orders keep working: they reach the route (which answers its own error).
    const status = await post('/api/index.php', ip, { action: 'getimeiorder' });
    expect(status.json()).toEqual({ ERROR: [{ MESSAGE: 'Authentication Failed' }], apiversion: '6.1' });
    const bulk = await post('/api/index.php', ip, { action: 'PlaceImeiOrderBulk' });
    expect(bulk.json()).toEqual(envelope);
    // With maintenance off the placement reaches the route too.
    await setMaintenance(undefined);
    expect((await post('/api/index.php', ip, { action: 'placeimeiorder' })).json().ERROR[0].MESSAGE).toBe(
      'Authentication Failed',
    );
  });

  it('keeps the state in the cache Redis, so a change is read from the setting only after invalidate()', async () => {
    const redis = t.app.get(RedisService).cache;
    const key = t.app.get(CacheKeys).maintenance();
    await setMaintenance(maintenanceOn('store'));
    expect((await STORE_PING(freshIp())).statusCode).toBe(503);
    expect(JSON.parse((await redis.get(key)) ?? 'null')).not.toBeNull();
    // Written straight to the table: nobody told the cache, so the old state is still served (this process or Redis).
    const { db } = await testDb();
    await db.delete(s.settings);
    expect((await STORE_PING(freshIp())).statusCode).toBe(503);
    await t.app.get(MaintenanceService).invalidate();
    expect(await redis.get(key)).toBeNull();
    expect((await STORE_PING(freshIp())).statusCode).toBe(200);
  });
});

describe('the per-IP rate limit (decision 021)', () => {
  it('limits the public storefront routes to 300 a minute per address, with 429 and Retry-After', async () => {
    const ip = freshIp();
    await exhaust('ip', ip, 299);
    expect((await get('/store/v1/t/ping', ip, AUTH)).statusCode).toBe(200);
    const res = await get('/store/v1/t/ping', ip, { ...AUTH, origin: CONSOLE });
    refusedAs(res, 429, 'RATE_LIMITED');
    expect(Number(res.headers['retry-after'])).toBeGreaterThanOrEqual(1);
    expect(Number(res.headers['retry-after'])).toBeLessThanOrEqual(60);
    expect(res.headers['access-control-allow-origin']).toBe(CONSOLE);
    // Another address has its own budget.
    expect((await get('/store/v1/t/ping', freshIp(), AUTH)).statusCode).toBe(200);
  });

  it('limits token routes to 30 a minute per address with a budget of their own', async () => {
    const ip = freshIp();
    await exhaust('token', ip, 29);
    expect((await get('/store/v1/t/orders/abc', ip, AUTH)).statusCode).toBe(200);
    const res = await get('/store/v1/t/orders/abc', ip, AUTH);
    refusedAs(res, 429, 'RATE_LIMITED');
    // The ordinary routes of the same address still have their 300.
    expect((await get('/store/v1/t/ping', ip, AUTH)).statusCode).toBe(200);
  });

  it('charges a HEAD request to the limiter of the GET route it stands for', async () => {
    const ip = freshIp();
    await exhaust('token', ip, 30);
    const res = await t.app.inject({ method: 'HEAD', url: '/store/v1/t/orders/abc', remoteAddress: ip, headers: AUTH });
    expect(res.statusCode).toBe(429);
  });

  it('counts the public routes of the admin console (sign-in family) against the ip limiter', async () => {
    const ip = freshIp();
    await exhaust('ip', ip, 300);
    refusedAs(await post('/admin/t/sign-in', ip, {}, AUTH), 429, 'RATE_LIMITED');
  });

  it('counts nothing else: authenticated admin and portal routes, REST v1, webhooks and the probes', async () => {
    const ip = freshIp();
    for (const url of ['/admin/t/session', '/client/t/ping', '/v1/t/ping', '/health', '/metrics']) {
      await get(url, ip, AUTH);
    }
    await post('/webhooks/t/ping', ip, {}, AUTH);
    const next = await t.app.get(RateLimitService).consume('ip', ipRateLimitKey(parseIpAddress(ip)));
    expect(next.remaining).toBe(299);
    const token = await t.app.get(RateLimitService).consume('token', ipRateLimitKey(parseIpAddress(ip)));
    expect(token.remaining).toBe(29);
  });

  it('counts an IPv4-mapped client with its IPv4 address, and an IPv6 client by its /64 network', async () => {
    const ip4 = freshIp();
    await exhaust('ip', ip4, 300);
    refusedAs(await get('/store/v1/t/ping', `::ffff:${ip4}`, AUTH), 429, 'RATE_LIMITED');

    const subscriber = freshClientPrefix();
    await exhaust('ip', `${subscriber}::1`, 300);
    refusedAs(await get('/store/v1/t/ping', `${subscriber}:aaaa:bbbb:cccc:dddd`, AUTH), 429, 'RATE_LIMITED');
    expect((await get('/store/v1/t/ping', `${freshClientPrefix()}::1`, AUTH)).statusCode).toBe(200);
  });

  it('keeps limiting in memory when the cache Redis is down, and never fails the request', async () => {
    const down = await createTestApp({
      controllers: [PipelineTestController],
      imports: [TestAccessModule],
      env: { REDIS_CACHE_URL_TEST: await deadRedisUrl(3) },
    });
    extraApps.push(down);
    const ip = freshIp();
    let status = 0;
    for (let i = 0; i < 301; i++) {
      status = (await down.app.inject({ method: 'GET', url: '/store/v1/t/ping', remoteAddress: ip, headers: AUTH }))
        .statusCode;
      if (i < 300) expect(status).toBe(200);
    }
    expect(status).toBe(429);
  });
});

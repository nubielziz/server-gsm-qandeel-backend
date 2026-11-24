// Integration tests of the machine guards (decision 018, P2.5c) through real HTTP on the real application: capability tokens, URL
// secrets, merchant API keys (Dhru credentials) and gateway webhook signatures. Real Postgres and Redis;
// merchants and keys are inserted the way the feature that issues them will store them (keyed hash only).
import { createHash } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import { eq } from 'drizzle-orm';
import type { LightMyRequestResponse } from 'fastify';
import { ipRateLimitKey, parseIpAddress } from '@src/common/ip-address';
import { CacheKeys, CacheService } from '@src/infra/cache';
import { TokenService } from '@src/infra/crypto';
import { type Database, schema as s } from '@src/infra/db';
import { RateLimitService } from '@src/infra/rate-limit';
import { RedisService } from '@src/infra/redis';
import {
  ApiKeyDirectory,
  CapabilityTokenResolvers,
  IpRuleCache,
  type StoredUrlSecret,
  UrlSecretVerifiers,
  WebhookVerifiers,
} from '@src/modules/identity';
import { CheckoutModule, CustomersAccountsModule } from '@src/modules/customers';
import { MerchantAuthModule } from '@src/modules/identity/merchant-auth.module';
import { OrderTrackingModule } from '@src/modules/orders';
import { MaintenanceService } from '@src/modules/platform';
import { SupportStoreModule } from '@src/modules/support';
import { type TestApp, createTestApp } from '../../support/app';
import { makeAccount } from '../../support/accounts';
import { insertMerchant } from '../../support/auth';
import { HOUR, MINUTE, SECOND, TestClock } from '../../support/clock';
import { closeTestDb, resetDb, testDb } from '../../support/db';
import { eventually } from '../../support/infra';
import {
  MachineTestController,
  TEST_GATEWAY,
  TEST_GATEWAY_SECRET,
  URL_SECRET_ROUTE_KEY,
  insertApiKey,
  randomCapabilityToken,
  signedDelivery,
  staticResolver,
  testWebhookVerifier,
} from '../../support/machine-auth';
import { freshClientIp } from '../../support/pipeline-routes';

// The modules that register the real capability token resolvers (checkout, tracking: feature 14a; the customer link tokens and the
// `customer` session subject: feature 14b; the support ticket token: feature 17); this test stands in for them with fixed tokens.
const REAL_RESOLVER_MODULES = [
  CheckoutModule,
  OrderTrackingModule,
  CustomersAccountsModule,
  SupportStoreModule,
  // The resolver of the account link tokens is registered by the sign-in module of the accounts now.
  MerchantAuthModule,
];

const DHRU_FAILED = { ERROR: [{ MESSAGE: 'Authentication Failed' }], apiversion: '6.1' };

let t: TestApp;
let db: Database;
/** The clock of the app: key expiry, "last used" and webhook windows move when the test says so (decision 031). */
const clock = new TestClock();
let stored: StoredUrlSecret | null = null;
const tokens: Record<'checkout' | 'tracking' | 'ticket' | 'link', string> = {
  checkout: '',
  tracking: '',
  ticket: '',
  link: '',
};

beforeAll(async () => {
  ({ db } = await testDb());
  await resetDb();
  t = await createTestApp({ controllers: [MachineTestController], clock, withoutModules: REAL_RESOLVER_MODULES });
  tokens.checkout = randomCapabilityToken(t);
  tokens.tracking = randomCapabilityToken(t);
  tokens.ticket = randomCapabilityToken(t);
  tokens.link = randomCapabilityToken(t);

  const resolvers = t.app.get(CapabilityTokenResolvers);
  resolvers.register(staticResolver('checkout-token', { [tokens.checkout]: 11 }));
  resolvers.register(staticResolver('tracking-token', { [tokens.tracking]: 22 }));
  resolvers.register(staticResolver('ticket-token', { [tokens.ticket]: 33 }));
  resolvers.register(staticResolver('link-token', { [tokens.link]: 44 }));
  t.app.get(UrlSecretVerifiers).register({ routeKey: URL_SECRET_ROUTE_KEY, load: () => stored });
  const verifiers = t.app.get(WebhookVerifiers);
  verifiers.register(testWebhookVerifier);
  verifiers.register({
    gateway: 'nameless',
    verify: () => ({ eventId: '', timestamp: Math.floor(clock.nowMs() / 1000) }),
  });
  verifiers.register({
    gateway: 'broken',
    verify: () => {
      throw new Error('The adapter lost its connection.');
    },
  });
  // Other test files share the cache Redis: start from rules and maintenance that say nothing.
  await t.app.get(IpRuleCache).invalidate();
  await t.app.get(MaintenanceService).invalidate();
});
afterAll(async () => {
  await t.close();
  await closeTestDb();
});
beforeEach(async () => {
  await resetDb();
  stored = null;
  clock.reset();
  const cache = t.app.get(CacheService);
  const keys = t.app.get(CacheKeys);
  // Key ids restart at 1 after resetDb: forget what the caches and limiters know about the previous test's keys.
  await cache.delByPrefix(keys.prefix('identity', 'api-key'));
  await cache.delByPrefix(keys.prefix('identity', 'webhook-event'));
  await cache.delByPrefix(keys.prefix('ratelimit', 'api-key'));
});

const refusedAs = (res: LightMyRequestResponse, status: number, code: string) => {
  expect(res.statusCode).toBe(status);
  expect(res.headers['content-type']).toContain('application/problem+json');
  expect(res.json().code).toBe(code);
};

describe('capability tokens', () => {
  const store = (url: string, ip = freshClientIp()) => t.app.inject({ method: 'GET', url, remoteAddress: ip });

  it('opens the record the resolver found for a valid token, on each token kind', async () => {
    const cases = [
      ['checkout', 11],
      ['orders', 22],
      ['tickets', 33],
    ] as const;
    const byPath = { checkout: tokens.checkout, orders: tokens.tracking, tickets: tokens.ticket };
    for (const [segment, id] of cases) {
      const res = await store(`/store/v1/t/mach/${segment}/${byPath[segment]}`);
      expect(res.statusCode, segment).toBe(200);
      expect(res.json(), segment).toMatchObject({ kind: 'capability', resourceId: id });
    }
  });

  it('reads a sign-in link token from the body', async () => {
    const res = await t.app.inject({
      method: 'POST',
      url: '/store/v1/t/mach/link',
      remoteAddress: freshClientIp(),
      payload: { token: tokens.link },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ kind: 'capability', resourceId: 44 });
  });

  it('refuses an unknown or malformed token with 404, and a sign-in link with 410, never with a session-ending 401', async () => {
    const unknown = randomCapabilityToken(t);
    for (const token of [unknown, 'short', 'x'.repeat(99), 'has%20space-in-it-padded']) {
      refusedAs(await store(`/store/v1/t/mach/orders/${token}`), 404, 'NOT_FOUND');
    }
    // The token of another kind opens nothing here: the resolvers are per kind.
    refusedAs(await store(`/store/v1/t/mach/orders/${tokens.checkout}`), 404, 'NOT_FOUND');
    const link = (payload: unknown) =>
      t.app.inject({
        method: 'POST',
        url: '/store/v1/t/mach/link',
        remoteAddress: freshClientIp(),
        payload: payload as never,
      });
    refusedAs(await link({ token: unknown }), 410, 'TOKEN_INVALID');
    refusedAs(await link({ token: 'short' }), 410, 'TOKEN_INVALID');
    refusedAs(await link({ token: 'x'.repeat(200) }), 410, 'TOKEN_INVALID');
    refusedAs(await link({ token: 12345 }), 410, 'TOKEN_INVALID');
  });

  it('answers a missing, expired and used token the same way (the resolver says null)', async () => {
    const first = await store(`/store/v1/t/mach/orders/${randomCapabilityToken(t)}`);
    const second = await store(`/store/v1/t/mach/orders/${randomCapabilityToken(t)}`);
    expect(first.json().detail).toBe(second.json().detail);
    expect(first.json().code).toBe(second.json().code);
  });

  it('does not use up a token: the guard only looks it up', async () => {
    for (let i = 0; i < 3; i++) {
      expect((await store(`/store/v1/t/mach/checkout/${tokens.checkout}`)).statusCode).toBe(200);
    }
  });

  it('refuses every request on a kind nobody registered a resolver for (fails closed)', async () => {
    const bare = await createTestApp({
      controllers: [MachineTestController],
      withoutModules: REAL_RESOLVER_MODULES,
    });
    try {
      expect(bare.app.get(CapabilityTokenResolvers).has('checkout-token')).toBe(false);
      const res = await bare.app.inject({
        method: 'GET',
        url: `/store/v1/t/mach/checkout/${tokens.checkout}`,
        remoteAddress: freshClientIp(),
      });
      refusedAs(res, 404, 'NOT_FOUND');
    } finally {
      await bare.close();
    }
  });

  it('refuses a second resolver for one kind at boot', () => {
    expect(() => t.app.get(CapabilityTokenResolvers).register(staticResolver('checkout-token', {}))).toThrow(
      /already registered/,
    );
  });

  it('turns a failing resolver into a 5xx, never into a pass', async () => {
    const own = await createTestApp({
      controllers: [MachineTestController],
      withoutModules: REAL_RESOLVER_MODULES,
    });
    try {
      own.app.get(CapabilityTokenResolvers).register({
        kind: 'tracking-token',
        resolve: () => Promise.reject(new Error('database is down')),
      });
      const res = await own.app.inject({
        method: 'GET',
        url: `/store/v1/t/mach/orders/${tokens.tracking}`,
        remoteAddress: freshClientIp(),
      });
      expect(res.statusCode).toBe(500);
    } finally {
      await own.close();
    }
  });
});

describe('URL secrets', () => {
  const secret = 'tg-webhook-secret-0123456789abcdef';
  const call = (value: string) =>
    t.app.inject({ method: 'POST', url: `/webhooks/t/mach/example/${value}`, payload: { update_id: 1 } });

  it('accepts the stored secret when it is kept as a keyed hash', async () => {
    stored = { form: 'hash', value: t.app.get(TokenService).hash(secret) };
    expect((await call(secret)).statusCode).toBe(200);
    refusedAs(await call(`${secret}x`), 401, 'UNAUTHORIZED');
    refusedAs(await call(secret.slice(1)), 401, 'UNAUTHORIZED');
  });

  it('accepts the stored secret when it is kept encrypted (handed over decrypted)', async () => {
    stored = { form: 'secret', value: secret };
    expect((await call(secret)).statusCode).toBe(200);
    refusedAs(await call('another-secret-0123456789abcdef'), 401, 'UNAUTHORIZED');
  });

  it('does not accept the hash itself as the secret', async () => {
    const hash = t.app.get(TokenService).hash(secret);
    stored = { form: 'hash', value: hash };
    refusedAs(await call(hash), 401, 'UNAUTHORIZED');
  });

  it('refuses everything when no secret is configured, and a route nobody registered a source for', async () => {
    stored = null;
    refusedAs(await call(secret), 401, 'UNAUTHORIZED');
    // The source's own placeholder text is not a way in either.
    refusedAs(await call('no-secret-is-configured-for-this-route'), 401, 'UNAUTHORIZED');
    const bare = await createTestApp({ controllers: [MachineTestController] });
    try {
      const res = await bare.app.inject({
        method: 'POST',
        url: `/webhooks/t/mach/example/${secret}`,
        payload: { update_id: 1 },
      });
      refusedAs(res, 401, 'UNAUTHORIZED');
    } finally {
      await bare.close();
    }
  });
});

describe('API keys on the Dhru endpoint', () => {
  const MERCHANT = 'acme';
  /** One `accountinfo` call, the cheapest action that needs the credentials. */
  const get = (key: string | undefined, ip = freshClientIp(), username = MERCHANT) =>
    t.app.inject({
      method: 'POST',
      url: '/api/index.php',
      remoteAddress: ip,
      payload: { action: 'accountinfo', username, ...(key === undefined ? {} : { apiaccesskey: key }) } as never,
    });
  const worked = (res: LightMyRequestResponse) => res.json().SUCCESS !== undefined;
  const messageOf = (res: LightMyRequestResponse): string | undefined => res.json().ERROR?.[0]?.MESSAGE;
  const merchant = (overrides: Partial<typeof s.clients.$inferInsert> = {}) =>
    insertMerchant(db, { username: MERCHANT, ...overrides });

  it('stores only a hash and a display prefix, never the key', async () => {
    const clientId = await merchant();
    const { id, key, keyHash } = await insertApiKey(t, db, clientId);
    const [row] = await db.select().from(s.apiKeys).where(eq(s.apiKeys.id, id));
    expect(JSON.stringify(row)).not.toContain(key);
    expect(row!.keyHash).toBe(keyHash);
    expect(row!.keyHash).toBe(t.app.get(TokenService).hash(key));
    expect(row!.prefix).toBe(key.slice(0, 8));
  });

  it('accepts a live key of an active merchant, with no scope to list', async () => {
    const clientId = await merchant();
    const { key } = await insertApiKey(t, db, clientId);
    expect(worked(await get(key))).toBe(true);
  });

  it('refuses an expired key once the clock passes its expiry (the cached view is judged again on every request)', async () => {
    const clientId = await merchant();
    const future = await insertApiKey(t, db, clientId, { expiresAt: new Date(clock.nowMs() + HOUR) });
    expect(worked(await get(future.key))).toBe(true);
    // Time moves: the key that was fine an hour ago is expired now.
    clock.advance(HOUR + SECOND);
    expect((await get(future.key)).json()).toEqual(DHRU_FAILED);
  });

  it('applies a revoke at once once the cached view is dropped, and not before (it lives a minute)', async () => {
    const clientId = await merchant();
    const { id, key, keyHash } = await insertApiKey(t, db, clientId);
    // The first call writes "last used", which drops the view; the second loads and caches it again.
    expect(worked(await get(key))).toBe(true);
    expect(worked(await get(key))).toBe(true);
    await db.update(s.apiKeys).set({ revokedAt: clock.now() }).where(eq(s.apiKeys.id, id));
    expect(worked(await get(key))).toBe(true);
    await t.app.get(ApiKeyDirectory).invalidate([keyHash]);
    expect((await get(key)).json()).toEqual(DHRU_FAILED);
  });

  it('limits a key to its allowed IP ranges: IPv4 and IPv6 ranges and single addresses, the envelope says so otherwise', async () => {
    const clientId = await merchant();
    const { key } = await insertApiKey(t, db, clientId, {
      allowedIps: ['203.0.113.0/24', '198.51.100.7', '2001:db8:abcd::/48'],
    });
    for (const ip of ['203.0.113.1', '203.0.113.254', '198.51.100.7', '2001:db8:abcd:1::9', '::ffff:203.0.113.9']) {
      expect(worked(await get(key, ip)), ip).toBe(true);
    }
    for (const ip of ['203.0.114.1', '198.51.100.8', '2001:db8:abce::1', '10.0.0.1']) {
      const res = await get(key, ip);
      expect(worked(res), ip).toBe(false);
      expect(messageOf(res), ip).toContain('allowed for this API key');
    }
  });

  it('lets a key with no allowed IPs be used from any address', async () => {
    const clientId = await merchant();
    const { key } = await insertApiKey(t, db, clientId, { allowedIps: [] });
    expect(worked(await get(key, '192.0.2.200'))).toBe(true);
    expect(worked(await get(key, '2001:db8::77'))).toBe(true);
  });

  it("applies a merchant status change once the merchant's cached key views are dropped", async () => {
    const clientId = await merchant();
    const { key } = await insertApiKey(t, db, clientId);
    const directory = t.app.get(ApiKeyDirectory);
    expect(worked(await get(key))).toBe(true);
    await db.update(s.clients).set({ status: 'suspended' }).where(eq(s.clients.id, clientId));
    await directory.invalidateClient(clientId);
    expect(messageOf(await get(key))).toBe('This merchant account is suspended.');
    await db.update(s.clients).set({ status: 'active' }).where(eq(s.clients.id, clientId));
    await directory.invalidateClient(clientId);
    expect(worked(await get(key))).toBe(true);
  });

  it('limits a key to its own requests per minute, other keys unaffected', async () => {
    const clientId = await merchant();
    const limited = await insertApiKey(t, db, clientId, { rateLimitPerMin: 3 });
    const other = await insertApiKey(t, db, clientId, { rateLimitPerMin: 3 });
    for (let i = 0; i < 3; i++) expect(worked(await get(limited.key)), `call ${i + 1}`).toBe(true);
    expect(messageOf(await get(limited.key))).toContain('Too many requests');
    expect(worked(await get(other.key))).toBe(true);
  });

  it('counts only the calls that were accepted: refusals cost the merchant nothing', async () => {
    const clientId = await merchant();
    const { key } = await insertApiKey(t, db, clientId, { allowedIps: ['203.0.113.0/24'], rateLimitPerMin: 2 });
    for (let i = 0; i < 5; i++) expect(messageOf(await get(key, '198.51.100.9'))).toContain('allowed for this API key');
    expect(worked(await get(key, '203.0.113.9'))).toBe(true);
    expect(worked(await get(key, '203.0.113.9'))).toBe(true);
    expect(messageOf(await get(key, '203.0.113.9'))).toContain('Too many requests');
  });

  it('uses the limiter default for a key whose stored limit is not a usable number', async () => {
    const clientId = await merchant();
    const { key } = await insertApiKey(t, db, clientId, { rateLimitPerMin: 0 });
    expect(worked(await get(key))).toBe(true);
  });

  it('counts unknown keys per client address and refuses when one address tries too many', async () => {
    const ip = freshClientIp();
    const address = parseIpAddress(ip);
    const limiter = t.app.get(RateLimitService);
    const failures = `api-key-failures:${ipRateLimitKey(address)}`;
    const used = await limiter.consume('ip', failures, 300, { limit: 300 });
    expect(used.allowed).toBe(true);
    const unknown = `gsm_${t.app.get(TokenService).random(32)}`;
    expect(messageOf(await get(unknown, ip))).toContain('Too many requests');
    // Another address, and a request without any key, are not affected.
    expect((await get(unknown)).json()).toEqual(DHRU_FAILED);
    expect((await get(undefined, ip)).json()).toEqual(DHRU_FAILED);
  });

  it('answers without a lookup, to a valid key the cache does not hold too, once the address used its unknown-key budget (decision 053)', async () => {
    const ip = freshClientIp();
    const limiter = t.app.get(RateLimitService);
    await limiter.consume('ip', `api-key-failures:${ipRateLimitKey(parseIpAddress(ip))}`, 300);
    const clientId = await merchant();
    const known = await insertApiKey(t, db, clientId);
    const lookup = spyOn(t.app.get(ApiKeyDirectory), 'findByKey');
    try {
      // Neither an unknown key nor a valid key the cache does not hold costs a lookup from an address that used up its budget.
      expect(messageOf(await get(`gsm_${t.app.get(TokenService).random(32)}`, ip))).toContain('Too many requests');
      expect(messageOf(await get(known.key, ip))).toContain('Too many requests');
      expect(lookup).not.toHaveBeenCalled();
      // Another address still reaches the lookup, and a request without a key never does.
      expect(worked(await get(known.key))).toBe(true);
      expect(lookup).toHaveBeenCalledTimes(1);
      expect((await get(undefined, ip)).json()).toEqual(DHRU_FAILED);
      expect(lookup).toHaveBeenCalledTimes(1);
    } finally {
      lookup.mockRestore();
    }
  });

  it('does not charge the failure budget for a known key', async () => {
    const clientId = await merchant();
    const { key } = await insertApiKey(t, db, clientId, { allowedIps: ['203.0.113.0/24'] });
    const ip = freshClientIp();
    for (let i = 0; i < 5; i++) expect(messageOf(await get(key, ip))).toContain('allowed for this API key');
    const after = await t.app
      .get(RateLimitService)
      .consume('ip', `api-key-failures:${ipRateLimitKey(parseIpAddress(ip))}`, 1, { limit: 2 });
    expect(after.remaining).toBe(1);
  });

  it('records when and from where a key was last used, at most once a minute', async () => {
    const clientId = await merchant();
    const { id, key } = await insertApiKey(t, db, clientId);
    const row = async () => (await db.select().from(s.apiKeys).where(eq(s.apiKeys.id, id)))[0]!;
    expect((await row()).lastUsedAt).toBeNull();
    expect(worked(await get(key, '203.0.113.50'))).toBe(true);
    const first = await row();
    expect(first.lastUsedAt).not.toBeNull();
    expect(first.lastUsedIp).toBe('203.0.113.50');
    expect(worked(await get(key, '203.0.113.51'))).toBe(true);
    expect((await row()).lastUsedAt).toEqual(first.lastUsedAt);
    expect((await row()).lastUsedIp).toBe('203.0.113.50');
    // A minute later the next call writes it again.
    clock.advance(MINUTE - SECOND);
    expect(worked(await get(key, '203.0.113.52'))).toBe(true);
    expect((await row()).lastUsedIp, 'a second short of a minute: not written').toBe('203.0.113.50');
    clock.advance(SECOND);
    expect(worked(await get(key, '203.0.113.53'))).toBe(true);
    expect((await row()).lastUsedIp).toBe('203.0.113.53');
    expect((await row()).lastUsedAt).toEqual(clock.now());
  });

  it('keeps the keys of two merchants apart', async () => {
    const a = await insertMerchant(db, { username: 'acme', email: 'acme@example.com' });
    const b = await insertMerchant(db, { username: 'beta', email: 'beta@example.com' });
    const keyA = await insertApiKey(t, db, a);
    const keyB = await insertApiKey(t, db, b);
    expect((await get(keyA.key, freshClientIp(), 'acme')).json().SUCCESS[0].AccoutInfo.mail).toBe('acme@example.com');
    expect((await get(keyB.key, freshClientIp(), 'beta')).json().SUCCESS[0].AccoutInfo.mail).toBe('beta@example.com');
    // A key never opens another merchant's username.
    expect((await get(keyA.key, freshClientIp(), 'beta')).json()).toEqual(DHRU_FAILED);
  });
});

describe('Dhru credentials', () => {
  const call = (payload: Record<string, unknown>, ip = freshClientIp()) =>
    t.app.inject({ method: 'POST', url: '/api/index.php', remoteAddress: ip, payload: payload as never });
  const message = (res: LightMyRequestResponse) => res.json().ERROR?.[0]?.MESSAGE;

  it('accepts username and apiaccesskey from a JSON body and from a form body', async () => {
    const clientId = await insertMerchant(db, { username: 'acme-gsm' });
    const { key } = await insertApiKey(t, db, clientId);
    // The real `POST /api/index.php` (feature 7a) answers: `accountinfo` is the cheapest action that needs the credentials.
    const json = await call({ action: 'accountinfo', username: 'acme-gsm', apiaccesskey: key });
    expect(json.statusCode).toBe(200);
    expect(json.json().SUCCESS[0].AccoutInfo).toBeDefined();
    const form = await t.app.inject({
      method: 'POST',
      url: '/api/index.php',
      remoteAddress: freshClientIp(),
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: new URLSearchParams({ action: 'accountinfo', username: 'acme-gsm', apiaccesskey: key }).toString(),
    });
    expect(form.statusCode).toBe(200);
    expect(form.json().SUCCESS[0].AccoutInfo).toBeDefined();
  });

  it('matches the username case-insensitively, like the Dhru username column', async () => {
    const clientId = await insertMerchant(db, { username: 'Acme-GSM' });
    const { key } = await insertApiKey(t, db, clientId);
    expect(
      (await call({ action: 'accountinfo', username: 'acme-gsm', apiaccesskey: key })).json().SUCCESS,
    ).toBeDefined();
    expect(
      (await call({ action: 'accountinfo', username: ' ACME-GSM ', apiaccesskey: key })).json().SUCCESS,
    ).toBeDefined();
  });

  it('answers every credential failure with HTTP 200 and the Dhru envelope "Authentication Failed"', async () => {
    const clientId = await insertMerchant(db, { username: 'acme' });
    const other = await insertMerchant(db, { username: 'other' });
    const good = await insertApiKey(t, db, clientId);
    const revoked = await insertApiKey(t, db, clientId, { revokedAt: new Date(clock.nowMs() - SECOND) });
    const expired = await insertApiKey(t, db, clientId, { expiresAt: new Date(clock.nowMs() - SECOND) });
    const unknown = `gsm_${t.app.get(TokenService).random(32)}`;
    const attempts: Record<string, Record<string, unknown>> = {
      'no credentials': { action: 'accountinfo' },
      'no key': { action: 'accountinfo', username: 'acme' },
      'no username': { action: 'accountinfo', apiaccesskey: good.key },
      'empty key': { action: 'accountinfo', username: 'acme', apiaccesskey: '' },
      'key as a list': { action: 'accountinfo', username: 'acme', apiaccesskey: [good.key] },
      'unknown key': { action: 'accountinfo', username: 'acme', apiaccesskey: unknown },
      'revoked key': { action: 'accountinfo', username: 'acme', apiaccesskey: revoked.key },
      'expired key': { action: 'accountinfo', username: 'acme', apiaccesskey: expired.key },
      'the username of another merchant': { action: 'accountinfo', username: 'other', apiaccesskey: good.key },
      'a username nobody has': { action: 'accountinfo', username: 'nobody', apiaccesskey: good.key },
    };
    expect(other).toBeGreaterThan(0);
    for (const [name, payload] of Object.entries(attempts)) {
      const res = await call(payload);
      expect(res.statusCode, name).toBe(200);
      expect(res.headers['content-type'], name).toBe('application/json; charset=utf-8');
      expect(res.json(), name).toEqual(DHRU_FAILED);
    }
  });

  it('tells the owner of valid credentials what is wrong with them, still in the envelope', async () => {
    const clientId = await insertMerchant(db, { username: 'acme' });
    const restricted = await insertApiKey(t, db, clientId, { allowedIps: ['203.0.113.0/24'] });
    const suspended = await insertMerchant(db, { username: 'frozen', status: 'suspended' });
    const frozen = await insertApiKey(t, db, suspended);

    const ip = await call({ action: 'accountinfo', username: 'acme', apiaccesskey: restricted.key }, '198.51.100.9');
    expect(ip.statusCode).toBe(200);
    expect(message(ip)).toContain('198.51.100.9');
    expect(message(ip)).toContain('allowed for this API key');
    expect(
      (await call({ action: 'accountinfo', username: 'acme', apiaccesskey: restricted.key }, '203.0.113.9')).json()
        .SUCCESS,
    ).toBeDefined();

    const account = await call({ action: 'accountinfo', username: 'frozen', apiaccesskey: frozen.key });
    expect(account.statusCode).toBe(200);
    expect(message(account)).toBe('This merchant account is suspended.');
  });

  it('tells a blocked merchant that the account is suspended, and says nothing about an erased one', async () => {
    const blocked = await insertMerchant(db, { username: 'blocked', status: 'blocked' });
    const erased = await insertMerchant(db, { username: 'erased', status: 'anonymized', anonymizedAt: clock.now() });
    const blockedKey = await insertApiKey(t, db, blocked);
    const erasedKey = await insertApiKey(t, db, erased);
    const refused = await call({ action: 'accountinfo', username: 'blocked', apiaccesskey: blockedKey.key });
    expect(refused.statusCode).toBe(200);
    expect(message(refused)).toBe('This merchant account is suspended.');
    const gone = await call({ action: 'accountinfo', username: 'erased', apiaccesskey: erasedKey.key });
    expect(gone.statusCode).toBe(200);
    expect(gone.json()).toEqual(DHRU_FAILED);
  });

  it('refuses a live key of an account whose rank was moved to retail in SQL, without a revoke: the second wall', async () => {
    const clientId = await insertMerchant(db, { username: 'moved' });
    const { key } = await insertApiKey(t, db, clientId);
    const body = { action: 'accountinfo', username: 'moved', apiaccesskey: key };
    expect((await call(body)).json().SUCCESS).toBeDefined();
    const retail = await makeAccount(t, { rank: 'retail' });
    await db.update(s.clients).set({ groupId: retail.groupId }).where(eq(s.clients.id, clientId));
    // The key row is still live: only the rank changed, and the cached view of the key is dropped as the rank change does.
    const [row] = await db.select().from(s.apiKeys).where(eq(s.apiKeys.clientId, clientId));
    expect(row?.revokedAt).toBeNull();
    await t.app.get(ApiKeyDirectory).invalidateClient(clientId);
    const refused = await call(body);
    expect(refused.statusCode).toBe(200);
    expect(refused.json()).toEqual(DHRU_FAILED);
  });

  it('refuses a key of a retail account that has no username, in the same envelope, whatever username is sent', async () => {
    const retail = await makeAccount(t, { rank: 'retail' });
    const { key } = await insertApiKey(t, db, retail.id);
    for (const username of ['retail', '', 'null']) {
      const res = await call({ action: 'accountinfo', username, apiaccesskey: key });
      expect(res.statusCode, username).toBe(200);
      expect(res.json(), username).toEqual(DHRU_FAILED);
    }
  });

  it('answers the per-key limit in the envelope too', async () => {
    const clientId = await insertMerchant(db, { username: 'acme' });
    const { key } = await insertApiKey(t, db, clientId, { rateLimitPerMin: 2 });
    const body = { action: 'accountinfo', username: 'acme', apiaccesskey: key };
    expect((await call(body)).json().SUCCESS).toBeDefined();
    expect((await call(body)).json().SUCCESS).toBeDefined();
    const limited = await call(body);
    expect(limited.statusCode).toBe(200);
    expect(message(limited)).toContain('Too many requests');
  });
});

describe('gateway webhook signatures', () => {
  const hook = (delivery: { payload: string; headers: Record<string, string> }, gateway = TEST_GATEWAY) =>
    t.app.inject({
      method: 'POST',
      url: `/webhooks/t/mach/pay/${gateway}`,
      headers: delivery.headers,
      payload: delivery.payload,
    });
  const now = () => Math.floor(clock.nowMs() / 1000);
  /** A delivery signed `offset` seconds from now (default now). */
  const signed = (body: Record<string, unknown>, offset = 0, secret?: string) =>
    signedDelivery(body, now() + offset, secret);

  it('accepts a delivery signed by its gateway and hands the handler the event', async () => {
    const res = await hook(signed({ id: 'evt_1', amount: '10.0000' }));
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ kind: 'webhook', gateway: TEST_GATEWAY, eventId: 'evt_1', duplicate: false });
  });

  it('verifies the exact bytes of the body, not a re-serialised object', async () => {
    const payload = '{ "id" : "evt_spaced",\n  "amount": 10.50, "tags": [ "a" ,"b" ] }';
    const { headers } = signed({ id: 'unused' });
    // Sign the odd text itself.
    const reference = signed({ id: 'evt_spaced' });
    expect(reference.payload).not.toBe(payload);
    const { signWebhook } = await import('@src/infra/crypto');
    const odd = {
      payload,
      headers: { ...headers, 'x-test-signature': signWebhook(TEST_GATEWAY_SECRET, now(), payload) },
    };
    const res = await hook(odd);
    expect(res.statusCode).toBe(200);
    expect(res.json().eventId).toBe('evt_spaced');
  });

  it('refuses a missing, malformed, wrong or tampered signature with 400 WEBHOOK_SIGNATURE_INVALID', async () => {
    const good = signed({ id: 'evt_2' });
    const noHeader = { payload: good.payload, headers: { 'content-type': 'application/json' } };
    refusedAs(await hook(noHeader), 400, 'WEBHOOK_SIGNATURE_INVALID');
    const garbage = { payload: good.payload, headers: { ...good.headers, 'x-test-signature': 'nonsense' } };
    refusedAs(await hook(garbage), 400, 'WEBHOOK_SIGNATURE_INVALID');
    refusedAs(await hook(signed({ id: 'evt_2' }, 0, 'another-secret')), 400, 'WEBHOOK_SIGNATURE_INVALID');
    const tampered = { payload: good.payload.replace('evt_2', 'evt_3'), headers: good.headers };
    refusedAs(await hook(tampered), 400, 'WEBHOOK_SIGNATURE_INVALID');
  });

  it('refuses a delivery whose signed time is more than 5 minutes from now, in either direction', async () => {
    for (const offset of [-301, -3_600, 301, 3_600]) {
      const res = await hook(signed({ id: `evt_late_${offset}` }, offset));
      refusedAs(res, 400, 'WEBHOOK_SIGNATURE_INVALID');
      expect(res.json().detail, String(offset)).toContain('too far');
    }
    for (const offset of [-290, 0, 290]) {
      expect((await hook(signed({ id: `evt_in_${offset}` }, offset))).statusCode, String(offset)).toBe(200);
    }
  });

  it('checks the signature before the time, so a forged request learns nothing about the window', async () => {
    const stale = await hook(signed({ id: 'evt_forged' }, -3_600, 'another-secret'));
    refusedAs(stale, 400, 'WEBHOOK_SIGNATURE_INVALID');
    expect(stale.json().detail).not.toContain('too far');
  });

  it('recognises an event it already accepted: the repeat is let through, marked duplicate', async () => {
    const delivery = signed({ id: 'evt_repeat' });
    expect((await hook(delivery)).json().duplicate).toBe(false);
    const again = await hook(delivery);
    expect(again.statusCode).toBe(200);
    expect(again.json()).toMatchObject({ eventId: 'evt_repeat', duplicate: true });
    // A different event is new, and so is the same id on another gateway slug (a separate key space).
    expect((await hook(signed({ id: 'evt_other' }))).json().duplicate).toBe(false);
  });

  it('marks a replay of a captured request inside the window as a duplicate', async () => {
    const captured = signed({ id: 'evt_captured' }, -120);
    expect((await hook(captured)).json().duplicate).toBe(false);
    expect((await hook(captured)).json().duplicate).toBe(true);
    expect((await hook(captured)).json().duplicate).toBe(true);
  });

  it('forgets an event whose delivery ended in a server error, so the gateway retry is processed', async () => {
    const failing = signed({ id: 'evt_fail', fail: true });
    expect((await hook(failing)).statusCode).toBe(500);
    const key = t.app.get(CacheKeys).webhookEvent(TEST_GATEWAY, createHash('sha256').update('evt_fail').digest('hex'));
    const redis = t.app.get(RedisService);
    // The release runs after the reply is sent; wait for the mark to be gone.
    await eventually(async () => ((await redis.cache.exists(key)) === 0 ? true : undefined));
    const retry = await hook(signed({ id: 'evt_fail', fail: false }));
    expect(retry.statusCode).toBe(200);
    expect(retry.json().duplicate).toBe(false);
  });

  it('refuses a gateway nobody registered an adapter for, ignoring the case of the slug', async () => {
    refusedAs(await hook(signed({ id: 'evt_x' }), 'nopay'), 400, 'WEBHOOK_SIGNATURE_INVALID');
    refusedAs(await hook(signed({ id: 'evt_x' }), 'bad slug!'), 400, 'WEBHOOK_SIGNATURE_INVALID');
    expect((await hook(signed({ id: 'evt_upper' }), 'TESTPAY')).statusCode).toBe(200);
  });

  it('answers 5xx, never a pass, when an adapter fails or returns nothing usable', async () => {
    expect((await hook(signed({ id: 'evt_a' }), 'broken')).statusCode).toBe(500);
    const res = await hook(signed({ id: 'evt_b' }), 'nameless');
    expect(res.statusCode).toBe(500);
    expect(res.json().code).toBe('INTERNAL_ERROR');
  });

  it('lists the registered gateways', () => {
    expect(t.app.get(WebhookVerifiers).gateways()).toEqual(['broken', 'nameless', TEST_GATEWAY]);
    expect(() => t.app.get(WebhookVerifiers).register(testWebhookVerifier)).toThrow(/already registered/);
    expect(() =>
      t.app.get(WebhookVerifiers).register({ gateway: 'Not A Slug', verify: () => ({ eventId: '1', timestamp: 1 }) }),
    ).toThrow(/not a valid gateway slug/);
  });
});

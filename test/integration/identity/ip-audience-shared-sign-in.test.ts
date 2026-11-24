// Integration tests of the IP audience of the sign-in routes every account shares (decision 064) through real
// HTTP: a store-scope rule matches the eight shared paths of /client/auth, so a blocked buyer cannot sign in; the rest of the merchant
// portal keeps the audience "other"; a rule of another scope does not reach them; the admin allowlist is not theirs.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import type { LightMyRequestResponse } from 'fastify';
import { CacheKeys } from '@src/infra/cache';
import { schema as s } from '@src/infra/db';
import { RedisService } from '@src/infra/redis';
import { IpRuleCache } from '@src/modules/identity';
import { SHARED_SIGN_IN_PATHS } from '@src/modules/identity/security/ip-rules/ip-audience';
import { type TestApp, createTestApp } from '../../support/app';
import { TestClock } from '../../support/clock';
import { closeTestDb, resetDb, testDb } from '../../support/db';
import { freshClientIp } from '../../support/pipeline-routes';
import { STORE_ORIGIN } from '../../support/store';

const clock = new TestClock();
let t: TestApp;

/** The eight routes every account shares, as the contract says: sign-in and its alias, the code step, sign-out, the two password routes and verification. */
const EIGHT = [
  '/client/auth/sign-in',
  '/client/auth/login',
  '/client/auth/2fa',
  '/client/auth/logout',
  '/client/auth/password/change',
  '/client/auth/password/forgot',
  '/client/auth/password/reset',
  '/client/auth/verify-email',
];

beforeAll(async () => {
  await resetDb();
  t = await createTestApp({ clock, env: { SHOP_ORIGINS: STORE_ORIGIN } });
});

/** Empties the rules and settings and drops the cached snapshot (other test files share the instances). */
async function clean(): Promise<void> {
  const { db } = await testDb();
  await db.delete(s.ipRules);
  await db.delete(s.settings);
  await t.app.get(IpRuleCache).invalidate();
  await t.app.get(RedisService).cache.del(t.app.get(CacheKeys).ipRuleHits());
}
afterAll(async () => {
  await clean();
  await t.close();
  await closeTestDb();
});
beforeEach(async () => {
  clock.reset();
  await clean();
});

async function addRule(scope: 'store' | 'api' | 'admin' | 'all', cidr: string): Promise<void> {
  const { db } = await testDb();
  await db.insert(s.ipRules).values({ kind: 'block', scope, cidr, reason: 'test' });
  await t.app.get(IpRuleCache).invalidate();
}

const post = (url: string, ip: string) =>
  t.app.inject({ method: 'POST', url, remoteAddress: ip, headers: { origin: STORE_ORIGIN }, payload: {} });
const get = (url: string, ip: string) => t.app.inject({ method: 'GET', url, remoteAddress: ip });

const isIpRefusal = (res: LightMyRequestResponse) =>
  res.statusCode === 403 &&
  String(res.headers['content-type'] ?? '').includes('json') &&
  res.json().code === 'IP_NOT_ALLOWED';

describe('a store-scope rule and the shared sign-in routes', () => {
  it('names the eight routes of the contract', () => {
    expect([...SHARED_SIGN_IN_PATHS].sort()).toEqual([...EIGHT].sort());
  });

  it('refuses a blocked address on each of the eight routes with 403 IP_NOT_ALLOWED, before the route reads anything', async () => {
    const ip = freshClientIp();
    await addRule('store', `${ip}/32`);
    for (const path of EIGHT) {
      const res = await post(path, ip);
      expect(isIpRefusal(res), `${path} -> ${res.statusCode} ${res.body.slice(0, 120)}`).toBe(true);
      expect(res.json().detail, path).toContain('is blocked');
    }
  });

  it('lets another address through to the routes (they answer for their own reasons, never with the IP refusal)', async () => {
    await addRule('store', `${freshClientIp()}/32`);
    for (const path of EIGHT) expect(isIpRefusal(await post(path, freshClientIp())), path).toBe(false);
  });

  it('does not reach the rest of the merchant portal: those routes stay the audience "other"', async () => {
    const ip = freshClientIp();
    await addRule('store', `${ip}/32`);
    for (const path of ['/client/auth/me', '/client/orders', '/client/wallet', '/client/notifications']) {
      expect(isIpRefusal(await get(path, ip)), path).toBe(false);
    }
    // The shop's own routes are covered, as before.
    expect(isIpRefusal(await get('/store/v1/me', ip))).toBe(true);
  });
});

describe('the other scopes', () => {
  it('stops the eight routes for an "all" rule, as it stops every audience', async () => {
    const ip = freshClientIp();
    await addRule('all', `${ip}/32`);
    for (const path of EIGHT) expect(isIpRefusal(await post(path, ip)), path).toBe(true);
    expect(isIpRefusal(await get('/client/orders', ip))).toBe(true);
  });

  it('does not stop them for an api or an admin rule: a blocked integration or console address may still sign in', async () => {
    for (const scope of ['api', 'admin'] as const) {
      await clean();
      const ip = freshClientIp();
      await addRule(scope, `${ip}/32`);
      for (const path of EIGHT) expect(isIpRefusal(await post(path, ip)), `${scope} ${path}`).toBe(false);
    }
  });

  it('is not the admin allowlist: restricting the console leaves the eight routes open to every address', async () => {
    const { db } = await testDb();
    await db.insert(s.settings).values({ key: 'adminAllowlistOnly', value: true });
    await t.app.get(IpRuleCache).invalidate();
    for (const path of EIGHT) expect(isIpRefusal(await post(path, freshClientIp())), path).toBe(false);
    expect(isIpRefusal(await get('/admin/staff', freshClientIp()))).toBe(true);
  });
});

// Integration tests of the unknown-key budget of an address (decision 053) through real HTTP on the Dhru endpoint: unknown keys and Dhru usernames
// that are not the key's cost one point per client address (the IPv4 address or the IPv6 /64); once the 300 a minute are used up the address is
// refused without a database lookup, except for a key whose view is in the cache: a key in use keeps its view fresh and stays answered.
import { afterAll, beforeAll, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import { eq } from 'drizzle-orm';
import { ipRateLimitKey, parseIpAddress } from '@src/common/ip-address';
import { CacheKeys, cacheMacKey, openEntry } from '@src/infra/cache';
import { TokenService } from '@src/infra/crypto';
import { DbService, schema as s } from '@src/infra/db';
import { RateLimitService } from '@src/infra/rate-limit';
import { RedisService } from '@src/infra/redis';
import { type TestApp, createTestApp } from '../../support/app';
import { clearIdentityCaches, clearRateLimits, insertMerchant } from '../../support/auth';
import { MINUTE, SECOND, TestClock } from '../../support/clock';
import { closeTestDb, resetDb, testDb } from '../../support/db';
import { eventually } from '../../support/infra';
import { type MachineCredentials, clearApiKeyCaches, credentialsFor, dhruClient } from '../../support/machine-orders';
import { freshClientIp, freshClientPrefix } from '../../support/pipeline-routes';

const clock = new TestClock();
let t: TestApp;
let limits: RateLimitService;

beforeAll(async () => {
  t = await createTestApp({ clock });
  limits = t.app.get(RateLimitService);
});
afterAll(async () => {
  await resetDb();
  await t.close();
  await closeTestDb();
});
beforeEach(async () => {
  clock.reset();
  await resetDb();
  await clearIdentityCaches(t);
  await clearApiKeyCaches(t);
  await clearRateLimits(t);
});

/** What a Dhru `accountinfo` call came to: a success, the answer of a used-up budget, or any other refusal. */
type Outcome = 'ok' | 'limited' | 'refused';

/** Calls `accountinfo` with a username and a key, from an address. */
async function accountinfo(username: string, key: string, ip: string): Promise<Outcome> {
  const res = await t.app.inject({
    method: 'POST',
    url: '/api/index.php',
    remoteAddress: ip,
    payload: { action: 'accountinfo', username, apiaccesskey: key } as never,
  });
  const answer = res.json<{ SUCCESS?: unknown; ERROR?: Array<{ MESSAGE: string }> }>();
  if (answer.SUCCESS !== undefined) return 'ok';
  return String(answer.ERROR?.[0]?.MESSAGE).includes('Too many requests') ? 'limited' : 'refused';
}
/** The call of a merchant's own key. */
const own = (merchant: MachineCredentials, ip: string) => accountinfo(merchant.username, merchant.key, ip);
const inventedKey = () => `gsm_${t.app.get(TokenService).random(32)}`;
const failureKey = (ip: string) => `api-key-failures:${ipRateLimitKey(parseIpAddress(ip))}`;

/** Runs `count` calls, 50 at a time, and returns their outcomes. */
async function inBatches(count: number, send: () => Promise<Outcome>): Promise<Outcome[]> {
  const outcomes: Outcome[] = [];
  for (let sent = 0; sent < count; sent += 50) {
    const batch = Array.from({ length: Math.min(50, count - sent) }, send);
    outcomes.push(...(await Promise.all(batch)));
  }
  return outcomes;
}

/** The statements that read the API keys or the merchants while `work` runs. */
async function keyReadsDuring(work: () => Promise<void>): Promise<string[]> {
  const query = spyOn(t.app.get(DbService).pool, 'query');
  try {
    await work();
    return query.mock.calls
      .map((call) => (typeof call[0] === 'string' ? call[0] : (call[0] as { text: string }).text))
      .filter((text) => /"api_keys"|"clients"/.test(text));
  } finally {
    query.mockRestore();
  }
}

/** Sends `count` calls 2 ms apart, each without waiting for the answers before it, and returns their outcomes in order. */
async function sideBySide(count: number, send: () => Promise<Outcome>): Promise<Outcome[]> {
  const pending: Promise<Outcome>[] = [];
  for (let sent = 0; sent < count; sent += 1) {
    pending.push(send());
    await Bun.sleep(2);
  }
  return Promise.all(pending);
}

/** How many milliseconds the cached view of a key stays fresh on the app's clock (0 when nothing is cached). */
async function freshForMs(key: string): Promise<number> {
  const cacheKey = t.app.get(CacheKeys).apiKey(t.app.get(TokenService).hash(key));
  const text = (await t.app.get(RedisService).cache.get(cacheKey)) ?? '';
  const opened = openEntry(cacheMacKey(t.config.security.tokenPepper), cacheKey, text);
  return typeof opened === 'string' ? 0 : opened.freshUntil - clock.nowMs();
}

describe('a valid API key of an address that used up its unknown-key budget', () => {
  it('is answered for an address of the same IPv6 /64, while invented keys stay refused without a database read', async () => {
    const { db } = await testDb();
    const merchant = await credentialsFor(t, db, await insertMerchant(db, { name: 'Network Phones' }));
    const prefix = freshClientPrefix();
    const server = `${prefix}::10`;
    const other = `${prefix}::bad:1`;
    expect(await own(merchant, server)).toBe('ok');
    // An unknown key is looked up in the database while the budget lasts.
    expect(
      await keyReadsDuring(async () => void (await accountinfo(merchant.username, inventedKey(), other))),
    ).not.toEqual([]);
    const outcomes = await inBatches(299, () => accountinfo(merchant.username, inventedKey(), other));
    expect(outcomes.filter((outcome) => outcome === 'refused')).toHaveLength(299);

    const reads = await keyReadsDuring(async () => {
      expect(await accountinfo(merchant.username, inventedKey(), other)).toBe('limited');
    });
    expect(reads, 'no database read for an invented key once the budget is used up').toEqual([]);

    expect(await own(merchant, server)).toBe('ok');
    const account = await dhruClient(t, merchant).call('accountinfo', undefined, { ip: server });
    expect(JSON.stringify(account)).toContain('AccoutInfo');
  }, 60_000);

  it('is answered for a merchant sharing the address of another one whose wrong username used up the budget, which stays charged', async () => {
    const { db } = await testDb();
    const merchant = await credentialsFor(t, db, await insertMerchant(db, { name: 'Shared Host Phones' }));
    const neighbour = await credentialsFor(t, db, await insertMerchant(db, { name: 'Shared Host GSM' }));
    const host = freshClientIp();
    expect(JSON.stringify(await dhruClient(t, merchant).call('accountinfo', undefined, { ip: host }))).toContain(
      'AccoutInfo',
    );

    const mistyped = dhruClient(t, { ...neighbour, username: `${neighbour.username}-typo` });
    await inBatches(300, async () => {
      await mistyped.raw('getimeiorder', { ID: 1 }, { ip: host });
      return 'refused';
    });
    expect(await limits.peek('ip', failureKey(host))).toMatchObject({ allowed: false });
    // The wrong username is still charged and refused.
    expect(JSON.stringify(await mistyped.call('accountinfo', undefined, { ip: host }))).not.toContain('AccoutInfo');

    expect(JSON.stringify(await dhruClient(t, merchant).call('accountinfo', undefined, { ip: host }))).toContain(
      'AccoutInfo',
    );
    expect(await own(merchant, host)).toBe('ok');
  }, 60_000);

  for (const cadence of [60, 65, 90]) {
    it(`stays answered while it is used every ${cadence} seconds for five minutes with the budget used up the whole time`, async () => {
      const { db } = await testDb();
      const merchant = await credentialsFor(t, db, await insertMerchant(db));
      const ip = freshClientIp();
      expect(await own(merchant, ip)).toBe('ok');
      await limits.consume('ip', failureKey(ip), 300);
      // Five minutes on the app's clock, one call per step: each step comes later than the shortest life of a fresh view (51 s).
      for (let step = 1; step <= Math.ceil(300 / cadence); step += 1) {
        clock.advance(cadence * SECOND);
        expect(await limits.peek('ip', failureKey(ip)), `budget after ${step * cadence} s`).toMatchObject({
          allowed: false,
        });
        expect(await own(merchant, ip), `after ${step * cadence} s`).toBe('ok');
        // The call left a view loaded at this moment behind it.
        await eventually(async () => ((await freshForMs(merchant.key)) >= 50 * SECOND ? true : undefined));
      }
      const [row] = await db.select().from(s.apiKeys).where(eq(s.apiKeys.id, merchant.keyId));
      expect(row!.lastUsedAt!.getTime(), '"last used" is still written once a minute').toBeGreaterThanOrEqual(
        clock.nowMs() - MINUTE,
      );
      expect(await accountinfo(merchant.username, inventedKey(), ip)).toBe('limited');
    }, 60_000);
  }

  it('stays answered when it sends calls side by side while its once-a-minute "last used" write runs', async () => {
    const { db } = await testDb();
    const merchant = await credentialsFor(t, db, await insertMerchant(db));
    const ip = freshClientIp();
    expect(await own(merchant, ip)).toBe('ok');
    await limits.consume('ip', failureKey(ip), 300);
    // Each round comes after the "last used" write is due, so the 20 calls of a round overlap that write and the reload of the view behind it.
    for (let round = 1; round <= 6; round += 1) {
      clock.advance(61 * SECOND);
      expect(await limits.peek('ip', failureKey(ip)), `budget in round ${round}`).toMatchObject({ allowed: false });
      const outcomes = await sideBySide(20, () => own(merchant, ip));
      expect(outcomes, `round ${round}`).toEqual(Array.from({ length: 20 }, () => 'ok'));
    }
    expect(await accountinfo(merchant.username, inventedKey(), ip)).toBe('limited');
  }, 60_000);

  it('is refused without a database read while the budget is used up once its view left the cache, and answered again when the budget is back', async () => {
    const { db } = await testDb();
    const merchant = await credentialsFor(t, db, await insertMerchant(db));
    const ip = freshClientIp();
    expect(await own(merchant, ip)).toBe('ok');
    await limits.consume('ip', failureKey(ip), 300);
    // Unused for longer than a view stays in the cache, its grace included (69 s + 60 s at most).
    clock.advance(130 * SECOND);
    const reads = await keyReadsDuring(async () => {
      expect(await own(merchant, ip)).toBe('limited');
    });
    expect(reads).toEqual([]);
    await limits.reset('ip', failureKey(ip));
    expect(await own(merchant, ip)).toBe('ok');
  });
});

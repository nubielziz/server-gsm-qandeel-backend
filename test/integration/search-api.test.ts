// Integration tests of the storefront search API (feature 29, slice B2) on real Postgres, Redis and Typesense: the suggest and results
// routes (shape, refusals, prices from Postgres, stale hits, English only, facet labels, the `/services?q=` path), the fallback on every
// kind of engine failure, the statistics (what is counted and what never is), the limiter, and the console's search tools (CRUD with
// audit rows and events, refusals, the rebuild, permissions). The suite works under its own Typesense sub-prefix and drops it in afterAll.
import { afterAll, beforeAll, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import { eq } from 'drizzle-orm';
import { Redis } from 'ioredis';
import { CacheKeys } from '../../src/infra/cache';
import { DbService, schema as s } from '../../src/infra/db';
import { RedisService } from '../../src/infra/redis';
import { SearchCircuit, SearchMetrics } from '../../src/infra/search';
import { SearchNames } from '../../src/modules/storefront';
import { SearchTermsFlush } from '../../src/modules/storefront/search/application/search-terms-flush';
import {
  SearchRebuildProcessor,
  SearchTermsBuildProcessor,
  SearchTermsFlushProcessor,
} from '../../src/modules/storefront/search/jobs/search-maintenance.processors';
import { dayKey, dayOf } from '../../src/modules/storefront/search/domain/terms';
import { type AdminApi, adminWith } from '../support/admin-api';
import { clearIdentityCaches } from '../support/auth';
import { insertCategory, insertService } from '../support/catalog';
import { TestClock } from '../support/clock';
import { closeTestDb, resetDb, testDb } from '../support/db';
import { deleteBullKeys } from '../support/queues';
import {
  type SearchTestApp,
  createSearchTestApp,
  dropSearchPrefix,
  engineClient,
  searchEvents,
  searchTestPrefix,
} from '../support/search';
import { insertListing, insertRetailPrice, storefrontWorld } from '../support/storefront';

const clock = new TestClock('2026-11-16T10:00:00.000Z');
const apps: SearchTestApp[] = [];
let t: SearchTestApp;
let admin: AdminApi;
let world: Awaited<ReturnType<typeof storefrontWorld>>;
const extra: {
  frp: number;
  frpListing: number;
  network: number;
  unlisted: number;
  categoryId: number;
} = {
  frp: 0,
  frpListing: 0,
  network: 0,
  unlisted: 0,
  categoryId: 0,
};
const db = async () => (await testDb()).db;
const job = (data: object = {}) => ({ name: 'test', data, timestamp: clock.nowMs() }) as never;

/** Another app on the same database with its own settings (a closed engine, a wrong key, search off). */
async function otherApp(env: Record<string, string>, prefix = searchTestPrefix()): Promise<SearchTestApp> {
  const app = await createSearchTestApp({ clock, env, prefix });
  apps.push(app);
  // The engine part of a suggest is cached per typed text in the one cache Redis the apps of a run share: another engine's answers go.
  const cache = app.app.get(RedisService).cache;
  const stale = await cache.keys('gsm:*:storefront:suggest:*');
  if (stale.length > 0) await cache.del(...stale);
  return app;
}

const publicGet = (app: SearchTestApp, url: string, headers: Record<string, string> = {}, ip = '198.51.100.7') =>
  app.app.inject({ method: 'GET', url, headers, remoteAddress: ip });
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- test bodies are untyped JSON: the default keeps assertions short
const json = <T = any>(res: { body: string }): T => JSON.parse(res.body) as T;

/** Builds the world: the usual two services plus a Samsung one, a second Samsung spelling and a priced service whose page is off. */
async function buildWorld(): Promise<void> {
  const database = await db();
  world = await storefrontWorld(database);
  extra.categoryId = await insertCategory(database, { name: 'Samsung Services' });
  const cheap = { cost: '0.0800', effectiveCost: '0.0800', basePrice: '0.1300', minProfit: null };
  extra.frp = await insertService(database, extra.categoryId, { name: 'Samsung FRP Bypass', ...cheap });
  extra.network = await insertService(database, extra.categoryId, { name: 'Samsung Network Unlock', ...cheap });
  extra.unlisted = await insertService(database, extra.categoryId, { name: 'Zircon Unlock', ...cheap });
  for (const serviceId of [extra.frp, extra.network, extra.unlisted])
    await insertRetailPrice(database, serviceId, world.groups.retail, '9.9900');
  extra.frpListing = await insertListing(database, extra.frp, {
    slug: 'samsung-frp-bypass',
    publicTitle: 'Samsung FRP Bypass',
    summary: 'Remove the Google lock from a Samsung phone.',
    brand: 'Samsung',
    sales30d: 50,
  });
  await insertListing(database, extra.network, {
    slug: 'samsung-network-unlock',
    publicTitle: 'Samsung Network Unlock (SM-A525F)',
    brand: 'SAMSUNG',
    carrier: 'Vodafone',
    country: 'GB',
    sales30d: 20,
  });
  await insertListing(database, extra.unlisted, {
    slug: 'zircon-unlock',
    publicTitle: 'Zircon Unlock',
    isListed: false,
  });
}

/** Builds the index and the terms collection from Postgres (what the worker's rebuild and terms build do). */
async function buildIndex(app: SearchTestApp): Promise<void> {
  await app.app.get(SearchRebuildProcessor, { strict: false }).process(job());
  await app.app.get(SearchTermsBuildProcessor, { strict: false }).process(job());
}

beforeAll(async () => {
  await resetDb();
  t = await createSearchTestApp({ clock });
  apps.push(t);
  // The reset restarted the ids: a role that the file before this one left in the cache (5 minutes) would lend its
  // permissions to the first role made here, and that staff member would be refused.
  await clearIdentityCaches(t);
  await buildWorld();
  await buildIndex(t);
});

afterAll(async () => {
  const redis = new Redis(t.config.redis.queueUrl);
  for (const app of apps) {
    await dropSearchPrefix(app.prefix);
    await deleteBullKeys(redis, app.bullPrefix);
  }
  redis.disconnect();
  await resetDb();
  for (const app of apps) await app.close();
  await closeTestDb();
});

describe('GET /store/v1/search/suggest', () => {
  it('answers the ghost, completions, services with Postgres prices, filters and the engine header', async () => {
    const res = await publicGet(t, '/store/v1/search/suggest?q=samsung%20f');
    expect(res.statusCode).toBe(200);
    expect(res.headers['x-search-engine']).toBe('typesense');
    expect(res.headers['cache-control']).toBe('public, max-age=30');
    const body = json(res);
    expect(body.engine).toBe('typesense');
    expect(body.q).toBe('samsung f');
    expect(body.ghost).toBe('rp');
    expect(body.completions.map((c: { text: string }) => c.text)).toContain('samsung frp');
    expect(body.services[0]).toMatchObject({
      id: extra.frp,
      slug: 'samsung-frp-bypass',
      title: 'Samsung FRP Bypass',
      titleHighlight: '<mark>Samsung</mark> <mark>FRP</mark> Bypass',
      brand: 'Samsung',
      type: 'imei',
      category: { id: extra.categoryId, name: 'Samsung Services' },
      availability: 'on_request',
      price: { currency: 'USD', net: '9.9900', gross: '9.9900' },
    });
    expect(body.filters.map((f: { label: string }) => f.label.toLowerCase())).toContain('brand: samsung');
    expect(body.popular).toEqual([]);
    expect(body.intent).toBeNull();
  });

  it('forgives a typo, offers a did-you-mean and completes a model code while it is typed', async () => {
    const typo = json(await publicGet(t, '/store/v1/search/suggest?q=samsng%20frp'));
    expect(typo.services[0].slug).toBe('samsung-frp-bypass');
    expect(typo.didYouMean).toBe('samsung frp');
    const code = json(await publicGet(t, '/store/v1/search/suggest?q=a525'));
    expect(code.services.map((svc: { slug: string }) => svc.slug)).toContain('samsung-network-unlock');
    const wrong = json(await publicGet(t, '/store/v1/search/suggest?q=SM-A526F'));
    expect(wrong.services.map((svc: { slug: string }) => svc.slug)).not.toContain('samsung-network-unlock');
  });

  it('shows the popular searches (the first categories) for an empty text and an IMEI intent without a search', async () => {
    const empty = json(await publicGet(t, '/store/v1/search/suggest?q='));
    expect(empty.services).toEqual([]);
    expect(empty.popular.length).toBeGreaterThan(0);
    expect(empty.popular.length).toBeLessThanOrEqual(8);
    const imei = json(await publicGet(t, '/store/v1/search/suggest?q=3569%203803%205643%20809'));
    expect(imei).toMatchObject({ intent: 'imei', services: [], completions: [] });
  });

  it('refuses an unknown key and a text over 100 characters, and takes a NUL byte as nothing', async () => {
    expect((await publicGet(t, '/store/v1/search/suggest?q=a&nope=1')).statusCode).toBe(422);
    expect((await publicGet(t, `/store/v1/search/suggest?q=${'a'.repeat(101)}`)).statusCode).toBe(422);
    expect((await publicGet(t, `/store/v1/search/suggest?q=${'a'.repeat(100)}`)).statusCode).toBe(200);
    expect((await publicGet(t, '/store/v1/search/suggest?q=sam%00sung')).statusCode).toBe(200);
    expect((await publicGet(t, '/store/v1/search/suggest?q=samsung&currency=ZZZ')).statusCode).toBe(422);
  });

  it('prices from Postgres only: a price change shows at once, without a reindex', async () => {
    await publicGet(t, '/store/v1/search/suggest?q=samsung%20frp');
    await (
      await db()
    )
      .update(s.serviceGroupPrices)
      .set({ price: '7.5000' })
      .where(eq(s.serviceGroupPrices.serviceId, extra.frp));
    const body = json(await publicGet(t, '/store/v1/search/suggest?q=samsung%20frp'));
    expect(body.services[0].price.net).toBe('7.5000');
    await (
      await db()
    )
      .update(s.serviceGroupPrices)
      .set({ price: '9.9900' })
      .where(eq(s.serviceGroupPrices.serviceId, extra.frp));
  });

  it('drops a stale hit and counts it', async () => {
    const metrics = t.app.get(SearchMetrics);
    const before = (await metrics.staleHits.get()).values[0]?.value ?? 0;
    await (
      await db()
    )
      .update(s.serviceListings)
      .set({ isListed: false })
      .where(eq(s.serviceListings.id, extra.frpListing));
    // A fresh text so the cached engine part (which still holds the service) is not what answers the first call.
    const body = json(await publicGet(t, '/store/v1/search/suggest?q=samsung%20frp%20bypass'));
    expect(body.services.map((svc: { slug: string }) => svc.slug)).not.toContain('samsung-frp-bypass');
    expect(((await metrics.staleHits.get()).values[0]?.value ?? 0) - before).toBeGreaterThanOrEqual(1);
    await (
      await db()
    )
      .update(s.serviceListings)
      .set({ isListed: true })
      .where(eq(s.serviceListings.id, extra.frpListing));
  });

  it('never shows a sellable, priced service whose page is off', async () => {
    const body = json(await publicGet(t, '/store/v1/search/suggest?q=zircon'));
    expect(body.services).toEqual([]);
    const res = json(await publicGet(t, '/store/v1/search?q=zircon'));
    expect(res.hits).toEqual([]);
  });

  it('keeps a warm suggest to its measured Postgres query budget once the cards are cached', async () => {
    await publicGet(t, '/store/v1/search/suggest?q=samsung%20network');
    const pool = t.app.get(DbService).pool;
    const spy = spyOn(pool, 'query');
    const res = await publicGet(t, '/store/v1/search/suggest?q=samsung%20network');
    const queries = spy.mock.calls.length;
    spy.mockRestore();
    expect(res.statusCode).toBe(200);
    expect(json(res).services.length).toBeGreaterThan(0);
    expect(queries).toBeLessThanOrEqual(QUERY_BUDGET);
  });
});

/**
 * The Postgres queries one warm suggest runs: 12 (the plan's target of 4 is out of reach with catalog's public reads: `RetailPrices.quotes`
 * alone runs 6, the searchable rule 3, plus the retail group, the currency and the stock; see the search README).
 */
const QUERY_BUDGET = 12;

describe('GET /store/v1/search', () => {
  it('lists the matches as the exact cards of the service list, with facets and the price span', async () => {
    const res = await publicGet(t, '/store/v1/search?q=samsung');
    expect(res.statusCode).toBe(200);
    expect(res.headers['x-search-engine']).toBe('typesense');
    const body = json(res);
    expect(body).toMatchObject({ engine: 'typesense', total: 2, truncated: false, page: 1, perPage: 24, intent: null });
    expect(body.hits.map((hit: { slug: string }) => hit.slug).sort()).toEqual([
      'samsung-frp-bypass',
      'samsung-network-unlock',
    ]);
    const list = json(await publicGet(t, '/store/v1/services?brand=samsung&_end=10'));
    const card = (slug: string, from: Array<{ slug: string }>) => from.find((entry) => entry.slug === slug);
    expect(card('samsung-frp-bypass', body.hits)).toEqual(card('samsung-frp-bypass', list));
    expect(body.priceRange).toEqual({ min: '9.9900', max: '9.9900' });
    // `Samsung` and `SAMSUNG` are one facet entry with the summed count and the most used spelling.
    expect(body.facets.brand).toEqual([{ value: expect.stringMatching(/^s/i), count: 2 }]);
    expect(body.facets.network).toEqual([{ value: 'Vodafone', count: 1 }]);
    expect(body.facets.country).toEqual([{ value: 'GB', count: 1 }]);
    expect(body.facets.availability).toEqual({ in_stock: 0, on_request: 2 });
  });

  it('filters, pages, sorts by price and bounds the price over the best matches', async () => {
    const filtered = json(await publicGet(t, '/store/v1/search?q=samsung&network=vodafone'));
    expect(filtered.hits.map((hit: { slug: string }) => hit.slug)).toEqual(['samsung-network-unlock']);
    // The brand facet still shows both brands' counts: a group's counts ignore its own selection.
    const byBrand = json(await publicGet(t, '/store/v1/search?q=samsung&brand=Samsung'));
    expect(byBrand.facets.brand[0].count).toBe(2);
    const priced = await publicGet(t, '/store/v1/search?q=samsung&sort=price&order=desc&minPrice=9&maxPrice=10');
    expect(json(priced).total).toBe(2);
    expect(json(await publicGet(t, '/store/v1/search?q=samsung&maxPrice=1')).hits).toEqual([]);
    expect((await publicGet(t, '/store/v1/search?q=samsung&minPrice=5&maxPrice=1')).statusCode).toBe(422);
    const page1 = json(await publicGet(t, '/store/v1/search?q=samsung&page=1&perPage=1'));
    const page2 = json(await publicGet(t, '/store/v1/search?q=samsung&page=2&perPage=1'));
    expect(page2.hits).toHaveLength(1);
    expect(page2.total).toBe(2);
    // Page 2 is the window after page 1 (the same order as the service list), never page 1 again; the price span is a page-1 field.
    expect(page1.hits).toHaveLength(1);
    expect(page2.hits[0].slug).not.toBe(page1.hits[0].slug);
    expect([page1.hits[0].slug, page2.hits[0].slug].sort()).toEqual(['samsung-frp-bypass', 'samsung-network-unlock']);
    expect(page1.priceRange).toEqual({ min: '9.9900', max: '9.9900' });
    expect(page2.priceRange).toBeNull();
    const list = json<Array<{ slug: string }>>(await publicGet(t, '/store/v1/services?q=samsung&_start=1&_end=2'));
    expect(page2.hits[0].slug).toBe(list[0]!.slug);
    expect(json(await publicGet(t, '/store/v1/search?q=samsung&page=3&perPage=1')).hits).toEqual([]);
  });

  it('takes a category id beyond the index range as a selection that matches nothing, and never opens the circuit', async () => {
    const circuit = t.app.get(SearchCircuit);
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const res = await publicGet(t, '/store/v1/search?q=samsung&categoryId=2147483648');
      expect(res.statusCode).toBe(200);
      expect(res.headers['x-search-engine']).toBe('typesense');
      expect(json(res)).toMatchObject({ total: 0, hits: [] });
      const list = await publicGet(t, '/store/v1/services?q=samsung&categoryId=2147483648');
      expect(list.statusCode).toBe(200);
      expect(json<unknown[]>(list)).toEqual([]);
    }
    expect(circuit.state()).toBe('closed');
    const plain = await publicGet(t, '/store/v1/search?q=samsung');
    expect(plain.headers['x-search-engine']).toBe('typesense');
    expect(json(plain).total).toBe(2);
    // A category id in range still filters.
    const inRange = json(await publicGet(t, `/store/v1/search?q=samsung&categoryId=${extra.categoryId}`));
    expect(inRange.total).toBe(2);
  });

  it('refuses an unknown key, a missing or oversized text, a bad page and a bad sort; a NUL byte is a 200', async () => {
    for (const url of [
      '/store/v1/search?q=a&nope=1',
      '/store/v1/search',
      '/store/v1/search?q=%20%20',
      `/store/v1/search?q=${'a'.repeat(101)}`,
      '/store/v1/search?q=a&page=51',
      '/store/v1/search?q=a&perPage=49',
      '/store/v1/search?q=a&sort=nope',
    ]) {
      expect((await publicGet(t, url)).statusCode, url).toBe(422);
    }
    expect((await publicGet(t, '/store/v1/search?q=sam%00sung')).statusCode).toBe(200);
  });

  it('answers an IMEI with the intent and no hits', async () => {
    const body = json(await publicGet(t, '/store/v1/search?q=356938035643809'));
    expect(body).toMatchObject({ intent: 'imei', hits: [], total: 0 });
  });

  it('suggests a correction when a word matched nothing and nothing for gibberish', async () => {
    expect(json(await publicGet(t, '/store/v1/search?q=samsng%20frp')).didYouMean).toBe('samsung frp');
    expect(json(await publicGet(t, '/store/v1/search?q=zzzzzzz'))).toMatchObject({ total: 0, didYouMean: null });
  });
});

describe('GET /store/v1/services?q=', () => {
  it('keeps its array shape and x-total-count, and takes the order from the engine', async () => {
    const res = await publicGet(t, '/store/v1/services?q=samsng');
    expect(res.statusCode).toBe(200);
    expect(res.headers['x-search-engine']).toBe('typesense');
    expect(res.headers['x-total-count']).toBe('2');
    const body = json<Array<{ slug: string }>>(res);
    expect(Array.isArray(body)).toBe(true);
    expect(body.map((card) => card.slug).sort()).toEqual(['samsung-frp-bypass', 'samsung-network-unlock']);
  });

  it('works over the best 1000 matches for a price sort and says so with x-search-truncated only when more matched', async () => {
    const res = await publicGet(t, '/store/v1/services?q=samsung&_sort=price&_order=desc');
    expect(res.headers['x-search-truncated']).toBeUndefined();
    expect(json<Array<{ slug: string }>>(res)).toHaveLength(2);
  });

  it('is the database list without q, and adds no header there', async () => {
    const plain = await publicGet(t, '/store/v1/services');
    expect(plain.headers['x-search-engine']).toBeUndefined();
    expect(plain.headers['x-total-count']).toBe('4');
  });

  it('accepts relevance as a sort and a NUL byte in q', async () => {
    expect((await publicGet(t, '/store/v1/services?q=samsung&_sort=relevance')).statusCode).toBe(200);
    expect((await publicGet(t, '/store/v1/services?q=sam%00sung')).statusCode).toBe(200);
  });
});

describe('the fallback', () => {
  const expectFallback = async (app: SearchTestApp, label: string) => {
    const suggest = await publicGet(app, '/store/v1/search/suggest?q=samsung');
    expect(suggest.statusCode, label).toBe(200);
    expect(suggest.headers['x-search-engine'], label).toBe('fallback');
    expect(json(suggest), label).toMatchObject({
      engine: 'fallback',
      ghost: null,
      services: [],
      filters: [],
      didYouMean: null,
    });
    const page = await publicGet(app, '/store/v1/search?q=samsung');
    expect(page.statusCode, label).toBe(200);
    expect(page.headers['x-search-engine'], label).toBe('fallback');
    const body = json(page);
    expect(body.facets, label).toBeNull();
    expect(body.hits.map((hit: { slug: string }) => hit.slug).sort(), label).toEqual([
      'samsung-frp-bypass',
      'samsung-network-unlock',
    ]);
    const list = await publicGet(app, '/store/v1/services?q=samsung');
    expect(list.headers['x-search-engine'], label).toBe('fallback');
    expect(json<unknown[]>(list), label).toHaveLength(2);
  };

  it('answers from Postgres when the engine port is closed', async () => {
    await expectFallback(await otherApp({ TYPESENSE_URL_TEST: 'http://127.0.0.1:1' }), 'closed port');
  });

  it('answers from Postgres when the engine refuses the key', async () => {
    const app = await otherApp({ TYPESENSE_SEARCH_KEY: 'a-key-the-node-does-not-know' });
    await expectFallback(app, '401');
    const metrics = app.app.get(SearchMetrics);
    const reasons = (await metrics.fallbacks.get()).values.map((value) => value.labels.reason);
    expect(reasons).toContain('error');
  });

  it('answers from Postgres when the index does not exist yet and counts not_ready', async () => {
    const app = await otherApp({});
    await expectFallback(app, 'missing alias');
    const reasons = (await app.app.get(SearchMetrics).fallbacks.get()).values.map((value) => value.labels.reason);
    expect(reasons).toContain('not_ready');
  });

  it('answers from Postgres when a sub-search fails inside a 200', async () => {
    // The terms alias is gone: the multi-search answers 200 with an error entry for it.
    const prefix = searchTestPrefix();
    const app = await otherApp({}, prefix);
    await buildIndex(app);
    await engineClient().deleteAlias(new SearchNames(prefix).alias('terms'));
    await expectFallback(app, 'sub-search error');
  });

  it('answers from Postgres when the engine answers something that is not a search result', async () => {
    const server = Bun.serve({
      port: 0,
      fetch: () => new Response('{"results": 5}', { headers: { 'content-type': 'application/json' } }),
    });
    try {
      await expectFallback(await otherApp({ TYPESENSE_URL_TEST: `http://127.0.0.1:${server.port}` }), 'malformed');
    } finally {
      await server.stop(true);
    }
  });

  it('runs no service query for a suggest fallback', async () => {
    const app = await otherApp({ TYPESENSE_URL_TEST: 'http://127.0.0.1:1' });
    await publicGet(app, '/store/v1/search/suggest?q=samsung');
    const spy = spyOn(app.app.get(DbService).pool, 'query');
    const res = await publicGet(app, '/store/v1/search/suggest?q=samsung%20frp');
    const text = spy.mock.calls
      .map((call) => (typeof call[0] === 'string' ? call[0] : (call[0] as { text: string }).text))
      .join('\n');
    spy.mockRestore();
    expect(json(res).engine).toBe('fallback');
    expect(text).not.toMatch(/"services"|"service_listings"|"service_group_prices"/);
  });

  it('is the database search with SEARCH_ENABLED=false and counts a disabled fallback', async () => {
    const app = await otherApp({ SEARCH_ENABLED_TEST: 'false' });
    await expectFallback(app, 'disabled');
    const reasons = (await app.app.get(SearchMetrics).fallbacks.get()).values.map((value) => value.labels.reason);
    expect(reasons).toContain('disabled');
  });
});

describe('the statistics', () => {
  let counters: Record<string, string>;
  const redis = () => t.app.get(RedisService).cache;
  const readDay = async () => redis().hgetall(t.app.get(CacheKeys).searchTermsDay(dayKey(clock.now())));
  const browser = 'Mozilla/5.0 (X11; Linux x86_64; rv:121.0) Gecko/20100101 Firefox/121.0';

  beforeEach(async () => {
    const keys = await redis().keys(`gsm:*:storefront:search-*:${dayKey(clock.now())}*`);
    if (keys.length > 0) await redis().del(...keys);
  });

  it('counts page 1 without filters once per search, with distinct visitors by a salted hash', async () => {
    await publicGet(t, '/store/v1/search?q=samsung%20frp', { 'user-agent': browser }, '203.0.113.10');
    await publicGet(t, '/store/v1/search?q=samsung%20frp', { 'user-agent': browser }, '203.0.113.11');
    await publicGet(t, '/store/v1/search?q=samsung%20frp', { 'user-agent': browser }, '203.0.113.11');
    counters = await readDay();
    expect(counters['s:samsung frp']).toBe('3');
    const keys = t.app.get(CacheKeys);
    const { createHash } = await import('node:crypto');
    const hll = await redis().pfcount(
      keys.searchVisitors(dayKey(clock.now()), createHash('sha1').update('samsung frp').digest('hex')),
    );
    expect(hll).toBe(2);
    const salt = await redis().get(keys.searchVisitorSalt(dayKey(clock.now())));
    expect(salt).toMatch(/^[0-9a-f]{64}$/);
    // No address is stored anywhere in what was counted.
    const everything = JSON.stringify([counters, await redis().keys(`gsm:*:storefront:search-*`)]);
    expect(everything).not.toContain('203.0.113');
  });

  it('counts a search that found nothing as a zero result', async () => {
    await publicGet(t, '/store/v1/search?q=blackberry', { 'user-agent': browser });
    counters = await readDay();
    expect(counters['s:blackberry']).toBe('1');
    expect(counters['z:blackberry']).toBe('1');
  });

  it('does not count filter clicks, later pages, prefetches, bots, suggest keystrokes or IMEI-like text', async () => {
    const headers = { 'user-agent': browser };
    await publicGet(t, '/store/v1/search?q=samsung&brand=Samsung', headers);
    await publicGet(t, '/store/v1/search?q=samsung&page=2&perPage=1', headers);
    await publicGet(t, '/store/v1/search?q=samsung', { ...headers, 'next-router-prefetch': '1' });
    await publicGet(t, '/store/v1/search?q=samsung', { ...headers, purpose: 'prefetch' });
    await publicGet(t, '/store/v1/search?q=samsung', { 'user-agent': 'Mozilla/5.0 (compatible; Googlebot/2.1)' });
    await publicGet(t, '/store/v1/search/suggest?q=samsung', headers);
    await publicGet(t, '/store/v1/search?q=356938035643809', headers);
    await publicGet(t, '/store/v1/search?q=me%40example.com', headers);
    await publicGet(t, '/store/v1/search?q=%2B962791234567', headers);
    await publicGet(t, '/store/v1/search?q=ord-2026-000123', headers);
    expect(await readDay()).toEqual({});
  });

  it('counts the services list with q too, and not a request the list refuses', async () => {
    await publicGet(t, '/store/v1/services?q=samsung%20frp', { 'user-agent': browser });
    // `locale` is an unknown parameter since decision 039: a 422 is never counted.
    const refused = await publicGet(t, '/store/v1/services?q=samsung&locale=tr', { 'user-agent': browser });
    expect(refused.statusCode).toBe(422);
    expect(Object.keys(await readDay())).toEqual(['s:samsung frp']);
  });

  it('flushes absolute values: running the flush twice gives the same rows', async () => {
    await publicGet(t, '/store/v1/search?q=samsung%20frp', { 'user-agent': browser }, '203.0.113.20');
    await publicGet(t, '/store/v1/search?q=blackberry', { 'user-agent': browser }, '203.0.113.20');
    const flush = t.app.get(SearchTermsFlush);
    await flush.flush();
    const first = await (await db()).select().from(s.searchTermsDaily).orderBy(s.searchTermsDaily.term);
    await flush.flush();
    const second = await (await db()).select().from(s.searchTermsDaily).orderBy(s.searchTermsDaily.term);
    expect(first.map((row) => [row.day, row.term, row.searches, row.zeroResults, row.visitors])).toEqual(
      second.map((row) => [row.day, row.term, row.searches, row.zeroResults, row.visitors]),
    );
    expect(first.map((row) => [row.term, row.searches, row.zeroResults, row.visitors])).toEqual([
      ['blackberry', 1, 1, 1],
      ['samsung frp', 1, 0, 1],
    ]);
    expect(dayOf(clock.now())).toBe(first[0]!.day);
    await t.app.get(SearchTermsFlushProcessor).process(job());
  });

  it('lists a term as popular only with 5 visitors on each of 3 days and only with words the catalog knows', async () => {
    const database = await db();
    const popular = async () => {
      await t.app.get(RedisService).cache.del(t.app.get(CacheKeys).searchPopular());
      return (json(await publicGet(t, '/store/v1/search/suggest?q=')).popular as string[]).slice();
    };
    await resetTerms(database);
    const rows = ['samsung frp', 'cheap unlock scam site'].flatMap((term) =>
      ['2026-11-12', '2026-11-13', '2026-11-14'].map((day) => ({
        day,
        term,
        searches: 6,
        zeroResults: 0,
        visitors: 5,
      })),
    );
    await database.insert(s.searchTermsDaily).values(rows);
    await t.app.get(SearchTermsBuildProcessor, { strict: false }).process(job());
    expect(await popular()).toEqual(['samsung frp']);
    // Fewer than 3 busy days, or a day under 5 visitors, or mostly no results: never popular (the categories stand in).
    await resetTerms(database);
    await database.insert(s.searchTermsDaily).values([
      { day: '2026-11-13', term: 'samsung frp', searches: 6, zeroResults: 0, visitors: 5 },
      { day: '2026-11-14', term: 'samsung frp', searches: 6, zeroResults: 0, visitors: 5 },
      { day: '2026-11-12', term: 'icloud', searches: 9, zeroResults: 0, visitors: 4 },
      { day: '2026-11-13', term: 'icloud', searches: 9, zeroResults: 0, visitors: 4 },
      { day: '2026-11-14', term: 'icloud', searches: 9, zeroResults: 0, visitors: 4 },
      ...['2026-11-12', '2026-11-13', '2026-11-14'].map((day) => ({
        day,
        term: 'samsung network',
        searches: 10,
        zeroResults: 6,
        visitors: 5,
      })),
    ]);
    const categories = await popular();
    expect(categories).not.toContain('samsung frp');
    expect(categories).not.toContain('icloud');
    expect(categories).not.toContain('samsung network');
    // Staff hide it: gone at once.
    await resetTerms(database);
    await database.insert(s.searchTermsDaily).values(
      ['2026-11-12', '2026-11-13', '2026-11-14'].map((day) => ({
        day,
        term: 'samsung frp',
        searches: 6,
        zeroResults: 0,
        visitors: 5,
      })),
    );
    expect(await popular()).toEqual(['samsung frp']);
    const owner = await adminWith(t, ['storefront:*']);
    const hidden = await owner.post('/admin/search/hidden-terms', { term: 'samsung frp' });
    expect(hidden.status).toBe(201);
    expect(await popular()).not.toContain('samsung frp');
    await owner.delete(`/admin/search/hidden-terms/${hidden.body.id}`);
    await resetTerms(database);
  });
});

async function resetTerms(database: Awaited<ReturnType<typeof db>>): Promise<void> {
  await database.delete(s.searchTermsDaily);
}

describe('the search-suggest limiter', () => {
  it('has its own budget of 1200 a minute per address, apart from the 300 of the other store routes', async () => {
    const app = await otherApp({ SEARCH_ENABLED_TEST: 'false' });
    // The counters outlive a run (60 s): start from none.
    const cache = app.app.get(RedisService).cache;
    const found = await cache.keys(`${app.app.get(CacheKeys).rateLimit('search-suggest')}:*`);
    if (found.length > 0) await cache.del(...found);
    const ip = '203.0.113.99';
    for (let sent = 0; sent < 1200; sent += 1) {
      const res = await publicGet(app, '/store/v1/search/suggest?q=a', {}, ip);
      if (res.statusCode !== 200) throw new Error(`request ${sent + 1} answered ${res.statusCode}`);
    }
    const refused = await publicGet(app, '/store/v1/search/suggest?q=a', {}, ip);
    expect(refused.statusCode).toBe(429);
    expect(refused.headers['retry-after']).toBeDefined();
    expect((await app.app.get(SearchMetrics).suggestLimited.get()).values[0]?.value ?? 0).toBe(1);
    // Another address is untouched, and the same address still has its own `ip` budget for the results page.
    expect((await publicGet(app, '/store/v1/search/suggest?q=a', {}, '203.0.113.98')).statusCode).toBe(200);
    expect((await publicGet(app, '/store/v1/search?q=a', {}, ip)).statusCode).toBe(200);
  }, 60_000);
});

describe('the console search tools', () => {
  beforeEach(async () => {
    await clearIdentityCaches(t);
    admin = await adminWith(t, ['storefront:*']);
  });

  it('creates, changes and deletes a synonym with an audit row and an event each, and refuses bad ones', async () => {
    const before = (await searchEvents()).length;
    const created = await admin.post('/admin/search/synonyms', {
      kind: 'multi',
      terms: ['  Rooting ', 'Magisk install'],
    });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({
      kind: 'multi',
      root: null,
      terms: ['rooting', 'magisk install'],
      isEnabled: true,
    });
    const id = created.body.id as number;
    const changed = await admin.patch(`/admin/search/synonyms/${id}`, { isEnabled: false, note: 'trial' });
    expect(changed.body).toMatchObject({ isEnabled: false, note: 'trial' });
    const listed = await admin.get('/admin/search/synonyms?q=magisk');
    expect(listed.total).toBe(1);
    expect((await admin.delete(`/admin/search/synonyms/${id}`)).status).toBe(204);
    expect((await admin.delete(`/admin/search/synonyms/${id}`)).status).toBe(404);
    expect((await admin.patch('/admin/search/synonyms/999999', { note: 'x' })).status).toBe(404);
    expect((await admin.post('/admin/search/synonyms', { kind: 'multi', terms: ['one'] })).status).toBe(422);
    expect((await admin.post('/admin/search/synonyms', { kind: 'one_way', terms: ['a b', 'c d'] })).status).toBe(422);
    expect((await admin.post('/admin/search/synonyms', { kind: 'multi', terms: ['a', 'A'] })).status).toBe(422);
    const events = (await searchEvents()).slice(before).filter((event) => event.type === 'search.settings_changed');
    expect(events.map((event) => event.payload.kind)).toEqual(['synonyms', 'synonyms', 'synonyms']);
    const audits = await (await db()).select().from(s.auditLogs).where(eq(s.auditLogs.entityType, 'search_synonym'));
    expect(audits.map((row) => row.action)).toEqual([
      'created search synonym',
      'changed search synonym',
      'deleted search synonym',
    ]);
  });

  it('creates pin rules with titles, refuses an unlisted service and a duplicate, and edits and deletes them', async () => {
    const created = await admin.post('/admin/search/pins', {
      query: '  Unlock ',
      match: 'exact',
      pinned: [{ serviceId: extra.frp, position: 1 }],
      hidden: [extra.network],
      note: 'push the FRP service',
    });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({
      query: 'unlock',
      match: 'exact',
      pinned: [{ serviceId: extra.frp, position: 1, title: 'Samsung FRP Bypass' }],
      hidden: [{ serviceId: extra.network, title: 'Samsung Network Unlock (SM-A525F)' }],
    });
    const id = created.body.id as number;
    const duplicate = await admin.post('/admin/search/pins', {
      query: 'unlock',
      match: 'exact',
      pinned: [],
      hidden: [],
    });
    expect(duplicate.status).toBe(409);
    expect(duplicate.body.code).toBe('CONFLICT');
    // The same query with the other match type is another rule.
    expect(
      (await admin.post('/admin/search/pins', { query: 'unlock', match: 'contains', pinned: [], hidden: [] })).status,
    ).toBe(201);
    const pinnedUnlisted = await admin.post('/admin/search/pins', {
      query: 'zircon',
      match: 'exact',
      pinned: [{ serviceId: extra.unlisted, position: 1 }],
      hidden: [],
    });
    expect(pinnedUnlisted.status).toBe(422);
    expect(pinnedUnlisted.body.errors[0].field).toBe('pinned.0.serviceId');
    const hiddenUnlisted = await admin.post('/admin/search/pins', {
      query: 'zircon',
      match: 'exact',
      pinned: [],
      hidden: [extra.unlisted],
    });
    expect(hiddenUnlisted.body.errors[0].field).toBe('hidden.0');
    expect(
      (
        await admin.post('/admin/search/pins', {
          query: 'x',
          match: 'exact',
          pinned: [{ serviceId: extra.frp, position: 11 }],
          hidden: [],
        })
      ).status,
    ).toBe(422);
    expect(
      (
        await admin.post('/admin/search/pins', {
          query: 'x',
          match: 'exact',
          pinned: [],
          hidden: [],
          startsAt: '2026-11-20T00:00:00.000Z',
          endsAt: '2026-11-19T00:00:00.000Z',
        })
      ).status,
    ).toBe(422);
    const changed = await admin.patch(`/admin/search/pins/${id}`, {
      isEnabled: false,
      endsAt: '2026-12-31T00:00:00.000Z',
    });
    expect(changed.body).toMatchObject({ isEnabled: false, endsAt: '2026-12-31T00:00:00.000Z' });
    expect((await admin.get('/admin/search/pins?q=unlock')).total).toBe(2);
    expect((await admin.delete(`/admin/search/pins/${id}`)).status).toBe(204);
    expect((await admin.patch(`/admin/search/pins/${id}`, { note: 'x' })).status).toBe(404);
    const audits = await (await db()).select().from(s.auditLogs).where(eq(s.auditLogs.entityType, 'search_pin'));
    expect(audits.length).toBeGreaterThanOrEqual(4);
  });

  it('hides a popular term, refuses it twice, lists it and shows it again', async () => {
    const hidden = await admin.post('/admin/search/hidden-terms', { term: '  Cheap  Phones ' });
    expect(hidden.status).toBe(201);
    expect(hidden.body).toMatchObject({ term: 'cheap phones' });
    expect((await admin.post('/admin/search/hidden-terms', { term: 'cheap phones' })).status).toBe(409);
    expect((await admin.get('/admin/search/hidden-terms')).total).toBe(1);
    expect((await admin.delete(`/admin/search/hidden-terms/${hidden.body.id}`)).status).toBe(204);
    expect((await admin.delete(`/admin/search/hidden-terms/${hidden.body.id}`)).status).toBe(404);
    expect((await admin.post('/admin/search/hidden-terms', { term: '   ' })).status).toBe(422);
  });

  it('reports the top terms and the terms that found nothing over 7, 30 or 90 days', async () => {
    const database = await db();
    await resetTerms(database);
    await database.insert(s.searchTermsDaily).values([
      { day: '2026-11-15', term: 'samsung frp', searches: 40, zeroResults: 0, visitors: 31 },
      { day: '2026-11-16', term: 'samsung frp', searches: 10, zeroResults: 0, visitors: 8 },
      { day: '2026-11-15', term: 'blackberry', searches: 4, zeroResults: 4, visitors: 3 },
      { day: '2026-09-01', term: 'old term', searches: 99, zeroResults: 99, visitors: 50 },
    ]);
    const report = await admin.get('/admin/search/report?days=30');
    expect(report.status).toBe(200);
    expect(report.body).toMatchObject({
      days: 30,
      totals: { searches: 54, zeroResults: 4, terms: 2 },
      topTerms: [
        { term: 'samsung frp', searches: 50, visitors: 39, zeroResults: 0 },
        { term: 'blackberry', searches: 4, visitors: 3, zeroResults: 4 },
      ],
      zeroResultTerms: [{ term: 'blackberry', searches: 4, lastSeen: '2026-11-15T00:00:00.000Z' }],
    });
    expect((await admin.get('/admin/search/report?days=90')).body.totals.terms).toBe(3);
    expect((await admin.get('/admin/search/report?days=5')).status).toBe(422);
    await resetTerms(database);
  });

  it('previews a query with the pins applied and marks the hidden services', async () => {
    const pin = await admin.post('/admin/search/pins', {
      query: 'samsung',
      match: 'exact',
      pinned: [{ serviceId: extra.network, position: 1 }],
      hidden: [extra.frp],
    });
    expect(pin.status).toBe(201);
    // The worker pushes the set after the settings event: run its job as the relay would.
    const { runSearchOutbox } = await import('../support/search');
    await runSearchOutbox(t);
    const preview = await admin.get('/admin/search/preview?q=samsung');
    expect(preview.status).toBe(200);
    expect(preview.body.engine).toBe('typesense');
    expect(preview.body.hits[0]).toMatchObject({ serviceId: extra.network, position: 1, pinned: true });
    expect(preview.body.hiddenIds).toEqual([extra.frp]);
    expect(preview.body.hits.map((hit: { serviceId: number }) => hit.serviceId)).not.toContain(extra.frp);
    await admin.delete(`/admin/search/pins/${pin.body.id}`);
    await runSearchOutbox(t);
  });

  it('reads the index status', async () => {
    const status = await admin.get('/admin/search/index');
    expect(status.status).toBe(200);
    expect(status.body).toMatchObject({
      engine: { status: 'ok' },
      schemaVersion: 1,
      documents: 4,
      expectedDocuments: 4,
      rebuild: { running: false, startedAt: null },
    });
    // The state row is the database's, written by the last rebuild of any app of this run.
    expect(status.body.collection).toMatch(/_services_v1_\d{14}$/);
  });

  it('asks for a rebuild once at a time and only with storefront:publish', async () => {
    const reader = await adminWith(t, ['storefront:read', 'storefront:update']);
    expect((await reader.post('/admin/search/index/rebuild')).status).toBe(403);
    const first = await admin.post('/admin/search/index/rebuild');
    expect(first.status).toBe(202);
    expect(first.body.running).toBe(true);
    const second = await admin.post('/admin/search/index/rebuild');
    expect(second.status).toBe(409);
    expect(second.body.code).toBe('JOB_ALREADY_RUNNING');
    const status = await admin.get('/admin/search/index');
    expect(status.body.rebuild.running).toBe(true);
    const events = await (
      await db()
    )
      .select()
      .from(s.outboxEvents)
      .where(eq(s.outboxEvents.type, 'search.rebuild_requested'));
    expect(events).toHaveLength(1);
    const audits = await (await db()).select().from(s.auditLogs).where(eq(s.auditLogs.entityType, 'search_index'));
    expect(audits).toHaveLength(1);
    await (await db()).update(s.jobRuns).set({ status: 'succeeded' }).where(eq(s.jobRuns.status, 'running'));
  });

  it('refuses a rebuild with 503 when search is switched off', async () => {
    const app = await otherApp({ SEARCH_ENABLED_TEST: 'false' });
    const owner = await adminWith(app, ['storefront:*']);
    const res = await owner.post('/admin/search/index/rebuild');
    expect(res.status).toBe(503);
    expect(res.body.code).toBe('UNAVAILABLE');
    expect((await owner.get('/admin/search/index')).body.engine.status).toBe('disabled');
    expect((await owner.get('/admin/search/preview?q=samsung')).status).toBe(503);
  });

  it('needs the permissions: read for the reads, update for the writes, none for a signed-out caller', async () => {
    const reader = await adminWith(t, ['storefront:read']);
    for (const url of ['synonyms', 'pins', 'hidden-terms', 'report', 'preview?q=a', 'index']) {
      expect((await reader.get(`/admin/search/${url}`)).status, url).toBe(200);
    }
    expect((await reader.post('/admin/search/synonyms', { kind: 'multi', terms: ['a b', 'c d'] })).status).toBe(403);
    expect((await reader.post('/admin/search/hidden-terms', { term: 'x y' })).status).toBe(403);
    expect((await admin.anonymous('GET', '/admin/search/synonyms')).status).toBe(401);
    const none = await adminWith(t, ['catalog:read']);
    expect((await none.get('/admin/search/synonyms')).status).toBe(403);
  });
});

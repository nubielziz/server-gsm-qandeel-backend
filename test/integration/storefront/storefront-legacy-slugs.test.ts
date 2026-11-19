// Integration tests of GET /store/v1/legacy-slugs/:kind/:slug (feature 30, English only, decision 039, plan section 4.5): where an
// old address of a service, page or help article that existed only in another language leads now. A service leads to its page when
// that page answers (the rule of GET /store/v1/services/:slug), else to the list; a page to the home page; a help article to the help
// centre. Public, on the store's `ip` limiter, with the cache headers of GET /store/v1/pages/:slug.
import { afterAll, beforeAll, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import { eq } from 'drizzle-orm';
import { schema as s } from '@src/infra/db';
import { RateLimitService } from '@src/infra/rate-limit';
import { type TestApp, createTestApp } from '../../support/app';
import { insertService } from '../../support/catalog';
import { TestClock } from '../../support/clock';
import { closeTestDb, resetDb, testDb } from '../../support/db';
import { freshClientIp } from '../../support/pipeline-routes';
import { type StorefrontWorld, storefrontWorld } from '../../support/storefront';

const clock = new TestClock('2026-11-16T12:00:00.000Z');
let t: TestApp;
let world: StorefrontWorld;

beforeAll(async () => {
  t = await createTestApp({ clock });
});
beforeEach(async () => {
  await resetDb();
  world = await storefrontWorld((await testDb()).db);
});
afterAll(async () => {
  await resetDb();
  await t.close();
  await closeTestDb();
});

const get = (url: string) => t.app.inject({ method: 'GET', url, remoteAddress: freshClientIp() });
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- test bodies are untyped JSON
const body = (res: { json: () => any }): any => res.json();

/** Remembers an old address, as migration 0035 does. */
async function remember(kind: 'service' | 'page' | 'help', slug: string, serviceId: number | null = null) {
  await (await testDb()).db.insert(s.legacySlugs).values({ kind, slug, serviceId });
}

describe('GET /store/v1/legacy-slugs/:kind/:slug', () => {
  it('sends an old service address to the page of the same service while it is on sale, with the cache headers of a page', async () => {
    await remember('service', 'old-icloud-check', world.icloud.serviceId);
    const res = await get('/store/v1/legacy-slugs/service/old-icloud-check');
    expect(res.statusCode).toBe(200);
    expect(body(res)).toEqual({ path: `/services/${world.icloud.slug}`, slug: world.icloud.slug });
    // The page route sends no cache header of its own; this route answers the same way.
    const page = await get('/store/v1/pages/terms');
    expect(page.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe(page.headers['cache-control']);
    // The path carries no language prefix and follows the slug staff give the page now.
    await (
      await testDb()
    ).db
      .update(s.serviceListings)
      .set({ slug: 'icloud-check' })
      .where(eq(s.serviceListings.id, world.icloud.listingId));
    expect(body(await get('/store/v1/legacy-slugs/service/old-icloud-check'))).toEqual({
      path: '/services/icloud-check',
      slug: 'icloud-check',
    });
  });

  it('sends it to the list when the page of the service is switched off, or the service cannot be sold or has no price', async () => {
    const { db } = await testDb();
    await remember('service', 'old-icloud', world.icloud.serviceId);
    await remember('service', 'old-att', world.att.serviceId);
    const list = { path: '/services', slug: null };

    await db.update(s.serviceListings).set({ isListed: false }).where(eq(s.serviceListings.id, world.icloud.listingId));
    expect(body(await get('/store/v1/legacy-slugs/service/old-icloud'))).toEqual(list);
    // The service page itself agrees: it is not on sale.
    expect((await get(`/store/v1/services/${world.icloud.slug}`)).statusCode).toBe(404);

    await db.update(s.services).set({ status: 'disabled' }).where(eq(s.services.id, world.att.serviceId));
    expect(body(await get('/store/v1/legacy-slugs/service/old-att'))).toEqual(list);
    await db.update(s.services).set({ status: 'active' }).where(eq(s.services.id, world.att.serviceId));
    expect(body(await get('/store/v1/legacy-slugs/service/old-att')).slug).toBe(world.att.slug);
    await db.delete(s.serviceGroupPrices).where(eq(s.serviceGroupPrices.serviceId, world.att.serviceId));
    expect(body(await get('/store/v1/legacy-slugs/service/old-att'))).toEqual(list);
    expect((await get(`/store/v1/services/${world.att.slug}`)).statusCode).toBe(404);
  });

  it('sends an old service address with no service, or whose service has no page, to the list', async () => {
    await remember('service', 'no-service');
    const bare = await insertService((await testDb()).db, world.icloud.categoryId, { name: 'Without a page' });
    await remember('service', 'no-page', bare);
    expect(body(await get('/store/v1/legacy-slugs/service/no-service'))).toEqual({ path: '/services', slug: null });
    expect(body(await get('/store/v1/legacy-slugs/service/no-page'))).toEqual({ path: '/services', slug: null });
  });

  it('forgets the address of a deleted service (404): an old address never keeps a service from being deleted', async () => {
    const { db } = await testDb();
    const bare = await insertService(db, world.icloud.categoryId, { name: 'To delete' });
    await remember('service', 'old-gone', bare);
    expect((await get('/store/v1/legacy-slugs/service/old-gone')).statusCode).toBe(200);
    await db.delete(s.services).where(eq(s.services.id, bare));
    const res = await get('/store/v1/legacy-slugs/service/old-gone');
    expect(res.statusCode).toBe(404);
    expect(body(res).code).toBe('NOT_FOUND');
  });

  it('sends an old page to the home page and an old help article to the help centre (only the id that starts it counts)', async () => {
    await remember('page', 'old-about');
    await remember('help', '12');
    expect(body(await get('/store/v1/legacy-slugs/page/old-about'))).toEqual({ path: '/', slug: null });
    expect(body(await get('/store/v1/legacy-slugs/help/12'))).toEqual({ path: '/help', slug: null });
    expect(body(await get('/store/v1/legacy-slugs/help/12-how-do-i-find-my-imei'))).toEqual({
      path: '/help',
      slug: null,
    });
    // A help slug that does not start with an id, another id, and the same slug under another kind are not old addresses.
    expect((await get('/store/v1/legacy-slugs/help/how-12')).statusCode).toBe(404);
    expect((await get('/store/v1/legacy-slugs/help/13')).statusCode).toBe(404);
    expect((await get('/store/v1/legacy-slugs/service/old-about')).statusCode).toBe(404);
    expect((await get('/store/v1/legacy-slugs/page/12')).statusCode).toBe(404);
  });

  it('answers 404 for an address that was never retired', async () => {
    const res = await get('/store/v1/legacy-slugs/service/never-was');
    expect(res.statusCode).toBe(404);
    expect(body(res)).toMatchObject({ code: 'NOT_FOUND', status: 404 });
  });

  it('answers 422 for an unknown kind and for any query parameter', async () => {
    await remember('service', 'old-icloud', world.icloud.serviceId);
    const kind = await get('/store/v1/legacy-slugs/blog/old-icloud');
    expect(kind.statusCode).toBe(422);
    expect(body(kind).errors[0]).toMatchObject({ field: 'kind' });
    for (const query of ['locale=en', 'buyerCountry=GB']) {
      const res = await get(`/store/v1/legacy-slugs/service/old-icloud?${query}`);
      expect(res.statusCode, query).toBe(422);
      expect(body(res).code, query).toBe('VALIDATION_FAILED');
    }
  });

  it('is public and counted against the per-IP limiter of the store', async () => {
    await remember('page', 'old-about');
    const enforce = spyOn(t.app.get(RateLimitService), 'enforce');
    try {
      expect((await get('/store/v1/legacy-slugs/page/old-about')).statusCode).toBe(200);
      expect(enforce.mock.calls.map((call) => call[0])).toEqual(['ip']);
    } finally {
      enforce.mockRestore();
    }
  });
});

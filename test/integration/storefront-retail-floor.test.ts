// The one retail floor (RESOLUTIONS b2c-7, catalog-12): the console's listing admin, the public list, the service page and the
// checkout all take the floor from catalog's RetailPrices, so a retail price under `max(base x 1.10, cost + minimum profit)` is
// sold at that floor everywhere and the console shows the same figure.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { eq } from 'drizzle-orm';
import { schema as s } from '../../src/infra/db';
import { type AdminApi, adminWith } from '../support/admin-api';
import { type TestApp, createTestApp } from '../support/app';
import { clearIdentityCaches } from '../support/auth';
import { TestClock } from '../support/clock';
import { closeTestDb, resetDb, testDb } from '../support/db';
import { freshClientIp } from '../support/pipeline-routes';
import { APPLE_IMEI, TURNSTILE_HEADERS, storefrontWorld } from '../support/storefront';

const clock = new TestClock('2026-11-07T12:00:00.000Z');
let t: TestApp;
let admin: AdminApi;

beforeAll(async () => {
  t = await createTestApp({ clock });
});
beforeEach(async () => {
  clock.set('2026-11-07T12:00:00.000Z');
  await resetDb();
  await clearIdentityCaches(t);
  admin = await adminWith(t, ['storefront:*']);
});
afterAll(async () => {
  await resetDb();
  await clearIdentityCaches(t);
  await t.close();
  await closeTestDb();
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- test bodies are untyped JSON
const body = (res: { json: () => any }): any => res.json();
const get = (url: string) => t.app.inject({ method: 'GET', url, remoteAddress: freshClientIp() });
const openCheckout = (serviceId: number) =>
  t.app.inject({
    method: 'POST',
    url: '/store/v1/checkout-sessions',
    headers: { 'user-agent': 'Mozilla/5.0 (test)', ...TURNSTILE_HEADERS },
    remoteAddress: freshClientIp(),
    payload: { serviceId, email: 'sam@mail.example', country: 'GB', currency: 'GBP', imei: APPLE_IMEI },
  });

describe('the retail floor', () => {
  it('sells a retail price between cost plus minimum profit and the storefront floor at the storefront floor, in the console, the list, the page and the checkout alike', async () => {
    const { db } = await testDb();
    const world = await storefrontWorld(db);
    // AT&T: base 17.28, cost 13.50 + minimum profit 0.81 = 14.31, base x 1.10 = 19.01. A stored 16.00 is above the first floor
    // and under the second (an old price, or a cost rise after the price was set).
    await db
      .update(s.serviceGroupPrices)
      .set({ price: '16.0000' })
      .where(eq(s.serviceGroupPrices.serviceId, world.att.serviceId));

    // The console shows the floor the shop sells at (and still the price staff stored).
    const listing = await admin.get(`/admin/service-listings/${world.att.listingId}`);
    expect(listing.body).toMatchObject({ retailPrice: '16.0000', floorPrice: '19.0100' });

    const list = body(await get('/store/v1/services?q=AT%26T'));
    expect(list[0].price.net).toBe(listing.body.floorPrice);
    const page = body(await get(`/store/v1/services/${world.att.slug}`));
    expect(page.price.net).toBe(listing.body.floorPrice);

    const opened = await openCheckout(world.att.serviceId);
    expect(opened.statusCode).toBe(201);
    expect(body(opened).amounts.usd.net).toBe(listing.body.floorPrice);
  });

  it('keeps a retail price above the floor as staff set it, and the console refuses a price under the floor it shows', async () => {
    const { db } = await testDb();
    const world = await storefrontWorld(db);
    const refused = await admin.patch(`/admin/service-listings/${world.att.listingId}`, { retailPrice: '16.0000' });
    expect(refused.status).toBe(422);
    expect(refused.body.errors[0]).toMatchObject({ field: 'retailPrice', code: 'below_floor' });
    expect(refused.body.errors[0].message).toContain('$19.01');

    // Exactly the floor is accepted and sold; a higher price is sold as set.
    expect(
      (await admin.patch(`/admin/service-listings/${world.att.listingId}`, { retailPrice: '19.0100' })).status,
    ).toBe(200);
    expect(body(await get(`/store/v1/services/${world.att.slug}`)).price.net).toBe('19.0100');
    expect(
      (await admin.patch(`/admin/service-listings/${world.att.listingId}`, { retailPrice: '30.0000' })).status,
    ).toBe(200);
    expect(body(await get(`/store/v1/services/${world.att.slug}`)).price.net).toBe('30.0000');
    expect(body(await openCheckout(world.att.serviceId)).amounts.usd.net).toBe('30.0000');
  });

  it('follows a cost rise: when cost plus minimum profit passes base x 1.10 the console and the shop use the larger floor', async () => {
    const { db } = await testDb();
    const world = await storefrontWorld(db);
    // Effective cost 19.00 + minimum profit 0.81 = 19.81 is now above base x 1.10 = 19.01, so it is the larger floor.
    await db
      .update(s.services)
      .set({ cost: '19.0000', effectiveCost: '19.0000' })
      .where(eq(s.services.id, world.att.serviceId));
    const listing = await admin.get(`/admin/service-listings/${world.att.listingId}`);
    expect(listing.body.floorPrice).toBe('19.8100');
    // The stored price 25.99 is above both floors and stays; a stored price under the new floor is lifted to it.
    expect(body(await get(`/store/v1/services/${world.att.slug}`)).price.net).toBe('25.9900');
    await db
      .update(s.serviceGroupPrices)
      .set({ price: '19.2000' })
      .where(eq(s.serviceGroupPrices.serviceId, world.att.serviceId));
    expect(body(await get(`/store/v1/services/${world.att.slug}`)).price.net).toBe(listing.body.floorPrice);
    expect(body(await openCheckout(world.att.serviceId)).amounts.usd.net).toBe(listing.body.floorPrice);
  });
});

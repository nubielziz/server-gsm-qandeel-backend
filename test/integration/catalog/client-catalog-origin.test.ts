// Integration tests of the origin rules of the merchant catalog reads (decision 045): GET /client/services, GET /client/services/:id and
// GET /client/prices/export record the prices they show as the merchant's listed prices. The two reads are called by the portal's
// own server as well as by its pages, so they refuse a request that the browser marks as started by another site; the export is
// downloaded by the browser, so it answers only a request that the portal itself started. The merchant's API key surface is
// another rule and is not affected.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { Money } from '@src/common/money';
import { schema as s } from '@src/infra/db';
import { ListedPrices, checkPriceChange } from '@src/modules/catalog';
import {
  NOT_STARTED_HERE_DETAIL,
  ORIGIN_MISSING_DETAIL,
  ORIGIN_NOT_ALLOWED_DETAIL,
} from '@src/modules/identity/security/origin-checks';
import { type TestApp, createTestApp } from '../../support/app';
import { clearIdentityCaches, openSession } from '../../support/auth';
import { closeTestDb, resetDb, testDb } from '../../support/db';
import { body, clearApiKeyCaches, credentialsFor, v1Client } from '../../support/machine-orders';
import { PORTAL_ORIGIN } from '../../support/merchant-portal';
import { insertAtt, insertClientPriceRow, insertDemoGroups, insertMerchantIn } from '../../support/pricing';
import { CONSOLE_ORIGIN } from '../../support/staff-console';

let t: TestApp;

beforeAll(async () => {
  t = await createTestApp({ env: { CONSOLE_ORIGINS: CONSOLE_ORIGIN, SHOP_ORIGINS: PORTAL_ORIGIN } });
});
beforeEach(async () => {
  await resetDb();
  await clearIdentityCaches(t);
  await clearApiKeyCaches(t);
});
afterAll(async () => {
  await resetDb();
  await clearIdentityCaches(t);
  await clearApiKeyCaches(t);
  await t.close();
  await closeTestDb();
});

/** What the portal's own server sends when it reads the API for a page: the cookie and plain fetch headers, no Sec-Fetch-Site, no Origin. */
const PORTAL_SERVER_HEADERS = {
  accept: 'application/json',
  'x-forwarded-for': '203.0.113.7',
  'accept-language': '*',
  'sec-fetch-mode': 'cors',
  'user-agent': 'node',
};
/** A page of another site navigating the browser to the URL. */
const CROSS_SITE_NAVIGATION = {
  'sec-fetch-site': 'cross-site',
  'sec-fetch-mode': 'navigate',
  'sec-fetch-dest': 'document',
};

/** A standard merchant with a signed-in session and one listed service. */
async function world() {
  const { db } = await testDb();
  const groups = await insertDemoGroups(db);
  const { serviceId } = await insertAtt(db);
  const merchant = await insertMerchantIn(db, groups.standard);
  const session = await openSession(t, { type: 'client', id: merchant });
  const get = (url: string, extra: Record<string, string> = {}) =>
    t.app.inject({ method: 'GET', url, headers: { ...session.headers, ...extra } });
  return { db, serviceId, merchant, get };
}

const listedRows = async () => (await testDb()).db.select().from(s.listedPrices);

describe('the portal list and show reads', () => {
  it("answer the portal's own server calls and record the listed price", async () => {
    const { serviceId, get } = await world();
    expect((await get('/client/services', PORTAL_SERVER_HEADERS)).statusCode).toBe(200);
    const listedByList = await listedRows();
    expect(listedByList.map((row) => row.serviceId)).toEqual([serviceId]);

    await (await testDb()).db.delete(s.listedPrices);
    const show = await get(`/client/services/${serviceId}`, PORTAL_SERVER_HEADERS);
    expect(show.statusCode).toBe(200);
    expect(show.json().id).toBe(serviceId);
    expect((await listedRows()).map((row) => row.serviceId)).toEqual([serviceId]);
  });

  it("answer a request that the browser marks as the portal's own, typed by the user, or sent by a page of the shop", async () => {
    const { serviceId, get } = await world();
    for (const url of ['/client/services', `/client/services/${serviceId}`]) {
      const requests: Record<string, string>[] = [
        { 'sec-fetch-site': 'same-origin' },
        { 'sec-fetch-site': 'none', 'sec-fetch-mode': 'navigate' },
        { 'sec-fetch-site': 'cross-site', origin: PORTAL_ORIGIN },
        { 'sec-fetch-site': 'same-site', origin: PORTAL_ORIGIN },
      ];
      for (const headers of requests) {
        expect((await get(url, headers)).statusCode, `${url} ${JSON.stringify(headers)}`).toBe(200);
      }
    }
    expect(await listedRows()).toHaveLength(1);
  });

  it('refuse a request that the browser marks as started by another site and write no listed price', async () => {
    const { serviceId, get } = await world();
    for (const url of ['/client/services', `/client/services/${serviceId}`]) {
      const navigation = await get(url, CROSS_SITE_NAVIGATION);
      expect(navigation.statusCode, url).toBe(403);
      expect(navigation.json(), url).toMatchObject({ code: 'CSRF_FAILED', detail: NOT_STARTED_HERE_DETAIL });

      const sameSite = await get(url, { 'sec-fetch-site': 'same-site', 'sec-fetch-mode': 'navigate' });
      expect(sameSite.statusCode, url).toBe(403);
      expect(sameSite.json(), url).toMatchObject({ code: 'CSRF_FAILED', detail: NOT_STARTED_HERE_DETAIL });

      const otherAudience = await get(url, { 'sec-fetch-site': 'cross-site', origin: CONSOLE_ORIGIN });
      expect(otherAudience.statusCode, url).toBe(403);
      expect(otherAudience.json(), url).toMatchObject({ code: 'CSRF_FAILED', detail: NOT_STARTED_HERE_DETAIL });
    }
    expect(await listedRows()).toHaveLength(0);
  });
});

describe('the portal price export', () => {
  it('answers only a request that the portal itself started, and writes no listed price for any other', async () => {
    const { get } = await world();
    const url = '/client/prices/export';
    const bare = await get(url);
    expect(bare.statusCode).toBe(403);
    expect(bare.json()).toMatchObject({ code: 'CSRF_FAILED', detail: ORIGIN_MISSING_DETAIL });

    const serverCall = await get(url, PORTAL_SERVER_HEADERS);
    expect(serverCall.statusCode).toBe(403);
    expect(serverCall.json()).toMatchObject({ code: 'CSRF_FAILED', detail: ORIGIN_MISSING_DETAIL });

    const navigation = await get(url, CROSS_SITE_NAVIGATION);
    expect(navigation.statusCode).toBe(403);
    expect(navigation.json()).toMatchObject({ code: 'CSRF_FAILED', detail: NOT_STARTED_HERE_DETAIL });

    expect((await get(url, { 'sec-fetch-site': 'same-site' })).statusCode).toBe(403);
    expect((await get(url, { 'sec-fetch-site': 'none' })).statusCode).toBe(403);

    const otherAudience = await get(url, { 'sec-fetch-site': 'cross-site', origin: CONSOLE_ORIGIN });
    expect(otherAudience.statusCode).toBe(403);
    expect(otherAudience.json()).toMatchObject({ code: 'CSRF_FAILED', detail: ORIGIN_NOT_ALLOWED_DETAIL });
    expect(await listedRows()).toHaveLength(0);

    expect((await get(url, { 'sec-fetch-site': 'same-origin' })).statusCode).toBe(200);
    expect(await listedRows()).toHaveLength(1);
    expect((await get(url, { 'sec-fetch-site': 'cross-site', origin: PORTAL_ORIGIN })).statusCode).toBe(200);
  });
});

describe('the listed price a merchant was shown', () => {
  it('is kept when a page of another site navigates the browser to a catalog route', async () => {
    const { db, serviceId, merchant, get } = await world();
    const listed = t.app.get(ListedPrices);
    expect((await get('/client/services', PORTAL_SERVER_HEADERS)).statusCode).toBe(200);
    expect((await listed.find(db, merchant, serviceId))!.price.toWire()).toBe('17.2800');

    await insertClientPriceRow(db, serviceId, merchant, '27.6500');
    for (const url of ['/client/prices/export', '/client/services', `/client/services/${serviceId}`]) {
      expect((await get(url, CROSS_SITE_NAVIGATION)).statusCode, url).toBe(403);
    }
    const shown = (await listed.find(db, merchant, serviceId))!;
    expect(shown.price.toWire()).toBe('17.2800');
    expect(checkPriceChange(shown.price, Money.of('27.6500'), 10).outcome).toBe('refuse');

    // The portal's own request shows the new price and records it.
    expect((await get('/client/services', PORTAL_SERVER_HEADERS)).statusCode).toBe(200);
    expect((await listed.find(db, merchant, serviceId))!.price.toWire()).toBe('27.6500');
  });
});

describe('the merchant API key surface', () => {
  it('lists and shows services without any browser header and still records the listed prices', async () => {
    const { db, serviceId, merchant } = await world();
    const v1 = v1Client(t, (await credentialsFor(t, db, merchant)).key);
    expect((await v1.get('/v1/services')).statusCode).toBe(200);
    expect(body(await v1.get(`/v1/services/${serviceId}`)).id).toBe(serviceId);
    expect((await listedRows()).map((row) => [row.clientId, row.serviceId])).toEqual([[merchant, serviceId]]);
  });
});

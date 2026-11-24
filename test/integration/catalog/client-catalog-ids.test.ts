// Integration tests of the `ids` parameter of GET /client/services (decision 066): the shop reads the merchant's own prices of the services
// visible on a page in one call. The rows are the rows of the list; an id the merchant may not see is absent; the listed prices are
// remembered exactly as the list remembers them (price protection, user rule 9); the list without `ids` is what it was.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { schema as s } from '@src/infra/db';
import { makeAccount } from '../../support/accounts';
import { openAccountSession } from '../../support/account-sessions';
import { type TestApp, createTestApp } from '../../support/app';
import { clearIdentityCaches, openSession } from '../../support/auth';
import { insertCategory, insertService } from '../../support/catalog';
import { MINUTE, TestClock } from '../../support/clock';
import { closeTestDb, resetDb, testDb } from '../../support/db';
import { insertAtt, insertClientPriceRow, insertDemoGroups, insertMerchantIn } from '../../support/pricing';

const clock = new TestClock('2026-11-07T12:00:00.000Z');
let t: TestApp;

beforeAll(async () => {
  t = await createTestApp({ clock });
});
beforeEach(async () => {
  clock.set('2026-11-07T12:00:00.000Z');
  await resetDb();
  await clearIdentityCaches(t);
});
afterAll(async () => {
  await resetDb();
  await clearIdentityCaches(t);
  await t.close();
  await closeTestDb();
});

const listedRows = async () =>
  (await testDb()).db.select().from(s.listedPrices).orderBy(s.listedPrices.clientId, s.listedPrices.serviceId);

type Row = { id: number; code: string; price: string };

/** A standard merchant, the AT&T unlock (17.28 for it) and an iCloud check (0.13), in two categories. */
async function world() {
  const { db } = await testDb();
  const groups = await insertDemoGroups(db);
  const { categoryId, serviceId } = await insertAtt(db, { deliveryTime: '1 day' });
  const apple = await insertCategory(db, { name: 'Apple' });
  const icloud = await insertService(db, apple, {
    name: 'iCloud Clean / Lost Check',
    code: 'IMEI-ICL-CHK',
    cost: '0.0800',
    effectiveCost: '0.0800',
    basePrice: '0.1300',
    minProfit: null,
    slaMinutes: 2,
  });
  const erbil = await insertMerchantIn(db, groups.standard, { name: 'Erbil' });
  const session = await openSession(t, { type: 'account', id: erbil });
  const get = (url: string, headers: Record<string, string> = {}) =>
    t.app.inject({ method: 'GET', url, headers: { ...session.headers, ...headers } });
  return { db, groups, categoryId, serviceId, apple, icloud, erbil, get };
}

describe('GET /client/services?ids=', () => {
  it('answers only the named services, in the row shape and the order of the list, with the merchant price', async () => {
    const { get, serviceId, icloud, categoryId, apple, db, erbil } = await world();
    await insertClientPriceRow(db, serviceId, erbil, '15.2000');
    const third = await insertService(db, categoryId, {
      name: 'Zeta',
      code: 'ZETA',
      basePrice: '9.0000',
      cost: '1',
      effectiveCost: '1',
    });

    const res = await get(`/client/services?ids=${icloud},${serviceId}`);
    expect(res.statusCode).toBe(200);
    expect(res.headers['x-total-count']).toBe('2');
    // The default order of the list: category order, then name; the order of the ids does not matter.
    expect(res.json()).toEqual([
      {
        id: serviceId,
        name: 'AT&T USA Premier Unlock',
        code: 'IMEI-ATT-USA',
        type: 'imei',
        category: { id: categoryId, name: 'Carrier unlock' },
        price: '15.2000',
        currency: 'USD',
        deliveryTime: '1 day',
        slaMinutes: 1440,
        info: '',
        minQty: 1,
        maxQty: 1,
        qtyOptions: [],
      },
      {
        id: icloud,
        name: 'iCloud Clean / Lost Check',
        code: 'IMEI-ICL-CHK',
        type: 'imei',
        category: { id: apple, name: 'Apple' },
        price: '0.1300',
        currency: 'USD',
        deliveryTime: '',
        slaMinutes: 2,
        info: '',
        minQty: 1,
        maxQty: 1,
        qtyOptions: [],
      },
    ]);

    const one = await get(`/client/services?ids=${third}`);
    expect(one.json().map((row: Row) => row.code)).toEqual(['ZETA']);
    expect(one.headers['x-total-count']).toBe('1');
    // The same rows as the list gives for them.
    const all = (await get('/client/services')).json<Row[]>();
    expect(all.find((row) => row.id === third)).toEqual(one.json()[0]);
  });

  it('counts a repeated id once and accepts a single id', async () => {
    const { get, serviceId } = await world();
    const res = await get(`/client/services?ids=${serviceId},${serviceId}`);
    expect(res.statusCode).toBe(200);
    expect(res.json().map((row: Row) => row.id)).toEqual([serviceId]);
    expect(res.headers['x-total-count']).toBe('1');
  });

  it('leaves an id that is unknown, archived, off, in a category that is off or in a category closed to the group out of the answer and the total', async () => {
    const { db, groups, get, serviceId, categoryId } = await world();
    const off = await insertService(db, categoryId, { code: 'OFF', status: 'disabled' });
    const gone = await insertService(db, categoryId, { code: 'GONE', status: 'disabled', archivedAt: new Date() });
    const hiddenCategory = await insertCategory(db, { name: 'Hidden', isActive: false });
    const inHiddenCategory = await insertService(db, hiddenCategory, { code: 'HID' });
    const vipOnly = await insertCategory(db, { name: 'VIP only', allowedGroupIds: [groups.vip] });
    const vipService = await insertService(db, vipOnly, { code: 'VIPSVC' });

    const ids = [serviceId, 424242, off, gone, inHiddenCategory, vipService];
    const res = await get(`/client/services?ids=${ids.join(',')}`);
    expect(res.statusCode).toBe(200);
    expect(res.json().map((row: Row) => row.id)).toEqual([serviceId]);
    expect(res.headers['x-total-count']).toBe('1');

    const none = await get(`/client/services?ids=${[424242, off, gone, vipService].join(',')}`);
    expect(none.statusCode).toBe(200);
    expect(none.json()).toEqual([]);
    expect(none.headers['x-total-count']).toBe('0');
  });

  it('combines with the filters, the search, the sort and the page range of the list', async () => {
    const { db, get, serviceId, icloud } = await world();
    const credits = await insertCategory(db, { name: 'Credits', type: 'server' });
    const z3x = await insertService(db, credits, { type: 'server', code: 'Z3X', name: 'Z3X Credits' });
    const ids = `${serviceId},${icloud},${z3x}`;
    const codes = async (query: string) =>
      (await get(`/client/services?ids=${ids}&${query}`)).json<Array<{ code: string }>>().map((row) => row.code);

    expect(await codes('type=server')).toEqual(['Z3X']);
    expect(await codes('type_ne=server&_sort=name&_order=desc')).toEqual(['IMEI-ICL-CHK', 'IMEI-ATT-USA']);
    expect(await codes('q=credits')).toEqual(['Z3X']);
    expect(await codes('q=nothing-like-this')).toEqual([]);
    const page = await get(`/client/services?ids=${ids}&_sort=id&_start=1&_end=2`);
    expect(page.headers['x-total-count']).toBe('3');
    expect(page.json().map((row: Row) => row.id)).toEqual([icloud]);
  });

  it('takes up to 100 ids, and the page range decides how many rows one call returns', async () => {
    const { db, get, serviceId, icloud, categoryId } = await world();
    const more: number[] = [];
    for (let index = 0; index < 29; index += 1) {
      more.push(await insertService(db, categoryId, { code: `MORE-${index}`, name: `More ${index}` }));
    }
    const ids = [serviceId, icloud, ...more];
    expect(ids).toHaveLength(31);

    // The default page of the list holds 25 rows: send _end=100 to read every named service in one call.
    const first = await get(`/client/services?ids=${ids.join(',')}`);
    expect(first.json()).toHaveLength(25);
    expect(first.headers['x-total-count']).toBe('31');
    const whole = await get(`/client/services?ids=${ids.join(',')}&_end=100`);
    expect(whole.statusCode).toBe(200);
    expect(
      whole
        .json()
        .map((row: Row) => row.id)
        .sort((a: number, b: number) => a - b),
    ).toEqual([...ids].sort((a, b) => a - b));

    // Exactly 100 ids (most of them unknown) are accepted.
    const hundred = [...ids, ...Array.from({ length: 69 }, (_, index) => 1_000_000 + index)];
    expect(hundred).toHaveLength(100);
    const limit = await get(`/client/services?ids=${hundred.join(',')}&_end=100`);
    expect(limit.statusCode).toBe(200);
    expect(limit.json()).toHaveLength(31);
  });

  it('refuses 101 ids with the usual 422 on ids, and remembers nothing', async () => {
    const { get } = await world();
    const res = await get(`/client/services?ids=${Array.from({ length: 101 }, (_, index) => index + 1).join(',')}`);
    expect(res.statusCode).toBe(422);
    expect(res.json().code).toBe('VALIDATION_FAILED');
    expect(res.json().errors[0].field).toBe('ids');
    expect(res.json().errors[0].message).toContain('at most 100');
    expect(await listedRows()).toEqual([]);
  });

  it('refuses a bad value with the usual 422 on ids, and remembers nothing', async () => {
    const { get, serviceId } = await world();
    for (const value of [
      '',
      'abc',
      `${serviceId},`,
      `,${serviceId}`,
      `${serviceId},,${serviceId}`,
      '0',
      '-1',
      '1.5',
      '01',
      '1e3',
      `${serviceId},x`,
      `${serviceId}%2C%202`,
      `${serviceId};2`,
      '99999999999999999',
      '9007199254740993',
    ]) {
      const res = await get(`/client/services?ids=${value}`);
      expect(res.statusCode, value).toBe(422);
      expect(res.json().code, value).toBe('VALIDATION_FAILED');
      expect(res.json().errors[0].field, value).toBe('ids');
    }
    // A repeated key is not the documented form either: one comma-separated value.
    const repeated = await get(`/client/services?ids=${serviceId}&ids=2`);
    expect(repeated.statusCode).toBe(422);
    expect(repeated.json().errors[0].field).toBe('ids');
    expect(await listedRows()).toEqual([]);
  });

  it('is still refused to a retail account, to a request another site started, and without a session', async () => {
    const { get, serviceId } = await world();
    const retail = await makeAccount(t, { rank: 'retail' });
    const retailSession = await openAccountSession(t, retail.id);
    const asRetail = await t.app.inject({
      method: 'GET',
      url: `/client/services?ids=${serviceId}`,
      headers: retailSession.headers,
    });
    expect(asRetail.statusCode).toBe(403);
    expect(asRetail.json().code).toBe('RANK_NOT_ALLOWED');

    const crossSite = await get(`/client/services?ids=${serviceId}`, {
      'sec-fetch-site': 'cross-site',
      'sec-fetch-mode': 'navigate',
    });
    expect(crossSite.statusCode).toBe(403);
    expect(crossSite.json().code).toBe('CSRF_FAILED');

    expect((await t.app.inject({ method: 'GET', url: `/client/services?ids=${serviceId}` })).statusCode).toBe(401);
    expect(await listedRows()).toEqual([]);
  });
});

describe('the listed prices of a request with ids', () => {
  it('records the price of every row it answers, and only those, once per change', async () => {
    const { get, db, erbil, serviceId, icloud, categoryId } = await world();
    const off = await insertService(db, categoryId, { code: 'OFF', status: 'disabled' });
    // The icloud service is visible but not named, the off service is named but not visible: neither is remembered.
    await get(`/client/services?ids=${serviceId},${off}`);
    expect((await listedRows()).map((row) => [row.clientId, row.serviceId, row.price, row.currency])).toEqual([
      [erbil, serviceId, '17.2800', 'USD'],
    ]);
    expect((await listedRows())[0]!.listedAt.toISOString()).toBe('2026-11-07T12:00:00.000Z');

    // The same read later writes nothing: the listed time stays the time the price first showed.
    clock.advance(MINUTE);
    await get(`/client/services?ids=${serviceId}`);
    expect((await listedRows())[0]!.listedAt.toISOString()).toBe('2026-11-07T12:00:00.000Z');

    // A changed price writes the new price and time, and a service named for the first time is written.
    await insertClientPriceRow(db, serviceId, erbil, '15.2000');
    clock.advance(MINUTE);
    await get(`/client/services?ids=${serviceId},${icloud}`);
    const rows = await listedRows();
    const price = (id: number) => rows.find((row) => row.serviceId === id);
    expect(rows).toHaveLength(2);
    expect(price(serviceId)?.price).toBe('15.2000');
    expect(price(serviceId)?.listedAt.toISOString()).toBe('2026-11-07T12:02:00.000Z');
    expect(price(icloud)?.price).toBe('0.1300');
  });

  it('writes the same rows as the list does for the same services', async () => {
    const { get, db, serviceId, icloud } = await world();
    const written = async () =>
      (await listedRows()).map((row) => [
        row.clientId,
        row.serviceId,
        row.price,
        row.currency,
        row.listedAt.toISOString(),
      ]);
    await get(`/client/services?ids=${serviceId},${icloud}`);
    const byIds = await written();
    expect(byIds).toHaveLength(2);
    await db.delete(s.listedPrices);
    await get('/client/services');
    expect(await written()).toEqual(byIds);
  });
});

describe('GET /client/services without ids', () => {
  it('lists every visible service as before, with the total, and remembers every price shown', async () => {
    const { get, db, erbil, serviceId, icloud, categoryId } = await world();
    await insertService(db, categoryId, { code: 'OFF', status: 'disabled' });
    const res = await get('/client/services');
    expect(res.statusCode).toBe(200);
    expect(res.headers['x-total-count']).toBe('2');
    const rows = res.json<Row[]>();
    expect(rows.map((row) => [row.id, row.price]).sort((a, b) => Number(a[0]) - Number(b[0]))).toEqual([
      [serviceId, '17.2800'],
      [icloud, '0.1300'],
    ]);
    expect(
      (await listedRows())
        .map((row) => [row.clientId, row.serviceId, row.price])
        .sort((a, b) => Number(a[1]) - Number(b[1])),
    ).toEqual([
      [erbil, serviceId, '17.2800'],
      [erbil, icloud, '0.1300'],
    ]);
  });

  it('answers the list, the list with ids and one service with Cache-Control private, no-store: they carry own prices', async () => {
    const { get, serviceId, icloud } = await world();
    for (const url of [
      '/client/services',
      `/client/services?ids=${icloud},${serviceId}`,
      `/client/services/${serviceId}`,
    ]) {
      const res = await get(url);
      expect(res.statusCode, url).toBe(200);
      expect(res.headers['cache-control'], url).toBe('private, no-store');
    }
  });

  it('keeps the other parameters and refuses an unknown one as before', async () => {
    const { get } = await world();
    expect((await get('/client/services?type=imei')).json()).toHaveLength(2);
    expect((await get('/client/services?q=icloud')).json()).toHaveLength(1);
    expect((await get('/client/services?id=1')).statusCode).toBe(422);
    expect((await get('/client/services?service_ids=1')).statusCode).toBe(422);
  });
});

// Integration tests of the merchant catalog (feature 4b): GET /client/services, GET /client/services/:id and GET
// /client/prices/export with a merchant session: prices resolved for the merchant, visibility, the listed-price memory (user
// rule 9), the CSV file, and the refusals (pending merchant, no session).
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { eq } from 'drizzle-orm';
import { schema as s } from '../../src/infra/db';
import { ListedPrices } from '../../src/modules/catalog';
import { type TestApp, createTestApp } from '../support/app';
import { clearIdentityCaches, openSession } from '../support/auth';
import { insertCategory, insertService } from '../support/catalog';
import { MINUTE, TestClock } from '../support/clock';
import { closeTestDb, resetDb, testDb } from '../support/db';
import {
  insertAtt,
  insertClientPriceRow,
  insertDemoGroups,
  insertGroupPrice,
  insertMerchantIn,
  insertRule,
} from '../support/pricing';

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

/** The demo: Cairo (VIP) and Erbil (Standard); the AT&T unlock with the 2 % Carrier unlock promo and a VIP price of 15.90. */
async function world() {
  const { db } = await testDb();
  const groups = await insertDemoGroups(db);
  const { categoryId, serviceId } = await insertAtt(db, { deliveryTime: '1 day' });
  await insertGroupPrice(db, serviceId, groups.vip, '15.9000');
  await insertRule(db, { scope: 'category', targetId: categoryId, kind: 'discount', percent: '2', priority: 100 });
  const cairo = await insertMerchantIn(db, groups.vip, { name: 'Cairo' });
  const erbil = await insertMerchantIn(db, groups.standard, { name: 'Erbil' });
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
  return { db, groups, categoryId, serviceId, cairo, erbil, apple, icloud };
}

async function as(clientId: number) {
  const session = await openSession(t, { type: 'client', id: clientId });
  const get = (url: string) => t.app.inject({ method: 'GET', url, headers: session.headers });
  return { session, get };
}

describe('GET /client/services', () => {
  it("lists the services at the signed-in merchant's own prices, by category order then name", async () => {
    const { cairo, erbil, serviceId, icloud, categoryId, apple, db } = await world();
    await db.update(s.serviceCategories).set({ sort: 2 }).where(eq(s.serviceCategories.id, categoryId));
    await db.update(s.serviceCategories).set({ sort: 1 }).where(eq(s.serviceCategories.id, apple));

    const forErbil = await (await as(erbil)).get('/client/services');
    expect(forErbil.statusCode).toBe(200);
    expect(forErbil.headers['x-total-count']).toBe('2');
    expect(forErbil.json()).toEqual([
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
      {
        id: serviceId,
        name: 'AT&T USA Premier Unlock',
        code: 'IMEI-ATT-USA',
        type: 'imei',
        category: { id: categoryId, name: 'Carrier unlock' },
        price: '16.9300',
        currency: 'USD',
        deliveryTime: '1 day',
        slaMinutes: 1440,
        info: '',
        minQty: 1,
        maxQty: 1,
        qtyOptions: [],
      },
    ]);
    const forCairo = (await (await as(cairo)).get('/client/services')).json();
    expect(forCairo.map((row: { code: string; price: string }) => [row.code, row.price])).toEqual([
      ['IMEI-ICL-CHK', '0.1200'],
      ['IMEI-ATT-USA', '15.9000'],
    ]);
  });

  it('keeps the services of a category together even when two categories share the same order number', async () => {
    const { db, erbil, categoryId, apple } = await world();
    await db.update(s.serviceCategories).set({ sort: 7 }).where(eq(s.serviceCategories.id, categoryId));
    await db.update(s.serviceCategories).set({ sort: 7 }).where(eq(s.serviceCategories.id, apple));
    await insertService(db, categoryId, {
      name: 'Zeta carrier',
      code: 'ZETA',
      basePrice: '9.0000',
      cost: '1',
      effectiveCost: '1',
    });
    await insertService(db, apple, {
      name: 'Alpha apple',
      code: 'ALPHA',
      basePrice: '9.0000',
      cost: '1',
      effectiveCost: '1',
    });
    const rows = (await (await as(erbil)).get('/client/services')).json();
    // Category order (sort, then id), then name: the carrier category (id 1) first, then Apple, never interleaved.
    expect(rows.map((row: { code: string }) => row.code)).toEqual(['IMEI-ATT-USA', 'ZETA', 'ALPHA', 'IMEI-ICL-CHK']);
    const file = (await (await as(erbil)).get('/client/prices/export')).body.split('\r\n');
    expect(file.slice(1, 5).map((line: string) => line.split(',')[1])).toEqual([
      'IMEI-ATT-USA',
      'ZETA',
      'ALPHA',
      'IMEI-ICL-CHK',
    ]);
  });

  it('never shows cost, floor, margin or supplier details', async () => {
    const { erbil } = await world();
    const [row] = (await (await as(erbil)).get('/client/services')).json();
    for (const key of ['cost', 'floorPrice', 'minProfit', 'marginPct', 'effectiveCost', 'supplier', 'basePrice']) {
      expect(row, key).not.toHaveProperty(key);
    }
  });

  it("uses the merchant's client price when it has one", async () => {
    const { db, erbil, serviceId } = await world();
    await insertClientPriceRow(db, serviceId, erbil, '15.2000');
    const rows = (await (await as(erbil)).get('/client/services?q=att')).json();
    expect(rows.map((row: { price: string }) => row.price)).toEqual(['15.2000']);
  });

  it('hides archived and disabled services, inactive categories and categories not open to the merchant group', async () => {
    const { db, groups, cairo, erbil, categoryId } = await world();
    await insertService(db, categoryId, { name: 'Off', code: 'OFF', status: 'disabled' });
    await insertService(db, categoryId, { name: 'Gone', code: 'GONE', status: 'disabled', archivedAt: new Date() });
    const hidden = await insertCategory(db, { name: 'Hidden', isActive: false });
    await insertService(db, hidden, { name: 'In hidden category', code: 'HID' });
    const vipOnly = await insertCategory(db, { name: 'VIP only', allowedGroupIds: [groups.vip] });
    await insertService(db, vipOnly, { name: 'VIP service', code: 'VIPSVC', basePrice: '5.0000' });

    const codes = async (id: number) =>
      (await (await as(id)).get('/client/services?_sort=id')).json().map((row: { code: string }) => row.code);
    expect(await codes(erbil)).toEqual(['IMEI-ATT-USA', 'IMEI-ICL-CHK']);
    expect(await codes(cairo)).toEqual(['IMEI-ATT-USA', 'IMEI-ICL-CHK', 'VIPSVC']);
  });

  it('filters by type and category, searches, sorts, pages and counts', async () => {
    const { db, erbil, categoryId } = await world();
    const server = await insertCategory(db, { name: 'Credits', type: 'server' });
    await insertService(db, server, {
      type: 'server',
      name: 'Z3X Credits',
      code: 'Z3X',
      basePrice: '9.0000',
      cost: '5',
      effectiveCost: '5',
    });
    const { get } = await as(erbil);
    expect((await get('/client/services?type=server')).json().map((row: { code: string }) => row.code)).toEqual([
      'Z3X',
    ]);
    expect((await get('/client/services?type_ne=server')).json()).toHaveLength(2);
    expect((await get(`/client/services?categoryId=${categoryId}`)).json()).toHaveLength(1);
    expect((await get('/client/services?q=credits')).json()).toHaveLength(1);
    expect((await get('/client/services?q=carrier')).json()).toHaveLength(1);
    const page = await get('/client/services?_start=1&_end=2&_sort=name&_order=asc');
    expect(page.headers['x-total-count']).toBe('3');
    expect(page.json()).toHaveLength(1);
    expect((await get('/client/services?_sort=price')).statusCode).toBe(422);
  });

  it('follows a pricing rule window on the clock', async () => {
    const { db, erbil, categoryId } = await world();
    await insertRule(db, {
      scope: 'category',
      targetId: categoryId,
      kind: 'promo',
      percent: '10',
      priority: 1,
      startsAt: new Date(clock.now().getTime() + MINUTE),
    });
    const price = async () => (await (await as(erbil)).get('/client/services?q=att')).json()[0].price;
    expect(await price()).toBe('16.9300');
    clock.advance(MINUTE);
    expect(await price()).toBe('15.5500');
  });

  it('is refused for a pending merchant (B153) and for a request without a session', async () => {
    const { db, groups } = await world();
    const pending = await insertMerchantIn(db, groups.standard, { status: 'pending' });
    const { get } = await as(pending);
    for (const url of ['/client/services', '/client/services/1', '/client/prices/export']) {
      const res = await get(url);
      expect(res.statusCode, url).toBe(403);
      expect(res.json().code).toBe('ACCOUNT_PENDING_APPROVAL');
    }
    expect((await t.app.inject({ method: 'GET', url: '/client/services' })).statusCode).toBe(401);
  });

  it('is not open to a staff session', async () => {
    const { adminWith } = await import('../support/admin-api');
    const admin = await adminWith(t, ['*']);
    expect(
      (await t.app.inject({ method: 'GET', url: '/client/services', headers: admin.session.headers })).statusCode,
    ).toBe(401);
  });
});

describe('the listed-price memory (user rule 9)', () => {
  it('records the price of every row shown, once per change, with the time of the change', async () => {
    const { db, erbil, cairo, serviceId, icloud } = await world();
    await (await as(erbil)).get('/client/services');
    expect((await listedRows()).map((row) => [row.clientId, row.serviceId, row.price, row.currency])).toEqual(
      [
        [erbil, serviceId, '16.9300', 'USD'],
        [erbil, icloud, '0.1300', 'USD'],
      ].sort((a, b) => Number(a[1]) - Number(b[1])),
    );
    const first = (await listedRows())[0]!;
    expect(first.listedAt.toISOString()).toBe('2026-11-07T12:00:00.000Z');

    // The same page again at a later time writes nothing: the listed time stays the time the price first showed.
    clock.advance(MINUTE);
    await (await as(erbil)).get('/client/services');
    expect((await listedRows())[0]?.listedAt.toISOString()).toBe('2026-11-07T12:00:00.000Z');

    // A change of the price writes a new row value and time; other merchants are unaffected.
    await insertClientPriceRow(db, serviceId, erbil, '15.2000');
    clock.advance(MINUTE);
    await (await as(erbil)).get('/client/services');
    const rows = await listedRows();
    const att = rows.find((row) => row.clientId === erbil && row.serviceId === serviceId)!;
    expect(att.price).toBe('15.2000');
    expect(att.listedAt.toISOString()).toBe('2026-11-07T12:02:00.000Z');
    expect(rows.some((row) => row.clientId === cairo)).toBe(false);
  });

  it('survives several lists of the same merchant at the same moment (no deadlock, one row per service)', async () => {
    const { erbil } = await world();
    const { session } = await as(erbil);
    const results = await Promise.all(
      Array.from({ length: 6 }, () =>
        t.app.inject({ method: 'GET', url: '/client/services', headers: session.headers }),
      ),
    );
    expect(results.map((res) => res.statusCode)).toEqual([200, 200, 200, 200, 200, 200]);
    expect(await listedRows()).toHaveLength(2);
  });

  it('records only the page the merchant was shown', async () => {
    const { erbil } = await world();
    await (await as(erbil)).get('/client/services?_start=0&_end=1');
    expect(await listedRows()).toHaveLength(1);
  });

  it('ListedPrices.record writes only when the price changes, and find and findMany read it back', async () => {
    const { db, erbil, serviceId, icloud } = await world();
    const listed = t.app.get(ListedPrices);
    const { Money } = await import('../../src/common/money');
    const at = new Date('2026-11-07T12:00:00.000Z');
    expect(
      await listed.record(
        db,
        erbil,
        [
          { serviceId, price: Money.of('10') },
          { serviceId: icloud, price: Money.of('1') },
        ],
        at,
      ),
    ).toBe(2);
    expect(
      await listed.record(db, erbil, [{ serviceId, price: Money.of('10.0000') }], new Date(at.getTime() + 1000)),
    ).toBe(0);
    expect(
      await listed.record(db, erbil, [{ serviceId, price: Money.of('10.5') }], new Date(at.getTime() + 2000)),
    ).toBe(1);
    expect(await listed.record(db, erbil, [], at)).toBe(0);
    expect(
      await listed.record(
        db,
        erbil,
        [
          { serviceId, price: Money.of('11') },
          { serviceId, price: Money.of('12') },
        ],
        new Date(at.getTime() + 3000),
      ),
    ).toBe(1);
    const one = await listed.find(db, erbil, serviceId);
    expect(one?.price.toWire()).toBe('12.0000');
    expect(one?.listedAt.toISOString()).toBe('2026-11-07T12:00:03.000Z');
    expect(await listed.find(db, erbil, 424242)).toBeUndefined();
    const many = await listed.findMany(db, erbil, [serviceId, icloud, 424242]);
    expect([...many.keys()].sort()).toEqual([serviceId, icloud].sort());
    expect((await listed.findMany(db, erbil, [])).size).toBe(0);
  });

  it('keeps a row for every merchant and service pair and drops with the service', async () => {
    const { db, erbil, cairo, icloud } = await world();
    await (await as(erbil)).get('/client/services');
    await (await as(cairo)).get('/client/services');
    expect(await listedRows()).toHaveLength(4);
    await db.delete(s.services).where(eq(s.services.id, icloud));
    expect(await listedRows()).toHaveLength(2);
  });
});

describe('GET /client/services/:id', () => {
  it('shows the service at the merchant price with the order-form fields and options, without supplier names', async () => {
    const { db, erbil, serviceId } = await world();
    await db.insert(s.serviceFields).values([
      {
        serviceId,
        key: 'imei',
        label: 'IMEI',
        fieldType: 'text',
        required: true,
        regex: '^[0-9]{15}$',
        supplierKey: 'IMEI',
        sort: 0,
      },
      { serviceId, key: 'note', label: 'Note', fieldType: 'select', options: ['a', 'b'], supplierKey: 'NOTE', sort: 1 },
    ]);
    await db
      .insert(s.serviceOptions)
      .values({ serviceId, list: 'model', value: 'iphone15', label: 'iPhone 15', supplierValue: 'IP15' });

    const res = await (await as(erbil)).get(`/client/services/${serviceId}`);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      id: serviceId,
      code: 'IMEI-ATT-USA',
      price: '16.9300',
      fields: [
        { key: 'imei', label: 'IMEI', fieldType: 'text', required: true, options: [], regex: '^[0-9]{15}$' },
        { key: 'note', label: 'Note', fieldType: 'select', required: false, options: ['a', 'b'], regex: '' },
      ],
      options: [{ list: 'model', value: 'iphone15', label: 'iPhone 15' }],
    });
    const body = res.json();
    expect(body.fields[0]).not.toHaveProperty('supplierKey');
    expect(body.options[0]).not.toHaveProperty('supplierValue');
    expect((await listedRows()).map((row) => row.price)).toEqual(['16.9300']);
  });

  it('answers 404 for an unknown, archived, disabled or hidden service', async () => {
    const { db, erbil, categoryId } = await world();
    const off = await insertService(db, categoryId, { status: 'disabled' });
    const gone = await insertService(db, categoryId, { status: 'disabled', archivedAt: new Date() });
    const vipOnly = await insertCategory(db, { name: 'VIP only', allowedGroupIds: [999] });
    const hidden = await insertService(db, vipOnly, {});
    const { get } = await as(erbil);
    for (const id of [424242, off, gone, hidden])
      expect((await get(`/client/services/${id}`)).statusCode, String(id)).toBe(404);
    expect(await listedRows()).toHaveLength(0);
  });
});

describe('GET /client/prices/export', () => {
  it('answers the price list as a CSV file with the merchant prices, and remembers them', async () => {
    const { erbil, cairo, serviceId, icloud, db, categoryId } = await world();
    await insertService(db, categoryId, {
      name: '=EVIL(), "x"',
      code: 'EVIL',
      basePrice: '3.0000',
      cost: '1',
      effectiveCost: '1',
    });
    const res = await (await as(erbil)).get('/client/prices/export');
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('text/csv; charset=utf-8');
    expect(res.headers['content-disposition']).toBe('attachment; filename="price-list.csv"');
    expect(res.headers['cache-control']).toBe('no-store');
    const lines = res.body.split('\r\n');
    expect(lines[0]).toBe('serviceId,code,name,type,category,price,currency,deliveryTime');
    expect(lines).toContain(`${serviceId},IMEI-ATT-USA,AT&T USA Premier Unlock,imei,Carrier unlock,16.9300,USD,1 day`);
    expect(lines.find((line) => line.includes(',EVIL,'))).toContain(`,"'=EVIL(), ""x""",`);
    expect(lines.at(-1)).toBe('');
    expect((await listedRows()).filter((row) => row.clientId === erbil)).toHaveLength(3);

    const cairoFile = (
      await (
        await as(cairo)
      ).get(
        '/client/prices/export?type=imei&categoryId=' +
          (await db.select().from(s.services).where(eq(s.services.id, icloud)))[0]!.categoryId,
      )
    ).body;
    expect(cairoFile.split('\r\n').slice(1, -1)).toHaveLength(1);
    expect(cairoFile).toContain(',0.1200,USD,');
  });

  it('refuses a filter it does not know', async () => {
    const { erbil } = await world();
    expect((await (await as(erbil)).get('/client/prices/export?type=banana')).statusCode).toBe(422);
  });
});

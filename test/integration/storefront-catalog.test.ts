// Integration tests of the public storefront catalog (feature 14a): GET /store/v1/config, /store/v1/services and
// /store/v1/services/:slug against the real API: visibility, the retail price, tax, the exchange rate, filters, paging.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { eq } from 'drizzle-orm';
import { schema as s } from '../../src/infra/db';
import { type TestApp, createTestApp } from '../support/app';
import { TestClock } from '../support/clock';
import { closeTestDb, resetDb, testDb } from '../support/db';
import { insertCurrency, insertListing, insertTaxWindow, storefrontWorld } from '../support/storefront';
import { insertCategory, insertInventoryCodes, insertService } from '../support/catalog';

const clock = new TestClock('2026-11-07T12:00:00.000Z');
let t: TestApp;

beforeAll(async () => {
  t = await createTestApp({ clock });
});
beforeEach(async () => {
  clock.set('2026-11-07T12:00:00.000Z');
  await resetDb();
});
afterAll(async () => {
  await resetDb();
  await t.close();
  await closeTestDb();
});

const get = (url: string) => t.app.inject({ method: 'GET', url });
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- test bodies are untyped JSON
const body = (res: { json: () => any }): any => res.json();

describe('GET /store/v1/config', () => {
  it('lists the offered currencies with the locked rate, the tax windows in force, the policies and the legal documents', async () => {
    const { db } = await testDb();
    await storefrontWorld(db);
    await insertCurrency(db, {
      code: 'SEK',
      name: 'Swedish krona',
      rateToBase: '10.6',
      markupPercent: '1.5',
      isStorefront: false,
    });
    await insertTaxWindow(db, { country: 'DE', ratePercent: '19', label: 'German VAT' });
    await insertTaxWindow(db, { country: 'FR', ratePercent: '20', validTo: new Date('2026-01-01T00:00:00.000Z') });
    await insertTaxWindow(db, { country: 'IT', ratePercent: '22', validFrom: new Date('2027-01-01T00:00:00.000Z') });

    const res = await get('/store/v1/config');
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('public, max-age=30');
    const config = body(res);
    expect(config.baseCurrency).toBe('USD');
    expect(config.currencies).toEqual([
      { code: 'GBP', name: 'British pound', decimals: 2, fxRate: '0.80185000' },
      { code: 'USD', name: 'US dollar', decimals: 2, fxRate: '1.00000000' },
    ]);
    // Tax windows in force today: GB and DE; FR ended, IT has not started.
    expect(config.taxRates.map((rate: { country: string }) => rate.country)).toEqual(['DE', 'GB']);
    expect(config.taxRates[1]).toEqual({
      country: 'GB',
      region: '',
      ratePercent: '20.0000',
      taxType: 'vat',
      label: 'UK VAT',
    });
    expect(config.policies).toEqual({ guestCheckout: true, withdrawalWaiver: true, imeiPrecheck: true });
    expect(config.paymentMethods).toEqual([]);
    expect(config.legalDocuments.map((doc: { type: string; version: string }) => `${doc.type} ${doc.version}`)).toEqual(
      ['privacy 2.1', 'refund 1.4', 'terms 3.2'],
    );
  });

  it('reads the policy switches from the settings and the B2C payment gateways that are on', async () => {
    const { db } = await testDb();
    await storefrontWorld(db);
    await db.insert(s.settings).values([
      { key: 'guestCheckout', value: false },
      { key: 'imeiPrecheck', value: 'nope' },
    ]);
    await db.insert(s.paymentGateways).values([
      { code: 'card', driver: 'stripe', name: 'Card gateway', audience: 'b2c', supports3ds: true },
      // Feature 21 (D6): a gateway is listed only when `/pay` can use it, so it needs a known driver (`nowpayments` is none).
      { code: 'crypto', driver: 'crypto', name: 'Crypto gateway', audience: 'both' },
      { code: 'bank', driver: 'manual', name: 'Bank transfer', audience: 'b2b', isManual: true },
      { code: 'off', driver: 'stripe', name: 'Switched off', audience: 'b2c', isActive: false },
      // Feature 21 (D6): a manual B2C gateway (store balance top-ups) and one without a driver cannot pay a checkout: not listed.
      { code: 'cliq', driver: 'manual', name: 'CliQ transfer', audience: 'b2c', isManual: true },
      { code: 'mystery', driver: 'nobody', name: 'No driver', audience: 'b2c' },
    ]);
    const config = body(await get('/store/v1/config'));
    expect(config.policies).toEqual({ guestCheckout: false, withdrawalWaiver: true, imeiPrecheck: true });
    expect(config.paymentMethods).toEqual([
      { code: 'card', name: 'Card gateway', supports3ds: true },
      { code: 'crypto', name: 'Crypto gateway', supports3ds: false },
    ]);
  });

  it('works on an empty database', async () => {
    const res = await get('/store/v1/config');
    expect(res.statusCode).toBe(200);
    expect(body(res).currencies).toEqual([]);
  });
});

describe('GET /store/v1/services', () => {
  it('lists the switched-on pages at the retail price in the buyer currency with tax, featured first, without any staff-only field', async () => {
    const { db } = await testDb();
    const world = await storefrontWorld(db);
    const res = await get('/store/v1/services?buyerCountry=gb&currency=gbp');
    expect(res.statusCode).toBe(200);
    expect(res.headers['x-total-count']).toBe('2');
    expect(res.headers['cache-control']).toBe('public, max-age=30');
    const rows = body(res);
    expect(rows.map((row: { slug: string }) => row.slug)).toEqual([world.icloud.slug, world.att.slug]);
    expect(rows[0]).toEqual({
      id: world.icloud.serviceId,
      slug: world.icloud.slug,
      locale: 'en',
      title: 'iCloud Clean / Lost Check',
      summary: 'Find out if the phone is clean before you buy.',
      brand: 'Apple',
      network: '',
      country: '',
      isFeatured: true,
      type: 'imei',
      deliveryTime: '2 minutes',
      category: { id: world.icloud.categoryId, slug: `${world.icloud.categoryId}-apple`, name: 'Apple' },
      availability: 'on_request',
      deliveryMinutes: 2,
      etaText: '',
      listedAt: null,
      imageUrl: null,
      // 3.99 net + 0.80 VAT = 4.79 USD; x 0.80185 = 3.84 GBP gross, 0.64 tax, 3.20 net.
      price: {
        currency: 'GBP',
        fxRate: '0.80185000',
        net: '3.2000',
        tax: '0.6400',
        gross: '3.8400',
        taxRate: '20.0000',
        taxCountry: 'GB',
      },
    });
    const text = JSON.stringify(rows);
    for (const secret of ['cost', 'floor', 'supplier', 'locked', 'basePrice', 'effectiveCost', 'minProfit']) {
      expect(text.toLowerCase()).not.toContain(secret.toLowerCase());
    }
  });

  it('prices in USD with no tax when the buyer gives neither country nor currency', async () => {
    const { db } = await testDb();
    await storefrontWorld(db);
    const [first] = body(await get('/store/v1/services'));
    expect(first.price).toEqual({
      currency: 'USD',
      fxRate: '1.00000000',
      net: '3.9900',
      tax: '0.0000',
      gross: '3.9900',
      taxRate: '0.0000',
      taxCountry: null,
    });
  });

  it('never lists a service the shop cannot sell: archived, disabled, B2B-only, unpriced, or a page that is switched off', async () => {
    const { db } = await testDb();
    const world = await storefrontWorld(db);
    const category = world.icloud.categoryId;
    const mk = async (
      name: string,
      values: Partial<typeof s.services.$inferInsert> = {},
      price: string | null = '5.0000',
    ) => {
      const id = await insertService(db, category, {
        name,
        basePrice: '1.0000',
        cost: '0.1000',
        effectiveCost: '0.1000',
        ...values,
      });
      if (price !== null)
        await db.insert(s.serviceGroupPrices).values({ serviceId: id, groupId: world.groups.retail, price });
      await insertListing(db, id, { slug: name.toLowerCase().replace(/\W+/g, '-'), publicTitle: name });
      return id;
    };
    await mk('Disabled one', { status: 'disabled' });
    await mk('Archived one', { status: 'disabled', archivedAt: new Date('2026-01-01T00:00:00.000Z') });
    await mk('Unpriced one', {}, null);
    const hidden = await mk('Switched off');
    await db.update(s.serviceListings).set({ isListed: false }).where(eq(s.serviceListings.serviceId, hidden));
    const b2bCategory = await db
      .insert(s.serviceCategories)
      .values({ name: 'B2B only', type: 'imei', allowedGroupIds: [world.groups.vip] })
      .returning({ id: s.serviceCategories.id });
    const b2b = await insertService(db, b2bCategory[0]!.id, {
      name: 'B2B only service',
      basePrice: '1.0000',
      cost: '0.1000',
      effectiveCost: '0.1000',
    });
    await db.insert(s.serviceGroupPrices).values({ serviceId: b2b, groupId: world.groups.retail, price: '5.0000' });
    await insertListing(db, b2b, { slug: 'b2b-only', publicTitle: 'B2B only service' });
    const off = await db
      .insert(s.serviceCategories)
      .values({ name: 'Category off', type: 'imei', isActive: false })
      .returning({ id: s.serviceCategories.id });
    const inactive = await insertService(db, off[0]!.id, {
      name: 'In an inactive category',
      basePrice: '1.0000',
      cost: '0.1000',
      effectiveCost: '0.1000',
    });
    await db
      .insert(s.serviceGroupPrices)
      .values({ serviceId: inactive, groupId: world.groups.retail, price: '5.0000' });
    await insertListing(db, inactive, { slug: 'inactive-category', publicTitle: 'In an inactive category' });

    const res = await get('/store/v1/services');
    expect(res.headers['x-total-count']).toBe('2');
    expect(body(res).map((row: { slug: string }) => row.slug)).toEqual([world.icloud.slug, world.att.slug]);
  });

  it('never sells under the storefront floor: a retail price below 110 % of the base price is lifted to it', async () => {
    const { db } = await testDb();
    const world = await storefrontWorld(db);
    // base 17.28: the floor is 19.01 whatever the stored retail price says.
    await db
      .update(s.serviceGroupPrices)
      .set({ price: '18.0000' })
      .where(eq(s.serviceGroupPrices.serviceId, world.att.serviceId));
    const rows = body(await get('/store/v1/services?q=AT%26T'));
    expect(rows[0].price.net).toBe('19.0100');
  });

  it('filters by brand, network and country case-insensitively, by featured and by search, and counts exactly', async () => {
    const { db } = await testDb();
    const world = await storefrontWorld(db);
    const slugs = async (query: string) =>
      body(await get(`/store/v1/services?${query}`)).map((row: { slug: string }) => row.slug);
    expect(await slugs('brand=apple')).toEqual([world.icloud.slug, world.att.slug]);
    expect(await slugs('brand=samsung')).toEqual([]);
    expect(await slugs('network=at%26t')).toEqual([world.att.slug]);
    expect(await slugs('country=us')).toEqual([world.att.slug]);
    expect(await slugs('featured=true')).toEqual([world.icloud.slug]);
    expect(await slugs('q=unlock')).toEqual([world.att.slug]);
    expect(await slugs('brand=apple&_sort=sort&_order=desc')).toEqual([world.att.slug, world.icloud.slug]);
    const paged = await get('/store/v1/services?_start=1&_end=2');
    expect(paged.headers['x-total-count']).toBe('2');
    expect(body(paged).map((row: { slug: string }) => row.slug)).toEqual([world.att.slug]);
  });

  it('reads a language of its own and defaults to English', async () => {
    const { db } = await testDb();
    const world = await storefrontWorld(db);
    await insertListing(db, world.icloud.serviceId, { locale: 'ar', slug: 'icloud-ar', publicTitle: 'فحص آي كلاود' });
    expect(body(await get('/store/v1/services?locale=ar')).map((row: { slug: string }) => row.slug)).toEqual([
      'icloud-ar',
    ]);
    expect((await get('/store/v1/services')).headers['x-total-count']).toBe('2');
  });

  it('answers 422 for a currency that is not offered or malformed and for a filter it does not know', async () => {
    const { db } = await testDb();
    await storefrontWorld(db);
    const sek = await get('/store/v1/services?currency=SEK');
    expect(sek.statusCode).toBe(422);
    expect(body(sek).errors[0].field).toBe('currency');
    expect((await get('/store/v1/services?currency=EURO')).statusCode).toBe(422);
    expect((await get('/store/v1/services?buyerCountry=GBR')).statusCode).toBe(422);
    expect((await get('/store/v1/services?cost=1')).statusCode).toBe(422);
    expect((await get('/store/v1/services?_end=500')).statusCode).toBe(422);
  });

  it('is empty without a retail group', async () => {
    const res = await get('/store/v1/services');
    expect(res.statusCode).toBe(200);
    expect(body(res)).toEqual([]);
    expect(res.headers['x-total-count']).toBe('0');
  });

  it('prices at the moment of the request: a tax window that ends stops being added', async () => {
    const { db } = await testDb();
    await storefrontWorld(db);
    await db.update(s.taxRates).set({ validTo: new Date('2026-12-31T00:00:00.000Z') });
    expect(body(await get('/store/v1/services?buyerCountry=GB'))[0].price.taxRate).toBe('20.0000');
    clock.set('2027-01-02T00:00:00.000Z');
    expect(body(await get('/store/v1/services?buyerCountry=GB'))[0].price.taxRate).toBe('0.0000');
  });
});

describe('GET /store/v1/services/:slug', () => {
  it('shows the page with its fields, quantities, published FAQs and price', async () => {
    const { db } = await testDb();
    const world = await storefrontWorld(db);
    await db
      .update(s.serviceListings)
      .set({
        descriptionMd: 'We check **iCloud**.',
        etaText: 'Usually 2 minutes',
        requirementsMd: 'Dial *#06#.',
        seoTitle: 'T',
        seoDescription: 'D',
      })
      .where(eq(s.serviceListings.id, world.icloud.listingId));
    await db.insert(s.serviceFields).values({
      serviceId: world.icloud.serviceId,
      key: 'note',
      label: 'Note',
      required: false,
      sort: 1,
      supplierKey: 'secret_supplier_key',
    });
    await db.insert(s.helpArticles).values([
      {
        category: 'Orders',
        question: 'How fast?',
        answerMd: 'Two minutes.',
        serviceId: world.icloud.serviceId,
        isPublished: true,
        sort: 2,
      },
      { category: 'Orders', question: 'Draft', answerMd: 'x', serviceId: world.icloud.serviceId, isPublished: false },
      {
        category: 'Orders',
        question: 'Other service',
        answerMd: 'x',
        serviceId: world.att.serviceId,
        isPublished: true,
      },
      {
        category: 'Orders',
        question: 'Arabic',
        answerMd: 'x',
        serviceId: world.icloud.serviceId,
        isPublished: true,
        locale: 'ar',
      },
    ]);
    const res = await get(`/store/v1/services/${world.icloud.slug}?buyerCountry=GB&currency=GBP`);
    expect(res.statusCode).toBe(200);
    const page = body(res);
    expect(page.descriptionMd).toBe('We check **iCloud**.');
    expect(page.etaText).toBe('Usually 2 minutes');
    expect(page.quantity).toEqual({ min: 1, max: 1, options: [] });
    expect(page.fields).toEqual([{ key: 'note', label: 'Note', fieldType: 'text', options: [], required: false }]);
    expect(page.faqs).toEqual([{ question: 'How fast?', answerMd: 'Two minutes.' }]);
    expect(page.price.gross).toBe('3.8400');
    expect(JSON.stringify(page)).not.toContain('secret_supplier_key');
  });

  it('answers 404 for an unknown slug, a page that is off, another language and a service that cannot be sold', async () => {
    const { db } = await testDb();
    const world = await storefrontWorld(db);
    expect((await get('/store/v1/services/nope')).statusCode).toBe(404);
    expect((await get(`/store/v1/services/${world.icloud.slug}?locale=ar`)).statusCode).toBe(404);
    await db.update(s.serviceListings).set({ isListed: false }).where(eq(s.serviceListings.id, world.icloud.listingId));
    expect((await get(`/store/v1/services/${world.icloud.slug}`)).statusCode).toBe(404);
    await db.update(s.services).set({ status: 'disabled' }).where(eq(s.services.id, world.att.serviceId));
    const res = await get(`/store/v1/services/${world.att.slug}`);
    expect(res.statusCode).toBe(404);
    expect(body(res).code).toBe('NOT_FOUND');
  });

  it('answers 422 for a currency that is not offered', async () => {
    const { db } = await testDb();
    const world = await storefrontWorld(db);
    const res = await get(`/store/v1/services/${world.icloud.slug}?currency=JPY`);
    expect(res.statusCode).toBe(422);
    expect(body(res).errors[0].field).toBe('currency');
  });
});

describe('the catalog filters, sorts and categories of feature 22', () => {
  /** Adds a priced, listed service in a category: one more row for the sorts and filters to tell apart. */
  async function addService(
    world: Awaited<ReturnType<typeof storefrontWorld>>,
    name: string,
    price: string,
    categoryId: number,
    options: {
      type?: 'imei' | 'server' | 'remote' | 'file';
      listing?: Partial<typeof s.serviceListings.$inferInsert>;
      service?: Partial<typeof s.services.$inferInsert>;
    } = {},
  ) {
    const { db } = world;
    const serviceId = await insertService(db, categoryId, {
      name,
      type: options.type ?? 'imei',
      basePrice: '1.0000',
      cost: '0.1000',
      effectiveCost: '0.1000',
      slaMinutes: 30,
      ...options.service,
    });
    await db.insert(s.serviceGroupPrices).values({ serviceId, groupId: world.groups.retail, price });
    const slug = name.toLowerCase().replace(/\W+/g, '-');
    const listingId = await insertListing(db, serviceId, { slug, publicTitle: name, ...options.listing });
    return { serviceId, listingId, slug };
  }
  const slugs = async (query: string) =>
    body(await get(`/store/v1/services?${query}`)).map((row: { slug: string }) => row.slug);

  it('shows the category, the delivery minutes, the delivery note and the first publication on every card', async () => {
    const { db } = await testDb();
    const world = await storefrontWorld(db);
    await db
      .update(s.serviceCategories)
      .set({ nameAr: 'آبل' })
      .where(eq(s.serviceCategories.id, world.icloud.categoryId));
    await db
      .update(s.serviceListings)
      .set({ etaText: 'About 2 minutes', listedAt: new Date('2026-10-01T09:00:00.000Z') })
      .where(eq(s.serviceListings.id, world.icloud.listingId));
    await db.update(s.services).set({ slaMinutes: 1440 }).where(eq(s.services.id, world.att.serviceId));
    const rows = body(await get('/store/v1/services'));
    expect(rows[0]).toMatchObject({
      category: { id: world.icloud.categoryId, slug: `${world.icloud.categoryId}-apple`, name: 'Apple' },
      deliveryMinutes: 2,
      deliveryTime: '2 minutes',
      etaText: 'About 2 minutes',
      listedAt: '2026-10-01T09:00:00.000Z',
    });
    expect(rows[1]).toMatchObject({ deliveryMinutes: 1440, etaText: '', listedAt: null });
    // The Arabic page shows the Arabic category name; the slug stays the English one.
    await insertListing(db, world.icloud.serviceId, { locale: 'ar', slug: 'icloud-ar', publicTitle: 'فحص' });
    const [ar] = body(await get('/store/v1/services?locale=ar'));
    expect(ar.category).toEqual({ id: world.icloud.categoryId, slug: `${world.icloud.categoryId}-apple`, name: 'آبل' });
  });

  it('says in_stock only when the available codes cover the smallest order, and never gives a count', async () => {
    const { db } = await testDb();
    const world = await storefrontWorld(db);
    const packs = await addService(world, 'Packs', '9.0000', world.icloud.categoryId, {
      service: { minQty: 1, maxQty: 50, qtyOptions: [5, 10] },
    });
    await insertInventoryCodes(db, world.icloud.serviceId, 1);
    await insertInventoryCodes(db, world.att.serviceId, 2, { status: 'sold' });
    await insertInventoryCodes(db, packs.serviceId, 4);
    const availability = async () =>
      Object.fromEntries(
        body(await get('/store/v1/services')).map((row: { slug: string; availability: string }) => [
          row.slug,
          row.availability,
        ]),
      );
    expect(await availability()).toEqual({
      [world.icloud.slug]: 'in_stock',
      [world.att.slug]: 'on_request',
      [packs.slug]: 'on_request',
    });
    await insertInventoryCodes(db, packs.serviceId, 1);
    expect((await availability())[packs.slug]).toBe('in_stock');
    expect(JSON.stringify(body(await get('/store/v1/services')))).not.toMatch(/stock"?:\s*\d/i);
  });

  it('filters by type (repeatable), category (repeatable) and availability, with exact totals', async () => {
    const { db } = await testDb();
    const world = await storefrontWorld(db);
    const credits = await insertCategory(db, { name: 'Credits', type: 'server' });
    const server = await addService(world, 'Server credit', '4.0000', credits, { type: 'server' });
    await insertInventoryCodes(db, world.icloud.serviceId, 1);

    expect(await slugs('type=server')).toEqual([server.slug]);
    expect(await slugs('type=imei')).toEqual([world.icloud.slug, world.att.slug]);
    expect(new Set(await slugs('type=imei&type=server'))).toEqual(
      new Set([world.icloud.slug, world.att.slug, server.slug]),
    );
    expect(await slugs(`categoryId=${credits}`)).toEqual([server.slug]);
    expect(new Set(await slugs(`categoryId=${credits}&categoryId=${world.icloud.categoryId}`))).toEqual(
      new Set([server.slug, world.icloud.slug]),
    );
    expect(await slugs('availability=in_stock')).toEqual([world.icloud.slug]);
    expect(new Set(await slugs('availability=on_request'))).toEqual(new Set([world.att.slug, server.slug]));
    // Both values, or filters that agree, change nothing / combine.
    expect(await slugs('availability=in_stock&availability=on_request')).toHaveLength(3);
    expect(await slugs(`type=imei&categoryId=${credits}`)).toEqual([]);
    const res = await get('/store/v1/services?type=imei&_start=0&_end=1');
    expect(res.headers['x-total-count']).toBe('2');
    expect(body(res)).toHaveLength(1);
    // Unknown values are refused, not ignored.
    expect((await get('/store/v1/services?type=sms')).statusCode).toBe(422);
    expect((await get('/store/v1/services?availability=low')).statusCode).toBe(422);
    expect((await get('/store/v1/services?categoryId=abc')).statusCode).toBe(422);
  });

  it('bounds the price the visitor sees, inclusive, in the chosen currency with the buyer country tax', async () => {
    const { db } = await testDb();
    const world = await storefrontWorld(db);
    const buyer = 'buyerCountry=GB&currency=GBP';
    const priced = body(await get(`/store/v1/services?${buyer}`)) as Array<{ slug: string; price: { gross: string } }>;
    const cheap = priced.find((row) => row.slug === world.icloud.slug)!.price.gross;
    const dear = priced.find((row) => row.slug === world.att.slug)!.price.gross;
    expect(cheap).toBe('3.8400');
    expect(Number(dear)).toBeGreaterThan(Number(cheap));

    expect(await slugs(`${buyer}&minPrice=${cheap}&maxPrice=${cheap}`)).toEqual([world.icloud.slug]);
    expect(await slugs(`${buyer}&minPrice=${dear}`)).toEqual([world.att.slug]);
    expect(await slugs(`${buyer}&maxPrice=${cheap}`)).toEqual([world.icloud.slug]);
    expect(await slugs(`${buyer}&minPrice=3.8401&maxPrice=${dear}`)).toEqual([world.att.slug]);
    expect(await slugs(`${buyer}&minPrice=3.85&maxPrice=3.99`)).toEqual([]);
    // The bound is read in the chosen currency: 3.84 GBP is not 3.84 USD.
    expect(await slugs('minPrice=3.84&maxPrice=3.90')).toEqual([]);
    const counted = await get(`/store/v1/services?${buyer}&maxPrice=${cheap}&_start=0&_end=1`);
    expect(counted.headers['x-total-count']).toBe('1');
    // It combines with a filter and a page.
    expect(await slugs(`${buyer}&maxPrice=${dear}&brand=apple&_sort=price&_order=desc&_start=1&_end=2`)).toEqual([
      world.icloud.slug,
    ]);
  });

  it('refuses a lowest price above the highest, and a malformed bound, with 422 on the field', async () => {
    const { db } = await testDb();
    await storefrontWorld(db);
    const inverted = await get('/store/v1/services?minPrice=10&maxPrice=5');
    expect(inverted.statusCode).toBe(422);
    expect(body(inverted).errors[0].field).toBe('maxPrice');
    expect((await get('/store/v1/services?minPrice=abc')).statusCode).toBe(422);
    expect((await get('/store/v1/services?minPrice=-1')).statusCode).toBe(422);
    expect((await get('/store/v1/services?maxPrice=1.23456')).statusCode).toBe(422);
    expect((await get('/store/v1/services?minPrice=5&maxPrice=5')).statusCode).toBe(200);
  });

  it('sorts by price in both directions with stable ties and exact paging', async () => {
    const { db } = await testDb();
    const world = await storefrontWorld(db);
    // Two more services at the same price as the cheap one: ties keep the listing order (featured, position, title).
    const twinA = await addService(world, 'Twin A', '3.9900', world.icloud.categoryId, { listing: { sort: 5 } });
    const twinB = await addService(world, 'Twin B', '3.9900', world.icloud.categoryId, { listing: { sort: 6 } });
    expect(await slugs('_sort=price&_order=asc')).toEqual([world.icloud.slug, twinA.slug, twinB.slug, world.att.slug]);
    expect(await slugs('_sort=price&_order=desc')).toEqual([world.att.slug, world.icloud.slug, twinA.slug, twinB.slug]);
    // Pages never repeat or skip a row.
    const first = await slugs('_sort=price&_order=asc&_start=0&_end=2');
    const second = await slugs('_sort=price&_order=asc&_start=2&_end=4');
    expect([...first, ...second]).toEqual([world.icloud.slug, twinA.slug, twinB.slug, world.att.slug]);
    const paged = await get('/store/v1/services?_sort=price&_order=asc&_start=2&_end=4');
    expect(paged.headers['x-total-count']).toBe('4');
    // Price after another key sorts inside the tie of the key before it; the id (descending, like the first key) breaks the rest.
    expect(await slugs('_sort=featured,price&_order=desc,desc')).toEqual([
      world.icloud.slug,
      world.att.slug,
      twinB.slug,
      twinA.slug,
    ]);
  });

  it('sorts by popularity and by first publication, nulls last', async () => {
    const { db } = await testDb();
    const world = await storefrontWorld(db);
    const third = await addService(world, 'Third', '5.0000', world.icloud.categoryId);
    await db
      .update(s.serviceListings)
      .set({ sales30d: 5, listedAt: new Date('2026-10-01T00:00:00Z') })
      .where(eq(s.serviceListings.id, world.att.listingId));
    await db
      .update(s.serviceListings)
      .set({ sales30d: 9, listedAt: new Date('2026-10-09T00:00:00Z') })
      .where(eq(s.serviceListings.id, third.listingId));
    expect(await slugs('_sort=popular&_order=desc')).toEqual([third.slug, world.att.slug, world.icloud.slug]);
    expect(await slugs('_sort=popular&_order=asc')).toEqual([world.icloud.slug, world.att.slug, third.slug]);
    expect(await slugs('_sort=listedAt&_order=desc')).toEqual([third.slug, world.att.slug, world.icloud.slug]);
    expect(await slugs('_sort=listedAt&_order=asc')).toEqual([world.att.slug, third.slug, world.icloud.slug]);
    // No number leaks through the popularity sort.
    expect(JSON.stringify(body(await get('/store/v1/services?_sort=popular')))).not.toContain('sales');
  });

  it('names the other languages of the same service on its page', async () => {
    const { db } = await testDb();
    const world = await storefrontWorld(db);
    expect(body(await get(`/store/v1/services/${world.icloud.slug}`)).alternates).toEqual([]);
    const ar = await insertListing(db, world.icloud.serviceId, { locale: 'ar', slug: 'icloud-ar', publicTitle: 'فحص' });
    await insertListing(db, world.att.serviceId, {
      locale: 'ar',
      slug: 'att-ar-off',
      publicTitle: 'AT&T',
      isListed: false,
    });
    expect(body(await get(`/store/v1/services/${world.icloud.slug}`)).alternates).toEqual([
      { locale: 'ar', slug: 'icloud-ar' },
    ]);
    expect(body(await get('/store/v1/services/icloud-ar?locale=ar')).alternates).toEqual([
      { locale: 'en', slug: world.icloud.slug },
    ]);
    // A page that is switched off is not an alternate.
    expect(body(await get(`/store/v1/services/${world.att.slug}`)).alternates).toEqual([]);
    await db.update(s.serviceListings).set({ isListed: false }).where(eq(s.serviceListings.id, ar));
    expect(body(await get(`/store/v1/services/${world.icloud.slug}`)).alternates).toEqual([]);
  });
});

describe('GET /store/v1/categories', () => {
  it('lists the categories with a sellable listed service in the language, their counts and names, in category order', async () => {
    const { db } = await testDb();
    const world = await storefrontWorld(db);
    await db
      .update(s.serviceCategories)
      .set({ nameAr: 'آبل', sort: 2 })
      .where(eq(s.serviceCategories.id, world.icloud.categoryId));
    const carrierId = (await db.select().from(s.services).where(eq(s.services.id, world.att.serviceId)))[0]!.categoryId;
    await db.update(s.serviceCategories).set({ sort: 1 }).where(eq(s.serviceCategories.id, carrierId));

    const res = await get('/store/v1/categories');
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('public, max-age=30');
    expect(body(res)).toEqual({
      locale: 'en',
      categories: [
        { id: carrierId, slug: `${carrierId}-carrier-unlock`, name: 'Carrier unlock', type: 'imei', serviceCount: 1 },
        {
          id: world.icloud.categoryId,
          slug: `${world.icloud.categoryId}-apple`,
          name: 'Apple',
          type: 'imei',
          serviceCount: 1,
        },
      ],
    });
    // Arabic: only the services with an Arabic page count; the name falls back to the English one.
    await insertListing(db, world.icloud.serviceId, { locale: 'ar', slug: 'icloud-ar', publicTitle: 'فحص' });
    expect(body(await get('/store/v1/categories?locale=ar'))).toEqual({
      locale: 'ar',
      categories: [
        {
          id: world.icloud.categoryId,
          slug: `${world.icloud.categoryId}-apple`,
          name: 'آبل',
          type: 'imei',
          serviceCount: 1,
        },
      ],
    });
    expect((await get('/store/v1/categories?locale=fr')).statusCode).toBe(422);
  });

  it('never counts what the shop cannot sell: B2B-only or inactive categories, unlisted, unpriced or disabled services', async () => {
    const { db } = await testDb();
    const world = await storefrontWorld(db);
    const b2b = await insertCategory(db, { name: 'B2B only', allowedGroupIds: [world.groups.vip] });
    const off = await insertCategory(db, { name: 'Switched off', isActive: false });
    const open = await insertCategory(db, { name: 'Open' });
    const make = async (
      categoryId: number,
      name: string,
      extra: Partial<typeof s.services.$inferInsert> = {},
      price = true,
    ) => {
      const id = await insertService(db, categoryId, {
        name,
        basePrice: '1.0000',
        cost: '0.1000',
        effectiveCost: '0.1000',
        ...extra,
      });
      if (price)
        await db.insert(s.serviceGroupPrices).values({ serviceId: id, groupId: world.groups.retail, price: '5.0000' });
      return id;
    };
    await insertListing(db, await make(b2b, 'a'), { slug: 'a' });
    await insertListing(db, await make(off, 'b'), { slug: 'b' });
    await insertListing(db, await make(open, 'c', { status: 'disabled' }), { slug: 'c' });
    await insertListing(db, await make(open, 'd', {}, false), { slug: 'd' });
    await insertListing(db, await make(open, 'e'), { slug: 'e', isListed: false });
    const ok = await make(open, 'f');
    await insertListing(db, ok, { slug: 'f' });
    const names = body(await get('/store/v1/categories')).categories.map(
      (c: { name: string; serviceCount: number }) => [c.name, c.serviceCount],
    );
    expect(names).toContainEqual(['Open', 1]);
    expect(names.map(([name]: [string]) => name)).not.toContain('B2B only');
    expect(names.map(([name]: [string]) => name)).not.toContain('Switched off');
  });

  it('gives each category a count equal to the list total filtered by it', async () => {
    const { db } = await testDb();
    const world = await storefrontWorld(db);
    const extra = await insertCategory(db, { name: 'Extra' });
    for (const name of ['One', 'Two', 'Three']) {
      const id = await insertService(db, extra, { name, basePrice: '1.0000', cost: '0.1000', effectiveCost: '0.1000' });
      await db.insert(s.serviceGroupPrices).values({ serviceId: id, groupId: world.groups.retail, price: '5.0000' });
      await insertListing(db, id, { slug: name.toLowerCase(), publicTitle: name });
    }
    const { categories } = body(await get('/store/v1/categories'));
    expect(categories.length).toBe(3);
    for (const category of categories as Array<{ id: number; serviceCount: number }>) {
      const res = await get(`/store/v1/services?categoryId=${category.id}&_start=0&_end=1`);
      expect(res.headers['x-total-count']).toBe(String(category.serviceCount));
    }
  });

  it('is empty without a retail group', async () => {
    expect(body(await get('/store/v1/categories'))).toEqual({ locale: 'en', categories: [] });
  });
});

// Integration tests of the public storefront catalog (feature 14a): GET /store/v1/config, /store/v1/services and
// /store/v1/services/:slug against the real API: visibility, the retail price, tax, the exchange rate, filters, paging.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { eq } from 'drizzle-orm';
import { schema as s } from '../../src/infra/db';
import { type TestApp, createTestApp } from '../support/app';
import { TestClock } from '../support/clock';
import { closeTestDb, resetDb, testDb } from '../support/db';
import { insertCurrency, insertListing, insertTaxWindow, storefrontWorld } from '../support/storefront';
import { insertService } from '../support/catalog';

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
      { code: 'crypto', driver: 'nowpayments', name: 'Crypto gateway', audience: 'both' },
      { code: 'bank', driver: 'manual', name: 'Bank transfer', audience: 'b2b', isManual: true },
      { code: 'off', driver: 'stripe', name: 'Switched off', audience: 'b2c', isActive: false },
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

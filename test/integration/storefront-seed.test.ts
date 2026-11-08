// The storefront seed (features 14a and 15): the demo's retail prices, listings, TAC catalogue, pages, help articles and legal
// documents appear with the ids, slugs, titles, statuses, flags and versions of the frontend mocks, through the real admin and
// public routes, and a second run changes nothing.
import { afterAll, beforeAll, beforeEach, describe, expect, it, setDefaultTimeout } from 'bun:test';
import { existsSync } from 'node:fs';
import { eq } from 'drizzle-orm';
import { schema as s } from '../../src/infra/db';
import { seedCatalog } from '../../scripts/seed/catalog';
import { demoStatePath, loadDemoState } from '../../scripts/seed/demo-state';
import { seedIdentity } from '../../scripts/seed/identity';
import { runSeed } from '../../scripts/seed/run';
import { seedStorefront } from '../../scripts/seed/storefront';
import { adminWith } from '../support/admin-api';
import { type AdminApi } from '../support/admin-api';
import { type TestApp, createTestApp } from '../support/app';
import { clearIdentityCaches } from '../support/auth';
import { TestClock } from '../support/clock';
import { closeTestDb, resetDb, testDb } from '../support/db';
import { freshClientIp } from '../support/pipeline-routes';
import { TURNSTILE_HEADERS } from '../support/storefront';

setDefaultTimeout(180_000);

const frontendPresent = existsSync(demoStatePath());
const clock = new TestClock();
let t: TestApp;
let admin: AdminApi;

/** Runs the seeders the console block needs: identity (the retail group), catalog (the services) and storefront. */
async function seed() {
  const { db } = await testDb();
  const demo = await loadDemoState();
  return db.transaction(async (tx) => {
    await seedIdentity(tx, demo);
    await seedCatalog(tx, demo);
    return seedStorefront(tx, demo);
  });
}

beforeAll(async () => {
  if (!frontendPresent) return;
  t = await createTestApp({ clock });
});
afterAll(async () => {
  if (!frontendPresent) return;
  await resetDb();
  await clearIdentityCaches(t);
  await t.close();
  await closeTestDb();
});

describe.skipIf(!frontendPresent)('the storefront seed through the console routes', () => {
  beforeEach(async () => {
    await resetDb();
    await clearIdentityCaches(t);
    admin = await adminWith(t, ['storefront:*', 'legal:*']);
  });

  it('writes the demo listings with their ids and retail prices, and the console reads them back with figures that agree', async () => {
    const reports = await seed();
    expect(reports.map((r) => [r.table, r.inserted])).toEqual([
      ['service_group_prices', 14],
      ['service_listings', 14],
      ['tac_catalog', 8],
      ['content_pages', 20],
      ['help_articles', 12],
      ['legal_documents', 7],
    ]);
    const listings = await admin.get('/admin/service-listings?_start=0&_end=200&_sort=id&_order=asc');
    expect(listings.total).toBe(14);
    const att = listings.body.find((row: { slug: string }) => row.slug === 'atandt-usa-premier-unlock');
    expect(att).toMatchObject({
      id: 5,
      serviceId: 5,
      publicTitle: 'AT&T USA Premier Unlock',
      isListed: true,
      isFeatured: true,
      retailPrice: '25.9900',
      floorPrice: '19.0100',
      service: { id: 5, code: 'IMEI-ATT-USA', basePrice: '17.2800', cost: '13.5000' },
      locked: false,
    });
    // The retail price is never under the floor the PATCH route would enforce.
    for (const row of listings.body as Array<{ retailPrice: string | null; floorPrice: string }>) {
      if (row.retailPrice !== null) expect(Number(row.retailPrice)).toBeGreaterThanOrEqual(Number(row.floorPrice));
    }
    // The tab's counts: 11 on the site (the demo's three unlisted services stay off); the disabled Xiaomi service is locked.
    expect((await admin.get('/admin/service-listings?isListed=true&_start=0&_end=1')).total).toBe(11);
    const xiaomi = listings.body.find((row: { serviceId: number }) => row.serviceId === 14);
    expect(xiaomi).toMatchObject({ isListed: false, locked: true, lockedReason: 'Service disabled' });
  });

  it('writes the 14 landing pages then the 6 content pages and serves the published ones publicly', async () => {
    await seed();
    const pages = await admin.get('/admin/content-pages?_start=0&_end=200&_sort=id&_order=asc');
    expect(pages.total).toBe(20);
    expect(pages.body[0]).toMatchObject({
      id: 1,
      kind: 'carrier',
      slug: 'unlock-iphone-on-atandt',
      status: 'published',
    });
    expect(
      pages.body.slice(14).map((p: { slug: string; kind: string; status: string }) => [p.slug, p.kind, p.status]),
    ).toEqual([
      ['about', 'static', 'published'],
      ['how-it-works', 'static', 'published'],
      ['contact', 'static', 'published'],
      ['is-my-iphone-locked', 'blog', 'published'],
      ['phone-blacklisted-why', 'blog', 'published'],
      ['unlock-vs-jailbreak', 'blog', 'draft'],
    ]);
    expect((await admin.get('/admin/content-pages?kind=static&kind=blog&_start=0&_end=1')).total).toBe(6);
    expect((await t.app.inject({ method: 'GET', url: '/store/v1/pages/about' })).statusCode).toBe(200);
    expect((await t.app.inject({ method: 'GET', url: '/store/v1/pages/unlock-vs-jailbreak' })).statusCode).toBe(404);
  });

  it('writes the 12 help articles (one draft) and the 7 legal versions, with the current ones public', async () => {
    await seed();
    const help = await admin.get('/admin/help-articles?_start=0&_end=200');
    expect(help.total).toBe(12);
    expect((await admin.get('/admin/help-articles?isPublished=false&_start=0&_end=1')).total).toBe(1);
    const publicHelp = await t.app.inject({ method: 'GET', url: '/store/v1/help?_start=0&_end=200' });
    expect(JSON.parse(publicHelp.body)).toHaveLength(11);

    const legal = await admin.get('/admin/legal-documents?_start=0&_end=200&_sort=id&_order=asc');
    expect(legal.total).toBe(7);
    const groups = (state: 'current' | 'draft' | 'earlier') =>
      legal.body.filter((v: { isCurrent: boolean; effectiveFrom: string | null }) =>
        state === 'current'
          ? v.isCurrent
          : state === 'draft'
            ? !v.isCurrent && v.effectiveFrom === null
            : !v.isCurrent && v.effectiveFrom !== null,
      );
    expect(groups('current')).toHaveLength(5);
    expect(groups('draft').map((v: { type: string; version: string }) => `${v.type} ${v.version}`)).toEqual([
      'refund 1.5',
    ]);
    expect(groups('earlier').map((v: { type: string; version: string }) => `${v.type} ${v.version}`)).toEqual([
      'terms 3.1',
    ]);
    const terms = JSON.parse((await t.app.inject({ method: 'GET', url: '/store/v1/pages/terms' })).body);
    expect(terms).toMatchObject({ kind: 'legal', legal: { type: 'terms', version: '3.2' } });
    const arabic = JSON.parse((await t.app.inject({ method: 'GET', url: '/store/v1/pages/terms?locale=ar' })).body);
    expect(arabic.legal.version).toBe('3.2');
    // Publishing the seeded draft works and replaces nothing else (no refund version was current).
    const draft = groups('draft')[0];
    expect((await admin.post(`/admin/legal-documents/${draft.id}/publish`)).status).toBe(200);
  });

  it('is idempotent: a second run inserts nothing and keeps the id sequences usable', async () => {
    await seed();
    const again = await seed();
    expect(again.map((r) => r.inserted)).toEqual([0, 0, 0, 0, 0, 0]);
    const { db } = await testDb();
    expect(await db.$count(s.serviceListings)).toBe(14);
    expect(await db.$count(s.contentPages)).toBe(20);
    // A normal insert after the seed takes the next id.
    const res = await admin.post('/admin/help-articles', {
      category: 'Orders',
      question: 'New?',
      answerMd: 'Yes.',
      locale: 'en',
    });
    expect(res.status).toBe(201);
    expect(res.body.id).toBe(13);
    const page = await admin.post('/admin/content-pages', {
      kind: 'static',
      title: 'Careers',
      locale: 'en',
      bodyMd: '',
    });
    expect(page.body.id).toBe(21);
  });
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- test bodies are untyped JSON
const body = (res: { json: () => any }): any => res.json();

describe.skipIf(!frontendPresent)('the storefront seed through the public API', () => {
  beforeAll(async () => {
    await resetDb();
    await clearIdentityCaches(t);
    const { db } = await testDb();
    clock.set(new Date((await loadDemoState()).now));
    await runSeed(db, await loadDemoState(), t.config);
  });

  it('writes the 14 retail prices, the 14 listings, the 8 TAC entries and the 7 legal documents', async () => {
    const { db } = await testDb();
    const [retail] = await db.select().from(s.clientGroups).where(eq(s.clientGroups.kind, 'b2c_retail'));
    const prices = await db.select().from(s.serviceGroupPrices).where(eq(s.serviceGroupPrices.groupId, retail!.id));
    expect(prices).toHaveLength(14);
    expect(await db.select().from(s.serviceListings)).toHaveLength(14);
    expect(await db.select().from(s.tacCatalog)).toHaveLength(8);
    expect(await db.select().from(s.legalDocuments)).toHaveLength(7);
    const [icloud] = await db
      .select()
      .from(s.serviceListings)
      .where(eq(s.serviceListings.slug, 'icloud-clean-lost-check'));
    expect(icloud).toMatchObject({
      id: 1,
      serviceId: 1,
      locale: 'en',
      isListed: true,
      isFeatured: true,
      brand: 'Apple',
    });
    const locked = await db
      .select()
      .from(s.serviceListings)
      .where(eq(s.serviceListings.slug, 'mdm-removal-iphone-premium'));
    expect(locked[0]).toMatchObject({ isListed: false });
    const [iphone] = await db.select().from(s.tacCatalog).where(eq(s.tacCatalog.tac, '35389011'));
    expect(iphone).toMatchObject({
      brand: 'Apple',
      model: 'A2633',
      marketingName: 'iPhone 13',
      releaseYear: 2021,
      source: 'import',
    });
    const current = await db.select().from(s.legalDocuments).where(eq(s.legalDocuments.isCurrent, true));
    expect(current.map((row) => `${row.type}/${row.locale}/${row.version}`).sort()).toEqual([
      'cookies/en/1.0',
      'privacy/en/2.1',
      'refund/en/1.4',
      'terms/ar/3.2',
      'terms/en/3.2',
    ]);
  });

  it('shows through the public API only what the shop can sell: the 11 switched-on pages, priced for the retail group', async () => {
    const res = await t.app.inject({
      method: 'GET',
      url: '/store/v1/services?_end=100&buyerCountry=GB',
      remoteAddress: freshClientIp(),
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['x-total-count']).toBe('11');
    const rows = body(res);
    expect(rows[0]).toMatchObject({
      slug: 'icloud-clean-lost-check',
      isFeatured: true,
      price: { currency: 'USD', net: '3.9900' },
    });
    const att = rows.find((row: { slug: string }) => row.slug === 'atandt-usa-premier-unlock');
    expect(att).toMatchObject({ brand: 'Apple', network: 'AT&T', country: 'US' });
    expect(rows.map((row: { slug: string }) => row.slug)).not.toContain('mdm-removal-iphone-premium');
    // Every price is at least the retail floor of its service.
    for (const row of rows) expect(Number(row.price.net)).toBeGreaterThan(0);
  });

  it('lets a buyer open a checkout and a check an IMEI against the seeded catalogue, end to end', async () => {
    const check = await t.app.inject({
      method: 'POST',
      url: '/store/v1/imei/check',
      headers: TURNSTILE_HEADERS,
      remoteAddress: freshClientIp(),
      payload: { imei: '353890110000004' },
    });
    expect(body(check).device).toMatchObject({ brand: 'Apple', model: 'A2633', marketingName: 'iPhone 13' });
    const opened = await t.app.inject({
      method: 'POST',
      url: '/store/v1/checkout-sessions',
      headers: TURNSTILE_HEADERS,
      remoteAddress: freshClientIp(),
      payload: { serviceId: 1, email: 'Buyer@Mail.example', country: 'GB', currency: 'GBP', imei: '353890110000004' },
    });
    expect(opened.statusCode).toBe(201);
    expect(body(opened).amounts.usd.net).toBe('3.9900');
    const consents = await t.app.inject({
      method: 'POST',
      url: `/store/v1/checkout-sessions/${body(opened).token}/consents`,
      remoteAddress: freshClientIp(),
      payload: {
        consents: [
          { purpose: 'terms', granted: true },
          { purpose: 'privacy', granted: true },
          { purpose: 'withdrawal_waiver', granted: true },
        ],
      },
    });
    expect(consents.statusCode).toBe(201);
    expect(body(consents).consent.complete).toBe(true);
    expect(body(consents).records[0].document).toEqual({ type: 'terms', version: '3.2', locale: 'en' });
  });

  it('refuses to check out or pre-check a seeded service whose page is switched off (the demo locks id 11)', async () => {
    const { db } = await testDb();
    const [retail] = await db.select().from(s.clientGroups).where(eq(s.clientGroups.kind, 'b2c_retail'));
    const off = await db.select().from(s.serviceListings).where(eq(s.serviceListings.isListed, false));
    const offIds = off.map((row) => row.serviceId);
    expect(offIds).toContain(11);
    // The point of the test: each of these has a retail price, so only the missing listing can stop the sale.
    const priced = await db.select().from(s.serviceGroupPrices).where(eq(s.serviceGroupPrices.groupId, retail!.id));
    for (const serviceId of offIds) expect(priced.map((row) => row.serviceId)).toContain(serviceId);
    for (const serviceId of offIds) {
      const opened = await t.app.inject({
        method: 'POST',
        url: '/store/v1/checkout-sessions',
        headers: TURNSTILE_HEADERS,
        remoteAddress: freshClientIp(),
        payload: { serviceId, email: 'buyer@mail.example', country: 'GB', imei: '353890110000004' },
      });
      expect(opened.statusCode, String(serviceId)).toBe(422);
      expect(body(opened).errors[0]).toMatchObject({ field: 'serviceId', code: 'not_available' });
      const checked = await t.app.inject({
        method: 'POST',
        url: '/store/v1/imei/check',
        headers: TURNSTILE_HEADERS,
        remoteAddress: freshClientIp(),
        payload: { imei: '353890110000004', serviceId },
      });
      expect(checked.statusCode, String(serviceId)).toBe(422);
    }
  });

  it('is idempotent: a second run writes nothing', async () => {
    const { db } = await testDb();
    const demo = await loadDemoState();
    const second = await db.transaction((tx) => seedStorefront(tx, demo));
    expect(second.map((report) => report.table)).toEqual([
      'service_group_prices',
      'service_listings',
      'tac_catalog',
      'content_pages',
      'help_articles',
      'legal_documents',
    ]);
    expect(second.filter((report) => report.inserted !== 0)).toEqual([]);
  });
});

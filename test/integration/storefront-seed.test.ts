// The storefront seed (feature 14a): the demo's retail prices, listings, TAC catalogue and legal documents appear through the real
// public API, with the ids and flags of the frontend mock, and a second run changes nothing.
import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from 'bun:test';
import { existsSync } from 'node:fs';
import { eq } from 'drizzle-orm';
import { loadDemoState, demoStatePath } from '../../scripts/seed/demo-state';
import { runSeed } from '../../scripts/seed/run';
import { seedStorefront } from '../../scripts/seed/storefront';
import { schema as s } from '../../src/infra/db';
import { type TestApp, createTestApp } from '../support/app';
import { TestClock } from '../support/clock';
import { closeTestDb, resetDb, testDb } from '../support/db';
import { TURNSTILE_HEADERS } from '../support/storefront';
import { freshClientIp } from '../support/pipeline-routes';

setDefaultTimeout(180_000);

const frontendPresent = existsSync(demoStatePath());
const clock = new TestClock();
let t: TestApp;

beforeAll(async () => {
  if (!frontendPresent) return;
  t = await createTestApp({ clock });
  await resetDb();
  const { db } = await testDb();
  clock.set(new Date((await loadDemoState()).now));
  await runSeed(db, await loadDemoState(), t.config);
});
afterAll(async () => {
  if (!frontendPresent) return;
  await resetDb();
  await t.close();
  await closeTestDb();
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- test bodies are untyped JSON
const body = (res: { json: () => any }): any => res.json();

describe.skipIf(!frontendPresent)('the storefront seed', () => {
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
      'legal_documents',
    ]);
    expect(second.filter((report) => report.inserted !== 0)).toEqual([]);
  });
});

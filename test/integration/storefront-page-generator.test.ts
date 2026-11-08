// Integration tests of the landing-page generator (feature 19, RESOLUTIONS b2c-15): POST /admin/content-pages/generate makes draft pages
// for brand x model x network from the TAC catalogue and the carriers of the listings, skips what exists, refuses a run of more than
// 50 new drafts as a whole, and publishes nothing.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { eq, sql } from 'drizzle-orm';
import { schema as s } from '../../src/infra/db';
import { type AdminApi, adminWith } from '../support/admin-api';
import { type TestApp, createTestApp } from '../support/app';
import { insertCategory, insertService } from '../support/catalog';
import { clearIdentityCaches } from '../support/auth';
import { closeTestDb, resetDb, testDb } from '../support/db';
import { freshClientIp } from '../support/pipeline-routes';
import { insertListing, insertPageRow, storefrontWorld, type StorefrontWorld } from '../support/storefront';

let t: TestApp;
let admin: AdminApi;
let world: StorefrontWorld;

beforeAll(async () => {
  t = await createTestApp();
});
beforeEach(async () => {
  await resetDb();
  await clearIdentityCaches(t);
  const { db } = await testDb();
  world = await storefrontWorld(db);
  // A second listing in Arabic brings the Vodafone network next to the AT&T of the first world.
  await insertListing(db, world.att.serviceId, {
    locale: 'ar',
    slug: 'att-ar',
    carrier: 'Vodafone',
    publicTitle: 'AT&T',
  });
  await db.insert(s.tacCatalog).values([
    { tac: '35389011', brand: 'Apple', model: 'A2633', marketingName: 'iPhone 13', source: 'demo' },
    { tac: '35389012', brand: 'Apple', model: 'A2403', marketingName: 'iPhone 12', source: 'demo' },
    { tac: '35389013', brand: 'Apple', model: 'A2633-B', marketingName: 'iPhone 13', source: 'demo' },
    { tac: '35100001', brand: 'Samsung', model: 'SM-S911B', marketingName: 'Galaxy S23', source: 'demo' },
    { tac: '35100002', brand: 'Samsung', model: 'SM-A546B', marketingName: '  ', source: 'demo' },
  ]);
  admin = await adminWith(t, ['storefront:*']);
});
afterAll(async () => {
  await resetDb();
  await clearIdentityCaches(t);
  await t.close();
  await closeTestDb();
});

const generate = (body: unknown) => admin.post('/admin/content-pages/generate', body);
const pageCount = async () => {
  const { db } = await testDb();
  return (await db.select().from(s.contentPages)).length;
};
const titles = (res: { body: { created: Array<{ title: string }> } }) => res.body.created.map((page) => page.title);

describe('POST /admin/content-pages/generate', () => {
  it('with empty lists makes a draft for every model of every brand on every network of the site', async () => {
    const res = await generate({ brands: [], models: [], networks: [] });
    expect(res.status).toBe(200);
    // Models: the marketing name, else the model code, once per brand; networks: AT&T and Vodafone (the listings' carriers).
    expect(titles(res)).toEqual([
      'Unlock iPhone 12 on AT&T',
      'Unlock iPhone 12 on Vodafone',
      'Unlock iPhone 13 on AT&T',
      'Unlock iPhone 13 on Vodafone',
      'Unlock Galaxy S23 on AT&T',
      'Unlock Galaxy S23 on Vodafone',
      'Unlock SM-A546B on AT&T',
      'Unlock SM-A546B on Vodafone',
    ]);
    expect(res.body.skipped).toBe(0);
    expect(res.body).not.toHaveProperty('unusableModels');
    expect(res.body).not.toHaveProperty('unusableNetworks');
    expect(res.body.created[0]).toMatchObject({
      kind: 'model',
      slug: 'unlock-iphone-12-on-atandt',
      locale: 'en',
      title: 'Unlock iPhone 12 on AT&T',
      status: 'draft',
      publishedAt: null,
      seoTitle: '',
      seoDescription: '',
      canonicalUrl: null,
    });
    expect(res.body.created[0].bodyMd).toContain('# Unlock iPhone 12 on AT&T');
    expect(res.body.created[0].bodyMd).toContain('Apple iPhone 12 locked to AT&T');
    const { db } = await testDb();
    const rows = await db.select().from(s.contentPages).orderBy(s.contentPages.id);
    expect(rows[0]).toMatchObject({
      authorId: admin.staffId,
      templateParams: { brand: 'Apple', model: 'iPhone 12', network: 'AT&T' },
    });
    expect(rows[6]?.templateParams).toEqual({ brand: 'Samsung', model: 'SM-A546B', network: 'AT&T' });
    // Nothing is public: a draft is not served.
    const served = await t.app.inject({
      method: 'GET',
      url: '/store/v1/pages/unlock-iphone-12-on-atandt',
      remoteAddress: freshClientIp(),
    });
    expect(served.statusCode).toBe(404);
  });

  it('narrows by the typed brands (ignoring case) and networks, and splits entries on commas and new lines', async () => {
    const res = await generate({ brands: ['  samsung '], models: [], networks: ['EE, Three\nO2 ', 'ee'] });
    expect(titles(res)).toEqual([
      'Unlock Galaxy S23 on EE',
      'Unlock Galaxy S23 on Three',
      'Unlock Galaxy S23 on O2',
      'Unlock SM-A546B on EE',
      'Unlock SM-A546B on Three',
      'Unlock SM-A546B on O2',
    ]);
    expect(res.body.created.every((page: { bodyMd: string }) => page.bodyMd.includes('Samsung'))).toBe(true);
  });

  it('generates the typed models, in the catalogue brand when it knows them and as typed when it does not', async () => {
    const res = await generate({ brands: [], models: ['iphone 13', 'Fairphone 5'], networks: ['AT&T'] });
    expect(titles(res)).toEqual(['Unlock iPhone 13 on AT&T', 'Unlock Fairphone 5 on AT&T']);
    const { db } = await testDb();
    const rows = await db.select().from(s.contentPages).orderBy(s.contentPages.id);
    expect(rows.map((row) => row.templateParams)).toEqual([
      { brand: 'Apple', model: 'iPhone 13', network: 'AT&T' },
      { brand: '', model: 'Fairphone 5', network: 'AT&T' },
    ]);
    // With exactly one brand typed, an unknown model belongs to it.
    const one = await generate({ brands: ['Fairphone'], models: ['Fairphone 4'], networks: ['EE'] });
    expect(
      (await db.select().from(s.contentPages).where(eq(s.contentPages.id, one.body.created[0].id)))[0]?.templateParams,
    ).toEqual({
      brand: 'Fairphone',
      model: 'Fairphone 4',
      network: 'EE',
    });
  });

  it('skips and counts only the distinct combinations that already have a page, and merges those that repeat inside the run', async () => {
    await insertPageRow(await db(), { slug: 'unlock-iphone-13-on-atandt', locale: 'en', kind: 'model' });
    await insertPageRow(await db(), { slug: 'unlock-iphone-13-on-vodafone', locale: 'ar', kind: 'model' });
    const res = await generate({
      brands: ['Apple'],
      models: ['iPhone 13', 'iPhone-13'],
      networks: ['AT&T', 'Vodafone'],
    });
    expect(res.status).toBe(200);
    // iPhone 13 x AT&T exists; the Arabic page does not block the English one; `iPhone-13` repeats the slugs of `iPhone 13`, which are
    // merged before counting, so only the one page that exists is skipped.
    expect(titles(res)).toEqual(['Unlock iPhone 13 on Vodafone']);
    expect(res.body.skipped).toBe(1);
    const again = await generate({ brands: ['Apple'], models: ['iPhone 13'], networks: ['AT&T', 'Vodafone'] });
    expect(again.body).toEqual({ created: [], skipped: 2 });
  });

  it('counts a page that a parallel run made first as one that already exists', async () => {
    // Two runs over the same 4 combinations at once: a slug that is free when a run looks may be taken when it inserts. Whatever one run
    // does not create, the other did, so each run answers `created + skipped = 4` and never an error.
    const { db } = await testDb();
    const body = { brands: ['Apple'], models: ['iPhone 12', 'iPhone 13'], networks: ['EE', 'Three'] };
    const results = await Promise.all([generate(body), generate(body)]);
    for (const res of results) expect(res.body.created.length + res.body.skipped).toBe(4);
    expect(results.reduce((sum, res) => sum + res.body.created.length, 0)).toBe(4);
    expect((await db.select().from(s.contentPages)).length).toBe(4);
  });

  it('skips a catalogue model whose name cannot make a slug and counts it, instead of refusing the whole run', async () => {
    const { db } = await testDb();
    await db.insert(s.tacCatalog).values([
      { tac: '86000001', brand: 'Apple', model: 'N1', marketingName: 'هاتف', source: 'demo' },
      { tac: '86000002', brand: 'Apple', model: 'N2', marketingName: '苹果', source: 'demo' },
    ]);
    const res = await generate({ brands: ['Apple'], models: [], networks: ['EE'] });
    expect(res.status).toBe(200);
    expect(titles(res)).toEqual(['Unlock iPhone 12 on EE', 'Unlock iPhone 13 on EE']);
    // The two odd names are counted on their own, not as pages that already existed.
    expect(res.body.unusableModels).toBe(2);
    expect(res.body.skipped).toBe(0);
    const [entry] = (await db.select().from(s.auditLogs)).filter((row) => row.action === 'generated landing pages');
    expect(entry?.after).toMatchObject({ created: 2, skipped: 0, unusableModels: 2 });
    // An 'all' run over the whole catalogue is not refused either.
    const all = await generate({ brands: [], models: [], networks: ['Three'] });
    expect(all.status).toBe(200);
    expect(all.body.unusableModels).toBe(2);
  });

  it('skips a carrier of the listings that cannot make a slug and counts it, instead of refusing the whole "all networks" run', async () => {
    const { db } = await testDb();
    // Two more services (a listing is one per service and language), each sold under a carrier with no Latin letter or digit.
    const category = await insertCategory(db, { name: 'Odd carriers' });
    for (const [slug, carrier] of [
      ['odd-carrier-1', 'شبكة'],
      ['odd-carrier-2', '网络'],
    ] as const) {
      await insertListing(db, await insertService(db, category), { slug, carrier });
    }
    const res = await generate({ brands: ['Apple'], models: ['iPhone 12'], networks: [] });
    expect(res.status).toBe(200);
    expect(titles(res)).toEqual(['Unlock iPhone 12 on AT&T', 'Unlock iPhone 12 on Vodafone']);
    // The two odd carriers are counted on their own, not as pages that already existed.
    expect(res.body.unusableNetworks).toBe(2);
    expect(res.body).not.toHaveProperty('unusableModels');
    expect(res.body.skipped).toBe(0);
    const [entry] = (await db.select().from(s.auditLogs)).filter((row) => row.action === 'generated landing pages');
    expect(entry?.after).toMatchObject({ created: 2, skipped: 0, unusableModels: 0, unusableNetworks: 2 });
  });

  it('refuses a run whose catalogue is longer than 20 000 models even when one name is unusable', async () => {
    const { db } = await testDb();
    // 20 001 usable names and one that makes no slug: the catalogue read stops at 20 001 rows, which holds that name first. Dropping it
    // before the check would leave 20 000 and let a cut-off catalogue pass as if it were whole.
    await db.execute(sql`
      insert into tac_catalog (tac, brand, model, marketing_name, source)
      select (88000000 + n)::text, 'Bulk', 'B' || n, 'Bulk ' || lpad(n::text, 6, '0'), 'demo' from generate_series(1, 20001) as n`);
    await db.insert(s.tacCatalog).values({ tac: '89000000', brand: 'Bulk', model: '***', source: 'demo' });
    const detail = 'This run would create 20001 pages; the limit is 50 per run. Narrow the lists.';
    const typed = await generate({ brands: ['Bulk'], models: [], networks: ['EE'] });
    expect(typed.status).toBe(422);
    expect(typed.body.detail).toBe(detail);
    expect(typed.body.errors ?? []).toEqual([]);
    // No carrier on the site: the product would be 0, yet the catalogue is still too long to judge.
    await db.delete(s.serviceListings);
    const none = await generate({ brands: ['Bulk'], models: [], networks: [] });
    expect(none.status).toBe(422);
    expect(none.body.detail).toBe(detail);
    expect(await pageCount()).toBe(0);
  }, 60_000);

  it('refuses a run that would create more than 50 new drafts, whole, with the count in the detail and no field', async () => {
    const models = Array.from({ length: 17 }, (_, i) => `Model ${i + 1}`);
    const res = await generate({ brands: [], models, networks: ['AT&T', 'EE', 'Three'] });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('VALIDATION_FAILED');
    expect(res.body.detail).toBe('This run would create 51 pages; the limit is 50 per run. Narrow the lists.');
    expect(res.body.errors ?? []).toEqual([]);
    expect(await pageCount()).toBe(0);
    // The audit log has no entry for the refused call (its transaction rolled back).
    const { db } = await testDb();
    expect((await db.select().from(s.auditLogs)).filter((row) => row.action === 'generated landing pages')).toEqual([]);
  });

  it('allows exactly 50, and counts the combinations that already have a page before it judges the cap', async () => {
    const models = Array.from({ length: 17 }, (_, i) => `Model ${i + 1}`);
    await insertPageRow(await db(), { slug: 'unlock-model-1-on-atandt', locale: 'en', kind: 'model' });
    const res = await generate({ brands: [], models, networks: ['AT&T', 'EE', 'Three'] });
    expect(res.status).toBe(200);
    expect(res.body.created).toHaveLength(50);
    expect(res.body.skipped).toBe(1);
    expect(await pageCount()).toBe(51);
    const next = await generate({ brands: [], models: [...models, 'Model 18'], networks: ['AT&T', 'EE', 'Three'] });
    expect(next.body.created).toHaveLength(3);
    expect(next.body.skipped).toBe(51);
  });

  it('writes one audit entry with the count and the ids', async () => {
    const res = await generate({ brands: ['Apple'], models: ['iPhone 12'], networks: ['EE', 'Three'] });
    const { db } = await testDb();
    const [entry] = (await db.select().from(s.auditLogs)).filter((row) => row.action === 'generated landing pages');
    expect(entry).toMatchObject({
      entityType: 'content_page',
      entityLabel: '2 drafts',
      actorType: 'staff',
      actorId: admin.staffId,
      after: {
        created: 2,
        skipped: 0,
        unusableModels: 0,
        unusableNetworks: 0,
        pageIds: res.body.created.map((page: { id: number }) => page.id),
      },
    });
  });

  it('answers an empty result, and still audits, when the site knows no network', async () => {
    const { db } = await testDb();
    await db.delete(s.serviceListings);
    const res = await generate({ brands: [], models: [], networks: [] });
    expect(res.body).toEqual({ created: [], skipped: 0 });
    expect(
      (await db.select().from(s.auditLogs)).filter((row) => row.action === 'generated landing pages'),
    ).toHaveLength(1);
  });

  it('refuses a run over 20 000 combinations with the cap sentence and no field, and creates nothing', async () => {
    const { db } = await testDb();
    // 201 catalogue models x 100 typed networks = 20 100 combinations, over the safety bound.
    await db.insert(s.tacCatalog).values(
      Array.from({ length: 200 }, (_, i) => ({
        tac: String(87000000 + i),
        brand: 'Bulk',
        model: `B${i}`,
        marketingName: `Bulk ${i}`,
        source: 'demo',
      })),
    );
    await db.insert(s.tacCatalog).values({ tac: '87000999', brand: 'Bulk', model: 'B999', source: 'demo' });
    const networks = Array.from({ length: 100 }, (_, i) => `Net ${i}`);
    const res = await generate({ brands: ['Bulk'], models: [], networks });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('VALIDATION_FAILED');
    expect(res.body.detail).toBe('This run would create 20100 pages; the limit is 50 per run. Narrow the lists.');
    expect(res.body.errors ?? []).toEqual([]);
    expect(await pageCount()).toBe(0);
  });

  it('refuses a typed model or network that cannot make a web address with a 422 on its list', async () => {
    const model = await generate({ brands: [], models: ['هاتف'], networks: ['EE'] });
    expect(model.status).toBe(422);
    expect(model.body.errors[0]).toMatchObject({ field: 'models', code: 'no_slug' });
    const network = await generate({ brands: [], models: ['iPhone 12'], networks: ['شبكة'] });
    expect(network.body.errors[0]).toMatchObject({ field: 'networks' });
    expect(await pageCount()).toBe(0);
  });

  it('refuses a body that is not three lists of short names', async () => {
    for (const [body, field] of [
      [{ brands: 'Apple', models: [], networks: [] }, 'brands'],
      [{ brands: [], models: [1], networks: [] }, 'models.0'],
      [{ brands: [], models: [], networks: ['x'.repeat(61)] }, 'networks.0'],
      [{ brands: Array.from({ length: 101 }, () => 'a'), models: [], networks: [] }, 'brands'],
    ] as const) {
      const res = await generate(body);
      expect(res.status, field).toBe(422);
      expect(res.body.errors[0].field, field).toBe(field);
    }
    expect((await generate({ brands: [], models: [] })).status).toBe(422);
  });

  it('makes each draft once when two requests run at the same time', async () => {
    const body = { brands: ['Apple'], models: ['iPhone 12', 'iPhone 13'], networks: ['EE', 'Three'] };
    const other = await adminWith(t, ['storefront:create']);
    const results = await Promise.all([
      generate(body),
      other.post('/admin/content-pages/generate', body),
      generate(body),
    ]);
    for (const res of results) expect(res.status).toBe(200);
    expect(results.reduce((sum, res) => sum + res.body.created.length, 0)).toBe(4);
    expect(await pageCount()).toBe(4);
  });

  it('needs storefront:create and a CSRF token', async () => {
    const reader = await adminWith(t, ['storefront:read', 'storefront:update', 'storefront:publish']);
    const refused = await reader.post('/admin/content-pages/generate', { brands: [], models: [], networks: [] });
    expect(refused.status).toBe(403);
    expect(refused.body.code).toBe('FORBIDDEN');
    const creator = await adminWith(t, ['storefront:create']);
    expect(
      (await creator.withoutCsrf('POST', '/admin/content-pages/generate', { brands: [], models: [], networks: [] }))
        .status,
    ).toBe(403);
    expect((await creator.post('/admin/content-pages/generate', { brands: [], models: [], networks: [] })).status).toBe(
      200,
    );
  });
});

/** The test database handle. */
async function db() {
  return (await testDb()).db;
}

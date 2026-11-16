// Integration tests of the storefront search index (feature 29, slice B1) on real Postgres, Redis and Typesense: every writer's event in
// its own transaction, the sync of each change, the reconcile, the rebuild with its alias swap, the not-ready path, the keys, the locks and
// the switch. The suite works under its own Typesense sub-prefix of the worktree's prefix and drops it in afterAll.
import { afterAll, beforeAll, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import { randomBytes } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { Redis } from 'ioredis';
import { DbService, schema as s } from '../../src/infra/db';
import { QueuesService } from '../../src/infra/queues';
import { SearchUnavailable, TypesenseClient } from '../../src/infra/search';
import { CatalogSignals, InventoryStock, ServiceImporter } from '../../src/modules/catalog';
import { SearchNames } from '../../src/modules/storefront';
import { SearchDocuments } from '../../src/modules/storefront/search/application/search-documents';
import { SearchLocks } from '../../src/modules/storefront/search/application/search-locks';
import { SearchSync } from '../../src/modules/storefront/search/application/search-sync';
import {
  SearchRebuildProcessor,
  SearchReconcileProcessor,
  SearchTermsBuildProcessor,
  SearchTermsFlushProcessor,
  SearchTermsPurgeProcessor,
} from '../../src/modules/storefront/search/jobs/search-maintenance.processors';
import { dayKey, dayOf, termId } from '../../src/modules/storefront/search/domain/terms';
import { CacheKeys } from '../../src/infra/cache';
import { RedisService } from '../../src/infra/redis';
import { SearchSyncProcessor } from '../../src/modules/storefront/search/jobs/search-index.processor';
import { ensureSearchKeys, scriptClient } from '../../scripts/search-keys';
import { type AdminApi, adminWith } from '../support/admin-api';
import { clearIdentityCaches } from '../support/auth';
import { insertCategory, insertService } from '../support/catalog';
import { TestClock } from '../support/clock';
import { closeTestDb, resetDb, testDb } from '../support/db';
import { deleteBullKeys } from '../support/queues';
import { expectRejection } from '../support/rejection';
import {
  SEARCH_TEST_URL,
  type SearchTestApp,
  createSearchTestApp,
  dropSearchPrefix,
  engineClient,
  indexedIds,
  resetSearchOutbox,
  runSearchOutbox,
  searchEvents,
} from '../support/search';
import {
  insertCustomerRow,
  insertListing,
  insertRetailPrice,
  insertStoreOrder,
  storefrontWorld,
} from '../support/storefront';

const clock = new TestClock('2026-11-16T10:00:00.000Z');
let t: SearchTestApp;
let admin: AdminApi;
let names: SearchNames;
const engine = engineClient();

const job = (data: object, extra: Record<string, unknown> = {}) =>
  ({ name: 'test', data, timestamp: clock.nowMs(), ...extra }) as never;
const rebuild = () => t.app.get(SearchRebuildProcessor, { strict: false }).process(job({}));
const reconcile = () => t.app.get(SearchReconcileProcessor, { strict: false }).process(job({}));
const db = async () => (await testDb()).db;
const aliasTarget = async () => (await engine.getAlias(names.alias('services')))?.collection_name ?? null;
const servicesCollections = async () =>
  (await engine.listCollections(t.prefix))
    .map((entry) => entry.name)
    .filter((name) => names.parse(name)?.kind === 'services');

/** The jobs the app put on a queue under its BullMQ prefix. */
async function queuedJobs(queue: 'search-index' | 'maintenance') {
  return t.app.get(QueuesService).queue(queue).getJobs(['waiting', 'delayed', 'prioritized']);
}

beforeAll(async () => {
  t = await createSearchTestApp({ clock });
  names = new SearchNames(t.prefix);
});

beforeEach(async () => {
  await resetDb();
  resetSearchOutbox(t);
  await clearIdentityCaches(t);
  admin = await adminWith(t, ['catalog:*', 'pricing:*', 'inventory:*', 'groups:*', 'storefront:*']);
  await t.app.get(QueuesService).queue('search-index').obliterate({ force: true });
  await t.app.get(QueuesService).queue('maintenance').obliterate({ force: true });
});

afterAll(async () => {
  await dropSearchPrefix(t.prefix);
  const redis = new Redis(t.config.redis.queueUrl);
  await deleteBullKeys(redis, t.bullPrefix);
  redis.disconnect();
  await resetDb();
  await t.close();
  await closeTestDb();
});

describe('the change signals (each writer, in its own transaction)', () => {
  it('writes one event per change of the catalog and the listings, and none for a refused request', async () => {
    const world = await storefrontWorld(await db());
    const { icloud, att } = world;
    const before = (await searchEvents()).length;
    expect((await admin.patch(`/admin/services/${icloud.serviceId}`, { name: 'iCloud Check v2' })).status).toBe(200);
    expect(
      (
        await admin.put(`/admin/services/${icloud.serviceId}/group-prices`, {
          prices: [{ groupId: world.groups.retail, price: '4.9900' }],
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await admin.put(`/admin/services/${att.serviceId}/options`, {
          options: [{ list: 'network', value: 'att', label: 'AT&T', supplierValue: '' }],
        })
      ).status,
    ).toBe(200);
    const imported = await admin.post(`/admin/services/${att.serviceId}/inventory/import`, { codes: ['CODE-0001'] });
    expect(imported.status).toBe(200);
    const [code] = await (await db()).select().from(s.inventoryCodes);
    expect((await admin.post('/admin/inventory-codes/void', { ids: [code!.id] })).status).toBe(200);
    expect((await admin.patch(`/admin/service-categories/${icloud.categoryId}`, { sort: 3 })).status).toBe(200);
    expect((await admin.patch(`/admin/service-listings/${att.listingId}`, { summary: 'New words' })).status).toBe(200);
    // Refused before any write: no event.
    expect((await admin.patch(`/admin/service-listings/${att.listingId}`, { retailPrice: '0.0000' })).status).toBe(422);
    expect((await admin.patch(`/admin/services/999999`, { name: 'Nobody' })).status).toBe(404);

    const events = (await searchEvents()).slice(before);
    expect(events.map((event) => [event.type, event.payload])).toEqual([
      ['catalog.services_changed', { serviceIds: [icloud.serviceId], reason: 'service' }],
      ['catalog.services_changed', { serviceIds: [icloud.serviceId], reason: 'price' }],
      ['catalog.services_changed', { serviceIds: [att.serviceId], reason: 'options' }],
      ['catalog.services_changed', { serviceIds: [att.serviceId], reason: 'stock' }],
      ['catalog.services_changed', { serviceIds: [att.serviceId], reason: 'stock' }],
      ['catalog.category_changed', { categoryId: icloud.categoryId }],
      ['storefront.listing_changed', { serviceIds: [att.serviceId] }],
    ]);
  });

  it('writes the event of a service created, archived and deleted, a category deleted and a listing created; none for a refused delete', async () => {
    const database = await db();
    const world = await storefrontWorld(database);
    // A service with an order is archived; a fresh service nothing refers to is deleted.
    await insertStoreOrder(database, world.att.serviceId, await insertCustomerRow(database));
    const unreferenced = await insertService(database, world.icloud.categoryId, {
      name: 'Nobody uses',
      code: 'UNUSED',
    });
    const empty = await insertCategory(database, { name: 'Empty' });
    const before = (await searchEvents()).length;

    const created = await admin.post('/admin/services', {
      name: 'Samsung FRP Remove',
      code: 'IMEI-FRP-1',
      categoryId: world.icloud.categoryId,
      type: 'imei',
      slaMinutes: 90,
      basePrice: '2.5000',
    });
    expect(created.status).toBe(201);
    const newId = created.body.id as number;
    expect((await admin.delete(`/admin/services/${world.att.serviceId}`)).status).toBe(204);
    const [archived] = await database.select().from(s.services).where(eq(s.services.id, world.att.serviceId));
    expect(archived?.archivedAt).not.toBeNull();
    expect((await admin.delete(`/admin/services/${unreferenced}`)).status).toBe(204);
    expect(await database.select().from(s.services).where(eq(s.services.id, unreferenced))).toEqual([]);
    expect((await admin.delete(`/admin/service-categories/${empty}`)).status).toBe(204);
    // Refused as in use (the category still holds live services): the transaction rolls back with its event.
    const refused = await admin.delete(`/admin/service-categories/${world.icloud.categoryId}`);
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe('CATEGORY_IN_USE');
    await insertRetailPrice(database, newId, world.groups.retail, '9.9900');
    expect(
      (
        await admin.post('/admin/service-listings', {
          serviceId: newId,
          locale: 'en',
          publicTitle: 'Samsung FRP Remove',
        })
      ).status,
    ).toBe(201);

    const events = (await searchEvents()).slice(before);
    expect(events.map((event) => [event.type, event.payload])).toEqual([
      ['catalog.services_changed', { serviceIds: [newId], reason: 'service' }],
      ['catalog.services_changed', { serviceIds: [world.att.serviceId], reason: 'service' }],
      ['catalog.services_changed', { serviceIds: [unreferenced], reason: 'service' }],
      ['catalog.category_changed', { categoryId: empty }],
      ['storefront.listing_changed', { serviceIds: [newId] }],
    ]);
  });

  it('writes one category event per category a deleted group leaves, and none after a rollback; 120 ids give 3 events', async () => {
    const database = await db();
    const world = await storefrontWorld(database);
    const [vip] = await database.insert(s.clientGroups).values({ name: 'Partners', sort: 9 }).returning();
    const a = await insertCategory(database, { name: 'Only partners A', allowedGroupIds: [vip!.id] });
    const b = await insertCategory(database, { name: 'Only partners B', allowedGroupIds: [vip!.id, world.groups.vip] });
    const before = (await searchEvents()).length;
    expect((await admin.delete(`/admin/client-groups/${vip!.id}`)).status).toBe(204);
    expect((await searchEvents()).slice(before).map((event) => event.payload)).toEqual([
      { categoryId: a },
      { categoryId: b },
    ]);

    const signals = t.app.get(CatalogSignals, { strict: false });
    const service = t.app.get(DbService);
    const ids = Array.from({ length: 120 }, (_, i) => i + 1);
    await service.runInTransaction(({ tx }) => signals.servicesChanged(tx, ids, 'service'));
    const chunked = (await searchEvents()).slice(before + 2);
    expect(chunked.map((event) => (event.payload.serviceIds as number[]).length)).toEqual([50, 50, 20]);
    const count = (await searchEvents()).length;
    await expectRejection(
      service.runInTransaction(async ({ tx }) => {
        await signals.servicesChanged(tx, [1, 2, 3], 'price');
        throw new Error('rolled back');
      }),
      'rolled back',
    );
    expect((await searchEvents()).length).toBe(count);
  });

  it('writes a stock event in the placement transaction of a claim, and none for a Quick add import', async () => {
    const database = await db();
    const world = await storefrontWorld(database);
    expect(
      (
        await admin.post(`/admin/services/${world.att.serviceId}/inventory/import`, {
          codes: ['CODE-0001', 'CODE-0002'],
        })
      ).status,
    ).toBe(200);
    const before = (await searchEvents()).length;
    const service = t.app.get(DbService);
    await service.runInTransaction(({ tx }) =>
      t.app.get(InventoryStock, { strict: false }).claim(tx, world.att.serviceId, 1),
    );
    expect((await searchEvents()).slice(before).map((event) => event.payload)).toEqual([
      { serviceIds: [world.att.serviceId], reason: 'stock' },
    ]);
    await service.runInTransaction(({ tx }) =>
      t.app.get(ServiceImporter, { strict: false }).create(tx, {
        supplierServiceId: 77,
        type: 'imei',
        name: 'Imported Unlock',
        group: 'Imported',
        time: '1 day',
        cost: '1.0000',
        basePrice: '2.0000',
        slaMinutes: 60,
        quantity: { minQty: 1, maxQty: 1, qtyOptions: [] },
        fields: [],
      }),
    );
    expect((await searchEvents()).length).toBe(before + 1);
  });
});

describe('the sync (search_sync through the alias)', () => {
  it('rebuilds only the searchable services: English and listed, retail priced, sellable; the alias links both sets', async () => {
    const database = await db();
    const world = await storefrontWorld(database);
    const arabicOnly = await insertService(database, world.icloud.categoryId, { name: 'Arabic only', code: 'AR-ONLY' });
    await insertRetailPrice(database, arabicOnly, world.groups.retail, '5.0000');
    await insertListing(database, arabicOnly, { locale: 'ar', publicTitle: 'فك شبكة', slug: 'ar-only' });
    const unlisted = await insertService(database, world.icloud.categoryId, { name: 'Unlisted', code: 'UNLISTED' });
    await insertRetailPrice(database, unlisted, world.groups.retail, '5.0000');
    await insertListing(database, unlisted, { publicTitle: 'Unlisted unlock', isListed: false });
    const unpriced = await insertService(database, world.icloud.categoryId, { name: 'Unpriced', code: 'UNPRICED' });
    await insertListing(database, unpriced, { publicTitle: 'Unpriced unlock' });
    await database.insert(s.searchSynonyms).values({ kind: 'multi', terms: ['frp', 'google account lock'] });

    const report = await rebuild();
    expect(report).toMatchObject({ outcome: 'rebuilt', documents: 2 });
    expect(await indexedIds(t.prefix)).toEqual([String(world.icloud.serviceId), String(world.att.serviceId)]);
    const collection = await engine.getCollection((await aliasTarget())!);
    expect(collection?.synonym_sets).toEqual([names.synonymSet]);
    expect(collection?.curation_sets).toEqual([names.curationSet]);
    const [state] = await database.select().from(s.searchIndexState);
    expect(state).toMatchObject({
      documents: 2,
      schemaVersion: 1,
      servicesCollection: collection?.name,
      lastError: null,
    });
    // The documents hold no price: the search answers ids and public words only.
    const hit = await engine.search(names.alias('services'), { q: 'att', query_by: 'title,brand,carrier' });
    expect(JSON.stringify(hit.hits[0]?.document)).not.toMatch(/25\.99|17\.28|13\.5/);
  });

  it('follows a listing switched off, on, retitled, and English off with Arabic on', async () => {
    const database = await db();
    const world = await storefrontWorld(database);
    await rebuild();
    const att = String(world.att.serviceId);
    expect((await admin.patch(`/admin/service-listings/${world.att.listingId}`, { isListed: false })).status).toBe(200);
    await runSearchOutbox(t);
    expect(await indexedIds(t.prefix)).not.toContain(att);
    expect((await admin.patch(`/admin/service-listings/${world.att.listingId}`, { isListed: true })).status).toBe(200);
    await runSearchOutbox(t);
    expect(await indexedIds(t.prefix)).toContain(att);
    expect(
      (await admin.patch(`/admin/service-listings/${world.att.listingId}`, { publicTitle: 'Cricket Wireless Unlock' }))
        .status,
    ).toBe(200);
    await runSearchOutbox(t);
    expect(await indexedIds(t.prefix, 'cricket')).toEqual([att]);

    await insertListing(database, world.att.serviceId, { locale: 'ar', publicTitle: 'فك شبكة', slug: 'att-ar' });
    expect((await admin.patch(`/admin/service-listings/${world.att.listingId}`, { isListed: false })).status).toBe(200);
    await runSearchOutbox(t);
    expect(await indexedIds(t.prefix)).toEqual([String(world.icloud.serviceId)]);
  });

  it('follows a category switched off, a group price set without the retail row, a stock sale and a missing first publication', async () => {
    const database = await db();
    const world = await storefrontWorld(database);
    await rebuild();
    const icloud = String(world.icloud.serviceId);
    const att = String(world.att.serviceId);
    expect(
      (await admin.patch(`/admin/service-categories/${world.icloud.categoryId}`, { isActive: false })).status,
    ).toBe(200);
    await runSearchOutbox(t);
    expect(await indexedIds(t.prefix)).toEqual([att]);

    expect((await admin.put(`/admin/services/${world.att.serviceId}/group-prices`, { prices: [] })).status).toBe(200);
    await runSearchOutbox(t);
    expect(await indexedIds(t.prefix)).toEqual([]);
    expect(
      (
        await admin.put(`/admin/services/${world.att.serviceId}/group-prices`, {
          prices: [{ groupId: world.groups.retail, price: '25.9900' }],
        })
      ).status,
    ).toBe(200);
    expect((await admin.patch(`/admin/service-categories/${world.icloud.categoryId}`, { isActive: true })).status).toBe(
      200,
    );
    await runSearchOutbox(t);
    expect(await indexedIds(t.prefix)).toEqual([icloud, att]);

    const inStock = async () => indexedIds(t.prefix, '*', { filter_by: 'in_stock:true' });
    expect(await inStock()).toEqual([]);
    expect(
      (await admin.post(`/admin/services/${world.att.serviceId}/inventory/import`, { codes: ['CODE-0009'] })).status,
    ).toBe(200);
    await runSearchOutbox(t);
    expect(await inStock()).toEqual([att]);
    await t.app.get(DbService).runInTransaction(({ tx }) =>
      t.app
        .get(InventoryStock, { strict: false })
        .claim(tx, world.att.serviceId, 1)
        .then(async (claim) => {
          await tx.update(s.inventoryCodes).set({ status: 'sold' }).where(eq(s.inventoryCodes.id, claim!.ids[0]!));
        }),
    );
    await runSearchOutbox(t);
    expect(await inStock()).toEqual([]);

    const [listing] = await database
      .select()
      .from(s.serviceListings)
      .where(eq(s.serviceListings.id, world.icloud.listingId));
    expect(listing?.listedAt).toBeNull();
    const document = (await engine.search(names.alias('services'), { q: '*', filter_by: `id:=${icloud}` })).hits[0]
      ?.document as { listed_at: number };
    expect(document.listed_at).toBe(Math.floor(listing!.createdAt.getTime() / 1000));
  });

  it('keeps the other documents when the engine refuses one line, and records the refused id', async () => {
    const database = await db();
    const world = await storefrontWorld(database);
    await database
      .update(s.serviceListings)
      .set({ country: '' })
      .where(eq(s.serviceListings.id, world.icloud.listingId));
    // A collection that requires `country`: the iCloud check has none, the AT&T unlock has US.
    const strict = `${t.prefix}strict_test`;
    await engine.createCollection({
      name: strict,
      fields: [
        { name: 'title', type: 'string' },
        { name: 'country', type: 'string' },
        { name: 'popularity', type: 'int32' },
        { name: '.*', type: 'auto' as never },
      ],
    });
    await engine.putAlias(names.alias('services'), strict);
    const result = await t.app.get(SearchSync, { strict: false }).run({
      serviceIds: [world.icloud.serviceId, world.att.serviceId],
    });
    expect(result).toMatchObject({ outcome: 'synced', upserted: 1, rejected: 1 });
    expect(await engine.getCollection(strict)).toMatchObject({ num_documents: 1 });
    const [state] = await database.select().from(s.searchIndexState);
    expect(state?.lastError).toContain(`document ${world.icloud.serviceId}:`);
    await engine.deleteAlias(names.alias('services'));
    await engine.dropCollection(strict);
  });
});

describe('the reconcile and the rebuild', () => {
  it('turns a deleted and a stale document into search_sync jobs without writing, and the jobs repair them', async () => {
    const database = await db();
    const world = await storefrontWorld(database);
    await rebuild();
    const icloud = String(world.icloud.serviceId);
    const att = String(world.att.serviceId);
    await engine.deleteByIds(names.alias('services'), [icloud]);
    await engine.importJsonl(names.alias('services'), [{ id: att, hash: 'stale' }], 'update');
    const report = await reconcile();
    expect(report).toMatchObject({
      outcome: 'reconciled',
      indexed: 1,
      expected: 2,
      changed: 1,
      missing: 1,
      extra: 0,
      jobs: 1,
    });
    expect(await indexedIds(t.prefix)).toEqual([att]);
    const jobs = await queuedJobs('search-index');
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.id).toStartWith('reconcile-');
    expect(jobs[0]?.data).toMatchObject({ serviceIds: [world.icloud.serviceId, world.att.serviceId] });
    await t.app.get(SearchSyncProcessor, { strict: false }).process(job(jobs[0]!.data));
    expect(await indexedIds(t.prefix)).toEqual([icloud, att]);
    expect(await reconcile()).toMatchObject({ changed: 0, missing: 0, extra: 0, jobs: 0 });
    const [state] = await database.select().from(s.searchIndexState);
    expect(state?.engineVersion).toMatch(/^\d+\.\d+/);
    expect(state?.lastReconcileAt?.toISOString()).toBe(clock.now().toISOString());
  });

  it('swaps the alias with no failed search, drops the old and orphan collections, and keeps both set links', async () => {
    const database = await db();
    await storefrontWorld(database);
    await rebuild();
    const first = await aliasTarget();
    const orphan = `${t.prefix}services_v1_20000101000000`;
    await engine.createCollection({ name: orphan, fields: [{ name: 'title', type: 'string' }] });
    let failures = 0;
    let searches = 0;
    let running = true;
    const loop = (async () => {
      while (running) {
        try {
          await engine.search(names.alias('services'), { q: 'unlock', query_by: 'title' });
        } catch {
          failures += 1;
        }
        searches += 1;
      }
    })();
    clock.advance(1_000);
    await rebuild();
    clock.advance(1_000);
    await rebuild();
    running = false;
    await loop;
    expect(searches).toBeGreaterThan(0);
    expect(failures).toBe(0);
    const target = await aliasTarget();
    expect(target).not.toBe(first);
    expect(await servicesCollections()).toEqual([target!]);
    const collection = await engine.getCollection(target!);
    expect(collection?.synonym_sets).toEqual([names.synonymSet]);
    expect(collection?.curation_sets).toEqual([names.curationSet]);
    // The rebuild queued its follow-ups: the terms and a reconcile.
    const follow = (await queuedJobs('maintenance')).map((entry) => entry.id);
    expect(follow).toEqual(expect.arrayContaining([expect.stringMatching(/^after-rebuild-\d+-terms$/)]));
    expect(follow).toEqual(expect.arrayContaining([expect.stringMatching(/^after-rebuild-\d+-reconcile$/)]));
  });

  it('leaves out a service unlisted during a rebuild once the post-swap reconcile ran', async () => {
    const database = await db();
    const world = await storefrontWorld(database);
    await rebuild();
    const documents = t.app.get(SearchDocuments, { strict: false });
    const original = documents.all.bind(documents);
    const spy = spyOn(documents, 'all').mockImplementation(async function* (database_) {
      const pages = [];
      for await (const page of original(database_)) pages.push(page);
      // The unlist commits while the rebuild holds its pages: its sync writes through the old alias.
      expect((await admin.patch(`/admin/service-listings/${world.att.listingId}`, { isListed: false })).status).toBe(
        200,
      );
      await runSearchOutbox(t);
      yield* pages;
    });
    clock.advance(1_000);
    await rebuild();
    spy.mockRestore();
    expect(await indexedIds(t.prefix)).toContain(String(world.att.serviceId));
    await reconcile();
    for (const entry of await queuedJobs('search-index')) {
      await t.app.get(SearchSyncProcessor, { strict: false }).process(job(entry.data));
    }
    expect(await indexedIds(t.prefix)).toEqual([String(world.icloud.serviceId)]);
  });

  it('without the alias (a bumped schema version, a wiped node): the sync writes nothing, health fails, the reconcile asks for a rebuild', async () => {
    const database = await db();
    const world = await storefrontWorld(database);
    await rebuild();
    const target = await aliasTarget();
    await engine.deleteAlias(names.alias('services'));
    const before = (await engine.getCollection(target!))?.num_documents;
    expect((await admin.patch(`/admin/service-listings/${world.att.listingId}`, { isListed: false })).status).toBe(200);
    const sync = t.app.get(SearchSync, { strict: false });
    expect(await sync.run({ serviceIds: [world.att.serviceId] })).toMatchObject({ outcome: 'not_ready', upserted: 0 });
    expect((await engine.getCollection(target!))?.num_documents).toBe(before);
    const indicator = (await import('../../src/infra/health')).HealthRegistry;
    const search = t.app
      .get(indicator, { strict: false })
      .list()
      .find((entry) => entry.name === 'search');
    expect(search?.critical).toBe(false);
    expect(await search?.check()).toBe(false);
    const autoRebuilds = async () =>
      (await queuedJobs('maintenance')).filter((entry) => String(entry.id).startsWith('rebuild-auto-'));
    expect(await reconcile()).toMatchObject({ outcome: 'rebuild_requested' });
    const [queued] = await autoRebuilds();
    expect(queued?.id).toBe(`rebuild-auto-v1-${clock.now().toISOString().slice(0, 13).replace(/[-T]/g, '')}`);
    expect(await reconcile()).toMatchObject({ outcome: 'rebuild_requested' });
    expect(await autoRebuilds()).toHaveLength(1);
    await t.app.get(SearchRebuildProcessor, { strict: false }).process(job(queued!.data));
    expect(await indexedIds(t.prefix)).toEqual([String(world.icloud.serviceId)]);
    expect(await search?.check()).toBe(true);
  });

  it('skips a run while the index lock is held', async () => {
    await storefrontWorld(await db());
    const lock = await t.app.get(SearchLocks, { strict: false }).acquire('index');
    expect(lock).not.toBeNull();
    try {
      expect(await t.app.get(SearchLocks, { strict: false }).acquire('index')).toBeNull();
      expect(await rebuild()).toMatchObject({ outcome: 'skipped' });
      expect(await reconcile()).toMatchObject({ outcome: 'skipped' });
      const runs = await (await db()).select().from(s.jobRuns);
      expect(runs.map((run) => run.status)).toEqual(['skipped', 'skipped']);
    } finally {
      await lock?.release();
    }
    expect(await rebuild()).toMatchObject({ outcome: 'rebuilt' });
  });
});

describe('the keys and the switch', () => {
  it('makes keys (not the bootstrap key) that work for both roles, and the search key cannot write', async () => {
    const indexerKey = `idx-${randomBytes(12).toString('hex')}`;
    const searchKey = `sch-${randomBytes(12).toString('hex')}`;
    const input = {
      admin: engine,
      clientFor: (key: string) => scriptClient(SEARCH_TEST_URL, key),
      prefix: t.prefix,
      indexerKey,
      searchKey,
    };
    expect((await ensureSearchKeys(input)).map((outcome) => outcome.action)).toEqual(['created', 'created']);
    expect((await ensureSearchKeys(input)).map((outcome) => outcome.action)).toEqual(['kept', 'kept']);
    const indexer = scriptClient(SEARCH_TEST_URL, indexerKey);
    const collection = `${t.prefix}keys_probe`;
    await indexer.createCollection({ name: collection, fields: [{ name: 'title', type: 'string' }] });
    await indexer.importJsonl(collection, [{ id: '1', title: 'Samsung FRP' }], 'upsert');
    await indexer.putAlias(`${t.prefix}keys_alias`, collection);
    const searcher: TypesenseClient = scriptClient(SEARCH_TEST_URL, searchKey);
    expect((await searcher.search(`${t.prefix}keys_alias`, { q: 'frp', query_by: 'title' })).found).toBe(1);
    expect(await searcher.getAlias(`${t.prefix}keys_alias`)).toMatchObject({ collection_name: collection });
    const write = await searcher
      .importJsonl(collection, [{ id: '2', title: 'x' }], 'upsert')
      .catch((error: unknown) => error);
    expect(write).toBeInstanceOf(SearchUnavailable);
    expect((write as SearchUnavailable).kind).toBe('auth');
    // Another environment's collection is out of reach of both keys.
    expect(
      await indexer
        .getCollection('gsm_development_services_v1')
        .then(() => 'reached')
        .catch((error: unknown) => (error instanceof SearchUnavailable ? error.kind : 'other')),
    ).toBe('auth');
    await indexer.deleteAlias(`${t.prefix}keys_alias`);
  });

  it('completes every job at once without a call while SEARCH_ENABLED is off', async () => {
    const throwing = new Proxy({} as TypesenseClient, {
      get: () => () => Promise.reject(new Error('no call may be made')),
    });
    const sync = t.app.get(SearchSync, { strict: false });
    const off = Object.create(sync) as SearchSync;
    Object.assign(off, { config: { ...t.config, search: { ...t.config.search, enabled: false } }, client: throwing });
    expect(await off.run({ serviceIds: [1, 2] })).toEqual({
      outcome: 'disabled',
      upserted: 0,
      deleted: 0,
      rejected: 0,
    });
  });
});

describe('the terms build and the search counters', () => {
  it('builds the completions into a terms collection, swaps its alias and drops the previous one', async () => {
    const database = await db();
    await storefrontWorld(database);
    await database.insert(s.searchSynonyms).values({ kind: 'multi', terms: ['icloud', 'activation lock'] });
    const build = () => t.app.get(SearchTermsBuildProcessor, { strict: false }).process(job({}));
    expect(await build()).toMatchObject({ outcome: 'built' });
    const completions = async (q: string) =>
      (await engine.search(names.alias('terms'), { q, query_by: 'q', prefix: 'true', per_page: 20 })).hits.map(
        (hit) => hit.document as { q: string; kind: string },
      );
    expect((await completions('icl')).map((term) => term.q)).toContain('icloud clean');
    expect(await completions('activation')).toEqual([
      expect.objectContaining({ q: 'activation lock', kind: 'synonym' }),
    ]);
    expect((await completions('att')).map((term) => term.q)).toContain('att usa premier unlock');
    const first = (await engine.getAlias(names.alias('terms')))?.collection_name;
    clock.advance(1_000);
    expect(await build()).toMatchObject({ outcome: 'built' });
    const terms = (await engine.listCollections(t.prefix))
      .map((entry) => entry.name)
      .filter((name) => names.parse(name)?.kind === 'terms');
    expect(terms).toHaveLength(1);
    expect(terms[0]).not.toBe(first);
    const [state] = await database.select().from(s.searchIndexState);
    expect(state?.termsCollection).toBe(terms[0]);
  });

  it('copies the day counters as absolute values (twice the same rows) and purges rows after 180 days', async () => {
    const database = await db();
    const redis = t.app.get(RedisService).cache;
    const keys = t.app.get(CacheKeys);
    const day = dayKey(clock.now());
    const counters = keys.searchTermsDay(day);
    const visitors = keys.searchVisitors(day, termId('samsung frp'));
    await redis.hset(counters, 's:samsung frp', '4', 'z:samsung frp', '1', 's:icloud', '2', 'x:junk', '9');
    await redis.pfadd(visitors, 'a1', 'b2', 'c3');
    try {
      const flush = () => t.app.get(SearchTermsFlushProcessor, { strict: false }).process(job({}));
      await flush();
      await flush();
      const rows = await database.select().from(s.searchTermsDaily).orderBy(s.searchTermsDaily.term);
      expect(rows.map((row) => [row.day, row.term, row.searches, row.zeroResults, row.visitors])).toEqual([
        [dayOf(clock.now()), 'icloud', 2, 0, 0],
        [dayOf(clock.now()), 'samsung frp', 4, 1, 3],
      ]);
      await database.insert(s.searchTermsDaily).values({ day: '2026-01-01', term: 'old term', searches: 1 });
      expect(await t.app.get(SearchTermsPurgeProcessor, { strict: false }).process(job({}))).toBe(1);
      expect(await database.select().from(s.searchTermsDaily)).toHaveLength(2);
    } finally {
      await redis.del(counters, visitors);
    }
  });
});

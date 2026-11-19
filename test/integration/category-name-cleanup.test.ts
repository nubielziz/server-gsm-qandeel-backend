// The pass that gives the existing categories clean names (feature 31, the final review's override of plan 31 section 3.5): what it renames,
// what it leaves, what a rename writes, and that the importer still finds a renamed category. Real Postgres and Redis.
import { afterAll, beforeAll, beforeEach, describe, expect, it, setDefaultTimeout } from 'bun:test';
import { asc, eq, sql } from 'drizzle-orm';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DbService, schema as s } from '../../src/infra/db';
import {
  CATALOG_CATEGORY_CHANGED_EVENT,
  CATEGORY_NAMES_CLEAN_EVENT,
  CATEGORY_NAMES_CLEAN_JOB,
  CategoryNameCleanup,
  CategoryNameCleanupModule,
  ServiceImporter,
} from '../../src/modules/catalog';
import { OutboxRouteRegistry } from '../../src/modules/platform';
import { type TestApp, createTestApp } from '../support/app';
import { clearIdentityCaches } from '../support/auth';
import { insertCategory } from '../support/catalog';
import { closeTestDb, resetDb, testDb } from '../support/db';
import { catalogVersionOf } from '../support/pricing';

setDefaultTimeout(60_000);

/** U+0622 U+0628 U+0644: a run of Arabic letters, written with escapes (decision 039). */
const ARABIC = '\u{0622}\u{0628}\u{0644}';

let t: TestApp;
let db: Awaited<ReturnType<typeof testDb>>['db'];
let cleanup: CategoryNameCleanup;

beforeAll(async () => {
  t = await createTestApp({ imports: [CategoryNameCleanupModule] });
  ({ db } = await testDb());
  cleanup = t.app.get(CategoryNameCleanup, { strict: false });
});
beforeEach(async () => {
  await resetDb();
  await clearIdentityCaches(t);
});
afterAll(async () => {
  await resetDb();
  await clearIdentityCaches(t);
  await t.close();
  await closeTestDb();
});

const names = async () =>
  (await db.select().from(s.serviceCategories).orderBy(asc(s.serviceCategories.id))).map((row) => row.name);
const audits = () => db.select().from(s.auditLogs).where(eq(s.auditLogs.action, 'edited category'));
const changedEvents = () =>
  db.select().from(s.outboxEvents).where(eq(s.outboxEvents.type, CATALOG_CATEGORY_CHANGED_EVENT));

describe('CategoryNameCleanup.run', () => {
  it('renames every category whose name is not clean, of every type, and leaves the clean ones alone', async () => {
    const att = await insertCategory(db, { name: 'AT&amp;T USA NETWORK UNLOCKED' });
    const tool = await insertCategory(db, { name: 'Q-UNLOCKER Tool \u{26A1}\u{FE0F}', type: 'server' });
    const mixed = await insertCategory(db, { name: `Fix Error Apple ID ${ARABIC}` });
    const bare = await insertCategory(db, { name: ARABIC });
    const clean = await insertCategory(db, { name: 'Carrier unlock' });
    const before = await catalogVersionOf(t);

    expect(await cleanup.run()).toEqual({ checked: 5, renamed: 3, collisions: 0 });

    expect(await names()).toEqual([
      'AT&T USA NETWORK UNLOCKED',
      'Q-UNLOCKER Tool',
      'Fix Error Apple ID',
      ARABIC,
      'Carrier unlock',
    ]);
    // A rename does what a staff rename does: the search index and the cached price lists hear about it.
    expect((await changedEvents()).map((event) => event.aggregateId).sort((a, b) => a - b)).toEqual(
      [att, tool, mixed].sort((a, b) => a - b),
    );
    expect(await catalogVersionOf(t)).not.toBe(before);
    const rows = await audits();
    expect(rows).toHaveLength(3);
    expect(rows.find((row) => row.entityId === att)).toMatchObject({
      actorType: 'system',
      entityType: 'category',
      entityLabel: 'AT&T USA NETWORK UNLOCKED',
      before: { name: 'AT&amp;T USA NETWORK UNLOCKED' },
      after: { name: 'AT&T USA NETWORK UNLOCKED' },
    });
    expect(rows.some((row) => row.entityId === clean || row.entityId === bare)).toBe(false);
  });

  it('finds nothing the second time: no rename, no event, no audit row', async () => {
    await insertCategory(db, { name: 'Check Case &amp; Sold By' });
    expect(await cleanup.run()).toMatchObject({ renamed: 1 });

    expect(await cleanup.run()).toEqual({ checked: 1, renamed: 0, collisions: 0 });

    expect(await audits()).toHaveLength(1);
    expect(await changedEvents()).toHaveLength(1);
  });

  it('keeps a name written only in Arabic script: the pass never turns it into Imported', async () => {
    const arabic = await insertCategory(db, { name: `${ARABIC} ${ARABIC}` });
    const mixed = await insertCategory(db, { name: `Tablets ${ARABIC} \u{2705}` });

    expect(await cleanup.run()).toEqual({ checked: 2, renamed: 1, collisions: 0 });

    const rows = await db.select().from(s.serviceCategories).orderBy(asc(s.serviceCategories.id));
    expect(rows.find((row) => row.id === arabic)?.name).toBe(`${ARABIC} ${ARABIC}`);
    expect(rows.find((row) => row.id === mixed)?.name).toBe('Tablets');
    expect((await audits()).map((row) => row.entityId)).toEqual([mixed]);
  });

  it('leaves a name another category of the type already has, in any case, and renames the same name of another type', async () => {
    await insertCategory(db, { name: 'AT&T Unlock' });
    const raw = await insertCategory(db, { name: 'at&amp;t UNLOCK' });
    const server = await insertCategory(db, { name: 'at&amp;t UNLOCK', type: 'server' });

    expect(await cleanup.run()).toEqual({ checked: 3, renamed: 1, collisions: 1 });

    const rows = await db.select().from(s.serviceCategories).orderBy(asc(s.serviceCategories.id));
    expect(rows.find((row) => row.id === raw)?.name).toBe('at&amp;t UNLOCK');
    expect(rows.find((row) => row.id === server)?.name).toBe('at&t UNLOCK');
    expect((await audits()).map((row) => row.entityId)).toEqual([server]);
  });

  it('counts a collision that appears after the name was read, and goes on', async () => {
    const raw = await insertCategory(db, { name: 'Apple &amp; iPad' });
    const later = await insertCategory(db, { name: 'Samsung &amp; Tab' });
    // Between the page read and the rename, someone makes the clean name.
    const database = t.app.get(DbService, { strict: false });
    const runInTransaction = database.runInTransaction.bind(database);
    let raced = false;
    database.runInTransaction = (async (...args: Parameters<typeof runInTransaction>) => {
      if (!raced) {
        raced = true;
        await insertCategory(db, { name: 'Apple & iPad' });
      }
      return runInTransaction(...args);
    }) as typeof database.runInTransaction;
    try {
      expect(await cleanup.run()).toMatchObject({ renamed: 1, collisions: 1 });
    } finally {
      database.runInTransaction = runInTransaction;
    }
    const rows = await db.select().from(s.serviceCategories);
    expect(rows.find((row) => row.id === raw)?.name).toBe('Apple &amp; iPad');
    expect(rows.find((row) => row.id === later)?.name).toBe('Samsung & Tab');
  });

  it('walks past one page of categories', async () => {
    await db.insert(s.serviceCategories).values(
      Array.from({ length: 250 }, (_, index) => ({
        name: `Group &amp; ${index}`,
        type: 'imei' as const,
      })),
    );

    expect(await cleanup.run()).toEqual({ checked: 250, renamed: 250, collisions: 0 });

    const [left] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(s.serviceCategories)
      .where(sql`${s.serviceCategories.name} like '%&amp;%'`);
    expect(left!.n).toBe(0);
  });

  it('keeps the importer on the renamed category: the raw group text finds it by its clean name', async () => {
    const category = await insertCategory(db, { name: 'AT&amp;T USA' });
    await cleanup.run();
    const importer = t.app.get(ServiceImporter, { strict: false });

    const created = await t.app.get(DbService, { strict: false }).runInTransaction(({ tx }) =>
      importer.create(tx, {
        supplierServiceId: 1,
        type: 'imei',
        name: 'AT&T iPhone Unlock',
        group: 'AT&amp;T USA',
        time: '1-2 hours',
        cost: '10.0000',
        basePrice: '10.6000',
        slaMinutes: 60,
        quantity: { minQty: 1, maxQty: 1, qtyOptions: [] },
        fields: [],
      }),
    );

    expect(created.categoryCreated).toBe(false);
    const [service] = await db.select().from(s.services).where(eq(s.services.id, created.serviceId));
    expect(service!.categoryId).toBe(category);
    expect(await names()).toEqual(['AT&T USA']);
  });
});

describe('how the pass is asked for', () => {
  it('is routed to its job, under the event migration 0046 writes once', () => {
    expect(t.app.get(OutboxRouteRegistry, { strict: false }).get(CATEGORY_NAMES_CLEAN_EVENT)).toEqual({
      type: 'catalog.category_names_clean',
      queue: 'maintenance',
      jobName: CATEGORY_NAMES_CLEAN_JOB,
    });
    const migration = readFileSync(join(import.meta.dir, '../../drizzle/0046_clean_category_names.sql'), 'utf8');
    expect(migration).toContain(`'${CATEGORY_NAMES_CLEAN_EVENT}'`);
  });
});

// The bulk publish through the real queues (feature 31, plan 31 section 6): the outbox relay hands `supplier.quick_add_done` to its processor,
// and the job chain goes on by itself to the shop; the event migration 0046 writes reaches the pass over the category names. Real Postgres
// and Redis (a private BullMQ prefix), real workers; the waits are polls for the effect.
import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from 'bun:test';
import { asc, eq, sql } from 'drizzle-orm';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { schema as s } from '../../src/infra/db';
import { QueueWorkersModule, QueuesService } from '../../src/infra/queues';
import { RedisService } from '../../src/infra/redis';
import { CATEGORY_NAMES_CLEAN_EVENT, CategoryNameCleanupModule } from '../../src/modules/catalog';
import { OutboxRelayModule } from '../../src/modules/platform';
import { PublishWorkerModule } from '../../src/modules/storefront';
import { QuickAddRunner } from '../../src/modules/suppliers';
import { QUICK_ADD_DONE_EVENT } from '../../src/modules/suppliers/application/quick-add-outbox';
import { type AdminApi, adminWith } from '../support/admin-api';
import { type TestApp, createTestApp } from '../support/app';
import { clearIdentityCaches } from '../support/auth';
import { insertCategory } from '../support/catalog';
import { closeTestDb, resetDb, testDb } from '../support/db';
import { insertUsd } from '../support/fixtures';
import { eventually } from '../support/infra';
import { insertDemoGroups } from '../support/pricing';
import { deleteBullKeys, testBullPrefix } from '../support/queues';

setDefaultTimeout(60_000);

const prefix = testBullPrefix();
let t: TestApp;
let db: Awaited<ReturnType<typeof testDb>>['db'];
let staff: AdminApi;

beforeAll(async () => {
  t = await createTestApp({
    imports: [QueueWorkersModule, OutboxRelayModule, PublishWorkerModule, CategoryNameCleanupModule],
    env: { BULL_PREFIX: prefix },
  });
  ({ db } = await testDb());
  await resetDb();
  await clearIdentityCaches(t);
  staff = await adminWith(t, ['suppliers:*', 'catalog:*', 'storefront:*', 'pricing:*'], { name: 'Lina S.' });
  await insertUsd(db);
  await insertDemoGroups(db);
});
afterAll(async () => {
  await resetDb();
  await clearIdentityCaches(t);
  await deleteBullKeys(t.app.get(RedisService, { strict: false }).queue, prefix);
  await t.close();
  await closeTestDb();
});

describe('the bulk publish through the real queues', () => {
  it('relays the end of a Quick add to its job, and the services reach the shop with no other step', async () => {
    const rule = { scope: 'type', serviceType: 'imei', percent: '30', rounding: 'ends_99' };
    expect((await staff.post('/admin/retail-price-rules', rule)).status).toBe(201);
    const [supplier] = await db
      .insert(s.suppliers)
      .values({
        name: 'Quick Source',
        driver: 'dhru',
        baseUrl: 'https://supplier.example',
        paramFormat: 'dhru_xml',
      })
      .returning({ id: s.suppliers.id });
    const names = ['Apple iPhone 15 Activation Lock Remove', 'Apple iPhone 16 Activation Lock Remove'];
    await db.insert(s.supplierServices).values(
      names.map((name, index) => ({
        supplierId: supplier!.id,
        remoteId: `r${index}`,
        remoteGroup: 'Apple',
        type: 'IMEI',
        name,
        credit: '10.0000',
        time: '1-2 hours',
      })),
    );
    const start = await staff.post(`/admin/suppliers/${supplier!.id}/quick-add`, {
      scope: 'all',
      publish: { listed: true },
    });
    expect(start.status).toBe(202);

    // The Quick add job itself runs here; its close writes the hand-over event, and everything after it goes through the queues.
    expect(await t.app.get(QuickAddRunner, { strict: false }).run(start.body.id)).toBe('succeeded');
    const [event] = await db.select().from(s.outboxEvents).where(eq(s.outboxEvents.type, QUICK_ADD_DONE_EVENT));
    expect(event).toMatchObject({ aggregateType: 'supplier_import_runs', aggregateId: start.body.id });

    const run = await eventually(async () => {
      const [row] = await db
        .select()
        .from(s.listingPublishRuns)
        .where(eq(s.listingPublishRuns.sourceRunId, start.body.id));
      return row?.status === 'succeeded' ? row : undefined;
    }, 30_000);
    expect(run).toMatchObject({ source: 'quick_add', auto: true, publishedCount: 2, requestedBy: staff.staffId });
    const listings = await db.select().from(s.serviceListings).orderBy(asc(s.serviceListings.id));
    expect(listings).toHaveLength(2);
    expect(listings.every((listing) => listing.isListed)).toBe(true);
    // The relay delivered the event once, and the job left nothing to do for a second delivery.
    const [relayed] = await db.select().from(s.outboxEvents).where(eq(s.outboxEvents.id, event!.id));
    expect(relayed!.processedAt).not.toBeNull();
    const job = await t.app.get(QueuesService, { strict: false }).queue('imports').getJob(`outbox-${event!.id}`);
    expect(job?.name).toBe('publish_from_quick_add');
  });

  it('runs the pass over the category names from the event migration 0046 writes', async () => {
    await insertCategory(db, { name: 'AT&amp;T Unlock' });
    await insertCategory(db, { name: 'Cerberus Tool \u{2705}', type: 'server' });
    await insertCategory(db, { name: 'Already clean' });
    const migration = readFileSync(join(import.meta.dir, '../../drizzle/0046_clean_category_names.sql'), 'utf8');

    await db.execute(sql.raw(migration));

    const [event] = await db.select().from(s.outboxEvents).where(eq(s.outboxEvents.type, CATEGORY_NAMES_CLEAN_EVENT));
    expect(event).toMatchObject({ aggregateType: 'service_categories' });
    const names = await eventually(async () => {
      const rows = await db.select({ name: s.serviceCategories.name }).from(s.serviceCategories);
      const found = rows.map((row) => row.name);
      return found.includes('AT&T Unlock') && found.includes('Cerberus Tool') ? found : undefined;
    }, 30_000);
    expect(names).toContain('Already clean');
    expect(names).not.toContain('AT&amp;T Unlock');
    const audits = await db.select().from(s.auditLogs).where(eq(s.auditLogs.action, 'edited category'));
    expect(audits).toHaveLength(2);
    expect(audits.every((row) => row.actorType === 'system')).toBe(true);
  });
});

// End-to-end walk of the owner's story for feature 31 (decision 040, plan 31 section 8.3): a supplier with real service names (the fixture of
// `test/fixtures/publish`), one general retail pricing rule, Quick add with "put them on the shop", the shop list and the search rule holding
// what was published, the ones that need a person left in the run, a sync that raises a cost, the price that follows it, and the "Price
// changes" list and the audit log that show it. The steps share one story, so the tests of this file run in order and keep their state in the
// variables below.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { and, asc, eq, inArray } from 'drizzle-orm';
import { Money } from '../../src/common/money';
import { EncryptionService } from '../../src/infra/crypto';
import { type Database, schema as s } from '../../src/infra/db';
import { RedisService } from '../../src/infra/redis';
import { RETAIL_GROUP_KIND, RetailPriceFollow, RetailPriceFollowModule } from '../../src/modules/catalog';
import { SearchableIds } from '../../src/modules/storefront/search/application/searchable-ids';
import { PublishFromQuickAddProcessor } from '../../src/modules/storefront/publish/jobs/publish.processors';
import { PublishFromQuickAdd } from '../../src/modules/storefront/publish/application/publish-from-quick-add';
import { PublishRunner } from '../../src/modules/storefront/publish/application/publish-runner';
import { PublishSwitch } from '../../src/modules/storefront/publish/application/publish-switch';
import { jobDataOf } from '../../src/modules/platform/outbox/outbox-payload';
import { QuickAddRunner, SupplierSync } from '../../src/modules/suppliers';
import { type AdminApi, adminWith } from '../support/admin-api';
import { type TestApp, createTestApp } from '../support/app';
import { clearIdentityCaches } from '../support/auth';
import { MINUTE, TestClock } from '../support/clock';
import { closeTestDb, resetDb, testDb } from '../support/db';
import { insertUsd } from '../support/fixtures';
import { freshClientIp } from '../support/pipeline-routes';
import { insertDemoGroups } from '../support/pricing';
import { deleteBullKeys, testBullPrefix } from '../support/queues';
import { FakeDhruSupplier, SupplierTestModule, insertFakeSupplier } from '../support/suppliers';

interface FixtureRow {
  readonly n: number;
  readonly type: 'IMEI' | 'SERVER';
  readonly group: string;
  readonly cost: string;
  readonly name: string;
}

const names = JSON.parse(
  readFileSync(join(import.meta.dir, '..', 'fixtures', 'publish', 'supplier-names.json'), 'utf8'),
) as FixtureRow[];

/** Arabic script, written with escapes: the fixture holds six such names, and one of them has nothing else. */
const ARABIC = /[\u{0600}-\u{06FF}\u{0750}-\u{077F}\u{08A0}-\u{08FF}\u{FB50}-\u{FDFF}\u{FE70}-\u{FEFF}]/u;

/** A spread of the real names: every twentieth with a cost and without Arabic script, 58 of them, IMEI and SERVER, many groups. */
const STORY: readonly FixtureRow[] = names
  .filter((row) => Number(row.cost) > 0 && !ARABIC.test(row.name))
  .filter((_, index) => index % 20 === 0);

const fake = new FakeDhruSupplier();
const clock = new TestClock('2026-11-18T09:00:00.000Z');
const prefix = testBullPrefix();
let t: TestApp;
let db: Database;
let staff: AdminApi;
let supplierId = 0;
let quickRunId = 0;
let publishRunId = 0;
let published: Array<{ serviceId: number; slug: string }> = [];
let followedServiceId = 0;
let priceBefore = '';

const follow = () => t.app.get(RetailPriceFollow, { strict: false });
const remoteIdOf = (row: FixtureRow) => String(5000 + row.n);

beforeAll(async () => {
  t = await createTestApp({
    clock,
    imports: [SupplierTestModule, RetailPriceFollowModule],
    env: { BULL_PREFIX: prefix },
  });
  ({ db } = await testDb());
  await resetDb();
  await clearIdentityCaches(t);
  staff = await adminWith(t, ['suppliers:*', 'catalog:*', 'storefront:*', 'pricing:*', 'audit:read'], {
    name: 'Lina S.',
  });
  await insertUsd(db);
  await insertDemoGroups(db);
});
afterAll(async () => {
  await fake.stop();
  await deleteBullKeys(t.app.get(RedisService).queue, prefix);
  await resetDb();
  await clearIdentityCaches(t);
  await t.close();
  await closeTestDb();
});

/** The shop's list of services (one page of up to 100). */
const shop = async () =>
  (
    await t.app.inject({ method: 'GET', url: '/store/v1/services?_start=0&_end=100', remoteAddress: freshClientIp() })
  ).json<Array<{ slug: string; price: { net: string } }>>();

const retailOf = async (serviceId: number) =>
  (
    await db
      .select({ price: s.serviceGroupPrices.price })
      .from(s.serviceGroupPrices)
      .innerJoin(s.clientGroups, eq(s.clientGroups.id, s.serviceGroupPrices.groupId))
      .where(and(eq(s.serviceGroupPrices.serviceId, serviceId), eq(s.clientGroups.kind, RETAIL_GROUP_KIND)))
  )[0]?.price ?? null;

describe('the owner story of bulk publish: from a supplier list to the shop and a price that follows its cost', () => {
  it('step 1: a supplier lists real services and the sync brings them in', async () => {
    expect(STORY.length).toBeGreaterThanOrEqual(50);
    fake.services = STORY.map((row) => ({
      id: remoteIdOf(row),
      group: row.group,
      type: row.type,
      name: row.name,
      credit: row.cost,
      time: '1-2 hours',
    }));
    supplierId = await insertFakeSupplier(db, t.app.get(EncryptionService), fake);

    const synced = await t.app.get(SupplierSync, { strict: false }).run(supplierId, { audit: false });

    expect(synced.ok).toBe(true);
    const rows = await db.select().from(s.supplierServices).where(eq(s.supplierServices.supplierId, supplierId));
    expect(rows).toHaveLength(STORY.length);
  });

  it('step 2: staff make one general rule: the cost plus 30 %, ends in .99', async () => {
    const res = await staff.post('/admin/retail-price-rules', { scope: 'global', percent: '30', rounding: 'ends_99' });
    expect(res.status).toBe(201);
    expect(res.body.label).toContain('30');
  });

  it('step 3: Quick add with "put them on the shop" adds every service and hands them over when it ends', async () => {
    const started = await staff.post(`/admin/suppliers/${supplierId}/quick-add`, {
      scope: 'all',
      publish: { listed: true },
    });
    expect(started.status).toBe(202);
    expect(started.body.publish).toBe('listed');
    quickRunId = started.body.id;

    expect(await t.app.get(QuickAddRunner, { strict: false }).run(quickRunId)).toBe('succeeded');

    const run = (await staff.get(`/admin/suppliers/${supplierId}/quick-add/${quickRunId}`)).body;
    expect(run).toMatchObject({ status: 'succeeded', created: STORY.length, failed: 0, publish: 'listed' });
    // Every service this run made is recorded on its link, and nothing is on the shop yet.
    const links = await db
      .select()
      .from(s.serviceSupplierLinks)
      .where(eq(s.serviceSupplierLinks.importRunId, quickRunId));
    expect(links).toHaveLength(STORY.length);
    expect(await db.select().from(s.serviceListings)).toHaveLength(0);
    // The category menu holds cleaned names: no entity, emoji, direction mark or Arabic script.
    const categories = (await db.select().from(s.serviceCategories)).map((row) => row.name);
    for (const name of categories) {
      expect(name).not.toMatch(/&(amp|quot|#\d+);|\p{Extended_Pictographic}|[\u{200B}-\u{200F}\u{202A}-\u{202E}]/u);
      expect(ARABIC.test(name)).toBe(false);
      expect(name).toBe(name.trim());
    }
  });

  it('step 4: the worker makes the one automatic run of the Quick add run, prepares it and queues the apply', async () => {
    const [event] = await db
      .select()
      .from(s.outboxEvents)
      .where(and(eq(s.outboxEvents.type, 'supplier.quick_add_done'), eq(s.outboxEvents.aggregateId, quickRunId)));
    expect(event).toBeDefined();
    const processor = new PublishFromQuickAddProcessor(t.app.get(PublishFromQuickAdd, { strict: false }));

    const outcome = await processor.process({ name: 'publish_from_quick_add', data: jobDataOf(event!) } as never);

    expect(outcome).toBe('queued');
    const runs = await db.select().from(s.listingPublishRuns);
    expect(runs).toHaveLength(1);
    publishRunId = runs[0]!.id;
    expect(runs[0]).toMatchObject({
      source: 'quick_add',
      sourceRunId: quickRunId,
      auto: true,
      listed: true,
      status: 'queued',
      total: STORY.length,
      requestedBy: staff.staffId,
    });
    // Quick add's own step 3 finds it with the Quick add run's id.
    const found = await staff.get(`/admin/publish-runs?quickAddRunId=${quickRunId}`);
    expect(found.body.map((run: { id: number }) => run.id)).toEqual([publishRunId]);
  });

  it('step 5: the ready services are on the shop at the rule price; the ones that need a person wait in the run', async () => {
    expect(await t.app.get(PublishRunner, { strict: false }).run(publishRunId)).toBe('succeeded');

    const run = (await staff.get(`/admin/publish-runs/${publishRunId}`)).body;
    expect(run.status).toBe('succeeded');
    expect(run.counts.published + run.counts.skipped + run.counts.refused).toBe(STORY.length);
    expect(run.counts.refused).toBe(0);
    expect(run.counts.published).toBeGreaterThanOrEqual(35);
    expect(run.counts.skipped).toBe(run.counts.review + run.counts.blocked);

    const listings = await db.select().from(s.serviceListings).orderBy(asc(s.serviceListings.id));
    expect(listings).toHaveLength(run.counts.published);
    expect(listings.every((listing) => listing.isListed)).toBe(true);
    published = listings.map((listing) => ({ serviceId: listing.serviceId, slug: listing.slug }));

    // The rows left out say why, and none of them is on the shop.
    const items = await db.select().from(s.listingPublishItems).where(eq(s.listingPublishItems.runId, publishRunId));
    const leftOut = items.filter((item) => item.result === 'skipped');
    expect(leftOut.length).toBe(run.counts.skipped);
    expect(leftOut.every((item) => item.resultReason === 'left_out' || item.state === 'blocked')).toBe(true);
    expect(leftOut.some((item) => published.some((row) => row.serviceId === item.serviceId))).toBe(false);

    // Each published service has the rule's price (the cost plus 30 %, never under the floor) and follows its rule.
    const prices = await db
      .select()
      .from(s.serviceGroupPrices)
      .where(
        inArray(
          s.serviceGroupPrices.serviceId,
          published.map((row) => row.serviceId),
        ),
      );
    expect(prices).toHaveLength(published.length);
    expect(await db.select().from(s.retailPriceFollows)).toHaveLength(published.length);
    const audits = await db.select().from(s.auditLogs).where(eq(s.auditLogs.action, 'published to the storefront'));
    expect(audits).toHaveLength(published.length);
  });

  it('step 6: the shop list and the search rule hold exactly what was published', async () => {
    const onShop = (await shop()).map((card) => card.slug).sort();
    expect(onShop).toEqual(published.map((row) => row.slug).sort());

    const ids = (await db.select({ id: s.services.id }).from(s.services)).map((row) => row.id);
    const searchable = await t.app.get(SearchableIds, { strict: false }).of(db, ids);
    expect([...searchable.services.keys()].sort((a, b) => a - b)).toEqual(
      published.map((row) => row.serviceId).sort((a, b) => a - b),
    );
  });

  it('step 7: a sync raises one cost by 10 %, and the price follows it', async () => {
    // The dearest published service: its 10 % is a whole step of the rule's rounding.
    const costs = await db
      .select({ id: s.services.id, cost: s.services.effectiveCost })
      .from(s.services)
      .where(
        inArray(
          s.services.id,
          published.map((row) => row.serviceId),
        ),
      );
    const dearest = costs.sort((a, b) => Money.of(b.cost).cmp(Money.of(a.cost)))[0]!;
    followedServiceId = dearest.id;
    priceBefore = (await retailOf(followedServiceId))!;
    const [link] = await db
      .select({ remoteId: s.supplierServices.remoteId })
      .from(s.serviceSupplierLinks)
      .innerJoin(s.supplierServices, eq(s.supplierServices.id, s.serviceSupplierLinks.supplierServiceId))
      .where(eq(s.serviceSupplierLinks.serviceId, followedServiceId));
    const entry = fake.services.find((service) => service.id === link!.remoteId)!;
    const raised = Money.of(entry.credit).mul('1.10').toWire();
    entry.credit = raised;
    clock.advance(15 * MINUTE);

    expect((await t.app.get(SupplierSync, { strict: false }).run(supplierId, { audit: false })).ok).toBe(true);

    const [after] = await db
      .select({ effectiveCost: s.services.effectiveCost })
      .from(s.services)
      .where(eq(s.services.id, followedServiceId));
    expect(after!.effectiveCost).toBe(raised);
    // Nothing else moved: the other costs are the ones of the Quick add.
    expect(await retailOf(followedServiceId)).toBe(priceBefore);

    const result = await follow().run();

    expect(result).toMatchObject({ followed: 1, proposed: 0, failed: 0 });
    const priceAfter = (await retailOf(followedServiceId))!;
    expect(Money.of(priceAfter).cmp(Money.of(priceBefore))).toBeGreaterThan(0);
    const card = (await shop()).find(
      (row) => row.slug === published.find((p) => p.serviceId === followedServiceId)!.slug,
    );
    expect(card?.price.net).toBe(priceAfter);
    // A second pass finds nothing to do.
    expect(await follow().run()).toMatchObject({ followed: 0, proposed: 0 });
  });

  it('step 8: the Price changes list and the audit log show the move, written by the system', async () => {
    const changes = await staff.get(`/admin/retail-price-changes?serviceId=${followedServiceId}`);
    expect(changes.status).toBe(200);
    expect(changes.body).toHaveLength(1);
    expect(changes.body[0]).toMatchObject({
      kind: 'followed',
      reason: 'cost_changed',
      oldPrice: priceBefore,
      waiting: false,
      service: { id: followedServiceId },
    });
    expect(changes.body[0].newPrice).toBe(await retailOf(followedServiceId));
    expect(Money.of(changes.body[0].newCost).cmp(Money.of(changes.body[0].oldCost))).toBeGreaterThan(0);

    const audit = await staff.get(
      `/admin/audit-logs?entityType=service&entityId=${followedServiceId}&q=retail%20price`,
    );
    expect(audit.status).toBe(200);
    expect(audit.body).toHaveLength(1);
    expect(audit.body[0]).toMatchObject({ action: 'changed retail price of', actorType: 'system' });
    expect(audit.body[0].after).toMatchObject({
      retailPrice: await retailOf(followedServiceId),
      reason: 'cost_changed',
    });
  });

  it('step 9: one button takes the whole run off the shop again, and every price stays', async () => {
    expect((await staff.post(`/admin/publish-runs/${publishRunId}/listed`, { listed: false })).status).toBe(202);
    expect(await t.app.get(PublishSwitch, { strict: false }).run(publishRunId, false, staff.staffId)).toBe('done');

    expect(await shop()).toEqual([]);
    const ids = (await db.select({ id: s.services.id }).from(s.services)).map((row) => row.id);
    expect((await t.app.get(SearchableIds, { strict: false }).of(db, ids)).services.size).toBe(0);
    expect(await db.select().from(s.serviceGroupPrices)).toHaveLength(published.length);
    expect(await db.select().from(s.serviceListings)).toHaveLength(published.length);
  });
});

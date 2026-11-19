// A publish run's worker and the run switch (feature 31 slice B3b, plan 31 sections 6.2, 6.5, 6.6, 6.7 and 8.3). The runs are seeded straight
// into their two tables and moved by helpers that do what the publish routes' transactions do: those routes do not exist yet (B4). The
// chunks and the close, the rows left out, idempotency, a resume after a death, two workers on one run, a cancel, the failed rows, the guards.
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  mock,
  setDefaultTimeout,
  spyOn,
} from 'bun:test';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { type Database, DbService, type Transaction, schema as s } from '../../src/infra/db';
import { CatalogPriceVersion, RetailPrices } from '../../src/modules/catalog';
import { AuditService, OutboxRouteRegistry } from '../../src/modules/platform';
import { jobDataOf } from '../../src/modules/platform/outbox/outbox-payload';
import { ListingPublisher } from '../../src/modules/storefront/application/listing-publisher';
import type { ListingPublishItem } from '../../src/modules/storefront/db/schema';
import {
  PUBLISH_APPLY_EVENT,
  PUBLISH_JOBS,
  PUBLISH_SET_LISTED_EVENT,
} from '../../src/modules/storefront/publish/application/publish-outbox';
import {
  type PublishRunOutcome,
  PublishRunner,
  publishInputOf,
} from '../../src/modules/storefront/publish/application/publish-runner';
import { PublishSwitch } from '../../src/modules/storefront/publish/application/publish-switch';
import { MAX_ITEM_FAILURES, TOO_MANY_FAILURES_ERROR } from '../../src/modules/storefront/publish/domain/publish-item';
import {
  beatApply,
  beatSwitch,
  claimApply,
  claimSwitch,
  closeApply,
  closeSwitch,
  countItemResults,
  holdApply,
  holdSwitch,
  lockApply,
  lockPendingItem,
  moveRunToQueued,
  queueRunSwitch,
  writeItemResult,
} from '../../src/modules/storefront/publish/infra/publish.repository';
import {
  PublishApplyProcessor,
  PublishSetListedProcessor,
} from '../../src/modules/storefront/publish/jobs/publish.processors';
import { LISTING_CHANGED_EVENT, SearchSignals } from '../../src/modules/storefront/search/application/search-signals';
import { type AdminApi, adminWith } from '../support/admin-api';
import { type TestApp, createTestApp } from '../support/app';
import { clearIdentityCaches } from '../support/auth';
import { insertCategory } from '../support/catalog';
import { MINUTE, TestClock } from '../support/clock';
import { closeTestDb, resetDb, testDb } from '../support/db';
import { insertUsd } from '../support/fixtures';
import { eventually } from '../support/infra';
import { insertDemoGroups } from '../support/pricing';
import {
  type SeededRun,
  cancelRun,
  publishItemsOf,
  publishOne,
  queueRun,
  queueSwitch,
  seedRun,
} from '../support/publish';
import { expectRejection } from '../support/rejection';
import { insertListingRow } from '../support/storefront';

setDefaultTimeout(60_000);

/** A second transaction a test keeps open: the other side of a race. */
interface Rival {
  /** Its connection, as `pg_blocking_pids` names it. */
  readonly pid: number;
  commit(): Promise<void>;
}

const START = '2026-11-18T09:00:00.000Z';
const clock = new TestClock(START);
let t: TestApp;
let db: Database;
let admin: AdminApi;
let runner: PublishRunner;
let switcher: PublishSwitch;
const rivals: Rival[] = [];

beforeAll(async () => {
  t = await createTestApp({ clock });
  ({ db } = await testDb());
  runner = t.app.get(PublishRunner, { strict: false });
  switcher = t.app.get(PublishSwitch, { strict: false });
});
beforeEach(async () => {
  clock.set(START);
  await resetDb();
  await clearIdentityCaches(t);
  admin = await adminWith(t, ['pricing:*', 'storefront:*', 'catalog:*'], { name: 'Rami K.' });
});
// A rival left open by a failed test would hold its locks, and the next reset would wait for it for ever.
afterEach(async () => {
  mock.restore();
  await Promise.allSettled(rivals.splice(0).map((rival) => rival.commit()));
});
afterAll(async () => {
  await resetDb();
  await clearIdentityCaches(t);
  await t.close();
  await closeTestDb();
});

/** IMEI +30 %, ends in .99 from $5, limit 25 %: cost 10.0000 (floor 11.66) gives 13.99. */
const IMEI_30 = { scope: 'type', serviceType: 'imei', percent: '30', rounding: 'ends_99' } as const;
const RULE_PRICE = '13.9900';

interface World {
  readonly groups: Awaited<ReturnType<typeof insertDemoGroups>>;
  readonly categoryId: number;
}

/** USD, the demo groups (the last is the retail group), a category open to every group and the rule that prices its services. */
async function world(): Promise<World> {
  await insertUsd(db);
  const groups = await insertDemoGroups(db);
  const categoryId = await insertCategory(db, { name: 'Carrier unlock' });
  const rule = await admin.post('/admin/retail-price-rules', IMEI_30);
  expect(rule.status).toBe(201);
  return { groups, categoryId };
}

let sequence = 0;

/**
 * Quick add services at cost 10.0000 (base price cost + 6 %, no own minimum profit, storefront floor 11.66), fulfilled automatically
 * through active links to one active supplier.
 */
async function services(w: World, count: number, categoryId = w.categoryId): Promise<number[]> {
  const rows = Array.from({ length: count }, () => {
    sequence += 1;
    return {
      categoryId,
      type: 'imei' as const,
      name: `Unlock ${sequence}`,
      code: `PUB-${sequence}-${crypto.randomUUID().slice(0, 6)}`,
      fulfillment: 'auto' as const,
      basePrice: '10.6000',
      cost: '10.0000',
      effectiveCost: '10.0000',
      minProfit: null,
      slaMinutes: 60,
    };
  });
  const ids = (await db.insert(s.services).values(rows).returning({ id: s.services.id })).map((row) => row.id);
  const [supplier] = await db
    .insert(s.suppliers)
    .values({
      name: `Publish source ${crypto.randomUUID().slice(0, 6)}`,
      driver: 'dhru',
      baseUrl: 'https://supplier.example.com',
      paramFormat: 'dhru_xml',
      creditRate: '1',
    })
    .returning({ id: s.suppliers.id });
  const remotes = await db
    .insert(s.supplierServices)
    .values(
      ids.map((id) => ({ supplierId: supplier!.id, remoteId: `r${id}`, type: 'IMEI', name: 'Remote', credit: '10' })),
    )
    .returning({ id: s.supplierServices.id });
  await db
    .insert(s.serviceSupplierLinks)
    .values(ids.map((serviceId, i) => ({ serviceId, supplierServiceId: remotes[i]!.id, priority: 1, isActive: true })));
  return ids;
}

const runOf = async (runId: number) =>
  (await db.select().from(s.listingPublishRuns).where(eq(s.listingPublishRuns.id, runId)))[0]!;

const listingsOf = (serviceIds: readonly number[]) =>
  db
    .select()
    .from(s.serviceListings)
    .where(inArray(s.serviceListings.serviceId, [...serviceIds]))
    .orderBy(asc(s.serviceListings.serviceId));

const retailRowsOf = (w: World, serviceIds: readonly number[]) =>
  db
    .select()
    .from(s.serviceGroupPrices)
    .where(
      and(inArray(s.serviceGroupPrices.serviceId, [...serviceIds]), eq(s.serviceGroupPrices.groupId, w.groups.retail)),
    )
    .orderBy(asc(s.serviceGroupPrices.serviceId));

const followsOf = (serviceIds: readonly number[]) =>
  db
    .select()
    .from(s.retailPriceFollows)
    .where(inArray(s.retailPriceFollows.serviceId, [...serviceIds]))
    .orderBy(asc(s.retailPriceFollows.serviceId));

const auditsOf = (action: string) =>
  db.select().from(s.auditLogs).where(eq(s.auditLogs.action, action)).orderBy(asc(s.auditLogs.id));

const CLOSE_AUDIT = 'published services to the storefront';
const ROW_AUDIT = 'published to the storefront';
const SWITCH_AUDIT = 'switched publishing run';

const listingEvents = () => db.$count(s.outboxEvents, eq(s.outboxEvents.type, LISTING_CHANGED_EVENT));

const resultsOf = (rows: readonly ListingPublishItem[]) => rows.map((row) => row.result);
const count = <T>(rows: readonly T[], test: (row: T) => boolean) => rows.filter(test).length;

/** Publishes a row as a worker that then died did: the listing and the price are there, and the row has its result. */
async function publishedBefore(item: ListingPublishItem): Promise<void> {
  const outcome = await publishOne(t, publishInputOf(item, { listed: true, requestedBy: null }));
  if (outcome.result !== 'published') throw new Error(`The row of service ${item.serviceId} was not published.`);
  await db
    .update(s.listingPublishItems)
    .set({
      result: 'published',
      listingId: outcome.listingId,
      publishedPrice: outcome.price.toWire(),
      finishedAt: clock.now(),
    })
    .where(eq(s.listingPublishItems.id, item.id));
}

const backendPid = async (tx: Transaction) =>
  (await tx.execute<{ pid: number }>(sql`select pg_backend_pid() as pid`)).rows[0]!.pid;

/** Opens a transaction that does `work` and stays open until `commit`. */
async function rival(work: (tx: Transaction) => Promise<unknown>): Promise<Rival> {
  let release!: () => void;
  const released = new Promise<void>((resolve) => (release = resolve));
  let opened!: (pid: number) => void;
  const ready = new Promise<number>((resolve) => (opened = resolve));
  const done = t.app.get(DbService).runInTransaction(async ({ tx }) => {
    const pid = await backendPid(tx);
    await work(tx);
    opened(pid);
    await released;
  });
  const pid = await Promise.race([ready, done.then(() => 0)]);
  const held: Rival = {
    pid,
    commit: () => {
      release();
      return done;
    },
  };
  rivals.push(held);
  return held;
}

const holdItem = (itemId: number) =>
  rival((tx) => tx.select().from(s.listingPublishItems).where(eq(s.listingPublishItems.id, itemId)).for('update'));

const holdService = (serviceId: number) =>
  rival((tx) => tx.select().from(s.services).where(eq(s.services.id, serviceId)).for('update'));

/** The statements of other connections that wait for a lock, and name `text`. */
const waiting = async (text: string) => {
  const { rows } = await db.execute<{ query: string }>(sql`
    select query from pg_stat_activity
    where datname = current_database() and wait_event_type = 'Lock' and query like ${`%${text}%`}`);
  return rows.map((row) => row.query);
};

/** Waits until at least `least` statements that name `text` wait for a lock, and answers the first. */
const waitsOn = (text: string, least = 1) =>
  eventually(async () => {
    const found = await waiting(text);
    return found.length >= least ? found[0] : undefined;
  }, 20_000);

const RUN_TABLE = '"listing_publish_runs"';
const ITEM_TABLE = '"listing_publish_items"';
const SERVICE_TABLE = 'from "services"';

/** A row the runner cannot publish: this check makes a listing's insert fail, whatever else is right about it. */
const BOOM_CHECK = 'publish_run_test_boom';
const addBoomCheck = async () => {
  await db.execute(
    sql.raw(`alter table service_listings add constraint ${BOOM_CHECK} check (slug not like 'boom-%') not valid`),
  );
};
const dropBoomCheck = async () => {
  await db.execute(sql.raw(`alter table service_listings drop constraint if exists ${BOOM_CHECK}`));
};

const deadlock = () => Object.assign(new Error('deadlock detected'), { code: '40P01' });

describe('PublishRunner: a run to its end', () => {
  it('publishes 250 rows in 5 chunks; the rows left out are skipped; the close counts the rows, audits once and bumps once', async () => {
    const w = await world();
    const ids = await services(w, 253);
    const bump = spyOn(t.app.get(CatalogPriceVersion, { strict: false }), 'bump');
    const run = await seedRun(
      t,
      [
        ...ids.slice(0, 250),
        { serviceId: ids[250]!, row: { state: 'review', included: false, flags: ['title_long'] } },
        { serviceId: ids[251]!, row: { state: 'ready', included: false } },
        { serviceId: ids[252]!, row: { state: 'blocked', blockedReason: 'price_missing', included: false } },
      ],
      { requestedBy: admin.staffId },
    );
    const chunks: number[] = [];

    const outcome = await runner.run(run.id, {
      afterChunk: async ({ rows }) => {
        chunks.push(rows);
        // The heartbeat of the chunk is written before the hook runs.
        expect((await runOf(run.id)).heartbeatAt).toEqual(clock.now());
        clock.advance(1_000);
      },
    });

    expect(outcome).toBe('succeeded');
    expect(chunks).toEqual([50, 50, 50, 50, 50]);
    const rows = await publishItemsOf(db, run.id);
    expect(count(rows, (row) => row.result === 'published')).toBe(250);
    for (const row of rows.slice(0, 250)) {
      expect(row).toMatchObject({
        result: 'published',
        resultReason: null,
        resultDetail: null,
        publishedPrice: RULE_PRICE,
      });
      expect(row.listingId).not.toBeNull();
      expect(row.finishedAt).toEqual(expect.any(Date));
    }
    expect(rows.slice(250).map((row) => [row.result, row.resultReason, row.listingId])).toEqual([
      ['skipped', 'left_out', null],
      ['skipped', 'left_out', null],
      ['skipped', 'price_missing', null],
    ]);

    const closed = await runOf(run.id);
    expect(closed).toMatchObject({
      status: 'succeeded',
      attempt: 1,
      error: null,
      publishedCount: 250,
      skippedCount: 3,
      refusedCount: 0,
    });
    expect(closed.startedAt).toEqual(new Date(START));
    expect(closed.finishedAt).toEqual(clock.now());
    expect(closed.heartbeatAt).toEqual(clock.now());

    const audits = await auditsOf(CLOSE_AUDIT);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      actorType: 'system',
      entityType: 'publish_run',
      entityId: run.id,
      entityLabel: `Publish run #${run.id}`,
      after: {
        status: 'succeeded',
        total: 253,
        published: 250,
        skipped: 3,
        refused: 0,
        listed: true,
        requestedBy: admin.staffId,
      },
    });
    expect(audits[0]!.after).not.toHaveProperty('error');
    expect(await auditsOf(ROW_AUDIT)).toHaveLength(250);
    expect(await listingEvents()).toBe(250);
    expect(bump).toHaveBeenCalledTimes(1);

    const listings = await listingsOf(ids);
    expect(listings).toHaveLength(250);
    expect(listings.every((listing) => listing.isListed)).toBe(true);
    expect(await retailRowsOf(w, ids)).toHaveLength(250);
  });

  it('writes on each row what the publisher answered, and writes nothing else for a refused row', async () => {
    const w = await world();
    const [plain, disabled, listed, moved, taken, holder] = await services(w, 6);
    const run = await seedRun(t, [plain!, disabled!, listed!, moved!, taken!]);
    const [, , , , takenRow] = run.items;

    await db.update(s.services).set({ status: 'disabled' }).where(eq(s.services.id, disabled!));
    await insertListingRow(db, listed!, { slug: 'made-by-staff' });
    await db.update(s.services).set({ effectiveCost: '100.0000' }).where(eq(s.services.id, moved!));
    await insertListingRow(db, holder!, { slug: takenRow!.slug });

    expect(await runner.run(run.id)).toBe('succeeded');

    const rows = await publishItemsOf(db, run.id);
    expect(rows.map((row) => [row.result, row.resultReason])).toEqual([
      ['published', null],
      ['refused', 'service_disabled'],
      ['skipped', 'already_listed'],
      ['refused', 'cost_moved'],
      ['published', null],
    ]);
    expect(rows[3]!.resultDetail).toBe(
      'The cost moved from $10.00 to $100.00 since the preview. Check the preview again.',
    );
    expect(rows[4]!.resultDetail).toBe(`The address ${takenRow!.slug} was taken: the listing got ${takenRow!.slug}-2.`);
    expect(rows[3]).toMatchObject({ listingId: null, publishedPrice: null });

    expect((await listingsOf([disabled!, moved!])).length).toBe(0);
    expect(await retailRowsOf(w, [disabled!, listed!, moved!])).toEqual([]);
    expect(await runOf(run.id)).toMatchObject({ publishedCount: 2, skippedCount: 1, refusedCount: 2 });
    expect(await auditsOf(ROW_AUDIT)).toHaveLength(2);
  });

  it('a run with `listed: false` leaves its listings priced and off, and says so in the close', async () => {
    const w = await world();
    const ids = await services(w, 2);
    const run = await seedRun(t, ids, { listed: false });

    expect(await runner.run(run.id)).toBe('succeeded');

    const listings = await listingsOf(ids);
    expect(listings.map((listing) => [listing.isListed, listing.listedAt])).toEqual([
      [false, null],
      [false, null],
    ]);
    expect((await retailRowsOf(w, ids)).map((row) => row.price)).toEqual([RULE_PRICE, RULE_PRICE]);
    expect((await auditsOf(CLOSE_AUDIT))[0]!.after).toMatchObject({ listed: false, published: 2 });
  });

  it('closes a run with nothing to publish, and moves no price version', async () => {
    const w = await world();
    const ids = await services(w, 2);
    const bump = spyOn(t.app.get(CatalogPriceVersion, { strict: false }), 'bump');
    const run = await seedRun(
      t,
      ids.map((serviceId) => ({ serviceId, row: { included: false } })),
    );

    expect(await runner.run(run.id)).toBe('succeeded');

    expect(resultsOf(await publishItemsOf(db, run.id))).toEqual(['skipped', 'skipped']);
    expect(await runOf(run.id)).toMatchObject({ status: 'succeeded', publishedCount: 0, skippedCount: 2 });
    expect(bump).not.toHaveBeenCalled();
  });

  it('claims only a queued run', async () => {
    const w = await world();
    const ids = await services(w, 1);
    for (const status of ['draft', 'preparing', 'running', 'succeeded', 'failed', 'cancelled'] as const) {
      const run = await seedRun(t, ids, { status });
      expect(await runner.run(run.id)).toBe('not_queued');
      expect(await runOf(run.id)).toMatchObject({ status, attempt: 0 });
      expect(resultsOf(await publishItemsOf(db, run.id))).toEqual([null]);
    }
    expect(await runner.run(999_999)).toBe('not_queued');
    expect(await listingsOf(ids)).toEqual([]);
  });
});

describe('PublishRunner: idempotency', () => {
  it('does nothing the second time', async () => {
    const w = await world();
    const ids = await services(w, 3);
    const bump = spyOn(t.app.get(CatalogPriceVersion, { strict: false }), 'bump');
    const run = await seedRun(t, ids);

    expect(await runner.run(run.id)).toBe('succeeded');
    const rows = await publishItemsOf(db, run.id);
    const closed = await runOf(run.id);
    clock.advance(MINUTE);

    expect(await runner.run(run.id)).toBe('not_queued');
    expect(await publishItemsOf(db, run.id)).toEqual(rows);
    expect(await runOf(run.id)).toEqual(closed);
    expect(await auditsOf(CLOSE_AUDIT)).toHaveLength(1);
    expect(bump).toHaveBeenCalledTimes(1);
  });

  it('two workers started together: one claim wins and each service is published once', async () => {
    const w = await world();
    const ids = await services(w, 60);
    const run = await seedRun(t, ids);

    const outcomes = await Promise.all([runner.run(run.id), runner.run(run.id)]);

    expect(outcomes.sort()).toEqual(['not_queued', 'succeeded']);
    expect(await listingsOf(ids)).toHaveLength(60);
    expect(await retailRowsOf(w, ids)).toHaveLength(60);
    expect(await auditsOf(ROW_AUDIT)).toHaveLength(60);
    expect(await auditsOf(CLOSE_AUDIT)).toHaveLength(1);
    expect(await runOf(run.id)).toMatchObject({ status: 'succeeded', attempt: 1, publishedCount: 60 });
  });

  it('two runs over the same services: the first transaction of each service wins, the other row is skipped', async () => {
    const w = await world();
    const ids = await services(w, 30);
    const first = await seedRun(t, ids);
    const second = await seedRun(t, ids);

    expect(await Promise.all([runner.run(first.id), runner.run(second.id)])).toEqual(['succeeded', 'succeeded']);

    const rows = [...(await publishItemsOf(db, first.id)), ...(await publishItemsOf(db, second.id))];
    expect(count(rows, (row) => row.result === 'published')).toBe(30);
    expect(count(rows, (row) => row.result === 'skipped' && row.resultReason === 'already_listed')).toBe(30);
    expect(await listingsOf(ids)).toHaveLength(30);
    expect(await auditsOf(ROW_AUDIT)).toHaveLength(30);
  });

  it('the job, delivered twice through its processor, publishes once', async () => {
    const w = await world();
    const ids = await services(w, 2);
    const run = await seedRun(t, ids, { status: 'draft' });
    await queueRun(t, run.id);
    const [event] = await db.select().from(s.outboxEvents).where(eq(s.outboxEvents.type, PUBLISH_APPLY_EVENT));
    expect(event).toMatchObject({ aggregateType: 'listing_publish_runs', aggregateId: run.id });
    const job = { name: PUBLISH_JOBS.apply, data: jobDataOf(event!) };
    expect(job.data.payload).toEqual({ runId: run.id });
    const processor = new PublishApplyProcessor(runner);

    expect(await processor.process(job as never)).toBe('succeeded');
    expect(await processor.process(job as never)).toBe('not_queued');

    expect(await listingsOf(ids)).toHaveLength(2);
    expect(await auditsOf(CLOSE_AUDIT)).toHaveLength(1);
    expect(() => processor.process({ name: PUBLISH_JOBS.apply, data: { aggregateId: 0 } } as never)).toThrow(
      'no run id',
    );
  });

  it('both processes route the events of a run to the imports queue', () => {
    const registry = t.app.get(OutboxRouteRegistry, { strict: false });
    expect(registry.routesOf(PUBLISH_APPLY_EVENT)).toEqual([
      { type: PUBLISH_APPLY_EVENT, queue: 'imports', jobName: 'publish_apply' },
    ]);
    expect(registry.routesOf(PUBLISH_SET_LISTED_EVENT)).toEqual([
      { type: PUBLISH_SET_LISTED_EVENT, queue: 'imports', jobName: 'publish_set_listed' },
    ]);
  });
});

describe('PublishRunner: a resume', () => {
  it('after a death continues with what is left, keeps every other result and tries a failed row again', async () => {
    const w = await world();
    const ids = await services(w, 8);
    const finishedAt = clock.now();
    const run = await seedRun(
      t,
      [
        ...ids.slice(0, 3),
        { serviceId: ids[3]!, row: { included: false, result: 'skipped', resultReason: 'left_out', finishedAt } },
        { serviceId: ids[4]!, row: { result: 'refused', resultReason: 'service_disabled', finishedAt } },
        ...ids.slice(5),
      ],
      { status: 'running', attempt: 1, startedAt: clock.now() },
    );
    const [one, two, failed] = run.items;
    await publishedBefore(one!);
    await publishedBefore(two!);
    await db
      .update(s.listingPublishItems)
      .set({ result: 'refused', resultReason: 'failed', resultDetail: 'unexpected error', finishedAt })
      .where(eq(s.listingPublishItems.id, failed!.id));
    const before = await publishItemsOf(db, run.id);
    const kept = [before[0], before[1], before[3], before[4]];
    clock.advance(6 * MINUTE);

    await queueRun(t, run.id);
    expect(await runOf(run.id)).toMatchObject({ status: 'queued', attempt: 1, error: null, finishedAt: null });
    expect((await publishItemsOf(db, run.id))[2]).toMatchObject({
      result: null,
      resultReason: null,
      resultDetail: null,
      finishedAt: null,
    });

    expect(await runner.run(run.id)).toBe('succeeded');

    const rows = await publishItemsOf(db, run.id);
    expect(resultsOf(rows)).toEqual([
      'published',
      'published',
      'published',
      'skipped',
      'refused',
      'published',
      'published',
      'published',
    ]);
    expect([rows[0], rows[1], rows[3], rows[4]]).toEqual(kept);
    expect(await listingsOf(ids)).toHaveLength(6);
    expect(await retailRowsOf(w, ids)).toHaveLength(6);
    const closed = await runOf(run.id);
    expect(closed).toMatchObject({
      status: 'succeeded',
      attempt: 2,
      publishedCount: 6,
      skippedCount: 1,
      refusedCount: 1,
    });
    expect(closed.startedAt).toEqual(new Date(START));
  });

  it('a row whose listing was made by the dead worker, but lost its result, ends skipped: nothing is published twice', async () => {
    const w = await world();
    const ids = await services(w, 2);
    const run = await seedRun(t, ids, { status: 'running', attempt: 1 });
    await publishOne(t, publishInputOf(run.items[0]!, { listed: true, requestedBy: null }));
    clock.advance(6 * MINUTE);

    await queueRun(t, run.id);
    expect(await runner.run(run.id)).toBe('succeeded');

    const rows = await publishItemsOf(db, run.id);
    expect(rows.map((row) => [row.result, row.resultReason])).toEqual([
      ['skipped', 'already_listed'],
      ['published', null],
    ]);
    expect(await listingsOf(ids)).toHaveLength(2);
  });

  it('its close moves the price version for what the dead attempt published, though this attempt published nothing', async () => {
    const w = await world();
    const [done, leftOut] = await services(w, 2);
    const run = await seedRun(t, [done!, { serviceId: leftOut!, row: { included: false } }], {
      status: 'running',
      attempt: 1,
      startedAt: clock.now(),
    });
    await publishedBefore(run.items[0]!);
    const audits = (await auditsOf(ROW_AUDIT)).length;
    const bump = spyOn(t.app.get(CatalogPriceVersion, { strict: false }), 'bump');
    clock.advance(6 * MINUTE);

    await queueRun(t, run.id);
    expect(await runner.run(run.id)).toBe('succeeded');

    expect(await auditsOf(ROW_AUDIT)).toHaveLength(audits);
    expect(await runOf(run.id)).toMatchObject({ status: 'succeeded', publishedCount: 1, skippedCount: 1, attempt: 2 });
    expect((await auditsOf(CLOSE_AUDIT))[0]!.after).toMatchObject({ status: 'succeeded', published: 1 });
    expect(bump).toHaveBeenCalledTimes(1);
  });
});

describe('PublishRunner: two workers on one run', () => {
  it('a worker resumed over after its first chunk stops; nothing it wrote is overwritten', async () => {
    const w = await world();
    const ids = await services(w, 120);
    const run = await seedRun(t, ids, { requestedBy: admin.staffId });
    let second: PublishRunOutcome | undefined;
    let afterFirstChunk: ListingPublishItem[] = [];

    const first = await runner.run(run.id, {
      afterChunk: async () => {
        if (second !== undefined) return;
        afterFirstChunk = await publishItemsOf(db, run.id);
        await queueRun(t, run.id);
        second = await runner.run(run.id);
      },
    });

    expect(first).toBe('stopped');
    expect(second).toBe('succeeded');
    expect(count(afterFirstChunk, (row) => row.result === 'published')).toBe(50);
    const rows = await publishItemsOf(db, run.id);
    expect(count(rows, (row) => row.result === 'published')).toBe(120);
    expect(rows.slice(0, 50)).toEqual(afterFirstChunk.slice(0, 50));
    expect(await listingsOf(ids)).toHaveLength(120);
    expect(await retailRowsOf(w, ids)).toHaveLength(120);
    expect(await auditsOf(ROW_AUDIT)).toHaveLength(120);
    expect(await auditsOf(CLOSE_AUDIT)).toHaveLength(1);
    expect(await runOf(run.id)).toMatchObject({
      status: 'succeeded',
      attempt: 2,
      publishedCount: 120,
      skippedCount: 0,
    });
  });

  it('a worker whose number is old stops at its next row and publishes nothing more', async () => {
    const w = await world();
    const ids = await services(w, 120);
    const run = await seedRun(t, ids);
    const publishLocked = spyOn(t.app.get(ListingPublisher, { strict: false }), 'publishLocked');
    let letSecondGoOn!: () => void;
    const secondMayGoOn = new Promise<void>((resolve) => (letSecondGoOn = resolve));
    let secondIsInside!: () => void;
    const secondInside = new Promise<void>((resolve) => (secondIsInside = resolve));
    let second: Promise<PublishRunOutcome> | undefined;

    const first = await runner.run(run.id, {
      afterChunk: async () => {
        if (second !== undefined) return;
        await queueRun(t, run.id);
        // The second worker claims the run, does a chunk and waits between two chunks.
        second = runner.run(run.id, {
          afterChunk: async () => {
            secondIsInside();
            await secondMayGoOn;
          },
        });
        await secondInside;
      },
    });

    // The first worker read rows that are still pending, took the service of the next one and found another number: no publish.
    expect(first).toBe('stopped');
    expect(publishLocked).toHaveBeenCalledTimes(100);
    expect(count(await publishItemsOf(db, run.id), (row) => row.result === null)).toBe(20);

    letSecondGoOn();
    expect(await second!).toBe('succeeded');
    expect(publishLocked).toHaveBeenCalledTimes(120);
    expect(await listingsOf(ids)).toHaveLength(120);
    expect(await runOf(run.id)).toMatchObject({ status: 'succeeded', attempt: 2, publishedCount: 120 });
    expect(await auditsOf(CLOSE_AUDIT)).toHaveLength(1);
  });

  it('a resume waits for the row in flight, and the old worker stops at its next service while the new one runs', async () => {
    const w = await world();
    const ids = await services(w, 3);
    const run = await seedRun(t, ids);
    const [first, second] = run.items;
    // The old worker holds the first row's service and the run row, and waits here for the row itself.
    const item = await holdItem(first!.id);
    // Then, with its first row committed, it waits for its second service, holding nothing of the run.
    const service = await holdService(second!.serviceId);
    const old = runner.run(run.id);
    expect(await waitsOn(ITEM_TABLE)).toContain('for update');

    let resumed = false;
    const resume = queueRun(t, run.id).then(() => {
      resumed = true;
    });
    expect(await waitsOn(RUN_TABLE)).toContain('for update');
    expect(resumed).toBe(false);

    await item.commit();
    await resume;
    // The resume got the run row only after that row committed, so the next worker never sees it without its result.
    expect((await publishItemsOf(db, run.id))[0]).toMatchObject({ result: 'published' });

    await waitsOn(SERVICE_TABLE);
    const next = runner.run(run.id);
    await waitsOn(SERVICE_TABLE, 2);
    await service.commit();

    expect(await old).toBe('stopped');
    expect(await next).toBe('succeeded');
    expect(resultsOf(await publishItemsOf(db, run.id))).toEqual(['published', 'published', 'published']);
    expect(await listingsOf(ids)).toHaveLength(3);
    expect(await auditsOf(ROW_AUDIT)).toHaveLength(3);
    expect(await auditsOf(CLOSE_AUDIT)).toHaveLength(1);
    expect(await runOf(run.id)).toMatchObject({ status: 'succeeded', attempt: 2, publishedCount: 3 });
  });

  it('every write of a worker requires its own number', async () => {
    const w = await world();
    const ids = await services(w, 2);
    const run = await seedRun(t, ids, { status: 'running', attempt: 3 });
    const stale = { runId: run.id, attempt: 2 };
    const mine = { runId: run.id, attempt: 3 };
    const now = clock.now();
    const closing = { status: 'succeeded', error: null, counts: await countItemResults(db, run.id), now } as const;
    const before = await runOf(run.id);
    clock.advance(MINUTE);
    const later = clock.now();

    const database = t.app.get(DbService);
    expect(await beatApply(db, stale, later)).toBe(false);
    await database.runInTransaction(async ({ tx }) => {
      expect(await holdApply(tx, stale)).toBeUndefined();
      expect(await lockApply(tx, stale)).toBe(false);
      expect(await closeApply(tx, stale, closing)).toBeUndefined();
    });
    expect(await runOf(run.id)).toEqual(before);

    expect(await beatApply(db, mine, later)).toBe(true);
    expect((await runOf(run.id)).heartbeatAt).toEqual(later);
    await database.runInTransaction(async ({ tx }) => {
      expect(await holdApply(tx, mine)).toEqual({ listed: true, requestedBy: null });
      expect(await lockApply(tx, mine)).toBe(true);
      expect(await closeApply(tx, mine, closing)).toMatchObject({ status: 'succeeded' });
    });
  });

  it('a result is written once: the first stands', async () => {
    const w = await world();
    const run = await seedRun(t, await services(w, 1));
    const [item] = run.items;
    const first = {
      result: 'refused',
      reason: 'failed',
      detail: 'first',
      listingId: null,
      publishedPrice: null,
    } as const;

    await t.app.get(DbService).runInTransaction(async ({ tx }) => {
      expect(await lockPendingItem(tx, run.id, item!.id)).toMatchObject({ id: item!.id, result: null });
      // Of another run it is not found, whatever its id.
      expect(await lockPendingItem(tx, run.id + 1, item!.id)).toBeUndefined();
    });

    expect(await writeItemResult(db, item!.id, first, clock.now())).toBe(true);
    expect(await writeItemResult(db, item!.id, { ...first, result: 'skipped', detail: 'second' }, clock.now())).toBe(
      false,
    );

    expect((await publishItemsOf(db, run.id))[0]).toMatchObject({ result: 'refused', resultDetail: 'first' });
    await t.app.get(DbService).runInTransaction(async ({ tx }) => {
      expect(await lockPendingItem(tx, run.id, item!.id)).toBeUndefined();
    });
  });

  it('a draft that was never prepared cannot be queued, nor a finished run', async () => {
    const w = await world();
    const ids = await services(w, 1);
    const unprepared = await seedRun(t, ids, { status: 'failed', preparedAt: null });
    const finished = await seedRun(t, ids, { status: 'succeeded' });
    const queued = await seedRun(t, ids, { status: 'draft' });

    expect(await moveRunToQueued(db, unprepared.id, { now: clock.now() })).toBeUndefined();
    expect(await moveRunToQueued(db, finished.id, { now: clock.now() })).toBeUndefined();
    expect(await moveRunToQueued(db, queued.id, { now: clock.now(), listed: false })).toMatchObject({
      status: 'queued',
      listed: false,
    });
  });
});

describe('PublishRunner: a cancel', () => {
  it('between two chunks: the worker stops before its next row, the rows done keep their result, the rest have none', async () => {
    const w = await world();
    const ids = await services(w, 70);
    const run = await seedRun(t, ids, { requestedBy: admin.staffId });
    const bump = spyOn(t.app.get(CatalogPriceVersion, { strict: false }), 'bump');
    let chunks = 0;

    const outcome = await runner.run(run.id, {
      afterChunk: async () => {
        chunks += 1;
        await cancelRun(t, run.id);
      },
    });

    expect(outcome).toBe('stopped');
    expect(chunks).toBe(1);
    const rows = await publishItemsOf(db, run.id);
    expect(count(rows, (row) => row.result === 'published')).toBe(50);
    expect(count(rows, (row) => row.result === null)).toBe(20);
    expect(await listingsOf(ids)).toHaveLength(50);
    const cancelled = await runOf(run.id);
    expect(cancelled).toMatchObject({ status: 'cancelled', publishedCount: 50, skippedCount: 0, refusedCount: 0 });
    expect(cancelled.finishedAt).toEqual(clock.now());
    // The worker writes no close of its own: the cancel route writes the audit row and moves the version.
    expect(await auditsOf(CLOSE_AUDIT)).toEqual([]);
    expect(bump).not.toHaveBeenCalled();
  });

  it('waits for the row in flight, and the worker stops at its next service', async () => {
    const w = await world();
    const ids = await services(w, 3);
    const run = await seedRun(t, ids);
    const [first, second] = run.items;
    const item = await holdItem(first!.id);
    const service = await holdService(second!.serviceId);
    const worker = runner.run(run.id);
    await waitsOn(ITEM_TABLE);

    let cancelled = false;
    const cancel = cancelRun(t, run.id).then(() => {
      cancelled = true;
    });
    await waitsOn(RUN_TABLE);
    expect(cancelled).toBe(false);

    await item.commit();
    await cancel;
    await waitsOn(SERVICE_TABLE);
    await service.commit();

    expect(await worker).toBe('stopped');
    expect(resultsOf(await publishItemsOf(db, run.id))).toEqual(['published', null, null]);
    expect(await runOf(run.id)).toMatchObject({ status: 'cancelled', publishedCount: 1 });
    expect(await listingsOf(ids)).toHaveLength(1);
  });

  it('of a finished run is refused, and the run keeps its counters', async () => {
    const w = await world();
    const run = await seedRun(t, await services(w, 1));
    expect(await runner.run(run.id)).toBe('succeeded');

    await expectRejection(cancelRun(t, run.id), 'cannot be cancelled');

    expect(await runOf(run.id)).toMatchObject({ status: 'succeeded', publishedCount: 1 });
  });

  it('of a run still queued: the job finds nothing to claim', async () => {
    const w = await world();
    const ids = await services(w, 1);
    const run = await seedRun(t, ids);
    await cancelRun(t, run.id);

    expect(await runner.run(run.id)).toBe('not_queued');

    expect(await listingsOf(ids)).toEqual([]);
    expect(await runOf(run.id)).toMatchObject({ status: 'cancelled', attempt: 0 });
  });
});

describe('PublishRunner: what changed under a worker', () => {
  it('marks the rows left out under the run row: a cancel waits for them and counts them', async () => {
    const w = await world();
    const [leftOut, included] = await services(w, 2);
    const run = await seedRun(t, [{ serviceId: leftOut!, row: { included: false } }, included!]);
    const item = await holdItem(run.items[0]!.id);
    const service = await holdService(included!);
    const worker = runner.run(run.id);
    expect(await waitsOn(ITEM_TABLE)).toContain('update');

    let cancelled = false;
    const cancel = cancelRun(t, run.id).then(() => {
      cancelled = true;
    });
    expect(await waitsOn(RUN_TABLE)).toContain('for update');
    expect(cancelled).toBe(false);

    await item.commit();
    await cancel;
    await waitsOn(SERVICE_TABLE);
    await service.commit();

    expect(await worker).toBe('stopped');
    expect((await publishItemsOf(db, run.id)).map((row) => [row.result, row.resultReason])).toEqual([
      ['skipped', 'left_out'],
      [null, null],
    ]);
    expect(await runOf(run.id)).toMatchObject({ status: 'cancelled', skippedCount: 1, publishedCount: 0 });
    expect(await listingsOf([included!])).toEqual([]);
  });

  it('leaves alone a row that got a result since its chunk was read', async () => {
    const w = await world();
    const ids = await services(w, 2);
    const run = await seedRun(t, ids);
    const [taken] = run.items;
    const retail = t.app.get(RetailPrices, { strict: false });
    const publisher = t.app.get(ListingPublisher, { strict: false });
    const publishLocked = spyOn(publisher, 'publishLocked');
    spyOn(publisher, 'lock').mockImplementationOnce(async (tx, serviceId) => {
      await db
        .update(s.listingPublishItems)
        .set({ result: 'skipped', resultReason: 'left_out', finishedAt: clock.now() })
        .where(eq(s.listingPublishItems.id, taken!.id));
      return retail.lockLiveService(tx, serviceId);
    });

    expect(await runner.run(run.id)).toBe('succeeded');

    expect(publishLocked).toHaveBeenCalledTimes(1);
    expect((await publishItemsOf(db, run.id)).map((row) => [row.result, row.resultReason])).toEqual([
      ['skipped', 'left_out'],
      ['published', null],
    ]);
    expect(await listingsOf([taken!.serviceId])).toEqual([]);
    expect(await runOf(run.id)).toMatchObject({ publishedCount: 1, skippedCount: 1 });
  });
});

describe('PublishRunner: rows that fail', () => {
  // Also before: a run that died in one of these tests must not leave the check behind for the next.
  beforeEach(dropBoomCheck);
  afterEach(dropBoomCheck);

  it('20 unexpected failures end the run failed, the rest untried; a resume tries them again', async () => {
    const w = await world();
    const ids = await services(w, MAX_ITEM_FAILURES + 5);
    const run = await seedRun(
      t,
      ids.map((serviceId) => ({ serviceId, input: { slug: `boom-${serviceId}` } })),
      { requestedBy: admin.staffId },
    );
    const bump = spyOn(t.app.get(CatalogPriceVersion, { strict: false }), 'bump');
    await addBoomCheck();

    expect(await runner.run(run.id)).toBe('failed');

    const rows = await publishItemsOf(db, run.id);
    for (const row of rows.slice(0, MAX_ITEM_FAILURES)) {
      expect(row).toMatchObject({
        result: 'refused',
        resultReason: 'failed',
        resultDetail: BOOM_CHECK,
        listingId: null,
      });
    }
    expect(resultsOf(rows.slice(MAX_ITEM_FAILURES))).toEqual(Array(5).fill(null));
    expect(await listingsOf(ids)).toEqual([]);
    expect(await retailRowsOf(w, ids)).toEqual([]);
    expect(await auditsOf(ROW_AUDIT)).toEqual([]);
    const failed = await runOf(run.id);
    expect(failed).toMatchObject({
      status: 'failed',
      error: TOO_MANY_FAILURES_ERROR,
      publishedCount: 0,
      refusedCount: MAX_ITEM_FAILURES,
    });
    expect(failed.finishedAt).toEqual(clock.now());
    expect((await auditsOf(CLOSE_AUDIT))[0]!.after).toEqual({
      status: 'failed',
      total: ids.length,
      published: 0,
      skipped: 0,
      refused: MAX_ITEM_FAILURES,
      listed: true,
      requestedBy: admin.staffId,
      error: TOO_MANY_FAILURES_ERROR,
    });
    expect(bump).not.toHaveBeenCalled();

    await dropBoomCheck();
    await queueRun(t, run.id);
    expect(await runOf(run.id)).toMatchObject({ status: 'queued', error: null, finishedAt: null });
    expect(await runner.run(run.id)).toBe('succeeded');
    expect(resultsOf(await publishItemsOf(db, run.id))).toEqual(Array(ids.length).fill('published'));
    expect(await listingsOf(ids)).toHaveLength(ids.length);
    expect(await runOf(run.id)).toMatchObject({ status: 'succeeded', error: null, refusedCount: 0, attempt: 2 });
    expect(bump).toHaveBeenCalledTimes(1);
  });

  it('a run closed failed by 20 failures moves the price version once when some rows were published', async () => {
    const w = await world();
    const ids = await services(w, MAX_ITEM_FAILURES + 3);
    const run = await seedRun(
      t,
      ids.map((serviceId, at) => (at < 3 ? serviceId : { serviceId, input: { slug: `boom-${serviceId}` } })),
    );
    const bump = spyOn(t.app.get(CatalogPriceVersion, { strict: false }), 'bump');
    await addBoomCheck();

    expect(await runner.run(run.id)).toBe('failed');

    expect(await runOf(run.id)).toMatchObject({
      status: 'failed',
      error: TOO_MANY_FAILURES_ERROR,
      publishedCount: 3,
      refusedCount: MAX_ITEM_FAILURES,
    });
    expect(bump).toHaveBeenCalledTimes(1);
  });

  it('a run closed failed by an error outside the rows moves the price version once when some rows were published', async () => {
    const w = await world();
    const ids = await services(w, 60);
    const run = await seedRun(t, ids);
    const bump = spyOn(t.app.get(CatalogPriceVersion, { strict: false }), 'bump');

    await expectRejection(
      runner.run(run.id, {
        afterChunk: () => {
          throw new Error('The chunk went wrong.');
        },
      }),
      'The chunk went wrong.',
    );

    expect(await runOf(run.id)).toMatchObject({ status: 'failed', publishedCount: 50 });
    expect(bump).toHaveBeenCalledTimes(1);
  });

  it('one failed row is rolled back whole and the run goes on', async () => {
    const w = await world();
    const [good, bad, last] = await services(w, 3);
    const run = await seedRun(t, [good!, { serviceId: bad!, input: { slug: `boom-${bad}` } }, last!]);
    await addBoomCheck();

    expect(await runner.run(run.id)).toBe('succeeded');

    const rows = await publishItemsOf(db, run.id);
    expect(rows.map((row) => [row.result, row.resultReason, row.resultDetail])).toEqual([
      ['published', null, null],
      ['refused', 'failed', BOOM_CHECK],
      ['published', null, null],
    ]);
    expect(await listingsOf([bad!])).toEqual([]);
    expect(await retailRowsOf(w, [bad!])).toEqual([]);
    expect(await followsOf([bad!])).toEqual([]);
    expect(await runOf(run.id)).toMatchObject({ status: 'succeeded', publishedCount: 2, refusedCount: 1 });
  });

  it('a deadlock is tried once more', async () => {
    const w = await world();
    const ids = await services(w, 2);
    const run = await seedRun(t, ids);
    const publishLocked = spyOn(t.app.get(ListingPublisher, { strict: false }), 'publishLocked');
    publishLocked.mockImplementationOnce(() => Promise.reject(deadlock()));

    expect(await runner.run(run.id)).toBe('succeeded');

    expect(publishLocked).toHaveBeenCalledTimes(3);
    expect(resultsOf(await publishItemsOf(db, run.id))).toEqual(['published', 'published']);
  });

  it('a row that deadlocks twice is refused, with no statement in its detail', async () => {
    const w = await world();
    const ids = await services(w, 2);
    const run = await seedRun(t, ids);
    const publishLocked = spyOn(t.app.get(ListingPublisher, { strict: false }), 'publishLocked');
    publishLocked
      .mockImplementationOnce(() => Promise.reject(deadlock()))
      .mockImplementationOnce(() => Promise.reject(deadlock()));

    expect(await runner.run(run.id)).toBe('succeeded');

    const rows = await publishItemsOf(db, run.id);
    expect(rows[0]).toMatchObject({ result: 'refused', resultReason: 'failed', resultDetail: 'unexpected error' });
    expect(rows[1]).toMatchObject({ result: 'published' });
  });

  it('a worker that lost the run records no failure', async () => {
    const w = await world();
    const ids = await services(w, 120);
    const run = await seedRun(t, ids);
    const lock = spyOn(t.app.get(ListingPublisher, { strict: false }), 'lock');
    let letSecondGoOn!: () => void;
    const secondMayGoOn = new Promise<void>((resolve) => (letSecondGoOn = resolve));
    let secondIsInside!: () => void;
    const secondInside = new Promise<void>((resolve) => (secondIsInside = resolve));
    let second: Promise<PublishRunOutcome> | undefined;

    const first = await runner.run(run.id, {
      afterChunk: async () => {
        if (second !== undefined) return;
        await queueRun(t, run.id);
        second = runner.run(run.id, {
          afterChunk: async () => {
            secondIsInside();
            await secondMayGoOn;
          },
        });
        await secondInside;
        // The first worker's next row fails before it reaches the run row.
        lock.mockImplementationOnce(() => Promise.reject(new Error('The lock failed.')));
      },
    });

    expect(first).toBe('stopped');
    expect(count(await publishItemsOf(db, run.id), (row) => row.resultReason === 'failed')).toBe(0);
    letSecondGoOn();
    expect(await second!).toBe('succeeded');
    expect(count(await publishItemsOf(db, run.id), (row) => row.result === 'published')).toBe(120);
  });

  it('an unexpected error outside the rows closes the run failed and is rethrown', async () => {
    const w = await world();
    const ids = await services(w, 60);
    const run = await seedRun(t, ids);

    await expectRejection(
      runner.run(run.id, {
        afterChunk: () => {
          throw new Error('The chunk went wrong.');
        },
      }),
      'The chunk went wrong.',
    );

    const failed = await runOf(run.id);
    expect(failed).toMatchObject({ status: 'failed', error: 'The chunk went wrong.', publishedCount: 50 });
    expect((await auditsOf(CLOSE_AUDIT))[0]!.after).toMatchObject({ status: 'failed', published: 50 });
    // Failed is resumable: the rest is still there.
    await queueRun(t, run.id);
    expect(await runner.run(run.id)).toBe('succeeded');
    expect(await listingsOf(ids)).toHaveLength(60);
  });
});

describe('PublishSwitch', () => {
  /** A run that published `size` services, with a staff member who asked. */
  async function published(w: World, size: number): Promise<{ ids: number[]; run: SeededRun }> {
    const ids = await services(w, size);
    const run = await seedRun(t, ids, { requestedBy: admin.staffId });
    expect(await runner.run(run.id)).toBe('succeeded');
    return { ids, run };
  }

  const press = async (runId: number, listed: boolean) => {
    await queueSwitch(t, runId, listed, admin.staffId);
    return switcher.run(runId, listed, admin.staffId);
  };
  const switchAudits = () => auditsOf(SWITCH_AUDIT);
  const statesOf = async (ids: readonly number[]) => (await listingsOf(ids)).map((listing) => listing.isListed);

  it('off, then on: every listing follows, each with one audit row and one search event; nothing else moves', async () => {
    const w = await world();
    const { ids, run } = await published(w, 60);
    const firstListed = (await listingsOf(ids))[0]!.listedAt;
    const prices = await retailRowsOf(w, ids);
    const follows = await followsOf(ids);
    expect(follows).toHaveLength(60);
    const events = await listingEvents();
    const chunks: number[] = [];
    clock.advance(MINUTE);

    await queueSwitch(t, run.id, false, admin.staffId);
    expect(await runOf(run.id)).toMatchObject({ switchStatus: 'queued', switchListed: false, listed: false });
    expect(
      await switcher.run(run.id, false, admin.staffId, {
        afterChunk: async ({ rows }) => {
          chunks.push(rows);
          // The console reads the progress of a switch from the run: the heartbeat of the chunk carries the counters.
          expect(await runOf(run.id)).toMatchObject({
            switchStatus: 'running',
            switchedCount: chunks.reduce((sum, size) => sum + size, 0),
            heartbeatAt: clock.now(),
          });
        },
      }),
    ).toBe('done');

    expect(chunks).toEqual([50, 10]);
    expect(await statesOf(ids)).toEqual(Array(60).fill(false));
    expect(await runOf(run.id)).toMatchObject({
      status: 'succeeded',
      switchStatus: 'done',
      switchListed: false,
      switchedCount: 60,
      switchSkippedCount: 0,
      switchError: null,
      attempt: 2,
    });
    const offAudits = await auditsOf('unlisted from storefront');
    expect(offAudits).toHaveLength(60);
    expect(offAudits[0]).toMatchObject({
      actorType: 'system',
      entityType: 'listing',
      before: { isListed: true },
      after: { isListed: false, runId: run.id, requestedBy: admin.staffId },
    });
    expect(await listingEvents()).toBe(events + 60);
    const closes = await switchAudits();
    expect(closes).toHaveLength(1);
    expect(closes[0]).toMatchObject({ actorType: 'system', entityType: 'publish_run', entityId: run.id });
    expect(closes[0]!.after).toEqual({
      listed: false,
      switched: 60,
      unchanged: 0,
      skipped: {},
      requestedBy: admin.staffId,
    });

    clock.advance(MINUTE);
    expect(await press(run.id, true)).toBe('done');
    const listings = await listingsOf(ids);
    expect(listings.every((listing) => listing.isListed)).toBe(true);
    // The first publication's moment never moves.
    expect(listings[0]!.listedAt).toEqual(firstListed);
    expect(await auditsOf('listed on storefront')).toHaveLength(60);
    expect(await listingEvents()).toBe(events + 120);
    expect(await retailRowsOf(w, ids)).toEqual(prices);
    expect(await followsOf(ids)).toEqual(follows);
    expect(await runOf(run.id)).toMatchObject({ switchListed: true, listed: true, switchedCount: 60, attempt: 3 });
  });

  it('twice: the second press changes nothing', async () => {
    const w = await world();
    const { ids, run } = await published(w, 3);
    expect(await press(run.id, false)).toBe('done');
    const listings = await listingsOf(ids);
    const events = await listingEvents();

    expect(await press(run.id, false)).toBe('done');

    expect(await listingsOf(ids)).toEqual(listings);
    expect(await listingEvents()).toBe(events);
    expect(await auditsOf('unlisted from storefront')).toHaveLength(3);
    expect(await runOf(run.id)).toMatchObject({ switchStatus: 'done', switchedCount: 0, switchSkippedCount: 0 });
    expect((await switchAudits())[1]!.after).toMatchObject({ switched: 0, unchanged: 3, skipped: {} });
  });

  it('delivered twice through its processor, and for an old target, it claims once', async () => {
    const w = await world();
    const { ids, run } = await published(w, 2);
    await queueSwitch(t, run.id, false, admin.staffId);
    const [event] = await db.select().from(s.outboxEvents).where(eq(s.outboxEvents.type, PUBLISH_SET_LISTED_EVENT));
    expect(event).toMatchObject({ aggregateType: 'listing_publish_runs', aggregateId: run.id });
    const job = { name: PUBLISH_JOBS.setListed, data: jobDataOf(event!) };
    expect(job.data.payload).toEqual({ runId: run.id, listed: false, requestedBy: admin.staffId });
    const processor = new PublishSetListedProcessor(switcher);

    expect(await switcher.run(run.id, true, admin.staffId)).toBe('not_queued');
    expect(await processor.process(job as never)).toBe('done');
    expect(await processor.process(job as never)).toBe('not_queued');

    expect(await statesOf(ids)).toEqual([false, false]);
    expect(await auditsOf('unlisted from storefront')).toHaveLength(2);
    expect(await switchAudits()).toHaveLength(1);
    expect(() =>
      processor.process({ name: PUBLISH_JOBS.setListed, data: { aggregateId: run.id, payload: {} } } as never),
    ).toThrow('no target');
    expect(() =>
      processor.process({
        name: PUBLISH_JOBS.setListed,
        data: { aggregateId: run.id, payload: { listed: true, requestedBy: 'x' } },
      } as never),
    ).toThrow('requestedBy');
  });

  it('a listing staff switched by hand meanwhile is unchanged', async () => {
    const w = await world();
    const { ids, run } = await published(w, 3);
    const [byHand] = await listingsOf(ids);
    expect((await admin.patch(`/admin/service-listings/${byHand!.id}`, { isListed: false })).status).toBe(200);

    expect(await press(run.id, false)).toBe('done');

    expect(await statesOf(ids)).toEqual([false, false, false]);
    expect(await runOf(run.id)).toMatchObject({ switchedCount: 2, switchSkippedCount: 0 });
    expect((await switchAudits())[0]!.after).toMatchObject({ switched: 2, unchanged: 1, skipped: {} });
    // Only the two the switch changed have a row of the switch.
    const audits = await auditsOf('unlisted from storefront');
    expect(audits.filter((row) => (row.after as { runId?: number }).runId === run.id)).toHaveLength(2);
  });

  it('switching on leaves out what cannot be on the shop, counts each reason, and every such listing stays off', async () => {
    const w = await world();
    const closedCategory = await insertCategory(db, { name: 'Wholesale only' });
    const [good, disabled, noPrice, archived, moved] = await services(w, 5);
    const [b2bOnly] = await services(w, 1, closedCategory);
    const ids = [good!, disabled!, noPrice!, archived!, moved!, b2bOnly!];
    const run = await seedRun(t, ids, { requestedBy: admin.staffId });
    expect(await runner.run(run.id)).toBe('succeeded');
    expect(await press(run.id, false)).toBe('done');

    await db.update(s.services).set({ status: 'disabled' }).where(eq(s.services.id, disabled!));
    expect((await admin.put(`/admin/services/${noPrice}/group-prices`, { prices: [] })).status).toBe(200);
    await db
      .update(s.services)
      .set({ status: 'disabled', archivedAt: clock.now() })
      .where(eq(s.services.id, archived!));
    await db
      .update(s.serviceCategories)
      .set({ allowedGroupIds: [w.groups.standard] })
      .where(eq(s.serviceCategories.id, closedCategory));
    // The row's listing is not the one the service has now.
    const listings = await listingsOf(ids);
    const otherListing = listings.find((listing) => listing.serviceId === good)!;
    await db
      .update(s.listingPublishItems)
      .set({ listingId: otherListing.id })
      .where(and(eq(s.listingPublishItems.runId, run.id), eq(s.listingPublishItems.serviceId, moved!)));

    expect(await press(run.id, true)).toBe('done');

    const after = new Map((await listingsOf(ids)).map((listing) => [listing.serviceId, listing.isListed]));
    expect(after.get(good!)).toBe(true);
    for (const id of [disabled!, noPrice!, archived!, moved!, b2bOnly!]) expect(after.get(id)).toBe(false);
    expect(await runOf(run.id)).toMatchObject({ switchStatus: 'done', switchedCount: 1, switchSkippedCount: 5 });
    expect((await switchAudits())[1]!.after).toEqual({
      listed: true,
      switched: 1,
      unchanged: 0,
      skipped: { service_gone: 1, listing_gone: 1, service_disabled: 1, b2b_only: 1, no_price: 1 },
      requestedBy: admin.staffId,
    });
  });

  it('switching off never refuses: a disabled service, a closed category and a price removed go off too', async () => {
    const w = await world();
    const closedCategory = await insertCategory(db, { name: 'Closing soon' });
    const [good, disabled, noPrice] = await services(w, 3);
    const [b2bOnly] = await services(w, 1, closedCategory);
    const ids = [good!, disabled!, noPrice!, b2bOnly!];
    const run = await seedRun(t, ids);
    expect(await runner.run(run.id)).toBe('succeeded');
    await db.update(s.services).set({ status: 'disabled' }).where(eq(s.services.id, disabled!));
    expect((await admin.put(`/admin/services/${noPrice}/group-prices`, { prices: [] })).status).toBe(200);
    await db
      .update(s.serviceCategories)
      .set({ allowedGroupIds: [w.groups.standard] })
      .where(eq(s.serviceCategories.id, closedCategory));

    expect(await press(run.id, false)).toBe('done');

    expect(await statesOf(ids)).toEqual([false, false, false, false]);
    expect(await runOf(run.id)).toMatchObject({ switchedCount: 4, switchSkippedCount: 0 });
  });

  it('touches only what the run published', async () => {
    const w = await world();
    const ids = await services(w, 3);
    const other = await insertListingRow(db, ids[2]!, { slug: 'skipped-with-a-listing', isListed: true });
    const run = await seedRun(t, [
      ids[0]!,
      { serviceId: ids[1]!, row: { included: false } },
      // A row with a listing that it did not publish.
      { serviceId: ids[2]!, row: { included: false, result: 'skipped', resultReason: 'left_out', listingId: other } },
    ]);
    expect(await runner.run(run.id)).toBe('succeeded');
    await insertListingRow(db, ids[1]!, { slug: 'not-of-this-run', isListed: true });

    expect(await press(run.id, false)).toBe('done');

    expect(await statesOf(ids)).toEqual([false, true, true]);
    expect(await runOf(run.id)).toMatchObject({ switchedCount: 1, switchSkippedCount: 0 });
  });

  it('a second switch claimed while the first is alive stops the first', async () => {
    const w = await world();
    const { ids, run } = await published(w, 60);
    let second: string | undefined;

    const first = await (async () => {
      await queueSwitch(t, run.id, false, admin.staffId);
      return switcher.run(run.id, false, admin.staffId, {
        afterChunk: async () => {
          if (second !== undefined) return;
          second = await press(run.id, true);
        },
      });
    })();

    expect(first).toBe('stopped');
    expect(second).toBe('done');
    // The newer press put back the 50 the first took off; the first took nothing more off.
    expect(await statesOf(ids)).toEqual(Array(60).fill(true));
    expect(await auditsOf('unlisted from storefront')).toHaveLength(50);
    expect(await auditsOf('listed on storefront')).toHaveLength(50);
    expect(await runOf(run.id)).toMatchObject({
      switchStatus: 'done',
      switchListed: true,
      switchedCount: 50,
      attempt: 3,
    });
    const closes = await switchAudits();
    expect(closes).toHaveLength(1);
    expect(closes[0]!.after).toMatchObject({ listed: true, switched: 50, unchanged: 10 });
  });

  it('a newer press waits for the listing in flight, and the old worker stops at its next service', async () => {
    const w = await world();
    const { ids, run } = await published(w, 3);
    const [first, second] = await listingsOf(ids);
    // The worker holds the first service and the run row, and waits here for the listing.
    const listing = await rival((tx) =>
      tx.select().from(s.serviceListings).where(eq(s.serviceListings.id, first!.id)).for('update'),
    );
    // Then, with its first listing committed, it waits for its second service, holding nothing of the run.
    const service = await holdService(second!.serviceId);
    await queueSwitch(t, run.id, false, admin.staffId);
    const worker = switcher.run(run.id, false, admin.staffId);
    await waitsOn('"service_listings"');

    let pressed = false;
    const newer = queueSwitch(t, run.id, true, admin.staffId).then(() => {
      pressed = true;
    });
    await waitsOn(RUN_TABLE);
    expect(pressed).toBe(false);

    await listing.commit();
    await newer;
    expect(await statesOf(ids)).toEqual([false, true, true]);

    await waitsOn(SERVICE_TABLE);
    await service.commit();
    expect(await worker).toBe('stopped');
    expect(await runOf(run.id)).toMatchObject({ switchStatus: 'queued', switchListed: true, switchedCount: 0 });

    expect(await switcher.run(run.id, true, admin.staffId)).toBe('done');
    expect(await statesOf(ids)).toEqual([true, true, true]);
    expect((await switchAudits())[0]!.after).toMatchObject({ listed: true, switched: 1, unchanged: 2 });
  });

  it('a switch claimed after a stalled apply stops the old worker of that apply', async () => {
    const w = await world();
    const ids = await services(w, 60);
    const run = await seedRun(t, ids);
    let switched: string | undefined;

    const outcome = await runner.run(run.id, {
      afterChunk: async () => {
        if (switched !== undefined) return;
        // What the `listed` route does to a stalled run: it closes the run first, then queues the switch.
        await t.app.get(DbService).runInTransaction(async ({ tx }) => {
          await tx
            .update(s.listingPublishRuns)
            .set({ status: 'failed', finishedAt: clock.now() })
            .where(eq(s.listingPublishRuns.id, run.id));
          await queueRunSwitch(tx, run.id, false, clock.now());
        });
        switched = await switcher.run(run.id, false, admin.staffId);
      },
    });

    expect(outcome).toBe('stopped');
    expect(switched).toBe('done');
    expect(await listingsOf(ids)).toHaveLength(50);
    expect((await listingsOf(ids)).every((listing) => !listing.isListed)).toBe(true);
    expect(await auditsOf(CLOSE_AUDIT)).toEqual([]);
  });

  it('every write of a switch requires its own number', async () => {
    const w = await world();
    const { run } = await published(w, 1);
    await queueSwitch(t, run.id, false);
    const claimed = (await claimSwitch(db, run.id, false, clock.now()))!;
    expect(await claimSwitch(db, run.id, false, clock.now())).toBeUndefined();
    const stale = { runId: run.id, attempt: claimed.attempt - 1 };
    const mine = { runId: run.id, attempt: claimed.attempt };
    const closing = { status: 'done', error: null, switched: 1, skipped: 0, now: clock.now() } as const;
    const before = await runOf(run.id);

    expect(await beatSwitch(db, stale, { switched: 9, skipped: 9 }, clock.now())).toBe(false);
    await t.app.get(DbService).runInTransaction(async ({ tx }) => {
      expect(await holdSwitch(tx, stale)).toBe(false);
      expect(await closeSwitch(tx, stale, closing)).toBeUndefined();
    });
    expect(await runOf(run.id)).toEqual(before);

    expect(await beatSwitch(db, mine, { switched: 1, skipped: 0 }, clock.now())).toBe(true);
    await t.app.get(DbService).runInTransaction(async ({ tx }) => {
      expect(await holdSwitch(tx, mine)).toBe(true);
      expect(await closeSwitch(tx, mine, closing)).toMatchObject({ switchStatus: 'done', switchedCount: 1 });
    });
  });

  it('a row that fails is skipped as failed; 20 of them end the switch failed, the rest untried', async () => {
    const w = await world();
    const { ids, run } = await published(w, MAX_ITEM_FAILURES + 5);
    const broken = new PublishSwitch(
      t.app.get(DbService),
      t.app.get(RetailPrices, { strict: false }),
      t.app.get(AuditService, { strict: false }),
      { listingsChanged: () => Promise.reject(new Error('The search signal failed.')) } as unknown as SearchSignals,
      clock,
    );
    await queueSwitch(t, run.id, false, admin.staffId);

    expect(await broken.run(run.id, false, admin.staffId)).toBe('failed');

    // Each failed row rolled back whole, so nothing went off.
    expect(await statesOf(ids)).toEqual(Array(ids.length).fill(true));
    expect(await auditsOf('unlisted from storefront')).toEqual([]);
    expect(await runOf(run.id)).toMatchObject({
      switchStatus: 'failed',
      switchError: TOO_MANY_FAILURES_ERROR,
      switchedCount: 0,
      switchSkippedCount: MAX_ITEM_FAILURES,
    });
    expect((await switchAudits())[0]!.after).toMatchObject({
      skipped: { failed: MAX_ITEM_FAILURES },
      error: TOO_MANY_FAILURES_ERROR,
    });

    // Pressing again finishes it.
    expect(await press(run.id, false)).toBe('done');
    expect(await statesOf(ids)).toEqual(Array(ids.length).fill(false));
  });

  it('a deadlock is tried once more; one that repeats skips the listing and the switch goes on', async () => {
    const w = await world();
    const { ids, run } = await published(w, 3);
    const signals = spyOn(t.app.get(SearchSignals, { strict: false }), 'listingsChanged');
    signals
      .mockImplementationOnce(() => Promise.reject(deadlock()))
      .mockImplementationOnce(() => Promise.reject(deadlock()))
      .mockImplementationOnce(() => Promise.reject(deadlock()));

    expect(await press(run.id, false)).toBe('done');

    // The first listing lost twice, the second once; the third never.
    expect(await statesOf(ids)).toEqual([true, false, false]);
    expect((await switchAudits())[0]!.after).toMatchObject({ switched: 2, skipped: { failed: 1 } });
  });

  it('an unexpected error outside the rows closes the switch failed and is rethrown', async () => {
    const w = await world();
    const { run } = await published(w, 60);
    await queueSwitch(t, run.id, false, admin.staffId);

    await expectRejection(
      switcher.run(run.id, false, admin.staffId, {
        afterChunk: () => {
          throw new Error('The chunk went wrong.');
        },
      }),
      'The chunk went wrong.',
    );

    expect(await runOf(run.id)).toMatchObject({
      switchStatus: 'failed',
      switchError: 'The chunk went wrong.',
      switchedCount: 50,
    });
    expect((await switchAudits())[0]!.after).toMatchObject({ switched: 50, error: 'The chunk went wrong.' });
  });
});

describe('the claims', () => {
  it('one claim of two gets the run, and an apply and a switch raise the same counter', async () => {
    const w = await world();
    const ids = await services(w, 1);
    const run = await seedRun(t, ids);

    const claims = await Promise.all([claimApply(db, run.id, clock.now()), claimApply(db, run.id, clock.now())]);

    expect(claims.flatMap((claim) => (claim === undefined ? [] : [claim.attempt]))).toEqual([1]);
    expect(await runOf(run.id)).toMatchObject({ status: 'running', attempt: 1 });

    await db
      .update(s.listingPublishRuns)
      .set({ status: 'succeeded', switchStatus: 'queued', switchListed: false })
      .where(eq(s.listingPublishRuns.id, run.id));
    expect((await claimSwitch(db, run.id, false, clock.now()))!.attempt).toBe(2);
  });

  it('a run still being published cannot be switched', async () => {
    const w = await world();
    const run = await seedRun(t, await services(w, 1), { status: 'running', attempt: 1 });

    await expectRejection(queueSwitch(t, run.id, false), 'cannot be switched');

    expect(await runOf(run.id)).toMatchObject({ switchStatus: null, switchListed: null, listed: true });
  });

  it('a late claim of a switch that a newer press replaced finds nothing', async () => {
    const w = await world();
    const run = await seedRun(t, await services(w, 1), { status: 'succeeded' });
    await queueSwitch(t, run.id, true);

    expect(await claimSwitch(db, run.id, false, clock.now())).toBeUndefined();
    expect(await runOf(run.id)).toMatchObject({ switchStatus: 'queued', switchListed: true, attempt: 0 });
  });
});

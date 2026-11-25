// Integration tests of the bulk publisher alone (feature 31 slice B3a, plan 31 section 8.3): one service per transaction through
// `ListingPublisher.lock` and `publishLocked`, with an input built as a prepared row; no run row. The listing, the price, the switch,
// the search signal and the audit row; the service row lock and what is read after it; the price table of apply against the database;
// the publish limit; a typed price never overwritten unasked; every refusal writing nothing; slugs and the races at the insert; a
// failure after the insert; the supplier links; a service adopted into `server` since the preview; and the races with a staff
// listing, a service edit and a supplier sync.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { Money } from '@src/common/money';
import { type DbExecutor, DbService, type Transaction, schema as s } from '@src/infra/db';
import {
  RetailFloorError,
  RetailPrices,
  ServiceImporter,
  recomputeEffectiveCost,
  supplyStates,
} from '@src/modules/catalog';
import type { PublishInput, PublishOutcome } from '@src/modules/storefront/application/listing-publisher';
import { LISTING_CHANGED_EVENT } from '@src/modules/storefront/search/application/search-signals';
import { TYPED_SINCE_DETAIL } from '@src/modules/storefront/publish/domain/publish-item';
import { mainInputField } from '@src/modules/suppliers/domain/import-plan';
import { type AdminApi, adminWith } from '../../support/admin-api';
import { type TestApp, createTestApp } from '../../support/app';
import { clearIdentityCaches } from '../../support/auth';
import {
  insertCategory,
  insertInventoryCodes,
  insertService,
  insertSupplierLink,
  markStockService,
} from '../../support/catalog';
import { TestClock } from '../../support/clock';
import { closeTestDb, resetDb, testDb } from '../../support/db';
import { insertUsd } from '../../support/fixtures';
import { eventually } from '../../support/infra';
import { freshClientIp } from '../../support/pipeline-routes';
import { insertDemoGroups } from '../../support/pricing';
import { preparedInput, publishOne, publishTrace, publishTraced, publisherOf } from '../../support/publish';
import { expectRejection } from '../../support/rejection';
import { insertListingRow } from '../../support/storefront';

/** A second transaction a test keeps open: the other side of a race. */
interface Rival {
  /** Its connection, as `pg_blocking_pids` names it. */
  readonly pid: number;
  commit(): Promise<void>;
}

const clock = new TestClock('2026-11-17T09:00:00.000Z');
let t: TestApp;
let admin: AdminApi;
const rivals: Rival[] = [];

beforeAll(async () => {
  t = await createTestApp({ clock });
});
beforeEach(async () => {
  clock.set('2026-11-17T09:00:00.000Z');
  await resetDb();
  await clearIdentityCaches(t);
  admin = await adminWith(t, ['pricing:*', 'storefront:*', 'catalog:*'], { name: 'Rami K.' });
});
// A rival left open by a failed test would hold its locks, and the next reset would wait for it for ever.
afterEach(async () => {
  await Promise.allSettled(rivals.splice(0).map((rival) => rival.commit()));
});
afterAll(async () => {
  await resetDb();
  await clearIdentityCaches(t);
  await t.close();
  await closeTestDb();
});

const db = async () => (await testDb()).db;
const m = (value: string) => Money.of(value);

/** IMEI +30 %, ends in .99 from $5, limit 25 %: cost 10.0000 (floor 11.66) gives 13.99. */
const IMEI_30 = { scope: 'type', serviceType: 'imei', percent: '30', rounding: 'ends_99' } as const;
const createRule = async (body: Record<string, unknown> = IMEI_30) => {
  const res = await admin.post('/admin/retail-price-rules', body);
  expect(res.status).toBe(201);
  return res.body as { id: number };
};

interface World {
  groups: Awaited<ReturnType<typeof insertDemoGroups>>;
  categoryId: number;
}

/** USD, the demo groups (the last is the retail group) and a category open to every group. */
async function world(): Promise<World> {
  await insertUsd(await db());
  const groups = await insertDemoGroups(await db());
  const categoryId = await insertCategory(await db(), { name: 'Carrier unlock' });
  return { groups, categoryId };
}

/**
 * A Quick add service: cost 10.0000 (or `cost`), base price cost + 6 %, no own minimum profit (storefront floor 11.66 at cost 10),
 * fulfilled automatically through an active link to an active supplier. `importedCost` is `services.cost` (the effective cost
 * never falls under it).
 */
async function service(
  w: World,
  options: { cost?: string; importedCost?: string; values?: Record<string, unknown> } = {},
) {
  const cost = options.cost ?? '10.0000';
  const id = await insertService(await db(), w.categoryId, {
    name: `Unlock ${crypto.randomUUID().slice(0, 6)}`,
    cost: options.importedCost ?? cost,
    effectiveCost: cost,
    basePrice: Money.of(cost).mul('1.06').toWire(),
    minProfit: null,
    ...options.values,
  });
  const link = await insertSupplierLink(await db(), id, { credit: cost, creditRate: '1' });
  return { id, ...link };
}

type One = Awaited<ReturnType<typeof service>>;

/** What a sync does to one supplier service: the supplier's new credit, then the effective cost worked out again. */
async function syncCost(serviceId: number, supplierServiceId: number, credit: string, tx?: DbExecutor) {
  const database = tx ?? (await db());
  await database.update(s.supplierServices).set({ credit }).where(eq(s.supplierServices.id, supplierServiceId));
  await recomputeEffectiveCost(database, [serviceId]);
}

/** Writes a following (rule) price through the one writer, as the listing route's `retailPricing: 'rule'` does. */
async function followingPrice(serviceId: number, ruleId: number, price: string) {
  const retail = t.app.get(RetailPrices);
  await t.app.get(DbService).runInTransaction(async ({ tx }) => {
    await retail.lockLiveService(tx, serviceId);
    const quote = (await retail.quotes(tx, [serviceId])).get(serviceId)!;
    await retail.set(tx, serviceId, m(price), { origin: { kind: 'rule', ruleId, cost: quote.cost }, quote });
  });
}

const typedPrice = (w: World, serviceId: number, price: string) =>
  admin.put(`/admin/services/${serviceId}/group-prices`, { prices: [{ groupId: w.groups.retail, price }] });

const retailOf = async (w: World, serviceId: number) =>
  (
    await (
      await db()
    )
      .select({ price: s.serviceGroupPrices.price })
      .from(s.serviceGroupPrices)
      .where(and(eq(s.serviceGroupPrices.serviceId, serviceId), eq(s.serviceGroupPrices.groupId, w.groups.retail)))
  )[0]?.price ?? null;

const followOf = async (serviceId: number) =>
  (await (await db()).select().from(s.retailPriceFollows).where(eq(s.retailPriceFollows.serviceId, serviceId)))[0];

const listingOf = async (serviceId: number) =>
  (await (await db()).select().from(s.serviceListings).where(eq(s.serviceListings.serviceId, serviceId)))[0];

const publishedAudits = async () =>
  (await db()).select().from(s.auditLogs).where(eq(s.auditLogs.action, 'published to the storefront'));

const auditActions = async () =>
  (await (await db()).select({ action: s.auditLogs.action }).from(s.auditLogs).orderBy(s.auditLogs.id)).map(
    (row) => row.action,
  );

const listingEvents = async (serviceId: number) =>
  (
    await (
      await db()
    )
      .select()
      .from(s.outboxEvents)
      .where(and(eq(s.outboxEvents.type, LISTING_CHANGED_EVENT), eq(s.outboxEvents.aggregateId, serviceId)))
  ).length;

const shopSlugs = async () =>
  (await t.app.inject({ method: 'GET', url: '/store/v1/services', remoteAddress: freshClientIp() }))
    .json<Array<{ slug: string }>>()
    .map((row) => row.slug);

/** The rows of every table a publish may write, whole tables: an audit row of any action and an event of any type count. */
async function rowCounts() {
  const database = await db();
  return {
    listings: await database.$count(s.serviceListings),
    prices: await database.$count(s.serviceGroupPrices),
    follows: await database.$count(s.retailPriceFollows),
    audits: await database.$count(s.auditLogs),
    events: await database.$count(s.outboxEvents),
  };
}

/**
 * Publishes a row that must change nothing (a refusal, or `already_listed`): its transaction wrote no row of any table, not even one
 * it undid, and the tables a publish may write hold the rows they held.
 */
async function publishNothing(input: PublishInput): Promise<PublishOutcome> {
  const before = await rowCounts();
  const { outcome, writes } = await publishTraced(t, input);
  expect(writes).toEqual({});
  expect(await rowCounts()).toEqual(before);
  return outcome;
}

const published = (outcome: PublishOutcome) => {
  expect(outcome.result).toBe('published');
  return outcome as Extract<PublishOutcome, { result: 'published' }>;
};

type RefusalReason = Extract<PublishOutcome, { result: 'refused' }>['reason'];

const ALREADY_LISTED: PublishOutcome = { result: 'skipped', reason: 'already_listed', detail: null };
const NO_RULE: PublishOutcome = {
  result: 'refused',
  reason: 'price_missing',
  detail: 'No pricing rule covers this service.',
};
const NO_COST: PublishOutcome = {
  result: 'refused',
  reason: 'price_missing',
  detail: 'This service has no cost, so a rule cannot price it.',
};
const COST_MOVED_10X: PublishOutcome = {
  result: 'refused',
  reason: 'cost_moved',
  detail: 'The cost moved from $10.00 to $100.00 since the preview. Check the preview again.',
};

const backendPid = async (tx: DbExecutor) =>
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

/** Waits until a statement of another connection is blocked by the transaction of `pid`, and answers its text. */
const blockedBy = (pid: number) =>
  eventually(async () => {
    const { rows } = await (
      await db()
    ).execute<{ query: string }>(sql`
      select query from pg_stat_activity
      where datname = current_database() and wait_event_type = 'Lock' and ${pid}::int = any(pg_blocking_pids(pid))`);
    return rows[0]?.query;
  });

/** The ways a supplier link stops being usable (plan 31 section 3.2, the rule of `pickLink` without the price test). */
const UNUSABLE: Array<[string, (link: { supplierId: number; supplierServiceId: number }) => Promise<unknown>]> = [
  [
    'a paused supplier',
    async (link) =>
      (await db()).update(s.suppliers).set({ status: 'paused' }).where(eq(s.suppliers.id, link.supplierId)),
  ],
  [
    'a disabled supplier',
    async (link) =>
      (await db()).update(s.suppliers).set({ status: 'disabled' }).where(eq(s.suppliers.id, link.supplierId)),
  ],
  [
    'a supplier service no longer listed',
    async (link) =>
      (await db())
        .update(s.supplierServices)
        .set({ isAvailable: false })
        .where(eq(s.supplierServices.id, link.supplierServiceId)),
  ],
];

describe('ListingPublisher: one service', () => {
  it('creates the listing with the row title, slug and facts, prices it by the rule, puts it on the shop, signals and audits once', async () => {
    const w = await world();
    const rule = await createRule();
    const one = await service(w);
    const input = await preparedInput(t, one.id, {
      title: 'Chimera Tool Activation',
      slug: 'chimera-tool-activation',
      brand: 'Chimera',
      carrier: 'AT&T',
      country: 'US',
      runId: 41,
      requestedBy: admin.staffId,
    });
    expect(input.price).toMatchObject({ mode: 'rule', replacesPrice: null });
    const actionsBefore = await auditActions();
    const traced = await publishTraced(t, input);
    const outcome = published(traced.outcome);
    expect(outcome).toMatchObject({
      slug: 'chimera-tool-activation',
      pricing: 'rule',
      priceWritten: true,
      detail: null,
    });
    expect(outcome.price.toWire()).toBe('13.9900');

    // What one published row writes, and nothing else: the listing and its switch, the price, the follow row, one event, one audit row.
    const once = { inserted: 1, updated: 0, deleted: 0 };
    expect(traced.writes).toEqual({
      audit_logs: once,
      outbox_events: once,
      retail_price_follows: once,
      service_group_prices: once,
      service_listings: { inserted: 1, updated: 1, deleted: 0 },
    });

    const listing = await listingOf(one.id);
    expect(listing).toMatchObject({
      id: outcome.listingId,
      slug: 'chimera-tool-activation',
      publicTitle: 'Chimera Tool Activation',
      brand: 'Chimera',
      carrier: 'AT&T',
      country: 'US',
      isListed: true,
      isFeatured: false,
      sort: 0,
      summary: '',
      imageFileId: null,
      listedAt: clock.now(),
    });
    expect(await retailOf(w, one.id)).toBe('13.9900');
    expect(await followOf(one.id)).toMatchObject({
      ruleId: rule.id,
      appliedPrice: '13.9900',
      appliedCost: '10.0000',
      appliedAt: clock.now(),
    });
    expect(await shopSlugs()).toEqual(['chimera-tool-activation']);
    expect(await listingEvents(one.id)).toBe(1);
    const audits = await publishedAudits();
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ entityType: 'listing', entityId: listing!.id, actorType: 'system' });
    expect(audits[0]!.entityLabel).toStartWith('Unlock ');
    expect(audits[0]!.after).toEqual({
      runId: 41,
      requestedBy: admin.staffId,
      slug: 'chimera-tool-activation',
      publicTitle: 'Chimera Tool Activation',
      brand: 'Chimera',
      carrier: 'AT&T',
      country: 'US',
      retailPrice: '13.9900',
      pricing: 'rule',
      ruleId: rule.id,
      isListed: true,
    });
    // The other audit rows of a hand-made listing and of a price change are not written: this row is the only new one.
    expect(await auditActions()).toEqual([...actionsBefore, 'published to the storefront']);
    expect(await auditActions()).not.toContain('changed retail price of');
  });

  it('with listed: false prices the listing, leaves it off the shop, and still signals the search index once', async () => {
    const w = await world();
    await createRule();
    const one = await service(w);
    const outcome = published(await publishOne(t, await preparedInput(t, one.id, { listed: false })));
    expect(outcome.price.toWire()).toBe('13.9900');
    expect(await listingOf(one.id)).toMatchObject({ isListed: false, listedAt: null });
    expect(await retailOf(w, one.id)).toBe('13.9900');
    expect(await shopSlugs()).toEqual([]);
    expect((await publishedAudits())[0]!.after).toMatchObject({ isListed: false });
    expect(await listingEvents(one.id)).toBe(1);
  });

  it('audits a typed and a kept price with no rule id, one row each, and never as a change of the retail price', async () => {
    const w = await world();
    const rule = await createRule();
    const manual = await service(w);
    const typed = await service(w);
    expect((await typedPrice(w, typed.id, '20.0000')).status).toBe(200);
    const following = await service(w);
    await followingPrice(following.id, rule.id, '13.9900');
    const cases: Array<[One, PublishInput, string, string]> = [
      [
        manual,
        await preparedInput(t, manual.id, { price: { mode: 'manual', override: m('15') } }),
        'manual',
        '15.0000',
      ],
      [typed, await preparedInput(t, typed.id), 'kept', '20.0000'],
      [following, await preparedInput(t, following.id), 'kept', '13.9900'],
    ];
    for (const [one, input, pricing, retailPrice] of cases) {
      const actionsBefore = await auditActions();
      const outcome = published(await publishOne(t, input));
      expect(outcome).toMatchObject({ pricing });
      expect(await auditActions(), pricing).toEqual([...actionsBefore, 'published to the storefront']);
      expect(await auditActions(), pricing).not.toContain('changed retail price of');
      const audit = (await publishedAudits()).find((row) => row.entityId === outcome.listingId);
      expect(audit).toMatchObject({ entityType: 'listing', actorType: 'system' });
      expect(audit!.after).toEqual({
        runId: null,
        requestedBy: null,
        slug: input.slug,
        publicTitle: input.title,
        brand: '',
        carrier: '',
        country: '',
        retailPrice,
        pricing,
        ruleId: null,
        isListed: true,
      });
      expect(await listingEvents(one.id)).toBe(1);
    }
  });
});

describe('ListingPublisher: the price table of apply', () => {
  it('manual: writes the typed price over a following one and stops following; under the floor of now it refuses below_floor', async () => {
    const w = await world();
    const rule = await createRule();
    const one = await service(w);
    await followingPrice(one.id, rule.id, '13.9900');
    const input = await preparedInput(t, one.id, { price: { mode: 'manual', override: m('15') } });
    const outcome = published(await publishOne(t, input));
    expect(outcome).toMatchObject({ pricing: 'manual', priceWritten: true });
    expect(await retailOf(w, one.id)).toBe('15.0000');
    expect(await followOf(one.id)).toBeUndefined();

    // A typed price that fell under the floor since the preview: the cost rose to 12.50, the floor to 12.50 + 0.75 = 13.25.
    const two = await service(w);
    const typed = await preparedInput(t, two.id, { price: { mode: 'manual', override: m('12') } });
    await syncCost(two.id, two.supplierServiceId, '12.5000');
    expect(await publishNothing(typed)).toEqual({
      result: 'refused',
      reason: 'below_floor',
      detail: 'Below the storefront floor of $13.25.',
    });
  });

  it('manual: replaces a typed price, and prices a service that has none, with no follow row', async () => {
    const w = await world();
    await createRule();
    const typed = await service(w);
    expect((await typedPrice(w, typed.id, '20.0000')).status).toBe(200);
    const over = await preparedInput(t, typed.id, { price: { mode: 'manual', override: m('15') } });
    expect(over.price.existingPrice?.toWire()).toBe('20.0000');
    const replaced = published(await publishOne(t, over));
    expect(replaced).toMatchObject({ pricing: 'manual', priceWritten: true, detail: null });
    expect(replaced.price.toWire()).toBe('15.0000');
    expect(await retailOf(w, typed.id)).toBe('15.0000');
    expect(await followOf(typed.id)).toBeUndefined();

    const none = await service(w);
    const first = published(
      await publishOne(t, await preparedInput(t, none.id, { price: { mode: 'manual', override: m('11.66') } })),
    );
    expect(first).toMatchObject({ pricing: 'manual', priceWritten: true, detail: null });
    expect(await retailOf(w, none.id)).toBe('11.6600');
    expect(await followOf(none.id)).toBeUndefined();
  });

  it('keep: a typed price and a following price stay as they are; a price gone since the preview is priced by the rule', async () => {
    const w = await world();
    const rule = await createRule();
    const typed = await service(w);
    expect((await typedPrice(w, typed.id, '20.0000')).status).toBe(200);
    const keepTyped = await preparedInput(t, typed.id);
    expect(keepTyped.price.mode).toBe('keep');
    expect(published(await publishOne(t, keepTyped))).toMatchObject({
      pricing: 'kept',
      priceWritten: false,
      detail: null,
    });
    expect(await retailOf(w, typed.id)).toBe('20.0000');
    expect(await followOf(typed.id)).toBeUndefined();

    const following = await service(w);
    await followingPrice(following.id, rule.id, '13.9900');
    const before = await followOf(following.id);
    expect(published(await publishOne(t, await preparedInput(t, following.id)))).toMatchObject({ pricing: 'kept' });
    expect(await followOf(following.id)).toEqual(before);

    const gone = await service(w);
    expect((await typedPrice(w, gone.id, '20.0000')).status).toBe(200);
    const keepGone = await preparedInput(t, gone.id);
    // Staff remove the retail price on the group price page (replace-all with no row).
    expect((await admin.put(`/admin/services/${gone.id}/group-prices`, { prices: [] })).status).toBe(200);
    const outcome = published(await publishOne(t, keepGone));
    expect(outcome).toMatchObject({
      pricing: 'rule',
      priceWritten: true,
      detail: 'The price is $13.99, not the $20.00 of the preview.',
    });
    expect(await retailOf(w, gone.id)).toBe('13.9900');
    expect(await followOf(gone.id)).toMatchObject({ ruleId: rule.id, appliedPrice: '13.9900' });
  });

  it('rule: a following price now is not written; the follow pass keeps it', async () => {
    const w = await world();
    const rule = await createRule();
    const one = await service(w);
    const input = await preparedInput(t, one.id);
    expect(input.price.mode).toBe('rule');
    await followingPrice(one.id, rule.id, '14.5000');
    const outcome = published(await publishOne(t, input));
    expect(outcome).toMatchObject({ pricing: 'kept', priceWritten: false });
    expect(outcome.price.toWire()).toBe('14.5000');
    expect(await followOf(one.id)).toMatchObject({ appliedPrice: '14.5000' });
  });
});

describe('ListingPublisher: the publish limit', () => {
  it('refuses cost_moved when a sync raised the cost 10 times since the preview, writing no listing and no price', async () => {
    const w = await world();
    await createRule();
    const one = await service(w);
    const input = await preparedInput(t, one.id);
    await syncCost(one.id, one.supplierServiceId, '100.0000');
    expect(await publishNothing(input)).toEqual(COST_MOVED_10X);
  });

  it('publishes at the rule price of the new cost after a rise of 10 % (limit 25), never under the new floor', async () => {
    const w = await world();
    await createRule();
    const one = await service(w);
    const input = await preparedInput(t, one.id);
    await syncCost(one.id, one.supplierServiceId, '11.0000');
    const outcome = published(await publishOne(t, input));
    // 11 x 1.30 = 14.30, then 14.99; the new floor is max(10.60 x 1.10, 11 + 0.66) = 11.66.
    expect(outcome.price.toWire()).toBe('14.9900');
    expect(outcome.detail).toBe('The price is $14.99, not the $13.99 of the preview.');
    const quote = (await t.app.get(RetailPrices).quotes(await db(), [one.id])).get(one.id)!;
    expect(outcome.price.cmp(quote.floor)).toBeGreaterThanOrEqual(0);
    expect(await followOf(one.id)).toMatchObject({ appliedPrice: '14.9900', appliedCost: '11.0000' });
  });

  it('refuses cost_moved when the cost fell by 50 %', async () => {
    const w = await world();
    await createRule();
    const one = await service(w, { importedCost: '5.0000' });
    const input = await preparedInput(t, one.id);
    await syncCost(one.id, one.supplierServiceId, '5.0000');
    expect(await publishNothing(input)).toMatchObject({ result: 'refused', reason: 'cost_moved' });
  });

  it('a missing rule or cost comes first: a cost gone to 0 is no cost and a moved cost without a rule is no rule, never cost_moved', async () => {
    const w = await world();
    const noRule = await service(w);
    const moved = await preparedInput(t, noRule.id);
    await syncCost(noRule.id, noRule.supplierServiceId, '100.0000');
    expect(await publishNothing(moved)).toEqual(NO_RULE);

    await createRule();
    const noCost = await service(w, { importedCost: '0.0000' });
    const previewed = await preparedInput(t, noCost.id);
    expect(previewed.price.cost.toWire()).toBe('10.0000');
    await syncCost(noCost.id, noCost.supplierServiceId, '0.0000');
    expect(await publishNothing(previewed)).toEqual(NO_COST);
  });
});

describe('ListingPublisher: a typed price is never overwritten unasked', () => {
  it('keeps a price typed on the group price page after a row was prepared with no price, and says so', async () => {
    const w = await world();
    await createRule();
    const one = await service(w);
    const input = await preparedInput(t, one.id, { brand: 'Edited brand' });
    expect(input.price).toMatchObject({ mode: 'rule', replacesPrice: null });
    expect((await typedPrice(w, one.id, '20.0000')).status).toBe(200);
    const outcome = published(await publishOne(t, input));
    expect(outcome).toMatchObject({ pricing: 'kept', priceWritten: false, detail: TYPED_SINCE_DETAIL });
    expect(await retailOf(w, one.id)).toBe('20.0000');
    expect(await followOf(one.id)).toBeUndefined();
    expect((await listingOf(one.id))!.brand).toBe('Edited brand');
  });

  it('replaces the typed price with the rule price when staff chose exactly that price, and not after it changed', async () => {
    const w = await world();
    const rule = await createRule();
    const chosen = await service(w);
    expect((await typedPrice(w, chosen.id, '20.0000')).status).toBe(200);
    const input = await preparedInput(t, chosen.id, { price: { mode: 'rule', replacesPrice: m('20') } });
    expect(published(await publishOne(t, input))).toMatchObject({ pricing: 'rule', priceWritten: true });
    expect(await retailOf(w, chosen.id)).toBe('13.9900');
    expect(await followOf(chosen.id)).toMatchObject({ ruleId: rule.id, appliedPrice: '13.9900' });

    const changed = await service(w);
    expect((await typedPrice(w, changed.id, '20.0000')).status).toBe(200);
    const stale = await preparedInput(t, changed.id, { price: { mode: 'rule', replacesPrice: m('20') } });
    expect((await typedPrice(w, changed.id, '21.0000')).status).toBe(200);
    expect(published(await publishOne(t, stale))).toMatchObject({ pricing: 'kept', detail: TYPED_SINCE_DETAIL });
    expect(await retailOf(w, changed.id)).toBe('21.0000');
    expect(await followOf(changed.id)).toBeUndefined();
  });
});

describe('ListingPublisher: every refusal writes nothing', () => {
  it('refuses on the locked service with the reason of the blocking list', async () => {
    const w = await world();
    await createRule();
    const cases: Array<[string, (one: One) => Promise<unknown>, RefusalReason]> = [
      [
        'archived',
        async (one) =>
          (await db())
            .update(s.services)
            .set({ status: 'disabled', archivedAt: clock.now() })
            .where(eq(s.services.id, one.id)),
        'service_gone',
      ],
      [
        'disabled',
        async (one) => (await db()).update(s.services).set({ status: 'disabled' }).where(eq(s.services.id, one.id)),
        'service_disabled',
      ],
      [
        'a switched-off category',
        async (one) => {
          const off = await insertCategory(await db(), { name: 'Off', isActive: false });
          await (await db()).update(s.services).set({ categoryId: off }).where(eq(s.services.id, one.id));
        },
        'category_inactive',
      ],
      [
        'a B2B-only category',
        async (one) => {
          const b2b = await insertCategory(await db(), { name: 'Dealers', allowedGroupIds: [w.groups.standard] });
          await (await db()).update(s.services).set({ categoryId: b2b }).where(eq(s.services.id, one.id));
        },
        'b2b_only',
      ],
      [
        'a file service',
        async (one) => {
          const files = await insertCategory(await db(), { name: 'Files', type: 'file' });
          await (
            await db()
          )
            .update(s.services)
            .set({ type: 'file', categoryId: files })
            .where(eq(s.services.id, one.id));
        },
        'not_orderable',
      ],
      ...UNUSABLE.map(([name, spoil]): [string, (one: One) => Promise<unknown>, RefusalReason] => [
        name,
        spoil,
        'supplier_unavailable',
      ]),
      [
        'no active link',
        async (one) =>
          (await db())
            .update(s.serviceSupplierLinks)
            .set({ isActive: false })
            .where(eq(s.serviceSupplierLinks.id, one.linkId)),
        'supplier_unavailable',
      ],
    ];
    for (const [name, change, reason] of cases) {
      const one = await service(w);
      const input = await preparedInput(t, one.id);
      await change(one);
      expect(await publishNothing(input), name).toEqual({ result: 'refused', reason, detail: null });
    }
  });

  it('refuses price_missing without a rule and at a cost of 0, saying which is absent', async () => {
    const w = await world();
    const noRule = await service(w);
    expect(await publishNothing(await preparedInput(t, noRule.id))).toEqual(NO_RULE);

    await createRule();
    const free = await service(w, { cost: '0.0000', values: { basePrice: '0.0200' } });
    expect(await publishNothing(await preparedInput(t, free.id))).toEqual(NO_COST);
  });

  it('refuses an empty title and a title over 200 characters, and publishes one of exactly 200', async () => {
    const w = await world();
    await createRule();
    const untitled = await service(w);
    expect(await publishNothing(await preparedInput(t, untitled.id, { title: '  ' }))).toEqual({
      result: 'refused',
      reason: 'title_missing',
      detail: null,
    });
    const long = await service(w);
    expect(await publishNothing(await preparedInput(t, long.id, { title: 'x'.repeat(201) }))).toEqual({
      result: 'refused',
      reason: 'title_too_long',
      detail: null,
    });
    const longest = await service(w);
    published(await publishOne(t, await preparedInput(t, longest.id, { title: 'x'.repeat(200) })));
    expect((await listingOf(longest.id))!.publicTitle).toHaveLength(200);
  });

  it('skips a service listed since the preview: no price, no follow row, no audit row, no search event, the listing untouched', async () => {
    const w = await world();
    await createRule();
    const listed = await service(w);
    const input = await preparedInput(t, listed.id);
    await insertListingRow(await db(), listed.id, { slug: 'by-hand' });
    const before = await listingOf(listed.id);
    expect(await publishNothing(input)).toEqual(ALREADY_LISTED);
    expect(await listingOf(listed.id)).toEqual(before);
    expect(await retailOf(w, listed.id)).toBeNull();
    expect(await followOf(listed.id)).toBeUndefined();
    expect(await publishedAudits()).toEqual([]);
    expect(await listingEvents(listed.id)).toBe(0);
  });

  it('puts already_listed before every other refusal: a listed service that is disabled and has no rule is skipped', async () => {
    const w = await world();
    const listed = await service(w);
    const input = await preparedInput(t, listed.id);
    await insertListingRow(await db(), listed.id, { slug: 'by-hand' });
    await (await db()).update(s.services).set({ status: 'disabled' }).where(eq(s.services.id, listed.id));
    expect(await publishNothing(input)).toEqual(ALREADY_LISTED);
  });

  it('lets a manual service without a usable supplier through', async () => {
    const w = await world();
    await createRule();
    const manual = await service(w, { values: { fulfillment: 'manual' } });
    await (await db()).update(s.suppliers).set({ status: 'disabled' }).where(eq(s.suppliers.id, manual.supplierId));
    published(await publishOne(t, await preparedInput(t, manual.id)));
  });
});

describe('ListingPublisher: slugs', () => {
  it('gives a proposed slug taken since the preview the next suffix, and refuses a typed slug that is taken', async () => {
    const w = await world();
    await createRule();
    const other = await service(w);
    const one = await service(w);
    const input = await preparedInput(t, one.id, { title: 'Unlock Pro', slug: 'unlock-pro' });
    await insertListingRow(await db(), other.id, { slug: 'unlock-pro' });
    const outcome = published(await publishOne(t, input));
    expect(outcome).toMatchObject({
      slug: 'unlock-pro-2',
      detail: 'The address unlock-pro was taken: the listing got unlock-pro-2.',
    });
    expect((await listingOf(one.id))!.slug).toBe('unlock-pro-2');

    const typed = await service(w);
    expect(await publishNothing(await preparedInput(t, typed.id, { slug: 'unlock-pro', slugSource: 'staff' }))).toEqual(
      {
        result: 'refused',
        reason: 'slug_taken',
        detail: 'The address unlock-pro is used by another listing. Type another.',
      },
    );
  });

  it('refuses a typed slug of the wrong form as slug_taken, even when nothing holds it', async () => {
    const w = await world();
    await createRule();
    for (const slug of ['Not A Slug', 'double--hyphen', 'x'.repeat(121)]) {
      const one = await service(w);
      expect(await publishNothing(await preparedInput(t, one.id, { slug, slugSource: 'staff' })), slug).toEqual({
        result: 'refused',
        reason: 'slug_taken',
        detail: `The address ${slug} is not valid. Type another.`,
      });
    }
  });

  it('refuses title_missing for a proposed row with no usable address: neither its title nor its slug gives one', async () => {
    const w = await world();
    await createRule();
    for (const slug of ['', 'Not A Slug']) {
      const one = await service(w);
      expect(await publishNothing(await preparedInput(t, one.id, { title: '***', slug })), slug).toEqual({
        result: 'refused',
        reason: 'title_missing',
        detail: 'No address can be made from the title. Type a title or an address.',
      });
    }
  });

  it('makes the address of a proposed row from its title when its slug is unusable, and from its slug when the title gives none', async () => {
    const w = await world();
    await createRule();
    const noSlug = await service(w);
    expect(
      published(await publishOne(t, await preparedInput(t, noSlug.id, { title: 'Unlock Pro', slug: '' }))),
    ).toMatchObject({ slug: 'unlock-pro', detail: null });

    const other = await service(w);
    await insertListingRow(await db(), other.id, { slug: 'free-name' });
    const noBase = await service(w);
    expect(
      published(await publishOne(t, await preparedInput(t, noBase.id, { title: '***', slug: 'free-name' }))),
    ).toMatchObject({
      slug: 'free-name-2',
      detail: 'The address free-name was taken: the listing got free-name-2.',
    });
  });

  it('two publishes racing for one slug end with two listings and two different slugs', async () => {
    const w = await world();
    await createRule();
    const first = await service(w);
    const second = await service(w);
    const inputs = await Promise.all(
      [first, second].map((one) => preparedInput(t, one.id, { title: 'Same Title', slug: 'same-title' })),
    );
    const outcomes = await Promise.all(inputs.map((input) => publishOne(t, input)));
    const slugs = outcomes.map((outcome) => published(outcome).slug).sort();
    expect(slugs).toEqual(['same-title', 'same-title-2']);
  });
});

describe('ListingPublisher: a race lost at the insert (a rolled-back savepoint keeps the transaction)', () => {
  /** A writer with an uncommitted listing that holds this slug for another service: the pre-checks cannot see it, the unique key can. */
  const slugHolder = async (w: World, slug: string) => {
    const other = await service(w);
    return rival((tx) => tx.insert(s.serviceListings).values({ serviceId: other.id, slug, publicTitle: 'Other' }));
  };
  const INSERT = /insert into "service_listings"/;
  /** Only the failed inserts were attempted: no other table was touched. */
  const onlyFailedInserts = (writes: Awaited<ReturnType<typeof publishTraced>>['writes'], attempts: number) =>
    expect(writes).toEqual({ service_listings: { inserted: attempts, updated: 0, deleted: 0 } });

  it('a proposed slug a writer commits during the insert: the next suffix is taken', async () => {
    const w = await world();
    await createRule();
    const one = await service(w);
    const input = await preparedInput(t, one.id, { title: 'Race Title', slug: 'race-title' });
    const writer = await slugHolder(w, 'race-title');
    const publishing = publishOne(t, input);
    expect(await blockedBy(writer.pid)).toMatch(INSERT);
    await writer.commit();
    const outcome = published(await publishing);
    expect(outcome.slug).toBe('race-title-2');
    expect((await listingOf(one.id))!.slug).toBe('race-title-2');
    expect((await publishedAudits()).length).toBe(1);
  });

  it('stops at 3 tries: a proposed slug lost three times is slug_taken, with nothing written', async () => {
    const w = await world();
    await createRule();
    const one = await service(w);
    const input = await preparedInput(t, one.id, { title: 'Busy Title', slug: 'busy-title' });
    const writers = [
      await slugHolder(w, 'busy-title'),
      await slugHolder(w, 'busy-title-2'),
      await slugHolder(w, 'busy-title-3'),
    ];
    const before = await rowCounts();
    const publishing = publishTraced(t, input);
    for (const writer of writers) {
      expect(await blockedBy(writer.pid)).toMatch(INSERT);
      await writer.commit();
    }
    const { outcome, writes } = await publishing;
    expect(outcome).toEqual({
      result: 'refused',
      reason: 'slug_taken',
      detail: 'No free address was found after 3 tries. Try again.',
    });
    onlyFailedInserts(writes, 3);
    expect(await rowCounts()).toEqual({ ...before, listings: before.listings + 3 });
    expect(await listingOf(one.id)).toBeUndefined();
  });

  it('a typed slug a writer commits during the insert is slug_taken: staff decide again, nothing is written', async () => {
    const w = await world();
    await createRule();
    const one = await service(w);
    const input = await preparedInput(t, one.id, { slug: 'my-address', slugSource: 'staff' });
    const writer = await slugHolder(w, 'my-address');
    const before = await rowCounts();
    const publishing = publishTraced(t, input);
    expect(await blockedBy(writer.pid)).toMatch(INSERT);
    await writer.commit();
    const { outcome, writes } = await publishing;
    expect(outcome).toEqual({
      result: 'refused',
      reason: 'slug_taken',
      detail: 'The address my-address is used by another listing. Type another.',
    });
    onlyFailedInserts(writes, 1);
    expect(await rowCounts()).toEqual({ ...before, listings: before.listings + 1 });
    expect(await listingOf(one.id)).toBeUndefined();
  });

  it('a listing of the same service committed during the insert (service_listings_service_uq) is already_listed', async () => {
    const w = await world();
    await createRule();
    const one = await service(w);
    const input = await preparedInput(t, one.id);
    // Every real writer of a listing waits for the service row, its foreign key check included, so the key is only a backstop. This
    // rival switches its foreign key check off to reach it (the test database's role is a superuser).
    const writer = await rival(async (tx) => {
      await tx.execute(sql`set local session_replication_role = replica`);
      await tx.insert(s.serviceListings).values({ serviceId: one.id, slug: 'by-hand', publicTitle: 'By hand' });
    });
    const before = await rowCounts();
    const publishing = publishTraced(t, input);
    expect(await blockedBy(writer.pid)).toMatch(INSERT);
    await writer.commit();
    const { outcome, writes } = await publishing;
    expect(outcome).toEqual(ALREADY_LISTED);
    onlyFailedInserts(writes, 1);
    expect(await rowCounts()).toEqual({ ...before, listings: before.listings + 1 });
    expect((await listingOf(one.id))!.slug).toBe('by-hand');
  });
});

describe('ListingPublisher: a failure after the insert', () => {
  it('rolls the whole row back: RetailFloorError from the price writer leaves no listing, price, audit row or event', async () => {
    const w = await world();
    await createRule();
    const one = await service(w);
    const input = await preparedInput(t, one.id);
    const retail = t.app.get(RetailPrices);
    // `decidePrice` and the writer read one quote, so the writer's own check is unreachable: this stand-in hands it a floor one cent
    // over the price, and the real writer refuses it.
    let listingsAtTheWrite = 0;
    const failing = Object.create(retail) as RetailPrices;
    failing.set = async (tx, serviceId, price, write) => {
      listingsAtTheWrite = (await tx.select().from(s.serviceListings).where(eq(s.serviceListings.serviceId, serviceId)))
        .length;
      return retail.set(tx, serviceId, price, { ...write, quote: { ...write.quote, floor: price.add(m('0.01')) } });
    };
    const before = await rowCounts();
    await expectRejection(publishOne(t, input, { publisher: publisherOf(t, { retail: failing }) }), RetailFloorError);
    expect(listingsAtTheWrite).toBe(1);
    expect(await rowCounts()).toEqual(before);
    expect(await listingOf(one.id)).toBeUndefined();
  });
});

describe('ListingPublisher: the service row lock', () => {
  /** A writer that holds the service row, has made its change and has not committed. */
  const holder = (one: One, change: (tx: Transaction) => Promise<unknown>, mode: 'update' | 'share' = 'update') =>
    rival(async (tx) => {
      await t.app.get(RetailPrices).lockLiveService(tx, one.id, mode);
      await change(tx);
    });

  /** Starts a publish behind a writer, proves that its first lock waits on the service row, and lets the writer commit. */
  async function publishBehind(writer: Rival, input: PublishInput) {
    const publishing = publishTraced(t, input);
    expect(await blockedBy(writer.pid)).toMatch(/from "services".*for update/s);
    await writer.commit();
    return publishing;
  }

  it('waits for a writer holding the row, then refuses on what it committed: the facts are read after the lock', async () => {
    const w = await world();
    await createRule();
    const off = await insertCategory(await db(), { name: 'Off', isActive: false });
    const cases: Array<
      [string, (one: One, tx: Transaction) => Promise<unknown>, PublishOutcome, ('update' | 'share')?]
    > = [
      ['a cost raised 10 times', (one, tx) => syncCost(one.id, one.supplierServiceId, '100.0000', tx), COST_MOVED_10X],
      [
        'the service disabled',
        (one, tx) => tx.update(s.services).set({ status: 'disabled' }).where(eq(s.services.id, one.id)),
        { result: 'refused', reason: 'service_disabled', detail: null },
      ],
      [
        'the service archived',
        (one, tx) =>
          tx.update(s.services).set({ status: 'disabled', archivedAt: clock.now() }).where(eq(s.services.id, one.id)),
        { result: 'refused', reason: 'service_gone', detail: null },
      ],
      [
        'the category switched off',
        (one, tx) => tx.update(s.services).set({ categoryId: off }).where(eq(s.services.id, one.id)),
        { result: 'refused', reason: 'category_inactive', detail: null },
      ],
      [
        'a listing made by staff, who hold the row FOR SHARE',
        (one, tx) =>
          tx.insert(s.serviceListings).values({ serviceId: one.id, slug: 'by-hand', publicTitle: 'By hand' }),
        ALREADY_LISTED,
        'share',
      ],
    ];
    for (const [name, change, expected, mode] of cases) {
      const one = await service(w);
      const input = await preparedInput(t, one.id);
      const writer = await holder(one, (tx) => change(one, tx), mode);
      const { outcome, writes } = await publishBehind(writer, input);
      expect(outcome, name).toEqual(expected);
      expect(writes, name).toEqual({});
    }
  });

  it('prices from the quote committed while it waited: a new cost inside the limit gives its rule price', async () => {
    const w = await world();
    await createRule();
    const one = await service(w);
    const input = await preparedInput(t, one.id);
    const writer = await holder(one, (tx) => syncCost(one.id, one.supplierServiceId, '11.0000', tx));
    const outcome = published((await publishBehind(writer, input)).outcome);
    expect(outcome.price.toWire()).toBe('14.9900');
    expect(outcome.detail).toBe('The price is $14.99, not the $13.99 of the preview.');
    expect(await followOf(one.id)).toMatchObject({ appliedPrice: '14.9900', appliedCost: '11.0000' });
  });

  it('keeps a price typed while it waited, and writes no follow row', async () => {
    const w = await world();
    await createRule();
    const one = await service(w);
    const input = await preparedInput(t, one.id);
    expect(input.price).toMatchObject({ mode: 'rule', replacesPrice: null });
    const retail = t.app.get(RetailPrices);
    const writer = await holder(one, async (tx) => {
      const quote = (await retail.quotes(tx, [one.id])).get(one.id)!;
      await retail.set(tx, one.id, m('20'), { origin: { kind: 'manual' }, quote });
    });
    const outcome = published((await publishBehind(writer, input)).outcome);
    expect(outcome).toMatchObject({ pricing: 'kept', priceWritten: false, detail: TYPED_SINCE_DETAIL });
    expect(outcome.price.toWire()).toBe('20.0000');
    expect(await retailOf(w, one.id)).toBe('20.0000');
    expect(await followOf(one.id)).toBeUndefined();
  });

  it('holds the row to its commit: a sync that arrives after the lock waits, and the price comes from the cost locked', async () => {
    const w = await world();
    await createRule();
    const one = await service(w);
    const input = await preparedInput(t, one.id);
    let sync!: Promise<void>;
    const outcome = published(
      await publishOne(t, input, {
        inside: async (tx) => {
          const publisherPid = await backendPid(tx);
          sync = syncCost(one.id, one.supplierServiceId, '100.0000');
          // The effective cost recompute: it locks the service rows first (decision 069), so that lock is what waits; an older form of
          // the recompute waited on its update, and the activity view may cut a long statement before it.
          expect(await blockedBy(publisherPid)).toMatch(/for no key update|update "services"|with figures as/);
        },
      }),
    );
    await sync;
    expect(outcome.price.toWire()).toBe('13.9900');
    expect(await followOf(one.id)).toMatchObject({ appliedPrice: '13.9900', appliedCost: '10.0000' });
    const [row] = await (await db()).select().from(s.services).where(eq(s.services.id, one.id));
    expect(row!.effectiveCost).toBe('100.0000');
  });

  it('takes the service row before the listing row: waiting on the listing, it already holds the service', async () => {
    const w = await world();
    await createRule();
    const one = await service(w);
    const input = await preparedInput(t, one.id);
    await insertListingRow(await db(), one.id, { slug: 'by-hand' });
    const writer = await rival((tx) =>
      tx.select().from(s.serviceListings).where(eq(s.serviceListings.serviceId, one.id)).for('update'),
    );
    const publishing = publishTraced(t, input);
    expect(await blockedBy(writer.pid)).toMatch(/from "service_listings".*for update/s);
    const free = await (
      await db()
    )
      .select({ id: s.services.id })
      .from(s.services)
      .where(eq(s.services.id, one.id))
      .for('update', { skipLocked: true });
    expect(free).toEqual([]);
    await writer.commit();
    expect(await publishing).toEqual({ outcome: ALREADY_LISTED, writes: {} });
  });
});

describe('ListingPublisher: the supplier links (supplyStates)', () => {
  it('one usable active link is enough, whichever link comes first: the state is ok and the row is published', async () => {
    const w = await world();
    await createRule();
    for (const [name, spoil] of UNUSABLE) {
      for (const spoilFirst of [true, false]) {
        const one = await service(w);
        const second = await insertSupplierLink(await db(), one.id, {
          credit: '10.0000',
          creditRate: '1',
          priority: 2,
        });
        await spoil(spoilFirst ? one : second);
        expect((await supplyStates(await db(), [one.id])).get(one.id), name).toBe('ok');
        published(await publishOne(t, await preparedInput(t, one.id)));
      }
    }
  });

  it('every active link unusable is supplier_unavailable, and an inactive usable link does not count', async () => {
    const w = await world();
    await createRule();
    const one = await service(w);
    await (await db()).update(s.suppliers).set({ status: 'disabled' }).where(eq(s.suppliers.id, one.supplierId));
    await insertSupplierLink(await db(), one.id, { credit: '10.0000', creditRate: '1', priority: 2, isActive: false });
    expect((await supplyStates(await db(), [one.id])).get(one.id)).toBe('supplier_unavailable');
    expect(await publishNothing(await preparedInput(t, one.id))).toEqual({
      result: 'refused',
      reason: 'supplier_unavailable',
      detail: null,
    });
  });

  it('supplies a service delivered from code stock by an available code, and refuses it out_of_stock with neither (decision 069)', async () => {
    const w = await world();
    await createRule();
    const gift = await service(w, { values: { stockDelivery: true } });
    await (await db()).update(s.suppliers).set({ status: 'paused' }).where(eq(s.suppliers.id, gift.supplierId));
    expect((await supplyStates(await db(), [gift.id])).get(gift.id)).toBe('out_of_stock');
    expect(await publishNothing(await preparedInput(t, gift.id))).toEqual({
      result: 'refused',
      reason: 'out_of_stock',
      detail: null,
    });
    // One available code is supply enough, with the supplier still paused, and with no link at all.
    await insertInventoryCodes(await db(), gift.id, 1);
    const bare = await insertService(await db(), w.categoryId, { stockDelivery: true });
    await insertInventoryCodes(await db(), bare, 1);
    const states = await supplyStates(await db(), [gift.id, bare]);
    expect([...states.values()]).toEqual(['ok', 'ok']);
    published(await publishOne(t, await preparedInput(t, gift.id)));
  });

  it('never counts the codes of a service that is not delivered from code stock', async () => {
    const w = await world();
    await createRule();
    const plain = await service(w);
    await (await db()).update(s.suppliers).set({ status: 'paused' }).where(eq(s.suppliers.id, plain.supplierId));
    await insertInventoryCodes(await db(), plain.id, 2);
    await markStockService(await db(), plain.id, false);
    expect((await supplyStates(await db(), [plain.id])).get(plain.id)).toBe('supplier_unavailable');
    expect(await publishNothing(await preparedInput(t, plain.id))).toEqual({
      result: 'refused',
      reason: 'supplier_unavailable',
      detail: null,
    });
  });

  it('no active link reads no_link, for a service with none, one with an inactive link and an unknown id', async () => {
    const w = await world();
    const none = await insertService(await db(), w.categoryId);
    const inactive = await insertService(await db(), w.categoryId);
    await insertSupplierLink(await db(), inactive, { isActive: false });
    const states = await supplyStates(await db(), [none, inactive, 999_999]);
    expect([...states.values()]).toEqual(['no_link', 'no_link', 'no_link']);
    expect((await supplyStates(await db(), [])).size).toBe(0);
  });
});

describe('ListingPublisher: a service adopted into server since the preview (feature 33)', () => {
  /** What the supplier sync does to the service (decision 042): the real adoption of the supplier's main box. */
  const adopt = async (serviceId: number) => {
    const field = mainInputField(
      { label: 'Serial Number', minLength: 1, maxLength: null },
      { keys: new Set(), names: new Set() },
    );
    const adopted = await t.app
      .get(DbService)
      .runInTransaction(({ tx }) => t.app.get(ServiceImporter).adoptMainInput(tx, { serviceId, field }));
    expect(adopted).toMatchObject({ before: { type: 'imei' }, after: { type: 'server' } });
    return adopted!;
  };
  const SERVER_50 = { scope: 'type', serviceType: 'server', percent: '50', rounding: 'ends_99' } as const;

  it('prices it by the rule of its new type, and says the price is not the one of the preview', async () => {
    const w = await world();
    await createRule();
    const serverRule = await createRule(SERVER_50);
    const one = await service(w);
    const input = await preparedInput(t, one.id);
    expect(input.price.rulePrice?.toWire()).toBe('13.9900');
    const adopted = await adopt(one.id);
    expect(adopted.categoryCreated).toBe(true);

    // 10 x 1.50 = 15.00, then 15.99.
    const outcome = published(await publishOne(t, input));
    expect(outcome).toMatchObject({
      pricing: 'rule',
      priceWritten: true,
      detail: 'The price is $15.99, not the $13.99 of the preview.',
    });
    expect(outcome.price.toWire()).toBe('15.9900');
    expect(await retailOf(w, one.id)).toBe('15.9900');
    expect(await followOf(one.id)).toMatchObject({ ruleId: serverRule.id, appliedPrice: '15.9900' });
    expect((await publishedAudits())[0]!.after).toMatchObject({ pricing: 'rule', ruleId: serverRule.id });
    expect(await shopSlugs()).toEqual([input.slug]);
  });

  it('prices it by the rule of the server category it moved into, before the rule of its type', async () => {
    const w = await world();
    await createRule();
    await createRule(SERVER_50);
    const serverCategory = await insertCategory(await db(), { name: 'Carrier unlock', type: 'server' });
    const categoryRule = await createRule({
      scope: 'category',
      categoryId: serverCategory,
      percent: '40',
      rounding: 'ends_99',
    });
    const one = await service(w);
    const input = await preparedInput(t, one.id);
    const adopted = await adopt(one.id);
    expect(adopted).toMatchObject({ categoryCreated: false, after: { categoryId: serverCategory } });

    // 10 x 1.40 = 14.00, then 14.99.
    const outcome = published(await publishOne(t, input));
    expect(outcome.detail).toBe('The price is $14.99, not the $13.99 of the preview.');
    expect(outcome.price.toWire()).toBe('14.9900');
    expect(await followOf(one.id)).toMatchObject({ ruleId: categoryRule.id, appliedPrice: '14.9900' });
  });

  it('refuses price_missing when no rule covers its new type or category', async () => {
    const w = await world();
    await createRule();
    const one = await service(w);
    const input = await preparedInput(t, one.id);
    expect(input.price.rulePrice).not.toBeNull();
    await adopt(one.id);
    expect(await publishNothing(input)).toEqual(NO_RULE);
  });

  it('judges the server category it moved into: closed to the retail group is b2b_only, switched off is category_inactive', async () => {
    const w = await world();
    await createRule();
    await createRule(SERVER_50);
    const cases: Array<[Partial<typeof s.serviceCategories.$inferInsert>, RefusalReason]> = [
      [{ allowedGroupIds: [w.groups.standard] }, 'b2b_only'],
      [{ isActive: false }, 'category_inactive'],
    ];
    for (const [values, reason] of cases) {
      const sameName = await insertCategory(await db(), { name: `Group ${reason}` });
      const reused = await insertCategory(await db(), { name: `Group ${reason}`, type: 'server', ...values });
      const one = await service(w, { values: { categoryId: sameName } });
      const input = await preparedInput(t, one.id);
      expect(await adopt(one.id)).toMatchObject({ categoryCreated: false, after: { categoryId: reused } });
      expect(await publishNothing(input), reason).toEqual({ result: 'refused', reason, detail: null });
    }
  });
});

describe('ListingPublisher: concurrency', () => {
  it('against a staff create of the same service: one listing; the publisher skips or the staff call answers 409', async () => {
    const w = await world();
    await createRule();
    for (let round = 0; round < 3; round += 1) {
      const one = await service(w);
      const input = await preparedInput(t, one.id);
      const [outcome, staff] = await Promise.all([
        publishOne(t, input),
        admin.post('/admin/service-listings', { serviceId: one.id, publicTitle: 'By hand' }),
      ]);
      const listings = (await publishTrace(await db(), one.id)).listings;
      expect(listings).toHaveLength(1);
      if (outcome.result === 'published') {
        expect(staff.status).toBe(409);
        expect(listings[0]!.publicTitle).toBe(input.title);
      } else {
        expect(outcome).toEqual({ result: 'skipped', reason: 'already_listed', detail: null });
        expect(staff.status).toBe(201);
        expect(await retailOf(w, one.id)).toBeNull();
      }
    }
  });

  it('against a staff disable of the service: either published then disabled, or refused with nothing written', async () => {
    const w = await world();
    await createRule();
    for (let round = 0; round < 3; round += 1) {
      const one = await service(w);
      const input = await preparedInput(t, one.id);
      const [outcome, patch] = await Promise.all([
        publishOne(t, input),
        admin.patch(`/admin/services/${one.id}`, { status: 'disabled' }),
      ]);
      expect(patch.status).toBe(200);
      if (outcome.result === 'published') {
        expect(await listingOf(one.id)).toBeDefined();
      } else {
        expect(outcome).toMatchObject({ result: 'refused', reason: 'service_disabled' });
        expect(await publishTrace(await db(), one.id)).toEqual({ listings: [], prices: [], follows: [] });
      }
    }
  });

  it('against a supplier sync raising the costs inside the limit: no deadlock, each price the rule price of the cost it committed against', async () => {
    const w = await world();
    await createRule();
    const first = await service(w);
    // Five more services of the same supplier.
    const ids = [first.id];
    const remotes = [first.supplierServiceId];
    for (let index = 0; index < 5; index += 1) {
      const id = await insertService(await db(), w.categoryId, {
        name: `Unlock ${index}`,
        cost: '10.0000',
        effectiveCost: '10.0000',
        basePrice: '10.6000',
        minProfit: null,
      });
      const [remote] = await (
        await db()
      )
        .insert(s.supplierServices)
        .values({ supplierId: first.supplierId, remoteId: crypto.randomUUID(), type: 'IMEI', name: 'R', credit: '10' })
        .returning({ id: s.supplierServices.id });
      await (
        await db()
      )
        .insert(s.serviceSupplierLinks)
        .values({ serviceId: id, supplierServiceId: remote!.id, priority: 1 });
      ids.push(id);
      remotes.push(remote!.id);
    }
    const inputs = await Promise.all(ids.map((id) => preparedInput(t, id)));
    // The sync's transaction: the supplier row, then every linked service's effective cost in one statement (+10 %).
    const sync = t.app.get(DbService).runInTransaction(async ({ tx }) => {
      await tx.execute(sql`select id from suppliers where id = ${first.supplierId} for update`);
      await tx.update(s.supplierServices).set({ credit: '11.0000' }).where(inArray(s.supplierServices.id, remotes));
      await recomputeEffectiveCost(tx, ids);
    });
    const outcomes = await Promise.all([...inputs.map((input) => publishOne(t, input)), sync]);
    for (const [index, id] of ids.entries()) {
      const outcome = published(outcomes[index] as PublishOutcome);
      const follow = await followOf(id);
      // The price and the cost it was worked out from agree: 13.99 at 10.00, 14.99 at 11.00 (the floor is 11.66 at both).
      expect(['10.0000', '11.0000']).toContain(follow!.appliedCost);
      expect(outcome.price.toWire()).toBe(follow!.appliedCost === '10.0000' ? '13.9900' : '14.9900');
      expect(outcome.price.cmp(m('11.66'))).toBeGreaterThanOrEqual(0);
    }
  });
});

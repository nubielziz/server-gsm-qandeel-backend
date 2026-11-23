// The retail price follow pass (feature 31 slice B5, decision 040, plan 31 sections 3.4, 5.4, 6.4, 6.5 and 8.3): the table of 3.4 against
// the database, the life of a proposal, the routes that list and resolve it, the pass against everything that runs beside it (a typed
// price, a rule edit or delete, a supplier sync, a publish run, a second pass), its scheduling, the hourly message and `job_runs`.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';
import { asc, eq, inArray, sql } from 'drizzle-orm';
import { AppModule } from '@src/app.module';
import { Money } from '@src/common/money';
import { EncryptionService } from '@src/infra/crypto';
import { type Database, DbService, type DbExecutor, schema as s } from '@src/infra/db';
import { JobSchedulerRegistry, QueuesService } from '@src/infra/queues';
import { RedisService } from '@src/infra/redis';
import {
  CatalogPriceVersion,
  CatalogPricesModule,
  RETAIL_FOLLOW_DELAY_MS,
  RETAIL_FOLLOW_JOB,
  RETAIL_FOLLOW_PAGE,
  RETAIL_FOLLOW_SCHEDULER,
  RetailFollowScheduler,
  RetailPriceFollow,
  RetailPriceFollowModule,
  RetailPriceFollowProcessor,
  RetailPrices,
  RetailPricing,
  ServiceImporter,
  recomputeEffectiveCost,
} from '@src/modules/catalog';
import { RetailFollowSteps } from '@src/modules/catalog/application/retail-follow-steps';
import { JobRunsService } from '@src/modules/health';
import { NotificationService } from '@src/modules/platform';
import { PublishRunner } from '@src/modules/storefront/publish/application/publish-runner';
import { SupplierSync } from '@src/modules/suppliers';
import { mainInputField } from '@src/modules/suppliers/domain/import-plan';
import { WorkerModule } from '@src/worker.module';
import { type AdminApi, adminWith } from '../../support/admin-api';
import { type TestApp, createTestApp } from '../../support/app';
import { clearIdentityCaches } from '../../support/auth';
import { B2cGateway, b2cWorld, json, openCheckout, pay } from '../../support/b2c';
import { GatewayTestModule } from '../../support/billing';
import { insertCategory, insertService, insertSupplierLink } from '../../support/catalog';
import { HOUR, MINUTE, TestClock } from '../../support/clock';
import { closeTestDb, resetDb, testDb } from '../../support/db';
import { insertUsd } from '../../support/fixtures';
import { eventually } from '../../support/infra';
import { mailbox, notificationRows, seedDefaultTemplates, sendAllQueued } from '../../support/notifications';
import { freshClientIp } from '../../support/pipeline-routes';
import { catalogVersionOf, insertDemoGroups } from '../../support/pricing';
import { seedRun } from '../../support/publish';
import { deleteBullKeys, testBullPrefix } from '../../support/queues';
import { expectRejection } from '../../support/rejection';
import { insertListingRow, storefrontWorld } from '../../support/storefront';
import { FakeDhruSupplier, SupplierTestModule, insertFakeSupplier, linkService } from '../../support/suppliers';

const prefix = testBullPrefix();
const clock = new TestClock('2026-11-18T09:00:00.000Z');
const EMAILS = 'ops@gsm.example,oncall@gsm.example';
const CHAT = '-1001234567890';
const gateway = new B2cGateway();
const fakeSupplier = new FakeDhruSupplier();
let t: TestApp;
let db: Database;
let admin: AdminApi;

const NOTICE_ENV = {
  BULL_PREFIX: prefix,
  TELEGRAM_BOT_TOKEN: '1234567890:AAtest-token',
  TELEGRAM_BOT_USERNAME: 'gsm_test_bot',
};

beforeAll(async () => {
  ({ db } = await testDb());
  t = await createTestApp({
    clock,
    env: { ...NOTICE_ENV, ALERTS_EMAIL_TO: EMAILS, ALERTS_TELEGRAM_CHAT_ID: CHAT },
    imports: [RetailPriceFollowModule, GatewayTestModule, SupplierTestModule],
  });
});
beforeEach(async () => {
  clock.set('2026-11-18T09:00:00.000Z');
  await resetDb();
  await deleteBullKeys(t.app.get(RedisService).queue, prefix);
  await clearIdentityCaches(t);
  admin = await adminWith(t, ['pricing:*', 'storefront:*', 'catalog:*'], { name: 'Rami K.' });
});
afterEach(() => mock.restore());
afterAll(async () => {
  await gateway.stop();
  await fakeSupplier.stop();
  await deleteBullKeys(t.app.get(RedisService).queue, prefix);
  await resetDb();
  await clearIdentityCaches(t);
  await t.close();
  await closeTestDb();
});

const follow = () => t.app.get(RetailPriceFollow, { strict: false });
const pass = () => follow().run();
const m = (value: string) => Money.of(value);

/** IMEI +30 %, ends in .99 from $5, limit 25 %: cost 10.0000 gives 13.99. */
const IMEI_30 = { scope: 'type', serviceType: 'imei', percent: '30', rounding: 'ends_99' } as const;
const createRule = async (body: Record<string, unknown> = IMEI_30) => {
  const res = await admin.post('/admin/retail-price-rules', body);
  expect(res.status).toBe(201);
  return res.body as { id: number; label: string };
};

interface World {
  readonly retail: number;
  readonly categoryId: number;
  readonly ruleId: number;
}

/** USD, the demo groups (the last is the retail group), a category open to every group, and the IMEI rule. */
async function world(rule: Record<string, unknown> = IMEI_30): Promise<World> {
  await insertUsd(db);
  const groups = await insertDemoGroups(db);
  const categoryId = await insertCategory(db, { name: 'Carrier unlock' });
  return { retail: groups.retail, categoryId, ruleId: (await createRule(rule)).id };
}

interface ServiceOptions {
  /** The effective cost (default 10.0000), and the supplier's credit that gives it. */
  readonly cost?: string;
  /** `services.cost`: the effective cost never falls under it (default: the cost). */
  readonly importedCost?: string;
  /** Base 5.00 keeps the floor (cost + 6 %) under the rule's prices, so they read plainly. */
  readonly basePrice?: string;
  readonly categoryId?: number;
}

/** A service with a supplier link, priced by no one yet. */
async function serviceOf(w: World, options: ServiceOptions = {}) {
  const cost = options.cost ?? '10.0000';
  const id = await insertService(db, options.categoryId ?? w.categoryId, {
    name: `Unlock ${crypto.randomUUID().slice(0, 6)}`,
    cost: options.importedCost ?? cost,
    effectiveCost: cost,
    basePrice: options.basePrice ?? '5.0000',
    minProfit: null,
  });
  const link = await insertSupplierLink(db, id, { credit: cost, creditRate: '1' });
  return { id, ...link };
}

/** Starts following: the rule price of now through the one writer, as `retailPricing: 'rule'` does. */
async function startFollowing(serviceId: number): Promise<void> {
  const retail = t.app.get(RetailPrices, { strict: false });
  const pricing = t.app.get(RetailPricing, { strict: false });
  await t.app.get(DbService).runInTransaction(async ({ tx }) => {
    await retail.lockLiveService(tx, serviceId);
    const target = (await pricing.targets(tx, [serviceId])).get(serviceId)!;
    if (target.rulePrice?.kind !== 'price') throw new Error('The rule gives no price.');
    await retail.set(tx, serviceId, target.rulePrice.price, {
      origin: { kind: 'rule', ruleId: target.rule!.id, cost: target.quote.cost },
      quote: target.quote,
    });
  });
}

/** A service whose retail price follows its rule. */
async function follower(w: World, options: ServiceOptions = {}) {
  const service = await serviceOf(w, options);
  await startFollowing(service.id);
  return service;
}

type Service = Awaited<ReturnType<typeof serviceOf>>;

/** What a sync does to one supplier service: the supplier's new credit, then the effective cost worked out again. */
async function syncCost(service: Service, credit: string, tx?: DbExecutor): Promise<void> {
  const executor = tx ?? db;
  await executor.update(s.supplierServices).set({ credit }).where(eq(s.supplierServices.id, service.supplierServiceId));
  await recomputeEffectiveCost(executor, [service.id]);
}

const retailOf = async (w: World, serviceId: number) =>
  (
    await db
      .select({ price: s.serviceGroupPrices.price })
      .from(s.serviceGroupPrices)
      .where(sql`${s.serviceGroupPrices.serviceId} = ${serviceId} and ${s.serviceGroupPrices.groupId} = ${w.retail}`)
  )[0]?.price ?? null;
const followOf = async (serviceId: number) =>
  (await db.select().from(s.retailPriceFollows).where(eq(s.retailPriceFollows.serviceId, serviceId)))[0];
const changes = (serviceId?: number) =>
  db
    .select()
    .from(s.retailPriceChanges)
    .where(serviceId === undefined ? undefined : eq(s.retailPriceChanges.serviceId, serviceId))
    .orderBy(asc(s.retailPriceChanges.id));
const auditsOf = async (action: string) =>
  (await db.select().from(s.auditLogs).orderBy(s.auditLogs.id)).filter((row) => row.action === action);
const RESOLVE = '/admin/retail-price-changes/resolve';
/** What the list shows of these proposals now: the `seen` of an approval made from it. */
const seenNow = async (ids: readonly number[]) => {
  const rows = await db
    .select({ id: s.retailPriceChanges.id, newPrice: s.retailPriceChanges.newPrice })
    .from(s.retailPriceChanges)
    .where(inArray(s.retailPriceChanges.id, [...ids]));
  const prices = new Map(rows.map((row) => [row.id, row.newPrice]));
  return [...new Set(ids)].map((id) => ({ id, newPrice: prices.get(id) ?? null }));
};
/** Answers proposals as the console does: an approval names the figures on the screen, here the ones of now. */
const resolve = async (ids: number[], action: 'apply' | 'keep', by: AdminApi = admin) =>
  by.post(RESOLVE, action === 'apply' ? { ids, action, seen: await seenNow(ids) } : { ids, action });
const listingOf = (serviceId: number) =>
  insertListingRow(db, serviceId, { slug: `s-${serviceId}`, publicTitle: `Service ${serviceId}` });
const listed = async (listingId: number) => (await admin.get(`/admin/service-listings/${listingId}`)).body;

/** Returns once a statement waits for a lock another transaction holds: the race a test sets up has started. */
const someoneWaitsForALock = () =>
  eventually(async () => {
    const { rows } = await db.execute<{ pid: number }>(sql`
      select pid from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock' limit 1`);
    return rows[0];
  });

/** A follower whose cost jumped from 10 to 20: a `cost_jump` proposal for 26.99 waits. */
async function waitingProposal(w: World, options: ServiceOptions = {}) {
  const service = await follower(w, options);
  await syncCost(service, '20.0000');
  await pass();
  const [proposal] = await changes(service.id);
  expect(proposal).toMatchObject({ kind: 'proposed', newPrice: '26.9900' });
  return { service, proposal: proposal! };
}

describe('the table of plan 31 section 3.4', () => {
  it('follows a cost rise inside the limit: the price, a followed row, an audit row, the follow row and the version', async () => {
    const w = await world();
    const service = await follower(w);
    expect(await retailOf(w, service.id)).toBe('13.9900');
    await syncCost(service, '12.0000');
    clock.advance(MINUTE);
    const before = await catalogVersionOf(t);

    expect(await pass()).toMatchObject({ checked: 1, candidates: 1, followed: 1, proposed: 0 });

    expect(await retailOf(w, service.id)).toBe('15.9900');
    expect(await changes()).toEqual([
      expect.objectContaining({
        serviceId: service.id,
        ruleId: w.ruleId,
        kind: 'followed',
        reason: 'cost_changed',
        oldPrice: '13.9900',
        newPrice: '15.9900',
        oldCost: '10.0000',
        newCost: '12.0000',
        resolution: null,
        resolvedAt: null,
        createdAt: clock.now(),
      }),
    ]);
    expect(await followOf(service.id)).toMatchObject({
      ruleId: w.ruleId,
      appliedPrice: '15.9900',
      appliedCost: '12.0000',
    });
    expect((await followOf(service.id))!.appliedAt).toEqual(clock.now());
    const [audit] = await auditsOf('changed retail price of');
    expect(audit).toMatchObject({
      actorType: 'system',
      entityType: 'service',
      entityId: service.id,
      before: { retailPrice: '13.9900', cost: '10.0000' },
      after: { retailPrice: '15.9900', cost: '12.0000', reason: 'cost_changed', ruleId: w.ruleId },
    });
    expect(await catalogVersionOf(t)).not.toBe(before);
  });

  it('follows a supplier price drop down to the imported cost, and no further', async () => {
    const w = await world();
    const service = await follower(w, { importedCost: '8.0000' });
    await syncCost(service, '8.5000');
    await pass();
    expect(await retailOf(w, service.id)).toBe('11.9900');
    await syncCost(service, '3.0000');
    expect((await pass()).followed).toBe(1);
    // The effective cost stops at `services.cost`, 8.0000: +30 % gives 10.40, ends in .99.
    expect(await retailOf(w, service.id)).toBe('10.9900');
    expect((await followOf(service.id))!.appliedCost).toBe('8.0000');
  });

  it('follows a move of exactly the limit, and one unit more waits', async () => {
    const w = await world();
    const exact = await follower(w);
    const over = await follower(w);
    await syncCost(exact, '12.5000');
    await syncCost(over, '12.5001');
    expect(await pass()).toMatchObject({ followed: 1, proposed: 1 });
    expect(await retailOf(w, exact.id)).toBe('16.9900');
    expect(await retailOf(w, over.id)).toBe('13.9900');
    expect((await changes(over.id))[0]).toMatchObject({ kind: 'proposed', reason: 'cost_jump', newCost: '12.5001' });
  });

  it('moves every follower at once when staff edit the rule, whatever the size', async () => {
    const w = await world();
    const one = await follower(w);
    const two = await follower(w, { cost: '20.0000' });
    clock.advance(MINUTE);
    expect((await admin.patch(`/admin/retail-price-rules/${w.ruleId}`, { percent: '300' })).status).toBe(200);
    expect(await pass()).toMatchObject({ followed: 2, proposed: 0 });
    expect(await retailOf(w, one.id)).toBe('40.9900');
    expect(await retailOf(w, two.id)).toBe('80.9900');
    expect((await changes()).map((row) => row.reason)).toEqual(['rule_changed', 'rule_changed']);
  });

  it('moves a price when a base price edit moves the floor', async () => {
    const w = await world();
    const service = await follower(w);
    clock.advance(MINUTE);
    expect((await admin.patch(`/admin/services/${service.id}`, { basePrice: '20.0000' })).status).toBe(200);
    expect((await pass()).followed).toBe(1);
    // 20.00 x 1.10 = 22.00 is the floor now; the rule's 13.00 is lifted to it, then ends in .99.
    expect(await retailOf(w, service.id)).toBe('22.9900');
    expect((await changes(service.id))[0]).toMatchObject({
      reason: 'floor_changed',
      oldCost: '10.0000',
      newCost: '10.0000',
    });
  });

  it('falls back by precedence when a rule is switched off or deleted, and with no rule the price stays', async () => {
    const w = await world();
    const general = await createRule({ scope: 'global', percent: '50', rounding: 'cent' });
    const service = await follower(w);
    clock.advance(MINUTE);
    expect((await admin.patch(`/admin/retail-price-rules/${w.ruleId}`, { isActive: false })).status).toBe(200);
    expect((await pass()).followed).toBe(1);
    expect(await retailOf(w, service.id)).toBe('15.0000');
    expect((await changes(service.id))[0]).toMatchObject({ reason: 'rule_changed', ruleId: general.id });

    clock.advance(MINUTE);
    expect((await admin.delete(`/admin/retail-price-rules/${general.id}`)).status).toBe(204);
    expect(await pass()).toMatchObject({ candidates: 0, followed: 0 });
    expect(await retailOf(w, service.id)).toBe('15.0000');
    expect(await followOf(service.id)).toMatchObject({ ruleId: general.id, appliedPrice: '15.0000' });

    // A rule switched on again picks the price up.
    clock.advance(MINUTE);
    expect((await admin.patch(`/admin/retail-price-rules/${w.ruleId}`, { isActive: true })).status).toBe(200);
    expect((await pass()).followed).toBe(1);
    expect(await retailOf(w, service.id)).toBe('13.9900');
  });

  it('records the new cost and the rule when the rule gives the stored price, with no change row', async () => {
    const w = await world();
    const service = await follower(w);
    await syncCost(service, '10.2000');
    clock.advance(MINUTE);
    const version = await catalogVersionOf(t);
    expect(await pass()).toMatchObject({ settled: 1, followed: 0 });
    expect(await followOf(service.id)).toMatchObject({ appliedCost: '10.2000' });
    expect((await followOf(service.id))!.appliedAt).toEqual(clock.now());
    expect(await retailOf(w, service.id)).toBe('13.9900');
    expect(await changes()).toEqual([]);
    expect(await catalogVersionOf(t)).toBe(version);
  });

  it('names the new rule on the follow row when it gives the stored price, with no change row', async () => {
    const w = await world();
    const general = await createRule({ scope: 'global', percent: '30', rounding: 'ends_99' });
    const service = await follower(w);
    clock.advance(MINUTE);
    expect((await admin.delete(`/admin/retail-price-rules/${w.ruleId}`)).status).toBe(204);
    expect(await pass()).toMatchObject({ settled: 1, followed: 0 });
    expect(await followOf(service.id)).toMatchObject({ ruleId: general.id, appliedCost: '10.0000' });
    expect((await followOf(service.id))!.appliedAt).toEqual(clock.now());
    expect(await changes()).toEqual([]);
    expect((await pass()).candidates).toBe(0);
  });

  it('takes the follow row of an archived service and of a service with no retail row, and closes their proposals', async () => {
    const w = await world();
    const archived = await waitingProposal(w);
    const noPrice = await waitingProposal(w);
    await db
      .update(s.services)
      .set({ archivedAt: clock.now(), status: 'disabled' })
      .where(eq(s.services.id, archived.service.id));
    await db.delete(s.serviceGroupPrices).where(eq(s.serviceGroupPrices.serviceId, noPrice.service.id));
    expect((await pass()).removed).toBe(2);
    expect(await followOf(archived.service.id)).toBeUndefined();
    expect(await followOf(noPrice.service.id)).toBeUndefined();
    for (const { proposal } of [archived, noPrice]) {
      const [row] = await db.select().from(s.retailPriceChanges).where(eq(s.retailPriceChanges.id, proposal.id));
      expect(row).toMatchObject({ resolution: 'superseded', resolvedBy: null });
      expect(row!.resolvedAt).toEqual(clock.now());
    }
  });

  it('detaches a retail row changed another way: the price is a typed one, and the rules leave it alone', async () => {
    const w = await world();
    const service = await follower(w);
    await db
      .update(s.serviceGroupPrices)
      .set({ price: '50.0000' })
      .where(eq(s.serviceGroupPrices.serviceId, service.id));
    await syncCost(service, '11.0000');
    expect((await pass()).detached).toBe(1);
    expect(await followOf(service.id)).toBeUndefined();
    expect(await retailOf(w, service.id)).toBe('50.0000');
    expect(await changes(service.id)).toEqual([
      expect.objectContaining({
        kind: 'detached',
        reason: 'changed_elsewhere',
        ruleId: w.ruleId,
        oldPrice: '13.9900',
        newPrice: null,
        oldCost: '10.0000',
        newCost: '11.0000',
      }),
    ]);
    expect((await auditsOf('detached retail price of'))[0]).toMatchObject({
      actorType: 'system',
      after: { retailPrice: '50.0000', reason: 'changed_elsewhere' },
    });
    await syncCost(service, '12.0000');
    expect(await pass()).toMatchObject({ checked: 0, candidates: 0 });
    expect(await retailOf(w, service.id)).toBe('50.0000');
  });

  it('never touches a typed price, whatever the cost does', async () => {
    const w = await world();
    const service = await serviceOf(w);
    expect(
      (
        await admin.put(`/admin/services/${service.id}/group-prices`, {
          prices: [{ groupId: w.retail, price: '40.0000' }],
        })
      ).status,
    ).toBe(200);
    for (const credit of ['12.0000', '100.0000', '0.5000']) {
      await syncCost(service, credit);
      expect(await pass()).toMatchObject({ checked: 0 });
    }
    expect(await retailOf(w, service.id)).toBe('40.0000');
    expect(await changes()).toEqual([]);
  });

  it('opens a no_cost proposal for a cost of 0, keeps the price, and follows again when the cost is back', async () => {
    const w = await world();
    const service = await follower(w);
    await db.update(s.services).set({ cost: '0', effectiveCost: '0' }).where(eq(s.services.id, service.id));
    expect((await pass()).proposed).toBe(1);
    expect(await retailOf(w, service.id)).toBe('13.9900');
    const [proposal] = await changes(service.id);
    expect(proposal).toMatchObject({
      kind: 'proposed',
      reason: 'no_cost',
      oldPrice: '13.9900',
      newPrice: null,
      oldCost: '10.0000',
      newCost: '0.0000',
    });
    expect((await resolve([proposal!.id], 'apply')).body.skipped).toEqual([{ id: proposal!.id, reason: 'no_cost' }]);

    await db.update(s.services).set({ effectiveCost: '11.0000' }).where(eq(s.services.id, service.id));
    expect((await pass()).followed).toBe(1);
    expect(await retailOf(w, service.id)).toBe('14.9900');
    expect((await changes(service.id))[0]).toMatchObject({ resolution: 'superseded', resolvedBy: null });
  });

  it('names rule_changed for a rule edited since and floor_changed when only the floor can have moved', async () => {
    const w = await world();
    const service = await follower(w);
    clock.advance(MINUTE);
    await admin.patch(`/admin/retail-price-rules/${w.ruleId}`, { percent: '40' });
    await pass();
    clock.advance(MINUTE);
    await db.update(s.services).set({ basePrice: '30.0000' }).where(eq(s.services.id, service.id));
    await pass();
    await syncCost(service, '33.0000');
    await pass();
    expect((await changes(service.id)).map((row) => [row.kind, row.reason, row.newPrice])).toEqual([
      ['followed', 'rule_changed', '14.9900'],
      ['followed', 'floor_changed', '33.9900'],
      ['proposed', 'cost_jump', '46.9900'],
    ]);
  });
});

describe('a service that moved while the rules did not (plan correction 3)', () => {
  /** A category with its own rule (+50 %) made before the service was priced: the rules stand still from here on. */
  async function moved() {
    const w = await world();
    const other = await insertCategory(db, { name: 'Moved here' });
    const rule = await createRule({ scope: 'category', categoryId: other, percent: '50', rounding: 'cent' });
    clock.advance(MINUTE);
    const service = await follower(w);
    clock.advance(MINUTE);
    return { w, other, rule, service };
  }

  it('waits for staff: a sync adoption changes the rule with no one watching', async () => {
    const { w, other, rule, service } = await moved();
    await db.update(s.services).set({ categoryId: other }).where(eq(s.services.id, service.id));
    expect((await pass()).proposed).toBe(1);
    expect(await retailOf(w, service.id)).toBe('13.9900');
    const [proposal] = await changes(service.id);
    expect(proposal).toMatchObject({ reason: 'rule_changed', ruleId: rule.id, newPrice: '15.0000' });
    expect(await followOf(service.id)).toMatchObject({ ruleId: w.ruleId });

    expect((await resolve([proposal!.id], 'apply')).body).toEqual({ applied: 1, kept: 0, skipped: [] });
    expect(await retailOf(w, service.id)).toBe('15.0000');
    expect(await followOf(service.id)).toMatchObject({ ruleId: rule.id });
    expect((await pass()).candidates).toBe(0);
  });

  it('still waits after an edit of the old rule that moved no price: the pass already took that edit in', async () => {
    const { w, other, service } = await moved();
    await admin.patch(`/admin/retail-price-rules/${w.ruleId}`, { autoFollowPercent: 30 });
    expect(await pass()).toMatchObject({ settled: 1, followed: 0 });
    clock.advance(MINUTE);
    await db.update(s.services).set({ categoryId: other }).where(eq(s.services.id, service.id));
    expect(await pass()).toMatchObject({ proposed: 1, followed: 0 });
  });

  it('applies at once when staff edited, switched off or deleted the old rule', async () => {
    for (const change of [
      (id: number) => admin.patch(`/admin/retail-price-rules/${id}`, { percent: '31' }),
      (id: number) => admin.patch(`/admin/retail-price-rules/${id}`, { isActive: false }),
      (id: number) => admin.delete(`/admin/retail-price-rules/${id}`),
    ]) {
      await resetDb();
      admin = await adminWith(t, ['pricing:*', 'storefront:*', 'catalog:*']);
      const { w, other, service } = await moved();
      await db.update(s.services).set({ categoryId: other }).where(eq(s.services.id, service.id));
      expect((await change(w.ruleId)).status).toBeLessThan(300);
      expect(await pass()).toMatchObject({ followed: 1, proposed: 0 });
      expect(await retailOf(w, service.id)).toBe('15.0000');
      expect((await changes(service.id))[0]).toMatchObject({ kind: 'followed', reason: 'rule_changed' });
    }
  });

  it('applies at once when staff made the new rule after the price', async () => {
    const w = await world();
    const service = await follower(w);
    clock.advance(MINUTE);
    await createRule({ scope: 'category', categoryId: w.categoryId, percent: '50', rounding: 'cent' });
    expect(await pass()).toMatchObject({ followed: 1, proposed: 0 });
    expect(await retailOf(w, service.id)).toBe('15.0000');
  });

  it('treats a follow row whose rule went with a deleted category as "the rule changed"', async () => {
    const w = await world();
    const gone = await insertCategory(db, { name: 'To delete' });
    const rule = await createRule({ scope: 'category', categoryId: gone, percent: '50', rounding: 'cent' });
    const service = await follower(w, { categoryId: gone });
    expect(await followOf(service.id)).toMatchObject({ ruleId: rule.id, appliedPrice: '15.0000' });
    await db.update(s.services).set({ categoryId: w.categoryId }).where(eq(s.services.id, service.id));
    expect((await admin.delete(`/admin/service-categories/${gone}`)).status).toBe(204);
    expect((await followOf(service.id))!.ruleId).toBeNull();
    clock.advance(MINUTE);
    expect(await pass()).toMatchObject({ followed: 1, proposed: 0, failed: 0 });
    expect(await retailOf(w, service.id)).toBe('13.9900');
    expect(await followOf(service.id)).toMatchObject({ ruleId: w.ruleId });
    expect((await changes(service.id))[0]).toMatchObject({ reason: 'rule_changed', ruleId: w.ruleId });
  });
});

describe('a service the supplier sync adopts (plan correction 3, the real adoption)', () => {
  const SERVER_50 = { scope: 'type', serviceType: 'server', percent: '50', rounding: 'cent' } as const;
  const adopt = (serviceId: number) => {
    const field = mainInputField({ label: 'Serial Number', minLength: 1, maxLength: null }, new Set());
    return t.app
      .get(DbService)
      .runInTransaction(({ tx }) =>
        t.app.get(ServiceImporter, { strict: false }).adoptMainInput(tx, { serviceId, field }),
      );
  };

  /** A price set by the IMEI rule, then an edit of the `server` rule: newer than the price, and about no service of this type yet. */
  async function ruleEditedAfterThePrice() {
    const w = await world();
    const serverRule = await createRule(SERVER_50);
    const service = await follower(w);
    clock.advance(MINUTE);
    expect((await admin.patch(`/admin/retail-price-rules/${serverRule.id}`, { percent: '60' })).status).toBe(200);
    expect((await pass()).candidates).toBe(0);
    clock.advance(MINUTE);
    return { w, serverRule, service };
  }

  it('waits for staff, even under a rule edited after the price was set', async () => {
    const { w, serverRule, service } = await ruleEditedAfterThePrice();
    expect(await adopt(service.id)).toMatchObject({ before: { type: 'imei' }, after: { type: 'server' } });
    const row = await followOf(service.id);
    expect(row!.appliedAt).toEqual(clock.now());
    expect(row).toMatchObject({ ruleId: w.ruleId, appliedPrice: '13.9900', appliedCost: '10.0000' });

    clock.advance(MINUTE);
    expect(await pass()).toMatchObject({ proposed: 1, followed: 0 });
    expect(await retailOf(w, service.id)).toBe('13.9900');
    expect(await changes(service.id)).toEqual([
      expect.objectContaining({
        kind: 'proposed',
        reason: 'rule_changed',
        ruleId: serverRule.id,
        oldPrice: '13.9900',
        newPrice: '16.0000',
      }),
    ]);
    expect(await auditsOf('changed retail price of')).toEqual([]);
  });

  it('applies at once when staff edit that rule after the move', async () => {
    const { w, serverRule, service } = await ruleEditedAfterThePrice();
    await adopt(service.id);
    clock.advance(MINUTE);
    expect((await admin.patch(`/admin/retail-price-rules/${serverRule.id}`, { percent: '70' })).status).toBe(200);
    expect(await pass()).toMatchObject({ followed: 1, proposed: 0 });
    expect(await retailOf(w, service.id)).toBe('17.0000');
    expect((await changes(service.id))[0]).toMatchObject({ kind: 'followed', reason: 'rule_changed' });
  });

  it('moves the time only when it adopts, and only on the follow row of that service', async () => {
    const { w, service } = await ruleEditedAfterThePrice();
    const other = await follower(w);
    const otherAt = (await followOf(other.id))!.appliedAt;
    clock.advance(MINUTE);
    await adopt(service.id);
    const adoptedAt = (await followOf(service.id))!.appliedAt;
    expect(adoptedAt).toEqual(clock.now());
    expect((await followOf(other.id))!.appliedAt).toEqual(otherAt);

    clock.advance(MINUTE);
    // Already a `server` service: nothing is adopted, so nothing moves.
    expect(await adopt(service.id)).toBeNull();
    expect((await followOf(service.id))!.appliedAt).toEqual(adoptedAt);
  });

  it('moves the time inside the transaction of the adoption: a sync that fails leaves it', async () => {
    const { service } = await ruleEditedAfterThePrice();
    const before = (await followOf(service.id))!.appliedAt;
    const field = mainInputField({ label: 'Serial Number', minLength: 1, maxLength: null }, new Set());
    const failed = t.app.get(DbService).runInTransaction(async ({ tx }) => {
      await t.app.get(ServiceImporter, { strict: false }).adoptMainInput(tx, { serviceId: service.id, field });
      throw new Error('the sync failed');
    });
    await expectRejection(failed, 'the sync failed');
    expect((await followOf(service.id))!.appliedAt).toEqual(before);
  });

  it('adopts a service whose price is typed without any follow row appearing', async () => {
    const w = await world();
    const service = await serviceOf(w);
    expect(await adopt(service.id)).toMatchObject({ after: { type: 'server' } });
    expect(await followOf(service.id)).toBeUndefined();
  });
});

describe('a service the supplier sync really adopts (plan correction 3 and item 15)', () => {
  const SERVER_50 = { scope: 'type', serviceType: 'server', percent: '50', rounding: 'cent' } as const;
  /** A sample IMEI service whose main box asks for a serial number: the sync turns the services linked to it into `server` ones. */
  const SERIAL_SERVICE = {
    id: '9102',
    group: 'Sample serial tools',
    type: 'IMEI',
    name: 'Sample serial check',
    credit: '2.0000',
    time: '2 hours',
    custom: { allow: '1', customname: 'Serial Number', customlen: '10', maxlength: '12' },
  };
  const sync = () => t.app.get(SupplierSync, { strict: false });

  /** A following IMEI price (13.99) of a service linked to the supplier service the fake lists, and a `server` rule edited after it. */
  async function followerOfTheSupplier() {
    const w = await world();
    const serverRule = await createRule(SERVER_50);
    fakeSupplier.reset();
    fakeSupplier.services = [{ ...SERIAL_SERVICE }];
    const supplierId = await insertFakeSupplier(db, t.app.get(EncryptionService), fakeSupplier);
    const serviceId = await insertService(db, w.categoryId, {
      name: 'Sample serial check',
      cost: '10.0000',
      effectiveCost: '10.0000',
      basePrice: '5.0000',
      minProfit: null,
    });
    await linkService(db, serviceId, supplierId, { remoteId: '9102', credit: '10.0000', name: 'Sample serial check' });
    await startFollowing(serviceId);
    clock.advance(MINUTE);
    expect((await admin.patch(`/admin/retail-price-rules/${serverRule.id}`, { percent: '60' })).status).toBe(200);
    expect((await pass()).candidates).toBe(0);
    clock.advance(MINUTE);
    return { w, serverRule, supplierId, serviceId };
  }

  it('waits for staff after the sync adopts the service, even under a rule edited after the price was set; approving writes the figure staff saw', async () => {
    const { w, serverRule, supplierId, serviceId } = await followerOfTheSupplier();
    const before = (await followOf(serviceId))!;

    const synced = await sync().run(supplierId, { audit: false });

    expect(synced).toMatchObject({ ok: true, result: { adopted: 1 } });
    const adopted = (await db.select().from(s.services).where(eq(s.services.id, serviceId)))[0]!;
    expect(adopted.type).toBe('server');
    // The sync moved the time in its own transaction; nothing else of the follow row changed, and the price is the one it was.
    const row = (await followOf(serviceId))!;
    expect(row.appliedAt).toEqual(clock.now());
    expect(row.appliedAt).not.toEqual(before.appliedAt);
    expect(row).toMatchObject({ ruleId: w.ruleId, appliedPrice: '13.9900', appliedCost: '10.0000' });
    expect(await retailOf(w, serviceId)).toBe('13.9900');

    clock.advance(MINUTE);
    expect(await pass()).toMatchObject({ proposed: 1, followed: 0 });
    expect(await retailOf(w, serviceId)).toBe('13.9900');
    expect(await changes(serviceId)).toEqual([
      expect.objectContaining({
        kind: 'proposed',
        reason: 'rule_changed',
        ruleId: serverRule.id,
        oldPrice: '13.9900',
        newPrice: '16.0000',
      }),
    ]);
    expect(await auditsOf('changed retail price of')).toEqual([]);

    const [proposal] = await changes(serviceId);
    expect((await resolve([proposal!.id], 'apply')).body).toEqual({ applied: 1, kept: 0, skipped: [] });
    expect(await retailOf(w, serviceId)).toBe('16.0000');
    expect(await followOf(serviceId)).toMatchObject({ ruleId: serverRule.id, appliedPrice: '16.0000' });
    expect((await pass()).candidates).toBe(0);
  });

  it('applies at once when staff edit the rule after the sync moved the service', async () => {
    const { w, serverRule, supplierId, serviceId } = await followerOfTheSupplier();
    await sync().run(supplierId, { audit: false });
    clock.advance(MINUTE);
    expect((await admin.patch(`/admin/retail-price-rules/${serverRule.id}`, { percent: '70' })).status).toBe(200);

    expect(await pass()).toMatchObject({ followed: 1, proposed: 0 });

    expect(await retailOf(w, serviceId)).toBe('17.0000');
    expect((await changes(serviceId))[0]).toMatchObject({ kind: 'followed', reason: 'rule_changed' });
  });

  it('leaves the follow row of a service the sync does not adopt as it was', async () => {
    const { supplierId, serviceId } = await followerOfTheSupplier();
    // Not adoptable: the supplier's service has no main box of its own, so the sync only refreshes its price.
    fakeSupplier.services = [{ ...SERIAL_SERVICE, custom: {} }];
    const before = (await followOf(serviceId))!.appliedAt;

    expect(await sync().run(supplierId, { audit: false })).toMatchObject({ ok: true, result: { adopted: 0 } });

    expect((await db.select().from(s.services).where(eq(s.services.id, serviceId)))[0]!.type).toBe('imei');
    expect((await followOf(serviceId))!.appliedAt).toEqual(before);
  });
});

describe('a proposal', () => {
  it('opens for a jump up and for a jump down, leaves the price and the follow row, and writes no version', async () => {
    const w = await world();
    const up = await follower(w);
    const down = await follower(w);
    const listingId = await listingOf(up.id);
    await syncCost(up, '20.0000');
    await syncCost(down, '5.0000');
    await db.update(s.services).set({ cost: '5.0000' }).where(eq(s.services.id, down.id));
    await recomputeEffectiveCost(db, [down.id]);
    clock.advance(MINUTE);
    const version = await catalogVersionOf(t);
    expect(await pass()).toMatchObject({ proposed: 2, followed: 0 });
    expect(await catalogVersionOf(t)).toBe(version);
    expect(await retailOf(w, up.id)).toBe('13.9900');
    expect(await retailOf(w, down.id)).toBe('13.9900');
    expect((await changes(up.id))[0]).toMatchObject({
      kind: 'proposed',
      reason: 'cost_jump',
      oldPrice: '13.9900',
      newPrice: '26.9900',
      oldCost: '10.0000',
      newCost: '20.0000',
      resolvedAt: null,
    });
    expect((await changes(down.id))[0]).toMatchObject({ newPrice: '6.9900', newCost: '5.0000' });
    expect(await followOf(up.id)).toMatchObject({ appliedPrice: '13.9900', appliedCost: '10.0000' });
    expect((await auditsOf('proposed retail price of'))[0]).toMatchObject({
      actorType: 'system',
      entityId: up.id,
      after: { retailPrice: '26.9900', cost: '20.0000', reason: 'cost_jump', ruleId: w.ruleId },
    });
    expect(await listed(listingId)).toMatchObject({ retailPriceWaiting: true, retailPriceSource: 'rule' });
  });

  it('is sold at the floor meanwhile: the shop never charges under the new cost plus the minimum profit', async () => {
    const store = await storefrontWorld(db);
    const { att } = store;
    await createRule(IMEI_30);
    const staffPrice = await admin.patch(`/admin/service-listings/${att.listingId}`, { retailPricing: 'rule' });
    expect(staffPrice.body).toMatchObject({ retailPrice: '19.9900', retailPriceSource: 'rule' });
    const page = async () =>
      json(
        await t.app.inject({ method: 'GET', url: `/store/v1/services/${att.slug}`, remoteAddress: freshClientIp() }),
      );
    expect((await page()).price.net).toBe('19.9900');

    await db
      .update(s.services)
      .set({ cost: '40.0000', effectiveCost: '40.0000' })
      .where(eq(s.services.id, att.serviceId));
    expect((await pass()).proposed).toBe(1);
    expect((await changes(att.serviceId))[0]).toMatchObject({ newPrice: '52.9900', oldPrice: '19.9900' });
    // The stored 19.99 stays; the floor is 40.00 + 0.81.
    expect((await page()).price.net).toBe('40.8100');
  });

  it('is not written again by a pass that finds the same figures, and keeps notified_at when it is', async () => {
    await seedDefaultTemplates(db);
    const w = await world();
    const { service, proposal } = await waitingProposal(w);
    const [notified] = await db.select().from(s.retailPriceChanges).where(eq(s.retailPriceChanges.id, proposal.id));
    expect(notified!.notifiedAt).toEqual(clock.now());
    const stamp = notified!.notifiedAt;

    clock.advance(HOUR);
    expect(await pass()).toMatchObject({ candidates: 0, proposed: 0, rewritten: 0, notified: false });
    const [same] = await changes(service.id);
    expect(same!.updatedAt).toEqual(notified!.updatedAt);

    await syncCost(service, '21.0000');
    expect((await pass()).rewritten).toBe(1);
    const rows = await changes(service.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: proposal.id, newPrice: '27.9900', newCost: '21.0000' });
    expect(rows[0]!.notifiedAt).toEqual(stamp);
    expect(await auditsOf('proposed retail price of')).toHaveLength(2);
    // A rewrite does not announce the proposal again.
    expect(await notificationRows(db)).toHaveLength(2);
  });

  it('closes by itself when the cost comes back: inside the limit the price follows, at the old cost nothing is written', async () => {
    const w = await world();
    const inside = await waitingProposal(w);
    const back = await waitingProposal(w);
    await syncCost(inside.service, '11.0000');
    await syncCost(back.service, '10.0000');
    expect(await pass()).toMatchObject({ followed: 1, settled: 1 });
    expect(await retailOf(w, inside.service.id)).toBe('14.9900');
    expect(await retailOf(w, back.service.id)).toBe('13.9900');
    const [closed, followed] = await changes(inside.service.id);
    expect(closed).toMatchObject({ resolution: 'superseded', resolvedBy: null });
    expect(closed!.resolvedAt).toEqual(clock.now());
    expect(followed).toMatchObject({ kind: 'followed', reason: 'cost_changed', oldCost: '10.0000' });
    expect((await changes(back.service.id)).map((row) => row.resolution)).toEqual(['superseded']);
    expect(await pass()).toMatchObject({ candidates: 0 });
  });

  it('closes when a person types a price, on the listing or on the group price page', async () => {
    const w = await world();
    const onListing = await waitingProposal(w);
    const onPage = await waitingProposal(w);
    const listingId = await listingOf(onListing.service.id);
    const typed = await admin.patch(`/admin/service-listings/${listingId}`, { retailPrice: '40.0000' });
    expect(typed.body).toMatchObject({ retailPriceSource: 'manual', retailPriceWaiting: false });
    await admin.put(`/admin/services/${onPage.service.id}/group-prices`, {
      prices: [{ groupId: w.retail, price: '41.0000' }],
    });
    for (const { service } of [onListing, onPage]) {
      expect((await changes(service.id))[0]).toMatchObject({ resolution: 'superseded', resolvedBy: null });
      expect(await followOf(service.id)).toBeUndefined();
    }
  });

  it('stays when the group price page re-sends the same retail price', async () => {
    const w = await world();
    const { service } = await waitingProposal(w);
    await admin.put(`/admin/services/${service.id}/group-prices`, {
      prices: [{ groupId: w.retail, price: '13.9900' }],
    });
    expect((await changes(service.id))[0]).toMatchObject({ resolvedAt: null });
    expect(await followOf(service.id)).toBeDefined();
  });

  it('closes when staff ask for the rule price of now on the listing', async () => {
    const w = await world();
    const { service } = await waitingProposal(w);
    const listingId = await listingOf(service.id);
    const res = await admin.patch(`/admin/service-listings/${listingId}`, { retailPricing: 'rule' });
    expect(res.body).toMatchObject({ retailPrice: '26.9900', retailPriceWaiting: false });
    expect((await changes(service.id))[0]).toMatchObject({ resolution: 'superseded' });
  });

  it('with no rule left stays open, and apply answers no_rule', async () => {
    const w = await world();
    const { service, proposal } = await waitingProposal(w);
    expect((await admin.delete(`/admin/retail-price-rules/${w.ruleId}`)).status).toBe(204);
    expect((await pass()).candidates).toBe(0);
    expect((await changes(service.id))[0]).toMatchObject({ resolvedAt: null });
    expect((await resolve([proposal.id], 'apply')).body).toEqual({
      applied: 0,
      kept: 0,
      skipped: [{ id: proposal.id, reason: 'no_rule' }],
    });
    expect(await retailOf(w, service.id)).toBe('13.9900');
  });
});

describe('POST /admin/retail-price-changes/resolve', () => {
  it('apply writes the figure staff saw, whatever the size, closes the proposal and audits it', async () => {
    const w = await world();
    const { service, proposal } = await waitingProposal(w);
    clock.advance(MINUTE);
    const version = await catalogVersionOf(t);
    const res = await resolve([proposal.id], 'apply');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ applied: 1, kept: 0, skipped: [] });
    expect(await retailOf(w, service.id)).toBe('26.9900');
    expect(await followOf(service.id)).toMatchObject({
      ruleId: w.ruleId,
      appliedPrice: '26.9900',
      appliedCost: '20.0000',
    });
    expect((await followOf(service.id))!.appliedAt).toEqual(clock.now());
    const [closed] = await changes(service.id);
    expect(closed).toMatchObject({ resolution: 'applied', resolvedBy: admin.staffId });
    expect(closed!.resolvedAt).toEqual(clock.now());
    expect((await auditsOf('approved retail price of'))[0]).toMatchObject({
      actorType: 'staff',
      actorId: admin.staffId,
      entityType: 'service',
      entityId: service.id,
      before: { retailPrice: '13.9900', cost: '10.0000' },
      after: { retailPrice: '26.9900', cost: '20.0000', ruleId: w.ruleId, proposalId: proposal.id },
    });
    expect(await catalogVersionOf(t)).not.toBe(version);
    expect(await pass()).toMatchObject({ candidates: 0, followed: 0 });
    expect(await retailOf(w, service.id)).toBe('26.9900');
  });

  it('writes nothing when the figure moved: the proposal shows the new one, and a second apply writes it', async () => {
    const w = await world();
    const { service, proposal } = await waitingProposal(w);
    await syncCost(service, '21.0000');
    expect((await resolve([proposal.id], 'apply')).body).toEqual({
      applied: 0,
      kept: 0,
      skipped: [{ id: proposal.id, reason: 'changed' }],
    });
    expect(await retailOf(w, service.id)).toBe('13.9900');
    expect(await followOf(service.id)).toMatchObject({ appliedPrice: '13.9900', appliedCost: '10.0000' });
    expect((await changes(service.id))[0]).toMatchObject({
      id: proposal.id,
      newPrice: '27.9900',
      newCost: '21.0000',
      resolvedAt: null,
    });
    expect((await resolve([proposal.id], 'apply')).body.applied).toBe(1);
    expect(await retailOf(w, service.id)).toBe('27.9900');
  });

  it('shows the figure the pass would write itself, and keeps the proposal until it does', async () => {
    const w = await world();
    const { service, proposal } = await waitingProposal(w);
    await syncCost(service, '11.0000');
    expect((await resolve([proposal.id], 'apply')).body.skipped).toEqual([{ id: proposal.id, reason: 'changed' }]);
    expect((await changes(service.id))[0]).toMatchObject({
      reason: 'cost_changed',
      newPrice: '14.9900',
      newCost: '11.0000',
      resolvedAt: null,
    });
    expect(await retailOf(w, service.id)).toBe('13.9900');
    expect((await pass()).followed).toBe(1);
    expect(await retailOf(w, service.id)).toBe('14.9900');
  });

  it('refuses the figure of the list when the pass rewrote the proposal since: no price moves, and the new figure can be approved', async () => {
    const w = await world();
    const { service, proposal } = await waitingProposal(w);
    const onScreen = (await admin.get('/admin/retail-price-changes?waiting=true')).body as Array<{
      id: number;
      newPrice: string | null;
    }>;
    expect(onScreen.map((row) => [row.id, row.newPrice])).toEqual([[proposal.id, '26.9900']]);

    await syncCost(service, '200.0000');
    expect((await pass()).rewritten).toBe(1);
    clock.advance(MINUTE);
    const version = await catalogVersionOf(t);

    const res = await admin.post(RESOLVE, {
      ids: [proposal.id],
      action: 'apply',
      seen: onScreen.map(({ id, newPrice }) => ({ id, newPrice })),
    });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ applied: 0, kept: 0, skipped: [{ id: proposal.id, reason: 'changed' }] });
    expect(await retailOf(w, service.id)).toBe('13.9900');
    expect(await followOf(service.id)).toMatchObject({ appliedPrice: '13.9900', appliedCost: '10.0000' });
    expect(await changes(service.id)).toEqual([
      expect.objectContaining({ id: proposal.id, newPrice: '260.9900', newCost: '200.0000', resolvedAt: null }),
    ]);
    expect(await auditsOf('approved retail price of')).toEqual([]);
    // The proposal already shows the figure of now: the refusal adds no rewrite to the pass's.
    expect(await auditsOf('proposed retail price of')).toHaveLength(2);
    expect(await catalogVersionOf(t)).toBe(version);

    expect((await resolve([proposal.id], 'apply')).body).toEqual({ applied: 1, kept: 0, skipped: [] });
    expect(await retailOf(w, service.id)).toBe('260.9900');
  });

  it('shows the figure of now when the list is behind and the proposal is too', async () => {
    const w = await world();
    const { service, proposal } = await waitingProposal(w);
    await syncCost(service, '30.0000');
    await pass();
    await syncCost(service, '40.0000');
    const res = await admin.post(RESOLVE, {
      ids: [proposal.id],
      action: 'apply',
      seen: [{ id: proposal.id, newPrice: '26.9900' }],
    });
    expect(res.body.skipped).toEqual([{ id: proposal.id, reason: 'changed' }]);
    expect(await retailOf(w, service.id)).toBe('13.9900');
    expect((await changes(service.id))[0]).toMatchObject({ newPrice: '52.9900', newCost: '40.0000', resolvedAt: null });
  });

  it('does not write a figure the rule gives again when the list showed another one', async () => {
    const w = await world();
    const { service, proposal } = await waitingProposal(w);
    await syncCost(service, '30.0000');
    await pass();
    await syncCost(service, '20.0000');
    // The list and the rule say 26.99, the row says 39.99: staff are shown the row's correction first.
    const res = await admin.post(RESOLVE, {
      ids: [proposal.id],
      action: 'apply',
      seen: [{ id: proposal.id, newPrice: '26.9900' }],
    });
    expect(res.body.skipped).toEqual([{ id: proposal.id, reason: 'changed' }]);
    expect(await retailOf(w, service.id)).toBe('13.9900');
    expect((await changes(service.id))[0]).toMatchObject({ newPrice: '26.9900', resolvedAt: null });
    expect((await resolve([proposal.id], 'apply')).body.applied).toBe(1);
    expect(await retailOf(w, service.id)).toBe('26.9900');
  });

  it('does not take "no figure" on the list for the figure a proposal shows now', async () => {
    const w = await world();
    const service = await follower(w);
    await db.update(s.services).set({ cost: '0', effectiveCost: '0' }).where(eq(s.services.id, service.id));
    await pass();
    const [proposal] = await changes(service.id);
    expect(proposal).toMatchObject({ reason: 'no_cost', newPrice: null });
    await db.update(s.services).set({ effectiveCost: '20.0000' }).where(eq(s.services.id, service.id));
    expect((await pass()).rewritten).toBe(1);
    const res = await admin.post(RESOLVE, {
      ids: [proposal!.id],
      action: 'apply',
      seen: [{ id: proposal!.id, newPrice: null }],
    });
    expect(res.body.skipped).toEqual([{ id: proposal!.id, reason: 'changed' }]);
    expect(await retailOf(w, service.id)).toBe('13.9900');
    expect((await changes(service.id))[0]).toMatchObject({ reason: 'cost_jump', newPrice: '26.9900' });
  });

  it('gives a proposal the reason of the move it now shows, not the one it opened with', async () => {
    const w = await world();
    const service = await follower(w);
    await db.update(s.services).set({ cost: '0', effectiveCost: '0' }).where(eq(s.services.id, service.id));
    await pass();
    const [proposal] = await changes(service.id);
    await db.update(s.services).set({ effectiveCost: '11.0000' }).where(eq(s.services.id, service.id));
    expect((await resolve([proposal!.id], 'apply')).body.skipped).toEqual([{ id: proposal!.id, reason: 'changed' }]);
    expect((await changes(service.id))[0]).toMatchObject({
      reason: 'cost_changed',
      newPrice: '14.9900',
      newCost: '11.0000',
      resolvedAt: null,
    });
    expect(await retailOf(w, service.id)).toBe('13.9900');
  });

  it('answers for a service no rule can price: apply says no_cost, keep still works, and the other ids go on', async () => {
    const w = await world();
    const absurd = await waitingProposal(w);
    const fine = await waitingProposal(w);
    const other = await waitingProposal(w);
    await db
      .update(s.services)
      .set({ effectiveCost: '99999999999999.0000' })
      .where(eq(s.services.id, absurd.service.id));

    const applied = await resolve([absurd.proposal.id, fine.proposal.id], 'apply');
    expect(applied.status).toBe(200);
    expect(applied.body).toEqual({ applied: 1, kept: 0, skipped: [{ id: absurd.proposal.id, reason: 'no_cost' }] });
    expect(await retailOf(w, absurd.service.id)).toBe('13.9900');
    expect(await retailOf(w, fine.service.id)).toBe('26.9900');
    expect((await changes(absurd.service.id))[0]).toMatchObject({ newPrice: '26.9900', resolvedAt: null });

    const kept = await resolve([absurd.proposal.id, other.proposal.id], 'keep');
    expect(kept.status).toBe(200);
    expect(kept.body).toEqual({ applied: 0, kept: 2, skipped: [] });
    expect(await followOf(absurd.service.id)).toBeUndefined();
    expect(await retailOf(w, absurd.service.id)).toBe('13.9900');
    expect((await changes(absurd.service.id))[0]).toMatchObject({ resolution: 'kept', resolvedBy: admin.staffId });
    const audit = (await auditsOf('kept retail price of')).find((row) => row.entityId === absurd.service.id);
    expect(audit).toMatchObject({ after: { retailPrice: '13.9900', proposalId: absurd.proposal.id } });
  });

  it('closes a proposal the rule has caught up with, and says it no longer waits', async () => {
    const w = await world();
    const { service, proposal } = await waitingProposal(w);
    await syncCost(service, '10.0000');
    expect((await resolve([proposal.id], 'apply')).body.skipped).toEqual([{ id: proposal.id, reason: 'not_waiting' }]);
    expect((await changes(service.id))[0]).toMatchObject({ resolution: 'superseded', resolvedBy: null });
  });

  it('detaches instead of writing over a price changed another way', async () => {
    const w = await world();
    const { service, proposal } = await waitingProposal(w);
    await db
      .update(s.serviceGroupPrices)
      .set({ price: '50.0000' })
      .where(eq(s.serviceGroupPrices.serviceId, service.id));
    expect((await resolve([proposal.id], 'apply')).body.skipped).toEqual([{ id: proposal.id, reason: 'not_waiting' }]);
    expect(await retailOf(w, service.id)).toBe('50.0000');
    expect((await changes(service.id)).map((row) => row.kind)).toEqual(['proposed', 'detached']);
  });

  it('keep makes the price a typed one: the follow row goes and later passes leave it alone', async () => {
    const w = await world();
    const { service, proposal } = await waitingProposal(w);
    const listingId = await listingOf(service.id);
    expect((await resolve([proposal.id], 'keep')).body).toEqual({ applied: 0, kept: 1, skipped: [] });
    expect(await followOf(service.id)).toBeUndefined();
    expect((await changes(service.id))[0]).toMatchObject({ resolution: 'kept', resolvedBy: admin.staffId });
    expect((await auditsOf('kept retail price of'))[0]).toMatchObject({
      actorId: admin.staffId,
      entityId: service.id,
      after: { retailPrice: '13.9900', proposalId: proposal.id },
    });
    await syncCost(service, '30.0000');
    expect((await pass()).checked).toBe(0);
    expect(await retailOf(w, service.id)).toBe('13.9900');
    expect(await listed(listingId)).toMatchObject({ retailPriceSource: 'manual', retailPriceWaiting: false });
  });

  it('closes the proposal of a service archived meanwhile, whatever staff answer', async () => {
    const w = await world();
    const applied = await waitingProposal(w);
    const kept = await waitingProposal(w);
    await db
      .update(s.services)
      .set({ archivedAt: clock.now(), status: 'disabled' })
      .where(inArray(s.services.id, [applied.service.id, kept.service.id]));
    expect((await resolve([applied.proposal.id], 'apply')).body).toEqual({
      applied: 0,
      kept: 0,
      skipped: [{ id: applied.proposal.id, reason: 'not_waiting' }],
    });
    expect((await changes(applied.service.id))[0]).toMatchObject({ resolution: 'superseded', resolvedBy: null });
    expect(await followOf(applied.service.id)).toBeUndefined();
    expect((await resolve([kept.proposal.id], 'keep')).body.kept).toBe(1);
    expect((await changes(kept.service.id))[0]).toMatchObject({ resolution: 'kept', resolvedBy: admin.staffId });
    expect(await followOf(kept.service.id)).toBeUndefined();
    expect(await retailOf(w, kept.service.id)).toBe('13.9900');
  });

  it('answers not_waiting for an unknown id, a resolved proposal and a row that is no proposal, with one summary audit row', async () => {
    const w = await world();
    const done = await follower(w);
    await syncCost(done, '11.0000');
    await pass();
    const [followed] = await changes(done.id);
    const kept = await waitingProposal(w);
    await resolve([kept.proposal.id], 'keep');

    const before = (await auditsOf('resolved no retail price change')).length;
    const ids = [followed!.id, kept.proposal.id, 999_999];
    const res = await resolve([...ids, 999_999], 'apply');
    expect(res.body).toEqual({
      applied: 0,
      kept: 0,
      skipped: ids.map((id) => ({ id, reason: 'not_waiting' })),
    });
    expect(await auditsOf('resolved no retail price change')).toHaveLength(before + 1);
  });

  it('resolves each id on its own: one skipped id leaves the others applied', async () => {
    const w = await world();
    const first = await waitingProposal(w);
    const moved = await waitingProposal(w);
    await syncCost(moved.service, '21.0000');
    const res = await resolve([first.proposal.id, moved.proposal.id], 'apply');
    expect(res.body).toEqual({ applied: 1, kept: 0, skipped: [{ id: moved.proposal.id, reason: 'changed' }] });
    expect(await auditsOf('approved retail price of')).toHaveLength(1);
    expect(await auditsOf('resolved no retail price change')).toHaveLength(0);
  });

  it('runs after a parallel pass or a second answer without writing twice', async () => {
    const w = await world();
    const { service, proposal } = await waitingProposal(w);
    const answers = await Promise.all([resolve([proposal.id], 'apply'), resolve([proposal.id], 'apply'), pass()]);
    expect([answers[0].body.applied, answers[1].body.applied].sort()).toEqual([0, 1]);
    expect(await auditsOf('approved retail price of')).toHaveLength(1);
    expect(await retailOf(w, service.id)).toBe('26.9900');
  });

  it('needs pricing:update, and refuses an empty list, too many ids and an unknown action', async () => {
    const w = await world();
    const { proposal } = await waitingProposal(w);
    const reader = await adminWith(t, ['pricing:read']);
    expect((await resolve([proposal.id], 'apply', reader)).status).toBe(403);
    expect((await reader.get('/admin/retail-price-changes')).status).toBe(200);
    const outsider = await adminWith(t, ['storefront:read']);
    expect((await outsider.get('/admin/retail-price-changes')).status).toBe(403);
    const ids = [proposal.id];
    const seen = [{ id: proposal.id, newPrice: '26.9900' }];
    const refused: Array<[string, unknown]> = [
      ['ids', { ids: [], action: 'apply', seen: [] }],
      ['ids', { ids: Array.from({ length: 201 }, (_, index) => index + 1), action: 'keep' }],
      ['action', { ids, action: 'approve' }],
      ['extra', { ids, action: 'apply', seen, extra: true }],
      // An approval names what the person saw, for every id and only once; keeping a price depends on no figure.
      ['seen', { ids, action: 'apply' }],
      ['seen', { ids, action: 'apply', seen: [] }],
      ['seen', { ids, action: 'apply', seen: [{ id: proposal.id + 1, newPrice: '26.9900' }] }],
      ['seen', { ids, action: 'apply', seen: [...seen, ...seen] }],
      ['seen', { ids, action: 'apply', seen: [...seen, { id: proposal.id + 1, newPrice: null }] }],
      ['seen', { ids: [proposal.id, proposal.id + 1], action: 'apply', seen }],
      ['seen.0.newPrice', { ids, action: 'apply', seen: [{ id: proposal.id, newPrice: '26.99' }] }],
      ['seen.0.newPrice', { ids, action: 'apply', seen: [{ id: proposal.id }] }],
      ['seen', { ids, action: 'keep', seen }],
    ];
    for (const [field, body] of refused) {
      const res = await admin.post(RESOLVE, body);
      expect(res.status).toBe(422);
      expect(res.body.errors.map((error: { field: string }) => error.field)).toEqual([field]);
    }
    expect((await changes(proposal.serviceId))[0]).toMatchObject({ resolvedAt: null, newPrice: '26.9900' });
    expect(await auditsOf('resolved no retail price change')).toEqual([]);
  });

  it('takes an id sent twice with one figure, and a figure for an id no proposal has', async () => {
    const w = await world();
    const { service, proposal } = await waitingProposal(w);
    const res = await admin.post(RESOLVE, {
      ids: [proposal.id, proposal.id, 999_999],
      action: 'apply',
      seen: [
        { id: 999_999, newPrice: null },
        { id: proposal.id, newPrice: '26.9900' },
      ],
    });
    expect(res.body).toEqual({ applied: 1, kept: 0, skipped: [{ id: 999_999, reason: 'not_waiting' }] });
    expect(await retailOf(w, service.id)).toBe('26.9900');
  });
});

describe('keep beside a pass of the follow job (plan 31 section 6.5)', () => {
  it('waits for a pass that is rewriting its proposal, then closes the proposal as the pass left it', async () => {
    const w = await world();
    const { service, proposal } = await waitingProposal(w);
    // The cost moved again: the pass will rewrite the waiting proposal with the new figures.
    await syncCost(service, '30.0000');
    const steps = t.app.get(RetailFollowSteps, { strict: false });
    const rewrite = steps.rewrite.bind(steps);
    let keeping: ReturnType<typeof resolve> | undefined;
    spyOn(steps, 'rewrite').mockImplementation(async (...args: Parameters<RetailFollowSteps['rewrite']>) => {
      // The pass holds the service row: the keep of the same service has to wait for the commit.
      keeping = resolve([proposal.id], 'keep');
      await someoneWaitsForALock();
      return rewrite(...args);
    });

    expect(await pass()).toMatchObject({ rewritten: 1, failed: 0, skipped: 0 });
    mock.restore();

    expect((await keeping!).body).toEqual({ applied: 0, kept: 1, skipped: [] });
    // The price stays as it was and is a typed one now; the one proposal is closed with the figures the pass wrote.
    expect(await retailOf(w, service.id)).toBe('13.9900');
    expect(await followOf(service.id)).toBeUndefined();
    expect(await changes(service.id)).toEqual([
      expect.objectContaining({
        id: proposal.id,
        kind: 'proposed',
        newPrice: '39.9900',
        newCost: '30.0000',
        resolution: 'kept',
        resolvedBy: admin.staffId,
      }),
    ]);
    expect((await auditsOf('kept retail price of'))[0]).toMatchObject({
      entityId: service.id,
      before: { retailPrice: '13.9900', proposedPrice: '39.9900' },
      after: { retailPrice: '13.9900', cost: '30.0000', proposalId: proposal.id },
    });
    expect(await auditsOf('kept retail price of')).toHaveLength(1);
    expect(await pass()).toMatchObject({ candidates: 0 });
    expect(await retailOf(w, service.id)).toBe('13.9900');
  });

  it('is done first when it holds the service: the pass behind it finds no follow row and writes nothing', async () => {
    const w = await world();
    const { service, proposal } = await waitingProposal(w);
    await syncCost(service, '30.0000');
    const retail = t.app.get(RetailPrices, { strict: false });
    const stored = retail.storedPrice.bind(retail);
    let running: ReturnType<typeof pass> | undefined;
    spyOn(retail, 'storedPrice').mockImplementation(async (...args: Parameters<RetailPrices['storedPrice']>) => {
      // The keep holds the service row and has read the price; the pass already took the service as a candidate and waits for it.
      running = pass();
      await someoneWaitsForALock();
      return stored(...args);
    });

    expect((await resolve([proposal.id], 'keep')).body).toEqual({ applied: 0, kept: 1, skipped: [] });
    mock.restore();

    expect(await running!).toMatchObject({
      candidates: 1,
      followed: 0,
      proposed: 0,
      rewritten: 0,
      detached: 0,
      failed: 0,
      skipped: 0,
    });
    expect(await retailOf(w, service.id)).toBe('13.9900');
    expect(await followOf(service.id)).toBeUndefined();
    // The proposal is closed with the figures it had when it was kept, and nothing else was proposed.
    expect(await changes(service.id)).toEqual([
      expect.objectContaining({ id: proposal.id, newPrice: '26.9900', newCost: '20.0000', resolution: 'kept' }),
    ]);
    expect(await auditsOf('kept retail price of')).toHaveLength(1);
    expect(await auditsOf('changed retail price of')).toEqual([]);
  });

  it('two keeps of one proposal at once keep it once, and the second finds nothing waiting', async () => {
    const w = await world();
    const { service, proposal } = await waitingProposal(w);

    const both = await Promise.all([resolve([proposal.id], 'keep'), resolve([proposal.id], 'keep')]);

    expect(both.map((res) => res.status)).toEqual([200, 200]);
    expect(both.map((res) => res.body.kept).sort()).toEqual([0, 1]);
    expect(both.flatMap((res) => res.body.skipped)).toEqual([{ id: proposal.id, reason: 'not_waiting' }]);
    expect(await auditsOf('kept retail price of')).toHaveLength(1);
    expect(await retailOf(w, service.id)).toBe('13.9900');
  });
});

describe('GET /admin/retail-price-changes', () => {
  it('lists the changes newest first with the service and the rule, also a rule deleted since', async () => {
    const w = await world();
    const moved = await follower(w);
    await syncCost(moved, '11.0000');
    const { service, proposal } = await waitingProposal(w);
    await pass();
    expect((await admin.delete(`/admin/retail-price-rules/${w.ruleId}`)).status).toBe(204);

    const res = await admin.get('/admin/retail-price-changes');
    expect(res.status).toBe(200);
    expect(res.total).toBe(2);
    const [newest, oldest] = res.body as Array<Record<string, unknown>>;
    expect(oldest).toMatchObject({ kind: 'followed', service: { id: moved.id }, waiting: false });
    expect(newest).toEqual({
      id: proposal.id,
      service: { id: service.id, name: expect.any(String), code: expect.any(String) },
      kind: 'proposed',
      reason: 'cost_jump',
      oldPrice: '13.9900',
      newPrice: '26.9900',
      oldCost: '10.0000',
      newCost: '20.0000',
      rule: { id: w.ruleId, label: 'IMEI +30%, ends in .99' },
      waiting: true,
      resolution: null,
      resolvedAt: null,
      resolvedBy: null,
      createdAt: clock.now().toISOString(),
    });
  });

  it('filters by kind, waiting and service, sorts, and counts the waiting ones for the tab', async () => {
    const w = await world();
    const moved = await follower(w);
    await syncCost(moved, '11.0000');
    const { service, proposal } = await waitingProposal(w);
    await pass();
    const ids = async (query: string) => {
      const res = await admin.get(`/admin/retail-price-changes?${query}`);
      expect(res.status).toBe(200);
      return { total: res.total, ids: (res.body as Array<{ id: number }>).map((row) => row.id) };
    };
    expect(await ids('waiting=true')).toEqual({ total: 1, ids: [proposal.id] });
    expect((await ids('waiting=false')).total).toBe(1);
    expect(await ids('kind=proposed')).toEqual({ total: 1, ids: [proposal.id] });
    expect(await ids(`serviceId=${service.id}`)).toEqual({ total: 1, ids: [proposal.id] });
    expect((await ids('_sort=id&_order=desc')).ids[0]).toBe(proposal.id);
    expect((await ids('_sort=id&_order=asc')).ids[1]).toBe(proposal.id);
    expect((await ids('_sort=createdAt&_order=desc')).total).toBe(2);
    await resolve([proposal.id], 'keep');
    expect(await ids('waiting=true')).toEqual({ total: 0, ids: [] });
    expect((await admin.get('/admin/retail-price-changes?nope=1')).status).toBe(422);
  });
});

describe('the pass beside everything else', () => {
  it('twice: the second writes nothing and does not move the version', async () => {
    const w = await world();
    const service = await follower(w);
    await syncCost(service, '12.0000');
    expect((await pass()).followed).toBe(1);
    const version = await catalogVersionOf(t);
    const audits = (await db.select().from(s.auditLogs)).length;
    expect(await pass()).toMatchObject({ candidates: 0, followed: 0 });
    expect(await catalogVersionOf(t)).toBe(version);
    expect(await db.select().from(s.auditLogs)).toHaveLength(audits);
    expect(await changes()).toHaveLength(1);
  });

  it('asks for one more pass only when it wrote a price, and that one ends the chain', async () => {
    const w = await world();
    const service = await follower(w);
    await syncCost(service, '12.0000');
    const bump = spyOn(t.app.get(CatalogPriceVersion, { strict: false }), 'bump');
    await pass();
    expect(bump).toHaveBeenCalledTimes(1);
    await pass();
    expect(bump).toHaveBeenCalledTimes(1);
  });

  it('walks every page, 200 at a time', async () => {
    const w = await world();
    await follower(w);
    const followers = await db
      .insert(s.services)
      .values(
        Array.from({ length: RETAIL_FOLLOW_PAGE + 5 }, (_, index) => ({
          categoryId: w.categoryId,
          type: 'imei' as const,
          name: `Copy ${index}`,
          code: `COPY-${index}`,
          fulfillment: 'auto' as const,
          basePrice: '5.0000',
          cost: '10.0000',
          effectiveCost: '10.0000',
          slaMinutes: 60,
        })),
      )
      .returning({ id: s.services.id });
    const price = (await db.select().from(s.retailPriceFollows))[0]!;
    await db
      .insert(s.serviceGroupPrices)
      .values(followers.map(({ id }) => ({ serviceId: id, groupId: w.retail, price: '13.9900' })));
    await db.insert(s.retailPriceFollows).values(
      followers.map(({ id }) => ({
        serviceId: id,
        ruleId: price.ruleId,
        appliedPrice: '13.9900',
        appliedCost: '10.0000',
        appliedAt: clock.now(),
      })),
    );
    await db.update(s.services).set({ effectiveCost: '12.0000' });
    const result = await pass();
    expect(result).toMatchObject({ checked: RETAIL_FOLLOW_PAGE + 6, followed: RETAIL_FOLLOW_PAGE + 6, failed: 0 });
    expect(await db.select().from(s.retailPriceChanges)).toHaveLength(RETAIL_FOLLOW_PAGE + 6);
  });

  it('two passes side by side: one change row per service', async () => {
    const w = await world();
    const services = [await follower(w), await follower(w), await follower(w)];
    for (const service of services) await syncCost(service, '12.0000');
    const [one, two] = await Promise.all([pass(), pass()]);
    expect(one.followed + two.followed).toBe(3);
    expect(await changes()).toHaveLength(3);
    for (const service of services) expect(await retailOf(w, service.id)).toBe('15.9900');
    expect(await db.select().from(s.retailPriceFollows)).toHaveLength(3);
  });

  it('a price typed while the pass holds the service is the price that stands, with no follow row left', async () => {
    const w = await world();
    const service = await follower(w);
    const listingId = await listingOf(service.id);
    await syncCost(service, '12.0000');
    const retail = t.app.get(RetailPrices, { strict: false });
    const write = retail.set.bind(retail);
    let typed: ReturnType<typeof admin.patch> | undefined;
    spyOn(retail, 'set').mockImplementation(async (...args: Parameters<RetailPrices['set']>) => {
      // The pass holds the service row: the staff request starts now and waits for it.
      typed = admin.patch(`/admin/service-listings/${listingId}`, { retailPrice: '30.0000' });
      await someoneWaitsForALock();
      return write(...args);
    });
    expect((await pass()).followed).toBe(1);
    mock.restore();
    expect((await typed!).status).toBe(200);
    expect(await retailOf(w, service.id)).toBe('30.0000');
    expect(await followOf(service.id)).toBeUndefined();
    expect((await pass()).checked).toBe(0);
    expect(await retailOf(w, service.id)).toBe('30.0000');
  });

  it('finds no follow row after a price typed just before it, and writes nothing', async () => {
    const w = await world();
    const service = await follower(w);
    const listingId = await listingOf(service.id);
    await syncCost(service, '12.0000');
    const results = await Promise.all([
      pass(),
      admin.patch(`/admin/service-listings/${listingId}`, { retailPrice: '30.0000' }),
    ]);
    expect(results[1].status).toBe(200);
    expect(await retailOf(w, service.id)).toBe('30.0000');
    expect(await followOf(service.id)).toBeUndefined();
  });

  it('never waits for a rule edit or delete, and the next pass prices by what is left', async () => {
    const w = await world();
    const general = await createRule({ scope: 'global', percent: '50', rounding: 'cent' });
    const service = await follower(w);
    await syncCost(service, '11.0000');
    clock.advance(MINUTE);
    const retail = t.app.get(RetailPrices, { strict: false });
    const write = retail.set.bind(retail);
    const answers: number[] = [];
    spyOn(retail, 'set').mockImplementation(async (...args: Parameters<RetailPrices['set']>) => {
      // The pass has read the rule and holds the service; the rule row is locked only by foreign key checks from here on.
      const written = await write(...args);
      // `FOR KEY SHARE` is the one row lock that lets this through: anything stronger would refuse it at once.
      await db.execute(sql`select id from retail_price_rules where id = ${w.ruleId} for no key update nowait`);
      answers.push((await admin.patch(`/admin/retail-price-rules/${w.ruleId}`, { fixed: '1.0000' })).status);
      answers.push((await admin.delete(`/admin/retail-price-rules/${w.ruleId}`)).status);
      return written;
    });
    expect(await pass()).toMatchObject({ followed: 1, failed: 0, skipped: 0 });
    mock.restore();
    expect(answers).toEqual([200, 204]);
    expect(await retailOf(w, service.id)).toBe('14.9900');

    expect((await pass()).followed).toBe(1);
    expect(await followOf(service.id)).toMatchObject({ ruleId: general.id, appliedPrice: '16.5000' });
    expect((await changes(service.id))[1]).toMatchObject({ reason: 'rule_changed', ruleId: general.id });
  });

  it('counts a service whose transaction lost a race as skipped, and the next pass takes it', async () => {
    const w = await world();
    const lost = await follower(w);
    const other = await follower(w);
    await syncCost(lost, '11.0000');
    await syncCost(other, '11.0000');
    const retail = t.app.get(RetailPrices, { strict: false });
    const write = retail.set.bind(retail);
    spyOn(retail, 'set').mockImplementation(async (...args: Parameters<RetailPrices['set']>) => {
      if (args[1] === lost.id) throw Object.assign(new Error('deadlock detected'), { code: '40P01' });
      return write(...args);
    });
    expect(await pass()).toMatchObject({ followed: 1, skipped: 1, failed: 0 });
    mock.restore();
    expect(await pass()).toMatchObject({ followed: 1, skipped: 0 });
    expect(await retailOf(w, lost.id)).toBe('14.9900');
  });

  it('survives one service that cannot be priced: the others follow and the failure is counted', async () => {
    const w = await world();
    const absurd = await follower(w);
    const fine = await follower(w);
    await db.update(s.services).set({ effectiveCost: '99999999999999.0000' }).where(eq(s.services.id, absurd.id));
    await syncCost(fine, '11.0000');
    expect(await pass()).toMatchObject({ followed: 1, failed: 1 });
    expect(await retailOf(w, fine.id)).toBe('14.9900');
    expect(await retailOf(w, absurd.id)).toBe('13.9900');
  });

  it('waits for a supplier sync that holds its services, and prices them by the cost the sync committed', async () => {
    const w = await world();
    const services = [await follower(w), await follower(w), await follower(w)];
    // Committed before the sync: what makes them candidates of the pass, which reads them unlocked first.
    for (const service of services) await syncCost(service, '11.0000');
    const holding = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const sync = t.app.get(DbService).runInTransaction(async ({ tx }) => {
      await tx.execute(sql`select id from suppliers where id = ${services[0]!.supplierId} for update`);
      await tx
        .update(s.supplierServices)
        .set({ credit: '12.0000' })
        .where(
          inArray(
            s.supplierServices.id,
            services.map((service) => service.supplierServiceId),
          ),
        );
      await recomputeEffectiveCost(
        tx,
        services.map((service) => service.id),
      );
      holding.resolve();
      await release.promise;
    });
    let running: ReturnType<typeof pass> | undefined;
    try {
      await holding.promise;
      running = pass();
      await someoneWaitsForALock();
    } finally {
      release.resolve();
      await sync;
    }
    expect(await running).toMatchObject({ followed: 3, failed: 0, skipped: 0 });
    for (const service of services) {
      expect(await retailOf(w, service.id)).toBe('15.9900');
      expect((await followOf(service.id))!.appliedCost).toBe('12.0000');
    }
    expect((await pass()).candidates).toBe(0);
  });

  it('holds up a supplier sync that reaches the service it is pricing, and the next pass follows the new cost', async () => {
    const w = await world();
    const service = await follower(w);
    await syncCost(service, '11.0000');
    const retail = t.app.get(RetailPrices, { strict: false });
    const write = retail.set.bind(retail);
    let sync: Promise<void> | undefined;
    spyOn(retail, 'set').mockImplementation(async (...args: Parameters<RetailPrices['set']>) => {
      // The pass holds the service row: the sync's update of it has to wait for the commit.
      sync = t.app.get(DbService).runInTransaction(({ tx }) => syncCost(service, '12.0000', tx));
      await someoneWaitsForALock();
      return write(...args);
    });
    expect(await pass()).toMatchObject({ followed: 1, failed: 0, skipped: 0 });
    mock.restore();
    await sync;
    // The pass priced by the cost committed when it locked the row.
    expect(await retailOf(w, service.id)).toBe('14.9900');
    expect((await followOf(service.id))!.appliedCost).toBe('11.0000');

    expect(await pass()).toMatchObject({ followed: 1, failed: 0 });
    expect(await retailOf(w, service.id)).toBe('15.9900');
    expect((await followOf(service.id))!.appliedCost).toBe('12.0000');
  });

  describe('against a save of the group price page', () => {
    const saveRetail = (w: World, serviceId: number, price: string) =>
      admin.put(`/admin/services/${serviceId}/group-prices`, { prices: [{ groupId: w.retail, price }] });

    /** Starts a pass while a save holds the service row, with its prices written and not committed; answers what the pass did. */
    async function passBehindSave(w: World, serviceId: number, price: string) {
      const retail = t.app.get(RetailPrices, { strict: false });
      const after = retail.afterGroupReplace.bind(retail);
      let running: ReturnType<typeof pass> | undefined;
      spyOn(retail, 'afterGroupReplace').mockImplementation(
        async (...args: Parameters<RetailPrices['afterGroupReplace']>) => {
          running = pass();
          await someoneWaitsForALock();
          return after(...args);
        },
      );
      const saved = await saveRetail(w, serviceId, price);
      mock.restore();
      expect(saved.status).toBe(200);
      return running!;
    }

    it('a typed price saved first stands: the pass waits, finds no follow row and writes nothing', async () => {
      const w = await world();
      const service = await follower(w);
      await syncCost(service, '12.0000');
      expect(await passBehindSave(w, service.id, '40.0000')).toMatchObject({
        candidates: 1,
        followed: 0,
        detached: 0,
        failed: 0,
        skipped: 0,
      });
      expect(await retailOf(w, service.id)).toBe('40.0000');
      expect(await followOf(service.id)).toBeUndefined();
      expect(await changes(service.id)).toEqual([]);
    });

    it('the same price saved first keeps following: the pass behind it moves the price', async () => {
      const w = await world();
      const service = await follower(w);
      await syncCost(service, '12.0000');
      expect(await passBehindSave(w, service.id, '13.9900')).toMatchObject({ followed: 1, detached: 0, failed: 0 });
      expect(await retailOf(w, service.id)).toBe('15.9900');
      expect(await followOf(service.id)).toMatchObject({ appliedPrice: '15.9900', appliedCost: '12.0000' });
    });

    it('a save that waits for the pass has the last word, also with the price the page showed before the pass', async () => {
      const w = await world();
      for (const typed of ['40.0000', '13.9900']) {
        const service = await follower(w);
        await syncCost(service, '12.0000');
        const retail = t.app.get(RetailPrices, { strict: false });
        const write = retail.set.bind(retail);
        let saving: ReturnType<typeof saveRetail> | undefined;
        spyOn(retail, 'set').mockImplementation(async (...args: Parameters<RetailPrices['set']>) => {
          // The pass holds the service row: the save starts now and waits for it.
          saving = saveRetail(w, service.id, typed);
          await someoneWaitsForALock();
          return write(...args);
        });
        expect(await pass()).toMatchObject({ followed: 1, failed: 0 });
        mock.restore();
        expect((await saving!).status).toBe(200);
        expect(await retailOf(w, service.id)).toBe(typed);
        expect(await followOf(service.id)).toBeUndefined();
        expect((await changes(service.id)).map((row) => row.kind)).toEqual(['followed']);
        expect(await pass()).toMatchObject({ checked: 0, followed: 0 });
        expect(await retailOf(w, service.id)).toBe(typed);
      }
    });
  });

  it('after a publish run beside a sync, every price is the rule price of the new cost', async () => {
    const w = await world();
    const services = [await serviceOf(w), await serviceOf(w), await serviceOf(w)];
    const run = await seedRun(
      t,
      services.map((service) => service.id),
    );
    const runner = t.app.get(PublishRunner, { strict: false });
    const remotes = services.map((service) => service.supplierServiceId);
    const sync = t.app.get(DbService).runInTransaction(async ({ tx }) => {
      await tx.update(s.supplierServices).set({ credit: '11.0000' }).where(inArray(s.supplierServices.id, remotes));
      await recomputeEffectiveCost(
        tx,
        services.map((service) => service.id),
      );
    });
    const [outcome] = await Promise.all([runner.run(run.id), sync]);
    expect(outcome).toBe('succeeded');
    await pass();
    for (const service of services) expect(await retailOf(w, service.id)).toBe('14.9900');
    expect((await pass()).candidates).toBe(0);
  });

  it('leaves an open checkout its amounts through a reprice, and the customer pays them', async () => {
    const store = await b2cWorld(t, db, gateway);
    const { ruleId } = { ruleId: (await createRule(IMEI_30)).id };
    const staffPrice = await admin.patch(`/admin/service-listings/${store.att.listingId}`, { retailPricing: 'rule' });
    expect(staffPrice.body.retailPrice).toBe('19.9900');
    const { token, session } = await openCheckout(t, store, { serviceId: store.att.serviceId });
    const locked = session.amounts;
    expect(locked.usd.net).toBe('19.9900');

    clock.advance(MINUTE);
    await admin.patch(`/admin/retail-price-rules/${ruleId}`, { percent: '100' });
    expect((await pass()).followed).toBe(1);
    expect(
      (
        await db
          .select({ price: s.serviceGroupPrices.price })
          .from(s.serviceGroupPrices)
          .where(eq(s.serviceGroupPrices.serviceId, store.att.serviceId))
      )[0]!.price,
    ).toBe('27.9900');

    const shown = await t.app.inject({
      method: 'GET',
      url: `/store/v1/checkout-sessions/${token}`,
      remoteAddress: freshClientIp(),
    });
    expect(json(shown).amounts).toEqual(locked);
    const paid = await pay(t, token, undefined);
    expect(paid.statusCode).toBe(201);
    expect(json(paid).payment.amount).toBe(locked.display.gross);
    // The next session gets the new price.
    const next = await openCheckout(t, store, { serviceId: store.att.serviceId, email: 'next@mail.example' });
    expect(next.session.amounts.usd.net).toBe('27.9900');
  });
});

describe('the scheduling', () => {
  const jobOfThisMinute = () =>
    t.app
      .get(QueuesService)
      .queue('maintenance')
      .getJob(`retail-follow-${Math.floor(clock.nowMs() / MINUTE)}`);

  it('a rule PATCH through the API asks for a pass a minute later, once for the minute', async () => {
    const w = await world();
    await deleteBullKeys(t.app.get(RedisService).queue, prefix);
    expect(await jobOfThisMinute()).toBeUndefined();
    expect((await admin.patch(`/admin/retail-price-rules/${w.ruleId}`, { percent: '31' })).status).toBe(200);
    const job = await jobOfThisMinute();
    expect(job).toMatchObject({ name: RETAIL_FOLLOW_JOB });
    expect(job!.opts.delay).toBe(RETAIL_FOLLOW_DELAY_MS);
    await admin.patch(`/admin/retail-price-rules/${w.ruleId}`, { percent: '32' });
    expect(await t.app.get(QueuesService).queue('maintenance').getDelayedCount()).toBeLessThanOrEqual(2);
    expect((await jobOfThisMinute())!.id).toBe(job!.id);
  });

  it('every move of the price version asks for one, and a queue that is away does not fail the price change', async () => {
    await t.app.get(CatalogPriceVersion, { strict: false }).bump();
    expect(await jobOfThisMinute()).toMatchObject({ name: RETAIL_FOLLOW_JOB });
    const scheduler = t.app.get(RetailFollowScheduler, { strict: false });
    spyOn(t.app.get(QueuesService), 'add').mockRejectedValueOnce(new Error('queue down'));
    expect(await scheduler.schedule()).toBe(false);
  });

  it('the worker module registers the hourly scheduler and the job has a processor', () => {
    const spec = t.app
      .get(JobSchedulerRegistry)
      .list()
      .find((one) => one.id === RETAIL_FOLLOW_SCHEDULER);
    expect(spec).toMatchObject({ queue: 'maintenance', jobName: RETAIL_FOLLOW_JOB, pattern: '10 * * * *' });
    expect(t.app.get(RetailPriceFollowProcessor, { strict: false })).toBeDefined();
  });

  it('runs the pass in the worker, and asks for it from the module the API and the worker share', () => {
    expect(Reflect.getMetadata('imports', WorkerModule)).toContain(RetailPriceFollowModule);
    expect(Reflect.getMetadata('providers', CatalogPricesModule)).toContain(RetailFollowScheduler);
    expect(Reflect.getMetadata('imports', AppModule)).toContain(CatalogPricesModule);
    expect(Reflect.getMetadata('imports', AppModule)).not.toContain(RetailPriceFollowModule);
  });
});

describe('the job', () => {
  const processor = () => t.app.get(RetailPriceFollowProcessor, { strict: false });
  const job = (data: { runId?: number }, repeatJobKey?: string) =>
    ({ data, repeatJobKey }) as unknown as Parameters<RetailPriceFollowProcessor['process']>[0];
  const runs = () => db.select().from(s.jobRuns).orderBy(s.jobRuns.id);

  it('runs unrecorded when the delayed job arrives', async () => {
    const w = await world();
    const service = await follower(w);
    await syncCost(service, '12.0000');
    expect(await processor().process(job({}))).toMatchObject({ followed: 1 });
    expect(await runs()).toEqual([]);
  });

  it('records a scheduled run in job_runs, with what it did', async () => {
    const w = await world();
    const service = await follower(w);
    await syncCost(service, '12.0000');
    await processor().process(job({}, 'repeat:retail'));
    expect(await runs()).toEqual([
      expect.objectContaining({
        job: RETAIL_FOLLOW_JOB,
        trigger: 'schedule',
        status: 'succeeded',
        processed: 1,
        result: expect.objectContaining({ followed: 1, checked: 1 }),
      }),
    ]);
  });

  it('records a manual run on the row the Jobs tab inserted', async () => {
    const run = await t.app.get(JobRunsService).start({ job: RETAIL_FOLLOW_JOB, trigger: 'manual', overlap: 'refuse' });
    await processor().process(job({ runId: run.id }));
    expect(await runs()).toEqual([expect.objectContaining({ id: run.id, trigger: 'manual', status: 'succeeded' })]);
  });

  it('a scheduled run while another runs is recorded as skipped and writes nothing', async () => {
    const w = await world();
    const service = await follower(w);
    await syncCost(service, '12.0000');
    await t.app.get(JobRunsService).start({ job: RETAIL_FOLLOW_JOB, trigger: 'manual' });
    expect(await processor().process(job({}, 'repeat:retail'))).toMatchObject({ checked: 0, followed: 0 });
    expect((await runs()).map((row) => row.status)).toEqual(['running', 'skipped']);
    expect(await changes()).toEqual([]);
  });
});

describe('the hourly message', () => {
  /** The Shop price rules tab of the Catalog page (decision 060); the older `/storefront?tab=pricing` is only a redirect now. */
  const SHOP_PRICES_LINK = 'http://localhost:5173/catalog?view=settings&tab=shop-prices';

  beforeEach(async () => {
    await seedDefaultTemplates(db);
  });

  const messages = async () => (await notificationRows(db)).filter((row) => row.event === 'retail.prices_followed');
  const variablesOf = (row: { payload: unknown }) => (row.payload as { variables: Record<string, string> }).variables;

  it('sends one message per channel with the counts, and marks the rows', async () => {
    const w = await world();
    const moved = await follower(w);
    const jumped = await follower(w);
    const detached = await follower(w);
    await syncCost(moved, '11.0000');
    await syncCost(jumped, '20.0000');
    await db
      .update(s.serviceGroupPrices)
      .set({ price: '50.0000' })
      .where(eq(s.serviceGroupPrices.serviceId, detached.id));
    expect((await pass()).notified).toBe(true);

    const rows = await messages();
    const first = (await changes())[0]!.id;
    expect(rows.map((row) => `${row.channel}:${row.status}:${row.dedupeKey}`).sort()).toEqual([
      `email:queued:retail-follow:${first}:email`,
      `telegram:queued:retail-follow:${first}:telegram`,
    ]);
    for (const row of rows) {
      expect(variablesOf(row)).toEqual({
        changed: '1',
        waiting: '1',
        detached: '1',
        link: SHOP_PRICES_LINK,
      });
    }
    expect(rows.find((row) => row.channel === 'email')!.payload).toMatchObject({ to: EMAILS });
    expect(rows.find((row) => row.channel === 'telegram')!.payload).toMatchObject({ chatId: CHAT });
    expect((await changes()).every((row) => row.notifiedAt?.getTime() === clock.nowMs())).toBe(true);

    await sendAllQueued(t);
    const mail = mailbox(t).sent.find((one) => one.subject.startsWith('IMEI-HUB shop prices'));
    expect(mail?.subject).toBe('IMEI-HUB shop prices: 1 changed, 1 waiting');
    expect(mail?.text).toContain(SHOP_PRICES_LINK);
    expect(mail?.text).not.toContain('/storefront');
  });

  it('sends at most one an hour, and the next one counts only what is new', async () => {
    const w = await world();
    const service = await follower(w);
    const proposal = await waitingProposal(w);
    await syncCost(service, '11.0000');
    await pass();
    expect(await messages()).toHaveLength(2);

    clock.advance(30 * MINUTE);
    await syncCost(service, '12.0000');
    expect(await pass()).toMatchObject({ followed: 1, notified: false });
    expect(await messages()).toHaveLength(2);
    expect((await changes()).at(-1)!.notifiedAt).toBeNull();

    clock.advance(30 * MINUTE);
    expect((await pass()).notified).toBe(true);
    const rows = await messages();
    expect(rows).toHaveLength(4);
    // The proposal that waits was reported in the first message and is not counted again.
    expect(variablesOf(rows.at(-1)!)).toMatchObject({ changed: '2', waiting: '0', detached: '0' });
    expect((await changes(proposal.service.id))[0]!.resolvedAt).toBeNull();
  });

  it('sends nothing when nothing changed', async () => {
    const w = await world();
    await follower(w);
    expect(await pass()).toMatchObject({ candidates: 0, notified: false });
    clock.advance(2 * HOUR);
    expect((await pass()).notified).toBe(false);
    expect(await messages()).toEqual([]);
  });

  it('does not count a proposal closed before any message, and says nothing when that is all there is', async () => {
    const w = await world();
    const { service, proposal } = await waitingProposal(w);
    // The first message went with this proposal: a new one is needed that closes before the next message.
    clock.advance(10 * MINUTE);
    await resolve([proposal.id], 'keep');
    const second = await follower(w);
    await syncCost(second, '20.0000');
    await pass();
    await syncCost(second, '10.0000');
    await pass();
    expect((await changes(second.id))[0]).toMatchObject({ resolution: 'superseded', notifiedAt: null });
    clock.advance(HOUR);
    expect((await pass()).notified).toBe(false);
    expect((await changes(second.id))[0]!.notifiedAt).not.toBeNull();
    expect(await messages()).toHaveLength(2);
    expect((await changes(service.id))[0]).toMatchObject({ resolution: 'kept' });
  });

  it('a marking that told nobody anything does not hold the next message back', async () => {
    const w = await world();
    await waitingProposal(w);
    expect(await messages()).toHaveLength(2);
    // Inside the hour of that message: a proposal opens and closes unreported.
    clock.advance(10 * MINUTE);
    const closed = await follower(w);
    await syncCost(closed, '20.0000');
    await pass();
    await syncCost(closed, '10.0000');
    await pass();
    clock.advance(HOUR);
    expect((await pass()).notified).toBe(false);
    expect((await changes(closed.id))[0]!.notifiedAt).toEqual(clock.now());
    expect(await messages()).toHaveLength(2);

    clock.advance(MINUTE);
    const moved = await follower(w);
    await syncCost(moved, '11.0000');
    expect(await pass()).toMatchObject({ followed: 1, notified: true });
    const rows = await messages();
    expect(rows).toHaveLength(4);
    expect(variablesOf(rows.at(-1)!)).toMatchObject({ changed: '1', waiting: '0', detached: '0' });

    // That one was a message: the hour runs from it.
    clock.advance(MINUTE);
    await syncCost(moved, '12.0000');
    expect(await pass()).toMatchObject({ followed: 1, notified: false });
    expect(await messages()).toHaveLength(4);
  });

  it('a proposal a message reported keeps the hour running after it is closed', async () => {
    const w = await world();
    const { proposal } = await waitingProposal(w);
    clock.advance(10 * MINUTE);
    expect((await resolve([proposal.id], 'keep')).body.kept).toBe(1);
    clock.advance(MINUTE);
    const moved = await follower(w);
    await syncCost(moved, '11.0000');
    expect(await pass()).toMatchObject({ followed: 1, notified: false });
    expect(await messages()).toHaveLength(2);
  });

  it('two passes that end together send one message', async () => {
    const w = await world();
    const services = [await follower(w), await follower(w)];
    for (const service of services) await syncCost(service, '11.0000');
    await Promise.all([pass(), pass()]);
    expect(await messages()).toHaveLength(2);
  });

  it('a pass that ends while the message of another is being written waits for it, and sends none for its own rows', async () => {
    const w = await world();
    const first = await follower(w);
    const second = await follower(w);
    await syncCost(first, '11.0000');
    const notifications = t.app.get(NotificationService, { strict: false });
    const write = notifications.enqueueToAddress.bind(notifications);
    let other: ReturnType<typeof pass> | undefined;
    spyOn(notifications, 'enqueueToAddress').mockImplementation(
      async (...args: Parameters<NotificationService['enqueueToAddress']>) => {
        if (!other) {
          // A change the running message does not cover, then a second pass, which gets as far as the message and must wait.
          await syncCost(second, '11.0000');
          other = pass();
          await someoneWaitsForALock();
        }
        return write(...args);
      },
    );
    expect((await pass()).notified).toBe(true);
    expect(await other).toMatchObject({ followed: 1, notified: false });
    expect(await messages()).toHaveLength(2);
    expect((await changes(second.id))[0]!.notifiedAt).toBeNull();
  });

  it('with no recipient configured records why, and the rows are reported all the same', async () => {
    const quiet = await createTestApp({ clock, env: NOTICE_ENV, imports: [RetailPriceFollowModule] });
    try {
      const w = await world();
      const service = await follower(w);
      await syncCost(service, '11.0000');
      expect((await quiet.app.get(RetailPriceFollow, { strict: false }).run()).notified).toBe(true);
      const rows = await messages();
      expect(rows.map((row) => [row.channel, row.status, row.error]).sort()).toEqual([
        ['email', 'failed', 'No alert recipient is configured for email.'],
        ['telegram', 'failed', 'No alert recipient is configured for telegram.'],
      ]);
      expect((await changes())[0]!.notifiedAt).not.toBeNull();
    } finally {
      await quiet.close();
    }
  });

  it('a template staff switched off sends nothing and the rows are still marked', async () => {
    await db
      .update(s.notificationTemplates)
      .set({ isActive: false })
      .where(eq(s.notificationTemplates.event, 'retail.prices_followed'));
    const w = await world();
    const service = await follower(w);
    await syncCost(service, '11.0000');
    expect((await pass()).notified).toBe(true);
    expect(await messages()).toEqual([]);
    expect((await changes())[0]!.notifiedAt).not.toBeNull();
  });
});

describe('the listing routes', () => {
  it('say when a proposal waits for a following price, and stop saying it once it is resolved', async () => {
    const w = await world();
    const service = await follower(w);
    const listingId = await listingOf(service.id);
    expect(await listed(listingId)).toMatchObject({
      retailPrice: '13.9900',
      retailPriceSource: 'rule',
      retailPriceRule: { id: w.ruleId, label: 'IMEI +30%, ends in .99' },
      retailPriceWaiting: false,
    });
    await syncCost(service, '20.0000');
    await pass();
    expect(await listed(listingId)).toMatchObject({ retailPriceWaiting: true });
    const page = await admin.get('/admin/service-listings');
    expect(page.body[0]).toMatchObject({ retailPriceWaiting: true });
    await resolve([(await changes(service.id))[0]!.id], 'apply');
    expect(await listed(listingId)).toMatchObject({ retailPrice: '26.9900', retailPriceWaiting: false });
  });
});

describe('RetailPrices.set against a proposal', () => {
  it('closes a waiting proposal for a price of either origin, and a typed one stops following', async () => {
    const w = await world();
    const { service, proposal } = await waitingProposal(w);
    const retail = t.app.get(RetailPrices, { strict: false });
    await t.app.get(DbService).runInTransaction(async ({ tx }) => {
      await retail.lockLiveService(tx, service.id);
      const quote = (await retail.quotes(tx, [service.id])).get(service.id)!;
      await retail.set(tx, service.id, m('40'), { origin: { kind: 'manual' }, quote });
    });
    const [row] = await db.select().from(s.retailPriceChanges).where(eq(s.retailPriceChanges.id, proposal.id));
    expect(row).toMatchObject({ resolution: 'superseded', resolvedBy: null });
    expect(row!.resolvedAt).toEqual(clock.now());
    expect(await followOf(service.id)).toBeUndefined();
  });
});

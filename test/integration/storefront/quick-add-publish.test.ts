// Quick add that also puts what it creates on the shop (feature 31 slice B6, decision 040, plan 31 sections 3.5, 4.3, 5.5, 6.3 and 8.3): the
// body's `publish` and its refusals, the run that each service of a Quick add belongs to (`import_run_id`), the hand-over event written
// by the transaction that closes a run, the job that makes and prepares the one publish run of it, the story from the Quick add to the
// shop and back, and the clean names of the categories an import makes. Real Postgres and Redis; time moves with a TestClock.
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
import { asc, eq, inArray } from 'drizzle-orm';
import { DbService, schema as s } from '@src/infra/db';
import { ServiceImporter } from '@src/modules/catalog';
import { OutboxRouteRegistry } from '@src/modules/platform';
import { jobDataOf } from '@src/modules/platform/outbox/outbox-payload';
import { QuickAddRunner } from '@src/modules/suppliers';
import { QUICK_ADD_DONE_EVENT } from '@src/modules/suppliers/application/quick-add-outbox';
import { mainInputField } from '@src/modules/suppliers/domain/import-plan';
import { findRun } from '@src/modules/suppliers/infra/quick-add.repository';
import { PublishDraftFacts } from '@src/modules/storefront/publish/application/publish-draft-facts';
import { PublishFromQuickAdd } from '@src/modules/storefront/publish/application/publish-from-quick-add';
import {
  PUBLISH_JOBS,
  QUICK_ADD_DONE_EVENT as STOREFRONT_DONE_EVENT,
} from '@src/modules/storefront/publish/application/publish-outbox';
import { PublishPreparer } from '@src/modules/storefront/publish/application/publish-preparer';
import { PublishRunner } from '@src/modules/storefront/publish/application/publish-runner';
import { PublishSwitch } from '@src/modules/storefront/publish/application/publish-switch';
import { PREPARE_STALLED_ERROR } from '@src/modules/storefront/publish/domain/publish-item';
import { claimPrepare } from '@src/modules/storefront/publish/infra/publish.repository';
import { PublishFromQuickAddProcessor } from '@src/modules/storefront/publish/jobs/publish.processors';
import { type AdminApi, adminWith } from '../../support/admin-api';
import { type TestApp, createTestApp } from '../../support/app';
import { clearIdentityCaches } from '../../support/auth';
import { insertCategory, insertService } from '../../support/catalog';
import { MINUTE, TestClock } from '../../support/clock';
import { closeTestDb, resetDb, testDb } from '../../support/db';
import { insertUsd } from '../../support/fixtures';
import { freshClientIp } from '../../support/pipeline-routes';
import { insertDemoGroups } from '../../support/pricing';
import { expectRejection } from '../../support/rejection';
import { insertListingRow } from '../../support/storefront';

setDefaultTimeout(120_000);

const START = '2026-11-18T09:00:00.000Z';
const clock = new TestClock(START);
let t: TestApp;
let db: Awaited<ReturnType<typeof testDb>>['db'];
let staff: AdminApi;
let writerOnly: AdminApi;
let runner: QuickAddRunner;
let handOver: PublishFromQuickAdd;

beforeAll(async () => {
  t = await createTestApp({ clock });
  ({ db } = await testDb());
  runner = t.app.get(QuickAddRunner, { strict: false });
  handOver = t.app.get(PublishFromQuickAdd, { strict: false });
});
beforeEach(async () => {
  clock.set(START);
  await resetDb();
  await clearIdentityCaches(t);
  staff = await adminWith(t, ['suppliers:*', 'catalog:*', 'storefront:*', 'pricing:*'], { name: 'Lina S.' });
  // The route's own permission, without the right to publish.
  writerOnly = await adminWith(t, ['catalog:create', 'suppliers:read'], { name: 'Writer Only' });
});
afterEach(() => mock.restore());
afterAll(async () => {
  await resetDb();
  await clearIdentityCaches(t);
  await t.close();
  await closeTestDb();
});

let sequence = 0;

/** USD, the demo groups (the last is the retail group), and the IMEI rule: +30 %, ends in .99 from $5 (credit 10.0000 gives 13.99). */
async function shop(rule: Record<string, unknown> | null = IMEI_30): Promise<void> {
  await insertUsd(db);
  await insertDemoGroups(db);
  if (rule !== null) expect((await staff.post('/admin/retail-price-rules', rule)).status).toBe(201);
}

const IMEI_30 = { scope: 'type', serviceType: 'imei', percent: '30', rounding: 'ends_99' } as const;

/** Inserts a supplier straight into the database (the quick add never calls the supplier). */
async function newSupplier(): Promise<number> {
  sequence += 1;
  const [row] = await db
    .insert(s.suppliers)
    .values({
      name: `Quick Source ${sequence}`,
      driver: 'dhru',
      baseUrl: 'https://supplier.example',
      paramFormat: 'dhru_xml',
    })
    .returning({ id: s.suppliers.id });
  return row!.id;
}

/** Inserts a synced supplier service: an available IMEI service of the group `Apple` at 10.0000 credits unless changed. */
async function remote(
  supplierId: number,
  overrides: Partial<typeof s.supplierServices.$inferInsert> = {},
): Promise<number> {
  sequence += 1;
  const [row] = await db
    .insert(s.supplierServices)
    .values({
      supplierId,
      remoteId: `r${sequence}`,
      remoteGroup: 'Apple',
      type: 'IMEI',
      name: `Apple iPhone ${sequence} Activation Lock Remove`,
      credit: '10.0000',
      time: '1-2 hours',
      ...overrides,
    })
    .returning({ id: s.supplierServices.id });
  return row!.id;
}

const startUrl = (supplierId: number) => `/admin/suppliers/${supplierId}/quick-add`;
const startAll = (supplierId: number, extra: object = {}, by: AdminApi = staff) =>
  by.post(startUrl(supplierId), { scope: 'all', ...extra });
const runRow = async (runId: number) => (await findRun(db, runId))!;
const linksOf = (supplierId: number) =>
  db
    .select({ link: s.serviceSupplierLinks, remote: s.supplierServices })
    .from(s.serviceSupplierLinks)
    .innerJoin(s.supplierServices, eq(s.supplierServices.id, s.serviceSupplierLinks.supplierServiceId))
    .where(eq(s.supplierServices.supplierId, supplierId))
    .orderBy(asc(s.serviceSupplierLinks.id));
const doneEvents = () => db.select().from(s.outboxEvents).where(eq(s.outboxEvents.type, QUICK_ADD_DONE_EVENT));
const publishRuns = () => db.select().from(s.listingPublishRuns).orderBy(asc(s.listingPublishRuns.id));
const auditsOf = (action: string) => db.select().from(s.auditLogs).where(eq(s.auditLogs.action, action));

/** The job the relay would make of the hand-over event of a Quick add run. */
async function handOverJob(quickAddRunId: number) {
  const events = (await doneEvents()).filter((event) => event.aggregateId === quickAddRunId);
  expect(events).toHaveLength(1);
  return { name: PUBLISH_JOBS.fromQuickAdd, data: jobDataOf(events[0]!) };
}

const processor = () => new PublishFromQuickAddProcessor(handOver);

/** The slugs the shop lists. */
const shopSlugs = async () =>
  (await t.app.inject({ method: 'GET', url: '/store/v1/services?_start=0&_end=100', remoteAddress: freshClientIp() }))
    .json<Array<{ slug: string }>>()
    .map((row) => row.slug)
    .sort();

describe('POST /admin/suppliers/:id/quick-add with publish', () => {
  it('stores the choice on the run and shows it: none by default, listed or unlisted when asked', async () => {
    await shop();
    const supplierId = await newSupplier();
    await remote(supplierId);

    const plain = await startAll(supplierId);
    expect(plain.status).toBe(202);
    expect(plain.body.publish).toBe('none');
    expect((await runRow(plain.body.id)).publishMode).toBe('none');
    await runner.run(plain.body.id);

    await remote(supplierId);
    const listed = await startAll(supplierId, { publish: { listed: true } });
    expect(listed.status).toBe(202);
    expect(listed.body.publish).toBe('listed');
    expect((await runRow(listed.body.id)).publishMode).toBe('listed');
    await runner.run(listed.body.id);

    await remote(supplierId);
    const unlisted = await startAll(supplierId, { publish: { listed: false } });
    expect(unlisted.body.publish).toBe('unlisted');
    expect((await runRow(unlisted.body.id)).publishMode).toBe('unlisted');

    const shown = await staff.get(`${startUrl(supplierId)}/${unlisted.body.id}`);
    expect(shown.body.publish).toBe('unlisted');
    const groups = await staff.get(`/admin/suppliers/${supplierId}/service-groups`);
    expect(groups.body.latestRun).toMatchObject({ id: unlisted.body.id, publish: 'unlisted' });
  });

  it('names the choice in the audit row of the start, and only when there is one', async () => {
    await shop();
    const supplierId = await newSupplier();
    await remote(supplierId);
    const first = await startAll(supplierId, { publish: { listed: true } });
    await runner.run(first.body.id);
    await remote(supplierId);
    const second = await startAll(supplierId);

    const starts = (await auditsOf('started quick add from')).sort((a, b) => a.id - b.id);
    expect(starts[0]!.after).toMatchObject({ runId: first.body.id, publish: 'listed' });
    expect(starts[1]!.after).not.toHaveProperty('publish');
    expect(second.status).toBe(202);
    const ends = await auditsOf('quick added services from');
    expect(ends).toHaveLength(1);
    expect(ends[0]!.after).toMatchObject({ runId: first.body.id, publish: 'listed' });
  });

  it('refuses services that start switched off: 422 on publish with needs_active, whatever listed says, and no run', async () => {
    await shop();
    const supplierId = await newSupplier();
    await remote(supplierId);

    for (const listed of [true, false]) {
      const res = await startAll(supplierId, { serviceStatus: 'disabled', publish: { listed } });
      expect(res.status).toBe(422);
      expect(res.body.errors).toEqual([
        { field: 'publish', code: 'needs_active', message: 'Services added switched off cannot go on the shop.' },
      ]);
    }
    expect(await db.select().from(s.supplierImportRuns)).toHaveLength(0);
    expect(await db.select().from(s.outboxEvents).where(eq(s.outboxEvents.type, 'supplier.quick_add'))).toHaveLength(0);
    // Switched off alone is still fine.
    expect((await startAll(supplierId, { serviceStatus: 'disabled' })).status).toBe(202);
  });

  it('refuses a start when no retail price rule is active: 422 on publish with no_rule, and no run', async () => {
    await shop(null);
    const supplierId = await newSupplier();
    await remote(supplierId);

    const none = await startAll(supplierId, { publish: { listed: true } });
    expect(none.status).toBe(422);
    expect(none.body.errors).toEqual([
      { field: 'publish', code: 'no_rule', message: 'Set a retail pricing rule first.' },
    ]);

    // A rule that is switched off does not count, nor one that was deleted.
    const made = await staff.post('/admin/retail-price-rules', IMEI_30);
    expect(made.status).toBe(201);
    expect((await staff.patch(`/admin/retail-price-rules/${made.body.id}`, { isActive: false })).status).toBe(200);
    expect((await startAll(supplierId, { publish: { listed: false } })).body.errors[0]).toMatchObject({
      code: 'no_rule',
    });
    expect((await staff.delete(`/admin/retail-price-rules/${made.body.id}`)).status).toBeLessThan(300);
    expect((await startAll(supplierId, { publish: { listed: true } })).status).toBe(422);
    expect(await db.select().from(s.supplierImportRuns)).toHaveLength(0);

    // Without publish the rule is not needed.
    expect((await startAll(supplierId)).status).toBe(202);
  });

  it('answers 403 naming storefront:publish to a staff member with only catalog:create, and no run; without publish they may start', async () => {
    await shop();
    const supplierId = await newSupplier();
    await remote(supplierId);

    const refused = await startAll(supplierId, { publish: { listed: true } }, writerOnly);
    expect(refused.status).toBe(403);
    expect(refused.body.code).toBe('FORBIDDEN');
    expect(refused.body.detail).toContain('storefront:publish');
    expect(await db.select().from(s.supplierImportRuns)).toHaveLength(0);

    expect((await startAll(supplierId, {}, writerOnly)).status).toBe(202);
    const publisher = await adminWith(t, ['catalog:create', 'storefront:publish'], { name: 'Publisher' });
    await runner.run((await db.select().from(s.supplierImportRuns))[0]!.id);
    await remote(supplierId);
    expect((await startAll(supplierId, { publish: { listed: false } }, publisher)).status).toBe(202);
  });

  it('refuses a publish that is not an object with a boolean listed, and a key it does not know', async () => {
    await shop();
    const supplierId = await newSupplier();
    await remote(supplierId);
    for (const publish of [{}, { listed: 'yes' }, { listed: true, extra: 1 }, true, null, 'listed']) {
      const res = await startAll(supplierId, { publish });
      expect(res.status, JSON.stringify(publish)).toBe(422);
    }
    expect(await db.select().from(s.supplierImportRuns)).toHaveLength(0);
  });

  it('reads the groups scope the same way', async () => {
    await shop();
    const supplierId = await newSupplier();
    await remote(supplierId);
    const groups = [{ type: 'IMEI', remoteGroup: 'Apple' }];
    const res = await staff.post(startUrl(supplierId), { scope: 'groups', groups, publish: { listed: true } });
    expect(res.status).toBe(202);
    expect(res.body.publish).toBe('listed');
    const off = await staff.post(startUrl(supplierId), {
      scope: 'groups',
      groups,
      serviceStatus: 'disabled',
      publish: { listed: true },
    });
    expect(off.status).toBe(422);
  });
});

describe('import_run_id on the links of the services a quick add makes', () => {
  it('records the run on each service it creates, and nothing on a service the picker imports', async () => {
    await shop();
    const supplierId = await newSupplier();
    const [a, b] = [await remote(supplierId), await remote(supplierId)];
    const run = await startAll(supplierId, { scope: 'groups', groups: [{ type: 'IMEI', remoteGroup: 'Apple' }] });
    expect(run.status).toBe(202);
    expect(await runner.run(run.body.id)).toBe('succeeded');
    const picked = await remote(supplierId, { remoteGroup: 'Samsung' });
    expect((await staff.post(`/admin/suppliers/${supplierId}/import`, { supplierServiceIds: [picked] })).status).toBe(
      200,
    );

    const links = await linksOf(supplierId);
    expect(links.map((row) => [row.remote.id, row.link.importRunId])).toEqual([
      [a, run.body.id],
      [b, run.body.id],
      [picked, null],
    ]);
  });

  it('gives each run its own services', async () => {
    await shop();
    const supplierId = await newSupplier();
    const first = await remote(supplierId);
    const one = await startAll(supplierId);
    await runner.run(one.body.id);
    const second = await remote(supplierId);
    const two = await startAll(supplierId);
    await runner.run(two.body.id);
    expect((await linksOf(supplierId)).map((row) => [row.remote.id, row.link.importRunId])).toEqual([
      [first, one.body.id],
      [second, two.body.id],
    ]);
  });

  it('is cleared, not refused, when the run row goes away', async () => {
    await shop();
    const supplierId = await newSupplier();
    await remote(supplierId);
    const run = await startAll(supplierId);
    await runner.run(run.body.id);

    await db.delete(s.supplierImportRuns).where(eq(s.supplierImportRuns.id, run.body.id));

    expect((await linksOf(supplierId))[0]!.link.importRunId).toBeNull();
  });

  it('is kept when staff save the chain of a service, and a new link starts with none', async () => {
    await shop();
    const supplierId = await newSupplier();
    const first = await remote(supplierId);
    const extra = await remote(supplierId, { remoteGroup: 'Other' });
    const run = await startAll(supplierId, { scope: 'groups', groups: [{ type: 'IMEI', remoteGroup: 'Apple' }] });
    await runner.run(run.body.id);
    const serviceId = (await linksOf(supplierId))[0]!.link.serviceId;

    const saved = await staff.put(`/admin/services/${serviceId}/supplier-links`, {
      links: [
        { supplierServiceId: first, priority: 1 },
        { supplierServiceId: extra, priority: 2 },
      ],
    });
    expect(saved.status).toBe(200);
    const chain = await db
      .select()
      .from(s.serviceSupplierLinks)
      .where(eq(s.serviceSupplierLinks.serviceId, serviceId))
      .orderBy(asc(s.serviceSupplierLinks.priority));
    expect(chain.map((row) => [row.supplierServiceId, row.importRunId])).toEqual([
      [first, run.body.id],
      [extra, null],
    ]);

    // Reordered: the link that made the service is second now, and still names its run.
    const reordered = await staff.put(`/admin/services/${serviceId}/supplier-links`, {
      links: [
        { supplierServiceId: extra, priority: 1 },
        { supplierServiceId: first, priority: 2 },
      ],
    });
    expect(reordered.status).toBe(200);
    const after = await db
      .select()
      .from(s.serviceSupplierLinks)
      .where(eq(s.serviceSupplierLinks.serviceId, serviceId))
      .orderBy(asc(s.serviceSupplierLinks.priority));
    expect(after.map((row) => [row.supplierServiceId, row.importRunId])).toEqual([
      [extra, null],
      [first, run.body.id],
    ]);

    // The link that made the service is removed: the service has left its run.
    expect(
      (
        await staff.put(`/admin/services/${serviceId}/supplier-links`, {
          links: [{ supplierServiceId: extra, priority: 1 }],
        })
      ).status,
    ).toBe(200);
    expect(
      (await db.select().from(s.serviceSupplierLinks).where(eq(s.serviceSupplierLinks.serviceId, serviceId))).map(
        (row) => row.importRunId,
      ),
    ).toEqual([null]);
  });
});

describe('the hand-over event at the close of a run (plan 31 section 6.3)', () => {
  it('is written by the run that asked to publish and created services, with ids and the target only', async () => {
    await shop();
    const supplierId = await newSupplier();
    await remote(supplierId);
    await remote(supplierId);
    const run = await startAll(supplierId, { publish: { listed: true } });
    expect(await doneEvents()).toHaveLength(0);

    expect(await runner.run(run.body.id)).toBe('succeeded');

    const [event] = await doneEvents();
    expect(event).toMatchObject({ aggregateType: 'supplier_import_runs', aggregateId: run.body.id });
    expect(jobDataOf(event!).payload).toEqual({
      runId: run.body.id,
      supplierId,
      requestedBy: staff.staffId,
      listed: true,
    });
    // One transaction with the close: the closing audit row is there, and the run is closed.
    expect(await auditsOf('quick added services from')).toHaveLength(1);
    expect(await doneEvents()).toHaveLength(1);
  });

  it('carries listed false for a run that asked for an unlisted publish', async () => {
    await shop();
    const supplierId = await newSupplier();
    await remote(supplierId);
    const run = await startAll(supplierId, { publish: { listed: false } });
    await runner.run(run.body.id);
    expect(jobDataOf((await doneEvents())[0]!).payload).toMatchObject({ runId: run.body.id, listed: false });
  });

  it('is not written when the run did not ask to publish', async () => {
    await shop();
    const supplierId = await newSupplier();
    await remote(supplierId);
    const run = await startAll(supplierId);
    expect(await runner.run(run.body.id)).toBe('succeeded');
    expect(await doneEvents()).toHaveLength(0);
  });

  it('is not written when the run created nothing', async () => {
    await shop();
    const supplierId = await newSupplier();
    const only = await remote(supplierId);
    const run = await startAll(supplierId, { publish: { listed: true } });
    // The service was imported by hand between the start and the worker's claim: the run counts it again and creates nothing.
    const serviceId = await insertService(db, await insertCategory(db, { name: 'By hand' }));
    await db.insert(s.serviceSupplierLinks).values({ serviceId, supplierServiceId: only, priority: 1 });

    expect(await runner.run(run.body.id)).toBe('succeeded');

    expect(await runRow(run.body.id)).toMatchObject({ createdCount: 0, total: 0 });
    expect(await doneEvents()).toHaveLength(0);
  });

  it('is written by a run that failed after it created some services', async () => {
    await shop();
    const supplierId = await newSupplier();
    for (let i = 0; i < 10; i += 1) await remote(supplierId);
    for (let i = 0; i < 20; i += 1) await remote(supplierId, { credit: '-1.0000' });
    const run = await startAll(supplierId, { publish: { listed: true } });

    expect(await runner.run(run.body.id)).toBe('failed');

    expect(await runRow(run.body.id)).toMatchObject({ status: 'failed', createdCount: 10, failedCount: 20 });
    const events = await doneEvents();
    expect(events).toHaveLength(1);
    expect(jobDataOf(events[0]!).payload).toMatchObject({ runId: run.body.id, listed: true });
  });

  it('is not written by a run that failed before it created anything', async () => {
    await shop();
    const supplierId = await newSupplier();
    for (let i = 0; i < 20; i += 1) await remote(supplierId, { credit: '-1.0000' });
    const run = await startAll(supplierId, { publish: { listed: true } });
    expect(await runner.run(run.body.id)).toBe('failed');
    expect(await doneEvents()).toHaveLength(0);
  });

  it('is written once by the start that closes a stalled run that created services', async () => {
    await shop();
    const supplierId = await newSupplier();
    await remote(supplierId);
    const stalled = await startAll(supplierId, { publish: { listed: true } });
    // The worker created its chunk and died before the close: the run says so, and the next start closes it.
    await t.app.get(DbService).runInTransaction(async ({ tx }) => {
      await tx
        .update(s.supplierImportRuns)
        .set({ status: 'running', createdCount: 3, startedAt: clock.now() })
        .where(eq(s.supplierImportRuns.id, stalled.body.id));
    });
    clock.advance(6 * MINUTE);
    await remote(supplierId);

    const next = await startAll(supplierId);

    expect(next.status).toBe(202);
    expect(await runRow(stalled.body.id)).toMatchObject({ status: 'failed' });
    const events = await doneEvents();
    expect(events).toHaveLength(1);
    expect(jobDataOf(events[0]!).payload).toEqual({
      runId: stalled.body.id,
      supplierId,
      requestedBy: staff.staffId,
      listed: true,
    });
  });

  it('is not written by the start that closes a stalled run that created nothing, or one that did not ask', async () => {
    await shop();
    const supplierId = await newSupplier();
    await remote(supplierId);
    const silent = await startAll(supplierId, { publish: { listed: true } });
    clock.advance(6 * MINUTE);
    const second = await startAll(supplierId);
    expect(second.status).toBe(202);
    expect(await runRow(silent.body.id)).toMatchObject({ status: 'failed', createdCount: 0 });

    await db
      .update(s.supplierImportRuns)
      .set({ status: 'running', createdCount: 2 })
      .where(eq(s.supplierImportRuns.id, second.body.id));
    clock.advance(6 * MINUTE);
    expect((await startAll(supplierId)).status).toBe(202);
    expect(await runRow(second.body.id)).toMatchObject({ status: 'failed', createdCount: 2, publishMode: 'none' });
    expect(await doneEvents()).toHaveLength(0);
  });

  it('is not written twice when the old runner reaches its close after a newer start closed the run', async () => {
    await shop();
    const supplierId = await newSupplier();
    await remote(supplierId);
    const first = await startAll(supplierId, { publish: { listed: true } });
    await db
      .update(s.supplierImportRuns)
      .set({ status: 'running', createdCount: 1, startedAt: clock.now() })
      .where(eq(s.supplierImportRuns.id, first.body.id));
    const claimed = await runRow(first.body.id);
    clock.advance(6 * MINUTE);
    expect((await startAll(supplierId)).status).toBe(202);
    expect(await doneEvents()).toHaveLength(1);

    const close = (runner as unknown as { close: (...args: unknown[]) => Promise<string> }).close.bind(runner);
    expect(await close(claimed, 'succeeded', null)).toBe('stopped');

    expect(await doneEvents()).toHaveLength(1);
  });
});

describe('the hand-over job (publish_from_quick_add)', () => {
  it('makes the one automatic run of the Quick add run and prepares it; the second delivery finds it and does nothing', async () => {
    await shop();
    const supplierId = await newSupplier();
    for (let i = 0; i < 3; i += 1) await remote(supplierId);
    const quick = await startAll(supplierId, { publish: { listed: false } });
    await runner.run(quick.body.id);
    const job = await handOverJob(quick.body.id);

    expect(await processor().process(job as never)).toBe('queued');
    expect(await processor().process(job as never)).toBe('exists');

    const runs = await publishRuns();
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      source: 'quick_add',
      sourceRunId: quick.body.id,
      scope: { kind: 'quickAddRun', runId: quick.body.id },
      auto: true,
      listed: false,
      requestedBy: staff.staffId,
      status: 'queued',
      total: 3,
    });
    expect(runs[0]!.preparedAt).not.toBeNull();
    // The preview closed with rows ticked: the apply event and the start audit row by the system.
    const events = await db.select().from(s.outboxEvents).where(eq(s.outboxEvents.type, 'storefront.publish_apply'));
    expect(events).toHaveLength(1);
    const [start] = await auditsOf('started publishing to the storefront');
    expect(start).toMatchObject({ actorType: 'system', entityType: 'publish_run', entityId: runs[0]!.id });
    expect(start!.after).toMatchObject({ source: 'quick_add', included: 3, listed: false, requestedBy: staff.staffId });
  });

  it('two deliveries at the same moment make one run (the conflict target repeats the index predicate)', async () => {
    await shop();
    const supplierId = await newSupplier();
    for (let i = 0; i < 3; i += 1) await remote(supplierId);
    const quick = await startAll(supplierId, { publish: { listed: true } });
    await runner.run(quick.body.id);
    const job = await handOverJob(quick.body.id);

    const outcomes = await Promise.all([processor().process(job as never), processor().process(job as never)]);

    expect(outcomes.slice().sort()).toEqual(['exists', 'queued']);
    expect(await publishRuns()).toHaveLength(1);
    expect(
      await db.select().from(s.outboxEvents).where(eq(s.outboxEvents.type, 'storefront.publish_apply')),
    ).toHaveLength(1);
  });

  it('leaves the run a draft when no row is ticked: every service is blocked because the rule is gone', async () => {
    await shop();
    const supplierId = await newSupplier();
    await remote(supplierId);
    await remote(supplierId);
    const quick = await startAll(supplierId, { publish: { listed: true } });
    await runner.run(quick.body.id);
    // The rule went away between the Quick add and the job.
    const rules = await db.select().from(s.retailPriceRules);
    expect((await staff.delete(`/admin/retail-price-rules/${rules[0]!.id}`)).status).toBeLessThan(300);

    expect(await processor().process((await handOverJob(quick.body.id)) as never)).toBe('draft');

    const [run] = await publishRuns();
    expect(run).toMatchObject({ status: 'draft', auto: true, total: 2 });
    const rows = await db.select().from(s.listingPublishItems).where(eq(s.listingPublishItems.runId, run!.id));
    expect(rows.map((row) => [row.state, row.blockedReason, row.included])).toEqual([
      ['blocked', 'price_missing', false],
      ['blocked', 'price_missing', false],
    ]);
    expect(await auditsOf('started publishing to the storefront')).toHaveLength(0);
    expect(await db.select().from(s.serviceListings)).toHaveLength(0);
  });

  it('prepares the services this Quick add created and no others', async () => {
    await shop();
    const supplierId = await newSupplier();
    const earlier = await remote(supplierId, { remoteGroup: 'Samsung' });
    expect((await staff.post(`/admin/suppliers/${supplierId}/import`, { supplierServiceIds: [earlier] })).status).toBe(
      200,
    );
    await remote(supplierId);
    await remote(supplierId);
    const quick = await startAll(supplierId, { publish: { listed: true } });
    await runner.run(quick.body.id);

    await processor().process((await handOverJob(quick.body.id)) as never);

    const [run] = await publishRuns();
    const rows = await db.select().from(s.listingPublishItems).where(eq(s.listingPublishItems.runId, run!.id));
    const made = (await linksOf(supplierId)).filter((row) => row.link.importRunId === quick.body.id);
    expect(rows.map((row) => row.serviceId).sort()).toEqual(made.map((row) => row.link.serviceId).sort());
    expect(rows).toHaveLength(2);
  });

  it('is routed by the storefront, under the event name the suppliers module writes', () => {
    expect(STOREFRONT_DONE_EVENT).toBe(QUICK_ADD_DONE_EVENT);
    expect(t.app.get(OutboxRouteRegistry, { strict: false }).get(QUICK_ADD_DONE_EVENT)).toEqual({
      type: 'supplier.quick_add_done',
      queue: 'imports',
      jobName: 'publish_from_quick_add',
    });
  });

  it('refuses a job without a Quick add run, a target or a valid requester', () => {
    const data = (patch: Record<string, unknown>, aggregateId = 7) => ({
      name: PUBLISH_JOBS.fromQuickAdd,
      data: { aggregateId, payload: { listed: true, requestedBy: 3, ...patch } },
    });
    expect(() => processor().process(data({}, 0) as never)).toThrow('no run id');
    expect(() => processor().process(data({ listed: undefined }) as never)).toThrow('no target');
    expect(() => processor().process(data({ listed: 'yes' }) as never)).toThrow('no target');
    expect(() => processor().process(data({ requestedBy: 'x' }) as never)).toThrow('bad requestedBy');
    expect(() => processor().process(data({ requestedBy: 0 }) as never)).toThrow('bad requestedBy');
  });

  it('closes a draft with no rows when every service of the Quick add run was archived before the job ran', async () => {
    await shop();
    const supplierId = await newSupplier();
    await remote(supplierId);
    await remote(supplierId);
    const quick = await startAll(supplierId, { publish: { listed: true } });
    await runner.run(quick.body.id);
    await db.update(s.services).set({ status: 'disabled', archivedAt: clock.now() });

    expect(await processor().process((await handOverJob(quick.body.id)) as never)).toBe('draft');

    expect((await publishRuns())[0]).toMatchObject({ status: 'draft', total: 0 });
    expect(await db.select().from(s.listingPublishItems)).toHaveLength(0);
  });

  it('takes a null requester: the run records none', async () => {
    await shop();
    const supplierId = await newSupplier();
    await remote(supplierId);
    const quick = await startAll(supplierId, { publish: { listed: true } });
    await runner.run(quick.body.id);
    const job = await handOverJob(quick.body.id);
    const data = { ...job.data, payload: { ...job.data.payload, requestedBy: null } };

    expect(await processor().process({ name: job.name, data } as never)).toBe('queued');
    expect((await publishRuns())[0]!.requestedBy).toBeNull();
  });
});

describe('a hand-over that dies (plan 31 section 6.3)', () => {
  const preparerOf = () => t.app.get(PublishPreparer, { strict: false });
  const prepareByHand = (quickAddRunId: number) =>
    staff.post('/admin/publish-runs', { scope: { kind: 'quickAddRun', runId: quickAddRunId } });
  const listings = () => db.select().from(s.serviceListings);
  const applyEvents = () => db.select().from(s.outboxEvents).where(eq(s.outboxEvents.type, 'storefront.publish_apply'));

  /** A Quick add that asked to publish and ended, with the job of its hand-over. */
  async function endedQuickAdd() {
    await shop();
    const supplierId = await newSupplier();
    await remote(supplierId);
    await remote(supplierId);
    const quick = await startAll(supplierId, { publish: { listed: true } });
    await runner.run(quick.body.id);
    return { quickAddRunId: quick.body.id as number, job: await handOverJob(quick.body.id) };
  }

  it('dying between its insert and the claim leaves a run nobody finishes: it reads failed, and a second delivery changes nothing', async () => {
    const { job } = await endedQuickAdd();
    spyOn(preparerOf(), 'run').mockRejectedValueOnce(new Error('the worker is gone'));

    await expectRejection(processor().process(job as never), 'the worker is gone');

    const [run] = await publishRuns();
    expect(run).toMatchObject({ status: 'preparing', auto: true, prepareClaimedAt: null, preparedAt: null });
    expect(await db.select().from(s.listingPublishItems)).toHaveLength(0);

    expect(await processor().process(job as never)).toBe('exists');
    expect(await publishRuns()).toHaveLength(1);
    expect(await db.select().from(s.listingPublishItems)).toHaveLength(0);

    expect((await staff.get(`/admin/publish-runs/${run!.id}`)).body.status).toBe('preparing');
    clock.advance(6 * MINUTE);
    expect((await staff.get(`/admin/publish-runs/${run!.id}`)).body).toMatchObject({
      status: 'failed',
      error: PREPARE_STALLED_ERROR,
      preparedAt: null,
    });
    expect(await listings()).toHaveLength(0);
  });

  it('staff preparing the preview by hand close the stalled run, so that it can publish nothing later', async () => {
    const { quickAddRunId, job } = await endedQuickAdd();
    spyOn(preparerOf(), 'run').mockRejectedValueOnce(new Error('the worker is gone'));
    await expectRejection(processor().process(job as never), 'the worker is gone');
    const [auto] = await publishRuns();
    clock.advance(6 * MINUTE);

    const manual = await prepareByHand(quickAddRunId);

    expect(manual.status).toBe(202);
    expect((await publishRuns()).find((run) => run.id === auto!.id)).toMatchObject({
      status: 'failed',
      error: PREPARE_STALLED_ERROR,
      preparedAt: null,
    });
    // The job of the old run has nothing to claim any more; staff's own run is prepared and waits for them.
    expect(await preparerOf().run(auto!.id)).toBe('not_preparing');
    expect(await preparerOf().run(manual.body.id)).toBe('draft');
    expect(await applyEvents()).toHaveLength(0);
    expect(await listings()).toHaveLength(0);
  });

  it('a worker that only slept stops when it wakes up after staff took over: nothing is queued or published', async () => {
    const { quickAddRunId, job } = await endedQuickAdd();
    const facts = t.app.get(PublishDraftFacts, { strict: false });
    const read = facts.read.bind(facts);
    // The worker claims the run and goes quiet in the middle of the preview; five minutes on, staff prepare it by hand.
    let manualId: number | undefined;
    spyOn(facts, 'read').mockImplementationOnce(async (...args: Parameters<PublishDraftFacts['read']>) => {
      clock.advance(6 * MINUTE);
      const manual = await prepareByHand(quickAddRunId);
      expect(manual.status).toBe(202);
      manualId = manual.body.id;
      return read(...args);
    });

    expect(await processor().process(job as never)).toBe('stopped');

    const runs = await publishRuns();
    expect(runs.find((run) => run.sourceRunId === quickAddRunId)).toMatchObject({
      status: 'failed',
      error: PREPARE_STALLED_ERROR,
      preparedAt: null,
    });
    expect(runs.find((run) => run.id === manualId)).toMatchObject({ status: 'preparing', auto: false });
    expect(await applyEvents()).toHaveLength(0);
    expect(await listings()).toHaveLength(0);
  });

  it('leaves an automatic run alone while it is alive or once it has its preview', async () => {
    const { quickAddRunId, job } = await endedQuickAdd();
    spyOn(preparerOf(), 'run').mockRejectedValueOnce(new Error('the worker is gone'));
    await expectRejection(processor().process(job as never), 'the worker is gone');
    const [auto] = await publishRuns();
    expect(await claimPrepare(db, auto!.id, clock.now())).toBeDefined();

    // Not stalled: it may still finish, and staff's run stands beside it.
    expect((await prepareByHand(quickAddRunId)).status).toBe(202);
    expect((await publishRuns()).find((run) => run.id === auto!.id)).toMatchObject({ status: 'preparing' });
  });
});

describe('from the Quick add to the shop and back (plan 31 sections 6.3 and 6.7)', () => {
  /** 30 services in the group `Apple`: 28 with names of their own and two that share one name (they wait for a person). */
  async function thirty(supplierId: number): Promise<{ plain: number[]; twins: number[] }> {
    const plain: number[] = [];
    for (let i = 1; i <= 28; i += 1) {
      plain.push(await remote(supplierId, { name: `Apple iPhone ${i} Activation Lock Remove` }));
    }
    const twins = [
      await remote(supplierId, { name: 'Samsung Galaxy KG Lock Remove' }),
      await remote(supplierId, { name: 'Samsung Galaxy KG Lock Remove' }),
    ];
    return { plain, twins };
  }

  it('publishes the ready services at the rule price, leaves the flagged ones for a person, and the run switch takes them off again', async () => {
    await shop();
    const supplierId = await newSupplier();
    const { twins } = await thirty(supplierId);
    const quick = await startAll(supplierId, { publish: { listed: true } });
    expect(await runner.run(quick.body.id)).toBe('succeeded');
    expect(await runRow(quick.body.id)).toMatchObject({ createdCount: 30, total: 30 });

    expect(await processor().process((await handOverJob(quick.body.id)) as never)).toBe('queued');
    const [run] = await publishRuns();
    expect(run).toMatchObject({ status: 'queued', total: 30, source: 'quick_add' });
    const items = await db
      .select()
      .from(s.listingPublishItems)
      .where(eq(s.listingPublishItems.runId, run!.id))
      .orderBy(asc(s.listingPublishItems.id));
    expect(items.filter((row) => row.included)).toHaveLength(28);

    // The worker applies the queued run.
    expect(await t.app.get(PublishRunner, { strict: false }).run(run!.id)).toBe('succeeded');

    const finished = (await staff.get(`/admin/publish-runs/${run!.id}`)).body;
    expect(finished).toMatchObject({
      status: 'succeeded',
      source: 'quick_add',
      auto: true,
      quickAddRunId: quick.body.id,
      counts: { published: 28, skipped: 2, refused: 0, pending: 0 },
    });
    const twinIds = await twinServiceIds(twins);
    const left = items.filter((row) => twinIds.includes(row.serviceId));
    expect(left).toHaveLength(2);
    const after = await db
      .select()
      .from(s.listingPublishItems)
      .where(
        inArray(
          s.listingPublishItems.id,
          left.map((row) => row.id),
        ),
      );
    expect(after.map((row) => [row.result, row.resultReason])).toEqual([
      ['skipped', 'left_out'],
      ['skipped', 'left_out'],
    ]);

    // On the shop at the rule price, with its follow row; the twins are not there.
    const listings = await db.select().from(s.serviceListings);
    expect(listings).toHaveLength(28);
    expect(listings.every((listing) => listing.isListed)).toBe(true);
    expect((await shopSlugs()).length).toBe(28);
    const prices = await db.select().from(s.serviceGroupPrices);
    expect(prices).toHaveLength(28);
    expect(new Set(prices.map((row) => row.price))).toEqual(new Set(['13.9900']));
    expect(await db.select().from(s.retailPriceFollows)).toHaveLength(28);
    expect(await auditsOf('published to the storefront')).toHaveLength(28);

    // The finished run is found from the Quick add run.
    const found = await staff.get(`/admin/publish-runs?quickAddRunId=${quick.body.id}`);
    expect(found.body.map((row: { id: number }) => row.id)).toEqual([run!.id]);

    // One button takes the whole run off the shop again.
    expect((await staff.post(`/admin/publish-runs/${run!.id}/listed`, { listed: false })).status).toBe(202);
    expect(await t.app.get(PublishSwitch, { strict: false }).run(run!.id, false, staff.staffId)).toBe('done');
    expect(await shopSlugs()).toEqual([]);
    expect((await db.select().from(s.serviceListings)).every((listing) => !listing.isListed)).toBe(true);
    expect(await db.select().from(s.serviceGroupPrices)).toHaveLength(28);
  });

  it('puts the ready services on the shop switched off when the Quick add asked for listed false', async () => {
    await shop();
    const supplierId = await newSupplier();
    await thirty(supplierId);
    const quick = await startAll(supplierId, { publish: { listed: false } });
    await runner.run(quick.body.id);
    await processor().process((await handOverJob(quick.body.id)) as never);
    const [run] = await publishRuns();
    await t.app.get(PublishRunner, { strict: false }).run(run!.id);

    const listings = await db.select().from(s.serviceListings);
    expect(listings).toHaveLength(28);
    expect(listings.every((listing) => !listing.isListed)).toBe(true);
    expect(await shopSlugs()).toEqual([]);

    // Switching them on is one press on the finished run.
    expect((await staff.post(`/admin/publish-runs/${run!.id}/listed`, { listed: true })).status).toBe(202);
    await t.app.get(PublishSwitch, { strict: false }).run(run!.id, true, staff.staffId);
    expect(await shopSlugs()).toHaveLength(28);
  });

  it('does not touch a service that was already on the shop, and never lists a Quick add service twice', async () => {
    await shop();
    const supplierId = await newSupplier();
    await remote(supplierId, { name: 'Apple iPhone 1 Activation Lock Remove' });
    await remote(supplierId, { name: 'Apple iPhone 2 Activation Lock Remove' });
    const quick = await startAll(supplierId, { publish: { listed: true } });
    await runner.run(quick.body.id);
    const made = (await linksOf(supplierId)).map((row) => row.link.serviceId);
    // Staff listed the first service by hand before the preview ran.
    await insertListingRow(db, made[0]!, { slug: 'by-hand', publicTitle: 'By hand' });

    await processor().process((await handOverJob(quick.body.id)) as never);
    const [run] = await publishRuns();
    expect(run).toMatchObject({ total: 1 });
    await t.app.get(PublishRunner, { strict: false }).run(run!.id);

    const listings = await db.select().from(s.serviceListings).orderBy(asc(s.serviceListings.id));
    expect(listings.map((row) => row.slug)).toEqual(['by-hand', 'apple-iphone-2-activation-lock-remove']);
  });
});

/** The services of ours whose supplier services are these. */
async function twinServiceIds(remoteIds: readonly number[]): Promise<number[]> {
  const links = await db
    .select({ serviceId: s.serviceSupplierLinks.serviceId })
    .from(s.serviceSupplierLinks)
    .where(inArray(s.serviceSupplierLinks.supplierServiceId, [...remoteIds]));
  return links.map((link) => link.serviceId);
}

describe('the category an import makes (plan 31 section 3.5)', () => {
  const categoriesOf = async (type: 'imei' | 'server' = 'imei') =>
    (
      await db
        .select()
        .from(s.serviceCategories)
        .where(eq(s.serviceCategories.type, type))
        .orderBy(asc(s.serviceCategories.id))
    ).map((row) => row.name);
  const categoryOfSupplierService = async (remoteId: number) => {
    const [row] = await db
      .select({ name: s.serviceCategories.name, id: s.serviceCategories.id })
      .from(s.serviceSupplierLinks)
      .innerJoin(s.services, eq(s.services.id, s.serviceSupplierLinks.serviceId))
      .innerJoin(s.serviceCategories, eq(s.serviceCategories.id, s.services.categoryId))
      .where(eq(s.serviceSupplierLinks.supplierServiceId, remoteId));
    return row!;
  };

  /** A group with an entity, an emoji, a direction mark and a run of Arabic letters (U+0622 U+0628 U+0644). */
  const MESSY = '\u{200F}\u{1F34E} Apple &amp; Samsung \u{0622}\u{0628}\u{0644}\u{200E}';

  it('names a new category with the cleaned group text, and the next import finds it again', async () => {
    const supplierId = await newSupplier();
    const first = await remote(supplierId, { remoteGroup: MESSY });
    const run = await startAll(supplierId);
    expect(await runner.run(run.body.id)).toBe('succeeded');
    expect(await categoriesOf()).toEqual(['Apple & Samsung']);
    expect(await runRow(run.body.id)).toMatchObject({ categoriesCreated: 1 });

    // Another spelling of the same group, later: it goes to the same category.
    const second = await remote(supplierId, { remoteGroup: '  Apple &amp;   Samsung ' });
    const again = await startAll(supplierId);
    await runner.run(again.body.id);
    expect(await categoriesOf()).toEqual(['Apple & Samsung']);
    expect(await runRow(again.body.id)).toMatchObject({ categoriesCreated: 0, createdCount: 1 });
    expect((await categoryOfSupplierService(first)).id).toBe((await categoryOfSupplierService(second)).id);
  });

  it('keeps sending a group to the category an earlier import made under the raw text', async () => {
    const supplierId = await newSupplier();
    const rawName = 'Apple &amp; Samsung';
    const legacy = await insertCategory(db, { name: rawName });
    const remoteId = await remote(supplierId, { remoteGroup: rawName });
    const run = await startAll(supplierId);

    expect(await runner.run(run.body.id)).toBe('succeeded');

    expect(await categoriesOf()).toEqual([rawName]);
    expect((await categoryOfSupplierService(remoteId)).id).toBe(legacy);
    expect(await runRow(run.body.id)).toMatchObject({ categoriesCreated: 0 });
  });

  it('does not split a group between two categories when the raw one exists next to the cleaned one', async () => {
    const supplierId = await newSupplier();
    const rawName = 'Apple &amp; Samsung';
    const legacy = await insertCategory(db, { name: rawName });
    const clean = await insertCategory(db, { name: 'Apple & Samsung' });
    const remoteId = await remote(supplierId, { remoteGroup: rawName });
    const run = await startAll(supplierId);
    await runner.run(run.body.id);
    // The raw text comes first: the lookup it always made.
    expect((await categoryOfSupplierService(remoteId)).id).toBe(legacy);
    expect(legacy).not.toBe(clean);
  });

  it('gives Imported to an empty group and to one that is only decoration', async () => {
    const supplierId = await newSupplier();
    await remote(supplierId, { remoteGroup: '' });
    await remote(supplierId, { remoteGroup: '\u{1F525}\u{1F525}' });
    const run = await startAll(supplierId);
    await runner.run(run.body.id);
    expect(await categoriesOf()).toEqual(['Imported']);
    expect(await runRow(run.body.id)).toMatchObject({ categoriesCreated: 1, createdCount: 2 });
  });

  it("the picker's import goes through the same lookup", async () => {
    const supplierId = await newSupplier();
    const first = await remote(supplierId, { remoteGroup: MESSY });
    const run = await startAll(supplierId);
    await runner.run(run.body.id);
    const picked = await remote(supplierId, { remoteGroup: 'Apple &amp; Samsung' });

    const res = await staff.post(`/admin/suppliers/${supplierId}/import`, { supplierServiceIds: [picked] });

    expect(res.status).toBe(200);
    expect(await categoriesOf()).toEqual(['Apple & Samsung']);
    expect((await categoryOfSupplierService(picked)).id).toBe((await categoryOfSupplierService(first)).id);

    // A group no category has yet is made under its cleaned name by the picker too.
    const fresh = await remote(supplierId, { remoteGroup: '\u{1F4F1} Nokia &amp; HMD' });
    expect((await staff.post(`/admin/suppliers/${supplierId}/import`, { supplierServiceIds: [fresh] })).status).toBe(
      200,
    );
    expect(await categoriesOf()).toEqual(['Apple & Samsung', 'Nokia & HMD']);
  });

  it('keeps the adoption of a main box on its exact-name lookup: the server category carries the old name as it is', async () => {
    const rawName = 'Legacy &amp; Reports';
    const oldCategory = await insertCategory(db, { name: rawName });
    const serviceId = await insertService(db, oldCategory, { name: 'Old report' });
    const field = mainInputField({ label: 'Serial Number', minLength: 1, maxLength: null }, new Set());

    const adopted = await t.app
      .get(DbService)
      .runInTransaction(({ tx }) =>
        t.app.get(ServiceImporter, { strict: false }).adoptMainInput(tx, { serviceId, field }),
      );

    expect(adopted).toMatchObject({ before: { type: 'imei' }, after: { type: 'server' }, categoryCreated: true });
    expect(await categoriesOf('server')).toEqual([rawName]);
  });
});

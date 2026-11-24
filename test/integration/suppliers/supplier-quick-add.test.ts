// The supplier quick add (feature 26, B214): the groups of a supplier's services with counts, the start of a run (a row and an outbox
// event), the worker's run in chunks (called as `QuickAddRunner.run`, and once through `QuickAddProcessor.process`), the refusals,
// concurrency, item failures, and the stall and resume rules. Real Postgres and Redis; time moves with a TestClock.
import { afterAll, beforeAll, beforeEach, describe, expect, it, setDefaultTimeout, spyOn } from 'bun:test';
import { and, asc, count, eq } from 'drizzle-orm';
import { schema as s } from '@src/infra/db';
import { defaultMinProfit } from '@src/modules/catalog';
import { Money } from '@src/common/money';
import { QuickAddRunner } from '@src/modules/suppliers';
import { QuickAddProcessor } from '@src/modules/suppliers/jobs/quick-add.processor';
import { claimRun, findRun } from '@src/modules/suppliers/infra/quick-add.repository';
import { type AdminApi, adminWith } from '../../support/admin-api';
import { type TestApp, createTestApp } from '../../support/app';
import { clearIdentityCaches } from '../../support/auth';
import { insertCategory, insertService } from '../../support/catalog';
import { MINUTE, TestClock } from '../../support/clock';
import { closeTestDb, resetDb, testDb } from '../../support/db';
import { catalogVersionOf } from '../../support/pricing';
import { expectRejection } from '../../support/rejection';

setDefaultTimeout(60_000);

const clock = new TestClock();
let t: TestApp;
let db: Awaited<ReturnType<typeof testDb>>['db'];
let staff: AdminApi;
let reader: AdminApi;
let writerOnly: AdminApi;
let runner: QuickAddRunner;

beforeAll(async () => {
  t = await createTestApp({ clock });
  ({ db } = await testDb());
  runner = t.app.get(QuickAddRunner, { strict: false });
});
beforeEach(async () => {
  await resetDb();
  await clearIdentityCaches(t);
  staff = await adminWith(t, ['suppliers:*', 'catalog:*'], { name: 'Lina S.' });
  reader = await adminWith(t, ['suppliers:read'], { name: 'Read Only' });
  writerOnly = await adminWith(t, ['catalog:create'], { name: 'Writer Only' });
});
afterAll(async () => {
  await resetDb();
  await clearIdentityCaches(t);
  clock.reset();
  await t.close();
  await closeTestDb();
});

let sequence = 0;

/** Inserts a supplier straight into the database (the quick add never calls the supplier). */
async function newSupplier(overrides: Partial<typeof s.suppliers.$inferInsert> = {}): Promise<number> {
  sequence += 1;
  const [row] = await db
    .insert(s.suppliers)
    .values({
      name: `Quick Source ${sequence}`,
      driver: 'dhru',
      baseUrl: 'https://supplier.example',
      paramFormat: 'dhru_xml',
      ...overrides,
    })
    .returning({ id: s.suppliers.id });
  return row!.id;
}

/** Inserts a synced supplier service (an available IMEI service of the group `Apple` unless changed). */
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
      name: `Remote ${sequence}`,
      credit: '10.0000',
      time: '1-2 hours',
      ...overrides,
    })
    .returning({ id: s.supplierServices.id });
  return row!.id;
}

/** Links a service of ours to a supplier service, as an earlier import would have. */
async function importedBy(
  supplierServiceId: number,
  serviceOverrides: Partial<typeof s.services.$inferInsert> = {},
): Promise<number> {
  const serviceId = await insertService(db, await insertCategory(db), serviceOverrides);
  await db.insert(s.serviceSupplierLinks).values({ serviceId, supplierServiceId, priority: 1 });
  return serviceId;
}

const GROUP_APPLE = { type: 'IMEI', remoteGroup: 'Apple' };
const startUrl = (supplierId: number) => `/admin/suppliers/${supplierId}/quick-add`;
const startGroups = (supplierId: number, groups: unknown[] = [GROUP_APPLE], extra: object = {}) =>
  staff.post(startUrl(supplierId), { scope: 'groups', groups, ...extra });
const runRow = async (runId: number) => (await findRun(db, runId))!;
const servicesOf = (supplierId: number) =>
  db
    .select({ service: s.services, link: s.serviceSupplierLinks, remote: s.supplierServices })
    .from(s.serviceSupplierLinks)
    .innerJoin(s.services, eq(s.services.id, s.serviceSupplierLinks.serviceId))
    .innerJoin(s.supplierServices, eq(s.supplierServices.id, s.serviceSupplierLinks.supplierServiceId))
    .where(eq(s.supplierServices.supplierId, supplierId))
    .orderBy(asc(s.supplierServices.id));
const auditRows = (supplierId: number) =>
  db
    .select()
    .from(s.auditLogs)
    .where(and(eq(s.auditLogs.entityType, 'supplier'), eq(s.auditLogs.entityId, supplierId)))
    .orderBy(asc(s.auditLogs.id));
const quickAuditRows = async (supplierId: number) =>
  (await auditRows(supplierId)).filter((row) => /quick add/.test(row.action));
const runsOf = (supplierId: number) =>
  db.select().from(s.supplierImportRuns).where(eq(s.supplierImportRuns.supplierId, supplierId));
const outboxOf = () => db.select().from(s.outboxEvents).where(eq(s.outboxEvents.type, 'supplier.quick_add'));

/** The state every group test builds: three available IMEI services in `Apple`, one in `Samsung`, one empty-named server group. */
async function seedGroups(supplierId: number) {
  return {
    apple: [await remote(supplierId), await remote(supplierId), await remote(supplierId)],
    samsung: await remote(supplierId, { remoteGroup: 'Samsung' }),
    noGroup: await remote(supplierId, { remoteGroup: '', type: 'SERVER' }),
  };
}

describe('GET /admin/suppliers/:id/service-groups', () => {
  it('counts every service once per group in the first bucket that fits, with totals, in a stable order', async () => {
    const supplierId = await newSupplier();
    const other = await newSupplier();
    const apple = [await remote(supplierId), await remote(supplierId), await remote(supplierId)];
    await importedBy(apple[0]!);
    await remote(supplierId, { isAvailable: false }); // unavailable
    await remote(supplierId, { remoteGroup: 'Samsung' });
    await remote(supplierId, { remoteGroup: '', type: 'SERVER' });
    await remote(supplierId, { remoteGroup: 'Apple', type: 'SERVER' }); // same name, another type: another group
    await remote(supplierId, { remoteGroup: 'Packs', type: 'Credits' }); // unsupported
    await remote(supplierId, { remoteGroup: 'Packs', type: 'Credits' }); // unsupported
    // Unavailable and of a type that cannot be imported: counted as unavailable (the first bucket that fits).
    await remote(supplierId, { remoteGroup: 'Packs', type: 'Credits', isAvailable: false });
    // An archived service still counts as imported.
    const archived = await remote(supplierId, { remoteGroup: 'Samsung' });
    await importedBy(archived, { archivedAt: new Date(), status: 'disabled' });
    await remote(other, { remoteGroup: 'Other supplier' });

    const res = await staff.get(`/admin/suppliers/${supplierId}/service-groups`);
    expect(res.status).toBe(200);
    expect(res.body.groups).toEqual([
      { type: 'Credits', remoteGroup: 'Packs', total: 3, addable: 0, imported: 0, unavailable: 1, unsupported: 2 },
      { type: 'IMEI', remoteGroup: 'Apple', total: 4, addable: 2, imported: 1, unavailable: 1, unsupported: 0 },
      { type: 'IMEI', remoteGroup: 'Samsung', total: 2, addable: 1, imported: 1, unavailable: 0, unsupported: 0 },
      { type: 'SERVER', remoteGroup: '', total: 1, addable: 1, imported: 0, unavailable: 0, unsupported: 0 },
      { type: 'SERVER', remoteGroup: 'Apple', total: 1, addable: 1, imported: 0, unavailable: 0, unsupported: 0 },
    ]);
    expect(res.body.totals).toEqual({ total: 11, addable: 5, imported: 2, unavailable: 2, unsupported: 2 });
    expect(res.body.latestRun).toBeNull();
    for (const group of res.body.groups) {
      expect(group.total).toBe(group.addable + group.imported + group.unavailable + group.unsupported);
    }
  });

  it('answers an empty list for a supplier with no services', async () => {
    const supplierId = await newSupplier();
    const res = await staff.get(`/admin/suppliers/${supplierId}/service-groups`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      groups: [],
      totals: { total: 0, addable: 0, imported: 0, unavailable: 0, unsupported: 0 },
      latestRun: null,
    });
  });

  it("carries the supplier's newest run, and a stalled one reads failed", async () => {
    const supplierId = await newSupplier();
    await seedGroups(supplierId);
    const first = await startGroups(supplierId);
    expect(first.status).toBe(202);
    await runner.run(first.body.id);
    const second = await startGroups(supplierId, [{ type: 'IMEI', remoteGroup: 'Samsung' }]);
    expect(second.status).toBe(202);
    const live = await staff.get(`/admin/suppliers/${supplierId}/service-groups`);
    expect(live.body.latestRun).toMatchObject({ id: second.body.id, status: 'queued', scope: 'groups' });
    clock.advance(6 * MINUTE);
    const stalled = await staff.get(`/admin/suppliers/${supplierId}/service-groups`);
    expect(stalled.body.latestRun).toMatchObject({ id: second.body.id, status: 'failed', finishedAt: null });
    expect(stalled.body.latestRun.error).toContain('Start it again');
  });

  it('answers 404 for an unknown supplier, 403 without suppliers:read and 401 without a session', async () => {
    const supplierId = await newSupplier();
    expect((await staff.get('/admin/suppliers/999999/service-groups')).status).toBe(404);
    expect((await writerOnly.get(`/admin/suppliers/${supplierId}/service-groups`)).status).toBe(403);
    expect((await staff.anonymous('GET', `/admin/suppliers/${supplierId}/service-groups`)).status).toBe(401);
    expect((await reader.get(`/admin/suppliers/${supplierId}/service-groups`)).status).toBe(200);
  });
});

describe('POST /admin/suppliers/:id/quick-add', () => {
  it('answers 202 with a queued run and its total, writes one outbox event and the audit row of the staff member', async () => {
    const supplierId = await newSupplier();
    await seedGroups(supplierId);
    const res = await startGroups(supplierId, [GROUP_APPLE, { ...GROUP_APPLE }], { serviceStatus: 'disabled' });
    expect(res.status).toBe(202);
    expect(res.body).toMatchObject({
      supplierId,
      scope: 'groups',
      groups: [GROUP_APPLE],
      serviceStatus: 'disabled',
      status: 'queued',
      total: 3,
      processed: 0,
      created: 0,
      skipped: 0,
      failed: 0,
      categoriesCreated: 0,
      failures: [],
      error: null,
      requestedBy: staff.staffId,
      startedAt: null,
      finishedAt: null,
    });
    expect(typeof res.body.createdAt).toBe('string');
    const events = await outboxOf();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      aggregateType: 'supplier_import_runs',
      aggregateId: res.body.id,
      payload: { runId: res.body.id, supplierId },
    });
    const [audit] = await quickAuditRows(supplierId);
    expect(audit).toMatchObject({
      action: 'started quick add from',
      actorType: 'staff',
      actorId: staff.staffId,
      actorName: 'Lina S.',
    });
    expect(audit!.after).toEqual({
      runId: res.body.id,
      scope: 'groups',
      groups: 1,
      groupNames: ['IMEI: Apple'],
      total: 3,
      serviceStatus: 'disabled',
    });
    expect(await servicesOf(supplierId)).toHaveLength(0);
  });

  it('takes the scope all with the default state active', async () => {
    const supplierId = await newSupplier();
    await seedGroups(supplierId);
    const res = await staff.post(startUrl(supplierId), { scope: 'all' });
    expect(res.status).toBe(202);
    expect(res.body).toMatchObject({ scope: 'all', groups: [], serviceStatus: 'active', total: 5 });
    const [audit] = await quickAuditRows(supplierId);
    expect(audit!.after).toMatchObject({ scope: 'all', groups: 0, groupNames: [], total: 5 });
  });

  it('answers 403 without catalog:create, 403 without the CSRF token, 401 without a session and 404 for an unknown supplier', async () => {
    const supplierId = await newSupplier();
    await seedGroups(supplierId);
    expect((await reader.post(startUrl(supplierId), { scope: 'all' })).status).toBe(403);
    expect((await staff.withoutCsrf('POST', startUrl(supplierId), { scope: 'all' })).status).toBe(403);
    expect((await staff.anonymous('POST', startUrl(supplierId), { scope: 'all' })).status).toBe(401);
    expect((await staff.post(startUrl(999999), { scope: 'all' })).status).toBe(404);
    expect(await runsOf(supplierId)).toHaveLength(0);
    expect(await outboxOf()).toHaveLength(0);
  });

  it.each([
    ['no groups', { scope: 'groups', groups: [] }, 'groups'],
    ['no groups key', { scope: 'groups' }, 'groups'],
    [
      '501 groups',
      { scope: 'groups', groups: Array.from({ length: 501 }, (_, i) => ({ type: 'IMEI', remoteGroup: `G${i}` })) },
      'groups',
    ],
    ['an unknown scope', { scope: 'everything' }, 'scope'],
    ['no scope', {}, 'scope'],
    ['groups with the scope all', { scope: 'all', groups: [GROUP_APPLE] }, 'groups'],
    ['an unknown state', { scope: 'all', serviceStatus: 'archived' }, 'serviceStatus'],
    ['a type over 60 characters', { scope: 'groups', groups: [{ type: 'x'.repeat(61), remoteGroup: 'A' }] }, 'groups'],
  ])('refuses %s with 422 on %s', async (_name, body, field) => {
    const supplierId = await newSupplier();
    await seedGroups(supplierId);
    const res = await staff.post(startUrl(supplierId), body);
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('VALIDATION_FAILED');
    expect(JSON.stringify(res.body.errors)).toContain(field);
    expect(await runsOf(supplierId)).toHaveLength(0);
  });

  it('accepts 500 groups', async () => {
    const supplierId = await newSupplier();
    await seedGroups(supplierId);
    const groups = Array.from({ length: 499 }, (_, i) => ({ type: 'IMEI', remoteGroup: `Missing ${i}` }));
    const res = await startGroups(supplierId, [...groups, GROUP_APPLE]);
    expect(res.status).toBe(202);
    expect(res.body.total).toBe(3);
  });

  it('answers 422 nothing_to_add and creates no run when the scope has no candidate', async () => {
    const supplierId = await newSupplier();
    const [a] = [await remote(supplierId)];
    await importedBy(a);
    await remote(supplierId, { isAvailable: false });
    await remote(supplierId, { remoteGroup: 'Packs', type: 'Credits' });
    const res = await staff.post(startUrl(supplierId), { scope: 'all' });
    expect(res.status).toBe(422);
    expect(res.body.errors).toEqual([
      {
        field: 'scope',
        code: 'nothing_to_add',
        message:
          'Nothing to add: every service in this scope is already in the console, no longer available or of a type that cannot be imported.',
      },
    ]);
    expect((await startGroups(supplierId, [{ type: 'IMEI', remoteGroup: 'No such group' }])).status).toBe(422);
    expect(await runsOf(supplierId)).toHaveLength(0);
    expect(await outboxOf()).toHaveLength(0);
    expect(await quickAuditRows(supplierId)).toHaveLength(0);
  });

  it('answers 409 SUPPLIER_DISABLED for a disabled supplier and accepts a paused one', async () => {
    const disabled = await newSupplier({ status: 'disabled' });
    await remote(disabled);
    const refused = await staff.post(startUrl(disabled), { scope: 'all' });
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe('SUPPLIER_DISABLED');
    expect(await runsOf(disabled)).toHaveLength(0);

    const paused = await newSupplier({ status: 'paused' });
    await remote(paused);
    expect((await staff.post(startUrl(paused), { scope: 'all' })).status).toBe(202);
  });

  it('answers 409 JOB_ALREADY_RUNNING while a run is queued or running, and allows a new one after it ended', async () => {
    const supplierId = await newSupplier();
    await seedGroups(supplierId);
    const first = await startGroups(supplierId);
    expect(first.status).toBe(202);
    const queued = await startGroups(supplierId, [{ type: 'IMEI', remoteGroup: 'Samsung' }]);
    expect(queued.status).toBe(409);
    expect(queued.body).toMatchObject({
      code: 'JOB_ALREADY_RUNNING',
      detail: 'A quick add for this supplier is already running.',
    });
    expect(await claimRun(db, first.body.id, clock.now())).toBeDefined();
    expect((await staff.post(startUrl(supplierId), { scope: 'all' })).status).toBe(409);
    await runner.run(first.body.id); // already running: nothing is claimed, the run stays running
    expect((await runRow(first.body.id)).status).toBe('running');
  });

  it('allows another supplier a run of its own at the same time', async () => {
    const a = await newSupplier();
    const b = await newSupplier();
    await remote(a);
    await remote(b);
    expect((await staff.post(startUrl(a), { scope: 'all' })).status).toBe(202);
    expect((await staff.post(startUrl(b), { scope: 'all' })).status).toBe(202);
  });

  it('lets two starts at the same moment make one run: one 202, one 409 and one live row', async () => {
    const supplierId = await newSupplier();
    await seedGroups(supplierId);
    const answers = await Promise.all([
      staff.post(startUrl(supplierId), { scope: 'all' }),
      staff.post(startUrl(supplierId), { scope: 'all' }),
    ]);
    expect(answers.map((answer) => answer.status).sort()).toEqual([202, 409]);
    const live = (await runsOf(supplierId)).filter((row) => ['queued', 'running'].includes(row.status));
    expect(live).toHaveLength(1);
    expect(await outboxOf()).toHaveLength(1);
  });
});

describe('GET /admin/suppliers/:id/quick-add/:runId', () => {
  it('shows the run, and answers 404 for an unknown run or the run of another supplier', async () => {
    const supplierId = await newSupplier();
    const other = await newSupplier();
    await seedGroups(supplierId);
    const started = await startGroups(supplierId);
    const shown = await staff.get(`${startUrl(supplierId)}/${started.body.id}`);
    expect(shown.status).toBe(200);
    expect(shown.body).toEqual(started.body);
    expect((await staff.get(`${startUrl(other)}/${started.body.id}`)).status).toBe(404);
    expect((await staff.get(`${startUrl(supplierId)}/999999`)).status).toBe(404);
    expect((await staff.get(`${startUrl(999999)}/${started.body.id}`)).status).toBe(404);
    expect((await writerOnly.get(`${startUrl(supplierId)}/${started.body.id}`)).status).toBe(403);
    expect((await reader.get(`${startUrl(supplierId)}/${started.body.id}`)).status).toBe(200);
    expect((await staff.anonymous('GET', `${startUrl(supplierId)}/${started.body.id}`)).status).toBe(401);
  });
});

describe('the run of a quick add by groups', () => {
  it('creates only the candidates of the picked groups, with the import rules, and leaves everything else alone', async () => {
    const supplierId = await newSupplier();
    const apple = await remote(supplierId, {
      name: 'Apple unlock',
      credit: '10.0000',
      customFields: [{ fieldname: 'Account User', fieldtype: 'text', description: 'Account name', required: '1' }],
      raw: { QNT: '1', MINQNT: '5', MAXQNT: '50' },
    });
    const apple2 = await remote(supplierId, { name: 'Apple unlock 2', credit: '3.3333', time: '' });
    const noName = await remote(supplierId, {
      name: 'Loose server',
      remoteGroup: '',
      type: 'SERVER',
      credit: '2.0000',
    });
    const imported = await remote(supplierId, { name: 'Apple already here', credit: '4.0000' });
    const existing = await importedBy(imported, { name: 'Our Apple', cost: '4.0000', effectiveCost: '4.0000' });
    await db.update(s.supplierServices).set({ credit: '5.0000' }).where(eq(s.supplierServices.id, imported));
    const gone = await remote(supplierId, { name: 'Apple gone', isAvailable: false });
    const credits = await remote(supplierId, { name: 'Apple credits', type: 'Credits' });
    const samsung = await remote(supplierId, { name: 'Samsung', remoteGroup: 'Samsung' });
    await db.update(s.suppliers).set({ creditRate: '1.50000000' }).where(eq(s.suppliers.id, supplierId));

    const version = await catalogVersionOf(t);
    const started = await startGroups(supplierId, [GROUP_APPLE, { type: 'SERVER', remoteGroup: '' }]);
    expect(started.status).toBe(202);
    expect(started.body.total).toBe(3);
    expect(await runner.run(started.body.id)).toBe('succeeded');

    const done = await staff.get(`${startUrl(supplierId)}/${started.body.id}`);
    expect(done.body).toMatchObject({
      status: 'succeeded',
      total: 3,
      processed: 3,
      created: 3,
      skipped: 0,
      failed: 0,
      categoriesCreated: 2,
      failures: [],
      error: null,
    });
    expect(done.body.startedAt).not.toBeNull();
    expect(done.body.finishedAt).not.toBeNull();

    const made = (await servicesOf(supplierId)).filter((row) => row.remote.id !== imported);
    expect(made.map((row) => row.remote.id)).toEqual([apple, apple2, noName]);
    const [first, second, third] = made;
    const cost = Money.of('15.0000');
    expect(first!.service).toMatchObject({
      name: 'Apple unlock',
      code: `IMP-${apple}`,
      type: 'imei',
      status: 'active',
      fulfillment: 'auto',
      priceMode: 'fixed',
      cost: '15.0000',
      effectiveCost: '15.0000',
      basePrice: cost.add(defaultMinProfit(cost)).toWire(),
      minQty: 5,
      maxQty: 50,
      qtyOptions: [],
    });
    expect(first!.link).toMatchObject({ priority: 1, isActive: true });
    expect(second!.service).toMatchObject({ code: `IMP-${apple2}`, cost: '5.0000', minQty: 1, maxQty: 1 });
    expect(second!.service.deliveryTime).not.toBe('');
    expect(third!.service).toMatchObject({ type: 'server', code: `IMP-${noName}` });

    const categories = await db.select().from(s.serviceCategories);
    const byId = new Map(categories.map((row) => [row.id, row]));
    expect(byId.get(first!.service.categoryId)).toMatchObject({ name: 'Apple', type: 'imei' });
    expect(second!.service.categoryId).toBe(first!.service.categoryId);
    expect(byId.get(third!.service.categoryId)).toMatchObject({ name: 'Imported', type: 'server' });

    const fields = await db.select().from(s.serviceFields).where(eq(s.serviceFields.serviceId, first!.service.id));
    expect(fields).toMatchObject([
      { key: 'account_user', label: 'Account name', supplierKey: 'Account User', isMainInput: false, required: true },
    ]);

    // Not touched: the imported one keeps its cost, and the unavailable, unsupported and other-group ones get nothing.
    const [kept] = await db.select().from(s.services).where(eq(s.services.id, existing));
    expect(kept).toMatchObject({ cost: '4.0000', name: 'Our Apple' });
    for (const id of [gone, credits, samsung]) {
      expect(
        await db.select().from(s.serviceSupplierLinks).where(eq(s.serviceSupplierLinks.supplierServiceId, id)),
      ).toEqual([]);
    }
    expect(await db.select({ n: count() }).from(s.services)).toEqual([{ n: 4 }]);

    expect(await catalogVersionOf(t)).not.toBe(version);
    const [end] = (await quickAuditRows(supplierId)).slice(-1);
    expect(end).toMatchObject({ action: 'quick added services from', actorType: 'system', actorId: null });
    expect(end!.after).toEqual({
      runId: started.body.id,
      requestedBy: staff.staffId,
      scope: 'groups',
      status: 'succeeded',
      total: 3,
      created: 3,
      skipped: 0,
      failed: 0,
      categoriesCreated: 2,
      createdWithQuantity: 1,
      serviceStatus: 'active',
    });
    expect(await quickAuditRows(supplierId)).toHaveLength(2);
  });

  it('adds the services switched off when asked, and a new run can follow a finished one', async () => {
    const supplierId = await newSupplier();
    await seedGroups(supplierId);
    const first = await startGroups(supplierId, [GROUP_APPLE], { serviceStatus: 'disabled' });
    await runner.run(first.body.id);
    const rows = await servicesOf(supplierId);
    expect(rows).toHaveLength(3);
    expect(rows.every((row) => row.service.status === 'disabled')).toBe(true);
    // The same scope again has nothing left to add.
    const again = await startGroups(supplierId, [GROUP_APPLE]);
    expect(again.status).toBe(422);
    expect((await startGroups(supplierId, [{ type: 'IMEI', remoteGroup: 'Samsung' }])).status).toBe(202);
  });

  it('does nothing when the run is called again, and creates each service once when two runners call it at the same moment', async () => {
    const supplierId = await newSupplier();
    await seedGroups(supplierId);
    const started = await startGroups(supplierId);
    const outcomes = await Promise.all([runner.run(started.body.id), runner.run(started.body.id)]);
    expect([...outcomes].sort()).toEqual(['not_queued', 'succeeded']);
    expect(await servicesOf(supplierId)).toHaveLength(3);
    expect(await runner.run(started.body.id)).toBe('not_queued');
    expect(await servicesOf(supplierId)).toHaveLength(3);
    expect(await db.select({ n: count() }).from(s.services)).toEqual([{ n: 3 }]);
    expect(await quickAuditRows(supplierId)).toHaveLength(2);
    expect(await runner.run(999999)).toBe('not_queued');
  });

  it('runs once through the processor with an outbox-shaped job', async () => {
    const supplierId = await newSupplier();
    await seedGroups(supplierId);
    const started = await startGroups(supplierId);
    const [event] = await outboxOf();
    const processor = new QuickAddProcessor(runner);
    const job = {
      data: {
        eventId: event!.id,
        type: 'supplier.quick_add',
        aggregateType: 'supplier_import_runs',
        aggregateId: started.body.id,
        payload: { runId: started.body.id, supplierId },
        requestId: `outbox-${event!.id}`,
      },
    } as never;
    expect(await processor.process(job)).toBe('succeeded');
    expect(await servicesOf(supplierId)).toHaveLength(3);
    expect(await processor.process(job)).toBe('not_queued');
    expect(() => processor.process({ data: { aggregateId: 0 } } as never)).toThrow('no run id');
  });

  it('takes the services of one supplier only, even when another supplier lists the same group', async () => {
    const supplierId = await newSupplier();
    const other = await newSupplier();
    await seedGroups(supplierId);
    await remote(other);
    const started = await startGroups(supplierId);
    await runner.run(started.body.id);
    expect(await servicesOf(supplierId)).toHaveLength(3);
    expect(await servicesOf(other)).toHaveLength(0);
  });

  it('takes a service whose type the supplier writes with another case and spaces, as the import does', async () => {
    const supplierId = await newSupplier();
    const loose = await remote(supplierId, { remoteGroup: 'Loose', type: ' Imei ' });
    const started = await startGroups(supplierId, [{ type: ' Imei ', remoteGroup: 'Loose' }]);
    expect(started.body.total).toBe(1);
    await runner.run(started.body.id);
    const [row] = await servicesOf(supplierId);
    expect(row!.remote.id).toBe(loose);
    expect(row!.service.type).toBe('imei');
    const groups = await staff.get(`/admin/suppliers/${supplierId}/service-groups`);
    expect(groups.body.groups).toEqual([
      { type: ' Imei ', remoteGroup: 'Loose', total: 1, addable: 0, imported: 1, unavailable: 0, unsupported: 0 },
    ]);
  });

  it('counts a group name that differs only by case as another group and finds the category of the same name once', async () => {
    const supplierId = await newSupplier();
    const first = await remote(supplierId, { remoteGroup: 'Apple', name: 'A' });
    const second = await remote(supplierId, { remoteGroup: 'APPLE', name: 'B' });
    const started = await startGroups(supplierId, [GROUP_APPLE, { type: 'IMEI', remoteGroup: 'APPLE' }]);
    expect(started.body.total).toBe(2);
    await runner.run(started.body.id);
    const rows = await servicesOf(supplierId);
    expect(rows.map((row) => row.remote.id)).toEqual([first, second]);
    // The category lookup ignores case, as the import's does: both services share one category.
    expect(rows[0]!.service.categoryId).toBe(rows[1]!.service.categoryId);
    expect(await runRow(started.body.id)).toMatchObject({ categoriesCreated: 1, createdCount: 2 });
  });
});

describe('the run of a quick add for all services', () => {
  it('adds 250 candidates in three chunks and sets the total', async () => {
    const supplierId = await newSupplier();
    await db.insert(s.supplierServices).values(
      Array.from({ length: 250 }, (_, i) => ({
        supplierId,
        remoteId: `bulk-${i}`,
        remoteGroup: `Group ${i % 5}`,
        type: 'IMEI',
        name: `Bulk ${i}`,
        credit: '2.0000',
      })),
    );
    const started = await staff.post(startUrl(supplierId), { scope: 'all' });
    expect(started.body.total).toBe(250);
    const chunks = spyOn(runner as unknown as { createIn: () => Promise<void> }, 'createIn');
    try {
      expect(await runner.run(started.body.id)).toBe('succeeded');
      expect(chunks).toHaveBeenCalledTimes(3);
    } finally {
      chunks.mockRestore();
    }
    expect(await servicesOf(supplierId)).toHaveLength(250);
    expect(await runRow(started.body.id)).toMatchObject({
      total: 250,
      createdCount: 250,
      skippedCount: 0,
      failedCount: 0,
      categoriesCreated: 5,
      status: 'succeeded',
    });
  });

  it('counts the candidates again when it starts: a service that became unavailable after the start is left out', async () => {
    const supplierId = await newSupplier();
    const ids = await seedGroups(supplierId);
    const started = await staff.post(startUrl(supplierId), { scope: 'all' });
    expect(started.body.total).toBe(5);
    await db.update(s.supplierServices).set({ isAvailable: false }).where(eq(s.supplierServices.id, ids.samsung));
    await runner.run(started.body.id);
    expect(await runRow(started.body.id)).toMatchObject({ total: 4, createdCount: 4, skippedCount: 0 });
  });

  it('re-checks every item inside the chunk that creates it', async () => {
    const supplierId = await newSupplier();
    const ids = await seedGroups(supplierId);
    const started = await staff.post(startUrl(supplierId), { scope: 'all' });
    const claimed = (await claimRun(db, started.body.id, clock.now()))!;
    // The list was built a moment ago; since then one service went away, one was imported by hand and one is gone.
    await db.update(s.supplierServices).set({ isAvailable: false }).where(eq(s.supplierServices.id, ids.apple[0]!));
    await importedBy(ids.apple[1]!);
    await db.update(s.supplierServices).set({ type: 'Credits' }).where(eq(s.supplierServices.id, ids.noGroup));
    const staleList = [...ids.apple, ids.samsung, ids.noGroup, 999999];
    await (runner as unknown as { createIn: (...args: unknown[]) => Promise<void> }).createIn(claimed, staleList, 1440);
    expect(await runRow(started.body.id)).toMatchObject({ createdCount: 2, skippedCount: 4 });
    expect(await db.select({ n: count() }).from(s.services)).toEqual([{ n: 3 }]);
  });

  it('finishes the run it has when the supplier is switched off after the start', async () => {
    const supplierId = await newSupplier();
    await seedGroups(supplierId);
    const started = await staff.post(startUrl(supplierId), { scope: 'all' });
    await db.update(s.suppliers).set({ status: 'disabled' }).where(eq(s.suppliers.id, supplierId));
    expect(await runner.run(started.body.id)).toBe('succeeded');
  });
});

describe('services a quick add cannot create', () => {
  it('reports a bad supplier entry, creates the rest of its chunk, and keeps the failure at most once', async () => {
    const supplierId = await newSupplier();
    const good1 = await remote(supplierId, { name: 'Good 1' });
    const bad = await remote(supplierId, { name: 'Bad entry', credit: '-1.0000' });
    const good2 = await remote(supplierId, { name: 'Good 2' });
    const started = await staff.post(startUrl(supplierId), { scope: 'all' });
    expect(await runner.run(started.body.id)).toBe('succeeded');
    const run = (await staff.get(`${startUrl(supplierId)}/${started.body.id}`)).body;
    expect(run).toMatchObject({
      status: 'succeeded',
      total: 3,
      processed: 3,
      created: 2,
      skipped: 0,
      failed: 1,
      error: null,
    });
    expect(run.failures).toEqual([{ supplierServiceId: bad, name: 'Bad entry', reason: 'unexpected error' }]);
    expect((await servicesOf(supplierId)).map((row) => row.remote.id)).toEqual([good1, good2]);
    const [end] = (await quickAuditRows(supplierId)).slice(-1);
    expect(end!.after).toMatchObject({ status: 'succeeded', created: 2, failed: 1 });
  });

  it('stops the run as failed at 20 failed items and does not try the rest', async () => {
    const supplierId = await newSupplier();
    for (let i = 0; i < 20; i += 1) await remote(supplierId, { name: `Bad ${i}`, credit: '-1.0000' });
    for (let i = 0; i < 10; i += 1) await remote(supplierId, { name: `Good ${i}` });
    const started = await staff.post(startUrl(supplierId), { scope: 'all' });
    expect(await runner.run(started.body.id)).toBe('failed');
    const run = (await staff.get(`${startUrl(supplierId)}/${started.body.id}`)).body;
    expect(run).toMatchObject({
      status: 'failed',
      total: 30,
      processed: 20,
      created: 0,
      failed: 20,
      error: 'Too many services could not be added (20). The rest was not tried.',
    });
    expect(run.failures).toHaveLength(20);
    expect(run.finishedAt).not.toBeNull();
    expect(await servicesOf(supplierId)).toHaveLength(0);
    const [end] = (await quickAuditRows(supplierId)).slice(-1);
    expect(end!.after).toMatchObject({
      status: 'failed',
      failed: 20,
      error: 'Too many services could not be added (20). The rest was not tried.',
    });
    // Starting again continues with what is left: the bad entries still fail, the good ones are added.
    for (const bad of await db.select().from(s.supplierServices).where(eq(s.supplierServices.credit, '-1.0000'))) {
      await db.update(s.supplierServices).set({ credit: '1.0000' }).where(eq(s.supplierServices.id, bad.id));
    }
    const again = await staff.post(startUrl(supplierId), { scope: 'all' });
    expect(again.status).toBe(202);
    await runner.run(again.body.id);
    expect(await servicesOf(supplierId)).toHaveLength(30);
  });

  it('does not stop at 19 failed items and lists all of them', async () => {
    const supplierId = await newSupplier();
    for (let i = 0; i < 19; i += 1) await remote(supplierId, { name: `Bad ${i}`, credit: '-1.0000' });
    await remote(supplierId, { name: 'Good' });
    const started = await staff.post(startUrl(supplierId), { scope: 'all' });
    expect(await runner.run(started.body.id)).toBe('succeeded');
    const run = await runRow(started.body.id);
    expect(run).toMatchObject({ failedCount: 19, createdCount: 1, status: 'succeeded' });
    expect(run.failures).toHaveLength(19);
  });
});

describe('the run against the picker import and against a newer start', () => {
  it('creates one service and one link per supplier service when the picker imports the same ones at the same moment', async () => {
    const supplierId = await newSupplier();
    const ids = await seedGroups(supplierId);
    const picked = [...ids.apple, ids.samsung];
    const started = await staff.post(startUrl(supplierId), { scope: 'all' });
    const [outcome, imported] = await Promise.all([
      runner.run(started.body.id),
      staff.post(`/admin/suppliers/${supplierId}/import`, { supplierServiceIds: picked }),
    ]);
    expect(outcome).toBe('succeeded');
    expect(imported.status).toBe(200);
    const links = await db
      .select({ supplierServiceId: s.serviceSupplierLinks.supplierServiceId, n: count() })
      .from(s.serviceSupplierLinks)
      .groupBy(s.serviceSupplierLinks.supplierServiceId);
    expect(links).toHaveLength(5);
    expect(links.every((row) => row.n === 1)).toBe(true);
    expect(await db.select({ n: count() }).from(s.services)).toEqual([{ n: 5 }]);
    const run = await runRow(started.body.id);
    // Whatever the picker took first is counted by the picker, not by the run: nothing is created twice.
    expect(run.createdCount + (imported.body.created as number)).toBe(5);
  });

  it('closes a stalled run at the next start, rolls back the old runner, and adds only what is left', async () => {
    const supplierId = await newSupplier();
    const ids = await seedGroups(supplierId);
    const first = await staff.post(startUrl(supplierId), { scope: 'all' });
    const claimed = (await claimRun(db, first.body.id, clock.now()))!;
    expect(claimed.status).toBe('running');

    clock.advance(6 * MINUTE);
    const shown = await staff.get(`${startUrl(supplierId)}/${first.body.id}`);
    expect(shown.body).toMatchObject({
      status: 'failed',
      finishedAt: null,
      error: 'The run stopped before it finished. Start it again: it continues with what is left.',
    });
    expect((await runRow(first.body.id)).status).toBe('running'); // a read never writes

    const second = await staff.post(startUrl(supplierId), { scope: 'all' });
    expect(second.status).toBe(202);
    const closed = await runRow(first.body.id);
    expect(closed).toMatchObject({
      status: 'failed',
      error: 'The run stopped before it finished. Start it again: it continues with what is left.',
    });
    expect(closed.finishedAt).not.toBeNull();
    const starts = (await quickAuditRows(supplierId)).filter((row) => row.action === 'started quick add from');
    expect(starts[1]!.after).toMatchObject({
      runId: second.body.id,
      closedStalledRun: { runId: first.body.id, created: 0, skipped: 0, failed: 0, total: 5 },
    });
    expect(starts[0]!.after).not.toHaveProperty('closedStalledRun');

    // The old runner's next chunk finds its run closed: it creates nothing and its transaction rolls back.
    const createIn = (runner as unknown as { createIn: (...args: unknown[]) => Promise<void> }).createIn.bind(runner);
    await expectRejection(createIn(claimed, [ids.samsung], 1440), /closed by a newer start/);
    expect(await servicesOf(supplierId)).toHaveLength(0);

    // Two services come in by hand (the picker), then the new run adds only what is left.
    const picked = await staff.post(`/admin/suppliers/${supplierId}/import`, {
      supplierServiceIds: [ids.apple[0], ids.apple[1]],
    });
    expect(picked.body.created).toBe(2);
    expect(await runner.run(second.body.id)).toBe('succeeded');
    expect(await runRow(second.body.id)).toMatchObject({
      total: 3,
      createdCount: 3,
      skippedCount: 0,
      status: 'succeeded',
    });
    expect(await servicesOf(supplierId)).toHaveLength(5);
    // The closed run is not touched again, and has no end audit row of its own.
    expect(await runner.run(first.body.id)).toBe('not_queued');
    const ends = (await quickAuditRows(supplierId)).filter((row) => row.action === 'quick added services from');
    expect(ends).toHaveLength(1);
    expect(ends[0]!.after).toMatchObject({ runId: second.body.id });
  });

  it('writes nothing when the old runner reaches its close after a newer start closed the run', async () => {
    const supplierId = await newSupplier();
    await seedGroups(supplierId);
    const first = await staff.post(startUrl(supplierId), { scope: 'all' });
    const claimed = (await claimRun(db, first.body.id, clock.now()))!;
    clock.advance(6 * MINUTE);
    expect((await staff.post(startUrl(supplierId), { scope: 'all' })).status).toBe(202);
    const close = (runner as unknown as { close: (...args: unknown[]) => Promise<string> }).close.bind(runner);
    expect(await close(claimed, 'succeeded', null)).toBe('stopped');
    expect(await runRow(first.body.id)).toMatchObject({ status: 'failed' });
    expect((await quickAuditRows(supplierId)).filter((row) => row.action === 'quick added services from')).toHaveLength(
      0,
    );
  });

  it('does not close a live run that moved within five minutes, and moves the heartbeat with every chunk', async () => {
    const supplierId = await newSupplier();
    await seedGroups(supplierId);
    const first = await staff.post(startUrl(supplierId), { scope: 'all' });
    clock.advance(4 * MINUTE);
    const claimed = (await claimRun(db, first.body.id, clock.now()))!;
    expect(claimed.heartbeatAt.getTime()).toBe(clock.nowMs());
    clock.advance(4 * MINUTE);
    // Eight minutes after the start, but four after the claim: still live.
    expect((await staff.get(`${startUrl(supplierId)}/${first.body.id}`)).body.status).toBe('running');
    expect((await staff.post(startUrl(supplierId), { scope: 'all' })).status).toBe(409);
  });
});

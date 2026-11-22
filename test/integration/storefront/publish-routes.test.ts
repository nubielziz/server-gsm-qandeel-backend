// The bulk publish's routes (feature 31, plan 31 sections 3.2, 5.2, 6.1, 6.5 and 8.3). Slice B4a, the first paragraph: POST for each
// scope, the refusals, the outbox event, the prepare job (detection, evaluation, ticks, slugs, prices), "a preview changes nothing", the
// lists and the stalled reads, and "Check again". Slice B4b, the second paragraph: the row's PATCH, bulk, apply with the resume, cancel
// and the run switch, with their permissions and the races of 6.5.
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
import { AppError } from '@src/common/errors';
import { type Database, DbService, type Transaction, schema as s } from '@src/infra/db';
import { OutboxRouteRegistry } from '@src/modules/platform';
import { jobDataOf } from '@src/modules/platform/outbox/outbox-payload';
import { PublishDraftFacts } from '@src/modules/storefront/publish/application/publish-draft-facts';
import {
  PUBLISH_APPLY_EVENT,
  PUBLISH_JOBS,
  PUBLISH_PREPARE_EVENT,
  PUBLISH_SET_LISTED_EVENT,
} from '@src/modules/storefront/publish/application/publish-outbox';
import {
  PublishPreparer,
  SCOPE_TRUNCATED_ERROR,
  scopeTruncatedError,
} from '@src/modules/storefront/publish/application/publish-preparer';
import { PublishRunner } from '@src/modules/storefront/publish/application/publish-runner';
import { PublishSwitch } from '@src/modules/storefront/publish/application/publish-switch';
import { PublishRunAdminService } from '@src/modules/storefront/publish/application/publish-run-admin.service';
import { collectScope } from '@src/modules/storefront/publish/application/publish-scope';
import { BLOCK_SENTENCES } from '@src/modules/storefront/publish/domain/publish-edit';
import {
  PREPARE_STALLED_ERROR,
  PUBLISH_CHUNK,
  STALLED_ERROR,
  SWITCH_STALLED_ERROR,
} from '@src/modules/storefront/publish/domain/publish-item';
import {
  beatPrepare,
  beatSwitch,
  claimPrepare,
  claimSwitch,
  closePrepare,
  closeSwitch,
} from '@src/modules/storefront/publish/infra/publish.repository';
import { PublishPrepareProcessor } from '@src/modules/storefront/publish/jobs/publish.processors';
import { type AdminApi, adminWith } from '../../support/admin-api';
import { type TestApp, createTestApp } from '../../support/app';
import { clearIdentityCaches } from '../../support/auth';
import { insertCategory, insertService, insertSupplierLink } from '../../support/catalog';
import { MINUTE, TestClock } from '../../support/clock';
import { closeTestDb, resetDb, testDb } from '../../support/db';
import { eventually } from '../../support/infra';
import { insertUsd } from '../../support/fixtures';
import { catalogVersionOf, insertDemoGroups } from '../../support/pricing';
import { seedRun } from '../../support/publish';
import { expectRejection } from '../../support/rejection';
import { insertListingRow, insertRetailPrice } from '../../support/storefront';

setDefaultTimeout(60_000);

const START = '2026-11-18T09:00:00.000Z';
const clock = new TestClock(START);
let t: TestApp;
let db: Database;
let admin: AdminApi;
let preparer: PublishPreparer;

beforeAll(async () => {
  t = await createTestApp({ clock });
  ({ db } = await testDb());
  preparer = t.app.get(PublishPreparer, { strict: false });
});
beforeEach(async () => {
  clock.set(START);
  await resetDb();
  await clearIdentityCaches(t);
  admin = await adminWith(t, ['pricing:*', 'storefront:*', 'catalog:*'], { name: 'Rami K.' });
});
afterEach(() => {
  mock.restore();
});
afterAll(async () => {
  await resetDb();
  await clearIdentityCaches(t);
  await t.close();
  await closeTestDb();
});

/** IMEI +30 %, ends in .99 from $5: cost 10.0000 (floor 11.66) gives 13.99. */
const IMEI_30 = { scope: 'type', serviceType: 'imei', percent: '30', rounding: 'ends_99' } as const;

/** An archived service is a disabled one with the time it was archived (the `services_archived_check`). */
const ARCHIVED = { status: 'disabled', archivedAt: new Date(START) } as const;

interface World {
  readonly groups: Awaited<ReturnType<typeof insertDemoGroups>>;
  readonly categoryId: number;
}

/** USD, the demo groups (the last is the retail group) and a category open to every group. */
async function world(): Promise<World> {
  await insertUsd(db);
  const groups = await insertDemoGroups(db);
  const categoryId = await insertCategory(db, { name: 'Carrier unlock' });
  return { groups, categoryId };
}

const makeRule = async () => {
  const res = await admin.post('/admin/retail-price-rules', IMEI_30);
  expect(res.status).toBe(201);
};

interface Made {
  readonly name?: string;
  readonly categoryId?: number;
  /** `none`: no link; `paused`: an inactive link; default: an active link to an active supplier. */
  readonly link?: 'none' | 'paused';
  readonly values?: Partial<typeof s.services.$inferInsert>;
}

/** A live IMEI service at cost 10.0000 (base price cost + 6 %, floor 11.66), fulfilled automatically through an active link. */
async function service(w: World, made: Made = {}): Promise<number> {
  const id = await insertService(db, made.categoryId ?? w.categoryId, {
    ...(made.name === undefined ? {} : { name: made.name }),
    basePrice: '10.6000',
    cost: '10.0000',
    effectiveCost: '10.0000',
    ...made.values,
  });
  if (made.link !== 'none') await insertSupplierLink(db, id, { isActive: made.link !== 'paused' });
  return id;
}

/** `n` services with plain, different names. */
async function several(w: World, n: number, categoryId = w.categoryId): Promise<number[]> {
  const ids: number[] = [];
  for (let i = 0; i < n; i += 1) {
    ids.push(await service(w, { categoryId, name: `Apple iPhone ${i + 1} Activation Lock Remove`, values: {} }));
  }
  return ids;
}

const post = (body: unknown) => admin.post('/admin/publish-runs', body);

/** POSTs a run and prepares it in the worker's place. */
async function prepared(body: unknown): Promise<number> {
  const res = await post(body);
  expect(res.status).toBe(202);
  expect(await preparer.run(res.body.id)).toMatch(/^(draft|queued)$/);
  return res.body.id;
}

async function itemsOf(runId: number, query = '') {
  const res = await admin.get(`/admin/publish-runs/${runId}/items?_start=0&_end=1000${query}`);
  expect(res.status).toBe(200);
  return res.body as Array<Record<string, any>>; // eslint-disable-line @typescript-eslint/no-explicit-any -- untyped JSON
}

const itemOf = async (runId: number, serviceId: number) => {
  const rows = await itemsOf(runId);
  const row = rows.find((item) => item.serviceId === serviceId);
  expect(row).toBeDefined();
  return row!;
};

const runRow = async (runId: number) =>
  (await db.select().from(s.listingPublishRuns).where(eq(s.listingPublishRuns.id, runId)))[0]!;

const auditsOf = (action: string) => db.select().from(s.auditLogs).where(eq(s.auditLogs.action, action));

const eventsOf = (type: string) => db.select().from(s.outboxEvents).where(eq(s.outboxEvents.type, type));

/** The rows of the tables a preview must not touch, and the catalog price version. */
async function snapshot() {
  const [row] = await db
    .select({
      services: sql<number>`(select count(*) from ${s.services})::int`,
      listings: sql<number>`(select count(*) from ${s.serviceListings})::int`,
      prices: sql<number>`(select count(*) from ${s.serviceGroupPrices})::int`,
      follows: sql<number>`(select count(*) from ${s.retailPriceFollows})::int`,
      listingEvents: sql<number>`(select count(*) from ${s.outboxEvents} where type = 'storefront.listing_changed')::int`,
      audits: sql<number>`(select count(*) from ${s.auditLogs})::int`,
    })
    .from(sql`(select 1) as one`);
  return { ...row!, version: await catalogVersionOf(t) };
}

describe('POST /admin/publish-runs: the scopes', () => {
  it('a category: the live services without a listing, as a run in preparing, with its event and no audit row', async () => {
    const w = await world();
    const ids = await several(w, 3);
    const other = await insertCategory(db, { name: 'Other' });
    await several(w, 1, other);
    await service(w, { values: ARCHIVED });
    const listed = await service(w, { name: 'Listed already' });
    await insertListingRow(db, listed);

    const res = await post({ scope: { kind: 'category', categoryId: w.categoryId } });

    expect(res.status).toBe(202);
    expect(res.body).toMatchObject({
      status: 'preparing',
      source: 'console',
      quickAddRunId: null,
      scope: { kind: 'category', categoryId: w.categoryId },
      listed: true,
      auto: false,
      total: ids.length,
      requestedBy: admin.staffId,
      requestedByName: 'Rami K.',
      replacedBy: null,
      error: null,
      preparedAt: null,
      startedAt: null,
      finishedAt: null,
    });
    expect(res.body.counts).toEqual({
      ready: 0,
      review: 0,
      blocked: 0,
      included: 0,
      noRule: 0,
      published: 0,
      skipped: 0,
      refused: 0,
      pending: 0,
    });
    expect(res.body.switch).toEqual({ status: null, listed: null, switched: 0, skipped: 0, error: null });
    const [event] = await eventsOf(PUBLISH_PREPARE_EVENT);
    expect(event).toMatchObject({ aggregateType: 'listing_publish_runs', aggregateId: res.body.id });
    expect(jobDataOf(event!).payload).toEqual({ runId: res.body.id });
    expect(await auditsOf('cancelled publishing run')).toHaveLength(0);
    expect(await db.select().from(s.listingPublishItems)).toHaveLength(0);
  });

  it('the rows of a category are the unlisted live services (a listing that is switched off still counts as a listing)', async () => {
    const w = await world();
    await makeRule();
    const ids = await several(w, 4);
    await insertListingRow(db, ids[0]!, { isListed: false });
    await db.update(s.services).set(ARCHIVED).where(eq(s.services.id, ids[1]!));

    const id = await prepared({ scope: { kind: 'category', categoryId: w.categoryId } });

    expect((await itemsOf(id)).map((item) => item.serviceId)).toEqual([ids[2]!, ids[3]!]);
    expect((await admin.get(`/admin/publish-runs/${id}`)).body.total).toBe(2);
  });

  it('services: the ticked services, repeats dropped, an archived one dropped, a listed one kept as a blocked row', async () => {
    const w = await world();
    await makeRule();
    const [a, b, c, d] = await several(w, 4);
    await db.update(s.services).set(ARCHIVED).where(eq(s.services.id, d!));
    await insertListingRow(db, c!);

    const res = await post({ scope: { kind: 'services', serviceIds: [c, a, a, b, d, 999_999] } });

    expect(res.status).toBe(202);
    expect(res.body.scope).toEqual({ kind: 'services', serviceIds: [c, a, b, d, 999_999] });
    expect(res.body.total).toBe(3);
    await preparer.run(res.body.id);
    const rows = await itemsOf(res.body.id);
    expect(rows.map((row) => row.serviceId)).toEqual([a!, b!, c!]);
    const listedRow = rows.find((row) => row.serviceId === c)!;
    expect(listedRow).toMatchObject({ state: 'blocked', blockedReason: 'already_listed', included: false });
  });

  it('a supplier: the live services linked to one of its services, once each', async () => {
    const w = await world();
    await makeRule();
    const [a, b, c] = await several(w, 3);
    const first = await insertSupplierLink(db, a!, { supplier: 'Supplier A' });
    // b is linked twice to the same supplier (two of its services) and c only to another supplier.
    const [extra] = await db
      .insert(s.supplierServices)
      .values({ supplierId: first.supplierId, remoteId: 'second', type: 'IMEI', name: 'Second', credit: '1' })
      .returning({ id: s.supplierServices.id });
    await db.insert(s.serviceSupplierLinks).values([
      { serviceId: b!, supplierServiceId: first.supplierServiceId },
      { serviceId: b!, supplierServiceId: extra!.id },
    ]);
    await insertSupplierLink(db, c!, { supplier: 'Supplier B' });

    const id = await prepared({ scope: { kind: 'supplier', supplierId: first.supplierId } });

    expect((await itemsOf(id)).map((item) => item.serviceId)).toEqual([a!, b!]);
  });

  it('all: every live service without a listing; and a copy-free run says its scope back', async () => {
    const w = await world();
    await makeRule();
    const ids = await several(w, 2);
    const other = await insertCategory(db, { name: 'Other' });
    const more = await several(w, 1, other);
    const res = await post({ scope: { kind: 'all' }, listed: false });
    expect(res.body).toMatchObject({ scope: { kind: 'all' }, listed: false, total: 3 });
    await preparer.run(res.body.id);
    expect((await itemsOf(res.body.id)).map((item) => item.serviceId)).toEqual([...ids, ...more]);
  });

  it('refuses a scope with nothing to publish, also when every ticked service has a listing, and creates no run', async () => {
    const w = await world();
    const [a] = await several(w, 1);
    await insertListingRow(db, a!);
    const emptyCategory = await insertCategory(db, { name: 'Empty' });

    for (const scope of [
      { kind: 'category', categoryId: w.categoryId },
      { kind: 'category', categoryId: emptyCategory },
      { kind: 'services', serviceIds: [999_999] },
      { kind: 'services', serviceIds: [a!] },
      { kind: 'services', serviceIds: [a!, 999_999] },
    ]) {
      const res = await post({ scope });
      expect(res.status).toBe(422);
      expect(res.body.errors).toEqual([
        {
          field: 'scope',
          code: 'nothing_to_publish',
          message: 'Nothing to publish: every service of this choice is already on the shop.',
        },
      ]);
    }
    expect(await db.select().from(s.listingPublishRuns)).toHaveLength(0);
    expect(await eventsOf(PUBLISH_PREPARE_EVENT)).toHaveLength(0);
  });

  it('refuses a scope over the limit (a lowered limit through the test seam), naming the number', async () => {
    const w = await world();
    await several(w, 3);
    const service = t.app.get(PublishRunAdminService, { strict: false });

    const error = await expectRejection(service.create(admin.staffId, { scope: { kind: 'all' } }, { maxItems: 2 }));
    expect(error).toMatchObject({ code: 'VALIDATION_FAILED' });
    expect((error as AppError).errors).toEqual([
      {
        field: 'scope',
        code: 'too_many',
        message: 'This choice has 3 services. A run takes at most 2: pick a category or a supplier.',
      },
    ]);
    // At the limit it is accepted.
    const ok = await service.create(admin.staffId, { scope: { kind: 'all' } }, { maxItems: 3 });
    expect(ok.total).toBe(3);
    expect(await db.select().from(s.listingPublishRuns)).toHaveLength(1);
  });

  it('refuses a category, a supplier, a Quick add run and a publish run that do not exist, on the field', async () => {
    await world();
    const cases: Array<[unknown, string]> = [
      [{ kind: 'category', categoryId: 999_999 }, 'scope.categoryId'],
      [{ kind: 'supplier', supplierId: 999_999 }, 'scope.supplierId'],
      [{ kind: 'quickAddRun', runId: 999_999 }, 'scope.runId'],
      [{ kind: 'run', runId: 999_999 }, 'scope.runId'],
    ];
    for (const [scope, field] of cases) {
      const res = await post({ scope });
      expect(res.status).toBe(422);
      expect(res.body.errors).toEqual([expect.objectContaining({ field, code: 'invalid' })]);
    }
    expect(await db.select().from(s.listingPublishRuns)).toHaveLength(0);
  });

  it('refuses a malformed request: an unknown key, no scope, an empty or too long list of services', async () => {
    const w = await world();
    const bodies = [
      { scope: { kind: 'all' }, extra: 1 },
      { scope: { kind: 'all', extra: 1 } },
      {},
      { scope: { kind: 'services', serviceIds: [] } },
      { scope: { kind: 'services', serviceIds: Array.from({ length: 501 }, (_, i) => i + 1) } },
      { scope: { kind: 'category' } },
      { scope: { kind: 'nothing' } },
      { scope: { kind: 'all' }, listed: 'yes' },
    ];
    for (const body of bodies) expect((await post(body)).status).toBe(422);
    expect(w.categoryId).toBeGreaterThan(0);
  });

  it('needs storefront:create to start a run and storefront:read to read one', async () => {
    const w = await world();
    await several(w, 1);
    const reader = await adminWith(t, ['storefront:read']);
    expect((await reader.post('/admin/publish-runs', { scope: { kind: 'all' } })).status).toBe(403);
    const writer = await adminWith(t, ['storefront:create']);
    const made = await writer.post('/admin/publish-runs', { scope: { kind: 'all' } });
    expect(made.status).toBe(202);
    expect((await writer.get('/admin/publish-runs')).status).toBe(403);
    expect((await writer.get(`/admin/publish-runs/${made.body.id}/items`)).status).toBe(403);
    expect((await reader.get(`/admin/publish-runs/${made.body.id}`)).status).toBe(200);
    expect((await admin.anonymous('GET', '/admin/publish-runs')).status).toBe(401);
    expect((await admin.withoutCsrf('POST', '/admin/publish-runs', { scope: { kind: 'all' } })).status).toBe(403);
  });
});

describe('the prepare job', () => {
  it('names and evaluates every row: the title, the slug, the facts, the price of the rule and the default ticks', async () => {
    const w = await world();
    await makeRule();
    const att = await service(w, { name: 'AT&T USA Premier Unlock' });
    const apple = await service(w, { name: 'Apple iPhone Activation Lock Remove' });
    const empty = await service(w, { name: '\u0627\u0644\u062e\u062f\u0645\u0629' });

    const id = await prepared({ scope: { kind: 'all' } });

    expect(await itemOf(id, att)).toMatchObject({
      title: 'AT&T USA Premier Unlock',
      slug: 'att-usa-premier-unlock',
      brand: '',
      carrier: 'AT&T',
      country: 'US',
      detected: { title: 'AT&T USA Premier Unlock', slug: 'att-usa-premier-unlock', brand: '', brandKind: null },
      edited: false,
      cost: '10.0000',
      floorPrice: '11.6600',
      rule: { label: expect.stringContaining('IMEI') },
      rulePrice: '13.9900',
      retailPrice: '13.9900',
      marginPct: '28.5204',
      priceMode: 'rule',
      existingPrice: null,
      replacesPrice: null,
      state: 'ready',
      blockedReason: null,
      flags: ['no_brand'],
      included: true,
      result: null,
      listingId: null,
      listingListed: null,
      service: { id: att, name: 'AT&T USA Premier Unlock', type: 'imei', categoryName: 'Carrier unlock' },
    });
    expect(await itemOf(id, apple)).toMatchObject({
      title: 'Apple iPhone Activation Lock Remove',
      brand: 'Apple',
      state: 'ready',
      flags: [],
      included: true,
    });
    // A name with no Latin word has no title: it waits for a person, and a blocked row is never ticked.
    expect(await itemOf(id, empty)).toMatchObject({
      title: '',
      slug: '',
      state: 'blocked',
      blockedReason: 'title_missing',
      included: false,
    });
    const run = (await admin.get(`/admin/publish-runs/${id}`)).body;
    expect(run).toMatchObject({ status: 'draft', total: 3 });
    expect(run.counts).toMatchObject({ ready: 2, review: 0, blocked: 1, included: 2, noRule: 0, pending: 3 });
    expect(run.preparedAt).toBe(START);
    expect((await runRow(id)).prepareClaimedAt).not.toBeNull();
  });

  it('two services with one supplier name wait in review, unticked, and the second gets the slug -2', async () => {
    const w = await world();
    await makeRule();
    const [first, second] = [
      await service(w, { name: 'Samsung Galaxy KG Lock Remove' }),
      await service(w, { name: 'Samsung Galaxy KG Lock Remove' }),
    ];
    const id = await prepared({ scope: { kind: 'all' } });

    const a = await itemOf(id, first);
    const b = await itemOf(id, second);
    expect(a).toMatchObject({ slug: 'samsung-galaxy-kg-lock-remove', state: 'review', included: false });
    expect(a.flags).toContain('duplicate_name');
    expect(b).toMatchObject({ slug: 'samsung-galaxy-kg-lock-remove-2', state: 'review', included: false });
    expect(b.flags).toEqual(expect.arrayContaining(['duplicate_name', 'slug_suffixed']));
    expect((await admin.get(`/admin/publish-runs/${id}`)).body.counts).toMatchObject({ review: 2, included: 0 });
  });

  it('gives slugs that are free among the listings: the address of a listing is never proposed again', async () => {
    const w = await world();
    await makeRule();
    const holder = await service(w, { name: 'Holder' });
    await insertListingRow(db, holder, { slug: 'apple-iphone-activation-lock-remove', publicTitle: 'Something else' });
    const wanted = await service(w, { name: 'Apple iPhone Activation Lock Remove' });

    const id = await prepared({ scope: { kind: 'services', serviceIds: [wanted] } });

    expect(await itemOf(id, wanted)).toMatchObject({
      slug: 'apple-iphone-activation-lock-remove-2',
      state: 'ready',
      included: true,
    });
    expect((await itemOf(id, wanted)).flags).toContain('slug_suffixed');
  });

  it('a title a listing already has is a likely twin: the row waits (title_taken)', async () => {
    const w = await world();
    await makeRule();
    const holder = await service(w, { name: 'Holder' });
    await insertListingRow(db, holder, { slug: 'held', publicTitle: 'Apple iPhone Activation Lock Remove' });
    const twin = await service(w, { name: 'Apple iPhone Activation Lock Remove' });

    const id = await prepared({ scope: { kind: 'services', serviceIds: [twin] } });

    const row = await itemOf(id, twin);
    expect(row.flags).toContain('title_taken');
    expect(row).toMatchObject({ state: 'review', included: false });
  });

  it('keeps the retail price a service has: the mode is keep, the row says so and stays ready', async () => {
    const w = await world();
    await makeRule();
    const priced = await service(w, { name: 'Apple iPhone 14 Activation Lock Remove' });
    await insertRetailPrice(db, priced, w.groups.retail, '20.0000');

    const id = await prepared({ scope: { kind: 'all' } });

    expect(await itemOf(id, priced)).toMatchObject({
      priceMode: 'keep',
      existingPrice: '20.0000',
      replacesPrice: null,
      retailPrice: '20.0000',
      rulePrice: '13.9900',
      state: 'ready',
      included: true,
    });
    expect((await itemOf(id, priced)).flags).toContain('price_kept');
  });

  it('blocks what cannot be published, with the first reason that applies, and unticks it', async () => {
    const w = await world();
    await makeRule();
    const off = await insertCategory(db, { name: 'Switched off', isActive: false });
    const inactive = await service(w, { categoryId: off, name: 'In a closed category' });
    const disabled = await service(w, { name: 'Disabled service', values: { status: 'disabled' } });
    const fileCategory = await insertCategory(db, { name: 'Files', type: 'file' });
    const file = await service(w, { categoryId: fileCategory, name: 'A file service', values: { type: 'file' } });
    const unsupplied = await service(w, { name: 'No supplier at all', link: 'none' });
    const paused = await service(w, { name: 'A paused link', link: 'paused' });
    const free = await service(w, {
      name: 'Zero cost service',
      values: { cost: '0.0000', effectiveCost: '0.0000', basePrice: '0.1000' },
    });
    const b2bGroup = await insertCategory(db, { name: 'B2B only', allowedGroupIds: [w.groups.vip] });
    const b2b = await service(w, { categoryId: b2bGroup, name: 'Merchants only' });

    const id = await prepared({ scope: { kind: 'all' } });

    const expected: Array<[number, string, string[]]> = [
      [inactive, 'category_inactive', []],
      [disabled, 'service_disabled', []],
      [file, 'not_orderable', []],
      [unsupplied, 'supplier_unavailable', []],
      [paused, 'supplier_unavailable', []],
      [free, 'price_missing', ['no_cost']],
      [b2b, 'b2b_only', []],
    ];
    for (const [serviceId, reason, flags] of expected) {
      const row = await itemOf(id, serviceId);
      expect({ reason: row.blockedReason, state: row.state, included: row.included }).toEqual({
        reason,
        state: 'blocked',
        included: false,
      });
      for (const flag of flags) expect(row.flags).toContain(flag);
    }
    expect((await admin.get(`/admin/publish-runs/${id}`)).body.counts).toMatchObject({
      ready: 0,
      blocked: 7,
      included: 0,
    });
  });

  it('with no rule every row without a price waits for one (price_missing, no_rule), and Check again readies it after a rule', async () => {
    const w = await world();
    const ids = await several(w, 2);
    const priced = await service(w, { name: 'Apple iPhone Typed Price Activation Lock Remove' });
    await insertRetailPrice(db, priced, w.groups.retail, '20.0000');

    const first = await prepared({ scope: { kind: 'category', categoryId: w.categoryId } });

    for (const serviceId of ids) {
      const row = await itemOf(first, serviceId);
      expect(row).toMatchObject({ state: 'blocked', blockedReason: 'price_missing', included: false, rule: null });
      expect(row.flags).toContain('no_rule');
    }
    // A service that has a price needs no rule: its price is kept.
    expect(await itemOf(first, priced)).toMatchObject({ state: 'ready', priceMode: 'keep', included: true });
    expect((await admin.get(`/admin/publish-runs/${first}`)).body.counts).toMatchObject({
      noRule: 2,
      blocked: 2,
      ready: 1,
    });

    await makeRule();
    const again = await admin.post('/admin/publish-runs', { scope: { kind: 'run', runId: first } });
    expect(again.status).toBe(202);
    await preparer.run(again.body.id);

    for (const serviceId of ids) {
      expect(await itemOf(again.body.id, serviceId)).toMatchObject({
        state: 'ready',
        blockedReason: null,
        included: true,
        rulePrice: '13.9900',
      });
    }
    expect((await admin.get(`/admin/publish-runs/${again.body.id}`)).body.counts).toMatchObject({
      ready: 3,
      blocked: 0,
      included: 3,
      noRule: 0,
    });
  });

  it('a server service with a main-box field is named by the IMEI rules, and one without by the server rules', async () => {
    const w = await world();
    await makeRule();
    const serverCategory = await insertCategory(db, { name: 'Carrier unlock', type: 'server' });
    const named = 'Unlock AT&T USA Apple iPhone Clean';
    const boxed = await service(w, { categoryId: serverCategory, name: named, values: { type: 'server' } });
    const plain = await service(w, { categoryId: serverCategory, name: `${named} Plain`, values: { type: 'server' } });
    await db.insert(s.serviceFields).values({ serviceId: boxed, key: 'imei', label: 'IMEI', supplierKey: 'IMEI' });
    await db.insert(s.serviceFields).values({ serviceId: plain, key: 'note', label: 'Note', supplierKey: 'Memo' });
    const real = await service(w, { name: `${named} Real` });

    const id = await prepared({ scope: { kind: 'all' } });

    expect(await itemOf(id, boxed)).toMatchObject({ carrier: 'AT&T', brand: 'Apple', country: 'US' });
    expect(await itemOf(id, real)).toMatchObject({ carrier: 'AT&T', brand: 'Apple', country: 'US' });
    const without = await itemOf(id, plain);
    expect(without.carrier).toBe('');
    expect(without.brand).not.toBe('Apple');
    // The field's own key counts when its supplier key is empty.
    await db.update(s.serviceFields).set({ supplierKey: '', key: 'IMEI' }).where(eq(s.serviceFields.serviceId, plain));
    const later = await prepared({ scope: { kind: 'all' } });
    expect((await itemOf(later, plain)).carrier).toBe('AT&T');
  });

  it('a preview changes nothing a visitor or a merchant can see', async () => {
    const w = await world();
    await makeRule();
    const ids = await several(w, 3);
    await insertListingRow(db, ids[0]!);
    await insertRetailPrice(db, ids[1]!, w.groups.retail, '20.0000');
    const before = await snapshot();

    const id = await prepared({ scope: { kind: 'all' } });
    await admin.get('/admin/publish-runs');
    await admin.get(`/admin/publish-runs/${id}`);
    await itemsOf(id);

    expect(await snapshot()).toEqual(before);
    expect(await db.select().from(s.listingPublishItems)).toHaveLength(2);
  });

  it('"Check again" adds exactly one audit row, the cancel of the old draft, and nothing else', async () => {
    const w = await world();
    await makeRule();
    await several(w, 3);
    const first = await prepared({ scope: { kind: 'all' } });
    const before = await snapshot();

    const again = await admin.post('/admin/publish-runs', { scope: { kind: 'run', runId: first } });
    expect(again.status).toBe(202);
    await preparer.run(again.body.id);

    const after = await snapshot();
    expect({ ...after, audits: after.audits - 1 }).toEqual(before);
    const audits = await auditsOf('cancelled publishing run');
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      entityType: 'publish_run',
      entityId: first,
      entityLabel: `Publish run #${first}`,
      actorType: 'staff',
      actorId: admin.staffId,
      after: { status: 'cancelled', total: 3, published: 0, skipped: 0, refused: 0, replacedBy: again.body.id },
    });
  });

  it('is idempotent: a second call, a claimed run and a cancelled run do nothing', async () => {
    const w = await world();
    await makeRule();
    await several(w, 2);
    const res = await post({ scope: { kind: 'all' } });
    const runId = res.body.id as number;

    expect(await preparer.run(runId)).toBe('draft');
    const rows = await db.select().from(s.listingPublishItems);
    expect(await preparer.run(runId)).toBe('not_preparing');
    expect(await db.select().from(s.listingPublishItems)).toEqual(rows);

    const claimed = await post({ scope: { kind: 'all' } });
    await db
      .update(s.listingPublishRuns)
      .set({ prepareClaimedAt: new Date(START) })
      .where(eq(s.listingPublishRuns.id, claimed.body.id));
    expect(await preparer.run(claimed.body.id)).toBe('not_preparing');

    const cancelled = await post({ scope: { kind: 'all' } });
    await db
      .update(s.listingPublishRuns)
      .set({ status: 'cancelled' })
      .where(eq(s.listingPublishRuns.id, cancelled.body.id));
    expect(await preparer.run(cancelled.body.id)).toBe('not_preparing');
    expect(await preparer.run(999_999)).toBe('not_preparing');
  });

  it('runs once through its processor, from the outbox event', async () => {
    const w = await world();
    await makeRule();
    await several(w, 2);
    const res = await post({ scope: { kind: 'all' } });
    const [event] = await eventsOf(PUBLISH_PREPARE_EVENT);
    const job = { name: PUBLISH_JOBS.prepare, data: jobDataOf(event!) };
    const processor = new PublishPrepareProcessor(preparer);

    expect(await processor.process(job as never)).toBe('draft');
    expect(await processor.process(job as never)).toBe('not_preparing');

    expect((await runRow(res.body.id)).status).toBe('draft');
    expect(() => processor.process({ name: PUBLISH_JOBS.prepare, data: { aggregateId: 0 } } as never)).toThrow(
      'no run id',
    );
    const registry = t.app.get(OutboxRouteRegistry, { strict: false });
    expect(registry.routesOf(PUBLISH_PREPARE_EVENT)).toEqual([
      { type: PUBLISH_PREPARE_EVENT, queue: 'imports', jobName: 'publish_prepare' },
    ]);
  });

  it('closes the run failed with its error and rethrows when something unexpected happens; a half-evaluated draft is never prepared', async () => {
    const w = await world();
    await makeRule();
    await several(w, 2);
    const res = await post({ scope: { kind: 'all' } });
    spyOn(t.app.get(PublishDraftFacts, { strict: false }), 'read').mockRejectedValue(
      new Error('the price service is down'),
    );

    await expectRejection(preparer.run(res.body.id), /price service is down/);

    const run = await runRow(res.body.id);
    expect(run).toMatchObject({ status: 'failed', error: 'the price service is down', preparedAt: null });
    expect(run.finishedAt).not.toBeNull();
    expect((await admin.get(`/admin/publish-runs/${res.body.id}`)).body).toMatchObject({ status: 'failed' });
  });

  it('an automatic run with a row to publish closes queued with the apply event and the start audit row of the system', async () => {
    const w = await world();
    await makeRule();
    const ids = await several(w, 2);
    const run = await seedRun(t, [], {
      status: 'preparing',
      auto: true,
      source: 'quick_add',
      preparedAt: null,
      total: 0,
      scope: { kind: 'services', serviceIds: ids },
    });

    expect(await preparer.run(run.id)).toBe('queued');

    expect(await runRow(run.id)).toMatchObject({ status: 'queued', total: 2 });
    const [event] = await eventsOf(PUBLISH_APPLY_EVENT);
    expect(event).toMatchObject({ aggregateType: 'listing_publish_runs', aggregateId: run.id });
    const [audit] = await auditsOf('started publishing to the storefront');
    expect(audit).toMatchObject({
      entityType: 'publish_run',
      entityId: run.id,
      actorType: 'system',
      after: { total: 2, included: 2, listed: true, source: 'quick_add', resumed: false },
    });
  });

  it('an automatic run with nothing ticked stays a draft for staff, with no event', async () => {
    const w = await world();
    const ids = await several(w, 2);
    const run = await seedRun(t, [], {
      status: 'preparing',
      auto: true,
      source: 'quick_add',
      preparedAt: null,
      total: 0,
      scope: { kind: 'services', serviceIds: ids },
    });

    expect(await preparer.run(run.id)).toBe('draft');

    expect(await runRow(run.id)).toMatchObject({ status: 'draft', total: 2 });
    expect(await eventsOf(PUBLISH_APPLY_EVENT)).toHaveLength(0);
    expect(await auditsOf('started publishing to the storefront')).toHaveLength(0);
  });

  it('a scope over the most a run takes keeps the first ones', async () => {
    const w = await world();
    const ids = await several(w, 3);
    const { services, truncated } = await collectScope(db, { kind: 'all' }, 2);
    expect(services.map((row) => row.serviceId)).toEqual(ids.slice(0, 2));
    expect(truncated).toBe(true);
    expect((await collectScope(db, { kind: 'all' }, 3)).truncated).toBe(false);
  });
});

describe('reading runs', () => {
  it('lists runs newest first with x-total-count, filters, sorts and the name of who asked', async () => {
    const w = await world();
    await several(w, 2);
    const other = await adminWith(t, ['storefront:*'], { name: 'Dana S.' });
    const a = await post({ scope: { kind: 'all' } });
    clock.advance(MINUTE);
    const b = await other.post('/admin/publish-runs', { scope: { kind: 'all' } });
    clock.advance(MINUTE);
    const c = await post({ scope: { kind: 'all' } });
    await preparer.run(a.body.id);
    await db
      .update(s.listingPublishRuns)
      .set({ source: 'quick_add', sourceRunId: 77 })
      .where(eq(s.listingPublishRuns.id, c.body.id));

    const list = await admin.get('/admin/publish-runs');
    expect(list.status).toBe(200);
    expect(list.total).toBe(3);
    expect(list.body.map((run: { id: number }) => run.id)).toEqual([c.body.id, b.body.id, a.body.id]);
    expect(list.body.map((run: { requestedByName: string }) => run.requestedByName)).toEqual([
      'Rami K.',
      'Dana S.',
      'Rami K.',
    ]);

    const filtered = async (query: string) =>
      (await admin.get(`/admin/publish-runs?${query}`)).body.map((run: { id: number }) => run.id);
    expect(await filtered('status=draft')).toEqual([a.body.id]);
    expect(await filtered('status=preparing')).toEqual([c.body.id, b.body.id]);
    expect(await filtered('source=quick_add')).toEqual([c.body.id]);
    expect(await filtered('quickAddRunId=77')).toEqual([c.body.id]);
    expect(await filtered('quickAddRunId=78')).toEqual([]);
    expect(await filtered('_sort=id&_order=asc')).toEqual([a.body.id, b.body.id, c.body.id]);
    expect(await filtered('_sort=createdAt&_order=desc')).toEqual([c.body.id, b.body.id, a.body.id]);
    const page = await admin.get('/admin/publish-runs?_start=1&_end=2');
    expect(page.body.map((run: { id: number }) => run.id)).toEqual([b.body.id]);
    expect(page.total).toBe(3);
    for (const bad of ['status=nope', 'colour=red', '_sort=total', 'q=x']) {
      expect((await admin.get(`/admin/publish-runs?${bad}`)).status).toBe(422);
    }
  });

  it('shows one run, and 404 for an unknown one', async () => {
    const w = await world();
    await several(w, 1);
    const made = await post({ scope: { kind: 'all' } });
    expect((await admin.get(`/admin/publish-runs/${made.body.id}`)).body).toEqual(made.body);
    for (const url of ['/admin/publish-runs/999999', '/admin/publish-runs/999999/items']) {
      const res = await admin.get(url);
      expect(res.status).toBe(404);
      expect(res.body.code).toBe('NOT_FOUND');
    }
    expect((await admin.get('/admin/publish-runs/abc')).status).toBe(422);
  });

  it('a run whose worker stopped reads failed after five minutes, with the sentence of its stage, and a read never writes', async () => {
    const w = await world();
    await several(w, 1);
    const preparing = (await post({ scope: { kind: 'all' } })).body.id as number;
    const queued = (await seedRun(t, [], { status: 'queued', scope: { kind: 'all' } })).id;
    const running = (await seedRun(t, [], { status: 'running', startedAt: new Date(START), scope: { kind: 'all' } }))
      .id;
    const switching = (
      await seedRun(t, [], {
        status: 'succeeded',
        switchStatus: 'running',
        switchListed: false,
        finishedAt: new Date(START),
        scope: { kind: 'all' },
      })
    ).id;
    const finished = (
      await seedRun(t, [], { status: 'succeeded', finishedAt: new Date(START), scope: { kind: 'all' } })
    ).id;
    const stored = async () =>
      (await db.select().from(s.listingPublishRuns).orderBy(asc(s.listingPublishRuns.id))).map((run) => run.status);
    const before = await stored();

    const read = async (id: number) => (await admin.get(`/admin/publish-runs/${id}`)).body;
    expect((await read(preparing)).status).toBe('preparing');
    clock.advance(4 * MINUTE + 59_000);
    expect((await read(running)).status).toBe('running');
    clock.advance(2_000);

    expect(await read(preparing)).toMatchObject({ status: 'failed', error: PREPARE_STALLED_ERROR });
    expect(await read(queued)).toMatchObject({ status: 'failed', error: STALLED_ERROR });
    expect(await read(running)).toMatchObject({ status: 'failed', error: STALLED_ERROR });
    expect((await read(switching)).switch).toMatchObject({ status: 'failed', error: SWITCH_STALLED_ERROR });
    expect(await read(switching)).toMatchObject({ status: 'succeeded' });
    expect(await read(finished)).toMatchObject({ status: 'succeeded', error: null });
    const list = (await admin.get('/admin/publish-runs?_sort=id&_order=asc')).body as Array<{
      id: number;
      status: string;
    }>;
    expect(list.find((run) => run.id === running)?.status).toBe('failed');
    expect(await stored()).toEqual(before);
  });

  it('lists the rows of a run with their filters, search, sorts, afterId and x-total-count', async () => {
    const w = await world();
    await makeRule();
    const apple = await service(w, {
      name: 'Apple iPhone Activation Lock Remove',
      values: { cost: '12.0000', effectiveCost: '12.0000', basePrice: '12.7200' },
    });
    const samsungA = await service(w, { name: 'Samsung Galaxy KG Lock Remove' });
    const samsungB = await service(w, { name: 'Samsung Galaxy KG Lock Remove' });
    const noBrand = await service(w, { name: 'AT&T USA Premier Unlock', values: { code: 'ATT-FIND-ME' } });
    const closed = await service(w, { name: 'Disabled one', values: { status: 'disabled' } });
    const id = await prepared({ scope: { kind: 'all' } });
    const ids = (query: string) => itemsOf(id, query).then((rows) => rows.map((row) => row.serviceId));

    const all = await admin.get(`/admin/publish-runs/${id}/items`);
    expect(all.total).toBe(5);
    expect(await ids('')).toEqual([apple, samsungA, samsungB, noBrand, closed]);
    expect(await ids('&state=ready')).toEqual([apple, noBrand]);
    expect(await ids('&state=review')).toEqual([samsungA, samsungB]);
    expect(await ids('&state=blocked')).toEqual([closed]);
    expect(await ids('&included=true')).toEqual([apple, noBrand]);
    expect(await ids('&included=false')).toEqual([samsungA, samsungB, closed]);
    expect(await ids('&result=pending')).toHaveLength(5);
    expect(await ids('&result=published')).toEqual([]);
    expect(await ids('&flag=duplicate_name')).toEqual([samsungA, samsungB]);
    expect(await ids('&flag=no_brand')).toEqual([noBrand, closed]);
    expect(await ids('&brandKind=device')).toEqual([apple, samsungA, samsungB]);
    expect(await ids('&q=kg lock')).toEqual([samsungA, samsungB]);
    expect(await ids('&q=att-find-me')).toEqual([noBrand]);
    expect(await ids('&q=premier-unlock')).toEqual([noBrand]);
    expect(await ids('&q=Disabled')).toEqual([closed]);
    expect(await ids(`&afterId=${(await itemOf(id, samsungA)).id}`)).toEqual([samsungB, noBrand, closed]);
    // Equal costs keep the order of the first key: the id, descending.
    expect(await ids('&_sort=cost&_order=desc')).toEqual([apple, closed, noBrand, samsungB, samsungA]);
    expect(await ids('&_sort=title&_order=asc')).toEqual([apple, noBrand, closed, samsungA, samsungB]);
    const page = await admin.get(`/admin/publish-runs/${id}/items?_start=1&_end=3&state=review`);
    expect(page.total).toBe(2);
    expect(page.body.map((row: { serviceId: number }) => row.serviceId)).toEqual([samsungB]);
    const filtered = await admin.get(`/admin/publish-runs/${id}/items?state=ready`);
    expect(filtered.total).toBe(2);
    for (const bad of [
      'state=nope',
      'flag=nope',
      'result=maybe',
      'brandKind=robot',
      'colour=red',
      '_sort=slug',
      'afterId=x',
    ]) {
      expect((await admin.get(`/admin/publish-runs/${id}/items?${bad}`)).status).toBe(422);
    }
  });

  it('says on a row whether its listing is on the shop now, and keeps the name of a rule that was deleted', async () => {
    const w = await world();
    await makeRule();
    const [a, b, c] = await several(w, 3);
    const id = await prepared({ scope: { kind: 'all' } });
    const onShop = await insertListingRow(db, a!, { isListed: true });
    const offShop = await insertListingRow(db, b!, { isListed: false });
    await db
      .update(s.listingPublishItems)
      .set({ result: 'published', listingId: onShop, publishedPrice: '13.9900' })
      .where(and(eq(s.listingPublishItems.runId, id), eq(s.listingPublishItems.serviceId, a!)));
    await db
      .update(s.listingPublishItems)
      .set({ result: 'published', listingId: offShop, publishedPrice: '13.9900' })
      .where(and(eq(s.listingPublishItems.runId, id), eq(s.listingPublishItems.serviceId, b!)));

    expect(await itemOf(id, a!)).toMatchObject({
      listingId: onShop,
      listingListed: true,
      result: 'published',
      publishedPrice: '13.9900',
    });
    expect(await itemOf(id, b!)).toMatchObject({ listingId: offShop, listingListed: false });
    expect(await itemOf(id, c!)).toMatchObject({ listingId: null, listingListed: null });

    const [rule] = await db.select().from(s.retailPriceRules);
    expect((await itemOf(id, c!)).rule).toEqual({ id: rule!.id, label: expect.any(String) });
    const label = (await itemOf(id, c!)).rule.label as string;
    expect((await admin.delete(`/admin/retail-price-rules/${rule!.id}`)).status).toBe(204);
    expect((await itemOf(id, c!)).rule).toEqual({ id: rule!.id, label });
  });
});

/** The draft edits a person makes in the row dialog, written straight into the row (the edit routes are slice B4b). */
const edit = (runId: number, serviceId: number, values: Partial<typeof s.listingPublishItems.$inferInsert>) =>
  db
    .update(s.listingPublishItems)
    .set(values)
    .where(and(eq(s.listingPublishItems.runId, runId), eq(s.listingPublishItems.serviceId, serviceId)));

describe('Check again and the copy of an earlier run', () => {
  it('replaces a draft: the old one is cancelled, links to the new one and reads replacedBy; the new one has the same rows', async () => {
    const w = await world();
    await makeRule();
    const ids = await several(w, 3);
    const first = await prepared({ scope: { kind: 'category', categoryId: w.categoryId } });

    const again = await admin.post('/admin/publish-runs', { scope: { kind: 'run', runId: first } });

    expect(again.status).toBe(202);
    expect(again.body).toMatchObject({
      status: 'preparing',
      source: 'console',
      auto: false,
      listed: true,
      total: 3,
      scope: { kind: 'run', runId: first },
      requestedBy: admin.staffId,
    });
    expect((await admin.get(`/admin/publish-runs/${first}`)).body).toMatchObject({
      status: 'cancelled',
      replacedBy: again.body.id,
      finishedAt: START,
    });
    expect(await eventsOf(PUBLISH_PREPARE_EVENT)).toHaveLength(2);
    await preparer.run(again.body.id);
    expect((await itemsOf(again.body.id)).map((row) => row.serviceId)).toEqual(ids);
    // The old rows stay: they can no longer change.
    expect(await itemsOf(first)).toHaveLength(3);
    // Nothing of the rest of the shop moved, and a second press of "Check again" on the old draft is refused.
    const twice = await admin.post('/admin/publish-runs', { scope: { kind: 'run', runId: first } });
    expect(twice.status).toBe(409);
    expect(twice.body.code).toBe('CONFLICT');
    expect(await db.select().from(s.listingPublishRuns)).toHaveLength(2);
    expect(await auditsOf('cancelled publishing run')).toHaveLength(1);
  });

  it('keeps what staff edited: the title, the facts, a typed address, a typed price and a tick; and drops replaces_price', async () => {
    const w = await world();
    await makeRule();
    const [edited, address, priced, unticked, ticked, replacing] = await several(w, 6);
    // Two services with one name make two review rows: one of them is ticked by staff.
    const twinA = await service(w, { name: 'Samsung Galaxy KG Lock Remove' });
    const twinB = await service(w, { name: 'Samsung Galaxy KG Lock Remove' });
    await insertRetailPrice(db, replacing!, w.groups.retail, '20.0000');
    const first = await prepared({ scope: { kind: 'category', categoryId: w.categoryId } });
    const row = await itemOf(first, edited!);
    await edit(first, edited!, {
      title: 'My own title',
      brand: 'Samsung',
      carrier: 'Orange',
      country: 'FR',
      edited: true,
      flags: row.flags,
    });
    await edit(first, address!, { slug: 'my-own-address', slugSource: 'staff', edited: true });
    await edit(first, priced!, { priceMode: 'manual', priceOverride: '25.0000' });
    await edit(first, unticked!, { included: false });
    await edit(first, twinB, { included: true });
    await edit(first, replacing!, { priceMode: 'rule', replacesPrice: '20.0000' });
    const before = await itemOf(first, edited!);

    const again = (await admin.post('/admin/publish-runs', { scope: { kind: 'run', runId: first } })).body;
    await preparer.run(again.id);

    expect(await itemOf(again.id, edited!)).toMatchObject({
      title: 'My own title',
      slug: 'my-own-title',
      brand: 'Samsung',
      carrier: 'Orange',
      country: 'FR',
      edited: true,
      detected: before.detected,
      state: 'ready',
      included: true,
    });
    expect((await itemOf(again.id, edited!)).flags).not.toContain('no_brand');
    expect(await itemOf(again.id, address!)).toMatchObject({ slug: 'my-own-address', edited: true, state: 'ready' });
    expect(await itemOf(again.id, priced!)).toMatchObject({
      priceMode: 'manual',
      retailPrice: '25.0000',
      state: 'ready',
      included: true,
    });
    expect(await itemOf(again.id, unticked!)).toMatchObject({ state: 'ready', included: false });
    expect(await itemOf(again.id, ticked!)).toMatchObject({ state: 'ready', included: true });
    expect(await itemOf(again.id, twinA)).toMatchObject({ state: 'review', included: false });
    expect(await itemOf(again.id, twinB)).toMatchObject({ state: 'review', included: true });
    // The choice to replace a typed price is never copied: the row keeps the price it has, and says so.
    expect(await itemOf(again.id, replacing!)).toMatchObject({
      priceMode: 'keep',
      replacesPrice: null,
      retailPrice: '20.0000',
    });
  });

  it('judges every row afresh: a typed price under the floor of now and an address a listing took are blocked', async () => {
    const w = await world();
    await makeRule();
    const [low, taken, fine] = await several(w, 3);
    const holder = await service(w, { name: 'Holder' });
    const first = await prepared({ scope: { kind: 'category', categoryId: w.categoryId } });
    await edit(first, low!, { priceMode: 'manual', priceOverride: '11.0000', edited: true });
    await edit(first, taken!, { slug: 'my-own-address', slugSource: 'staff', edited: true });
    await insertListingRow(db, holder, { slug: 'my-own-address', publicTitle: 'Holder' });

    const again = (await admin.post('/admin/publish-runs', { scope: { kind: 'run', runId: first } })).body;
    await preparer.run(again.id);

    expect(await itemOf(again.id, low!)).toMatchObject({
      state: 'blocked',
      blockedReason: 'below_floor',
      included: false,
      priceMode: 'manual',
    });
    expect(await itemOf(again.id, taken!)).toMatchObject({
      state: 'blocked',
      blockedReason: 'slug_taken',
      included: false,
      slug: 'my-own-address',
    });
    expect(await itemOf(again.id, fine!)).toMatchObject({ state: 'ready', included: true });
  });

  it('does not copy a service that was listed or archived meanwhile', async () => {
    const w = await world();
    await makeRule();
    const [a, b, c] = await several(w, 3);
    const first = await prepared({ scope: { kind: 'category', categoryId: w.categoryId } });
    await insertListingRow(db, a!);
    await db.update(s.services).set(ARCHIVED).where(eq(s.services.id, b!));

    const again = await admin.post('/admin/publish-runs', { scope: { kind: 'run', runId: first } });

    expect(again.body.total).toBe(1);
    await preparer.run(again.body.id);
    expect((await itemsOf(again.body.id)).map((row) => row.serviceId)).toEqual([c!]);
  });

  it('refuses when nothing is left, and then the old draft stays a draft: no run, no cancel, no audit row', async () => {
    const w = await world();
    await makeRule();
    const ids = await several(w, 2);
    const first = await prepared({ scope: { kind: 'all' } });
    for (const id of ids) await insertListingRow(db, id);

    const res = await admin.post('/admin/publish-runs', { scope: { kind: 'run', runId: first } });

    expect(res.status).toBe(422);
    expect(res.body.errors).toEqual([expect.objectContaining({ field: 'scope', code: 'nothing_to_publish' })]);
    expect((await runRow(first)).status).toBe('draft');
    expect(await db.select().from(s.listingPublishRuns)).toHaveLength(1);
    expect(await auditsOf('cancelled publishing run')).toHaveLength(0);
    expect(await eventsOf(PUBLISH_PREPARE_EVENT)).toHaveLength(1);
  });

  it('"Review the rest": a finished run gives the rows that were not published, as a new console draft, and is not cancelled', async () => {
    const w = await world();
    await makeRule();
    const [published, leftOut, refused, never] = await several(w, 4);
    const finished = await seedRun(
      t,
      [
        { serviceId: published!, row: { result: 'published', finishedAt: new Date(START) } },
        { serviceId: leftOut!, row: { included: false, result: 'skipped', resultReason: 'left_out' } },
        { serviceId: refused!, row: { result: 'refused', resultReason: 'cost_moved' } },
        { serviceId: never! },
      ],
      { status: 'succeeded', source: 'quick_add', auto: true, listed: false, finishedAt: new Date(START) },
    );
    await db.update(s.listingPublishItems).set({ title: 'x' }).where(eq(s.listingPublishItems.runId, finished.id));

    const res = await admin.post('/admin/publish-runs', { scope: { kind: 'run', runId: finished.id } });

    expect(res.status).toBe(202);
    expect(res.body).toMatchObject({ source: 'console', auto: false, listed: false, total: 3, quickAddRunId: null });
    await preparer.run(res.body.id);
    expect((await itemsOf(res.body.id)).map((row) => row.serviceId)).toEqual([leftOut!, refused!, never!]);
    expect((await runRow(finished.id)).status).toBe('succeeded');
    expect((await runRow(finished.id)).replacedByRunId).toBeNull();
    expect(await auditsOf('cancelled publishing run')).toHaveLength(0);
    // `listed` sent with the request wins over the old run's.
    const listed = await admin.post('/admin/publish-runs', {
      scope: { kind: 'run', runId: finished.id },
      listed: true,
    });
    expect(listed.body.listed).toBe(true);
  });

  it('refuses a run that is still working (409), but takes a failed one, a cancelled one and one that stalled', async () => {
    const w = await world();
    await makeRule();
    const ids = await several(w, 2);
    const copy = (runId: number) => admin.post('/admin/publish-runs', { scope: { kind: 'run', runId } });
    const run = (status: 'preparing' | 'queued' | 'running' | 'failed' | 'cancelled') =>
      seedRun(t, ids, { status, preparedAt: status === 'preparing' ? null : new Date(START) }).then((made) => made.id);

    for (const status of ['preparing', 'queued', 'running'] as const) {
      const res = await copy(await run(status));
      expect(res.status).toBe(409);
      expect(res.body).toMatchObject({ code: 'CONFLICT', detail: 'That run is still working.' });
    }
    expect((await copy(await run('failed'))).status).toBe(202);
    expect((await copy(await run('cancelled'))).status).toBe(202);
    const stalled = await run('running');
    clock.advance(6 * MINUTE);
    expect((await copy(stalled)).status).toBe(202);
    expect(await auditsOf('cancelled publishing run')).toHaveLength(0);
  });

  it('refuses a draft that the other writers hold: two presses race and one new draft is made', async () => {
    const w = await world();
    await makeRule();
    await several(w, 2);
    const first = await prepared({ scope: { kind: 'all' } });

    const both = await Promise.all([
      admin.post('/admin/publish-runs', { scope: { kind: 'run', runId: first } }),
      admin.post('/admin/publish-runs', { scope: { kind: 'run', runId: first } }),
    ]);

    expect(both.map((res) => res.status).sort()).toEqual([202, 409]);
    expect(
      await db
        .select()
        .from(s.listingPublishRuns)
        .where(inArray(s.listingPublishRuns.status, ['preparing'])),
    ).toHaveLength(1);
    expect(await auditsOf('cancelled publishing run')).toHaveLength(1);
  });

  it('refuses to copy a run whose preview was never finished: its rows are partial', async () => {
    const w = await world();
    await makeRule();
    await several(w, 2);
    const scope = { kind: 'all' };
    const failed = (await post({ scope })).body.id as number;
    await db
      .update(s.listingPublishRuns)
      .set({ status: 'failed', error: 'boom', finishedAt: new Date(START) })
      .where(eq(s.listingPublishRuns.id, failed));
    const cancelled = (await post({ scope })).body.id as number;
    expect((await cancelRun(cancelled)).status).toBe(200);
    const stalled = (await post({ scope })).body.id as number;
    clock.advance(6 * MINUTE);

    for (const runId of [failed, cancelled, stalled]) {
      const res = await post({ scope: { kind: 'run', runId } });
      expect(res.status).toBe(409);
      expect(res.body).toMatchObject({ code: 'CONFLICT', detail: 'The preview was not finished. Start a new one.' });
    }
    expect(await db.select().from(s.listingPublishRuns)).toHaveLength(3);
  });
});

describe('"Prepare again" after a "Check again" that died (plan 31 sections 5.2 and 7.2)', () => {
  const REPLACED = { code: 'CONFLICT', detail: 'That preview was already replaced by a newer one.' };

  const copyOf = (runId: number) => post({ scope: { kind: 'run', runId } });

  /** A prepared draft with a row staff edited, and the run "Check again" made from it, which no worker has touched. */
  async function replacedDraft() {
    const w = await world();
    await makeRule();
    const ids = await several(w, 2);
    const first = await prepared({ scope: { kind: 'all' }, listed: false });
    await edit(first, ids[0]!, { title: 'My own title', brand: 'Samsung', edited: true });
    const again = await copyOf(first);
    expect(again.status).toBe(202);
    return { ids, first, dead: again.body.id as number };
  }

  it('a preview that failed: the old draft is copied again with its edits, and links to the new run', async () => {
    const { ids, first, dead } = await replacedDraft();
    spyOn(t.app.get(PublishDraftFacts, { strict: false }), 'read').mockRejectedValueOnce(
      new Error('The prices are down.'),
    );
    await expectRejection(preparer.run(dead), /prices are down/);
    expect((await admin.get(`/admin/publish-runs/${dead}`)).body).toMatchObject({ status: 'failed', preparedAt: null });
    const before = await snapshot();

    const res = await copyOf(first);

    expect(res.status).toBe(202);
    expect(res.body).toMatchObject({
      status: 'preparing',
      scope: { kind: 'run', runId: first },
      listed: false,
      total: 2,
      requestedBy: admin.staffId,
    });
    expect((await admin.get(`/admin/publish-runs/${first}`)).body).toMatchObject({
      status: 'cancelled',
      replacedBy: res.body.id,
    });
    expect(await runRow(dead)).toMatchObject({ status: 'failed', replacedByRunId: null });
    expect(await eventsOf(PUBLISH_PREPARE_EVENT)).toHaveLength(3);
    // Nothing is cancelled here, so the audit log and the shop stay as they were.
    expect(await snapshot()).toEqual(before);
    expect(await auditsOf('cancelled publishing run')).toHaveLength(1);

    expect(await preparer.run(res.body.id)).toBe('draft');
    expect((await itemsOf(res.body.id)).map((row) => row.serviceId)).toEqual(ids);
    expect(await itemOf(res.body.id, ids[0]!)).toMatchObject({ title: 'My own title', brand: 'Samsung', edited: true });
    // The link now names a run that was prepared: the old draft is closed for good.
    expect((await copyOf(first)).body).toMatchObject(REPLACED);
  });

  it('a preview that stalled: it is closed first, so its worker cannot finish a second draft', async () => {
    const { first, dead } = await replacedDraft();
    // The worker took the run and went silent; it may still wake up.
    expect(await claimPrepare(db, dead, clock.now())).toBeDefined();
    clock.advance(6 * MINUTE);
    expect((await admin.get(`/admin/publish-runs/${dead}`)).body).toMatchObject({
      status: 'failed',
      error: PREPARE_STALLED_ERROR,
    });
    expect((await runRow(dead)).status).toBe('preparing');

    const res = await copyOf(first);

    expect(res.status).toBe(202);
    expect(await runRow(dead)).toMatchObject({ status: 'failed', error: PREPARE_STALLED_ERROR, preparedAt: null });
    expect((await runRow(dead)).finishedAt).toEqual(clock.now());
    expect((await runRow(first)).replacedByRunId).toBe(res.body.id);
    expect(await beatPrepare(db, dead, clock.now())).toBe(false);
    const closing = { status: 'draft', total: 2, error: null, now: clock.now() } as const;
    expect(await closePrepare(db, dead, closing)).toBeUndefined();
    expect(await auditsOf('cancelled publishing run')).toHaveLength(1);

    expect(await preparer.run(res.body.id)).toBe('draft');
    const drafts = await db.select().from(s.listingPublishRuns).where(eq(s.listingPublishRuns.status, 'draft'));
    expect(drafts.map((run) => run.id)).toEqual([res.body.id]);
  });

  it('a preview that staff cancelled before it was ready: the old draft can be copied again', async () => {
    const { first, dead } = await replacedDraft();
    expect((await cancelRun(dead)).status).toBe(200);

    const res = await copyOf(first);

    expect(res.status).toBe(202);
    expect((await runRow(first)).replacedByRunId).toBe(res.body.id);
    expect(await runRow(dead)).toMatchObject({ status: 'cancelled', preparedAt: null });
  });

  it('is refused while the replacement is alive and once it was prepared, whatever became of it; the link stays', async () => {
    const { first, dead } = await replacedDraft();

    const alive = await copyOf(first);
    expect(alive.status).toBe(409);
    expect(alive.body).toMatchObject(REPLACED);

    expect(await preparer.run(dead)).toBe('draft');
    expect((await copyOf(first)).body).toMatchObject(REPLACED);
    for (const status of ['queued', 'running', 'succeeded', 'failed', 'cancelled'] as const) {
      await db.update(s.listingPublishRuns).set({ status }).where(eq(s.listingPublishRuns.id, dead));
      const res = await copyOf(first);
      expect(res.status, status).toBe(409);
      expect(res.body).toMatchObject(REPLACED);
    }
    clock.advance(6 * MINUTE);
    await db.update(s.listingPublishRuns).set({ status: 'running' }).where(eq(s.listingPublishRuns.id, dead));
    expect((await copyOf(first)).body).toMatchObject(REPLACED);

    expect((await runRow(first)).replacedByRunId).toBe(dead);
    expect(await db.select().from(s.listingPublishRuns)).toHaveLength(2);
    expect(await eventsOf(PUBLISH_PREPARE_EVENT)).toHaveLength(2);
  });

  it('nothing left to publish refuses it and writes nothing: the dead run stays as it is', async () => {
    const { ids, first, dead } = await replacedDraft();
    expect(await claimPrepare(db, dead, clock.now())).toBeDefined();
    clock.advance(6 * MINUTE);
    for (const id of ids) await insertListingRow(db, id);

    const res = await copyOf(first);

    expect(res.status).toBe(422);
    expect(res.body.errors).toEqual([expect.objectContaining({ field: 'scope', code: 'nothing_to_publish' })]);
    expect((await runRow(first)).replacedByRunId).toBe(dead);
    expect((await runRow(dead)).status).toBe('preparing');
    expect(await db.select().from(s.listingPublishRuns)).toHaveLength(2);
  });

  it('waits for a worker that is closing the replacement, and then refuses: the preview was ready after all', async () => {
    const { first, dead } = await replacedDraft();
    clock.advance(6 * MINUTE);
    // The stalled worker woke up and is inside the transaction of its close.
    const closing = await holding((tx) =>
      closePrepare(tx, dead, { status: 'draft', total: 2, error: null, now: clock.now() }),
    );

    const pressed = copyOf(first);
    await waitsOnRunRow();
    await closing.commit();
    const res = await pressed;

    expect(res.status).toBe(409);
    expect(res.body).toMatchObject(REPLACED);
    expect((await runRow(dead)).status).toBe('draft');
    expect((await runRow(first)).replacedByRunId).toBe(dead);
    expect(await db.select().from(s.listingPublishRuns)).toHaveLength(2);
  });

  it('two presses at once make one new run, and the link names it', async () => {
    const { first, dead } = await replacedDraft();
    await db
      .update(s.listingPublishRuns)
      .set({ status: 'failed', error: 'boom', finishedAt: new Date(START) })
      .where(eq(s.listingPublishRuns.id, dead));

    const both = await Promise.all([copyOf(first), copyOf(first)]);

    expect(both.map((res) => res.status).sort()).toEqual([202, 409]);
    const made = both.find((res) => res.status === 202)!;
    expect((await runRow(first)).replacedByRunId).toBe(made.body.id);
    expect(await db.select().from(s.listingPublishRuns)).toHaveLength(3);
  });
});

// --- Slice B4b: edit, apply, cancel and switch (plan 31 sections 5.2, 6.5 and 8.3, second paragraph) -------------------------------------

const runnerOf = () => t.app.get(PublishRunner, { strict: false });
const switcherOf = () => t.app.get(PublishSwitch, { strict: false });

const runUrl = (runId: number, tail = '') => `/admin/publish-runs/${runId}${tail}`;

/** PATCHes the row of a service in a run. */
async function patchItem(runId: number, serviceId: number, body: unknown, as: AdminApi = admin) {
  const row = await itemOf(runId, serviceId);
  return as.patch(runUrl(runId, `/items/${row.id}`), body);
}

const bulk = (runId: number, body: unknown, as: AdminApi = admin) => as.post(runUrl(runId, '/items/bulk'), body);
const applyRun = (runId: number, body: unknown = {}, as: AdminApi = admin) => as.post(runUrl(runId, '/apply'), body);
const cancelRun = (runId: number, as: AdminApi = admin) => as.post(runUrl(runId, '/cancel'), {});
const switchRun = (runId: number, listed: boolean, as: AdminApi = admin) =>
  as.post(runUrl(runId, '/listed'), { listed });

const listingsOf = () => db.select().from(s.serviceListings).orderBy(asc(s.serviceListings.id));

const errorsOf = (res: { body: { errors?: unknown } }) =>
  res.body.errors as Array<{ field: string; code: string; message: string }>;

const itemRowOf = async (runId: number, serviceId: number) =>
  (
    await db
      .select()
      .from(s.listingPublishItems)
      .where(and(eq(s.listingPublishItems.runId, runId), eq(s.listingPublishItems.serviceId, serviceId)))
  )[0]!;

/** A rule, `n` ready services and the prepared draft of all of them. */
async function draftOf(n: number) {
  const w = await world();
  await makeRule();
  const ids = await several(w, n);
  const run = await prepared({ scope: { kind: 'all' } });
  return { w, ids, run };
}

describe('PATCH /admin/publish-runs/:id/items/:itemId', () => {
  it('title: sets it, marks the row edited, makes an address that was not typed follow it, and answers the row judged again', async () => {
    const w = await world();
    await makeRule();
    const a = await service(w, { name: 'AT&T USA Premier Unlock' });
    const run = await prepared({ scope: { kind: 'all' } });

    const res = await patchItem(run, a, { title: 'AT&T USA Premier Unlock (Clean IMEI)' });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      title: 'AT&T USA Premier Unlock (Clean IMEI)',
      slug: 'att-usa-premier-unlock-clean-imei',
      edited: true,
      detected: { title: 'AT&T USA Premier Unlock', slug: 'att-usa-premier-unlock' },
      state: 'ready',
      included: true,
      evaluatedAt: START,
    });
    expect(await itemOf(run, a)).toMatchObject({ title: 'AT&T USA Premier Unlock (Clean IMEI)', edited: true });
    expect((await itemRowOf(run, a)).slugSource).toBe('auto');
  });

  it('slug: a typed address is kept as staff typed it, and an empty one makes it from the title again', async () => {
    const w = await world();
    await makeRule();
    const a = await service(w, { name: 'AT&T USA Premier Unlock' });
    const run = await prepared({ scope: { kind: 'all' } });

    const typed = await patchItem(run, a, { slug: 'my-own-address' });
    expect(typed.body).toMatchObject({ slug: 'my-own-address', edited: true });
    expect((await itemRowOf(run, a)).slugSource).toBe('staff');
    // A title edit leaves a typed address alone.
    expect((await patchItem(run, a, { title: 'Another title' })).body.slug).toBe('my-own-address');

    const again = await patchItem(run, a, { slug: '' });
    expect(again.body.slug).toBe('another-title');
    expect((await itemRowOf(run, a)).slugSource).toBe('auto');
  });

  it("slug: a listing's address, another row's address and a form that is not an address are refused on the field", async () => {
    const w = await world();
    await makeRule();
    const a = await service(w, { name: 'AT&T USA Premier Unlock' });
    const b = await service(w, { name: 'Apple iPhone Activation Lock Remove' });
    const holder = await service(w, { name: 'Holder' });
    const run = await prepared({ scope: { kind: 'services', serviceIds: [a, b] } });
    await insertListingRow(db, holder, { slug: 'held-address', publicTitle: 'Holder' });
    const before = await itemOf(run, a);

    for (const slug of ['held-address', 'apple-iphone-activation-lock-remove']) {
      const res = await patchItem(run, a, { slug });
      expect(res.status).toBe(422);
      expect(errorsOf(res)).toEqual([
        {
          field: 'slug',
          code: 'duplicate',
          message: 'This address is used by a listing or by another row of this run.',
        },
      ]);
    }
    const bad = await patchItem(run, a, { slug: 'Bad Address' });
    expect(bad.status).toBe(422);
    expect(errorsOf(bad)).toEqual([expect.objectContaining({ field: 'slug', code: 'invalid' })]);
    expect(await itemOf(run, a)).toEqual(before);
  });

  it('slug: an empty one takes the next free suffix when a listing took the address since the preview', async () => {
    const w = await world();
    await makeRule();
    const a = await service(w, { name: 'AT&T USA Premier Unlock' });
    const holder = await service(w, { name: 'Holder' });
    const run = await prepared({ scope: { kind: 'services', serviceIds: [a] } });
    await insertListingRow(db, holder, { slug: 'att-usa-premier-unlock', publicTitle: 'Holder' });

    const res = await patchItem(run, a, { slug: '' });

    expect(res.body).toMatchObject({ slug: 'att-usa-premier-unlock-2', state: 'ready' });
    expect(res.body.flags).toContain('slug_suffixed');
  });

  it('facts: brand, carrier and country are set, and the flags that derive from them are worked out again', async () => {
    const w = await world();
    await makeRule();
    const a = await service(w, { name: 'AT&T USA Premier Unlock' });
    const run = await prepared({ scope: { kind: 'all' } });
    expect((await itemOf(run, a)).flags).toEqual(['no_brand']);

    const brand = await patchItem(run, a, { brand: 'Apple' });
    expect(brand.body).toMatchObject({ brand: 'Apple', edited: true, flags: [], state: 'ready' });

    const noCountry = await patchItem(run, a, { country: '' });
    expect(noCountry.body).toMatchObject({ country: '', flags: ['carrier_no_country'], state: 'ready' });

    const both = await patchItem(run, a, { carrier: 'Orange', country: 'fr' });
    expect(both.body).toMatchObject({ carrier: 'Orange', country: 'FR', flags: [] });

    expect((await patchItem(run, a, { brand: '' })).body.flags).toEqual(['no_brand']);
  });

  it('title: a long one gets its flag, and a title another row or a listing already has is a likely twin', async () => {
    const w = await world();
    await makeRule();
    const a = await service(w, { name: 'AT&T USA Premier Unlock' });
    const b = await service(w, { name: 'Apple iPhone Activation Lock Remove' });
    const holder = await service(w, { name: 'Holder' });
    await insertListingRow(db, holder, { slug: 'held', publicTitle: 'Held Title' });
    const run = await prepared({ scope: { kind: 'services', serviceIds: [a, b] } });

    const soft = await patchItem(run, a, { title: `Unlock ${'x'.repeat(80)}` });
    expect(soft.body.flags).toContain('title_81_100');
    expect(soft.body.state).toBe('ready');
    const hard = await patchItem(run, a, { title: `Unlock ${'x'.repeat(100)}` });
    expect(hard.body.flags).toContain('title_long');
    expect(hard.body).toMatchObject({ state: 'review', included: true });

    const twin = await patchItem(run, a, { title: 'held   TITLE' });
    expect(twin.body.flags).toContain('title_taken');
    expect(twin.body.state).toBe('review');
    const other = await patchItem(run, a, { title: 'Apple iPhone Activation Lock Remove' });
    expect(other.body.flags).toContain('title_taken');
    const free = await patchItem(run, a, { title: 'A title nobody has' });
    expect(free.body.flags).not.toContain('title_taken');
    expect(free.body.state).toBe('ready');
  });

  it('retailPrice: a typed price is stored as manual with its margin, and judged against the floor of now', async () => {
    const w = await world();
    await makeRule();
    const a = await service(w, { name: 'AT&T USA Premier Unlock' });
    const run = await prepared({ scope: { kind: 'all' } });

    const res = await patchItem(run, a, { retailPrice: '25.0000' });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      priceMode: 'manual',
      retailPrice: '25.0000',
      rulePrice: '13.9900',
      replacesPrice: null,
      floorPrice: '11.6600',
      state: 'ready',
    });
    expect(res.body.marginPct).toMatch(/^60(\.0+)?$/);
    expect((await patchItem(run, a, { retailPrice: '11.6600' })).body).toMatchObject({ priceMode: 'manual' });
  });

  it("retailPrice: zero, a negative price and a price under the floor are refused on the field in the listing route's words", async () => {
    const w = await world();
    await makeRule();
    const a = await service(w, { name: 'AT&T USA Premier Unlock' });
    const run = await prepared({ scope: { kind: 'all' } });
    const before = await itemOf(run, a);

    const zero = await patchItem(run, a, { retailPrice: '0.0000' });
    expect(zero.status).toBe(422);
    expect(errorsOf(zero)).toEqual([
      { field: 'retailPrice', code: 'invalid', message: 'Enter a price greater than zero.' },
    ]);
    expect(errorsOf(await patchItem(run, a, { retailPrice: '-3.0000' }))[0]).toMatchObject({ code: 'invalid' });
    const low = await patchItem(run, a, { retailPrice: '11.0000' });
    expect(low.status).toBe(422);
    expect(errorsOf(low)).toEqual([
      { field: 'retailPrice', code: 'below_floor', message: 'Below the storefront floor of $11.66.' },
    ]);
    expect((await patchItem(run, a, { retailPrice: '12' })).status).toBe(422);
    expect(await itemOf(run, a)).toEqual(before);
  });

  it('pricing: rule over a typed price the service has stores that price as the one to replace; without one it stores none', async () => {
    const w = await world();
    await makeRule();
    const typed = await service(w, { name: 'Apple iPhone 14 Activation Lock Remove' });
    await insertRetailPrice(db, typed, w.groups.retail, '20.0000');
    const plain = await service(w, { name: 'Apple iPhone 15 Activation Lock Remove' });
    const run = await prepared({ scope: { kind: 'all' } });
    expect(await itemOf(run, typed)).toMatchObject({ priceMode: 'keep', replacesPrice: null });

    const over = await patchItem(run, typed, { pricing: 'rule' });
    expect(over.body).toMatchObject({
      priceMode: 'rule',
      replacesPrice: '20.0000',
      existingPrice: '20.0000',
      retailPrice: '13.9900',
    });
    expect(over.body.flags).not.toContain('price_kept');

    const none = await patchItem(run, plain, { pricing: 'rule' });
    expect(none.body).toMatchObject({ priceMode: 'rule', replacesPrice: null, retailPrice: '13.9900' });

    // Each price key clears what the others set.
    const kept = await patchItem(run, typed, { pricing: 'keep' });
    expect(kept.body).toMatchObject({ priceMode: 'keep', replacesPrice: null, retailPrice: '20.0000' });
    expect(kept.body.flags).toContain('price_kept');
    await patchItem(run, typed, { pricing: 'rule' });
    const manual = await patchItem(run, typed, { retailPrice: '30.0000' });
    expect(manual.body).toMatchObject({ priceMode: 'manual', replacesPrice: null, retailPrice: '30.0000' });
    const stored = await itemRowOf(run, typed);
    expect(stored).toMatchObject({ priceMode: 'manual', priceOverride: '30.0000', replacesPrice: null });
  });

  it('pricing: keep on a service with no retail price is refused on the field', async () => {
    const w = await world();
    await makeRule();
    const a = await service(w, { name: 'AT&T USA Premier Unlock' });
    const run = await prepared({ scope: { kind: 'all' } });

    const res = await patchItem(run, a, { pricing: 'keep' });

    expect(res.status).toBe(422);
    expect(errorsOf(res)).toEqual([
      { field: 'pricing', code: 'invalid', message: 'This service has no retail price to keep.' },
    ]);
  });

  it('included: unticks and ticks a row; a row that is blocked cannot be ticked and the answer names the reason', async () => {
    const w = await world();
    await makeRule();
    const ok = await service(w, { name: 'AT&T USA Premier Unlock' });
    const off = await service(w, { name: 'Apple iPhone Activation Lock Remove', values: { status: 'disabled' } });
    const run = await prepared({ scope: { kind: 'all' } });
    expect(await itemOf(run, off)).toMatchObject({ state: 'blocked', blockedReason: 'service_disabled' });

    expect((await patchItem(run, ok, { included: false })).body).toMatchObject({ included: false, state: 'ready' });
    expect((await patchItem(run, ok, { included: true })).body.included).toBe(true);
    const blocked = await patchItem(run, off, { included: true });
    expect(blocked.status).toBe(422);
    expect(errorsOf(blocked)).toEqual([
      { field: 'included', code: 'blocked', message: BLOCK_SENTENCES.service_disabled },
    ]);
    expect((await patchItem(run, off, { included: false })).status).toBe(200);
    expect((await itemOf(run, off)).included).toBe(false);
  });

  it('reset: gives back what was detected, clears edited, and the price choice goes back to the default', async () => {
    const w = await world();
    await makeRule();
    const a = await service(w, { name: 'AT&T USA Premier Unlock' });
    const run = await prepared({ scope: { kind: 'all' } });
    const before = await itemOf(run, a);
    await patchItem(run, a, { title: 'My title', brand: 'Samsung', carrier: 'Orange', country: 'FR' });
    await patchItem(run, a, { slug: 'my-address' });
    await patchItem(run, a, { retailPrice: '25.0000' });
    expect(await itemOf(run, a)).toMatchObject({ edited: true, priceMode: 'manual', slug: 'my-address' });

    const res = await patchItem(run, a, { reset: true });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      title: before.title,
      slug: before.slug,
      brand: before.brand,
      carrier: before.carrier,
      country: before.country,
      priceMode: before.priceMode,
      retailPrice: before.retailPrice,
      edited: false,
      state: before.state,
      flags: before.flags,
      included: before.included,
    });
    expect((await itemRowOf(run, a)).slugSource).toBe('auto');
  });

  it('refuses the conflicts, an empty body and what the contract refuses, and changes nothing', async () => {
    const w = await world();
    await makeRule();
    const a = await service(w, { name: 'AT&T USA Premier Unlock' });
    const run = await prepared({ scope: { kind: 'all' } });
    const before = await itemOf(run, a);

    const priceTwice = await patchItem(run, a, { retailPrice: '20.0000', pricing: 'rule' });
    expect(priceTwice.status).toBe(422);
    expect(errorsOf(priceTwice)).toEqual([expect.objectContaining({ field: 'retailPrice', code: 'conflict' })]);
    const resetWith = await patchItem(run, a, { reset: true, title: 'x' });
    expect(resetWith.status).toBe(422);
    expect(errorsOf(resetWith)).toEqual([expect.objectContaining({ field: 'reset', code: 'conflict' })]);
    for (const body of [
      {},
      { nope: 1 },
      { title: '' },
      { title: 'two\nlines' },
      { country: 'USA' },
      { brand: 'x'.repeat(81) },
      { reset: false },
      { pricing: 'other' },
    ]) {
      const res = await patchItem(run, a, body);
      expect(res.status, JSON.stringify(body)).toBe(422);
      expect(res.body.code).toBe('VALIDATION_FAILED');
    }
    expect(await itemOf(run, a)).toEqual(before);
  });

  it('answers 404 for an unknown run or row and for a row of another run', async () => {
    const w = await world();
    await makeRule();
    const [a, b] = await several(w, 2);
    const first = await prepared({ scope: { kind: 'services', serviceIds: [a!] } });
    const second = await prepared({ scope: { kind: 'services', serviceIds: [b!] } });
    const row = await itemOf(first, a!);
    const other = await itemOf(second, b!);

    expect((await admin.patch(runUrl(999_999, `/items/${row.id}`), { brand: 'x' })).status).toBe(404);
    expect((await admin.patch(runUrl(first, '/items/999999'), { brand: 'x' })).status).toBe(404);
    expect((await admin.patch(runUrl(first, `/items/${other.id}`), { brand: 'x' })).status).toBe(404);
    expect((await admin.patch(runUrl(first, `/items/${row.id}`), { brand: 'x' })).status).toBe(200);
  });

  it('answers 409 once the run is not a draft: cancelled, queued, running or finished', async () => {
    const w = await world();
    await makeRule();
    const ids = await several(w, 4);
    const runs: number[] = [];
    for (const id of ids) runs.push(await prepared({ scope: { kind: 'services', serviceIds: [id] } }));
    const [cancelled, queued, running, succeeded] = runs as [number, number, number, number];
    expect((await cancelRun(cancelled)).status).toBe(200);
    expect((await applyRun(queued)).status).toBe(202);
    await db.update(s.listingPublishRuns).set({ status: 'running' }).where(eq(s.listingPublishRuns.id, running));
    await db.update(s.listingPublishRuns).set({ status: 'succeeded' }).where(eq(s.listingPublishRuns.id, succeeded));

    for (const [run, id] of [
      [cancelled, ids[0]!],
      [queued, ids[1]!],
      [running, ids[2]!],
      [succeeded, ids[3]!],
    ] as const) {
      const res = await patchItem(run, id, { brand: 'Edited brand' });
      expect(res.status).toBe(409);
      expect(res.body).toMatchObject({ code: 'CONFLICT', detail: 'This run is no longer a draft.' });
      expect((await itemOf(run, id)).brand).not.toBe('Edited brand');
    }
  });

  it('a role with storefront:create edits a row but needs pricing:update for a price key; storefront:read cannot edit', async () => {
    const w = await world();
    await makeRule();
    const a = await service(w, { name: 'AT&T USA Premier Unlock' });
    const run = await prepared({ scope: { kind: 'all' } });
    const clerk = await adminWith(t, ['storefront:create', 'storefront:read'], { name: 'Clerk' });
    const viewer = await adminWith(t, ['storefront:read'], { name: 'Viewer' });
    const pricer = await adminWith(t, ['storefront:create', 'pricing:update'], { name: 'Pricer' });
    const updater = await adminWith(t, ['storefront:create', 'storefront:update'], { name: 'Updater' });
    const before = await itemOf(run, a);

    expect((await patchItem(run, a, { brand: 'Apple' }, clerk)).status).toBe(200);
    for (const body of [{ retailPrice: '25.0000' }, { pricing: 'rule' }]) {
      const res = await patchItem(run, a, body, clerk);
      expect(res.status, JSON.stringify(body)).toBe(403);
      expect(res.body).toMatchObject({ code: 'FORBIDDEN' });
      expect(res.body.detail).toContain('pricing:update');
    }
    // A role that may update the storefront but not price things is refused a price key too (decision 046).
    const stale = await patchItem(run, a, { retailPrice: '25.0000' }, updater);
    expect(stale.status).toBe(403);
    expect(stale.body.detail).toContain('pricing:update');
    expect((await itemOf(run, a)).priceMode).toBe(before.priceMode);
    expect((await patchItem(run, a, { reset: true }, clerk)).status).toBe(200);
    expect((await patchItem(run, a, { brand: 'Apple' }, viewer)).status).toBe(403);
    expect((await patchItem(run, a, { retailPrice: '25.0000' }, pricer)).status).toBe(200);
    expect((await admin.withoutCsrf('PATCH', runUrl(run, `/items/${before.id}`), { brand: 'x' })).status).toBe(403);
  });

  it('a reset that would drop a price staff chose needs pricing:update; on any other row it does not', async () => {
    const w = await world();
    await makeRule();
    const typed = await service(w, { name: 'AT&T USA Premier Unlock' });
    const replaced = await service(w, { name: 'Vodafone UK Premium Unlock' });
    const plain = await service(w, { name: 'Orange France Clean Unlock' });
    const group = await admin.put(`/admin/services/${replaced}/group-prices`, {
      prices: [{ groupId: w.groups.retail, price: '20.0000' }],
    });
    expect(group.status).toBe(200);
    const run = await prepared({ scope: { kind: 'all' } });
    const clerk = await adminWith(t, ['storefront:create', 'storefront:read'], { name: 'Clerk' });
    const pricer = await adminWith(t, ['storefront:create', 'pricing:update'], { name: 'Pricer' });
    expect((await patchItem(run, typed, { retailPrice: '50.0000' })).status).toBe(200);
    expect((await patchItem(run, replaced, { pricing: 'rule' })).status).toBe(200);
    expect(await itemRowOf(run, replaced)).toMatchObject({ priceMode: 'rule', replacesPrice: '20.0000' });

    for (const [id, stored] of [
      [typed, { priceMode: 'manual', priceOverride: '50.0000', replacesPrice: null }],
      [replaced, { priceMode: 'rule', priceOverride: null, replacesPrice: '20.0000' }],
    ] as const) {
      const refused = await patchItem(run, id, { reset: true }, clerk);
      expect(refused.status).toBe(403);
      expect(refused.body).toMatchObject({ code: 'FORBIDDEN' });
      expect(refused.body.detail).toContain('pricing:update');
      // Nothing moved: the row keeps the price choice staff made, and no other field changed with it.
      expect(await itemRowOf(run, id)).toMatchObject(stored);
    }

    // A row on the default price has nothing to lose: the clerk may still put it back.
    expect((await patchItem(run, plain, { title: 'A better title' }, clerk)).status).toBe(200);
    const back = await patchItem(run, plain, { reset: true }, clerk);
    expect(back.status).toBe(200);
    expect(back.body).toMatchObject({ edited: false, priceMode: 'rule' });

    // Whoever may price can reset: the typed price goes, and the row is on the rule's price again.
    const reset = await patchItem(run, typed, { reset: true }, pricer);
    expect(reset.status).toBe(200);
    expect(reset.body).toMatchObject({ priceMode: 'rule', retailPrice: '13.9900' });
    expect((await patchItem(run, replaced, { reset: true }, pricer)).body).toMatchObject({
      priceMode: 'keep',
      replacesPrice: null,
      retailPrice: '20.0000',
    });
  });

  it('answers 200 with a blocked, unticked row when the service was disabled since, and ticks it again when it is enabled', async () => {
    const w = await world();
    await makeRule();
    const a = await service(w, { name: 'AT&T USA Premier Unlock' });
    const run = await prepared({ scope: { kind: 'all' } });
    await db.update(s.services).set({ status: 'disabled' }).where(eq(s.services.id, a));

    const blocked = await patchItem(run, a, { brand: 'Apple' });
    expect(blocked.status).toBe(200);
    expect(blocked.body).toMatchObject({ state: 'blocked', blockedReason: 'service_disabled', included: false });

    await db.update(s.services).set({ status: 'active' }).where(eq(s.services.id, a));
    const unblocked = await patchItem(run, a, { carrier: 'Orange' });
    expect(unblocked.body).toMatchObject({ state: 'ready', blockedReason: null, included: true });
  });

  it('answers 409 for a service that was archived since, and changes nothing', async () => {
    const w = await world();
    await makeRule();
    const a = await service(w, { name: 'AT&T USA Premier Unlock' });
    const run = await prepared({ scope: { kind: 'all' } });
    await db.update(s.services).set(ARCHIVED).where(eq(s.services.id, a));
    const before = await itemOf(run, a);

    const res = await patchItem(run, a, { brand: 'Apple' });

    expect(res.status).toBe(409);
    expect(await itemOf(run, a)).toEqual(before);
  });

  it('judges the row again on the facts of now: the cost, the floor and the rule of the answer are those of this moment', async () => {
    const w = await world();
    await makeRule();
    const a = await service(w, { name: 'AT&T USA Premier Unlock' });
    const run = await prepared({ scope: { kind: 'all' } });
    await db.update(s.services).set({ effectiveCost: '20.0000' }).where(eq(s.services.id, a));

    const res = await patchItem(run, a, { brand: 'Apple' });

    expect(res.body).toMatchObject({ cost: '20.0000', state: 'ready' });
    expect(res.body.rulePrice).not.toBe('13.9900');
    expect(Number(res.body.floorPrice)).toBeGreaterThan(11.66);
  });

  it('a typed price that fell under a floor that rose reads blocked below_floor; what staff typed is never changed', async () => {
    const w = await world();
    await makeRule();
    const a = await service(w, { name: 'AT&T USA Premier Unlock' });
    const run = await prepared({ scope: { kind: 'all' } });
    expect((await patchItem(run, a, { retailPrice: '12.0000' })).status).toBe(200);
    await db.update(s.services).set({ effectiveCost: '20.0000' }).where(eq(s.services.id, a));

    const res = await patchItem(run, a, { brand: 'Apple' });

    expect(res.body).toMatchObject({
      state: 'blocked',
      blockedReason: 'below_floor',
      included: false,
      priceMode: 'manual',
      retailPrice: '12.0000',
    });
  });

  it('the scenario of 6.2 through the routes: a price typed after the preview is kept, no follow row is made', async () => {
    const w = await world();
    await makeRule();
    const a = await service(w, { name: 'AT&T USA Premier Unlock' });
    const run = await prepared({ scope: { kind: 'all' } });
    expect(await itemOf(run, a)).toMatchObject({ priceMode: 'rule', existingPrice: null, retailPrice: '13.9900' });
    const group = await admin.put(`/admin/services/${a}/group-prices`, {
      prices: [{ groupId: w.groups.retail, price: '20.0000' }],
    });
    expect(group.status).toBe(200);

    const edited = await patchItem(run, a, { brand: 'Apple' });

    expect(edited.body).toMatchObject({ priceMode: 'keep', existingPrice: '20.0000', retailPrice: '20.0000' });
    expect(edited.body.flags).toContain('price_kept');
    expect((await applyRun(run)).status).toBe(202);
    expect(await runnerOf().run(run)).toBe('succeeded');
    const [listing] = await listingsOf();
    expect(listing).toMatchObject({ serviceId: a, brand: 'Apple', isListed: true });
    const price = await db.select().from(s.serviceGroupPrices).where(eq(s.serviceGroupPrices.serviceId, a));
    expect(price.map((row) => row.price)).toEqual(['20.0000']);
    expect(await db.select().from(s.retailPriceFollows)).toHaveLength(0);
    expect(await itemOf(run, a)).toMatchObject({ result: 'published', publishedPrice: '20.0000' });
  });

  it('an edit and an apply never interleave: the listing carries the whole edit or none of it', async () => {
    const w = await world();
    await makeRule();
    const ids = await several(w, 4);
    const outcomes: number[] = [];
    for (const [round, id] of ids.entries()) {
      const run = await prepared({ scope: { kind: 'services', serviceIds: [id] } });
      const original = (await itemOf(run, id)).title as string;

      const [edit, applied] = await Promise.all([
        patchItem(run, id, { title: `Edited title ${round}`, brand: 'Edited brand' }),
        applyRun(run),
      ]);

      expect(applied.status).toBe(202);
      expect([200, 409]).toContain(edit.status);
      outcomes.push(edit.status);
      expect(await runnerOf().run(run)).toBe('succeeded');
      const listing = (await listingsOf()).find((row) => row.serviceId === id)!;
      if (edit.status === 200) {
        expect(listing).toMatchObject({ publicTitle: `Edited title ${round}`, brand: 'Edited brand' });
      } else {
        expect(listing.publicTitle).toBe(original);
        expect(listing.brand).not.toBe('Edited brand');
      }
    }
    expect(outcomes).toHaveLength(4);
  });

  it('a preview changes nothing: the rows of the shop, the prices, the events and the audit log are the same after a PATCH and a bulk', async () => {
    const w = await world();
    await makeRule();
    const [a, b] = await several(w, 2);
    const run = await prepared({ scope: { kind: 'all' } });
    const before = await snapshot();

    await patchItem(run, a!, { title: 'A new title', brand: 'Apple', retailPrice: '25.0000' });
    await patchItem(run, a!, { reset: true });
    await patchItem(run, b!, { pricing: 'rule', included: false });
    await bulk(run, { select: { filter: {} }, set: { included: true, country: 'US' } });

    expect(await snapshot()).toEqual(before);
  });
});

describe('POST /admin/publish-runs/:id/items/bulk', () => {
  /** Two ready rows, one blocked (the service is disabled) and a pair of duplicate names that wait in review. */
  async function mixed() {
    const w = await world();
    await makeRule();
    const ready = await several(w, 2);
    const blocked = await service(w, { name: 'Apple iPhone 9 Activation Lock Remove', values: { status: 'disabled' } });
    const twinA = await service(w, { name: 'AT&T USA Premier Unlock' });
    const twinB = await service(w, { name: 'AT&T USA Premier Unlock' });
    const run = await prepared({ scope: { kind: 'all' } });
    const rows = async (...ids: number[]) => Promise.all(ids.map(async (id) => (await itemOf(run, id)).id as number));
    return { w, run, ready, blocked, twinA, twinB, rows };
  }

  it('by ids: ticks and unticks, counts the rows that changed, and refuses to tick a blocked row without failing the call', async () => {
    const { run, ready, blocked, twinA, rows } = await mixed();
    const [a, b] = ready as [number, number];

    const off = await bulk(run, { select: { itemIds: await rows(a, b, blocked) }, set: { included: false } });
    expect(off.status).toBe(200);
    // The blocked row was unticked already: only the two ready rows changed.
    expect(off.body).toEqual({ changed: 2, refused: 0 });
    expect(await itemOf(run, a)).toMatchObject({ included: false });

    const on = await bulk(run, { select: { itemIds: await rows(a, b, blocked, twinA) }, set: { included: true } });
    expect(on.body).toEqual({ changed: 3, refused: 1 });
    expect(await itemOf(run, a)).toMatchObject({ included: true });
    expect(await itemOf(run, twinA)).toMatchObject({ state: 'review', included: true });
    expect(await itemOf(run, blocked)).toMatchObject({ state: 'blocked', included: false });
    // A second call finds nothing to change.
    expect((await bulk(run, { select: { itemIds: await rows(a, b) }, set: { included: true } })).body).toEqual({
      changed: 0,
      refused: 0,
    });
  });

  it('by filter: every row of the run that matches, not one page: state, flag, brand kind, tick and search', async () => {
    const { run, ready, blocked, twinA, twinB } = await mixed();

    const review = await bulk(run, { select: { filter: { state: 'review' } }, set: { included: true } });
    expect(review.body).toEqual({ changed: 2, refused: 0 });
    expect(await itemOf(run, twinB)).toMatchObject({ included: true });

    const device = await bulk(run, { select: { filter: { brandKind: 'device' } }, set: { included: false } });
    // The two ready rows and the blocked one are Apple devices; only the ticked ones change.
    expect(device.body).toEqual({ changed: 2, refused: 0 });
    for (const id of ready) expect((await itemOf(run, id)).included).toBe(false);

    const noBrandRows = (await itemsOf(run, '&flag=no_brand')).map((row) => row.serviceId);
    expect(noBrandRows).toEqual([twinA, twinB]);
    const flagged = await bulk(run, { select: { filter: { flag: 'no_brand' } }, set: { included: false } });
    expect(flagged.body).toEqual({ changed: 2, refused: 0 });

    const search = await bulk(run, { select: { filter: { q: 'premier', included: false } }, set: { included: true } });
    expect(search.body).toEqual({ changed: 2, refused: 0 });
    const everything = await bulk(run, { select: { filter: {} }, set: { included: true } });
    expect(everything.body).toEqual({ changed: 2, refused: 1 });
    expect((await itemOf(run, blocked)).included).toBe(false);
  });

  it('facts: the brand, carrier and country are set for the rows picked, and the badges and the state are right after', async () => {
    const { run, ready, twinA, twinB, rows } = await mixed();
    // A row that waits for a country: a hard flag set as the naming would set it.
    await edit(run, twinA, {
      flags: ['duplicate_name', 'multi_country', 'no_brand'],
      state: 'review',
      included: false,
    });

    const noBrand = await bulk(run, { select: { filter: { flag: 'no_brand' } }, set: { brand: 'Samsung' } });
    expect(noBrand.body).toEqual({ changed: 2, refused: 0 });
    for (const id of [twinA, twinB]) {
      const row = await itemOf(run, id);
      expect(row).toMatchObject({ brand: 'Samsung', edited: true });
      expect(row.flags).not.toContain('no_brand');
    }

    const country = await bulk(run, {
      select: { itemIds: await rows(twinA) },
      set: { country: 'GB', carrier: 'Orange' },
    });
    expect(country.body).toEqual({ changed: 1, refused: 0 });
    const row = await itemOf(run, twinA);
    expect(row).toMatchObject({ country: 'GB', carrier: 'Orange', included: false });
    // multi_country is gone, and the row is still in review for its other hard flag (the duplicate name): no tick moved.
    expect(row.flags).not.toContain('multi_country');
    expect(row.flags).toContain('duplicate_name');
    expect(row.state).toBe('review');
    // The rows nobody picked did not change.
    expect(await itemOf(run, ready[0]!)).toMatchObject({ edited: false });

    // The same values again change nothing; an empty text clears a fact.
    expect((await bulk(run, { select: { itemIds: await rows(twinA) }, set: { country: 'GB' } })).body.changed).toBe(0);
    expect((await bulk(run, { select: { itemIds: await rows(twinA) }, set: { brand: '' } })).body.changed).toBe(1);
    expect((await itemOf(run, twinA)).flags).toContain('no_brand');
  });

  it('a ready row whose last hard flag goes with the country becomes ready and keeps its tick', async () => {
    const w = await world();
    await makeRule();
    const [a] = await several(w, 1);
    const run = await prepared({ scope: { kind: 'all' } });
    await edit(run, a!, { flags: ['multi_country'], state: 'review', included: false });

    const res = await bulk(run, { select: { filter: { flag: 'multi_country' } }, set: { country: 'GB' } });

    expect(res.body).toEqual({ changed: 1, refused: 0 });
    expect(await itemOf(run, a!)).toMatchObject({ state: 'ready', flags: [], included: false, country: 'GB' });
  });

  it('reads no price and moves no tick for a fact: the price choice of every row is as it was', async () => {
    const { w, run, ready } = await mixed();
    await insertRetailPrice(db, ready[0]!, w.groups.retail, '20.0000');
    const priced = async () =>
      (await itemsOf(run)).map((row) => ({
        priceMode: row.priceMode,
        retailPrice: row.retailPrice,
        existingPrice: row.existingPrice,
        cost: row.cost,
        included: row.included,
      }));
    const before = await priced();
    const prices = await db.select().from(s.serviceGroupPrices);

    await bulk(run, { select: { filter: {} }, set: { brand: 'Apple' } });

    expect(await priced()).toEqual(before);
    expect(await db.select().from(s.serviceGroupPrices)).toEqual(prices);
  });

  it('refuses a row that is not in this run, an empty change and a malformed body, and writes nothing', async () => {
    const { w, run, ready, rows } = await mixed();
    const [other] = await several(w, 1);
    const second = await prepared({ scope: { kind: 'services', serviceIds: [other!] } });
    const foreign = (await itemOf(second, other!)).id as number;
    const before = await itemsOf(run);

    const outside = await bulk(run, {
      select: { itemIds: [...(await rows(ready[0]!)), foreign] },
      set: { included: false },
    });
    expect(outside.status).toBe(422);
    expect(errorsOf(outside)).toEqual([
      { field: 'select.itemIds', code: 'invalid', message: 'Some of these rows are not in this run.' },
    ]);
    for (const body of [
      { select: { itemIds: [1] }, set: {} },
      { select: { itemIds: [] }, set: { included: true } },
      { select: { itemIds: Array.from({ length: 501 }, (_unused, i) => i + 1) }, set: { included: true } },
      { select: { filter: { state: 'nope' } }, set: { included: true } },
      { select: { itemIds: [1], filter: {} }, set: { included: true } },
      { select: { itemIds: [1] }, set: { country: 'USA' } },
      { select: { itemIds: [1] }, set: { price: '1.0000' } },
      { set: { included: true } },
      {},
    ]) {
      const res = await bulk(run, body);
      expect(res.status, JSON.stringify(body)).toBe(422);
    }
    expect(await itemsOf(run)).toEqual(before);
  });

  it('answers 404 for an unknown run, and 409 once the run is not a draft (queued, cancelled, finished)', async () => {
    const { run, ready, rows } = await mixed();
    const body = { select: { itemIds: await rows(ready[0]!) }, set: { included: false } };
    expect((await bulk(999_999, body)).status).toBe(404);
    expect((await applyRun(run)).status).toBe(202);
    const queued = await bulk(run, body);
    expect(queued.status).toBe(409);
    expect(queued.body).toMatchObject({ code: 'CONFLICT', detail: 'This run is no longer a draft.' });
    await runnerOf().run(run);
    expect((await bulk(run, body)).status).toBe(409);
  });

  it('needs storefront:create; a role that may only read cannot', async () => {
    const { run, ready, rows } = await mixed();
    const body = { select: { itemIds: await rows(ready[0]!) }, set: { included: false } };
    const clerk = await adminWith(t, ['storefront:create'], { name: 'Clerk' });
    const viewer = await adminWith(t, ['storefront:read'], { name: 'Viewer' });

    expect((await bulk(run, body, viewer)).status).toBe(403);
    expect((await bulk(run, body, clerk)).status).toBe(200);
    expect((await admin.withoutCsrf('POST', runUrl(run, '/items/bulk'), body)).status).toBe(403);
  });
});

describe('POST /admin/publish-runs/:id/apply', () => {
  it('applies a draft: queued, the event, the audit row; the worker then publishes the ticked rows and skips the others', async () => {
    const { ids, run } = await draftOf(3);
    const [a, b, c] = ids as [number, number, number];
    await patchItem(run, c, { included: false });

    const res = await applyRun(run, { listed: false });

    expect(res.status).toBe(202);
    expect(res.body).toMatchObject({
      id: run,
      status: 'queued',
      listed: false,
      error: null,
      startedAt: null,
      finishedAt: null,
      total: 3,
      counts: { included: 2, pending: 3 },
    });
    const [event] = await eventsOf(PUBLISH_APPLY_EVENT);
    expect(event).toMatchObject({ aggregateType: 'listing_publish_runs', aggregateId: run });
    expect(jobDataOf(event!).payload).toEqual({ runId: run });
    const [audit] = await auditsOf('started publishing to the storefront');
    expect(audit).toMatchObject({ entityType: 'publish_run', entityId: run, entityLabel: `Publish run #${run}` });
    expect(audit!.after).toMatchObject({
      scope: { kind: 'all' },
      total: 3,
      included: 2,
      listed: false,
      source: 'console',
      resumed: false,
      requestedBy: admin.staffId,
    });
    expect((await runRow(run)).status).toBe('queued');
    expect(await listingsOf()).toHaveLength(0);

    expect(await runnerOf().run(run)).toBe('succeeded');
    expect((await listingsOf()).map((listing) => [listing.serviceId, listing.isListed])).toEqual([
      [a, false],
      [b, false],
    ]);
    expect(await itemOf(run, c)).toMatchObject({ result: 'skipped', resultReason: 'left_out' });
    expect((await admin.get(runUrl(run))).body).toMatchObject({
      status: 'succeeded',
      counts: { published: 2, skipped: 1, refused: 0, pending: 0 },
    });
  });

  it('answers 409 JOB_ALREADY_RUNNING for a second press while the run is queued or running, and writes nothing more', async () => {
    const { run } = await draftOf(2);
    expect((await applyRun(run)).status).toBe(202);

    const queued = await applyRun(run);
    expect(queued.status).toBe(409);
    expect(queued.body).toMatchObject({ code: 'JOB_ALREADY_RUNNING', detail: 'This run is already being published.' });
    await db.update(s.listingPublishRuns).set({ status: 'running' }).where(eq(s.listingPublishRuns.id, run));
    expect((await applyRun(run)).status).toBe(409);
    expect(await eventsOf(PUBLISH_APPLY_EVENT)).toHaveLength(1);
    expect(await auditsOf('started publishing to the storefront')).toHaveLength(1);
  });

  it('two presses at once: one 202 and one 409, one event', async () => {
    const { run } = await draftOf(2);

    const both = await Promise.all([applyRun(run), applyRun(run)]);

    expect(both.map((res) => res.status).sort()).toEqual([202, 409]);
    expect(await eventsOf(PUBLISH_APPLY_EVENT)).toHaveLength(1);
  });

  it('refuses a draft with no ticked row on the field included, and moves nothing', async () => {
    const { run } = await draftOf(2);
    await bulk(run, { select: { filter: {} }, set: { included: false } });

    const res = await applyRun(run);

    expect(res.status).toBe(422);
    expect(errorsOf(res)).toEqual([{ field: 'included', code: 'nothing_included', message: 'No row is included.' }]);
    expect((await runRow(run)).status).toBe('draft');
    expect(await eventsOf(PUBLISH_APPLY_EVENT)).toHaveLength(0);
    expect(await auditsOf('started publishing to the storefront')).toHaveLength(0);
  });

  it('refuses a preview that is still prepared, one that was never finished, and a run that is over; nothing is published', async () => {
    const w = await world();
    await makeRule();
    await several(w, 2);
    const preparing = (await post({ scope: { kind: 'all' } })).body.id as number;
    const refusal = (detail: string) => ({ code: 'CONFLICT', detail });

    const early = await applyRun(preparing);
    expect(early.status).toBe(409);
    expect(early.body).toMatchObject(refusal('The preview is still being prepared.'));
    clock.advance(6 * MINUTE);
    expect((await applyRun(preparing)).body).toMatchObject(refusal('The preview was not finished. Start a new one.'));

    // A prepare that failed: a half-evaluated draft is never applied.
    const failed = (await post({ scope: { kind: 'all' } })).body.id as number;
    await db
      .update(s.listingPublishRuns)
      .set({ status: 'failed', error: 'boom', finishedAt: new Date(START) })
      .where(eq(s.listingPublishRuns.id, failed));
    const half = await applyRun(failed);
    expect(half.status).toBe(409);
    expect(half.body).toMatchObject(refusal('The preview was not finished. Start a new one.'));

    const done = await prepared({ scope: { kind: 'all' } });
    await db.update(s.listingPublishRuns).set({ status: 'succeeded' }).where(eq(s.listingPublishRuns.id, done));
    expect((await applyRun(done)).body).toMatchObject(refusal('This run is finished. Start a new one.'));
    await db.update(s.listingPublishRuns).set({ status: 'cancelled' }).where(eq(s.listingPublishRuns.id, done));
    expect((await applyRun(done)).body).toMatchObject(refusal('This run is finished. Start a new one.'));

    expect(await listingsOf()).toHaveLength(0);
    expect(await eventsOf(PUBLISH_APPLY_EVENT)).toHaveLength(0);
    expect(await auditsOf('started publishing to the storefront')).toHaveLength(0);
    expect((await runRow(failed)).status).toBe('failed');
  });

  it('refuses a run whose switch is alive, and takes one whose switch stalled', async () => {
    const { run } = await draftOf(2);
    await db
      .update(s.listingPublishRuns)
      .set({
        status: 'failed',
        error: 'boom',
        finishedAt: new Date(START),
        switchStatus: 'running',
        switchListed: false,
        heartbeatAt: new Date(START),
      })
      .where(eq(s.listingPublishRuns.id, run));

    const alive = await applyRun(run);
    expect(alive.status).toBe(409);
    expect(alive.body).toMatchObject({ code: 'JOB_ALREADY_RUNNING', detail: 'This run is being switched.' });
    clock.advance(6 * MINUTE);
    expect((await applyRun(run)).status).toBe(202);
  });

  /** A run that published its rows and then read `failed`, with the switch staff pressed still `queued`. */
  async function failedWithSwitch(n: number) {
    const { ids, run } = await draftOf(n);
    expect((await applyRun(run)).status).toBe(202);
    expect(await runnerOf().run(run)).toBe('succeeded');
    await db
      .update(s.listingPublishRuns)
      .set({ status: 'failed', error: 'boom' })
      .where(eq(s.listingPublishRuns.id, run));
    expect((await switchRun(run, false)).status).toBe(202);
    return { ids, run };
  }

  it('a resume closes a queued switch that stalled: its late job finds nothing, the apply goes on, and the switch can be pressed after it', async () => {
    const { run } = await failedWithSwitch(2);
    clock.advance(6 * MINUTE);

    const res = await applyRun(run);

    expect(res.status).toBe(202);
    expect(res.body).toMatchObject({
      status: 'queued',
      switch: { status: 'failed', listed: false, error: SWITCH_STALLED_ERROR },
    });
    expect(await runRow(run)).toMatchObject({ switchStatus: 'failed', switchError: SWITCH_STALLED_ERROR });

    // The job of the old press arrives late: it claims nothing, so the counter the apply needs does not move.
    const attempt = (await runRow(run)).attempt;
    expect(await switcherOf().run(run, false, admin.staffId)).toBe('not_queued');
    expect((await runRow(run)).attempt).toBe(attempt);
    expect((await listingsOf()).map((listing) => listing.isListed)).toEqual([true, true]);
    expect(await runnerOf().run(run)).toBe('succeeded');

    // The close leaves no switch that reads alive, so this is no false 409.
    const again = await switchRun(run, false);
    expect(again.status).toBe(202);
    expect(again.body.switch).toMatchObject({ status: 'queued', error: null });
    expect(await switcherOf().run(run, false, admin.staffId)).toBe('done');
    expect((await listingsOf()).map((listing) => listing.isListed)).toEqual([false, false]);
  });

  it('a resume closes a running switch that stalled: its worker fails every guard and writes nothing', async () => {
    const { run } = await failedWithSwitch(1);
    const claimed = (await claimSwitch(db, run, false, clock.now()))!;
    const worker = { runId: run, attempt: claimed.attempt };
    clock.advance(6 * MINUTE);
    expect((await admin.get(runUrl(run))).body.switch).toMatchObject({ status: 'failed', error: SWITCH_STALLED_ERROR });

    expect((await applyRun(run)).status).toBe(202);

    expect((await admin.get(runUrl(run))).body.switch).toMatchObject({ status: 'failed', error: SWITCH_STALLED_ERROR });
    expect(await beatSwitch(db, worker, { switched: 9, skipped: 9 }, clock.now())).toBe(false);
    const closing = { status: 'done', error: null, switched: 9, skipped: 0, now: clock.now() } as const;
    expect(await closeSwitch(db, worker, closing)).toBeUndefined();
    expect(await runRow(run)).toMatchObject({ switchStatus: 'failed', switchedCount: 0, switchSkippedCount: 0 });
    expect(await runnerOf().run(run)).toBe('succeeded');
    expect((await switchRun(run, true)).status).toBe(202);
  });

  it('a resume leaves a switch that had ended as it was', async () => {
    const { run } = await failedWithSwitch(1);
    expect(await switcherOf().run(run, false, admin.staffId)).toBe('done');

    const res = await applyRun(run);

    expect(res.status).toBe(202);
    expect(res.body.switch).toMatchObject({ status: 'done', listed: false, switched: 1, error: null });
  });

  it('the first apply of a draft has no switch to close', async () => {
    const { run } = await draftOf(1);

    expect((await applyRun(run)).body.switch).toMatchObject({ status: null, listed: null, error: null });
  });

  it('the resume through the routes: the clock moves 6 minutes, the run reads failed, apply answers 202, and again 409 while it runs', async () => {
    const { ids, run } = await draftOf(3);
    expect((await applyRun(run)).status).toBe(202);
    clock.advance(6 * MINUTE);
    expect((await admin.get(runUrl(run))).body).toMatchObject({ status: 'failed', error: STALLED_ERROR });
    // The dead attempt published one service for good and met an unexpected error on another.
    expect(await runnerOf().run(run)).toBe('succeeded');
    await db
      .update(s.listingPublishRuns)
      .set({ status: 'running', finishedAt: null, heartbeatAt: new Date(START) })
      .where(eq(s.listingPublishRuns.id, run));
    await db
      .update(s.listingPublishItems)
      .set({
        result: null,
        resultReason: null,
        resultDetail: null,
        listingId: null,
        publishedPrice: null,
        finishedAt: null,
      })
      .where(and(eq(s.listingPublishItems.runId, run), eq(s.listingPublishItems.serviceId, ids[2]!)));
    await db
      .update(s.listingPublishItems)
      .set({ result: 'refused', resultReason: 'failed', resultDetail: 'unexpected error' })
      .where(and(eq(s.listingPublishItems.runId, run), eq(s.listingPublishItems.serviceId, ids[1]!)));
    await db.delete(s.serviceListings).where(inArray(s.serviceListings.serviceId, [ids[1]!, ids[2]!]));
    expect((await admin.get(runUrl(run))).body.status).toBe('failed');

    const resumed = await applyRun(run);

    expect(resumed.status).toBe(202);
    expect(resumed.body).toMatchObject({ status: 'queued', error: null, finishedAt: null });
    // Rows with a result stay; the row that failed unexpectedly is tried again.
    expect(await itemOf(run, ids[0]!)).toMatchObject({ result: 'published' });
    expect(await itemOf(run, ids[1]!)).toMatchObject({ result: null, resultReason: null });
    const audits = (await auditsOf('started publishing to the storefront')).sort((x, y) => x.id - y.id);
    expect(audits.map((row) => (row.after as { resumed: boolean }).resumed)).toEqual([false, true]);
    const again = await applyRun(run);
    expect(again.status).toBe(409);
    expect(again.body.code).toBe('JOB_ALREADY_RUNNING');

    expect(await runnerOf().run(run)).toBe('succeeded');
    const listings = await listingsOf();
    expect(listings.map((listing) => listing.serviceId).sort()).toEqual([...ids].sort());
    expect((await admin.get(runUrl(run))).body.counts).toMatchObject({ published: 3, pending: 0 });
  });

  it('resumes a run that failed with its draft prepared, and keeps the choice of listed unless staff send one', async () => {
    const { run } = await draftOf(2);
    await db
      .update(s.listingPublishRuns)
      .set({ status: 'failed', error: 'Too many rows failed.', finishedAt: new Date(START), listed: false })
      .where(eq(s.listingPublishRuns.id, run));

    const res = await applyRun(run);

    expect(res.status).toBe(202);
    expect(res.body).toMatchObject({ status: 'queued', error: null, finishedAt: null, listed: false });
    expect((await applyRun(run, { listed: true })).status).toBe(409);
    await db.update(s.listingPublishRuns).set({ status: 'failed' }).where(eq(s.listingPublishRuns.id, run));
    expect((await applyRun(run, { listed: true })).body.listed).toBe(true);
  });

  it('needs storefront:publish: a role that may only prepare previews cannot apply, and the draft stays', async () => {
    const { run } = await draftOf(2);
    const clerk = await adminWith(t, ['storefront:create', 'storefront:read'], { name: 'Clerk' });
    const publisher = await adminWith(t, ['storefront:publish'], { name: 'Publisher' });

    const refused = await applyRun(run, {}, clerk);
    expect(refused.status).toBe(403);
    expect(refused.body.detail).toContain('storefront:publish');
    expect((await runRow(run)).status).toBe('draft');
    expect((await applyRun(run, {}, publisher)).status).toBe(202);
    expect((await admin.withoutCsrf('POST', runUrl(run, '/apply'), {})).status).toBe(403);
  });

  it('answers 404 for an unknown run and 422 for a body that is not an object of the contract', async () => {
    const { run } = await draftOf(1);
    expect((await applyRun(999_999)).status).toBe(404);
    expect((await applyRun(run, { listed: 'yes' })).status).toBe(422);
    expect((await applyRun(run, { other: true })).status).toBe(422);
    expect((await runRow(run)).status).toBe('draft');
  });
});

describe('POST /admin/publish-runs/:id/cancel', () => {
  it('discards a draft: cancelled, the counts, the audit row, and no edit or apply after it', async () => {
    const { ids, run } = await draftOf(2);
    const version = await catalogVersionOf(t);

    const res = await cancelRun(run);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: 'cancelled', finishedAt: START, counts: { published: 0, pending: 2 } });
    expect(await runRow(run)).toMatchObject({
      status: 'cancelled',
      publishedCount: 0,
      skippedCount: 0,
      refusedCount: 0,
    });
    const [audit] = await auditsOf('cancelled publishing run');
    expect(audit).toMatchObject({ entityType: 'publish_run', entityId: run, entityLabel: `Publish run #${run}` });
    expect(audit!.after).toEqual({ status: 'cancelled', total: 2, published: 0, skipped: 0, refused: 0 });
    expect(await catalogVersionOf(t)).toBe(version);
    expect((await patchItem(run, ids[0]!, { brand: 'Apple' })).status).toBe(409);
    expect((await applyRun(run)).status).toBe(409);
    expect((await cancelRun(run)).status).toBe(409);
  });

  it('discards a preview that is still being prepared: the worker then finds nothing to prepare', async () => {
    const w = await world();
    await several(w, 2);
    const id = (await post({ scope: { kind: 'all' } })).body.id as number;

    expect((await cancelRun(id)).body.status).toBe('cancelled');

    expect(await preparer.run(id)).toBe('not_preparing');
    expect(await db.select().from(s.listingPublishItems)).toHaveLength(0);
  });

  it('a role that may only prepare previews discards a draft, and cannot stop a run that is queued or running', async () => {
    const { run } = await draftOf(2);
    const second = await prepared({ scope: { kind: 'all' } });
    const clerk = await adminWith(t, ['storefront:create', 'storefront:read'], { name: 'Clerk' });
    expect((await applyRun(second)).status).toBe(202);

    expect((await cancelRun(run, clerk)).status).toBe(200);
    const queued = await cancelRun(second, clerk);
    expect(queued.status).toBe(403);
    expect(queued.body.detail).toContain('storefront:publish');
    expect((await runRow(second)).status).toBe('queued');
    await db.update(s.listingPublishRuns).set({ status: 'running' }).where(eq(s.listingPublishRuns.id, second));
    expect((await cancelRun(second, clerk)).status).toBe(403);
    expect((await runRow(second)).status).toBe('running');
    expect((await cancelRun(second)).status).toBe(200);
    expect(await auditsOf('cancelled publishing run')).toHaveLength(2);
  });

  it('answers 409 for a run that is over, 404 for an unknown one, and 403 without storefront:create', async () => {
    const { run } = await draftOf(1);
    const viewer = await adminWith(t, ['storefront:read'], { name: 'Viewer' });
    expect((await cancelRun(run, viewer)).status).toBe(403);
    for (const status of ['succeeded', 'failed', 'cancelled'] as const) {
      await db.update(s.listingPublishRuns).set({ status }).where(eq(s.listingPublishRuns.id, run));
      const res = await cancelRun(run);
      expect(res.status, status).toBe(409);
      expect(res.body.code).toBe('CONFLICT');
    }
    expect((await cancelRun(999_999)).status).toBe(404);
    expect(await auditsOf('cancelled publishing run')).toHaveLength(0);
  });

  it('answers 422 for a body with an unknown key, and leaves the run as it is', async () => {
    const { run } = await draftOf(1);

    const res = await admin.post(runUrl(run, '/cancel'), { reason: 'not needed' });

    expect(res.status).toBe(422);
    expect(res.body.code).toBe('VALIDATION_FAILED');
    expect((await runRow(run)).status).toBe('draft');
  });

  it('stops a run between two chunks: the rows done keep their result, the worker stops, the counts and the price version follow', async () => {
    const w = await world();
    await makeRule();
    const ids = await several(w, PUBLISH_CHUNK + 5);
    const run = await prepared({ scope: { kind: 'all' } });
    expect((await applyRun(run)).status).toBe(202);
    const version = await catalogVersionOf(t);
    let answer: Awaited<ReturnType<typeof cancelRun>> | undefined;

    const outcome = await runnerOf().run(run, {
      afterChunk: async () => {
        answer ??= await cancelRun(run);
      },
    });

    expect(outcome).toBe('stopped');
    expect(answer?.status).toBe(200);
    expect(answer?.body).toMatchObject({
      status: 'cancelled',
      counts: { published: PUBLISH_CHUNK, pending: 5 },
    });
    const rows = await db
      .select()
      .from(s.listingPublishItems)
      .where(eq(s.listingPublishItems.runId, run))
      .orderBy(asc(s.listingPublishItems.id));
    expect(rows.filter((row) => row.result === 'published')).toHaveLength(PUBLISH_CHUNK);
    expect(rows.filter((row) => row.result === null)).toHaveLength(5);
    expect(await listingsOf()).toHaveLength(PUBLISH_CHUNK);
    expect(await runRow(run)).toMatchObject({ status: 'cancelled', publishedCount: PUBLISH_CHUNK });
    const [audit] = await auditsOf('cancelled publishing run');
    expect(audit!.after).toMatchObject({ status: 'cancelled', total: ids.length, published: PUBLISH_CHUNK });
    // The run wrote prices, so the catalog price version moved with the cancel.
    expect(await catalogVersionOf(t)).not.toBe(version);
    expect(await auditsOf('published services to the storefront')).toHaveLength(0);
  });
});

describe('POST /admin/publish-runs/:id/listed', () => {
  /** A run that published three services, switched on. */
  async function published() {
    const { ids, run } = await draftOf(3);
    expect((await applyRun(run)).status).toBe(202);
    expect(await runnerOf().run(run)).toBe('succeeded');
    return { ids, run };
  }

  it('queues the switch: the target on the run, the counters zeroed, the event and the audit row; the worker then follows it', async () => {
    const { ids, run } = await published();

    const off = await switchRun(run, false);

    expect(off.status).toBe(202);
    expect(off.body).toMatchObject({
      status: 'succeeded',
      listed: false,
      switch: { status: 'queued', listed: false, switched: 0, skipped: 0, error: null },
    });
    const [event] = await eventsOf(PUBLISH_SET_LISTED_EVENT);
    expect(jobDataOf(event!).payload).toEqual({ runId: run, listed: false, requestedBy: admin.staffId });
    const [audit] = await auditsOf('started switching publishing run');
    expect(audit).toMatchObject({ entityType: 'publish_run', entityId: run });
    expect(audit!.after).toEqual({ listed: false, published: 3 });

    expect(await switcherOf().run(run, false, admin.staffId)).toBe('done');
    expect((await listingsOf()).map((listing) => listing.isListed)).toEqual([false, false, false]);
    expect((await admin.get(runUrl(run))).body.switch).toMatchObject({ status: 'done', listed: false, switched: 3 });
    expect((await itemsOf(run)).map((row) => row.listingListed)).toEqual([false, false, false]);

    // Put it back: allowed again after a switch that is done.
    expect((await switchRun(run, true)).body.switch).toMatchObject({ status: 'queued', listed: true, switched: 0 });
    expect(await switcherOf().run(run, true, admin.staffId)).toBe('done');
    expect((await listingsOf()).map((listing) => listing.isListed)).toEqual([true, true, true]);
    expect(ids).toHaveLength(3);
  });

  it('answers 409 JOB_ALREADY_RUNNING while a switch is queued or running, and takes a press again after one that stalled', async () => {
    const { run } = await published();
    expect((await switchRun(run, false)).status).toBe(202);

    const again = await switchRun(run, true);
    expect(again.status).toBe(409);
    expect(again.body).toMatchObject({ code: 'JOB_ALREADY_RUNNING', detail: 'This run is being switched.' });
    expect(await eventsOf(PUBLISH_SET_LISTED_EVENT)).toHaveLength(1);

    clock.advance(6 * MINUTE);
    expect((await admin.get(runUrl(run))).body.switch).toMatchObject({ status: 'failed' });
    expect((await switchRun(run, true)).status).toBe(202);
  });

  it('refuses a run that is not finished, and one that published nothing', async () => {
    const { run } = await draftOf(2);
    const preparing = (await post({ scope: { kind: 'all' } })).body.id as number;
    const notFinished = { code: 'CONFLICT', detail: 'Only a finished run can be switched.' };

    expect((await switchRun(run, false)).body).toMatchObject(notFinished);
    expect((await switchRun(preparing, false)).body).toMatchObject(notFinished);
    expect((await applyRun(run)).status).toBe(202);
    expect((await switchRun(run, false)).body).toMatchObject(notFinished);

    await db.update(s.listingPublishRuns).set({ status: 'cancelled' }).where(eq(s.listingPublishRuns.id, run));
    const empty = await switchRun(run, false);
    expect(empty.status).toBe(409);
    expect(empty.body).toMatchObject({ code: 'CONFLICT', detail: 'This run published nothing.' });
    expect(await eventsOf(PUBLISH_SET_LISTED_EVENT)).toHaveLength(0);
    expect(await auditsOf('started switching publishing run')).toHaveLength(0);
  });

  it('switches what a cancelled run published: the run stays cancelled and its listings follow', async () => {
    const { run } = await draftOf(2);
    expect((await applyRun(run)).status).toBe(202);
    let cancelled: Awaited<ReturnType<typeof cancelRun>> | undefined;
    const outcome = await runnerOf().run(run, {
      afterChunk: async () => {
        cancelled ??= await cancelRun(run);
      },
    });
    expect(outcome).toBe('stopped');
    expect(cancelled?.body).toMatchObject({ status: 'cancelled', counts: { published: 2 } });

    const res = await switchRun(run, false);

    expect(res.status).toBe(202);
    expect(res.body).toMatchObject({ status: 'cancelled', listed: false, switch: { status: 'queued', listed: false } });
    expect((await auditsOf('started switching publishing run'))[0]!.after).toEqual({ listed: false, published: 2 });
    expect(await switcherOf().run(run, false, admin.staffId)).toBe('done');
    expect((await listingsOf()).map((listing) => listing.isListed)).toEqual([false, false]);
    expect((await admin.get(runUrl(run))).body).toMatchObject({
      status: 'cancelled',
      switch: { status: 'done', switched: 2 },
    });
  });

  it('closes a run that stalled first: failed with its sentence, the counters from the rows, its close audit row and the price version', async () => {
    const { run } = await published();
    // The worker died after publishing, before its close.
    await db
      .update(s.listingPublishRuns)
      .set({ status: 'running', error: null, finishedAt: null, publishedCount: 0, heartbeatAt: new Date(START) })
      .where(eq(s.listingPublishRuns.id, run));
    expect((await switchRun(run, false)).status).toBe(409);
    clock.advance(6 * MINUTE);
    const version = await catalogVersionOf(t);

    const res = await switchRun(run, false);

    expect(res.status).toBe(202);
    expect(res.body).toMatchObject({
      status: 'failed',
      error: STALLED_ERROR,
      switch: { status: 'queued', listed: false },
    });
    expect(await runRow(run)).toMatchObject({ status: 'failed', publishedCount: 3, error: STALLED_ERROR });
    const closes = await auditsOf('published services to the storefront');
    expect(closes.find((row) => (row.after as { status: string }).status === 'failed')!.after).toMatchObject({
      published: 3,
      error: STALLED_ERROR,
    });
    expect(await auditsOf('started switching publishing run')).toHaveLength(1);
    expect(await catalogVersionOf(t)).not.toBe(version);
    // A worker that wakes up later finds the run closed and writes nothing.
    expect(await runnerOf().run(run)).toBe('not_queued');
  });

  it('needs storefront:publish and a body with the target; 404 for an unknown run', async () => {
    const { run } = await published();
    const clerk = await adminWith(t, ['storefront:create', 'storefront:read'], { name: 'Clerk' });

    const refused = await switchRun(run, false, clerk);
    expect(refused.status).toBe(403);
    expect(refused.body.detail).toContain('storefront:publish');
    expect((await switchRun(999_999, false)).status).toBe(404);
    expect((await admin.post(runUrl(run, '/listed'), {})).status).toBe(422);
    expect((await admin.post(runUrl(run, '/listed'), { listed: 'no' })).status).toBe(422);
    expect((await admin.withoutCsrf('POST', runUrl(run, '/listed'), { listed: false })).status).toBe(403);
    expect((await runRow(run)).switchStatus).toBeNull();
  });
});

/** A transaction that did `work` and stays open until `commit`: the lock of another connection (a worker's row, an edit in flight). */
async function holding(work: (tx: Transaction) => Promise<unknown>) {
  let release!: () => void;
  const released = new Promise<void>((resolve) => (release = resolve));
  let opened!: () => void;
  const ready = new Promise<void>((resolve) => (opened = resolve));
  const done = t.app.get(DbService).runInTransaction(async ({ tx }) => {
    await work(tx);
    opened();
    await released;
  });
  await Promise.race([ready, done]);
  return {
    commit: () => {
      release();
      return done;
    },
  };
}

/** Waits until a statement on the run table waits for a lock (the request is blocked, not finished). */
const waitsOnRunRow = () =>
  eventually(async () => {
    const { rows } = await db.execute(sql`
      select 1 from pg_stat_activity
      where datname = current_database() and wait_event_type = 'Lock' and query like '%"listing_publish_runs"%'`);
    return rows.length > 0 ? true : undefined;
  }, 20_000);

const holdRunShared = (runId: number) =>
  holding((tx) => tx.select().from(s.listingPublishRuns).where(eq(s.listingPublishRuns.id, runId)).for('share'));

describe('the locks of a draft (plan 31 section 6.5)', () => {
  it('an edit waits for an apply that holds the run row, then answers 409 and writes nothing', async () => {
    const { ids, run } = await draftOf(1);
    const before = await itemOf(run, ids[0]!);
    // An apply between its lock and its commit: the run row held FOR UPDATE, the status already moved.
    const apply = await holding(async (tx) => {
      await tx.select().from(s.listingPublishRuns).where(eq(s.listingPublishRuns.id, run)).for('update');
      await tx.update(s.listingPublishRuns).set({ status: 'queued' }).where(eq(s.listingPublishRuns.id, run));
    });

    const edit = patchItem(run, ids[0]!, { brand: 'Edited brand' });
    await waitsOnRunRow();
    await apply.commit();
    const res = await edit;

    expect(res.status).toBe(409);
    expect(res.body.detail).toBe('This run is no longer a draft.');
    expect((await itemOf(run, ids[0]!)).brand).toBe(before.brand);
  });

  it('an apply waits for an edit in flight, which holds the run row FOR SHARE, and then publishes the edited row', async () => {
    const { ids, run } = await draftOf(1);
    const row = await itemOf(run, ids[0]!);
    const editing = await holding(async (tx) => {
      await tx.select().from(s.listingPublishRuns).where(eq(s.listingPublishRuns.id, run)).for('share');
      await tx.update(s.listingPublishItems).set({ title: 'Held title' }).where(eq(s.listingPublishItems.id, row.id));
    });

    const apply = applyRun(run);
    await waitsOnRunRow();
    expect((await runRow(run)).status).toBe('draft');
    await editing.commit();

    expect((await apply).status).toBe(202);
    expect(await runnerOf().run(run)).toBe('succeeded');
    expect((await listingsOf())[0]).toMatchObject({ serviceId: ids[0], publicTitle: 'Held title' });
  });

  it('after "Check again" an edit, a bulk and an apply of the old draft answer 409 and change nothing', async () => {
    const { ids, run } = await draftOf(2);
    const before = await itemOf(run, ids[0]!);
    const again = await post({ scope: { kind: 'run', runId: run } });
    expect(again.status).toBe(202);

    const edited = await patchItem(run, ids[0]!, { brand: 'Edited brand' });
    expect(edited.status).toBe(409);
    expect(edited.body).toMatchObject({ code: 'CONFLICT', detail: 'This run is no longer a draft.' });
    const changed = await bulk(run, { select: { filter: {} }, set: { included: false } });
    expect(changed.status).toBe(409);
    expect(changed.body).toMatchObject({ code: 'CONFLICT', detail: 'This run is no longer a draft.' });
    const applied = await applyRun(run);
    expect(applied.status).toBe(409);
    expect(applied.body).toMatchObject({ code: 'CONFLICT', detail: 'This run is finished. Start a new one.' });

    expect(await itemOf(run, ids[0]!)).toEqual(before);
    expect(await runRow(run)).toMatchObject({ status: 'cancelled', replacedByRunId: again.body.id });
    expect(await eventsOf(PUBLISH_APPLY_EVENT)).toHaveLength(0);
    expect(await auditsOf('started publishing to the storefront')).toHaveLength(0);
  });

  it('"Check again" waits for an apply that holds the run row, then answers 409 and cancels nothing', async () => {
    const { run } = await draftOf(1);
    const apply = await holding(async (tx) => {
      await tx.select().from(s.listingPublishRuns).where(eq(s.listingPublishRuns.id, run)).for('update');
      await tx.update(s.listingPublishRuns).set({ status: 'queued' }).where(eq(s.listingPublishRuns.id, run));
    });

    const checking = post({ scope: { kind: 'run', runId: run } });
    await waitsOnRunRow();
    await apply.commit();
    const res = await checking;

    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ code: 'CONFLICT', detail: 'That run is still working.' });
    expect(await runRow(run)).toMatchObject({ status: 'queued', replacedByRunId: null });
    expect(await db.select().from(s.listingPublishRuns)).toHaveLength(1);
    expect(await auditsOf('cancelled publishing run')).toHaveLength(0);
  });

  it('"Check again" waits for an edit in flight, which holds the run row FOR SHARE, and then copies the edited row', async () => {
    const { ids, run } = await draftOf(2);
    const row = await itemOf(run, ids[0]!);
    const editing = await holding(async (tx) => {
      await tx.select().from(s.listingPublishRuns).where(eq(s.listingPublishRuns.id, run)).for('share');
      await tx
        .update(s.listingPublishItems)
        .set({ title: 'Edit in flight', edited: true })
        .where(eq(s.listingPublishItems.id, row.id));
    });

    const checking = post({ scope: { kind: 'run', runId: run } });
    await waitsOnRunRow();
    expect((await runRow(run)).status).toBe('draft');
    expect(await db.select().from(s.listingPublishRuns)).toHaveLength(1);
    await editing.commit();
    const res = await checking;

    expect(res.status).toBe(202);
    expect(await runRow(run)).toMatchObject({ status: 'cancelled', replacedByRunId: res.body.id });
    expect(await preparer.run(res.body.id)).toBe('draft');
    expect(await itemOf(res.body.id, ids[0]!)).toMatchObject({ title: 'Edit in flight', edited: true });
  });

  it('a bulk, a cancel and the run switch wait for a row in flight, which holds the run row FOR SHARE, and then go on', async () => {
    const { ids, run } = await draftOf(2);
    const row = await itemOf(run, ids[0]!);

    const first = await holdRunShared(run);
    const bulking = bulk(run, { select: { itemIds: [row.id] }, set: { included: false } });
    await waitsOnRunRow();
    expect((await itemOf(run, ids[0]!)).included).toBe(true);
    await first.commit();
    expect((await bulking).body).toEqual({ changed: 1, refused: 0 });

    const second = await holdRunShared(run);
    const cancelling = cancelRun(run);
    await waitsOnRunRow();
    expect((await runRow(run)).status).toBe('draft');
    await second.commit();
    expect((await cancelling).status).toBe(200);
    expect((await runRow(run)).status).toBe('cancelled');

    await db
      .update(s.listingPublishRuns)
      .set({ status: 'succeeded', switchStatus: null, switchListed: null })
      .where(eq(s.listingPublishRuns.id, run));
    await db.update(s.listingPublishItems).set({ result: 'published' }).where(eq(s.listingPublishItems.id, row.id));
    const third = await holdRunShared(run);
    const switching = switchRun(run, false);
    await waitsOnRunRow();
    expect((await runRow(run)).switchStatus).toBeNull();
    await third.commit();
    expect((await switching).status).toBe(202);
  });

  it('two edits of one row serialize on the row, and two edits of two rows run side by side', async () => {
    const { ids, run } = await draftOf(2);

    const [one, two, other] = await Promise.all([
      patchItem(run, ids[0]!, { title: 'First title' }),
      patchItem(run, ids[0]!, { title: 'Second title' }),
      patchItem(run, ids[1]!, { title: 'Other title' }),
    ]);

    expect([one.status, two.status, other.status]).toEqual([200, 200, 200]);
    expect(['First title', 'Second title']).toContain((await itemOf(run, ids[0]!)).title);
    expect((await itemOf(run, ids[1]!)).title).toBe('Other title');
  });
});

// --- Slice B6: the scope `quickAddRun` with its real column, the runs of a Quick add run, and the tests the reviews of B3 to B5 left open ---

describe('the scope quickAddRun (plan 31 sections 4.3 and 5.2)', () => {
  /** A Quick add run of a supplier, and the links that say which of the services it made (`import_run_id`). */
  async function quickAddRunOf(serviceIds: readonly number[], supplierId?: number): Promise<number> {
    const owner =
      supplierId ??
      (
        await db
          .insert(s.suppliers)
          .values({
            name: `Quick source ${crypto.randomUUID().slice(0, 6)}`,
            driver: 'dhru',
            baseUrl: 'https://supplier.example',
            paramFormat: 'dhru_xml',
          })
          .returning({ id: s.suppliers.id })
      )[0]!.id;
    const [run] = await db
      .insert(s.supplierImportRuns)
      .values({
        supplierId: owner,
        scope: 'all',
        serviceStatus: 'active',
        status: 'succeeded',
        createdCount: serviceIds.length,
        heartbeatAt: new Date(START),
      })
      .returning({ id: s.supplierImportRuns.id });
    if (serviceIds.length > 0) {
      await db
        .update(s.serviceSupplierLinks)
        .set({ importRunId: run!.id })
        .where(inArray(s.serviceSupplierLinks.serviceId, [...serviceIds]));
    }
    return run!.id;
  }

  it('takes exactly the live services the run made that have no listing, in id order', async () => {
    const w = await world();
    await makeRule();
    const [a, b, c, listed, archived, other, plain] = [
      await service(w, { name: 'Apple iPhone 1 Activation Lock Remove' }),
      await service(w, { name: 'Apple iPhone 2 Activation Lock Remove' }),
      await service(w, { name: 'Apple iPhone 3 Activation Lock Remove' }),
      await service(w, { name: 'Apple iPhone 4 Activation Lock Remove' }),
      await service(w, { name: 'Apple iPhone 5 Activation Lock Remove', values: ARCHIVED }),
      await service(w, { name: 'Apple iPhone 6 Activation Lock Remove' }),
      await service(w, { name: 'Apple iPhone 7 Activation Lock Remove' }),
    ];
    await insertListingRow(db, listed, { slug: 'listed-already', publicTitle: 'Listed already' });
    const quick = await quickAddRunOf([a, b, c, listed, archived]);
    const otherRun = await quickAddRunOf([other]);
    expect(plain).toBeGreaterThan(0);

    const res = await post({ scope: { kind: 'quickAddRun', runId: quick } });

    expect(res.status).toBe(202);
    expect(res.body).toMatchObject({ source: 'console', scope: { kind: 'quickAddRun', runId: quick }, total: 3 });
    expect(await preparer.run(res.body.id)).toBe('draft');
    expect((await itemsOf(res.body.id)).map((row) => row.serviceId)).toEqual([a, b, c]);
    const second = await post({ scope: { kind: 'quickAddRun', runId: otherRun } });
    expect(second.body.total).toBe(1);
  });

  it('keeps a service in its run when staff save its supplier chain, and drops one whose link was removed', async () => {
    const w = await world();
    await makeRule();
    const [kept, dropped] = [
      await service(w, { name: 'Kept in the run' }),
      await service(w, { name: 'Dropped from the run' }),
    ];
    const quick = await quickAddRunOf([kept, dropped]);
    const link = async (serviceId: number) =>
      (await db.select().from(s.serviceSupplierLinks).where(eq(s.serviceSupplierLinks.serviceId, serviceId)))[0]!;
    const keptLink = await link(kept);
    expect(
      (
        await admin.put(`/admin/services/${kept}/supplier-links`, {
          links: [{ supplierServiceId: keptLink.supplierServiceId, priority: 1 }],
        })
      ).status,
    ).toBe(200);
    expect((await admin.put(`/admin/services/${dropped}/supplier-links`, { links: [] })).status).toBe(200);

    const res = await post({ scope: { kind: 'quickAddRun', runId: quick } });

    expect(res.status).toBe(202);
    expect(res.body.total).toBe(1);
    await preparer.run(res.body.id);
    expect((await itemsOf(res.body.id)).map((row) => row.serviceId)).toEqual([kept]);
  });

  it('refuses a Quick add run that made nothing, and one whose services all have a listing, with nothing_to_publish', async () => {
    const w = await world();
    await makeRule();
    const made = await service(w);
    await insertListingRow(db, made, { slug: 'made-already', publicTitle: 'Made already' });
    const empty = await quickAddRunOf([]);
    const listed = await quickAddRunOf([made]);

    for (const runId of [empty, listed]) {
      const res = await post({ scope: { kind: 'quickAddRun', runId } });
      expect(res.status).toBe(422);
      expect(res.body.errors).toEqual([expect.objectContaining({ field: 'scope', code: 'nothing_to_publish' })]);
    }
    expect(await db.select().from(s.listingPublishRuns)).toHaveLength(0);
  });
});

describe('the publish runs of a Quick add run (plan 31 correction 13)', () => {
  it('lists the automatic run it asked for and a run staff started with the scope quickAddRun, and no other', async () => {
    const w = await world();
    await makeRule();
    const [a, b] = [
      await service(w, { name: 'Apple iPhone 1 Activation Lock Remove' }),
      await service(w, { name: 'Apple iPhone 2 Activation Lock Remove' }),
    ];
    const [owner] = await db
      .insert(s.suppliers)
      .values({ name: 'Quick source', driver: 'dhru', baseUrl: 'https://supplier.example', paramFormat: 'dhru_xml' })
      .returning({ id: s.suppliers.id });
    const importRuns = await db
      .insert(s.supplierImportRuns)
      .values(
        [1, 2].map((n) => ({
          supplierId: owner!.id,
          scope: 'all' as const,
          serviceStatus: 'active' as const,
          status: 'succeeded' as const,
          heartbeatAt: new Date(START),
          total: n,
        })),
      )
      .returning({ id: s.supplierImportRuns.id });
    const [first, second] = importRuns.map((row) => row.id) as [number, number];
    await db
      .update(s.serviceSupplierLinks)
      .set({ importRunId: first })
      .where(inArray(s.serviceSupplierLinks.serviceId, [a, b]));
    // The automatic run of the first Quick add run (as the hand-over makes it), a run staff started from its scope later, a run of
    // another Quick add run, and a run of another scope.
    const auto = await post({ scope: { kind: 'all' } });
    await db
      .update(s.listingPublishRuns)
      .set({ source: 'quick_add', sourceRunId: first, scope: { kind: 'quickAddRun', runId: first }, auto: true })
      .where(eq(s.listingPublishRuns.id, auto.body.id));
    clock.advance(MINUTE);
    const byStaff = await post({ scope: { kind: 'quickAddRun', runId: first } });
    expect(byStaff.status).toBe(202);
    const unrelated = await post({ scope: { kind: 'all' } });
    await db.update(s.serviceSupplierLinks).set({ importRunId: second }).where(eq(s.serviceSupplierLinks.serviceId, b));
    const ofSecond = await post({ scope: { kind: 'quickAddRun', runId: second } });
    expect(ofSecond.status).toBe(202);

    const found = async (query: string) =>
      (await admin.get(`/admin/publish-runs?${query}`)).body.map((run: { id: number }) => run.id);
    expect(await found(`quickAddRunId=${first}`)).toEqual([byStaff.body.id, auto.body.id]);
    expect(await found(`quickAddRunId=${second}`)).toEqual([ofSecond.body.id]);
    expect(await found('quickAddRunId=999999')).toEqual([]);
    expect(await found(`quickAddRunId=${first}&quickAddRunId=${second}`)).toEqual([
      ofSecond.body.id,
      byStaff.body.id,
      auto.body.id,
    ]);
    expect(await found(`quickAddRunId=${first}&source=quick_add`)).toEqual([auto.body.id]);
    expect(await found('_sort=id&_order=asc')).toEqual([
      auto.body.id,
      byStaff.body.id,
      unrelated.body.id,
      ofSecond.body.id,
    ]);
    // What each run says of itself is unchanged: only the automatic one names the Quick add run that asked for it.
    expect((await admin.get(runUrl(auto.body.id))).body.quickAddRunId).toBe(first);
    expect((await admin.get(runUrl(byStaff.body.id))).body.quickAddRunId).toBeNull();
  });
});

describe('the prepare job against a run that is cancelled or closed while it works', () => {
  /** Runs `act` the first time the worker reads the facts of a page: the middle of step 4. */
  function duringTheFactsRead(act: () => Promise<unknown>) {
    const facts = t.app.get(PublishDraftFacts, { strict: false });
    const read = facts.read.bind(facts);
    let acted = false;
    spyOn(facts, 'read').mockImplementation(async (...args: Parameters<PublishDraftFacts['read']>) => {
      if (!acted) {
        acted = true;
        await act();
      }
      return read(...args);
    });
  }

  /** Runs `act` once, just before the transaction that closes the prepare (the only transaction of the preparer). */
  function beforeTheClose(act: () => Promise<unknown>) {
    const database = t.app.get(DbService);
    const real = database.runInTransaction.bind(database);
    let armed = true;
    spyOn(database, 'runInTransaction').mockImplementation(((work: never, ...rest: never[]) => {
      if (!armed) return real(work, ...rest);
      armed = false;
      return act().then(() => real(work, ...rest));
    }) as never);
  }

  const unevaluated = async (runId: number) =>
    (await db.select().from(s.listingPublishItems).where(eq(s.listingPublishItems.runId, runId))).filter(
      (row) => row.evaluatedAt === null,
    );

  it('stops when the run is cancelled in the middle of the prepare: nothing more is written, and the run stays cancelled', async () => {
    const w = await world();
    await makeRule();
    await several(w, 3);
    const id = (await post({ scope: { kind: 'all' } })).body.id as number;
    let answer: Awaited<ReturnType<typeof cancelRun>> | undefined;
    duringTheFactsRead(async () => {
      answer = await cancelRun(id);
    });

    expect(await preparer.run(id)).toBe('stopped');

    expect(answer?.status).toBe(200);
    expect(await runRow(id)).toMatchObject({ status: 'cancelled', preparedAt: null, error: null });
    // The rows of step 3 were inserted; step 5 never wrote an evaluation.
    expect(await unevaluated(id)).toHaveLength(3);
    expect(await eventsOf(PUBLISH_APPLY_EVENT)).toHaveLength(0);
    expect(await auditsOf('started publishing to the storefront')).toHaveLength(0);
    expect(await preparer.run(id)).toBe('not_preparing');
  });

  it('stops when the run is closed failed in the middle of the prepare (the stall rule, "Prepare again"): its text is not overwritten', async () => {
    const w = await world();
    await makeRule();
    await several(w, 2);
    const id = (await post({ scope: { kind: 'all' } })).body.id as number;
    duringTheFactsRead(async () => {
      await db
        .update(s.listingPublishRuns)
        .set({ status: 'failed', error: PREPARE_STALLED_ERROR, finishedAt: new Date(START) })
        .where(eq(s.listingPublishRuns.id, id));
    });

    expect(await preparer.run(id)).toBe('stopped');

    expect(await runRow(id)).toMatchObject({ status: 'failed', error: PREPARE_STALLED_ERROR, preparedAt: null });
    expect(await unevaluated(id)).toHaveLength(2);
  });

  it('stops at the close when the run was cancelled after its last row was written: an automatic run publishes nothing', async () => {
    const w = await world();
    await makeRule();
    await several(w, 3);
    const id = (await post({ scope: { kind: 'all' } })).body.id as number;
    await db.update(s.listingPublishRuns).set({ auto: true }).where(eq(s.listingPublishRuns.id, id));
    let answer: Awaited<ReturnType<typeof cancelRun>> | undefined;
    beforeTheClose(async () => {
      answer = await cancelRun(id);
    });

    expect(await preparer.run(id)).toBe('stopped');

    expect(answer?.status).toBe(200);
    expect(await runRow(id)).toMatchObject({ status: 'cancelled', preparedAt: null });
    // Every row was evaluated before the cancel; the guarded close wrote nothing, so the run is not queued and no apply was asked for.
    expect(await unevaluated(id)).toHaveLength(0);
    expect(await eventsOf(PUBLISH_APPLY_EVENT)).toHaveLength(0);
    expect(await auditsOf('started publishing to the storefront')).toHaveLength(0);
    expect(await listingsOf()).toHaveLength(0);
  });
});

describe('the rows of a run whose preview was not finished', () => {
  it('lists them with an empty detection while it is prepared, and after it failed', async () => {
    const w = await world();
    const [first, second] = await several(w, 2);
    const id = (await post({ scope: { kind: 'all' } })).body.id as number;
    // What the preparer's first step leaves: the rows exist, and the naming has not reached them.
    await db.insert(s.listingPublishItems).values([
      { runId: id, serviceId: first! },
      { runId: id, serviceId: second! },
    ]);

    const rows = await itemsOf(id);

    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      serviceId: first,
      state: 'blocked',
      included: false,
      retailPrice: null,
      evaluatedAt: null,
      detected: { title: '', slug: '', brand: '', brandKind: null, carrier: '', country: '' },
    });

    await db
      .update(s.listingPublishRuns)
      .set({ status: 'failed', error: 'The preview broke.', finishedAt: new Date(START) })
      .where(eq(s.listingPublishRuns.id, id));
    expect(await itemsOf(id)).toHaveLength(2);
  });
});

describe('the note of a scope cut at the most a run takes (plan 31 section 6.1 step 2)', () => {
  it('takes the first services in id order and says so in error; a scope at the limit says nothing', async () => {
    const w = await world();
    await makeRule();
    const ids = await several(w, 5);
    const cut = (await post({ scope: { kind: 'all' } })).body.id as number;

    expect(await preparer.run(cut, { maxItems: 3 })).toBe('draft');

    expect(await runRow(cut)).toMatchObject({
      status: 'draft',
      total: 3,
      error: 'The choice has more than 3 services. This run holds the first 3.',
    });
    expect((await itemsOf(cut)).map((row) => row.serviceId)).toEqual(ids.slice(0, 3));
    expect((await admin.get(runUrl(cut))).body).toMatchObject({ total: 3, error: scopeTruncatedError(3) });

    const exact = (await post({ scope: { kind: 'all' } })).body.id as number;
    expect(await preparer.run(exact, { maxItems: 5 })).toBe('draft');
    expect(await runRow(exact)).toMatchObject({ total: 5, error: null });
  });

  it('keeps the note on an automatic run that goes on to be published, with the rows it took', async () => {
    const w = await world();
    await makeRule();
    const ids = await several(w, 4);
    const id = (await post({ scope: { kind: 'all' } })).body.id as number;
    await db.update(s.listingPublishRuns).set({ auto: true }).where(eq(s.listingPublishRuns.id, id));

    expect(await preparer.run(id, { maxItems: 2 })).toBe('queued');

    expect(await runRow(id)).toMatchObject({ status: 'queued', total: 2, error: scopeTruncatedError(2) });
    expect(await runnerOf().run(id)).toBe('succeeded');
    expect((await listingsOf()).map((listing) => listing.serviceId)).toEqual(ids.slice(0, 2));
    // The close of a run that went well writes nothing over it: the run still says it took only the first services.
    expect(await runRow(id)).toMatchObject({ status: 'succeeded', error: scopeTruncatedError(2) });
    expect((await admin.get(runUrl(id))).body).toMatchObject({ status: 'succeeded', error: scopeTruncatedError(2) });
  });

  it('keeps the note of a draft through its apply, to the end of the run', async () => {
    const w = await world();
    await makeRule();
    await several(w, 4);
    const id = (await post({ scope: { kind: 'all' } })).body.id as number;
    expect(await preparer.run(id, { maxItems: 2 })).toBe('draft');

    const applied = await applyRun(id);

    expect(applied.status).toBe(202);
    expect(applied.body).toMatchObject({ status: 'queued', error: scopeTruncatedError(2) });
    expect(await runnerOf().run(id)).toBe('succeeded');
    expect((await admin.get(runUrl(id))).body).toMatchObject({ status: 'succeeded', error: scopeTruncatedError(2) });
  });

  it('keeps the note of a run that stalled through its resume', async () => {
    const w = await world();
    await makeRule();
    await several(w, 3);
    const id = (await post({ scope: { kind: 'all' } })).body.id as number;
    await db.update(s.listingPublishRuns).set({ auto: true }).where(eq(s.listingPublishRuns.id, id));
    expect(await preparer.run(id, { maxItems: 2 })).toBe('queued');
    clock.advance(6 * MINUTE);
    expect((await admin.get(runUrl(id))).body).toMatchObject({ status: 'failed', error: STALLED_ERROR });

    expect((await applyRun(id)).body).toMatchObject({ status: 'queued', error: scopeTruncatedError(2) });
    expect(await runnerOf().run(id)).toBe('succeeded');
    expect(await runRow(id)).toMatchObject({ status: 'succeeded', error: scopeTruncatedError(2) });
  });

  it('a run that failed loses its failure when it is resumed, and a run with nothing to say stays silent', async () => {
    const { run } = await draftOf(2);
    expect((await applyRun(run)).status).toBe(202);
    expect(await runnerOf().run(run)).toBe('succeeded');
    expect(await runRow(run)).toMatchObject({ status: 'succeeded', error: null });

    await db
      .update(s.listingPublishRuns)
      .set({ status: 'failed', error: 'Too many rows failed.', finishedAt: new Date(START) })
      .where(eq(s.listingPublishRuns.id, run));
    expect((await applyRun(run)).body).toMatchObject({ status: 'queued', error: null });
    expect(await runnerOf().run(run)).toBe('succeeded');
    expect(await runRow(run)).toMatchObject({ status: 'succeeded', error: null });
  });

  it('is the sentence of the real limit for the default', () => {
    expect(SCOPE_TRUNCATED_ERROR).toBe('The choice has more than 5000 services. This run holds the first 5000.');
  });
});

describe('a run that stalled, through the routes (plan 31 sections 5.2 and 6.5)', () => {
  it('resumes a run that stayed queued because no worker took it: 202, the second event, one listing per service', async () => {
    const { ids, run } = await draftOf(3);
    expect((await applyRun(run)).status).toBe(202);
    expect((await applyRun(run)).status).toBe(409);
    clock.advance(6 * MINUTE);
    // Nobody claimed it, so it was never started; it reads failed like any run that stopped moving.
    expect((await admin.get(runUrl(run))).body).toMatchObject({
      status: 'failed',
      error: STALLED_ERROR,
      startedAt: null,
    });
    expect((await runRow(run)).status).toBe('queued');

    const resumed = await applyRun(run, { listed: false });

    expect(resumed.status).toBe(202);
    expect(resumed.body).toMatchObject({ status: 'queued', error: null, listed: false });
    expect(await eventsOf(PUBLISH_APPLY_EVENT)).toHaveLength(2);
    const starts = (await auditsOf('started publishing to the storefront')).sort((x, y) => x.id - y.id);
    expect(starts.map((row) => (row.after as { resumed: boolean }).resumed)).toEqual([false, true]);
    expect((await applyRun(run)).status).toBe(409);

    // Both jobs reach the worker: one claims, the other finds nothing.
    expect(await runnerOf().run(run)).toBe('succeeded');
    expect(await runnerOf().run(run)).toBe('not_queued');
    const listings = await listingsOf();
    expect(listings.map((listing) => [listing.serviceId, listing.isListed])).toEqual(ids.map((id) => [id, false]));
    expect((await admin.get(runUrl(run))).body.counts).toMatchObject({ published: 3, pending: 0 });
  });

  it('switches a resumed run that stalled while queued: it is closed failed first, with its sentence, and its late job writes nothing', async () => {
    const { run } = await draftOf(3);
    expect((await applyRun(run)).status).toBe(202);
    expect(await runnerOf().run(run)).toBe('succeeded');
    // The first attempt ended with too many failed rows; staff resume, and no worker takes the second attempt.
    await db
      .update(s.listingPublishRuns)
      .set({ status: 'failed', error: 'Too many rows failed.', finishedAt: new Date(START) })
      .where(eq(s.listingPublishRuns.id, run));
    expect((await applyRun(run)).body).toMatchObject({ status: 'queued', error: null });
    expect(await switchRun(run, false)).toMatchObject({ status: 409 });
    clock.advance(6 * MINUTE);
    const version = await catalogVersionOf(t);

    const res = await switchRun(run, false);

    expect(res.status).toBe(202);
    expect(res.body).toMatchObject({
      status: 'failed',
      error: STALLED_ERROR,
      counts: { published: 3, pending: 0 },
      switch: { status: 'queued', listed: false },
    });
    expect(await runRow(run)).toMatchObject({ status: 'failed', publishedCount: 3, error: STALLED_ERROR });
    const closes = (await auditsOf('published services to the storefront')).filter(
      (row) => (row.after as { error?: string }).error === STALLED_ERROR,
    );
    expect(closes).toHaveLength(1);
    expect(closes[0]!.after).toMatchObject({ status: 'failed', published: 3 });
    expect(await catalogVersionOf(t)).not.toBe(version);
    // The job of the second apply arrives late: the run is not queued any more.
    expect(await runnerOf().run(run)).toBe('not_queued');
    expect(await switcherOf().run(run, false, admin.staffId)).toBe('done');
    expect((await listingsOf()).map((listing) => listing.isListed)).toEqual([false, false, false]);
  });

  it('cancels a run that stalled while queued, and the worker that wakes up later finds nothing to claim', async () => {
    const { run } = await draftOf(2);
    expect((await applyRun(run)).status).toBe(202);
    clock.advance(6 * MINUTE);
    expect((await admin.get(runUrl(run))).body.status).toBe('failed');
    const clerk = await adminWith(t, ['storefront:create', 'storefront:read'], { name: 'Clerk' });
    // By its stored status it is still publishing, so stopping it needs storefront:publish.
    expect((await cancelRun(run, clerk)).status).toBe(403);

    const res = await cancelRun(run);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: 'cancelled', error: null });
    expect(await runRow(run)).toMatchObject({ status: 'cancelled', publishedCount: 0 });
    expect(await auditsOf('cancelled publishing run')).toHaveLength(1);
    expect(await runnerOf().run(run)).toBe('not_queued');
    expect(await listingsOf()).toHaveLength(0);
    // A cancelled run does not read as stalled any more, and cannot be applied.
    clock.advance(6 * MINUTE);
    expect((await admin.get(runUrl(run))).body.status).toBe('cancelled');
    expect((await applyRun(run)).status).toBe(409);
  });

  it('cancels a run that stalled while running, keeping what it published, and moves the price version', async () => {
    const w = await world();
    await makeRule();
    await several(w, PUBLISH_CHUNK + 4);
    const run = await prepared({ scope: { kind: 'all' } });
    expect((await applyRun(run)).status).toBe(202);
    // The worker published its first chunk and died.
    let stalled = false;
    expect(
      await runnerOf().run(run, {
        afterChunk: async () => {
          if (stalled) return;
          stalled = true;
          clock.advance(6 * MINUTE);
          expect((await admin.get(runUrl(run))).body.status).toBe('failed');
          expect((await cancelRun(run)).status).toBe(200);
        },
      }),
    ).toBe('stopped');
    expect(await runRow(run)).toMatchObject({ status: 'cancelled', publishedCount: PUBLISH_CHUNK });
    expect(await listingsOf()).toHaveLength(PUBLISH_CHUNK);
    expect((await admin.get(runUrl(run))).body).toMatchObject({
      status: 'cancelled',
      counts: { published: PUBLISH_CHUNK, pending: 4 },
    });
  });

  it('cancels a preview that stalled while it was prepared, with only storefront:create', async () => {
    const w = await world();
    await makeRule();
    await several(w, 2);
    const id = (await post({ scope: { kind: 'all' } })).body.id as number;
    clock.advance(6 * MINUTE);
    expect((await admin.get(runUrl(id))).body).toMatchObject({ status: 'failed', error: PREPARE_STALLED_ERROR });
    const clerk = await adminWith(t, ['storefront:create', 'storefront:read'], { name: 'Clerk' });

    const res = await cancelRun(id, clerk);

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('cancelled');
    expect(await preparer.run(id)).toBe('not_preparing');
    expect(await db.select().from(s.listingPublishItems)).toHaveLength(0);
  });
});

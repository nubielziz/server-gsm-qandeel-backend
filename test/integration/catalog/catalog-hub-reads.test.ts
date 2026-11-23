// Integration tests of the Catalog page's reads on the service routes (decision 060): the shop price and its source, the attention
// reasons, the shop page facts by permission on the list, show, POST and PATCH answers, the new filters with their 403, the shop price
// sort, the shop block against the storefront's publish rule, and why the last publish attempt was refused.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { type Database, schema as s } from '@src/infra/db';
import { SHOP_BLOCKS } from '@src/modules/catalog/domain/service-attention';
import { publishFactsOf } from '@src/modules/storefront/infra/foreign-reads.repository';
import { NAMING_RULES_VERSION } from '@src/modules/storefront/publish/domain/naming';
import { evaluateItem } from '@src/modules/storefront/publish/domain/publish-item';
import { type AdminApi, adminWith } from '../../support/admin-api';
import { type TestApp, createTestApp } from '../../support/app';
import { clearIdentityCaches } from '../../support/auth';
import { insertCategory, insertService, insertSupplierLink } from '../../support/catalog';
import { MINUTE, TestClock } from '../../support/clock';
import { closeTestDb, resetDb, testDb } from '../../support/db';
import { insertDemoGroups } from '../../support/pricing';
import { insertListingRow, insertRetailPrice } from '../../support/storefront';

const clock = new TestClock();
let t: TestApp;
/** The four readers of decision 060: an Owner, the catalog alone, plus the shop pages, plus the retail pricing. */
let owner: AdminApi;
let catalogOnly: AdminApi;
let shopReader: AdminApi;
let priceReader: AdminApi;

beforeAll(async () => {
  t = await createTestApp({ clock });
});
beforeEach(async () => {
  clock.reset();
  await resetDb();
  await clearIdentityCaches(t);
  owner = await adminWith(t, ['*']);
  catalogOnly = await adminWith(t, ['catalog:*', 'pricing:update']);
  shopReader = await adminWith(t, ['catalog:*', 'storefront:read']);
  priceReader = await adminWith(t, ['catalog:*', 'pricing:read', 'pricing:update']);
});
afterAll(async () => {
  await resetDb();
  await clearIdentityCaches(t);
  await t.close();
  await closeTestDb();
});

/** The keys every reader gets, and the keys that depend on the reader's permissions (decision 060). */
const ALWAYS_KEYS = ['attention', 'retailPrice', 'retailPriceSource'];
const PERMISSION_KEYS = [
  'retailPriceRule',
  'retailPriceWaiting',
  'listingId',
  'isListed',
  'shopBlocked',
  'publishFailure',
];

interface Row {
  readonly id: number;
  readonly name: string;
  readonly status: string;
  readonly attention: string[];
  readonly isListed?: boolean;
  readonly shopBlocked?: string | null;
  readonly retailPrice: string | null;
}

/** The demo's groups (the last is the shop's retail group) and one category open to every group. */
async function world() {
  const { db } = await testDb();
  const groups = await insertDemoGroups(db);
  const category = await insertCategory(db, { name: 'Carrier unlock' });
  return { db, groups, category };
}

/** A service priced well above its floor (cost 1, price 5), automatic, with no link unless the test adds one. */
const serviceIn = (
  db: Database,
  category: number,
  name: string,
  values: Partial<typeof s.services.$inferInsert> = {},
) => insertService(db, category, { name, cost: '1.0000', effectiveCost: '1.0000', basePrice: '5.0000', ...values });

/** A waiting proposal of the shop price (or, with values, a resolved one). */
async function insertProposal(
  db: Database,
  serviceId: number,
  values: Partial<typeof s.retailPriceChanges.$inferInsert> = {},
): Promise<void> {
  await db.insert(s.retailPriceChanges).values({
    serviceId,
    kind: 'proposed',
    reason: 'cost_changed',
    oldPrice: '10.0000',
    newPrice: '13.0000',
    oldCost: '7.0000',
    newCost: '9.0000',
    ...values,
  });
}

/** One publish attempt of a service in a run of its own, with its result written at a time; returns the run id. */
async function insertAttempt(
  db: Database,
  serviceId: number,
  result: 'published' | 'skipped' | 'refused' | null,
  at: Date,
  values: Partial<typeof s.listingPublishItems.$inferInsert> = {},
): Promise<number> {
  const [run] = await db
    .insert(s.listingPublishRuns)
    .values({
      status: 'succeeded',
      source: 'console',
      scope: { kind: 'services', serviceIds: [serviceId] },
      rulesVersion: NAMING_RULES_VERSION,
      total: 1,
      heartbeatAt: at,
    })
    .returning({ id: s.listingPublishRuns.id });
  const reason = result === 'refused' ? 'below_floor' : result === 'skipped' ? 'left_out' : null;
  await db.insert(s.listingPublishItems).values({
    runId: run!.id,
    serviceId,
    title: 'A title',
    result,
    resultReason: reason,
    resultDetail: result === 'refused' ? 'Below the storefront floor of $5.50.' : null,
    finishedAt: result === null ? null : at,
    ...values,
  });
  return run!.id;
}

const ids = (body: ReadonlyArray<{ id: number }>) => body.map((row) => row.id);
const all = async (api: AdminApi, filter = ''): Promise<{ rows: Row[]; total: number }> => {
  const res = await api.get(`/admin/services?_start=0&_end=1000${filter}`);
  expect(res.status).toBe(200);
  return { rows: res.body as Row[], total: res.total };
};
const minutesFromNow = (minutes: number) => new Date(clock.now().getTime() + minutes * MINUTE);

describe('the Catalog page facts of a service row (decision 060)', () => {
  it('sends the shop price to everyone, the rule and the proposal with pricing:read and the shop page with storefront:read, on the list, show and PATCH answers', async () => {
    const { db, groups, category } = await world();
    const id = await insertService(db, category, {
      name: 'Alpha unlock',
      code: 'IMEI-ALPHA',
      cost: '10.0000',
      effectiveCost: '10.0000',
      basePrice: '15.0000',
      minProfit: '1.0000',
      slaMinutes: 60,
    });
    const link = await insertSupplierLink(db, id, { supplier: 'Alpha supplier', credit: '10' });
    await insertRetailPrice(db, id, groups.retail, '25.9900');
    const listingId = await insertListingRow(db, id, { isListed: true });

    const base = {
      id,
      name: 'Alpha unlock',
      code: 'IMEI-ALPHA',
      type: 'imei',
      status: 'active',
      executionMode: 'auto',
      categoryId: category,
      category: { id: category, name: 'Carrier unlock' },
      basePrice: '15.0000',
      cost: '10.0000',
      costChangedFrom: null,
      minProfit: '1.0000',
      floorPrice: '11.0000',
      marginPct: '33.3333',
      belowFloor: false,
      slaMinutes: 60,
      supplier: { id: link.supplierId, name: 'Alpha supplier' },
      fallbackSupplier: null,
      allowCancel: false,
      allowVerify: false,
      verifyWindowH: 0,
      minQty: 1,
      maxQty: 1,
      qtyOptions: [],
      attention: [],
      retailPrice: '25.9900',
      retailPriceSource: 'manual',
    };
    const pricingKeys = { retailPriceRule: null, retailPriceWaiting: false };
    const listingKeys = { listingId, isListed: true, shopBlocked: null };
    const readers: Array<[string, AdminApi, Record<string, unknown>]> = [
      ['catalog only', catalogOnly, base],
      ['pricing:read', priceReader, { ...base, ...pricingKeys }],
      ['storefront:read', shopReader, { ...base, ...listingKeys }],
      ['owner', owner, { ...base, ...pricingKeys, ...listingKeys }],
    ];
    for (const [who, api, row] of readers) {
      const list = await api.get('/admin/services');
      expect(list.status, who).toBe(200);
      expect(list.body, who).toEqual([row]);
      const show = await api.get(`/admin/services/${id}`);
      expect(show.body, who).toEqual({
        ...row,
        fields: [],
        options: [],
        groupPrices: [{ groupId: groups.retail, price: '25.9900' }],
        // The refused last publish attempt is a shop page fact too.
        ...('listingId' in row ? { publishFailure: null } : {}),
      });
      const patched = await api.patch(`/admin/services/${id}`, { slaMinutes: 90 });
      expect(patched.status, who).toBe(200);
      expect(patched.body, who).toEqual({ ...row, slaMinutes: 90 });
      await api.patch(`/admin/services/${id}`, { slaMinutes: 60 });
    }
  });

  it('answers POST with the same facts by permission: a new automatic service has no supplier, no shop price and no shop page', async () => {
    const { category } = await world();
    const readers: Array<[AdminApi, Record<string, unknown>]> = [
      [catalogOnly, {}],
      [priceReader, { retailPriceRule: null, retailPriceWaiting: false }],
      [shopReader, { listingId: null, isListed: false, shopBlocked: null }],
      [
        owner,
        { retailPriceRule: null, retailPriceWaiting: false, listingId: null, isListed: false, shopBlocked: null },
      ],
    ];
    for (const [index, [api, keys]] of readers.entries()) {
      const res = await api.post('/admin/services', {
        name: `New check ${index}`,
        code: `IMEI-NEW-${index}`,
        categoryId: category,
        type: 'imei',
        slaMinutes: 90,
        basePrice: '2.5000',
      });
      expect(res.status).toBe(201);
      expect(res.body).toEqual({
        id: expect.any(Number),
        name: `New check ${index}`,
        code: `IMEI-NEW-${index}`,
        type: 'imei',
        status: 'active',
        executionMode: 'auto',
        categoryId: category,
        category: { id: category, name: 'Carrier unlock' },
        basePrice: '2.5000',
        cost: '0.0000',
        costChangedFrom: null,
        minProfit: '0.0200',
        floorPrice: '0.0200',
        marginPct: '100.0000',
        belowFloor: false,
        slaMinutes: 90,
        supplier: null,
        fallbackSupplier: null,
        allowCancel: false,
        allowVerify: false,
        verifyWindowH: 0,
        minQty: 1,
        maxQty: 1,
        qtyOptions: [],
        attention: ['no_supplier'],
        retailPrice: null,
        retailPriceSource: null,
        ...keys,
      });
    }
  });

  it('sends attention, retailPrice and retailPriceSource to a reader with the catalog permissions alone, on the list, show, POST and PATCH answers, and none of the keys that depend on the reader', async () => {
    const { db, category } = await world();
    const bare = await adminWith(t, ['catalog:read', 'catalog:create', 'catalog:update']);
    // No supplier, no shop price, no shop page: the keys are there with their empty values, not left out.
    const id = await serviceIn(db, category, 'Bare check');
    const created = await bare.post('/admin/services', {
      name: 'Bare new check',
      code: 'IMEI-BARE-NEW',
      categoryId: category,
      type: 'imei',
      slaMinutes: 90,
      basePrice: '2.5000',
    });
    expect(created.status).toBe(201);
    const list = await all(bare);
    const show = await bare.get(`/admin/services/${id}`);
    const patched = await bare.patch(`/admin/services/${id}`, { slaMinutes: 90 });
    expect(show.status).toBe(200);
    expect(patched.status).toBe(200);
    const answers: Array<[string, Record<string, unknown>]> = [
      ['list', list.rows.find((row) => row.id === id) as unknown as Record<string, unknown>],
      ['show', show.body],
      ['POST', created.body],
      ['PATCH', patched.body],
    ];
    for (const [label, row] of answers) {
      for (const key of ALWAYS_KEYS) expect(row, `${label} ${key}`).toHaveProperty(key);
      expect(Array.isArray(row.attention), label).toBe(true);
      expect(row.retailPrice, label).toBeNull();
      expect(row.retailPriceSource, label).toBeNull();
      for (const key of PERMISSION_KEYS) expect(row, `${label} ${key}`).not.toHaveProperty(key);
    }
  });

  it('tells a typed shop price from one that follows a rule, names the rule and says when a proposal waits', async () => {
    const { db, groups, category } = await world();
    await serviceIn(db, category, 'A none');
    const typed = await serviceIn(db, category, 'B typed');
    const following = await serviceIn(db, category, 'C following');
    await insertRetailPrice(db, typed, groups.retail, '12.5000');
    await insertRetailPrice(db, following, groups.retail, '14.0000');
    const [rule] = await db
      .insert(s.retailPriceRules)
      .values({ scope: 'global', percent: '30.0000', rounding: 'cent', changedAt: clock.now() })
      .returning({ id: s.retailPriceRules.id });
    await db.insert(s.retailPriceFollows).values({
      serviceId: following,
      ruleId: rule!.id,
      appliedPrice: '14.0000',
      appliedCost: '10.0000',
      appliedAt: clock.now(),
    });
    await insertProposal(db, following, { ruleId: rule!.id });
    const rows = (await owner.get('/admin/services')).body as Array<Record<string, unknown>>;
    expect(
      rows.map((row) => [
        row.name,
        row.retailPrice,
        row.retailPriceSource,
        row.retailPriceRule,
        row.retailPriceWaiting,
      ]),
    ).toEqual([
      ['A none', null, null, null, false],
      ['B typed', '12.5000', 'manual', null, false],
      ['C following', '14.0000', 'rule', { id: rule!.id, label: expect.any(String) }, true],
    ]);
    expect((rows[2]!.retailPriceRule as { label: string }).label.length).toBeGreaterThan(0);
    // The waiting proposal is a reason for a reader of the retail pricing only.
    expect(rows[2]!.attention).toEqual(['no_supplier', 'price_proposal']);
    const plain = (await catalogOnly.get(`/admin/services/${following}`)).body;
    expect(plain).toMatchObject({ retailPrice: '14.0000', retailPriceSource: 'rule', attention: ['no_supplier'] });
    expect(plain).not.toHaveProperty('retailPriceRule');
    expect(plain).not.toHaveProperty('retailPriceWaiting');
  });

  it('works out no_supplier, below_floor and price_proposal for enabled services only', async () => {
    const { db, category } = await world();
    const linked = async (name: string, values: Partial<typeof s.services.$inferInsert> = {}) => {
      const id = await serviceIn(db, category, name, values);
      await insertSupplierLink(db, id);
      return id;
    };
    await serviceIn(db, category, 'A unlinked');
    await serviceIn(db, category, 'B manual', { fulfillment: 'manual' });
    const offLink = await serviceIn(db, category, 'C link switched off');
    await insertSupplierLink(db, offLink, { isActive: false });
    await linked('D linked');
    await serviceIn(db, category, 'E unlinked, disabled', { status: 'disabled' });
    await linked('F below floor', { basePrice: '1.0000' });
    await linked('G below floor, disabled', { basePrice: '1.0000', status: 'disabled' });
    const proposal = await linked('H proposal');
    await insertProposal(db, proposal);
    const resolved = await linked('I resolved proposal');
    await insertProposal(db, resolved, { resolution: 'kept', resolvedAt: clock.now() });
    const disabledProposal = await linked('J proposal, disabled', { status: 'disabled' });
    await insertProposal(db, disabledProposal);
    await serviceIn(db, category, 'K everything', { basePrice: '1.0000' }).then((id) => insertProposal(db, id));

    const reasons = Object.fromEntries((await all(owner)).rows.map((row) => [row.name, row.attention]));
    expect(reasons).toEqual({
      'A unlinked': ['no_supplier'],
      'B manual': [],
      'C link switched off': ['no_supplier'],
      'D linked': [],
      'E unlinked, disabled': [],
      'F below floor': ['below_floor'],
      'G below floor, disabled': [],
      'H proposal': ['price_proposal'],
      'I resolved proposal': [],
      'J proposal, disabled': [],
      'K everything': ['no_supplier', 'below_floor', 'price_proposal'],
    });
    // below_floor is the row's own belowFloor, for enabled services (the dashboard's figure).
    for (const row of (await all(owner)).rows as unknown as Array<Row & { belowFloor: boolean }>) {
      expect(row.attention.includes('below_floor'), row.name).toBe(row.belowFloor && row.status === 'active');
    }
  });

  it('works out publish_failed from the latest attempt with a result of a service that has no listing', async () => {
    const { db, category } = await world();
    const make = async (name: string, values: Partial<typeof s.services.$inferInsert> = {}) => {
      const id = await serviceIn(db, category, name, values);
      await insertSupplierLink(db, id);
      return id;
    };
    const t1 = minutesFromNow(-30);
    const t2 = minutesFromNow(-20);
    const t3 = minutesFromNow(-10);

    const refused = await make('A refused');
    await insertAttempt(db, refused, 'refused', t1);

    const leftOut = await make('B refused, then left out');
    await insertAttempt(db, leftOut, 'refused', t1);
    await insertAttempt(db, leftOut, 'skipped', t2);

    const published = await make('C refused, then published');
    await insertAttempt(db, published, 'refused', t1);
    await insertAttempt(db, published, 'published', t2);
    await insertListingRow(db, published, { isListed: true });

    const byHand = await make('D refused, then listed by hand, then switched off');
    await insertAttempt(db, byHand, 'refused', t1);
    await insertListingRow(db, byHand, { isListed: false });

    // The run made first finished last: its refusal is the latest attempt.
    const reversed = await make('E refused last in an older run');
    await insertAttempt(db, reversed, 'refused', t3);
    await insertAttempt(db, reversed, 'skipped', t2);

    const reversedBack = await make('F left out last in an older run');
    await insertAttempt(db, reversedBack, 'skipped', t3);
    await insertAttempt(db, reversedBack, 'refused', t2);

    const untried = await make('G refused, then a run that never tried it');
    await insertAttempt(db, untried, 'refused', t1);
    await insertAttempt(db, untried, null, t2);

    const disabled = await make('H refused, disabled', { status: 'disabled' });
    await insertAttempt(db, disabled, 'refused', t1);

    const reasons = Object.fromEntries((await all(owner)).rows.map((row) => [row.name, row.attention]));
    expect(reasons).toEqual({
      'A refused': ['publish_failed'],
      'B refused, then left out': [],
      'C refused, then published': [],
      'D refused, then listed by hand, then switched off': [],
      'E refused last in an older run': ['publish_failed'],
      'F left out last in an older run': [],
      'G refused, then a run that never tried it': ['publish_failed'],
      'H refused, disabled': [],
    });
    // A reader without storefront:read never sees the reason.
    expect((await all(catalogOnly)).rows.every((row) => row.attention.length === 0)).toBe(true);
  });

  it('shows why the last publish attempt was refused and in which run, with storefront:read only', async () => {
    const { db, category } = await world();
    const id = await serviceIn(db, category, 'Refused service');
    await insertSupplierLink(db, id);
    await insertAttempt(db, id, 'refused', minutesFromNow(-30), { resultReason: 'cost_moved', resultDetail: 'Older.' });
    const at = minutesFromNow(-5);
    const runId = await insertAttempt(db, id, 'refused', at);
    const clean = await serviceIn(db, category, 'Clean service');

    const detail = await shopReader.get(`/admin/services/${id}`);
    expect(detail.body.attention).toEqual(['publish_failed']);
    expect(detail.body.publishFailure).toEqual({
      runId,
      reason: 'below_floor',
      detail: 'Below the storefront floor of $5.50.',
      at: at.toISOString(),
    });
    expect((await shopReader.get(`/admin/services/${clean}`)).body.publishFailure).toBeNull();
    const plain = await priceReader.get(`/admin/services/${id}`);
    expect(plain.status).toBe(200);
    expect(plain.body).not.toHaveProperty('publishFailure');
    expect(plain.body.attention).toEqual([]);
    // A listing made by hand ends the failure.
    await insertListingRow(db, id, { isListed: false });
    expect((await owner.get(`/admin/services/${id}`)).body).toMatchObject({
      attention: [],
      publishFailure: null,
    });
  });

  it('shows no failure when the attempt it reads was not refused, whatever the reason flag it was handed said', async () => {
    const { db, category } = await world();
    // Loaded after the app: the service file imports the module graph the controllers also import.
    const { ServiceAdminService } = await import('@src/modules/catalog/application/service-admin.service');
    const service = t.app.get(ServiceAdminService);
    // The reason flag is read before the attempt: an attempt that finished in between is what the second read finds.
    const failureOf = (id: number) =>
      service['publishFailureOf'](db, id, {
        flags: new Map([[id, { reasons: ['publish_failed' as const], shopBlocked: null }]]),
        sources: new Map(),
        listings: undefined,
      });

    const published = await serviceIn(db, category, 'Published after the flag was read');
    await insertAttempt(db, published, 'refused', minutesFromNow(-30));
    await insertAttempt(db, published, 'published', minutesFromNow(-5));
    expect(await failureOf(published)).toBeNull();

    const leftOut = await serviceIn(db, category, 'Left out after the flag was read');
    await insertAttempt(db, leftOut, 'refused', minutesFromNow(-30));
    await insertAttempt(db, leftOut, 'skipped', minutesFromNow(-5));
    expect(await failureOf(leftOut)).toBeNull();

    // A refused latest attempt is still shown, and a service never tried has nothing to show.
    const refused = await serviceIn(db, category, 'Still refused');
    const runId = await insertAttempt(db, refused, 'refused', minutesFromNow(-5));
    expect(await failureOf(refused)).toMatchObject({ runId, reason: 'below_floor' });
    const untried = await serviceIn(db, category, 'Never tried');
    expect(await failureOf(untried)).toBeNull();
  });
});

describe('the filters and the sort of decision 060 on GET /admin/services', () => {
  /** A mixed catalog: every reason, linked and unlinked services, shop pages on and off, blocked services. */
  async function mixedCatalog() {
    const w = await world();
    const { db, groups, category } = w;
    const b2b = await insertCategory(db, { name: 'Dealers', allowedGroupIds: [groups.standard] });
    const make = async (name: string, values: Partial<typeof s.services.$inferInsert> = {}, inCategory = category) =>
      serviceIn(db, inCategory, name, values);
    const unlinked = await make('A unlinked');
    const primary = await make('B primary and fallback');
    // A switched-off link ranked first (same priority, lower id) is never the primary supplier.
    const off = await insertSupplierLink(db, primary, { supplier: 'Switched off', priority: 1, isActive: false });
    const p = await insertSupplierLink(db, primary, { supplier: 'Primary', priority: 1 });
    const q = await insertSupplierLink(db, primary, { supplier: 'Fallback', priority: 2 });
    const low = await make('C below floor', { basePrice: '1.0000', fulfillment: 'manual' });
    const proposal = await make('D proposal', { fulfillment: 'manual' });
    await insertProposal(db, proposal);
    const refused = await make('E refused', { fulfillment: 'manual' });
    await insertAttempt(db, refused, 'refused', minutesFromNow(-5));
    const listedOn = await make('F listed', { fulfillment: 'manual' });
    await insertListingRow(db, listedOn, { isListed: true });
    await insertRetailPrice(db, listedOn, groups.retail, '30.0000');
    const listedOff = await make('G listed, switched off', { fulfillment: 'manual' });
    await insertListingRow(db, listedOff, { isListed: false });
    await insertRetailPrice(db, listedOff, groups.retail, '10.0000');
    const dealer = await make('H dealers only', { fulfillment: 'manual' }, b2b);
    const disabled = await make('I disabled', { status: 'disabled', fulfillment: 'manual' });
    await insertRetailPrice(db, disabled, groups.retail, '20.0000');
    return {
      ...w,
      services: { unlinked, primary, low, proposal, refused, listedOn, listedOff, dealer, disabled },
      suppliers: { primary: p.supplierId, fallback: q.supplierId, off: off.supplierId },
    };
  }

  it('needsAttention is the union of the reasons the caller may see, and the count equals the flagged rows', async () => {
    const { services } = await mixedCatalog();
    const expected: Array<[string, AdminApi, number[]]> = [
      ['owner', owner, [services.unlinked, services.low, services.proposal, services.refused]],
      ['catalog only', catalogOnly, [services.unlinked, services.low]],
      ['pricing:read', priceReader, [services.unlinked, services.low, services.proposal]],
      ['storefront:read', shopReader, [services.unlinked, services.low, services.refused]],
    ];
    for (const [who, api, flagged] of expected) {
      const everyone = await all(api);
      expect(ids(everyone.rows.filter((row) => row.attention.length > 0)), who).toEqual(flagged);
      const needs = await all(api, '&needsAttention=true');
      expect(ids(needs.rows), who).toEqual(flagged);
      expect(needs.total, who).toBe(flagged.length);
      const fine = await all(api, '&needsAttention=false');
      expect(ids(fine.rows), who).toEqual(ids(everyone.rows.filter((row) => row.attention.length === 0)));
      // The chip count of the console: one row, read from the total.
      expect((await api.get('/admin/services?needsAttention=true&_start=0&_end=1')).total, who).toBe(flagged.length);
    }
  });

  it('filters by hasSupplier (an active link) and supplierId (the primary supplier only, eq only)', async () => {
    const { services, suppliers } = await mixedCatalog();
    expect(ids((await all(catalogOnly, '&hasSupplier=true')).rows)).toEqual([services.primary]);
    expect((await all(catalogOnly, '&hasSupplier=false')).total).toBe(8);
    expect(ids((await all(catalogOnly, `&supplierId=${suppliers.primary}`)).rows)).toEqual([services.primary]);
    // The fallback and a switched-off link are not the primary supplier.
    expect((await all(catalogOnly, `&supplierId=${suppliers.fallback}`)).total).toBe(0);
    expect((await all(catalogOnly, `&supplierId=${suppliers.off}`)).total).toBe(0);
    // A repeated key is IN.
    expect(
      ids((await all(catalogOnly, `&supplierId=${suppliers.fallback}&supplierId=${suppliers.primary}`)).rows),
    ).toEqual([services.primary]);
    expect((await catalogOnly.get(`/admin/services?supplierId_ne=${suppliers.primary}`)).status).toBe(422);
    expect((await catalogOnly.get('/admin/services?hasSupplier=yes')).status).toBe(422);
  });

  it('filters by isListed and notOnShop, which agree with the row facts, and refuses both without storefront:read', async () => {
    const { services } = await mixedCatalog();
    for (const api of [owner, shopReader]) {
      const everyone = (await all(api)).rows;
      expect(ids((await all(api, '&isListed=true')).rows)).toEqual([services.listedOn]);
      expect(ids((await all(api, '&isListed=false')).rows)).toEqual(ids(everyone.filter((row) => !row.isListed)));
      const notOnShop = await all(api, '&notOnShop=true');
      expect(ids(notOnShop.rows)).toEqual(
        ids(everyone.filter((row) => row.status === 'active' && row.isListed === false && row.shopBlocked === null)),
      );
      // The dealers-only and the disabled service are never "not on the shop": nothing can put them there.
      expect(ids(notOnShop.rows)).not.toContain(services.dealer);
      expect(ids(notOnShop.rows)).not.toContain(services.disabled);
      expect(ids(notOnShop.rows)).toContain(services.listedOff);
      expect((await all(api, '&notOnShop=false')).total).toBe(everyone.length - notOnShop.total);
      expect(everyone.find((row) => row.id === services.dealer)!.shopBlocked).toBe('b2b_only');
      expect(everyone.find((row) => row.id === services.disabled)!.shopBlocked).toBe('service_disabled');
    }
    for (const api of [catalogOnly, priceReader]) {
      for (const filter of [
        'isListed=true',
        'isListed=false',
        'notOnShop=true',
        'needsAttention=true&notOnShop=false',
      ]) {
        const res = await api.get(`/admin/services?${filter}`);
        expect(res.status, filter).toBe(403);
        expect(res.body).toMatchObject({
          code: 'FORBIDDEN',
          detail: 'You need the storefront:read permission to do this.',
        });
      }
    }
  });

  it('sorts by the shop price both ways, a service without one last', async () => {
    const { services } = await mixedCatalog();
    const asc = ids((await all(catalogOnly, '&_sort=retailPrice&_order=asc')).rows);
    expect(asc.slice(0, 3)).toEqual([services.listedOff, services.disabled, services.listedOn]);
    const desc = ids((await all(catalogOnly, '&_sort=retailPrice&_order=desc')).rows);
    expect(desc.slice(0, 3)).toEqual([services.listedOn, services.disabled, services.listedOff]);
    expect(asc).toHaveLength(9);
    expect(desc.slice(3).sort()).toEqual(asc.slice(3).sort());
  });
});

describe('shopBlocked against the publish rule', () => {
  /** What the storefront's publish rule says first about a service that has no listing (its facts, read by its own reader). */
  async function publishBlocks(db: Database, serviceIds: number[]): Promise<Map<number, string | null>> {
    const facts = await publishFactsOf(db, serviceIds);
    return new Map(
      serviceIds.map((id) => {
        const service = facts.get(id)!;
        const { blockedReason } = evaluateItem({
          facts: {
            listed: false,
            serviceStatus: service.status,
            serviceType: service.type,
            fulfillment: service.fulfillment,
            categoryActive: service.categoryActive,
            categoryName: service.categoryName,
            categoryAllowedGroupIds: service.allowedGroupIds,
            retailGroupId: service.retailGroupId,
            supply: 'ok',
          },
          title: 'A title',
          flags: [],
        });
        return [id, blockedReason];
      }),
    );
  }

  it('agrees with evaluateItem over every status, category switch, group list and type', async () => {
    const { db, groups } = await world();
    const lists: number[][] = [[], [groups.retail], [groups.standard], [groups.standard, groups.retail]];
    const made: number[] = [];
    for (const type of ['imei', 'file'] as const) {
      for (const [index, allowedGroupIds] of lists.entries()) {
        for (const isActive of [true, false]) {
          const category = await insertCategory(db, {
            name: `${type} ${index} ${isActive}`,
            type,
            allowedGroupIds,
            isActive,
          });
          for (const status of ['active', 'disabled'] as const) {
            made.push(await serviceIn(db, category, `${type} ${index} ${isActive} ${status}`, { type, status }));
          }
        }
      }
    }
    const expected = await publishBlocks(db, made);
    const rows = (await all(owner)).rows;
    expect(rows).toHaveLength(32);
    for (const row of rows) {
      expect(row.shopBlocked ?? null, row.name).toBe(expected.get(row.id) ?? null);
    }
    // Every value of the closed list is reached, and nothing else.
    expect(new Set(rows.map((row) => row.shopBlocked))).toEqual(new Set([...SHOP_BLOCKS, null]));
  });

  it('agrees with evaluateItem when the shop has no retail group: any group list is dealers only', async () => {
    const { db } = await testDb();
    const [standard] = await db
      .insert(s.clientGroups)
      .values({ name: 'Standard', isDefault: true })
      .returning({ id: s.clientGroups.id });
    const open = await insertCategory(db, { name: 'Open' });
    const listed = await insertCategory(db, { name: 'Listed', allowedGroupIds: [standard!.id] });
    const a = await serviceIn(db, open, 'A open');
    const b = await serviceIn(db, listed, 'B listed');
    const expected = await publishBlocks(db, [a, b]);
    const rows = (await all(owner)).rows;
    expect(rows.map((row) => [row.name, row.shopBlocked])).toEqual([
      ['A open', expected.get(a) ?? null],
      ['B listed', expected.get(b) ?? null],
    ]);
    expect(expected.get(b)).toBe('b2b_only');
    expect(expected.get(a) ?? null).toBeNull();
  });
});

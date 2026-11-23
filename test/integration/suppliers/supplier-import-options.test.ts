// The two options of the supplier import and its preview (decision 063, B242): `status` (the new services start active or disabled) and
// `categoryId` (the new services go into a category staff picked, which must have the type of each of them). Without the keys both routes
// are what they were. Real Postgres and Redis; the supplier's services are inserted straight into the database (the import never calls the
// supplier).
import { afterAll, beforeAll, beforeEach, describe, expect, it, setDefaultTimeout, spyOn } from 'bun:test';
import { and, asc, count, eq } from 'drizzle-orm';
import { schema as s } from '@src/infra/db';
import { ServiceImporter } from '@src/modules/catalog';
import { type AdminApi, adminWith } from '../../support/admin-api';
import { type TestApp, createTestApp } from '../../support/app';
import { clearIdentityCaches } from '../../support/auth';
import { insertCategory, insertService } from '../../support/catalog';
import { closeTestDb, resetDb, testDb } from '../../support/db';

setDefaultTimeout(60_000);

let t: TestApp;
let db: Awaited<ReturnType<typeof testDb>>['db'];
let staff: AdminApi;
let reader: AdminApi;

beforeAll(async () => {
  t = await createTestApp();
  ({ db } = await testDb());
});
beforeEach(async () => {
  await resetDb();
  await clearIdentityCaches(t);
  staff = await adminWith(t, ['suppliers:*', 'catalog:*'], { name: 'Lina S.' });
  reader = await adminWith(t, ['suppliers:read'], { name: 'Read Only' });
});
afterAll(async () => {
  await resetDb();
  await clearIdentityCaches(t);
  await t.close();
  await closeTestDb();
});

let sequence = 0;

/** Inserts a supplier straight into the database; its credit rate is 1, so a credit is a dollar. */
async function newSupplier(): Promise<number> {
  sequence += 1;
  const [row] = await db
    .insert(s.suppliers)
    .values({
      name: `Import Source ${sequence}`,
      driver: 'dhru',
      baseUrl: 'https://supplier.example',
      paramFormat: 'dhru_xml',
    })
    .returning({ id: s.suppliers.id });
  return row!.id;
}

/** Inserts a synced supplier service (an available IMEI service of the group `Carrier unlock` unless changed). */
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
      remoteGroup: 'Carrier unlock',
      type: 'IMEI',
      name: `Remote ${sequence}`,
      credit: '10.0000',
      time: '1-2 hours',
      ...overrides,
    })
    .returning({ id: s.supplierServices.id });
  return row!.id;
}

/** Links a service of ours to a supplier service, as an earlier import would have; returns the service id. */
async function importedBy(
  supplierServiceId: number,
  serviceOverrides: Partial<typeof s.services.$inferInsert> = {},
): Promise<number> {
  // A service and its category have one type (the composite key of `services`).
  const category = await insertCategory(db, { type: serviceOverrides.type ?? 'imei' });
  const serviceId = await insertService(db, category, serviceOverrides);
  await db.insert(s.serviceSupplierLinks).values({ serviceId, supplierServiceId, priority: 1 });
  return serviceId;
}

/** The IMEI service whose main box is an ECID, which the import makes a `server` service (decision 042). */
const ECID_ENTRY = { CUSTOM: { allow: '1', customname: 'ECID', customlen: '13', maxlength: '16' } };

const importUrl = (supplierId: number) => `/admin/suppliers/${supplierId}/import`;
const previewUrl = (supplierId: number) => `${importUrl(supplierId)}/preview`;

/** The service an import made from a supplier service, with its category. */
async function serviceOf(supplierServiceId: number) {
  const [row] = await db
    .select({ service: s.services, category: s.serviceCategories })
    .from(s.serviceSupplierLinks)
    .innerJoin(s.services, eq(s.services.id, s.serviceSupplierLinks.serviceId))
    .innerJoin(s.serviceCategories, eq(s.serviceCategories.id, s.services.categoryId))
    .where(eq(s.serviceSupplierLinks.supplierServiceId, supplierServiceId));
  return row!;
}

const importAudit = (supplierId: number) =>
  db
    .select()
    .from(s.auditLogs)
    .where(
      and(
        eq(s.auditLogs.entityType, 'supplier'),
        eq(s.auditLogs.entityId, supplierId),
        eq(s.auditLogs.action, 'imported services from'),
      ),
    )
    .orderBy(asc(s.auditLogs.id));

/** How many services, categories, links and import audit rows there are: what a refused request must leave as it was. */
async function counts(supplierId: number) {
  const [services] = await db.select({ n: count() }).from(s.services);
  const [categories] = await db.select({ n: count() }).from(s.serviceCategories);
  const [links] = await db.select({ n: count() }).from(s.serviceSupplierLinks);
  return {
    services: services!.n,
    categories: categories!.n,
    links: links!.n,
    audit: (await importAudit(supplierId)).length,
  };
}

/** The keys of a preview item before decision 063. */
const OLD_ITEM_KEYS = [
  'cost',
  'name',
  'previousCost',
  'qtyOptions',
  'quantityDiffers',
  'maxQty',
  'minQty',
  'serviceId',
  'serviceName',
  'state',
  'suggestedPrice',
  'supplierServiceId',
  'type',
].sort();

const itemsById = (items: Array<{ supplierServiceId: number }>) =>
  new Map(items.map((item) => [item.supplierServiceId, item]));

describe('POST /admin/suppliers/:id/import without the options', () => {
  it('creates active services in the category named after the supplier group, and answers and audits as before', async () => {
    const supplierId = await newSupplier();
    const unlock = await remote(supplierId);
    const tools = await remote(supplierId, { remoteGroup: 'Tools', type: 'SERVER' });
    const res = await staff.post(importUrl(supplierId), { supplierServiceIds: [unlock, tools] });
    expect(res.status).toBe(200);
    expect(Object.keys(res.body)).toEqual(['created', 'updated', 'unchanged', 'createdServiceIds']);
    expect(res.body).toMatchObject({ created: 2, updated: 0, unchanged: 0 });
    const first = await serviceOf(unlock);
    const second = await serviceOf(tools);
    expect(first.service).toMatchObject({ status: 'active', type: 'imei' });
    expect(first.category).toMatchObject({ name: 'Carrier unlock', type: 'imei' });
    expect(second.service).toMatchObject({ status: 'active', type: 'server' });
    expect(second.category).toMatchObject({ name: 'Tools', type: 'server' });
    expect(res.body.createdServiceIds).toEqual([first.service.id, second.service.id].sort((a, b) => a - b));
    const [audit] = await importAudit(supplierId);
    expect(audit!.after).toEqual({ created: 2, updated: 0, unchanged: 0, createdWithQuantity: 0 });
  });

  it('previews the items with exactly the old keys', async () => {
    const supplierId = await newSupplier();
    const fresh = await remote(supplierId);
    const res = await staff.post(previewUrl(supplierId), { supplierServiceIds: [fresh] });
    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(1);
    expect(Object.keys(res.body.items[0]).sort()).toEqual(OLD_ITEM_KEYS);
    expect(res.body.items[0]).toMatchObject({ state: 'new', cost: '10.0000', suggestedPrice: '10.6000' });
  });
});

describe('POST /admin/suppliers/:id/import with status', () => {
  it('creates the new services disabled, inserted that way and never switched off afterwards, and leaves the updated ones alone', async () => {
    const supplierId = await newSupplier();
    const unlock = await remote(supplierId);
    const tools = await remote(supplierId, { remoteGroup: 'Tools', type: 'SERVER' });
    const moved = await remote(supplierId, { credit: '12.0000' });
    const linkedId = await importedBy(moved, { cost: '10.0000', effectiveCost: '10.0000', status: 'active' });
    const importer = t.app.get(ServiceImporter, { strict: false });
    const create = spyOn(importer, 'create');
    let res;
    try {
      res = await staff.post(importUrl(supplierId), { supplierServiceIds: [unlock, tools, moved], status: 'disabled' });
      // The importer is asked for a disabled service; no active one is made first and switched off later.
      expect(create.mock.calls.map(([, input]) => input.status)).toEqual(['disabled', 'disabled']);
    } finally {
      create.mockRestore();
    }
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ created: 2, updated: 1, unchanged: 0 });
    const first = await serviceOf(unlock);
    const second = await serviceOf(tools);
    expect(first.service.status).toBe('disabled');
    expect(second.service.status).toBe('disabled');
    // The category is still the one named after the group.
    expect(first.category.name).toBe('Carrier unlock');
    expect(second.category.name).toBe('Tools');
    // The linked service gets its new cost and keeps its state: the option is about the services this call creates.
    const [linked] = await db.select().from(s.services).where(eq(s.services.id, linkedId));
    expect(linked).toMatchObject({ status: 'active', cost: '12.0000' });
    const [audit] = await importAudit(supplierId);
    expect(audit!.after).toEqual({
      created: 2,
      updated: 1,
      unchanged: 0,
      createdWithQuantity: 0,
      serviceStatus: 'disabled',
    });
  });

  it('takes status active as the default and still says so in the audit row', async () => {
    const supplierId = await newSupplier();
    const unlock = await remote(supplierId);
    const res = await staff.post(importUrl(supplierId), { supplierServiceIds: [unlock], status: 'active' });
    expect(res.status).toBe(200);
    expect((await serviceOf(unlock)).service.status).toBe('active');
    const [audit] = await importAudit(supplierId);
    expect(audit!.after).toEqual({
      created: 1,
      updated: 0,
      unchanged: 0,
      createdWithQuantity: 0,
      serviceStatus: 'active',
    });
  });

  it('refuses a status that is not active or disabled (422 on status) and creates nothing', async () => {
    const supplierId = await newSupplier();
    const unlock = await remote(supplierId);
    const before = await counts(supplierId);
    for (const status of ['paused', 'archived', '']) {
      const res = await staff.post(importUrl(supplierId), { supplierServiceIds: [unlock], status });
      expect(res.status).toBe(422);
      expect(res.body.errors.map((error: { field: string }) => error.field)).toContain('status');
    }
    expect(await counts(supplierId)).toEqual(before);
  });

  it('needs the same permission as before', async () => {
    const supplierId = await newSupplier();
    const unlock = await remote(supplierId);
    const res = await reader.post(importUrl(supplierId), { supplierServiceIds: [unlock], status: 'disabled' });
    expect(res.status).toBe(403);
  });
});

describe('POST /admin/suppliers/:id/import with categoryId', () => {
  it('puts every new service in the picked category of the right type, not in the category named after its group, and makes no category', async () => {
    const supplierId = await newSupplier();
    const carriers = await insertCategory(db, { name: 'Apple & Samsung unlock', type: 'imei' });
    // A category named like the supplier's group: the pick still wins.
    const lookalike = await insertCategory(db, { name: 'Carrier unlock', type: 'imei' });
    const unlock = await remote(supplierId);
    const other = await remote(supplierId, { remoteGroup: 'A group nobody made' });
    const before = await counts(supplierId);
    const res = await staff.post(importUrl(supplierId), { supplierServiceIds: [unlock, other], categoryId: carriers });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ created: 2, updated: 0, unchanged: 0 });
    for (const picked of [unlock, other]) {
      const made = await serviceOf(picked);
      expect(made.service).toMatchObject({ categoryId: carriers, status: 'active', type: 'imei' });
    }
    const [inLookalike] = await db.select({ n: count() }).from(s.services).where(eq(s.services.categoryId, lookalike));
    expect(inLookalike!.n).toBe(0);
    const after = await counts(supplierId);
    expect(after.categories).toBe(before.categories);
    expect(after.services).toBe(before.services + 2);
    const [audit] = await importAudit(supplierId);
    expect(audit!.after).toEqual({
      created: 2,
      updated: 0,
      unchanged: 0,
      createdWithQuantity: 0,
      categoryId: carriers,
      categoryName: 'Apple & Samsung unlock',
    });
  });

  it('works with status disabled in the same call', async () => {
    const supplierId = await newSupplier();
    const tools = await insertCategory(db, { name: 'Server tools', type: 'server' });
    const pack = await remote(supplierId, { type: 'SERVER', remoteGroup: 'Whatever' });
    const res = await staff.post(importUrl(supplierId), {
      supplierServiceIds: [pack],
      categoryId: tools,
      status: 'disabled',
    });
    expect(res.status).toBe(200);
    expect((await serviceOf(pack)).service).toMatchObject({ categoryId: tools, status: 'disabled', type: 'server' });
  });

  it('counts an IMEI service whose main box is not an IMEI as a server service (decision 042)', async () => {
    const supplierId = await newSupplier();
    const imeiCategory = await insertCategory(db, { name: 'Carriers', type: 'imei' });
    const serverCategory = await insertCategory(db, { name: 'Server tools', type: 'server' });
    const ecid = await remote(supplierId, { name: 'ECID check', raw: ECID_ENTRY });
    const before = await counts(supplierId);
    const refused = await staff.post(importUrl(supplierId), { supplierServiceIds: [ecid], categoryId: imeiCategory });
    expect(refused.status).toBe(422);
    expect(refused.body.errors[0]).toMatchObject({
      field: 'categoryId',
      code: 'kind_mismatch',
      message: expect.stringContaining('"ECID check" (server)'),
    });
    expect(await counts(supplierId)).toEqual(before);
    const accepted = await staff.post(importUrl(supplierId), {
      supplierServiceIds: [ecid],
      categoryId: serverCategory,
    });
    expect(accepted.status).toBe(200);
    expect((await serviceOf(ecid)).service).toMatchObject({ categoryId: serverCategory, type: 'server' });
  });

  it('refuses a category of another type with the names of the supplier services that do not fit, and imports nothing', async () => {
    const supplierId = await newSupplier();
    const carriers = await insertCategory(db, { name: 'Carriers', type: 'imei' });
    const phone = await remote(supplierId, { name: 'Telstra Australia' });
    const pack = await remote(supplierId, { name: 'Server pack', type: 'SERVER', remoteGroup: 'Tools' });
    const ecid = await remote(supplierId, { name: 'ECID check', raw: ECID_ENTRY, remoteGroup: 'Apple' });
    const before = await counts(supplierId);
    const res = await staff.post(importUrl(supplierId), {
      supplierServiceIds: [phone, pack, ecid],
      categoryId: carriers,
    });
    expect(res.status).toBe(422);
    expect(res.body.errors).toHaveLength(1);
    expect(res.body.errors[0]).toMatchObject({ field: 'categoryId', code: 'kind_mismatch' });
    const message: string = res.body.errors[0].message;
    expect(message).toContain('"Carriers" holds imei services only');
    expect(message).toContain('"Server pack" (server)');
    expect(message).toContain('"ECID check" (server)');
    expect(message).not.toContain('Telstra Australia');
    // One transaction: no service, no category (not even the groups'), no link, no audit row.
    expect(await counts(supplierId)).toEqual(before);
  });

  it('does not count an item the import will not create: a linked service of another type is only updated', async () => {
    const supplierId = await newSupplier();
    const carriers = await insertCategory(db, { name: 'Carriers', type: 'imei' });
    const phone = await remote(supplierId);
    const pack = await remote(supplierId, { type: 'SERVER', credit: '12.0000' });
    const linkedId = await importedBy(pack, { type: 'server', cost: '10.0000', effectiveCost: '10.0000' });
    const res = await staff.post(importUrl(supplierId), { supplierServiceIds: [phone, pack], categoryId: carriers });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ created: 1, updated: 1, unchanged: 0 });
    expect((await serviceOf(phone)).service.categoryId).toBe(carriers);
    const [linked] = await db.select().from(s.services).where(eq(s.services.id, linkedId));
    expect(linked).toMatchObject({ cost: '12.0000' });
    expect(linked!.categoryId).not.toBe(carriers);
  });

  it('refuses a category that does not exist (422 on categoryId, code unknown) and imports nothing', async () => {
    const supplierId = await newSupplier();
    const unlock = await remote(supplierId);
    const before = await counts(supplierId);
    const res = await staff.post(importUrl(supplierId), { supplierServiceIds: [unlock], categoryId: 987654 });
    expect(res.status).toBe(422);
    expect(res.body.errors[0]).toMatchObject({ field: 'categoryId', code: 'unknown' });
    expect(await counts(supplierId)).toEqual(before);
  });

  it('refuses a category id that is not a positive whole number (422 on categoryId)', async () => {
    const supplierId = await newSupplier();
    const unlock = await remote(supplierId);
    for (const categoryId of [0, -1, 1.5, 'abc']) {
      const res = await staff.post(importUrl(supplierId), { supplierServiceIds: [unlock], categoryId });
      expect(res.status).toBe(422);
      expect(res.body.errors.map((error: { field: string }) => error.field)).toContain('categoryId');
    }
  });

  it('keeps the refusal of a type the import cannot create ahead of the category check', async () => {
    const supplierId = await newSupplier();
    const carriers = await insertCategory(db, { name: 'Carriers', type: 'imei' });
    const credits = await remote(supplierId, { name: 'Credit bundle', type: 'Credits' });
    const res = await staff.post(importUrl(supplierId), { supplierServiceIds: [credits], categoryId: carriers });
    expect(res.status).toBe(422);
    expect(res.body.errors[0]).toMatchObject({ field: 'supplierServiceIds', code: 'unsupported_type' });
  });
});

describe('POST /admin/suppliers/:id/import/preview with the options', () => {
  it('names the category each new service would get exactly, as the import finds or makes it, and its status; null for the others', async () => {
    const supplierId = await newSupplier();
    // The group text is found as the importer finds it: by type and name, ignoring case; an empty group is `Imported`; then the
    // cleaned name; else the import makes a category under the cleaned name, which the preview names with a null id.
    const known = await insertCategory(db, { name: 'Carrier Unlock', type: 'imei' });
    const imported = await insertCategory(db, { name: 'Imported', type: 'imei' });
    const byCleanName = await insertCategory(db, { name: 'Apple & Samsung', type: 'imei' });
    const knownRemote = await remote(supplierId, { remoteGroup: 'carrier unlock' });
    const emptyGroup = await remote(supplierId, { remoteGroup: '' });
    const unknownGroup = await remote(supplierId, { remoteGroup: 'A group nobody made' });
    const dirtyGroup = await remote(supplierId, { remoteGroup: '\u2705 Apple &amp; Samsung \u2705' });
    const dirtyNewGroup = await remote(supplierId, { remoteGroup: '\u2705 Fresh &amp; New \u2705' });
    const wrongType = await remote(supplierId, { remoteGroup: 'Carrier unlock', type: 'SERVER' });
    const movedRemote = await remote(supplierId, { credit: '12.0000' });
    await importedBy(movedRemote, { cost: '10.0000', effectiveCost: '10.0000' });
    const sameRemote = await remote(supplierId, { credit: '10.0000' });
    await importedBy(sameRemote, { cost: '10.0000', effectiveCost: '10.0000' });
    const before = await counts(supplierId);
    const res = await staff.post(previewUrl(supplierId), {
      supplierServiceIds: [
        knownRemote,
        emptyGroup,
        unknownGroup,
        dirtyGroup,
        dirtyNewGroup,
        wrongType,
        movedRemote,
        sameRemote,
      ],
      status: 'disabled',
    });
    expect(res.status).toBe(200);
    const items = itemsById(res.body.items);
    expect(items.get(knownRemote)).toMatchObject({
      state: 'new',
      status: 'disabled',
      category: { id: known, name: 'Carrier Unlock' },
    });
    expect(items.get(emptyGroup)).toMatchObject({
      state: 'new',
      status: 'disabled',
      category: { id: imported, name: 'Imported' },
    });
    expect(items.get(unknownGroup)).toMatchObject({
      state: 'new',
      status: 'disabled',
      category: { id: null, name: 'A group nobody made' },
    });
    // No category has the raw text, one has the cleaned name: the import finds that one.
    expect(items.get(dirtyGroup)).toMatchObject({
      state: 'new',
      status: 'disabled',
      category: { id: byCleanName, name: 'Apple & Samsung' },
    });
    // Neither exists: the import makes a category under the cleaned name.
    expect(items.get(dirtyNewGroup)).toMatchObject({ state: 'new', category: { id: null, name: 'Fresh & New' } });
    // A category of another type is no hit for a server service: the import makes a server category of that name.
    expect(items.get(wrongType)).toMatchObject({
      state: 'new',
      status: 'disabled',
      category: { id: null, name: 'Carrier unlock' },
    });
    expect(items.get(movedRemote)).toMatchObject({ state: 'changed', status: null, category: null });
    expect(items.get(sameRemote)).toMatchObject({ state: 'matching', status: null, category: null });
    // A preview changes nothing and writes no audit row.
    expect(await counts(supplierId)).toEqual(before);
  });

  it('says the picked category and the default status when only categoryId is sent', async () => {
    const supplierId = await newSupplier();
    const carriers = await insertCategory(db, { name: 'Carriers', type: 'imei' });
    const fresh = await remote(supplierId);
    const movedRemote = await remote(supplierId, { credit: '12.0000', type: 'SERVER' });
    await importedBy(movedRemote, { type: 'server', cost: '10.0000', effectiveCost: '10.0000' });
    const res = await staff.post(previewUrl(supplierId), {
      supplierServiceIds: [fresh, movedRemote],
      categoryId: carriers,
    });
    expect(res.status).toBe(200);
    const items = itemsById(res.body.items);
    expect(items.get(fresh)).toMatchObject({
      state: 'new',
      status: 'active',
      category: { id: carriers, name: 'Carriers' },
    });
    // A changed item is never created, so a category of another type does not concern it.
    expect(items.get(movedRemote)).toMatchObject({ state: 'changed', status: null, category: null });
  });

  it('refuses a category that does not fit or does not exist like the import does', async () => {
    const supplierId = await newSupplier();
    const carriers = await insertCategory(db, { name: 'Carriers', type: 'imei' });
    const phone = await remote(supplierId, { name: 'Telstra Australia' });
    const pack = await remote(supplierId, { name: 'Server pack', type: 'SERVER' });
    const refused = await staff.post(previewUrl(supplierId), {
      supplierServiceIds: [phone, pack],
      categoryId: carriers,
    });
    expect(refused.status).toBe(422);
    expect(refused.body.errors[0]).toMatchObject({
      field: 'categoryId',
      code: 'kind_mismatch',
      message: expect.stringContaining('"Server pack" (server)'),
    });
    expect(refused.body.errors[0].message).not.toContain('Telstra Australia');
    const unknown = await staff.post(previewUrl(supplierId), { supplierServiceIds: [phone], categoryId: 987654 });
    expect(unknown.status).toBe(422);
    expect(unknown.body.errors[0]).toMatchObject({ field: 'categoryId', code: 'unknown' });
  });

  it('answers the same for the same request as the import then does', async () => {
    const supplierId = await newSupplier();
    const servers = await insertCategory(db, { name: 'Server tools', type: 'server' });
    const pack = await remote(supplierId, { type: 'SERVER', remoteGroup: 'Whatever' });
    const body = { supplierServiceIds: [pack], categoryId: servers, status: 'disabled' };
    const preview = await staff.post(previewUrl(supplierId), body);
    expect(preview.body.items[0]).toMatchObject({
      status: 'disabled',
      category: { id: servers, name: 'Server tools' },
    });
    const done = await staff.post(importUrl(supplierId), body);
    expect(done.status).toBe(200);
    expect((await serviceOf(pack)).service).toMatchObject({ categoryId: servers, status: 'disabled' });
  });
});

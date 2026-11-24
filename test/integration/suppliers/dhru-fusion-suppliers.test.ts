// Feature 33 (decision 042), real Dhru Fusion suppliers: the parameters in the supplier's own form (the classic XML string, or base64 of
// JSON), the wrong form refused with the order stopped for review and never sent twice, the supplier's own main box (`CUSTOM`) imported
// as the first field of a server service and sent as `IMEI`, and the sync's adoption of the IMEI services made before. Since decision 065
// the main box is the field flagged `isMainInput` and every other field travels under its Name. Real Postgres and Redis, the fake Dhru
// supplier; every service entry here is a made-up sample.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { and, asc, eq } from 'drizzle-orm';
import { EncryptionService } from '@src/infra/crypto';
import { DbService, schema as s } from '@src/infra/db';
import { ServiceImporter } from '@src/modules/catalog';
import { QuickAddRunner, SupplierDispatch, SupplierPoll, SupplierSync } from '@src/modules/suppliers';
import { mainInputField } from '@src/modules/suppliers/domain/import-plan';
import { type AdminApi, adminWith } from '../../support/admin-api';
import { type TestApp, createTestApp } from '../../support/app';
import { clearIdentityCaches } from '../../support/auth';
import { insertCategory, insertService } from '../../support/catalog';
import { closeTestDb, resetDb, testDb } from '../../support/db';
import { fundWallet } from '../../support/money';
import { IMEIS, type OrdersWorld, json, orderRow, ordersWorld, portalFor, walletOf } from '../../support/orders';
import { catalogVersionOf } from '../../support/pricing';
import {
  FakeDhruSupplier,
  type FakeService,
  SupplierTestModule,
  insertFakeSupplier,
  linkService,
  logsOf,
} from '../../support/suppliers';

const fake = new FakeDhruSupplier();
let t: TestApp;
let world: OrdersWorld;
let staff: AdminApi;
let dispatch: SupplierDispatch;
let poll: SupplierPoll;
let sync: SupplierSync;

beforeAll(async () => {
  t = await createTestApp({ imports: [SupplierTestModule] });
  await resetDb();
  await clearIdentityCaches(t);
  world = await ordersWorld((await testDb()).db);
  staff = await adminWith(t, ['orders:*', 'suppliers:*', 'catalog:*']);
  dispatch = t.app.get(SupplierDispatch, { strict: false });
  poll = t.app.get(SupplierPoll, { strict: false });
  sync = t.app.get(SupplierSync, { strict: false });
});
afterAll(async () => {
  await fake.stop();
  await resetDb();
  await clearIdentityCaches(t);
  await t.close();
  await closeTestDb();
});
beforeEach(async () => {
  fake.reset();
  await fundWallet(world.db, world.merchant.id, '100');
});

/** A sample IMEI service whose main box asks for an ECID of 13 to 16 characters, with one other field. */
const ECID_SERVICE: FakeService = {
  id: '9101',
  group: 'Sample device reports',
  type: 'IMEI',
  name: 'Sample ECID report',
  credit: '3.0000',
  time: '1 hour',
  custom: {
    allow: '1',
    bulk: '0',
    customname: 'ECID',
    custominfo: 'Hex ECID',
    customlen: '13',
    maxlength: '16',
    regex: '',
    isalpha: '1',
  },
  requiresCustom: [{ type: 'serviceimei', fieldname: 'Model', fieldtype: 'text', description: 'Model', required: '0' }],
};
/** A sample IMEI service whose main box asks for a serial number of 10 to 12 characters. */
const SERIAL_SERVICE: FakeService = {
  id: '9102',
  group: 'Sample serial tools',
  type: 'IMEI',
  name: 'Sample serial check',
  credit: '2.0000',
  time: '2 hours',
  custom: { allow: '1', customname: 'Serial Number', customlen: '10', maxlength: '12' },
};
/** A sample IMEI service whose main box is named only IMEI: it stays an IMEI service. */
const IMEI_BOX_SERVICE: FakeService = {
  id: '9103',
  group: 'Sample carrier checks',
  type: 'IMEI',
  name: 'Sample carrier check',
  credit: '1.5000',
  time: '1 hour',
  custom: { allow: '1', customname: 'IMEI', maxlength: '15' },
};

const xml = (body: string) => `<PARAMETERS>${body}</PARAMETERS>`;
const base64Json = (value: unknown) => Buffer.from(JSON.stringify(value), 'utf8').toString('base64');

/** A new supplier at the fake whose only service is the default IMEI service 4411, linked to a fresh automatic IMEI service. */
async function imeiRoute(paramFormat: 'dhru_xml' | 'json') {
  const supplierId = await insertFakeSupplier(world.db, t.app.get(EncryptionService), fake, { paramFormat });
  const serviceId = await insertService(world.db, world.auto.categoryId, {
    cost: '13.5000',
    effectiveCost: '13.5000',
    basePrice: '17.2800',
    minProfit: '0.8100',
  });
  await linkService(world.db, serviceId, supplierId, { credit: '13.5000' });
  return { supplierId, serviceId };
}

/** The merchant places one order through the portal. */
async function placed(body: Record<string, unknown>): Promise<number> {
  const res = await (await portalFor(t, world.merchant.id)).post('/client/orders', body);
  expect(res.statusCode).toBe(201);
  return json(res).orders[0].id as number;
}

/** Syncs the supplier and imports the supplier services of the given remote ids through the console route. */
async function importRemote(supplierId: number, remoteIds: string[]): Promise<Map<string, number>> {
  const synced = await sync.run(supplierId, { audit: false });
  expect(synced.ok).toBe(true);
  const rows = await world.db.select().from(s.supplierServices).where(eq(s.supplierServices.supplierId, supplierId));
  const ids = rows.filter((row) => remoteIds.includes(row.remoteId)).map((row) => row.id);
  const res = await staff.post(`/admin/suppliers/${supplierId}/import`, { supplierServiceIds: ids });
  expect(res.status).toBe(200);
  const links = await world.db
    .select({ remoteId: s.supplierServices.remoteId, serviceId: s.serviceSupplierLinks.serviceId })
    .from(s.serviceSupplierLinks)
    .innerJoin(s.supplierServices, eq(s.supplierServices.id, s.serviceSupplierLinks.supplierServiceId))
    .where(eq(s.supplierServices.supplierId, supplierId));
  return new Map(links.map((link) => [link.remoteId, link.serviceId]));
}

const fieldsOf = (serviceId: number) =>
  world.db
    .select()
    .from(s.serviceFields)
    .where(eq(s.serviceFields.serviceId, serviceId))
    .orderBy(asc(s.serviceFields.sort), asc(s.serviceFields.id));
const serviceOf = async (serviceId: number) =>
  (await world.db.select().from(s.services).where(eq(s.services.id, serviceId)))[0]!;
const categoryOf = async (categoryId: number) =>
  (await world.db.select().from(s.serviceCategories).where(eq(s.serviceCategories.id, categoryId)))[0]!;

describe('the parameters in the form the supplier reads (decision 042)', () => {
  it('sends a dhru_xml supplier the classic XML string for placeimeiorder and getimeiorder, and the log row says the form', async () => {
    const { supplierId, serviceId } = await imeiRoute('dhru_xml');
    fake.accepts = 'dhru_xml';
    const orderId = await placed({ serviceId, imei: IMEIS[0] });
    expect(await dispatch.run(orderId, { lastAttempt: false })).toMatchObject({ status: 'sent' });
    const reference = fake.referenceOf(1);
    expect(await poll.check(orderId, { type: 'system' })).toMatchObject({ kind: 'running' });

    const [place] = fake.callsOf('placeimeiorder');
    expect(place).toMatchObject({
      format: 'dhru_xml',
      rawParameters: xml(`<ID>4411</ID><IMEI>${IMEIS[0]}</IMEI><QNT>1</QNT>`),
    });
    const [get] = fake.callsOf('getimeiorder');
    expect(get).toMatchObject({ format: 'dhru_xml', rawParameters: xml(`<ID>${reference}</ID>`) });
    expect(fake.callsOf('accountinfo')).toHaveLength(0);

    const logs = await logsOf(world.db, supplierId);
    expect(logs.map((log) => [log.action, log.outcome, log.request?.format])).toEqual([
      ['placeimeiorder', 'ok', 'dhru_xml'],
      ['getimeiorder', 'ok', 'dhru_xml'],
    ]);
    expect(logs[0]!.request).toMatchObject({
      parameters: { ID: '4411', IMEI: `••••••••${IMEIS[0].slice(-4)}`, QNT: 1 },
    });
    expect(JSON.stringify(logs)).not.toContain(IMEIS[0]);
  });

  it('sends a json supplier base64 of JSON, as decision 026 describes', async () => {
    const { supplierId, serviceId } = await imeiRoute('json');
    fake.accepts = 'json';
    const orderId = await placed({ serviceId, imei: IMEIS[1] });
    expect(await dispatch.run(orderId, { lastAttempt: false })).toMatchObject({ status: 'sent' });
    await poll.check(orderId, { type: 'system' });

    expect(fake.callsOf('placeimeiorder')[0]).toMatchObject({
      format: 'json',
      rawParameters: base64Json({ ID: '4411', IMEI: IMEIS[1], QNT: 1 }),
    });
    expect(fake.callsOf('getimeiorder')[0]).toMatchObject({
      format: 'json',
      rawParameters: base64Json({ ID: fake.referenceOf(1) }),
    });
    expect((await logsOf(world.db, supplierId)).map((log) => log.request?.format)).toEqual(['json', 'json']);
  });

  it("refuses the wrong form with the supplier's message: the order stops for review with the hold kept and is never sent again", async () => {
    const { supplierId, serviceId } = await imeiRoute('json');
    fake.accepts = 'dhru_xml';
    const before = await walletOf(world.db, world.merchant.id);
    const orderId = await placed({ serviceId, imei: IMEIS[2] });
    const held = await walletOf(world.db, world.merchant.id);
    expect(held.hold).not.toBe(before.hold);

    const outcome = await dispatch.run(orderId, { lastAttempt: false });
    expect(outcome).toEqual({
      status: 'needs_attention',
      reason: expect.stringContaining("refused the order: Parameter 'ID' Required"),
    });
    expect(await orderRow(world.db, orderId)).toMatchObject({ dispatchState: 'needs_attention', supplierRef: null });
    expect(await walletOf(world.db, world.merchant.id)).toEqual(held);
    const [log] = await logsOf(world.db, supplierId);
    expect(log).toMatchObject({
      action: 'placeimeiorder',
      outcome: 'error',
      httpStatus: 200,
      error: "Parameter 'ID' Required",
      request: { format: 'json' },
    });

    // A second run of the job, or the queue's retry, sends nothing.
    expect(await dispatch.run(orderId, { lastAttempt: true })).toMatchObject({ status: 'skipped' });
    expect(fake.callsOf('placeimeiorder')).toHaveLength(1);
    expect(await logsOf(world.db, supplierId)).toHaveLength(1);
  });

  it('is refused the same way when a dhru_xml supplier reads only base64 of JSON', async () => {
    const { serviceId } = await imeiRoute('dhru_xml');
    fake.accepts = 'json';
    const orderId = await placed({ serviceId, imei: IMEIS[3] });
    expect(await dispatch.run(orderId, { lastAttempt: false })).toMatchObject({ status: 'needs_attention' });
    expect(fake.callsOf('placeimeiorder')).toHaveLength(1);
    expect(fake.orders.size).toBe(0);
  });
});

describe("the supplier's main box (CUSTOM)", () => {
  it('imports a CUSTOM service as a server service whose first field is the box, regex from the lengths, sent as IMEI', async () => {
    fake.services = [ECID_SERVICE];
    const supplierId = await insertFakeSupplier(world.db, t.app.get(EncryptionService), fake);
    await sync.run(supplierId, { audit: false });
    const synced = await world.db
      .select()
      .from(s.supplierServices)
      .where(eq(s.supplierServices.supplierId, supplierId));
    const preview = await staff.post(`/admin/suppliers/${supplierId}/import/preview`, {
      supplierServiceIds: synced.map((row) => row.id),
    });
    // The preview tags the item with the type the import makes of it.
    expect(preview.body.items[0]).toMatchObject({ name: 'Sample ECID report', type: 'SERVER', state: 'new' });

    const serviceId = (await importRemote(supplierId, ['9101'])).get('9101')!;
    const service = await serviceOf(serviceId);
    expect(service.type).toBe('server');
    expect(await categoryOf(service.categoryId)).toMatchObject({ name: 'Sample device reports', type: 'server' });
    expect(
      (await fieldsOf(serviceId)).map((field) => [
        field.key,
        field.label,
        field.supplierKey,
        field.isMainInput,
        field.required,
        field.regex,
      ]),
    ).toEqual([
      ['ecid', 'ECID', 'ECID', true, true, '^.{13,16}$'],
      ['model', 'Model', 'Model', false, false, ''],
    ]);

    // The portal checks the box like any field.
    const portal = await portalFor(t, world.merchant.id);
    const short = await portal.post('/client/orders', { serviceId, inputs: { ecid: '0001A2' } });
    expect(short.statusCode).toBe(422);
    expect(json(short).errors).toEqual([expect.objectContaining({ field: 'inputs.ecid', code: 'invalid_format' })]);

    const orderId = await placed({ serviceId, inputs: { ecid: '0001A2B3C4D5E6', model: 'Sample X' } });
    expect((await orderRow(world.db, orderId)).imei).toBe('0001A2B3C4D5E6');
    expect(await dispatch.run(orderId, { lastAttempt: false })).toMatchObject({ status: 'sent' });
    const [place] = fake.callsOf('placeimeiorder');
    expect(place!.rawParameters).toBe(
      xml(
        `<ID>9101</ID><IMEI>0001A2B3C4D5E6</IMEI><QNT>1</QNT><CUSTOMFIELD>${base64Json({ Model: 'Sample X' })}</CUSTOMFIELD>`,
      ),
    );
    expect(place!.parameters.CUSTOMFIELD).toEqual({ Model: 'Sample X' });
  });

  it('sends no CUSTOMFIELD at all when the box is the only value', async () => {
    fake.services = [ECID_SERVICE];
    const supplierId = await insertFakeSupplier(world.db, t.app.get(EncryptionService), fake);
    const serviceId = (await importRemote(supplierId, ['9101'])).get('9101')!;
    const orderId = await placed({ serviceId, inputs: { ecid: 'ABCDEF0123456' } });
    expect(await dispatch.run(orderId, { lastAttempt: false })).toMatchObject({ status: 'sent' });
    expect(fake.callsOf('placeimeiorder')[0]!.rawParameters).toBe(
      xml('<ID>9101</ID><IMEI>ABCDEF0123456</IMEI><QNT>1</QNT>'),
    );
  });

  it('quick adds a CUSTOM service as a server service with the box first', async () => {
    fake.services = [SERIAL_SERVICE];
    const supplierId = await insertFakeSupplier(world.db, t.app.get(EncryptionService), fake);
    expect((await sync.run(supplierId, { audit: false })).ok).toBe(true);
    const started = await staff.post(`/admin/suppliers/${supplierId}/quick-add`, {
      scope: 'groups',
      groups: [{ type: 'IMEI', remoteGroup: 'Sample serial tools' }],
    });
    expect(started.status).toBe(202);
    expect(await t.app.get(QuickAddRunner, { strict: false }).run(started.body.id)).toBe('succeeded');
    const [link] = await world.db
      .select({ serviceId: s.serviceSupplierLinks.serviceId })
      .from(s.serviceSupplierLinks)
      .innerJoin(s.supplierServices, eq(s.supplierServices.id, s.serviceSupplierLinks.supplierServiceId))
      .where(eq(s.supplierServices.supplierId, supplierId));
    const service = await serviceOf(link!.serviceId);
    expect(service.type).toBe('server');
    expect(await categoryOf(service.categoryId)).toMatchObject({ name: 'Sample serial tools', type: 'server' });
    expect(
      (await fieldsOf(service.id)).map((field) => [field.key, field.supplierKey, field.isMainInput, field.regex]),
    ).toEqual([['serial_number', 'Serial Number', true, '^.{10,12}$']]);
  });

  it('imports each field under the name its supplier spells; a repeat in another letter case gets a number, and a field named IMEI is no main input', async () => {
    const field = (fieldname: string, over: Record<string, unknown> = {}) => ({
      type: 'serviceserver',
      fieldname,
      fieldtype: 'text',
      description: '',
      required: 'on',
      ...over,
    });
    fake.services = [
      {
        id: '9104',
        group: 'Sample account tools',
        type: 'SERVER',
        name: 'Sample account tool',
        credit: '2.0000',
        time: '1 hour',
        requiresCustom: [
          field('IMEI', { description: 'Device IMEI' }),
          field('Email'),
          field('email'),
          field('EMAIL '),
        ],
      },
    ];
    const supplierId = await insertFakeSupplier(world.db, t.app.get(EncryptionService), fake);
    const serviceId = (await importRemote(supplierId, ['9104'])).get('9104')!;
    expect((await serviceOf(serviceId)).type).toBe('server');
    expect(
      (await fieldsOf(serviceId)).map((field) => [field.key, field.supplierKey, field.label, field.isMainInput]),
    ).toEqual([
      ['imei', 'IMEI', 'Device IMEI', false],
      ['email', 'Email', 'Email', false],
      ['email_2', 'email 2', 'email 2', false],
      ['email_3', 'EMAIL 3', 'EMAIL 3', false],
    ]);
  });

  it('keeps a service whose box is named only IMEI an IMEI service that still refuses a bad Luhn digit', async () => {
    fake.services = [IMEI_BOX_SERVICE];
    const supplierId = await insertFakeSupplier(world.db, t.app.get(EncryptionService), fake);
    const serviceId = (await importRemote(supplierId, ['9103'])).get('9103')!;
    expect((await serviceOf(serviceId)).type).toBe('imei');
    expect(await fieldsOf(serviceId)).toHaveLength(0);
    const bad = await (
      await portalFor(t, world.merchant.id)
    ).post('/client/orders', { serviceId, imei: '352905112490860' });
    expect(bad.statusCode).toBe(422);
    expect(json(bad)).toMatchObject({ code: 'INVALID_IMEI' });
    const orderId = await placed({ serviceId, imei: IMEIS[4] });
    expect(await dispatch.run(orderId, { lastAttempt: false })).toMatchObject({ status: 'sent' });
    expect(fake.callsOf('placeimeiorder')[0]!.rawParameters).toBe(
      xml(`<ID>9103</ID><IMEI>${IMEIS[4]}</IMEI><QNT>1</QNT>`),
    );
  });
});

describe('a field named IMEI on a service that stays an IMEI service (decision 065)', () => {
  it('is the main input: the order form leaves it out, the typed IMEI fills it and travels as IMEI, never in CUSTOMFIELD', async () => {
    fake.services = [
      {
        id: '9105',
        group: 'Sample carrier checks',
        type: 'IMEI',
        name: 'Sample IMEI field check',
        credit: '1.5000',
        time: '1 hour',
        requiresCustom: [
          { type: 'serviceimei', fieldname: 'imei', fieldtype: 'text', description: 'IMEI', required: 'on' },
          { type: 'serviceimei', fieldname: 'Model', fieldtype: 'text', description: 'Model', required: '0' },
        ],
      },
    ];
    const supplierId = await insertFakeSupplier(world.db, t.app.get(EncryptionService), fake);
    const serviceId = (await importRemote(supplierId, ['9105'])).get('9105')!;
    expect((await serviceOf(serviceId)).type).toBe('imei');
    expect(
      (await fieldsOf(serviceId)).map((field) => [field.key, field.supplierKey, field.isMainInput, field.required]),
    ).toEqual([
      ['imei', 'imei', true, true],
      ['model', 'Model', false, false],
    ]);
    const portal = await portalFor(t, world.merchant.id);
    const form = await portal.get(`/client/services/${serviceId}`);
    expect(json(form).fields.map((field: { key: string }) => field.key)).toEqual(['model']);
    const orderId = await placed({ serviceId, imei: IMEIS[2], inputs: { model: 'Sample Y' } });
    expect(await dispatch.run(orderId, { lastAttempt: false })).toMatchObject({ status: 'sent' });
    expect(fake.callsOf('placeimeiorder')[0]!.parameters).toEqual({
      ID: '9105',
      IMEI: IMEIS[2],
      QNT: 1,
      CUSTOMFIELD: { Model: 'Sample Y' },
    });
  });
});

describe("the sync adopts the supplier's main box on IMEI services made before", () => {
  it('makes the service a server service with the box first, writes one audit row and counts it; a second sync adopts none', async () => {
    const { db } = world;
    fake.services = [ECID_SERVICE, SERIAL_SERVICE];
    const supplierId = await insertFakeSupplier(db, t.app.get(EncryptionService), fake);
    const otherSupplier = await insertFakeSupplier(db, t.app.get(EncryptionService), fake);
    // Two adoptable services in one IMEI category, as the quick add made them before decision 042.
    const oldCategory = await insertCategory(db, { name: 'Legacy Reports' });
    const adoptable = await insertService(db, oldCategory, {
      name: 'Old ECID report',
      basePrice: '4.5000',
      cost: '3.0000',
      effectiveCost: '3.0000',
      status: 'disabled',
      minQty: 1,
      maxQty: 3,
      slaMinutes: 90,
    });
    await db.insert(s.serviceFields).values([
      { serviceId: adoptable, key: 'model', label: 'Model', supplierKey: 'Model', sort: 0 },
      { serviceId: adoptable, key: 'ecid', label: 'Old ECID', supplierKey: 'Other', sort: 1 },
    ]);
    const ecidRemote = (await linkService(db, adoptable, supplierId, { remoteId: '9101', credit: '3.0000' }))
      .supplierServiceId;
    const second = await insertService(db, oldCategory, { name: 'Old serial check' });
    await linkService(db, second, supplierId, { remoteId: '9102', credit: '2.0000' });

    // The four services the sync leaves alone.
    const twoLinks = await insertService(db, oldCategory, { name: 'Two active links' });
    await db.insert(s.serviceSupplierLinks).values({ serviceId: twoLinks, supplierServiceId: ecidRemote, priority: 1 });
    await linkService(db, twoLinks, otherSupplier, { remoteId: '7001', priority: 2 });
    const archived = await insertService(db, oldCategory, {
      name: 'Archived',
      status: 'disabled',
      archivedAt: new Date('2026-11-01T00:00:00.000Z'),
    });
    await db.insert(s.serviceSupplierLinks).values({ serviceId: archived, supplierServiceId: ecidRemote, priority: 1 });
    const remoteCategory = await insertCategory(db, { name: 'Sample remote', type: 'remote' });
    const otherType = await insertService(db, remoteCategory, { type: 'remote', name: 'Already remote' });
    await db
      .insert(s.serviceSupplierLinks)
      .values({ serviceId: otherType, supplierServiceId: ecidRemote, priority: 1 });
    const staffKey = await insertService(db, oldCategory, { name: 'Staff marked the box' });
    await db
      .insert(s.serviceFields)
      .values({ serviceId: staffKey, key: 'device', label: 'Device', supplierKey: 'Device', isMainInput: true });
    await db.insert(s.serviceSupplierLinks).values({ serviceId: staffKey, supplierServiceId: ecidRemote, priority: 1 });

    const versionBefore = await catalogVersionOf(t);
    const before = await serviceOf(adoptable);
    const outcome = await sync.run(supplierId, { audit: true });
    expect(outcome).toMatchObject({ ok: true, result: { adopted: 2 } });

    const after = await serviceOf(adoptable);
    expect(after.type).toBe('server');
    const category = await categoryOf(after.categoryId);
    expect(category).toMatchObject({ name: 'Legacy Reports', type: 'server', isActive: true, allowedGroupIds: [] });
    expect(after.categoryId).not.toBe(oldCategory);
    // Nothing else of the service changed.
    const kept = (row: typeof before) => ({
      name: row.name,
      code: row.code,
      status: row.status,
      basePrice: row.basePrice,
      cost: row.cost,
      minQty: row.minQty,
      maxQty: row.maxQty,
      qtyOptions: row.qtyOptions,
      slaMinutes: row.slaMinutes,
      fulfillment: row.fulfillment,
      archivedAt: row.archivedAt,
    });
    expect(kept(after)).toEqual(kept(before));
    expect(
      (await fieldsOf(adoptable)).map((field) => [
        field.key,
        field.label,
        field.supplierKey,
        field.isMainInput,
        field.sort,
        field.regex,
      ]),
    ).toEqual([
      ['ecid_2', 'ECID', 'ECID', true, 0, '^.{13,16}$'],
      ['model', 'Model', 'Model', false, 1, ''],
      ['ecid', 'Old ECID', 'Other', false, 2, ''],
    ]);
    // The second service went into the same new server category.
    expect(await serviceOf(second)).toMatchObject({ type: 'server', categoryId: after.categoryId });
    expect((await fieldsOf(second)).map((field) => field.key)).toEqual(['serial_number']);

    for (const id of [twoLinks, archived, otherType, staffKey]) {
      const left = await serviceOf(id);
      expect(left.type, String(id)).toBe(id === otherType ? 'remote' : 'imei');
      expect(left.categoryId).toBe(id === otherType ? remoteCategory : oldCategory);
    }
    expect(await fieldsOf(twoLinks)).toHaveLength(0);

    const audits = await db
      .select()
      .from(s.auditLogs)
      .where(and(eq(s.auditLogs.entityType, 'service'), eq(s.auditLogs.action, "adopted the supplier's input")))
      .orderBy(asc(s.auditLogs.id));
    expect(audits).toHaveLength(2);
    expect(audits[0]).toMatchObject({
      actorType: 'system',
      entityId: adoptable,
      entityLabel: 'Old ECID report',
      before: { type: 'imei', categoryId: oldCategory },
      after: {
        type: 'server',
        categoryId: after.categoryId,
        field: { key: 'ecid_2', name: 'ECID', label: 'ECID' },
      },
    });
    const [synced] = await db
      .select()
      .from(s.auditLogs)
      .where(and(eq(s.auditLogs.entityType, 'supplier'), eq(s.auditLogs.entityId, supplierId)));
    expect(synced!.after).toMatchObject({ adopted: 2 });

    const searchEvents = await db
      .select()
      .from(s.outboxEvents)
      .where(eq(s.outboxEvents.type, 'catalog.services_changed'));
    const changed = searchEvents.flatMap((event) => (event.payload as { serviceIds: number[] }).serviceIds);
    expect(changed).toEqual(expect.arrayContaining([adoptable, second]));
    expect(await catalogVersionOf(t)).not.toBe(versionBefore);

    // An order of the adopted service sends the box as IMEI.
    await db.update(s.services).set({ status: 'active' }).where(eq(s.services.id, adoptable));
    const orderId = await placed({ serviceId: adoptable, inputs: { ecid_2: 'ABCDEF0123456', model: 'Sample Y' } });
    expect(await dispatch.run(orderId, { lastAttempt: false })).toMatchObject({ status: 'sent' });
    expect(fake.callsOf('placeimeiorder')[0]!.parameters).toEqual({
      ID: '9101',
      IMEI: 'ABCDEF0123456',
      QNT: 1,
      CUSTOMFIELD: { Model: 'Sample Y' },
    });

    const again = await sync.run(supplierId, { audit: false });
    expect(again).toMatchObject({ ok: true, result: { adopted: 0 } });
    expect((await fieldsOf(adoptable)).map((field) => field.key)).toEqual(['ecid_2', 'model', 'ecid']);
  });

  it('adopts nothing for a service whose supplier service has no main box', async () => {
    const { db } = world;
    fake.services = [IMEI_BOX_SERVICE];
    const supplierId = await insertFakeSupplier(db, t.app.get(EncryptionService), fake);
    const serviceId = await insertService(db, await insertCategory(db));
    await linkService(db, serviceId, supplierId, { remoteId: '9103', credit: '1.5000' });
    expect(await sync.run(supplierId, { audit: false })).toMatchObject({ ok: true, result: { adopted: 0 } });
    expect((await serviceOf(serviceId)).type).toBe('imei');
  });
});

describe("which value is sent as the supplier's main box (the field flagged isMainInput) and under which names the rest travels", () => {
  /** A fresh automatic service of the given type with fields, linked (with a field map) to a new supplier at the fake. */
  async function routeWith(
    type: 'imei' | 'server',
    fields: Array<{ key: string; supplierKey: string; sort: number; required?: boolean; isMainInput?: boolean }>,
    fieldMap: Record<string, string> = {},
  ): Promise<number> {
    const { db } = world;
    const supplierId = await insertFakeSupplier(db, t.app.get(EncryptionService), fake);
    const categoryId = type === 'imei' ? world.auto.categoryId : await insertCategory(db, { type: 'server' });
    const serviceId = await insertService(db, categoryId, {
      type,
      cost: '6.0000',
      effectiveCost: '6.0000',
      basePrice: '8.0000',
      minProfit: '0.5000',
    });
    await db
      .insert(s.serviceFields)
      .values(fields.map((field) => ({ serviceId, label: field.key, required: field.required ?? false, ...field })));
    await linkService(db, serviceId, supplierId, { remoteId: '4412', type: 'SERVER', credit: '6.0000', fieldMap });
    return serviceId;
  }

  it('sends the value of the flagged field as IMEI, and every other field in CUSTOMFIELD under its Name', async () => {
    const serviceId = await routeWith('server', [
      { key: 'later', supplierKey: 'Later Field', sort: 2 },
      { key: 'serial', supplierKey: 'Serial Number', sort: 1, required: true, isMainInput: true },
      { key: 'note', supplierKey: 'Note', sort: 3 },
    ]);
    const orderId = await placed({ serviceId, inputs: { later: 'SECOND-1', serial: 'FIRST-1', note: 'n' } });
    expect(await dispatch.run(orderId, { lastAttempt: false })).toMatchObject({ status: 'sent' });
    expect(fake.callsOf('placeimeiorder')[0]!.parameters).toEqual({
      ID: '4412',
      IMEI: 'FIRST-1',
      QNT: 1,
      CUSTOMFIELD: { 'Later Field': 'SECOND-1', Note: 'n' },
    });
  });

  it('stores as the order main input the value it sends as IMEI, also when a required field comes before the flagged one', async () => {
    const serviceId = await routeWith('server', [
      { key: 'account', supplierKey: 'Account', sort: 0, required: true },
      { key: 'serial', supplierKey: 'Serial Number', sort: 1, isMainInput: true },
    ]);
    const orderId = await placed({ serviceId, inputs: { account: 'ACC-0001', serial: 'SER-0001' } });
    expect((await orderRow(world.db, orderId)).imei).toBe('SER-0001');
    expect(await dispatch.run(orderId, { lastAttempt: false })).toMatchObject({ status: 'sent' });
    expect(fake.callsOf('placeimeiorder')[0]!.parameters).toEqual({
      ID: '4412',
      IMEI: 'SER-0001',
      QNT: 1,
      CUSTOMFIELD: { Account: 'ACC-0001' },
    });
  });

  it('treats a field that its supplier names IMEI as an ordinary field when it is not flagged: it travels in CUSTOMFIELD', async () => {
    const serviceId = await routeWith('server', [
      { key: 'lock_code', supplierKey: 'Lock Code', sort: 0, required: true, isMainInput: true },
      { key: 'device_imei', supplierKey: 'IMEI', sort: 1 },
    ]);
    const orderId = await placed({ serviceId, inputs: { lock_code: 'LOCK-0001', device_imei: 'DEVICE-0002' } });
    expect(await dispatch.run(orderId, { lastAttempt: false })).toMatchObject({ status: 'sent' });
    expect(fake.callsOf('placeimeiorder')[0]!.parameters).toEqual({
      ID: '4412',
      IMEI: 'LOCK-0001',
      QNT: 1,
      CUSTOMFIELD: { IMEI: 'DEVICE-0002' },
    });
  });

  it("sends the order's own IMEI before the flagged field, and still keeps that field out of CUSTOMFIELD", async () => {
    const serviceId = await routeWith('imei', [{ key: 'serial', supplierKey: 'Serial', sort: 0, isMainInput: true }]);
    const orderId = await placed({ serviceId, imei: IMEIS[0], inputs: { serial: 'SERIAL-TEST-0002' } });
    expect(await dispatch.run(orderId, { lastAttempt: false })).toMatchObject({ status: 'sent' });
    expect(fake.callsOf('placeimeiorder')[0]!.parameters).toEqual({ ID: '4412', IMEI: IMEIS[0], QNT: 1 });
  });

  it("sends a field under the link's field map name when it has one, else under its Name; the map never makes a field the main box", async () => {
    const serviceId = await routeWith(
      'server',
      [
        { key: 'device', supplierKey: 'Device', sort: 0, required: true },
        { key: 'plan', supplierKey: 'Plan', sort: 1 },
      ],
      { device: 'imei' },
    );
    const orderId = await placed({ serviceId, inputs: { device: 'SERIAL-TEST-0003', plan: 'Pro' } });
    expect(await dispatch.run(orderId, { lastAttempt: false })).toMatchObject({ status: 'sent' });
    expect(fake.callsOf('placeimeiorder')[0]!.parameters).toEqual({
      ID: '4412',
      QNT: 1,
      CUSTOMFIELD: { imei: 'SERIAL-TEST-0003', Plan: 'Pro' },
    });
  });
});

describe('the adoption: categories, links and the guards of the shared rule', () => {
  /** A supplier at the fake listing the ECID sample, and an IMEI service in a category of the given name linked to it. */
  async function oldService(categoryName: string, category: Partial<typeof s.serviceCategories.$inferInsert> = {}) {
    const { db } = world;
    fake.services = [ECID_SERVICE];
    const supplierId = await insertFakeSupplier(db, t.app.get(EncryptionService), fake);
    const categoryId = await insertCategory(db, { name: categoryName, ...category });
    const serviceId = await insertService(db, categoryId, {
      cost: '3.0000',
      effectiveCost: '3.0000',
      basePrice: '4.0000',
    });
    const { linkId } = await linkService(db, serviceId, supplierId, { remoteId: '9101', credit: '3.0000' });
    return { supplierId, serviceId, categoryId, linkId };
  }
  const groupId = async () => (await world.db.select({ id: s.clientGroups.id }).from(s.clientGroups).limit(1))[0]!.id;

  it("copies the old category's switch and groups into a category it creates for the move", async () => {
    const group = await groupId();
    const { supplierId, serviceId } = await oldService('Copied Reports', { isActive: false, allowedGroupIds: [group] });
    expect(await sync.run(supplierId, { audit: false })).toMatchObject({ ok: true, result: { adopted: 1 } });
    const moved = await serviceOf(serviceId);
    expect(await categoryOf(moved.categoryId)).toMatchObject({
      name: 'Copied Reports',
      type: 'server',
      isActive: false,
      allowedGroupIds: [group],
    });
  });

  it('reuses a server category of the same name (any case) as it is, with its own switch and groups', async () => {
    const group = await groupId();
    const existing = await insertCategory(world.db, {
      name: 'reused reports',
      type: 'server',
      isActive: false,
      allowedGroupIds: [group],
    });
    const { supplierId, serviceId } = await oldService('Reused Reports');
    expect(await sync.run(supplierId, { audit: false })).toMatchObject({ ok: true, result: { adopted: 1 } });
    expect((await serviceOf(serviceId)).categoryId).toBe(existing);
    expect(await categoryOf(existing)).toMatchObject({
      name: 'reused reports',
      isActive: false,
      allowedGroupIds: [group],
    });
  });

  it('adopts a service with one active and one inactive link, and not one with two active links', async () => {
    const { db } = world;
    const other = await insertFakeSupplier(db, t.app.get(EncryptionService), fake);
    const one = await oldService('Inactive Second Link');
    await linkService(db, one.serviceId, other, { remoteId: '7101', priority: 2, isActive: false });
    expect(await sync.run(one.supplierId, { audit: false })).toMatchObject({ ok: true, result: { adopted: 1 } });
    expect((await serviceOf(one.serviceId)).type).toBe('server');

    const two = await oldService('Active Second Link');
    await linkService(db, two.serviceId, other, { remoteId: '7102', priority: 2, isActive: true });
    expect(await sync.run(two.supplierId, { audit: false })).toMatchObject({ ok: true, result: { adopted: 0 } });
    expect((await serviceOf(two.serviceId)).type).toBe('imei');
  });

  it('leaves alone a service that already has a main-input field, whatever its key and Name', async () => {
    const { db } = world;
    for (const [category, key, supplierKey] of [
      ['Flagged Imei', 'imei', 'IMEI'],
      ['Flagged Other', 'device', 'Device'],
    ] as const) {
      const flagged = await oldService(category);
      await db
        .insert(s.serviceFields)
        .values({ serviceId: flagged.serviceId, key, label: 'Device', supplierKey, isMainInput: true });
      expect(await sync.run(flagged.supplierId, { audit: false })).toMatchObject({ ok: true, result: { adopted: 0 } });
      expect((await serviceOf(flagged.serviceId)).type, category).toBe('imei');
      expect(await fieldsOf(flagged.serviceId)).toHaveLength(1);
    }
  });

  it('adopts a service whose field is only named IMEI, or that its link maps to IMEI: the flag decides, not a name', async () => {
    const { db } = world;
    const named = await oldService('Named Imei');
    await db
      .insert(s.serviceFields)
      .values({ serviceId: named.serviceId, key: 'imei', label: 'Device', supplierKey: 'IMEI' });
    expect(await sync.run(named.supplierId, { audit: false })).toMatchObject({ ok: true, result: { adopted: 1 } });
    expect((await serviceOf(named.serviceId)).type).toBe('server');
    expect(
      (await fieldsOf(named.serviceId)).map((field) => [field.key, field.supplierKey, field.isMainInput, field.sort]),
    ).toEqual([
      ['ecid', 'ECID', true, 0],
      ['imei', 'IMEI', false, 1],
    ]);

    const mapped = await oldService('Mapped Imei');
    await db
      .insert(s.serviceFields)
      .values({ serviceId: mapped.serviceId, key: 'device', label: 'Device', supplierKey: 'Device' });
    await db
      .update(s.serviceSupplierLinks)
      .set({ fieldMap: { device: 'Imei' } })
      .where(eq(s.serviceSupplierLinks.id, mapped.linkId));
    expect(await sync.run(mapped.supplierId, { audit: false })).toMatchObject({ ok: true, result: { adopted: 1 } });
    expect((await serviceOf(mapped.serviceId)).type).toBe('server');
  });

  it("gives the box another Name when its own is taken by another field in any letter case, and keeps the supplier's field named as before", async () => {
    const { db } = world;
    const taken = await oldService('Taken Box Name');
    await db
      .insert(s.serviceFields)
      .values({ serviceId: taken.serviceId, key: 'model', label: 'Model', supplierKey: 'ecid' });
    expect(await sync.run(taken.supplierId, { audit: false })).toMatchObject({ ok: true, result: { adopted: 1 } });
    expect((await fieldsOf(taken.serviceId)).map((field) => [field.key, field.supplierKey, field.isMainInput])).toEqual(
      [
        ['ecid', 'ECID 2', true],
        ['model', 'ecid', false],
      ],
    );
  });

  it('writes nothing when the box it is given has a key or a Name that the service already uses, or the service already has a box', async () => {
    const { db } = world;
    const { serviceId } = await oldService('Refused Adoption');
    await db.insert(s.serviceFields).values({ serviceId, key: 'model', label: 'Model', supplierKey: 'Model' });
    const importer = t.app.get(ServiceImporter, { strict: false });
    const box = mainInputField({ label: 'ECID', minLength: 1, maxLength: null }, { keys: new Set(), names: new Set() });
    const adopt = (field: typeof box) =>
      t.app
        .get(DbService, { strict: false })
        .runInTransaction(({ tx }) => importer.adoptMainInput(tx, { serviceId, field }));
    expect(await adopt({ ...box, supplierKey: ' MODEL ' })).toBeNull();
    expect(await adopt({ ...box, key: 'model' })).toBeNull();
    expect((await serviceOf(serviceId)).type).toBe('imei');
    expect((await fieldsOf(serviceId)).map((field) => field.key)).toEqual(['model']);

    await db.update(s.serviceFields).set({ isMainInput: true }).where(eq(s.serviceFields.serviceId, serviceId));
    expect(await adopt(box)).toBeNull();
    expect((await serviceOf(serviceId)).type).toBe('imei');

    await db.update(s.serviceFields).set({ isMainInput: false }).where(eq(s.serviceFields.serviceId, serviceId));
    expect(await adopt(box)).toMatchObject({ before: { type: 'imei' }, after: { type: 'server' } });
    expect(
      (await fieldsOf(serviceId)).map((field) => [field.key, field.supplierKey, field.isMainInput, field.sort]),
    ).toEqual([
      ['ecid', 'ECID', true, 0],
      ['model', 'Model', false, 1],
    ]);
  });
});

describe('the fields a supplier requires ("required": "on")', () => {
  // Shaped like a Dhru Fusion entry; the names are made up.
  const fusionField = (fieldname: string, over: Record<string, unknown> = {}) => ({
    type: 'serviceimei',
    fieldname,
    fieldtype: 'text',
    description: '',
    fieldoptions: '',
    required: 'on',
    regexpr: '',
    adminonly: '',
    ...over,
  });
  const ACCOUNT_SERVICE: FakeService = {
    id: '9301',
    group: 'Sample accounts',
    type: 'SERVER',
    name: 'Sample account renewal',
    credit: '5.0000',
    time: '1 hour',
    requiresCustom: [
      fusionField('Account Email'),
      fusionField('Region'),
      fusionField('Note', { required: '' }),
      fusionField('Staff Ref', { adminonly: 'on' }),
    ],
  };
  const requiredOf = async (serviceId: number) =>
    (await fieldsOf(serviceId)).map((field) => [field.key, field.required]);
  const auditsOf = (serviceId: number, action: string) =>
    world.db
      .select()
      .from(s.auditLogs)
      .where(and(eq(s.auditLogs.entityId, serviceId), eq(s.auditLogs.action, action)))
      .orderBy(asc(s.auditLogs.id));

  /** A server service made before: the supplier's fields, all optional, linked to the sample. */
  async function serverMadeBefore(
    fields: Array<{ key: string; supplierKey: string; required?: boolean }>,
    fieldMap: Record<string, string> = {},
  ) {
    const { db } = world;
    fake.services = [ACCOUNT_SERVICE];
    const supplierId = await insertFakeSupplier(db, t.app.get(EncryptionService), fake);
    const serviceId = await insertService(db, await insertCategory(db, { type: 'server' }), {
      type: 'server',
      cost: '5.0000',
      effectiveCost: '5.0000',
      basePrice: '7.0000',
      minProfit: '0.5000',
    });
    await db
      .insert(s.serviceFields)
      .values(fields.map((field, sort) => ({ serviceId, label: field.key, required: false, sort, ...field })));
    const { linkId } = await linkService(db, serviceId, supplierId, {
      remoteId: '9301',
      type: 'SERVER',
      credit: '5.0000',
      fieldMap,
    });
    return { supplierId, serviceId, linkId };
  }

  it('an import and a quick add create the "on" fields required, leave adminonly out', async () => {
    fake.services = [ACCOUNT_SERVICE];
    const imported = await insertFakeSupplier(world.db, t.app.get(EncryptionService), fake);
    const serviceId = (await importRemote(imported, ['9301'])).get('9301')!;
    expect(await requiredOf(serviceId)).toEqual([
      ['account_email', true],
      ['region', true],
      ['note', false],
    ]);

    const quick = await insertFakeSupplier(world.db, t.app.get(EncryptionService), fake);
    expect((await sync.run(quick, { audit: false })).ok).toBe(true);
    const started = await staff.post(`/admin/suppliers/${quick}/quick-add`, {
      scope: 'groups',
      groups: [{ type: 'SERVER', remoteGroup: 'Sample accounts' }],
    });
    expect(started.status).toBe(202);
    expect(await t.app.get(QuickAddRunner, { strict: false }).run(started.body.id)).toBe('succeeded');
    const [link] = await world.db
      .select({ serviceId: s.serviceSupplierLinks.serviceId })
      .from(s.serviceSupplierLinks)
      .innerJoin(s.supplierServices, eq(s.supplierServices.id, s.serviceSupplierLinks.supplierServiceId))
      .where(eq(s.supplierServices.supplierId, quick));
    expect(await requiredOf(link!.serviceId)).toEqual([
      ['account_email', true],
      ['region', true],
      ['note', false],
    ]);
  });

  it('a sync makes them required on a service made before (field map too), never lowers one, writes one audit row; a second run changes nothing', async () => {
    const { supplierId, serviceId } = await serverMadeBefore(
      [
        { key: 'account_email', supplierKey: 'Account Email' },
        { key: 'area', supplierKey: 'Area' },
        { key: 'note', supplierKey: 'Note', required: true },
        { key: 'staff_ref', supplierKey: 'Staff Ref' },
      ],
      { area: 'region' },
    );
    expect(await sync.run(supplierId, { audit: true })).toMatchObject({ ok: true, result: { adopted: 1 } });
    expect(await requiredOf(serviceId)).toEqual([
      ['account_email', true],
      ['area', true],
      ['note', true],
      ['staff_ref', false],
    ]);
    const [field] = await fieldsOf(serviceId);
    expect(field).toMatchObject({ label: 'account_email', fieldType: 'text', regex: '', sort: 0 });
    const audits = await auditsOf(serviceId, "made the supplier's required fields required");
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      actorType: 'system',
      entityType: 'service',
      before: { optionalFields: ['account_email', 'area'] },
      after: { requiredFields: ['account_email', 'area'] },
    });

    expect(await sync.run(supplierId, { audit: false })).toMatchObject({ ok: true, result: { adopted: 0 } });
    expect(await auditsOf(serviceId, "made the supplier's required fields required")).toHaveLength(1);
  });

  it('leaves a service with two active links, and an archived one, alone', async () => {
    const { db } = world;
    const two = await serverMadeBefore([{ key: 'account_email', supplierKey: 'Account Email' }]);
    const other = await insertFakeSupplier(db, t.app.get(EncryptionService), fake);
    await linkService(db, two.serviceId, other, { remoteId: '7201', priority: 2 });
    expect(await sync.run(two.supplierId, { audit: false })).toMatchObject({ ok: true, result: { adopted: 0 } });
    expect(await requiredOf(two.serviceId)).toEqual([['account_email', false]]);

    const archived = await serverMadeBefore([{ key: 'account_email', supplierKey: 'Account Email' }]);
    await db
      .update(s.services)
      .set({ status: 'disabled', archivedAt: new Date('2026-11-01T00:00:00.000Z') })
      .where(eq(s.services.id, archived.serviceId));
    expect(await sync.run(archived.supplierId, { audit: false })).toMatchObject({ ok: true, result: { adopted: 0 } });
    expect(await requiredOf(archived.serviceId)).toEqual([['account_email', false]]);
  });

  it('counts a service once when the sync adopts its main box and raises its fields', async () => {
    const { db } = world;
    fake.services = [{ ...ECID_SERVICE, requiresCustom: [fusionField('Model')] }];
    const supplierId = await insertFakeSupplier(db, t.app.get(EncryptionService), fake);
    const serviceId = await insertService(db, await insertCategory(db, { name: 'Counted Once' }), {
      cost: '3.0000',
      effectiveCost: '3.0000',
      basePrice: '4.0000',
    });
    await db.insert(s.serviceFields).values({ serviceId, key: 'model', label: 'Model', supplierKey: 'Model' });
    await linkService(db, serviceId, supplierId, { remoteId: '9101', credit: '3.0000' });
    expect(await sync.run(supplierId, { audit: false })).toMatchObject({ ok: true, result: { adopted: 1 } });
    expect((await serviceOf(serviceId)).type).toBe('server');
    expect(await requiredOf(serviceId)).toEqual([
      ['ecid', true],
      ['model', true],
    ]);
    expect(await auditsOf(serviceId, "adopted the supplier's input")).toHaveLength(1);
    expect(await auditsOf(serviceId, "made the supplier's required fields required")).toHaveLength(1);
  });

  it('refuses a portal order that leaves out a field made required, and holds no money', async () => {
    const { supplierId, serviceId } = await serverMadeBefore([
      { key: 'account_email', supplierKey: 'Account Email' },
      { key: 'region', supplierKey: 'Region' },
    ]);
    expect(await sync.run(supplierId, { audit: false })).toMatchObject({ ok: true, result: { adopted: 1 } });
    const before = await walletOf(world.db, world.merchant.id);
    const res = await (
      await portalFor(t, world.merchant.id)
    ).post('/client/orders', {
      serviceId,
      inputs: { account_email: 'buyer@mail.example' },
    });
    expect(res.statusCode).toBe(422);
    expect(json(res).errors).toEqual([expect.objectContaining({ field: 'inputs.region', code: 'required' })]);
    expect(await walletOf(world.db, world.merchant.id)).toEqual(before);
    expect(await world.db.select().from(s.orders).where(eq(s.orders.serviceId, serviceId))).toHaveLength(0);
  });
});

// Feature 33 (decision 042) on the storefront: a supplier service whose main box asks for an ECID is imported as a server service with
// that box first; a shop order for it, once paid, sends the ECID as the classic XML string's `IMEI` and nothing of it in CUSTOMFIELD.
// A checkout opened while a service took an IMEI and paid after the sync adopted the supplier's box keeps the buyer's value (card webhook
// and store balance). Decision 071: a plain IMEI supplier service is imported with the IMEI field, which the shop's page lists flagged and
// whose value a paid order sends as `IMEI`. Real Postgres and Redis, a stand-in card gateway and the fake Dhru supplier; the service
// entries are made-up samples.
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { eq } from 'drizzle-orm';
import { EncryptionService } from '@src/infra/crypto';
import { schema as s } from '@src/infra/db';
import { SupplierDispatch, SupplierSync } from '@src/modules/suppliers';
import { adminWith } from '../../support/admin-api';
import { type TestApp, createTestApp } from '../../support/app';
import { clearIdentityCaches } from '../../support/auth';
import { GatewayTestModule } from '../../support/billing';
import {
  type B2cWorld,
  B2cGateway,
  b2cWorld,
  hook,
  json,
  openCheckout,
  pay,
  paidOrder,
  storefrontEvent,
} from '../../support/b2c';
import {
  fundCustomer,
  insertWalletTemplates,
  openSignedInCheckout,
  payFromBalance,
  walletSettings,
} from '../../support/customer-wallet';
import { seedDefaultTemplates } from '../../support/notifications';
import { freshClientIp } from '../../support/pipeline-routes';
import { STORE_ORIGIN, StoreClient, makeCustomer } from '../../support/store';
import { TestClock } from '../../support/clock';
import { closeTestDb, resetDb, testDb } from '../../support/db';
import { orderRow } from '../../support/orders';
import { APPLE_IMEI, insertListing, insertRetailPrice } from '../../support/storefront';
import { insertCategory, insertService } from '../../support/catalog';
import { FakeDhruSupplier, SupplierTestModule, insertFakeSupplier, linkService } from '../../support/suppliers';

const gateway = new B2cGateway();
const supplier = new FakeDhruSupplier();
const clock = new TestClock('2026-11-17T12:00:00.000Z');
let t: TestApp;
let world: B2cWorld;

beforeAll(async () => {
  t = await createTestApp({
    clock,
    imports: [GatewayTestModule, SupplierTestModule],
    env: { SHOP_ORIGINS: STORE_ORIGIN },
  });
  await resetDb();
  await clearIdentityCaches(t);
  const { db } = await testDb();
  world = await b2cWorld(t, db, gateway);
  await walletSettings(t, db);
  await seedDefaultTemplates(db);
  await insertWalletTemplates(db);
});
afterAll(async () => {
  await gateway.stop();
  await supplier.stop();
  await resetDb();
  await clearIdentityCaches(t);
  await t.close();
  await closeTestDb();
});

describe("a shop order for a service whose supplier's main box is an ECID", () => {
  it('is drawn and checked as a server service, and its paid order sends the ECID as <IMEI>', async () => {
    supplier.services = [
      {
        id: '9201',
        group: 'Sample shop reports',
        type: 'IMEI',
        name: 'Sample shop ECID report',
        credit: '3.0000',
        time: '1 hour',
        custom: { allow: '1', customname: 'ECID', customlen: '13', maxlength: '16' },
      },
    ];
    supplier.accepts = 'dhru_xml';
    const supplierId = await insertFakeSupplier(world.db, t.app.get(EncryptionService, { strict: false }), supplier);
    expect((await t.app.get(SupplierSync, { strict: false }).run(supplierId, { audit: false })).ok).toBe(true);
    const [remote] = await world.db
      .select()
      .from(s.supplierServices)
      .where(eq(s.supplierServices.supplierId, supplierId));
    const staff = await adminWith(t, ['suppliers:*', 'catalog:*']);
    expect(
      (await staff.post(`/admin/suppliers/${supplierId}/import`, { supplierServiceIds: [remote!.id] })).status,
    ).toBe(200);
    const [link] = await world.db
      .select()
      .from(s.serviceSupplierLinks)
      .where(eq(s.serviceSupplierLinks.supplierServiceId, remote!.id));
    const serviceId = link!.serviceId;
    await insertRetailPrice(world.db, serviceId, world.groups.retail, '9.9900');
    await insertListing(world.db, serviceId, {
      slug: 'sample-shop-ecid-report',
      publicTitle: 'Sample shop ECID report',
    });

    const paid = await paidOrder(t, clock, world, {
      serviceId,
      email: 'buyer@mail.example',
      inputs: { ecid: '0001A2B3C4D5E6' },
    });
    expect(await orderRow(world.db, paid.orderId)).toMatchObject({
      type: 'server',
      imei: '0001A2B3C4D5E6',
      dispatchState: 'pending',
    });
    expect(
      await t.app.get(SupplierDispatch, { strict: false }).run(paid.orderId, { lastAttempt: false }),
    ).toMatchObject({ status: 'sent' });
    const calls = supplier.callsOf('placeimeiorder');
    expect(calls).toHaveLength(1);
    expect(calls[0]!.rawParameters).toBe(
      '<PARAMETERS><ID>9201</ID><IMEI>0001A2B3C4D5E6</IMEI><QNT>1</QNT></PARAMETERS>',
    );
    expect(calls[0]!.parameters.CUSTOMFIELD).toBeUndefined();
  });
});

describe('a plain IMEI supplier service in the shop (decision 071)', () => {
  it("is imported with the IMEI field, which the shop's page lists flagged; the IMEI typed into it is sent as <IMEI>", async () => {
    supplier.reset();
    supplier.services = [
      {
        id: '9501',
        group: 'Sample shop checks',
        type: 'IMEI',
        name: 'Sample shop IMEI check',
        credit: '2.0000',
        time: '1 hour',
        requiresCustom: [
          { type: 'serviceimei', fieldname: 'Model', fieldtype: 'text', description: 'Model', required: '' },
        ],
      },
    ];
    supplier.accepts = 'dhru_xml';
    const supplierId = await insertFakeSupplier(world.db, t.app.get(EncryptionService, { strict: false }), supplier);
    expect((await t.app.get(SupplierSync, { strict: false }).run(supplierId, { audit: false })).ok).toBe(true);
    const [remote] = await world.db
      .select()
      .from(s.supplierServices)
      .where(eq(s.supplierServices.supplierId, supplierId));
    const staff = await adminWith(t, ['suppliers:*', 'catalog:*']);
    expect(
      (await staff.post(`/admin/suppliers/${supplierId}/import`, { supplierServiceIds: [remote!.id] })).status,
    ).toBe(200);
    const [link] = await world.db
      .select()
      .from(s.serviceSupplierLinks)
      .where(eq(s.serviceSupplierLinks.supplierServiceId, remote!.id));
    const serviceId = link!.serviceId;
    await insertRetailPrice(world.db, serviceId, world.groups.retail, '9.9900');
    await insertListing(world.db, serviceId, { slug: 'sample-shop-imei-check', publicTitle: 'Sample shop IMEI check' });

    const page = await t.app.inject({ method: 'GET', url: '/store/v1/services/sample-shop-imei-check' });
    expect(page.statusCode).toBe(200);
    expect(json(page).fields).toEqual([
      { key: 'imei', label: 'IMEI', fieldType: 'imei', options: [], required: true, isMainInput: true },
      { key: 'model', label: 'Model', fieldType: 'text', options: [], required: false, isMainInput: false },
    ]);

    // The new shop sends only the fields (decision 070): the IMEI under the main-input field's key, no `imei`.
    const paid = await paidOrder(t, clock, world, {
      serviceId,
      email: 'plain@mail.example',
      imei: null,
      inputs: { imei: APPLE_IMEI, model: 'Sample Z' },
    });
    expect(await orderRow(world.db, paid.orderId)).toMatchObject({
      type: 'imei',
      imei: APPLE_IMEI,
      inputs: { imei: APPLE_IMEI, model: 'Sample Z' },
    });
    expect(
      await t.app.get(SupplierDispatch, { strict: false }).run(paid.orderId, { lastAttempt: false }),
    ).toMatchObject({ status: 'sent' });
    const calls = supplier.callsOf('placeimeiorder');
    expect(calls).toHaveLength(1);
    expect(calls[0]!.parameters).toEqual({ ID: '9501', IMEI: APPLE_IMEI, QNT: 1, CUSTOMFIELD: { Model: 'Sample Z' } });

    // Decision 073: staff may make the main input a text field (an ECID): the shop takes letters and the supplier gets them as IMEI.
    const saved = await staff.put(`/admin/services/${serviceId}/fields`, {
      fields: [
        {
          key: 'imei',
          name: 'ECID',
          label: 'ECID',
          fieldType: 'text',
          required: true,
          options: [],
          regex: '',
          isMainInput: true,
        },
        { key: 'model', name: 'Model', fieldType: 'text', required: false, options: [], regex: '' },
      ],
    });
    expect(saved.status).toBe(200);
    const ecid = await paidOrder(t, clock, world, {
      serviceId,
      email: 'ecid@mail.example',
      imei: null,
      inputs: { imei: 'ABCDEF0123456' },
    });
    expect(await orderRow(world.db, ecid.orderId)).toMatchObject({
      type: 'imei',
      imei: 'ABCDEF0123456',
      inputs: { imei: 'ABCDEF0123456' },
    });
    expect(
      await t.app.get(SupplierDispatch, { strict: false }).run(ecid.orderId, { lastAttempt: false }),
    ).toMatchObject({ status: 'sent' });
    expect(supplier.callsOf('placeimeiorder')[1]!.parameters).toEqual({ ID: '9501', IMEI: 'ABCDEF0123456', QNT: 1 });
  });
});

describe("a checkout opened while the service took an IMEI and paid after the sync adopted the supplier's box", () => {
  let counter = 0;

  /**
   * An IMEI service made before decision 042, linked to a supplier service whose box is an ECID, listed in the shop; with `imeiField`,
   * it has the IMEI field migration 0071 gives such a service (decision 071).
   */
  async function imeiServiceBeforeAdoption(options: { imeiField?: boolean } = {}) {
    counter += 1;
    const remoteId = `93${counter}0`;
    supplier.reset();
    supplier.services = [
      {
        id: remoteId,
        group: 'Sample shop reports',
        type: 'IMEI',
        name: `Sample old report ${counter}`,
        credit: '3.0000',
        time: '1 hour',
        custom: { allow: '1', customname: 'Serial Or IMEI', customlen: '8', maxlength: '20' },
      },
    ];
    const supplierId = await insertFakeSupplier(world.db, t.app.get(EncryptionService, { strict: false }), supplier);
    const serviceId = await insertService(
      world.db,
      await insertCategory(world.db, { name: `Old reports ${counter}` }),
      {
        name: `Old report ${counter}`,
        cost: '3.0000',
        effectiveCost: '3.0000',
        basePrice: '4.0000',
      },
    );
    await linkService(world.db, serviceId, supplierId, { remoteId, credit: '3.0000' });
    if (options.imeiField) {
      await world.db.insert(s.serviceFields).values({
        serviceId,
        key: 'imei',
        label: 'IMEI',
        supplierKey: 'IMEI',
        required: true,
        isMainInput: true,
      });
    }
    await insertRetailPrice(world.db, serviceId, world.groups.retail, '9.9900');
    await insertListing(world.db, serviceId, {
      slug: `sample-old-report-${counter}`,
      publicTitle: `Old report ${counter}`,
    });
    return { supplierId, serviceId };
  }

  async function adopt(supplierId: number, serviceId: number) {
    const synced = await t.app.get(SupplierSync, { strict: false }).run(supplierId, { audit: false });
    expect(synced).toMatchObject({ ok: true, result: { adopted: 1 } });
    const [service] = await world.db.select().from(s.services).where(eq(s.services.id, serviceId));
    expect(service!.type).toBe('server');
  }

  async function expectSentAsImei(orderId: number, boxKey = 'serial_or_imei') {
    expect(await orderRow(world.db, orderId)).toMatchObject({
      type: 'server',
      imei: APPLE_IMEI,
      inputs: { [boxKey]: APPLE_IMEI },
    });
    expect(await t.app.get(SupplierDispatch, { strict: false }).run(orderId, { lastAttempt: false })).toMatchObject({
      status: 'sent',
    });
    const [call] = supplier.callsOf('placeimeiorder');
    expect(call!.rawParameters).toBe(
      `<PARAMETERS><ID>${supplier.services[0]!.id}</ID><IMEI>${APPLE_IMEI}</IMEI><QNT>1</QNT></PARAMETERS>`,
    );
  }

  it('paid by card (the gateway webhook): the order is a server order whose input is the typed value, sent as <IMEI>', async () => {
    const { supplierId, serviceId } = await imeiServiceBeforeAdoption();
    const { token } = await openCheckout(t, world, { serviceId, email: 'early@mail.example' });
    await adopt(supplierId, serviceId);

    const started = await pay(t, token, undefined);
    expect(started.statusCode).toBe(201);
    const { payment } = json(started);
    const body = storefrontEvent(`evt_adopted_${counter}`, payment.reference, {
      amount: payment.amount,
      currency: payment.currency,
      intent: `pi_adopted_${counter}`,
    });
    expect((await hook(t, clock, 'payments', world.gateway.code, body)).statusCode).toBe(200);
    const [order] = await world.db.select().from(s.orders).where(eq(s.orders.serviceId, serviceId));
    await expectSentAsImei(order!.id);
  });

  it('with the IMEI typed into its IMEI field (decision 071): that field became the box, so the typed value is sent as <IMEI>', async () => {
    const { supplierId, serviceId } = await imeiServiceBeforeAdoption({ imeiField: true });
    const { token } = await openCheckout(t, world, {
      serviceId,
      email: 'field@mail.example',
      imei: null,
      inputs: { imei: APPLE_IMEI },
    });
    await adopt(supplierId, serviceId);
    const box = await world.db.select().from(s.serviceFields).where(eq(s.serviceFields.serviceId, serviceId));
    expect(box.map((field) => [field.key, field.supplierKey, field.isMainInput])).toEqual([
      ['imei', 'Serial Or IMEI', true],
    ]);

    const started = await pay(t, token, undefined);
    expect(started.statusCode).toBe(201);
    const { payment } = json(started);
    const body = storefrontEvent(`evt_adopted_field_${counter}`, payment.reference, {
      amount: payment.amount,
      currency: payment.currency,
      intent: `pi_adopted_field_${counter}`,
    });
    expect((await hook(t, clock, 'payments', world.gateway.code, body)).statusCode).toBe(200);
    const [order] = await world.db.select().from(s.orders).where(eq(s.orders.serviceId, serviceId));
    await expectSentAsImei(order!.id, 'imei');
  });

  it('paid from the store balance: the same', async () => {
    const { supplierId, serviceId } = await imeiServiceBeforeAdoption();
    const customer = await makeCustomer(t, { name: 'Early Buyer' });
    const client = new StoreClient(t, freshClientIp());
    expect((await client.login(customer.email)).statusCode).toBe(200);
    await fundCustomer(world.db, customer.id, '50');
    const { token } = await openSignedInCheckout(client, world, customer.email, { serviceId });
    await adopt(supplierId, serviceId);

    const paid = await payFromBalance(client, token, 'adopted-balance-1');
    expect(paid.statusCode).toBe(201);
    await expectSentAsImei(json(paid).order.id);
  });
});

describe('a field the supplier requires, made required by the sync', () => {
  it('is required by the shop checkout too: a checkout without it is refused with 422 on inputs.<key>', async () => {
    supplier.reset();
    supplier.services = [
      {
        id: '9401',
        group: 'Sample shop accounts',
        type: 'SERVER',
        name: 'Sample shop renewal',
        credit: '3.0000',
        time: '1 hour',
        requiresCustom: [
          { type: 'serviceimei', fieldname: 'Account Email', fieldtype: 'text', required: 'on', adminonly: '' },
        ],
      },
    ];
    const supplierId = await insertFakeSupplier(world.db, t.app.get(EncryptionService, { strict: false }), supplier);
    const serviceId = await insertService(world.db, await insertCategory(world.db, { type: 'server' }), {
      type: 'server',
      cost: '3.0000',
      effectiveCost: '3.0000',
      basePrice: '4.0000',
    });
    await world.db.insert(s.serviceFields).values({
      serviceId,
      key: 'account_email',
      label: 'Account email',
      supplierKey: 'Account Email',
      required: false,
    });
    await linkService(world.db, serviceId, supplierId, { remoteId: '9401', type: 'SERVER', credit: '3.0000' });
    await insertRetailPrice(world.db, serviceId, world.groups.retail, '9.9900');
    await insertListing(world.db, serviceId, { slug: 'sample-shop-renewal', publicTitle: 'Sample shop renewal' });

    expect(await t.app.get(SupplierSync, { strict: false }).run(supplierId, { audit: false })).toMatchObject({
      ok: true,
      result: { adopted: 1 },
    });
    const refused = await openCheckout(t, world, { serviceId, email: 'late@mail.example' }).then(
      () => 'opened',
      (error: unknown) => (error instanceof Error ? error.message : String(error)),
    );
    expect(refused).toMatch(/answered 422.*inputs\.account_email.*required/);
    const { token } = await openCheckout(t, world, {
      serviceId,
      email: 'late@mail.example',
      inputs: { account_email: 'owner@mail.example' },
    });
    expect(token).toEqual(expect.any(String));
  });
});

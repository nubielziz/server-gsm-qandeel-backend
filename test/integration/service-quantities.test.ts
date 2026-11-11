// Integration tests of the quantity rule across the surfaces (feature 25): what staff save with PATCH /admin/services/:id is what the
// merchant portal, REST v1, Dhru, the store page, placement and the store checkout read and enforce on the very next request.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { eq } from 'drizzle-orm';
import { schema as s } from '../../src/infra/db';
import { MaintenanceService } from '../../src/modules/platform';
import { type AdminApi, adminWith } from '../support/admin-api';
import { type TestApp, createTestApp } from '../support/app';
import { clearIdentityCaches } from '../support/auth';
import { TestClock } from '../support/clock';
import { closeTestDb, resetDb, testDb } from '../support/db';
import {
  body as machineBody,
  clearApiKeyCaches,
  credentialsFor,
  dhruClient,
  v1Client,
} from '../support/machine-orders';
import { IMEIS, type OrdersWorld, json, ordersWorld, orderRow, portalFor, walletOf } from '../support/orders';
import { freshClientIp } from '../support/pipeline-routes';
import { APPLE_IMEI, TURNSTILE_HEADERS, storefrontWorld } from '../support/storefront';

const clock = new TestClock('2026-11-07T12:00:00.000Z');
let t: TestApp;
let admin: AdminApi;

beforeAll(async () => {
  t = await createTestApp({ clock });
});
afterAll(async () => {
  await resetDb();
  await clearIdentityCaches(t);
  await t.close();
  await closeTestDb();
});

describe('a quantity rule saved by staff reaches the merchant surfaces and placement', () => {
  let world: OrdersWorld;

  beforeEach(async () => {
    clock.set('2026-11-07T12:00:00.000Z');
    await resetDb();
    await clearIdentityCaches(t);
    await clearApiKeyCaches(t);
    await t.app.get(MaintenanceService).invalidate();
    admin = await adminWith(t, ['catalog:*']);
    world = await ordersWorld((await testDb()).db);
  });

  it('shows 1..5 on the portal, REST v1 and Dhru on the next request, and the store page', async () => {
    const { db, merchant, auto } = world;
    const patched = await admin.patch(`/admin/services/${auto.serviceId}`, { minQty: 1, maxQty: 5 });
    expect(patched.status).toBe(200);

    const portal = await portalFor(t, merchant.id);
    const row = json(await portal.get(`/client/services/${auto.serviceId}`));
    expect(row).toMatchObject({ minQty: 1, maxQty: 5, qtyOptions: [] });
    const listed = json(await portal.get('/client/services')).find(
      (entry: { id: number }) => entry.id === auto.serviceId,
    );
    expect(listed).toMatchObject({ minQty: 1, maxQty: 5, qtyOptions: [] });

    const creds = await credentialsFor(t, db, merchant.id);
    const v1 = v1Client(t, creds.key);
    expect(machineBody(await v1.get(`/v1/services/${auto.serviceId}`))).toMatchObject({
      minQty: 1,
      maxQty: 5,
      qtyOptions: [],
    });

    const dhru = dhruClient(t, creds);
    const entry = (await dhru.call('imeiservicelist')).SUCCESS[0].LIST['Carrier unlock'].SERVICES[
      String(auto.serviceId)
    ];
    expect(entry).toMatchObject({ QNT: '1', MINQNT: '1', MAXQNT: '5' });
  });

  it('accepts a quantity inside the range with a total of unit x quantity and one hold, and refuses one outside it', async () => {
    const { db, merchant, auto } = world;
    await admin.patch(`/admin/services/${auto.serviceId}`, { minQty: 1, maxQty: 5 });
    const portal = await portalFor(t, merchant.id);

    const ok = await portal.post('/client/orders', { serviceId: auto.serviceId, imei: IMEIS[0], quantity: 3 });
    expect(ok.statusCode).toBe(201);
    const [placed] = json(ok).orders;
    expect(placed).toMatchObject({ quantity: 3, unitPrice: '17.2800', totalPrice: '51.8400' });
    expect(await walletOf(db, merchant.id)).toEqual({ wallet: '48.1600', hold: '51.8400' });
    expect((await orderRow(db, placed.id)).totalPrice).toBe('51.8400');
    expect(await db.select().from(s.orders)).toHaveLength(1);

    const tooMany = await portal.post('/client/orders', { serviceId: auto.serviceId, imei: IMEIS[1], quantity: 6 });
    expect(tooMany.statusCode).toBe(422);
    expect(json(tooMany).errors).toEqual([expect.objectContaining({ field: 'quantity', code: 'invalid_quantity' })]);
    expect(await walletOf(db, merchant.id)).toEqual({ wallet: '48.1600', hold: '51.8400' });
  });

  it('with packs: no quantity orders the smallest pack, a quantity that is not a pack names the packs', async () => {
    const { db, merchant, auto } = world;
    const patched = await admin.patch(`/admin/services/${auto.serviceId}`, { qtyOptions: [10, 5] });
    expect(patched.body).toMatchObject({ minQty: 5, maxQty: 10, qtyOptions: [5, 10] });
    const portal = await portalFor(t, merchant.id);

    const defaulted = await portal.post('/client/orders', { serviceId: auto.serviceId, imei: IMEIS[0] });
    expect(defaulted.statusCode).toBe(201);
    expect(json(defaulted).orders[0]).toMatchObject({ quantity: 5, totalPrice: '86.4000' });
    expect(await walletOf(db, merchant.id)).toEqual({ wallet: '13.6000', hold: '86.4000' });

    const seven = await portal.post('/client/orders', { serviceId: auto.serviceId, imei: IMEIS[1], quantity: 7 });
    expect(seven.statusCode).toBe(422);
    expect(json(seven).errors[0]).toMatchObject({ field: 'quantity', code: 'invalid_quantity' });
    expect(json(seven).errors[0].message).toContain('5, 10');
  });
});

describe('a quantity rule saved by staff reaches the store', () => {
  beforeEach(async () => {
    clock.set('2026-11-07T12:00:00.000Z');
    await resetDb();
    await clearIdentityCaches(t);
    admin = await adminWith(t, ['catalog:*']);
  });

  it('shows the rule on the store page and prices a checkout for a pack as unit x pack', async () => {
    const world = await storefrontWorld((await testDb()).db);
    const unit = await t.app.inject({
      method: 'GET',
      url: `/store/v1/services/${world.icloud.slug}?buyerCountry=GB&currency=GBP`,
    });
    expect(unit.json().quantity).toEqual({ min: 1, max: 1, options: [] });

    const patched = await admin.patch(`/admin/services/${world.icloud.serviceId}`, { qtyOptions: [5, 2] });
    expect(patched.status).toBe(200);
    const page = await t.app.inject({
      method: 'GET',
      url: `/store/v1/services/${world.icloud.slug}?buyerCountry=GB&currency=GBP`,
    });
    expect(page.json().quantity).toEqual({ min: 2, max: 5, options: [2, 5] });

    const open = (quantity?: number) =>
      t.app.inject({
        method: 'POST',
        url: '/store/v1/checkout-sessions',
        headers: { 'user-agent': 'Mozilla/5.0 (test)', ...TURNSTILE_HEADERS },
        remoteAddress: freshClientIp(),
        payload: {
          serviceId: world.icloud.serviceId,
          email: 'sam@mail.example',
          country: 'GB',
          currency: 'GBP',
          imei: APPLE_IMEI,
          ...(quantity === undefined ? {} : { quantity }),
        } as never,
      });
    // The retail price of the iCloud check is 3.99 per unit; the net of 5 is 5 x 3.99 = 19.95 (tax is worked out on that net).
    const five = await open(5);
    expect(five.statusCode).toBe(201);
    expect(five.json()).toMatchObject({ quantity: 5, amounts: { usd: { net: '19.9500' } } });
    // A missing quantity is the smallest pack; a quantity that is not a pack is refused.
    const defaulted = await open();
    expect(defaulted.json()).toMatchObject({ quantity: 2, amounts: { usd: { net: '7.9800' } } });
    const three = await open(3);
    expect(three.statusCode).toBe(422);
    expect(three.json().errors[0]).toMatchObject({ field: 'quantity', code: 'invalid_quantity' });
    const { db } = await testDb();
    expect((await db.select().from(s.services).where(eq(s.services.id, world.icloud.serviceId)))[0]).toMatchObject({
      minQty: 2,
      maxQty: 5,
      qtyOptions: [2, 5],
    });
  });
});

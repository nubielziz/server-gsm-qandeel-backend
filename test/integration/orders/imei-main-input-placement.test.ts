// Decision 070: the order forms draw only the custom fields, so the IMEI of an IMEI service is typed into the field flagged as the main
// input (decision 065) and sent under its key in `inputs`. Placement reads it there when no `imei` is sent, checks it as an IMEI (spaces and
// dashes removed, 15 digits, Luhn) and reports every problem about it on `inputs.<key>`; the order ends exactly like one sent as `imei`
// (`orders.imei`, the stored inputs, the duplicate rule). `imei` still works and wins when both are sent; Dhru reads only its `IMEI`
// parameter. Real application, Postgres and Redis.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { eq } from 'drizzle-orm';
import { schema as s } from '@src/infra/db';
import { type TestApp, createTestApp } from '../../support/app';
import { clearIdentityCaches } from '../../support/auth';
import { TestClock } from '../../support/clock';
import { closeTestDb, resetDb, testDb } from '../../support/db';
import { type MachineCredentials, clearApiKeyCaches, credentialsFor, dhruClient } from '../../support/machine-orders';
import { IMEIS, json, orderRow, ordersWorld, portalFor, walletOf, type OrdersWorld } from '../../support/orders';

const clock = new TestClock();
let t: TestApp;
let world: OrdersWorld;
let creds: MachineCredentials;

/** The pattern of the main-input field in the pattern case: 15 digits that start with 35. */
const PATTERN = '^35[0-9]{13}$';
/** A valid IMEI the pattern accepts. */
const ACCEPTED = IMEIS[0];
/** Another valid IMEI the pattern accepts. */
const ACCEPTED_TOO = IMEIS[1];
/** A valid IMEI the pattern refuses (it starts with 86). */
const REFUSED = IMEIS[4];
/** {@link ACCEPTED} with a wrong check digit. */
const BAD_CHECK_DIGIT = '352905112490862';

beforeAll(async () => {
  t = await createTestApp({ clock });
});
afterAll(async () => {
  await resetDb();
  await clearIdentityCaches(t);
  await t.close();
  await closeTestDb();
});
beforeEach(async () => {
  clock.reset();
  await resetDb();
  await clearIdentityCaches(t);
  await clearApiKeyCaches(t);
  const { db } = await testDb();
  world = await ordersWorld(db);
  creds = await credentialsFor(t, db, world.merchant.id);
  // The key and the Name say nothing: the flag makes the field the IMEI's box.
  await world.db.insert(s.serviceFields).values({
    serviceId: world.auto.serviceId,
    key: 'serial',
    label: 'Serial',
    supplierKey: 'Serial number',
    isMainInput: true,
    required: true,
    sort: 1,
  });
});

/** Asserts nothing was placed and nothing is held for the merchant. */
async function expectNothingPlaced(): Promise<void> {
  expect(await world.db.select().from(s.orders)).toHaveLength(0);
  expect(await walletOf(world.db, world.merchant.id)).toEqual({ wallet: '100.0000', hold: '0.0000' });
}

describe('POST /client/orders: the IMEI typed into the main-input field (decision 070)', () => {
  it('is placed like an IMEI sent as imei: normalised into orders.imei and under the field key', async () => {
    const portal = await portalFor(t, world.merchant.id);
    const placed = await portal.post('/client/orders', {
      serviceId: world.auto.serviceId,
      inputs: { serial: '3529 0511-2490861' },
    });
    expect(placed.statusCode).toBe(201);
    expect(json(placed).orders[0].imei).toBe(ACCEPTED);
    const order = await orderRow(world.db, json(placed).orders[0].id);
    expect(order.imei).toBe(ACCEPTED);
    expect(order.inputs).toEqual({ serial: ACCEPTED });
  });

  it('refuses a wrong check digit with INVALID_IMEI on inputs.<key>', async () => {
    const portal = await portalFor(t, world.merchant.id);
    const bad = await portal.post('/client/orders', {
      serviceId: world.auto.serviceId,
      inputs: { serial: BAD_CHECK_DIGIT },
    });
    expect(bad.statusCode).toBe(422);
    expect(json(bad)).toMatchObject({ code: 'INVALID_IMEI' });
    expect(json(bad).errors).toEqual([expect.objectContaining({ field: 'inputs.serial', code: 'invalid_imei' })]);
    const short = await portal.post('/client/orders', {
      serviceId: world.auto.serviceId,
      inputs: { serial: '35290511' },
    });
    expect(json(short).code).toBe('INVALID_IMEI');
    expect(json(short).errors).toEqual([expect.objectContaining({ field: 'inputs.serial', code: 'invalid_imei' })]);
    await expectNothingPlaced();
  });

  it('asks for a missing IMEI once, on inputs.<key>, also when the field itself is optional', async () => {
    const portal = await portalFor(t, world.merchant.id);
    for (const body of [{}, { inputs: { serial: '   ' } }]) {
      const missing = await portal.post('/client/orders', { serviceId: world.auto.serviceId, ...body });
      expect(missing.statusCode).toBe(422);
      expect(json(missing).code).toBe('VALIDATION_FAILED');
      expect(json(missing).errors).toEqual([
        expect.objectContaining({ field: 'inputs.serial', code: 'required', message: 'Enter the IMEI.' }),
      ]);
    }
    await world.db
      .update(s.serviceFields)
      .set({ required: false })
      .where(eq(s.serviceFields.serviceId, world.auto.serviceId));
    const optional = await portal.post('/client/orders', { serviceId: world.auto.serviceId });
    expect(json(optional).errors).toEqual([expect.objectContaining({ field: 'inputs.serial', code: 'required' })]);
    await expectNothingPlaced();
  });

  it("judges the field's pattern on the IMEI typed there, on inputs.<key>", async () => {
    await world.db
      .update(s.serviceFields)
      .set({ regex: PATTERN })
      .where(eq(s.serviceFields.serviceId, world.auto.serviceId));
    const portal = await portalFor(t, world.merchant.id);
    const refused = await portal.post('/client/orders', {
      serviceId: world.auto.serviceId,
      inputs: { serial: REFUSED },
    });
    expect(refused.statusCode).toBe(422);
    expect(json(refused).errors).toEqual([expect.objectContaining({ field: 'inputs.serial', code: 'invalid_format' })]);
    await expectNothingPlaced();
    const placed = await portal.post('/client/orders', {
      serviceId: world.auto.serviceId,
      inputs: { serial: ACCEPTED },
    });
    expect(placed.statusCode).toBe(201);
  });

  it('keeps imei working, and imei wins when both are sent, with its problems on imei', async () => {
    const portal = await portalFor(t, world.merchant.id);
    const alone = await portal.post('/client/orders', { serviceId: world.auto.serviceId, imei: ACCEPTED });
    expect(alone.statusCode).toBe(201);
    const bare = await orderRow(world.db, json(alone).orders[0].id);
    expect(bare.imei).toBe(ACCEPTED);
    expect(bare.inputs).toEqual({});

    const both = await portal.post('/client/orders', {
      serviceId: world.auto.serviceId,
      imei: ACCEPTED_TOO,
      inputs: { serial: 'not an imei' },
    });
    expect(both.statusCode).toBe(201);
    const order = await orderRow(world.db, json(both).orders[0].id);
    expect(order.imei).toBe(ACCEPTED_TOO);
    expect(order.inputs).toEqual({ serial: ACCEPTED_TOO });

    const badImei = await portal.post('/client/orders', {
      serviceId: world.auto.serviceId,
      imei: BAD_CHECK_DIGIT,
      inputs: { serial: IMEIS[2] },
    });
    expect(json(badImei).code).toBe('INVALID_IMEI');
    expect(json(badImei).errors).toEqual([expect.objectContaining({ field: 'imei', code: 'invalid_imei' })]);
  });

  it('keeps the bulk list working: each IMEI of imeis is its own order', async () => {
    const portal = await portalFor(t, world.merchant.id);
    const bulk = await portal.post('/client/orders', {
      serviceId: world.auto.serviceId,
      imeis: [ACCEPTED, ACCEPTED_TOO],
    });
    expect(bulk.statusCode).toBe(201);
    expect(json(bulk).orders.map((order: { imei: string }) => order.imei)).toEqual([ACCEPTED, ACCEPTED_TOO]);
  });

  it("stores each bulk IMEI under the field's key when the key is sent too, and keeps the problems on imeis.N", async () => {
    const portal = await portalFor(t, world.merchant.id);
    const bulk = await portal.post('/client/orders', {
      serviceId: world.auto.serviceId,
      imeis: [ACCEPTED, '3546 0711-1076240'],
      inputs: { serial: 'not an imei' },
    });
    expect(bulk.statusCode).toBe(201);
    const ids = json(bulk).orders.map((order: { id: number }) => order.id);
    const rows = await Promise.all(ids.map((id: number) => orderRow(world.db, id)));
    expect(rows.map((row) => [row.imei, row.inputs])).toEqual([
      [ACCEPTED, { serial: ACCEPTED }],
      [ACCEPTED_TOO, { serial: ACCEPTED_TOO }],
    ]);

    const bad = await portal.post('/client/orders', {
      serviceId: world.auto.serviceId,
      imeis: [IMEIS[2], BAD_CHECK_DIGIT],
      inputs: { serial: IMEIS[3] },
    });
    expect(json(bad).code).toBe('INVALID_IMEI');
    expect(json(bad).errors).toEqual([expect.objectContaining({ field: 'imeis.1', code: 'invalid_imei' })]);
    expect(await world.db.select().from(s.orders)).toHaveLength(2);
  });

  it('replays a field-only order sent again with its Idempotency-Key: the first 201, one order', async () => {
    const portal = await portalFor(t, world.merchant.id);
    const send = () =>
      t.app.inject({
        method: 'POST',
        url: '/client/orders',
        headers: { ...portal.session.mutationHeaders, 'idempotency-key': 'field-only-1' },
        payload: { serviceId: world.auto.serviceId, inputs: { serial: ACCEPTED } },
      });
    const first = await send();
    expect(first.statusCode).toBe(201);
    expect(first.headers['idempotency-replayed']).toBeUndefined();
    const again = await send();
    expect(again.statusCode).toBe(201);
    expect(again.headers['idempotency-replayed']).toBe('true');
    expect(json(again)).toEqual(json(first));
    const orders = await world.db.select().from(s.orders);
    expect(orders).toHaveLength(1);
    expect(orders[0]).toMatchObject({ imei: ACCEPTED, inputs: { serial: ACCEPTED } });
    expect(await walletOf(world.db, world.merchant.id)).toEqual({ wallet: '82.7200', hold: '17.2800' });
  });

  it('names the same IMEI to the duplicate rule whichever way it was sent', async () => {
    const portal = await portalFor(t, world.merchant.id);
    const typed = await portal.post('/client/orders', {
      serviceId: world.auto.serviceId,
      inputs: { serial: ACCEPTED },
    });
    expect(typed.statusCode).toBe(201);
    const sent = await portal.post('/client/orders', { serviceId: world.auto.serviceId, imei: '3529 0511-2490861' });
    expect(sent.statusCode).toBe(409);
    expect(json(sent)).toMatchObject({ code: 'DUPLICATE_ORDER', orderId: json(typed).orders[0].id });

    const first = await portal.post('/client/orders', { serviceId: world.auto.serviceId, imei: ACCEPTED_TOO });
    expect(first.statusCode).toBe(201);
    const again = await portal.post('/client/orders', {
      serviceId: world.auto.serviceId,
      inputs: { serial: ACCEPTED_TOO },
    });
    expect(again.statusCode).toBe(409);
    expect(json(again)).toMatchObject({ code: 'DUPLICATE_ORDER', orderId: json(first).orders[0].id });
  });

  it('still needs imei, on imei, for an IMEI service without a main-input field', async () => {
    await world.db.delete(s.serviceFields).where(eq(s.serviceFields.serviceId, world.auto.serviceId));
    const portal = await portalFor(t, world.merchant.id);
    const missing = await portal.post('/client/orders', { serviceId: world.auto.serviceId });
    expect(missing.statusCode).toBe(422);
    expect(json(missing).errors).toEqual([
      expect.objectContaining({ field: 'imei', code: 'required', message: 'Enter the IMEI.' }),
    ]);
    const stray = await portal.post('/client/orders', {
      serviceId: world.auto.serviceId,
      inputs: { serial: ACCEPTED },
    });
    expect(json(stray).errors).toEqual([
      expect.objectContaining({ field: 'imei', code: 'required' }),
      expect.objectContaining({ field: 'inputs.serial', code: 'unknown_field' }),
    ]);
    await expectNothingPlaced();
  });
});

describe('Dhru placeimeiorder: the IMEI parameter only (decision 070)', () => {
  it('never reads the IMEI from CUSTOMFIELD: a missing IMEI parameter is refused as before', async () => {
    const dhru = dhruClient(t, creds);
    const refused = await dhru.call('placeimeiorder', {
      ID: world.auto.serviceId,
      CUSTOMFIELD: { 'Serial number': ACCEPTED },
    });
    expect(refused.ERROR?.[0]?.MESSAGE).toBe('Enter the IMEI.');
    await expectNothingPlaced();
    const placed = await dhru.call('placeimeiorder', { ID: world.auto.serviceId, IMEI: ACCEPTED });
    expect(placed.SUCCESS).toBeDefined();
    expect((await orderRow(world.db, Number(placed.SUCCESS[0].REFERENCEID))).imei).toBe(ACCEPTED);
  });
});

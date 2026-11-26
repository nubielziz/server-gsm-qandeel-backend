// The pattern of a service's main-input field (the one flagged `isMainInput`, whatever its key, decision 065) judges the IMEI the buyer typed
// (the value that is stored and sent to the supplier), on every order surface: the portal and Dhru. When the IMEI is sent as `imei` its
// problems are reported on the item's IMEI path; a value the buyer also puts under that field's key never stands in for it. A missing value
// of the required field is asked for on the field, where the fields-only form draws it (decisions 070 and 073; the IMEI typed there is
// tested in `imei-main-input-placement.test.ts`). A field that is only keyed `imei` (not flagged) is an ordinary field. Real application, Postgres
// and Redis.
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

/** The pattern of the `imei` field: 15 digits that start with 35. */
const PATTERN = '^35[0-9]{13}$';
/** A valid IMEI the pattern accepts. */
const ACCEPTED = IMEIS[0];
/** Another valid IMEI the pattern accepts. */
const ACCEPTED_TOO = IMEIS[1];
/** A valid IMEI the pattern refuses (it starts with 86). */
const REFUSED = IMEIS[4];

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
  await world.db.insert(s.serviceFields).values({
    serviceId: world.auto.serviceId,
    key: 'imei',
    label: 'IMEI',
    supplierKey: 'IMEI',
    isMainInput: true,
    required: true,
    sort: 1,
    regex: PATTERN,
  });
});

/** Asserts nothing was placed and nothing is held for the merchant. */
async function expectNothingPlaced(): Promise<void> {
  expect(await world.db.select().from(s.orders)).toHaveLength(0);
  expect(await walletOf(world.db, world.merchant.id)).toEqual({ wallet: '100.0000', hold: '0.0000' });
}

describe('the pattern of the main-input field keyed imei on an IMEI service', () => {
  it('portal: judges the typed IMEI, not a value sent under inputs.imei, and reports it on the IMEI', async () => {
    const portal = await portalFor(t, world.merchant.id);
    const alone = await portal.post('/client/orders', { serviceId: world.auto.serviceId, imei: REFUSED });
    expect(alone.statusCode).toBe(422);
    expect(json(alone).errors).toEqual([expect.objectContaining({ field: 'imei', code: 'invalid_format' })]);

    const withOther = await portal.post('/client/orders', {
      serviceId: world.auto.serviceId,
      imei: REFUSED,
      inputs: { imei: ACCEPTED },
    });
    expect(withOther.statusCode).toBe(422);
    expect(json(withOther).errors).toEqual([expect.objectContaining({ field: 'imei', code: 'invalid_format' })]);
    await expectNothingPlaced();
  });

  it('portal: reports a bulk IMEI the pattern refuses on its own place in the list, and a missing IMEI once, on the field', async () => {
    const portal = await portalFor(t, world.merchant.id);
    const bulk = await portal.post('/client/orders', { serviceId: world.auto.serviceId, imeis: [ACCEPTED, REFUSED] });
    expect(bulk.statusCode).toBe(422);
    expect(json(bulk).errors).toEqual([expect.objectContaining({ field: 'imeis.1', code: 'invalid_format' })]);
    // Decisions 070 and 073: with no `imei`, the required main-input field is asked for where the form draws it.
    const missing = await portal.post('/client/orders', { serviceId: world.auto.serviceId });
    expect(missing.statusCode).toBe(422);
    expect(json(missing).errors).toEqual([
      expect.objectContaining({ field: 'inputs.imei', code: 'required', message: 'IMEI is required.' }),
    ]);
    await expectNothingPlaced();
  });

  it('portal: an IMEI the pattern accepts is placed and stored as typed', async () => {
    const portal = await portalFor(t, world.merchant.id);
    const placed = await portal.post('/client/orders', { serviceId: world.auto.serviceId, imei: ACCEPTED });
    expect(placed.statusCode).toBe(201);
    expect((await orderRow(world.db, json(placed).orders[0].id)).imei).toBe(ACCEPTED);
    const repeated = await portal.post('/client/orders', {
      serviceId: world.auto.serviceId,
      imei: ACCEPTED_TOO,
      inputs: { imei: ACCEPTED_TOO },
    });
    expect(repeated.statusCode).toBe(201);
    expect((await orderRow(world.db, json(repeated).orders[0].id)).imei).toBe(ACCEPTED_TOO);
  });

  it('portal: the stored inputs.imei is the typed IMEI, never another value', async () => {
    const portal = await portalFor(t, world.merchant.id);
    const placed = await portal.post('/client/orders', {
      serviceId: world.auto.serviceId,
      imei: ACCEPTED,
      inputs: { imei: ACCEPTED_TOO },
    });
    expect(placed.statusCode).toBe(201);
    const order = await orderRow(world.db, json(placed).orders[0].id);
    expect(order.imei).toBe(ACCEPTED);
    expect(order.inputs).toEqual({ imei: ACCEPTED });
    const unchecked = await portal.post('/client/orders', {
      serviceId: world.auto.serviceId,
      imei: ACCEPTED_TOO,
      inputs: { imei: 'not an imei' },
    });
    expect(unchecked.statusCode).toBe(201);
    expect((await orderRow(world.db, json(unchecked).orders[0].id)).inputs).toEqual({ imei: ACCEPTED_TOO });
  });

  it('Dhru: judges the IMEI parameter, not a value sent in CUSTOMFIELD', async () => {
    const dhru = dhruClient(t, creds);
    const refused = await dhru.call('placeimeiorder', {
      ID: world.auto.serviceId,
      IMEI: REFUSED,
      CUSTOMFIELD: { imei: ACCEPTED },
    });
    expect(refused.ERROR?.[0]?.MESSAGE).toBe('IMEI is not in the expected format.');
    await expectNothingPlaced();

    const placed = await dhru.call('placeimeiorder', { ID: world.auto.serviceId, IMEI: ACCEPTED });
    expect(placed.SUCCESS).toBeDefined();
    expect((await orderRow(world.db, Number(placed.SUCCESS[0].REFERENCEID))).imei).toBe(ACCEPTED);
  });
});

describe('the pattern of a main-input field with another key (decision 065)', () => {
  /** The flagged field now has the key `serial` and the Name `Serial number`: the key says nothing, the flag does. */
  beforeEach(async () => {
    await world.db
      .update(s.serviceFields)
      .set({ key: 'serial', label: 'Serial', supplierKey: 'Serial number' })
      .where(eq(s.serviceFields.serviceId, world.auto.serviceId));
  });

  it('portal: judges the typed IMEI on the flagged field, not a value sent under its key, and reports it on the IMEI', async () => {
    const portal = await portalFor(t, world.merchant.id);
    const alone = await portal.post('/client/orders', { serviceId: world.auto.serviceId, imei: REFUSED });
    expect(alone.statusCode).toBe(422);
    expect(json(alone).errors).toEqual([expect.objectContaining({ field: 'imei', code: 'invalid_format' })]);
    const withOther = await portal.post('/client/orders', {
      serviceId: world.auto.serviceId,
      imei: REFUSED,
      inputs: { serial: ACCEPTED },
    });
    expect(withOther.statusCode).toBe(422);
    expect(json(withOther).errors).toEqual([expect.objectContaining({ field: 'imei', code: 'invalid_format' })]);
    await expectNothingPlaced();
  });

  it('portal: a required flagged field is satisfied by the typed IMEI, and what is stored under its key is the typed IMEI', async () => {
    const portal = await portalFor(t, world.merchant.id);
    const alone = await portal.post('/client/orders', { serviceId: world.auto.serviceId, imei: ACCEPTED });
    expect(alone.statusCode).toBe(201);
    const bare = await orderRow(world.db, json(alone).orders[0].id);
    expect(bare.imei).toBe(ACCEPTED);
    expect(bare.inputs).toEqual({});
    const stray = await portal.post('/client/orders', {
      serviceId: world.auto.serviceId,
      imei: ACCEPTED_TOO,
      inputs: { serial: 'not an imei' },
    });
    expect(stray.statusCode).toBe(201);
    const order = await orderRow(world.db, json(stray).orders[0].id);
    expect(order.imei).toBe(ACCEPTED_TOO);
    expect(order.inputs).toEqual({ serial: ACCEPTED_TOO });
  });

  it('portal: a value sent under the old key imei is a field the service does not have', async () => {
    const portal = await portalFor(t, world.merchant.id);
    const refused = await portal.post('/client/orders', {
      serviceId: world.auto.serviceId,
      imei: ACCEPTED,
      inputs: { imei: ACCEPTED },
    });
    expect(refused.statusCode).toBe(422);
    expect(json(refused).errors).toEqual([expect.objectContaining({ field: 'inputs.imei', code: 'unknown_field' })]);
    await expectNothingPlaced();
  });

  it('Dhru: judges the IMEI parameter on the flagged field, and a CUSTOMFIELD value under its Name never stands in for it', async () => {
    const dhru = dhruClient(t, creds);
    const refused = await dhru.call('placeimeiorder', {
      ID: world.auto.serviceId,
      IMEI: REFUSED,
      CUSTOMFIELD: { 'serial number': ACCEPTED },
    });
    expect(refused.ERROR?.[0]?.MESSAGE).toBe('Serial is not in the expected format.');
    await expectNothingPlaced();

    const placed = await dhru.call('placeimeiorder', {
      ID: world.auto.serviceId,
      IMEI: ACCEPTED,
      CUSTOMFIELD: { 'Serial Number': 'not an imei' },
    });
    expect(placed.SUCCESS).toBeDefined();
    const order = await orderRow(world.db, Number(placed.SUCCESS[0].REFERENCEID));
    expect(order.imei).toBe(ACCEPTED);
    expect(order.inputs).toEqual({ serial: ACCEPTED });
  });
});

describe('a field that is only keyed imei, without the flag (decision 065)', () => {
  beforeEach(async () => {
    await world.db
      .update(s.serviceFields)
      .set({ isMainInput: false })
      .where(eq(s.serviceFields.serviceId, world.auto.serviceId));
  });

  it('is an ordinary field: the typed IMEI does not fill it, so a required one must be given', async () => {
    const portal = await portalFor(t, world.merchant.id);
    const missing = await portal.post('/client/orders', { serviceId: world.auto.serviceId, imei: ACCEPTED });
    expect(missing.statusCode).toBe(422);
    expect(json(missing).errors).toEqual([expect.objectContaining({ field: 'inputs.imei', code: 'required' })]);
    await expectNothingPlaced();

    const placed = await portal.post('/client/orders', {
      serviceId: world.auto.serviceId,
      imei: ACCEPTED,
      inputs: { imei: ACCEPTED_TOO },
    });
    expect(placed.statusCode).toBe(201);
    const order = await orderRow(world.db, json(placed).orders[0].id);
    expect(order.imei).toBe(ACCEPTED);
    expect(order.inputs).toEqual({ imei: ACCEPTED_TOO });
  });
});

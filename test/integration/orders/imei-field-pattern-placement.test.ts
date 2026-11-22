// The pattern of a service field keyed `imei` judges the IMEI the buyer typed (the value that is stored and sent to the supplier), on every
// order surface: the portal, REST v1 and Dhru. A value the buyer also puts under `inputs.imei` never stands in for it. Real application,
// Postgres and Redis.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { schema as s } from '@src/infra/db';
import { type TestApp, createTestApp } from '../../support/app';
import { clearIdentityCaches } from '../../support/auth';
import { TestClock } from '../../support/clock';
import { closeTestDb, resetDb, testDb } from '../../support/db';
import {
  type MachineCredentials,
  body,
  clearApiKeyCaches,
  credentialsFor,
  dhruClient,
  v1Client,
} from '../../support/machine-orders';
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

describe('the pattern of a field keyed imei on an IMEI service', () => {
  it('portal: judges the typed IMEI, not a value sent under inputs.imei', async () => {
    const portal = await portalFor(t, world.merchant.id);
    const alone = await portal.post('/client/orders', { serviceId: world.auto.serviceId, imei: REFUSED });
    expect(alone.statusCode).toBe(422);
    expect(json(alone).errors).toEqual([expect.objectContaining({ field: 'inputs.imei', code: 'invalid_format' })]);

    const withOther = await portal.post('/client/orders', {
      serviceId: world.auto.serviceId,
      imei: REFUSED,
      inputs: { imei: ACCEPTED },
    });
    expect(withOther.statusCode).toBe(422);
    expect(json(withOther).errors).toEqual([expect.objectContaining({ field: 'inputs.imei', code: 'invalid_format' })]);
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

  it('REST v1: judges the typed IMEI, not a value sent under inputs.imei', async () => {
    const v1 = v1Client(t, creds.key);
    const alone = await v1.post('/v1/orders', { serviceId: world.auto.serviceId, imei: REFUSED });
    expect(alone.statusCode).toBe(422);
    expect(body(alone).errors).toEqual([expect.objectContaining({ field: 'inputs.imei', code: 'invalid_format' })]);

    const withOther = await v1.post('/v1/orders', {
      serviceId: world.auto.serviceId,
      imei: REFUSED,
      inputs: { imei: ACCEPTED },
    });
    expect(withOther.statusCode).toBe(422);
    expect(body(withOther).errors).toEqual([expect.objectContaining({ field: 'inputs.imei', code: 'invalid_format' })]);
    await expectNothingPlaced();
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

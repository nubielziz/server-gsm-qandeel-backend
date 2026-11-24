// The pattern of a service's main-input field (the one flagged isMainInput, whatever its key, decision 065) judges the IMEI the buyer typed at the
// storefront checkout (the value that is stored and sent to the supplier), as it does on the portal and Dhru, and its problems are reported
// on imei, where the checkout shows the IMEI's (the shop draws no box for that field). A value the buyer also puts under that field's key
// never stands in for it, and a required main-input field is satisfied by the typed IMEI. A field that is only keyed imei is an ordinary
// field. Real application, Postgres and Redis.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { eq } from 'drizzle-orm';
import { schema as s, type Database } from '@src/infra/db';
import { type TestApp, createTestApp } from '../../support/app';
import { B2cGateway, type B2cWorld, b2cWorld, json, paidOrder } from '../../support/b2c';
import { GatewayTestModule } from '../../support/billing';
import { TestClock } from '../../support/clock';
import { closeTestDb, resetDb, testDb } from '../../support/db';
import { IMEIS, orderRow } from '../../support/orders';
import { freshClientIp } from '../../support/pipeline-routes';
import { clearStoreRateLimits } from '../../support/store';
import { APPLE_IMEI, TURNSTILE_HEADERS } from '../../support/storefront';
import { seedDefaultTemplates } from '../../support/notifications';

const clock = new TestClock('2026-11-10T12:00:00.000Z');
const fake = new B2cGateway();
let t: TestApp;
let db: Database;
let world: B2cWorld;

/** The pattern of the `imei` field: 15 digits that start with 35. */
const PATTERN = '^35[0-9]{13}$';
/** A valid IMEI the pattern accepts. */
const ACCEPTED = APPLE_IMEI;
/** Another valid IMEI the pattern accepts. */
const ACCEPTED_TOO = IMEIS[1];
/** A valid IMEI the pattern refuses (it starts with 86). */
const REFUSED = IMEIS[4];

beforeAll(async () => {
  ({ db } = await testDb());
  t = await createTestApp({ clock, imports: [GatewayTestModule] });
});
afterAll(async () => {
  await fake.stop();
  await resetDb();
  await t.close();
  await closeTestDb();
});
beforeEach(async () => {
  clock.set('2026-11-10T12:00:00.000Z');
  fake.reset();
  await resetDb();
  await clearStoreRateLimits(t);
  world = await b2cWorld(t, db, fake);
  await seedDefaultTemplates(db);
  await db.insert(s.serviceFields).values({
    serviceId: world.icloud.serviceId,
    key: 'imei',
    label: 'IMEI',
    supplierKey: 'IMEI',
    isMainInput: true,
    required: true,
    sort: 1,
    regex: PATTERN,
  });
});

/** `POST /store/v1/checkout-sessions` of the iCloud service with the given typed IMEI and inputs. */
const open = (payload: Record<string, unknown>) =>
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
      ...payload,
    } as never,
  });

/** Asserts that nothing was opened. */
async function expectNothingOpened(): Promise<void> {
  expect(await db.select().from(s.checkoutSessions)).toHaveLength(0);
  // No guest row was made for the typed address either (a guest is an account row without a login).
  expect(await db.select().from(s.clients).where(eq(s.clients.hasAccount, false))).toHaveLength(0);
}

describe('the pattern of the main-input field keyed imei on a storefront checkout', () => {
  it('judges the typed IMEI, not a value sent under inputs.imei', async () => {
    const withOther = await open({ imei: REFUSED, inputs: { imei: ACCEPTED } });
    expect(withOther.statusCode).toBe(422);
    expect(json(withOther).errors).toEqual([expect.objectContaining({ field: 'imei', code: 'invalid_format' })]);
    await expectNothingOpened();
  });

  it('refuses a typed IMEI the pattern does not accept, on the IMEI', async () => {
    const alone = await open({ imei: REFUSED });
    expect(alone.statusCode).toBe(422);
    expect(json(alone).errors).toEqual([expect.objectContaining({ field: 'imei', code: 'invalid_format' })]);
    await expectNothingOpened();
  });

  it('a required field keyed imei is satisfied by the typed IMEI', async () => {
    const opened = await open({ imei: ACCEPTED });
    expect(opened.statusCode).toBe(201);
    const repeated = await open({ imei: ACCEPTED_TOO, inputs: { imei: ACCEPTED_TOO }, email: 'ann@mail.example' });
    expect(repeated.statusCode).toBe(201);
  });

  it('the order stores the typed IMEI under that key, never another value', async () => {
    const stray = await paidOrder(t, clock, world, { inputs: { imei: 'not an imei' } });
    const order = await orderRow(db, stray.orderId);
    expect(order.imei).toBe(ACCEPTED);
    expect(order.inputs).toEqual({ imei: ACCEPTED });

    const same = await paidOrder(t, clock, world, { email: 'ann@mail.example', inputs: { imei: ACCEPTED } });
    expect((await orderRow(db, same.orderId)).inputs).toEqual({ imei: ACCEPTED });

    const alone = await paidOrder(t, clock, world, { email: 'bob@mail.example' });
    expect((await orderRow(db, alone.orderId)).inputs).toEqual({});
  });

  it('a service without a main-input field still refuses a value under inputs.imei', async () => {
    await db.delete(s.serviceFields).where(eq(s.serviceFields.serviceId, world.icloud.serviceId));
    const refused = await open({ imei: ACCEPTED, inputs: { imei: ACCEPTED } });
    expect(refused.statusCode).toBe(422);
    expect(json(refused).errors).toEqual([expect.objectContaining({ field: 'inputs.imei', code: 'unknown_field' })]);
    expect((await open({ imei: ACCEPTED })).statusCode).toBe(201);
  });

  it('a main-input field without a pattern accepts any typed IMEI that is valid', async () => {
    await db.update(s.serviceFields).set({ regex: '' }).where(eq(s.serviceFields.serviceId, world.icloud.serviceId));
    expect((await open({ imei: REFUSED })).statusCode).toBe(201);
  });
});

describe('a main-input field with another key on a storefront checkout (decision 065)', () => {
  /** The flagged field now has the key `serial`: the key says nothing, the flag does. */
  beforeEach(async () => {
    await db
      .update(s.serviceFields)
      .set({ key: 'serial', label: 'Serial', supplierKey: 'Serial number' })
      .where(eq(s.serviceFields.serviceId, world.icloud.serviceId));
  });

  it('judges the typed IMEI on that field, not a value sent under its key, and reports it on the IMEI', async () => {
    const alone = await open({ imei: REFUSED });
    expect(alone.statusCode).toBe(422);
    expect(json(alone).errors).toEqual([expect.objectContaining({ field: 'imei', code: 'invalid_format' })]);
    const withOther = await open({ imei: REFUSED, inputs: { serial: ACCEPTED } });
    expect(withOther.statusCode).toBe(422);
    expect(json(withOther).errors).toEqual([expect.objectContaining({ field: 'imei', code: 'invalid_format' })]);
    await expectNothingOpened();
  });

  it('is satisfied by the typed IMEI when it is required, and the order stores the typed IMEI under that key', async () => {
    expect((await open({ imei: ACCEPTED })).statusCode).toBe(201);
    const stray = await paidOrder(t, clock, world, { email: 'ann@mail.example', inputs: { serial: 'not an imei' } });
    const order = await orderRow(db, stray.orderId);
    expect(order.imei).toBe(ACCEPTED);
    expect(order.inputs).toEqual({ serial: ACCEPTED });
    const alone = await paidOrder(t, clock, world, { email: 'bob@mail.example' });
    expect((await orderRow(db, alone.orderId)).inputs).toEqual({});
  });

  it('reads a value under the old key imei as a field the service does not have', async () => {
    const refused = await open({ imei: ACCEPTED, inputs: { imei: ACCEPTED } });
    expect(refused.statusCode).toBe(422);
    expect(json(refused).errors).toEqual([expect.objectContaining({ field: 'inputs.imei', code: 'unknown_field' })]);
    await expectNothingOpened();
  });
});

describe('a field that is only keyed imei, without the flag, on a storefront checkout (decision 065)', () => {
  it('is an ordinary field: the typed IMEI does not fill it, so a required one must be given', async () => {
    await db
      .update(s.serviceFields)
      .set({ isMainInput: false })
      .where(eq(s.serviceFields.serviceId, world.icloud.serviceId));
    const missing = await open({ imei: ACCEPTED });
    expect(missing.statusCode).toBe(422);
    expect(json(missing).errors).toEqual([expect.objectContaining({ field: 'inputs.imei', code: 'required' })]);
    await expectNothingOpened();
    const given = await paidOrder(t, clock, world, { inputs: { imei: ACCEPTED_TOO } });
    const order = await orderRow(db, given.orderId);
    expect(order.imei).toBe(ACCEPTED);
    expect(order.inputs).toEqual({ imei: ACCEPTED_TOO });
  });
});

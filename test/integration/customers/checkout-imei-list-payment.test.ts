// Decision 076 at the payment of a checkout: the main input of an IMEI service may be the value of a field of type imei_bulk, a list of up
// to 30 IMEIs (one checkout, one order). The payment, by card (the capture of the confirmed payment) or from the store balance, asks the
// risk screening about every IMEI of that list, as the checkout's open did, so an IMEI blocklisted between the open and the payment is
// stopped the way one blocklisted IMEI is: the order is placed held and refunded at once, and its assessment says block. Real application,
// Postgres and Redis.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { eq } from 'drizzle-orm';
import { type Database, schema as s } from '@src/infra/db';
import { RefundProcessModule } from '@src/modules/money';
import { type TestApp, createTestApp } from '../../support/app';
import { clearIdentityCaches } from '../../support/auth';
import { B2cGateway, type B2cWorld, b2cWorld, json, paidOrder } from '../../support/b2c';
import { GatewayTestModule } from '../../support/billing';
import { TestClock } from '../../support/clock';
import {
  fundCustomer,
  insertWalletTemplates,
  openSignedInCheckout,
  payFromBalance,
  walletSettings,
} from '../../support/customer-wallet';
import { closeTestDb, resetDb, testDb } from '../../support/db';
import { seedDefaultTemplates } from '../../support/notifications';
import { IMEIS, orderRow } from '../../support/orders';
import { freshClientIp } from '../../support/pipeline-routes';
import { assessmentOf, insertBlock } from '../../support/risk';
import { STORE_ORIGIN, StoreClient, clearStoreRateLimits, makeCustomer } from '../../support/store';

const clock = new TestClock('2026-11-10T12:00:00.000Z');
const fake = new B2cGateway();
let t: TestApp;
let db: Database;
let world: B2cWorld;

beforeAll(async () => {
  ({ db } = await testDb());
  t = await createTestApp({
    clock,
    imports: [GatewayTestModule, RefundProcessModule],
    env: { SHOP_ORIGINS: STORE_ORIGIN },
  });
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
  await clearIdentityCaches(t);
  await clearStoreRateLimits(t);
  world = await b2cWorld(t, db, fake);
  await walletSettings(t, db);
  await seedDefaultTemplates(db);
  await insertWalletTemplates(db);
});

/** The one IMEI of the single case. */
const SINGLE = IMEIS[0];
/** The list of the list case: its SECOND IMEI is the one blocklisted after the open. */
const LIST = `${IMEIS[1]}\n${IMEIS[2]}`;
const LISTED = IMEIS[2];

/** Makes the main input of the iCloud service a required field of the type (the field the shop types the IMEI or the list into). */
async function mainFieldOf(fieldType: 'imei' | 'imei_bulk'): Promise<void> {
  await db.delete(s.serviceFields).where(eq(s.serviceFields.serviceId, world.icloud.serviceId));
  await db.insert(s.serviceFields).values({
    serviceId: world.icloud.serviceId,
    key: 'imeis',
    label: 'IMEIs',
    supplierKey: 'IMEIs',
    fieldType,
    isMainInput: true,
    required: true,
    sort: 1,
  });
}

/** What a payment left: the order's status and dispatch state, its assessment and how many refunds it has. */
async function outcomeOf(orderId: number) {
  const order = await orderRow(db, orderId);
  const assessment = await assessmentOf(db, orderId);
  const refunds = await db.select().from(s.refunds).where(eq(s.refunds.orderId, orderId));
  return {
    status: order.status,
    dispatchState: order.dispatchState,
    decision: assessment.decision,
    score: assessment.score,
    signals: assessment.signals,
    outcome: assessment.outcome,
    refunds: refunds.map((refund) => ({ requestedByType: refund.requestedByType, method: refund.method })),
  };
}

/** How a payment whose IMEI is on the blocklist ends. */
const STOPPED = {
  status: 'rejected',
  decision: 'block',
  score: 100,
  signals: ['IMEI is on the blocklist'],
  outcome: 'refunded',
  refunds: [{ requestedByType: 'system', method: 'original' }],
};

describe('the card capture of a checkout whose main input is an imei_bulk list', () => {
  it('stops a list whose second IMEI was blocklisted after the open, the way it stops one blocklisted IMEI', async () => {
    await mainFieldOf('imei');
    const single = await paidOrder(t, clock, world, {
      email: 'one@mail.example',
      imei: null,
      inputs: { imeis: SINGLE },
      afterOpen: () => insertBlock(t, db, 'imei', SINGLE),
    });
    expect(await outcomeOf(single.orderId)).toMatchObject(STOPPED);

    await mainFieldOf('imei_bulk');
    const listed = await paidOrder(t, clock, world, {
      email: 'two@mail.example',
      imei: null,
      inputs: { imeis: LIST },
      afterOpen: () => insertBlock(t, db, 'imei', LISTED),
    });
    expect((await orderRow(db, listed.orderId)).imei).toBe(LIST);
    expect(await outcomeOf(listed.orderId)).toEqual(await outcomeOf(single.orderId));
  });

  it('lets a list through when none of its IMEIs is on the blocklist', async () => {
    await mainFieldOf('imei_bulk');
    await insertBlock(t, db, 'imei', SINGLE);
    const paid = await paidOrder(t, clock, world, { email: 'ann@mail.example', imei: null, inputs: { imeis: LIST } });
    expect(await outcomeOf(paid.orderId)).toMatchObject({ status: 'pending', decision: 'allow', refunds: [] });
  });
});

describe('the balance payment of a checkout whose main input is an imei_bulk list', () => {
  /** A signed-in customer with a balance, its checkout of the iCloud service opened with the main input, and the order it paid. */
  async function paidFromBalance(name: string, mainInput: string, blocked: string): Promise<number> {
    const customer = await makeCustomer(t, { name });
    const client = new StoreClient(t, freshClientIp());
    expect((await client.login(customer.email)).statusCode).toBe(200);
    await fundCustomer(db, customer.id, '50');
    const { token } = await openSignedInCheckout(client, world, customer.email, {
      imei: null,
      inputs: { imeis: mainInput },
    });
    await insertBlock(t, db, 'imei', blocked);
    const res = await payFromBalance(client, token);
    expect(res.statusCode).toBe(201);
    return json(res).order.id;
  }

  it('stops a list whose second IMEI was blocklisted after the open, the way it stops one blocklisted IMEI', async () => {
    await mainFieldOf('imei');
    const single = await paidFromBalance('Daniel Rivera', SINGLE, SINGLE);
    expect(await outcomeOf(single)).toMatchObject({ ...STOPPED, refunds: [{ requestedByType: 'system' }] });

    await mainFieldOf('imei_bulk');
    const listed = await paidFromBalance('Maya Chen', LIST, LISTED);
    expect((await orderRow(db, listed)).imei).toBe(LIST);
    expect(await outcomeOf(listed)).toEqual(await outcomeOf(single));
  });
});

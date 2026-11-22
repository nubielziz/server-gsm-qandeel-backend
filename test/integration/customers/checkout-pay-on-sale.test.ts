// Paying a storefront checkout (a card page or the store balance) is refused while the service is no longer on sale (switched off, its
// listing off, or no retail price): before any payment row is written and before the gateway is asked. A price that changed after the
// checkout opened still holds (the price lock), a replay of an earlier call still answers, and a confirmation of money that already
// arrived still places the order. Real application, Postgres and Redis.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { and, eq } from 'drizzle-orm';
import { type Database, schema as s } from '@src/infra/db';
import { RefundProcessModule } from '@src/modules/money';
import { type TestApp, createTestApp } from '../../support/app';
import { clearIdentityCaches } from '../../support/auth';
import { B2cGateway, type B2cWorld, b2cWorld, hook, json, openCheckout, pay, storefrontEvent } from '../../support/b2c';
import { GatewayTestModule } from '../../support/billing';
import { TestClock } from '../../support/clock';
import {
  customerWalletRow,
  fundCustomer,
  insertWalletTemplates,
  openSignedInCheckout,
  payFromBalance,
  walletSettings,
} from '../../support/customer-wallet';
import { closeTestDb, resetDb, testDb } from '../../support/db';
import { seedDefaultTemplates } from '../../support/notifications';
import { freshClientIp } from '../../support/pipeline-routes';
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

/** The ways staff take a service off sale, each applied to the service of the open checkout. */
const SWITCH_OFFS: ReadonlyArray<[string, () => Promise<unknown>]> = [
  [
    'the service is disabled',
    () => db.update(s.services).set({ status: 'disabled' }).where(eq(s.services.id, world.icloud.serviceId)),
  ],
  [
    'its listing is switched off',
    () => db.update(s.serviceListings).set({ isListed: false }).where(eq(s.serviceListings.id, world.icloud.listingId)),
  ],
  [
    'its retail price is removed',
    () =>
      db
        .delete(s.serviceGroupPrices)
        .where(
          and(
            eq(s.serviceGroupPrices.serviceId, world.icloud.serviceId),
            eq(s.serviceGroupPrices.groupId, world.groups.retail),
          ),
        ),
  ],
];

const NO_LONGER_AVAILABLE = 'This service is no longer available. Start again.';

describe('POST /store/v1/checkout-sessions/:token/pay while the service is not on sale', () => {
  for (const [name, switchOff] of SWITCH_OFFS) {
    it(`refuses the payment when ${name}: no payment row, no gateway call`, async () => {
      const { token } = await openCheckout(t, world);
      await switchOff();
      const res = await pay(t, token, undefined);
      expect(res.statusCode).toBe(409);
      expect(json(res)).toMatchObject({ code: 'INVALID_TRANSITION', detail: NO_LONGER_AVAILABLE });
      expect(await db.select().from(s.payments)).toHaveLength(0);
      expect(fake.requests).toHaveLength(0);
      const shown = await t.app.inject({
        method: 'GET',
        url: `/store/v1/checkout-sessions/${token}`,
        remoteAddress: freshClientIp(),
      });
      expect(json(shown).status).toBe('open');
    });
  }

  it('still pays a checkout whose price changed after it opened: the locked price is charged', async () => {
    const { token, session } = await openCheckout(t, world);
    await db
      .update(s.serviceGroupPrices)
      .set({ price: '9.9900' })
      .where(
        and(
          eq(s.serviceGroupPrices.serviceId, world.icloud.serviceId),
          eq(s.serviceGroupPrices.groupId, world.groups.retail),
        ),
      );
    const res = await pay(t, token, undefined);
    expect(res.statusCode).toBe(201);
    expect(json(res).payment.amount).toBe(session.amounts.display.gross);
  });

  it('answers a replay of a call made before the switch-off with the same payment', async () => {
    const { token } = await openCheckout(t, world);
    const key = crypto.randomUUID();
    const first = await pay(t, token, undefined, key);
    expect(first.statusCode).toBe(201);
    await db.update(s.services).set({ status: 'disabled' }).where(eq(s.services.id, world.icloud.serviceId));
    const again = await pay(t, token, undefined, key);
    expect(again.statusCode).toBe(201);
    expect(again.headers['idempotency-replayed']).toBe('true');
    expect(json(again).payment.id).toBe(json(first).payment.id);
    expect(await db.select().from(s.payments)).toHaveLength(1);
  });

  for (const [name, switchOff] of SWITCH_OFFS) {
    it(`captures money that already arrived when ${name} after the payment page opened`, async () => {
      const { token } = await openCheckout(t, world);
      const started = await pay(t, token, undefined);
      expect(started.statusCode).toBe(201);
      await switchOff();
      const { payment } = json(started);
      const event = storefrontEvent(`evt_${crypto.randomUUID()}`, payment.reference, {
        amount: payment.amount,
        currency: payment.currency,
        intent: `pi_${crypto.randomUUID().slice(0, 8)}`,
      });
      expect((await hook(t, clock, 'payments', world.gateway.code, event)).statusCode).toBe(200);
      const [row] = await db.select().from(s.payments).where(eq(s.payments.id, payment.id));
      expect(row!.status).toBe('captured');
      expect(row!.orderId).not.toBeNull();
      expect(await db.select().from(s.orders)).toHaveLength(1);
    });
  }
});

describe('POST /store/v1/checkout-sessions/:token/balance-payment while the service is not on sale', () => {
  /** A customer with an account, signed in, with a balance. */
  async function buyer() {
    const customer = await makeCustomer(t, { name: 'Daniel Rivera' });
    const client = new StoreClient(t, freshClientIp());
    expect((await client.login(customer.email)).statusCode).toBe(200);
    await fundCustomer(db, customer.id, '50');
    return { customer, client };
  }

  for (const [name, switchOff] of SWITCH_OFFS) {
    it(`refuses the payment when ${name}: no order, no payment, the balance is untouched`, async () => {
      const { customer, client } = await buyer();
      const { token } = await openSignedInCheckout(client, world, customer.email);
      await switchOff();
      const res = await payFromBalance(client, token);
      expect(res.statusCode).toBe(409);
      expect(json(res)).toMatchObject({ code: 'INVALID_TRANSITION', detail: NO_LONGER_AVAILABLE });
      expect(await db.select().from(s.orders)).toHaveLength(0);
      expect(await db.select().from(s.payments)).toHaveLength(0);
      expect((await customerWalletRow(db, customer.id))!.balance).toBe('50.0000');
      const shown = await t.app.inject({
        method: 'GET',
        url: `/store/v1/checkout-sessions/${token}`,
        remoteAddress: freshClientIp(),
      });
      expect(json(shown).status).toBe('open');
    });
  }

  it('still pays a checkout whose price changed after it opened: the locked price is taken', async () => {
    const { customer, client } = await buyer();
    const { token } = await openSignedInCheckout(client, world, customer.email);
    await db
      .update(s.serviceGroupPrices)
      .set({ price: '9.9900' })
      .where(
        and(
          eq(s.serviceGroupPrices.serviceId, world.icloud.serviceId),
          eq(s.serviceGroupPrices.groupId, world.groups.retail),
        ),
      );
    const res = await payFromBalance(client, token);
    expect(res.statusCode).toBe(201);
    expect(await db.select().from(s.orders)).toHaveLength(1);
  });

  it('answers a replay of a payment made before the switch-off with the same order', async () => {
    const { customer, client } = await buyer();
    const { token } = await openSignedInCheckout(client, world, customer.email);
    const key = crypto.randomUUID();
    const first = await payFromBalance(client, token, key);
    expect(first.statusCode).toBe(201);
    await db.update(s.services).set({ status: 'disabled' }).where(eq(s.services.id, world.icloud.serviceId));
    const again = await payFromBalance(client, token, key);
    expect(again.statusCode).toBe(201);
    expect(again.headers['idempotency-replayed']).toBe('true');
    expect(json(again).order.id).toBe(json(first).order.id);
    expect(await db.select().from(s.orders)).toHaveLength(1);
  });
});

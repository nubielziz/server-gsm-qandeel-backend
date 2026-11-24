// The tracking token at rest (decision 054): a new storefront order keeps it only as a keyed hash and an encrypted copy, which the tracking
// page, the paid checkout and the customer's order list read; an order placed before still opens and is sealed once; the ticket form takes
// the tracking token of both.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { eq } from 'drizzle-orm';
import { type Database, schema as s } from '@src/infra/db';
import { TrackingTokenSeal, TrackingTokenSealModule } from '@src/modules/orders';
import { type TestApp, createTestApp } from '../../support/app';
import { clearIdentityCaches } from '../../support/auth';
import { B2cGateway, type B2cWorld, b2cWorld, paidOrder } from '../../support/b2c';
import { GatewayTestModule } from '../../support/billing';
import { revealedToken, sealedRow, tokenHashOf } from '../../support/capability-tokens';
import { TestClock } from '../../support/clock';
import { closeTestDb, resetDb, testDb } from '../../support/db';
import { insertOrderRow } from '../../support/orders';
import { freshClientIp } from '../../support/pipeline-routes';
import { APPLE_IMEI, TURNSTILE_HEADERS } from '../../support/storefront';
import { makeCustomer } from '../../support/store';
import { clearTicketEmailLimits, seedSupportTemplates } from '../../support/support';
import { customerSession } from '../../support/support-accounts';

const clock = new TestClock('2026-11-07T12:00:00.000Z');
const fake = new B2cGateway();
const OLD_TOKEN = 'Old7kq2Zp9Xw4Ld1Hn6Rb3';
let t: TestApp;
let db: Database;
let world: B2cWorld;

beforeAll(async () => {
  ({ db } = await testDb());
  t = await createTestApp({ clock, imports: [GatewayTestModule, TrackingTokenSealModule] });
});
beforeEach(async () => {
  clock.set('2026-11-07T12:00:00.000Z');
  fake.reset();
  await resetDb();
  await clearIdentityCaches(t);
  await clearTicketEmailLimits(t);
  world = await b2cWorld(t, db, fake);
});
afterAll(async () => {
  await fake.stop();
  await resetDb();
  await t.close();
  await closeTestDb();
});

const track = (token: string) =>
  t.app.inject({ method: 'GET', url: `/store/v1/orders/${token}`, remoteAddress: freshClientIp() });
const orderOf = async (id: number) => (await db.select().from(s.orders).where(eq(s.orders.id, id)))[0]!;

/** A storefront order stored the way orders were before decision 054: the tracking token as issued. */
async function oldOrder(accountId?: number) {
  const id = accountId ?? (await makeCustomer(t, { guest: true, email: 'old@mail.example', name: 'Old Buyer' })).id;
  return insertOrderRow(db, {
    serviceId: world.icloud.serviceId,
    accountId: id,
    source: 'store',
    imei: APPLE_IMEI,
    publicToken: OLD_TOKEN,
    status: 'pending',
  });
}

describe('the tracking token at rest', () => {
  it('stores a new tracking token only as a keyed hash and an encrypted copy', async () => {
    const paid = await paidOrder(t, clock, world);
    const order = await orderOf(paid.orderId);
    expect(order.publicToken).toBeNull();
    expect(order.publicTokenHash).toBe(tokenHashOf(t, 'tracking', paid.trackingToken));
    expect(order.publicTokenEnc).not.toContain(paid.trackingToken);
    expect(revealedToken(t, 'tracking', { enc: order.publicTokenEnc, plain: order.publicToken })).toBe(
      paid.trackingToken,
    );
    expect((await track(paid.trackingToken)).statusCode).toBe(200);
    // The paid checkout shows the token again (it was read from the encrypted copy).
    const session = await t.app.inject({
      method: 'GET',
      url: `/store/v1/checkout-sessions/${paid.token}`,
      remoteAddress: freshClientIp(),
    });
    expect(session.json<{ trackingToken: string }>().trackingToken).toBe(paid.trackingToken);
  });

  it("the customer's order list shows the token of a sealed order", async () => {
    const customer = await makeCustomer(t);
    const session = await customerSession(t, customer.id);
    const token = 'Sealed7kq2Zp9Xw4Ld1Hn6';
    const sealed = sealedRow(t, 'tracking', token);
    await insertOrderRow(db, {
      serviceId: world.icloud.serviceId,
      accountId: customer.id,
      source: 'store',
      publicToken: null,
      publicTokenHash: sealed.hash,
      publicTokenEnc: sealed.enc,
    });
    const res = await session.call('GET', '/store/v1/me/orders');
    expect(res.status).toBe(200);
    expect((res.body as Array<{ trackingToken: string | null }>).map((row) => row.trackingToken)).toEqual([token]);
  });

  it('opens and seals an order placed before', async () => {
    const old = await oldOrder();
    expect((await track(OLD_TOKEN)).statusCode).toBe(200);
    expect(await t.app.get(TrackingTokenSeal).run()).toEqual({ sealed: 1, unchanged: 0 });
    const row = await orderOf(old.id);
    expect(row.publicToken).toBeNull();
    expect(row.publicTokenHash).toBe(tokenHashOf(t, 'tracking', OLD_TOKEN));
    expect(row.updatedAt).toEqual(old.updatedAt);
    expect((await track(OLD_TOKEN)).statusCode).toBe(200);
    expect(await t.app.get(TrackingTokenSeal).run()).toEqual({ sealed: 0, unchanged: 0 });
  });

  it('the ticket form accepts the tracking token of a sealed and of an old order', async () => {
    await seedSupportTemplates(db);
    const paid = await paidOrder(t, clock, world);
    await oldOrder();
    for (const orderToken of [paid.trackingToken, OLD_TOKEN]) {
      const res = await t.app.inject({
        method: 'POST',
        url: '/store/v1/tickets',
        headers: TURNSTILE_HEADERS,
        remoteAddress: freshClientIp(),
        payload: { subject: 'Where is it?', message: 'Still waiting.', orderToken },
      });
      expect(res.statusCode, orderToken).toBe(201);
      expect(res.json<{ token?: string }>().token).toMatch(/^[A-Za-z0-9_-]{22}$/);
    }
  });
});

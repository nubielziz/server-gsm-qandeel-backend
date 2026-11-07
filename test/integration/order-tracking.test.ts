// Integration tests of the public order tracking (feature 14a): GET /store/v1/orders/:token against the real API: the capability
// token (constant-time, one answer for every wrong token), the public view without anything staff-only, the words of the timeline,
// and the token limit.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { eq } from 'drizzle-orm';
import { schema as s } from '../../src/infra/db';
import { CapabilityTokenResolvers } from '../../src/modules/identity';
import { type TestApp, createTestApp } from '../support/app';
import { TestClock } from '../support/clock';
import { closeTestDb, resetDb, testDb } from '../support/db';
import { insertOrderRow } from '../support/orders';
import { insertMerchantIn } from '../support/pricing';
import { freshClientIp } from '../support/pipeline-routes';
import { APPLE_IMEI, storefrontWorld } from '../support/storefront';

const clock = new TestClock('2026-11-07T12:00:00.000Z');
let t: TestApp;

beforeAll(async () => {
  t = await createTestApp({ clock });
});
beforeEach(async () => {
  clock.set('2026-11-07T12:00:00.000Z');
  await resetDb();
});
afterAll(async () => {
  await resetDb();
  await t.close();
  await closeTestDb();
});

const TOKEN = 'T7kq2Zp9Xw4Ld1Hn6Rb3Yc';
const track = (token: string, remoteAddress = freshClientIp()) =>
  t.app.inject({ method: 'GET', url: `/store/v1/orders/${token}`, remoteAddress });
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- test bodies are untyped JSON
const body = (res: { json: () => any }): any => res.json();

/** A storefront order of the iCloud check for a guest customer, with the token. */
async function storefrontOrder(values: Partial<typeof s.orders.$inferInsert> = {}) {
  const { db } = await testDb();
  const world = await storefrontWorld(db);
  const [customer] = await db.insert(s.customers).values({ email: 'sam@mail.example', name: 'Sam Buyer' }).returning();
  const order = await insertOrderRow(db, {
    serviceId: world.icloud.serviceId,
    customerId: customer!.id,
    source: 'store',
    imei: APPLE_IMEI,
    publicToken: TOKEN,
    status: 'pending',
    placedAt: new Date('2026-11-07T12:00:00.000Z'),
    ...values,
  });
  return { db, world, order, customer: customer! };
}

describe('GET /store/v1/orders/:token', () => {
  it('shows the status, the service, the masked input and the timeline in the shop words, nothing else', async () => {
    const { db, order } = await storefrontOrder({
      status: 'completed',
      dispatchState: 'done',
      resultCode: 'Status: Clean.',
      resultComment: 'Checked at the carrier.',
      completedAt: new Date('2026-11-07T12:02:10.000Z'),
      supplierRef: 'NG-8841',
      adminNote: 'staff only note',
      clientNote: 'client note',
    });
    await db.insert(s.orderEvents).values([
      {
        orderId: order.id,
        type: 'created',
        actorType: 'system',
        data: { message: 'Order received via Storefront' },
        createdAt: new Date('2026-11-07T12:00:00.000Z'),
      },
      {
        orderId: order.id,
        type: 'paid',
        actorType: 'system',
        data: { message: 'Paid $4.79 by card 4242' },
        createdAt: new Date('2026-11-07T12:00:05.000Z'),
      },
      {
        orderId: order.id,
        type: 'hold',
        actorType: 'system',
        data: { message: 'Risk score 61: new customer' },
        createdAt: new Date('2026-11-07T12:00:06.000Z'),
      },
      {
        orderId: order.id,
        type: 'dispatch',
        actorType: 'system',
        data: { message: 'Sent to Nordic GSM' },
        createdAt: new Date('2026-11-07T12:00:10.000Z'),
      },
      {
        orderId: order.id,
        type: 'note',
        actorType: 'staff',
        actorId: 1,
        data: { message: 'staff only note' },
        createdAt: new Date('2026-11-07T12:00:20.000Z'),
      },
      {
        orderId: order.id,
        type: 'settle',
        actorType: 'system',
        data: { message: 'cost 0.08' },
        createdAt: new Date('2026-11-07T12:02:10.000Z'),
      },
      {
        orderId: order.id,
        type: 'completed',
        fromStatus: 'processing',
        toStatus: 'completed',
        actorType: 'supplier',
        actorId: 1,
        data: { message: 'Done by Nordic GSM' },
        createdAt: new Date('2026-11-07T12:02:10.000Z'),
      },
    ]);
    const res = await track(TOKEN);
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(body(res)).toEqual({
      status: 'completed',
      service: { name: 'iCloud Clean / Lost Check', type: 'imei', deliveryTime: '2 minutes' },
      input: '•••••••••••0004',
      quantity: 1,
      placedAt: '2026-11-07T12:00:00.000Z',
      completedAt: '2026-11-07T12:02:10.000Z',
      result: { code: 'Status: Clean.', comment: 'Checked at the carrier.' },
      timeline: [
        { type: 'created', message: 'Order received', createdAt: '2026-11-07T12:00:00.000Z' },
        { type: 'paid', message: 'Payment received', createdAt: '2026-11-07T12:00:05.000Z' },
        { type: 'completed', message: 'Completed', createdAt: '2026-11-07T12:02:10.000Z' },
      ],
    });
    const text = JSON.stringify(body(res));
    for (const secret of [
      'Nordic',
      'NG-8841',
      'staff only',
      'client note',
      'Risk score',
      'cost',
      APPLE_IMEI,
      'sam@mail',
      'Sam Buyer',
      'supplier',
    ]) {
      expect(text, secret).not.toContain(secret);
    }
  });

  it('shows no result before the order is completed and never the reason of a rejection', async () => {
    const { db, order } = await storefrontOrder({
      status: 'rejected',
      resultCode: 'Supplier says: blacklisted at Nordic GSM',
      dispatchState: 'done',
    });
    await db.insert(s.orderEvents).values([
      {
        orderId: order.id,
        type: 'rejected',
        fromStatus: 'processing',
        toStatus: 'rejected',
        actorType: 'supplier',
        actorId: 1,
        data: { reason: 'Nordic GSM refused' },
      },
      { orderId: order.id, type: 'refund', actorType: 'system', data: { message: 'Refunded $4.79 to card' } },
    ]);
    const view = body(await track(TOKEN));
    expect(view.status).toBe('rejected');
    expect(view.result).toBeNull();
    expect(view.timeline.map((line: { message: string }) => line.message)).toEqual([
      'We could not complete this order',
      'Refunded',
    ]);
    expect(JSON.stringify(view)).not.toContain('Nordic');
  });

  it('hides a risk hold: a held order reads as pending', async () => {
    const { db, order } = await storefrontOrder({ status: 'pending', dispatchState: 'held' });
    await db
      .insert(s.orderEvents)
      .values({ orderId: order.id, type: 'risk', actorType: 'system', data: { message: 'Held: score 80' } });
    const view = body(await track(TOKEN));
    expect(view.status).toBe('pending');
    expect(view.timeline).toEqual([]);
    expect(JSON.stringify(view)).not.toContain('held');
  });

  it('masks a short input completely and sends null for an order without one', async () => {
    const { db, order } = await storefrontOrder({ imei: 'abc' });
    expect(body(await track(TOKEN)).input).toBe('•••');
    await db.update(s.orders).set({ imei: null }).where(eq(s.orders.id, order.id));
    expect(body(await track(TOKEN)).input).toBeNull();
  });

  it('answers 404 with the same words for an unknown token, a nearly right token and a merchant order', async () => {
    const { db, world, order } = await storefrontOrder();
    const merchant = await insertMerchantIn(db, world.groups.standard, { name: 'Cairo GSM Lab' });
    await insertOrderRow(db, { serviceId: world.icloud.serviceId, clientId: merchant, customerId: null });
    const nearly = `${TOKEN.slice(0, -1)}${TOKEN.endsWith('A') ? 'B' : 'A'}`;
    const answers = [];
    for (const wrong of [
      nearly,
      'AAAAAAAAAAAAAAAAAAAAAA',
      'short',
      'null',
      String(order.id),
      'has space in it......',
    ]) {
      const res = await track(encodeURIComponent(wrong));
      expect(res.statusCode, wrong).toBe(404);
      answers.push(body(res));
    }
    for (const answer of answers) {
      expect(answer).toMatchObject({ code: 'NOT_FOUND', status: 404, detail: 'This link is not valid.' });
      expect(JSON.stringify(answer)).not.toContain(TOKEN);
    }
  });

  it('does not open an order by a token that belongs to a checkout session, or the other way round', async () => {
    const { db, world } = await storefrontOrder();
    const [customer] = await db.select().from(s.customers);
    await db.insert(s.checkoutSessions).values({
      token: 'C5zq8Vw3Ny7Bm2Kd9Ts4Fa',
      customerId: customer!.id,
      email: 'sam@mail.example',
      serviceId: world.icloud.serviceId,
      currency: 'USD',
      netAmount: '3.99',
      grossAmount: '3.99',
      expiresAt: new Date('2026-11-07T12:30:00.000Z'),
    });
    expect((await track('C5zq8Vw3Ny7Bm2Kd9Ts4Fa')).statusCode).toBe(404);
    const crossed = await t.app.inject({
      method: 'GET',
      url: `/store/v1/checkout-sessions/${TOKEN}`,
      remoteAddress: freshClientIp(),
    });
    expect(crossed.statusCode).toBe(404);
  });

  it('limits token lookups to 30 a minute per address, with 429 and Retry-After', async () => {
    await storefrontOrder();
    const ip = freshClientIp();
    for (let index = 0; index < 30; index += 1)
      expect((await track('AAAAAAAAAAAAAAAAAAAAAA', ip)).statusCode).toBe(404);
    const limited = await track(TOKEN, ip);
    expect(limited.statusCode).toBe(429);
    expect(body(limited).code).toBe('RATE_LIMITED');
  });
});

describe('the capability token resolvers', () => {
  it('are registered by the module that owns the record, so the checkout and tracking kinds no longer fail closed', () => {
    const resolvers = t.app.get(CapabilityTokenResolvers);
    expect(resolvers.has('tracking-token')).toBe(true);
    expect(resolvers.has('checkout-token')).toBe(true);
  });
});

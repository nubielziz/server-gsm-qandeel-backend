// Integration tests of the storefront links of an anonymized customer: once staff anonymize a customer (POST /admin/customers/:id/anonymize),
// the tracking link of the customer's orders (the status, the result and the receipt), the checkout link and the ticket form's order link
// answer as for an unknown link. The links of other customers keep working.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { eq } from 'drizzle-orm';
import { type Database, schema as s } from '@src/infra/db';
import { ReceiptRenderModule } from '@src/modules/money';
import { adminWith } from '../../support/admin-api';
import { type TestApp, createTestApp } from '../../support/app';
import { clearIdentityCaches } from '../../support/auth';
import { B2cGateway, type B2cWorld, b2cWorld, paidOrder, renderReceipts } from '../../support/b2c';
import { GatewayTestModule } from '../../support/billing';
import { TestClock } from '../../support/clock';
import { closeTestDb, resetDb, testDb } from '../../support/db';
import { freshClientIp } from '../../support/pipeline-routes';
import { clearStoreRateLimits } from '../../support/store';
import { TURNSTILE_HEADERS } from '../../support/storefront';
import { clearTicketEmailLimits, seedSupportTemplates } from '../../support/support';

const clock = new TestClock('2026-11-07T12:00:00.000Z');
const fake = new B2cGateway();
let t: TestApp;
let db: Database;
let world: B2cWorld;

beforeAll(async () => {
  ({ db } = await testDb());
  t = await createTestApp({ clock, imports: [GatewayTestModule, ReceiptRenderModule] });
});
beforeEach(async () => {
  clock.set('2026-11-07T12:00:00.000Z');
  fake.reset();
  await resetDb();
  await clearIdentityCaches(t);
  await clearStoreRateLimits(t);
  await clearTicketEmailLimits(t);
  await seedSupportTemplates(db);
  world = await b2cWorld(t, db, fake);
});
afterAll(async () => {
  await fake.stop();
  await resetDb();
  await t.close();
  await closeTestDb();
});

const get = (url: string) => t.app.inject({ method: 'GET', url, remoteAddress: freshClientIp() });
const openTicket = (orderToken: string) =>
  t.app.inject({
    method: 'POST',
    url: '/store/v1/tickets',
    headers: { ...TURNSTILE_HEADERS },
    remoteAddress: freshClientIp(),
    payload: { orderToken, subject: 'Hello again', message: 'About my order.' } as never,
  });

describe('the storefront links of an anonymized customer', () => {
  it('answer as unknown links: the tracking page, the receipt, the checkout and a new ticket', async () => {
    const erased = await paidOrder(t, clock, world, { email: 'erin.erased@mail.example' });
    const kept = await paidOrder(t, clock, world, { email: 'kim.kept@mail.example' });
    await renderReceipts(t);
    const [order] = await db.select().from(s.orders).where(eq(s.orders.id, erased.orderId));
    expect((await get(`/store/v1/orders/${erased.trackingToken}`)).statusCode).toBe(200);

    const privacy = await adminWith(t, ['customers:privacy']);
    expect((await privacy.post(`/admin/customers/${order!.customerId}/anonymize`)).status).toBeLessThan(300);

    for (const url of [
      `/store/v1/orders/${erased.trackingToken}`,
      `/store/v1/orders/${erased.trackingToken}/receipt`,
      `/store/v1/checkout-sessions/${erased.token}`,
    ]) {
      const res = await get(url);
      expect(res.statusCode, url).toBe(404);
      expect(res.json().code, url).toBe('NOT_FOUND');
    }
    const ticket = await openTicket(erased.trackingToken);
    expect(ticket.statusCode).toBe(422);
    expect(ticket.json().errors).toEqual([expect.objectContaining({ field: 'orderToken', code: 'unknown_order' })]);
    expect(await db.select().from(s.supportTickets)).toHaveLength(0);

    // Another customer's links are untouched.
    expect((await get(`/store/v1/orders/${kept.trackingToken}`)).statusCode).toBe(200);
    expect((await get(`/store/v1/orders/${kept.trackingToken}/receipt`)).statusCode).toBe(200);
    expect((await get(`/store/v1/checkout-sessions/${kept.token}`)).statusCode).toBe(200);
    expect((await openTicket(kept.trackingToken)).statusCode).toBe(201);
  });
});

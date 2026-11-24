// Integration tests of the order link on the storefront ticket form (POST /store/v1/tickets with an `orderToken`, decision 053 and 064): the link
// speaks for the order's account only when the account itself opened the checkout signed in, or when the buyer row has no login (a guest
// row). A guest checkout never attaches to a login account any more, so its order belongs to the guest row of the typed address and
// nothing of it reaches the account. An order placed before decision 064 by a guest checkout typed with a login account's address still
// belongs to that account: its link files the ticket under that address unconfirmed, exactly as a typed address does: not in the account,
// no ticket token in the answer, a system note for staff, until the link mailed to that address is used. The link of an anonymized
// account's order opens nothing.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { asc, eq } from 'drizzle-orm';
import { type Database, schema as s } from '@src/infra/db';
import { UNPROVEN_TICKET_NOTE } from '@src/modules/support/domain/requester-proof';
import { adminWith } from '../../support/admin-api';
import { type TestApp, createTestApp } from '../../support/app';
import { clearIdentityCaches } from '../../support/auth';
import { B2cGateway, type B2cWorld, b2cWorld, hook, json, paidOrder, pay, storefrontEvent } from '../../support/b2c';
import { GatewayTestModule } from '../../support/billing';
import { revealedToken } from '../../support/capability-tokens';
import { TestClock } from '../../support/clock';
import { openSignedInCheckout } from '../../support/customer-wallet';
import { closeTestDb, resetDb, testDb } from '../../support/db';
import { freshClientIp } from '../../support/pipeline-routes';
import { STORE_ORIGIN, StoreClient, clearStoreRateLimits, makeCustomer } from '../../support/store';
import { TURNSTILE_HEADERS } from '../../support/storefront';
import { clearTicketEmailLimits, seedSupportTemplates } from '../../support/support';
import { clearTicketOpenLimits, customerSession } from '../../support/support-accounts';

const NOW = '2026-11-10T12:00:00.000Z';
const clock = new TestClock(NOW);
const fake = new B2cGateway();
let t: TestApp;
let db: Database;
let world: B2cWorld;

beforeAll(async () => {
  ({ db } = await testDb());
  t = await createTestApp({ clock, imports: [GatewayTestModule], env: { SHOP_ORIGINS: STORE_ORIGIN } });
});
beforeEach(async () => {
  clock.set(NOW);
  fake.reset();
  await resetDb();
  await clearIdentityCaches(t);
  await clearStoreRateLimits(t);
  await clearTicketEmailLimits(t);
  await clearTicketOpenLimits(t);
  await seedSupportTemplates(db);
  world = await b2cWorld(t, db, fake);
});
afterAll(async () => {
  await fake.stop();
  await resetDb();
  await t.close();
  await closeTestDb();
});

// Every call comes from its own address: the per-IP limits must not decide these tests.
const send = (method: 'GET' | 'POST', url: string, payload?: unknown, headers: Record<string, string> = {}) =>
  t.app.inject({
    method,
    url,
    headers,
    remoteAddress: freshClientIp(),
    ...(payload === undefined ? {} : { payload: payload as never }),
  });
const openTicket = (orderToken: string, subject = 'About my order') =>
  send('POST', '/store/v1/tickets', { orderToken, subject, message: 'Where is my code?' }, TURNSTILE_HEADERS);
const ticketByNumber = async (number: string) =>
  (await db.select().from(s.supportTickets).where(eq(s.supportTickets.number, number)))[0]!;
const threadOf = (ticketId: number) =>
  db.select().from(s.ticketMessages).where(eq(s.ticketMessages.ticketId, ticketId)).orderBy(asc(s.ticketMessages.id));

/** A card-paid order of a checkout the signed-in account opened itself. */
async function paidSignedInOrder(client: StoreClient, email: string): Promise<{ trackingToken: string }> {
  const { token } = await openSignedInCheckout(client, world, email);
  const started = await pay(t, token, undefined);
  expect(started.statusCode).toBe(201);
  const { payment } = json(started);
  const id = crypto.randomUUID().slice(0, 8);
  const body = storefrontEvent(`evt_signed_${id}`, payment.reference, {
    amount: payment.amount,
    currency: payment.currency,
    intent: `pi_signed_${id}`,
  });
  expect((await hook(t, clock, 'payments', world.gateway.code, body)).statusCode).toBe(200);
  const shown = json(await send('GET', `/store/v1/checkout-sessions/${token}`));
  expect(shown.status).toBe('paid');
  return { trackingToken: shown.trackingToken as string };
}

describe('the order link on the ticket form', () => {
  it('files the ticket of a guest checkout typed with a login account’s address under the guest row: proven by its link, with its token, and nothing in the account (decision 064)', async () => {
    const holder = await makeCustomer(t, { email: 'valerie.private@mail.example', name: 'Valerie Quillfeather' });
    const paid = await paidOrder(t, clock, world, { email: holder.email });
    const [order] = await db.select().from(s.orders).where(eq(s.orders.id, paid.orderId));
    expect(order!.accountId).not.toBe(holder.id);

    const res = await openTicket(paid.trackingToken, 'About my order');
    expect(res.statusCode).toBe(201);
    expect(typeof res.json().token).toBe('string');
    const ticket = await ticketByNumber(res.json().number);
    expect(ticket).toMatchObject({ requesterType: 'account', requesterId: order!.accountId, orderId: paid.orderId });
    expect(ticket.requesterProvenAt?.toISOString()).toBe(NOW);
    expect((await threadOf(ticket.id)).map((m) => [m.authorType, m.isInternal])).toEqual([['account', false]]);

    const account = await customerSession(t, holder.id);
    const list = await account.call('GET', '/store/v1/me/tickets');
    expect(list.status).toBe(200);
    expect((list.body as Array<{ number: string }>).map((row) => row.number)).not.toContain(ticket.number);
  });

  it('files the ticket of an order placed before decision 064 under the login account it was typed with, unconfirmed: no token, not in the account, a note for staff', async () => {
    const holder = await makeCustomer(t, { email: 'valerie.private@mail.example', name: 'Valerie Quillfeather' });
    const client = new StoreClient(t, freshClientIp());
    expect((await client.login(holder.email)).statusCode).toBe(200);
    const paid = await paidSignedInOrder(client, holder.email);
    // An order of the account whose checkout it did not open itself, as the old guest checkout made them.
    await db
      .update(s.checkoutSessions)
      .set({ openedSignedIn: false })
      .where(eq(s.checkoutSessions.accountId, holder.id));

    const res = await openTicket(paid.trackingToken, 'About my account');
    expect(res.statusCode).toBe(201);
    expect(res.json().token).toBeUndefined();
    const ticket = await ticketByNumber(res.json().number);
    expect(ticket).toMatchObject({ requesterType: 'account', requesterId: holder.id });
    expect(ticket.requesterProvenAt).toBeNull();
    const thread = await threadOf(ticket.id);
    expect(thread.map((m) => [m.authorType, m.isInternal])).toEqual([
      ['account', false],
      ['system', true],
    ]);
    expect(thread[1]!.body).toBe(UNPROVEN_TICKET_NOTE);

    const account = await customerSession(t, holder.id);
    const list = await account.call('GET', '/store/v1/me/tickets');
    expect(list.status).toBe(200);
    expect((list.body as Array<{ number: string }>).map((row) => row.number)).not.toContain(ticket.number);

    // The link mailed to the account's address confirms it, as for a typed address.
    const link = revealedToken(t, 'ticket', { enc: ticket.tokenEnc, plain: ticket.token }) as string;
    expect((await send('GET', `/store/v1/tickets/${link}`)).statusCode).toBe(200);
    expect((await ticketByNumber(ticket.number)).requesterProvenAt?.toISOString()).toBe(NOW);
    const after = await account.call('GET', '/store/v1/me/tickets');
    expect((after.body as Array<{ number: string }>).map((row) => row.number)).toContain(ticket.number);
  });

  it('speaks for the account when the account opened the checkout signed in: a proven ticket with its token', async () => {
    const customer = await makeCustomer(t, { name: 'Daniel Rivera' });
    const client = new StoreClient(t, freshClientIp());
    expect((await client.login(customer.email)).statusCode).toBe(200);
    const paid = await paidSignedInOrder(client, customer.email);

    const res = await openTicket(paid.trackingToken);
    expect(res.statusCode).toBe(201);
    const ticket = await ticketByNumber(res.json().number);
    expect(res.json().token).toBe(revealedToken(t, 'ticket', { enc: ticket.tokenEnc, plain: ticket.token }));
    expect(ticket.requesterId).toBe(customer.id);
    expect(ticket.requesterProvenAt?.toISOString()).toBe(NOW);
    expect((await threadOf(ticket.id)).map((m) => m.authorType)).toEqual(['account']);
    const list = await (await customerSession(t, customer.id)).call('GET', '/store/v1/me/tickets');
    expect((list.body as Array<{ number: string }>).map((row) => row.number)).toContain(ticket.number);
  });

  it('speaks for a customer with no account: a proven ticket with its token', async () => {
    const paid = await paidOrder(t, clock, world, { email: 'first.time@mail.example' });
    const res = await openTicket(paid.trackingToken);
    expect(res.statusCode).toBe(201);
    expect(typeof res.json().token).toBe('string');
    const ticket = await ticketByNumber(res.json().number);
    expect(ticket.requesterProvenAt?.toISOString()).toBe(NOW);
    expect((await threadOf(ticket.id)).map((m) => m.authorType)).toEqual(['account']);
  });

  it('opens nothing for the order of an anonymized account: 422 on orderToken and no ticket', async () => {
    const paid = await paidOrder(t, clock, world, { email: 'erin.erased@mail.example' });
    const [order] = await db.select().from(s.orders).where(eq(s.orders.id, paid.orderId));
    const privacy = await adminWith(t, ['customers:privacy']);
    expect((await privacy.post(`/admin/clients/${order!.accountId}/anonymize`)).status).toBeLessThan(300);

    const res = await openTicket(paid.trackingToken);
    expect(res.statusCode).toBe(422);
    expect(res.json().errors).toEqual([expect.objectContaining({ field: 'orderToken', code: 'unknown_order' })]);
    expect(await db.select().from(s.supportTickets)).toHaveLength(0);
  });
});

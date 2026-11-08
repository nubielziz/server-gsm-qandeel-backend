// Integration tests of the storefront support routes (feature 17): POST /store/v1/tickets, GET /store/v1/tickets/:token,
// POST /store/v1/tickets/:token/messages and POST /store/v1/tickets/:token/csat against the real API: the anti-bot check, the guest
// customer, the order link, the ticket token, the reopen on a customer message, and the rating once.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { eq } from 'drizzle-orm';
import { CacheKeys } from '../../src/infra/cache';
import { schema as s } from '../../src/infra/db';
import { RedisService } from '../../src/infra/redis';
import type { TicketCategory, TicketPriority } from '../../src/modules/support/db/schema';
import { type TestApp, createTestApp } from '../support/app';
import { clearIdentityCaches } from '../support/auth';
import { TestClock } from '../support/clock';
import { insertCategory, insertService } from '../support/catalog';
import { closeTestDb, resetDb, testDb } from '../support/db';
import { mailbox, notificationRows } from '../support/notifications';
import { insertOrderRow } from '../support/orders';
import { freshClientIp } from '../support/pipeline-routes';
import { TURNSTILE_HEADERS, insertCurrency } from '../support/storefront';
import {
  clearTicketEmailLimits,
  insertClient,
  insertCustomer,
  insertSupportMessage,
  insertSupportTicket,
  seedSupportTemplates,
  sendTicketMails,
  supportStaff,
  ticketMailEvents,
} from '../support/support';

const NOW = '2026-11-08T12:00:00.000Z';
const HOUR = 3_600_000;
const clock = new TestClock(NOW);
let t: TestApp;

beforeAll(async () => {
  t = await createTestApp({ clock });
});
beforeEach(async () => {
  clock.set(NOW);
  await resetDb();
  await clearIdentityCaches(t);
  // The tests open many tickets from the same few addresses: the 3-an-hour counters of the Redis outlive them.
  await clearTicketEmailLimits(t);
  const { db } = await testDb();
  await seedSupportTemplates(db);
  mailbox(t).reset();
});
afterAll(async () => {
  await resetDb();
  await clearIdentityCaches(t);
  await t.close();
  await closeTestDb();
});

// Every call comes from its own address: the per-IP limits (300 a minute, 30 for token lookups) must not decide these tests.
const send = (method: 'GET' | 'POST', url: string, payload?: unknown, headers: Record<string, string> = {}) =>
  t.app.inject({
    method,
    url,
    headers,
    remoteAddress: freshClientIp(),
    ...(payload === undefined ? {} : { payload: payload as never }),
  });
const open = (payload: unknown, headers: Record<string, string> = TURNSTILE_HEADERS) =>
  send('POST', '/store/v1/tickets', payload, headers);
const show = (token: string) => send('GET', `/store/v1/tickets/${token}`);
const write = (token: string, payload: unknown) => send('POST', `/store/v1/tickets/${token}/messages`, payload);
const rate = (token: string, payload: unknown) => send('POST', `/store/v1/tickets/${token}/csat`, payload);
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- test bodies are untyped JSON
const body = (res: { json: () => any }): any => res.json();
const ticketRow = async (token: string) =>
  (await (await testDb()).db.select().from(s.supportTickets).where(eq(s.supportTickets.token, token)))[0]!;
const ticketByNumber = async (number: string) =>
  (await (await testDb()).db.select().from(s.supportTickets).where(eq(s.supportTickets.number, number)))[0]!;
/**
 * Opens a ticket by email and reads its token from the table. The 201 of the email path carries none (the receipt link is the only way
 * in), so a test that goes on to use the ticket takes the token the way the visitor does: from the row the link was made from.
 */
const openByEmail = async (payload: unknown = VALID) => {
  const res = await open(payload);
  expect(res.statusCode).toBe(201);
  return { ...body(res), token: (await ticketByNumber(body(res).number)).token as string };
};

const TRACKING_TOKEN = 'T7kq2Zp9Xw4Ld1Hn6Rb3Yc';
const VALID = {
  email: 'Victor@Mail.Example',
  subject: 'Where is my unlock?',
  message: 'I paid yesterday and still have no code.',
};

/** A storefront order of a customer, with its tracking token. */
async function trackedOrder(token = TRACKING_TOKEN, email = 'victor@mail.example') {
  const { db } = await testDb();
  await insertCurrency(db, { code: 'USD' });
  const customer = await insertCustomer(db, { name: 'Victor Hale', email });
  const serviceId = await insertService(db, await insertCategory(db));
  const order = await insertOrderRow(db, { serviceId, customerId: customer.id, source: 'store', publicToken: token });
  return { db, customer, order };
}

describe('POST /store/v1/tickets', () => {
  it('opens a ticket for a first-time visitor: a guest customer, the category’s priority and target, the first message, a receipt', async () => {
    const res = await open({ ...VALID, name: ' Victor ', category: 'failed_unlock' });
    expect(res.statusCode).toBe(201);
    const ticket = body(res);
    expect(res.headers['cache-control']).toBe('no-store');
    // The email path answers without the ticket token: only the receipt link holds it (see 'keeps the token out of...' below).
    expect(ticket).not.toHaveProperty('token');
    expect(ticket).toMatchObject({
      subject: 'Where is my unlock?',
      category: 'failed_unlock',
      status: 'new',
      orderId: null,
      createdAt: NOW,
      updatedAt: NOW,
      resolvedAt: null,
      csatScore: null,
      canRate: false,
    });
    expect(ticket.number).toMatch(/^T-\d+$/);
    expect(ticket.messages).toEqual([
      { id: expect.any(Number), from: 'you', body: 'I paid yesterday and still have no code.', createdAt: NOW },
    ]);

    const { db } = await testDb();
    const [customer] = await db.select().from(s.customers);
    expect(customer).toMatchObject({
      email: 'victor@mail.example',
      name: 'Victor',
      hasAccount: false,
      status: 'active',
    });
    const row = await ticketByNumber(ticket.number);
    expect(row.token).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(row).toMatchObject({
      requesterType: 'customer',
      requesterId: customer!.id,
      channel: 'web',
      status: 'new',
      priority: 'high',
      assigneeId: null,
      orderId: null,
    });
    // failed_unlock is high: the customer's message is due an answer in 2 hours.
    expect(row.slaDueAt?.toISOString()).toBe('2026-11-08T14:00:00.000Z');
    expect(row.number).toBe(`T-${row.id}`);

    // The receipt is an outbox event with ids only; the job makes the notification row (without the link) and sends the mail.
    expect(await ticketMailEvents(db)).toEqual([
      expect.objectContaining({ aggregateId: row.id, payload: expect.objectContaining({ kind: 'received' }) }),
    ]);
    expect(await notificationRows(db)).toHaveLength(0);
    expect(await sendTicketMails(t)).toEqual([{ sent: true }]);
    const [notification] = await notificationRows(db);
    expect(notification).toMatchObject({
      event: 'support.ticket_received',
      recipientType: 'customer',
      channel: 'email',
      status: 'sent',
    });
    expect(JSON.stringify(notification!.payload)).not.toContain(row.token!);
    const [mail] = mailbox(t).sent;
    expect(mail).toMatchObject({ to: 'victor@mail.example', subject: `We got your message (${ticket.number})` });
    expect(mail!.text).toContain('Hi Victor,');
    // The link is built from STORE_BASE_URL (the development default here).
    expect(mail!.text).toContain(`http://localhost:5175/support/tickets/${row.token}`);
  });

  it('reuses the customer of a known address (any case) and makes a ticket for each request', async () => {
    const { db } = await testDb();
    const known = await insertCustomer(db, { email: 'victor@mail.example', name: 'Victor Hale' });
    await open(VALID);
    await open({ ...VALID, email: 'VICTOR@mail.example', name: 'Someone else' });
    expect(await db.select().from(s.customers)).toHaveLength(1);
    const tickets = await db.select().from(s.supportTickets);
    expect(tickets).toHaveLength(2);
    expect(new Set(tickets.map((ticket) => ticket.requesterId))).toEqual(new Set([known.id]));
    expect(new Set(tickets.map((ticket) => ticket.token)).size).toBe(2);
    // The name a stranger types never renames the customer.
    expect((await db.select().from(s.customers))[0]!.name).toBe('Victor Hale');
  });

  it('makes one guest for two first tickets from one new address at once', async () => {
    const results = await Promise.all([
      open({ ...VALID, email: 'new@mail.example' }),
      open({ ...VALID, email: 'new@mail.example' }),
    ]);
    expect(results.map((res) => res.statusCode)).toEqual([201, 201]);
    const { db } = await testDb();
    expect(await db.select().from(s.customers)).toHaveLength(1);
    expect(await db.select().from(s.supportTickets)).toHaveLength(2);
  });

  it('keeps the token out of the answer on the email path, for a known address and a new one alike, and the receipt carries the link', async () => {
    const { db } = await testDb();
    const known = await insertCustomer(db, { email: 'victor@mail.example', name: 'Victor Hale' });
    // A stranger who knows the customer's address files a ticket under that customer.
    const stranger = await open({ ...VALID, name: 'Not Victor' });
    const fresh = await open({ ...VALID, email: 'new@mail.example' });
    for (const res of [stranger, fresh]) {
      expect(res.statusCode).toBe(201);
      expect(body(res)).not.toHaveProperty('token');
      expect(Object.keys(body(res)).sort()).toEqual(
        [
          'canRate',
          'category',
          'createdAt',
          'csatScore',
          'messages',
          'number',
          'orderId',
          'resolvedAt',
          'status',
          'subject',
          'updatedAt',
        ].sort(),
      );
    }
    const rows = await db.select().from(s.supportTickets).orderBy(s.supportTickets.id);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ requesterId: known.id, number: body(stranger).number });
    // The token is nowhere in what the stranger got: not the body, not a header, and no route accepts the ticket number instead.
    for (const [res, row] of [
      [stranger, rows[0]!],
      [fresh, rows[1]!],
    ] as const) {
      expect(res.payload).not.toContain(row.token!);
      expect(JSON.stringify(res.headers)).not.toContain(row.token!);
    }
    expect((await show(body(stranger).number)).statusCode).toBe(404);
    // The owner of the address still gets in: the receipt mail holds the link.
    expect(await sendTicketMails(t)).toEqual([{ sent: true }, { sent: true }]);
    const [first, second] = mailbox(t).sent;
    expect(first!.to).toBe('victor@mail.example');
    expect(first!.text).toContain(`http://localhost:5175/support/tickets/${rows[0]!.token}`);
    expect(second!.to).toBe('new@mail.example');
    expect(second!.text).toContain(`http://localhost:5175/support/tickets/${rows[1]!.token}`);
    expect((await show(rows[0]!.token!)).statusCode).toBe(200);
  });

  it('hands the token over on the order-token path only, where the caller already holds the order link', async () => {
    const { db } = await trackedOrder();
    const res = await open({ subject: 'Delay', message: 'Still waiting.', orderToken: TRACKING_TOKEN });
    expect(res.statusCode).toBe(201);
    const row = await ticketByNumber(body(res).number);
    expect(body(res).token).toBe(row.token);
    expect((await show(body(res).token)).statusCode).toBe(200);
    // An email typed next to the order token changes nothing: the order link is the proof.
    const both = await open({
      subject: 'Delay',
      message: 'Again.',
      orderToken: TRACKING_TOKEN,
      email: 'x@mail.example',
    });
    expect(body(both).token).toBe((await ticketByNumber(body(both).number)).token);
    expect(await db.select().from(s.supportTickets)).toHaveLength(2);
  });

  it('links the ticket to the order and its customer when the tracking token is given, whatever email is typed', async () => {
    const { db, customer, order } = await trackedOrder();
    const res = await open({
      subject: 'Delay (SF-1)',
      message: 'Still waiting.',
      category: 'delay',
      orderToken: TRACKING_TOKEN,
      email: 'someone-else@mail.example',
    });
    expect(res.statusCode).toBe(201);
    expect(body(res).orderId).toBe(order.id);
    const row = await ticketRow(body(res).token);
    expect(row).toMatchObject({ orderId: order.id, requesterId: customer.id, priority: 'normal' });
    // delay is normal: due 8 hours after the message.
    expect(row.slaDueAt?.toISOString()).toBe('2026-11-08T20:00:00.000Z');
    expect(await db.select().from(s.customers)).toHaveLength(1);
    await sendTicketMails(t);
    expect(mailbox(t).sent[0]!.to).toBe('victor@mail.example');
  });

  it('refuses a tracking token that names no storefront order, on orderToken, and a merchant order never matches', async () => {
    const { db } = await testDb();
    await insertCurrency(db, { code: 'USD' });
    const merchant = await insertClient(db);
    await insertOrderRow(db, {
      serviceId: await insertService(db, await insertCategory(db)),
      clientId: merchant.id,
      publicToken: 'M7kq2Zp9Xw4Ld1Hn6Rb3Yc',
    });
    for (const orderToken of ['Unknown7kq2Zp9Xw4Ld1Hn', 'M7kq2Zp9Xw4Ld1Hn6Rb3Yc', 'short']) {
      const res = await open({ subject: 'Hi', message: 'Hello', orderToken });
      expect(res.statusCode).toBe(422);
      expect(body(res).errors).toEqual([expect.objectContaining({ field: 'orderToken' })]);
    }
    expect(await db.select().from(s.supportTickets)).toHaveLength(0);
  });

  it('gives the other categories their priority and defaults to other', async () => {
    const priorities: Array<[TicketCategory | undefined, TicketPriority]> = [
      [undefined, 'low'],
      ['presale', 'low'],
      ['howto', 'low'],
      ['billing', 'normal'],
      ['wrong_imei', 'normal'],
      ['refund', 'high'],
    ];
    for (const [n, [category, priority]] of priorities.entries()) {
      // One address per ticket: an address may open only 3 an hour.
      const res = await open({
        ...VALID,
        email: `visitor${n}@mail.example`,
        ...(category === undefined ? {} : { category }),
      });
      expect(body(res).category).toBe(category ?? 'other');
      expect((await ticketByNumber(body(res).number)).priority).toBe(priority);
    }
  });

  it('needs an email or an order token, a subject and a message, and the anti-bot token', async () => {
    const noEmail = await open({ subject: 'Hi', message: 'Hello' });
    expect(noEmail.statusCode).toBe(422);
    expect(body(noEmail).errors).toEqual([
      expect.objectContaining({ field: 'email', message: 'Enter your email address.' }),
    ]);
    const empty = await open({ email: 'not-an-email', subject: '  ', message: '' });
    expect(empty.statusCode).toBe(422);
    expect(
      body(empty)
        .errors.map((error: { field: string }) => error.field)
        .sort(),
    ).toEqual(['email', 'message', 'subject']);
    expect((await open({ ...VALID, category: 'nope' })).statusCode).toBe(422);
    expect((await open({ ...VALID, message: 'x'.repeat(4001) })).statusCode).toBe(422);
    const badHeaders: Array<Record<string, string>> = [{}, { 'x-turnstile-token': 'wrong' }];
    for (const headers of badHeaders) {
      const res = await open(VALID, headers);
      expect(res.statusCode).toBe(403);
      expect(body(res).code).toBe('TURNSTILE_FAILED');
    }
    const { db } = await testDb();
    expect(await db.select().from(s.supportTickets)).toHaveLength(0);
    expect(await db.select().from(s.customers)).toHaveLength(0);
  });

  it('lets one email address open 3 tickets an hour in any case, then answers 429 RATE_LIMITED with Retry-After and writes nothing', async () => {
    for (const email of ['relay@mail.example', 'Relay@Mail.Example', 'RELAY@MAIL.EXAMPLE']) {
      expect((await open({ ...VALID, email })).statusCode).toBe(201);
    }
    const { db } = await testDb();
    const refused = await open({ ...VALID, email: 'relay@MAIL.example', subject: 'Win a prize' });
    expect(refused.statusCode).toBe(429);
    expect(body(refused).code).toBe('RATE_LIMITED');
    const retryAfter = Number(refused.headers['retry-after']);
    expect(retryAfter).toBeGreaterThan(0);
    expect(retryAfter).toBeLessThanOrEqual(3600);
    // The refused call left no ticket and no receipt behind: three tickets, three receipts, one customer.
    const tickets = await db.select().from(s.supportTickets);
    expect(tickets).toHaveLength(3);
    expect(tickets.map((ticket) => ticket.subject)).not.toContain('Win a prize');
    expect(await ticketMailEvents(db)).toHaveLength(3);
    expect(await db.select().from(s.customers)).toHaveLength(1);

    // Another address has its own budget, and the counter key holds no address.
    expect((await open({ ...VALID, email: 'other@mail.example' })).statusCode).toBe(201);
    const redis = t.app.get(RedisService).cache;
    const keys = await redis.keys(`${t.app.get(CacheKeys).rateLimit('ticket-email')}:*`);
    expect(keys).toHaveLength(2);
    expect(keys.join(' ')).not.toContain('mail.example');
  });

  it('does not count the order-token path against the email limit, where the receipt goes to the order’s own customer', async () => {
    await trackedOrder();
    for (let n = 0; n < 4; n += 1) {
      const res = await open({ subject: 'Where is it?', message: 'Still waiting.', orderToken: TRACKING_TOKEN });
      expect(res.statusCode).toBe(201);
    }
    expect((await open({ ...VALID, email: 'victor@mail.example' })).statusCode).toBe(201);
  });

  it('sends no receipt when the template is off or the customer was anonymized, and still opens the ticket', async () => {
    const { db } = await testDb();
    await db
      .update(s.notificationTemplates)
      .set({ isActive: false })
      .where(eq(s.notificationTemplates.event, 'support.ticket_received'));
    expect((await open(VALID)).statusCode).toBe(201);
    expect(await sendTicketMails(t)).toEqual([{ sent: false, skipped: 'template_off' }]);
    expect(await notificationRows(db)).toHaveLength(0);
    await db.update(s.notificationTemplates).set({ isActive: true });
    await db.delete(s.outboxEvents);
    const { order, customer } = await trackedOrder(TRACKING_TOKEN, 'gone@mail.example');
    await db
      .update(s.customers)
      .set({ status: 'anonymized', name: 'Deleted customer', email: 'deleted-1@redacted.invalid' })
      .where(eq(s.customers.id, customer.id));
    const res = await open({ subject: 'Hi', message: 'Hello', orderToken: TRACKING_TOKEN });
    expect(res.statusCode).toBe(201);
    expect(body(res).orderId).toBe(order.id);
    // The job re-reads the customer: an anonymized one has no address, so nothing is sent.
    expect(await ticketMailEvents(db)).toHaveLength(1);
    expect(await sendTicketMails(t)).toEqual([{ sent: false, skipped: 'recipient_gone' }]);
    expect(await notificationRows(db)).toHaveLength(0);
    expect(mailbox(t).sent).toHaveLength(0);
  });
});

describe('GET /store/v1/tickets/:token', () => {
  it('shows the conversation without internal notes or system messages, staff as support, and no staff name or timer', async () => {
    const opened = await openByEmail(VALID);
    const { db } = await testDb();
    const row = await ticketRow(opened.token);
    const staff = await supportStaff(t);
    await insertSupportMessage(db, row.id, {
      authorType: 'staff',
      authorId: staff.staffId,
      body: 'Checking.',
      createdAt: new Date(clock.nowMs() + 60_000),
    });
    await insertSupportMessage(db, row.id, {
      authorType: 'staff',
      authorId: staff.staffId,
      body: 'Secret note.',
      isInternal: true,
      createdAt: new Date(clock.nowMs() + 120_000),
    });
    await insertSupportMessage(db, row.id, {
      authorType: 'system',
      body: 'Marked resolved by Lina S..',
      isInternal: true,
      createdAt: new Date(clock.nowMs() + 180_000),
    });
    const res = await show(opened.token);
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    const ticket = body(res);
    expect(ticket.messages.map((message: { from: string; body: string }) => [message.from, message.body])).toEqual([
      ['you', 'I paid yesterday and still have no code.'],
      ['support', 'Checking.'],
    ]);
    expect(Object.keys(ticket).sort()).toEqual([
      'canRate',
      'category',
      'createdAt',
      'csatScore',
      'messages',
      'number',
      'orderId',
      'resolvedAt',
      'status',
      'subject',
      'updatedAt',
    ]);
    expect(JSON.stringify(ticket)).not.toContain('Lina');
  });

  it('answers the same 404 for an unknown, a wrong and a malformed token', async () => {
    const opened = await openByEmail(VALID);
    const wrong = `${opened.token.slice(0, -1)}${opened.token.endsWith('A') ? 'B' : 'A'}`;
    const answers = await Promise.all(['Zk3b0jY8mQe1xVn7hT2cLw', wrong, 'x', `${opened.token}!`].map(show));
    for (const res of answers) {
      expect(res.statusCode).toBe(404);
      expect(body(res).code).toBe('NOT_FOUND');
      expect(body(res).detail).toBe('This link is not valid.');
    }
    expect((await show(opened.token)).statusCode).toBe(200);
  });

  it('shows pending as the status of a ticket that waits on the customer, and the rating form once resolved', async () => {
    const opened = await openByEmail(VALID);
    const { db } = await testDb();
    await db
      .update(s.supportTickets)
      .set({ status: 'pending_customer', slaDueAt: null })
      .where(eq(s.supportTickets.token, opened.token));
    expect(body(await show(opened.token)).status).toBe('pending');
    await db
      .update(s.supportTickets)
      .set({ status: 'resolved', resolvedAt: new Date(clock.nowMs()) })
      .where(eq(s.supportTickets.token, opened.token));
    expect(body(await show(opened.token))).toMatchObject({ status: 'resolved', canRate: true, resolvedAt: NOW });
  });
});

describe('POST /store/v1/tickets/:token/messages', () => {
  it('adds the customer’s message, restarts the reply target and keeps a new ticket new', async () => {
    const opened = await openByEmail({ ...VALID, category: 'delay' });
    clock.advance(HOUR);
    const res = await write(opened.token, { body: '  Any news?  ' });
    expect(res.statusCode).toBe(201);
    expect(body(res)).toEqual({
      id: expect.any(Number),
      from: 'you',
      body: 'Any news?',
      createdAt: '2026-11-08T13:00:00.000Z',
    });
    const row = await ticketRow(opened.token);
    expect(row.status).toBe('new');
    expect(row.slaDueAt?.toISOString()).toBe('2026-11-08T21:00:00.000Z');
    expect(row.updatedAt.toISOString()).toBe('2026-11-08T13:00:00.000Z');
    const { db } = await testDb();
    const messages = await db
      .select()
      .from(s.ticketMessages)
      .where(eq(s.ticketMessages.ticketId, row.id))
      .orderBy(s.ticketMessages.id);
    expect(messages.map((message) => [message.authorType, message.authorId, message.isInternal])).toEqual([
      ['customer', row.requesterId, false],
      ['customer', row.requesterId, false],
    ]);
  });

  it('makes a ticket that waited on the customer open again, and reopens a resolved one (resolved_at cleared)', async () => {
    const opened = await openByEmail(VALID);
    const { db } = await testDb();
    await db
      .update(s.supportTickets)
      .set({ status: 'pending_customer', slaDueAt: null, assigneeId: null })
      .where(eq(s.supportTickets.token, opened.token));
    await write(opened.token, { body: 'Here is the photo.' });
    expect((await ticketRow(opened.token)).status).toBe('open');
    expect((await ticketRow(opened.token)).slaDueAt).not.toBeNull();

    await db
      .update(s.supportTickets)
      .set({ status: 'resolved', resolvedAt: new Date(clock.nowMs()), slaDueAt: null })
      .where(eq(s.supportTickets.token, opened.token));
    clock.advance(HOUR);
    expect((await write(opened.token, { body: 'It is still locked.' })).statusCode).toBe(201);
    const row = await ticketRow(opened.token);
    expect(row).toMatchObject({ status: 'open', resolvedAt: null });
    // No category was given: other is low, due 24 hours after this message.
    expect(row.slaDueAt?.toISOString()).toBe('2026-11-09T13:00:00.000Z');
    const staff = await supportStaff(t);
    expect((await staff.get(`/admin/support-tickets/${row.id}`)).body).toMatchObject({
      status: 'open',
      resolvedAt: null,
      lastPublicAt: '2026-11-08T13:00:00.000Z',
    });
  });

  it('refuses an empty message, answers 404 for a wrong token, and never touches another ticket', async () => {
    const mine = await openByEmail(VALID);
    const other = await openByEmail({ ...VALID, email: 'other@mail.example' });
    const empty = await write(mine.token, { body: '   ' });
    expect(empty.statusCode).toBe(422);
    expect(body(empty).errors).toEqual([expect.objectContaining({ field: 'body', message: 'Write your message.' })]);
    expect((await write('Zk3b0jY8mQe1xVn7hT2cLw', { body: 'Hi' })).statusCode).toBe(404);
    await write(mine.token, { body: 'Mine' });
    expect(body(await show(other.token)).messages).toHaveLength(1);
    expect(body(await show(mine.token)).messages).toHaveLength(2);
  });
});

describe('POST /store/v1/tickets/:token/csat', () => {
  /** A resolved ticket, as the staff console resolves it. */
  async function resolvedTicket() {
    const opened = await openByEmail(VALID);
    const staff = await supportStaff(t);
    const row = await ticketRow(opened.token);
    expect((await staff.patch(`/admin/support-tickets/${row.id}`, { status: 'resolved' })).status).toBe(200);
    return opened.token as string;
  }

  it('records the rating once after the ticket is resolved, and the ticket stays resolved', async () => {
    const token = await resolvedTicket();
    expect(body(await show(token))).toMatchObject({ status: 'resolved', canRate: true, csatScore: null });
    clock.advance(HOUR);
    const res = await rate(token, { score: 5 });
    expect(res.statusCode).toBe(200);
    expect(body(res)).toMatchObject({ status: 'resolved', csatScore: 5, canRate: false });
    const row = await ticketRow(token);
    expect(row.csatScore).toBe(5);
    expect(row.status).toBe('resolved');
    // The rating is not activity: the inbox order does not change.
    expect(row.updatedAt.toISOString()).toBe(NOW);
  });

  it('refuses a rating before the resolve and a second rating, on score', async () => {
    const opened = await openByEmail(VALID);
    const early = await rate(opened.token, { score: 4 });
    expect(early.statusCode).toBe(422);
    expect(body(early).errors).toEqual([expect.objectContaining({ field: 'score', code: 'not_resolved' })]);
    const token = await resolvedTicket();
    expect((await rate(token, { score: 4 })).statusCode).toBe(200);
    const again = await rate(token, { score: 1 });
    expect(again.statusCode).toBe(422);
    expect(body(again).errors).toEqual([expect.objectContaining({ field: 'score', code: 'already_rated' })]);
    expect((await ticketRow(token)).csatScore).toBe(4);
  });

  it('takes only a whole number from 1 to 5 and answers 404 for a wrong token', async () => {
    const token = await resolvedTicket();
    for (const score of [0, 6, 2.5, '5', null]) {
      const res = await rate(token, { score });
      expect(res.statusCode).toBe(422);
      expect(body(res).errors).toEqual([expect.objectContaining({ field: 'score' })]);
    }
    expect((await rate(token, {})).statusCode).toBe(422);
    expect((await rate('Zk3b0jY8mQe1xVn7hT2cLw', { score: 5 })).statusCode).toBe(404);
    expect((await ticketRow(token)).csatScore).toBeNull();
  });

  it('records exactly one of two ratings sent at once', async () => {
    const token = await resolvedTicket();
    const results = await Promise.all([rate(token, { score: 5 }), rate(token, { score: 1 })]);
    expect(results.map((res) => res.statusCode).sort()).toEqual([200, 422]);
    const score = (await ticketRow(token)).csatScore;
    expect([1, 5]).toContain(score as number);
  });
});

describe('the ticket token', () => {
  it('is limited to 30 lookups a minute per address, like the other capability tokens', async () => {
    const opened = await openByEmail(VALID);
    const address = freshClientIp();
    const statuses: number[] = [];
    for (let n = 0; n < 31; n += 1) {
      statuses.push(
        (await t.app.inject({ method: 'GET', url: `/store/v1/tickets/${opened.token}`, remoteAddress: address }))
          .statusCode,
      );
    }
    expect(statuses.slice(0, 30).every((status) => status === 200)).toBe(true);
    expect(statuses[30]).toBe(429);
  });

  it('never opens a ticket that has no token (a merchant’s ticket)', async () => {
    const { db } = await testDb();
    const merchant = await insertClient(db);
    await insertSupportTicket(db, { requesterType: 'client', requesterId: merchant.id, token: null });
    expect((await show('0000000000000000000000')).statusCode).toBe(404);
  });
});

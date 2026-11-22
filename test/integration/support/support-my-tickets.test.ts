// Integration tests of a signed-in customer's own tickets (feature 28, slice B2, plan § 3.2 routes 6 and 7 and § 7): the list with the link
// token of each ticket (the ones filed as a guest with the same address included), opening a ticket without Turnstile, the order and file
// checks, the ticket-open limit and the token opening the existing ticket page. Real Postgres and Redis, with a test clock.
import { afterAll, beforeAll, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import { eq, sql } from 'drizzle-orm';
import { schema as s } from '@src/infra/db';
import { TicketEvents } from '@src/modules/support/application/ticket-events';
import { type AdminApi } from '../../support/admin-api';
import { type TestApp, createTestApp } from '../../support/app';
import { clearIdentityCaches, insertMerchant } from '../../support/auth';
import { insertCategory, insertService } from '../../support/catalog';
import { MINUTE, TestClock } from '../../support/clock';
import { insertCustomerOrder } from '../../support/customers';
import { tokenHashOf } from '../../support/capability-tokens';
import { closeTestDb, resetDb, testDb } from '../../support/db';
import { merchantSession } from '../../support/notifications';
import { insertOrderRow } from '../../support/orders';
import { freshClientIp } from '../../support/pipeline-routes';
import { makeCustomer } from '../../support/store';
import { TURNSTILE_HEADERS, insertCurrency } from '../../support/storefront';
import {
  clearTicketChatLimits,
  clearTicketEmailLimits,
  insertSupportMessage,
  insertSupportTicket,
  seedSupportTemplates,
  supportStaff,
  ticketMailEvents,
} from '../../support/support';
import { clearTicketOpenLimits, customerSession, insertFileRow } from '../../support/support-accounts';

const NOW = '2026-11-15T10:00:00.000Z';
const clock = new TestClock(NOW);
let t: TestApp;
let staff: AdminApi;

beforeAll(async () => {
  t = await createTestApp({ clock });
});
beforeEach(async () => {
  clock.set(NOW);
  await resetDb();
  await seedSupportTemplates((await testDb()).db);
  await clearIdentityCaches(t);
  await clearTicketChatLimits(t);
  await clearTicketOpenLimits(t);
  await clearTicketEmailLimits(t);
  staff = await supportStaff(t, ['support:*'], 'Lina S.');
});
afterAll(async () => {
  await resetDb();
  await clearIdentityCaches(t);
  await t.close();
  await closeTestDb();
});

/** A customer with an account and a signed-in session. */
async function customer(overrides: Parameters<typeof makeCustomer>[1] = {}) {
  const made = await makeCustomer(t, { name: 'Victor Hale', ...overrides });
  return { ...made, session: await customerSession(t, made.id) };
}

/** Changes columns of a ticket without letting the table's `$onUpdate` stamp `updated_at` with the wall clock. */
async function patchTicket(ticketId: number, values: Partial<typeof s.supportTickets.$inferInsert>) {
  const { db } = await testDb();
  await db
    .update(s.supportTickets)
    .set({ updatedAt: sql`${s.supportTickets.updatedAt}`, ...values })
    .where(eq(s.supportTickets.id, ticketId));
}

/** A customer's ticket (with a link token) and its first message, `minutes` before the clock's now. */
async function customerTicket(
  customerId: number,
  values: Partial<typeof s.supportTickets.$inferInsert> = {},
  minutes = 30,
) {
  const { db } = await testDb();
  const at = new Date(clock.nowMs() - minutes * MINUTE);
  const ticket = await insertSupportTicket(db, {
    requesterId: customerId,
    status: 'open',
    createdAt: at,
    updatedAt: at,
    ...values,
  });
  const first = await insertSupportMessage(db, ticket.id, {
    authorType: 'customer',
    authorId: customerId,
    body: 'I paid yesterday and still have no code.',
    createdAt: at,
  });
  await patchTicket(ticket.id, { lastRequesterMessageId: first.id });
  return { ticket: { ...ticket, token: ticket.token! }, first };
}

const replyAsStaff = async (ticketId: number, body: string) => {
  const res = await staff.post(`/admin/support-tickets/${ticketId}/reply`, { body });
  expect(res.status).toBe(201);
  return res.body.id as number;
};

/** A call on the ticket page, by link token. */
const onPage = (method: 'GET' | 'POST', token: string, path = '', payload?: unknown) =>
  t.app.inject({
    method,
    url: `/store/v1/tickets/${token}${path}`,
    remoteAddress: freshClientIp(),
    ...(payload === undefined ? {} : { payload: payload as never }),
  });

const errorOf = (answer: { body: { errors?: { field: string; code: string }[] } }) => answer.body.errors?.[0];

describe('GET /store/v1/me/tickets', () => {
  it('lists the customer’s own tickets, newest activity first, each with its link token; the token opens the ticket page', async () => {
    const mine = await customer();
    const other = await customer({ name: 'Someone Else' });
    const { db } = await testDb();
    const older = await customerTicket(mine.id, { subject: 'Older one', category: 'billing' }, 120);
    const newer = await customerTicket(mine.id, { subject: 'Newer one' }, 10);
    await customerTicket(other.id, { subject: 'Not mine' });
    // A merchant's ticket whose requester id equals the customer's id is not the customer's.
    await insertSupportTicket(db, {
      requesterType: 'client',
      requesterId: mine.id,
      token: null,
      subject: 'A merchant',
    });
    // A ticket whose link was cleared (an erasure) has no page to open and is not listed.
    await customerTicket(mine.id, { subject: 'No link', token: null });
    const reply = await replyAsStaff(older.ticket.id, 'Your code is on its way.');
    // A note after the reply never counts as the last message.
    await insertSupportMessage(db, older.ticket.id, {
      authorType: 'staff',
      authorId: staff.staffId,
      body: 'Internal: refund approved.',
      isInternal: true,
      createdAt: new Date(clock.nowMs()),
    });

    const res = await mine.session.call('GET', '/store/v1/me/tickets');
    expect(res.status).toBe(200);
    expect(res.res.headers['cache-control']).toBe('no-store');
    expect(res.res.headers['x-total-count']).toBe('2');
    expect(res.body).toEqual([
      {
        number: older.ticket.number,
        subject: 'Older one',
        category: 'billing',
        status: 'pending',
        orderId: null,
        createdAt: new Date(clock.nowMs() - 120 * MINUTE).toISOString(),
        updatedAt: NOW,
        lastMessageAt: NOW,
        lastMessageFrom: 'support',
        hasUnread: true,
        token: older.ticket.token,
      },
      {
        number: newer.ticket.number,
        subject: 'Newer one',
        category: 'other',
        status: 'open',
        orderId: null,
        createdAt: new Date(clock.nowMs() - 10 * MINUTE).toISOString(),
        updatedAt: new Date(clock.nowMs() - 10 * MINUTE).toISOString(),
        lastMessageAt: new Date(clock.nowMs() - 10 * MINUTE).toISOString(),
        lastMessageFrom: 'you',
        hasUnread: false,
        token: newer.ticket.token,
      },
    ]);
    expect(JSON.stringify(res.body)).not.toContain('Lina');
    // The token of a row opens the existing ticket page and shows the same thread.
    const page = await onPage('GET', res.body[0].token);
    expect(page.statusCode).toBe(200);
    expect(page.json()).toMatchObject({
      number: older.ticket.number,
      messages: [{ from: 'you' }, { id: reply, from: 'support', body: 'Your code is on its way.' }],
    });
  });

  it('lists the ticket a visitor filed with the customer’s address on the public form', async () => {
    const mine = await customer({ email: 'victor@mail.example' });
    const filed = await t.app.inject({
      method: 'POST',
      url: '/store/v1/tickets',
      headers: TURNSTILE_HEADERS,
      remoteAddress: freshClientIp(),
      payload: { email: 'Victor@Mail.Example', subject: 'Filed as a guest', message: 'Hello from the contact page.' },
    });
    expect(filed.statusCode).toBe(201);
    const res = await mine.session.call('GET', '/store/v1/me/tickets');
    expect(res.body).toHaveLength(1);
    expect(res.body[0]).toMatchObject({
      subject: 'Filed as a guest',
      status: 'new',
      lastMessageFrom: 'you',
      hasUnread: false,
    });
    expect((await onPage('GET', res.body[0].token)).statusCode).toBe(200);
  });

  it('filters by status, sorts, pages with an exact total and refuses what it does not offer', async () => {
    const mine = await customer();
    await customerTicket(mine.id, { subject: 'A', status: 'open' }, 90);
    await customerTicket(mine.id, { subject: 'B', status: 'pending_customer' }, 60);
    await customerTicket(mine.id, { subject: 'C', status: 'resolved' }, 30);
    const subjects = (answer: { body: { subject: string }[] }) => answer.body.map((row) => row.subject);

    expect(subjects(await mine.session.call('GET', '/store/v1/me/tickets?status=pending'))).toEqual(['B']);
    expect(
      subjects(
        await mine.session.call('GET', '/store/v1/me/tickets?status=open&status=resolved&_sort=createdAt&_order=asc'),
      ),
    ).toEqual(['A', 'C']);
    const page = await mine.session.call('GET', '/store/v1/me/tickets?_sort=createdAt&_order=asc&_start=1&_end=2');
    expect(subjects(page)).toEqual(['B']);
    expect(page.res.headers['x-total-count']).toBe('3');
    expect(subjects(await mine.session.call('GET', '/store/v1/me/tickets'))).toEqual(['C', 'B', 'A']);
    for (const url of [
      '/store/v1/me/tickets?q=hello',
      '/store/v1/me/tickets?status=closed',
      '/store/v1/me/tickets?_sort=id',
      '/store/v1/me/tickets?requesterId=3',
      '/store/v1/me/tickets?_start=0&_end=51',
    ]) {
      expect((await mine.session.call('GET', url)).status, url).toBe(422);
    }
    expect((await mine.session.call('GET', '/store/v1/me/tickets?_start=0&_end=50')).status).toBe(200);
  });

  it('tells hasUnread from the customer’s own mark, which the token page moves', async () => {
    const mine = await customer();
    const { ticket } = await customerTicket(mine.id);
    const unread = async () => (await mine.session.call('GET', '/store/v1/me/tickets')).body[0].hasUnread;
    expect(await unread()).toBe(false);
    const reply = await replyAsStaff(ticket.id, 'Hello.');
    expect(await unread()).toBe(true);
    expect((await onPage('POST', ticket.token, '/read', { upToMessageId: reply })).statusCode).toBe(204);
    expect(await unread()).toBe(false);
  });

  it('needs a customer session: 401 without one and for a merchant or staff session, 403 for a suspended customer', async () => {
    const mine = await customer();
    expect((await t.app.inject({ method: 'GET', url: '/store/v1/me/tickets' })).statusCode).toBe(401);
    expect((await staff.get('/store/v1/me/tickets')).status).toBe(401);
    const { db } = await testDb();
    const clientId = await insertMerchant(db, {});
    const merchant = await merchantSession(t, clientId);
    expect((await merchant.call('GET', '/store/v1/me/tickets')).status).toBe(401);
    expect(mine.id).toBeGreaterThan(0);
    const suspended = await customer({ status: 'suspended' });
    const refused = await suspended.session.call('GET', '/store/v1/me/tickets');
    expect(refused.status).toBe(403);
    expect(refused.body.code).toBe('ACCOUNT_SUSPENDED');
  });
});

describe('POST /store/v1/me/tickets', () => {
  const VALID = { subject: 'Where is my unlock?', message: 'I paid yesterday and still have no code.' };

  it('opens a ticket with no Turnstile and gives the link token at once: the category’s priority and target, a receipt, the doorbell', async () => {
    const mine = await customer();
    const { db } = await testDb();
    const updated = spyOn(TicketEvents.prototype, 'updated');
    const res = await mine.session.call('POST', '/store/v1/me/tickets', { ...VALID, category: 'failed_unlock' });
    expect(res.status).toBe(201);
    expect(res.res.headers['cache-control']).toBe('no-store');
    expect(res.body).toMatchObject({
      subject: VALID.subject,
      category: 'failed_unlock',
      status: 'new',
      orderId: null,
      resolvedAt: null,
      csatScore: null,
      canRate: false,
      messages: [{ from: 'you', body: VALID.message, attachments: [] }],
      seenByYou: null,
      seenBySupport: null,
      seenBySupportAt: null,
    });
    expect(res.body.token).toMatch(/^[A-Za-z0-9_-]{20,}$/);
    const [row] = await db.select().from(s.supportTickets).where(eq(s.supportTickets.number, res.body.number));
    expect(row).toMatchObject({
      channel: 'web',
      requesterType: 'customer',
      requesterId: mine.id,
      // Decision 054: the token is stored only as its keyed hash and an encrypted copy.
      token: null,
      tokenHash: tokenHashOf(t, 'ticket', res.body.token),
      status: 'new',
      priority: 'high',
      slaDueAt: new Date(clock.nowMs() + 2 * 60 * MINUTE),
    });
    const [message] = await db.select().from(s.ticketMessages).where(eq(s.ticketMessages.ticketId, row!.id));
    expect(message).toMatchObject({ authorType: 'customer', authorId: mine.id, isInternal: false });
    expect(row!.lastRequesterMessageId).toBe(message!.id);
    // The receipt is queued (ids only) and the console is told at once.
    const events = await ticketMailEvents(db);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ aggregateId: row!.id, payload: { kind: 'received' } });
    expect(updated).toHaveBeenCalledWith(row!.id);
    updated.mockRestore();
    // The token opens the existing ticket page, the list shows the ticket, and the customer can write on it.
    const page = await onPage('GET', res.body.token);
    expect(page.statusCode).toBe(200);
    expect(page.json().messages).toHaveLength(1);
    expect((await mine.session.call('GET', '/store/v1/me/tickets')).body[0]).toMatchObject({ token: res.body.token });
    expect((await onPage('POST', res.body.token, '/messages', { body: 'One more thing.' })).statusCode).toBe(201);
  });

  it('is closed for the customer once staff resolve it: a message on its token is 409 and changes nothing, until a reopen (B220)', async () => {
    const mine = await customer();
    const { db } = await testDb();
    const opened = await mine.session.call('POST', '/store/v1/me/tickets', VALID);
    expect(opened.status).toBe(201);
    const ticketId = (
      await db.select().from(s.supportTickets).where(eq(s.supportTickets.number, opened.body.number))
    )[0]!.id;
    expect((await staff.patch(`/admin/support-tickets/${ticketId}`, { status: 'resolved' })).status).toBe(200);
    const ticketOf = async () =>
      (await db.select().from(s.supportTickets).where(eq(s.supportTickets.id, ticketId)))[0]!;
    const resolved = await ticketOf();
    const messagesBefore = await db.select().from(s.ticketMessages);
    const rung = spyOn(TicketEvents.prototype, 'message');

    const refused = await onPage('POST', opened.body.token, '/messages', { body: 'Any news?' });
    expect(refused.statusCode).toBe(409);
    expect(refused.json()).toMatchObject({
      code: 'TICKET_RESOLVED',
      detail: 'This ticket is closed. Open a new ticket if you still need help.',
    });
    expect(await ticketOf()).toEqual(resolved);
    expect(await db.select().from(s.ticketMessages)).toEqual(messagesBefore);
    expect(rung).not.toHaveBeenCalled();
    // The account still lists and reads the ticket; only writing on it is closed.
    expect((await mine.session.call('GET', '/store/v1/me/tickets')).body[0]).toMatchObject({
      status: 'resolved',
      token: opened.body.token,
    });

    expect((await staff.patch(`/admin/support-tickets/${ticketId}`, { status: 'open' })).status).toBe(200);
    const again = await onPage('POST', opened.body.token, '/messages', { body: 'Any news?' });
    expect(again.statusCode).toBe(201);
    expect(rung).toHaveBeenCalledWith(ticketId, again.json().id);
    rung.mockRestore();
    expect(await ticketOf()).toMatchObject({ status: 'open', resolvedAt: null });
  });

  it('may be about an order of the customer, and refuses another customer’s order, a merchant’s and an unknown one (422 on orderId)', async () => {
    const mine = await customer();
    const other = await customer({ name: 'Someone Else' });
    const { db } = await testDb();
    await insertCurrency(db, { code: 'USD' });
    const serviceId = await insertService(db, await insertCategory(db));
    const own = await insertCustomerOrder(db, serviceId, mine.id, { currency: 'USD' });
    const theirs = await insertCustomerOrder(db, serviceId, other.id, { currency: 'USD' });
    const merchantOrder = await insertOrderRow(db, { serviceId, clientId: await insertMerchant(db, {}) });

    const ok = await mine.session.call('POST', '/store/v1/me/tickets', { ...VALID, orderId: own });
    expect(ok.status).toBe(201);
    expect(ok.body.orderId).toBe(own);
    for (const orderId of [theirs, merchantOrder.id, 999_999]) {
      const refused = await mine.session.call('POST', '/store/v1/me/tickets', { ...VALID, orderId });
      expect(refused.status, String(orderId)).toBe(422);
      expect(errorOf(refused)).toMatchObject({ field: 'orderId', code: 'unknown_order' });
    }
    expect(await db.select().from(s.supportTickets)).toHaveLength(1);
  });

  it('takes the first message as files only, and refuses an empty one and files that are not the customer’s own PDF, JPEG or PNG', async () => {
    const mine = await customer();
    const other = await customer({ name: 'Someone Else' });
    const { db } = await testDb();
    const own = await insertFileRow(db, 'customer', mine.id, { filename: 'receipt.pdf', mime: 'application/pdf' });
    const filesOnly = await mine.session.call('POST', '/store/v1/me/tickets', {
      subject: 'Receipt',
      message: '',
      fileIds: [own.id],
    });
    expect(filesOnly.status).toBe(201);
    expect(filesOnly.body.messages).toEqual([
      {
        id: expect.any(Number),
        from: 'you',
        body: '',
        createdAt: NOW,
        attachments: [{ id: own.id, filename: 'receipt.pdf', mime: 'application/pdf', size: 1000 }],
      },
    ]);
    // The file downloads through the existing ticket page route.
    const download = await onPage('GET', filesOnly.body.token, `/files/${own.id}`);
    expect(download.statusCode).toBe(302);

    const empty = await mine.session.call('POST', '/store/v1/me/tickets', { subject: 'Nothing', message: ' ' });
    expect(empty.status).toBe(422);
    expect(errorOf(empty)).toMatchObject({ field: 'message', code: 'too_small' });
    const cases = [
      [(await insertFileRow(db, 'customer', other.id)).id, 'not_yours'],
      [(await insertFileRow(db, 'client', await insertMerchant(db, {}))).id, 'not_yours'],
      [(await insertFileRow(db, 'customer', mine.id, { size: 6 * 1024 * 1024 })).id, 'too_large'],
      [(await insertFileRow(db, 'customer', mine.id, { mime: 'text/plain', filename: 'a.txt' })).id, 'type'],
      [999_999, 'unknown_file'],
    ] as const;
    // A refused attempt counts against the hour like a successful one (the limit is taken first, so ids cannot be probed): start afresh.
    await clearTicketOpenLimits(t);
    for (const [fileId, code] of cases) {
      const refused = await mine.session.call('POST', '/store/v1/me/tickets', { ...VALID, fileIds: [fileId] });
      expect(refused.status, code).toBe(422);
      expect(errorOf(refused)).toMatchObject({ field: 'fileIds', code });
    }
    const six = await mine.session.call('POST', '/store/v1/me/tickets', { ...VALID, fileIds: [1, 2, 3, 4, 5, 6] });
    expect(six.status).toBe(422);
    expect(errorOf(six)).toMatchObject({ field: 'fileIds' });
    expect(await db.select().from(s.supportTickets)).toHaveLength(1);
  });

  it('refuses a bad subject, a bad category, a body without CSRF or a session, and a suspended customer', async () => {
    const mine = await customer();
    expect(errorOf(await mine.session.call('POST', '/store/v1/me/tickets', { ...VALID, subject: ' ' }))).toMatchObject({
      field: 'subject',
    });
    expect(
      errorOf(await mine.session.call('POST', '/store/v1/me/tickets', { ...VALID, subject: 'x'.repeat(151) })),
    ).toMatchObject({ field: 'subject' });
    expect(
      errorOf(await mine.session.call('POST', '/store/v1/me/tickets', { ...VALID, category: 'gossip' })),
    ).toMatchObject({ field: 'category' });
    // The public form's own fields are not part of this route: an email in the body is ignored, never trusted.
    const forged = await mine.session.withoutCsrf('POST', '/store/v1/me/tickets', VALID);
    expect(forged.status).toBe(403);
    expect(forged.body.code).toBe('CSRF_FAILED');
    expect((await t.app.inject({ method: 'POST', url: '/store/v1/me/tickets', payload: VALID })).statusCode).toBe(401);
    const suspended = await customer({ status: 'suspended' });
    const refused = await suspended.session.call('POST', '/store/v1/me/tickets', VALID);
    expect(refused.status).toBe(403);
    expect(refused.body.code).toBe('ACCOUNT_SUSPENDED');
    const { db } = await testDb();
    expect(await db.select().from(s.supportTickets)).toEqual([]);
  });

  it('lets a customer open 5 tickets an hour: the 6th is 429 with Retry-After; another customer and a merchant are not affected', async () => {
    const mine = await customer();
    const other = await customer({ name: 'Someone Else' });
    const { db } = await testDb();
    const clientId = await insertMerchant(db, {});
    const merchant = await merchantSession(t, clientId);
    for (let n = 0; n < 5; n += 1) {
      expect(
        (await mine.session.call('POST', '/store/v1/me/tickets', { ...VALID, subject: `Ticket ${n}` })).status,
      ).toBe(201);
    }
    const sixth = await mine.session.call('POST', '/store/v1/me/tickets', VALID);
    expect(sixth.status).toBe(429);
    expect(sixth.body.code).toBe('RATE_LIMITED');
    expect(Number(sixth.res.headers['retry-after'])).toBeGreaterThan(0);
    expect(await db.select().from(s.supportTickets)).toHaveLength(5);
    expect((await other.session.call('POST', '/store/v1/me/tickets', VALID)).status).toBe(201);
    expect((await merchant.call('POST', '/client/tickets', VALID)).status).toBe(201);
    // Each customer's first ticket queued a receipt; the merchant's queued none.
    expect(await ticketMailEvents(db)).toHaveLength(6);
  });
});

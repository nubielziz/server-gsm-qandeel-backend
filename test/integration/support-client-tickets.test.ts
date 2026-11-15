// Integration tests of the merchant portal's support routes (feature 28, slice B2, plan § 3.2 routes 8 to 14 and § 7): list, open, the
// conversation, reply, read mark, typing and the attachment download under /client/tickets. Every route's success and refusals, a foreign
// ticket is 404, a merchant waiting for approval is allowed and a suspended one is refused, the list's filter, sort, range and total,
// `hasUnread`, the ticket-open limit and an order of another buyer. Real Postgres and Redis, with a test clock.
import { afterAll, beforeAll, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import { eq, sql } from 'drizzle-orm';
import { schema as s } from '../../src/infra/db';
import { TicketEvents } from '../../src/modules/support/application/ticket-events';
import { type AdminApi } from '../support/admin-api';
import { type TestApp, createTestApp } from '../support/app';
import { clearIdentityCaches, insertMerchant } from '../support/auth';
import { insertCategory, insertService } from '../support/catalog';
import { MINUTE, TestClock } from '../support/clock';
import { insertCustomerOrder } from '../support/customers';
import { closeTestDb, resetDb, testDb } from '../support/db';
import { merchantSession } from '../support/notifications';
import { insertOrderRow } from '../support/orders';
import { insertCurrency } from '../support/storefront';
import {
  clearTicketChatLimits,
  insertSupportMessage,
  insertSupportTicket,
  seedSupportTemplates,
  supportStaff,
  ticketMailEvents,
} from '../support/support';
import { clearTicketOpenLimits, insertFileRow } from '../support/support-accounts';

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
  staff = await supportStaff(t, ['support:*'], 'Lina S.');
});
afterAll(async () => {
  await resetDb();
  await clearIdentityCaches(t);
  await t.close();
  await closeTestDb();
});

/** A merchant and its portal session. */
async function merchant(values: Partial<typeof s.clients.$inferInsert> = {}) {
  const { db } = await testDb();
  const clientId = await insertMerchant(db, { name: 'Zain Mobile Hub', ...values });
  return { db, clientId, portal: await merchantSession(t, clientId) };
}

/** Changes columns of a ticket without letting the table's `$onUpdate` stamp `updated_at` with the wall clock. */
async function patchTicket(ticketId: number, values: Partial<typeof s.supportTickets.$inferInsert>) {
  const { db } = await testDb();
  await db
    .update(s.supportTickets)
    .set({ updatedAt: sql`${s.supportTickets.updatedAt}`, ...values })
    .where(eq(s.supportTickets.id, ticketId));
}

/** Writes a message into a ticket and moves the ticket's newest-message marks the way the use cases do. */
async function say(
  ticketId: number,
  author: { type: 'client' | 'customer' | 'staff' | 'system'; id: number | null },
  body: string,
  values: Partial<typeof s.ticketMessages.$inferInsert> = {},
) {
  const { db } = await testDb();
  const message = await insertSupportMessage(db, ticketId, {
    authorType: author.type,
    authorId: author.id,
    body,
    createdAt: new Date(clock.nowMs()),
    ...values,
  });
  const isPublicStaff = author.type === 'staff' && values.isInternal !== true;
  const isRequester = author.type === 'client' || author.type === 'customer';
  if (isRequester) await patchTicket(ticketId, { lastRequesterMessageId: message.id });
  if (isPublicStaff) await patchTicket(ticketId, { lastStaffMessageId: message.id });
  return message;
}

/** A merchant's ticket with its first message, `minutes` before the clock's now. */
async function merchantTicket(
  clientId: number,
  values: Partial<typeof s.supportTickets.$inferInsert> = {},
  minutes = 30,
) {
  const { db } = await testDb();
  const at = new Date(clock.nowMs() - minutes * MINUTE);
  const ticket = await insertSupportTicket(db, {
    requesterType: 'client',
    requesterId: clientId,
    token: null,
    status: 'open',
    createdAt: at,
    updatedAt: at,
    ...values,
  });
  const first = await say(ticket.id, { type: 'client', id: clientId }, 'Hello, I have a question.', { createdAt: at });
  return { ticket, first };
}

const replyAsStaff = async (ticketId: number, body: string, fileIds?: number[]) => {
  const res = await staff.post(`/admin/support-tickets/${ticketId}/reply`, { body, ...(fileIds ? { fileIds } : {}) });
  expect(res.status).toBe(201);
  return res.body.id as number;
};

const errorOf = (answer: { body: { errors?: { field: string; code: string }[] } }) => answer.body.errors?.[0];

describe('GET /client/tickets', () => {
  it('lists only the signed-in merchant’s tickets, newest activity first, with the last public message and hasUnread', async () => {
    const { db, clientId, portal } = await merchant();
    const rival = await merchant({ name: 'Other Shop' });
    const older = await merchantTicket(clientId, { subject: 'Older one', category: 'billing' }, 120);
    const newer = await merchantTicket(clientId, { subject: 'Newer one' }, 10);
    await merchantTicket(rival.clientId, { subject: 'Not mine' });
    // A customer ticket whose requester id equals the merchant's id is not the merchant's.
    await insertSupportTicket(db, { requesterType: 'customer', requesterId: clientId, subject: 'A customer' });
    const reply = await replyAsStaff(older.ticket.id, 'Done, check your billing page.');
    // A note and a system message after the reply never count as the last message.
    await say(older.ticket.id, { type: 'staff', id: staff.staffId }, 'Internal: refund approved.', {
      isInternal: true,
    });
    await say(older.ticket.id, { type: 'system', id: null }, 'Marked something.', { isInternal: true });
    expect(reply).toBeGreaterThan(0);

    const res = await portal.call('GET', '/client/tickets');
    expect(res.status).toBe(200);
    expect(res.res.headers['x-total-count']).toBe('2');
    expect(res.res.headers['cache-control']).toBe('no-store');
    expect(res.body.map((row: { subject: string }) => row.subject)).toEqual(['Older one', 'Newer one']);
    const [first, second] = res.body;
    // The staff reply moved the older ticket's `updated_at` to now: it is the newest activity.
    expect(first).toEqual({
      id: older.ticket.id,
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
    });
    expect(second).toMatchObject({
      id: newer.ticket.id,
      lastMessageFrom: 'you',
      lastMessageAt: new Date(clock.nowMs() - 10 * MINUTE).toISOString(),
      hasUnread: false,
    });
    // A merchant's row has no link token and no staff detail.
    for (const row of res.body) expect(Object.keys(row)).not.toContain('token');
    expect(JSON.stringify(res.body)).not.toContain('Lina');
  });

  it('filters by status, sorts, pages with an exact total and refuses what it does not offer', async () => {
    const { clientId, portal } = await merchant();
    await merchantTicket(clientId, { subject: 'A', status: 'open' }, 90);
    await merchantTicket(clientId, { subject: 'B', status: 'pending_customer' }, 60);
    await merchantTicket(clientId, { subject: 'C', status: 'resolved' }, 30);

    const pending = await portal.call('GET', '/client/tickets?status=pending');
    expect(pending.body.map((row: { subject: string; status: string }) => [row.subject, row.status])).toEqual([
      ['B', 'pending'],
    ]);
    expect(pending.res.headers['x-total-count']).toBe('1');
    const several = await portal.call('GET', '/client/tickets?status=open&status=resolved&_sort=createdAt&_order=asc');
    expect(several.body.map((row: { subject: string }) => row.subject)).toEqual(['A', 'C']);
    const page = await portal.call('GET', '/client/tickets?_sort=createdAt&_order=asc&_start=1&_end=2');
    expect(page.body.map((row: { subject: string }) => row.subject)).toEqual(['B']);
    expect(page.res.headers['x-total-count']).toBe('3');
    // Default order: the most recently active first.
    expect((await portal.call('GET', '/client/tickets')).body.map((row: { subject: string }) => row.subject)).toEqual([
      'C',
      'B',
      'A',
    ]);

    for (const url of [
      '/client/tickets?q=hello',
      '/client/tickets?status=closed',
      '/client/tickets?_sort=id',
      '/client/tickets?requesterId=3',
      '/client/tickets?_start=0&_end=51',
    ]) {
      expect((await portal.call('GET', url)).status, url).toBe(422);
    }
    expect((await portal.call('GET', '/client/tickets?_start=0&_end=50')).status).toBe(200);
  });

  it('is open to a merchant waiting for approval, refused to a suspended one and to anyone without a merchant session', async () => {
    const pending = await merchant({ status: 'pending' });
    expect((await pending.portal.call('GET', '/client/tickets')).status).toBe(200);
    const suspended = await merchant({ status: 'suspended' });
    const refused = await suspended.portal.call('GET', '/client/tickets');
    expect(refused.status).toBe(403);
    expect(refused.body.code).toBe('ACCOUNT_SUSPENDED');
    expect((await t.app.inject({ method: 'GET', url: '/client/tickets' })).statusCode).toBe(401);
    expect((await staff.get('/client/tickets')).status).toBe(401);
  });

  it('tells hasUnread from the merchant’s own mark: a support reply is unread until the merchant marks it', async () => {
    const { clientId, portal } = await merchant();
    const { ticket } = await merchantTicket(clientId);
    const unread = async () => (await portal.call('GET', '/client/tickets')).body[0].hasUnread;
    expect(await unread()).toBe(false);
    const reply = await replyAsStaff(ticket.id, 'Hello.');
    expect(await unread()).toBe(true);
    expect((await portal.call('POST', `/client/tickets/${ticket.id}/read`, { upToMessageId: reply })).status).toBe(204);
    expect(await unread()).toBe(false);
    // A newer reply is unread again.
    await replyAsStaff(ticket.id, 'One more thing.');
    expect(await unread()).toBe(true);
  });
});

describe('POST /client/tickets', () => {
  const VALID = { subject: 'Invoice question', message: 'Can you re-issue the October invoice in USD?' };

  it('opens a ticket without a token or a receipt: the category’s priority and target, the first message, the doorbell', async () => {
    const { db, clientId, portal } = await merchant();
    const updated = spyOn(TicketEvents.prototype, 'updated');
    const res = await portal.call('POST', '/client/tickets', { ...VALID, category: 'failed_unlock' });
    expect(res.status).toBe(201);
    expect(res.res.headers['cache-control']).toBe('no-store');
    expect(res.body).toMatchObject({
      subject: 'Invoice question',
      category: 'failed_unlock',
      status: 'new',
      orderId: null,
      resolvedAt: null,
      messages: [{ from: 'you', body: VALID.message, attachments: [] }],
      seenByYou: null,
      seenBySupport: null,
      seenBySupportAt: null,
    });
    expect(Object.keys(res.body)).not.toContain('token');
    expect(Object.keys(res.body)).not.toContain('canRate');
    const [row] = await db.select().from(s.supportTickets).where(eq(s.supportTickets.id, res.body.id));
    expect(row).toMatchObject({
      number: res.body.number,
      channel: 'web',
      requesterType: 'client',
      requesterId: clientId,
      token: null,
      status: 'new',
      priority: 'high',
      slaDueAt: new Date(clock.nowMs() + 2 * 60 * MINUTE),
      createdAt: new Date(NOW),
    });
    const [message] = await db.select().from(s.ticketMessages).where(eq(s.ticketMessages.ticketId, row!.id));
    expect(message).toMatchObject({ authorType: 'client', authorId: clientId, isInternal: false, fileIds: [] });
    expect(row!.lastRequesterMessageId).toBe(message!.id);
    // A merchant's ticket has no page to link: no receipt, and the console is told at once.
    expect(await ticketMailEvents(db)).toEqual([]);
    expect(updated).toHaveBeenCalledWith(row!.id);
    updated.mockRestore();
    // The ticket is the merchant's thread at once.
    expect((await portal.call('GET', `/client/tickets/${row!.id}`)).status).toBe(200);
  });

  it('may be about an order of the merchant, and refuses another buyer’s order and an unknown one (422 on orderId)', async () => {
    const { db, clientId, portal } = await merchant();
    const rival = await merchant({ name: 'Other Shop' });
    await insertCurrency(db, { code: 'USD' });
    const serviceId = await insertService(db, await insertCategory(db));
    const mine = await insertOrderRow(db, { serviceId, clientId });
    const theirs = await insertOrderRow(db, { serviceId, clientId: rival.clientId });
    const customer = (
      await db.insert(s.customers).values({ email: 'shopper@example.com', name: 'Shopper' }).returning()
    )[0]!;
    const storefront = await insertCustomerOrder(db, serviceId, customer.id, { currency: 'USD' });

    const ok = await portal.call('POST', '/client/tickets', { ...VALID, orderId: mine.id });
    expect(ok.status).toBe(201);
    expect(ok.body.orderId).toBe(mine.id);
    for (const orderId of [theirs.id, storefront, 999_999]) {
      const refused = await portal.call('POST', '/client/tickets', { ...VALID, orderId });
      expect(refused.status, String(orderId)).toBe(422);
      expect(errorOf(refused)).toMatchObject({ field: 'orderId', code: 'unknown_order' });
    }
    // Nothing was written for the refusals.
    expect(await db.select().from(s.supportTickets)).toHaveLength(1);
    expect(clientId).toBeGreaterThan(0);
  });

  it('takes the first message as files only, and refuses an empty one, a foreign file, a big portal upload and a wrong type', async () => {
    const { db, clientId, portal } = await merchant();
    const rival = await merchant({ name: 'Other Shop' });
    const own = await insertFileRow(db, 'client', clientId, { filename: 'statement.pdf' });
    const filesOnly = await portal.call('POST', '/client/tickets', {
      subject: 'Statement',
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
        attachments: [{ id: own.id, filename: 'statement.pdf', mime: 'application/pdf', size: 1000 }],
      },
    ]);
    const empty = await portal.call('POST', '/client/tickets', { subject: 'Nothing', message: '  ' });
    expect(empty.status).toBe(422);
    expect(errorOf(empty)).toMatchObject({ field: 'message', code: 'too_small' });
    const emptyWithEmptyList = await portal.call('POST', '/client/tickets', {
      subject: 'Nothing',
      message: '',
      fileIds: [],
    });
    expect(errorOf(emptyWithEmptyList)).toMatchObject({ field: 'message', code: 'too_small' });

    const cases = [
      [(await insertFileRow(db, 'client', rival.clientId)).id, 'not_yours'],
      [(await insertFileRow(db, 'client', clientId, { size: 20 * 1024 * 1024 })).id, 'too_large'],
      [(await insertFileRow(db, 'client', clientId, { mime: 'application/zip', filename: 'a.zip' })).id, 'type'],
      [999_999, 'unknown_file'],
    ] as const;
    for (const [fileId, code] of cases) {
      const refused = await portal.call('POST', '/client/tickets', { ...VALID, fileIds: [fileId] });
      expect(refused.status, code).toBe(422);
      expect(errorOf(refused)).toMatchObject({ field: 'fileIds', code });
    }
    const six = await portal.call('POST', '/client/tickets', { ...VALID, fileIds: [1, 2, 3, 4, 5, 6] });
    expect(six.status).toBe(422);
    expect(errorOf(six)).toMatchObject({ field: 'fileIds' });
    // Only the files-only ticket exists.
    expect(await db.select().from(s.supportTickets)).toHaveLength(1);
  });

  it('refuses a subject that is empty or too long, and the same body without CSRF or a session', async () => {
    const { portal } = await merchant();
    expect(errorOf(await portal.call('POST', '/client/tickets', { ...VALID, subject: ' ' }))).toMatchObject({
      field: 'subject',
    });
    expect(errorOf(await portal.call('POST', '/client/tickets', { ...VALID, subject: 'x'.repeat(151) }))).toMatchObject(
      { field: 'subject' },
    );
    expect(errorOf(await portal.call('POST', '/client/tickets', { ...VALID, category: 'gossip' }))).toMatchObject({
      field: 'category',
    });
    const forged = await portal.withoutCsrf('POST', '/client/tickets', VALID);
    expect(forged.status).toBe(403);
    expect(forged.body.code).toBe('CSRF_FAILED');
    expect((await t.app.inject({ method: 'POST', url: '/client/tickets', payload: VALID })).statusCode).toBe(401);
  });

  it('is allowed to a merchant waiting for approval and refused to a suspended one', async () => {
    const pending = await merchant({ status: 'pending' });
    expect((await pending.portal.call('POST', '/client/tickets', VALID)).status).toBe(201);
    const suspended = await merchant({ status: 'suspended' });
    const refused = await suspended.portal.call('POST', '/client/tickets', VALID);
    expect(refused.status).toBe(403);
    expect(refused.body.code).toBe('ACCOUNT_SUSPENDED');
  });

  it('lets a merchant open 5 tickets an hour: the 6th is 429 with Retry-After, and another merchant is not affected', async () => {
    const { db, portal } = await merchant();
    const other = await merchant({ name: 'Other Shop' });
    for (let n = 0; n < 5; n += 1) {
      expect((await portal.call('POST', '/client/tickets', { ...VALID, subject: `Ticket ${n}` })).status).toBe(201);
    }
    const sixth = await portal.call('POST', '/client/tickets', VALID);
    expect(sixth.status).toBe(429);
    expect(sixth.body.code).toBe('RATE_LIMITED');
    expect(Number(sixth.res.headers['retry-after'])).toBeGreaterThan(0);
    expect(await db.select().from(s.supportTickets)).toHaveLength(5);
    expect((await other.portal.call('POST', '/client/tickets', VALID)).status).toBe(201);
  });
});

describe('GET /client/tickets/:id', () => {
  it('shows the public conversation with its attachments and the seen marks, never a note or a system message', async () => {
    const { db, clientId, portal } = await merchant();
    const { ticket, first } = await merchantTicket(clientId, { subject: 'Invoice question', category: 'billing' });
    const file = await insertFileRow(db, 'client', clientId, {
      filename: 'screenshot.png',
      mime: 'image/png',
      size: 4096,
    });
    const own = await say(ticket.id, { type: 'client', id: clientId }, 'Here is the screenshot.', {
      fileIds: [file.id],
    });
    const reply = await replyAsStaff(ticket.id, 'Got it, thank you.');
    await say(ticket.id, { type: 'staff', id: staff.staffId }, 'Internal: check the ledger.', { isInternal: true });
    await say(ticket.id, { type: 'system', id: null }, 'Marked resolved by Lina S.', { isInternal: true });
    await patchTicket(ticket.id, { staffSeenMessageId: own.id, staffSeenAt: new Date('2026-11-15T09:55:00.000Z') });

    const res = await portal.call('GET', `/client/tickets/${ticket.id}`);
    expect(res.status).toBe(200);
    expect(res.res.headers['cache-control']).toBe('no-store');
    expect(res.body).toEqual({
      id: ticket.id,
      number: ticket.number,
      subject: 'Invoice question',
      category: 'billing',
      status: 'pending',
      orderId: null,
      createdAt: ticket.createdAt.toISOString(),
      updatedAt: NOW,
      resolvedAt: null,
      messages: [
        {
          id: first.id,
          from: 'you',
          body: 'Hello, I have a question.',
          createdAt: first.createdAt.toISOString(),
          attachments: [],
        },
        {
          id: own.id,
          from: 'you',
          body: 'Here is the screenshot.',
          createdAt: NOW,
          attachments: [{ id: file.id, filename: 'screenshot.png', mime: 'image/png', size: 4096 }],
        },
        { id: reply, from: 'support', body: 'Got it, thank you.', createdAt: NOW, attachments: [] },
      ],
      seenByYou: null,
      seenBySupport: own.id,
      seenBySupportAt: '2026-11-15T09:55:00.000Z',
    });
    // Nothing of the staff side leaks: no name, assignee, priority, note or timer.
    const text = JSON.stringify(res.body);
    for (const leak of [
      'Lina',
      'Internal',
      'ledger',
      'assignee',
      'priority',
      'slaDueAt',
      'authorName',
      'Marked resolved',
    ]) {
      expect(text, leak).not.toContain(leak);
    }
  });

  it('answers 404 for another merchant’s ticket, a customer’s ticket with the same number as an id, and an unknown id', async () => {
    const { clientId, portal } = await merchant();
    const rival = await merchant({ name: 'Other Shop' });
    const theirs = await merchantTicket(rival.clientId);
    const { db } = await testDb();
    const customerTicket = await insertSupportTicket(db, { requesterType: 'customer', requesterId: clientId });
    for (const id of [theirs.ticket.id, customerTicket.id, 999_999]) {
      const res = await portal.call('GET', `/client/tickets/${id}`);
      expect(res.status, String(id)).toBe(404);
      expect(res.body.code).toBe('NOT_FOUND');
    }
    expect((await portal.call('GET', '/client/tickets/abc')).status).toBe(422);
  });
});

describe('POST /client/tickets/:id/messages', () => {
  it('writes the merchant’s message, reopens a resolved ticket, rings the doorbell and keeps the files', async () => {
    const { db, clientId, portal } = await merchant();
    const { ticket } = await merchantTicket(clientId, {
      status: 'resolved',
      resolvedAt: new Date(clock.nowMs() - MINUTE),
    });
    const file = await insertFileRow(db, 'client', clientId, { filename: 'proof.pdf' });
    const rung = spyOn(TicketEvents.prototype, 'message');
    const res = await portal.call('POST', `/client/tickets/${ticket.id}/messages`, {
      body: 'The problem is back.',
      fileIds: [file.id],
    });
    expect(res.status).toBe(201);
    expect(res.res.headers['cache-control']).toBe('no-store');
    expect(res.body).toEqual({
      id: expect.any(Number),
      from: 'you',
      body: 'The problem is back.',
      createdAt: NOW,
      attachments: [{ id: file.id, filename: 'proof.pdf', mime: 'application/pdf', size: 1000 }],
    });
    const [row] = await db.select().from(s.supportTickets).where(eq(s.supportTickets.id, ticket.id));
    expect(row).toMatchObject({ status: 'open', resolvedAt: null, lastRequesterMessageId: res.body.id });
    expect(rung).toHaveBeenCalledWith(ticket.id, res.body.id);
    rung.mockRestore();
    const [stored] = await db.select().from(s.ticketMessages).where(eq(s.ticketMessages.id, res.body.id));
    expect(stored).toMatchObject({ authorType: 'client', authorId: clientId, isInternal: false, fileIds: [file.id] });
    // A files-only message.
    const filesOnly = await portal.call('POST', `/client/tickets/${ticket.id}/messages`, {
      body: '',
      fileIds: [file.id],
    });
    expect(filesOnly.status).toBe(201);
    expect(filesOnly.body.body).toBe('');
  });

  it('refuses an empty message, a foreign file and a ticket of another merchant (404, nothing written)', async () => {
    const { db, clientId, portal } = await merchant();
    const rival = await merchant({ name: 'Other Shop' });
    const { ticket } = await merchantTicket(clientId);
    const theirs = await merchantTicket(rival.clientId);
    const empty = await portal.call('POST', `/client/tickets/${ticket.id}/messages`, { body: '  ' });
    expect(empty.status).toBe(422);
    expect(errorOf(empty)).toMatchObject({ field: 'body', code: 'too_small' });
    const foreign = await insertFileRow(db, 'client', rival.clientId);
    const stolen = await portal.call('POST', `/client/tickets/${ticket.id}/messages`, {
      body: 'x',
      fileIds: [foreign.id],
    });
    expect(stolen.status).toBe(422);
    expect(errorOf(stolen)).toMatchObject({ field: 'fileIds', code: 'not_yours' });
    const before = (await db.select().from(s.ticketMessages)).length;
    const wrongTicket = await portal.call('POST', `/client/tickets/${theirs.ticket.id}/messages`, { body: 'Hello?' });
    expect(wrongTicket.status).toBe(404);
    expect((await portal.call('POST', '/client/tickets/999999/messages', { body: 'Hello?' })).status).toBe(404);
    expect((await db.select().from(s.ticketMessages)).length).toBe(before);
    const forged = await portal.withoutCsrf('POST', `/client/tickets/${ticket.id}/messages`, { body: 'Hello?' });
    expect(forged.status).toBe(403);
  });

  it('takes 20 messages a minute on one ticket: the 21st is 429 with Retry-After', async () => {
    const { clientId, portal } = await merchant();
    const { ticket } = await merchantTicket(clientId);
    for (let n = 0; n < 20; n += 1) {
      expect(
        (await portal.call('POST', `/client/tickets/${ticket.id}/messages`, { body: `Message ${n}` })).status,
      ).toBe(201);
    }
    const flood = await portal.call('POST', `/client/tickets/${ticket.id}/messages`, { body: 'Too many.' });
    expect(flood.status).toBe(429);
    expect(Number(flood.res.headers['retry-after'])).toBeGreaterThan(0);
  });
});

describe('POST /client/tickets/:id/read', () => {
  it('moves the merchant’s mark forward only, rings one doorbell per move and leaves updated_at alone', async () => {
    const { db, clientId, portal } = await merchant();
    const { ticket } = await merchantTicket(clientId);
    const first = await replyAsStaff(ticket.id, 'First.');
    const second = await replyAsStaff(ticket.id, 'Second.');
    const [before] = await db.select().from(s.supportTickets).where(eq(s.supportTickets.id, ticket.id));
    const rung = spyOn(TicketEvents.prototype, 'read');
    clock.advance(5 * MINUTE);

    const forward = await portal.call('POST', `/client/tickets/${ticket.id}/read`, { upToMessageId: second });
    expect(forward.status).toBe(204);
    expect(forward.body).toBeUndefined();
    const [moved] = await db.select().from(s.supportTickets).where(eq(s.supportTickets.id, ticket.id));
    expect(moved).toMatchObject({ requesterSeenMessageId: second, requesterSeenAt: new Date(clock.nowMs()) });
    expect(moved!.updatedAt).toEqual(before!.updatedAt);
    expect(rung).toHaveBeenCalledTimes(1);
    expect(rung).toHaveBeenCalledWith(ticket.id, 'requester');

    // A repeat and an older id change nothing and ring nothing.
    expect((await portal.call('POST', `/client/tickets/${ticket.id}/read`, { upToMessageId: second })).status).toBe(
      204,
    );
    expect((await portal.call('POST', `/client/tickets/${ticket.id}/read`, { upToMessageId: first })).status).toBe(204);
    const [after] = await db.select().from(s.supportTickets).where(eq(s.supportTickets.id, ticket.id));
    expect(after!.requesterSeenMessageId).toBe(second);
    expect(rung).toHaveBeenCalledTimes(1);
    rung.mockRestore();
    // The mark shows in the conversation.
    expect((await portal.call('GET', `/client/tickets/${ticket.id}`)).body.seenByYou).toBe(second);
  });

  it('refuses the merchant’s own message, a note, a system message and another ticket’s message (422 unknown_message)', async () => {
    const { clientId, portal } = await merchant();
    const { ticket, first } = await merchantTicket(clientId);
    const other = await merchantTicket(clientId, { subject: 'Another' });
    const note = await say(ticket.id, { type: 'staff', id: staff.staffId }, 'A note.', { isInternal: true });
    const system = await say(ticket.id, { type: 'system', id: null }, 'System.', { isInternal: true });
    const replyOnOther = await replyAsStaff(other.ticket.id, 'Reply on another ticket.');
    for (const upToMessageId of [first.id, note.id, system.id, replyOnOther, 999_999]) {
      const res = await portal.call('POST', `/client/tickets/${ticket.id}/read`, { upToMessageId });
      expect(res.status, String(upToMessageId)).toBe(422);
      expect(errorOf(res)).toMatchObject({ field: 'upToMessageId', code: 'unknown_message' });
    }
    expect((await portal.call('POST', `/client/tickets/${ticket.id}/read`, {})).status).toBe(422);
  });

  it('answers 404 for another merchant’s ticket, whatever the message id, and writes nothing', async () => {
    const { clientId, portal } = await merchant();
    const rival = await merchant({ name: 'Other Shop' });
    const theirs = await merchantTicket(rival.clientId);
    const theirReply = await replyAsStaff(theirs.ticket.id, 'For the other shop.');
    const res = await portal.call('POST', `/client/tickets/${theirs.ticket.id}/read`, { upToMessageId: theirReply });
    expect(res.status).toBe(404);
    const { db } = await testDb();
    const [row] = await db.select().from(s.supportTickets).where(eq(s.supportTickets.id, theirs.ticket.id));
    expect(row!.requesterSeenMessageId).toBeNull();
    expect(clientId).toBeGreaterThan(0);
  });
});

describe('POST /client/tickets/:id/typing', () => {
  it('rings one doorbell per 2.5 seconds however many pings, stores nothing and always answers 204', async () => {
    const { db, clientId, portal } = await merchant();
    const { ticket } = await merchantTicket(clientId);
    const typing = spyOn(TicketEvents.prototype, 'typing');
    const messages = (await db.select().from(s.ticketMessages)).length;
    for (let n = 0; n < 4; n += 1) {
      const res = await portal.call('POST', `/client/tickets/${ticket.id}/typing`);
      expect(res.status).toBe(204);
    }
    expect(typing).toHaveBeenCalledTimes(1);
    expect(typing).toHaveBeenCalledWith(ticket.id, { by: 'requester' });
    typing.mockRestore();
    expect((await db.select().from(s.ticketMessages)).length).toBe(messages);
  });

  it('answers 404 for another merchant’s ticket and an unknown id, and rings nothing', async () => {
    const { portal } = await merchant();
    const rival = await merchant({ name: 'Other Shop' });
    const theirs = await merchantTicket(rival.clientId);
    const typing = spyOn(TicketEvents.prototype, 'typing');
    expect((await portal.call('POST', `/client/tickets/${theirs.ticket.id}/typing`)).status).toBe(404);
    expect((await portal.call('POST', '/client/tickets/999999/typing')).status).toBe(404);
    expect(typing).not.toHaveBeenCalled();
    typing.mockRestore();
  });
});

describe('GET /client/tickets/:id/files/:fileId', () => {
  it('redirects to a 5-minute attachment link for the file of a public message of the merchant’s ticket', async () => {
    const { db, clientId, portal } = await merchant();
    const { ticket } = await merchantTicket(clientId);
    const file = await insertFileRow(db, 'client', clientId, { filename: 'Rechnung Oktober.pdf' });
    await say(ticket.id, { type: 'client', id: clientId }, 'The statement.', { fileIds: [file.id] });
    const staffFile = await insertFileRow(db, 'staff', staff.staffId, { filename: 'invoice.pdf' });
    await replyAsStaff(ticket.id, 'Here is the invoice.', undefined);
    await say(ticket.id, { type: 'staff', id: staff.staffId }, 'Reissued.', { fileIds: [staffFile.id] });

    const res = await portal.call('GET', `/client/tickets/${ticket.id}/files/${file.id}`);
    expect(res.status).toBe(302);
    expect(res.res.headers['cache-control']).toBe('no-store');
    const link = new URL(String(res.res.headers.location));
    expect(link.searchParams.get('X-Amz-Expires')).toBe('300');
    const disposition = decodeURIComponent(link.searchParams.get('response-content-disposition') ?? '');
    expect(disposition).toContain('attachment');
    expect(disposition).toContain('Rechnung');
    // Support's own file is the merchant's to download too (a public message).
    expect((await portal.call('GET', `/client/tickets/${ticket.id}/files/${staffFile.id}`)).status).toBe(302);
  });

  it('answers 404 for a note’s file, another ticket’s file, a file in no message, an unknown id and another merchant’s ticket', async () => {
    const { db, clientId, portal } = await merchant();
    const rival = await merchant({ name: 'Other Shop' });
    const { ticket } = await merchantTicket(clientId);
    const other = await merchantTicket(clientId, { subject: 'Another ticket' });
    const theirs = await merchantTicket(rival.clientId);
    const noteFile = await insertFileRow(db, 'staff', staff.staffId, { filename: 'note.pdf' });
    await say(ticket.id, { type: 'staff', id: staff.staffId }, 'Internal.', {
      isInternal: true,
      fileIds: [noteFile.id],
    });
    const otherFile = await insertFileRow(db, 'client', clientId, { filename: 'other.pdf' });
    await say(other.ticket.id, { type: 'client', id: clientId }, 'On the other ticket.', { fileIds: [otherFile.id] });
    const loose = await insertFileRow(db, 'client', clientId, { filename: 'loose.pdf' });
    const theirFile = await insertFileRow(db, 'client', rival.clientId, { filename: 'theirs.pdf' });
    await say(theirs.ticket.id, { type: 'client', id: rival.clientId }, 'Theirs.', { fileIds: [theirFile.id] });

    for (const fileId of [noteFile.id, otherFile.id, loose.id, 999_999]) {
      expect((await portal.call('GET', `/client/tickets/${ticket.id}/files/${fileId}`)).status, String(fileId)).toBe(
        404,
      );
    }
    // The file is real and is in a public message, but the ticket is not the merchant's.
    expect((await portal.call('GET', `/client/tickets/${theirs.ticket.id}/files/${theirFile.id}`)).status).toBe(404);
    expect((await portal.call('GET', '/client/tickets/999999/files/1')).status).toBe(404);
    expect(
      (await t.app.inject({ method: 'GET', url: `/client/tickets/${ticket.id}/files/${loose.id}` })).statusCode,
    ).toBe(401);
  });
});

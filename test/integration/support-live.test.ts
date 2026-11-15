// Integration tests of the support chat on the live streams (feature 28, plan § 7): a staff reply reaches the ticket link's stream and the
// customer's account stream at once as the requester view; a requester message reaches staff with support:read only; an internal note and a
// system message never reach a requester stream, and the requester view carries no staff name, assignee or priority; a merchant's stream
// gets only its own tickets and a ticket stream only its ticket; ticket.updated on a PATCH and a new ticket; typing (throttled, a note's to
// staff only, nothing stored); read marks (forward only, 422 for another message, the event, updated_at kept); replay and resync; the
// ticket stream's cap; erasure; the ticket-chat limiter. A listening test app on real Postgres and Redis, with a test clock.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { eq } from 'drizzle-orm';
import { CacheKeys } from '../../src/infra/cache';
import { schema as s } from '../../src/infra/db';
import { RealtimeHub, RealtimePublisher } from '../../src/infra/realtime';
import { RedisService } from '../../src/infra/redis';
import { type AdminApi, adminWith } from '../support/admin-api';
import { type TestApp, createTestApp } from '../support/app';
import { clearIdentityCaches, insertMerchant, openSession } from '../support/auth';
import { TestClock } from '../support/clock';
import { closeTestDb, resetDb, testDb } from '../support/db';
import { eventually } from '../support/infra';
import { freshClientIp } from '../support/pipeline-routes';
import { deleteBullKeys, testBullPrefix } from '../support/queues';
import { makeCustomer } from '../support/store';
import { TURNSTILE_HEADERS } from '../support/storefront';
import {
  SAME_ORIGIN,
  type StreamFrame,
  type TestStream,
  clearStreamLimits,
  listen,
  openStream,
} from '../support/stream';
import {
  clearTicketChatLimits,
  clearTicketEmailLimits,
  insertSupportMessage,
  insertSupportTicket,
  seedSupportTemplates,
  setSupportSetting,
  supportStaff,
} from '../support/support';

const prefix = testBullPrefix();
const NOW = '2026-11-15T10:00:00.000Z';
const clock = new TestClock(NOW);
let t: TestApp;
let base: string;
let staff: AdminApi;
const open: TestStream[] = [];

beforeAll(async () => {
  await testDb();
  t = await createTestApp({ clock, env: { BULL_PREFIX: prefix } });
  base = await listen(t);
  await eventually(() => (t.app.get(RealtimeHub).listening ? true : undefined));
});
afterAll(async () => {
  await deleteBullKeys(t.app.get(RedisService).queue, prefix);
  await t.close();
  await resetDb();
  await closeTestDb();
});
beforeEach(async () => {
  clock.set(NOW);
  await resetDb();
  await seedSupportTemplates((await testDb()).db);
  await clearIdentityCaches(t);
  await clearStreamLimits(t);
  await clearTicketChatLimits(t);
  await clearTicketEmailLimits(t);
  // The reply mail is not what these tests look at: mail at once, so no due time is left behind.
  await setSupportSetting(t, 'replyEmailDelayMinutes', 0);
  staff = await supportStaff(t, ['support:*'], 'Lina S.');
});
afterEach(async () => {
  for (const opened of open.splice(0)) opened.close();
  await eventually(() => (t.app.get(RealtimeHub).size === 0 ? true : undefined));
});

/** Opens a stream and keeps it for the clean-up. */
async function stream(path: string, headers: Record<string, string> = SAME_ORIGIN): Promise<TestStream> {
  const opened = await openStream(`${base}${path}`, headers);
  open.push(opened);
  return opened;
}

/** The stream of a ticket link, after `ready` (a ticket stream has no snapshot). */
async function ticketStream(token: string, extra: Record<string, string> = {}): Promise<TestStream> {
  const opened = await stream(`/store/v1/tickets/${token}/stream`, { ...SAME_ORIGIN, ...extra });
  expect(opened.status).toBe(200);
  expect((await opened.next()).event).toBe('ready');
  return opened;
}

/** The stream of a signed-in account, after `ready` and the inbox count. */
async function accountStream(subject: { type: 'staff' | 'client' | 'customer'; id: number }): Promise<TestStream> {
  const session = await openSession(t, subject);
  const path =
    subject.type === 'staff' ? '/admin/stream' : subject.type === 'client' ? '/client/stream' : '/store/v1/me/stream';
  const opened = await stream(path, { ...SAME_ORIGIN, ...session.headers });
  expect(opened.status).toBe(200);
  expect((await opened.next()).event).toBe('ready');
  expect((await opened.next()).event).toBe('unread.changed');
  return opened;
}

/** The stream of the staff member behind an admin client. */
const staffStream = (api: AdminApi) => accountStream({ type: 'staff', id: api.staffId });

/** A customer with an account and a ticket of theirs, opened with a first message. */
async function customerTicket(subject = 'Where is my unlock?') {
  const { db } = await testDb();
  const customer = await makeCustomer(t, { name: 'Victor Hale' });
  const ticket = await insertSupportTicket(db, { requesterId: customer.id, subject, status: 'open' });
  const first = await insertSupportMessage(db, ticket.id, {
    authorType: 'customer',
    authorId: customer.id,
    body: 'I paid yesterday and still have no code.',
    // A minute before the clock's now, like a message of the past (the default would be the wall clock).
    createdAt: new Date(clock.nowMs() - 60_000),
  });
  return { db, customer, ticket: { ...ticket, token: ticket.token! }, first };
}

/** A request on the ticket page (JSON), from its own client address unless told otherwise. */
const onTicket = (method: 'GET' | 'POST', token: string, path: string, payload?: unknown, ip = freshClientIp()) =>
  t.app.inject({
    method,
    url: `/store/v1/tickets/${token}${path}`,
    remoteAddress: ip,
    ...(payload === undefined ? {} : { payload: payload as never }),
  });

/** Rings `ticket updated` of a ticket: a barrier frame behind anything already written to that ticket's streams. */
const barrier = (ticketId: number) => t.app.get(RealtimePublisher).publish('ticket', 'updated', { ticketId });

/** Rings an inbox recount: a barrier frame (`unread.changed`) for every account stream. */
const inboxBarrier = () =>
  t.app.get(RealtimePublisher).publish('inbox', 'recount', { types: ['staff', 'client', 'customer'] });

const ticketEvents = (frames: readonly StreamFrame[]) => frames.filter((frame) => frame.event.startsWith('ticket.'));

/** The support chat's part of a composite cursor (`t5521` of `i41-t5521`). */
const ticketCursorOf = (id: string | undefined): number => Number(/(?:^|-)t(\d+)(?:-|$)/.exec(id ?? '')?.[1]);

describe('a staff reply', () => {
  it('reaches the ticket link’s stream and the customer’s account stream in under a second, as the requester view', async () => {
    const { ticket, customer } = await customerTicket();
    const page = await ticketStream(ticket.token);
    const account = await accountStream({ type: 'customer', id: customer.id });
    const startedAt = performance.now();
    const res = await staff.post(`/admin/support-tickets/${ticket.id}/reply`, { body: 'Your code is on its way.' });
    expect(res.status).toBe(201);
    const [onPage, onAccount] = await Promise.all([
      page.next('ticket.message.created'),
      account.next('ticket.message.created'),
    ]);
    expect(performance.now() - startedAt).toBeLessThan(1000);
    for (const frame of [onPage, onAccount]) {
      expect(ticketCursorOf(frame.id)).toBe(res.body.id);
      expect(frame.data).toEqual({
        ticketId: null,
        number: ticket.number,
        message: {
          id: res.body.id,
          from: 'support',
          body: 'Your code is on its way.',
          createdAt: NOW,
          attachments: [],
        },
        live: true,
      });
    }
    const updated = await page.next('ticket.updated');
    expect(updated.id).toBeUndefined();
    expect(updated.data).toEqual({
      ticketId: null,
      number: ticket.number,
      status: 'pending',
      updatedAt: NOW,
      resolvedAt: null,
      canRate: false,
      csatScore: null,
      hasUnread: true,
    });
    expect((await account.next('ticket.updated')).data).toEqual(updated.data);
    // The requester view never names the staff member, the assignee or the priority.
    for (const frame of [...page.frames, ...account.frames]) {
      const text = JSON.stringify(frame.data);
      expect(text).not.toContain('Lina');
      expect(text).not.toContain('assignee');
      expect(text).not.toContain('priority');
      expect(text).not.toContain(ticket.token);
    }
  });
});

describe('a requester message', () => {
  it('reaches a staff stream with support:read as the staff view, and not one without it', async () => {
    const { ticket, customer } = await customerTicket();
    const reader = await staffStream(staff);
    const outsider = await staffStream(await adminWith(t, ['orders:read'], { name: 'Omar' }));
    const res = await onTicket('POST', ticket.token, '/messages', { body: 'Any news?' });
    expect(res.statusCode).toBe(201);
    const frame = await reader.next('ticket.message.created');
    expect(ticketCursorOf(frame.id)).toBe(res.json().id);
    expect(frame.data).toMatchObject({
      ticketId: ticket.id,
      live: true,
      message: {
        id: res.json().id,
        ticketId: ticket.id,
        authorType: 'customer',
        authorId: customer.id,
        authorName: 'Victor Hale',
        body: 'Any news?',
        isInternal: false,
        fileIds: [],
        attachments: [],
      },
    });
    const row = await reader.next('ticket.updated');
    expect(row.data.ticket).toMatchObject({ id: ticket.id, status: 'open', hasUnread: true, assignee: null });
    // A barrier behind the message's doorbell: the stream without support:read got no ticket event.
    await inboxBarrier();
    await outsider.next('unread.changed');
    expect(ticketEvents(outsider.frames)).toEqual([]);
  });
});

describe('the requester view', () => {
  it('never carries an internal note or a system message, nor a staff name, the assignee or the priority', async () => {
    const { ticket, customer } = await customerTicket();
    const page = await ticketStream(ticket.token);
    const account = await accountStream({ type: 'customer', id: customer.id });
    const team = await staffStream(staff);
    const note = await staff.post(`/admin/support-tickets/${ticket.id}/note`, {
      body: 'Supplier is slow today (Lina).',
    });
    expect(note.status).toBe(201);
    expect((await team.next('ticket.message.created')).data.message).toMatchObject({
      id: note.body.id,
      isInternal: true,
      authorName: 'Lina S.',
    });
    // The resolve writes the internal system message: staff see it live, the requester gets only the new status.
    const resolved = await staff.patch(`/admin/support-tickets/${ticket.id}`, { status: 'resolved', priority: 'high' });
    expect(resolved.status).toBe(200);
    const system = await team.next('ticket.message.created');
    expect(system.data.message).toMatchObject({ authorType: 'system', isInternal: true });
    for (const requester of [page, account]) {
      const update = await requester.next('ticket.updated');
      expect(update.data).toMatchObject({ status: 'resolved', canRate: true, resolvedAt: NOW });
    }
    await barrier(ticket.id);
    for (const requester of [page, account]) {
      await requester.next('ticket.updated');
      expect(requester.frames.filter((frame) => frame.event === 'ticket.message.created')).toEqual([]);
      for (const frame of ticketEvents(requester.frames)) {
        const text = JSON.stringify(frame.data);
        for (const secret of [
          'Supplier is slow',
          'Marked resolved',
          'Lina',
          'assignee',
          'priority',
          'high',
          'slaDueAt',
        ]) {
          expect(text, secret).not.toContain(secret);
        }
        expect(Object.keys(frame.data).sort()).toEqual(
          ['canRate', 'csatScore', 'hasUnread', 'number', 'resolvedAt', 'status', 'ticketId', 'updatedAt'].sort(),
        );
      }
    }
  });

  it('gives a merchant’s stream only its own tickets, by id, and another ticket’s link stream nothing', async () => {
    const { db } = await testDb();
    const mine = await insertMerchant(db, { name: 'Zain Mobile Hub' });
    const other = await insertMerchant(db, { name: 'Other Shop' });
    const own = await insertSupportTicket(db, {
      requesterType: 'client',
      requesterId: mine,
      token: null,
      status: 'open',
    });
    const foreign = await insertSupportTicket(db, {
      requesterType: 'client',
      requesterId: other,
      token: null,
      status: 'open',
    });
    const merchant = await accountStream({ type: 'client', id: mine });
    const { ticket: first } = await customerTicket('First');
    const { ticket: second } = await customerTicket('Second');
    const secondPage = await ticketStream(second.token);

    expect(
      (await staff.post(`/admin/support-tickets/${foreign.id}/reply`, { body: 'For the other shop.' })).status,
    ).toBe(201);
    expect((await staff.post(`/admin/support-tickets/${own.id}/reply`, { body: 'For you.' })).status).toBe(201);
    const created = await merchant.next('ticket.message.created');
    expect(created.data).toMatchObject({ ticketId: own.id, number: own.number, message: { body: 'For you.' } });
    expect((await merchant.next('ticket.updated')).data).toMatchObject({ ticketId: own.id });
    await inboxBarrier();
    await merchant.next('unread.changed');
    expect(ticketEvents(merchant.frames).every((frame) => frame.data.ticketId === own.id)).toBe(true);

    expect(
      (await staff.post(`/admin/support-tickets/${first.id}/reply`, { body: 'For the first ticket.' })).status,
    ).toBe(201);
    await barrier(second.id);
    const only = await secondPage.next();
    expect(only).toMatchObject({ event: 'ticket.updated', data: { number: second.number } });
    expect(ticketEvents(secondPage.frames)).toHaveLength(1);
  });
});

describe('ticket.updated', () => {
  it('reaches staff on a PATCH and on a new ticket', async () => {
    const { ticket } = await customerTicket();
    const team = await staffStream(staff);
    expect((await staff.patch(`/admin/support-tickets/${ticket.id}`, { priority: 'high' })).status).toBe(200);
    expect((await team.next('ticket.updated')).data.ticket).toMatchObject({ id: ticket.id, priority: 'high' });
    const opened = await t.app.inject({
      method: 'POST',
      url: '/store/v1/tickets',
      remoteAddress: freshClientIp(),
      headers: TURNSTILE_HEADERS,
      payload: { email: 'new.visitor@mail.example', subject: 'A new question', message: 'Do you unlock Pixel 9?' },
    });
    expect(opened.statusCode).toBe(201);
    const created = await team.next('ticket.updated');
    expect(created.data.ticket).toMatchObject({ number: opened.json().number, status: 'new', hasUnread: true });
  });
});

describe('typing', () => {
  it('rings once per 2.5 s however many pings, shows the requester to staff, and stores nothing', async () => {
    const { ticket } = await customerTicket();
    const team = await staffStream(staff);
    const before = await (await testDb()).db.select().from(s.supportTickets).where(eq(s.supportTickets.id, ticket.id));
    for (let ping = 0; ping < 5; ping++) {
      expect((await onTicket('POST', ticket.token, '/typing')).statusCode).toBe(204);
    }
    expect((await team.next('ticket.typing')).data).toEqual({
      ticketId: ticket.id,
      by: 'requester',
      staffId: null,
      staffName: null,
      mode: null,
    });
    await barrier(ticket.id);
    await team.next('ticket.updated');
    expect(team.frames.filter((frame) => frame.event === 'ticket.typing')).toHaveLength(1);
    // Nothing stored: the ticket row and the thread are as they were; the throttle key lives at most 2.5 s.
    const { db } = await testDb();
    expect(await db.select().from(s.supportTickets).where(eq(s.supportTickets.id, ticket.id))).toEqual(before);
    expect(await db.select().from(s.ticketMessages).where(eq(s.ticketMessages.ticketId, ticket.id))).toHaveLength(1);
    const ttl = await t.app.get(RedisService).cache.pttl(t.app.get(CacheKeys).supportTyping(ticket.id, 'r'));
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(2500);
  });

  it('rings nothing for the requester on a resolved ticket (still 204, no throttle key) and rings again after a staff reopen (B220)', async () => {
    const { db, ticket } = await customerTicket();
    await db
      .update(s.supportTickets)
      .set({ status: 'resolved', resolvedAt: new Date(clock.nowMs()) })
      .where(eq(s.supportTickets.id, ticket.id));
    const team = await staffStream(staff);
    for (let ping = 0; ping < 3; ping++) {
      expect((await onTicket('POST', ticket.token, '/typing')).statusCode).toBe(204);
    }
    await barrier(ticket.id);
    await team.next('ticket.updated');
    expect(team.frames.filter((frame) => frame.event === 'ticket.typing')).toEqual([]);
    // -2: the key does not exist, so the first ping after a reopen is not absorbed.
    expect(await t.app.get(RedisService).cache.pttl(t.app.get(CacheKeys).supportTyping(ticket.id, 'r'))).toBe(-2);

    expect((await staff.patch(`/admin/support-tickets/${ticket.id}`, { status: 'open' })).status).toBe(200);
    expect((await onTicket('POST', ticket.token, '/typing')).statusCode).toBe(204);
    expect((await team.next('ticket.typing')).data).toMatchObject({ ticketId: ticket.id, by: 'requester' });
  });

  it('shows a staff reply’s typing to the requester and a note’s to other staff only', async () => {
    const { ticket } = await customerTicket();
    const page = await ticketStream(ticket.token);
    const colleague = await supportStaff(t, ['support:*'], 'Rami K.');
    const team = await staffStream(colleague);
    const note = await staff.post(`/admin/support-tickets/${ticket.id}/typing`, { mode: 'note' });
    expect(note.status).toBe(204);
    expect((await team.next('ticket.typing')).data).toEqual({
      ticketId: ticket.id,
      by: 'staff',
      staffId: staff.staffId,
      staffName: 'Lina S.',
      mode: 'note',
    });
    await barrier(ticket.id);
    await page.next('ticket.updated');
    expect(page.frames.filter((frame) => frame.event === 'ticket.typing')).toEqual([]);

    const reply = await colleague.post(`/admin/support-tickets/${ticket.id}/typing`, { mode: 'reply' });
    expect(reply.status).toBe(204);
    expect((await page.next('ticket.typing')).data).toEqual({ ticketId: null, number: ticket.number });
    expect((await team.next('ticket.typing')).data).toMatchObject({ staffName: 'Rami K.', mode: 'reply' });
    expect((await staff.post('/admin/support-tickets/999999/typing', { mode: 'reply' })).status).toBe(404);
    expect((await staff.post(`/admin/support-tickets/${ticket.id}/typing`, { mode: 'shout' })).status).toBe(422);
    const { db } = await testDb();
    expect(await db.select().from(s.auditLogs)).toEqual([]);
  });
});

describe('read marks', () => {
  it('move forward only, refuse another message, reach the other side and leave updated_at', async () => {
    const { db, ticket, first } = await customerTicket();
    const { ticket: other } = await customerTicket('Other');
    const otherMessage = await insertSupportMessage(db, other.id, {
      authorType: 'staff',
      authorId: staff.staffId,
      body: 'x',
    });
    const team = await staffStream(staff);
    const page = await ticketStream(ticket.token);
    const one = (await staff.post(`/admin/support-tickets/${ticket.id}/reply`, { body: 'One.' })).body.id as number;
    const two = (await staff.post(`/admin/support-tickets/${ticket.id}/reply`, { body: 'Two.' })).body.id as number;
    const note = (await staff.post(`/admin/support-tickets/${ticket.id}/note`, { body: 'Note.' })).body.id as number;
    const updatedAt = (await db.select().from(s.supportTickets).where(eq(s.supportTickets.id, ticket.id)))[0]!
      .updatedAt;
    clock.advance(60_000);

    expect((await onTicket('POST', ticket.token, '/read', { upToMessageId: two })).statusCode).toBe(204);
    const seen = await team.next('ticket.read');
    expect(seen.data).toEqual({
      ticketId: ticket.id,
      by: 'requester',
      upToMessageId: two,
      at: '2026-11-15T10:01:00.000Z',
    });
    expect((await page.next('ticket.read')).data).toEqual({
      ticketId: null,
      number: ticket.number,
      by: 'you',
      upToMessageId: two,
      at: '2026-11-15T10:01:00.000Z',
    });
    const [row] = await db.select().from(s.supportTickets).where(eq(s.supportTickets.id, ticket.id));
    expect(row).toMatchObject({ requesterSeenMessageId: two, updatedAt });

    // An older id is a success that changes nothing and rings nothing.
    expect((await onTicket('POST', ticket.token, '/read', { upToMessageId: one })).statusCode).toBe(204);
    expect((await db.select().from(s.supportTickets).where(eq(s.supportTickets.id, ticket.id)))[0]).toMatchObject({
      requesterSeenMessageId: two,
    });
    for (const refused of [note, first.id, otherMessage.id, 999_999]) {
      const res = await onTicket('POST', ticket.token, '/read', { upToMessageId: refused });
      expect(res.statusCode, String(refused)).toBe(422);
      expect(res.json().errors[0]).toMatchObject({ field: 'upToMessageId', code: 'unknown_message' });
    }

    // Staff mark the requester's message: the requester learns that support saw it, never who.
    const staffRead = await staff.post(`/admin/support-tickets/${ticket.id}/read`, { upToMessageId: first.id });
    expect(staffRead.status).toBe(204);
    expect((await page.next('ticket.read')).data).toMatchObject({ by: 'support', upToMessageId: first.id });
    expect((await staff.post(`/admin/support-tickets/${ticket.id}/read`, { upToMessageId: two })).status).toBe(422);
    expect((await staff.post('/admin/support-tickets/999999/read', { upToMessageId: first.id })).status).toBe(404);
    const shown = await onTicket('GET', ticket.token, '');
    expect(shown.json()).toMatchObject({
      seenByYou: two,
      seenBySupport: first.id,
      seenBySupportAt: '2026-11-15T10:01:00.000Z',
    });
    await barrier(ticket.id);
    await team.next('ticket.updated');
    expect(team.frames.filter((frame) => frame.event === 'ticket.read')).toHaveLength(2);
    // The staff side's own read mark is not an admin change: no audit row.
    expect((await db.select().from(s.auditLogs)).map((audit) => audit.action)).not.toContain('read ticket');
  });
});

describe('a reconnect', () => {
  it('replays the 3 missed public messages with Last-Event-ID, and resyncs after 101', async () => {
    const { db, ticket } = await customerTicket();
    const page = await ticketStream(ticket.token);
    const reply = await staff.post(`/admin/support-tickets/${ticket.id}/reply`, { body: 'Seen live.' });
    const seen = await page.next('ticket.message.created');
    page.close();
    await eventually(() => (t.app.get(RealtimeHub).size === 0 ? true : undefined));
    // While away: two replies, a note (never replayed to the requester) and the customer's own message.
    await staff.post(`/admin/support-tickets/${ticket.id}/reply`, { body: 'Missed one.' });
    await staff.post(`/admin/support-tickets/${ticket.id}/note`, { body: 'Internal.' });
    await staff.post(`/admin/support-tickets/${ticket.id}/reply`, { body: 'Missed two.' });
    await onTicket('POST', ticket.token, '/messages', { body: 'From another tab.' });

    const again = await stream(`/store/v1/tickets/${ticket.token}/stream`, {
      ...SAME_ORIGIN,
      'last-event-id': seen.id!,
    });
    expect(await again.next()).toMatchObject({ event: 'ready', data: { resumed: true } });
    const replayed = [await again.next(), await again.next(), await again.next()];
    expect(replayed.map((frame) => [frame.event, frame.data.message.body, frame.data.live])).toEqual([
      ['ticket.message.created', 'Missed one.', false],
      ['ticket.message.created', 'Missed two.', false],
      ['ticket.message.created', 'From another tab.', false],
    ]);
    expect(ticketCursorOf(replayed[2]!.id)).toBe(replayed[2]!.data.message.id);
    expect(ticketCursorOf(seen.id)).toBe(reply.body.id);
    again.close();
    await eventually(() => (t.app.get(RealtimeHub).size === 0 ? true : undefined));

    await db.insert(s.ticketMessages).values(
      Array.from({ length: 101 }, (_, index) => ({
        ticketId: ticket.id,
        authorType: 'staff' as const,
        authorId: staff.staffId,
        body: `Bulk ${index}`,
      })),
    );
    const late = await stream(`/store/v1/tickets/${ticket.token}/stream`, {
      ...SAME_ORIGIN,
      'last-event-id': `t${replayed[2]!.data.message.id as number}`,
    });
    expect(await late.next()).toMatchObject({ event: 'ready', data: { resumed: true } });
    expect(await late.next()).toMatchObject({ event: 'resync', data: { topics: ['ticket'] } });
  });
});

describe('the ticket stream', () => {
  it('refuses the 4th stream of a ticket with 429, and an unknown token with 404', async () => {
    const { ticket } = await customerTicket();
    for (let n = 0; n < 3; n++) await ticketStream(ticket.token);
    const fourth = await stream(`/store/v1/tickets/${ticket.token}/stream`);
    expect(fourth.status).toBe(429);
    expect(fourth.headers['retry-after']).toBe('60');
    expect(fourth.body).toMatchObject({ code: 'RATE_LIMITED', detail: 'Too many open live connections.' });
    const unknown = await stream('/store/v1/tickets/Zk3b0jY8mQe1xVn7hT2cLwAAAA/stream');
    expect(unknown.status).toBe(404);
  });

  it('ends when the customer is anonymized, and the token answers 404 afterwards', async () => {
    const { ticket, customer } = await customerTicket();
    const page = await ticketStream(ticket.token);
    const privacy = await adminWith(t, ['customers:privacy']);
    expect((await privacy.post(`/admin/customers/${customer.id}/anonymize`)).status).toBe(204);
    expect(await page.next('bye')).toMatchObject({ data: { reason: 'session_ended' } });
    await page.ended;
    expect((await onTicket('GET', ticket.token, '')).statusCode).toBe(404);
    expect((await stream(`/store/v1/tickets/${ticket.token}/stream`)).status).toBe(404);
  });
});

describe('the ticket-chat limiter', () => {
  it('counts typing and read marks apart from the token lookups', async () => {
    const { ticket } = await customerTicket();
    const ip = freshClientIp();
    // 35 typing pings from one address: more than the 30 token lookups a minute, all accepted.
    for (let ping = 0; ping < 35; ping++) {
      expect((await onTicket('POST', ticket.token, '/typing', undefined, ip)).statusCode).toBe(204);
    }
    expect((await onTicket('GET', ticket.token, '', undefined, ip)).statusCode).toBe(200);
  });
});

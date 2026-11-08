// Integration tests of the support inbox (feature 17): the list with its filters, sorts and timers, one ticket with its thread, the change
// of priority, assignee and status (resolve and reopen), the staff reply on its channels, the internal note, and the audit trail.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { eq } from 'drizzle-orm';
import { schema as s } from '../../src/infra/db';
import { type AdminApi } from '../support/admin-api';
import { type TestApp, createTestApp } from '../support/app';
import { clearIdentityCaches, insertRole, insertStaff } from '../support/auth';
import { TestClock } from '../support/clock';
import { closeTestDb, resetDb, testDb } from '../support/db';
import { mailbox, notificationRows, telegramOutbox } from '../support/notifications';
import {
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
let admin: AdminApi;

beforeAll(async () => {
  t = await createTestApp({
    clock,
    env: { TELEGRAM_BOT_TOKEN: '1234567890:AAtest-token', TELEGRAM_BOT_USERNAME: 'gsm_test_bot' },
  });
});
beforeEach(async () => {
  clock.set(NOW);
  await resetDb();
  await clearIdentityCaches(t);
  const { db } = await testDb();
  await seedSupportTemplates(db);
  mailbox(t).reset();
  telegramOutbox(t).reset();
  admin = await supportStaff(t);
});
afterAll(async () => {
  await resetDb();
  await clearIdentityCaches(t);
  await t.close();
  await closeTestDb();
});

/** Moves the clock and signs a new staff member in: a session idles out when the clock jumps hours ahead. */
async function elapse(ms: number): Promise<void> {
  clock.advance(ms);
  admin = await supportStaff(t);
}

const ago = (ms: number) => new Date(clock.nowMs() - ms);
const ahead = (ms: number) => new Date(clock.nowMs() + ms);
const auditRows = async () => (await testDb()).db.select().from(s.auditLogs).orderBy(s.auditLogs.id);
const ticketRow = async (id: number) =>
  (await (await testDb()).db.select().from(s.supportTickets).where(eq(s.supportTickets.id, id)))[0]!;
const messagesOf = async (ticketId: number) =>
  (await testDb()).db
    .select()
    .from(s.ticketMessages)
    .where(eq(s.ticketMessages.ticketId, ticketId))
    .orderBy(s.ticketMessages.id);

/** A customer, a ticket of theirs that waits for a reply (their message is the last one) and that message. */
async function waitingTicket(values: Partial<typeof s.supportTickets.$inferInsert> = {}) {
  const { db } = await testDb();
  const customer = await insertCustomer(db, { name: 'Victor Hale', email: 'victor@mail.example' });
  const ticket = await insertSupportTicket(db, {
    requesterId: customer.id,
    subject: 'Where is my unlock?',
    status: 'new',
    priority: 'normal',
    category: 'delay',
    slaDueAt: ahead(HOUR),
    createdAt: ago(HOUR),
    updatedAt: ago(HOUR),
    ...values,
  });
  await insertSupportMessage(db, ticket.id, {
    authorType: 'customer',
    authorId: customer.id,
    body: 'I paid yesterday and still have no code.',
    createdAt: ago(HOUR),
  });
  return { db, customer, ticket };
}

describe('GET /admin/support-tickets', () => {
  it('lists a row with the joined requester and assignee, the status in the console’s words and the timers', async () => {
    const { db, customer, ticket } = await waitingTicket({ status: 'pending_customer', slaDueAt: null });
    const [staffId] = [admin.staffId];
    await db
      .update(s.supportTickets)
      .set({ assigneeId: staffId, firstResponseAt: ago(HOUR / 2), updatedAt: ago(HOUR) });
    await insertSupportMessage(db, ticket.id, {
      authorType: 'staff',
      authorId: staffId,
      body: 'On it.',
      createdAt: ago(HOUR / 2),
    });
    await insertSupportMessage(db, ticket.id, {
      authorType: 'staff',
      authorId: staffId,
      body: 'Note.',
      isInternal: true,
    });

    const res = await admin.get('/admin/support-tickets');
    expect(res.status).toBe(200);
    expect(res.total).toBe(1);
    expect(res.body).toEqual([
      {
        id: ticket.id,
        number: ticket.number,
        subject: 'Where is my unlock?',
        channel: 'web',
        requesterType: 'customer',
        requesterId: customer.id,
        requester: { name: 'Victor Hale', email: 'victor@mail.example' },
        orderId: null,
        category: 'delay',
        priority: 'normal',
        status: 'pending',
        assigneeId: staffId,
        assignee: { id: staffId, name: 'Lina S.' },
        slaDueAt: null,
        firstResponseAt: ago(HOUR / 2).toISOString(),
        resolvedAt: null,
        csatScore: null,
        createdAt: ago(HOUR).toISOString(),
        updatedAt: ago(HOUR).toISOString(),
        // The internal note is newer than the public reply but does not count.
        lastPublicAt: ago(HOUR / 2).toISOString(),
        late: false,
      },
    ]);
  });

  it('shows a merchant’s ticket with the merchant as requester, and an anonymized customer as Deleted customer', async () => {
    const { db } = await testDb();
    const merchant = await insertClient(db, { name: 'Zain Mobile Hub', email: 'ops@zain.example' });
    const gone = await insertCustomer(db, {
      name: 'Deleted customer',
      email: 'deleted-9@redacted.invalid',
      status: 'anonymized',
    });
    await insertSupportTicket(db, {
      requesterType: 'client',
      requesterId: merchant.id,
      token: null,
      subject: 'Invoice question',
    });
    await insertSupportTicket(db, { requesterId: gone.id, subject: 'Old ticket' });
    const names = Object.fromEntries(
      (await admin.get('/admin/support-tickets')).body.map((row: { subject: string; requester: unknown }) => [
        row.subject,
        row.requester,
      ]),
    );
    expect(names['Invoice question']).toEqual({ name: 'Zain Mobile Hub', email: 'ops@zain.example' });
    expect(names['Old ticket']).toEqual({ name: 'Deleted customer', email: null });
  });

  it('flags late from the clock: a reply is awaited and overdue, never for a resolved ticket', async () => {
    const { db, customer } = await waitingTicket({ slaDueAt: ahead(HOUR) });
    await insertSupportTicket(db, {
      requesterId: customer.id,
      subject: 'Resolved',
      status: 'resolved',
      slaDueAt: null,
    });
    expect((await admin.get('/admin/support-tickets?late=true')).total).toBe(0);
    await elapse(2 * HOUR);
    const late = await admin.get('/admin/support-tickets?late=true');
    expect(late.total).toBe(1);
    expect(late.body[0]).toMatchObject({ subject: 'Where is my unlock?', late: true });
    expect((await admin.get('/admin/support-tickets?late=false')).total).toBe(1);
  });

  it('sorts late tickets first and then by the latest activity', async () => {
    const { db, customer } = await waitingTicket({ slaDueAt: ago(HOUR), updatedAt: ago(5 * HOUR) });
    await insertSupportTicket(db, {
      requesterId: customer.id,
      subject: 'Newer',
      status: 'open',
      slaDueAt: ahead(HOUR),
      updatedAt: ago(1000),
    });
    await insertSupportTicket(db, {
      requesterId: customer.id,
      subject: 'Older',
      status: 'open',
      slaDueAt: ahead(HOUR),
      updatedAt: ago(HOUR),
    });
    const order = (await admin.get('/admin/support-tickets')).body.map((row: { subject: string }) => row.subject);
    expect(order).toEqual(['Where is my unlock?', 'Newer', 'Older']);
    const plain = (await admin.get('/admin/support-tickets?_sort=updatedAt&_order=asc')).body.map(
      (row: { subject: string }) => row.subject,
    );
    expect(plain).toEqual(['Where is my unlock?', 'Older', 'Newer']);
  });

  it('filters by status (a repeated key is IN; pending is the stored pending_customer), assignee, requester and search', async () => {
    const { db, customer } = await waitingTicket({ subject: 'First (SF-1)' });
    const other = await insertCustomer(db, { name: 'Alex Rowe', email: 'alex@mail.example' });
    const merchant = await insertClient(db, { name: 'Zain Mobile Hub' });
    await insertSupportTicket(db, {
      requesterId: customer.id,
      subject: 'Waiting',
      status: 'pending_customer',
      assigneeId: admin.staffId,
    });
    await insertSupportTicket(db, { requesterId: other.id, subject: 'Done', status: 'resolved' });
    await insertSupportTicket(db, {
      requesterType: 'client',
      requesterId: merchant.id,
      subject: 'Merchant',
      status: 'open',
      token: null,
    });
    const subjects = async (query: string) =>
      (await admin.get(`/admin/support-tickets?${query}&_sort=id&_order=asc`)).body.map(
        (row: { subject: string }) => row.subject,
      );
    expect(await subjects('status=new&status=open&status=pending')).toEqual(['First (SF-1)', 'Waiting', 'Merchant']);
    expect(await subjects('status=pending')).toEqual(['Waiting']);
    expect(await subjects('status=resolved')).toEqual(['Done']);
    expect(await subjects(`assigneeId=${admin.staffId}`)).toEqual(['Waiting']);
    expect(await subjects('requesterType=client')).toEqual(['Merchant']);
    expect(await subjects(`requesterType=customer&requesterId=${other.id}`)).toEqual(['Done']);
    expect(await subjects('q=alex')).toEqual(['Done']);
    expect(await subjects('q=zain')).toEqual(['Merchant']);
    expect(await subjects('q=sf-1')).toEqual(['First (SF-1)']);
    expect(await subjects('q=T-90')).toHaveLength(4);
    // The status words are the console's: `closed` and `pending_customer` are not accepted.
    expect((await admin.get('/admin/support-tickets?status=closed')).status).toBe(422);
    expect((await admin.get('/admin/support-tickets?status=pending_customer')).status).toBe(422);
  });

  it('finds a ticket by the requester’s email address too, so a guest shown by email is findable (not an anonymized one)', async () => {
    const { db } = await testDb();
    const guest = await insertCustomer(db, { name: '', email: 'no.name.guest@mail.example' });
    const named = await insertCustomer(db, { name: 'Alex Rowe', email: 'alex@other.example' });
    const gone = await insertCustomer(db, {
      name: 'Deleted customer',
      email: 'erased-1@redacted.invalid',
      status: 'anonymized',
    });
    const merchant = await insertClient(db, { name: 'Zain Mobile Hub', email: 'desk@zain-hub.example' });
    await insertSupportTicket(db, { requesterId: guest.id, subject: 'Nameless' });
    await insertSupportTicket(db, { requesterId: named.id, subject: 'Named' });
    await insertSupportTicket(db, { requesterId: gone.id, subject: 'Gone' });
    await insertSupportTicket(db, {
      requesterType: 'client',
      requesterId: merchant.id,
      subject: 'Merchant',
      token: null,
    });
    const subjects = async (query: string) =>
      (await admin.get(`/admin/support-tickets?${query}&_sort=id&_order=asc`)).body.map(
        (row: { subject: string }) => row.subject,
      );
    expect(await subjects('q=no.name.guest@mail')).toEqual(['Nameless']);
    // Ignoring case, and a part of the address counts.
    expect(await subjects('q=NO.NAME.GUEST')).toEqual(['Nameless']);
    expect(await subjects('q=%40other.example')).toEqual(['Named']);
    expect(await subjects('q=zain-hub.example')).toEqual(['Merchant']);
    // The inbox shows the guest by their address, and that is what the search finds.
    const shown = (await admin.get('/admin/support-tickets?q=no.name.guest')).body[0];
    expect(shown.requester).toEqual({ name: 'no.name.guest@mail.example', email: 'no.name.guest@mail.example' });
    // An anonymized customer's address is never shown, so it is not searchable either.
    expect(await subjects('q=erased-1')).toEqual([]);
  });

  it('pages with the exact total (the console’s one-row count calls)', async () => {
    const { db, customer } = await waitingTicket();
    for (let n = 0; n < 4; n += 1) await insertSupportTicket(db, { requesterId: customer.id, subject: `More ${n}` });
    const res = await admin.get('/admin/support-tickets?_start=0&_end=1');
    expect(res.body).toHaveLength(1);
    expect(res.total).toBe(5);
    expect((await admin.get('/admin/support-tickets?_start=3&_end=10')).body).toHaveLength(2);
  });

  it('needs support:read', async () => {
    const other = await supportStaff(t, ['groups:read']);
    expect((await other.get('/admin/support-tickets')).status).toBe(403);
    expect((await (await supportStaff(t, ['support:read'])).get('/admin/support-tickets')).status).toBe(200);
  });
});

describe('GET /admin/support-tickets/:id', () => {
  it('embeds the thread oldest first with internal notes, the joined author names and the reply channels', async () => {
    const { db, customer, ticket } = await waitingTicket();
    await insertSupportMessage(db, ticket.id, {
      authorType: 'staff',
      authorId: admin.staffId,
      body: 'Checking with the supplier.',
      createdAt: ago(HOUR / 2),
    });
    await insertSupportMessage(db, ticket.id, {
      authorType: 'staff',
      authorId: admin.staffId,
      body: 'Internal: supplier is slow.',
      isInternal: true,
      createdAt: ago(HOUR / 3),
    });
    await insertSupportMessage(db, ticket.id, {
      authorType: 'system',
      body: 'Marked resolved by Lina S.',
      isInternal: true,
      createdAt: ago(HOUR / 4),
    });
    const res = await admin.get(`/admin/support-tickets/${ticket.id}`);
    expect(res.status).toBe(200);
    expect(res.body.replyChannels).toEqual(['email']);
    expect(
      res.body.messages.map((m: { authorType: string; authorName: string; isInternal: boolean }) => [
        m.authorType,
        m.authorName,
        m.isInternal,
      ]),
    ).toEqual([
      ['customer', 'Victor Hale', false],
      ['staff', 'Lina S.', false],
      ['staff', 'Lina S.', true],
      ['system', 'System', true],
    ]);
    expect(res.body.messages[0]).toMatchObject({ ticketId: ticket.id, authorId: customer.id, fileIds: [] });
    expect(res.body).toMatchObject({ id: ticket.id, status: 'new', requester: { name: 'Victor Hale' } });
  });

  it('offers Telegram only for a merchant with a linked chat, and no channel for an anonymized customer', async () => {
    const { db } = await testDb();
    const linked = await insertClient(db, { telegramChatId: '555001' });
    const plain = await insertClient(db);
    const gone = await insertCustomer(db, { status: 'anonymized', email: 'deleted-1@redacted.invalid' });
    const a = await insertSupportTicket(db, { requesterType: 'client', requesterId: linked.id, token: null });
    const b = await insertSupportTicket(db, { requesterType: 'client', requesterId: plain.id, token: null });
    const c = await insertSupportTicket(db, { requesterId: gone.id });
    expect((await admin.get(`/admin/support-tickets/${a.id}`)).body.replyChannels).toEqual(['email', 'telegram']);
    expect((await admin.get(`/admin/support-tickets/${b.id}`)).body.replyChannels).toEqual(['email']);
    expect((await admin.get(`/admin/support-tickets/${c.id}`)).body.replyChannels).toEqual([]);
  });

  it('answers 404 for an unknown ticket', async () => {
    const res = await admin.get('/admin/support-tickets/999999');
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('NOT_FOUND');
  });

  it('needs support:read, and a role that only holds other permissions never sees the thread', async () => {
    const { ticket } = await waitingTicket();
    const other = await supportStaff(t, ['groups:read']);
    const refused = await other.get(`/admin/support-tickets/${ticket.id}`);
    expect(refused.status).toBe(403);
    expect(refused.body.code).toBe('FORBIDDEN');
    expect(refused.body.detail).toContain('support:read');
    expect(refused.body.messages).toBeUndefined();
    // The writers of tickets do not read them by that alone.
    const writer = await supportStaff(t, ['support:update', 'support:reply']);
    expect((await writer.get(`/admin/support-tickets/${ticket.id}`)).status).toBe(403);
    expect((await (await supportStaff(t, ['support:read'])).get(`/admin/support-tickets/${ticket.id}`)).status).toBe(
      200,
    );
  });
});

describe('PATCH /admin/support-tickets/:id', () => {
  it('changes the priority, moves the reply target to the new priority and audits it', async () => {
    const { ticket } = await waitingTicket({ priority: 'normal', slaDueAt: ahead(7 * HOUR) });
    const res = await admin.patch(`/admin/support-tickets/${ticket.id}`, { priority: 'high' });
    expect(res.status).toBe(200);
    // The customer wrote an hour ago; high is due 2 hours after that message.
    expect(res.body).toMatchObject({ priority: 'high', slaDueAt: ahead(HOUR).toISOString(), late: false });
    const [audit] = await auditRows();
    expect(audit).toMatchObject({
      actorId: admin.staffId,
      action: 'changed priority of ticket',
      entityType: 'ticket',
      entityId: ticket.id,
      entityLabel: `${ticket.number}, Where is my unlock?`,
      before: { priority: 'normal' },
      after: { priority: 'high' },
    });
    await elapse(2 * HOUR);
    expect((await admin.get(`/admin/support-tickets/${ticket.id}`)).body.late).toBe(true);
  });

  it('assigns an active staff member and unassigns with null, each audited, and refuses anyone else on assigneeId', async () => {
    const { db } = await testDb();
    const { ticket } = await waitingTicket();
    const role = await insertRole(db, ['support:*']);
    const omar = await insertStaff(db, role, { name: 'Omar H.' });
    const suspended = await insertStaff(db, role, { name: 'Gone', status: 'suspended' });
    const invited = await insertStaff(db, role, { name: 'New', status: 'invited' });

    const assigned = await admin.patch(`/admin/support-tickets/${ticket.id}`, { assigneeId: omar });
    expect(assigned.body).toMatchObject({ assigneeId: omar, assignee: { id: omar, name: 'Omar H.' } });
    expect((await auditRows())[0]).toMatchObject({
      action: 'assigned ticket',
      after: { assigneeId: omar, assignee: 'Omar H.' },
    });

    for (const bad of [suspended, invited, 999_999]) {
      const refused = await admin.patch(`/admin/support-tickets/${ticket.id}`, { assigneeId: bad });
      expect(refused.status).toBe(422);
      expect(refused.body.errors).toEqual([expect.objectContaining({ field: 'assigneeId' })]);
    }
    const cleared = await admin.patch(`/admin/support-tickets/${ticket.id}`, { assigneeId: null });
    expect(cleared.body).toMatchObject({ assigneeId: null, assignee: null });
    expect((await auditRows())[1]).toMatchObject({
      // The demo's one phrase: clearing the assignee is 'assigned ticket' with the assignee none (ANSWERS audit Q3).
      action: 'assigned ticket',
      before: { assigneeId: omar, assignee: 'Omar H.' },
      after: { assigneeId: null, assignee: null },
    });
  });

  it('ignores values equal to the current ones: nothing changes, the updated time stays, one neutral audit entry', async () => {
    const { ticket } = await waitingTicket({ priority: 'normal' });
    const res = await admin.patch(`/admin/support-tickets/${ticket.id}`, {
      priority: 'normal',
      status: 'new',
      assigneeId: null,
    });
    expect(res.status).toBe(200);
    expect(res.body.updatedAt).toBe(ago(HOUR).toISOString());
    // Nothing changed, so no change is audited; the request itself leaves one entry (every staff write does).
    expect((await auditRows()).map((row) => row.action)).toEqual(['edited ticket']);
    expect((await ticketRow(ticket.id)).updatedAt.toISOString()).toBe(ago(HOUR).toISOString());
  });

  it('resolves: stamps resolved_at, writes the internal system message, clears the target, emails the survey and audits it', async () => {
    const { ticket } = await waitingTicket({ status: 'open', slaDueAt: ahead(HOUR) });
    const res = await admin.patch(`/admin/support-tickets/${ticket.id}`, { status: 'resolved' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: 'resolved', resolvedAt: NOW, slaDueAt: null, late: false });

    const thread = await messagesOf(ticket.id);
    expect(thread.at(-1)).toMatchObject({
      authorType: 'system',
      authorId: null,
      isInternal: true,
      body: 'Marked resolved by Lina S.. A satisfaction survey is emailed to the customer.',
    });
    expect((await auditRows())[0]).toMatchObject({
      action: 'resolved ticket',
      before: { status: 'open' },
      after: { status: 'resolved' },
    });

    // The survey is an outbox event with ids only; the job makes the notification row and sends it.
    const { db } = await testDb();
    const events = await ticketMailEvents(db);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      aggregateType: 'support_tickets',
      aggregateId: ticket.id,
      payload: expect.objectContaining({ kind: 'survey' }),
    });
    expect(await notificationRows(db)).toHaveLength(0);
    expect(await sendTicketMails(t)).toEqual([{ sent: true }]);
    const [row] = await notificationRows(db);
    expect(row).toMatchObject({
      event: 'support.csat_survey',
      recipientType: 'customer',
      channel: 'email',
      status: 'sent',
    });
    // The link holds the ticket token: it reaches the customer and never the stored row, which the notification log shows.
    expect(JSON.stringify(row!.payload)).not.toContain(ticket.token!);
    const mail = mailbox(t).sent;
    expect(mail).toHaveLength(1);
    expect(mail[0]!.subject).toBe(`How did we do? (${ticket.number})`);
    expect(mail[0]!.text).toContain(`/support/tickets/${ticket.token}`);
  });

  it('reopens a resolved ticket to open, clears resolved_at and restarts the target from the customer’s last message', async () => {
    const { ticket } = await waitingTicket({ status: 'resolved', resolvedAt: ago(1000), slaDueAt: null });
    const res = await admin.patch(`/admin/support-tickets/${ticket.id}`, { status: 'open' });
    expect(res.body).toMatchObject({ status: 'open', resolvedAt: null, slaDueAt: ahead(7 * HOUR).toISOString() });
    expect((await auditRows())[0]).toMatchObject({
      action: 'reopened ticket',
      before: { status: 'resolved' },
      after: { status: 'open' },
    });
    expect(await ticketMailEvents((await testDb()).db)).toHaveLength(0);
  });

  it('lets staff open a new ticket and mark one as waiting on the customer, and refuses the moves a ticket cannot make', async () => {
    const { ticket } = await waitingTicket();
    expect((await admin.patch(`/admin/support-tickets/${ticket.id}`, { status: 'open' })).body.status).toBe('open');
    const pending = await admin.patch(`/admin/support-tickets/${ticket.id}`, { status: 'pending' });
    expect(pending.body).toMatchObject({ status: 'pending', slaDueAt: null });
    expect((await ticketRow(ticket.id)).status).toBe('pending_customer');
    expect((await auditRows()).map((row) => row.action)).toEqual([
      'changed status of ticket',
      'changed status of ticket',
    ]);

    const backToNew = await admin.patch(`/admin/support-tickets/${ticket.id}`, { status: 'new' });
    expect(backToNew.status).toBe(422);
    expect(backToNew.body.errors).toEqual([
      expect.objectContaining({ field: 'status', message: 'A ticket cannot go back to new.' }),
    ]);
    await admin.patch(`/admin/support-tickets/${ticket.id}`, { status: 'resolved' });
    const fromResolved = await admin.patch(`/admin/support-tickets/${ticket.id}`, { status: 'pending' });
    expect(fromResolved.status).toBe(422);
    expect(fromResolved.body.errors).toEqual([expect.objectContaining({ field: 'status' })]);
    const closed = await admin.patch(`/admin/support-tickets/${ticket.id}`, { status: 'closed' });
    expect(closed.status).toBe(422);
    expect(closed.body.errors).toEqual([expect.objectContaining({ field: 'status' })]);
  });

  it('sends the survey once per ticket: resolving again after a reopen asks nobody, rated or not', async () => {
    const { db } = await testDb();
    const patch = (id: number, status: string) => admin.patch(`/admin/support-tickets/${id}`, { status });
    const surveys = async () =>
      (await ticketMailEvents(db)).filter((event) => (event.payload as { kind: string }).kind === 'survey');

    // Not rated: resolve, reopen, resolve again.
    const { ticket } = await waitingTicket({ status: 'open' });
    expect((await ticketRow(ticket.id)).surveySentAt).toBeNull();
    expect((await patch(ticket.id, 'resolved')).status).toBe(200);
    expect(await surveys()).toHaveLength(1);
    // The record of the survey is a column, set when it is queued.
    expect((await ticketRow(ticket.id)).surveySentAt?.toISOString()).toBe(NOW);
    // ... and the injected clock, not the wall clock, stays the ticket's updated time.
    expect((await ticketRow(ticket.id)).updatedAt.toISOString()).toBe(NOW);
    expect((await patch(ticket.id, 'open')).status).toBe(200);
    await elapse(HOUR);
    expect((await patch(ticket.id, 'resolved')).status).toBe(200);
    expect(await surveys()).toHaveLength(1);
    // The second resolve leaves the first time as it was.
    expect((await ticketRow(ticket.id)).surveySentAt?.toISOString()).toBe(NOW);
    // The thread says so: the first resolve announces the survey, the second only the resolve.
    const notes = (await messagesOf(ticket.id)).filter((message) => message.authorType === 'system');
    expect(notes.map((note) => note.body)).toEqual([
      'Marked resolved by Lina S.. A satisfaction survey is emailed to the customer.',
      'Marked resolved by Lina S..',
    ]);

    // Rated: the customer rated after the first resolve, then the ticket is reopened and resolved again.
    const rated = await insertSupportTicket(db, { requesterId: ticket.requesterId, status: 'open' });
    await patch(rated.id, 'resolved');
    await db.update(s.supportTickets).set({ csatScore: 5 }).where(eq(s.supportTickets.id, rated.id));
    await patch(rated.id, 'open');
    await patch(rated.id, 'resolved');
    expect((await surveys()).filter((event) => event.aggregateId === rated.id)).toHaveLength(1);

    // A different ticket of the same customer is asked on its own.
    const other = await insertSupportTicket(db, { requesterId: ticket.requesterId, status: 'open' });
    await patch(other.id, 'resolved');
    expect((await surveys()).filter((event) => event.aggregateId === other.id)).toHaveLength(1);
  });

  it('decides "already asked" from the survey column, not from the words of the system message or the name of the staff member', async () => {
    const { db } = await testDb();
    const patch = (id: number, status: string) => admin.patch(`/admin/support-tickets/${id}`, { status });
    const surveys = async () =>
      (await ticketMailEvents(db)).filter((event) => (event.payload as { kind: string }).kind === 'survey');
    const { ticket } = await waitingTicket({ status: 'open' });
    await patch(ticket.id, 'resolved');
    expect(await surveys()).toHaveLength(1);

    // The staff member is renamed to a name that ends with the survey sentence, and the old system message is reworded (a translation):
    // neither changes the record, so the second resolve asks nobody and writes the plain note.
    await db
      .update(s.staffUsers)
      .set({ name: 'Lina S. A satisfaction survey is emailed to the customer' })
      .where(eq(s.staffUsers.id, admin.staffId));
    await db
      .update(s.ticketMessages)
      .set({ body: 'Ticket gelöst. Eine Umfrage wurde gesendet.' })
      .where(eq(s.ticketMessages.ticketId, ticket.id));
    await patch(ticket.id, 'open');
    await patch(ticket.id, 'resolved');
    expect(await surveys()).toHaveLength(1);
    expect((await ticketRow(ticket.id)).surveySentAt?.toISOString()).toBe(NOW);
    const notes = (await messagesOf(ticket.id)).filter((message) => message.authorType === 'system');
    expect(notes.at(-1)!.body).toBe('Marked resolved by Lina S. A satisfaction survey is emailed to the customer.');

    // The other way round: a note that carries the sentence is not a record. A ticket that got no survey (no ticket page yet) keeps
    // `survey_sent_at` empty, and is asked once it can be.
    const quiet = await insertSupportTicket(db, { requesterId: ticket.requesterId, status: 'open', token: null });
    await patch(quiet.id, 'resolved');
    expect(await surveys()).toHaveLength(1);
    expect((await ticketRow(quiet.id)).surveySentAt).toBeNull();
    await db.update(s.supportTickets).set({ token: 'tok-later' }).where(eq(s.supportTickets.id, quiet.id));
    await patch(quiet.id, 'open');
    await patch(quiet.id, 'resolved');
    expect((await surveys()).filter((event) => event.aggregateId === quiet.id)).toHaveLength(1);
    expect((await ticketRow(quiet.id)).surveySentAt).not.toBeNull();
  });

  it('does not ask a rated ticket for a second survey, and sends none for a merchant’s ticket', async () => {
    const { db } = await testDb();
    const { ticket } = await waitingTicket({ status: 'open', csatScore: 4 });
    await admin.patch(`/admin/support-tickets/${ticket.id}`, { status: 'resolved' });
    const merchant = await insertClient(db);
    const merchantTicket = await insertSupportTicket(db, {
      requesterType: 'client',
      requesterId: merchant.id,
      token: null,
      status: 'open',
    });
    await admin.patch(`/admin/support-tickets/${merchantTicket.id}`, { status: 'resolved' });
    expect(await ticketMailEvents(db)).toHaveLength(0);
    expect((await messagesOf(merchantTicket.id)).at(-1)!.body).toBe('Marked resolved by Lina S..');
  });

  it('validates the body and needs support:update', async () => {
    const { ticket } = await waitingTicket();
    expect((await admin.patch(`/admin/support-tickets/${ticket.id}`, {})).status).toBe(422);
    expect((await admin.patch(`/admin/support-tickets/${ticket.id}`, { priority: 'urgent' })).body.errors).toEqual([
      expect.objectContaining({ field: 'priority', message: 'Choose high, normal or low.' }),
    ]);
    expect((await admin.patch('/admin/support-tickets/999999', { priority: 'high' })).status).toBe(404);
    const reader = await supportStaff(t, ['support:read', 'support:reply']);
    const refused = await reader.patch(`/admin/support-tickets/${ticket.id}`, { priority: 'high' });
    expect(refused.status).toBe(403);
    expect(refused.body.detail).toContain('support:update');
    expect((await admin.withoutCsrf('PATCH', `/admin/support-tickets/${ticket.id}`, { priority: 'high' })).status).toBe(
      403,
    );
  });

  it('keeps two changes at once consistent: a reply and a resolve never both pass the same check', async () => {
    const { ticket } = await waitingTicket({ status: 'open' });
    const [reply, resolve] = await Promise.all([
      admin.post(`/admin/support-tickets/${ticket.id}/reply`, { body: 'Hello' }),
      admin.patch(`/admin/support-tickets/${ticket.id}`, { status: 'resolved' }),
    ]);
    expect(resolve.status).toBe(200);
    // Either the reply went first (then the ticket was resolved) or it met the resolved ticket.
    expect([201, 409]).toContain(reply.status);
    const row = await ticketRow(ticket.id);
    expect(row.status).toBe('resolved');
    expect(row.slaDueAt).toBeNull();
  });
});

describe('POST /admin/support-tickets/:id/reply', () => {
  it('adds a public staff message, moves the ticket to waiting, stamps the first response, assigns the sender and emails the customer', async () => {
    const { ticket } = await waitingTicket({ status: 'new' });
    await elapse(10 * 60_000);
    const res = await admin.post(`/admin/support-tickets/${ticket.id}/reply`, {
      body: '  Hi Victor, your order is with the carrier.  ',
    });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      ticketId: ticket.id,
      authorType: 'staff',
      authorId: admin.staffId,
      authorName: 'Lina S.',
      body: 'Hi Victor, your order is with the carrier.',
      isInternal: false,
      fileIds: [],
      createdAt: '2026-11-08T12:10:00.000Z',
    });
    const row = await ticketRow(ticket.id);
    expect(row).toMatchObject({ status: 'pending_customer', assigneeId: admin.staffId, slaDueAt: null });
    expect(row.firstResponseAt?.toISOString()).toBe('2026-11-08T12:10:00.000Z');
    expect(row.updatedAt.toISOString()).toBe('2026-11-08T12:10:00.000Z');
    expect((await auditRows())[0]).toMatchObject({
      action: 'replied to ticket',
      entityId: ticket.id,
      after: { messageId: res.body.id, channel: 'email' },
    });

    expect(await sendTicketMails(t)).toEqual([{ sent: true }]);
    const [mail] = mailbox(t).sent;
    expect(mail).toMatchObject({ to: 'victor@mail.example', subject: `Re: Where is my unlock? (${ticket.number})` });
    expect(mail!.text).toContain('Hi Victor Hale,');
    expect(mail!.text).toContain('Hi Victor, your order is with the carrier.');
    expect(mail!.text).toContain(`/support/tickets/${ticket.token}`);
  });

  it('keeps the first response time and the assignee on a second reply', async () => {
    const { db } = await testDb();
    const role = await insertRole(db, ['support:*']);
    const omar = await insertStaff(db, role, { name: 'Omar H.' });
    const { ticket } = await waitingTicket({ status: 'open', assigneeId: omar, firstResponseAt: ago(HOUR / 2) });
    await admin.post(`/admin/support-tickets/${ticket.id}/reply`, { body: 'First' });
    await admin.post(`/admin/support-tickets/${ticket.id}/reply`, { body: 'Second' });
    const row = await ticketRow(ticket.id);
    expect(row.assigneeId).toBe(omar);
    expect(row.firstResponseAt?.toISOString()).toBe(ago(HOUR / 2).toISOString());
    expect(row.status).toBe('pending_customer');
    expect(await messagesOf(ticket.id)).toHaveLength(3);
  });

  it('is refused with 409 TICKET_RESOLVED on a resolved ticket, and works again after a reopen', async () => {
    const { ticket } = await waitingTicket({ status: 'resolved', resolvedAt: ago(1000), slaDueAt: null });
    const refused = await admin.post(`/admin/support-tickets/${ticket.id}/reply`, { body: 'Hello' });
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe('TICKET_RESOLVED');
    expect(await messagesOf(ticket.id)).toHaveLength(1);
    await admin.patch(`/admin/support-tickets/${ticket.id}`, { status: 'open' });
    expect((await admin.post(`/admin/support-tickets/${ticket.id}/reply`, { body: 'Hello' })).status).toBe(201);
  });

  it('refuses an empty text on body and a channel the ticket cannot use on channel', async () => {
    const { ticket } = await waitingTicket();
    const empty = await admin.post(`/admin/support-tickets/${ticket.id}/reply`, { body: '   ' });
    expect(empty.status).toBe(422);
    expect(empty.body.errors).toEqual([expect.objectContaining({ field: 'body', message: 'Write a reply first.' })]);
    const telegram = await admin.post(`/admin/support-tickets/${ticket.id}/reply`, {
      body: 'Hello',
      channel: 'telegram',
    });
    expect(telegram.status).toBe(422);
    expect(telegram.body.errors).toEqual([expect.objectContaining({ field: 'channel' })]);
    const sms = await admin.post(`/admin/support-tickets/${ticket.id}/reply`, { body: 'Hello', channel: 'sms' });
    expect(sms.status).toBe(422);
    expect(await messagesOf(ticket.id)).toHaveLength(1);
    expect(await ticketMailEvents((await testDb()).db)).toHaveLength(0);
  });

  it('answers a merchant on Telegram when their chat is linked, and on the ticket’s own channel by default', async () => {
    const { db } = await testDb();
    const merchant = await insertClient(db, { name: 'Zain Mobile Hub', telegramChatId: '555001' });
    const ticket = await insertSupportTicket(db, {
      requesterType: 'client',
      requesterId: merchant.id,
      token: null,
      channel: 'telegram',
      subject: 'Invoice question',
      status: 'new',
    });
    const byDefault = await admin.post(`/admin/support-tickets/${ticket.id}/reply`, { body: 'Issued in USD.' });
    expect(byDefault.status).toBe(201);
    const byEmail = await admin.post(`/admin/support-tickets/${ticket.id}/reply`, {
      body: 'See the statement.',
      channel: 'email',
    });
    expect(byEmail.status).toBe(201);
    expect(await sendTicketMails(t)).toEqual([{ sent: true }, { sent: true }]);
    expect(telegramOutbox(t).sent.map((sent) => sent.text)).toEqual([
      `Support replied on ${ticket.number} (Invoice question):\nIssued in USD.`,
    ]);
    expect(telegramOutbox(t).sent[0]).toMatchObject({ chatId: '555001' });
    expect(mailbox(t).sent).toHaveLength(1);
    expect(mailbox(t).sent[0]).toMatchObject({ subject: `Re: Invoice question (${ticket.number})` });
    expect(mailbox(t).sent[0]!.text).toContain('Hi Zain Mobile Hub,');
  });

  it('refuses Telegram for a merchant with no linked chat', async () => {
    const { db } = await testDb();
    const merchant = await insertClient(db);
    const ticket = await insertSupportTicket(db, { requesterType: 'client', requesterId: merchant.id, token: null });
    const res = await admin.post(`/admin/support-tickets/${ticket.id}/reply`, { body: 'Hello', channel: 'telegram' });
    expect(res.status).toBe(422);
    expect(res.body.errors).toEqual([expect.objectContaining({ field: 'channel' })]);
  });

  it('cannot answer an anonymized customer: nothing is written or sent', async () => {
    const { db } = await testDb();
    const gone = await insertCustomer(db, { status: 'anonymized', email: 'deleted-1@redacted.invalid' });
    const ticket = await insertSupportTicket(db, { requesterId: gone.id });
    const res = await admin.post(`/admin/support-tickets/${ticket.id}/reply`, { body: 'Hello' });
    expect(res.status).toBe(422);
    expect(res.body.errors).toEqual([expect.objectContaining({ field: 'channel' })]);
    expect(await messagesOf(ticket.id)).toHaveLength(0);
  });

  it('stores the reply and sends nothing when the email template is switched off', async () => {
    const { db } = await testDb();
    await db
      .update(s.notificationTemplates)
      .set({ isActive: false })
      .where(eq(s.notificationTemplates.event, 'support.reply'));
    const { ticket } = await waitingTicket();
    expect((await admin.post(`/admin/support-tickets/${ticket.id}/reply`, { body: 'Hello' })).status).toBe(201);
    expect(await sendTicketMails(t)).toEqual([{ sent: false, skipped: 'template_off' }]);
    expect(await notificationRows(db)).toHaveLength(0);
    expect(mailbox(t).sent).toHaveLength(0);
    expect((await ticketRow(ticket.id)).status).toBe('pending_customer');
  });

  it('answers 404 for an unknown ticket and needs support:reply', async () => {
    expect((await admin.post('/admin/support-tickets/999999/reply', { body: 'Hello' })).status).toBe(404);
    const { ticket } = await waitingTicket();
    const reader = await supportStaff(t, ['support:read', 'support:update']);
    const refused = await reader.post(`/admin/support-tickets/${ticket.id}/reply`, { body: 'Hello' });
    expect(refused.status).toBe(403);
    expect(refused.body.detail).toContain('support:reply');
  });
});

describe('POST /admin/support-tickets/:id/note', () => {
  it('adds an internal note, keeps the status, takes an unassigned ticket and moves the updated time', async () => {
    const { ticket } = await waitingTicket({ status: 'open' });
    await elapse(5 * 60_000);
    const res = await admin.post(`/admin/support-tickets/${ticket.id}/note`, {
      body: 'Supplier says the carrier is slow.',
    });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      authorType: 'staff',
      authorName: 'Lina S.',
      isInternal: true,
      body: 'Supplier says the carrier is slow.',
    });
    const row = await ticketRow(ticket.id);
    expect(row).toMatchObject({ status: 'open', assigneeId: admin.staffId });
    expect(row.updatedAt.toISOString()).toBe('2026-11-08T12:05:00.000Z');
    // A note is not a reply: the customer is still the last public voice, so the target stands.
    expect(row.slaDueAt?.toISOString()).toBe('2026-11-08T13:00:00.000Z');
    expect(row.firstResponseAt).toBeNull();
    expect(await ticketMailEvents((await testDb()).db)).toHaveLength(0);
    expect((await auditRows())[0]).toMatchObject({ action: 'added note to ticket', entityId: ticket.id });
  });

  it('is allowed on a resolved ticket and needs a text', async () => {
    const { ticket } = await waitingTicket({ status: 'resolved', resolvedAt: ago(1000), slaDueAt: null });
    expect((await admin.post(`/admin/support-tickets/${ticket.id}/note`, { body: 'Late note.' })).status).toBe(201);
    expect((await ticketRow(ticket.id)).status).toBe('resolved');
    const empty = await admin.post(`/admin/support-tickets/${ticket.id}/note`, { body: '' });
    expect(empty.status).toBe(422);
    expect(empty.body.errors).toEqual([expect.objectContaining({ field: 'body', message: 'Write the note first.' })]);
    expect((await admin.post('/admin/support-tickets/999999/note', { body: 'x' })).status).toBe(404);
  });

  it('needs support:reply: reading and updating are not enough, and nothing is written', async () => {
    const { ticket } = await waitingTicket();
    const reader = await supportStaff(t, ['support:read', 'support:update']);
    const refused = await reader.post(`/admin/support-tickets/${ticket.id}/note`, { body: 'Sneaky note.' });
    expect(refused.status).toBe(403);
    expect(refused.body.code).toBe('FORBIDDEN');
    expect(refused.body.detail).toContain('support:reply');
    expect(await messagesOf(ticket.id)).toHaveLength(1);
    expect(await auditRows()).toHaveLength(0);
    const allowed = await supportStaff(t, ['support:reply']);
    expect((await allowed.post(`/admin/support-tickets/${ticket.id}/note`, { body: 'Fine note.' })).status).toBe(201);
  });
});

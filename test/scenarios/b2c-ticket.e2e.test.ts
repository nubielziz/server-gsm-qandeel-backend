// End-to-end walk of the map scenario `b2c-ticket` (a support ticket about a delay, docs/slices/support.json), step by step through HTTP on the
// real application: the tables and statuses each step names are read back from Postgres. The steps share one story, so the tests of this
// file run in order and keep their state in the variables below.
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { eq } from 'drizzle-orm';
import { schema as s } from '../../src/infra/db';
import { type AdminApi } from '../support/admin-api';
import { type TestApp, createTestApp } from '../support/app';
import { clearIdentityCaches } from '../support/auth';
import { insertCategory, insertService } from '../support/catalog';
import { HOUR, MINUTE, TestClock } from '../support/clock';
import { closeTestDb, resetDb, testDb } from '../support/db';
import { mailbox, notificationRows } from '../support/notifications';
import { insertOrderRow } from '../support/orders';
import { freshClientIp } from '../support/pipeline-routes';
import { TURNSTILE_HEADERS, insertCurrency } from '../support/storefront';
import {
  insertCustomer,
  seedSupportTemplates,
  sendTicketMails,
  supportStaff,
  ticketMailEvents,
} from '../support/support';

const clock = new TestClock('2026-11-08T09:00:00.000Z');
let t: TestApp;
let staff: AdminApi;
const TRACKING_TOKEN = 'T7kq2Zp9Xw4Ld1Hn6Rb3Yc';
let customerId = 0;
let orderId = 0;
let templateBody = '';
let ticketId = 0;
let ticketNumber = '';
let token = '';

beforeAll(async () => {
  t = await createTestApp({ clock });
  clock.set('2026-11-08T09:00:00.000Z');
  await resetDb();
  await clearIdentityCaches(t);
  const { db } = await testDb();
  await seedSupportTemplates(db);
  await insertCurrency(db, { code: 'USD' });
  const customer = await insertCustomer(db, { name: 'Victor Hale', email: 'victor@mail.example' });
  customerId = customer.id;
  const order = await insertOrderRow(db, {
    serviceId: await insertService(db, await insertCategory(db)),
    customerId,
    source: 'store',
    publicToken: TRACKING_TOKEN,
  });
  orderId = order.id;
  // The reply template the agent uses in step 4 (the console fills the variables).
  const [template] = await db
    .insert(s.replyTemplates)
    .values({
      title: 'Order is in progress',
      category: 'delay',
      body: 'Hi {{name}}, your order {{order}} is with the carrier; the usual time is {{eta}}.',
    })
    .returning();
  templateBody = template!.body
    .replace('{{name}}', 'Victor')
    .replace('{{order}}', `SF-${orderId}`)
    .replace('{{eta}}', '2h');
  mailbox(t).reset();
  staff = await supportStaff(t, ['support:*'], 'Lina S.');
});
afterAll(async () => {
  await resetDb();
  await clearIdentityCaches(t);
  await t.close();
  await closeTestDb();
});

const tickets = async () => (await testDb()).db.select().from(s.supportTickets);
const ticket = async () => (await tickets()).find((row) => row.id === ticketId)!;
const messages = async () =>
  (await testDb()).db
    .select()
    .from(s.ticketMessages)
    .where(eq(s.ticketMessages.ticketId, ticketId))
    .orderBy(s.ticketMessages.id);
const call = (method: 'GET' | 'POST', url: string, payload?: unknown, headers: Record<string, string> = {}) =>
  t.app.inject({
    method,
    url,
    headers,
    remoteAddress: freshClientIp(),
    ...(payload === undefined ? {} : { payload: payload as never }),
  });
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- test bodies are untyped JSON
const json = (res: { json: () => any }): any => res.json();

describe('scenario b2c-ticket: a support ticket about a delay', () => {
  it('step 1 (POST /store/v1/tickets): the customer opens a ticket from the tracking page, with no account, category delay', async () => {
    const res = await call(
      'POST',
      '/store/v1/tickets',
      {
        subject: `Where is my unlock? (SF-${orderId})`,
        message: 'The order took longer than expected. Can you check?',
        category: 'delay',
        orderToken: TRACKING_TOKEN,
      },
      TURNSTILE_HEADERS,
    );
    expect(res.statusCode).toBe(201);
    const view = json(res);
    token = view.token;
    ticketNumber = view.number;
    expect(view).toMatchObject({ status: 'new', category: 'delay', orderId });
    expect(view.messages).toHaveLength(1);
    ticketId = (await tickets())[0]!.id;
  });

  it('step 2: the ticket is `new` with a number, a priority and sla_due_at by its category, and its first message', async () => {
    const row = await ticket();
    expect(row).toMatchObject({
      number: `T-${ticketId}`,
      status: 'new',
      priority: 'normal',
      category: 'delay',
      requesterType: 'customer',
      requesterId: customerId,
      orderId,
      assigneeId: null,
      firstResponseAt: null,
    });
    expect(ticketNumber).toBe(row.number);
    // The customer wrote at 09:00 and a normal ticket is answered within 8 hours.
    expect(row.slaDueAt?.toISOString()).toBe('2026-11-08T17:00:00.000Z');
    const thread = await messages();
    expect(thread).toHaveLength(1);
    expect(thread[0]).toMatchObject({ authorType: 'customer', authorId: customerId, isInternal: false });
    // The receipt is an outbox event written with the ticket (ids only: the link holds the ticket token, so the job builds it).
    const events = await ticketMailEvents((await testDb()).db);
    expect(events.map((event) => [event.aggregateType, event.aggregateId, event.payload['kind']])).toEqual([
      ['support_tickets', ticketId, 'received'],
    ]);
  });

  it('step 3: the ticket shows in the support queue and the customer gets an email with the link', async () => {
    const list = await staff.get('/admin/support-tickets?status=new&status=open&status=pending');
    expect(list.total).toBe(1);
    expect(list.body[0]).toMatchObject({
      id: ticketId,
      status: 'new',
      late: false,
      assignee: null,
      requester: { name: 'Victor Hale' },
    });
    expect(await sendTicketMails(t)).toEqual([{ sent: true }]);
    expect(mailbox(t).sent).toHaveLength(1);
    expect(mailbox(t).sent[0]).toMatchObject({
      to: 'victor@mail.example',
      subject: `We got your message (${ticketNumber})`,
    });
    expect(mailbox(t).sent[0]!.text).toContain(`/support/tickets/${token}`);
    const [notification] = await notificationRows((await testDb()).db);
    expect(notification).toMatchObject({ event: 'support.ticket_received', status: 'sent', recipientId: customerId });
    expect(JSON.stringify(notification!.payload)).not.toContain(token);
  });

  it('step 4: the agent takes it (assignee, open) and replies with a template: the first reply sets first_response_at', async () => {
    clock.advance(20 * MINUTE);
    const taken = await staff.patch(`/admin/support-tickets/${ticketId}`, {
      assigneeId: staff.staffId,
      status: 'open',
    });
    expect(taken.body).toMatchObject({ status: 'open', assigneeId: staff.staffId });
    const templates = await staff.get('/admin/reply-templates?category=delay');
    expect(templates.body[0].body).toContain('{{order}}');
    clock.advance(5 * MINUTE);
    const reply = await staff.post(`/admin/support-tickets/${ticketId}/reply`, {
      body: templateBody,
      channel: 'email',
    });
    expect(reply.status).toBe(201);
    const row = await ticket();
    expect(row.firstResponseAt?.toISOString()).toBe('2026-11-08T09:25:00.000Z');
    expect(row.assigneeId).toBe(staff.staffId);
    expect((await messages()).at(-1)).toMatchObject({
      authorType: 'staff',
      authorId: staff.staffId,
      body: templateBody,
      isInternal: false,
    });
  });

  it('step 5: the reply reaches the customer by email and the ticket waits on them (pending_customer)', async () => {
    const row = await ticket();
    expect(row).toMatchObject({ status: 'pending_customer', slaDueAt: null });
    await sendTicketMails(t);
    const mail = mailbox(t).sent.at(-1)!;
    expect(mail).toMatchObject({
      to: 'victor@mail.example',
      subject: `Re: Where is my unlock? (SF-${orderId}) (${ticketNumber})`,
    });
    expect(mail.text).toContain(templateBody);
    expect((await staff.get(`/admin/support-tickets/${ticketId}`)).body.status).toBe('pending');
  });

  it('step 6 (POST /store/v1/tickets/:token/messages): the customer’s answer joins the same ticket and it is open again', async () => {
    clock.advance(30 * MINUTE);
    const res = await call('POST', `/store/v1/tickets/${token}/messages`, { body: 'Thanks, I will wait.' });
    expect(res.statusCode).toBe(201);
    const row = await ticket();
    expect(row.status).toBe('open');
    expect(row.slaDueAt?.toISOString()).toBe('2026-11-08T17:55:00.000Z');
    expect(await messages()).toHaveLength(3);
    const view = json(await call('GET', `/store/v1/tickets/${token}`));
    expect(view.messages.map((message: { from: string }) => message.from)).toEqual(['you', 'support', 'you']);
    expect(view.status).toBe('open');
  });

  it('step 7: after the order is done the agent resolves it: resolved_at, the internal note, an audit entry, the survey', async () => {
    clock.advance(HOUR);
    staff = await supportStaff(t, ['support:*'], 'Lina S.');
    const res = await staff.patch(`/admin/support-tickets/${ticketId}`, { status: 'resolved' });
    expect(res.body).toMatchObject({ status: 'resolved', slaDueAt: null, late: false });
    const row = await ticket();
    expect(row.resolvedAt?.toISOString()).toBe('2026-11-08T10:55:00.000Z');
    expect((await messages()).at(-1)).toMatchObject({ authorType: 'system', isInternal: true });
    const { db } = await testDb();
    const audits = (await db.select().from(s.auditLogs).orderBy(s.auditLogs.id)).filter(
      (row) => row.entityType === 'ticket',
    );
    expect(audits.map((row) => row.action)).toEqual([
      'assigned ticket',
      'changed status of ticket',
      'replied to ticket',
      'resolved ticket',
    ]);
    expect(audits.at(-1)).toMatchObject({ entityId: ticketId, entityLabel: expect.stringContaining(ticketNumber) });
  });

  it('step 8 (POST /store/v1/tickets/:token/csat): the customer gets the survey link and rates; the ticket stays resolved', async () => {
    await sendTicketMails(t);
    const survey = mailbox(t).sent.at(-1)!;
    expect(survey.subject).toBe(`How did we do? (${ticketNumber})`);
    expect(survey.text).toContain(`/support/tickets/${token}`);
    expect(json(await call('GET', `/store/v1/tickets/${token}`))).toMatchObject({ status: 'resolved', canRate: true });
    const res = await call('POST', `/store/v1/tickets/${token}/csat`, { score: 5 });
    expect(res.statusCode).toBe(200);
    expect(await ticket()).toMatchObject({ status: 'resolved', csatScore: 5 });
    expect((await staff.get(`/admin/support-tickets/${ticketId}`)).body).toMatchObject({
      status: 'resolved',
      csatScore: 5,
    });
    const rated = await call('POST', `/store/v1/tickets/${token}/csat`, { score: 3 });
    expect(rated.statusCode).toBe(422);
  });
});

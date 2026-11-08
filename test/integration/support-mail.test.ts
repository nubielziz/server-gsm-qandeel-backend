// Integration tests of the ticket message job (feature 17): `support.ticket_mail` events become emails and Telegram messages through the
// notification delivery. The ticket link (the token) is a secret that is never stored or logged, a repeat sends nothing twice, a transient
// failure is retried by the queue, and a message that is no longer worth sending is skipped.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { eq } from 'drizzle-orm';
import { schema as s } from '../../src/infra/db';
import { UnrecoverableError } from '../../src/infra/queues';
import { DeliveryError, OutboxService } from '../../src/modules/platform';
import { TICKET_MAIL_EVENT, TicketMailProcessor } from '../../src/modules/support';
import { type TestApp, createTestApp } from '../support/app';
import { TestClock } from '../support/clock';
import { closeTestDb, resetDb, testDb } from '../support/db';
import { mailbox, notificationRows, telegramOutbox } from '../support/notifications';
import { rejectionOf } from '../support/rejection';
import {
  insertClient,
  insertCustomer,
  insertSupportMessage,
  insertSupportTicket,
  seedSupportTemplates,
  sendTicketMails,
  ticketMailEvents,
} from '../support/support';

const clock = new TestClock('2026-11-08T12:00:00.000Z');
let t: TestApp;

beforeAll(async () => {
  t = await createTestApp({
    clock,
    env: { TELEGRAM_BOT_TOKEN: '1234567890:AAtest-token', TELEGRAM_BOT_USERNAME: 'gsm_test_bot' },
  });
});
beforeEach(async () => {
  await resetDb();
  const { db } = await testDb();
  await seedSupportTemplates(db);
  mailbox(t).reset();
  telegramOutbox(t).reset();
});
afterAll(async () => {
  await resetDb();
  await t.close();
  await closeTestDb();
});

/** Writes a `support.ticket_mail` event the way the use cases do, and returns its job. */
async function writeEvent(ticketId: number, payload: Record<string, string | number>) {
  const { db } = await testDb();
  const row = await db.transaction((tx) =>
    t.app
      .get(OutboxService)
      .add(tx, { type: TICKET_MAIL_EVENT, aggregateType: 'support_tickets', aggregateId: ticketId, payload }),
  );
  return {
    eventId: row.id,
    type: TICKET_MAIL_EVENT,
    aggregateType: 'support_tickets',
    aggregateId: ticketId,
    payload,
    requestId: 'test',
  };
}
const run = (data: Awaited<ReturnType<typeof writeEvent>>, attemptsMade = 0) =>
  t.app.get(TicketMailProcessor).process({ data, attemptsMade, opts: { attempts: 5 } } as never);

async function customerTicket() {
  const { db } = await testDb();
  const customer = await insertCustomer(db, { name: 'Victor Hale', email: 'victor@mail.example' });
  const ticket = await insertSupportTicket(db, { requesterId: customer.id, subject: 'Where is my unlock?' });
  return { db, customer, ticket };
}

describe('the ticket message job', () => {
  it('sends the receipt with the ticket link, and the stored row and the log never hold the token', async () => {
    const { db, ticket } = await customerTicket();
    const job = await writeEvent(ticket.id, { kind: 'received' });
    expect(await run(job)).toEqual({ sent: true });
    const [mail] = mailbox(t).sent;
    expect(mail!.text).toContain(`http://localhost:5175/support/tickets/${ticket.token}`);
    const [row] = await notificationRows(db);
    expect(row).toMatchObject({
      event: 'support.ticket_received',
      status: 'sent',
      dedupeKey: `outbox-${job.eventId}:email`,
    });
    expect(row!.payload).toEqual({
      variables: { ticketNumber: ticket.number, subject: 'Where is my unlock?', customerName: 'Victor Hale' },
    });
    expect(JSON.stringify(row)).not.toContain(ticket.token!);
  });

  it('sends nothing twice when the job runs again, and a retry after a transient failure sends once', async () => {
    const { ticket } = await customerTicket();
    const job = await writeEvent(ticket.id, { kind: 'survey' });
    mailbox(t).failNext(new DeliveryError('The mail server is busy.'));
    expect((await rejectionOf(run(job, 0))) instanceof DeliveryError).toBe(true);
    expect(mailbox(t).sent).toHaveLength(0);
    expect(await run(job, 1)).toEqual({ sent: true });
    expect(await run(job, 2)).toEqual({ sent: false, skipped: 'already_sent' });
    expect(mailbox(t).sent).toHaveLength(1);
    expect((await notificationRows((await testDb()).db))[0]).toMatchObject({ status: 'sent', attempts: 2 });
  });

  it('skips a message for a customer who was anonymized since, and a ticket that is gone', async () => {
    const { db, customer, ticket } = await customerTicket();
    const job = await writeEvent(ticket.id, { kind: 'received' });
    await db
      .update(s.customers)
      .set({ status: 'anonymized', email: 'deleted-1@redacted.invalid' })
      .where(eq(s.customers.id, customer.id));
    expect(await run(job)).toEqual({ sent: false, skipped: 'recipient_gone' });
    const missing = await writeEvent(999_999, { kind: 'received' });
    expect(await run(missing)).toEqual({ sent: false, skipped: 'ticket_gone' });
    expect(mailbox(t).sent).toHaveLength(0);
    expect(await notificationRows(db)).toHaveLength(0);
  });

  it('sends a reply only for a public staff message of that ticket', async () => {
    const { db, ticket } = await customerTicket();
    const other = await insertSupportTicket(db, { requesterId: ticket.requesterId });
    const staffId = (
      await db
        .insert(s.roles)
        .values({ name: 'R', permissions: ['support:*'] })
        .returning({ id: s.roles.id })
    )[0]!.id;
    const [staff] = await db
      .insert(s.staffUsers)
      .values({ email: 's@example.com', name: 'Lina S.', roleId: staffId, status: 'active' })
      .returning();
    const note = await insertSupportMessage(db, ticket.id, {
      authorType: 'staff',
      authorId: staff!.id,
      isInternal: true,
      body: 'note',
    });
    const foreign = await insertSupportMessage(db, other.id, {
      authorType: 'staff',
      authorId: staff!.id,
      body: 'other ticket',
    });
    const customerMessage = await insertSupportMessage(db, ticket.id, {
      authorType: 'customer',
      authorId: ticket.requesterId,
      body: 'mine',
    });
    const good = await insertSupportMessage(db, ticket.id, {
      authorType: 'staff',
      authorId: staff!.id,
      body: 'Hi Victor.',
    });
    for (const bad of [note, foreign, customerMessage, { id: 999_999 }]) {
      const job = await writeEvent(ticket.id, { kind: 'reply', messageId: bad.id, channel: 'email' });
      expect(await run(job)).toEqual({ sent: false, skipped: 'message_gone' });
    }
    expect(mailbox(t).sent).toHaveLength(0);
    expect(await run(await writeEvent(ticket.id, { kind: 'reply', messageId: good.id, channel: 'email' }))).toEqual({
      sent: true,
    });
    expect(mailbox(t).sent[0]!.text).toContain('Hi Victor.');
  });

  it('fails a merchant’s Telegram reply for good when the chat was unlinked since, and sends no receipt for a merchant', async () => {
    const { db } = await testDb();
    const merchant = await insertClient(db, { telegramChatId: null });
    const ticket = await insertSupportTicket(db, { requesterType: 'client', requesterId: merchant.id, token: null });
    const staffId = (
      await db
        .insert(s.roles)
        .values({ name: 'R', permissions: ['support:*'] })
        .returning({ id: s.roles.id })
    )[0]!.id;
    const [staff] = await db
      .insert(s.staffUsers)
      .values({ email: 's@example.com', name: 'Lina S.', roleId: staffId, status: 'active' })
      .returning();
    const reply = await insertSupportMessage(db, ticket.id, {
      authorType: 'staff',
      authorId: staff!.id,
      body: 'Done.',
    });
    const job = await writeEvent(ticket.id, { kind: 'reply', messageId: reply.id, channel: 'telegram' });
    expect(await run(job)).toEqual({ sent: false, failed: 'Telegram is not linked.' });
    expect((await notificationRows(db))[0]).toMatchObject({
      status: 'failed',
      channel: 'telegram',
      event: 'support.reply',
    });
    expect(await run(await writeEvent(ticket.id, { kind: 'received' }))).toEqual({
      sent: false,
      skipped: 'recipient_gone',
    });
  });

  it('rejects a malformed event for good, so the queue does not retry it', async () => {
    const { ticket } = await customerTicket();
    const malformed: Array<Record<string, string | number>> = [
      { kind: 'unknown' },
      { kind: 'reply' },
      { kind: 'reply', messageId: 1, channel: 'sms' },
    ];
    for (const payload of malformed) {
      const error = await rejectionOf(run(await writeEvent(ticket.id, payload)));
      expect(error).toBeInstanceOf(UnrecoverableError);
    }
  });

  it('runs every written event in order through the helper the other tests use', async () => {
    const { ticket } = await customerTicket();
    await writeEvent(ticket.id, { kind: 'received' });
    await writeEvent(ticket.id, { kind: 'survey' });
    expect(await ticketMailEvents((await testDb()).db)).toHaveLength(2);
    expect(await sendTicketMails(t)).toEqual([{ sent: true }, { sent: true }]);
    expect(mailbox(t).sent.map((mail) => mail.subject)).toEqual([
      `We got your message (${ticket.number})`,
      `How did we do? (${ticket.number})`,
    ]);
  });
});

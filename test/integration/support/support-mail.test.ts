// Integration tests of the ticket message job (feature 17): `support.ticket_mail` events become emails through the
// notification delivery. The ticket link (the token) is a secret that is never stored or logged, a repeat sends nothing twice, a transient
// failure is retried by the queue, and a message that is no longer worth sending is skipped.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { eq } from 'drizzle-orm';
import { schema as s } from '@src/infra/db';
import { UnrecoverableError } from '@src/infra/queues';
import { DeliveryError, OutboxService } from '@src/modules/platform';
import { TICKET_MAIL_EVENT, TicketMailProcessor } from '@src/modules/support';
import { ensureRetailGroup } from '../../support/accounts';
import { type TestApp, createTestApp } from '../../support/app';
import { TestClock } from '../../support/clock';
import { closeTestDb, resetDb, testDb } from '../../support/db';
import { mailbox, notificationRows, telegramOutbox } from '../../support/notifications';
import { rejectionOf } from '../../support/rejection';
import {
  insertClient,
  insertCustomer,
  insertSupportMessage,
  insertSupportTicket,
  seedSupportTemplates,
  sendTicketMails,
  ticketMailEvents,
} from '../../support/support';

const clock = new TestClock('2026-11-08T12:00:00.000Z');
let t: TestApp;

beforeAll(async () => {
  t = await createTestApp({
    clock,
    env: { TELEGRAM_BOT_TOKEN: '1234567890:AAtest-token' },
  });
});
beforeEach(async () => {
  await resetDb();
  const { db } = await testDb();
  // the reset removed the one retail rank that the migrations insert; the console reads it to tell the requester's rank
  await ensureRetailGroup(db);
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
    // Decision 053: the receipt repeats nothing a visitor typed, so it carries the number alone (the link is a secret, not a variable).
    // The row keeps the audience its text was made for (decision 064: one account, two texts).
    expect(row!.payload).toEqual({ audience: 'customer', variables: { ticketNumber: ticket.number } });
    expect(mail!.text).toContain('Hello,');
    expect(mail!.text).not.toContain('Victor');
    expect(mail!.text).not.toContain('Where is my unlock?');
    expect(JSON.stringify(row)).not.toContain(ticket.token!);
  });

  it('sends nothing twice when the job runs again, and a retry after a transient failure sends once', async () => {
    const { ticket } = await customerTicket();
    const job = await writeEvent(ticket.id, { kind: 'received' });
    mailbox(t).failNext(new DeliveryError('The mail server is busy.'));
    expect((await rejectionOf(run(job, 0))) instanceof DeliveryError).toBe(true);
    expect(mailbox(t).sent).toHaveLength(0);
    expect(await run(job, 1)).toEqual({ sent: true });
    expect(await run(job, 2)).toEqual({ sent: false, skipped: 'already_sent' });
    expect(mailbox(t).sent).toHaveLength(1);
    expect((await notificationRows((await testDb()).db))[0]).toMatchObject({ status: 'sent', attempts: 2 });
  });

  it('skips a message for an account that was anonymized since, and a ticket that is gone', async () => {
    const { db, customer, ticket } = await customerTicket();
    const job = await writeEvent(ticket.id, { kind: 'received' });
    await db
      .update(s.clients)
      .set({ status: 'anonymized', anonymizedAt: new Date(), email: 'deleted-1@redacted.invalid' })
      .where(eq(s.clients.id, customer.id));
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
      authorType: 'account',
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

  it('skips a reply event that was written for the retired Telegram channel, and sends no receipt for a merchant', async () => {
    const { db } = await testDb();
    const merchant = await insertClient(db, { telegramChatId: '555001' });
    const ticket = await insertSupportTicket(db, { requesterType: 'account', requesterId: merchant.id, token: null });
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
    // No notification row is made and nothing is sent, even though a chat is still stored on the merchant.
    expect(await run(job)).toEqual({ sent: false, skipped: 'channel_retired' });
    expect(await notificationRows(db)).toEqual([]);
    expect(telegramOutbox(t).sent).toEqual([]);
    expect(await run(await writeEvent(ticket.id, { kind: 'received' }))).toEqual({
      sent: false,
      skipped: 'recipient_gone',
    });
  });

  it('words a mail by the rank kind of its requester: the receipt of a merchant rank carries the ticket link, its reply the portal link (decision 064)', async () => {
    const { db } = await testDb();
    const merchant = await insertClient(db, { name: 'Zain Mobile Hub', email: 'zain@mail.example' });
    // A ticket typed on the public form with the merchant's address: it has a link token, and the address is not proven yet.
    const typed = await insertSupportTicket(db, {
      requesterId: merchant.id,
      subject: 'Invoice question',
      requesterProvenAt: null,
    });
    expect(await run(await writeEvent(typed.id, { kind: 'received' }))).toEqual({ sent: true });
    const [receipt] = mailbox(t).sent;
    expect(receipt).toMatchObject({ to: 'zain@mail.example', subject: `We got your message (${typed.number})` });
    expect(receipt!.text).toContain(`http://localhost:5175/support/tickets/${typed.token}`);
    expect(await notificationRows(db)).toEqual([
      expect.objectContaining({ event: 'support.ticket_received', recipientType: 'account', recipientId: merchant.id }),
    ]);

    // A reply on a ticket opened in the portal (no link token) is the merchant text with the portal link and the merchant's name.
    const portal = await insertSupportTicket(db, { requesterId: merchant.id, subject: 'Statement', token: null });
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
    const reply = await insertSupportMessage(db, portal.id, {
      authorType: 'staff',
      authorId: staff!.id,
      body: 'It is in your portal.',
    });
    expect(await run(await writeEvent(portal.id, { kind: 'reply', messageId: reply.id, channel: 'email' }))).toEqual({
      sent: true,
    });
    const portalMail = mailbox(t).sent[1]!;
    expect(portalMail.text).toContain('Hi Zain Mobile Hub,');
    expect(portalMail.text).toContain(`http://localhost:5175/account/support/${portal.id}`);
  });

  it('rejects a malformed event for good, so the queue does not retry it', async () => {
    const { ticket } = await customerTicket();
    const malformed: Array<Record<string, string | number>> = [
      { kind: 'unknown' },
      // The retired survey: an event of that kind that was written before the retirement is no message any more.
      { kind: 'survey' },
      { kind: 'reply' },
      { kind: 'reply', messageId: 1, channel: 'sms' },
    ];
    for (const payload of malformed) {
      const error = await rejectionOf(run(await writeEvent(ticket.id, payload)));
      expect(error).toBeInstanceOf(UnrecoverableError);
    }
  });

  it('runs every written event in order through the helper the other tests use', async () => {
    const { db, ticket } = await customerTicket();
    const second = await insertSupportTicket(db, { requesterId: ticket.requesterId });
    await writeEvent(ticket.id, { kind: 'received' });
    await writeEvent(second.id, { kind: 'received' });
    expect(await ticketMailEvents(db)).toHaveLength(2);
    expect(await sendTicketMails(t)).toEqual([{ sent: true }, { sent: true }]);
    expect(mailbox(t).sent.map((mail) => mail.subject)).toEqual([
      `We got your message (${ticket.number})`,
      `We got your message (${second.number})`,
    ]);
  });
});

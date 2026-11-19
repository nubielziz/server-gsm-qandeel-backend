// Integration tests of the email fallback of staff replies (feature 28, rule 9): an email reply waits support.replyEmailDelayMinutes for
// the requester to see it; then one mail carries every unseen reply. No mail when the requester read in time, a new delay after a mail,
// at once with a delay of 0, Telegram at once and never by email, two sweeps at once mail once, an anonymized customer gets nothing,
// and a merchant's mail links to the portal. Real Postgres and Redis, a test clock.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { eq } from 'drizzle-orm';
import { schema as s } from '@src/infra/db';
import { SupportJobsModule } from '@src/modules/support';
import { ReplyMailSweep } from '@src/modules/support/application/reply-mail-sweep';
import { ReplyMailSweepProcessor } from '@src/modules/support/jobs/reply-mail-sweep.processor';
import { type AdminApi, adminWith } from '../../support/admin-api';
import { type TestApp, createTestApp } from '../../support/app';
import { clearIdentityCaches, insertMerchant } from '../../support/auth';
import { MINUTE, TestClock } from '../../support/clock';
import { closeTestDb, resetDb, testDb } from '../../support/db';
import { mailbox, telegramOutbox } from '../../support/notifications';
import { freshClientIp } from '../../support/pipeline-routes';
import { makeCustomer } from '../../support/store';
import {
  clearTicketChatLimits,
  insertSupportMessage,
  insertSupportTicket,
  seedSupportTemplates,
  sendTicketMails,
  setSupportSetting,
  supportStaff,
  ticketMailEvents,
} from '../../support/support';

const NOW = '2026-11-15T10:00:00.000Z';
const clock = new TestClock(NOW);
let t: TestApp;
let staff: AdminApi;

beforeAll(async () => {
  t = await createTestApp({
    clock,
    imports: [SupportJobsModule],
    env: { TELEGRAM_BOT_TOKEN: '1234567890:AAtest-token', TELEGRAM_BOT_USERNAME: 'gsm_test_bot' },
  });
});
beforeEach(async () => {
  clock.set(NOW);
  await resetDb();
  await seedSupportTemplates((await testDb()).db);
  await clearIdentityCaches(t);
  await clearTicketChatLimits(t);
  // The plan's default: 5 minutes (resetDb empties the settings; the cache is dropped here).
  await setSupportSetting(t, 'replyEmailDelayMinutes', 5);
  mailbox(t).reset();
  telegramOutbox(t).reset();
  staff = await supportStaff(t, ['support:*'], 'Lina S.');
});
afterAll(async () => {
  await resetDb();
  await clearIdentityCaches(t);
  await t.close();
  await closeTestDb();
});

const sweep = () => t.app.get(ReplyMailSweep).run();

/** A customer's open ticket with their first message. */
async function customerTicket() {
  const { db } = await testDb();
  const customer = await makeCustomer(t, { name: 'Victor Hale' });
  const ticket = await insertSupportTicket(db, {
    requesterId: customer.id,
    status: 'open',
    subject: 'Where is my unlock?',
  });
  await insertSupportMessage(db, ticket.id, {
    authorType: 'customer',
    authorId: customer.id,
    body: 'Hello.',
    createdAt: new Date(clock.nowMs() - MINUTE),
  });
  return { db, customer, ticket: { ...ticket, token: ticket.token! } };
}

const reply = async (ticketId: number, body: string, channel?: 'email' | 'telegram') => {
  const res = await staff.post(`/admin/support-tickets/${ticketId}/reply`, { body, ...(channel ? { channel } : {}) });
  expect(res.status).toBe(201);
  return res.body.id as number;
};

const read = (token: string, upToMessageId: number) =>
  t.app.inject({
    method: 'POST',
    url: `/store/v1/tickets/${token}/read`,
    remoteAddress: freshClientIp(),
    payload: { upToMessageId },
  });

/** The reply mail events written so far, oldest first, without the outbox's own `meta` (the request id). */
const replyEvents = async () =>
  (await ticketMailEvents((await testDb()).db))
    .filter((event) => event.payload['kind'] === 'reply')
    .map((event) => {
      const { meta: _meta, ...payload } = event.payload;
      return { ...event, payload };
    });

const ticketOf = async (id: number) =>
  (await (await testDb()).db.select().from(s.supportTickets).where(eq(s.supportTickets.id, id)))[0]!;

describe('an email reply', () => {
  it('is not mailed when the requester read it within the delay', async () => {
    const { ticket } = await customerTicket();
    const id = await reply(ticket.id, 'Your code is on its way.');
    expect(await replyEvents()).toEqual([]);
    expect((await ticketOf(ticket.id)).replyMailDueAt?.toISOString()).toBe('2026-11-15T10:05:00.000Z');
    clock.advance(2 * MINUTE);
    expect((await read(ticket.token, id)).statusCode).toBe(204);
    clock.advance(4 * MINUTE);
    expect(await sweep()).toEqual({ tickets: 1, mailed: 0, seen: 1 });
    expect(await replyEvents()).toEqual([]);
    expect((await ticketOf(ticket.id)).replyMailDueAt).toBeNull();
    await sendTicketMails(t);
    expect(mailbox(t).sent).toEqual([]);
  });

  it('is mailed with the other unseen replies in one mail after 5 minutes, once; a later reply starts a new delay', async () => {
    const { ticket } = await customerTicket();
    const first = await reply(ticket.id, 'First reply.');
    clock.advance(2 * MINUTE);
    const second = await reply(ticket.id, 'Second reply.');
    // The first unseen reply started the wait; the second joins it.
    expect((await ticketOf(ticket.id)).replyMailDueAt?.toISOString()).toBe('2026-11-15T10:05:00.000Z');
    clock.advance(2 * MINUTE);
    expect(await sweep()).toEqual({ tickets: 0, mailed: 0, seen: 0 });
    clock.advance(MINUTE);
    expect(await sweep()).toEqual({ tickets: 1, mailed: 1, seen: 0 });
    const events = await replyEvents();
    expect(events.map((event) => event.payload)).toEqual([
      { kind: 'reply', channel: 'email', messageId: second, fromMessageId: first },
    ]);
    expect(await sendTicketMails(t)).toEqual([{ sent: true }]);
    expect(mailbox(t).sent).toHaveLength(1);
    expect(mailbox(t).sent[0]).toMatchObject({ to: expect.stringContaining('@example.com') });
    expect(mailbox(t).sent[0]!.text).toContain('First reply.\n\nSecond reply.');
    expect(mailbox(t).sent[0]!.text).toContain(`/support/tickets/${ticket.token}`);
    expect(await ticketOf(ticket.id)).toMatchObject({ replyMailDueAt: null, replyMailedMessageId: second });
    // Nothing is mailed twice.
    clock.advance(10 * MINUTE);
    expect(await sweep()).toEqual({ tickets: 0, mailed: 0, seen: 0 });
    expect(await replyEvents()).toHaveLength(1);

    const third = await reply(ticket.id, 'Third reply.');
    expect((await ticketOf(ticket.id)).replyMailDueAt?.toISOString()).toBe('2026-11-15T10:20:00.000Z');
    clock.advance(5 * MINUTE);
    expect(await sweep()).toMatchObject({ mailed: 1 });
    expect((await replyEvents()).at(-1)!.payload).toEqual({
      kind: 'reply',
      channel: 'email',
      messageId: third,
      fromMessageId: third,
    });
    await sendTicketMails(t);
    expect(mailbox(t).sent).toHaveLength(2);
    expect(mailbox(t).sent[1]!.text).toContain('Third reply.');
    expect(mailbox(t).sent[1]!.text).not.toContain('Second reply.');
  });

  it('drops out of a written mail when the requester sees it before the job runs', async () => {
    const { ticket } = await customerTicket();
    const id = await reply(ticket.id, 'Seen just in time.');
    clock.advance(5 * MINUTE);
    expect(await sweep()).toMatchObject({ mailed: 1 });
    expect((await read(ticket.token, id)).statusCode).toBe(204);
    expect(await sendTicketMails(t)).toEqual([{ sent: false, skipped: 'seen' }]);
    expect(mailbox(t).sent).toEqual([]);
  });

  it('is mailed at once with a delay of 0, as before the live chat', async () => {
    await setSupportSetting(t, 'replyEmailDelayMinutes', 0);
    const { ticket } = await customerTicket();
    const id = await reply(ticket.id, 'At once.');
    expect((await replyEvents()).map((event) => event.payload)).toEqual([
      { kind: 'reply', messageId: id, channel: 'email' },
    ]);
    expect(await ticketOf(ticket.id)).toMatchObject({ replyMailDueAt: null, replyMailedMessageId: id });
    expect(await sendTicketMails(t)).toEqual([{ sent: true }]);
    expect(mailbox(t).sent[0]!.text).toContain('At once.');
    clock.advance(10 * MINUTE);
    expect(await sweep()).toEqual({ tickets: 0, mailed: 0, seen: 0 });
  });

  it('carries the portal link in a merchant’s mail', async () => {
    const { db } = await testDb();
    const merchant = await insertMerchant(db, { name: 'Zain Mobile Hub', telegramChatId: null });
    const ticket = await insertSupportTicket(db, {
      requesterType: 'client',
      requesterId: merchant,
      token: null,
      subject: 'Invoice question',
      status: 'open',
    });
    await reply(ticket.id, 'See the statement.');
    clock.advance(5 * MINUTE);
    expect(await sweep()).toMatchObject({ mailed: 1 });
    expect(await sendTicketMails(t)).toEqual([{ sent: true }]);
    const [mail] = mailbox(t).sent;
    expect(mail!.text).toContain('See the statement.');
    expect(mail!.text).toContain(`Open the conversation: http://localhost:5175/merchant/support/${ticket.id}`);
  });

  it('gets an anonymized customer nothing', async () => {
    const { ticket, customer } = await customerTicket();
    await reply(ticket.id, 'Too late.');
    const privacy = await adminWith(t, ['customers:privacy']);
    expect((await privacy.post(`/admin/customers/${customer.id}/anonymize`)).status).toBe(204);
    clock.advance(5 * MINUTE);
    await sweep();
    expect((await sendTicketMails(t)).every((result) => !result.sent)).toBe(true);
    expect(mailbox(t).sent).toEqual([]);
  });
});

describe('a Telegram reply', () => {
  it('is sent at once and never mailed', async () => {
    const { db } = await testDb();
    const merchant = await insertMerchant(db, { name: 'Zain Mobile Hub', telegramChatId: '555001' });
    const ticket = await insertSupportTicket(db, {
      requesterType: 'client',
      requesterId: merchant,
      token: null,
      channel: 'telegram',
      subject: 'Invoice question',
      status: 'open',
    });
    const id = await reply(ticket.id, 'Issued in USD.', 'telegram');
    expect((await replyEvents()).map((event) => event.payload)).toEqual([
      { kind: 'reply', messageId: id, channel: 'telegram' },
    ]);
    expect((await ticketOf(ticket.id)).replyMailDueAt).toBeNull();
    expect((await db.select().from(s.ticketMessages).where(eq(s.ticketMessages.id, id)))[0]!.notifyChannel).toBe(
      'telegram',
    );
    expect(await sendTicketMails(t)).toEqual([{ sent: true }]);
    clock.advance(10 * MINUTE);
    expect(await sweep()).toEqual({ tickets: 0, mailed: 0, seen: 0 });
    await sendTicketMails(t);
    expect(telegramOutbox(t).sent).toHaveLength(1);
    expect(mailbox(t).sent).toEqual([]);
  });
});

describe('the sweep', () => {
  it('mails once when two sweeps run at once', async () => {
    const a = await customerTicket();
    const b = await customerTicket();
    await reply(a.ticket.id, 'For A.');
    await reply(b.ticket.id, 'For B.');
    clock.advance(5 * MINUTE);
    const [one, two] = await Promise.all([sweep(), sweep()]);
    expect(one.mailed + two.mailed).toBe(2);
    expect(await replyEvents()).toHaveLength(2);
    expect(await sweep()).toEqual({ tickets: 0, mailed: 0, seen: 0 });
    await sendTicketMails(t);
    expect(mailbox(t).sent.map((mail) => mail.text.includes('For A.') || mail.text.includes('For B.'))).toEqual([
      true,
      true,
    ]);
  });

  it('records a run only when a ticket was due, like checkout_recovery_sweep', async () => {
    const processor = t.app.get(ReplyMailSweepProcessor);
    const job = { data: {} } as never;
    const { db } = await testDb();
    expect(await processor.process(job)).toEqual({ tickets: 0, mailed: 0, seen: 0 });
    expect(await db.select().from(s.jobRuns)).toEqual([]);
    const { ticket } = await customerTicket();
    await reply(ticket.id, 'Recorded.');
    clock.advance(5 * MINUTE);
    expect(await processor.process(job)).toEqual({ tickets: 1, mailed: 1, seen: 0 });
    expect(await db.select().from(s.jobRuns)).toEqual([
      expect.objectContaining({ job: 'support_reply_mail_sweep', status: 'succeeded', processed: 1 }),
    ]);
  });
});

// Integration tests of the notification delivery path (feature 12a, decisions 020 and 033): a notification is a row plus an outbox event written
// together, the send job renders the active template and hands it to the mail or Telegram driver, a failure is retried by the queue with the attempt
// on the row, and the planning job turns the outbox events (low balance, order results, invoices, deposits, price changes) into notifications by the
// merchant's own preferences, with the price changes collected into one digest a day. Real Postgres and Redis; the drivers are in memory.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { eq } from 'drizzle-orm';
import { DbService, type Database, schema as s } from '../../src/infra/db';
import { QueuesService, UnrecoverableError, queueJobId } from '../../src/infra/queues';
import { RedisService } from '../../src/infra/redis';
import {
  DeliveryError,
  NotificationEventRegistry,
  NotificationService,
  OutboxRouteRegistry,
  type NotificationInput,
} from '../../src/modules/platform';
import { type TestApp, createTestApp } from '../support/app';
import { insertMerchant } from '../support/auth';
import { insertRecoveryTemplate } from '../support/growth';
import { DAY, HOUR, MINUTE, TestClock } from '../support/clock';
import { closeTestDb, resetDb, testDb } from '../support/db';
import {
  emitEvent,
  eventJob,
  mailbox,
  merchantSession,
  notificationRows,
  planEvent,
  seedDefaultTemplates,
  sendAllQueued,
  sendNotification,
  telegramOutbox,
} from '../support/notifications';
import { deleteBullKeys, testBullPrefix } from '../support/queues';
import { expectRejection } from '../support/rejection';
import { insertOrder, insertUsd } from '../support/webhooks';
import { insertCategory, insertService } from '../support/catalog';

const prefix = testBullPrefix();
const clock = new TestClock('2026-11-01T10:00:00.000Z');
let t: TestApp;
let db: Database;

beforeAll(async () => {
  ({ db } = await testDb());
  t = await createTestApp({
    clock,
    env: { BULL_PREFIX: prefix, TELEGRAM_BOT_TOKEN: '1234567890:AAtest-token', TELEGRAM_BOT_USERNAME: 'gsm_test_bot' },
  });
});
afterAll(async () => {
  await deleteBullKeys(t.app.get(RedisService).queue, prefix);
  await resetDb();
  await t.close();
  await closeTestDb();
});
beforeEach(async () => {
  merchants = 0;
  clock.set('2026-11-01T10:00:00.000Z');
  await resetDb();
  await deleteBullKeys(t.app.get(RedisService).queue, prefix);
  await seedDefaultTemplates(db);
  mailbox(t).reset();
  telegramOutbox(t).reset();
});

const service = () => t.app.get(NotificationService);
const enqueue = (input: NotificationInput) =>
  t.app.get(DbService).runInTransaction(({ tx }) => service().enqueue({ tx }, input));
const outboxRows = () => db.select().from(s.outboxEvents).orderBy(s.outboxEvents.id);
const notificationQueue = () => t.app.get(QueuesService).queue('notifications');

let merchants = 0;
/** A merchant: the first of a test has the address the mails go to; the others get their own. */
async function merchant(overrides: Partial<typeof s.clients.$inferInsert> = {}) {
  merchants += 1;
  const email = merchants === 1 ? 'ops@zainmobilehub.example' : `ops-${merchants}@zainmobilehub.example`;
  return insertMerchant(db, { name: 'Zain Mobile Hub', email, ...overrides });
}
const lowBalance = (clientId: number) => ({
  event: 'wallet.low_balance',
  recipient: { type: 'client' as const, id: clientId },
  channel: 'email' as const,
  variables: { merchantName: 'Zain Mobile Hub', currency: 'USD', available: '42.50', threshold: '50.00' },
});

describe('NotificationService.enqueue and the send job', () => {
  it('writes the queued row and its send event together; the job renders the template, sends the mail and marks the row sent', async () => {
    const clientId = await merchant();
    const made = await enqueue({ ...lowBalance(clientId), dedupeKey: 'test-1' });
    expect(made).toMatchObject({ status: 'queued', created: true });
    const [row] = await notificationRows(db);
    expect(row).toMatchObject({
      recipientType: 'client',
      recipientId: clientId,
      channel: 'email',
      event: 'wallet.low_balance',
      status: 'queued',
      attempts: 0,
      sentAt: null,
      error: null,
      dedupeKey: 'test-1',
      payload: { variables: { available: '42.50' } },
    });
    expect(row?.createdAt).toEqual(clock.now());
    const [event] = await outboxRows();
    expect(event).toMatchObject({ type: 'notification.send', aggregateType: 'notifications', aggregateId: row!.id });
    expect(mailbox(t).sent).toEqual([]);

    clock.advance(5_000);
    expect(await sendNotification(t, row!.id)).toEqual({ outcome: 'sent' });
    const [sent] = await notificationRows(db);
    expect(sent).toMatchObject({ status: 'sent', attempts: 1, error: null });
    expect(sent?.sentAt).toEqual(clock.now());
    expect(mailbox(t).sent).toEqual([
      {
        from: 'GSM <noreply@gsm.local>',
        to: 'ops@zainmobilehub.example',
        subject: 'Your wallet balance is low',
        text: expect.stringContaining('Your available balance is 42.50 USD, below your alert level of 50.00 USD.'),
        messageId: `<notification-${row!.id}@gsm.local>`,
      },
    ]);
    expect(mailbox(t).sent[0]?.text.startsWith('Hi Zain Mobile Hub,')).toBe(true);
  });

  it('makes one row for a dedupe key however often the caller repeats, and none when the caller rolls back', async () => {
    const clientId = await merchant();
    const first = await enqueue({ ...lowBalance(clientId), dedupeKey: 'once' });
    const second = await enqueue({ ...lowBalance(clientId), dedupeKey: 'once' });
    expect(second).toEqual({ status: 'queued', id: (first as { id: number }).id, created: false });
    expect(await notificationRows(db)).toHaveLength(1);
    expect(await outboxRows()).toHaveLength(1);

    await expectRejection(
      t.app.get(DbService).runInTransaction(async ({ tx }) => {
        await service().enqueue({ tx }, { ...lowBalance(clientId), dedupeKey: 'rolled-back' });
        throw new Error('the caller failed after the notification');
      }),
      'the caller failed after the notification',
    );
    expect(await notificationRows(db)).toHaveLength(1);
    expect(await outboxRows()).toHaveLength(1);
  });

  it('makes nothing for a recipient that is gone, a missing template and a template that is switched off, and says why', async () => {
    const clientId = await merchant();
    expect(await enqueue({ ...lowBalance(99999) })).toEqual({ status: 'skipped', reason: 'recipient_gone' });
    await db
      .update(s.notificationTemplates)
      .set({ isActive: false })
      .where(eq(s.notificationTemplates.event, 'wallet.low_balance'));
    expect(await enqueue(lowBalance(clientId))).toEqual({ status: 'skipped', reason: 'template_off' });
    await db.delete(s.notificationTemplates).where(eq(s.notificationTemplates.event, 'wallet.low_balance'));
    expect(await enqueue(lowBalance(clientId))).toEqual({ status: 'skipped', reason: 'no_template' });
    expect(await notificationRows(db)).toEqual([]);
    expect(await outboxRows()).toEqual([]);
  });

  it("writes to a recipient in the English template when the recipient's language has none or has it off, and tells which languages can be written in", async () => {
    const [customer] = await db
      .insert(s.customers)
      .values({ email: 'sam@mail.example', name: 'Sam', locale: 'ar' })
      .returning({ id: s.customers.id });
    const input = {
      event: 'checkout.abandoned',
      recipient: { type: 'customer' as const, id: customer!.id },
      channel: 'email' as const,
    };
    const check = () => service().check(db, input);
    const languages = () =>
      service().writableLanguages(db, { event: 'checkout.abandoned', channel: 'email', audience: 'customer' });
    expect(await check()).toEqual({ skipped: 'no_template' });
    expect(await languages()).toEqual({ anyLanguage: false, locales: [] });

    await insertRecoveryTemplate(db);
    expect(await check()).toHaveProperty('recipient');
    expect(await languages()).toEqual({ anyLanguage: true, locales: ['en'] });

    // The language's own template, off: the English one still covers it.
    await insertRecoveryTemplate(db, { locale: 'ar', isActive: false });
    expect(await check()).toHaveProperty('recipient');
    expect(await languages()).toEqual({ anyLanguage: true, locales: ['en'] });

    // Both off: nothing can be written; with only the language's own on, only that language can.
    await db.update(s.notificationTemplates).set({ isActive: false });
    expect(await check()).toEqual({ skipped: 'template_off' });
    expect(await languages()).toEqual({ anyLanguage: false, locales: [] });
    await db.update(s.notificationTemplates).set({ isActive: true }).where(eq(s.notificationTemplates.locale, 'ar'));
    expect(await check()).toHaveProperty('recipient');
    expect(await languages()).toEqual({ anyLanguage: false, locales: ['ar'] });
  });

  it('keeps a suspended merchant from messages that are not transactional, but not from the mails it needs', async () => {
    const clientId = await merchant({ status: 'suspended' });
    expect(await enqueue(lowBalance(clientId))).toEqual({ status: 'skipped', reason: 'recipient_suspended' });
    const invitation = await enqueue({
      event: 'merchant.invited',
      recipient: { type: 'client', id: clientId },
      channel: 'email',
      variables: { merchantName: 'Zain', expiresAt: 'tomorrow' },
    });
    expect(invitation.status).toBe('queued');
  });

  it('refuses an event the audience does not have and a channel the event does not use (programming errors)', async () => {
    const clientId = await merchant();
    await expectRejection(enqueue({ ...lowBalance(clientId), event: 'order.received' }), RangeError);
    await expectRejection(
      enqueue({ ...lowBalance(clientId), event: 'merchant.invited', channel: 'telegram' }),
      'cannot be sent by telegram',
    );
  });

  it('sends once when the job runs twice, and a finished row is skipped', async () => {
    const clientId = await merchant();
    await enqueue(lowBalance(clientId));
    expect(await sendAllQueued(t)).toEqual([{ outcome: 'sent' }]);
    expect(await sendAllQueued(t)).toEqual([{ outcome: 'skipped', reason: 'already_sent' }]);
    expect(mailbox(t).sent).toHaveLength(1);
    const [row] = await notificationRows(db);
    expect(row?.attempts).toBe(1);
    expect(await sendNotification(t, 99999)).toEqual({ outcome: 'skipped', reason: 'gone' });
  });

  it('retries a transient failure with the attempt on the row, sends on a later attempt, and records the attempt that succeeded', async () => {
    const clientId = await merchant();
    await enqueue(lowBalance(clientId));
    const [row] = await notificationRows(db);
    for (const attemptsMade of [0, 1]) {
      mailbox(t).failNext(new DeliveryError('The mail server is busy.'));
      await expectRejection(sendNotification(t, row!.id, attemptsMade), 'The mail server is busy.');
      expect((await notificationRows(db))[0]).toMatchObject({
        status: 'queued',
        attempts: attemptsMade + 1,
        error: null,
      });
    }
    expect(await sendNotification(t, row!.id, 2)).toEqual({ outcome: 'sent' });
    expect((await notificationRows(db))[0]).toMatchObject({ status: 'sent', attempts: 3 });
    expect(mailbox(t).sent).toHaveLength(1);
  });

  it('marks the row failed with the reason on the last attempt and never sends it again', async () => {
    const clientId = await merchant();
    await enqueue(lowBalance(clientId));
    const [row] = await notificationRows(db);
    for (const attemptsMade of [0, 1, 2, 3]) {
      mailbox(t).failNext(new DeliveryError('Connection timed out.'));
      await expectRejection(sendNotification(t, row!.id, attemptsMade), 'Connection timed out.');
    }
    expect((await notificationRows(db))[0]).toMatchObject({ status: 'queued', attempts: 4 });
    mailbox(t).failNext(new DeliveryError('Connection timed out.'));
    await expectRejection(sendNotification(t, row!.id, 4), 'Connection timed out.');
    expect((await notificationRows(db))[0]).toMatchObject({
      status: 'failed',
      attempts: 5,
      error: 'Connection timed out.',
    });
    expect(await sendNotification(t, row!.id, 5)).toEqual({ outcome: 'skipped', reason: 'already_failed' });
    expect(mailbox(t).sent).toEqual([]);
  });

  it('fails a permanent refusal at once, without a retry', async () => {
    const clientId = await merchant();
    await enqueue(lowBalance(clientId));
    const [row] = await notificationRows(db);
    mailbox(t).failNext(new DeliveryError('550 5.1.1 The mailbox does not exist.', { permanent: true }));
    expect(await sendNotification(t, row!.id)).toEqual({
      outcome: 'failed',
      reason: '550 5.1.1 The mailbox does not exist.',
    });
    expect((await notificationRows(db))[0]).toMatchObject({
      status: 'failed',
      attempts: 1,
      error: '550 5.1.1 The mailbox does not exist.',
    });
  });

  it('fails a message whose template was switched off or deleted, or whose recipient lost the address, after it was queued', async () => {
    const clientId = await merchant();
    await enqueue(lowBalance(clientId));
    await enqueue({
      ...lowBalance(clientId),
      event: 'deposit.approved',
      variables: { merchantName: 'Z', amount: '1', currency: 'USD' },
    });
    await enqueue({
      ...lowBalance(clientId),
      event: 'invoice.paid',
      variables: { merchantName: 'Z', invoiceNumber: 'I-1', amount: '1', currency: 'USD' },
    });
    await db
      .update(s.notificationTemplates)
      .set({ isActive: false })
      .where(eq(s.notificationTemplates.event, 'wallet.low_balance'));
    await db.delete(s.notificationTemplates).where(eq(s.notificationTemplates.event, 'deposit.approved'));
    await db.update(s.clients).set({ email: 'not-an-address' }).where(eq(s.clients.id, clientId));
    expect(
      (await sendAllQueued(t)).map((outcome) => (outcome.outcome === 'failed' ? outcome.reason : outcome.outcome)),
    ).toEqual([
      'The template is switched off.',
      'There is no template for this message.',
      'The recipient has no email address.',
    ]);
    expect(mailbox(t).sent).toEqual([]);
  });

  it('sends the HTML part with escaped values and a text part made from it when the template has markup', async () => {
    const clientId = await merchant({ name: 'Zain <b>&</b> Co' });
    await db
      .update(s.notificationTemplates)
      .set({ body: '<p>Hi <strong>{{merchantName}}</strong>, you have {{available}} {{currency}}.</p>' })
      .where(eq(s.notificationTemplates.event, 'wallet.low_balance'));
    await enqueue({
      ...lowBalance(clientId),
      variables: { ...lowBalance(clientId).variables, merchantName: 'Zain <b>&</b> Co' },
    });
    await sendAllQueued(t);
    const [mail] = mailbox(t).sent;
    expect(mail?.html).toBe('<p>Hi <strong>Zain &lt;b&gt;&amp;&lt;/b&gt; Co</strong>, you have 42.50 USD.</p>');
    expect(mail?.text).toBe('Hi Zain <b>&</b> Co, you have 42.50 USD.');
  });

  it('sends a Telegram message to the linked chat, to a chat named by the row, and fails for a merchant with no chat', async () => {
    const telegramOn = { events: { 'wallet.low_balance': { email: false, telegram: true } } };
    const linked = await merchant({ telegramChatId: '7001234', notificationPrefs: telegramOn });
    const unlinked = await merchant({ name: 'No Chat', notificationPrefs: telegramOn });
    await enqueue({ ...lowBalance(linked), channel: 'telegram' });
    await enqueue({ ...lowBalance(unlinked), channel: 'telegram' });
    await enqueue({ ...lowBalance(unlinked), channel: 'telegram', chatId: '555' });
    const outcomes = await sendAllQueued(t);
    expect(outcomes).toEqual([
      { outcome: 'sent' },
      { outcome: 'failed', reason: 'Telegram is not linked.' },
      { outcome: 'sent' },
    ]);
    expect(telegramOutbox(t).sent).toEqual([
      { chatId: '7001234', text: 'Low balance: 42.50 USD available (your alert level is 50.00 USD).' },
      { chatId: '555', text: 'Low balance: 42.50 USD available (your alert level is 50.00 USD).' },
    ]);
    expect(mailbox(t).sent).toEqual([]);
  });

  it('re-reads the merchant at send time: a message switched off or a merchant suspended after the row was queued sends nothing, a transactional mail still goes out', async () => {
    const off = await merchant();
    const suspended = await merchant();
    const telegramOff = await merchant({
      telegramChatId: '7001234',
      notificationPrefs: { events: { 'wallet.low_balance': { email: false, telegram: true } } },
    });
    await enqueue({ ...lowBalance(off), dedupeKey: 'off' });
    await enqueue({ ...lowBalance(suspended), dedupeKey: 'suspended' });
    await enqueue({ ...lowBalance(telegramOff), channel: 'telegram', dedupeKey: 'telegram-off' });
    await enqueue({
      event: 'merchant.invited',
      recipient: { type: 'client', id: suspended },
      channel: 'email',
      variables: { merchantName: 'Zain', expiresAt: 'tomorrow' },
      dedupeKey: 'invited',
    });

    // The merchants change their minds, and one is suspended, between the queueing and the send.
    expect(
      (
        await (
          await merchantSession(t, off)
        ).call('PUT', '/client/notification-preferences', {
          events: [{ event: 'wallet.low_balance', email: false, telegram: false }],
        })
      ).status,
    ).toBe(200);
    await db.update(s.clients).set({ status: 'suspended' }).where(eq(s.clients.id, suspended));
    await db
      .update(s.clients)
      .set({ notificationPrefs: { events: { 'wallet.low_balance': { email: true, telegram: false } } } })
      .where(eq(s.clients.id, telegramOff));

    expect(await sendAllQueued(t)).toEqual([
      { outcome: 'failed', reason: 'The merchant turned this message off.' },
      { outcome: 'failed', reason: 'The recipient is suspended.' },
      { outcome: 'failed', reason: 'The merchant turned this message off.' },
      { outcome: 'sent' },
    ]);
    expect(telegramOutbox(t).sent).toEqual([]);
    expect(mailbox(t).sent.map((mail) => mail.subject)).toEqual(['Your GSM merchant account is ready']);
    expect((await notificationRows(db)).map((row) => row.status)).toEqual(['failed', 'failed', 'failed', 'sent']);
  });

  it('keeps a Telegram refusal that cannot change as failed, and retries one that can', async () => {
    const clientId = await merchant({
      telegramChatId: '7001234',
      notificationPrefs: { events: { 'wallet.low_balance': { email: false, telegram: true } } },
    });
    await enqueue({ ...lowBalance(clientId), channel: 'telegram' });
    const [row] = await notificationRows(db);
    telegramOutbox(t).failNext(new DeliveryError('Telegram asked to slow down.'));
    await expectRejection(sendNotification(t, row!.id), 'slow down');
    expect((await notificationRows(db))[0]).toMatchObject({ status: 'queued', attempts: 1 });
    telegramOutbox(t).failNext(
      new DeliveryError('Telegram refused the message: bot was blocked by the user', { permanent: true }),
    );
    expect(await sendNotification(t, row!.id, 1)).toMatchObject({ outcome: 'failed' });
    expect((await notificationRows(db))[0]).toMatchObject({ status: 'failed', attempts: 2 });
  });
});

describe('the outbox routes of the notifications', () => {
  it('send order changes, low balance and price changes to the webhooks and to the notifications, and the rest to one queue', () => {
    const queuesOf = (type: string) =>
      t.app
        .get(OutboxRouteRegistry)
        .routesOf(type)
        .map((route) => route.queue)
        .sort();
    for (const type of ['order.status_changed', 'wallet.low_balance', 'service.price_changed'])
      expect(queuesOf(type), type).toEqual(['merchant-webhooks', 'notifications']);
    for (const type of [
      'notification.send',
      'merchant.invited',
      'merchant.password_reset',
      'merchant.email_verification',
    ])
      expect(queuesOf(type), type).toEqual(['notifications']);
    // Feature 8 owns the routes of these two: the lead adds their `notifications` route when 8 is merged.
    expect(t.app.get(NotificationEventRegistry).has('invoice.paid')).toBe(true);
    expect(t.app.get(NotificationEventRegistry).has('deposit.approved')).toBe(true);
  });
});

describe('planning a low balance alert', () => {
  const event = (clientId: number, extra: Record<string, string> = {}) =>
    emitEvent(t, 'wallet.low_balance', 'ledger_accounts', 7, {
      clientId,
      currency: 'USD',
      available: '42.5000',
      threshold: '50.0000',
      ...extra,
    });

  it('makes an email by default, in the merchant’s words, and sends it', async () => {
    const clientId = await merchant();
    expect(await planEvent(t, await event(clientId))).toEqual({ created: 1 });
    expect(await sendAllQueued(t)).toEqual([{ outcome: 'sent' }]);
    const [mail] = mailbox(t).sent;
    expect(mail?.to).toBe('ops@zainmobilehub.example');
    expect(mail?.text).toContain('Your available balance is 42.50 USD, below your alert level of 50.00 USD.');
  });

  it('follows the merchant’s switches: off sends nothing, Telegram needs a linked chat, both channels make two rows', async () => {
    const off = await merchant({
      notificationPrefs: { events: { 'wallet.low_balance': { email: false, telegram: false } } },
    });
    expect(await planEvent(t, await event(off))).toEqual({ created: 0, skipped: 'opted_out' });

    const unlinked = await merchant({
      notificationPrefs: { events: { 'wallet.low_balance': { email: true, telegram: true } } },
    });
    expect(await planEvent(t, await event(unlinked))).toEqual({ created: 1 });
    expect((await notificationRows(db)).map((row) => row.channel)).toEqual(['email']);

    const both = await merchant({
      telegramChatId: '9001',
      notificationPrefs: { events: { 'wallet.low_balance': { email: true, telegram: true } } },
    });
    expect(await planEvent(t, await event(both))).toEqual({ created: 2 });
    await sendAllQueued(t);
    expect(telegramOutbox(t).sent.map((message) => message.chatId)).toEqual(['9001']);
    expect(mailbox(t).sent).toHaveLength(2);
  });

  it('is safe to run twice for one event: a retry after a crash makes no second message', async () => {
    const clientId = await merchant({
      telegramChatId: '9001',
      notificationPrefs: { events: { 'wallet.low_balance': { email: true, telegram: true } } },
    });
    const job = await event(clientId);
    expect(await planEvent(t, job)).toEqual({ created: 2 });
    expect(await planEvent(t, job, 1)).toEqual({ created: 0 });
    expect(await notificationRows(db)).toHaveLength(2);
    expect(await outboxRows()).toHaveLength(3);
    expect((await notificationRows(db)).map((row) => row.dedupeKey)).toEqual([
      `outbox-${job.eventId}:email`,
      `outbox-${job.eventId}:telegram`,
    ]);
  });

  it('skips a merchant who is gone or suspended, and fails the job for good when the event lacks its figures', async () => {
    const suspended = await merchant({ status: 'suspended' });
    expect(await planEvent(t, await event(suspended))).toEqual({ created: 0, skipped: 'recipient_suspended' });
    expect(await planEvent(t, await event(99999))).toEqual({ created: 0, skipped: 'merchant_gone' });
    const clientId = await merchant();
    const broken = await emitEvent(t, 'wallet.low_balance', 'ledger_accounts', 7, { clientId });
    await expectRejection(planEvent(t, broken), UnrecoverableError);
    const orphan = await emitEvent(t, 'wallet.low_balance', 'ledger_accounts', 7, {
      currency: 'USD',
      available: '1',
      threshold: '2',
    });
    await expectRejection(planEvent(t, orphan), UnrecoverableError);
    expect(await notificationRows(db)).toEqual([]);
  });

  it('ignores an event type it does not know', async () => {
    const job = await emitEvent(t, 'wallet.low_balance', 'ledger_accounts', 7, { clientId: 1 });
    expect(await planEvent(t, { ...job, type: 'something.else' })).toEqual({ created: 0, skipped: 'unknown_event' });
  });
});

describe('planning the result of an order', () => {
  async function orderEvent(
    clientId: number,
    toStatus: string,
    orderOverrides: Partial<typeof s.orders.$inferInsert> = {},
  ) {
    const { orderId } = await insertOrder(db, clientId, {
      serviceName: 'Vodafone UK iPhone Unlock',
      ...orderOverrides,
    });
    return {
      orderId,
      job: await emitEvent(t, 'order.status_changed', 'orders', orderId, {
        orderId,
        clientId,
        fromStatus: 'processing',
        toStatus,
      }),
    };
  }
  const optedIn = {
    events: { 'order.completed': { email: true, telegram: false }, 'order.failed': { email: true, telegram: false } },
  };

  it('stays silent until the merchant opts in to order results', async () => {
    const clientId = await merchant();
    const { job } = await orderEvent(clientId, 'completed');
    expect(await planEvent(t, job)).toEqual({ created: 0, skipped: 'opted_out' });
    expect(await notificationRows(db)).toEqual([]);
  });

  it('tells an opted-in merchant that an order is complete or was rejected, with the service and the carrier’s comment', async () => {
    const clientId = await merchant({ notificationPrefs: optedIn });
    const done = await orderEvent(clientId, 'completed');
    expect(await planEvent(t, done.job)).toEqual({ created: 1 });
    const failed = await orderEvent(clientId, 'rejected', {
      status: 'rejected',
      resultCode: 'REJECTED',
      resultComment: 'Blacklisted device.',
    });
    expect(await planEvent(t, failed.job)).toEqual({ created: 1 });
    await sendAllQueued(t);
    const [complete, rejected] = mailbox(t).sent;
    expect(complete).toMatchObject({ subject: `Order ${done.orderId} is complete` });
    expect(complete?.text).toContain('(Vodafone UK iPhone Unlock) is complete. Device is clean');
    expect(rejected).toMatchObject({ subject: `Order ${failed.orderId} was rejected` });
    expect(rejected?.text).toContain('Blacklisted device.');
    expect((await notificationRows(db)).map((row) => row.event)).toEqual(['order.completed', 'order.failed']);
  });

  it('ignores the other status changes, a storefront order, an order of another merchant and an order that is gone', async () => {
    const clientId = await merchant({ notificationPrefs: optedIn });
    const processing = await orderEvent(clientId, 'processing');
    expect(await planEvent(t, processing.job)).toEqual({ created: 0, skipped: 'not_notified' });
    const storefront = await emitEvent(t, 'order.status_changed', 'orders', 5, {
      orderId: 5,
      clientId: null,
      fromStatus: 'processing',
      toStatus: 'completed',
    });
    expect(await planEvent(t, storefront)).toEqual({ created: 0, skipped: 'no_merchant' });
    const other = await merchant({ notificationPrefs: optedIn });
    const foreign = await orderEvent(other, 'completed');
    const mismatch = await emitEvent(t, 'order.status_changed', 'orders', foreign.orderId, {
      orderId: foreign.orderId,
      clientId,
      fromStatus: 'processing',
      toStatus: 'completed',
    });
    expect(await planEvent(t, mismatch)).toEqual({ created: 0, skipped: 'source_gone' });
    const gone = await emitEvent(t, 'order.status_changed', 'orders', 987654, {
      orderId: 987654,
      clientId,
      fromStatus: 'processing',
      toStatus: 'completed',
    });
    expect(await planEvent(t, gone)).toEqual({ created: 0, skipped: 'source_gone' });
    expect(await notificationRows(db)).toEqual([]);
  });
});

describe('planning the events of billing', () => {
  it('tells a merchant about a paid invoice and an approved deposit, by email by default', async () => {
    const clientId = await merchant();
    await insertUsd(db);
    const [invoice] = await db
      .insert(s.invoices)
      .values({
        number: 'INV-2026-0311',
        clientId,
        kind: 'manual',
        amount: '250.0000',
        netAmount: '250.0000',
        total: '250.0000',
        currency: 'USD',
        status: 'paid',
        paidAt: clock.now(),
      })
      .returning({ id: s.invoices.id });
    const paid = eventJob('invoice.paid', 'invoices', invoice!.id, { invoiceId: invoice!.id, clientId });
    expect(await planEvent(t, paid)).toEqual({ created: 1 });
    const approved = eventJob('deposit.approved', 'payments', 12, {
      clientId,
      amount: '100.0000',
      currency: 'USD',
    });
    expect(await planEvent(t, approved)).toEqual({ created: 1 });
    await sendAllQueued(t);
    expect(mailbox(t).sent.map((mail) => mail.subject)).toEqual([
      'Invoice INV-2026-0311 is paid',
      'Your deposit of 100.00 USD was approved',
    ]);
    expect(mailbox(t).sent[0]?.text).toContain('(250.00 USD) was paid');
    const gone = eventJob('invoice.paid', 'invoices', 987654, { invoiceId: 987654, clientId });
    expect(await planEvent(t, gone)).toEqual({ created: 0, skipped: 'source_gone' });
    const broken = eventJob('deposit.approved', 'payments', 13, { clientId });
    await expectRejection(planEvent(t, broken), UnrecoverableError);
  });
});

describe('the daily digest of price changes (user rule 9)', () => {
  async function services() {
    const categoryId = await insertCategory(db);
    const a = await insertService(db, categoryId, { name: 'Vodafone UK iPhone Unlock' });
    const b = await insertService(db, categoryId, { name: 'O2 UK iPhone Unlock' });
    return { a, b };
  }
  const change = (clientId: number, serviceId: number, previousPrice: string, price: string) =>
    emitEvent(t, 'service.price_changed', 'services', serviceId, {
      clientId,
      serviceId,
      previousPrice,
      price,
      currency: 'USD',
    });
  const digests = () => notificationRows(db);

  it('collects the day’s changes into one row, sent once at the next 06:00 UTC, with a delayed job under a deterministic id', async () => {
    const { a, b } = await services();
    const clientId = await merchant();
    const first = await change(clientId, a, '12.0000', '12.5000');
    expect(await planEvent(t, first)).toEqual({ created: 1 });
    const [row] = await digests();
    expect(row).toMatchObject({
      event: 'service.price_changed',
      channel: 'email',
      status: 'queued',
      dedupeKey: `digest:service.price_changed:email:${clientId}:2026-11-01`,
    });
    const job = await notificationQueue().getJob(queueJobId('notification', row!.id));
    expect(job?.name).toBe('notification.send');
    expect(job?.data).toEqual({ notificationId: row!.id });
    expect(job?.opts.delay).toBe(20 * HOUR);

    clock.advance(2 * HOUR);
    expect(await planEvent(t, await change(clientId, b, '9.8000', '10.2000'))).toEqual({ created: 0 });
    // The same event again changes nothing.
    expect(await planEvent(t, first, 1)).toEqual({ created: 0 });
    expect(await digests()).toHaveLength(1);
    expect(await outboxRows()).toHaveLength(2);
    expect(((await digests())[0]!.payload as { items: unknown[] }).items).toHaveLength(2);
    expect(mailbox(t).sent).toEqual([]);

    clock.set('2026-11-02T06:00:00.000Z');
    expect(await sendNotification(t, row!.id)).toEqual({ outcome: 'sent' });
    expect(await sendNotification(t, row!.id, 1)).toEqual({ outcome: 'skipped', reason: 'already_sent' });
    const [mail] = mailbox(t).sent;
    expect(mailbox(t).sent).toHaveLength(1);
    expect(mail?.subject).toBe('Price changes on services you ordered');
    expect(mail?.text).toContain('The price of 2 service(s) you ordered in the last 30 days changed:');
    expect(mail?.text).toContain(
      '- Vodafone UK iPhone Unlock: 12.00 to 12.50 USD\n- O2 UK iPhone Unlock: 9.80 to 10.20 USD',
    );
    expect((await digests())[0]).toMatchObject({ status: 'sent', attempts: 1 });
  });

  it('puts a change that arrives after the digest was closed or sent into the next day’s digest', async () => {
    const { a, b } = await services();
    const clientId = await merchant();
    await planEvent(t, await change(clientId, a, '12.0000', '12.5000'));
    const [first] = await digests();
    clock.set('2026-11-02T06:00:00.000Z');
    await sendNotification(t, first!.id);

    // 06:00 starts a new period: the change belongs to the next digest, not to the one that was just sent.
    expect(await planEvent(t, await change(clientId, b, '9.8000', '10.2000'))).toEqual({ created: 1 });
    const rows = await digests();
    expect(rows).toHaveLength(2);
    expect(rows[1]).toMatchObject({
      status: 'queued',
      dedupeKey: `digest:service.price_changed:email:${clientId}:2026-11-02`,
    });
    expect((await notificationQueue().getJob(queueJobId('notification', rows[1]!.id)))?.opts.delay).toBe(DAY);

    // A row closed by its send job but not yet sent (a retry is waiting) takes no more items: the change opens the next period's row.
    await db
      .update(s.notifications)
      .set({ payload: { ...(rows[1]!.payload as object), closed: true } })
      .where(eq(s.notifications.id, rows[1]!.id));
    expect(await planEvent(t, await change(clientId, a, '12.5000', '13.0000'))).toEqual({ created: 1 });
    const after = await digests();
    expect(after.map((row) => (row.dedupeKey ?? '').slice(-10))).toEqual(['2026-11-01', '2026-11-02', '2026-11-03']);
    expect((after[1]!.payload as { items: unknown[] }).items).toHaveLength(1);
  });

  it('is a day long from 06:00 UTC: a change at 05:59 waits one minute, one at 06:01 waits a day', async () => {
    const { a, b } = await services();
    const clientId = await merchant();
    clock.set('2026-11-02T05:59:00.000Z');
    await planEvent(t, await change(clientId, a, '12.0000', '12.5000'));
    const [early] = await digests();
    expect(early?.dedupeKey).toBe(`digest:service.price_changed:email:${clientId}:2026-11-01`);
    expect((await notificationQueue().getJob(queueJobId('notification', early!.id)))?.opts.delay).toBe(MINUTE);
    clock.set('2026-11-02T06:01:00.000Z');
    await planEvent(t, await change(clientId, b, '9.8000', '10.2000'));
    const rows = await digests();
    expect(rows[1]?.dedupeKey).toBe(`digest:service.price_changed:email:${clientId}:2026-11-02`);
    expect((await notificationQueue().getJob(queueJobId('notification', rows[1]!.id)))?.opts.delay).toBe(DAY - MINUTE);
  });

  it('gives the send job at least 10 seconds, even for a change a few milliseconds before 06:00 UTC', async () => {
    const { a, b } = await services();
    const clientId = await merchant();
    clock.set('2026-11-02T05:59:59.995Z');
    await planEvent(t, await change(clientId, a, '12.0000', '12.5000'));
    const [row] = await digests();
    expect(row?.dedupeKey).toBe(`digest:service.price_changed:email:${clientId}:2026-11-01`);
    expect((await notificationQueue().getJob(queueJobId('notification', row!.id)))?.opts.delay).toBe(10_000);

    // A change right after 06:00 opens the new period's row, with its normal day-long wait.
    clock.set('2026-11-02T06:00:00.005Z');
    await planEvent(t, await change(clientId, b, '9.8000', '10.2000'));
    const rows = await digests();
    expect(rows).toHaveLength(2);
    expect((await notificationQueue().getJob(queueJobId('notification', rows[1]!.id)))?.opts.delay).toBe(DAY - 5);
  });

  it('keeps a digest per merchant and per channel, in the merchant’s preferences, and nothing for a merchant who turned it off', async () => {
    const { a } = await services();
    const linked = await merchant({
      telegramChatId: '9001',
      notificationPrefs: { events: { 'service.price_changed': { email: true, telegram: true } } },
    });
    const plain = await merchant();
    const off = await merchant({
      notificationPrefs: { events: { 'service.price_changed': { email: false, telegram: false } } },
    });
    expect(await planEvent(t, await change(linked, a, '12.0000', '12.5000'))).toEqual({ created: 2 });
    expect(await planEvent(t, await change(plain, a, '12.0000', '12.5000'))).toEqual({ created: 1 });
    expect(await planEvent(t, await change(off, a, '12.0000', '12.5000'))).toEqual({
      created: 0,
      skipped: 'opted_out',
    });
    const rows = await digests();
    expect(rows.map((row) => `${row.recipientId === linked ? 'linked' : 'plain'}:${row.channel}`)).toEqual([
      'linked:email',
      'linked:telegram',
      'plain:email',
    ]);

    clock.set('2026-11-02T06:00:00.000Z');
    for (const row of rows) await sendNotification(t, row.id);
    expect(telegramOutbox(t).sent).toEqual([
      {
        chatId: '9001',
        text: 'Price changes on services you ordered (1):\n- Vodafone UK iPhone Unlock: 12.00 to 12.50 USD',
      },
    ]);
    expect(mailbox(t).sent).toHaveLength(2);
  });

  it('does not send a digest after the merchant turned it off or was suspended, and sends it when the merchant turned it back on before 06:00', async () => {
    const { a } = await services();
    const optedOut = await merchant();
    const suspended = await merchant();
    const changedMind = await merchant();
    for (const clientId of [optedOut, suspended, changedMind]) {
      expect(await planEvent(t, await change(clientId, a, '12.0000', '12.5000'))).toEqual({ created: 1 });
    }
    const rows = await digests();
    expect(rows).toHaveLength(3);

    const choose = async (clientId: number, email: boolean) =>
      (
        await (
          await merchantSession(t, clientId)
        ).call('PUT', '/client/notification-preferences', {
          events: [{ event: 'service.price_changed', email, telegram: false }],
        })
      ).status;
    expect(await choose(optedOut, false)).toBe(200);
    expect(await choose(changedMind, false)).toBe(200);
    expect(await choose(changedMind, true)).toBe(200);
    await db.update(s.clients).set({ status: 'suspended' }).where(eq(s.clients.id, suspended));

    clock.set('2026-11-02T06:00:00.000Z');
    expect(await sendNotification(t, rows[0]!.id)).toEqual({
      outcome: 'failed',
      reason: 'The merchant turned this message off.',
    });
    expect(await sendNotification(t, rows[1]!.id)).toEqual({
      outcome: 'failed',
      reason: 'The recipient is suspended.',
    });
    expect(await sendNotification(t, rows[2]!.id)).toEqual({ outcome: 'sent' });
    expect(mailbox(t).sent.map((mail) => mail.to)).toEqual(['ops-3@zainmobilehub.example']);
    expect((await digests()).map((row) => row.status)).toEqual(['failed', 'failed', 'sent']);
  });

  it('skips a change whose service or merchant is gone', async () => {
    const { a } = await services();
    const clientId = await merchant();
    expect(await planEvent(t, await change(clientId, 987654, '1.0000', '2.0000'))).toEqual({
      created: 0,
      skipped: 'source_gone',
    });
    expect(await planEvent(t, await change(99999, a, '1.0000', '2.0000'))).toEqual({
      created: 0,
      skipped: 'merchant_gone',
    });
    expect(await digests()).toEqual([]);
  });
});

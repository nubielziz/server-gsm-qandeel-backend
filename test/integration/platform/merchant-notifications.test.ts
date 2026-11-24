// Integration tests of the merchant portal's notification settings (feature 12a, MISMATCHES B165): the preferences a merchant reads and saves,
// and what an older stored Telegram value or an older queued Telegram row does now that merchants have email only (decision 062).
// Real Postgres and Redis through HTTP; Telegram and mail are the in-memory drivers.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { eq } from 'drizzle-orm';
import { type Database, schema as s } from '@src/infra/db';
import { thresholdFrom } from '@src/modules/money/domain/low-balance';
import { type TestApp, createTestApp } from '../../support/app';
import { clearIdentityCaches, insertMerchant } from '../../support/auth';
import { TestClock } from '../../support/clock';
import { closeTestDb, resetDb, testDb } from '../../support/db';
import {
  type MerchantSession,
  emitEvent,
  mailbox,
  merchantSession,
  notificationRows,
  planEvent,
  seedDefaultTemplates,
  sendAllQueued,
  sendNotification,
  telegramOutbox,
} from '../../support/notifications';
import { RedisService } from '@src/infra/redis';
import { deleteBullKeys, testBullPrefix } from '../../support/queues';

const prefix = testBullPrefix();
const BOT = { TELEGRAM_BOT_TOKEN: '1234567890:AAtest-token' };
const clock = new TestClock('2026-11-01T10:00:00.000Z');
let t: TestApp;
let db: Database;

beforeAll(async () => {
  ({ db } = await testDb());
  t = await createTestApp({ clock, env: { ...BOT, BULL_PREFIX: prefix } });
});
afterAll(async () => {
  await deleteBullKeys(t.app.get(RedisService).queue, prefix);
  await resetDb();
  await clearIdentityCaches(t);
  await t.close();
  await closeTestDb();
});
beforeEach(async () => {
  clock.set('2026-11-01T10:00:00.000Z');
  await resetDb();
  await clearIdentityCaches(t);
  await seedDefaultTemplates(db);
  telegramOutbox(t).reset();
  mailbox(t).reset();
});

let counter = 0;
async function signedIn(overrides: Partial<typeof s.clients.$inferInsert> = {}): Promise<MerchantSession> {
  counter += 1;
  const clientId = await insertMerchant(db, {
    name: 'Zain Mobile Hub',
    email: `ops-${counter}@zainmobilehub.example`,
    ...overrides,
  });
  return merchantSession(t, clientId);
}
const fieldsOf = (body: { errors: Array<{ field: string }> }) => body.errors.map((error) => error.field);
const clientRow = async (id: number) => (await db.select().from(s.clients).where(eq(s.clients.id, id)))[0]!;

describe('GET /client/notification-preferences', () => {
  it('lists the events a merchant may switch, with the defaults: email on, order results off, no alert level, and no Telegram anywhere', async () => {
    const m = await signedIn({ email: 'ops@zainmobilehub.example' });
    const res = await m.call('GET', '/client/notification-preferences');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      email: { address: 'ops@zainmobilehub.example' },
      lowBalanceThreshold: null,
      events: [
        { event: 'wallet.low_balance', label: 'Low wallet balance', email: true },
        { event: 'service.price_changed', label: 'Price changes', email: true },
        { event: 'invoice.paid', label: 'Invoice paid', email: true },
        { event: 'order.completed', label: 'Order completed', email: false },
        { event: 'order.failed', label: 'Order failed', email: false },
        // Feature 23: the notification center's announcements, email on by default.
        { event: 'broadcast.announcement', label: 'Announcements', email: true },
      ],
    });
    // The mails that sign you in are always sent, so they are not listed.
    expect(JSON.stringify(res.body)).not.toContain('merchant.invited');
    expect(JSON.stringify(res.body)).not.toMatch(/telegram/i);
  });

  it('shows what was saved and the alert level as a money string, tolerates junk in the stored preferences, and ignores a Telegram switch an older save stored', async () => {
    const m = await signedIn({
      telegramChatId: '9001',
      notificationPrefs: {
        lowBalanceThreshold: '75',
        events: {
          'order.completed': { email: true, telegram: true },
          'wallet.low_balance': { telegram: true },
          'gone.event': { email: true },
          'invoice.paid': 'bad',
        },
        somethingElse: 1,
      },
    });
    const res = await m.call('GET', '/client/notification-preferences');
    expect(res.body.lowBalanceThreshold).toBe('75.0000');
    const byEvent = Object.fromEntries(res.body.events.map((row: { event: string }) => [row.event, row]));
    expect(byEvent['order.completed']).toEqual({ event: 'order.completed', label: 'Order completed', email: true });
    expect(byEvent['wallet.low_balance']).toMatchObject({ email: true });
    expect(byEvent['invoice.paid']).toMatchObject({ email: true });
    expect(res.body).not.toHaveProperty('telegram');
  });

  it('needs a session and an active account', async () => {
    expect((await t.app.inject({ method: 'GET', url: '/client/notification-preferences' })).statusCode).toBe(401);
    // Decision 064: there is no waiting-for-approval status any more; a suspended account is refused.
    const suspended = await signedIn({ status: 'suspended' });
    expect((await suspended.call('GET', '/client/notification-preferences')).body.code).toBe('ACCOUNT_SUSPENDED');
  });
});

describe('PUT /client/notification-preferences', () => {
  it('replaces the listed events, keeps the others, and answers the same body as the GET', async () => {
    const m = await signedIn();
    const first = await m.call('PUT', '/client/notification-preferences', {
      events: [
        { event: 'order.completed', email: true },
        { event: 'wallet.low_balance', email: false },
      ],
    });
    expect(first.status).toBe(200);
    const byEvent = (body: { events: Array<{ event: string }> }) =>
      Object.fromEntries(body.events.map((row) => [row.event, row]));
    expect(byEvent(first.body)['order.completed']).toMatchObject({ email: true });
    expect(byEvent(first.body)['wallet.low_balance']).toMatchObject({ email: false });

    const second = await m.call('PUT', '/client/notification-preferences', {
      events: [{ event: 'invoice.paid', email: false }],
    });
    // The events left out keep their value.
    expect(byEvent(second.body)['order.completed']).toMatchObject({ email: true });
    expect(byEvent(second.body)['invoice.paid']).toMatchObject({ email: false });
    expect((await m.call('GET', '/client/notification-preferences')).body).toEqual(second.body);
  });

  it('accepts a row that an older portal still sends with a Telegram switch, stores the email switch only, and never refuses it for a missing chat', async () => {
    const m = await signedIn();
    const res = await m.call('PUT', '/client/notification-preferences', {
      events: [
        { event: 'invoice.paid', email: false, telegram: true },
        { event: 'broadcast.announcement', email: true, telegram: true },
      ],
    });
    expect(res.status).toBe(200);
    expect(JSON.stringify(res.body)).not.toMatch(/telegram/i);
    expect((await clientRow(m.clientId)).notificationPrefs).toEqual({
      events: { 'invoice.paid': { email: false }, 'broadcast.announcement': { email: true } },
    });
  });

  it('drops the Telegram switch an older save stored when the event is saved again, and keeps the ones it did not list', async () => {
    const m = await signedIn({
      notificationPrefs: {
        events: { 'invoice.paid': { email: true, telegram: true }, 'order.failed': { email: true, telegram: true } },
      },
    });
    await m.call('PUT', '/client/notification-preferences', { events: [{ event: 'invoice.paid', email: false }] });
    expect((await clientRow(m.clientId)).notificationPrefs).toEqual({
      events: { 'invoice.paid': { email: false }, 'order.failed': { email: true, telegram: true } },
    });
  });

  it('sets, keeps and removes the alert level, and 7b’s watch reads what was saved', async () => {
    const m = await signedIn();
    expect(
      (await m.call('PUT', '/client/notification-preferences', { lowBalanceThreshold: '50', events: [] })).body
        .lowBalanceThreshold,
    ).toBe('50.0000');
    expect(thresholdFrom((await clientRow(m.clientId)).notificationPrefs)?.toWire()).toBe('50.0000');
    // A missing key keeps it; `null` removes it; a decimal with up to four places is fine.
    expect((await m.call('PUT', '/client/notification-preferences', { events: [] })).body.lowBalanceThreshold).toBe(
      '50.0000',
    );
    expect(
      (await m.call('PUT', '/client/notification-preferences', { lowBalanceThreshold: ' 12.5 ' })).body
        .lowBalanceThreshold,
    ).toBe('12.5000');
    expect(
      (await m.call('PUT', '/client/notification-preferences', { lowBalanceThreshold: null })).body.lowBalanceThreshold,
    ).toBeNull();
    expect(thresholdFrom((await clientRow(m.clientId)).notificationPrefs)).toBeUndefined();
  });

  it('keeps the keys it does not know when it saves', async () => {
    const m = await signedIn({ notificationPrefs: { somethingElse: { a: 1 } } });
    await m.call('PUT', '/client/notification-preferences', {
      events: [{ event: 'invoice.paid', email: false }],
    });
    expect((await clientRow(m.clientId)).notificationPrefs).toMatchObject({ somethingElse: { a: 1 } });
  });

  it('refuses an unknown, always-sent or repeated event with 422 on events.N.event', async () => {
    const m = await signedIn();
    const res = await m.call('PUT', '/client/notification-preferences', {
      events: [
        { event: 'invoice.paid', email: true },
        { event: 'merchant.invited', email: false },
        { event: 'nope.nothing', email: true },
        { event: 'invoice.paid', email: false },
      ],
    });
    expect(res.status).toBe(422);
    expect(fieldsOf(res.body)).toEqual(['events.1.event', 'events.2.event', 'events.3.event']);
    expect((await clientRow(m.clientId)).notificationPrefs).toEqual({});
  });

  it('refuses a bad alert level, and saves nothing then', async () => {
    const m = await signedIn();
    const res = await m.call('PUT', '/client/notification-preferences', {
      lowBalanceThreshold: '-5',
      events: [{ event: 'invoice.paid', email: true }],
    });
    expect(res.status).toBe(422);
    expect(fieldsOf(res.body)).toEqual(['lowBalanceThreshold']);
    for (const bad of ['abc', '1.23456', '1e3', '', '12,5']) {
      const answer = await m.call('PUT', '/client/notification-preferences', { lowBalanceThreshold: bad });
      expect(fieldsOf(answer.body), bad).toEqual(['lowBalanceThreshold']);
    }
    expect((await clientRow(m.clientId)).notificationPrefs).toEqual({});
    expect(
      (await m.call('PUT', '/client/notification-preferences', { events: [{ event: 'invoice.paid' }] })).status,
    ).toBe(422);
  });

  it('needs a CSRF token and an active account', async () => {
    const m = await signedIn();
    expect((await m.withoutCsrf('PUT', '/client/notification-preferences', { events: [] })).body.code).toBe(
      'CSRF_FAILED',
    );
    const suspended = await signedIn({ status: 'suspended' });
    expect((await suspended.call('PUT', '/client/notification-preferences', { events: [] })).body.code).toBe(
      'ACCOUNT_SUSPENDED',
    );
  });

  it('writes no audit row: the merchant portal is not audited (B121)', async () => {
    const m = await signedIn();
    await m.call('PUT', '/client/notification-preferences', { lowBalanceThreshold: '10', events: [] });
    expect(await db.select().from(s.auditLogs)).toEqual([]);
  });
});

describe('the Telegram routes of the portal and of the bot (retired, decision 062)', () => {
  it('answers 404 to the one-time link and to the bot webhook, whatever they carry', async () => {
    const m = await signedIn();
    const link = await m.call('POST', '/client/telegram/link');
    expect(link.status).toBe(404);
    expect(link.body.code).toBe('NOT_FOUND');
    const hook = await t.app.inject({
      method: 'POST',
      url: '/webhooks/telegram/0123456789abcdef0123',
      headers: { 'content-type': 'application/json', 'x-telegram-bot-api-secret-token': 'abcdef0123456789' },
      payload: { update_id: 1, message: { chat: { id: 7001, type: 'private' }, text: '/stop' } },
    });
    expect(hook.statusCode).toBe(404);
    expect(await db.select().from(s.authTokens)).toEqual([]);
    expect(await notificationRows(db)).toEqual([]);
  });
});

describe('a merchant that older data still shows as linked to a chat', () => {
  const lowBalance = (clientId: number, available: string) =>
    emitEvent(t, 'wallet.low_balance', 'ledger_accounts', 1, {
      clientId,
      currency: 'USD',
      available,
      threshold: '50.0000',
    });

  it('gets the email of an event it switched on, and no Telegram message, whatever the old switch says', async () => {
    const m = await signedIn({
      telegramChatId: '7001',
      notificationPrefs: { events: { 'wallet.low_balance': { email: true, telegram: true } } },
    });
    expect(await planEvent(t, await lowBalance(m.clientId, '10.0000'))).toEqual({ created: 1 });
    await sendAllQueued(t);
    expect((await notificationRows(db)).map((row) => `${row.channel}:${row.status}`)).toEqual(['email:sent']);
    expect(mailbox(t).sent).toHaveLength(1);
    expect(telegramOutbox(t).sent).toEqual([]);
  });

  it('gets nothing for an event whose email is off, even with the old Telegram switch on', async () => {
    const m = await signedIn({
      telegramChatId: '7001',
      notificationPrefs: { events: { 'wallet.low_balance': { email: false, telegram: true } } },
    });
    expect(await planEvent(t, await lowBalance(m.clientId, '9.0000'))).toEqual({ created: 0, skipped: 'opted_out' });
    expect(await notificationRows(db)).toEqual([]);
    expect(telegramOutbox(t).sent).toEqual([]);
  });

  it('records a Telegram row that was queued before the channel was retired as failed, and sends nothing', async () => {
    const m = await signedIn({ telegramChatId: '7001' });
    const [row] = await db
      .insert(s.notifications)
      .values({
        recipientType: 'account',
        recipientId: m.accountId,
        channel: 'telegram',
        event: 'wallet.low_balance',
        payload: { chatId: '7001', variables: { merchantName: 'Zain Mobile Hub' } },
        status: 'queued',
      })
      .returning();
    expect(await sendNotification(t, row!.id)).toEqual({
      outcome: 'failed',
      reason: 'Telegram is no longer used for this message.',
    });
    expect((await notificationRows(db))[0]).toMatchObject({
      status: 'failed',
      error: 'Telegram is no longer used for this message.',
    });
    expect(telegramOutbox(t).sent).toEqual([]);
  });
});

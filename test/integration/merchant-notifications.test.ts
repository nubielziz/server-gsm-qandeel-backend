// Integration tests of the merchant portal's notification settings and of Telegram's update webhook (feature 12a, MISMATCHES B165): the preferences
// a merchant reads and saves, the one-time Telegram link, and the webhook that links a chat with `/start <token>` and unlinks it with `/stop`.
// Real Postgres and Redis through HTTP; Telegram and mail are the in-memory drivers.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { eq } from 'drizzle-orm';
import { TokenService } from '../../src/infra/crypto';
import { type Database, schema as s } from '../../src/infra/db';
import { thresholdFrom } from '../../src/modules/money/domain/low-balance';
import { type TestApp, createTestApp } from '../support/app';
import { clearIdentityCaches, insertMerchant } from '../support/auth';
import { MINUTE, TestClock } from '../support/clock';
import { closeTestDb, resetDb, testDb } from '../support/db';
import {
  type MerchantSession,
  emitEvent,
  merchantSession,
  notificationRows,
  planEvent,
  seedDefaultTemplates,
  sendAllQueued,
  telegramOutbox,
} from '../support/notifications';
import { RedisService } from '../../src/infra/redis';
import { deleteBullKeys, testBullPrefix } from '../support/queues';

const prefix = testBullPrefix();
const SECRET = 'tg-webhook-secret-0123456789-abcdef';
const BOT = { TELEGRAM_BOT_TOKEN: '1234567890:AAtest-token', TELEGRAM_BOT_USERNAME: 'gsm_test_bot' };
const clock = new TestClock('2026-11-01T10:00:00.000Z');
let t: TestApp;
let db: Database;

beforeAll(async () => {
  ({ db } = await testDb());
  t = await createTestApp({ clock, env: { ...BOT, TELEGRAM_WEBHOOK_SECRET: SECRET, BULL_PREFIX: prefix } });
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
  it('lists the events a merchant may switch, with the defaults: email on, Telegram off, order results off, no alert level', async () => {
    const m = await signedIn({ email: 'ops@zainmobilehub.example' });
    const res = await m.call('GET', '/client/notification-preferences');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      email: { address: 'ops@zainmobilehub.example' },
      telegram: { linked: false },
      lowBalanceThreshold: null,
      events: [
        { event: 'wallet.low_balance', label: 'Low wallet balance', email: true, telegram: false },
        { event: 'service.price_changed', label: 'Price changes', email: true, telegram: false },
        { event: 'deposit.approved', label: 'Deposit approved', email: true, telegram: false },
        { event: 'invoice.paid', label: 'Invoice paid', email: true, telegram: false },
        { event: 'order.completed', label: 'Order completed', email: false, telegram: false },
        { event: 'order.failed', label: 'Order failed', email: false, telegram: false },
      ],
    });
    // The mails that sign you in are always sent, so they are not listed.
    expect(JSON.stringify(res.body)).not.toContain('merchant.invited');
  });

  it('shows what was saved, the linked chat and the alert level as a money string, and tolerates junk in the stored preferences', async () => {
    const m = await signedIn({
      telegramChatId: '9001',
      notificationPrefs: {
        lowBalanceThreshold: '75',
        events: {
          'order.completed': { email: true, telegram: true },
          'gone.event': { email: true },
          'invoice.paid': 'bad',
        },
        somethingElse: 1,
      },
    });
    const res = await m.call('GET', '/client/notification-preferences');
    expect(res.body.telegram).toEqual({ linked: true });
    expect(res.body.lowBalanceThreshold).toBe('75.0000');
    const byEvent = Object.fromEntries(res.body.events.map((row: { event: string }) => [row.event, row]));
    expect(byEvent['order.completed']).toMatchObject({ email: true, telegram: true });
    expect(byEvent['invoice.paid']).toMatchObject({ email: true, telegram: false });
  });

  it('needs a session and an approved merchant', async () => {
    expect((await t.app.inject({ method: 'GET', url: '/client/notification-preferences' })).statusCode).toBe(401);
    const pending = await signedIn({ status: 'pending' });
    expect((await pending.call('GET', '/client/notification-preferences')).body.code).toBe('ACCOUNT_PENDING_APPROVAL');
  });
});

describe('PUT /client/notification-preferences', () => {
  it('replaces the listed events, keeps the others, and answers the same body as the GET', async () => {
    const m = await signedIn({ telegramChatId: '9001' });
    const first = await m.call('PUT', '/client/notification-preferences', {
      events: [
        { event: 'order.completed', email: true, telegram: true },
        { event: 'wallet.low_balance', email: false, telegram: true },
      ],
    });
    expect(first.status).toBe(200);
    const byEvent = (body: { events: Array<{ event: string }> }) =>
      Object.fromEntries(body.events.map((row) => [row.event, row]));
    expect(byEvent(first.body)['order.completed']).toMatchObject({ email: true, telegram: true });
    expect(byEvent(first.body)['wallet.low_balance']).toMatchObject({ email: false, telegram: true });

    const second = await m.call('PUT', '/client/notification-preferences', {
      events: [{ event: 'invoice.paid', email: false, telegram: false }],
    });
    // The events left out keep their value.
    expect(byEvent(second.body)['order.completed']).toMatchObject({ email: true, telegram: true });
    expect(byEvent(second.body)['invoice.paid']).toMatchObject({ email: false, telegram: false });
    expect((await m.call('GET', '/client/notification-preferences')).body).toEqual(second.body);
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
      events: [{ event: 'invoice.paid', email: false, telegram: false }],
    });
    expect((await clientRow(m.clientId)).notificationPrefs).toMatchObject({ somethingElse: { a: 1 } });
  });

  it('refuses an unknown, always-sent or repeated event with 422 on events.N.event', async () => {
    const m = await signedIn();
    const res = await m.call('PUT', '/client/notification-preferences', {
      events: [
        { event: 'invoice.paid', email: true, telegram: false },
        { event: 'merchant.invited', email: false, telegram: false },
        { event: 'nope.nothing', email: true, telegram: false },
        { event: 'invoice.paid', email: false, telegram: false },
      ],
    });
    expect(res.status).toBe(422);
    expect(fieldsOf(res.body)).toEqual(['events.1.event', 'events.2.event', 'events.3.event']);
    expect((await clientRow(m.clientId)).notificationPrefs).toEqual({});
  });

  it('refuses Telegram while no chat is linked ("Link Telegram first.") and a bad alert level, and saves nothing then', async () => {
    const m = await signedIn();
    const res = await m.call('PUT', '/client/notification-preferences', {
      lowBalanceThreshold: '-5',
      events: [{ event: 'invoice.paid', email: true, telegram: true }],
    });
    expect(res.status).toBe(422);
    expect(fieldsOf(res.body)).toEqual(['lowBalanceThreshold', 'events.0.telegram']);
    expect(res.body.errors[1].message).toBe('Link Telegram first.');
    for (const bad of ['abc', '1.23456', '1e3', '', '12,5']) {
      const answer = await m.call('PUT', '/client/notification-preferences', { lowBalanceThreshold: bad });
      expect(fieldsOf(answer.body), bad).toEqual(['lowBalanceThreshold']);
    }
    expect((await clientRow(m.clientId)).notificationPrefs).toEqual({});
    expect(
      (await m.call('PUT', '/client/notification-preferences', { events: [{ event: 'invoice.paid' }] })).status,
    ).toBe(422);
  });

  it('needs a CSRF token and an approved merchant', async () => {
    const m = await signedIn();
    expect((await m.withoutCsrf('PUT', '/client/notification-preferences', { events: [] })).body.code).toBe(
      'CSRF_FAILED',
    );
    const pending = await signedIn({ status: 'pending' });
    expect((await pending.call('PUT', '/client/notification-preferences', { events: [] })).body.code).toBe(
      'ACCOUNT_PENDING_APPROVAL',
    );
  });

  it('writes no audit row: the merchant portal is not audited (B121)', async () => {
    const m = await signedIn();
    await m.call('PUT', '/client/notification-preferences', { lowBalanceThreshold: '10', events: [] });
    expect(await db.select().from(s.auditLogs)).toEqual([]);
  });
});

describe('POST /client/telegram/link', () => {
  const tokenOf = (url: string) => new URL(url).searchParams.get('start')!;

  it('answers a t.me link with a one-time token valid for 15 minutes, stored only as a hash, and never cached', async () => {
    const m = await signedIn();
    const res = await m.call('POST', '/client/telegram/link');
    expect(res.status).toBe(201);
    expect(res.res.headers['cache-control']).toBe('no-store');
    expect(res.body.url).toMatch(/^https:\/\/t\.me\/gsm_test_bot\?start=[A-Za-z0-9_-]{43}$/);
    expect(res.body.expiresAt).toBe(new Date(clock.nowMs() + 15 * MINUTE).toISOString());
    const [row] = await db.select().from(s.authTokens);
    expect(row).toMatchObject({ purpose: 'telegram_link', subjectType: 'client', subjectId: m.clientId, usedAt: null });
    expect(row?.tokenHash).toBe(t.app.get(TokenService).hash(tokenOf(res.body.url)));
    expect(JSON.stringify(row)).not.toContain(tokenOf(res.body.url));
  });

  it('revokes the previous link when a new one is made, also when the calls arrive together', async () => {
    const m = await signedIn();
    const first = await m.call('POST', '/client/telegram/link');
    const second = await m.call('POST', '/client/telegram/link');
    const hash = (answer: { body: { url: string } }) => t.app.get(TokenService).hash(tokenOf(answer.body.url));
    const rows = await db.select().from(s.authTokens).orderBy(s.authTokens.id);
    expect(rows.find((row) => row.tokenHash === hash(first))?.usedAt).not.toBeNull();
    expect(rows.find((row) => row.tokenHash === hash(second))?.usedAt).toBeNull();

    await Promise.all(Array.from({ length: 5 }, () => m.call('POST', '/client/telegram/link')));
    const open = (await db.select().from(s.authTokens)).filter((row) => row.usedAt === null);
    expect(open).toHaveLength(1);
  });

  it('needs a session, a CSRF token and an approved merchant, and answers 503 when the bot is not set up', async () => {
    const m = await signedIn();
    expect((await m.withoutCsrf('POST', '/client/telegram/link')).body.code).toBe('CSRF_FAILED');
    expect((await t.app.inject({ method: 'POST', url: '/client/telegram/link' })).statusCode).toBe(401);
    const pending = await signedIn({ status: 'pending' });
    expect((await pending.call('POST', '/client/telegram/link')).body.code).toBe('ACCOUNT_PENDING_APPROVAL');

    const bare = await createTestApp({ clock });
    try {
      const merchant = await merchantSession(bare, await insertMerchant(db));
      const res = await merchant.call('POST', '/client/telegram/link');
      expect(res.status).toBe(503);
      expect(res.body.code).toBe('UNAVAILABLE');
    } finally {
      await bare.close();
    }
  });
});

describe('POST /webhooks/telegram/:secret', () => {
  let updateId = 1000;
  const send = (body: unknown, options: { secret?: string; header?: string | null; app?: TestApp } = {}) =>
    (options.app ?? t).app.inject({
      method: 'POST',
      url: `/webhooks/telegram/${options.secret ?? SECRET}`,
      headers: {
        'content-type': 'application/json',
        ...(options.header === null ? {} : { 'x-telegram-bot-api-secret-token': options.header ?? SECRET }),
      },
      payload: body as never,
    });
  const message = (chatId: number | string, text: string, extra: { id?: number; type?: string } = {}) => ({
    update_id: extra.id ?? ++updateId,
    message: { chat: { id: chatId, type: extra.type ?? 'private' }, text },
  });
  /** A merchant with a live link: returns the merchant and the token the bot would be sent. */
  async function withLink(overrides: Partial<typeof s.clients.$inferInsert> = {}) {
    const m = await signedIn(overrides);
    const token = new URL((await m.call('POST', '/client/telegram/link')).body.url).searchParams.get('start')!;
    return { m, token };
  }

  it('answers 404 unless both the path secret and the header carry the configured secret', async () => {
    const body = message(1, '/stop');
    expect((await send(body)).statusCode).toBe(200);
    for (const options of [
      { secret: `${SECRET}x` },
      { header: null },
      { header: `${SECRET}x` },
      { secret: 'short', header: 'short' },
    ]) {
      const res = await send(body, options);
      expect(res.statusCode, JSON.stringify(options)).toBe(404);
      expect(res.json().code).toBe('NOT_FOUND');
    }
    const open = await createTestApp({ clock, env: { ...BOT } });
    try {
      // No secret configured: every call is refused, whatever it carries.
      expect((await send(body, { app: open })).statusCode).toBe(404);
    } finally {
      await open.close();
    }
  });

  it('links the chat on /start <token>, spends the token, and the bot answers "Linked to <merchant name>."', async () => {
    const { m, token } = await withLink({ name: 'Zain Mobile Hub' });
    const res = await send(message(7001234, `/start ${token}`, { id: 5001 }));
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({});
    expect((await clientRow(m.clientId)).telegramChatId).toBe('7001234');
    expect((await db.select().from(s.authTokens))[0]?.usedAt).toEqual(clock.now());
    const [row] = await notificationRows(db);
    expect(row).toMatchObject({
      recipientType: 'client',
      recipientId: m.clientId,
      channel: 'telegram',
      event: 'telegram.linked',
      status: 'queued',
      dedupeKey: 'telegram-update-5001',
      payload: { chatId: '7001234', variables: { merchantName: 'Zain Mobile Hub' } },
    });
    await sendAllQueued(t);
    expect(telegramOutbox(t).sent).toEqual([{ chatId: '7001234', text: 'Linked to Zain Mobile Hub.' }]);
    expect((await m.call('GET', '/client/notification-preferences')).body.telegram.linked).toBe(true);
  });

  it('processes a repeated update once, and a token only once', async () => {
    const { m, token } = await withLink();
    expect((await send(message(7001, `/start ${token}`, { id: 6001 }))).statusCode).toBe(200);
    expect((await send(message(7001, `/start ${token}`, { id: 6001 }))).statusCode).toBe(200);
    expect(await notificationRows(db)).toHaveLength(1);
    // The same token in a new update (another chat) does nothing: it is spent.
    expect((await send(message(7002, `/start ${token}`, { id: 6002 }))).statusCode).toBe(200);
    expect((await clientRow(m.clientId)).telegramChatId).toBe('7001');
    expect(await notificationRows(db)).toHaveLength(1);
    // Telegram's retries arrive together: still one answer.
    const other = await withLink();
    await Promise.all(Array.from({ length: 4 }, () => send(message(7003, `/start ${other.token}`, { id: 6003 }))));
    expect(await notificationRows(db)).toHaveLength(2);
  });

  it('ignores a token that is unknown, expired, of another purpose, or of a suspended merchant, and answers 200 anyway', async () => {
    const { m, token } = await withLink();
    expect((await send(message(1, '/start ' + 'A'.repeat(43)))).statusCode).toBe(200);
    clock.advance(16 * MINUTE);
    expect((await send(message(7001, `/start ${token}`))).statusCode).toBe(200);
    expect((await clientRow(m.clientId)).telegramChatId).toBeNull();

    clock.set('2026-11-01T10:00:00.000Z');
    const { m: suspended, token: suspendedToken } = await withLink();
    await db.update(s.clients).set({ status: 'suspended' }).where(eq(s.clients.id, suspended.clientId));
    expect((await send(message(7002, `/start ${suspendedToken}`))).statusCode).toBe(200);
    expect((await clientRow(suspended.clientId)).telegramChatId).toBeNull();

    // A reset-password token is not a link token.
    const other = await signedIn();
    await db.insert(s.authTokens).values({
      purpose: 'reset',
      subjectType: 'client',
      subjectId: other.clientId,
      tokenHash: t.app.get(TokenService).hash('R'.repeat(43)),
      expiresAt: new Date(clock.nowMs() + 15 * MINUTE),
    });
    expect((await send(message(7003, '/start ' + 'R'.repeat(43)))).statusCode).toBe(200);
    expect((await clientRow(other.clientId)).telegramChatId).toBeNull();
    expect(await notificationRows(db)).toEqual([]);
  });

  it('ignores everything that is not a command in a private chat', async () => {
    const { m, token } = await withLink();
    for (const body of [
      message(7001, `/start ${token}`, { type: 'group' }),
      message(7001, `/start ${token}`, { type: 'supergroup' }),
      message(7001, 'hello'),
      message(7001, '/start'),
      message(7001, `/begin ${token}`),
      message('not-a-number', `/start ${token}`),
      { update_id: 1, edited_message: { chat: { id: 7001, type: 'private' }, text: `/start ${token}` } },
      { update_id: 2, message: { chat: { id: 7001, type: 'private' } } },
      { update_id: 3 },
      {},
    ]) {
      expect((await send(body)).statusCode, JSON.stringify(body)).toBe(200);
    }
    expect((await clientRow(m.clientId)).telegramChatId).toBeNull();
    expect(await notificationRows(db)).toEqual([]);
  });

  it('moves a chat that another merchant had linked, and turns the first merchant’s Telegram events off', async () => {
    const first = await signedIn({
      telegramChatId: '7001',
      notificationPrefs: { events: { 'wallet.low_balance': { email: true, telegram: true } } },
    });
    const { m: second, token } = await withLink();
    await send(message(7001, `/start ${token}`));
    expect((await clientRow(second.clientId)).telegramChatId).toBe('7001');
    const after = await clientRow(first.clientId);
    expect(after.telegramChatId).toBeNull();
    expect(after.notificationPrefs).toMatchObject({
      events: { 'wallet.low_balance': { email: true, telegram: false } },
    });
  });

  it('unlinks the chat on /stop, turns the Telegram events off, and the bot says so to that chat', async () => {
    const m = await signedIn({
      name: 'Zain Mobile Hub',
      telegramChatId: '7001',
      notificationPrefs: {
        lowBalanceThreshold: '50.0000',
        events: { 'wallet.low_balance': { email: true, telegram: true } },
      },
    });
    expect((await send(message(7001, '/stop', { id: 8001 }))).statusCode).toBe(200);
    const after = await clientRow(m.clientId);
    expect(after.telegramChatId).toBeNull();
    expect(after.notificationPrefs).toMatchObject({
      lowBalanceThreshold: '50.0000',
      events: { 'wallet.low_balance': { email: true, telegram: false } },
    });
    await sendAllQueued(t);
    expect(telegramOutbox(t).sent).toEqual([
      {
        chatId: '7001',
        text: 'Telegram notifications for Zain Mobile Hub are off. Create a new link in the portal to connect this chat again.',
      },
    ]);
    // A repeat, and a chat nobody linked, change nothing.
    await send(message(7001, '/stop', { id: 8001 }));
    await send(message(555, '/stop'));
    expect(await notificationRows(db)).toHaveLength(1);
  });

  it('delivers Telegram alerts to the linked chat once the merchant switched them on, and stops after /stop', async () => {
    const { m, token } = await withLink();
    await send(message(7001, `/start ${token}`));
    await sendAllQueued(t);
    telegramOutbox(t).reset();
    expect(
      (
        await m.call('PUT', '/client/notification-preferences', {
          events: [{ event: 'wallet.low_balance', email: false, telegram: true }],
        })
      ).status,
    ).toBe(200);
    const job = await emitEvent(t, 'wallet.low_balance', 'ledger_accounts', 1, {
      clientId: m.clientId,
      currency: 'USD',
      available: '10.0000',
      threshold: '50.0000',
    });
    expect(await planEvent(t, job)).toEqual({ created: 1 });
    await sendAllQueued(t);
    expect(telegramOutbox(t).sent).toEqual([
      { chatId: '7001', text: 'Low balance: 10.00 USD available (your alert level is 50.00 USD).' },
    ]);

    await send(message(7001, '/stop'));
    const again = await emitEvent(t, 'wallet.low_balance', 'ledger_accounts', 1, {
      clientId: m.clientId,
      currency: 'USD',
      available: '9.0000',
      threshold: '50.0000',
    });
    expect(await planEvent(t, again)).toEqual({ created: 0, skipped: 'opted_out' });
  });
});

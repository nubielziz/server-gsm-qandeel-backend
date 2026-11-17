// Integration tests of the campaign branch of the delivery and the bulk sender (feature 23, slice B, plan sections 8.2 and 9.1): the
// text and HTML part of an email (English, left to right), the link per audience, Telegram for a merchant with a chat, the
// send-time re-check (consent withdrawn, a merchant's switch turned off, a suspended person), the per-channel budget and a short
// Telegram "retry after" waited for inside the attempt.
import { afterAll, beforeAll, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import { eq } from 'drizzle-orm';
import { type Database, schema as s } from '../../src/infra/db';
import { QueuesService } from '../../src/infra/queues';
import { RateLimitService } from '../../src/infra/rate-limit';
import { RedisService } from '../../src/infra/redis';
import {
  BROADCAST_QUEUE,
  BroadcastBudget,
  DeliveryError,
  MAX_BUDGET_WAITS,
  SettingsReader,
} from '../../src/modules/platform';
import { type AdminApi, adminWith } from '../support/admin-api';
import { type TestApp, createTestApp } from '../support/app';
import { clearIdentityCaches, insertMerchant } from '../support/auth';
import {
  campaignMessages,
  createDraft,
  fanOutAll,
  fanOutWith,
  insertCustomer,
  sendBroadcast,
  sendNow,
  setMarketingConsent,
} from '../support/campaigns';
import { TestClock } from '../support/clock';
import { closeTestDb, resetDb, testDb } from '../support/db';
import { mailbox, telegramOutbox } from '../support/notifications';
import { deleteBullKeys, testBullPrefix } from '../support/queues';
import { expectRejection } from '../support/rejection';

const prefix = testBullPrefix();
const clock = new TestClock('2026-11-10T09:00:00.000Z');
let t: TestApp;
let owner: AdminApi;
let db: Database;

const allowed = { allowed: true, remaining: 1, limit: 30, retryAfterSeconds: 0, resetSeconds: 1 };
const refused = { allowed: false, remaining: 0, limit: 30, retryAfterSeconds: 2, resetSeconds: 2 };

/** Sends a campaign, fans it out, and returns its rows. */
async function fannedOut(changes: Record<string, unknown>) {
  const draft = await createDraft(owner, changes);
  const res = await sendNow(owner, draft.id);
  if (res.status !== 202) throw new Error(`send answered ${res.status}: ${JSON.stringify(res.body)}`);
  await fanOutAll(t, draft.id);
  return { id: draft.id as number, rows: await campaignMessages(db, draft.id) };
}

beforeAll(async () => {
  t = await createTestApp({
    clock,
    env: { BULL_PREFIX: prefix, TELEGRAM_BOT_TOKEN: '1234567890:AAtest-token', TELEGRAM_BOT_USERNAME: 'gsm_test_bot' },
  });
  db = (await testDb()).db;
});
beforeEach(async () => {
  clock.set('2026-11-10T09:00:00.000Z');
  await resetDb();
  await clearIdentityCaches(t);
  await t.app.get(QueuesService).queue(BROADCAST_QUEUE).obliterate({ force: true });
  await t.app.get(RedisService).cache.flushdb();
  // The highest rate keeps the real budget out of the way of the tests that do not look at it.
  await db.insert(s.settings).values([
    { key: 'notifications.broadcast_email_per_second', value: 30 },
    { key: 'notifications.broadcast_telegram_per_second', value: 30 },
  ]);
  await t.app.get(SettingsReader).invalidate();
  mailbox(t).reset();
  telegramOutbox(t).sent.length = 0;
  fanOutWith(t, { chunkSize: 500, timeBudgetMs: 60_000, highWater: 20_000 });
  owner = await adminWith(t, ['*'], { name: 'Rami K.' });
});
afterAll(async () => {
  await resetDb();
  await clearIdentityCaches(t);
  await deleteBullKeys(t.app.get(RedisService).queue, prefix);
  await t.close();
  await closeTestDb();
});

describe('the campaign branch of the delivery', () => {
  it('sends the campaign in English with a left-to-right part to every customer, with the store link', async () => {
    const sam = await insertCustomer(db, { name: 'Sam', email: 'sam@mail.example' });
    const huda = await insertCustomer(db, { name: 'Huda', email: 'huda@mail.example' });
    const { rows } = await fannedOut({ channels: ['email'], audience: { customers: {} } });
    for (const row of rows) expect(await sendBroadcast(t, row.id, 'email')).toEqual({ outcome: 'sent' });
    const sent = mailbox(t).sent;
    const toSam = sent.find((mail) => mail.to === 'sam@mail.example')!;
    const toHuda = sent.find((mail) => mail.to === 'huda@mail.example')!;
    expect(toSam).toMatchObject({ subject: 'Maintenance for Sam' });
    expect(toSam.text).toBe('The portal is read-only on Friday.\n\nhttp://localhost:5175/account/orders');
    expect(toSam.html).toStartWith('<div dir="ltr" lang="en">');
    expect(toSam.messageId).toMatch(new RegExp(`^<notification-${rows.find((r) => r.recipientId === sam)!.id}@`));
    expect(toHuda).toMatchObject({ subject: 'Maintenance for Huda' });
    expect(toHuda.html).toStartWith('<div dir="ltr" lang="en">');
    expect(toHuda.headers).toBeUndefined();
    expect((await campaignMessages(db, rows[0]!.campaignId!)).every((row) => row.status === 'sent')).toBe(true);
    expect(rows.find((row) => row.recipientId === huda)).toBeDefined();
  });

  it('sends Telegram to a merchant with a chat, with the site link, and an email to staff without a link', async () => {
    await insertMerchant(db, { telegramChatId: '555', name: 'Zain Mobile Hub' });
    const { rows } = await fannedOut({
      channels: ['email', 'telegram'],
      audience: { staff: {}, merchants: {} },
    });
    const telegram = rows.find((row) => row.channel === 'telegram')!;
    expect(await sendBroadcast(t, telegram.id, 'telegram')).toEqual({ outcome: 'sent' });
    expect(telegramOutbox(t).sent).toEqual([
      {
        chatId: '555',
        // The site path joins the site's root once (PORTAL_BASE_URL already ends at /merchant in production).
        text: 'Maintenance for Zain Mobile Hub\n\nThe portal is read-only on Friday.\nhttp://localhost:5175/merchant/wallet',
      },
    ]);
    const staff = rows.find((row) => row.recipientType === 'staff')!;
    await sendBroadcast(t, staff.id, 'email');
    expect(mailbox(t).sent.at(-1)?.text).toBe('The portal is read-only on Friday.');
  });

  it("ends a merchant's marketing email with the site's notification settings page, under /merchant once", async () => {
    await insertMerchant(db, { name: 'Zain Mobile Hub' });
    const { rows } = await fannedOut({ purpose: 'marketing', channels: ['email'], audience: { merchants: {} } });
    expect(await sendBroadcast(t, rows[0]!.id, 'email')).toEqual({ outcome: 'sent' });
    expect(mailbox(t).sent.at(-1)?.text).toEndWith(
      'Manage notifications: http://localhost:5175/merchant/settings/notifications',
    );
  });

  it('re-checks consent at send time: a customer who withdrew after the fan-out gets nothing', async () => {
    const customer = await insertCustomer(db);
    await setMarketingConsent(db, customer, true);
    const { rows } = await fannedOut({ purpose: 'marketing', channels: ['email'], audience: { customers: {} } });
    expect(rows).toHaveLength(1);
    await setMarketingConsent(db, customer, false);
    expect(await sendBroadcast(t, rows[0]!.id, 'email')).toEqual({
      outcome: 'failed',
      reason: 'The recipient is no longer eligible.',
    });
    expect(mailbox(t).sent).toHaveLength(0);
  });

  it('re-checks the merchant switch at send time, and a merchant suspended since the fan-out', async () => {
    const off = await insertMerchant(db, { telegramChatId: '777' });
    const suspended = await insertMerchant(db);
    const { rows } = await fannedOut({ channels: ['email', 'telegram'], audience: { merchants: {} } });
    await db
      .update(s.clients)
      .set({ notificationPrefs: { events: { 'broadcast.announcement': { telegram: false } } } })
      .where(eq(s.clients.id, off));
    await db.update(s.clients).set({ status: 'suspended' }).where(eq(s.clients.id, suspended));
    const telegram = rows.find((row) => row.channel === 'telegram')!;
    expect(await sendBroadcast(t, telegram.id, 'telegram')).toEqual({
      outcome: 'failed',
      reason: 'The recipient turned this message off.',
    });
    const toSuspended = rows.find((row) => row.recipientId === suspended)!;
    expect(await sendBroadcast(t, toSuspended.id, 'email')).toEqual({
      outcome: 'failed',
      reason: 'The recipient is no longer eligible.',
    });
    const toOff = rows.find((row) => row.recipientId === off && row.channel === 'email')!;
    expect(await sendBroadcast(t, toOff.id, 'email')).toEqual({ outcome: 'sent' });
  });

  it('sends once when the job runs twice, and retries a transient failure through the queue', async () => {
    await insertCustomer(db);
    const { rows } = await fannedOut({ channels: ['email'], audience: { customers: {} } });
    const id = rows[0]!.id;
    mailbox(t).failNext(new DeliveryError('The mail server is busy.'));
    await expectRejection(sendBroadcast(t, id, 'email'), 'The mail server is busy.');
    expect(await sendBroadcast(t, id, 'email', 1)).toEqual({ outcome: 'sent' });
    expect(await sendBroadcast(t, id, 'email', 2)).toEqual({ outcome: 'skipped', reason: 'already_sent' });
    expect(mailbox(t).sent).toHaveLength(1);
    expect((await campaignMessages(db, rows[0]!.campaignId!))[0]).toMatchObject({ status: 'sent', attempts: 2 });
  });

  it('waits once for a short Telegram "retry after" inside the same attempt', async () => {
    await insertMerchant(db, { telegramChatId: '555' });
    const { rows } = await fannedOut({ channels: ['telegram'], audience: { merchants: {} } });
    const budget = t.app.get(BroadcastBudget);
    const wait = spyOn(budget, 'wait').mockResolvedValue(undefined);
    telegramOutbox(t).failNext(new DeliveryError('Too many requests.', { retryAfterSeconds: 3 }));
    try {
      expect(await sendBroadcast(t, rows[0]!.id, 'telegram')).toEqual({ outcome: 'sent' });
      expect(wait.mock.calls).toEqual([[3000]]);
      expect(telegramOutbox(t).sent).toHaveLength(1);
    } finally {
      wait.mockRestore();
    }
  });
});

describe('the per-channel budget', () => {
  it('waits while the budget is used up, then sends', async () => {
    await insertCustomer(db);
    const { rows } = await fannedOut({ channels: ['email'], audience: { customers: {} } });
    const budget = t.app.get(BroadcastBudget);
    const limits = t.app.get(RateLimitService);
    const consume = spyOn(limits, 'consume')
      .mockResolvedValueOnce(refused)
      .mockResolvedValueOnce(refused)
      .mockResolvedValueOnce(allowed);
    const wait = spyOn(budget, 'wait').mockResolvedValue(undefined);
    try {
      expect(await sendBroadcast(t, rows[0]!.id, 'email')).toEqual({ outcome: 'sent' });
      expect(wait.mock.calls).toEqual([[2000], [2000]]);
      expect(consume.mock.calls[0]).toEqual(['broadcast-email', 'all', 1, { limit: 30 }]);
    } finally {
      consume.mockRestore();
      wait.mockRestore();
    }
  });

  it('reads its size from the setting, and gives up after the most waits with a transient error the queue retries', async () => {
    await db.update(s.settings).set({ value: 7 }).where(eq(s.settings.key, 'notifications.broadcast_email_per_second'));
    await t.app.get(SettingsReader).invalidate();
    const budget = t.app.get(BroadcastBudget);
    const consume = spyOn(t.app.get(RateLimitService), 'consume').mockResolvedValue(refused);
    const wait = spyOn(budget, 'wait').mockResolvedValue(undefined);
    try {
      await expectRejection(budget.take('email'), 'budget');
      expect(wait).toHaveBeenCalledTimes(MAX_BUDGET_WAITS);
      expect(consume.mock.calls[0]?.[3]).toEqual({ limit: 7 });
    } finally {
      consume.mockRestore();
      wait.mockRestore();
    }
  });

  it('takes no budget for a row that can no longer be sent (a cancelled campaign)', async () => {
    await insertCustomer(db);
    const { id, rows } = await fannedOut({ channels: ['email'], audience: { customers: {} } });
    await db.update(s.notificationCampaigns).set({ status: 'cancelled' }).where(eq(s.notificationCampaigns.id, id));
    const take = spyOn(t.app.get(BroadcastBudget), 'take');
    try {
      expect(await sendBroadcast(t, rows[0]!.id, 'email')).toMatchObject({ outcome: 'failed' });
      expect(take).not.toHaveBeenCalled();
    } finally {
      take.mockRestore();
    }
  });

  it('uses the real limiter: one point per message on the system-wide key', async () => {
    const limits = t.app.get(RateLimitService);
    for (let i = 0; i < 3; i += 1)
      expect((await limits.consume('broadcast-email', 'all', 1, { limit: 3 })).allowed).toBe(true);
    expect((await limits.consume('broadcast-email', 'all', 1, { limit: 3 })).allowed).toBe(false);
  });
});

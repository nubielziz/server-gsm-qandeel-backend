// Integration tests of the campaign fan-out (feature 23, slice B, plan section 8.1): a 7-person campaign with chunks of 3 ends `sent`
// with the right in-app items, queued rows, counters and send jobs; a second run and two parallel runs make nothing twice; a crash
// mid-way resumes at the cursor; a cancel between chunks stops it; the time budget hands over to a continuation; backpressure pauses
// it; a stored audience that no longer parses fails the campaign. Also the recipients route (route 12) over the result.
import { afterAll, beforeAll, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import { eq } from 'drizzle-orm';
import { type Database, schema as s } from '../../src/infra/db';
import { QueuesService, UnrecoverableError } from '../../src/infra/queues';
import { RedisService } from '../../src/infra/redis';
import { BROADCAST_QUEUE, CampaignFanOutProcessor, NotificationAudiences } from '../../src/modules/platform';
import { type AdminApi, adminWith } from '../support/admin-api';
import { type TestApp, createTestApp } from '../support/app';
import { clearIdentityCaches, insertMerchant, insertStaff } from '../support/auth';
import {
  campaignItems,
  campaignMessages,
  campaignRow,
  createDraft,
  fanOutAll,
  fanOutWith,
  insertCustomer,
  jobLike,
  sendBroadcast,
  sendNow,
} from '../support/campaigns';
import { TestClock } from '../support/clock';
import { closeTestDb, resetDb, testDb } from '../support/db';
import { expectRejection } from '../support/rejection';
import { deleteBullKeys, testBullPrefix } from '../support/queues';

const prefix = testBullPrefix();
const clock = new TestClock('2026-11-10T09:00:00.000Z');
let t: TestApp;
let owner: AdminApi;
let db: Database;

/** Everyone, on every channel: 2 staff, 2 merchants (one with a chat), 3 customers with an account (one Arabic), 1 guest left out. */
const EVERYONE = {
  channels: ['in_app', 'email', 'telegram'],
  audience: { staff: {}, merchants: {}, customers: { hasAccount: true } },
};
const PACE = { chunkSize: 3, timeBudgetMs: 60_000, highWater: 20_000, waitMs: 15_000 };

async function broadcastJobs() {
  return t.app.get(QueuesService).queue(BROADCAST_QUEUE).getJobs(['waiting', 'delayed', 'prioritized', 'active']);
}
async function fanOutJobs() {
  const jobs = await t.app.get(QueuesService).queue('notifications').getJobs(['waiting', 'delayed']);
  return jobs.filter((job) => job.name === 'notification.campaign_fanout');
}

/** A sent (queued) campaign to everyone. */
async function queuedCampaign(changes: Record<string, unknown> = {}): Promise<number> {
  const draft = await createDraft(owner, { ...EVERYONE, ...changes });
  const res = await sendNow(owner, draft.id);
  expect(res.status).toBe(202);
  return draft.id;
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
  for (const name of [BROADCAST_QUEUE, 'notifications'] as const) {
    await t.app.get(QueuesService).queue(name).obliterate({ force: true });
  }
  fanOutWith(t, PACE);
  owner = await adminWith(t, ['*'], { name: 'Rami K.' });
  await insertStaff(db, owner.roleId);
  await insertMerchant(db, { telegramChatId: '555' });
  await insertMerchant(db);
  await insertCustomer(db);
  await insertCustomer(db, { locale: 'ar' });
  await insertCustomer(db);
  await insertCustomer(db, { hasAccount: false });
});
afterAll(async () => {
  await resetDb();
  await clearIdentityCaches(t);
  await deleteBullKeys(t.app.get(RedisService).queue, prefix);
  await t.close();
  await closeTestDb();
});

describe('the fan-out', () => {
  it('ends sent with one in-app item per person, the email and Telegram rows, the counters and one send job per row', async () => {
    const id = await queuedCampaign();
    const results = await fanOutAll(t, id);
    expect(results).toEqual([{ chunks: 4, rows: 8, outcome: 'sent' }]);

    const row = await campaignRow(db, id);
    expect(row).toMatchObject({
      status: 'sent',
      recipients: 7,
      chunksDone: 4,
      fanoutCursor: null,
      startedAt: clock.now(),
      finishedAt: clock.now(),
      stats: { planned: { inApp: 7, email: 7, telegram: 1 }, skipped: { optedOut: 0, noTelegram: 6, noAccount: 0 } },
    });
    const items = await campaignItems(db, id);
    expect(items).toHaveLength(7);
    expect(items.every((item) => item.category === 'announcement' && item.event === null)).toBe(true);
    expect(items.map((item) => item.recipientType)).toEqual([
      'staff',
      'staff',
      'client',
      'client',
      'customer',
      'customer',
      'customer',
    ]);
    const messages = await campaignMessages(db, id);
    expect(messages.map((m) => m.channel).sort()).toEqual([...Array(7).fill('email'), 'telegram'].sort());
    expect(messages.every((m) => m.status === 'queued' && m.event === 'broadcast.announcement')).toBe(true);
    expect(messages[0]?.dedupeKey).toBe(`campaign-${id}:email:staff-${owner.staffId}`);

    const jobs = await broadcastJobs();
    expect(jobs.map((job) => job.id).sort()).toEqual(messages.map((m) => `notification-${m.id}`).sort());
    const telegram = messages.find((m) => m.channel === 'telegram')!;
    expect(jobs.find((job) => job.id === `notification-${telegram.id}`)?.data).toMatchObject({
      notificationId: telegram.id,
      channel: 'telegram',
    });

    // The detail shows the live numbers.
    const detail = await owner.get(`/admin/notification-campaigns/${id}`);
    expect(detail.body).toMatchObject({
      status: 'sent',
      recipients: 7,
      planned: { inApp: 7, email: 7, telegram: 1 },
      skipped: { noTelegram: 6 },
      delivery: { inApp: { delivered: 7, read: 0 }, email: { queued: 7 }, telegram: { queued: 1 } },
    });
  });

  it('runs from the relay job (aggregateId) through the processor, and a second run changes nothing', async () => {
    const id = await queuedCampaign();
    const [event] = await db
      .select()
      .from(s.outboxEvents)
      .where(eq(s.outboxEvents.type, 'notification.campaign_fanout'));
    const processor = t.app.get(CampaignFanOutProcessor);
    expect(await processor.process(jobLike({ eventId: event!.id, aggregateId: id }))).toMatchObject({
      outcome: 'sent',
    });
    const before = {
      items: await campaignItems(db, id),
      messages: await campaignMessages(db, id),
      row: await campaignRow(db, id),
    };
    expect(await processor.process(jobLike({ campaignId: id }))).toEqual({ chunks: 0, rows: 0, outcome: 'stopped' });
    expect(await campaignItems(db, id)).toEqual(before.items);
    expect(await campaignMessages(db, id)).toEqual(before.messages);
    expect(await campaignRow(db, id)).toEqual(before.row);
    await expectRejection(processor.process(jobLike({})), 'names no campaign');
  });

  it('makes every row once when two fan-out jobs of one campaign run in parallel', async () => {
    fanOutWith(t, { timeBudgetMs: 0 });
    const id = await queuedCampaign();
    for (let round = 0; round < 10; round += 1) {
      const results = await Promise.all([
        t.app.get(CampaignFanOutProcessor).process(jobLike({ campaignId: id })),
        t.app.get(CampaignFanOutProcessor).process(jobLike({ campaignId: id })),
      ]);
      if (results.every((result) => result.outcome === 'stopped' || result.outcome === 'sent')) break;
    }
    expect((await campaignRow(db, id)).status).toBe('sent');
    expect(await campaignItems(db, id)).toHaveLength(7);
    expect(await campaignMessages(db, id)).toHaveLength(8);
    expect((await campaignRow(db, id)).recipients).toBe(7);
  });

  it('resumes at the cursor after a crash between chunks', async () => {
    const id = await queuedCampaign();
    const merchants = t.app.get(NotificationAudiences).get('client');
    const crash = spyOn(merchants, 'page').mockRejectedValueOnce(new Error('connection reset'));
    await expectRejection(t.app.get(CampaignFanOutProcessor).process(jobLike({ campaignId: id })), 'connection reset');
    crash.mockRestore();
    // The staff chunk committed; the merchant chunk rolled back.
    expect(await campaignRow(db, id)).toMatchObject({
      status: 'sending',
      chunksDone: 1,
      recipients: 2,
      fanoutCursor: { type: 'client', afterId: 0 },
    });
    expect(await campaignItems(db, id)).toHaveLength(2);
    expect(await fanOutAll(t, id)).toEqual([{ chunks: 3, rows: 6, outcome: 'sent' }]);
    expect(await campaignItems(db, id)).toHaveLength(7);
    expect(await campaignMessages(db, id)).toHaveLength(8);
    expect(await campaignRow(db, id)).toMatchObject({ recipients: 7, chunksDone: 4 });
  });

  it('hands over to a continuation job after its time budget', async () => {
    fanOutWith(t, { timeBudgetMs: 0 });
    const id = await queuedCampaign();
    expect(await t.app.get(CampaignFanOutProcessor).process(jobLike({ campaignId: id }))).toEqual({
      chunks: 1,
      rows: 2,
      outcome: 'continued',
    });
    const jobs = await fanOutJobs();
    expect(jobs.map((job) => [job.id, job.data])).toEqual([[`campaign-fanout-${id}-1`, { campaignId: id, round: 0 }]]);
    expect(await fanOutAll(t, id)).toHaveLength(3);
    expect((await campaignRow(db, id)).status).toBe('sent');
  });

  it('pauses with a delayed continuation while the bulk queue is above the high-water mark', async () => {
    fanOutWith(t, { highWater: -1 });
    const id = await queuedCampaign();
    expect(await t.app.get(CampaignFanOutProcessor).process(jobLike({ campaignId: id, round: 2 }))).toEqual({
      chunks: 0,
      rows: 0,
      outcome: 'paused',
    });
    const [job] = await fanOutJobs();
    expect(job?.id).toBe(`campaign-fanout-${id}-0-w3`);
    expect(job?.opts.delay).toBe(15_000);
    expect(job?.data).toEqual({ campaignId: id, round: 3 });
    expect(await campaignItems(db, id)).toHaveLength(0);
  });

  it('stops at the next chunk after a cancel, and the queued rows of the cancelled campaign fail with the reason', async () => {
    fanOutWith(t, { timeBudgetMs: 0 });
    const id = await queuedCampaign();
    await t.app.get(CampaignFanOutProcessor).process(jobLike({ campaignId: id }));
    expect((await owner.post(`/admin/notification-campaigns/${id}/cancel`)).status).toBe(200);
    expect(await t.app.get(CampaignFanOutProcessor).process(jobLike({ campaignId: id }))).toEqual({
      chunks: 0,
      rows: 0,
      outcome: 'stopped',
    });
    expect(await campaignItems(db, id)).toHaveLength(2);
    const [message] = await campaignMessages(db, id);
    expect(await sendBroadcast(t, message!.id, 'email')).toEqual({
      outcome: 'failed',
      reason: 'The campaign was cancelled.',
    });
    expect((await campaignMessages(db, id))[0]).toMatchObject({
      status: 'failed',
      error: 'The campaign was cancelled.',
    });
  });

  it('fails the campaign for good when its stored audience no longer parses', async () => {
    const id = await queuedCampaign();
    await db
      .update(s.notificationCampaigns)
      .set({ audience: { everyone: true } })
      .where(eq(s.notificationCampaigns.id, id));
    const failure = await t.app
      .get(CampaignFanOutProcessor)
      .process(jobLike({ campaignId: id }))
      .then(
        () => undefined,
        (error: unknown) => error,
      );
    expect(failure).toBeInstanceOf(UnrecoverableError);
    expect(await campaignRow(db, id)).toMatchObject({
      status: 'failed',
      error: 'The stored audience is no longer valid.',
    });
  });

  it('counts skips: a guest has no inbox, a merchant who switched announcements off gets no email', async () => {
    await insertMerchant(db, { notificationPrefs: { events: { 'broadcast.announcement': { email: false } } } });
    const id = await queuedCampaign({ audience: { merchants: {}, customers: {} } });
    await fanOutAll(t, id);
    expect((await campaignRow(db, id)).stats).toEqual({
      planned: { inApp: 6, email: 6, telegram: 1 },
      skipped: { optedOut: 1, noTelegram: 6, noAccount: 1 },
    });
  });
});

describe('GET /admin/notification-campaigns/:id/recipients', () => {
  it('lists the in-app recipients with read state, and the email rows with status and masked addresses, paged', async () => {
    const id = await queuedCampaign();
    await fanOutAll(t, id);
    const [first] = await campaignItems(db, id);
    await db.update(s.notificationInbox).set({ readAt: clock.now() }).where(eq(s.notificationInbox.id, first!.id));

    const inApp = await owner.get(`/admin/notification-campaigns/${id}/recipients?channel=in_app`);
    expect(inApp.status).toBe(200);
    expect(inApp.total).toBe(7);
    expect(inApp.body[0]).toMatchObject({
      channel: 'in_app',
      recipientType: 'staff',
      recipientId: owner.staffId,
      status: 'read',
      readAt: clock.now().toISOString(),
      sentAt: null,
    });
    expect(inApp.body[0].recipient).toContain('*');
    expect(JSON.stringify(inApp.body)).not.toMatch(/staff-[0-9a-f-]{36}@/);

    const read = await owner.get(`/admin/notification-campaigns/${id}/recipients?channel=in_app&status=delivered`);
    expect(read.total).toBe(6);

    const [message] = await campaignMessages(db, id);
    await sendBroadcast(t, message!.id, 'email');
    const sent = await owner.get(`/admin/notification-campaigns/${id}/recipients?channel=email&status=sent`);
    expect(sent.total).toBe(1);
    expect(sent.body[0]).toMatchObject({ id: message!.id, status: 'sent', attempts: 1, error: null });
    const page = await owner.get(
      `/admin/notification-campaigns/${id}/recipients?channel=email&_start=2&_end=4&_sort=id&_order=desc`,
    );
    expect(page.total).toBe(7);
    expect(page.body).toHaveLength(2);
    const telegram = await owner.get(`/admin/notification-campaigns/${id}/recipients?channel=telegram`);
    expect(telegram.body[0].recipient).not.toBe('555');
  });

  it('needs the channel, and answers 404 for an unknown campaign', async () => {
    const id = await queuedCampaign();
    expect((await owner.get(`/admin/notification-campaigns/${id}/recipients`)).status).toBe(422);
    expect((await owner.get('/admin/notification-campaigns/999999/recipients?channel=email')).status).toBe(404);
  });
});

// Integration tests of the notification retention (feature 23, plan section 8.4, owner decision O6): the daily job deletes inbox items read
// longer ago than the read retention, every item older than the inbox retention, and sent or failed log rows older than the log retention,
// by the three settings, in batches, and never a queued row; every run is recorded in `job_runs`.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { eq } from 'drizzle-orm';
import { type Database, schema as s } from '@src/infra/db';
import { JobSchedulerRegistry } from '@src/infra/queues';
import { RedisService } from '@src/infra/redis';
import {
  INBOX_READ_RETENTION_DAYS_KEY,
  LOG_RETENTION_DAYS_KEY,
  NOTIFICATION_RETENTION_JOB,
  NotificationRetentionProcessor,
  SettingsReader,
} from '@src/modules/platform';
import { type AdminApi, adminWith } from '../../support/admin-api';
import { type TestApp, createTestApp } from '../../support/app';
import { clearIdentityCaches } from '../../support/auth';
import { insertCustomer, jobLike } from '../../support/campaigns';
import { DAY, TestClock } from '../../support/clock';
import { closeTestDb, resetDb, testDb } from '../../support/db';
import { deleteBullKeys, testBullPrefix } from '../../support/queues';

const prefix = testBullPrefix();
const clock = new TestClock('2026-01-01T04:20:00.000Z');
let t: TestApp;
let db: Database;
let owner: AdminApi;
let personId: number;

const run = (runId?: number) =>
  t.app.get(NotificationRetentionProcessor).process(jobLike(runId === undefined ? {} : { runId }));
const inboxIds = async () =>
  (await db.select({ id: s.notificationInbox.id }).from(s.notificationInbox)).map((row) => row.id);
const logIds = async () => (await db.select({ id: s.notifications.id }).from(s.notifications)).map((row) => row.id);

async function item(values: Partial<typeof s.notificationInbox.$inferInsert> = {}): Promise<number> {
  const [row] = await db
    .insert(s.notificationInbox)
    .values({
      recipientType: 'customer',
      recipientId: personId,
      event: 'order.completed',
      category: 'order',
      variables: {},
      createdAt: clock.now(),
      updatedAt: clock.now(),
      ...values,
    })
    .returning({ id: s.notificationInbox.id });
  return row!.id;
}
async function logRow(status: 'queued' | 'sent' | 'failed'): Promise<number> {
  const [row] = await db
    .insert(s.notifications)
    .values({
      recipientType: 'customer',
      recipientId: personId,
      channel: 'email',
      event: 'order.completed',
      status,
      createdAt: clock.now(),
      updatedAt: clock.now(),
    })
    .returning({ id: s.notifications.id });
  return row!.id;
}

beforeAll(async () => {
  db = (await testDb()).db;
  t = await createTestApp({ clock, env: { BULL_PREFIX: prefix } });
});
beforeEach(async () => {
  clock.set('2026-01-01T04:20:00.000Z');
  await resetDb();
  await clearIdentityCaches(t);
  await t.app.get(SettingsReader).invalidate();
  owner = await adminWith(t, ['*']);
  personId = await insertCustomer(db);
});
afterAll(async () => {
  await resetDb();
  await clearIdentityCaches(t);
  await deleteBullKeys(t.app.get(RedisService).queue, prefix);
  await t.close();
  await closeTestDb();
});

describe('the retention job', () => {
  it('is registered daily at 04:20 UTC on the maintenance queue', () => {
    const entry = t.app
      .get(JobSchedulerRegistry)
      .list()
      .find((scheduler) => scheduler.id === 'notification-retention');
    expect(entry).toMatchObject({ queue: 'maintenance', jobName: NOTIFICATION_RETENTION_JOB, pattern: '20 4 * * *' });
  });

  it('deletes read items after 90 days and all items after 365 days by default, keeping what is younger', async () => {
    const readOld = await item({ readAt: clock.now() });
    const unreadOld = await item();
    clock.advance(80 * DAY);
    const readRecent = await item({ readAt: clock.now() });
    const unreadRecent = await item();
    clock.advance(11 * DAY);
    expect(await run()).toEqual({ inboxRead: 1, inboxOld: 0, log: 0 });
    expect((await inboxIds()).sort()).toEqual([unreadOld, readRecent, unreadRecent].sort());
    expect(await inboxIds()).not.toContain(readOld);

    clock.advance(275 * DAY);
    expect(await run()).toEqual({ inboxRead: 1, inboxOld: 1, log: 0 });
    expect(await inboxIds()).toEqual([unreadRecent]);
  });

  it('deletes sent and failed log rows after 180 days and never a queued one', async () => {
    const sent = await logRow('sent');
    const failed = await logRow('failed');
    const queued = await logRow('queued');
    clock.advance(179 * DAY);
    const young = await logRow('sent');
    expect((await run()).log).toBe(0);
    clock.advance(2 * DAY);
    expect((await run()).log).toBe(2);
    expect((await logIds()).sort()).toEqual([queued, young].sort());
    expect(await logIds()).not.toContain(sent);
    expect(await logIds()).not.toContain(failed);
  });

  it('follows the settings', async () => {
    const readItem = await item({ readAt: clock.now() });
    const logged = await logRow('sent');
    clock.advance(31 * DAY);
    expect(await run()).toEqual({ inboxRead: 0, inboxOld: 0, log: 0 });
    // The clock moved a month: sign in again (the first session has expired).
    owner = await adminWith(t, ['*']);
    const saved = await owner.patch('/admin/settings', {
      [INBOX_READ_RETENTION_DAYS_KEY]: 30,
      [LOG_RETENTION_DAYS_KEY]: 30,
    });
    expect(saved.status).toBe(200);
    expect(await run()).toEqual({ inboxRead: 1, inboxOld: 0, log: 1 });
    expect(await inboxIds()).not.toContain(readItem);
    expect(await logIds()).not.toContain(logged);
    // A value outside the bounds is refused by the route.
    expect((await owner.patch('/admin/settings', { [LOG_RETENTION_DAYS_KEY]: 7 })).status).toBe(422);
  });

  it('works through a backlog in batches of 1000', async () => {
    await db.insert(s.notificationInbox).values(
      Array.from({ length: 2500 }, () => ({
        recipientType: 'customer' as const,
        recipientId: personId,
        event: 'order.completed',
        category: 'order' as const,
        variables: {},
        readAt: clock.now(),
        createdAt: clock.now(),
        updatedAt: clock.now(),
      })),
    );
    clock.advance(91 * DAY);
    expect(await run()).toEqual({ inboxRead: 2500, inboxOld: 0, log: 0 });
    expect(await inboxIds()).toEqual([]);
  });

  it('records every run in job_runs with the counts, the schedule’s and a manual one', async () => {
    await item({ readAt: clock.now() });
    clock.advance(91 * DAY);
    await run();
    const [manual] = await db
      .insert(s.jobRuns)
      .values({ job: NOTIFICATION_RETENTION_JOB, trigger: 'manual', status: 'running', startedAt: clock.now() })
      .returning({ id: s.jobRuns.id });
    await run(manual!.id);
    const runs = await db
      .select()
      .from(s.jobRuns)
      .where(eq(s.jobRuns.job, NOTIFICATION_RETENTION_JOB))
      .orderBy(s.jobRuns.id);
    expect(runs).toHaveLength(2);
    expect(runs[0]).toMatchObject({ trigger: 'schedule', status: 'succeeded', processed: 1 });
    expect(runs[0]!.result).toEqual({ inboxRead: 1, inboxOld: 0, log: 0 });
    expect(runs[1]).toMatchObject({ id: manual!.id, trigger: 'manual', status: 'succeeded', processed: 0 });
  });
});

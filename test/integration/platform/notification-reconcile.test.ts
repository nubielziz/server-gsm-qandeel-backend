// Integration tests of the notification reconciler (feature 23, plan section 8.4): a queued campaign row, event row or digest row whose job
// was lost gets its job again, a live job is left alone, a `sendNow` row is never re-sent, a row older than 48 hours is failed, and a run that
// did something (and every manual run) is recorded in `job_runs`.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { eq } from 'drizzle-orm';
import { type Database, DbService, schema as s } from '@src/infra/db';
import { JobSchedulerRegistry, QueuesService } from '@src/infra/queues';
import { RedisService } from '@src/infra/redis';
import {
  NOTIFICATION_RECONCILE_JOB,
  NotificationReconcile,
  NotificationReconcileProcessor,
  OutboxService,
} from '@src/modules/platform';
import { type AdminApi, adminWith } from '../../support/admin-api';
import { type TestApp, createTestApp } from '../../support/app';
import { clearIdentityCaches, insertMerchant } from '../../support/auth';
import { createDraft, fanOutAll, fanOutWith, insertCustomer, jobLike, sendNow } from '../../support/campaigns';
import { HOUR, MINUTE, TestClock } from '../../support/clock';
import { closeTestDb, resetDb, testDb } from '../../support/db';
import { eventJob, mailbox, planEvent, seedDefaultTemplates } from '../../support/notifications';
import { deleteBullKeys, testBullPrefix } from '../../support/queues';

const prefix = testBullPrefix();
const clock = new TestClock('2026-11-10T09:00:00.000Z');
let t: TestApp;
let db: Database;
let owner: AdminApi;

const queue = (name: 'notifications' | 'notification-broadcasts') => t.app.get(QueuesService).queue(name);
const reconcile = () => t.app.get(NotificationReconcile).run();
const runs = () => db.select().from(s.jobRuns).where(eq(s.jobRuns.job, NOTIFICATION_RECONCILE_JOB));
const rowOf = async (id: number) => (await db.select().from(s.notifications).where(eq(s.notifications.id, id)))[0]!;

/** A queued row of the log made by hand, as `sendNow` or a digest makes it. */
async function insertRow(values: Partial<typeof s.notifications.$inferInsert> = {}): Promise<number> {
  const customerId = await insertCustomer(db);
  const [row] = await db
    .insert(s.notifications)
    .values({
      recipientType: 'account',
      recipientId: customerId,
      channel: 'email',
      event: 'order.completed',
      payload: { variables: { customerName: 'Dana', orderId: '1' } },
      status: 'queued',
      createdAt: clock.now(),
      updatedAt: clock.now(),
      ...values,
    })
    .returning({ id: s.notifications.id });
  return row!.id;
}

beforeAll(async () => {
  db = (await testDb()).db;
  t = await createTestApp({ clock, env: { BULL_PREFIX: prefix } });
});
beforeEach(async () => {
  clock.set('2026-11-10T09:00:00.000Z');
  await resetDb();
  await clearIdentityCaches(t);
  await deleteBullKeys(t.app.get(RedisService).queue, prefix);
  await seedDefaultTemplates(db);
  mailbox(t).reset();
  fanOutWith(t, { chunkSize: 500, timeBudgetMs: 60_000, highWater: 20_000 });
  owner = await adminWith(t, ['*']);
});
afterAll(async () => {
  await resetDb();
  await clearIdentityCaches(t);
  await deleteBullKeys(t.app.get(RedisService).queue, prefix);
  await t.close();
  await closeTestDb();
});

describe('the reconciler', () => {
  it('is registered every 5 minutes on the maintenance queue', () => {
    const entry = t.app
      .get(JobSchedulerRegistry)
      .list()
      .find((scheduler) => scheduler.id === 'notification-reconcile');
    expect(entry).toMatchObject({ queue: 'maintenance', jobName: NOTIFICATION_RECONCILE_JOB, pattern: '*/5 * * * *' });
  });

  it('adds the bulk job again for a campaign row whose job was lost, after 15 minutes, with ids only', async () => {
    await insertCustomer(db);
    await insertCustomer(db);
    const draft = await createDraft(owner, { channels: ['email'], audience: { customers: { hasAccount: true } } });
    expect((await sendNow(owner, draft.id)).status).toBe(202);
    await fanOutAll(t, draft.id);
    const rows = await db.select().from(s.notifications).where(eq(s.notifications.campaignId, draft.id));
    expect(rows).toHaveLength(2);
    // The queue Redis is lost: the rows stay queued with no job.
    await deleteBullKeys(t.app.get(RedisService).queue, prefix);
    expect(await queue('notification-broadcasts').getJob(`notification-${rows[0]!.id}`)).toBeUndefined();

    clock.advance(14 * MINUTE);
    expect(await reconcile()).toMatchObject({ campaignRows: 0 });
    clock.advance(2 * MINUTE);
    expect(await reconcile()).toMatchObject({ campaignRows: 2, eventRows: 0, digests: 0, expired: 0 });
    const job = await queue('notification-broadcasts').getJob(`notification-${rows[0]!.id}`);
    expect(job?.name).toBe('notification.send');
    expect(job?.data).toMatchObject({ notificationId: rows[0]!.id, channel: 'email' });
    // A second run finds the jobs there: nothing doubles.
    await reconcile();
    expect(await queue('notification-broadcasts').getJobCounts('waiting')).toEqual({ waiting: 2 });
  });

  it('adds the send job again for an event row whose relayed job is missing, and leaves a live job alone', async () => {
    const clientId = await insertMerchant(db, { email: 'ops@zainmobilehub.example' });
    const lost = eventJob('wallet.low_balance', 'ledger_accounts', 1, {
      accountId: clientId,
      currency: 'USD',
      available: '10.0000',
      threshold: '50.0000',
    });
    await planEvent(t, lost);
    const [row] = await db.select().from(s.notifications);
    const [event] = await db.select().from(s.outboxEvents).where(eq(s.outboxEvents.aggregateId, row!.id));
    // The relay handled the event (processed) but its job is gone.
    await db.update(s.outboxEvents).set({ processedAt: clock.now() }).where(eq(s.outboxEvents.id, event!.id));
    clock.advance(29 * MINUTE);
    expect((await reconcile()).eventRows).toBe(0);
    clock.advance(2 * MINUTE);
    expect((await reconcile()).eventRows).toBe(1);
    const job = await queue('notifications').getJob(`notification-${row!.id}`);
    expect(job?.name).toBe('notification.send');
    expect(job?.data).toEqual({ notificationId: row!.id });

    // The same row with a live relay job (waiting): left alone.
    await queue('notifications').remove(`notification-${row!.id}`);
    await t.app
      .get(QueuesService)
      .add('notifications', 'notification.send', { aggregateId: row!.id }, { jobId: `outbox-${event!.id}` });
    expect((await reconcile()).eventRows).toBe(0);
    expect(await queue('notifications').getJob(`notification-${row!.id}`)).toBeUndefined();
  });

  it('never re-sends a sendNow row (no outbox event, it holds a secret link) or a row whose event was not relayed yet', async () => {
    const sendNowRow = await insertRow();
    const unrelayed = await insertRow();
    await t.app
      .get(DbService)
      .runInTransaction(({ tx }) =>
        t.app
          .get(OutboxService)
          .add(tx, { type: 'notification.send', aggregateType: 'notifications', aggregateId: unrelayed }),
      );
    clock.advance(2 * HOUR);
    expect(await reconcile()).toEqual({ campaignRows: 0, eventRows: 0, digests: 0, expired: 0 });
    expect(await queue('notifications').getJob(`notification-${sendNowRow}`)).toBeUndefined();
    expect(await queue('notifications').getJob(`notification-${unrelayed}`)).toBeUndefined();
  });

  it('adds the job of a digest whose period ended more than 30 minutes ago, and not before', async () => {
    clock.set('2026-11-10T06:00:00.000Z');
    const digest = await insertRow({
      event: 'service.price_changed',
      payload: { variables: { merchantName: 'Zain' }, items: [{ serviceId: 1 }], cycle: '2026-11-09' },
      recipientType: 'account',
    });
    const today = await insertRow({
      event: 'service.price_changed',
      payload: { variables: { merchantName: 'Zain' }, items: [{ serviceId: 1 }], cycle: '2026-11-10' },
      recipientType: 'account',
    });
    // The period of 2026-11-09 ended at 06:00 on the 10th: only 29 minutes ago.
    clock.advance(29 * MINUTE);
    expect((await reconcile()).digests).toBe(0);
    clock.advance(2 * MINUTE);
    expect((await reconcile()).digests).toBe(1);
    expect((await queue('notifications').getJob(`notification-${digest}`))?.data).toEqual({ notificationId: digest });
    expect(await queue('notifications').getJob(`notification-${today}`)).toBeUndefined();
  });

  it('fails a queued row older than 48 hours with the reason, and keeps a younger one', async () => {
    const old = await insertRow();
    clock.advance(47 * HOUR);
    const young = await insertRow();
    clock.advance(2 * HOUR);
    expect((await reconcile()).expired).toBe(1);
    expect(await rowOf(old)).toMatchObject({ status: 'failed', error: 'The message was not sent in time.' });
    expect((await rowOf(young)).status).toBe('queued');
    expect((await reconcile()).expired).toBe(0);
    clock.advance(47 * HOUR);
    expect((await reconcile()).expired).toBe(1);
    expect((await rowOf(young)).status).toBe('failed');
  });
});

describe('NotificationReconcileProcessor', () => {
  const tick = (data: { runId?: number } = {}) => t.app.get(NotificationReconcileProcessor).process(jobLike(data));

  it('writes no run for an idle tick, one for a tick that did something, and one for every manual run', async () => {
    expect(await tick()).toEqual({ campaignRows: 0, eventRows: 0, digests: 0, expired: 0 });
    expect(await runs()).toHaveLength(0);

    const old = await insertRow();
    clock.advance(49 * HOUR);
    expect((await tick()).expired).toBe(1);
    const recorded = await runs();
    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject({ trigger: 'schedule', status: 'succeeded', processed: 1 });
    expect(recorded[0]!.result).toEqual({ campaignRows: 0, eventRows: 0, digests: 0, expired: 1 });
    expect((await rowOf(old)).status).toBe('failed');

    const [manual] = await db
      .insert(s.jobRuns)
      .values({ job: NOTIFICATION_RECONCILE_JOB, trigger: 'manual', status: 'running', startedAt: clock.now() })
      .returning({ id: s.jobRuns.id });
    expect(await tick({ runId: manual!.id })).toEqual({ campaignRows: 0, eventRows: 0, digests: 0, expired: 0 });
    const afterManual = await runs();
    expect(afterManual).toHaveLength(2);
    expect(afterManual.find((run) => run.id === manual!.id)).toMatchObject({ trigger: 'manual', status: 'succeeded' });
  });
});

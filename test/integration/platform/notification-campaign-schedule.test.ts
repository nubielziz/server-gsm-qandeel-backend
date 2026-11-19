// Integration tests of the scheduling sweep (feature 23, slice B, plan section 8.3): a scheduled campaign is queued once when its time
// comes (TestClock), even by two parallel ticks, with its outbox event and a system audit row; a reschedule moves it and a cancel stops
// it; a stalled fan-out is re-kicked and a day-old one given up; `job_runs` records a tick that did something and every manual run.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { eq } from 'drizzle-orm';
import { type Database, schema as s } from '@src/infra/db';
import { JobSchedulerRegistry, QueuesService } from '@src/infra/queues';
import { RedisService } from '@src/infra/redis';
import { JobRunsService } from '@src/modules/health';
import {
  CAMPAIGN_SWEEP_JOB,
  CAMPAIGN_SWEEP_SCHEDULER,
  CampaignSweep,
  CampaignSweepProcessor,
} from '@src/modules/platform';
import { type AdminApi, adminWith } from '../../support/admin-api';
import { type TestApp, createTestApp } from '../../support/app';
import { clearIdentityCaches } from '../../support/auth';
import {
  campaignAudit,
  campaignItems,
  campaignRow,
  createDraft,
  fanOutAll,
  fanOutWith,
  insertCustomer,
  jobLike,
  sendNow,
} from '../../support/campaigns';
import { DAY, HOUR, MINUTE, TestClock } from '../../support/clock';
import { closeTestDb, resetDb, testDb } from '../../support/db';
import { deleteBullKeys, testBullPrefix } from '../../support/queues';

const prefix = testBullPrefix();
const clock = new TestClock('2026-11-10T09:00:00.000Z');
let t: TestApp;
let owner: AdminApi;
let db: Database;

const CUSTOMERS = { channels: ['in_app'], audience: { customers: { hasAccount: true } } };
const at = (ms: number) => new Date(clock.nowMs() + ms).toISOString();

async function fanOutEvents(campaignId: number) {
  const rows = await db.select().from(s.outboxEvents).where(eq(s.outboxEvents.type, 'notification.campaign_fanout'));
  return rows.filter((row) => row.aggregateId === campaignId);
}
async function sweepRuns() {
  return db.select().from(s.jobRuns).where(eq(s.jobRuns.job, CAMPAIGN_SWEEP_JOB));
}
async function tick() {
  return t.app.get(CampaignSweepProcessor).process(jobLike({}));
}
async function scheduled(inMs: number): Promise<number> {
  const draft = await createDraft(owner, CUSTOMERS);
  const res = await owner.post(`/admin/notification-campaigns/${draft.id}/schedule`, { scheduledAt: at(inMs) });
  expect(res.status).toBe(200);
  return draft.id;
}

beforeAll(async () => {
  t = await createTestApp({ clock, env: { BULL_PREFIX: prefix } });
  db = (await testDb()).db;
});
beforeEach(async () => {
  clock.set('2026-11-10T09:00:00.000Z');
  await resetDb();
  await clearIdentityCaches(t);
  await t.app.get(QueuesService).queue('notifications').obliterate({ force: true });
  fanOutWith(t, { chunkSize: 500, timeBudgetMs: 60_000, highWater: 20_000 });
  owner = await adminWith(t, ['*']);
  await insertCustomer(db);
  await insertCustomer(db);
});
afterAll(async () => {
  await resetDb();
  await clearIdentityCaches(t);
  await deleteBullKeys(t.app.get(RedisService).queue, prefix);
  await t.close();
  await closeTestDb();
});

describe('the campaign sweep', () => {
  it('is registered every minute on the maintenance queue', () => {
    const entry = t.app
      .get(JobSchedulerRegistry)
      .list()
      .find((scheduler) => scheduler.id === CAMPAIGN_SWEEP_SCHEDULER);
    expect(entry).toMatchObject({ queue: 'maintenance', jobName: CAMPAIGN_SWEEP_JOB, pattern: '* * * * *' });
  });

  it('does nothing before the time, and writes no run for an idle tick', async () => {
    const id = await scheduled(10 * MINUTE);
    clock.advance(9 * MINUTE);
    expect(await tick()).toEqual({ queued: 0, rekicked: 0, failed: 0 });
    expect((await campaignRow(db, id)).status).toBe('scheduled');
    expect(await sweepRuns()).toHaveLength(0);
  });

  it('queues the campaign at its time with one outbox event and a system audit row, recorded in job_runs', async () => {
    const id = await scheduled(10 * MINUTE);
    clock.advance(10 * MINUTE);
    expect(await tick()).toEqual({ queued: 1, rekicked: 0, failed: 0 });
    expect(await campaignRow(db, id)).toMatchObject({ status: 'queued', queuedAt: clock.now() });
    expect(await fanOutEvents(id)).toHaveLength(1);
    expect((await campaignAudit(db, id)).at(-1)).toMatchObject({
      action: 'sent scheduled notification campaign',
      actorType: 'system',
      after: { status: 'queued' },
    });
    const runs = await sweepRuns();
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ trigger: 'schedule', status: 'succeeded', processed: 1 });
    // The fan-out then delivers the in-app items.
    await fanOutAll(t, id);
    expect(await campaignItems(db, id)).toHaveLength(2);
    expect(await tick()).toEqual({ queued: 0, rekicked: 0, failed: 0 });
  });

  it('queues a due campaign once when two ticks run in parallel', async () => {
    const id = await scheduled(MINUTE);
    clock.advance(2 * MINUTE);
    const sweep = t.app.get(CampaignSweep);
    const results = await Promise.all([sweep.run(), sweep.run(), sweep.run()]);
    expect(results.map((result) => result.queued).sort()).toEqual([0, 0, 1]);
    expect(await fanOutEvents(id)).toHaveLength(1);
  });

  it('follows a reschedule and never sends a cancelled campaign', async () => {
    const moved = await scheduled(10 * MINUTE);
    await owner.post(`/admin/notification-campaigns/${moved}/schedule`, { scheduledAt: at(HOUR) });
    const cancelled = await scheduled(10 * MINUTE);
    await owner.post(`/admin/notification-campaigns/${cancelled}/cancel`);
    clock.advance(30 * MINUTE);
    expect((await tick()).queued).toBe(0);
    expect((await campaignRow(db, moved)).status).toBe('scheduled');
    clock.advance(30 * MINUTE);
    expect((await tick()).queued).toBe(1);
    expect((await campaignRow(db, moved)).status).toBe('queued');
    expect((await campaignRow(db, cancelled)).status).toBe('cancelled');
    expect(await fanOutEvents(cancelled)).toHaveLength(0);
  });

  it('re-kicks a fan-out whose heartbeat stopped, once per minute', async () => {
    const draft = await createDraft(owner, CUSTOMERS);
    await sendNow(owner, draft.id);
    clock.advance(6 * MINUTE);
    expect(await tick()).toEqual({ queued: 0, rekicked: 1, failed: 0 });
    expect(await tick()).toMatchObject({ rekicked: 1 });
    const jobs = (await t.app.get(QueuesService).queue('notifications').getJobs(['waiting'])).filter(
      (job) => job.name === 'notification.campaign_fanout',
    );
    const minute = Math.floor(clock.nowMs() / MINUTE);
    expect(jobs.map((job) => [job.id, job.data])).toEqual([
      [`campaign-fanout-${draft.id}-r${minute}`, { campaignId: draft.id }],
    ]);
  });

  it('gives up a campaign still running a day after it was queued', async () => {
    const draft = await createDraft(owner, CUSTOMERS);
    await sendNow(owner, draft.id);
    clock.advance(DAY + MINUTE);
    expect(await tick()).toMatchObject({ failed: 1 });
    expect(await campaignRow(db, draft.id)).toMatchObject({
      status: 'failed',
      error: 'The fan-out did not finish within 24 hours.',
      finishedAt: clock.now(),
    });
  });

  it('records a manual run in the row the route inserted, even when there is nothing to do', async () => {
    const run = await t.app.get(JobRunsService).start({ job: CAMPAIGN_SWEEP_JOB, trigger: 'manual' });
    expect(await t.app.get(CampaignSweepProcessor).process(jobLike({ runId: run.id }))).toEqual({
      queued: 0,
      rekicked: 0,
      failed: 0,
    });
    const runs = await sweepRuns();
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ id: run.id, trigger: 'manual', status: 'succeeded' });
  });
});

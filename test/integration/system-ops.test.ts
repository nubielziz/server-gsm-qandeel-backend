// Integration tests of the System health background work routes (feature 9): the queue counters, failed jobs, retry and pause, the
// scheduled jobs list and the manual run, on the real queue Redis and Postgres (decision 020, resolutions health-commissions-16).
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { Worker } from 'bullmq';
import { eq } from 'drizzle-orm';
import { schema as s } from '../../src/infra/db';
import { QUEUE_NAMES, QueuesService } from '../../src/infra/queues';
import { RedisService } from '../../src/infra/redis';
import { JobRunsService } from '../../src/modules/health';
import { UNRECORDED_JOBS } from '../../src/modules/health/domain/unrecorded-jobs';
import { IP_RULE_HITS_FLUSH_JOB } from '../../src/modules/identity/security/ip-rules/ip-rule-hits-flush.processor';
import { OUTBOX_TICK_JOB } from '../../src/modules/platform/outbox/outbox-relay.processor';
import { SUPPLIER_POLL_TICK_JOB } from '../../src/modules/suppliers/application/supplier-poll';
import { adminWith } from '../support/admin-api';
import { type TestApp, createTestApp } from '../support/app';
import { clearIdentityCaches } from '../support/auth';
import { MINUTE, TestClock } from '../support/clock';
import { closeTestDb, resetDb, testDb } from '../support/db';
import { deleteBullKeys, testBullPrefix, waitForState } from '../support/queues';

const prefix = testBullPrefix();
const clock = new TestClock();
let t: TestApp;
let redis: RedisService;
let queues: QueuesService;

beforeAll(async () => {
  t = await createTestApp({ env: { BULL_PREFIX: prefix } });
  redis = t.app.get(RedisService, { strict: false });
  queues = t.app.get(QueuesService, { strict: false });
});
beforeEach(async () => {
  await resetDb();
  await clearIdentityCaches(t);
  for (const name of QUEUE_NAMES) {
    const queue = queues.queue(name);
    await queue.resume();
    await queue.obliterate({ force: true });
    for (const scheduler of await queue.getJobSchedulers()) await queue.removeJobScheduler(scheduler.key);
  }
});
afterAll(async () => {
  await resetDb();
  await clearIdentityCaches(t);
  await deleteBullKeys(redis.queue, prefix);
  await t.close();
  await closeTestDb();
});

/** Fails one job of a queue for real: a worker takes it and throws (the `imports` queue does not retry). */
async function failJob(data: object, queueName: 'imports' | 'files' = 'imports', reason = 'Supplier said no') {
  const worker = new Worker(queueName, () => Promise.reject(new Error(reason)), {
    connection: redis.createWorkerConnection(),
    prefix,
  });
  try {
    const job = await queues.add(queueName, 'import_services', data);
    return await waitForState(() => queues.queue(queueName).getJob(job.id!), 'failed');
  } finally {
    await worker.close();
  }
}

describe('GET /admin/system/queues', () => {
  it('needs system:read and lists every queue with its counters and verdict', async () => {
    expect((await (await adminWith(t, ['dashboard:read'])).get('/admin/system/queues')).status).toBe(403);
    const api = await adminWith(t, ['system:read']);
    await queues.add('files', 'render', { fileId: 1 });
    await queues.add('files', 'render', { fileId: 2 }, { delay: 60_000 });
    const { body, status } = await api.get('/admin/system/queues');
    expect(status).toBe(200);
    expect(body.queues.map((q: { name: string }) => q.name)).toEqual([...QUEUE_NAMES]);
    const files = body.queues.find((q: { name: string }) => q.name === 'files');
    expect(files).toMatchObject({ paused: false, waiting: 1, active: 0, delayed: 1, failed: 0, workers: 0 });
    expect(files.oldestAge).toMatchObject({ unit: 's', warn: 120, crit: 600 });
    // Nobody works a queue in this app, and a queue with no worker is critical.
    expect(files.state).toBe('crit');
    const idle = body.queues.find((q: { name: string }) => q.name === 'notifications');
    expect(idle.oldestAge).toMatchObject({ value: 0, state: 'ok' });
    expect(body.oldestAge.unit).toBe('s');
    expect(body.trend).toHaveLength(96);
    expect(body.trend.every((point: { value: number | null }) => point.value === null)).toBe(true);
  });

  it('shows the outbox backlog as the outbox-relay queue, not the relay ticks', async () => {
    const api = await adminWith(t, ['system:read']);
    const { db } = await testDb();
    await db.insert(s.outboxEvents).values([
      { type: 'order.status_changed', aggregateType: 'order', aggregateId: 1 },
      { type: 'order.status_changed', aggregateType: 'order', aggregateId: 2 },
    ]);
    const { body } = await api.get('/admin/system/queues');
    expect(body.queues.find((q: { name: string }) => q.name === 'outbox-relay').waiting).toBe(2);
  });
});

describe('failed jobs, retry and pause', () => {
  it('lists failed jobs newest first with the subject read from the ids and counts them', async () => {
    const api = await adminWith(t, ['system:read']);
    const first = await failJob({ orderId: 10422, requestId: 'r1' });
    const second = await failJob({ aggregateType: 'order', aggregateId: 7 });
    const { body, status, total } = await api.get('/admin/system/queues/imports/failed?_start=0&_end=25');
    expect(status).toBe(200);
    expect(total).toBe(2);
    expect(body.map((row: { id: string }) => row.id)).toEqual([String(second.id), String(first.id)]);
    expect(body[1]).toMatchObject({
      name: 'import_services',
      failedReason: 'Supplier said no',
      attemptsMade: 1,
      maxAttempts: 1,
      subject: 'order #10422',
    });
    expect(body[0].subject).toBe('order #7');
    expect(typeof body[0].failedAt).toBe('string');
    expect(JSON.stringify(body)).not.toContain('r1');
    const page = await api.get('/admin/system/queues/imports/failed?_start=1&_end=2');
    expect(page.body).toHaveLength(1);
    expect((await api.get('/admin/system/queues/nope/failed')).status).toBe(404);
  });

  it('cuts credentials out of a failure text and caps its length', async () => {
    const api = await adminWith(t, ['system:read']);
    await failJob(
      { orderId: 1 },
      'imports',
      `connect ECONNREFUSED redis://admin:s3cret@10.0.0.5:6379 ${'x'.repeat(800)}`,
    );
    const { body } = await api.get('/admin/system/queues/imports/failed?_start=0&_end=25');
    const reason = (body[0] as { failedReason: string }).failedReason;
    expect(reason).not.toContain('s3cret');
    expect(reason).toContain('redis://***@10.0.0.5:6379');
    expect(reason.length).toBeLessThanOrEqual(500);
  });

  it('retries one failed job or all of them, audited, and refuses the wrong bodies', async () => {
    const api = await adminWith(t, ['system:manage', 'system:read']);
    const one = await failJob({ orderId: 1 });
    await failJob({ orderId: 2 });
    expect((await api.post('/admin/system/queues/imports/retry', {})).status).toBe(422);
    const both = await api.post('/admin/system/queues/imports/retry', { jobId: String(one.id), all: true });
    expect(both.status).toBe(422);
    expect(both.body.errors[0].field).toBe('jobId');
    expect((await api.post('/admin/system/queues/imports/retry', { jobId: 'missing' })).status).toBe(404);
    expect((await api.post('/admin/system/queues/nope/retry', { all: true })).status).toBe(404);
    const single = await api.post('/admin/system/queues/imports/retry', { jobId: String(one.id) });
    expect(single).toMatchObject({ status: 200, body: { retried: 1 } });
    expect(await queues.queue('imports').getFailedCount()).toBe(1);
    const all = await api.post('/admin/system/queues/imports/retry', { all: true });
    expect(all.body).toEqual({ retried: 1 });
    expect(await queues.queue('imports').getFailedCount()).toBe(0);
    expect((await api.post('/admin/system/queues/imports/retry', { all: true })).body).toEqual({ retried: 0 });
    const { db } = await testDb();
    const audit = await db
      .select()
      .from(s.auditLogs)
      .where(eq(s.auditLogs.entityType, 'queue'))
      .orderBy(s.auditLogs.id);
    expect(audit.map((row) => [row.action, row.entityLabel])).toEqual(
      Array(3).fill(['retried failed jobs in', 'imports']),
    );
    const reader = await adminWith(t, ['system:read']);
    expect((await reader.post('/admin/system/queues/imports/retry', { all: true })).status).toBe(403);
  });

  it('pauses with a reason, keeps the first pause, resumes, and audits each', async () => {
    const api = await adminWith(t, ['system:manage', 'system:read']);
    const noReason = await api.post('/admin/system/queues/files/pause', { paused: true, reason: 'ab' });
    expect(noReason.status).toBe(422);
    expect(noReason.body.errors[0].field).toBe('reason');
    expect((await api.post('/admin/system/queues/files/pause', { paused: 'yes' })).status).toBe(422);
    expect((await api.post('/admin/system/queues/nope/pause', { paused: false })).status).toBe(404);
    const paused = await api.post('/admin/system/queues/files/pause', { paused: true, reason: '  Supplier outage  ' });
    expect(paused.status).toBe(200);
    expect(paused.body).toMatchObject({ name: 'files', paused: true, state: 'crit' });
    expect(await queues.queue('files').isPaused()).toBe(true);
    await api.post('/admin/system/queues/files/pause', { paused: true, reason: 'Second reason' });
    const resumed = await api.post('/admin/system/queues/files/pause', { paused: false });
    expect(resumed.body.paused).toBe(false);
    expect(await queues.queue('files').isPaused()).toBe(false);
    const { db } = await testDb();
    const audit = await db
      .select()
      .from(s.auditLogs)
      .where(eq(s.auditLogs.entityType, 'queue'))
      .orderBy(s.auditLogs.id);
    expect(audit.map((row) => row.action)).toEqual(['paused queue', 'paused queue', 'resumed queue']);
    expect(audit[0]?.after).toMatchObject({ paused: true, reason: 'Supplier outage', alreadyPaused: false });
    expect(audit[1]?.after).toMatchObject({ alreadyPaused: true });
  });
});

describe('scheduled jobs', () => {
  async function schedule() {
    await queues
      .queue('maintenance')
      .upsertJobScheduler('session-purge', { pattern: '15 3 * * *' }, { name: 'session_purge', data: {} });
    await queues
      .queue('maintenance')
      .upsertJobScheduler('service-checks', { every: 60_000 }, { name: 'service_checks', data: {} });
  }

  it('lists the schedulers with their last finished run, never the running one', async () => {
    const api = await adminWith(t, ['system:read']);
    await schedule();
    const { db } = await testDb();
    const at = (minutes: number) => new Date(clock.now().getTime() - minutes * MINUTE);
    await db.insert(s.jobRuns).values([
      {
        job: 'session_purge',
        trigger: 'schedule',
        status: 'succeeded',
        startedAt: at(30),
        finishedAt: at(29),
        durationMs: 60_000,
        processed: 12,
        result: { deleted: 12 },
      },
      {
        job: 'session_purge',
        trigger: 'schedule',
        status: 'failed',
        startedAt: at(20),
        finishedAt: at(19),
        durationMs: 1_000,
        error: 'timeout',
      },
      { job: 'session_purge', trigger: 'schedule', status: 'running', startedAt: at(1) },
    ]);
    const { body, status } = await api.get('/admin/system/jobs');
    expect(status).toBe(200);
    expect(body.runs).toEqual([]);
    const purge = body.jobs.find((job: { name: string }) => job.name === 'session_purge');
    expect(purge).toMatchObject({
      label: 'Session purge',
      schedule: '15 3 * * *',
      scheduleText: 'Daily at 03:15 UTC',
      running: true,
      state: 'crit',
    });
    expect(purge.lastRun).toMatchObject({ status: 'failed', error: 'timeout', durationMs: 1000 });
    expect(typeof purge.nextRunAt).toBe('string');
    const checks = body.jobs.find((job: { name: string }) => job.name === 'service_checks');
    expect(checks).toMatchObject({
      schedule: '* * * * *',
      scheduleText: 'Every minute',
      running: false,
      state: 'unknown',
      lastRun: null,
    });
  });

  it("gives one job's history with a running run at duration 0, and 404 for an unknown job", async () => {
    const api = await adminWith(t, ['system:read']);
    await schedule();
    const { db } = await testDb();
    await db.insert(s.jobRuns).values([
      {
        job: 'session_purge',
        trigger: 'schedule',
        status: 'succeeded',
        startedAt: new Date(clock.now().getTime() - 5 * MINUTE),
        finishedAt: clock.now(),
        durationMs: 5,
        processed: 2,
      },
      { job: 'session_purge', trigger: 'schedule', status: 'running', startedAt: clock.now() },
    ]);
    const { body } = await api.get('/admin/system/jobs?job=session_purge');
    expect(body.runs).toHaveLength(2);
    expect(body.runs[0]).toMatchObject({
      status: 'running',
      durationMs: 0,
      processed: 0,
      finishedAt: null,
      triggeredBy: null,
    });
    expect(body.runs[1].status).toBe('succeeded');
    expect((await api.get('/admin/system/jobs?job=nope')).status).toBe(404);
  });

  it("starts a manual run on the job's queue as manual-<id>, refuses an overlap, and audits", async () => {
    const api = await adminWith(t, ['system:manage', 'system:read'], { name: 'Rami K.' });
    await schedule();
    expect((await api.post('/admin/system/jobs/nope/run')).status).toBe(404);
    const started = await api.post('/admin/system/jobs/session_purge/run');
    expect(started.status).toBe(202);
    expect(started.body).toMatchObject({
      job: 'session_purge',
      trigger: 'manual',
      status: 'running',
      durationMs: 0,
      processed: 0,
      finishedAt: null,
      triggeredBy: { id: api.staffId, name: 'Rami K.' },
    });
    const job = await queues.queue('maintenance').getJob(`manual-${started.body.id}`);
    expect(job?.name).toBe('session_purge');
    expect(job?.data).toMatchObject({ runId: started.body.id });
    const again = await api.post('/admin/system/jobs/session_purge/run');
    expect(again.status).toBe(409);
    expect(again.body.code).toBe('JOB_ALREADY_RUNNING');
    const runs = t.app.get(JobRunsService, { strict: false });
    expect((await runs.findRunning('session_purge'))?.id).toBe(started.body.id);
    const { db } = await testDb();
    const audit = await db.select().from(s.auditLogs).where(eq(s.auditLogs.entityType, 'job'));
    expect(audit.map((row) => [row.action, row.entityLabel])).toEqual([['ran job', 'session_purge']]);
    expect((await (await adminWith(t, ['system:read'])).post('/admin/system/jobs/session_purge/run')).status).toBe(403);
  });
  it('leaves out the housekeeping ticks that write no job_runs, and a manual run of one is 404 with nothing written', async () => {
    const api = await adminWith(t, ['system:manage', 'system:read']);
    await schedule();
    // The three schedulers whose processors ignore `data.runId`, created the way their modules register them.
    await queues
      .queue('outbox-relay')
      .upsertJobScheduler('outbox-tick', { every: 1_000 }, { name: OUTBOX_TICK_JOB, data: {} });
    await queues
      .queue('maintenance')
      .upsertJobScheduler('ip-rule-hits-flush', { every: 60_000 }, { name: IP_RULE_HITS_FLUSH_JOB, data: {} });
    await queues
      .queue('supplier-poll')
      .upsertJobScheduler('supplier-poll-tick', { every: 60_000 }, { name: SUPPLIER_POLL_TICK_JOB, data: {} });
    expect([...UNRECORDED_JOBS].sort()).toEqual(
      [OUTBOX_TICK_JOB, IP_RULE_HITS_FLUSH_JOB, SUPPLIER_POLL_TICK_JOB].sort(),
    );

    const list = await api.get('/admin/system/jobs');
    expect(list.status).toBe(200);
    expect(list.body.jobs.map((job: { name: string }) => job.name).sort()).toEqual(['service_checks', 'session_purge']);
    for (const name of UNRECORDED_JOBS) {
      expect((await api.get(`/admin/system/jobs?job=${name}`)).status).toBe(404);
      const run = await api.post(`/admin/system/jobs/${name}/run`);
      expect(run.status).toBe(404);
    }
    const { db } = await testDb();
    expect(await db.select().from(s.jobRuns)).toEqual([]);
    expect(await db.select().from(s.auditLogs).where(eq(s.auditLogs.entityType, 'job'))).toEqual([]);
    for (const queue of ['outbox-relay', 'supplier-poll'] as const)
      expect(await queues.queue(queue).getJobs(['waiting', 'delayed', 'active'])).not.toContainEqual(
        expect.objectContaining({ id: expect.stringMatching(/^manual-/) }),
      );
    // The recorded jobs still run: the 404 is for the housekeeping ticks only.
    expect((await api.post('/admin/system/jobs/service_checks/run')).status).toBe(202);
  });
});

// Integration tests of the admin session routes and the ended-session purge job (feature 2a, scenarios admin-team and ip-rules):
// the one live-session rule (resolution identity-platform-6), the list of staff and merchant sessions, ending a session, and the
// daily purge of sessions that ended more than 30 days ago.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { MetricsModule } from '../../src/infra/metrics';
import { CacheModule } from '../../src/infra/cache';
import { DbModule, DbService, schema as s } from '../../src/infra/db';
import {
  JobSchedulerRegistry,
  QueueWorkers,
  QueueWorkersModule,
  QueuesModule,
  QueuesService,
} from '../../src/infra/queues';
import { RedisModule, RedisService } from '../../src/infra/redis';
import {
  PURGE_BATCH_SIZE,
  SESSION_PURGE_JOB,
  SESSION_PURGE_SCHEDULER,
  SESSION_RETENTION_DAYS,
  SessionPurge,
  SessionPurgeModule,
} from '../../src/modules/identity';
import { SessionPurgeProcessor } from '../../src/modules/identity/jobs/session-purge.processor';
import { adminFor, adminWith } from '../support/admin-api';
import { type TestApp, createTestApp } from '../support/app';
import { clearIdentityCaches, insertMerchant, insertRole, insertStaff, openSession } from '../support/auth';
import { DAY, HOUR, MINUTE, TestClock } from '../support/clock';
import { closeTestDb, resetDb, testDb } from '../support/db';
import { createInfra } from '../support/infra';
import { deleteBullKeys, testBullPrefix } from '../support/queues';

const clock = new TestClock();
let t: TestApp;

beforeAll(async () => {
  t = await createTestApp({ clock });
});
beforeEach(async () => {
  clock.reset();
  await resetDb();
  await clearIdentityCaches(t);
});
afterAll(async () => {
  await resetDb();
  await clearIdentityCaches(t);
  await t.close();
  await closeTestDb();
});

const sessionRow = async (id: number) => {
  const { db } = await testDb();
  return (await db.select().from(s.sessions).where(eq(s.sessions.id, id)))[0]!;
};
const auditRows = async () => (await testDb()).db.select().from(s.auditLogs).orderBy(s.auditLogs.id);
const ids = (body: Array<{ id: number }>) => body.map((row) => row.id);

async function viewer(permissions = ['sessions:read', 'sessions:revoke'], name = 'Rami K.') {
  return adminWith(t, permissions, { name });
}

describe('GET /admin/sessions', () => {
  it("lists fully signed-in staff and merchant sessions with their account, marks the caller's own, and nothing else", async () => {
    const rami = await viewer();
    const { db } = await testDb();
    const support = await insertRole(db, ['staff:read']);
    const lina = await insertStaff(db, support, { name: 'Lina S.', email: 'lina@example.com' });
    const linaSession = await openSession(t, { type: 'staff', id: lina });
    const merchant = await insertMerchant(db, { name: 'Zain Mobile Hub', email: 'ops@zain.example' });
    const merchantSession = await openSession(t, { type: 'client', id: merchant });
    // Never listed: a storefront customer, and the sign-in steps before the second factor or the password change.
    await openSession(t, { type: 'customer', id: 99 });
    await openSession(t, { type: 'staff', id: lina }, { stage: 'pending_totp' });
    await openSession(t, { type: 'staff', id: lina }, { stage: 'pending_password' });

    const res = await rami.get('/admin/sessions?_sort=id&_order=asc');
    expect(res.status).toBe(200);
    expect(res.total).toBe(3);
    expect(ids(res.body)).toEqual([rami.session.sessionId, linaSession.sessionId, merchantSession.sessionId]);
    const created = clock.now().toISOString();
    expect(res.body[1]).toEqual({
      id: linaSession.sessionId,
      expiresAt: new Date(clock.nowMs() + 8 * HOUR).toISOString(),
      createdAt: created,
      ip: '203.0.113.7',
      userAgent: 'bun-test',
      lastSeenAt: created,
      subjectType: 'staff',
      subject: { id: lina, name: 'Lina S.', email: 'lina@example.com' },
      current: false,
    });
    expect(res.body[2]).toMatchObject({
      subjectType: 'client',
      subject: { id: merchant, name: 'Zain Mobile Hub', email: 'ops@zain.example' },
      current: false,
    });
    expect(res.body[2].expiresAt).toBe(new Date(clock.nowMs() + 30 * DAY).toISOString());
    expect(res.body[0]).toMatchObject({
      subjectType: 'staff',
      subject: { id: rami.staffId, name: 'Rami K.' },
      current: true,
    });
    expect(JSON.stringify(res.body)).not.toMatch(/tokenHash|token_hash|"token"/);
  });

  it('applies one live rule: revoked, expired and idle-dead sessions disappear, with the idle limit of each subject type', async () => {
    const { db } = await testDb();
    const support = await insertRole(db, ['staff:read']);
    const lina = await insertStaff(db, support, { name: 'Lina S.' });
    const merchant = await insertMerchant(db);
    const revoked = await openSession(t, { type: 'staff', id: lina });
    const shortLived = await openSession(t, { type: 'staff', id: lina }, { ttlSeconds: 2 * 60 });
    const staffLive = await openSession(t, { type: 'staff', id: lina });
    const merchantLive = await openSession(t, { type: 'client', id: merchant });
    await db.update(s.sessions).set({ revokedAt: clock.now() }).where(eq(s.sessions.id, revoked.sessionId));
    /** The ids a fresh viewer sees at this moment (a viewer is signed in at the current time, so it is never idle-dead). */
    const seen = async (name: string) =>
      ids((await (await viewer(['sessions:read'], name)).get('/admin/sessions?_end=100')).body);

    const start = await seen('At start');
    expect(start).toEqual(expect.arrayContaining([shortLived.sessionId, staffLive.sessionId, merchantLive.sessionId]));
    expect(start).not.toContain(revoked.sessionId);

    // The short session ends at its absolute end: one millisecond before it is still listed, at the end it is not.
    clock.advance(2 * MINUTE - 1);
    expect(await seen('Before the end')).toContain(shortLived.sessionId);
    clock.advance(1);
    expect(await seen('At the end')).not.toContain(shortLived.sessionId);

    // Staff may sit idle for 30 minutes (the unused session was last seen at the start): alive one millisecond before, dead at
    // the limit. A merchant session may sit idle for seven days.
    clock.advance(28 * MINUTE - 1);
    const beforeIdle = await seen('Before idle');
    expect(beforeIdle).toContain(staffLive.sessionId);
    clock.advance(1);
    const afterIdle = await seen('After idle');
    expect(afterIdle).not.toContain(staffLive.sessionId);
    expect(afterIdle).toContain(merchantLive.sessionId);

    clock.advance(7 * DAY - 30 * MINUTE - 1);
    expect(await seen('Before merchant idle')).toContain(merchantLive.sessionId);
    clock.advance(1);
    expect(await seen('After merchant idle')).not.toContain(merchantLive.sessionId);
  });

  it('filters by subject type, sorts by last use, creation and id, and pages with the exact total', async () => {
    const rami = await viewer();
    const { db } = await testDb();
    const support = await insertRole(db, ['staff:read']);
    const lina = await insertStaff(db, support, { name: 'Lina S.' });
    const first = await openSession(t, { type: 'staff', id: lina });
    clock.advance(MINUTE);
    const merchant = await insertMerchant(db);
    const second = await openSession(t, { type: 'client', id: merchant });
    clock.advance(MINUTE);
    const third = await openSession(t, { type: 'client', id: merchant });

    expect(ids((await rami.get('/admin/sessions?subjectType=client&_sort=id&_order=asc')).body)).toEqual([
      second.sessionId,
      third.sessionId,
    ]);
    expect((await rami.get('/admin/sessions?subjectType=staff')).total).toBe(2);
    // Default order: last use, newest first.
    expect(ids((await rami.get('/admin/sessions?subjectType=client')).body)).toEqual([
      third.sessionId,
      second.sessionId,
    ]);
    expect(ids((await rami.get('/admin/sessions?subjectType=client&_sort=lastSeenAt&_order=asc')).body)).toEqual([
      second.sessionId,
      third.sessionId,
    ]);
    expect(ids((await rami.get('/admin/sessions?subjectType=client&_sort=createdAt&_order=desc')).body)).toEqual([
      third.sessionId,
      second.sessionId,
    ]);

    const everyone = [rami.session.sessionId, first.sessionId, second.sessionId, third.sessionId].sort((a, b) => b - a);
    const page = await rami.get('/admin/sessions?_sort=id&_order=desc&_start=1&_end=2');
    expect(ids(page.body)).toEqual([everyone[1]!]);
    expect(page.total).toBe(4);
    expect((await rami.get('/admin/sessions?subjectType=customer')).status).toBe(422);
    expect((await rami.get('/admin/sessions?_sort=ip')).status).toBe(422);
  });

  it("shows the account's current name (a rename is visible at once) and needs sessions:read", async () => {
    const rami = await viewer();
    const { db } = await testDb();
    const support = await insertRole(db, ['staff:read']);
    const lina = await insertStaff(db, support, { name: 'Lina S.' });
    await openSession(t, { type: 'staff', id: lina });
    await db.update(s.staffUsers).set({ name: 'Lina Saleh' }).where(eq(s.staffUsers.id, lina));
    const res = await rami.get('/admin/sessions?_sort=id&_order=desc');
    expect(res.body[0].subject.name).toBe('Lina Saleh');

    const nobody = await adminWith(t, ['staff:read']);
    const refused = await nobody.get('/admin/sessions');
    expect(refused.status).toBe(403);
    expect(refused.body.detail).toContain('sessions:read');
    expect((await rami.anonymous('GET', '/admin/sessions')).status).toBe(401);
  });
});

describe('DELETE /admin/sessions/:id', () => {
  it('ends a staff session and a merchant session, audits each, and the account is signed out on its next request', async () => {
    const rami = await viewer();
    const { db } = await testDb();
    const support = await insertRole(db, ['staff:read']);
    const lina = await insertStaff(db, support, { name: 'Lina S.' });
    const linaApi = await adminFor(t, lina, support);
    expect((await linaApi.get('/admin/sessions')).status).toBe(403);
    const merchant = await insertMerchant(db, { name: 'Zain Mobile Hub' });
    const merchantSession = await openSession(t, { type: 'client', id: merchant });

    const res = await rami.delete(`/admin/sessions/${linaApi.session.sessionId}`);
    expect(res.status).toBe(204);
    expect(res.body).toBeUndefined();
    expect((await sessionRow(linaApi.session.sessionId)).revokedAt).toEqual(clock.now());
    expect((await linaApi.get('/admin/staff')).status).toBe(401);
    expect((await rami.delete(`/admin/sessions/${merchantSession.sessionId}`)).status).toBe(204);
    expect((await sessionRow(merchantSession.sessionId)).revokedAt).not.toBeNull();

    const [first, second] = await auditRows();
    expect(first).toMatchObject({
      action: 'ended session of',
      entityType: 'session',
      entityId: linaApi.session.sessionId,
      entityLabel: 'Lina S.',
      actorId: rami.staffId,
      actorName: 'Rami K.',
    });
    expect(first!.before).toEqual({ subjectType: 'staff', subjectId: lina, ip: '203.0.113.7' });
    expect(first!.after).toEqual({ ended: true, own: false });
    expect(second).toMatchObject({ entityLabel: 'Zain Mobile Hub' });
    expect((await rami.get('/admin/sessions')).body.map((row: { id: number }) => row.id)).toEqual([
      rami.session.sessionId,
    ]);
  });

  it('lets a staff member end their own session: the next request is signed out', async () => {
    const rami = await viewer();
    const res = await rami.delete(`/admin/sessions/${rami.session.sessionId}`);
    expect(res.status).toBe(204);
    expect((await auditRows())[0]!.after).toEqual({ ended: true, own: true });
    expect((await rami.get('/admin/sessions')).status).toBe(401);
  });

  it("answers 404 for a session that is not live by the list's rule: unknown, revoked, expired, idle, a customer or a sign-in step", async () => {
    const rami = await viewer();
    const { db } = await testDb();
    const support = await insertRole(db, ['staff:read']);
    const lina = await insertStaff(db, support);
    const merchant = await insertMerchant(db);
    const revoked = await openSession(t, { type: 'staff', id: lina });
    await db.update(s.sessions).set({ revokedAt: clock.now() }).where(eq(s.sessions.id, revoked.sessionId));
    const expired = await openSession(t, { type: 'staff', id: lina }, { ttlSeconds: 60 });
    const idle = await openSession(t, { type: 'staff', id: lina });
    const customer = await openSession(t, { type: 'customer', id: 7 });
    const step = await openSession(t, { type: 'staff', id: lina }, { stage: 'pending_totp' });
    const merchantLive = await openSession(t, { type: 'client', id: merchant });

    for (const dead of [revoked, customer, step]) {
      const res = await rami.delete(`/admin/sessions/${dead.sessionId}`);
      expect(res.status).toBe(404);
      expect(res.body.code).toBe('NOT_FOUND');
    }
    expect((await rami.delete('/admin/sessions/999999')).status).toBe(404);
    expect((await rami.delete('/admin/sessions/abc')).status).toBe(422);

    clock.advance(31 * MINUTE);
    const later = await viewer(['sessions:revoke'], 'Later');
    for (const dead of [expired, idle])
      expect((await later.delete(`/admin/sessions/${dead.sessionId}`)).status).toBe(404);
    // The merchant session (7 days idle limit) is still live and can be ended.
    expect((await later.delete(`/admin/sessions/${merchantLive.sessionId}`)).status).toBe(204);
    // Ended twice: the second answer is 404, and only one audit row was written for it.
    expect((await later.delete(`/admin/sessions/${merchantLive.sessionId}`)).status).toBe(404);
    expect(await auditRows()).toHaveLength(1);
  });

  it('needs sessions:revoke and a CSRF token', async () => {
    const rami = await viewer();
    const reader = await adminWith(t, ['sessions:read']);
    const refused = await reader.delete(`/admin/sessions/${rami.session.sessionId}`);
    expect(refused.status).toBe(403);
    expect(refused.body.detail).toContain('sessions:revoke');
    const noCsrf = await rami.withoutCsrf('DELETE', `/admin/sessions/${reader.session.sessionId}`);
    expect(noCsrf.status).toBe(403);
    expect(noCsrf.body.code).toBe('CSRF_FAILED');
    expect((await sessionRow(reader.session.sessionId)).revokedAt).toBeNull();
  });
});

describe('the ended-session purge job', () => {
  /** The purge as the worker builds it, on the test database and the test clock. */
  const purge = () => new SessionPurge(t.app.get(DbService), clock);

  /** Inserts a session row with explicit times, as an old sign-in would have left it. */
  async function oldSession(values: Partial<typeof s.sessions.$inferInsert>): Promise<number> {
    const { db } = await testDb();
    const [row] = await db
      .insert(s.sessions)
      .values({
        tokenHash: randomUUID().replaceAll('-', '').repeat(2),
        subjectType: 'staff',
        subjectId: 1,
        stage: 'active',
        ip: '203.0.113.7',
        lastSeenAt: clock.now(),
        expiresAt: new Date(clock.nowMs() + 8 * HOUR),
        ...values,
      })
      .returning({ id: s.sessions.id });
    return row!.id;
  }
  const remaining = async () =>
    (await (await testDb()).db.select({ id: s.sessions.id }).from(s.sessions).orderBy(s.sessions.id)).map(
      (row) => row.id,
    );
  const daysAgo = (n: number) => new Date(clock.nowMs() - n * DAY);

  it('keeps ended sessions for 30 days and deletes older ones, whatever ended them, and never touches a live one', async () => {
    expect(SESSION_RETENTION_DAYS).toBe(30);
    await oldSession({ revokedAt: daysAgo(31), expiresAt: daysAgo(30) });
    await oldSession({ expiresAt: daysAgo(31) });
    await oldSession({ stage: 'pending_totp', expiresAt: daysAgo(40) });
    const revokedRecent = await oldSession({ revokedAt: daysAgo(29), expiresAt: daysAgo(-1) });
    const expiredRecent = await oldSession({ expiresAt: daysAgo(29) });
    const live = await oldSession({});
    // Idle-dead but not past its absolute end: not "ended" for the purge.
    const idleDead = await oldSession({ lastSeenAt: daysAgo(60), expiresAt: daysAgo(-5) });

    expect(await purge().purge()).toBe(3);
    expect(await remaining()).toEqual([revokedRecent, expiredRecent, live, idleDead].sort((a, b) => a - b));
  });

  it('is exact at the edge: a session that ended exactly 30 days ago stays, one millisecond older goes', async () => {
    const atEdge = await oldSession({ expiresAt: daysAgo(30) });
    await oldSession({ expiresAt: new Date(daysAgo(30).getTime() - 1) });
    expect(await purge().purge()).toBe(1);
    expect(await remaining()).toEqual([atEdge]);
    // Running it again changes nothing; a millisecond later the edge session is old enough.
    expect(await purge().purge()).toBe(0);
    clock.advance(1);
    expect(await purge().purge()).toBe(1);
    expect(await remaining()).toEqual([]);
  });

  it('works through more than one batch and counts every deleted row', async () => {
    const { db } = await testDb();
    const rows = Array.from({ length: PURGE_BATCH_SIZE + 5 }, (_, index) => ({
      tokenHash: String(index).padStart(64, '0'),
      subjectType: 'staff' as const,
      subjectId: 1,
      stage: 'active' as const,
      ip: '203.0.113.7',
      lastSeenAt: daysAgo(60),
      expiresAt: daysAgo(40),
    }));
    await db.insert(s.sessions).values(rows);
    const live = await oldSession({});
    expect(await purge().purge()).toBe(PURGE_BATCH_SIZE + 5);
    expect(await remaining()).toEqual([live]);
  });

  it('is safe to run twice at the same time', async () => {
    for (let i = 0; i < 20; i++) await oldSession({ expiresAt: daysAgo(40) });
    const live = await oldSession({});
    const [first, second] = await Promise.all([purge().purge(), purge().purge()]);
    expect(first + second).toBe(20);
    expect(await remaining()).toEqual([live]);
  });
});

describe('the purge on a worker', () => {
  const prefix = testBullPrefix();
  afterAll(async () => {
    const cleaner = await createInfra({ modules: [MetricsModule, RedisModule] });
    await deleteBullKeys(cleaner.get(RedisService).queue, prefix);
    await cleaner.close();
  });

  it('is scheduled once a day on the maintenance queue, runs on a real worker, and records a job_runs row', async () => {
    const workerClock = new TestClock();
    const harness = await createInfra({
      modules: [
        MetricsModule,
        RedisModule,
        CacheModule,
        DbModule,
        QueuesModule,
        QueueWorkersModule,
        SessionPurgeModule,
      ],
      env: { BULL_PREFIX: prefix },
      clock: workerClock,
    });
    try {
      await harness.get(QueueWorkers).whenReady();
      expect(harness.get(JobSchedulerRegistry).list()).toContainEqual(
        expect.objectContaining({
          id: SESSION_PURGE_SCHEDULER,
          queue: 'maintenance',
          jobName: SESSION_PURGE_JOB,
          pattern: '15 3 * * *',
        }),
      );
      const queues = harness.get(QueuesService);
      const scheduler = (await queues.queue('maintenance').getJobSchedulers()).find(
        (candidate) => candidate.key === SESSION_PURGE_SCHEDULER,
      );
      expect(scheduler).toMatchObject({ name: SESSION_PURGE_JOB, pattern: '15 3 * * *' });

      // The processor, called as the worker would: the old ended session goes, the live one stays, the run is recorded.
      const { db } = await testDb();
      const [old] = await db
        .insert(s.sessions)
        .values({
          tokenHash: 'a'.repeat(64),
          subjectType: 'staff',
          subjectId: 1,
          stage: 'active',
          ip: '203.0.113.7',
          lastSeenAt: new Date(workerClock.nowMs() - 60 * DAY),
          expiresAt: new Date(workerClock.nowMs() - 40 * DAY),
        })
        .returning({ id: s.sessions.id });
      const [kept] = await db
        .insert(s.sessions)
        .values({
          tokenHash: 'b'.repeat(64),
          subjectType: 'staff',
          subjectId: 1,
          stage: 'active',
          ip: '203.0.113.7',
          expiresAt: new Date(workerClock.nowMs() + 8 * HOUR),
        })
        .returning({ id: s.sessions.id });
      const processor = harness.get(SessionPurgeProcessor);
      const result = await processor.process({ data: {} } as Parameters<SessionPurgeProcessor['process']>[0]);
      expect(result).toEqual({ deleted: 1 });
      expect((await db.select({ id: s.sessions.id }).from(s.sessions)).map((row) => row.id)).toEqual([kept!.id]);
      expect(old!.id).not.toBe(kept!.id);
      const runs = await db.select().from(s.jobRuns).where(eq(s.jobRuns.job, SESSION_PURGE_JOB));
      expect(runs).toHaveLength(1);
      expect(runs[0]).toMatchObject({ trigger: 'schedule', status: 'succeeded', processed: 1, result: { deleted: 1 } });
      // A second run finds nothing and records itself again.
      expect(await processor.process({ data: {} } as Parameters<SessionPurgeProcessor['process']>[0])).toEqual({
        deleted: 0,
      });
      expect(await db.select().from(s.jobRuns).where(eq(s.jobRuns.job, SESSION_PURGE_JOB))).toHaveLength(2);
    } finally {
      await harness.close();
    }
  });
});

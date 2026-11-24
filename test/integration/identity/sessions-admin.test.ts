// Integration tests of the admin session routes and the ended-session purge job (feature 2a, scenarios admin-team and ip-rules):
// the one live-session rule (resolution identity-platform-6), the list of staff sessions, ending a session, and the
// daily purge of sessions that ended more than 30 days ago.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { MetricsModule } from '@src/infra/metrics';
import { CacheModule } from '@src/infra/cache';
import { DbModule, DbService, schema as s } from '@src/infra/db';
import { JobSchedulerRegistry, QueueWorkers, QueueWorkersModule, QueuesModule, QueuesService } from '@src/infra/queues';
import { RedisModule, RedisService } from '@src/infra/redis';
import {
  PURGE_BATCH_SIZE,
  SESSION_PURGE_JOB,
  SESSION_PURGE_SCHEDULER,
  SESSION_RETENTION_DAYS,
  SessionPurge,
  SessionPurgeModule,
} from '@src/modules/identity';
import { SessionPurgeProcessor } from '@src/modules/identity/jobs/session-purge.processor';
import { adminFor, adminWith } from '../../support/admin-api';
import { type TestApp, createTestApp } from '../../support/app';
import { clearIdentityCaches, insertMerchant, insertRole, insertStaff, openSession } from '../../support/auth';
import { DAY, HOUR, MINUTE, TestClock } from '../../support/clock';
import { closeTestDb, resetDb, testDb } from '../../support/db';
import { createInfra } from '../../support/infra';
import { deleteBullKeys, testBullPrefix } from '../../support/queues';

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

async function viewer(permissions = ['sessions:read', 'sessions:revoke', 'staff:read'], name = 'Rami K.') {
  return adminWith(t, permissions, { name });
}

describe('GET /admin/sessions', () => {
  it("lists fully signed-in staff sessions with their account, marks the caller's own, and nothing else", async () => {
    const rami = await viewer();
    const { db } = await testDb();
    const support = await insertRole(db, ['staff:read']);
    const lina = await insertStaff(db, support, { name: 'Lina S.', email: 'lina@example.com' });
    const linaSession = await openSession(t, { type: 'staff', id: lina });
    // Never listed: a merchant (its per-device list is retired), a storefront customer, and the sign-in steps before the second
    // factor or the password change.
    const merchant = await insertMerchant(db, { name: 'Zain Mobile Hub', email: 'ops@zain.example' });
    await openSession(t, { type: 'client', id: merchant });
    await openSession(t, { type: 'customer', id: 99 });
    await openSession(t, { type: 'staff', id: lina }, { stage: 'pending_totp' });
    await openSession(t, { type: 'staff', id: lina }, { stage: 'pending_password' });

    const res = await rami.get('/admin/sessions?_sort=id&_order=asc');
    expect(res.status).toBe(200);
    expect(res.total).toBe(2);
    expect(ids(res.body)).toEqual([rami.session.sessionId, linaSession.sessionId]);
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
    expect(res.body[0]).toMatchObject({
      subjectType: 'staff',
      subject: { id: rami.staffId, name: 'Rami K.' },
      current: true,
    });
    expect(JSON.stringify(res.body)).not.toMatch(/tokenHash|token_hash|"token"/);
  });

  it('applies one live rule: revoked, expired and idle-dead sessions disappear, with the idle limit of staff', async () => {
    const { db } = await testDb();
    const support = await insertRole(db, ['staff:read']);
    const lina = await insertStaff(db, support, { name: 'Lina S.' });
    const revoked = await openSession(t, { type: 'staff', id: lina });
    const shortLived = await openSession(t, { type: 'staff', id: lina }, { ttlSeconds: 2 * 60 });
    const staffLive = await openSession(t, { type: 'staff', id: lina });
    await db.update(s.sessions).set({ revokedAt: clock.now() }).where(eq(s.sessions.id, revoked.sessionId));
    /** The ids a fresh viewer sees at this moment (a viewer is signed in at the current time, so it is never idle-dead). */
    const seen = async (name: string) =>
      ids((await (await viewer(['sessions:read'], name)).get('/admin/sessions?_end=100')).body);

    const start = await seen('At start');
    expect(start).toEqual(expect.arrayContaining([shortLived.sessionId, staffLive.sessionId]));
    expect(start).not.toContain(revoked.sessionId);

    // The short session ends at its absolute end: one millisecond before it is still listed, at the end it is not.
    clock.advance(2 * MINUTE - 1);
    expect(await seen('Before the end')).toContain(shortLived.sessionId);
    clock.advance(1);
    expect(await seen('At the end')).not.toContain(shortLived.sessionId);

    // Staff may sit idle for 30 minutes (the unused session was last seen at the start): alive one millisecond before, dead at
    // the limit.
    clock.advance(28 * MINUTE - 1);
    expect(await seen('Before idle')).toContain(staffLive.sessionId);
    clock.advance(1);
    expect(await seen('After idle')).not.toContain(staffLive.sessionId);
  });

  it('accepts the staff filter, sorts by last use, creation and id, and pages with the exact total', async () => {
    const rami = await viewer();
    const { db } = await testDb();
    const support = await insertRole(db, ['staff:read']);
    const lina = await insertStaff(db, support, { name: 'Lina S.' });
    const first = await openSession(t, { type: 'staff', id: lina });
    clock.advance(MINUTE);
    const second = await openSession(t, { type: 'staff', id: lina });
    clock.advance(MINUTE);
    const third = await openSession(t, { type: 'staff', id: lina });

    expect((await rami.get('/admin/sessions?subjectType=staff')).total).toBe(4);
    // The caller's own session is touched by every request, so the order of the others is what is compared.
    const others = (body: Array<{ id: number }>) => ids(body).filter((id) => id !== rami.session.sessionId);
    // Default order: last use, newest first.
    expect(others((await rami.get('/admin/sessions?subjectType=staff&_end=100')).body)).toEqual([
      third.sessionId,
      second.sessionId,
      first.sessionId,
    ]);
    expect(others((await rami.get('/admin/sessions?_sort=lastSeenAt&_order=asc&_end=100')).body)).toEqual([
      first.sessionId,
      second.sessionId,
      third.sessionId,
    ]);
    expect(ids((await rami.get('/admin/sessions?_sort=createdAt&_order=desc&_end=1')).body)).toEqual([third.sessionId]);

    const everyone = [rami.session.sessionId, first.sessionId, second.sessionId, third.sessionId].sort((a, b) => b - a);
    const page = await rami.get('/admin/sessions?_sort=id&_order=desc&_start=1&_end=2');
    expect(ids(page.body)).toEqual([everyone[1]!]);
    expect(page.total).toBe(4);
    expect((await rami.get('/admin/sessions?subjectType=customer')).status).toBe(422);
    expect((await rami.get('/admin/sessions?_sort=ip')).status).toBe(422);
  });

  it('no longer lists a merchant: the merchant filter values and subjectId are refused', async () => {
    const rami = await viewer();
    const { db } = await testDb();
    const merchant = await insertMerchant(db, { name: 'Zain Mobile Hub' });
    await openSession(t, { type: 'client', id: merchant });
    for (const query of ['subjectType=client', `subjectType=client&subjectId=${merchant}`, 'subjectId=7']) {
      const res = await rami.get(`/admin/sessions?${query}`);
      expect(res.status, query).toBe(422);
      expect(res.body.code).toBe('VALIDATION_FAILED');
    }
    const all = await rami.get('/admin/sessions?_end=100');
    expect(all.total).toBe(1);
    expect(ids(all.body)).toEqual([rami.session.sessionId]);
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
  it('ends a staff session, audits it, and the account is signed out on its next request', async () => {
    const rami = await viewer();
    const { db } = await testDb();
    const support = await insertRole(db, ['staff:read']);
    const lina = await insertStaff(db, support, { name: 'Lina S.' });
    const linaApi = await adminFor(t, lina, support);
    expect((await linaApi.get('/admin/sessions')).status).toBe(403);

    const res = await rami.delete(`/admin/sessions/${linaApi.session.sessionId}`);
    expect(res.status).toBe(204);
    expect(res.body).toBeUndefined();
    expect((await sessionRow(linaApi.session.sessionId)).revokedAt).toEqual(clock.now());
    expect((await linaApi.get('/admin/staff')).status).toBe(401);

    const [first, ...others] = await auditRows();
    expect(others).toHaveLength(0);
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
    expect((await rami.get('/admin/sessions')).body.map((row: { id: number }) => row.id)).toEqual([
      rami.session.sessionId,
    ]);
  });

  it('refuses ending a session of an Owner without *, or of a member whose role the caller does not hold, and keeps both live (decision 046)', async () => {
    const rami = await viewer();
    const { db } = await testDb();
    const ownerRole = await insertRole(db, ['*'], 'Owner');
    const ownerId = await insertStaff(db, ownerRole, { name: 'Boss' });
    const ownerSession = await openSession(t, { type: 'staff', id: ownerId });
    const finance = await insertRole(db, ['staff:read', 'wallet:adjust'], 'Finance');
    const nadia = await insertStaff(db, finance, { name: 'Nadia H.' });
    const nadiaSession = await openSession(t, { type: 'staff', id: nadia });

    const owner = await rami.delete(`/admin/sessions/${ownerSession.sessionId}`);
    expect(owner.status).toBe(403);
    expect(owner.body.detail).toBe('Only an owner can do this to an owner account.');
    const member = await rami.delete(`/admin/sessions/${nadiaSession.sessionId}`);
    expect(member.status).toBe(403);
    expect(member.body.detail).toBe('This account has permissions you do not hold yourself.');
    expect((await sessionRow(ownerSession.sessionId)).revokedAt).toBeNull();
    expect((await sessionRow(nadiaSession.sessionId)).revokedAt).toBeNull();
    expect(await auditRows()).toHaveLength(0);

    // An Owner ends the same sessions.
    const chief = await adminWith(t, ['*'], { name: 'Chief' });
    expect((await chief.delete(`/admin/sessions/${ownerSession.sessionId}`)).status).toBe(204);
    expect((await chief.delete(`/admin/sessions/${nadiaSession.sessionId}`)).status).toBe(204);
  });

  it('lets a staff member end their own session: the next request is signed out', async () => {
    const rami = await viewer();
    const res = await rami.delete(`/admin/sessions/${rami.session.sessionId}`);
    expect(res.status).toBe(204);
    expect((await auditRows())[0]!.after).toEqual({ ended: true, own: true });
    expect((await rami.get('/admin/sessions')).status).toBe(401);
  });

  it("answers 404 for a session that is not live by the list's rule: unknown, revoked, expired, idle, a merchant, a customer or a sign-in step", async () => {
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

    for (const dead of [revoked, customer, step, merchantLive]) {
      const res = await rami.delete(`/admin/sessions/${dead.sessionId}`);
      expect(res.status).toBe(404);
      expect(res.body.code).toBe('NOT_FOUND');
    }
    expect((await sessionRow(merchantLive.sessionId)).revokedAt).toBeNull();
    expect((await rami.delete('/admin/sessions/999999')).status).toBe(404);
    expect((await rami.delete('/admin/sessions/abc')).status).toBe(422);

    clock.advance(31 * MINUTE);
    const later = await viewer(['sessions:revoke'], 'Later');
    for (const dead of [expired, idle])
      expect((await later.delete(`/admin/sessions/${dead.sessionId}`)).status).toBe(404);
    expect(await auditRows()).toHaveLength(0);
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

describe('what the session list and ending a session show, by permission', () => {
  const MASK = '•••';
  const sessionIn = (body: Array<{ id: number }>, id: number) => body.find((row) => row.id === id)!;

  it('masks the address and device of a session whose role holds permissions the caller lacks, and of nobody else', async () => {
    const { db } = await testDb();
    const ownerRole = await insertRole(db, ['*'], 'Owner');
    const ownerId = await insertStaff(db, ownerRole, { name: 'Boss' });
    const ownerSession = await openSession(t, { type: 'staff', id: ownerId });
    const finance = await insertRole(db, ['staff:read', 'wallet:adjust'], 'Finance');
    const nadia = await insertStaff(db, finance, { name: 'Nadia H.' });
    const nadiaSession = await openSession(t, { type: 'staff', id: nadia });
    const support = await insertRole(db, ['staff:read'], 'Support');
    const lina = await insertStaff(db, support, { name: 'Lina S.' });
    const linaSession = await openSession(t, { type: 'staff', id: lina });

    const reader = await adminWith(t, ['sessions:read', 'staff:read'], { name: 'Reader' });
    const seen = (await reader.get('/admin/sessions?_end=100')).body as Array<{ id: number }>;
    const owner = sessionIn(seen, ownerSession.sessionId) as Record<string, unknown>;
    const member = sessionIn(seen, nadiaSession.sessionId) as Record<string, unknown>;
    // The row keeps its shape: the two values are masked, nothing is dropped.
    expect(owner).toMatchObject({
      ip: MASK,
      userAgent: MASK,
      subjectType: 'staff',
      subject: { id: ownerId, name: 'Boss' },
    });
    expect(member).toMatchObject({ ip: MASK, userAgent: MASK, subject: { id: nadia, name: 'Nadia H.' } });
    expect(Object.keys(owner)).toEqual(Object.keys(sessionIn(seen, linaSession.sessionId)));
    // A member whose role the caller covers and the caller's own session are shown as they are.
    for (const own of [linaSession.sessionId, reader.session.sessionId]) {
      expect(sessionIn(seen, own)).toMatchObject({ ip: '203.0.113.7', userAgent: 'bun-test' });
    }

    // An area wildcard covers its actions; an Owner covers every role.
    const wide = await adminWith(t, ['sessions:read', 'staff:read', 'wallet:*'], { name: 'Wide' });
    const widest = (await wide.get('/admin/sessions?_end=100')).body as Array<{ id: number }>;
    expect(sessionIn(widest, nadiaSession.sessionId)).toMatchObject({ ip: '203.0.113.7', userAgent: 'bun-test' });
    expect(sessionIn(widest, ownerSession.sessionId)).toMatchObject({ ip: MASK, userAgent: MASK });
    const chief = await adminWith(t, ['*'], { name: 'Chief' });
    const everything = (await chief.get('/admin/sessions?_end=100')).body as Array<{ id: number }>;
    for (const row of [ownerSession, nadiaSession, linaSession]) {
      expect(sessionIn(everything, row.sessionId)).toMatchObject({ ip: '203.0.113.7', userAgent: 'bun-test' });
    }
  });

  it("neither lists nor ends a merchant's session, whatever the caller holds", async () => {
    const { db } = await testDb();
    const merchant = await insertMerchant(db, { name: 'Zain Mobile Hub', email: 'ops@zain.example' });
    const merchantSession = await openSession(t, { type: 'client', id: merchant });
    const owner = await adminWith(t, ['*']);

    const listed = (await owner.get('/admin/sessions?_end=100')).body as Array<{ id: number }>;
    expect(ids(listed)).not.toContain(merchantSession.sessionId);
    expect(JSON.stringify(listed)).not.toContain('ops@zain.example');
    expect((await owner.delete(`/admin/sessions/${merchantSession.sessionId}`)).status).toBe(404);
    expect((await sessionRow(merchantSession.sessionId)).revokedAt).toBeNull();
    expect(await auditRows()).toHaveLength(0);
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
      // The retired nightly promotion is listed, and the worker removed its scheduler from this Redis at boot (a leftover from an older worker).
      expect(harness.get(JobSchedulerRegistry).retired()).toContainEqual({
        queue: 'maintenance',
        id: 'client-group-promotion',
      });
      expect(
        (await queues.queue('maintenance').getJobSchedulers()).some(
          (candidate) => candidate.key === 'client-group-promotion',
        ),
      ).toBe(false);

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

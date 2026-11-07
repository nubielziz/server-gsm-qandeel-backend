// Integration tests of the audit log (decision 018, platform module): AuditService writes the actor and IP of the request,
// redacts secrets, and the request-level enforcement fails a staff mutation that wrote no audit row (outside production).
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { desc } from 'drizzle-orm';
import { runWithRequestId } from '../../src/common/request-id';
import { getRequestContext, setRequestActor } from '../../src/common/request-context';
import { schema as s } from '../../src/infra/db';
import { AuditService } from '../../src/modules/platform';
import { type TestApp, createTestApp } from '../support/app';
import { clearIdentityCaches, openSession, signInStaff } from '../support/auth';
import { closeTestDb, resetDb, testDb } from '../support/db';
import { logSink } from '../support/log-sink';
import { expectRejection } from '../support/rejection';
import { SecurityTestController } from '../support/security-routes';

let t: TestApp;
beforeAll(async () => {
  t = await createTestApp({ controllers: [SecurityTestController] });
});
afterAll(async () => {
  await t.close();
  await closeTestDb();
});
beforeEach(async () => {
  await resetDb();
  await clearIdentityCaches(t);
  logSink.clear();
});

const rows = async () => (await testDb()).db.select().from(s.auditLogs).orderBy(desc(s.auditLogs.id));
const call = (method: 'POST' | 'PUT' | 'GET', url: string, headers: Record<string, string>) =>
  t.app.inject({ method, url, headers });

describe('AuditService through a staff mutation', () => {
  it('writes the actor and the IP of the request, and the entity the use case names', async () => {
    const { session, staffId } = await signInStaff(t, ['staff:update']);
    const res = await call('POST', '/admin/t/sec/write', session.mutationHeaders);
    expect(res.statusCode).toBe(201);
    const [row, ...rest] = await rows();
    expect(rest).toHaveLength(0);
    expect(row).toMatchObject({
      actorType: 'staff',
      actorId: staffId,
      actorName: 'Test Staff',
      action: 'Changed a test record',
      entityType: 'staff',
      entityId: 7,
      entityLabel: 'Test record',
      ip: '127.0.0.1',
    });
  });

  it('keeps secrets out of the snapshots but leaves flags readable', async () => {
    const { session } = await signInStaff(t, ['staff:update']);
    await call('POST', '/admin/t/sec/write', session.mutationHeaders);
    const [row] = await rows();
    expect(row!.before).toEqual({ name: 'old', passwordHash: '[redacted]', mustChangePassword: true });
    expect(row!.after).toEqual({ name: 'new', passwordHash: '[redacted]', mustChangePassword: false });
    expect(JSON.stringify(row)).not.toContain('argon2id');
  });

  it('records 0 and the label for an action without a numeric entity', async () => {
    const { session } = await signInStaff(t, ['risk:*']);
    const res = await call('PUT', '/admin/t/sec/risk-rules', session.mutationHeaders);
    expect(res.statusCode).toBe(200);
    const [row] = await rows();
    expect(row).toMatchObject({
      entityType: 'setting',
      entityId: 0,
      entityLabel: 'risk.rules',
      before: null,
      after: null,
    });
  });
});

describe('audit enforcement', () => {
  it('fails a staff mutation that wrote no audit row with a 500 that names the route, and logs it', async () => {
    const { session } = await signInStaff(t, []);
    const res = await call('POST', '/admin/t/sec/forgets-audit', session.mutationHeaders);
    expect(res.statusCode).toBe(500);
    expect(res.json()).toMatchObject({ code: 'INTERNAL_ERROR', status: 500 });
    expect(res.json().detail).toContain('POST /admin/t/sec/forgets-audit');
    expect(res.json().detail).toContain('AuditService.record');
    const logged = logSink.lines.find((line) => String(line.msg ?? '').includes('wrote no audit row'));
    expect(logged).toBeDefined();
  });

  it('lets a mutation that declares audit: false through', async () => {
    const { session } = await signInStaff(t, []);
    expect((await call('POST', '/admin/t/sec/no-audit', session.mutationHeaders)).statusCode).toBe(200);
    expect(await rows()).toHaveLength(0);
  });

  it('checks only successful mutations: a business error is not turned into a 500', async () => {
    const { session } = await signInStaff(t, []);
    const res = await call('POST', '/admin/t/sec/fails', session.mutationHeaders);
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe('CONFLICT');
  });

  it('does not apply to reads, to guard refusals or to the sign-in steps', async () => {
    const { session, staffId } = await signInStaff(t, []);
    expect((await call('GET', '/admin/t/sec/session', session.headers)).statusCode).toBe(200);
    // A missing CSRF token is refused by the guard before the handler: that is a 403, not an audit problem.
    expect((await call('POST', '/admin/t/sec/forgets-audit', session.headers)).statusCode).toBe(403);
    const pending = await openSession(t, { type: 'staff', id: staffId }, { stage: 'pending_totp' });
    expect((await call('POST', '/admin/t/sec/step', pending.mutationHeaders)).statusCode).toBe(200);
  });

  it('does not apply to callers that are not staff', async () => {
    expect((await t.app.inject({ method: 'POST', url: '/store/v1/t/sec/public' })).statusCode).toBe(200);
  });
});

describe('AuditService outside a request', () => {
  it('records the system as the actor when nobody is signed in', async () => {
    const { db } = await testDb();
    const audit = t.app.get(AuditService);
    const row = await audit.record(db, {
      action: 'Ran the nightly check',
      entityType: 'setting',
      entityLabel: 'nightly',
    });
    expect(row).toMatchObject({
      actorType: 'system',
      actorId: null,
      actorName: '',
      ip: null,
      entityId: 0,
      entityLabel: 'nightly',
    });
  });

  it('reads the actor and the IP from the request context and counts the row', async () => {
    const { db } = await testDb();
    const audit = t.app.get(AuditService);
    const counted = await runWithRequestId('req-audit-1', async () => {
      setRequestActor({ type: 'staff', id: 41, name: 'Lina S.' }, '198.51.100.8');
      expect(getRequestContext()?.auditRecords).toBe(0);
      const row = await audit.record(db, {
        action: 'Did something',
        entityType: 'order',
        entityId: 9,
        before: { a: 1 },
      });
      expect(row).toMatchObject({
        actorType: 'staff',
        actorId: 41,
        actorName: 'Lina S.',
        ip: '198.51.100.8',
        entityId: 9,
        before: { a: 1 },
        after: null,
      });
      await audit.record(db, { action: 'Did another thing', entityType: 'order', entityId: 9 });
      return getRequestContext()?.auditRecords;
    });
    expect(counted).toBe(2);
  });

  it('rolls back with the transaction of the use case', async () => {
    const { db } = await testDb();
    const audit = t.app.get(AuditService);
    await expectRejection(
      db.transaction(async (tx) => {
        await audit.record(tx, { action: 'Changed it', entityType: 'staff', entityId: 1 });
        throw new Error('fail after the audit');
      }),
      /fail after the audit/,
    );
    expect(await rows()).toHaveLength(0);
  });

  it('refuses a malformed entry before touching the database', async () => {
    const { db } = await testDb();
    const audit = t.app.get(AuditService);
    for (const entry of [
      { action: '', entityType: 'staff' },
      { action: 'x'.repeat(201), entityType: 'staff' },
      { action: 'Did it', entityType: 'Staff' },
      { action: 'Did it', entityType: 'not_an_entity' },
      { action: 'Did it', entityType: 'staff', entityId: -1 },
      { action: 'Did it', entityType: 'staff', entityId: 1.5 },
    ]) {
      await expectRejection(audit.record(db, entry as never), RangeError, JSON.stringify(entry));
    }
    expect(await rows()).toHaveLength(0);
  });

  it('cuts a label that is too long instead of failing the use case', async () => {
    const { db } = await testDb();
    const row = await t.app
      .get(AuditService)
      .record(db, { action: 'Did it', entityType: 'staff', entityLabel: 'n'.repeat(500) });
    expect(row.entityLabel).toHaveLength(200);
  });
});

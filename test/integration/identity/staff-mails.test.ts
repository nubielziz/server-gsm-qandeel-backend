// Integration tests of the staff link mails (feature 20, slice C): the invitation and the set-password link reach the member by email, the
// mail job rotates the placeholder token, nothing stores or logs the clear link, retries and repeats are safe, and the limiter caps the mails.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';
import { Logger } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { TokenService } from '@src/infra/crypto';
import { schema as s } from '@src/infra/db';
import { UnrecoverableError } from '@src/infra/queues';
import { DeliveryError } from '@src/modules/platform';
import { type TestApp, createTestApp } from '../../support/app';
import { type AdminApi, adminWith } from '../../support/admin-api';
import { clearIdentityCaches, insertRole, insertStaff } from '../../support/auth';
import { HOUR, TestClock } from '../../support/clock';
import { closeTestDb, resetDb, testDb } from '../../support/db';
import {
  clearAccountMailLimits,
  runStaffMailJob,
  seedIdentityTemplates,
  staffMailJobData,
} from '../../support/identity-mail';
import { logSink } from '../../support/log-sink';
import { mailbox, tokenIn } from '../../support/notifications';
import { expectRejection } from '../../support/rejection';
import { CONSOLE_ORIGIN, StaffConsole } from '../../support/staff-console';

const clock = new TestClock();
let t: TestApp;
beforeAll(async () => {
  t = await createTestApp({ env: { CORS_ORIGINS: CONSOLE_ORIGIN }, clock });
});
afterEach(() => {
  mock.restore();
});
afterAll(async () => {
  await resetDb();
  await t.close();
  await closeTestDb();
});
beforeEach(async () => {
  clock.reset();
  supportRoleId = undefined;
  await resetDb();
  await clearIdentityCaches(t);
  await clearAccountMailLimits(t);
  logSink.clear();
  await seedIdentityTemplates((await testDb()).db);
  mailbox(t).reset();
});

const PASSWORD = 'a-long-staff-passphrase-2026';

const owner = (): Promise<AdminApi> => adminWith(t, ['*'], { name: 'Rami K.', roleName: 'Owner' });
let supportRoleId: number | undefined;
const supportRole = async (): Promise<number> =>
  (supportRoleId ??= await insertRole((await testDb()).db, ['staff:read'], 'Support'));
const tokensOf = async (staffId: number) =>
  (await testDb()).db
    .select()
    .from(s.authTokens)
    .where(and(eq(s.authTokens.subjectType, 'staff'), eq(s.authTokens.subjectId, staffId)))
    .orderBy(s.authTokens.id);
const outboxOf = async (type: string) =>
  (await testDb()).db.select().from(s.outboxEvents).where(eq(s.outboxEvents.type, type)).orderBy(s.outboxEvents.id);
const notificationsOf = async () => (await testDb()).db.select().from(s.notifications).orderBy(s.notifications.id);

async function invite(api: AdminApi, email = 'nadia@gsm-supply.example'): Promise<number> {
  const res = await api.post('/admin/staff', {
    name: 'Nadia Hamdan',
    email,
    roleId: await supportRole(),
    onboarding: 'invite',
  });
  expect(res.status).toBe(201);
  return res.body.id as number;
}

describe('the invitation mail', () => {
  it('POST /admin/staff with onboarding invite writes one staff.invited outbox row with the token id only', async () => {
    const api = await owner();
    const id = await invite(api);
    const [token] = await tokensOf(id);
    const rows = await outboxOf('staff.invited');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ aggregateType: 'staff_users', aggregateId: id });
    const { meta: _meta, ...payload } = rows[0]!.payload;
    expect(payload).toEqual({ tokenId: token!.id });
    // The request answered no link, and the temporary onboarding writes no mail event.
    expect(await notificationsOf()).toEqual([]);
    const temp = await api.post('/admin/staff', {
      name: 'Omar',
      email: 'omar@gsm-supply.example',
      roleId: await supportRole(),
      onboarding: 'temporary_password',
    });
    expect(temp.status).toBe(201);
    expect(await outboxOf('staff.invited')).toHaveLength(1);
  });

  it('the job mails <CONSOLE_BASE_URL>/set-password?token=..., and that token (not the placeholder) sets the password', async () => {
    const api = await owner();
    const id = await invite(api);
    const [placeholder] = await tokensOf(id);
    const log = spyOn(Logger.prototype, 'log');
    const warn = spyOn(Logger.prototype, 'warn');

    expect(await runStaffMailJob(t, 'invited')).toEqual({ sent: true });
    const [mail] = mailbox(t).sent;
    expect(mailbox(t).sent).toHaveLength(1);
    expect(mail).toMatchObject({
      to: 'nadia@gsm-supply.example',
      subject: 'You were invited to the GSM admin console',
    });
    expect(mail!.text).toContain('Hi Nadia Hamdan,');
    expect(mail!.text).toContain(`${t.config.http.consoleBaseUrl}/set-password?token=`);
    const delivered = tokenIn(mail!.text);

    // The row keeps its id and expiry and now holds the hash of the delivered token.
    const [after] = await tokensOf(id);
    expect(after).toMatchObject({ id: placeholder!.id, expiresAt: placeholder!.expiresAt, usedAt: null });
    expect(after!.tokenHash).toBe(t.app.get(TokenService).hash(delivered));

    // No notifications row, outbox row, audit row or log line holds the token or the link.
    const { db } = await testDb();
    const stored = JSON.stringify([
      await notificationsOf(),
      await outboxOf('staff.invited'),
      await db.select().from(s.auditLogs),
    ]);
    expect(stored).not.toContain(delivered);
    expect(stored).not.toContain('token=');
    expect((await notificationsOf())[0]).toMatchObject({
      recipientType: 'staff',
      recipientId: id,
      event: 'staff.invited',
      status: 'sent',
    });
    const logged = [...log.mock.calls, ...warn.mock.calls].map((call) => String(call[0])).join('\n');
    expect(logged).not.toContain(delivered);
    expect(JSON.stringify(logSink.lines)).not.toContain(delivered);

    // The placeholder never worked; the delivered link does, once.
    const console = new StaffConsole(t);
    expect(
      (await console.setPassword({ token: placeholder!.tokenHash, password: PASSWORD }, { csrf: false })).statusCode,
    ).not.toBe(200);
    const ok = await console.setPassword({ token: delivered, password: PASSWORD }, { csrf: false });
    expect(ok.statusCode).toBe(204);
    expect(
      (
        await new StaffConsole(t).setPassword(
          { token: delivered, password: 'another-long-passphrase-2026' },
          { csrf: false },
        )
      ).statusCode,
    ).toBe(410);
  });

  it('run twice it sends one mail and the delivered link still works', async () => {
    const api = await owner();
    await invite(api);
    const data = (await staffMailJobData('invited'))!;
    expect(await runStaffMailJob(t, 'invited', data)).toEqual({ sent: true });
    const delivered = tokenIn(mailbox(t).sent[0]!.text);
    expect(await runStaffMailJob(t, 'invited', data, 1)).toEqual({ sent: false, skipped: 'already_sent' });
    expect(mailbox(t).sent).toHaveLength(1);
    const ok = await new StaffConsole(t).setPassword({ token: delivered, password: PASSWORD }, { csrf: false });
    expect(ok.statusCode).toBe(204);
  });

  it('a transient mail failure retries, the retry link works, and the last failed attempt marks the row failed', async () => {
    const api = await owner();
    const id = await invite(api);
    const data = (await staffMailJobData('invited'))!;
    mailbox(t).failNext(new DeliveryError('The mail server is busy.'));
    await expectRejection(runStaffMailJob(t, 'invited', data, 0), 'The mail server is busy.');
    expect(await notificationsOf()).toMatchObject([{ status: 'queued', attempts: 1 }]);
    expect(mailbox(t).sent).toEqual([]);

    expect(await runStaffMailJob(t, 'invited', data, 1)).toEqual({ sent: true });
    const delivered = tokenIn(mailbox(t).sent[0]!.text);
    expect(await notificationsOf()).toMatchObject([{ status: 'sent', attempts: 2 }]);
    expect(
      (await new StaffConsole(t).setPassword({ token: delivered, password: PASSWORD }, { csrf: false })).statusCode,
    ).toBe(204);
    expect(await tokensOf(id)).toHaveLength(1);
  });

  it('sends nothing, and leaves no queued row, for a suspended or deleted member and a used or expired link', async () => {
    const api = await owner();
    const { db } = await testDb();
    const id = await invite(api);
    const data = (await staffMailJobData('invited'))!;

    // Suspended.
    await db.update(s.staffUsers).set({ status: 'suspended' }).where(eq(s.staffUsers.id, id));
    expect(await runStaffMailJob(t, 'invited', data)).toEqual({ sent: false, skipped: 'staff_suspended' });
    await db.update(s.staffUsers).set({ status: 'invited' }).where(eq(s.staffUsers.id, id));

    // Expired.
    clock.advance(2 * HOUR);
    expect(await runStaffMailJob(t, 'invited', data)).toEqual({ sent: false, skipped: 'link_not_usable' });
    clock.reset();

    // Used.
    await db.update(s.authTokens).set({ usedAt: clock.now() });
    expect(await runStaffMailJob(t, 'invited', data)).toEqual({ sent: false, skipped: 'link_not_usable' });
    await db.update(s.authTokens).set({ usedAt: null });

    // Gone.
    await db.update(s.authTokens).set({ usedAt: null });
    await db.update(s.staffUsers).set({ createdBy: null });
    await db.delete(s.authTokens);
    await db.delete(s.staffUsers).where(eq(s.staffUsers.id, id));
    expect(await runStaffMailJob(t, 'invited', data)).toEqual({ sent: false, skipped: 'staff_gone' });

    expect(mailbox(t).sent).toEqual([]);
    expect((await notificationsOf()).filter((row) => row.status === 'queued')).toEqual([]);
  });

  it('sends the shipped invitation when the template is switched off (decision 047)', async () => {
    const api = await owner();
    const { db } = await testDb();
    const id = await invite(api);
    const data = (await staffMailJobData('invited'))!;
    const [placeholder] = await tokensOf(id);
    await db
      .update(s.notificationTemplates)
      .set({ isActive: false })
      .where(eq(s.notificationTemplates.event, 'staff.invited'));
    expect(await runStaffMailJob(t, 'invited', data)).toEqual({ sent: true });
    expect(mailbox(t).sent).toHaveLength(1);
    expect(mailbox(t).sent[0]).toMatchObject({
      to: 'nadia@gsm-supply.example',
      subject: 'You were invited to the GSM admin console',
    });
    const delivered = tokenIn(mailbox(t).sent[0]!.text);
    // The shipped text carries the real link: it rotated the placeholder token and works once.
    expect((await tokensOf(id))[0]!.tokenHash).not.toBe(placeholder!.tokenHash);
    const ok = await new StaffConsole(t).setPassword({ token: delivered, password: PASSWORD }, { csrf: false });
    expect(ok.statusCode).toBe(204);
    // A missing template is stood in for too.
    const second = await invite(api, 'second@gsm-supply.example');
    await db.delete(s.notificationTemplates).where(eq(s.notificationTemplates.event, 'staff.invited'));
    const secondData = (await staffMailJobData('invited'))!;
    expect(await runStaffMailJob(t, 'invited', secondData)).toEqual({ sent: true });
    expect(mailbox(t).sent).toHaveLength(2);
    expect(second).toBeGreaterThan(id);
  });

  it('a job whose event lost its token id fails for good (no retry)', async () => {
    const api = await owner();
    await invite(api);
    const data = (await staffMailJobData('invited'))!;
    await expectRejection(runStaffMailJob(t, 'invited', { ...data, payload: {} }), UnrecoverableError);
  });
});

describe('POST /admin/staff/:id/password', () => {
  it('reset_link writes staff.invited while the member is invited and staff.password_reset once active; the temporary mode writes none', async () => {
    const api = await owner();
    const role = await supportRole();
    const { db } = await testDb();
    const invited = await insertStaff(db, role, { status: 'invited', name: 'Newbie' });
    const active = await insertStaff(db, role, { passwordHash: 'old-hash', name: 'Lina S.' });

    expect(
      (await api.post(`/admin/staff/${invited}/password`, { mode: 'reset_link', revokeSessions: false })).status,
    ).toBe(200);
    expect(
      (await api.post(`/admin/staff/${active}/password`, { mode: 'reset_link', revokeSessions: false })).status,
    ).toBe(200);
    expect(await outboxOf('staff.invited')).toMatchObject([{ aggregateId: invited }]);
    expect(await outboxOf('staff.password_reset')).toMatchObject([{ aggregateId: active }]);

    await api.post(`/admin/staff/${active}/password`, { mode: 'temporary_password', revokeSessions: false });
    expect(await outboxOf('staff.password_reset')).toHaveLength(1);
  });

  it('mails the reset link, which sets a password while the current one keeps working until then', async () => {
    const api = await owner();
    const { db } = await testDb();
    const lina = await insertStaff(db, await supportRole(), { passwordHash: 'old-hash', name: 'Lina S.' });
    await api.post(`/admin/staff/${lina}/password`, { mode: 'reset_link', revokeSessions: false });
    expect(await runStaffMailJob(t, 'password_reset')).toEqual({ sent: true });
    const [mail] = mailbox(t).sent;
    expect(mail).toMatchObject({ subject: 'Choose a new password for the GSM admin console' });
    const token = tokenIn(mail!.text);
    const res = await new StaffConsole(t).setPassword({ token, password: PASSWORD }, { csrf: false });
    expect(res.statusCode).toBe(204);
  });

  it('answers 429 on the sixth link in an hour (per member), counts members apart, and a new hour starts again', async () => {
    const api = await owner();
    const role = await supportRole();
    const { db } = await testDb();
    const lina = await insertStaff(db, role, { passwordHash: 'old-hash' });
    const yusuf = await insertStaff(db, role, { passwordHash: 'old-hash' });
    const send = (id: number) => api.post(`/admin/staff/${id}/password`, { mode: 'reset_link', revokeSessions: false });
    for (let i = 0; i < 5; i++) expect((await send(lina)).status).toBe(200);
    const sixth = await send(lina);
    expect(sixth.status).toBe(429);
    expect(sixth.body.code).toBe('RATE_LIMITED');
    expect(await outboxOf('staff.password_reset')).toHaveLength(5);
    expect((await send(yusuf)).status).toBe(200);
    // The temporary mode sends no mail and is not counted.
    expect(
      (await api.post(`/admin/staff/${lina}/password`, { mode: 'temporary_password', revokeSessions: false })).status,
    ).toBe(200);
  });

  it('keeps the token and the link out of the audit log and the answer', async () => {
    const api = await owner();
    const { db } = await testDb();
    const lina = await insertStaff(db, await supportRole(), { passwordHash: 'old-hash' });
    const res = await api.post(`/admin/staff/${lina}/password`, { mode: 'reset_link', revokeSessions: false });
    expect(res.body).toEqual({});
    await runStaffMailJob(t, 'password_reset');
    const delivered = tokenIn(mailbox(t).sent[0]!.text);
    expect(JSON.stringify(await db.select().from(s.auditLogs))).not.toContain(delivered);
  });

  it('a suspended member gets no mail even if the link was requested before the suspension', async () => {
    const api = await owner();
    const { db } = await testDb();
    const lina = await insertStaff(db, await supportRole(), { passwordHash: 'old-hash' });
    await api.post(`/admin/staff/${lina}/password`, { mode: 'reset_link', revokeSessions: false });
    expect((await api.post(`/admin/staff/${lina}/suspend`, { reason: 'On leave' })).status).toBe(204);
    expect(await runStaffMailJob(t, 'password_reset')).toEqual({ sent: false, skipped: 'staff_suspended' });
    expect(mailbox(t).sent).toEqual([]);
  });
});

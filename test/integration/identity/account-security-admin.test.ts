// Integration tests of the staff security tools on an account of any rank (decision 064): a password or invitation link, a temporary password,
// a 2FA reset, "sign out everywhere" and a new verification email, through HTTP on the real application. A guest has nothing to secure.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, mock } from 'bun:test';
import { and, eq } from 'drizzle-orm';
import { schema as s } from '@src/infra/db';
import { type AdminApi, adminWith } from '../../support/admin-api';
import { accountLinks, captureAccountLinks } from '../../support/account-links';
import { accountRow, ensureRetailGroup, makeAccount } from '../../support/accounts';
import { type TestApp, createTestApp } from '../../support/app';
import { clearIdentityCaches, openSession } from '../../support/auth';
import { HOUR, TestClock } from '../../support/clock';
import { closeTestDb, resetDb, testDb } from '../../support/db';
import { insertUsd } from '../../support/fixtures';
import { clearAccountMailLimits } from '../../support/identity-mail';
import { notificationRows } from '../../support/notifications';

const clock = new TestClock();
let t: TestApp;
const CALLER_IP = '203.0.113.50';
const RANKS = ['retail', 'merchant'] as const;
/** The security notice each rank kind gets: the family follows the rank. */
const NOTICE_EVENT = { retail: 'customer.security_notice', merchant: 'merchant.security_notice' } as const;

beforeAll(async () => {
  t = await createTestApp({ clock });
});
beforeEach(async () => {
  clock.reset();
  await resetDb();
  await clearIdentityCaches(t);
  await clearAccountMailLimits(t);
  captureAccountLinks(t);
  const { db } = await testDb();
  await insertUsd(db);
  await ensureRetailGroup(db);
});
afterEach(() => mock.restore());
afterAll(async () => {
  await resetDb();
  await clearIdentityCaches(t);
  await t.close();
  await closeTestDb();
});

const auditRows = async () => (await testDb()).db.select().from(s.auditLogs).orderBy(s.auditLogs.id);
const sessionRows = async () => (await testDb()).db.select().from(s.sessions).orderBy(s.sessions.id);
const tokensOf = async (accountId: number) => {
  const { db } = await testDb();
  return db
    .select()
    .from(s.authTokens)
    .where(and(eq(s.authTokens.subjectType, 'account'), eq(s.authTokens.subjectId, accountId)))
    .orderBy(s.authTokens.id);
};

/** A staff member who holds the permission of every tool. */
const security = () => adminWith(t, ['clients:read', 'clients:security'], { name: 'Rami K.', ip: CALLER_IP });

const password = (api: AdminApi, id: number, body: Record<string, unknown>) =>
  api.post(`/admin/clients/${id}/password`, body);
const reset2fa = (api: AdminApi, id: number) => api.post(`/admin/clients/${id}/reset-2fa`);
const signOut = (api: AdminApi, id: number) => api.post(`/admin/clients/${id}/sessions/revoke`);
const verify = (api: AdminApi, id: number) => api.post(`/admin/clients/${id}/verify-email/resend`);

describe.each(RANKS)('the security tools on a %s account', (rank) => {
  it('mails a reset link to an account with a password and the invitation to one without, and never answers the link', async () => {
    const api = await security();
    const withPassword = await makeAccount(t, { rank });
    const without = await makeAccount(t, { rank, password: null });
    const reset = await password(api, withPassword.id, { mode: 'reset_link' });
    const invite = await password(api, without.id, { mode: 'reset_link' });
    expect(reset.body).toEqual({ link: 'reset' });
    expect(invite.body).toEqual({ link: 'invite' });
    expect(accountLinks().map((l) => [l.kind, l.accountId])).toEqual([
      ['password_reset', withPassword.id],
      ['invited', without.id],
    ]);
    expect((await tokensOf(withPassword.id))[0]).toMatchObject({
      purpose: 'reset',
      createdBy: api.staffId,
      usedAt: null,
    });
    expect((await accountRow(withPassword.id)).passwordHash).toBe(withPassword.row.passwordHash);
    // A newer link voids the older one.
    await password(api, withPassword.id, { mode: 'reset_link' });
    const tokens = await tokensOf(withPassword.id);
    expect(tokens.filter((row) => row.usedAt === null)).toHaveLength(1);
    const [audit] = await auditRows();
    expect(audit).toMatchObject({
      action: 'sent a password reset link to',
      entityType: 'account',
      entityId: withPassword.id,
    });
    expect(JSON.stringify(audit)).not.toContain(tokens[0]!.tokenHash);
  });

  it('sets a temporary password: hash only, a forced change, API keys held back, older links void, failed codes forgotten, every session ended', async () => {
    const api = await security();
    const account = await makeAccount(t, { rank });
    const other = await makeAccount(t, { rank });
    const session = await openSession(t, { type: 'account', id: account.id });
    const otherSession = await openSession(t, { type: 'account', id: other.id });
    const { db } = await testDb();
    await db
      .update(s.clients)
      .set({ totpFailures: 7, totpFailuresSince: clock.now() })
      .where(eq(s.clients.id, account.id));
    await db.insert(s.authTokens).values({
      purpose: 'reset',
      subjectType: 'account',
      subjectId: account.id,
      tokenHash: 'c'.repeat(64),
      expiresAt: new Date(clock.nowMs() + HOUR),
    });

    const kept = await password(api, account.id, { mode: 'temporary_password', revokeSessions: false });
    expect(kept.status).toBe(200);
    expect(kept.res.headers['cache-control']).toContain('no-store');
    const temporary = kept.body.temporaryPassword as string;
    expect(temporary).toHaveLength(14);
    const row = await accountRow(account.id);
    expect(row).toMatchObject({
      mustChangePassword: true,
      passwordSetByStaff: true,
      passwordChangedAt: clock.now(),
      totpFailures: 0,
      totpFailuresSince: null,
    });
    expect(row.passwordHash).toMatch(/^\$argon2id\$/);
    expect(JSON.stringify(row)).not.toContain(temporary);
    expect((await tokensOf(account.id)).filter((token) => token.usedAt === null)).toHaveLength(0);
    // The old password may be known to someone else: the sessions end even though the caller did not ask; another account's stay.
    const sessions = await sessionRows();
    expect(sessions.find((r) => r.id === session.sessionId)!.revokedAt).not.toBeNull();
    expect(sessions.find((r) => r.id === otherSession.sessionId)!.revokedAt).toBeNull();
    const notices = (await notificationRows(db)).filter((n) => n.recipientId === account.id);
    // The family of the notice follows the rank kind: a retail account gets the retail text.
    expect(notices.map((n) => n.event)).toEqual([NOTICE_EVENT[rank]]);
    const audits = await auditRows();
    expect(audits.at(-1)).toMatchObject({
      action: 'set a temporary password for',
      entityType: 'account',
      entityId: account.id,
      after: { credential: 'temporary password set', revokeSessions: true, sessionsEnded: 1 },
    });

    // A session opened after it ends with the next temporary password, with the box ticked or not.
    const later = await openSession(t, { type: 'account', id: account.id });
    await password(api, account.id, { mode: 'temporary_password', revokeSessions: true });
    expect((await sessionRows()).find((r) => r.id === later.sessionId)!.revokedAt).not.toBeNull();
    expect(JSON.stringify(audits)).not.toContain(temporary);
  });

  it('resets two-factor sign-in: the secret goes, every session ends, the notice is written; without two-step it is 409 TWOFA_NOT_ENABLED', async () => {
    const api = await security();
    const account = await makeAccount(t, { rank, twofaEnabled: true, totpSecretEnc: 'v1:secret', totpLastStep: 5 });
    const plain = await makeAccount(t, { rank });
    const session = await openSession(t, { type: 'account', id: account.id });
    const res = await reset2fa(api, account.id);
    expect(res.status).toBe(204);
    expect(await accountRow(account.id)).toMatchObject({
      twofaEnabled: false,
      totpSecretEnc: null,
      totpLastStep: null,
    });
    expect((await sessionRows()).find((r) => r.id === session.sessionId)!.revokedAt).not.toBeNull();
    expect((await auditRows()).at(-1)).toMatchObject({
      action: 'reset 2FA of',
      entityType: 'account',
      after: { twofaEnabled: false, sessionsEnded: 1 },
    });
    const notices = (await notificationRows((await testDb()).db)).filter((n) => n.recipientId === account.id);
    expect(notices.map((n) => n.event)).toEqual([NOTICE_EVENT[rank]]);
    const refused = await reset2fa(api, plain.id);
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe('TWOFA_NOT_ENABLED');
  });

  it('signs the account out of every device, also when it is suspended, and touches no other account', async () => {
    const api = await security();
    const account = await makeAccount(t, { rank, status: 'suspended', suspendedReason: 'Fraud check' });
    const other = await makeAccount(t, { rank });
    const one = await openSession(t, { type: 'account', id: account.id });
    const two = await openSession(t, { type: 'account', id: account.id }, { stage: 'pending_totp' });
    const otherSession = await openSession(t, { type: 'account', id: other.id });
    expect((await signOut(api, account.id)).status).toBe(204);
    const sessions = await sessionRows();
    for (const ended of [one, two]) expect(sessions.find((r) => r.id === ended.sessionId)!.revokedAt).not.toBeNull();
    expect(sessions.find((r) => r.id === otherSession.sessionId)!.revokedAt).toBeNull();
    expect((await auditRows()).at(-1)).toMatchObject({
      action: 'signed out all devices of',
      entityType: 'account',
      entityId: account.id,
      before: { sessions: 2 },
    });
  });

  it('resends the verification link, once an hour five times; an address already verified is 409 CONFLICT', async () => {
    const api = await security();
    const account = await makeAccount(t, { rank });
    const verified = await makeAccount(t, { rank, emailVerifiedAt: clock.now() });
    expect((await verify(api, account.id)).status).toBe(204);
    expect(accountLinks().map((l) => [l.kind, l.accountId])).toEqual([['email_verification', account.id]]);
    expect((await auditRows()).at(-1)).toMatchObject({ action: 'sent a verification email to', entityType: 'account' });
    const conflict = await verify(api, verified.id);
    expect(conflict.status).toBe(409);
    expect(conflict.body.code).toBe('CONFLICT');
    for (let i = 0; i < 4; i++) expect((await verify(api, account.id)).status).toBe(204);
    expect((await verify(api, account.id)).status).toBe(429);
  });

  it('refuses a password link and a verification link for a suspended or blocked account (409 NOT_ACTIVE) and writes nothing', async () => {
    const api = await security();
    for (const status of ['suspended', 'blocked'] as const) {
      const account = await makeAccount(t, {
        rank,
        status,
        suspendedReason: status === 'suspended' ? 'Fraud check' : null,
      });
      for (const body of [{ mode: 'reset_link' }, { mode: 'temporary_password' }]) {
        const res = await password(api, account.id, body);
        expect(res.status, `${status} ${body.mode}`).toBe(409);
        expect(res.body.code).toBe('NOT_ACTIVE');
      }
      expect((await verify(api, account.id)).body.code).toBe('NOT_ACTIVE');
      expect((await accountRow(account.id)).passwordHash).toBe(account.row.passwordHash);
    }
    expect(await auditRows()).toHaveLength(0);
    expect(accountLinks()).toEqual([]);
  });
});

describe('the security tools on a row that is no account', () => {
  it('refuses a guest on every tool (409 NO_ACCOUNT, "Make an account first.") and writes nothing', async () => {
    const api = await security();
    const guest = await makeAccount(t, { rank: 'retail', guest: true });
    const before = await accountRow(guest.id);
    for (const answer of [
      await password(api, guest.id, { mode: 'reset_link' }),
      await password(api, guest.id, { mode: 'temporary_password' }),
      await reset2fa(api, guest.id),
      await signOut(api, guest.id),
      await verify(api, guest.id),
    ]) {
      expect(answer.status).toBe(409);
      expect(answer.body.code).toBe('NO_ACCOUNT');
      expect(answer.body.detail).toBe('Make an account first.');
    }
    expect(await accountRow(guest.id)).toEqual(before);
    expect(await auditRows()).toHaveLength(0);
    expect(accountLinks()).toEqual([]);
  });

  it('refuses an anonymized account on every tool (409 ANONYMIZED) and an unknown account (404)', async () => {
    const api = await security();
    const gone = await makeAccount(t, {
      rank: 'retail',
      status: 'anonymized',
      anonymizedAt: clock.now(),
      password: null,
      email: 'deleted-account-1@redacted.invalid',
    });
    for (const answer of [
      await password(api, gone.id, { mode: 'reset_link' }),
      await reset2fa(api, gone.id),
      await signOut(api, gone.id),
      await verify(api, gone.id),
    ]) {
      expect(answer.status).toBe(409);
      expect(answer.body.code).toBe('ANONYMIZED');
    }
    expect((await signOut(api, 999_999)).status).toBe(404);
    expect(await auditRows()).toHaveLength(0);
  });
});

describe('who may use the security tools', () => {
  it('needs clients:security and a CSRF token on every tool', async () => {
    const account = await makeAccount(t, { rank: 'retail' });
    const plain = await adminWith(t, ['clients:read', 'clients:update'], { ip: CALLER_IP });
    for (const answer of [
      await password(plain, account.id, { mode: 'reset_link' }),
      await reset2fa(plain, account.id),
      await signOut(plain, account.id),
      await verify(plain, account.id),
    ]) {
      expect(answer.status).toBe(403);
      expect(answer.body.detail).toContain('clients:security');
    }
    const api = await security();
    const noCsrf = await api.withoutCsrf('POST', `/admin/clients/${account.id}/sessions/revoke`);
    expect(noCsrf.status).toBe(403);
    expect(noCsrf.body.code).toBe('CSRF_FAILED');
    expect(await auditRows()).toHaveLength(0);
  });
});

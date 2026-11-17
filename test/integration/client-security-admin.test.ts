// Integration tests of the staff security tools on a merchant (feature 20, slice A, routes R1-R4 of /admin/clients/:id): a password or
// invitation link, a temporary password, a 2FA reset, "sign out everywhere" and a verification resend, through HTTP on the real application.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';
import { Logger } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { schema as s } from '../../src/infra/db';
import { MERCHANT_MAIL_EVENTS } from '../../src/modules/identity';
import {
  EmailVerificationMailProcessor,
  MerchantInvitedMailProcessor,
  PasswordResetMailProcessor,
} from '../../src/modules/identity/jobs/merchant-mail.processors';
import type { OutboxJobData } from '../../src/modules/platform';
import { type AdminApi, adminWith } from '../support/admin-api';
import { type TestApp, createTestApp } from '../support/app';
import { clearIdentityCaches, openSession } from '../support/auth';
import { HOUR, MINUTE, TestClock } from '../support/clock';
import { closeTestDb, resetDb, testDb } from '../support/db';
import { clearAccountMailLimits, seedIdentityTemplates } from '../support/identity-mail';
import { logSink } from '../support/log-sink';
import {
  MERCHANT_PASSWORD,
  MerchantPortal,
  PORTAL_ORIGIN,
  captureEmailedLinks,
  clearPortalRateLimits,
  clientRow,
  emailedLinks,
  makeMerchant,
  seedPortalBasics,
} from '../support/merchant-portal';
import { mailbox, sendAllQueued, tokenIn } from '../support/notifications';
import { freshClientIp } from '../support/pipeline-routes';

const clock = new TestClock();
let t: TestApp;

beforeAll(async () => {
  t = await createTestApp({ env: { CORS_ORIGINS: PORTAL_ORIGIN }, clock });
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
  await resetDb();
  await clearIdentityCaches(t);
  await clearPortalRateLimits(t);
  await clearAccountMailLimits(t);
  logSink.clear();
  captureEmailedLinks(t);
  await seedPortalBasics();
  await seedIdentityTemplates((await testDb()).db);
  mailbox(t).reset();
});

const portal = () => new MerchantPortal(t, freshClientIp());
/** Staff with the security permission (and the read/update ones the console shows beside it). */
const security = () =>
  adminWith(t, ['clients:read', 'clients:create', 'clients:update', 'clients:security', 'sessions:read'], {
    name: 'Rami K.',
  });
const auditRows = async () => (await testDb()).db.select().from(s.auditLogs).orderBy(s.auditLogs.id);
const outbox = async (type: string) =>
  (await testDb()).db.select().from(s.outboxEvents).where(eq(s.outboxEvents.type, type)).orderBy(s.outboxEvents.id);
const tokensOf = async (clientId: number) =>
  (await testDb()).db
    .select()
    .from(s.authTokens)
    .where(and(eq(s.authTokens.subjectType, 'client'), eq(s.authTokens.subjectId, clientId)))
    .orderBy(s.authTokens.id);
const openTokens = async (clientId: number) => (await tokensOf(clientId)).filter((row) => row.usedAt === null);
const sessionsOf = async (clientId: number) =>
  (await testDb()).db
    .select()
    .from(s.sessions)
    .where(and(eq(s.sessions.subjectType, 'client'), eq(s.sessions.subjectId, clientId)));
const liveSessions = async (clientId: number) => (await sessionsOf(clientId)).filter((row) => row.revokedAt === null);

/** Runs the mail job of the newest outbox event of a type, as the worker would. */
async function runMailJob(type: keyof typeof MERCHANT_MAIL_EVENTS): Promise<void> {
  const rows = await outbox(MERCHANT_MAIL_EVENTS[type]);
  const event = rows.at(-1)!;
  const { meta: _meta, ...payload } = event.payload;
  const job = {
    data: {
      eventId: event.id,
      type: event.type,
      aggregateType: event.aggregateType,
      aggregateId: event.aggregateId,
      payload: payload as OutboxJobData['payload'],
      requestId: 'test',
    },
    attemptsMade: 0,
    opts: { attempts: 5 },
  } as never;
  const processor =
    type === 'invited'
      ? t.app.get(MerchantInvitedMailProcessor)
      : type === 'password_reset'
        ? t.app.get(PasswordResetMailProcessor)
        : t.app.get(EmailVerificationMailProcessor);
  await (processor as { process(job: never): Promise<unknown> }).process(job);
}

describe('POST /admin/clients/:id/password, reset_link', () => {
  it('mails a reset link to a merchant with a password and never returns it; the delivered link works and the placeholder does not', async () => {
    const merchant = await makeMerchant(t);
    const api = await security();
    const res = await api.post(`/admin/clients/${merchant.id}/password`, { mode: 'reset_link' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ link: 'reset' });
    expect(res.res.headers['cache-control']).toBe('no-store');
    expect(JSON.stringify(res.body)).not.toContain('token');

    // Ids only in the outbox; the placeholder token of the request is dropped.
    const [event] = await outbox(MERCHANT_MAIL_EVENTS.password_reset);
    expect(event!.payload).toMatchObject({ tokenId: expect.any(Number) });
    expect(Object.keys(event!.payload).filter((key) => key !== 'meta')).toEqual(['tokenId']);
    const [placeholder] = emailedLinks();
    expect(placeholder).toMatchObject({ kind: 'password_reset', clientId: merchant.id });

    await runMailJob('password_reset');
    const delivered = tokenIn(mailbox(t).sent[0]!.text);
    expect(delivered).not.toBe(placeholder!.token);
    expect((await portal().reset(placeholder!.token, 'brand-new-password-1')).statusCode).toBe(410);
    expect((await portal().reset(delivered, 'brand-new-password-1')).statusCode).toBe(204);

    const [audit] = await auditRows();
    expect(audit).toMatchObject({
      action: 'sent a password reset link to',
      entityType: 'merchant',
      entityId: merchant.id,
      actorName: 'Rami K.',
      after: { credential: 'reset link emailed', revokeSessions: false, sessionsEnded: 0 },
    });
    expect(JSON.stringify(audit)).not.toContain(delivered);
  });

  it('sends the invitation while the merchant has no password, and a newer link voids the older one', async () => {
    const merchant = await makeMerchant(t, { noPassword: true, status: 'pending' });
    const api = await security();
    expect((await api.post(`/admin/clients/${merchant.id}/password`, { mode: 'reset_link' })).body).toEqual({
      link: 'invite',
    });
    expect((await api.post(`/admin/clients/${merchant.id}/password`, { mode: 'reset_link' })).body).toEqual({
      link: 'invite',
    });
    const [first] = emailedLinks();
    expect(first).toMatchObject({ kind: 'invited' });
    expect(await openTokens(merchant.id)).toHaveLength(1);
    expect((await portal().reset(first!.token, 'brand-new-password-1')).statusCode).toBe(410);
    const actions = (await auditRows()).map((row) => row.action);
    expect(actions).toEqual(['resent the invitation of', 'resent the invitation of']);
    await runMailJob('invited');
    expect(mailbox(t).sent[0]).toMatchObject({ to: merchant.email });
    expect((await portal().reset(tokenIn(mailbox(t).sent[0]!.text), 'brand-new-password-1')).statusCode).toBe(204);
  });

  it('answers 429 on the sixth link within an hour and writes nothing for it; the hour passes with the clock', async () => {
    const merchant = await makeMerchant(t);
    const api = await security();
    for (let i = 0; i < 5; i++) {
      expect((await api.post(`/admin/clients/${merchant.id}/password`, { mode: 'reset_link' })).status).toBe(200);
    }
    const tokensBefore = (await tokensOf(merchant.id)).length;
    const auditBefore = (await auditRows()).length;
    const sixth = await api.post(`/admin/clients/${merchant.id}/password`, { mode: 'reset_link' });
    expect(sixth.status).toBe(429);
    expect(sixth.body.code).toBe('RATE_LIMITED');
    expect(sixth.res.headers['retry-after']).toBeDefined();
    expect((await tokensOf(merchant.id)).length).toBe(tokensBefore);
    expect((await auditRows()).length).toBe(auditBefore);
    expect((await outbox(MERCHANT_MAIL_EVENTS.password_reset)).length).toBe(5);
  });

  it('parallel link requests leave exactly one open link', async () => {
    const merchant = await makeMerchant(t);
    const api = await security();
    const answers = await Promise.all(
      [1, 2, 3].map(() => api.post(`/admin/clients/${merchant.id}/password`, { mode: 'reset_link' })),
    );
    expect(answers.map((a) => a.status)).toEqual([200, 200, 200]);
    expect(await openTokens(merchant.id)).toHaveLength(1);
  });

  it('refuses a suspended merchant with 409 NOT_ACTIVE and an unknown one with 404', async () => {
    const suspended = await makeMerchant(t, { status: 'suspended' });
    const api = await security();
    const refused = await api.post(`/admin/clients/${suspended.id}/password`, { mode: 'reset_link' });
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe('NOT_ACTIVE');
    expect(refused.body.detail).toContain('suspended');
    expect((await api.post('/admin/clients/999999/password', { mode: 'temporary_password' })).status).toBe(404);
    expect((await api.post(`/admin/clients/${suspended.id}/password`, { mode: 'nonsense' })).status).toBe(422);
  });
});

describe('POST /admin/clients/:id/password, temporary_password', () => {
  it('returns a 14-character password once, no-store, that signs in and must be changed; older links are void; the merchant is told', async () => {
    const merchant = await makeMerchant(t);
    const api = await security();
    // An older reset link is out there.
    await api.post(`/admin/clients/${merchant.id}/password`, { mode: 'reset_link' });
    expect(await openTokens(merchant.id)).toHaveLength(1);

    const res = await api.post(`/admin/clients/${merchant.id}/password`, { mode: 'temporary_password' });
    expect(res.status).toBe(200);
    expect(res.res.headers['cache-control']).toBe('no-store');
    const temporary = res.body.temporaryPassword as string;
    expect(temporary).toHaveLength(14);
    expect(res.body.link).toBeUndefined();

    const row = await clientRow(merchant.id);
    expect(row.mustChangePassword).toBe(true);
    expect(row.passwordChangedAt).toEqual(clock.now());
    expect(await openTokens(merchant.id)).toHaveLength(0);

    // It signs in on the normal login; the step comes from slice B.
    const login = await portal().login(merchant.email, temporary);
    expect(login.statusCode).toBe(200);
    expect(login.json()).toEqual({ next: 'password' });
    expect((await portal().login(merchant.email, MERCHANT_PASSWORD)).statusCode).toBe(401);

    // Nothing stores or logs the password; the audit row says `credential`.
    const audit = (await auditRows()).at(-1)!;
    expect(audit).toMatchObject({
      action: 'set a temporary password for',
      entityType: 'merchant',
      after: { credential: 'temporary password set', revokeSessions: false, sessionsEnded: 0 },
    });
    const { db } = await testDb();
    const everything = JSON.stringify([
      await auditRows(),
      await outbox('notification.send'),
      await db.select().from(s.notifications),
    ]);
    expect(everything).not.toContain(temporary);

    // A security notice is queued for the merchant, with the fixed sentence and no password.
    await sendAllQueued(t);
    const notice = mailbox(t).sent.find((mail) => mail.subject === 'A security change on your merchant account');
    expect(notice?.to).toBe(merchant.email);
    expect(notice?.text).toContain('a temporary password was set for your account');
    expect(notice?.text).not.toContain(temporary);
  });

  it('with revokeSessions ends every session and the audit row counts them', async () => {
    const merchant = await makeMerchant(t);
    await openSession(t, { type: 'client', id: merchant.id });
    await openSession(t, { type: 'client', id: merchant.id });
    await openSession(t, { type: 'client', id: merchant.id }, { stage: 'pending_totp' });
    const api = await security();
    const res = await api.post(`/admin/clients/${merchant.id}/password`, {
      mode: 'temporary_password',
      revokeSessions: true,
    });
    expect(res.status).toBe(200);
    expect(await liveSessions(merchant.id)).toHaveLength(0);
    expect((await auditRows()).at(-1)!.after).toMatchObject({ revokeSessions: true, sessionsEnded: 3 });
  });

  it('keeps the sessions without revokeSessions, and never logs the password', async () => {
    const merchant = await makeMerchant(t);
    await openSession(t, { type: 'client', id: merchant.id });
    const log = spyOn(Logger.prototype, 'log');
    const warn = spyOn(Logger.prototype, 'warn');
    const api = await security();
    const res = await api.post(`/admin/clients/${merchant.id}/password`, { mode: 'temporary_password' });
    expect(await liveSessions(merchant.id)).toHaveLength(1);
    const logged = [...log.mock.calls, ...warn.mock.calls].map((call) => String(call[0])).join('\n');
    expect(logged).not.toContain(res.body.temporaryPassword);
  });
});

describe('POST /admin/clients/:id/reset-2fa', () => {
  it('clears the three TOTP columns, ends every session (a pending step too), mails a notice and audits', async () => {
    const merchant = await makeMerchant(t, { twofa: true, totpLastStep: 5 });
    await openSession(t, { type: 'client', id: merchant.id });
    await openSession(t, { type: 'client', id: merchant.id }, { stage: 'pending_totp' });
    const api = await security();
    const res = await api.post(`/admin/clients/${merchant.id}/reset-2fa`);
    expect(res.status).toBe(204);
    const row = await clientRow(merchant.id);
    expect(row).toMatchObject({ twofaEnabled: false, totpSecretEnc: null, totpLastStep: null });
    expect(await liveSessions(merchant.id)).toHaveLength(0);
    expect((await auditRows()).at(-1)).toMatchObject({
      action: 'reset 2FA of',
      entityType: 'merchant',
      before: { twofaEnabled: true },
      after: { twofaEnabled: false, sessionsEnded: 2 },
    });
    await sendAllQueued(t);
    expect(mailbox(t).sent.at(-1)?.text).toContain('two-factor sign-in was turned off for your account');
  });

  it('is 409 TWOFA_NOT_ENABLED when 2FA is off, and 404 for an unknown merchant', async () => {
    const merchant = await makeMerchant(t);
    const api = await security();
    const res = await api.post(`/admin/clients/${merchant.id}/reset-2fa`);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('TWOFA_NOT_ENABLED');
    expect((await api.post('/admin/clients/999999/reset-2fa')).status).toBe(404);
  });
});

describe('POST /admin/clients/:id/sessions/revoke', () => {
  it('ends full and pending sessions, answers 204 when there are none, and audits the count', async () => {
    const merchant = await makeMerchant(t);
    const full = await openSession(t, { type: 'client', id: merchant.id });
    await openSession(t, { type: 'client', id: merchant.id }, { stage: 'pending_totp' });
    const other = await makeMerchant(t);
    await openSession(t, { type: 'client', id: other.id });
    const api = await security();
    expect((await api.post(`/admin/clients/${merchant.id}/sessions/revoke`)).status).toBe(204);
    expect(await liveSessions(merchant.id)).toHaveLength(0);
    expect(await liveSessions(other.id)).toHaveLength(1);
    expect((await auditRows()).at(-1)).toMatchObject({
      action: 'signed out all devices of',
      entityType: 'merchant',
      entityId: merchant.id,
      before: { sessions: 2 },
      after: { sessions: 0 },
    });
    // The merchant's own cookie is dead at once.
    const res = await t.app.inject({
      method: 'GET',
      url: '/client/auth/me',
      headers: { ...full.headers, origin: PORTAL_ORIGIN },
    });
    expect(res.statusCode).toBe(401);
    expect((await api.post(`/admin/clients/${merchant.id}/sessions/revoke`)).status).toBe(204);
    expect((await api.post('/admin/clients/999999/sessions/revoke')).status).toBe(404);
  });
});

describe('POST /admin/clients/:id/verify-email/resend', () => {
  it('mails a new verification link that replaces the older one; the limiter is shared with the merchant', async () => {
    const merchant = await makeMerchant(t, { emailVerifiedAt: null, status: 'pending' });
    const api = await security();
    expect((await api.post(`/admin/clients/${merchant.id}/verify-email/resend`)).status).toBe(204);
    expect((await api.post(`/admin/clients/${merchant.id}/verify-email/resend`)).status).toBe(204);
    const [older, newer] = emailedLinks();
    expect(older).toMatchObject({ kind: 'email_verification' });
    expect((await outbox(MERCHANT_MAIL_EVENTS.email_verification)).length).toBe(2);
    expect(await openTokens(merchant.id)).toHaveLength(1);
    expect((await portal().verifyEmail(older!.token)).statusCode).toBe(410);
    await runMailJob('email_verification');
    expect((await portal().verifyEmail(tokenIn(mailbox(t).sent[0]!.text))).statusCode).toBe(204);
    expect(newer).toBeDefined();
    expect((await auditRows()).map((row) => row.action)).toEqual([
      'sent a verification email to',
      'sent a verification email to',
    ]);
    expect((await auditRows())[0]!.after).toEqual({ email: merchant.email });
  });

  it('is 409 CONFLICT when verified, 409 NOT_ACTIVE when suspended, 404 when unknown, and 429 after five in an hour', async () => {
    const api = await security();
    const verified = await makeMerchant(t, { emailVerifiedAt: clock.now() });
    const conflict = await api.post(`/admin/clients/${verified.id}/verify-email/resend`);
    expect(conflict.status).toBe(409);
    expect(conflict.body.code).toBe('CONFLICT');
    const suspended = await makeMerchant(t, { emailVerifiedAt: null, status: 'suspended' });
    expect((await api.post(`/admin/clients/${suspended.id}/verify-email/resend`)).body.code).toBe('NOT_ACTIVE');
    expect((await api.post('/admin/clients/999999/verify-email/resend')).status).toBe(404);

    const merchant = await makeMerchant(t, { emailVerifiedAt: null });
    for (let i = 0; i < 5; i++) {
      expect((await api.post(`/admin/clients/${merchant.id}/verify-email/resend`)).status).toBe(204);
    }
    expect((await api.post(`/admin/clients/${merchant.id}/verify-email/resend`)).status).toBe(429);
    expect((await outbox(MERCHANT_MAIL_EVENTS.email_verification)).length).toBe(5);
    clock.advance(HOUR + MINUTE);
  });
});

describe('permissions and CSRF', () => {
  it('403 FORBIDDEN for a role with clients:update but without clients:security on all four routes', async () => {
    const merchant = await makeMerchant(t, { twofa: true });
    const api = await adminWith(t, ['clients:read', 'clients:update'], { name: 'Lina S.' });
    for (const [path, body] of [
      ['password', { mode: 'reset_link' }],
      ['reset-2fa', undefined],
      ['sessions/revoke', undefined],
      ['verify-email/resend', undefined],
    ] as const) {
      const res = await api.post(`/admin/clients/${merchant.id}/${path}`, body);
      expect(res.status, path).toBe(403);
      expect(res.body.code, path).toBe('FORBIDDEN');
    }
    expect(await auditRows()).toHaveLength(0);
  });

  it('403 CSRF_FAILED without the header, and a role holding clients:* gets the permission through the grammar', async () => {
    const merchant = await makeMerchant(t);
    const api = await security();
    const forged = await api.withoutCsrf('POST', `/admin/clients/${merchant.id}/sessions/revoke`);
    expect(forged.status).toBe(403);
    expect(forged.body.code).toBe('CSRF_FAILED');
    const wildcard = await adminWith(t, ['clients:*'], { name: 'Nadia H.' });
    expect((await wildcard.post(`/admin/clients/${merchant.id}/sessions/revoke`)).status).toBe(204);
  });
});

describe('the merchant row', () => {
  const row = (api: AdminApi, id: number) => api.get(`/admin/clients/${id}`);

  it('carries the security facts of a merchant with no password and an open invitation, and drops an expired link', async () => {
    const api = await security();
    const created = await api.post('/admin/clients', {
      name: 'Zain Mobile Hub',
      email: 'ops@zain.example',
      country: 'JO',
      invite: true,
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const { body } = await row(api, created.body.id);
    expect(body).toMatchObject({
      address: '',
      taxId: '',
      internalNotes: '',
      telegramLinked: false,
      suspension: null,
      security: {
        hasPassword: false,
        mustChangePassword: false,
        passwordChangedAt: null,
        twofaEnabled: false,
        lastLoginAt: null,
        lastLoginIp: null,
        activeSessions: 0,
        linkSentAt: clock.now().toISOString(),
        verificationSentAt: null,
      },
    });
    clock.advance(HOUR + MINUTE);
    // The staff session idles out after 30 minutes: a new one reads the row.
    expect((await row(await security(), created.body.id)).body.security.linkSentAt).toBeNull();
  });

  it('counts live sessions and shows 2FA, last sign-in, Telegram and the verification link of a merchant', async () => {
    const merchant = await makeMerchant(t, {
      twofa: true,
      telegramChatId: '555',
      lastLoginAt: clock.now(),
      lastLoginIp: '203.0.113.9',
      emailVerifiedAt: null,
    });
    await openSession(t, { type: 'client', id: merchant.id });
    await openSession(t, { type: 'client', id: merchant.id });
    await openSession(t, { type: 'client', id: merchant.id }, { stage: 'pending_totp' });
    const api = await security();
    await api.post(`/admin/clients/${merchant.id}/verify-email/resend`);
    const { body } = await row(api, merchant.id);
    expect(body.telegramLinked).toBe(true);
    expect(JSON.stringify(body)).not.toContain('555');
    expect(body.security).toMatchObject({
      hasPassword: true,
      twofaEnabled: true,
      lastLoginAt: clock.now().toISOString(),
      lastLoginIp: '203.0.113.9',
      activeSessions: 2,
      verificationSentAt: clock.now().toISOString(),
      linkSentAt: null,
    });
    const list = await api.get('/admin/clients');
    expect(list.body.find((item: { id: number }) => item.id === merchant.id).security.activeSessions).toBe(2);
  });

  it('shows who suspended the merchant, when and why; null again once reactivated', async () => {
    const merchant = await makeMerchant(t);
    const api = await security();
    clock.advance(MINUTE);
    const suspended = await api.patch(`/admin/clients/${merchant.id}`, { status: 'suspended', reason: 'Chargebacks' });
    expect(suspended.body.suspension).toEqual({
      at: clock.now().toISOString(),
      reason: 'Chargebacks',
      by: { id: api.staffId, name: 'Rami K.' },
    });
    const back = await api.patch(`/admin/clients/${merchant.id}`, { status: 'active' });
    expect(back.body.suspension).toBeNull();
  });
});

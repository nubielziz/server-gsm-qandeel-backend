// Integration tests of the transactional emails staff actions send a merchant (feature 20, slice B): approval, suspension, reactivation,
// the security notice and the one English template of each (decision 039), plus what a suspension does to open links and to the merchant's
// sign-in.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, mock } from 'bun:test';
import { and, eq } from 'drizzle-orm';
import { DbService, schema as s } from '@src/infra/db';
import {
  MerchantLifecycleMails,
  SECURITY_NOTICE_PHRASES,
  type SecurityNoticeKind,
} from '@src/modules/identity/application/mail/merchant-lifecycle-mails';
import { type AdminApi, adminWith } from '../../support/admin-api';
import { type TestApp, createTestApp } from '../../support/app';
import { clearIdentityCaches } from '../../support/auth';
import { TestClock } from '../../support/clock';
import { closeTestDb, resetDb, testDb } from '../../support/db';
import { clearAccountMailLimits, seedIdentityTemplates } from '../../support/identity-mail';
import { logSink } from '../../support/log-sink';
import {
  MerchantPortal,
  PORTAL_ORIGIN,
  captureEmailedLinks,
  clearPortalRateLimits,
  clientRow,
  makeMerchant,
  seedPortalBasics,
} from '../../support/merchant-portal';
import { mailbox, notificationRows, sendAllQueued } from '../../support/notifications';
import { freshClientIp } from '../../support/pipeline-routes';

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

const staff = (): Promise<AdminApi> => adminWith(t, ['*'], { name: 'Rami K.' });
const portal = () => new MerchantPortal(t, freshClientIp());
const rows = async () => notificationRows((await testDb()).db);
const tokensOf = async (clientId: number) =>
  (await testDb()).db
    .select()
    .from(s.authTokens)
    .where(and(eq(s.authTokens.subjectType, 'client'), eq(s.authTokens.subjectId, clientId)));

describe('approval and reactivation', () => {
  it('approving a pending merchant writes one merchant.approved notification and mails it in English', async () => {
    const merchant = await makeMerchant(t, { status: 'pending', name: 'Zain Mobile Hub' });
    const api = await staff();
    expect((await api.patch(`/admin/clients/${merchant.id}`, { status: 'active' })).status).toBe(200);
    const sent = await rows();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      event: 'merchant.approved',
      recipientType: 'client',
      recipientId: merchant.id,
      channel: 'email',
    });

    await sendAllQueued(t);
    const [mail] = mailbox(t).sent;
    expect(mail).toMatchObject({ to: merchant.email, subject: 'Your merchant account is approved' });
    expect(mail!.text).toContain('Hi Zain Mobile Hub,');
    expect(mail!.text).toContain(t.config.http.portalBaseUrl);
  });

  it('reactivating a suspended merchant writes one merchant.reactivated notification, and every merchant gets the one template', async () => {
    const first = await makeMerchant(t, { status: 'suspended', name: 'Zain Mobile Hub' });
    const second = await makeMerchant(t, { status: 'suspended', name: 'Cedar Phones' });
    const api = await staff();
    await api.patch(`/admin/clients/${first.id}`, { status: 'active' });
    await api.patch(`/admin/clients/${second.id}`, { status: 'active' });
    expect((await rows()).map((row) => row.event)).toEqual(['merchant.reactivated', 'merchant.reactivated']);

    await sendAllQueued(t);
    const byTo = new Map(mailbox(t).sent.map((mail) => [mail.to, mail]));
    expect(byTo.get(first.email)?.subject).toBe('Your merchant account is active again');
    expect(byTo.get(first.email)?.text).toContain('Hi Zain Mobile Hub,');
    expect(byTo.get(second.email)?.subject).toBe('Your merchant account is active again');
    expect(byTo.get(second.email)?.text).toContain('Hi Cedar Phones,');
    expect(byTo.get(second.email)?.html).toBeUndefined();
  });

  it('a missing or switched-off template sends nothing while the request still succeeds (nothing stands in for it)', async () => {
    const { db } = await testDb();
    const merchant = await makeMerchant(t, { status: 'pending' });
    const api = await staff();
    // The approval's one template is gone: no notification, and the approval itself goes through.
    await db.delete(s.notificationTemplates).where(eq(s.notificationTemplates.event, 'merchant.approved'));
    expect((await api.patch(`/admin/clients/${merchant.id}`, { status: 'active' })).status).toBe(200);
    expect(await rows()).toEqual([]);
    await sendAllQueued(t);
    expect(mailbox(t).sent).toEqual([]);
    expect((await clientRow(merchant.id)).status).toBe('active');

    // Switched off: nothing is queued at all.
    const other = await makeMerchant(t, { status: 'suspended' });
    await db
      .update(s.notificationTemplates)
      .set({ isActive: false })
      .where(eq(s.notificationTemplates.event, 'merchant.reactivated'));
    const before = (await rows()).length;
    expect((await api.patch(`/admin/clients/${other.id}`, { status: 'active' })).status).toBe(200);
    expect((await rows()).length).toBe(before);
    await sendAllQueued(t);
    expect(mailbox(t).sent).toEqual([]);
    expect((await clientRow(other.id)).status).toBe('active');
  });
});

describe('suspension', () => {
  it('uses every open link up, ends the sessions, mails the merchant although it is suspended, and never sends the staff reason', async () => {
    const merchant = await makeMerchant(t, { emailVerifiedAt: null });
    const api = await staff();
    await api.post(`/admin/clients/${merchant.id}/password`, { mode: 'reset_link' });
    await api.post(`/admin/clients/${merchant.id}/verify-email/resend`);
    expect((await tokensOf(merchant.id)).filter((row) => row.usedAt === null)).toHaveLength(2);
    const session = portal();
    await session.login(merchant.email);
    mailbox(t).reset();

    const reason = 'Chargebacks above the agreed limit';
    const res = await api.patch(`/admin/clients/${merchant.id}`, { status: 'suspended', reason });
    expect(res.status).toBe(200);
    expect(res.body.suspension).toMatchObject({ reason, by: { name: 'Rami K.' } });
    expect((await tokensOf(merchant.id)).filter((row) => row.usedAt === null)).toEqual([]);
    expect((await session.me()).statusCode).toBe(401);

    const suspended = (await rows()).filter((row) => row.event === 'merchant.suspended');
    expect(suspended).toHaveLength(1);
    await sendAllQueued(t);
    const mail = mailbox(t).sent.find((m) => m.subject === 'Your merchant account is suspended');
    expect(mail?.to).toBe(merchant.email);
    expect(mail?.text).not.toContain(reason);
    expect(JSON.stringify(await rows())).not.toContain(reason);
  });

  it('a pending applicant can be suspended (declined) and then cannot sign in; pending to pending and active to pending stay refused', async () => {
    const applicant = await makeMerchant(t, { status: 'pending' });
    const api = await staff();
    const refused = await api.patch(`/admin/clients/${applicant.id}`, { status: 'pending' });
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe('INVALID_TRANSITION');
    const declined = await api.patch(`/admin/clients/${applicant.id}`, {
      status: 'suspended',
      reason: 'Documents are missing',
    });
    expect(declined.status).toBe(200);
    expect(declined.body.status).toBe('suspended');
    const login = await portal().login(applicant.email);
    expect(login.statusCode).toBe(403);
    expect(login.json().code).toBe('ACCOUNT_SUSPENDED');
    expect((await rows()).map((row) => row.event)).toEqual(['merchant.suspended']);

    const active = await makeMerchant(t);
    const back = await api.patch(`/admin/clients/${active.id}`, { status: 'pending' });
    expect(back.status).toBe(409);
    expect(back.body.code).toBe('INVALID_TRANSITION');
  });

  it('a link sent before the suspension is dead after the reactivation (410)', async () => {
    const merchant = await makeMerchant(t);
    const api = await staff();
    await api.post(`/admin/clients/${merchant.id}/password`, { mode: 'reset_link' });
    const { db } = await testDb();
    const [link] = await db.select().from(s.authTokens).where(eq(s.authTokens.subjectId, merchant.id));
    expect(link!.usedAt).toBeNull();
    await api.patch(`/admin/clients/${merchant.id}`, { status: 'suspended', reason: 'Under review' });
    await api.patch(`/admin/clients/${merchant.id}`, { status: 'active' });
    const [after] = await db.select().from(s.authTokens).where(eq(s.authTokens.id, link!.id));
    expect(after!.usedAt).not.toBeNull();
  });
});

describe('the security notice', () => {
  const KINDS: readonly SecurityNoticeKind[] = ['temporary_password', 'twofa_reset', 'api_key_created'];

  it('names the fixed sentence of the action, the same for every merchant, never anything else', async () => {
    const first = await makeMerchant(t, { name: 'English Shop' });
    const second = await makeMerchant(t, { name: 'Cedar Phones' });
    const mails = t.app.get(MerchantLifecycleMails);
    const db = t.app.get(DbService);
    for (const kind of KINDS) {
      await db.runInTransaction(async (work) => {
        await mails.securityNotice(work, first.row, kind);
        await mails.securityNotice(work, second.row, kind);
      });
    }
    await sendAllQueued(t);
    const sent = mailbox(t).sent;
    expect(sent).toHaveLength(6);
    for (const kind of KINDS) {
      for (const merchant of [first, second]) {
        const mail = sent.find((m) => m.to === merchant.email && m.text.includes(SECURITY_NOTICE_PHRASES[kind]));
        expect(mail?.subject, `${kind} ${merchant.email}`).toBe('A security change on your merchant account');
        expect(mail?.text).toBe(
          `Hi ${merchant.row.name},\n\nOur support team made this change to your account: ${SECURITY_NOTICE_PHRASES[kind]}.\n\n` +
            'If you did not ask for it, reply to this email or contact our support team at once.',
        );
      }
    }
  });

  it('is sent by the temporary password and the 2FA reset routes', async () => {
    const withTwoFactor = await makeMerchant(t, { twofa: true });
    const api = await staff();
    await api.post(`/admin/clients/${withTwoFactor.id}/reset-2fa`);
    await api.post(`/admin/clients/${withTwoFactor.id}/password`, { mode: 'temporary_password' });
    await sendAllQueued(t);
    const texts = mailbox(t).sent.map((mail) => mail.text);
    expect(texts.some((text) => text.includes(SECURITY_NOTICE_PHRASES.twofa_reset))).toBe(true);
    expect(texts.some((text) => text.includes(SECURITY_NOTICE_PHRASES.temporary_password))).toBe(true);
  });
});

describe('the templates of merchant mail', () => {
  it('every lifecycle event has one English template that renders, with every placeholder filled', async () => {
    const merchant = await makeMerchant(t, { name: 'Zain Mobile Hub' });
    const mails = t.app.get(MerchantLifecycleMails);
    await t.app.get(DbService).runInTransaction(async (work) => {
      await mails.approved(work, merchant.row);
      await mails.suspended(work, merchant.row);
      await mails.reactivated(work, merchant.row);
      await mails.kycDecided(work, merchant.row, 'approved', '');
      await mails.kycDecided(work, merchant.row, 'rejected', 'The photo is not readable.');
      await mails.securityNotice(work, merchant.row, 'twofa_reset');
    });
    await sendAllQueued(t);
    const sent = mailbox(t).sent;
    expect(sent.map((mail) => mail.subject)).toEqual([
      'Your merchant account is approved',
      'Your merchant account is suspended',
      'Your merchant account is active again',
      'Your identity verification is approved',
      'Your identity verification needs attention',
      'A security change on your merchant account',
    ]);
    // Plain text mails: no HTML part, and no placeholder is left unfilled.
    expect(sent.every((mail) => mail.html === undefined)).toBe(true);
    expect(sent.some((mail) => /\{\{/.test(mail.text) || /\{\{/.test(mail.subject))).toBe(false);
    const rejected = sent.find((mail) => mail.subject === 'Your identity verification needs attention');
    expect(rejected?.text).toContain('Reason: The photo is not readable.');
  });
});

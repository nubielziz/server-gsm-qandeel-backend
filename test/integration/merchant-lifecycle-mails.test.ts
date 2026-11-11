// Integration tests of the transactional emails staff actions send a merchant (feature 20, slice B): approval, suspension, reactivation,
// the security notice and the language of each, plus what a suspension does to open links and to the merchant's sign-in.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, mock } from 'bun:test';
import { and, eq } from 'drizzle-orm';
import { DbService, schema as s } from '../../src/infra/db';
import {
  MerchantLifecycleMails,
  SECURITY_NOTICE_PHRASES,
  type SecurityNoticeKind,
} from '../../src/modules/identity/application/mail/merchant-lifecycle-mails';
import { type AdminApi, adminWith } from '../support/admin-api';
import { type TestApp, createTestApp } from '../support/app';
import { clearIdentityCaches } from '../support/auth';
import { TestClock } from '../support/clock';
import { closeTestDb, resetDb, testDb } from '../support/db';
import { clearAccountMailLimits, seedIdentityTemplates } from '../support/identity-mail';
import { logSink } from '../support/log-sink';
import {
  MerchantPortal,
  PORTAL_ORIGIN,
  captureEmailedLinks,
  clearPortalRateLimits,
  clientRow,
  makeMerchant,
  seedPortalBasics,
} from '../support/merchant-portal';
import { mailbox, notificationRows, sendAllQueued } from '../support/notifications';
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

  it('reactivating a suspended merchant writes one merchant.reactivated notification, in the merchant language', async () => {
    const english = await makeMerchant(t, { status: 'suspended' });
    const arabic = await makeMerchant(t, { status: 'suspended', locale: 'ar', name: 'متجر زين' });
    const api = await staff();
    await api.patch(`/admin/clients/${english.id}`, { status: 'active' });
    await api.patch(`/admin/clients/${arabic.id}`, { status: 'active' });
    expect((await rows()).map((row) => row.event)).toEqual(['merchant.reactivated', 'merchant.reactivated']);

    await sendAllQueued(t);
    const byTo = new Map(mailbox(t).sent.map((mail) => [mail.to, mail]));
    expect(byTo.get(english.email)?.subject).toBe('Your merchant account is active again');
    expect(byTo.get(arabic.email)?.subject).toBe('تمت إعادة تفعيل حساب التاجر الخاص بك');
    expect(byTo.get(arabic.email)?.text).toContain('مرحباً متجر زين،');
  });

  it('a language with no template falls back to English, and a switched-off template sends nothing while the request still succeeds', async () => {
    const { db } = await testDb();
    const merchant = await makeMerchant(t, { status: 'pending' });
    const api = await staff();
    // Only the Arabic row is off: the merchant is Arabic, so the English template answers.
    await db
      .update(s.notificationTemplates)
      .set({ isActive: false })
      .where(and(eq(s.notificationTemplates.event, 'merchant.approved'), eq(s.notificationTemplates.locale, 'ar')));
    await db.update(s.clients).set({ locale: 'ar' }).where(eq(s.clients.id, merchant.id));
    expect((await api.patch(`/admin/clients/${merchant.id}`, { status: 'active' })).status).toBe(200);
    await sendAllQueued(t);
    expect(mailbox(t).sent.map((mail) => mail.subject)).toEqual(['Your merchant account is approved']);

    // Every language off: nothing is queued at all.
    mailbox(t).reset();
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

  it('names a fixed sentence per action in the merchant language, never anything else', async () => {
    const english = await makeMerchant(t, { name: 'English Shop' });
    const arabic = await makeMerchant(t, { name: 'متجر', locale: 'ar' });
    const mails = t.app.get(MerchantLifecycleMails);
    const db = t.app.get(DbService);
    for (const kind of KINDS) {
      await db.runInTransaction(async (work) => {
        await mails.securityNotice(work, english.row, kind);
        await mails.securityNotice(work, arabic.row, kind);
      });
    }
    await sendAllQueued(t);
    const sent = mailbox(t).sent;
    expect(sent).toHaveLength(6);
    for (const kind of KINDS) {
      const en = sent.find((mail) => mail.to === english.email && mail.text.includes(SECURITY_NOTICE_PHRASES[kind].en));
      const ar = sent.find((mail) => mail.to === arabic.email && mail.text.includes(SECURITY_NOTICE_PHRASES[kind].ar));
      expect(en?.subject).toBe('A security change on your merchant account');
      expect(ar?.subject).toBe('تغيير أمني في حساب التاجر الخاص بك');
    }
  });

  it('is sent by the temporary password and the 2FA reset routes', async () => {
    const withTwoFactor = await makeMerchant(t, { twofa: true });
    const api = await staff();
    await api.post(`/admin/clients/${withTwoFactor.id}/reset-2fa`);
    await api.post(`/admin/clients/${withTwoFactor.id}/password`, { mode: 'temporary_password' });
    await sendAllQueued(t);
    const texts = mailbox(t).sent.map((mail) => mail.text);
    expect(texts.some((text) => text.includes(SECURITY_NOTICE_PHRASES.twofa_reset.en))).toBe(true);
    expect(texts.some((text) => text.includes(SECURITY_NOTICE_PHRASES.temporary_password.en))).toBe(true);
  });
});

describe('the language of merchant mail', () => {
  it('every lifecycle event has an English and an Arabic template that renders', async () => {
    const english = await makeMerchant(t);
    const arabic = await makeMerchant(t, { locale: 'ar' });
    const mails = t.app.get(MerchantLifecycleMails);
    await t.app.get(DbService).runInTransaction(async (work) => {
      for (const client of [english.row, arabic.row]) {
        await mails.approved(work, client);
        await mails.suspended(work, client);
        await mails.reactivated(work, client);
        await mails.kycDecided(work, client, 'approved', '');
        await mails.kycDecided(work, client, 'rejected', 'The photo is not readable.');
        await mails.securityNotice(work, client, 'twofa_reset');
      }
    });
    await sendAllQueued(t);
    const sent = mailbox(t).sent;
    expect(sent).toHaveLength(12);
    expect(sent.filter((mail) => mail.to === english.email).every((mail) => /^[\x20-\x7e]+$/.test(mail.subject))).toBe(
      true,
    );
    expect(sent.filter((mail) => mail.to === arabic.email).every((mail) => /[؀-ۿ]/.test(mail.subject))).toBe(true);
    // No placeholder is left unfilled.
    expect(sent.some((mail) => /\{\{/.test(mail.text) || /\{\{/.test(mail.subject))).toBe(false);
    const rejected = sent.find((mail) => mail.to === arabic.email && mail.subject === 'توثيق هويتك يحتاج إلى مراجعة');
    expect(rejected?.text).toContain('The photo is not readable.');
  });
});

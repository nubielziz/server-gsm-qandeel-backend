// Integration tests of the transactional emails staff actions send a merchant (feature 20, slice B): suspension, reactivation,
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
import { makeAccount } from '../../support/accounts';
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
import { expectRejection } from '../../support/rejection';

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
    .where(and(eq(s.authTokens.subjectType, 'account'), eq(s.authTokens.subjectId, clientId)));

describe('activation and reactivation', () => {
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
    // The merchant pages live under the signed-in area of the shop (decision 064), never under the retired /merchant path.
    expect(byTo.get(first.email)?.text).toContain(`${t.config.http.storeBaseUrl}/account`);
    expect(byTo.get(first.email)?.text).not.toContain('/merchant');
    expect(byTo.get(second.email)?.subject).toBe('Your merchant account is active again');
    expect(byTo.get(second.email)?.text).toContain('Hi Cedar Phones,');
    expect(byTo.get(second.email)?.html).toBeUndefined();
  });

  it('a missing or switched-off template sends nothing while the request still succeeds (nothing stands in for it)', async () => {
    const { db } = await testDb();
    const api = await staff();
    // The suspension's one template is gone: no notification, and the suspension itself goes through.
    const gone = await makeMerchant(t);
    await db.delete(s.notificationTemplates).where(eq(s.notificationTemplates.event, 'merchant.suspended'));
    expect((await api.patch(`/admin/clients/${gone.id}`, { status: 'suspended', reason: 'Under review' })).status).toBe(
      200,
    );
    expect(await rows()).toEqual([]);
    await sendAllQueued(t);
    expect(mailbox(t).sent).toEqual([]);
    expect((await clientRow(gone.id)).status).toBe('suspended');

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

  it('a merchant that has not signed in yet can be suspended and then cannot sign in', async () => {
    const applicant = await makeMerchant(t);
    const api = await staff();
    const declined = await api.patch(`/admin/clients/${applicant.id}`, {
      status: 'suspended',
      reason: 'Under review',
    });
    expect(declined.status).toBe(200);
    expect(declined.body.status).toBe('suspended');
    const login = await portal().login(applicant.email);
    expect(login.statusCode).toBe(403);
    expect(login.json().code).toBe('ACCOUNT_SUSPENDED');
    expect((await rows()).map((row) => row.event)).toEqual(['merchant.suspended']);
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
  const KINDS: readonly SecurityNoticeKind[] = [
    'temporary_password',
    'twofa_reset',
    'api_key_created',
    // Decision 047: the notice a staff change of the merchant's email sends (to the address before the change).
    'email_changed',
    'api_key_changed',
  ];

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
    expect(sent).toHaveLength(KINDS.length * 2);
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

  it('sends the security notice with its shipped text when its template is switched off or deleted (decision 047)', async () => {
    const { db } = await testDb();
    const merchant = await makeMerchant(t, { twofa: true });
    const api = await staff();
    const notice = eq(s.notificationTemplates.event, 'merchant.security_notice');
    await db.update(s.notificationTemplates).set({ isActive: false }).where(notice);
    expect((await api.post(`/admin/clients/${merchant.id}/reset-2fa`)).status).toBeLessThan(300);
    expect(await rows()).toHaveLength(1);
    await sendAllQueued(t);
    expect(mailbox(t).sent).toHaveLength(1);
    expect(mailbox(t).sent[0]).toMatchObject({
      to: merchant.email,
      subject: 'A security change on your merchant account',
    });
    expect(mailbox(t).sent[0]!.text).toContain(SECURITY_NOTICE_PHRASES.twofa_reset);
    await db.delete(s.notificationTemplates).where(notice);
    expect(
      (await api.post(`/admin/clients/${merchant.id}/password`, { mode: 'temporary_password' })).status,
    ).toBeLessThan(300);
    await sendAllQueued(t);
    expect(mailbox(t).sent).toHaveLength(2);
    expect(mailbox(t).sent[1]!.text).toContain(SECURITY_NOTICE_PHRASES.temporary_password);
    // The words come from the shipped text, so the logged warning names the reason, not the text.
    const warnings = logSink.lines.filter(
      (line) => typeof line.msg === 'string' && line.msg.includes('the shipped text is used'),
    );
    expect(warnings.map((line) => line.msg as string).join('\n')).toContain('no stored template');
    expect(warnings.map((line) => line.msg as string).join('\n')).not.toContain('Our support team');
  });
});

describe('the templates of merchant mail', () => {
  it('every lifecycle event has one English template that renders, with every placeholder filled', async () => {
    const merchant = await makeMerchant(t, { name: 'Zain Mobile Hub' });
    const mails = t.app.get(MerchantLifecycleMails);
    await t.app.get(DbService).runInTransaction(async (work) => {
      await mails.suspended(work, merchant.row);
      await mails.reactivated(work, merchant.row);
      await mails.securityNotice(work, merchant.row, 'twofa_reset');
    });
    await sendAllQueued(t);
    const sent = mailbox(t).sent;
    expect(sent.map((mail) => mail.subject)).toEqual([
      'Your merchant account is suspended',
      'Your merchant account is active again',
      'A security change on your merchant account',
    ]);
    // Plain text mails: no HTML part, and no placeholder is left unfilled.
    expect(sent.every((mail) => mail.html === undefined)).toBe(true);
    expect(sent.some((mail) => /\{\{/.test(mail.text) || /\{\{/.test(mail.subject))).toBe(false);
  });
});

describe('the suspension mails are merchant mails (decision 064)', () => {
  it('suspends and reactivates a retail account without a mail: 200, the status changes, no notification row', async () => {
    const shopper = await makeAccount(t, { rank: 'retail', name: 'Sam Shopper' });
    const api = await staff();
    const suspended = await api.patch(`/admin/clients/${shopper.id}`, { status: 'suspended', reason: 'Under review' });
    expect(suspended.status).toBe(200);
    expect(suspended.body.status).toBe('suspended');
    expect((await clientRow(shopper.id)).status).toBe('suspended');
    const reactivated = await api.patch(`/admin/clients/${shopper.id}`, { status: 'active' });
    expect(reactivated.status).toBe(200);
    expect((await clientRow(shopper.id)).status).toBe('active');
    expect(await rows()).toEqual([]);
    await sendAllQueued(t);
    expect(mailbox(t).sent).toEqual([]);
  });

  it('still mails a merchant rank on the same two changes', async () => {
    const merchant = await makeMerchant(t, { name: 'Zain Mobile Hub' });
    const api = await staff();
    await api.patch(`/admin/clients/${merchant.id}`, { status: 'suspended', reason: 'Under review' });
    await api.patch(`/admin/clients/${merchant.id}`, { status: 'active' });
    expect((await rows()).map((row) => [row.event, row.recipientId])).toEqual([
      ['merchant.suspended', merchant.id],
      ['merchant.reactivated', merchant.id],
    ]);
  });
});

describe('the family of a security notice follows the rank kind (decision 064)', () => {
  it('writes merchant.security_notice for a merchant rank and customer.security_notice for a retail rank, both for the account', async () => {
    const merchant = await makeMerchant(t, { name: 'Zain Mobile Hub' });
    const shopper = await makeAccount(t, { rank: 'retail', name: 'Sam Shopper' });
    const mails = t.app.get(MerchantLifecycleMails);
    await t.app.get(DbService).runInTransaction(async (work) => {
      await mails.securityNotice(work, { ...merchant.row, rankKind: 'merchant' }, 'twofa_reset');
      await mails.securityNotice(work, { id: shopper.id, name: shopper.row.name, rankKind: 'retail' }, 'twofa_reset');
    });
    expect((await rows()).map((row) => [row.event, row.recipientType, row.recipientId])).toEqual([
      ['merchant.security_notice', 'account', merchant.id],
      ['customer.security_notice', 'account', shopper.id],
    ]);
    await sendAllQueued(t);
    const byTo = new Map(mailbox(t).sent.map((mail) => [mail.to, mail]));
    expect(byTo.get(merchant.email)?.subject).toBe('A security change on your merchant account');
    expect(byTo.get(shopper.email)?.subject).toBe('A security change on your account');
    expect(byTo.get(shopper.email)?.text).toContain(SECURITY_NOTICE_PHRASES.twofa_reset);
    expect(byTo.get(shopper.email)?.text).toContain('Hi Sam Shopper,');
  });

  it('refuses an API key notice for a retail rank: it holds no key', async () => {
    const shopper = await makeAccount(t, { rank: 'retail' });
    const mails = t.app.get(MerchantLifecycleMails);
    await expectRejection(
      t.app
        .get(DbService)
        .runInTransaction((work) =>
          mails.securityNotice(work, { id: shopper.id, name: shopper.row.name, rankKind: 'retail' }, 'api_key_created'),
        ),
      'does not exist for a retail account',
    );
  });
});

// Feature 20 as one story, in order (not a map scenario): invite, resend, password, approve, sign in, change the email, verify, temporary
// password and forced change, suspend, reactivate, and the audit history that tells it. Steps share state like a scenario file.
// Step 11 is the staff-made API key of slice D.
import { afterAll, beforeAll, describe, expect, it, mock } from 'bun:test';
import { eq } from 'drizzle-orm';
import { schema as s } from '@src/infra/db';
import { type AdminApi, adminWith } from '../../support/admin-api';
import { type TestApp, createTestApp } from '../../support/app';
import { clearIdentityCaches } from '../../support/auth';
import { closeTestDb, resetDb, testDb } from '../../support/db';
import { insertUsd } from '../../support/fixtures';
import { clearAccountMailLimits, runMerchantMailJob, seedIdentityTemplates } from '../../support/identity-mail';
import {
  MerchantPortal,
  PORTAL_ORIGIN,
  captureEmailedLinks,
  clearPortalRateLimits,
  clientRow,
} from '../../support/merchant-portal';
import { mailbox, sendAllQueued, tokenIn } from '../../support/notifications';
import { TestClock } from '../../support/clock';
import { freshClientIp } from '../../support/pipeline-routes';

const clock = new TestClock();
let t: TestApp;
let api: AdminApi;
let merchantId: number;
let email = 'ops@story-shop.example';
let temporary = '';
const portal = new Map<string, MerchantPortal>();
const device = (name: string) =>
  portal.get(name) ?? portal.set(name, new MerchantPortal(t, freshClientIp())).get(name)!;
const mails = () => mailbox(t).sent;
const lastMail = () => mails().at(-1)!;

beforeAll(async () => {
  t = await createTestApp({ env: { CORS_ORIGINS: PORTAL_ORIGIN }, clock });
  clock.reset();
  await resetDb();
  await clearIdentityCaches(t);
  await clearPortalRateLimits(t);
  await clearAccountMailLimits(t);
  captureEmailedLinks(t);
  const { db } = await testDb();
  await insertUsd(db);
  await db.insert(s.clientGroups).values({ name: 'Standard', isDefault: true, discountPercent: '0' });
  await seedIdentityTemplates(db);
  mailbox(t).reset();
  api = await adminWith(t, ['*'], { name: 'Rami K.' });
});
afterAll(async () => {
  mock.restore();
  await resetDb();
  await t.close();
  await closeTestDb();
});

describe('the life of a merchant account', () => {
  it('1. staff invite a merchant: pending, no password, an invitation mail with a link', async () => {
    const res = await api.post('/admin/clients', { name: 'Story Shop', email, country: 'JO', invite: true });
    expect(res.status).toBe(201);
    merchantId = res.body.id;
    expect(res.body).toMatchObject({
      status: 'pending',
      security: { hasPassword: false, twofaEnabled: false, activeSessions: 0 },
    });
    await runMerchantMailJob(t, 'invited');
    expect(lastMail()).toMatchObject({ to: email });
    expect(lastMail().text).toContain('token=');
  });

  it('2. staff resend the invitation: the older link is dead, the newer works', async () => {
    const older = tokenIn(lastMail().text);
    expect((await api.post(`/admin/clients/${merchantId}/password`, { mode: 'reset_link' })).body).toEqual({
      link: 'invite',
    });
    await runMerchantMailJob(t, 'invited');
    expect((await device('phone').reset(older, 'a-long-first-password')).statusCode).toBe(410);
  });

  it('3. the merchant chooses a password with the new link: the email counts as verified, nobody is signed in', async () => {
    const res = await device('phone').reset(tokenIn(lastMail().text), 'a-long-first-password');
    expect(res.statusCode).toBe(204);
    expect((await clientRow(merchantId)).emailVerifiedAt).not.toBeNull();
    expect((await clientRow(merchantId)).passwordHash).not.toBeNull();
  });

  it('4. staff approve: one mail tells the merchant', async () => {
    mailbox(t).reset();
    expect((await api.patch(`/admin/clients/${merchantId}`, { status: 'active' })).body.status).toBe('active');
    await sendAllQueued(t);
    expect(mails().map((mail) => mail.subject)).toEqual(['Your merchant account is approved']);
  });

  it('5. the merchant signs in; the row shows the session and the last sign-in', async () => {
    const res = await device('laptop').login(email, 'a-long-first-password');
    expect(res.json()).toEqual({ next: 'done' });
    const row = (await api.get(`/admin/clients/${merchantId}`)).body;
    expect(row.security).toMatchObject({
      hasPassword: true,
      activeSessions: 1,
      lastLoginAt: clock.now().toISOString(),
    });
  });

  it('6. staff change the email: the old address is told, the verification goes to the new address, every session ends (decision 047)', async () => {
    const previous = email;
    email = 'new.ops@story-shop.example';
    mailbox(t).reset();
    const res = await api.patch(`/admin/clients/${merchantId}`, { email });
    expect(res.status).toBe(200);
    expect(res.body.emailVerifiedAt).toBeNull();
    await sendAllQueued(t);
    expect(mailbox(t).sent).toHaveLength(1);
    expect(lastMail()).toMatchObject({ to: previous, subject: 'A security change on your merchant account' });
    await runMerchantMailJob(t, 'email_verification');
    expect(lastMail()).toMatchObject({ to: email });
    expect((await device('laptop').me()).statusCode).toBe(401);
  });

  it('7. the merchant verifies the new address with the mailed link', async () => {
    expect((await device('laptop').verifyEmail(tokenIn(lastMail().text))).statusCode).toBe(204);
    expect((await clientRow(merchantId)).emailVerifiedAt).not.toBeNull();
  });

  it('8. staff set a temporary password and sign the merchant out; the notice carries no password', async () => {
    mailbox(t).reset();
    const res = await api.post(`/admin/clients/${merchantId}/password`, {
      mode: 'temporary_password',
      revokeSessions: true,
    });
    expect(res.body.temporaryPassword).toHaveLength(14);
    temporary = res.body.temporaryPassword;
    expect((await device('laptop').me()).statusCode).toBe(401);
    await sendAllQueued(t);
    expect(lastMail().subject).toBe('A security change on your merchant account');
    expect(lastMail().text).not.toContain(temporary);
  });

  it('9. the login answers next "password"; the forced change opens the session', async () => {
    const fresh = device('tablet');
    expect((await fresh.login(email, temporary)).json()).toEqual({ next: 'password' });
    expect((await fresh.me()).statusCode).toBe(401);
    const changed = await fresh.changeTemporaryPassword('a-second-long-password');
    expect(changed.json()).toEqual({ next: 'done' });
    expect((await fresh.me()).statusCode).toBe(200);
    expect((await clientRow(merchantId)).mustChangePassword).toBe(false);
  });

  it('10. staff suspend: the merchant is signed out, cannot sign in and is told; reactivation tells again', async () => {
    mailbox(t).reset();
    await api.patch(`/admin/clients/${merchantId}`, { status: 'suspended', reason: 'Chargeback review' });
    expect((await device('tablet').me()).statusCode).toBe(401);
    const login = await device('again').login(email, 'a-second-long-password');
    expect(login.statusCode).toBe(403);
    await api.patch(`/admin/clients/${merchantId}`, { status: 'active' });
    await sendAllQueued(t);
    expect(mails().map((mail) => mail.subject)).toEqual([
      'Your merchant account is suspended',
      'Your merchant account is active again',
    ]);
    expect((await device('again').login(email, 'a-second-long-password')).json()).toEqual({ next: 'done' });
  });

  it('11. staff create an API key and lower its limit: shown once, marked as made by support, one notice, no secret stored', async () => {
    mailbox(t).reset();
    const created = await api.post(`/admin/clients/${merchantId}/api-keys`, {
      name: 'Server',
      scopes: ['orders:read'],
      rateLimitPerMin: 120,
    });
    expect(created.status).toBe(201);
    expect(created.res.headers['cache-control']).toBe('no-store');
    const { key, secret } = created.body as { key: { id: number; createdByStaff: boolean }; secret: string };
    expect(key.createdByStaff).toBe(true);
    const limited = await api.patch(`/admin/api-keys/${key.id}`, { rateLimitPerMin: 30 });
    expect(limited.status).toBe(200);
    expect(limited.body.rateLimitPerMin).toBe(30);
    const mine = await device('again').call('GET', '/client/api-keys');
    expect(mine.statusCode).toBe(200);
    expect(mine.json<{ createdByStaff: boolean }[]>().map((row) => row.createdByStaff)).toEqual([true]);
    await sendAllQueued(t);
    expect(mails().map((mail) => mail.subject)).toEqual(['A security change on your merchant account']);
    expect(lastMail().text).toContain('a new API key was created for your account');
    expect(lastMail().text).not.toContain(secret);
    const { db } = await testDb();
    expect(JSON.stringify(await db.select().from(s.auditLogs))).not.toContain(secret);
  });

  it('12. the audit history of the merchant lists every staff action of the story', async () => {
    const res = await api.get(
      `/admin/audit-logs?entityType=merchant&entityId=${merchantId}&_sort=id&_order=asc&_end=100`,
    );
    expect(res.status).toBe(200);
    const actions: string[] = res.body.map((row: { action: string }) => row.action);
    for (const phrase of [
      'resent the invitation of',
      'approved merchant',
      'edited details of',
      'set a temporary password for',
      'suspended merchant',
      'reactivated merchant',
      'created API key for',
      'changed limits of API key of',
    ]) {
      expect(actions).toContain(phrase);
    }
    expect(actions.indexOf('approved merchant')).toBeLessThan(actions.indexOf('edited details of'));
    expect(actions.indexOf('suspended merchant')).toBeLessThan(actions.indexOf('reactivated merchant'));
    const { db } = await testDb();
    const everything = JSON.stringify(await db.select().from(s.auditLogs));
    expect(everything).not.toContain(temporary);
    expect(await db.select().from(s.clients).where(eq(s.clients.id, merchantId))).toHaveLength(1);
  });
});

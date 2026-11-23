// Integration tests of the hold that a password set by staff puts on a merchant's machine credentials (decision 046: a key that spends a
// merchant's money is made by the merchant or by an Owner). While the account's password is one staff set, a portal session does not
// create API keys and does not create or change webhook endpoints; the rest of the portal works. A password chosen from a link mailed to
// the merchant's address lifts the hold. A staff change of the email address puts on the same hold, and a link mailed to the new address
// (an address staff chose) does not lift it. A key made in the portal sends the merchant the security notice of a new key.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, mock } from 'bun:test';
import { eq } from 'drizzle-orm';
import { EncryptionService } from '@src/infra/crypto';
import { schema as s } from '@src/infra/db';
import { STAFF_SET_EMAIL_HOLD } from '@src/modules/identity/application/machine-credential-hold';
import { SECURITY_NOTICE_PHRASES } from '@src/modules/identity/application/mail/merchant-lifecycle-mails';
import { adminWith } from '../../support/admin-api';
import { type TestApp, createTestApp } from '../../support/app';
import { clearIdentityCaches } from '../../support/auth';
import { TestClock } from '../../support/clock';
import { closeTestDb, resetDb, testDb } from '../../support/db';
import { clearAccountMailLimits, runMerchantMailJob, seedIdentityTemplates } from '../../support/identity-mail';
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
} from '../../support/merchant-portal';
import { mailbox, notificationRows, tokenIn } from '../../support/notifications';
import { freshClientIp } from '../../support/pipeline-routes';
import { WebhookTestModule, insertEndpoint, resetWebhookPolicy } from '../../support/webhooks';

const clock = new TestClock('2026-11-11T09:00:00.000Z');
let t: TestApp;

beforeAll(async () => {
  t = await createTestApp({ env: { CORS_ORIGINS: PORTAL_ORIGIN }, clock, imports: [WebhookTestModule] });
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
  clock.set('2026-11-11T09:00:00.000Z');
  resetWebhookPolicy();
  await resetDb();
  await clearIdentityCaches(t);
  await clearPortalRateLimits(t);
  await seedPortalBasics();
  await clearAccountMailLimits(t);
  await seedIdentityTemplates((await testDb()).db);
  captureEmailedLinks(t);
});

const KEY = { name: 'Integration', scopes: ['orders:read'] };
const ENDPOINT = { url: 'https://hooks.example.com/gsm', events: ['order.status_changed'] };

/** Sets a temporary password through the staff route and signs in with it to a full portal session. */
async function signedInWithStaffPassword(merchant: { id: number; email: string }): Promise<MerchantPortal> {
  const security = await adminWith(t, ['clients:security']);
  const answer = await security.post(`/admin/clients/${merchant.id}/password`, {
    mode: 'temporary_password',
    revokeSessions: true,
  });
  expect(answer.status).toBe(200);
  const portal = new MerchantPortal(t, freshClientIp());
  expect((await portal.login(merchant.email, answer.body.temporaryPassword as string)).json()).toEqual({
    next: 'password',
  });
  expect((await portal.changeTemporaryPassword('chosen-after-temporary-31')).json()).toEqual({ next: 'done' });
  return portal;
}

/** Sets a password from the reset link mailed to the merchant's address. */
async function resetFromMailedLink(email: string, password: string): Promise<void> {
  const owner = new MerchantPortal(t, freshClientIp());
  expect((await owner.forgot(email)).statusCode).toBe(204);
  const link = emailedLinks().findLast((l) => l.kind === 'password_reset');
  expect(link).toBeDefined();
  expect((await owner.reset(link!.token, password)).statusCode).toBe(204);
}

describe('machine credentials while the password is one staff set', () => {
  it('refuses API keys and webhook endpoint writes with 403 until a password is set from a mailed link', async () => {
    const merchant = await makeMerchant(t, { emailVerifiedAt: new Date('2026-11-01T00:00:00.000Z') });
    const { db } = await testDb();
    const endpointId = await insertEndpoint(t.app.get(EncryptionService), db, merchant.id);
    const portal = await signedInWithStaffPassword(merchant);

    const key = await portal.call('POST', '/client/api-keys', KEY);
    expect(key.statusCode).toBe(403);
    const problem = key.json<{ code: string; detail: string }>();
    expect(problem.code).toBe('FORBIDDEN');
    expect(problem.detail).toContain('Forgot password');
    const created = await portal.call('POST', '/client/webhooks', ENDPOINT);
    expect(created.statusCode).toBe(403);
    expect(created.json<{ code: string }>().code).toBe('FORBIDDEN');
    const changed = await portal.call('PATCH', `/client/webhooks/${endpointId}`, {
      url: 'https://other.example.com/gsm',
    });
    expect(changed.statusCode).toBe(403);
    expect(await db.select().from(s.apiKeys)).toEqual([]);
    const [endpoint] = await db.select().from(s.webhookEndpoints).where(eq(s.webhookEndpoints.id, endpointId));
    expect(endpoint!.url).not.toBe('https://other.example.com/gsm');
    expect(await db.select().from(s.webhookEndpoints)).toHaveLength(1);

    // The rest of the portal works in that session.
    expect((await portal.me()).statusCode).toBe(200);
    expect((await portal.call('GET', '/client/api-keys')).statusCode).toBe(200);
    expect((await portal.call('GET', '/client/webhooks')).statusCode).toBe(200);

    // A change on the security page is not a mailed link: the hold stays.
    expect((await portal.changePassword('chosen-after-temporary-31', 'changed-on-security-page-47')).statusCode).toBe(
      204,
    );
    expect((await portal.call('POST', '/client/api-keys', KEY)).statusCode).toBe(403);

    // A password set from the link mailed to the merchant's address lifts it.
    clock.advance(60_000);
    await resetFromMailedLink(merchant.email, 'owner-chose-from-link-58');
    expect((await portal.me()).statusCode).toBe(401);
    const owner = new MerchantPortal(t, freshClientIp());
    expect((await owner.login(merchant.email, 'owner-chose-from-link-58')).json()).toEqual({ next: 'done' });
    expect((await owner.call('POST', '/client/api-keys', KEY)).statusCode).toBe(201);
    expect((await owner.call('POST', '/client/webhooks', ENDPOINT)).statusCode).toBe(201);
    expect((await owner.call('PATCH', `/client/webhooks/${endpointId}`, { isActive: false })).statusCode).toBe(200);
  });

  it('leaves a merchant that never had a staff-set password free to create both', async () => {
    const merchant = await makeMerchant(t, { emailVerifiedAt: new Date('2026-11-01T00:00:00.000Z') });
    const portal = new MerchantPortal(t, freshClientIp());
    expect((await portal.login(merchant.email, MERCHANT_PASSWORD)).json()).toEqual({ next: 'done' });
    expect((await portal.call('POST', '/client/api-keys', KEY)).statusCode).toBe(201);
    expect((await portal.call('POST', '/client/webhooks', ENDPOINT)).statusCode).toBe(201);
  });
});

/** Changes the merchant's email address through the staff route (decision 047: an email change needs `clients:security`). */
async function staffChangesEmail(merchantId: number, email: string): Promise<void> {
  const support = await adminWith(t, ['clients:read', 'clients:update', 'clients:security']);
  expect((await support.patch(`/admin/clients/${merchantId}`, { email })).status).toBe(200);
}

describe('machine credentials after staff changed the email address', () => {
  it('refuses API keys and webhook endpoints with 403, and a password set from a link to the new address does not lift it', async () => {
    const merchant = await makeMerchant(t, { emailVerifiedAt: new Date('2026-11-01T00:00:00.000Z') });
    await staffChangesEmail(merchant.id, 'desk-inbox@example.com');
    clock.advance(60_000);
    await resetFromMailedLink('desk-inbox@example.com', 'chosen-from-new-address-62');
    const portal = new MerchantPortal(t, freshClientIp());
    expect((await portal.login('desk-inbox@example.com', 'chosen-from-new-address-62')).json()).toEqual({
      next: 'done',
    });

    const key = await portal.call('POST', '/client/api-keys', KEY);
    expect(key.statusCode).toBe(403);
    expect(key.json<{ code: string; detail: string }>()).toMatchObject({
      code: 'FORBIDDEN',
      detail: STAFF_SET_EMAIL_HOLD,
    });
    const created = await portal.call('POST', '/client/webhooks', ENDPOINT);
    expect(created.statusCode).toBe(403);
    expect(created.json<{ code: string }>().code).toBe('FORBIDDEN');
    const { db } = await testDb();
    expect(await db.select().from(s.apiKeys)).toEqual([]);
    expect(await db.select().from(s.webhookEndpoints)).toEqual([]);
    expect(await clientRow(merchant.id)).toMatchObject({ emailSetByStaff: true, passwordSetByStaff: false });
    // The rest of the portal works in that session.
    expect((await portal.me()).statusCode).toBe(200);
    expect((await portal.call('GET', '/client/api-keys')).statusCode).toBe(200);

    // An Owner still makes a key for the merchant from the console (decision 046).
    const owner = await adminWith(t, ['*']);
    expect((await owner.post(`/admin/clients/${merchant.id}/api-keys`, KEY)).status).toBe(201);
  });

  it('keeps the hold of a temporary password after a reset by link to an address staff set', async () => {
    const merchant = await makeMerchant(t, { emailVerifiedAt: new Date('2026-11-01T00:00:00.000Z') });
    const first = await signedInWithStaffPassword(merchant);
    await staffChangesEmail(merchant.id, 'second-inbox@example.com');
    expect((await first.me()).statusCode).toBe(401);
    clock.advance(60_000);
    await resetFromMailedLink('second-inbox@example.com', 'chosen-from-new-address-63');
    const portal = new MerchantPortal(t, freshClientIp());
    expect((await portal.login('second-inbox@example.com', 'chosen-from-new-address-63')).json()).toEqual({
      next: 'done',
    });

    expect((await portal.call('POST', '/client/api-keys', KEY)).statusCode).toBe(403);
    expect((await portal.call('POST', '/client/webhooks', ENDPOINT)).statusCode).toBe(403);
    expect(await clientRow(merchant.id)).toMatchObject({ emailSetByStaff: true, passwordSetByStaff: false });
  });
});

describe('the hold of a password staff set and the invitation link', () => {
  it('is lifted by a password set from an invitation mailed to the merchant', async () => {
    // The mark is written directly: an invitation is a mailed link like a reset, and both end the hold the same way.
    const merchant = await makeMerchant(t, { noPassword: true, passwordSetByStaff: true });
    const security = await adminWith(t, ['clients:security']);
    expect((await security.post(`/admin/clients/${merchant.id}/password`, { mode: 'reset_link' })).body).toEqual({
      link: 'invite',
    });
    mailbox(t).reset();
    await runMerchantMailJob(t, 'invited');
    const token = tokenIn(mailbox(t).sent.at(-1)!.text);
    expect((await new MerchantPortal(t, freshClientIp()).reset(token, 'chosen-from-invitation-64')).statusCode).toBe(
      204,
    );
    expect((await clientRow(merchant.id)).passwordSetByStaff).toBe(false);

    const portal = new MerchantPortal(t, freshClientIp());
    expect((await portal.login(merchant.email, 'chosen-from-invitation-64')).json()).toEqual({ next: 'done' });
    expect((await portal.call('POST', '/client/api-keys', KEY)).statusCode).toBe(201);
    expect((await portal.call('POST', '/client/webhooks', ENDPOINT)).statusCode).toBe(201);
  });
});

describe('POST /client/api-keys notice', () => {
  it('sends the merchant the security notice of a new key', async () => {
    const merchant = await makeMerchant(t, { emailVerifiedAt: new Date('2026-11-01T00:00:00.000Z') });
    const portal = new MerchantPortal(t, freshClientIp());
    expect((await portal.login(merchant.email, MERCHANT_PASSWORD)).json()).toEqual({ next: 'done' });
    expect((await portal.call('POST', '/client/api-keys', KEY)).statusCode).toBe(201);

    const { db } = await testDb();
    const notices = (await notificationRows(db)).filter((row) => row.event === 'merchant.security_notice');
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({ recipientType: 'client', recipientId: merchant.id, channel: 'email' });
    expect(JSON.stringify(notices[0]!.payload)).toContain(SECURITY_NOTICE_PHRASES.api_key_created);
  });

  it('sends nothing when the key is refused', async () => {
    const merchant = await makeMerchant(t, { emailVerifiedAt: new Date('2026-11-01T00:00:00.000Z') });
    const portal = new MerchantPortal(t, freshClientIp());
    expect((await portal.login(merchant.email, MERCHANT_PASSWORD)).json()).toEqual({ next: 'done' });
    expect((await portal.call('POST', '/client/api-keys', { name: 'Bad', scopes: ['nope:read'] })).statusCode).toBe(
      422,
    );
    const { db } = await testDb();
    expect(await notificationRows(db)).toEqual([]);
  });
});

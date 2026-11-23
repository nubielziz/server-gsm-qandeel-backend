// Integration tests of the hold that a password set by staff puts on a merchant's machine credentials (decision 046: a key that spends a
// merchant's money is made by the merchant or by an Owner). While the account's password is one staff set, a portal session does not
// create API keys and does not create or change webhook endpoints; the rest of the portal works. A password chosen from a link mailed to
// the merchant's address lifts the hold. A change of the email address by a staff member who is not an Owner puts on the same hold, and a
// link mailed to the new address (an address staff chose) does not lift it; an Owner's change of the address sets none, and an Owner's
// details edit that carries the stored address lifts it. Connecting a Telegram chat (`POST /client/telegram/link`) is held the same way. A
// key made in the portal sends the merchant a notice that says so; a key staff made keeps the notice that names the support team.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';
import { and, eq } from 'drizzle-orm';
import { EncryptionService } from '@src/infra/crypto';
import { schema as s } from '@src/infra/db';
import { ClientDetailsEditor } from '@src/modules/identity/application/client-details-editor';
import {
  STAFF_SET_EMAIL_HOLD,
  STAFF_SET_PASSWORD_HOLD,
} from '@src/modules/identity/application/machine-credential-hold';
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
import { mailbox, notificationRows, sendAllQueued, tokenIn } from '../../support/notifications';
import { freshClientIp } from '../../support/pipeline-routes';
import { WebhookTestModule, insertEndpoint, resetWebhookPolicy } from '../../support/webhooks';

const clock = new TestClock('2026-11-11T09:00:00.000Z');
let t: TestApp;

beforeAll(async () => {
  t = await createTestApp({
    env: {
      CORS_ORIGINS: PORTAL_ORIGIN,
      TELEGRAM_BOT_TOKEN: '1234567890:AAtest-token',
      TELEGRAM_BOT_USERNAME: 'gsm_test_bot',
    },
    clock,
    imports: [WebhookTestModule],
  });
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
    // The sentence names the third thing the hold covers.
    expect(problem.detail).toBe(STAFF_SET_PASSWORD_HOLD);
    expect(problem.detail).toEndWith('before you create API keys or webhook endpoints or connect Telegram.');
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
    expect(STAFF_SET_EMAIL_HOLD).toEndWith('before you create API keys or webhook endpoints or connect Telegram.');
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

/** A merchant with a verified address and a full details form (the console sends every key, the country included). */
const formMerchant = () =>
  makeMerchant(t, {
    emailVerifiedAt: new Date('2026-11-01T00:00:00.000Z'),
    company: 'Zain',
    phone: '+962 6',
    country: 'JO',
  });

/** The console's details form of the merchant as stored: every detail key, the email included. */
async function detailsForm(merchantId: number): Promise<Record<string, string>> {
  const row = await clientRow(merchantId);
  return {
    name: row.name,
    company: row.company,
    phone: row.phone,
    country: row.country,
    email: row.email,
    address: row.address,
    taxId: row.taxId,
    internalNotes: row.internalNotes,
  };
}

/** Signs the merchant in to a full portal session with the password it has. */
async function signedIn(email: string): Promise<MerchantPortal> {
  const portal = new MerchantPortal(t, freshClientIp());
  expect((await portal.login(email)).json()).toEqual({ next: 'done' });
  return portal;
}

/** The merchant's links, sessions and audit rows, the notifications and the outbox. */
async function accountTrail(merchantId: number) {
  const { db } = await testDb();
  const client = (table: typeof s.authTokens | typeof s.sessions) =>
    and(eq(table.subjectType, 'client'), eq(table.subjectId, merchantId));
  return {
    tokens: await db.select().from(s.authTokens).where(client(s.authTokens)).orderBy(s.authTokens.id),
    sessions: await db.select().from(s.sessions).where(client(s.sessions)).orderBy(s.sessions.id),
    outbox: await db.select().from(s.outboxEvents).orderBy(s.outboxEvents.id),
    notifications: await notificationRows(db),
    audit: await db
      .select()
      .from(s.auditLogs)
      .where(and(eq(s.auditLogs.entityType, 'merchant'), eq(s.auditLogs.entityId, merchantId)))
      .orderBy(s.auditLogs.id),
  };
}

describe('the hold of an email address and an Owner', () => {
  it('is lifted when an Owner sends the details form with the stored address, which changes nothing else of the email', async () => {
    const merchant = await formMerchant();
    await staffChangesEmail(merchant.id, 'desk-inbox@example.com');
    const portal = await signedIn('desk-inbox@example.com');
    const refused = await portal.call('POST', '/client/api-keys', KEY);
    expect(refused.statusCode).toBe(403);
    expect(refused.json<{ detail: string }>().detail).toBe(STAFF_SET_EMAIL_HOLD);

    const before = await accountTrail(merchant.id);
    const links = emailedLinks().length;
    const limiter = spyOn(t.app.get(ClientDetailsEditor, { strict: false }), 'enforceEmailChangeLimit');
    const owner = await adminWith(t, ['*']);
    expect((await owner.patch(`/admin/clients/${merchant.id}`, await detailsForm(merchant.id))).status).toBe(200);

    expect(await clientRow(merchant.id)).toMatchObject({
      email: 'desk-inbox@example.com',
      emailVerifiedAt: null,
      emailSetByStaff: false,
      passwordSetByStaff: false,
    });
    const after = await accountTrail(merchant.id);
    const added = after.audit.slice(before.audit.length);
    expect(added).toHaveLength(1);
    expect(added[0]).toMatchObject({
      action: 'edited details of',
      actorType: 'staff',
      actorId: owner.staffId,
      before: { emailSetByStaff: true },
      after: { emailSetByStaff: false },
    });
    expect(added[0]!.before).toEqual({ emailSetByStaff: true });
    expect(added[0]!.after).toEqual({ emailSetByStaff: false });
    // No link, no mail job, no notice, no point of the limiter, and the merchant's sessions live on.
    expect({ ...after, audit: before.audit }).toEqual(before);
    expect(emailedLinks()).toHaveLength(links);
    expect(limiter).not.toHaveBeenCalled();
    expect((await portal.me()).statusCode).toBe(200);

    expect((await portal.call('POST', '/client/api-keys', KEY)).statusCode).toBe(201);
    expect((await portal.call('POST', '/client/webhooks', ENDPOINT)).statusCode).toBe(201);
  });

  it('stays after the same form from a staff member who is not an Owner, and after an Owner edit without the email', async () => {
    const merchant = await formMerchant();
    await staffChangesEmail(merchant.id, 'desk-inbox@example.com');
    const portal = await signedIn('desk-inbox@example.com');

    const support = await adminWith(t, ['clients:read', 'clients:update', 'clients:security']);
    expect((await support.patch(`/admin/clients/${merchant.id}`, await detailsForm(merchant.id))).status).toBe(200);
    expect((await clientRow(merchant.id)).emailSetByStaff).toBe(true);
    expect((await portal.call('POST', '/client/api-keys', KEY)).statusCode).toBe(403);

    const owner = await adminWith(t, ['*']);
    expect((await owner.patch(`/admin/clients/${merchant.id}`, { phone: '+962 79 555' })).status).toBe(200);
    expect(await clientRow(merchant.id)).toMatchObject({ phone: '+962 79 555', emailSetByStaff: true });
    expect((await portal.call('POST', '/client/api-keys', KEY)).statusCode).toBe(403);
    expect((await portal.call('POST', '/client/webhooks', ENDPOINT)).statusCode).toBe(403);
  });

  it('is not set by an Owner change of the address, which still ends the sessions, voids the links and tells the old address', async () => {
    const merchant = await formMerchant();
    const first = await signedIn(merchant.email);
    const { db } = await testDb();
    await db.insert(s.authTokens).values({
      purpose: 'reset',
      subjectType: 'client',
      subjectId: merchant.id,
      tokenHash: 'open-reset-before-the-change',
      expiresAt: new Date(clock.nowMs() + 3_600_000),
    });
    const owner = await adminWith(t, ['*']);
    expect((await owner.patch(`/admin/clients/${merchant.id}`, { email: 'owner-typed@example.com' })).status).toBe(200);

    expect(await clientRow(merchant.id)).toMatchObject({
      email: 'owner-typed@example.com',
      emailVerifiedAt: null,
      emailSetByStaff: false,
    });
    expect((await first.me()).statusCode).toBe(401);
    const { tokens, notifications } = await accountTrail(merchant.id);
    expect(tokens.find((row) => row.tokenHash === 'open-reset-before-the-change')!.usedAt).not.toBeNull();
    expect(tokens.filter((row) => row.usedAt === null).map((row) => row.purpose)).toEqual(['verify_email']);
    const notices = notifications.filter((row) => row.event === 'merchant.security_notice');
    expect(notices).toHaveLength(1);
    expect(notices[0]!.payload).toMatchObject({ to: merchant.email });

    const portal = await signedIn('owner-typed@example.com');
    expect((await portal.call('POST', '/client/api-keys', KEY)).statusCode).toBe(201);
    expect((await portal.call('POST', '/client/webhooks', ENDPOINT)).statusCode).toBe(201);
  });

  it('is cleared by an Owner change of an address a staff member who is not an Owner set', async () => {
    const merchant = await formMerchant();
    await staffChangesEmail(merchant.id, 'desk-inbox@example.com');
    expect((await clientRow(merchant.id)).emailSetByStaff).toBe(true);

    const owner = await adminWith(t, ['*']);
    expect((await owner.patch(`/admin/clients/${merchant.id}`, { email: 'merchant-own@example.com' })).status).toBe(
      200,
    );
    expect((await clientRow(merchant.id)).emailSetByStaff).toBe(false);
    const portal = await signedIn('merchant-own@example.com');
    expect((await portal.call('POST', '/client/api-keys', KEY)).statusCode).toBe(201);
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

/** The Telegram link tokens that exist. */
async function telegramLinkTokens() {
  const { db } = await testDb();
  return db.select().from(s.authTokens).where(eq(s.authTokens.purpose, 'telegram_link'));
}

describe('POST /client/telegram/link while a credential is one staff set', () => {
  it('refuses with 403 and writes no link while the password is one staff set, and links again after a password from a mailed link', async () => {
    const merchant = await makeMerchant(t, { emailVerifiedAt: new Date('2026-11-01T00:00:00.000Z') });
    const portal = await signedInWithStaffPassword(merchant);

    const refused = await portal.call('POST', '/client/telegram/link');
    expect(refused.statusCode).toBe(403);
    expect(refused.json<{ code: string; detail: string }>()).toMatchObject({
      code: 'FORBIDDEN',
      detail: STAFF_SET_PASSWORD_HOLD,
    });
    expect(await telegramLinkTokens()).toEqual([]);
    // The rest of the portal works in that session, the notification settings included.
    expect((await portal.call('GET', '/client/notification-preferences')).statusCode).toBe(200);

    // A change on the security page is not a mailed link: the hold stays.
    expect((await portal.changePassword('chosen-after-temporary-31', 'changed-on-security-page-47')).statusCode).toBe(
      204,
    );
    expect((await portal.call('POST', '/client/telegram/link')).statusCode).toBe(403);
    expect(await telegramLinkTokens()).toEqual([]);

    // A password set from the link mailed to the merchant's address lifts it.
    clock.advance(60_000);
    await resetFromMailedLink(merchant.email, 'owner-chose-from-link-71');
    const owner = new MerchantPortal(t, freshClientIp());
    expect((await owner.login(merchant.email, 'owner-chose-from-link-71')).json()).toEqual({ next: 'done' });
    const linked = await owner.call('POST', '/client/telegram/link');
    expect(linked.statusCode).toBe(201);
    expect(linked.json<{ url: string }>().url).toMatch(/^https:\/\/t\.me\/gsm_test_bot\?start=/);
    expect(await telegramLinkTokens()).toHaveLength(1);
  });

  it('refuses with 403 and writes no link after a staff member who is not an Owner changed the email address', async () => {
    const merchant = await makeMerchant(t, { emailVerifiedAt: new Date('2026-11-01T00:00:00.000Z') });
    await staffChangesEmail(merchant.id, 'desk-inbox-tg@example.com');
    clock.advance(60_000);
    // A password from a link to the new address does not end this hold.
    await resetFromMailedLink('desk-inbox-tg@example.com', 'chosen-from-new-address-72');
    const portal = new MerchantPortal(t, freshClientIp());
    expect((await portal.login('desk-inbox-tg@example.com', 'chosen-from-new-address-72')).json()).toEqual({
      next: 'done',
    });

    const refused = await portal.call('POST', '/client/telegram/link');
    expect(refused.statusCode).toBe(403);
    expect(refused.json<{ code: string; detail: string }>()).toMatchObject({
      code: 'FORBIDDEN',
      detail: STAFF_SET_EMAIL_HOLD,
    });
    expect(await telegramLinkTokens()).toEqual([]);
  });

  it('leaves a merchant without a mark free to connect Telegram', async () => {
    const merchant = await makeMerchant(t, { emailVerifiedAt: new Date('2026-11-01T00:00:00.000Z') });
    const portal = new MerchantPortal(t, freshClientIp());
    expect((await portal.login(merchant.email, MERCHANT_PASSWORD)).json()).toEqual({ next: 'done' });
    const linked = await portal.call('POST', '/client/telegram/link');
    expect(linked.statusCode).toBe(201);
    expect(await telegramLinkTokens()).toHaveLength(1);
  });
});

describe('the notice of a new API key', () => {
  beforeEach(() => {
    mailbox(t).reset();
  });

  it('says that a key made in the portal was made in the portal, and names no action of the support team', async () => {
    const merchant = await makeMerchant(t, { emailVerifiedAt: new Date('2026-11-01T00:00:00.000Z') });
    const portal = new MerchantPortal(t, freshClientIp());
    expect((await portal.login(merchant.email, MERCHANT_PASSWORD)).json()).toEqual({ next: 'done' });
    expect((await portal.call('POST', '/client/api-keys', KEY)).statusCode).toBe(201);

    const { db } = await testDb();
    const rows = await notificationRows(db);
    expect(rows.map((row) => row.event)).toEqual(['merchant.portal_api_key_created']);
    expect(rows[0]).toMatchObject({ recipientType: 'client', recipientId: merchant.id, channel: 'email' });

    // The stored templates of the test database are the ones the migrations installed: this event has none, so the shipped text is sent.
    await sendAllQueued(t);
    const sent = mailbox(t).sent;
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ to: merchant.email, subject: 'A new API key was created in your account' });
    expect(sent[0]!.text).toBe(
      "Hi Test Merchant,\n\nA new API key was created in your account's portal.\n\n" +
        'If you did not create it, revoke it in the portal and change your password.',
    );
    expect(sent[0]!.text).not.toContain('support');
  });

  it('keeps the text that names the support team in the notice of a key staff made', async () => {
    const merchant = await makeMerchant(t, { emailVerifiedAt: new Date('2026-11-01T00:00:00.000Z') });
    const owner = await adminWith(t, ['*']);
    expect((await owner.post(`/admin/clients/${merchant.id}/api-keys`, KEY)).status).toBe(201);

    const { db } = await testDb();
    const rows = await notificationRows(db);
    expect(rows.map((row) => row.event)).toEqual(['merchant.security_notice']);
    expect(JSON.stringify(rows[0]!.payload)).toContain(SECURITY_NOTICE_PHRASES.api_key_created);
    await sendAllQueued(t);
    expect(mailbox(t).sent).toHaveLength(1);
    expect(mailbox(t).sent[0]!.text).toBe(
      'Hi Test Merchant,\n\nOur support team made this change to your account: a new API key was created for your account.\n\n' +
        'If you did not ask for it, reply to this email or contact our support team at once.',
    );
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

// Integration tests of the two marks staff leave on an account (decision 046; read by nobody since decision 067): `password_set_by_staff`
// is set by a staff temporary password and cleared only by a password chosen from a link mailed to the account's address, and
// `email_set_by_staff` is set by a change of the email address by a staff member who is not an Owner and cleared by an Owner (a change of the
// address, or a details edit that carries the stored one). The marks held back the merchant's own creation of API keys; merchants make no key
// any more, but the marks are still written and cleared as before until the accounts model drops them. The notice of the retired portal key
// event is kept registered with its shipped text: a notification written before still sends.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';
import { and, eq } from 'drizzle-orm';
import { DbService, schema as s } from '@src/infra/db';
// The identity barrel loads before the editor's own file: that file reaches the money barrel, whose module loads the identity module
// files that import the editor, so a process that starts with the editor's file meets the class before it exists.
import '@src/modules/identity';
import { ClientDetailsEditor } from '@src/modules/identity/application/client-details-editor';
import { NotificationService } from '@src/modules/platform';
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
import { TURNSTILE_TEST_TOKEN } from '../../support/store';

const clock = new TestClock('2026-11-11T09:00:00.000Z');
let t: TestApp;

beforeAll(async () => {
  t = await createTestApp({
    env: {
      CORS_ORIGINS: PORTAL_ORIGIN,
    },
    clock,
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
  await resetDb();
  await clearIdentityCaches(t);
  await clearPortalRateLimits(t);
  await seedPortalBasics();
  await clearAccountMailLimits(t);
  await seedIdentityTemplates((await testDb()).db);
  captureEmailedLinks(t);
});

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
  // The forgot route always needs the anti-bot token (the merchant rollout switch does not govern it).
  expect((await owner.forgot(email, { headers: { 'x-turnstile-token': TURNSTILE_TEST_TOKEN } })).statusCode).toBe(204);
  const link = emailedLinks().findLast((l) => l.kind === 'password_reset');
  expect(link).toBeDefined();
  expect((await owner.reset(link!.token, password)).statusCode).toBe(204);
}

describe('the mark of a password staff set', () => {
  it('is set by a temporary password, kept by the forced change and by a change on the security page, and cleared by a password from a mailed link', async () => {
    const merchant = await makeMerchant(t, { emailVerifiedAt: new Date('2026-11-01T00:00:00.000Z') });
    const portal = await signedInWithStaffPassword(merchant);
    expect(await clientRow(merchant.id)).toMatchObject({ passwordSetByStaff: true, mustChangePassword: false });

    // The rest of the portal works in that session, and a change on the security page is not a mailed link: the mark stays.
    expect((await portal.me()).statusCode).toBe(200);
    expect((await portal.changePassword('chosen-after-temporary-31', 'changed-on-security-page-47')).statusCode).toBe(
      204,
    );
    expect((await clientRow(merchant.id)).passwordSetByStaff).toBe(true);

    // A password set from the link mailed to the merchant's address clears it, and ends the sessions open under it.
    clock.advance(60_000);
    await resetFromMailedLink(merchant.email, 'owner-chose-from-link-58');
    expect((await clientRow(merchant.id)).passwordSetByStaff).toBe(false);
    expect((await portal.me()).statusCode).toBe(401);
    const owner = new MerchantPortal(t, freshClientIp());
    expect((await owner.login(merchant.email, 'owner-chose-from-link-58')).json()).toEqual({ next: 'done' });
  });

  it('is never set for a merchant that chose its own password', async () => {
    const merchant = await makeMerchant(t, { emailVerifiedAt: new Date('2026-11-01T00:00:00.000Z') });
    const portal = new MerchantPortal(t, freshClientIp());
    expect((await portal.login(merchant.email, MERCHANT_PASSWORD)).json()).toEqual({ next: 'done' });
    expect(await clientRow(merchant.id)).toMatchObject({ passwordSetByStaff: false, emailSetByStaff: false });
  });

  it('is cleared by a password set from an invitation mailed to the merchant', async () => {
    // The mark is written directly: an invitation is a mailed link like a reset, and both clear it the same way.
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
  });
});

/** Changes the merchant's email address through the staff route (decision 047: an email change needs `clients:security`). */
async function staffChangesEmail(merchantId: number, email: string): Promise<void> {
  const support = await adminWith(t, ['clients:read', 'clients:update', 'clients:security']);
  expect((await support.patch(`/admin/clients/${merchantId}`, { email })).status).toBe(200);
}

describe('the mark of an email address staff changed', () => {
  it('is set by a staff member who is not an Owner, and a password set from a link to the new address does not clear it', async () => {
    const merchant = await makeMerchant(t, { emailVerifiedAt: new Date('2026-11-01T00:00:00.000Z') });
    await staffChangesEmail(merchant.id, 'desk-inbox@example.com');
    expect(await clientRow(merchant.id)).toMatchObject({ emailSetByStaff: true, passwordSetByStaff: false });
    clock.advance(60_000);
    await resetFromMailedLink('desk-inbox@example.com', 'chosen-from-new-address-62');
    const portal = new MerchantPortal(t, freshClientIp());
    expect((await portal.login('desk-inbox@example.com', 'chosen-from-new-address-62')).json()).toEqual({
      next: 'done',
    });
    expect(await clientRow(merchant.id)).toMatchObject({ emailSetByStaff: true, passwordSetByStaff: false });
    // The rest of the portal works in that session.
    expect((await portal.me()).statusCode).toBe(200);
  });

  it('stays after a reset by link to an address staff set, while the mark of the staff password is cleared by that link', async () => {
    const merchant = await makeMerchant(t, { emailVerifiedAt: new Date('2026-11-01T00:00:00.000Z') });
    const first = await signedInWithStaffPassword(merchant);
    expect((await clientRow(merchant.id)).passwordSetByStaff).toBe(true);
    await staffChangesEmail(merchant.id, 'second-inbox@example.com');
    expect((await first.me()).statusCode).toBe(401);
    clock.advance(60_000);
    await resetFromMailedLink('second-inbox@example.com', 'chosen-from-new-address-63');
    const portal = new MerchantPortal(t, freshClientIp());
    expect((await portal.login('second-inbox@example.com', 'chosen-from-new-address-63')).json()).toEqual({
      next: 'done',
    });
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
    and(eq(table.subjectType, 'account'), eq(table.subjectId, merchantId));
  return {
    tokens: await db.select().from(s.authTokens).where(client(s.authTokens)).orderBy(s.authTokens.id),
    sessions: await db.select().from(s.sessions).where(client(s.sessions)).orderBy(s.sessions.id),
    outbox: await db.select().from(s.outboxEvents).orderBy(s.outboxEvents.id),
    notifications: await notificationRows(db),
    audit: await db
      .select()
      .from(s.auditLogs)
      .where(and(eq(s.auditLogs.entityType, 'account'), eq(s.auditLogs.entityId, merchantId)))
      .orderBy(s.auditLogs.id),
  };
}

describe('the mark of an email address and an Owner', () => {
  it('is cleared when an Owner sends the details form with the stored address, which changes nothing else of the email', async () => {
    const merchant = await formMerchant();
    await staffChangesEmail(merchant.id, 'desk-inbox@example.com');
    const portal = await signedIn('desk-inbox@example.com');
    expect((await clientRow(merchant.id)).emailSetByStaff).toBe(true);

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
  });

  it('stays after the same form from a staff member who is not an Owner, and after an Owner edit without the email', async () => {
    const merchant = await formMerchant();
    await staffChangesEmail(merchant.id, 'desk-inbox@example.com');

    const support = await adminWith(t, ['clients:read', 'clients:update', 'clients:security']);
    expect((await support.patch(`/admin/clients/${merchant.id}`, await detailsForm(merchant.id))).status).toBe(200);
    expect((await clientRow(merchant.id)).emailSetByStaff).toBe(true);

    const owner = await adminWith(t, ['*']);
    expect((await owner.patch(`/admin/clients/${merchant.id}`, { phone: '+962 79 555' })).status).toBe(200);
    expect(await clientRow(merchant.id)).toMatchObject({ phone: '+962 79 555', emailSetByStaff: true });
  });

  it('is not set by an Owner change of the address, which still ends the sessions, voids the links and tells the old address', async () => {
    const merchant = await formMerchant();
    const first = await signedIn(merchant.email);
    const { db } = await testDb();
    await db.insert(s.authTokens).values({
      purpose: 'reset',
      subjectType: 'account',
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
  });
});

describe('the notice of the retired event merchant.portal_api_key_created', () => {
  beforeEach(() => {
    mailbox(t).reset();
  });

  it('is still registered with its shipped text, so a notification written before decision 067 still sends and says it was made in the portal', async () => {
    const merchant = await makeMerchant(t, { emailVerifiedAt: new Date('2026-11-01T00:00:00.000Z') });
    // Nothing in the code writes this notice any more: the row stands for one written before merchants stopped making keys.
    await t.app.get(DbService).runInTransaction((work) =>
      t.app.get(NotificationService, { strict: false }).enqueue(work, {
        event: 'merchant.portal_api_key_created',
        recipient: { type: 'account', id: merchant.id },
        channel: 'email',
        variables: { merchantName: 'Test Merchant', change: "A new API key was created in your account's portal." },
      }),
    );
    const { db } = await testDb();
    expect((await notificationRows(db)).map((row) => row.event)).toEqual(['merchant.portal_api_key_created']);

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
});

// End-to-end walk of the map scenario `b2c-account` (managing a retail account, docs/slices/customers.json), step by step through HTTP on the
// real application: the tables and statuses each step names are read back from Postgres. A retail account is a row of the one account
// table (decision 064): staff make it with `POST /admin/clients`, it takes its invitation on `/client/auth/password/reset`, signs in on the one
// form `/client/auth/sign-in` and reads itself on `/store/v1/me`, and staff suspend and reactivate it with `PATCH /admin/clients/:id`. The steps
// share one story, so the tests of this file run in order and keep their state in the variables below.
// The map has no step 3: the test of that number checks the invitation mail's outbox event (ids only), between steps 2 and 4.
// Step 8 also names a new checkout session, which feature 14a refuses for a suspended account (ACCOUNT_SUSPENDED); 14a adds it here.
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { and, asc, eq } from 'drizzle-orm';
import { Money } from '@src/common/money';
import { TokenService } from '@src/infra/crypto';
import { schema as s } from '@src/infra/db';
import { b2cPay, postTransaction } from '@src/modules/money';
import { ensureRetailGroup, makeAccount } from '../support/accounts';
import { type AdminApi, adminWith } from '../support/admin-api';
import { type TestApp, createTestApp } from '../support/app';
import { clearIdentityCaches, openSession } from '../support/auth';
import { HOUR, MINUTE, TestClock } from '../support/clock';
import { auditOfCustomer, insertTaxRates } from '../support/customers';
import { closeTestDb, resetDb, testDb } from '../support/db';
import { insertOrderRow, orderRow, ordersWorld, type OrdersWorld } from '../support/orders';
import {
  STORE_ORIGIN,
  StoreClient,
  captureCustomerLinks,
  clearStoreRateLimits,
  customerLinks,
  customerRow,
} from '../support/store';

const clock = new TestClock('2026-11-07T10:00:00.000Z');
let t: TestApp;
let world: OrdersWorld;
let staff: AdminApi;
let accountId = 0;
let orderId = 0;
const EMAIL = 'daniel.whitmore@example.com';
const PASSWORD = 'a-much-longer-passphrase';

beforeAll(async () => {
  t = await createTestApp({ clock, env: { SHOP_ORIGINS: STORE_ORIGIN } });
  await resetDb();
  await clearIdentityCaches(t);
  await clearStoreRateLimits(t);
  captureCustomerLinks(t);
  const { db } = await testDb();
  world = await ordersWorld(db);
  // An account made without a rank takes the one retail rank.
  await ensureRetailGroup(db);
  // Staff can only add an account in a country the storefront sells to (one with a current tax rate).
  await insertTaxRates(db, ['GB']);
  staff = await adminWith(t, ['clients:*', 'orders:*'], { name: 'Lina S.' });
});
afterAll(async () => {
  await resetDb();
  await clearIdentityCaches(t);
  await t.close();
  await closeTestDb();
});

/** The sessions of the account, oldest first. */
async function sessionsOfAccount() {
  const { db } = await testDb();
  return db
    .select()
    .from(s.sessions)
    .where(and(eq(s.sessions.subjectType, 'account'), eq(s.sessions.subjectId, accountId)))
    .orderBy(asc(s.sessions.id));
}

/** The link rows of the account, oldest first. */
async function tokensOfAccount() {
  const { db } = await testDb();
  return db
    .select()
    .from(s.authTokens)
    .where(and(eq(s.authTokens.subjectType, 'account'), eq(s.authTokens.subjectId, accountId)))
    .orderBy(asc(s.authTokens.id));
}

describe('scenario b2c-account: managing a retail account', () => {
  it('step 1: a staff member adds an account by link; another account’s email and a blocklisted one are refused', async () => {
    const { db } = await testDb();
    await makeAccount(t, { rank: 'retail', email: 'taken@example.com', name: 'Someone Else' });
    await db.insert(s.blocklistEntries).values({
      kind: 'email',
      valueHash: t.app.get(TokenService).hash('fraud@example.com'),
      display: 'f***@example.com',
    });
    const body = (email: string) => ({
      name: 'Daniel Whitmore',
      email,
      country: 'GB',
      password: { mode: 'reset_link' },
    });
    expect((await staff.post('/admin/clients', body('taken@example.com'))).body).toMatchObject({
      code: 'EMAIL_TAKEN',
    });
    expect((await staff.post('/admin/clients', body('fraud@example.com'))).body).toMatchObject({
      errors: [{ field: 'email', message: 'This email is blocked.' }],
    });
    const created = await staff.post('/admin/clients', body(EMAIL));
    expect(created.status).toBe(201);
    accountId = created.body.id;
    expect(created.body).toMatchObject({
      hasAccount: true,
      createdBy: { id: staff.staffId, name: 'Lina S.' },
      status: 'active',
      rank: { kind: 'retail' },
      invitationPending: true,
    });
  });

  it('step 2: the account, no password yet, a one-hour invitation (hash only) and the audit row', async () => {
    const { db } = await testDb();
    expect(await customerRow(accountId)).toMatchObject({
      hasAccount: true,
      createdBy: staff.staffId,
      status: 'active',
      emailVerifiedAt: null,
      passwordHash: null,
      mustChangePassword: false,
      username: null,
    });
    const [token] = await tokensOfAccount();
    expect(token).toMatchObject({ purpose: 'invite', subjectType: 'account', usedAt: null, createdBy: staff.staffId });
    expect(token!.expiresAt.getTime() - token!.createdAt.getTime()).toBe(HOUR);
    expect(token!.tokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(token!.tokenHash).not.toBe(customerLinks()[0]!.token);
    expect((await auditOfCustomer(db, accountId))[0]).toMatchObject({
      action: 'created account',
      entityType: 'account',
      actorName: 'Lina S.',
    });
  });

  it('step 3: the invitation mail is one outbox event that carries ids only, never the token or the email', async () => {
    const { db } = await testDb();
    const [token] = await tokensOfAccount();
    const events = (await db.select().from(s.outboxEvents)).filter(
      (event) => event.aggregateType === 'clients' && event.aggregateId === accountId,
    );
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: 'customer.invited',
      aggregateType: 'clients',
      aggregateId: accountId,
      payload: { accountId, tokenId: token!.id },
    });
    // Decision 020: a job payload is ids only; the clear token exists only in the request that created it.
    const written = JSON.stringify(events[0]);
    expect(written).not.toContain(customerLinks()[0]!.token);
    expect(written).not.toContain(EMAIL);
  });

  it('step 4: the account opens the link and chooses a password: the token is spent and the email is verified; older sessions end', async () => {
    const { db } = await testDb();
    // A session from before (the account signed in some other way): the new password ends it.
    const older = await openSession(t, { type: 'account', id: accountId });
    const [link] = customerLinks();
    clock.advance(10 * MINUTE);
    const res = await new StoreClient(t, '198.18.1.1').call('POST', '/client/auth/password/reset', {
      token: link!.token,
      password: PASSWORD,
    });
    expect(res.statusCode).toBe(204);

    const [token] = await tokensOfAccount();
    expect(token!.usedAt).toEqual(new Date('2026-11-07T10:10:00.000Z'));
    const row = await customerRow(accountId);
    expect(row.emailVerifiedAt).toEqual(new Date('2026-11-07T10:10:00.000Z'));
    expect(row.passwordHash).toStartWith('$argon2id$');
    expect(row.passwordChangedAt).toEqual(new Date('2026-11-07T10:10:00.000Z'));
    const [oldSession] = await db.select().from(s.sessions).where(eq(s.sessions.id, older.sessionId));
    expect(oldSession!.revokedAt).not.toBeNull();
    // Single use.
    const again = await new StoreClient(t, '198.18.1.2').call('POST', '/client/auth/password/reset', {
      token: link!.token,
      password: PASSWORD,
    });
    expect(again.statusCode).toBe(410);
    expect(again.json()).toMatchObject({ code: 'TOKEN_INVALID' });
  });

  let account: StoreClient;
  it('step 5: the account signs in on the one form: a new session opens, last_login_at is written and the password is stored only as a hash', async () => {
    account = new StoreClient(t, '198.18.1.3');
    const res = await account.call('POST', '/client/auth/sign-in', { email: EMAIL, password: PASSWORD });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ kind: 'customer', next: 'done', rank: { kind: 'retail' } });
    const live = (await sessionsOfAccount()).filter(
      (session) => session.subjectType === 'account' && session.revokedAt === null,
    );
    expect(live).toHaveLength(1);
    expect(await customerRow(accountId)).toMatchObject({ lastLoginAt: new Date('2026-11-07T10:10:00.000Z') });
    // A retail account reads itself on the shop's route.
    expect((await account.me()).json()).toMatchObject({ id: accountId, hasPassword: true, rank: { kind: 'retail' } });
  });

  it('step 6: the account forgot the password: staff send a new link and end every session; no password reaches the audit log', async () => {
    const { db } = await testDb();
    const res = await staff.post(`/admin/clients/${accountId}/password`, {
      mode: 'reset_link',
      revokeSessions: true,
    });
    expect(res.status).toBe(200);
    // The account has a password now, so the link is a reset link, not an invitation.
    expect(res.body).toEqual({ link: 'reset' });
    expect((await account.me()).statusCode).toBe(401);
    const tokens = await tokensOfAccount();
    expect(tokens.at(-1)).toMatchObject({ purpose: 'reset', usedAt: null });
    expect((await db.select().from(s.outboxEvents)).map((event) => event.type)).toContain('customer.password_reset');
    const audits = await auditOfCustomer(db, accountId);
    expect(audits.at(-1)).toMatchObject({ action: 'sent a password reset link to' });
    expect(JSON.stringify(audits)).not.toContain(PASSWORD);
  });

  it('step 7: suspected hijacking: staff suspend the account; sessions end at once and nothing joins the blocklist', async () => {
    const { db, auto } = world;
    // An order the account paid for is on its way when the account is suspended (step 8 completes it).
    const row = await insertOrderRow(db, {
      accountId,
      serviceId: auto.serviceId,
      type: 'imei',
      source: 'store',
      dispatchState: 'manual',
      imei: '352905112490861',
      unitPrice: '12.4900',
      totalPrice: '12.4900',
      taxAmount: '2.5000',
      currency: 'USD',
    });
    orderId = row.id;
    await db.transaction((tx) =>
      postTransaction(
        tx,
        {
          ...b2cPay({ net: Money.of('12.49'), vat: Money.of('2.50') }),
          refId: orderId,
          idempotencyKey: `scenario:pay:${orderId}`,
          currency: 'USD',
          createdBy: { type: 'system', id: null },
        },
        clock.now(),
      ),
    );
    const signedIn = await new StoreClient(t, '198.18.1.4').call('POST', '/client/auth/sign-in', {
      email: EMAIL,
      password: PASSWORD,
    });
    expect(signedIn.statusCode).toBe(200);
    const res = await staff.patch(`/admin/clients/${accountId}`, {
      status: 'suspended',
      reason: 'Account may be compromised: the customer called support.',
    });
    expect(res.status).toBe(200);
    expect(await customerRow(accountId)).toMatchObject({
      status: 'suspended',
      suspendedBy: staff.staffId,
      suspendedReason: 'Account may be compromised: the customer called support.',
    });
    expect((await sessionsOfAccount()).filter((session) => session.revokedAt === null)).toEqual([]);
    // Only the entry staff added in step 1: the suspension added nothing.
    expect(await db.select().from(s.blocklistEntries)).toHaveLength(1);
    expect((await auditOfCustomer(db, accountId)).at(-1)).toMatchObject({ action: 'suspended account of' });
  });

  it('step 8: signing in is refused with ACCOUNT_SUSPENDED, and the order in progress still completes for the account', async () => {
    const { db } = world;
    const refused = await new StoreClient(t, '198.18.1.5').call('POST', '/client/auth/sign-in', {
      email: EMAIL,
      password: PASSWORD,
    });
    expect(refused.statusCode).toBe(403);
    expect(refused.json()).toMatchObject({ code: 'ACCOUNT_SUSPENDED' });
    // The link form stays silent for an account that may not act: the same 204 as for any address.
    expect((await new StoreClient(t, '198.18.1.6').magicLink(EMAIL)).statusCode).toBe(204);

    expect((await staff.post(`/admin/orders/${orderId}/reply`, { code: 'Unlocked' })).status).toBe(204);
    expect(await orderRow(db, orderId)).toMatchObject({ status: 'completed', accountId });
  });

  it('step 9: staff reactivate the account: the status is active, the reason is gone and the account signs in again', async () => {
    const { db } = await testDb();
    const res = await staff.patch(`/admin/clients/${accountId}`, { status: 'active' });
    expect(res.status).toBe(200);
    expect(await customerRow(accountId)).toMatchObject({
      status: 'active',
      suspendedAt: null,
      suspendedBy: null,
      suspendedReason: null,
    });
    const back = await new StoreClient(t, '198.18.1.7').call('POST', '/client/auth/sign-in', {
      email: EMAIL,
      password: PASSWORD,
    });
    expect(back.statusCode).toBe(200);
    expect((await auditOfCustomer(db, accountId)).at(-1)).toMatchObject({ action: 'reactivated account of' });
    // The scenario's last line: reactivation is not the block, which would have added the account to the blocklist.
    expect(await db.select().from(s.blocklistEntries)).toHaveLength(1);
  });
});

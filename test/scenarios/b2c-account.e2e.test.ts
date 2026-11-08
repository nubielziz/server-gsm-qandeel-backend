// End-to-end walk of the map scenario `b2c-account` (managing a customer's account, docs/slices/customers.json), step by step through
// HTTP on the real application: the tables and statuses each step names are read back from Postgres. The steps share one story, so
// the tests of this file run in order and keep their state in the variables below.
// The map has no step 3: the test of that number checks the invitation mail's outbox event (ids only), between steps 2 and 4.
// Step 8 also names a new checkout session, which feature 14a refuses for a suspended customer (ACCOUNT_SUSPENDED); 14a adds it here.
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { eq } from 'drizzle-orm';
import { Money } from '../../src/common/money';
import { TokenService } from '../../src/infra/crypto';
import { schema as s } from '../../src/infra/db';
import { b2cPay, postTransaction } from '../../src/modules/money';
import { type AdminApi, adminWith } from '../support/admin-api';
import { type TestApp, createTestApp } from '../support/app';
import { clearIdentityCaches, openSession } from '../support/auth';
import { HOUR, MINUTE, TestClock } from '../support/clock';
import { auditOfCustomer, insertTaxRates } from '../support/customers';
import { closeTestDb, resetDb, testDb } from '../support/db';
import { orderRow, ordersWorld, type OrdersWorld } from '../support/orders';
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
let customerId = 0;
let orderId = 0;
const EMAIL = 'daniel.whitmore@example.com';
const PASSWORD = 'a-much-longer-passphrase';

beforeAll(async () => {
  t = await createTestApp({ clock, env: { CORS_ORIGINS: STORE_ORIGIN } });
  await resetDb();
  await clearIdentityCaches(t);
  await clearStoreRateLimits(t);
  captureCustomerLinks(t);
  world = await ordersWorld((await testDb()).db);
  // Staff can only add a customer in a country the storefront sells to (one with a current tax rate).
  await insertTaxRates((await testDb()).db, ['GB']);
  staff = await adminWith(t, ['customers:*', 'orders:*'], { name: 'Lina S.' });
});
afterAll(async () => {
  await resetDb();
  await clearIdentityCaches(t);
  await t.close();
  await closeTestDb();
});

describe('scenario b2c-account: managing a customer account', () => {
  it('step 1: a staff member adds a customer by link; another customer’s email and a blocklisted one are refused', async () => {
    const { db } = await testDb();
    await db.insert(s.customers).values({ email: 'taken@example.com', name: 'Someone Else' });
    await db.insert(s.blocklistEntries).values({
      kind: 'email',
      valueHash: t.app.get(TokenService).hash('fraud@example.com'),
      display: 'f***@example.com',
    });
    const body = (email: string) => ({
      name: 'Daniel Whitmore',
      email,
      country: 'GB',
      locale: 'en',
      password: { mode: 'reset_link' },
    });
    expect((await staff.post('/admin/customers', body('taken@example.com'))).body).toMatchObject({
      code: 'EMAIL_TAKEN',
    });
    expect((await staff.post('/admin/customers', body('fraud@example.com'))).body).toMatchObject({
      errors: [{ field: 'email', message: 'This email is blocked.' }],
    });
    const created = await staff.post('/admin/customers', body(EMAIL));
    expect(created.status).toBe(201);
    customerId = created.body.id;
    expect(created.body).toMatchObject({ hasAccount: true, createdBy: staff.staffId, status: 'active' });
  });

  it('step 2: the account, its credentials without a password, a one-hour invitation (hash only) and the audit row', async () => {
    const { db } = await testDb();
    expect(await customerRow(customerId)).toMatchObject({
      hasAccount: true,
      createdBy: staff.staffId,
      status: 'active',
      emailVerifiedAt: null,
    });
    const [credentials] = await db
      .select()
      .from(s.customerCredentials)
      .where(eq(s.customerCredentials.customerId, customerId));
    expect(credentials).toMatchObject({ passwordHash: null, mustChangePassword: false });
    const [token] = await db.select().from(s.authTokens).where(eq(s.authTokens.subjectId, customerId));
    expect(token).toMatchObject({ purpose: 'invite', subjectType: 'customer', usedAt: null, createdBy: staff.staffId });
    expect(token!.expiresAt.getTime() - token!.createdAt.getTime()).toBe(HOUR);
    expect(token!.tokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(token!.tokenHash).not.toBe(customerLinks()[0]!.token);
    expect((await auditOfCustomer(db, customerId))[0]).toMatchObject({
      action: 'created customer',
      actorName: 'Lina S.',
    });
  });

  it('step 3: the invitation mail is one outbox event that carries ids only, never the token or the email', async () => {
    const { db } = await testDb();
    const [token] = await db.select().from(s.authTokens).where(eq(s.authTokens.subjectId, customerId));
    const events = await db.select().from(s.outboxEvents);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: 'customer.invited',
      aggregateType: 'customers',
      aggregateId: customerId,
      payload: { tokenId: token!.id },
    });
    // Decision 020: a job payload is ids only; the clear token exists only in the request that created it.
    const written = JSON.stringify(events[0]);
    expect(written).not.toContain(customerLinks()[0]!.token);
    expect(written).not.toContain(EMAIL);
  });

  it('step 4: the customer opens the link and chooses a password: the token is spent and the email is verified; older sessions end', async () => {
    const { db } = await testDb();
    // A session from before (the customer signed in some other way): the new password ends it.
    const older = await openSession(t, { type: 'customer', id: customerId });
    const [link] = customerLinks();
    clock.advance(10 * MINUTE);
    const res = await new StoreClient(t, '198.18.1.1').setPassword(link!.token, PASSWORD);
    expect(res.statusCode).toBe(204);

    const [token] = await db.select().from(s.authTokens).where(eq(s.authTokens.subjectId, customerId));
    expect(token!.usedAt).toEqual(new Date('2026-11-07T10:10:00.000Z'));
    expect(await customerRow(customerId)).toMatchObject({ emailVerifiedAt: new Date('2026-11-07T10:10:00.000Z') });
    const [credentials] = await db
      .select()
      .from(s.customerCredentials)
      .where(eq(s.customerCredentials.customerId, customerId));
    expect(credentials!.passwordHash).toStartWith('$argon2id$');
    expect(credentials!.passwordChangedAt).toEqual(new Date('2026-11-07T10:10:00.000Z'));
    const [oldSession] = await db.select().from(s.sessions).where(eq(s.sessions.id, older.sessionId));
    expect(oldSession!.revokedAt).not.toBeNull();
    // Single use.
    expect((await new StoreClient(t, '198.18.1.2').setPassword(link!.token, PASSWORD)).statusCode).toBe(410);
  });

  let customer: StoreClient;
  it('step 5: the customer signs in: a new session opens, last_login_at is written and the password is stored only as a hash', async () => {
    const { db } = await testDb();
    customer = new StoreClient(t, '198.18.1.3');
    const res = await customer.login(EMAIL, PASSWORD);
    expect(res.json()).toEqual({ next: 'done' });
    const sessions = (await db.select().from(s.sessions).where(eq(s.sessions.subjectId, customerId))).filter(
      (session) => session.subjectType === 'customer',
    );
    expect(sessions.filter((session) => session.revokedAt === null)).toHaveLength(1);
    expect(await customerRow(customerId)).toMatchObject({ lastLoginAt: new Date('2026-11-07T10:10:00.000Z') });
    expect((await customer.me()).json()).toMatchObject({ id: customerId, hasPassword: true });
  });

  it('step 6: the customer forgot the password: staff send a new link and end every session; no password reaches the audit log', async () => {
    const { db } = await testDb();
    const res = await staff.post(`/admin/customers/${customerId}/password`, {
      mode: 'reset_link',
      revokeSessions: true,
    });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({});
    expect((await customer.me()).statusCode).toBe(401);
    const tokens = await db.select().from(s.authTokens).where(eq(s.authTokens.subjectId, customerId));
    expect(tokens.at(-1)).toMatchObject({ purpose: 'reset', usedAt: null });
    expect((await db.select().from(s.outboxEvents)).map((event) => event.type)).toContain('customer.password_reset');
    const audits = await auditOfCustomer(db, customerId);
    expect(audits.at(-1)).toMatchObject({ action: 'sent a password reset link to' });
    expect(JSON.stringify(audits)).not.toContain(PASSWORD);
  });

  it('step 7: suspected hijacking: staff suspend the account; sessions end at once and nothing joins the blocklist', async () => {
    const { db, auto } = world;
    // An order the customer paid for is on its way when the account is suspended (step 8 completes it).
    const [row] = await db
      .insert(s.orders)
      .values({
        customerId,
        serviceId: auto.serviceId,
        type: 'imei',
        source: 'store',
        dispatchState: 'manual',
        imei: '352905112490861',
        unitPrice: '12.4900',
        totalPrice: '12.4900',
        taxAmount: '2.5000',
        currency: 'USD',
      })
      .returning({ id: s.orders.id });
    orderId = row!.id;
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
    await new StoreClient(t, '198.18.1.4').login(EMAIL, PASSWORD);
    const res = await staff.post(`/admin/customers/${customerId}/suspend`, {
      reason: 'Account may be compromised',
      note: 'The customer called support.',
    });
    expect(res.status).toBe(204);
    expect(await customerRow(customerId)).toMatchObject({
      status: 'suspended',
      suspendedBy: staff.staffId,
      suspendedReason: 'Account may be compromised: The customer called support.',
    });
    expect(
      (await db.select().from(s.sessions).where(eq(s.sessions.subjectId, customerId))).filter(
        (session) => session.subjectType === 'customer' && session.revokedAt === null,
      ),
    ).toEqual([]);
    // Only the entry staff added in step 1: the suspension added nothing.
    expect(await db.select().from(s.blocklistEntries)).toHaveLength(1);
    expect((await auditOfCustomer(db, customerId)).at(-1)).toMatchObject({ action: 'suspended account of' });
  });

  it('step 8: signing in is refused with ACCOUNT_SUSPENDED, and the order in progress still completes for the customer', async () => {
    const { db } = world;
    const refused = await new StoreClient(t, '198.18.1.5').login(EMAIL, PASSWORD);
    expect(refused.statusCode).toBe(403);
    expect(refused.json()).toMatchObject({ code: 'ACCOUNT_SUSPENDED' });
    expect((await new StoreClient(t, '198.18.1.6').magicLink(EMAIL)).statusCode).toBe(204);

    expect((await staff.post(`/admin/orders/${orderId}/reply`, { code: 'Unlocked' })).status).toBe(204);
    expect(await orderRow(db, orderId)).toMatchObject({ status: 'completed', customerId });
  });

  it('step 9: staff reactivate the account: the status is active, the reason is gone and the customer signs in again', async () => {
    const { db } = await testDb();
    const res = await staff.post(`/admin/customers/${customerId}/reactivate`);
    expect(res.status).toBe(204);
    expect(await customerRow(customerId)).toMatchObject({
      status: 'active',
      suspendedAt: null,
      suspendedBy: null,
      suspendedReason: null,
    });
    expect((await new StoreClient(t, '198.18.1.7').login(EMAIL, PASSWORD)).statusCode).toBe(200);
    expect((await auditOfCustomer(db, customerId)).at(-1)).toMatchObject({ action: 'reactivated account of' });
    // The scenario's last line: reactivation is not the block, which would have added the customer to the blocklist.
    expect(await db.select().from(s.blocklistEntries)).toHaveLength(1);
  });
});

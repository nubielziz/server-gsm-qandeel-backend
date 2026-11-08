// Integration tests of the admin customer routes (feature 14b, GET and POST /admin/customers, GET and PATCH /admin/customers/:id;
// RESOLUTIONS b2c-1, b2c-11, b2c-12, b2c-14, b2c-16; scenario b2c-account steps 1 and 2): the list with its filters, sorts and
// order figures, the detail with the account, consent evidence and risk, creating a customer (both password modes) and editing one.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, mock } from 'bun:test';
import { eq } from 'drizzle-orm';
import type { PoolClient } from 'pg';
import { PasswordHasher, TokenService } from '../../src/infra/crypto';
import { DbService, schema as s } from '../../src/infra/db';
import { CustomerAuthTokens } from '../../src/modules/identity';
import { type TestApp, createTestApp } from '../support/app';
import { clearIdentityCaches, signInStaff } from '../support/auth';
import { DAY, HOUR, TestClock } from '../support/clock';
import {
  auditOfCustomer,
  insertAnyService,
  insertCustomerHistory,
  insertCustomerOrder,
  insertStoreCurrencies,
  insertTaxRates,
} from '../support/customers';
import { closeTestDb, resetDb, testDb } from '../support/db';
import { eventually } from '../support/infra';
import { insertOrderRow } from '../support/orders';
import { insertBlock } from '../support/risk';
import { StoreClient, captureCustomerLinks, customerLinks, customerRow, makeCustomer } from '../support/store';

const clock = new TestClock('2026-11-07T10:00:00.000Z');
let t: TestApp;

beforeAll(async () => {
  t = await createTestApp({ clock });
});
afterAll(async () => {
  await resetDb();
  await t.close();
  await closeTestDb();
});
beforeEach(async () => {
  clock.set('2026-11-07T10:00:00.000Z');
  await resetDb();
  // The countries the tests below use are ones the storefront sells to; Jordan and Canada have no row unless a test adds one.
  await insertTaxRates((await testDb()).db, ['GB', 'DE', 'ES', 'SE', 'US']);
  await clearIdentityCaches(t);
  captureCustomerLinks(t);
});
afterEach(() => mock.restore());

type Staff = Awaited<ReturnType<typeof signInStaff>>;
const get = (staff: Staff, url: string) => t.app.inject({ method: 'GET', url, headers: staff.session.headers });
const send = (staff: Staff, method: 'POST' | 'PATCH', url: string, payload?: unknown) =>
  t.app.inject({
    method,
    url,
    headers: staff.session.mutationHeaders,
    ...(payload === undefined ? {} : { payload: payload as never }),
  });
const staffWith = (...permissions: string[]) => signInStaff(t, permissions);
/**
 * Ends the side connection of a locking test.
 *
 * Why: a failing assertion must not leave the row locked (`resetDb` would wait for the lock for ever), so whatever is still open is rolled back
 * (nothing after a commit); the connection is dropped if even that fails.
 */
async function rollbackAndRelease(client: PoolClient): Promise<void> {
  const rolledBack = await client.query('rollback').then(
    () => true,
    () => false,
  );
  client.release(!rolledBack);
}
const problem = (res: { json: () => unknown }) =>
  res.json() as { code: string; detail?: string; errors?: Array<{ field: string; message: string }> };

describe('GET /admin/customers', () => {
  /** Six customers across countries, statuses and risk levels, with orders for two of them. */
  async function world() {
    const { db } = await testDb();
    await insertStoreCurrencies(db);
    const serviceId = await insertAnyService(db);
    const daniel = await makeCustomer(t, {
      name: 'Daniel Whitmore',
      email: 'daniel.whitmore@example.com',
      country: 'GB',
      currency: 'GBP',
      totalSpent: '120.5000',
    });
    const sofia = await makeCustomer(t, {
      name: 'Sofia Alvarez',
      email: 'sofia@example.com',
      country: 'ES',
      currency: 'EUR',
      guest: true,
      totalSpent: '48.0000',
      riskLevel: 'medium',
    });
    const jt = await makeCustomer(t, {
      name: 'JT Temp',
      email: 'jt.1234@tempbox.example',
      country: 'US',
      currency: 'USD',
      status: 'blocked',
      riskLevel: 'high',
      totalSpent: '0.0000',
    });
    const erik = await makeCustomer(t, {
      name: 'Erik Lindqvist',
      email: 'erik@example.com',
      country: 'SE',
      currency: null,
      status: 'suspended',
      totalSpent: '12.0000',
    });
    const mia = await makeCustomer(t, { name: 'Mia Schneider', email: 'mia@example.com', country: 'DE', guest: true });
    await insertCustomerOrder(db, serviceId, daniel.id, { createdAt: new Date('2026-10-01T10:00:00.000Z') });
    await insertCustomerOrder(db, serviceId, daniel.id, { createdAt: new Date('2026-10-20T10:00:00.000Z') });
    await insertCustomerOrder(db, serviceId, sofia.id, { createdAt: new Date('2026-10-25T10:00:00.000Z') });
    return { daniel, sofia, jt, erik, mia };
  }
  const names = (res: { json: () => unknown }) => (res.json() as Array<{ name: string }>).map((row) => row.name);

  it('lists customers with the currency id and code, the order figures and x-total-count, highest spend first', async () => {
    const { daniel, erik } = await world();
    const staff = await staffWith('customers:read');
    const res = await get(staff, '/admin/customers');
    expect(res.statusCode).toBe(200);
    expect(res.headers['x-total-count']).toBe('5');
    expect(names(res)).toEqual(['Daniel Whitmore', 'Sofia Alvarez', 'Erik Lindqvist', 'Mia Schneider', 'JT Temp']);
    const rows = res.json<Array<Record<string, unknown>>>();
    expect(rows[0]).toEqual({
      id: daniel.id,
      email: 'daniel.whitmore@example.com',
      emailVerifiedAt: null,
      name: 'Daniel Whitmore',
      phone: '',
      country: 'GB',
      locale: 'en',
      currency: 2,
      currencyCode: 'GBP',
      hasAccount: true,
      createdBy: null,
      marketingOptIn: false,
      riskLevel: 'low',
      status: 'active',
      suspendedAt: null,
      suspendedReason: null,
      suspendedBy: null,
      internalNotes: '',
      lastLoginAt: null,
      firstOrderAt: null,
      totalSpent: '120.5000',
      anonymizedAt: null,
      createdAt: expect.any(String),
      ordersCount: 2,
      lastOrderAt: '2026-10-20T10:00:00.000Z',
    });
    // No currency: both null (B148).
    expect(rows.find((row) => row.id === erik.id)).toMatchObject({
      currency: null,
      currencyCode: null,
      ordersCount: 0,
      lastOrderAt: null,
    });
  });

  it('filters by status and riskLevel (repeat the key for IN), country and hasAccount', async () => {
    await world();
    const staff = await staffWith('customers:read');
    expect(names(await get(staff, '/admin/customers?status=suspended&status=blocked&_sort=name&_order=asc'))).toEqual([
      'Erik Lindqvist',
      'JT Temp',
    ]);
    const flagged = await get(staff, '/admin/customers?riskLevel=medium&riskLevel=high&_sort=name');
    expect(names(flagged)).toEqual(['JT Temp', 'Sofia Alvarez']);
    expect(flagged.headers['x-total-count']).toBe('2');
    expect(names(await get(staff, '/admin/customers?country=GB'))).toEqual(['Daniel Whitmore']);
    const guests = await get(staff, '/admin/customers?hasAccount=false&_sort=name');
    expect(names(guests)).toEqual(['Mia Schneider', 'Sofia Alvarez']);
    expect((await get(staff, '/admin/customers?hasAccount=true')).headers['x-total-count']).toBe('3');
    expect((await get(staff, '/admin/customers?status=gone')).statusCode).toBe(422);
  });

  it('searches the name and the email only, ignoring case, and pages', async () => {
    await world();
    const staff = await staffWith('customers:read');
    expect(names(await get(staff, '/admin/customers?q=WHITMORE'))).toEqual(['Daniel Whitmore']);
    expect(names(await get(staff, '/admin/customers?q=tempbox'))).toEqual(['JT Temp']);
    // The country is its own filter, not part of the search (M86).
    expect(names(await get(staff, '/admin/customers?q=GB'))).toEqual([]);
    const page = await get(staff, '/admin/customers?_sort=name&_order=asc&_start=1&_end=3');
    expect(names(page)).toEqual(['Erik Lindqvist', 'JT Temp']);
    expect(page.headers['x-total-count']).toBe('5');
  });

  it('sorts by the order figures and by risk (low, medium, high), and refuses a sort it does not know', async () => {
    await world();
    const staff = await staffWith('customers:read');
    expect(names(await get(staff, '/admin/customers?_sort=ordersCount&_order=desc')).slice(0, 2)).toEqual([
      'Daniel Whitmore',
      'Sofia Alvarez',
    ]);
    // The latest order first; customers without orders last in both directions.
    expect(names(await get(staff, '/admin/customers?_sort=lastOrderAt&_order=desc')).slice(0, 2)).toEqual([
      'Sofia Alvarez',
      'Daniel Whitmore',
    ]);
    expect(names(await get(staff, '/admin/customers?_sort=riskLevel&_order=desc')).slice(0, 2)).toEqual([
      'JT Temp',
      'Sofia Alvarez',
    ]);
    expect(names(await get(staff, '/admin/customers?_sort=riskLevel&_order=asc')).at(-1)).toBe('JT Temp');
    expect(
      names(await get(staff, '/admin/customers?_sort=hasAccount&_order=desc'))
        .slice(0, 3)
        .sort(),
    ).toEqual(['Daniel Whitmore', 'Erik Lindqvist', 'JT Temp']);
    expect((await get(staff, '/admin/customers?_sort=email')).statusCode).toBe(422);
  });

  it('answers the palette’s small search page, 403 without customers:read and 401 without a session', async () => {
    await world();
    const staff = await staffWith('customers:read');
    expect((await get(staff, '/admin/customers?q=example&_start=0&_end=4')).json<unknown[]>()).toHaveLength(4);
    const denied = await get(await staffWith('orders:read'), '/admin/customers');
    expect(denied.statusCode).toBe(403);
    expect(problem(denied).code).toBe('FORBIDDEN');
    expect((await t.app.inject({ method: 'GET', url: '/admin/customers' })).statusCode).toBe(401);
  });
});

describe('GET /admin/customers/:id', () => {
  it('shows the account side of an account: forced change, link time, live sessions and the address last seen from', async () => {
    const { db } = await testDb();
    await insertStoreCurrencies(db);
    const customer = await makeCustomer(t, { currency: 'GBP', emailVerifiedAt: new Date('2026-10-12T09:30:00.000Z') });
    await db
      .update(s.customerCredentials)
      .set({ mustChangePassword: true, passwordChangedAt: new Date('2026-11-01T08:00:00.000Z') });
    await t.app
      .get(DbService)
      .runInTransaction((work) =>
        t.app.get(CustomerAuthTokens).issue(work, { customerId: customer.id, purpose: 'reset', ip: '203.0.113.9' }),
      );
    // Three sessions: live, revoked and expired; the live one is the newest address.
    const base = { subjectType: 'customer' as const, subjectId: customer.id, stage: 'active' as const, tokenHash: '' };
    await db.insert(s.sessions).values([
      {
        ...base,
        tokenHash: 'a'.repeat(64),
        ip: '198.51.100.1',
        expiresAt: new Date(clock.nowMs() + DAY),
        createdAt: new Date(clock.nowMs() - 3 * HOUR),
      },
      {
        ...base,
        tokenHash: 'b'.repeat(64),
        ip: '198.51.100.2',
        expiresAt: new Date(clock.nowMs() + DAY),
        revokedAt: new Date(clock.nowMs()),
        createdAt: new Date(clock.nowMs() - 5 * HOUR),
      },
      {
        ...base,
        tokenHash: 'c'.repeat(64),
        ip: '198.51.100.3',
        expiresAt: new Date(clock.nowMs() - HOUR),
        createdAt: new Date(clock.nowMs() - 6 * HOUR),
      },
    ]);
    // A newer checkout from another address wins "last seen from".
    const serviceId = await insertAnyService(db);
    await db.insert(s.checkoutSessions).values({
      token: 'checkout-token-0001',
      customerId: customer.id,
      email: customer.email,
      serviceId,
      currency: 'GBP',
      netAmount: '11.0000',
      grossAmount: '13.2000',
      ip: '192.0.2.77',
      expiresAt: new Date(clock.nowMs() + HOUR),
      createdAt: new Date(clock.nowMs() - HOUR),
    });

    const staff = await staffWith('customers:read');
    const res = await get(staff, `/admin/customers/${customer.id}`);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      id: customer.id,
      currency: 2,
      currencyCode: 'GBP',
      stats: { orders: 0, spent: '0.0000', lastOrderAt: null, refunds: 0, tickets: 0, disputes: 0 },
      account: {
        emailVerified: true,
        mustChangePassword: true,
        passwordChangedAt: '2026-11-01T08:00:00.000Z',
        resetSentAt: '2026-11-07T10:00:00.000Z',
        activeSessions: 1,
        lastIp: '192.0.2.77',
      },
      latestConsents: null,
      risk: { highestScore: null, signals: [] },
    });
  });

  it('gives a guest no account and an unknown id 404', async () => {
    const guest = await makeCustomer(t, { guest: true });
    const staff = await staffWith('customers:read');
    expect((await get(staff, `/admin/customers/${guest.id}`)).json()).toMatchObject({
      hasAccount: false,
      account: null,
    });
    const missing = await get(staff, '/admin/customers/999999');
    expect(missing.statusCode).toBe(404);
    expect(problem(missing).code).toBe('NOT_FOUND');
    expect((await get(staff, '/admin/customers/abc')).statusCode).toBe(422);
  });

  it('counts the refunds, tickets and disputes and the orders, and reads the consent evidence of the latest order', async () => {
    const { db } = await testDb();
    await insertStoreCurrencies(db);
    const serviceId = await insertAnyService(db);
    const customer = await makeCustomer(t, { guest: true, totalSpent: '27.5000' });
    const older = await insertCustomerOrder(db, serviceId, customer.id, {
      createdAt: new Date('2026-10-01T10:00:00.000Z'),
    });
    const latest = await insertCustomerOrder(db, serviceId, customer.id, {
      createdAt: new Date('2026-10-30T14:20:00.000Z'),
    });
    await insertCustomerHistory(db, customer.id, latest);
    const [terms] = await db
      .insert(s.legalDocuments)
      .values({ type: 'terms', version: '3.2', bodyMd: 'Terms', isCurrent: true })
      .returning();
    const at = (time: string) => new Date(time);
    const record = (
      purpose: 'terms' | 'privacy' | 'withdrawal_waiver' | 'marketing',
      orderId: number,
      time: string,
      ip: string,
      doc?: number,
    ) => ({
      subjectType: 'customer' as const,
      subjectId: customer.id,
      purpose,
      granted: true,
      orderId,
      ip,
      legalDocumentId: doc ?? null,
      createdAt: at(time),
    });
    await db
      .insert(s.consentRecords)
      .values([
        record('terms', older, '2026-10-01T09:59:00.000Z', '198.51.100.5', terms!.id),
        record('terms', latest, '2026-10-30T14:19:19.000Z', '203.0.113.24', terms!.id),
        record('withdrawal_waiver', latest, '2026-10-30T14:19:22.000Z', '203.0.113.24'),
      ]);

    const staff = await staffWith('customers:read');
    const detail = (await get(staff, `/admin/customers/${customer.id}`)).json();
    expect(detail).toMatchObject({
      stats: {
        orders: 2,
        spent: '27.5000',
        lastOrderAt: '2026-10-30T14:20:00.000Z',
        refunds: 1,
        tickets: 1,
        disputes: 1,
      },
      account: null,
      latestConsents: {
        orderId: latest,
        records: [
          { purpose: 'terms', document: 'Terms of service v3.2', at: '2026-10-30T14:19:19.000Z', ip: '203.0.113.24' },
          { purpose: 'withdrawal_waiver', document: null, at: '2026-10-30T14:19:22.000Z', ip: '203.0.113.24' },
        ],
      },
    });
  });

  it('summarises the risk: the highest score of every assessment, the signals of those with an order, newest first, at most 20', async () => {
    const { db } = await testDb();
    await insertStoreCurrencies(db);
    const serviceId = await insertAnyService(db);
    const customer = await makeCustomer(t);
    const firstOrder = await insertCustomerOrder(db, serviceId, customer.id);
    const secondOrder = await insertCustomerOrder(db, serviceId, customer.id);
    await db.insert(s.riskAssessments).values([
      {
        customerId: customer.id,
        orderId: firstOrder,
        score: 35,
        decision: 'allow',
        signals: ['New device', 'Free email'],
        createdAt: new Date('2026-10-01T10:00:00.000Z'),
      },
      {
        customerId: customer.id,
        orderId: secondOrder,
        score: 61,
        decision: 'review',
        signals: Array.from({ length: 22 }, (_, i) => `Signal ${i + 1}`),
        createdAt: new Date('2026-10-02T10:00:00.000Z'),
      },
      // An assessment of a checkout that never became an order: counts for the score, shows no signal.
      {
        customerId: customer.id,
        score: 80,
        decision: 'block',
        signals: ['Card testing'],
        createdAt: new Date('2026-10-03T10:00:00.000Z'),
      },
    ]);
    const staff = await staffWith('customers:read');
    const { risk } = (await get(staff, `/admin/customers/${customer.id}`)).json<{
      risk: { highestScore: number; signals: Array<{ text: string; orderId: number }> };
    }>();
    expect(risk.highestScore).toBe(80);
    expect(risk.signals).toHaveLength(20);
    expect(risk.signals[0]).toEqual({ text: 'Signal 1', orderId: secondOrder });
    expect(risk.signals.at(-1)).toEqual({ text: 'Signal 20', orderId: secondOrder });
    expect(risk.signals.some((signal) => signal.text === 'Card testing')).toBe(false);
  });
});

describe('POST /admin/customers', () => {
  const body = (overrides: Record<string, unknown> = {}) => ({
    name: '  Daniel   Whitmore ',
    email: ' Daniel.Whitmore@Example.com ',
    country: 'gb',
    locale: 'en',
    phone: ' +447700900123 ',
    password: { mode: 'reset_link' },
    ...overrides,
  });

  it('creates an account with an invitation link: row, credentials without a password, one-hour link, outbox event, audit', async () => {
    const { db } = await testDb();
    await insertStoreCurrencies(db);
    const staff = await staffWith('customers:create');
    const res = await send(staff, 'POST', '/admin/customers', body());
    expect(res.statusCode).toBe(201);
    expect(res.headers['cache-control']).toBe('no-store');
    const created = res.json<Record<string, unknown> & { id: number }>();
    expect(created).toMatchObject({
      email: 'daniel.whitmore@example.com',
      name: 'Daniel Whitmore',
      phone: '+447700900123',
      country: 'GB',
      locale: 'en',
      currency: 2,
      currencyCode: 'GBP',
      hasAccount: true,
      createdBy: staff.staffId,
      status: 'active',
      riskLevel: 'low',
      marketingOptIn: false,
      totalSpent: '0.0000',
      ordersCount: 0,
      lastOrderAt: null,
      emailVerifiedAt: null,
      createdAt: '2026-11-07T10:00:00.000Z',
    });
    expect(created).not.toHaveProperty('temporaryPassword');

    const [credentials] = await db.select().from(s.customerCredentials);
    expect(credentials).toMatchObject({
      customerId: created.id,
      passwordHash: null,
      mustChangePassword: false,
      updatedBy: staff.staffId,
    });
    const [link] = await db.select().from(s.authTokens);
    expect(link).toMatchObject({
      purpose: 'invite',
      subjectType: 'customer',
      subjectId: created.id,
      createdBy: staff.staffId,
      usedAt: null,
    });
    expect(link!.expiresAt.toISOString()).toBe('2026-11-07T11:00:00.000Z');
    const [event] = await db.select().from(s.outboxEvents);
    expect(event).toMatchObject({ type: 'customer.invited', aggregateType: 'customers', aggregateId: created.id });
    expect(customerLinks()).toMatchObject([{ kind: 'invited', customerId: created.id }]);

    const [audit] = await auditOfCustomer(db, created.id);
    expect(audit).toMatchObject({
      action: 'created customer',
      entityLabel: 'Daniel Whitmore',
      actorType: 'staff',
      actorId: staff.staffId,
      after: {
        email: 'daniel.whitmore@example.com',
        country: 'GB',
        created_by: 'staff',
        credential: 'invite link emailed',
      },
    });
    expect(JSON.stringify(audit)).not.toContain(customerLinks()[0]!.token);
  });

  it('creates an account with a temporary password: shown once, only the hash stored, a forced change, no link', async () => {
    const { db } = await testDb();
    await insertStoreCurrencies(db);
    const staff = await staffWith('customers:create');
    const res = await send(staff, 'POST', '/admin/customers', body({ password: { mode: 'temporary_password' } }));
    expect(res.statusCode).toBe(201);
    expect(res.headers['cache-control']).toBe('no-store');
    const { temporaryPassword, id } = res.json<{ temporaryPassword: string; id: number }>();
    expect(temporaryPassword).toHaveLength(14);

    const [credentials] = await db.select().from(s.customerCredentials);
    expect(credentials).toMatchObject({
      mustChangePassword: true,
      passwordChangedAt: new Date('2026-11-07T10:00:00.000Z'),
    });
    expect(credentials!.passwordHash).not.toContain(temporaryPassword);
    expect(await t.app.get(PasswordHasher).verify(credentials!.passwordHash!, temporaryPassword)).toBe(true);
    expect(await db.select().from(s.authTokens)).toHaveLength(0);
    expect(await db.select().from(s.outboxEvents)).toHaveLength(0);
    const [audit] = await auditOfCustomer(db, id);
    expect(audit!.after).toMatchObject({ credential: 'temporary password set' });
    expect(JSON.stringify(audit)).not.toContain(temporaryPassword);
    // The password the staff member hands over signs the customer in, and then asks for a change.
    const { StoreClient } = await import('../support/store');
    const login = await new StoreClient(t).login('daniel.whitmore@example.com', temporaryPassword);
    expect(login.json()).toEqual({ next: 'password' });
  });

  it('derives the currency from the country: its storefront currency when active, else USD', async () => {
    const { db } = await testDb();
    await insertStoreCurrencies(db);
    await insertTaxRates(db, ['CA']);
    const staff = await staffWith('customers:create');
    const created = (email: string, country: string) =>
      send(staff, 'POST', '/admin/customers', body({ email, country }));
    // The pound is a storefront currency.
    expect((await created('gb@example.com', 'GB')).json()).toMatchObject({ currency: 2, currencyCode: 'GBP' });
    // The krona is in the table but the store does not show it: USD.
    expect((await created('a@example.com', 'SE')).json()).toMatchObject({
      country: 'SE',
      currency: 1,
      currencyCode: 'USD',
    });
    // Canada pays in CAD, which this database does not list: USD, not null.
    expect((await created('c@example.com', 'CA')).json()).toMatchObject({
      country: 'CA',
      currency: 1,
      currencyCode: 'USD',
    });
    // Once the krona is shown by the store, Swedish customers pay in it; an inactive one is still USD.
    await db.update(s.currencies).set({ isStorefront: true }).where(eq(s.currencies.code, 'SEK'));
    expect((await created('b@example.com', 'SE')).json()).toMatchObject({ currency: 4, currencyCode: 'SEK' });
    await db.update(s.currencies).set({ isActive: false }).where(eq(s.currencies.code, 'SEK'));
    expect((await created('d@example.com', 'SE')).json()).toMatchObject({ currency: 1, currencyCode: 'USD' });
  });

  it('refuses a country with no current tax rate: 422 on country, nothing written (ANSWERS customers Q8)', async () => {
    const { db } = await testDb();
    await insertStoreCurrencies(db);
    const staff = await staffWith('customers:create');
    const create = (country: string) =>
      send(staff, 'POST', '/admin/customers', body({ email: 'jo@example.com', country }));
    const expectChoose = async (country: string) => {
      const res = await create(country);
      expect(res.statusCode).toBe(422);
      expect(problem(res)).toMatchObject({
        code: 'VALIDATION_FAILED',
        errors: [{ field: 'country', message: 'Choose a country.' }],
      });
    };
    // No row at all.
    await expectChoose('JO');
    // A window that has ended, one that has not begun (the clock decides, decision 031).
    await insertTaxRates(db, ['JO'], { validTo: new Date(clock.nowMs() - DAY) });
    await expectChoose('jo');
    await db.delete(s.taxRates).where(eq(s.taxRates.country, 'JO'));
    await insertTaxRates(db, ['JO'], { validFrom: new Date(clock.nowMs() + DAY) });
    await expectChoose('JO');
    expect(await db.select().from(s.customers)).toHaveLength(0);
    expect(await db.select().from(s.customerCredentials)).toHaveLength(0);
    expect(await db.select().from(s.outboxEvents)).toHaveLength(0);
    expect(await db.select().from(s.auditLogs)).toHaveLength(0);
    // A window that begins right now, and one that ends later, both count.
    await db.delete(s.taxRates).where(eq(s.taxRates.country, 'JO'));
    await insertTaxRates(db, ['JO'], { validFrom: new Date(clock.nowMs()) });
    expect((await create('JO')).statusCode).toBe(201);
    await db.delete(s.taxRates).where(eq(s.taxRates.country, 'JO'));
    await insertTaxRates(db, ['JO'], { validTo: new Date(clock.nowMs() + DAY) });
    expect(
      (await send(staff, 'POST', '/admin/customers', body({ email: 'jo2@example.com', country: 'JO' }))).statusCode,
    ).toBe(201);
  });

  it('refuses an email another customer has, guest or account, with 409 EMAIL_TAKEN naming the owner', async () => {
    await makeCustomer(t, { name: 'Sofia Alvarez', email: 'sofia@example.com', guest: true });
    await makeCustomer(t, { name: 'Dan Account', email: 'dan@example.com' });
    const staff = await staffWith('customers:create');
    const guest = await send(staff, 'POST', '/admin/customers', body({ email: 'SOFIA@example.com' }));
    expect(guest.statusCode).toBe(409);
    expect(problem(guest)).toMatchObject({ code: 'EMAIL_TAKEN' });
    expect(problem(guest).detail).toBe(
      'sofia@example.com already belongs to Sofia Alvarez, who bought as a guest. Open them and use “Create account” instead.',
    );
    expect(problem(guest).errors ?? []).toEqual([]);
    const account = await send(staff, 'POST', '/admin/customers', body({ email: 'dan@example.com' }));
    expect(problem(account).detail).toBe('dan@example.com already belongs to Dan Account.');
  });

  it('refuses a blocklisted email with 422 on email and no code of its own (B46, b2c-16)', async () => {
    const { db } = await testDb();
    await db.insert(s.blocklistEntries).values({
      kind: 'email',
      valueHash: t.app.get(TokenService).hash('bad@example.com'),
      display: 'b***@example.com',
    });
    const staff = await staffWith('customers:create');
    const res = await send(staff, 'POST', '/admin/customers', body({ email: 'Bad@example.com' }));
    expect(res.statusCode).toBe(422);
    expect(problem(res)).toMatchObject({
      code: 'VALIDATION_FAILED',
      errors: [{ field: 'email', message: 'This email is blocked.' }],
    });
    expect(await db.select().from(s.customers)).toHaveLength(0);
    // An expired entry no longer blocks.
    await db.update(s.blocklistEntries).set({ expiresAt: new Date(clock.nowMs() - HOUR) });
    expect((await send(staff, 'POST', '/admin/customers', body({ email: 'bad@example.com' }))).statusCode).toBe(201);
  });

  it('refuses an email on a blocklisted domain the same way, when staff create a customer and when they change the email', async () => {
    const { db } = await testDb();
    await insertBlock(t, db, 'domain', 'tempbox.example');
    const creator = await staffWith('customers:create');
    const created = await send(creator, 'POST', '/admin/customers', body({ email: 'Anyone@TempBox.example' }));
    expect(created.statusCode).toBe(422);
    expect(problem(created).errors).toMatchObject([{ field: 'email', message: 'This email is blocked.' }]);
    expect(await db.select().from(s.customers)).toHaveLength(0);
    const customer = await makeCustomer(t, { email: 'fine@example.com' });
    const editor = await staffWith('customers:update');
    const changed = await send(editor, 'PATCH', `/admin/customers/${customer.id}`, { email: 'moved@tempbox.example' });
    expect(changed.statusCode).toBe(422);
    expect(problem(changed).errors).toMatchObject([{ field: 'email', message: 'This email is blocked.' }]);
    expect((await customerRow(customer.id)).email).toBe('fine@example.com');
  });

  it('answers 422 on each bad field, including the dotted password.mode', async () => {
    const staff = await staffWith('customers:create');
    const res = await send(staff, 'POST', '/admin/customers', {
      name: 'D',
      email: 'not-an-email',
      country: 'Britain',
      locale: 'fr',
      phone: 'x'.repeat(41),
      password: { mode: 'sms' },
    });
    expect(res.statusCode).toBe(422);
    expect(
      problem(res)
        .errors?.map((e) => e.field)
        .sort(),
    ).toEqual(['country', 'email', 'locale', 'name', 'password.mode', 'phone'].sort());
    const missing = await send(staff, 'POST', '/admin/customers', {});
    expect(missing.statusCode).toBe(422);
  });

  it('lets only one of two parallel requests with the same email create the customer', async () => {
    const staff = await staffWith('customers:create');
    const results = await Promise.all([
      send(staff, 'POST', '/admin/customers', body()),
      send(staff, 'POST', '/admin/customers', body()),
    ]);
    expect(results.map((res) => res.statusCode).sort()).toEqual([201, 409]);
    const { db } = await testDb();
    expect(await db.select().from(s.customers)).toHaveLength(1);
  });

  it('needs customers:create and the CSRF token', async () => {
    const reader = await staffWith('customers:read');
    expect((await send(reader, 'POST', '/admin/customers', body())).statusCode).toBe(403);
    const writer = await staffWith('customers:create');
    const noToken = await t.app.inject({
      method: 'POST',
      url: '/admin/customers',
      headers: writer.session.headers,
      payload: body() as never,
    });
    expect(noToken.statusCode).toBe(403);
    expect(problem(noToken).code).toBe('CSRF_FAILED');
  });
});

describe('PATCH /admin/customers/:id', () => {
  it('changes the fields sent, re-derives the currency on a country change and audits the old and new values', async () => {
    const { db } = await testDb();
    await insertStoreCurrencies(db);
    await db.update(s.currencies).set({ isStorefront: true }).where(eq(s.currencies.code, 'SEK'));
    const customer = await makeCustomer(t, { name: 'Old Name', country: 'GB', currency: 'GBP', phone: '1' });
    const staff = await staffWith('customers:update');
    const res = await send(staff, 'PATCH', `/admin/customers/${customer.id}`, {
      name: '  New   Name ',
      country: 'se',
      locale: 'ar',
      phone: '',
      internalNotes: 'Prefers email.',
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      name: 'New Name',
      country: 'SE',
      currency: 4,
      currencyCode: 'SEK',
      locale: 'ar',
      phone: '',
      internalNotes: 'Prefers email.',
    });
    const [audit] = await auditOfCustomer(db, customer.id);
    expect(audit).toMatchObject({
      action: 'edited details of',
      entityLabel: 'Old Name',
      before: { name: 'Old Name', country: 'GB', locale: 'en', phone: '1', notes: '' },
      after: { name: 'New Name', country: 'SE', locale: 'ar', phone: '', notes: 'Prefers email.' },
    });
  });

  it('refuses a new country with no current tax rate and falls back to USD; the stored country may be sent again', async () => {
    const { db } = await testDb();
    await insertStoreCurrencies(db);
    await insertTaxRates(db, ['CA']);
    const customer = await makeCustomer(t, { name: 'Old Name', country: 'GB', currency: 'GBP' });
    const abroad = await makeCustomer(t, {
      name: 'Jordan Based',
      email: 'jo@example.com',
      country: 'JO',
      currency: 'USD',
    });
    const staff = await staffWith('customers:update');
    const patch = (id: number, payload: Record<string, unknown>) =>
      send(staff, 'PATCH', `/admin/customers/${id}`, payload);

    const refused = await patch(customer.id, { name: 'Changed', country: 'jo' });
    expect(refused.statusCode).toBe(422);
    expect(problem(refused)).toMatchObject({
      code: 'VALIDATION_FAILED',
      errors: [{ field: 'country', message: 'Choose a country.' }],
    });
    // Nothing of the refused edit was kept, not even the name.
    expect(await customerRow(customer.id)).toMatchObject({ name: 'Old Name', country: 'GB', currency: 'GBP' });
    expect(await auditOfCustomer(db, customer.id)).toHaveLength(0);

    // Canada has a rate but its currency is not in the table: USD, not null.
    const canada = await patch(customer.id, { country: 'CA' });
    expect(canada.statusCode).toBe(200);
    expect(canada.json()).toMatchObject({ country: 'CA', currency: 1, currencyCode: 'USD' });

    // A customer whose country has no rate (any more) can still be edited when the country is sent unchanged.
    const same = await patch(abroad.id, { name: 'Jordan Renamed', country: 'JO' });
    expect(same.statusCode).toBe(200);
    expect(same.json()).toMatchObject({ name: 'Jordan Renamed', country: 'JO' });
  });

  it('judges a country change against the row it locks: another edit that lands first can make "unchanged" a change', async () => {
    const { db, pool } = await testDb();
    await insertStoreCurrencies(db);
    // Jordan has no current tax rate in these tests, so the shop cannot sell there.
    const customer = await makeCustomer(t, { name: 'Racing Edit', country: 'JO', currency: 'USD' });
    const staff = await staffWith('customers:update');

    // Another edit holds the row and moves the customer to Great Britain; it commits only after the PATCH is waiting for the row.
    const other = await pool.connect();
    try {
      await other.query('begin');
      await other.query('select id from customers where id = $1 for update', [customer.id]);
      await other.query(`update customers set country = 'GB', currency = 'GBP' where id = $1`, [customer.id]);
      // The PATCH reads Jordan (the committed row), so it sees nothing to check; under the lock the country is GB.
      const patch = send(staff, 'PATCH', `/admin/customers/${customer.id}`, { country: 'JO' });
      await eventually(async () => {
        const { rows } = await pool.query(
          `select 1 from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock' and query ilike '%from "customers"%for update%'`,
        );
        return rows.length > 0 ? true : undefined;
      });
      await other.query('commit');
      const res = await patch;
      expect(res.statusCode).toBe(422);
      expect(problem(res)).toMatchObject({
        code: 'VALIDATION_FAILED',
        errors: [{ field: 'country', message: 'Choose a country.' }],
      });
    } finally {
      await rollbackAndRelease(other);
    }
    expect(await customerRow(customer.id)).toMatchObject({ country: 'GB', currency: 'GBP' });
    expect(await auditOfCustomer(db, customer.id)).toHaveLength(0);
  });

  it('judges an email change against the row it locks: another edit that lands first can make "unchanged" a change', async () => {
    const { pool } = await testDb();
    const customer = await makeCustomer(t, {
      name: 'Racing Email',
      email: 'racing@example.com',
      emailVerifiedAt: new Date('2026-10-01T00:00:00.000Z'),
    });
    const staff = await staffWith('customers:update');

    // Another edit holds the row and moves the address; it commits only after the PATCH is waiting for the row.
    const other = await pool.connect();
    try {
      await other.query('begin');
      await other.query('select id from customers where id = $1 for update', [customer.id]);
      await other.query(`update customers set email = 'moved@example.com' where id = $1`, [customer.id]);
      // The PATCH reads racing@example.com (the committed row) and finds nothing new; under the lock the stored address is another one,
      // so sending racing@example.com is a change: the address is set, the verification is cleared and a verification link is sent.
      const patch = send(staff, 'PATCH', `/admin/customers/${customer.id}`, { email: 'racing@example.com' });
      await eventually(async () => {
        const { rows } = await pool.query(
          `select 1 from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock' and query ilike '%from "customers"%for update%'`,
        );
        return rows.length > 0 ? true : undefined;
      });
      await other.query('commit');
      const res = await patch;
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ email: 'racing@example.com', emailVerifiedAt: null });
    } finally {
      await rollbackAndRelease(other);
    }
    expect(await customerRow(customer.id)).toMatchObject({ email: 'racing@example.com', emailVerifiedAt: null });
    expect(customerLinks()).toMatchObject([{ kind: 'email_verification', customerId: customer.id }]);
  });

  it('clears the verification on a new email, sends a verification link to an account and none to a guest', async () => {
    const { db } = await testDb();
    const account = await makeCustomer(t, {
      email: 'old@example.com',
      emailVerifiedAt: new Date('2026-10-01T00:00:00.000Z'),
    });
    const guest = await makeCustomer(t, {
      email: 'guest@example.com',
      guest: true,
      emailVerifiedAt: new Date('2026-10-01T00:00:00.000Z'),
    });
    const staff = await staffWith('customers:update');

    const changed = await send(staff, 'PATCH', `/admin/customers/${account.id}`, { email: ' New@Example.com ' });
    expect(changed.statusCode).toBe(200);
    expect(changed.json()).toMatchObject({ email: 'new@example.com', emailVerifiedAt: null });
    expect(customerLinks()).toMatchObject([{ kind: 'email_verification', customerId: account.id }]);
    const [event] = await db.select().from(s.outboxEvents);
    expect(event).toMatchObject({ type: 'customer.email_verification', aggregateId: account.id });
    const [audit] = await auditOfCustomer(db, account.id);
    expect(audit).toMatchObject({
      before: { email: 'old@example.com', email_verified: true },
      after: { email: 'new@example.com', email_verified: false },
    });

    // The verification link signs the account in and verifies the new address.
    const link = customerLinks()[0]!;
    expect((await new StoreClient(t).verify(link.token)).statusCode).toBe(200);
    expect((await customerRow(account.id)).emailVerifiedAt).not.toBeNull();

    const guestChanged = await send(staff, 'PATCH', `/admin/customers/${guest.id}`, { email: 'guest2@example.com' });
    expect(guestChanged.json()).toMatchObject({ emailVerifiedAt: null });
    expect(customerLinks()).toHaveLength(1);
  });

  it('voids every link sent to the old address (sign-in, reset, invitation), so none can verify the new one (b2c-16)', async () => {
    const staff = await staffWith('customers:update', 'customers:create');
    const store = () => new StoreClient(t);
    const verifiedAt = new Date('2026-10-01T00:00:00.000Z');
    const account = await makeCustomer(t, { email: 'old@example.com', emailVerifiedAt: verifiedAt });
    const guest = await makeCustomer(t, { email: 'guest-old@example.com', guest: true, emailVerifiedAt: verifiedAt });
    const invited = await send(staff, 'POST', '/admin/customers', {
      name: 'Invited Person',
      email: 'invited-old@example.com',
      country: 'gb',
      locale: 'en',
      password: { mode: 'reset_link' },
    });
    const invitedId = invited.json<{ id: number }>().id;
    await store().magicLink(account.email);
    await store().forgot(account.email);
    await store().magicLink(guest.email);
    const links = customerLinks();
    const tokenOf = (kind: string, customerId: number) =>
      links.find((link) => link.kind === kind && link.customerId === customerId)!.token;
    const signInLink = tokenOf('magic_link', account.id);
    const resetLink = tokenOf('password_reset', account.id);
    const guestLink = tokenOf('magic_link', guest.id);
    const inviteLink = tokenOf('invited', invitedId);

    for (const [id, email] of [
      [account.id, 'new@example.com'],
      [guest.id, 'guest-new@example.com'],
      [invitedId, 'invited-new@example.com'],
    ] as const) {
      expect((await send(staff, 'PATCH', `/admin/customers/${id}`, { email })).statusCode).toBe(200);
    }

    // Every old link answers 410, and nothing marks the new addresses as proven.
    expect((await store().verify(signInLink)).statusCode).toBe(410);
    expect((await store().verify(guestLink)).statusCode).toBe(410);
    expect((await store().setPassword(resetLink, 'a-much-longer-passphrase')).statusCode).toBe(410);
    expect((await store().setPassword(inviteLink, 'a-much-longer-passphrase')).statusCode).toBe(410);
    for (const id of [account.id, guest.id, invitedId]) expect((await customerRow(id)).emailVerifiedAt).toBeNull();
    expect((await customerRow(guest.id)).hasAccount).toBe(false);

    // The verification link sent to the new address of the account still works.
    const verification = customerLinks().find((link) => link.kind === 'email_verification')!;
    expect((await store().verify(verification.token)).statusCode).toBe(200);
    expect((await customerRow(account.id)).emailVerifiedAt).not.toBeNull();
  });

  it('keeps the verification when the email only changes case, and refuses a taken or blocklisted new email', async () => {
    const { db } = await testDb();
    const customer = await makeCustomer(t, {
      email: 'same@example.com',
      emailVerifiedAt: new Date('2026-10-01T00:00:00.000Z'),
    });
    await makeCustomer(t, { name: 'Taken Name', email: 'taken@example.com' });
    await db.insert(s.blocklistEntries).values({
      kind: 'email',
      valueHash: t.app.get(TokenService).hash('blocked@example.com'),
      display: 'b***@example.com',
    });
    const staff = await staffWith('customers:update');
    const sameCase = await send(staff, 'PATCH', `/admin/customers/${customer.id}`, { email: 'SAME@example.com' });
    expect(sameCase.statusCode).toBe(200);
    expect((await customerRow(customer.id)).emailVerifiedAt).not.toBeNull();
    expect(customerLinks()).toEqual([]);

    const taken = await send(staff, 'PATCH', `/admin/customers/${customer.id}`, { email: 'Taken@example.com' });
    expect(taken.statusCode).toBe(409);
    expect(problem(taken).code).toBe('EMAIL_TAKEN');
    const blocked = await send(staff, 'PATCH', `/admin/customers/${customer.id}`, { email: 'blocked@example.com' });
    expect(blocked.statusCode).toBe(422);
    expect(problem(blocked).errors).toMatchObject([{ field: 'email', message: 'This email is blocked.' }]);
  });

  it('answers 404 for an unknown customer, 409 ANONYMIZED for an anonymized one, 422 on a bad field, and audits an empty edit', async () => {
    const { db } = await testDb();
    const staff = await staffWith('customers:update');
    expect((await send(staff, 'PATCH', '/admin/customers/999999', { name: 'Someone' })).statusCode).toBe(404);
    const gone = await makeCustomer(t, { status: 'anonymized', hasAccount: false, name: 'Deleted customer' });
    const anonymized = await send(staff, 'PATCH', `/admin/customers/${gone.id}`, { name: 'Someone Else' });
    expect(anonymized.statusCode).toBe(409);
    expect(problem(anonymized).code).toBe('ANONYMIZED');

    const customer = await makeCustomer(t);
    const bad = await send(staff, 'PATCH', `/admin/customers/${customer.id}`, {
      name: 'x',
      email: 'nope',
      country: 'GBR',
      locale: 'de',
      internalNotes: 'n'.repeat(301),
    });
    expect(bad.statusCode).toBe(422);
    expect(
      problem(bad)
        .errors?.map((e) => e.field)
        .sort(),
    ).toEqual(['country', 'email', 'internalNotes', 'locale', 'name']);

    // Nothing changes, but a staff write is still audited.
    const empty = await send(staff, 'PATCH', `/admin/customers/${customer.id}`, {});
    expect(empty.statusCode).toBe(200);
    expect(await auditOfCustomer(db, customer.id)).toHaveLength(1);
  });

  it('needs customers:update', async () => {
    const customer = await makeCustomer(t);
    const reader = await staffWith('customers:read');
    expect((await send(reader, 'PATCH', `/admin/customers/${customer.id}`, { name: 'Another Name' })).statusCode).toBe(
      403,
    );
  });
});

describe('the customer a staff member created', () => {
  it('shows in the list with the staff id, and an order of the customer counts in its figures', async () => {
    const { db } = await testDb();
    await insertStoreCurrencies(db);
    const staff = await staffWith('customers:create', 'customers:read');
    const created = await send(staff, 'POST', '/admin/customers', {
      name: 'Lukas Brandt',
      email: 'lukas@example.com',
      country: 'DE',
      locale: 'en',
      password: { mode: 'reset_link' },
    });
    const id = created.json<{ id: number }>().id;
    const serviceId = await insertAnyService(db);
    await insertOrderRow(db, { serviceId, customerId: id, source: 'store', currency: 'EUR' });
    const row = (await get(staff, `/admin/customers?q=lukas`)).json<
      Array<{ createdBy: number; ordersCount: number }>
    >()[0]!;
    expect(row).toMatchObject({ createdBy: staff.staffId, ordersCount: 1 });
    expect(await db.select().from(s.customers).where(eq(s.customers.id, id))).toHaveLength(1);
  });
});

// Integration tests of the storefront customer's account (feature 14b, routes GET and PATCH /store/v1/me and GET
// /store/v1/me/orders): the details, the language, currency and marketing consent (with its proof), and the customer's own
// orders and no one else's.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, mock } from 'bun:test';
import { asc, eq } from 'drizzle-orm';
import { schema as s } from '../../src/infra/db';
import { type TestApp, createTestApp } from '../support/app';
import { clearIdentityCaches } from '../support/auth';
import { TestClock } from '../support/clock';
import { insertCategory, insertService } from '../support/catalog';
import { closeTestDb, resetDb, testDb } from '../support/db';
import { insertOrderRow } from '../support/orders';
import { freshClientIp } from '../support/pipeline-routes';
import { STORE_ORIGIN, StoreClient, clearStoreRateLimits, customerRow, makeCustomer } from '../support/store';

const clock = new TestClock('2026-11-07T10:00:00.000Z');
let t: TestApp;

beforeAll(async () => {
  t = await createTestApp({ env: { CORS_ORIGINS: STORE_ORIGIN }, clock });
});
afterAll(async () => {
  await resetDb();
  await t.close();
  await closeTestDb();
});
beforeEach(async () => {
  clock.set('2026-11-07T10:00:00.000Z');
  await resetDb();
  await clearIdentityCaches(t);
  await clearStoreRateLimits(t);
});
afterEach(() => mock.restore());

/** Currencies the store shows (GBP, USD) and one it does not (SEK). */
async function insertCurrencies(): Promise<void> {
  const { db } = await testDb();
  await db.insert(s.currencies).values([
    { code: 'USD', name: 'US dollar', rateToBase: '1', isStorefront: true },
    { code: 'GBP', name: 'Pound sterling', rateToBase: '0.79', isStorefront: true },
    { code: 'SEK', name: 'Swedish krona', rateToBase: '10.6', isStorefront: false },
  ]);
}

async function signedIn(overrides: Parameters<typeof makeCustomer>[1] = {}) {
  const customer = await makeCustomer(t, overrides);
  const ip = freshClientIp();
  const client = new StoreClient(t, ip);
  expect((await client.login(customer.email)).statusCode).toBe(200);
  return { customer, client, ip };
}

describe('GET /store/v1/me', () => {
  it('describes the signed-in customer, never cached, and repeats the CSRF token', async () => {
    await insertCurrencies();
    const { customer, client } = await signedIn({
      name: 'Daniel Whitmore',
      phone: '+447700900123',
      currency: 'GBP',
      marketingOptIn: true,
      emailVerifiedAt: new Date('2026-10-12T09:30:00.000Z'),
    });
    const res = await client.me();
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['x-csrf-token']).toBe(client.csrf);
    expect(res.json()).toEqual({
      id: customer.id,
      email: customer.email,
      emailVerifiedAt: '2026-10-12T09:30:00.000Z',
      name: 'Daniel Whitmore',
      phone: '+447700900123',
      country: 'GB',
      locale: 'en',
      currency: 'GBP',
      marketingOptIn: true,
      hasPassword: true,
      createdAt: expect.any(String),
    });
  });

  it('says hasPassword false for an account that signs in by link, and answers 401 without a session', async () => {
    const customer = await makeCustomer(t, { noPassword: true });
    const anonymous = new StoreClient(t, freshClientIp());
    expect((await anonymous.me()).statusCode).toBe(401);
    // A session opened some other way (the link) sees the account.
    const { openSession } = await import('../support/auth');
    const session = await openSession(t, { type: 'customer', id: customer.id });
    const res = await t.app.inject({ method: 'GET', url: '/store/v1/me', headers: session.headers });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ id: customer.id, hasPassword: false });
  });
});

describe('PATCH /store/v1/me', () => {
  it('changes language and currency, and writes a consent record for each change of the marketing choice', async () => {
    await insertCurrencies();
    const { customer, client, ip } = await signedIn();
    const res = await client.updateMe({ locale: 'ar', currency: 'gbp', marketingOptIn: true });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ locale: 'ar', currency: 'GBP', marketingOptIn: true });
    expect(await customerRow(customer.id)).toMatchObject({ locale: 'ar', currency: 'GBP', marketingOptIn: true });

    // The same choice again writes nothing; withdrawing writes a new record.
    await client.updateMe({ marketingOptIn: true });
    await client.updateMe({ marketingOptIn: false });
    const { db } = await testDb();
    const records = await db.select().from(s.consentRecords).orderBy(asc(s.consentRecords.id));
    expect(records).toMatchObject([
      { subjectType: 'customer', subjectId: customer.id, purpose: 'marketing', granted: true },
      { subjectType: 'customer', subjectId: customer.id, purpose: 'marketing', granted: false },
    ]);
    expect(records[0]).toMatchObject({ createdAt: new Date('2026-11-07T10:00:00.000Z') });
    // The proof keeps the address the request came from, which is the address of this storefront client.
    expect(records.map((record) => record.ip)).toEqual([ip, ip]);
  });

  it('refuses a currency the store does not show, and a language it does not speak, with 422 on the field', async () => {
    await insertCurrencies();
    const { client } = await signedIn();
    const sek = await client.updateMe({ currency: 'SEK' });
    expect(sek.statusCode).toBe(422);
    expect(sek.json<{ errors: Array<{ field: string }> }>().errors.map((e) => e.field)).toEqual(['currency']);
    const nowhere = await client.updateMe({ currency: 'XXX' });
    expect(nowhere.statusCode).toBe(422);
    const klingon = await client.updateMe({ locale: 'tlh' });
    expect(klingon.statusCode).toBe(422);
    expect(klingon.json<{ errors: Array<{ field: string }> }>().errors.map((e) => e.field)).toEqual(['locale']);
  });

  it('changes nothing for an empty body, never lets the customer change the name or email, and needs the CSRF token', async () => {
    const { customer, client } = await signedIn({ name: 'Original Name' });
    expect((await client.updateMe({})).statusCode).toBe(200);
    const sneaky = await client.updateMe({ name: 'Hacker', email: 'hacker@example.com' });
    expect(sneaky.statusCode).toBe(200);
    expect(await customerRow(customer.id)).toMatchObject({ name: 'Original Name', email: customer.email });
    const noToken = await client.updateMe({ locale: 'ar' }, { csrf: false });
    expect(noToken.statusCode).toBe(403);
  });
});

describe('GET /store/v1/me/orders', () => {
  /** Two customers, a service and four orders: three for the first (one of them rejected), one for the second. */
  async function world() {
    const { db } = await testDb();
    await insertCurrencies();
    const category = await insertCategory(db);
    const serviceId = await insertService(db, category, { name: 'Vodafone UK iPhone Unlock' });
    const { customer, client } = await signedIn();
    const other = await makeCustomer(t);
    const make = (customerId: number, values: Partial<typeof s.orders.$inferInsert>) =>
      insertOrderRow(db, {
        serviceId,
        customerId,
        source: 'store',
        currency: 'GBP',
        publicToken: `token-${crypto.randomUUID()}`,
        ...values,
      });
    const first = await make(customer.id, {
      status: 'completed',
      totalPrice: '13.7500',
      taxAmount: '2.7500',
      createdAt: new Date('2026-11-01T10:00:00.000Z'),
      completedAt: new Date('2026-11-01T10:09:00.000Z'),
    });
    const second = await make(customer.id, {
      status: 'rejected',
      totalPrice: '20.0000',
      createdAt: new Date('2026-11-03T10:00:00.000Z'),
    });
    const third = await make(customer.id, {
      status: 'processing',
      totalPrice: '5.0000',
      publicToken: null,
      imei: null,
      createdAt: new Date('2026-11-05T10:00:00.000Z'),
    });
    const foreign = await make(other.id, { createdAt: new Date('2026-11-06T10:00:00.000Z') });
    return { client, first, second, third, foreign };
  }

  it('lists only the signed-in customer’s own orders, newest first, with the total in x-total-count', async () => {
    const { client, first, second, third, foreign } = await world();
    const res = await client.orders();
    expect(res.statusCode).toBe(200);
    expect(res.headers['x-total-count']).toBe('3');
    const rows = res.json<Array<Record<string, unknown>>>();
    expect(rows.map((row) => row.id)).toEqual([third.id, second.id, first.id]);
    expect(rows.map((row) => row.id)).not.toContain(foreign.id);
    expect(rows[2]).toEqual({
      id: first.id,
      status: 'completed',
      service: { id: first.serviceId, name: 'Vodafone UK iPhone Unlock' },
      imei: first.imei,
      quantity: 1,
      totalPrice: '13.7500',
      taxAmount: '2.7500',
      currency: 'GBP',
      trackingToken: first.publicToken,
      createdAt: '2026-11-01T10:00:00.000Z',
      completedAt: '2026-11-01T10:09:00.000Z',
    });
    // An order without a tracking page and with an erased IMEI.
    expect(rows[0]).toMatchObject({ trackingToken: null, imei: '', completedAt: null });
  });

  it('filters by status (repeat the key for IN), sorts, and pages', async () => {
    const { client, first, second, third } = await world();
    const open = await client.orders('?status=processing&status=rejected');
    expect(open.headers['x-total-count']).toBe('2');
    expect(open.json<Array<{ id: number }>>().map((row) => row.id)).toEqual([third.id, second.id]);

    const byPrice = await client.orders('?_sort=totalPrice&_order=desc');
    expect(byPrice.json<Array<{ id: number }>>().map((row) => row.id)).toEqual([second.id, first.id, third.id]);

    const page = await client.orders('?_start=1&_end=2');
    expect(page.headers['x-total-count']).toBe('3');
    expect(page.json<Array<{ id: number }>>().map((row) => row.id)).toEqual([second.id]);

    const bad = await client.orders('?status=shipped');
    expect(bad.statusCode).toBe(422);
  });

  it('answers 401 without a session', async () => {
    const res = await new StoreClient(t, freshClientIp()).orders();
    expect(res.statusCode).toBe(401);
  });
});

describe('the customer session', () => {
  it('reads the account from the database on every request: a customer anonymized meanwhile is signed out', async () => {
    const { customer, client } = await signedIn();
    const { db } = await testDb();
    await db.update(s.customers).set({ status: 'anonymized' }).where(eq(s.customers.id, customer.id));
    await clearIdentityCaches(t);
    expect((await client.me()).statusCode).toBe(401);
  });
});

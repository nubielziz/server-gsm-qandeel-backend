// Integration tests of the storefront customer's account (feature 14b, routes GET and PATCH /store/v1/me and GET
// /store/v1/me/orders): the details, currency and marketing consent (with its proof), and the customer's own
// orders and no one else's.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, mock } from 'bun:test';
import { asc, eq } from 'drizzle-orm';
import { schema as s } from '../../src/infra/db';
import { type TestApp, createTestApp } from '../support/app';
import { clearIdentityCaches } from '../support/auth';
import { TestClock } from '../support/clock';
import { insertCategory, insertService } from '../support/catalog';
import { closeTestDb, resetDb, testDb } from '../support/db';
import { insertStoreCurrencies, insertTaxRates } from '../support/customers';
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
  it('changes the currency, and writes a consent record for each change of the marketing choice', async () => {
    await insertCurrencies();
    const { customer, client, ip } = await signedIn();
    const res = await client.updateMe({ currency: 'gbp', marketingOptIn: true });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ currency: 'GBP', marketingOptIn: true });
    expect(await customerRow(customer.id)).toMatchObject({ currency: 'GBP', marketingOptIn: true });

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

  it('refuses a currency the store does not show with 422 on the field', async () => {
    await insertCurrencies();
    const { client } = await signedIn();
    const sek = await client.updateMe({ currency: 'SEK' });
    expect(sek.statusCode).toBe(422);
    expect(sek.json<{ errors: Array<{ field: string }> }>().errors.map((e) => e.field)).toEqual(['currency']);
    const nowhere = await client.updateMe({ currency: 'XXX' });
    expect(nowhere.statusCode).toBe(422);
  });

  it('has no language (decision 039): the account never shows one, and a language key an old client sends is ignored', async () => {
    await insertCurrencies();
    const { customer, client } = await signedIn();
    expect(Object.keys((await client.me()).json())).not.toContain('locale');
    const res = await client.updateMe({ locale: 'tr', currency: 'gbp' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).not.toHaveProperty('locale');
    expect(res.json()).toMatchObject({ currency: 'GBP' });
    expect(await customerRow(customer.id)).not.toHaveProperty('locale');
  });

  it('changes nothing for an empty body, never lets the customer change the email, and needs the CSRF token', async () => {
    const { customer, client } = await signedIn({ name: 'Original Name' });
    expect((await client.updateMe({})).statusCode).toBe(200);
    const sneaky = await client.updateMe({ email: 'hacker@example.com' });
    expect(sneaky.statusCode).toBe(200);
    expect(await customerRow(customer.id)).toMatchObject({ name: 'Original Name', email: customer.email });
    const noToken = await client.updateMe({ marketingOptIn: true }, { csrf: false });
    expect(noToken.statusCode).toBe(403);
  });
});

describe('PATCH /store/v1/me: name, phone and country (feature 24B)', () => {
  /** Currencies USD, GBP, EUR (shown) and SEK (not shown), and tax rates for GB, DE, SE and US. */
  async function world() {
    const { db } = await testDb();
    await insertStoreCurrencies(db);
    await insertTaxRates(db, ['GB', 'DE', 'SE', 'US']);
    return db;
  }

  it('sets the name, the phone and the country, tidies the name, and answers the account', async () => {
    await world();
    const { customer, client } = await signedIn({ name: 'Original Name', phone: '', country: 'GB', currency: 'GBP' });
    const res = await client.updateMe({ name: '  Daniel   Whitmore ', phone: ' +44 7700 900123 ', country: 'de' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      id: customer.id,
      name: 'Daniel Whitmore',
      phone: '+44 7700 900123',
      country: 'DE',
      currency: 'EUR',
    });
    expect(await customerRow(customer.id)).toMatchObject({
      name: 'Daniel Whitmore',
      phone: '+44 7700 900123',
      country: 'DE',
    });
  });

  it("clears the phone with '' and leaves the other fields alone", async () => {
    await world();
    const { customer, client } = await signedIn({ name: 'Keep Me', phone: '+447700900123' });
    const res = await client.updateMe({ phone: '' });
    expect(res.statusCode).toBe(200);
    expect(await customerRow(customer.id)).toMatchObject({ name: 'Keep Me', phone: '', country: 'GB' });
  });

  it('refuses a name of 1 character, a 3-letter country and a phone over 40 characters with 422 on the field', async () => {
    await world();
    const { customer, client } = await signedIn({ name: 'Original Name' });
    const fieldsOf = (res: { json: <T>() => T }) =>
      res.json<{ errors: Array<{ field: string }> }>().errors.map((e) => e.field);
    const name = await client.updateMe({ name: 'A' });
    expect(name.statusCode).toBe(422);
    expect(fieldsOf(name)).toEqual(['name']);
    const country = await client.updateMe({ country: 'GBR' });
    expect(country.statusCode).toBe(422);
    expect(fieldsOf(country)).toEqual(['country']);
    const phone = await client.updateMe({ phone: '1'.repeat(41) });
    expect(phone.statusCode).toBe(422);
    expect(fieldsOf(phone)).toEqual(['phone']);
    expect(await customerRow(customer.id)).toMatchObject({ name: 'Original Name', country: 'GB' });
  });

  it('refuses a new country with no current tax rate (422 on country, nothing written), including an ended or future window', async () => {
    const db = await world();
    const { customer, client } = await signedIn({ name: 'Original Name', currency: 'GBP' });
    const refused = async () => {
      const res = await client.updateMe({ name: 'Changed Name', country: 'JO' });
      expect(res.statusCode).toBe(422);
      expect(res.json()).toMatchObject({
        code: 'VALIDATION_FAILED',
        errors: [{ field: 'country', message: 'Choose a country.' }],
      });
    };
    await refused();
    await insertTaxRates(db, ['JO'], { validTo: new Date(clock.nowMs() - 86_400_000) });
    await refused();
    await db.delete(s.taxRates).where(eq(s.taxRates.country, 'JO'));
    await insertTaxRates(db, ['JO'], { validFrom: new Date(clock.nowMs() + 86_400_000) });
    await refused();
    // The whole request is refused: the name did not change either.
    expect(await customerRow(customer.id)).toMatchObject({ name: 'Original Name', country: 'GB', currency: 'GBP' });
  });

  it('never checks the stored country again: it is accepted after its tax rate ended, and the currency stays', async () => {
    const db = await world();
    const { customer, client } = await signedIn({ country: 'GB', currency: 'USD' });
    await db.delete(s.taxRates).where(eq(s.taxRates.country, 'GB'));
    const res = await client.updateMe({ country: 'gb', name: 'Still Here' });
    expect(res.statusCode).toBe(200);
    expect(await customerRow(customer.id)).toMatchObject({ name: 'Still Here', country: 'GB', currency: 'USD' });
  });

  it('re-derives the currency from a changed country (its shown currency, else USD), and keeps an explicit one', async () => {
    await world();
    const { customer, client } = await signedIn({ country: 'GB', currency: 'GBP' });
    // Germany pays in EUR; Sweden's krona is not shown by the store: USD.
    expect((await client.updateMe({ country: 'DE' })).json()).toMatchObject({ country: 'DE', currency: 'EUR' });
    expect((await client.updateMe({ country: 'SE' })).json()).toMatchObject({ country: 'SE', currency: 'USD' });
    // Together with a currency the customer chose, the choice wins.
    const both = await client.updateMe({ country: 'GB', currency: 'EUR' });
    expect(both.json()).toMatchObject({ country: 'GB', currency: 'EUR' });
    expect(await customerRow(customer.id)).toMatchObject({ country: 'GB', currency: 'EUR' });
    // A currency alone does not touch the country.
    expect((await client.updateMe({ currency: 'USD' })).json()).toMatchObject({ country: 'GB', currency: 'USD' });
  });

  it('does not change another customer, writes no audit row, and an empty body or the same values change nothing', async () => {
    const db = await world();
    const { customer, client } = await signedIn({ name: 'Original Name', phone: '+1', country: 'GB' });
    const other = await makeCustomer(t, { name: 'Other Person', phone: '+2', country: 'GB' });
    const before = await customerRow(customer.id);
    expect((await client.updateMe({})).statusCode).toBe(200);
    expect((await client.updateMe({ name: 'Original Name', phone: '+1', country: 'GB' })).statusCode).toBe(200);
    expect(await customerRow(customer.id)).toEqual(before);
    expect((await client.updateMe({ name: 'New Name', country: 'DE' })).statusCode).toBe(200);
    expect(await customerRow(other.id)).toEqual(other.row);
    expect(await db.select().from(s.auditLogs)).toHaveLength(0);
  });

  it('needs the CSRF token for the new fields too', async () => {
    await world();
    const { customer, client } = await signedIn({ name: 'Original Name' });
    const res = await client.updateMe({ name: 'Hacker Name' }, { csrf: false });
    expect(res.statusCode).toBe(403);
    expect(await customerRow(customer.id)).toMatchObject({ name: 'Original Name' });
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

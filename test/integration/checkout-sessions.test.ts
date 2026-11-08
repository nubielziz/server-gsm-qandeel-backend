// Integration tests of the storefront checkout (feature 14a): POST /store/v1/checkout-sessions, GET /store/v1/checkout-sessions/:token
// and POST /store/v1/checkout-sessions/:token/consents against the real API: the locked price, tax and exchange rate, the guest
// customer, the encrypted IMEI, expiry on the injected clock, the capability token, and the consent proof.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { eq } from 'drizzle-orm';
import { schema as s } from '../../src/infra/db';
import { EncryptionService } from '../../src/infra/crypto';
import { CHECKOUT_IMEI_AAD } from '../../src/modules/customers';
import { type TestApp, createTestApp } from '../support/app';
import { clearIdentityCaches } from '../support/auth';
import { MINUTE, TestClock } from '../support/clock';
import { closeTestDb, resetDb, testDb } from '../support/db';
import { insertCategory, insertService } from '../support/catalog';
import { freshClientIp } from '../support/pipeline-routes';
import {
  APPLE_IMEI,
  TURNSTILE_HEADERS,
  insertLegal,
  insertListing,
  storefrontWorld,
  type StorefrontWorld,
} from '../support/storefront';
import { StoreClient, customerRow, makeCustomer } from '../support/store';

const clock = new TestClock('2026-11-07T12:00:00.000Z');
let t: TestApp;

beforeAll(async () => {
  t = await createTestApp({ clock });
});
beforeEach(async () => {
  clock.set('2026-11-07T12:00:00.000Z');
  await resetDb();
});
afterAll(async () => {
  await resetDb();
  await t.close();
  await closeTestDb();
});

// Every call comes from its own address: the per-IP limits (300 a minute, 30 for token lookups) must not decide these tests.
const open = (payload: unknown, headers: Record<string, string> = TURNSTILE_HEADERS) =>
  t.app.inject({
    method: 'POST',
    url: '/store/v1/checkout-sessions',
    headers: { 'user-agent': 'Mozilla/5.0 (test)', ...headers },
    remoteAddress: freshClientIp(),
    payload: payload as never,
  });
const show = (token: string) =>
  t.app.inject({ method: 'GET', url: `/store/v1/checkout-sessions/${token}`, remoteAddress: freshClientIp() });
const consent = (token: string, payload: unknown, headers: Record<string, string> = {}) =>
  t.app.inject({
    method: 'POST',
    url: `/store/v1/checkout-sessions/${token}/consents`,
    headers: { 'user-agent': 'Mozilla/5.0 (test)', ...headers },
    remoteAddress: freshClientIp(),
    payload: payload as never,
  });
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- test bodies are untyped JSON
const body = (res: { json: () => any }): any => res.json();

const valid = (world: StorefrontWorld, extra: Record<string, unknown> = {}) => ({
  serviceId: world.icloud.serviceId,
  email: 'sam@mail.example',
  country: 'GB',
  currency: 'GBP',
  imei: APPLE_IMEI,
  ...extra,
});
const counts = async () => {
  const { db } = await testDb();
  return {
    customers: (await db.select().from(s.customers)).length,
    sessions: (await db.select().from(s.checkoutSessions)).length,
    consents: (await db.select().from(s.consentRecords)).length,
  };
};

describe('POST /store/v1/checkout-sessions', () => {
  it('opens a session that locks the retail price, the tax of the buyer country and the exchange rate', async () => {
    const { db } = await testDb();
    const world = await storefrontWorld(db);
    const res = await open(valid(world, { utm: { source: 'Google', medium: '' } }));
    expect(res.statusCode).toBe(201);
    // The answer holds the checkout token: nothing may keep a copy.
    expect(res.headers['cache-control']).toBe('no-store');
    const session = body(res);
    expect(session.token).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(session).toMatchObject({
      status: 'open',
      expiresAt: '2026-11-07T12:30:00.000Z',
      createdAt: '2026-11-07T12:00:00.000Z',
      service: {
        id: world.icloud.serviceId,
        name: 'iCloud Clean / Lost Check',
        type: 'imei',
        deliveryTime: '2 minutes',
      },
      quantity: 1,
      imei: '•••••••••••0004',
      email: 'sa•••@mail.example',
      country: 'GB',
      currency: 'GBP',
      fxRate: '0.80185000',
      taxRate: '20.0000',
      amounts: {
        usd: { net: '3.9900', tax: '0.8000', gross: '4.7900' },
        display: { net: '3.2000', tax: '0.6400', gross: '3.8400' },
      },
      consent: { required: ['terms', 'privacy', 'withdrawal_waiver'], granted: [], complete: false },
      paymentMethods: [],
    });
    expect(JSON.stringify(session)).not.toContain(APPLE_IMEI);

    const [row] = await db.select().from(s.checkoutSessions);
    expect(row).toMatchObject({
      token: session.token,
      email: 'sam@mail.example',
      serviceId: world.icloud.serviceId,
      quantity: 1,
      currency: 'GBP',
      fxRate: '0.80185000',
      netAmount: '3.9900',
      taxRate: '20.0000',
      taxAmount: '0.8000',
      grossAmount: '4.7900',
      taxCountry: 'GB',
      status: 'open',
      userAgent: 'Mozilla/5.0 (test)',
      utm: { source: 'Google' },
      orderId: null,
    });
    expect(row?.ip).toBeTruthy();
    expect(row?.expiresAt.toISOString()).toBe('2026-11-07T12:30:00.000Z');
    expect(row?.imeiEnc).not.toContain(APPLE_IMEI);
    expect(t.app.get(EncryptionService).decrypt(row!.imeiEnc!, CHECKOUT_IMEI_AAD)).toBe(APPLE_IMEI);
    const [customer] = await db.select().from(s.customers);
    expect(customer).toMatchObject({ email: 'sam@mail.example', hasAccount: false, status: 'active', country: 'GB' });
    expect(row?.customerId).toBe(customer?.id ?? -1);
  });

  it('makes one guest customer per email, whatever the case, and reuses it for the next checkout', async () => {
    const { db } = await testDb();
    const world = await storefrontWorld(db);
    expect((await open(valid(world))).statusCode).toBe(201);
    expect((await open(valid(world, { email: 'Sam@Mail.Example' }))).statusCode).toBe(201);
    expect((await open(valid(world, { email: '  sam@mail.example ' }))).statusCode).toBe(201);
    const sessions = await db.select().from(s.checkoutSessions);
    expect(sessions).toHaveLength(3);
    expect(new Set(sessions.map((row) => row.customerId)).size).toBe(1);
    expect(await db.select().from(s.customers)).toHaveLength(1);
  });

  it('survives two checkouts of the same new email at once with one customer', async () => {
    const { db } = await testDb();
    const world = await storefrontWorld(db);
    const results = await Promise.all(Array.from({ length: 6 }, () => open(valid(world))));
    expect(results.map((res) => res.statusCode)).toEqual([201, 201, 201, 201, 201, 201]);
    expect(await db.select().from(s.customers)).toHaveLength(1);
    expect(await db.select().from(s.checkoutSessions)).toHaveLength(6);
  });

  it('keeps the locked amounts when the price, the tax or the rate change afterwards', async () => {
    const { db } = await testDb();
    const world = await storefrontWorld(db);
    const { token } = body(await open(valid(world)));
    await db
      .update(s.serviceGroupPrices)
      .set({ price: '9.9900' })
      .where(eq(s.serviceGroupPrices.serviceId, world.icloud.serviceId));
    await db.update(s.taxRates).set({ ratePercent: '5' });
    await db.update(s.currencies).set({ rateToBase: '0.5' }).where(eq(s.currencies.code, 'GBP'));
    const again = body(await show(token));
    expect(again.amounts).toEqual({
      usd: { net: '3.9900', tax: '0.8000', gross: '4.7900' },
      display: { net: '3.2000', tax: '0.6400', gross: '3.8400' },
    });
    expect(again.fxRate).toBe('0.80185000');
    // A new session sees the new numbers.
    const fresh = body(await open(valid(world)));
    expect(fresh.amounts.usd.net).toBe('9.9900');
    expect(fresh.taxRate).toBe('5.0000');
  });

  it('prices in USD without tax for a country that has no tax window, and defaults the currency', async () => {
    const { db } = await testDb();
    const world = await storefrontWorld(db);
    const res = await open({
      serviceId: world.icloud.serviceId,
      email: 'sam@mail.example',
      country: 'us',
      imei: APPLE_IMEI,
    });
    expect(res.statusCode).toBe(201);
    expect(body(res)).toMatchObject({
      currency: 'USD',
      fxRate: '1.00000000',
      taxRate: '0.0000',
      country: 'US',
      amounts: {
        usd: { net: '3.9900', tax: '0.0000', gross: '3.9900' },
        display: { net: '3.9900', tax: '0.0000', gross: '3.9900' },
      },
    });
  });

  it('multiplies the price by the quantity before the tax and checks it against the service', async () => {
    const { db } = await testDb();
    const world = await storefrontWorld(db);
    await db.update(s.services).set({ minQty: 1, maxQty: 5 }).where(eq(s.services.id, world.icloud.serviceId));
    const ok = await open(valid(world, { quantity: 3 }));
    expect(ok.statusCode).toBe(201);
    expect(body(ok)).toMatchObject({
      quantity: 3,
      amounts: { usd: { net: '11.9700', tax: '2.3900', gross: '14.3600' } },
    });
    for (const quantity of [0, 6]) {
      const res = await open(valid(world, { quantity }));
      expect(res.statusCode, String(quantity)).toBe(422);
      if (quantity === 6) expect(body(res).errors[0].field).toBe('quantity');
    }
  });

  it('refuses a bad IMEI with INVALID_IMEI and leaves no customer and no session behind', async () => {
    const { db } = await testDb();
    const world = await storefrontWorld(db);
    for (const imei of [undefined, '353890110000005', 'abc', '35389011000000']) {
      const res = await open(valid(world, { imei }));
      expect(res.statusCode, String(imei)).toBe(422);
      expect(body(res).code).toBe('INVALID_IMEI');
      expect(body(res).errors[0].field).toBe('imei');
    }
    // An empty string never reaches the IMEI rule: the body schema refuses it.
    expect(body(await open(valid(world, { imei: '' }))).code).toBe('VALIDATION_FAILED');
    expect(await counts()).toEqual({ customers: 0, sessions: 0, consents: 0 });
  });

  it('refuses an invalid email, a missing or malformed country and an unknown currency, creating nothing', async () => {
    const { db } = await testDb();
    const world = await storefrontWorld(db);
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ email: 'not-an-email' }, 'email'],
      [{ email: '' }, 'email'],
      [{ email: `${'a'.repeat(250)}@mail.example` }, 'email'],
      [{ country: undefined }, 'country'],
      [{ country: 'GBR' }, 'country'],
      [{ currency: 'JPY' }, 'currency'],
      [{ serviceId: 'x' }, 'serviceId'],
    ];
    for (const [extra, field] of cases) {
      const res = await open(valid(world, extra));
      expect(res.statusCode, field).toBe(422);
      expect(body(res).errors.map((error: { field: string }) => error.field)).toContain(field);
    }
    expect(await counts()).toEqual({ customers: 0, sessions: 0, consents: 0 });
  });

  it('refuses a service the shop cannot sell: unknown, disabled, archived, unpriced, B2B-only or not listed', async () => {
    const { db } = await testDb();
    const world = await storefrontWorld(db);
    // Every service here is sellable in every respect but the one under test: it has a retail price and a switched-on listing
    // unless the case says otherwise, so each id is refused for its own reason only.
    const mk = async (
      values: Partial<typeof s.services.$inferInsert>,
      options: { priced?: boolean; categoryId?: number; listing?: 'on' | 'off' | 'none' } = {},
    ) => {
      const { priced = true, categoryId = world.icloud.categoryId, listing = 'on' } = options;
      const id = await insertService(db, categoryId, {
        basePrice: '1.0000',
        cost: '0.1000',
        effectiveCost: '0.1000',
        ...values,
      });
      if (priced)
        await db.insert(s.serviceGroupPrices).values({ serviceId: id, groupId: world.groups.retail, price: '5.0000' });
      if (listing !== 'none') await insertListing(db, id, { isListed: listing === 'on' });
      return id;
    };
    const b2b = await db
      .insert(s.serviceCategories)
      .values({ name: 'B2B', type: 'imei', allowedGroupIds: [world.groups.vip] })
      .returning({ id: s.serviceCategories.id });
    const ids = [
      999_999,
      await mk({ status: 'disabled' }),
      await mk({ status: 'disabled', archivedAt: new Date('2026-01-01T00:00:00.000Z') }),
      await mk({}, { priced: false }),
      await mk({}, { categoryId: b2b[0]!.id }),
      // catalog-3: a service with a retail price but no switched-on `service_listings` row is not public, so it cannot be bought
      // by guessing its id.
      await mk({}, { listing: 'none' }),
      await mk({}, { listing: 'off' }),
    ];
    for (const serviceId of ids) {
      const res = await open(valid(world, { serviceId }));
      expect(res.statusCode, String(serviceId)).toBe(422);
      expect(body(res).errors[0]).toMatchObject({ field: 'serviceId', code: 'not_available' });
    }
    // The control: the same shape with its listing on is sold, so the refusals above come from the listing.
    const control = await mk({});
    const sold = await open(valid(world, { serviceId: control }));
    expect(sold.statusCode).toBe(201);
    expect(await counts()).toEqual({ customers: 1, sessions: 1, consents: 0 });
  });

  it('refuses a service whose page is switched off, and sells it again when staff switch the page back on', async () => {
    const { db } = await testDb();
    const world = await storefrontWorld(db);
    await db.update(s.serviceListings).set({ isListed: false }).where(eq(s.serviceListings.id, world.icloud.listingId));
    const off = await open(valid(world));
    expect(off.statusCode).toBe(422);
    expect(body(off).errors[0]).toMatchObject({ field: 'serviceId', code: 'not_available' });
    expect(await counts()).toEqual({ customers: 0, sessions: 0, consents: 0 });

    await db.update(s.serviceListings).set({ isListed: true }).where(eq(s.serviceListings.id, world.icloud.listingId));
    expect((await open(valid(world))).statusCode).toBe(201);
  });

  it('sells a service that is listed only in another language', async () => {
    const { db } = await testDb();
    const world = await storefrontWorld(db);
    await db.update(s.serviceListings).set({ isListed: false }).where(eq(s.serviceListings.id, world.icloud.listingId));
    await insertListing(db, world.icloud.serviceId, { locale: 'ar', slug: 'icloud-ar', publicTitle: 'فحص آي كلاود' });
    expect((await open(valid(world))).statusCode).toBe(201);
  });

  it('refuses a file service that is not ready to order online', async () => {
    const { db } = await testDb();
    const world = await storefrontWorld(db);
    const fileCategory = await insertCategory(db, { name: 'Files', type: 'file' });
    const fileId = await insertService(db, fileCategory, {
      type: 'file',
      basePrice: '1.0000',
      cost: '0.1000',
      effectiveCost: '0.1000',
    });
    await db.insert(s.serviceGroupPrices).values({ serviceId: fileId, groupId: world.groups.retail, price: '5.0000' });
    await insertListing(db, fileId);
    const refused = await open(valid(world, { serviceId: fileId, imei: undefined }));
    expect(refused.statusCode).toBe(422);
    expect(body(refused).errors[0]).toMatchObject({ field: 'serviceId', code: 'not_orderable' });
    expect(await counts()).toEqual({ customers: 0, sessions: 0, consents: 0 });
  });

  it('asks a service with order fields for them, checks them, and stores what the buyer gave', async () => {
    const { db } = await testDb();
    const world = await storefrontWorld(db);
    const serverCategory = await insertCategory(db, { name: 'Server', type: 'server' });
    const server = await insertService(db, serverCategory, {
      type: 'server',
      name: 'Server credits',
      basePrice: '8.0000',
      cost: '6.0000',
      effectiveCost: '6.0000',
      minProfit: '0.5000',
    });
    await db.insert(s.serviceGroupPrices).values({ serviceId: server, groupId: world.groups.retail, price: '12.0000' });
    await insertListing(db, server, { slug: 'server-credits', publicTitle: 'Server credits' });
    await db
      .insert(s.serviceFields)
      .values({ serviceId: server, key: 'username', label: 'Username', required: true, sort: 1 });

    const missing = await open({ serviceId: server, email: 'sam@mail.example', country: 'GB' });
    expect(missing.statusCode).toBe(422);
    expect(body(missing).errors[0]).toMatchObject({ field: 'inputs.username', code: 'required' });
    const unknown = await open({
      serviceId: server,
      email: 'sam@mail.example',
      country: 'GB',
      inputs: { username: 'sam', typo: 'x' },
    });
    expect(body(unknown).errors[0]).toMatchObject({ field: 'inputs.typo', code: 'unknown_field' });

    const ok = await open({
      serviceId: server,
      email: 'sam@mail.example',
      country: 'GB',
      inputs: { username: 'sam_01' },
    });
    expect(ok.statusCode).toBe(201);
    expect(body(ok).imei).toBeNull();
    const [row] = await db.select().from(s.checkoutSessions);
    expect(row).toMatchObject({ inputs: { username: 'sam_01' }, imeiEnc: null });
  });

  it('refuses a suspended or blocked customer with ACCOUNT_SUSPENDED and a neutral message, and opens nothing', async () => {
    const { db } = await testDb();
    const world = await storefrontWorld(db);
    await db.insert(s.customers).values([
      { email: 'suspended@mail.example', status: 'suspended' },
      { email: 'blocked@mail.example', status: 'blocked' },
    ]);
    for (const email of ['suspended@mail.example', 'BLOCKED@mail.example']) {
      const res = await open(valid(world, { email }));
      expect(res.statusCode, email).toBe(403);
      expect(body(res).code).toBe('ACCOUNT_SUSPENDED');
      expect(body(res).detail).toBe('This account cannot start a new order. Contact support.');
    }
    expect(await counts()).toEqual({ customers: 2, sessions: 0, consents: 0 });
  });

  it('asks for sign-in when the shop turned guest checkout off', async () => {
    const { db } = await testDb();
    const world = await storefrontWorld(db);
    await db.insert(s.settings).values({ key: 'guestCheckout', value: false });
    const res = await open(valid(world));
    expect(res.statusCode).toBe(401);
    expect(body(res).detail).toBe('Sign in to check out.');
    expect(await counts()).toEqual({ customers: 0, sessions: 0, consents: 0 });
  });

  it('needs the anti-bot token and creates nothing without it', async () => {
    const { db } = await testDb();
    const world = await storefrontWorld(db);
    const bad: Array<Record<string, string>> = [{}, { 'x-turnstile-token': 'wrong' }];
    for (const headers of bad) {
      const res = await open(valid(world), headers);
      expect(res.statusCode).toBe(403);
      expect(body(res).code).toBe('TURNSTILE_FAILED');
    }
    expect(await counts()).toEqual({ customers: 0, sessions: 0, consents: 0 });
  });

  it('opens nothing without a retail group', async () => {
    const res = await open({ serviceId: 1, email: 'sam@mail.example', country: 'GB', imei: APPLE_IMEI });
    expect(res.statusCode).toBe(422);
    expect(body(res).errors[0].field).toBe('serviceId');
  });
});

/** A customer who signed in on the storefront, with the client that holds the cookies and the CSRF token. */
async function signedInCustomer(overrides: Parameters<typeof makeCustomer>[1] = {}) {
  const customer = await makeCustomer(t, overrides);
  const client = new StoreClient(t, freshClientIp());
  expect((await client.login(customer.email)).statusCode).toBe(200);
  return { customer, client };
}
const OPEN_URL = '/store/v1/checkout-sessions';

describe('POST /store/v1/checkout-sessions as a signed-in customer (feature 14b)', () => {
  it('opens the checkout as the account, even with guest checkout off, whatever the case of the typed email', async () => {
    const { db } = await testDb();
    const world = await storefrontWorld(db);
    await db.insert(s.settings).values({ key: 'guestCheckout', value: false });
    const { customer, client } = await signedInCustomer();

    const res = await client.call('POST', OPEN_URL, valid(world, { email: customer.email.toUpperCase() }));
    expect(res.statusCode).toBe(201);
    expect(res.headers['cache-control']).toBe('no-store');
    const [row] = await db.select().from(s.checkoutSessions);
    expect(row).toMatchObject({ token: body(res).token, customerId: customer.id, email: customer.email });
    // The account is the customer: no guest row was made, and the session works like any other.
    expect(await counts()).toEqual({ customers: 1, sessions: 1, consents: 0 });
    expect((await show(body(res).token)).statusCode).toBe(200);

    // Without the cookie the same call is a guest's, which this shop does not accept.
    expect((await open(valid(world))).statusCode).toBe(401);
  });

  it('needs the CSRF header of the session and writes nothing without it', async () => {
    const { db } = await testDb();
    const world = await storefrontWorld(db);
    const { customer, client } = await signedInCustomer();
    for (const csrf of [false, 'not-the-token']) {
      const res = await client.call('POST', OPEN_URL, valid(world, { email: customer.email }), { csrf });
      expect(res.statusCode, String(csrf)).toBe(403);
      expect(body(res).code).toBe('CSRF_FAILED');
    }
    expect(await counts()).toEqual({ customers: 1, sessions: 0, consents: 0 });
    // With the header it opens.
    expect((await client.call('POST', OPEN_URL, valid(world, { email: customer.email }))).statusCode).toBe(201);
  });

  it("refuses an email that is not the account's with 422 on email, guest checkout on or off, and writes nothing", async () => {
    const { db } = await testDb();
    const world = await storefrontWorld(db);
    const { client } = await signedInCustomer();
    const other = await makeCustomer(t, { guest: true });
    for (const guestCheckout of [true, false]) {
      await db.delete(s.settings);
      await db.insert(s.settings).values({ key: 'guestCheckout', value: guestCheckout });
      for (const email of ['someone.else@mail.example', other.email]) {
        const res = await client.call('POST', OPEN_URL, valid(world, { email }));
        expect(res.statusCode, `${guestCheckout} ${email}`).toBe(422);
        expect(body(res).code).toBe('VALIDATION_FAILED');
        expect(body(res).errors).toEqual([
          {
            field: 'email',
            code: 'not_account_email',
            message: 'Use the email of your account, or sign out to check out as a guest.',
          },
        ]);
      }
    }
    expect(await counts()).toEqual({ customers: 2, sessions: 0, consents: 0 });
  });

  it('treats a request with no usable session as a guest: no cookie, an unknown token, or a session that is not complete', async () => {
    const { db } = await testDb();
    const world = await storefrontWorld(db);
    const account = await makeCustomer(t);
    // No cookie: a guest who types an account's email gets that customer row, as before 14b.
    const asGuest = await open(valid(world, { email: account.email }));
    expect(asGuest.statusCode).toBe(201);

    // A cookie that names no session.
    const stale = new StoreClient(t, freshClientIp());
    stale.setSessionToken('x'.repeat(43));
    expect(
      (await stale.call('POST', OPEN_URL, valid(world, { email: 'new.guest@mail.example' }), { csrf: false }))
        .statusCode,
    ).toBe(201);

    // A pending_password session cannot act as the account.
    const pending = await makeCustomer(t, { mustChangePassword: true });
    const pendingClient = new StoreClient(t, freshClientIp());
    expect((await pendingClient.login(pending.email)).json()).toEqual({ next: 'password' });
    await db.insert(s.settings).values({ key: 'guestCheckout', value: false });
    const refused = await pendingClient.call('POST', OPEN_URL, valid(world, { email: pending.email }));
    expect(refused.statusCode).toBe(401);
    expect(body(refused).detail).toBe('Sign in to check out.');

    const rows = await db.select().from(s.checkoutSessions).orderBy(s.checkoutSessions.id);
    expect(rows.map((row) => row.email)).toEqual([account.email, 'new.guest@mail.example']);
    expect(rows[0]?.customerId).toBe(account.id);
  });

  it('still refuses a suspended customer, who has no usable session any more', async () => {
    const { db } = await testDb();
    const world = await storefrontWorld(db);
    const { customer, client } = await signedInCustomer();
    await db.update(s.customers).set({ status: 'suspended' }).where(eq(s.customers.id, customer.id));
    await clearIdentityCaches(t);

    const res = await client.call('POST', OPEN_URL, valid(world, { email: customer.email }));
    expect(res.statusCode).toBe(403);
    expect(body(res).code).toBe('ACCOUNT_SUSPENDED');
    expect(body(res).detail).toBe('This account cannot start a new order. Contact support.');
    // With guest checkout off the suspended customer is just a guest who must sign in.
    await db.insert(s.settings).values({ key: 'guestCheckout', value: false });
    expect((await client.call('POST', OPEN_URL, valid(world, { email: customer.email }))).statusCode).toBe(401);
    expect(await counts()).toEqual({ customers: 1, sessions: 0, consents: 0 });
    expect((await customerRow(customer.id)).status).toBe('suspended');
  });
});

describe('GET /store/v1/checkout-sessions/:token', () => {
  it('shows the session by its token, with the consent state and the payment methods that are on', async () => {
    const { db } = await testDb();
    const world = await storefrontWorld(db);
    await db
      .insert(s.paymentGateways)
      .values({ code: 'card', driver: 'stripe', name: 'Card gateway', audience: 'b2c', supports3ds: true });
    const opened = body(await open(valid(world)));
    const res = await show(opened.token);
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(body(res)).toEqual({
      ...opened,
      paymentMethods: [{ code: 'card', name: 'Card gateway', supports3ds: true }],
    });
  });

  it('answers 404 with the same words for an unknown, a malformed and a nearly right token', async () => {
    const { db } = await testDb();
    const world = await storefrontWorld(db);
    const { token } = body(await open(valid(world)));
    const nearly = `${token.slice(0, -1)}${token.endsWith('A') ? 'B' : 'A'}`;
    const answers = [];
    for (const wrong of [nearly, 'AAAAAAAAAAAAAAAAAAAAAA', 'short', 'has space in it......']) {
      const res = await show(encodeURIComponent(wrong));
      expect(res.statusCode, wrong).toBe(404);
      answers.push(body(res));
    }
    // A path parameter longer than the router allows never reaches the guard at all.
    expect([400, 404]).toContain((await show('x'.repeat(200))).statusCode);
    for (const answer of answers) {
      expect(answer).toMatchObject({ code: 'NOT_FOUND', status: 404, detail: 'This link is not valid.' });
      expect(JSON.stringify(answer)).not.toContain(token);
    }
  });

  it('reads an unpaid session as expired from the moment it runs out, and a paid one as paid', async () => {
    const { db } = await testDb();
    const world = await storefrontWorld(db);
    const { token } = body(await open(valid(world)));
    clock.advance(30 * MINUTE - 1);
    expect(body(await show(token)).status).toBe('open');
    clock.advance(1);
    expect(body(await show(token)).status).toBe('expired');
    await db.update(s.checkoutSessions).set({ status: 'paid' });
    expect(body(await show(token)).status).toBe('paid');
  });

  it('still names the service and shows the locked amounts after the service is archived and the currency switched off', async () => {
    const { db } = await testDb();
    const world = await storefrontWorld(db);
    const { token } = body(await open(valid(world)));
    await db
      .update(s.services)
      .set({ status: 'disabled', archivedAt: new Date('2026-11-07T12:01:00.000Z') })
      .where(eq(s.services.id, world.icloud.serviceId));
    await db.update(s.currencies).set({ isStorefront: false }).where(eq(s.currencies.code, 'GBP'));
    const again = body(await show(token));
    expect(again.service.name).toBe('iCloud Clean / Lost Check');
    expect(again.amounts.display.gross).toBe('3.8400');
  });

  it('limits token lookups to 30 a minute per address, with 429 and Retry-After', async () => {
    const ip = freshClientIp();
    const lookup = () =>
      t.app.inject({ method: 'GET', url: '/store/v1/checkout-sessions/AAAAAAAAAAAAAAAAAAAAAA', remoteAddress: ip });
    for (let index = 0; index < 30; index += 1) expect((await lookup()).statusCode).toBe(404);
    const limited = await lookup();
    expect(limited.statusCode).toBe(429);
    expect(body(limited).code).toBe('RATE_LIMITED');
    expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);
  });
});

describe('POST /store/v1/checkout-sessions/:token/consents', () => {
  const ALL = [
    { purpose: 'terms', granted: true },
    { purpose: 'privacy', granted: true },
    { purpose: 'withdrawal_waiver', granted: true },
  ];

  async function opened() {
    const { db } = await testDb();
    const world = await storefrontWorld(db);
    const session = body(await open(valid(world)));
    const [row] = await db.select().from(s.checkoutSessions);
    return { db, world, token: session.token as string, sessionId: row!.id, customerId: row!.customerId! };
  }

  it('records the proof: the version of each text, the time, the address and the user agent', async () => {
    const { db, token, sessionId, customerId } = await opened();
    clock.advance(MINUTE);
    const res = await consent(token, { consents: ALL });
    expect(res.statusCode).toBe(201);
    expect(body(res)).toEqual({
      records: [
        {
          purpose: 'terms',
          granted: true,
          document: { type: 'terms', version: '3.2', locale: 'en' },
          recordedAt: '2026-11-07T12:01:00.000Z',
        },
        {
          purpose: 'privacy',
          granted: true,
          document: { type: 'privacy', version: '2.1', locale: 'en' },
          recordedAt: '2026-11-07T12:01:00.000Z',
        },
        { purpose: 'withdrawal_waiver', granted: true, document: null, recordedAt: '2026-11-07T12:01:00.000Z' },
      ],
      consent: {
        required: ['terms', 'privacy', 'withdrawal_waiver'],
        granted: ['terms', 'privacy', 'withdrawal_waiver'],
        complete: true,
      },
    });
    const rows = await db.select().from(s.consentRecords).orderBy(s.consentRecords.id);
    expect(rows).toHaveLength(3);
    const terms = (await db.select().from(s.legalDocuments).where(eq(s.legalDocuments.type, 'terms')))[0]!;
    expect(rows[0]).toMatchObject({
      subjectType: 'customer',
      subjectId: customerId,
      legalDocumentId: terms.id,
      purpose: 'terms',
      granted: true,
      checkoutSessionId: sessionId,
      orderId: null,
      userAgent: 'Mozilla/5.0 (test)',
    });
    expect(rows[0]?.ip).not.toBe('');
    expect(rows[0]?.createdAt.toISOString()).toBe('2026-11-07T12:01:00.000Z');
    expect(rows[2]).toMatchObject({ purpose: 'withdrawal_waiver', legalDocumentId: null });
    expect(body(await show(token)).consent.complete).toBe(true);
  });

  it('keeps a retry from writing the proof twice, and writes a new row for a withdrawal', async () => {
    const { db, token } = await opened();
    await consent(token, { consents: ALL });
    clock.advance(MINUTE);
    const retry = await consent(token, { consents: ALL });
    expect(retry.statusCode).toBe(201);
    expect(body(retry).records[0].recordedAt).toBe('2026-11-07T12:00:00.000Z');
    expect(await db.select().from(s.consentRecords)).toHaveLength(3);

    const withdrawn = await consent(token, { consents: [{ purpose: 'terms', granted: false }] });
    expect(body(withdrawn).consent).toEqual({
      required: ['terms', 'privacy', 'withdrawal_waiver'],
      granted: ['privacy', 'withdrawal_waiver'],
      complete: false,
    });
    expect(await db.select().from(s.consentRecords)).toHaveLength(4);
    // The old grant is still there: proof is never overwritten.
    expect(
      (await db.select().from(s.consentRecords).where(eq(s.consentRecords.purpose, 'terms')))
        .map((row) => row.granted)
        .sort(),
    ).toEqual([false, true]);
  });

  it('points a new record at the new text when a new version becomes current', async () => {
    const { db, token } = await opened();
    await consent(token, { consents: [{ purpose: 'terms', granted: true }] });
    await db.update(s.legalDocuments).set({ isCurrent: false }).where(eq(s.legalDocuments.type, 'terms'));
    await insertLegal(db, { type: 'terms', version: '4.0' });
    const res = await consent(token, { consents: [{ purpose: 'terms', granted: true }] });
    expect(body(res).records[0].document.version).toBe('4.0');
    expect(await db.select().from(s.consentRecords)).toHaveLength(2);
  });

  it('records marketing and the refund policy without making them required, and falls back to English texts', async () => {
    const { db, token } = await opened();
    const res = await consent(token, {
      locale: 'ar',
      consents: [
        { purpose: 'marketing', granted: true },
        { purpose: 'refund_policy', granted: true },
      ],
    });
    expect(res.statusCode).toBe(201);
    expect(body(res).records[1].document).toEqual({ type: 'refund', version: '1.4', locale: 'en' });
    expect(body(res).consent).toEqual({
      required: ['terms', 'privacy', 'withdrawal_waiver'],
      granted: ['refund_policy', 'marketing'],
      complete: false,
    });
    expect((await db.select().from(s.consentRecords)).map((row) => row.purpose).sort()).toEqual([
      'marketing',
      'refund_policy',
    ]);
    // A guest's only place to choose is the checkout, so the customer list shows what was recorded.
    const [guest] = await db.select().from(s.customers);
    expect(guest?.marketingOptIn).toBe(true);
  });

  it("never changes an account holder's marketing choice from a guest checkout, but records the purchase consents", async () => {
    const { db, token, customerId } = await opened();
    await db.update(s.customers).set({ hasAccount: true, marketingOptIn: false }).where(eq(s.customers.id, customerId));
    const res = await consent(token, { consents: [...ALL, { purpose: 'marketing', granted: true }] });
    expect(res.statusCode).toBe(201);
    expect(body(res).records.map((record: { purpose: string }) => record.purpose)).toEqual([
      'terms',
      'privacy',
      'withdrawal_waiver',
    ]);
    expect(body(res).consent.complete).toBe(true);
    const purposes = (await db.select().from(s.consentRecords)).map((row) => row.purpose);
    expect(purposes.sort()).toEqual(['privacy', 'terms', 'withdrawal_waiver']);
    const [holder] = await db.select().from(s.customers).where(eq(s.customers.id, customerId));
    expect(holder?.marketingOptIn).toBe(false);
  });

  it('writes one proof when the same consents arrive twice at once', async () => {
    const { db, token } = await opened();
    const answers = await Promise.all([consent(token, { consents: ALL }), consent(token, { consents: ALL })]);
    expect(answers.map((res) => res.statusCode)).toEqual([201, 201]);
    // The session row is locked for the whole write, so the second request sees the first one's records as a retry.
    expect(await db.select().from(s.consentRecords)).toHaveLength(3);
  });

  it('does not need the waiver when the policy is off', async () => {
    const { db, token } = await opened();
    await db.insert(s.settings).values({ key: 'withdrawalWaiver', value: false });
    const res = await consent(token, { consents: ALL.slice(0, 2) });
    expect(body(res).consent).toEqual({
      required: ['terms', 'privacy'],
      granted: ['terms', 'privacy'],
      complete: true,
    });
  });

  it('refuses a purpose twice, a purpose without a published text and an empty or unknown list, writing nothing', async () => {
    const { db, token } = await opened();
    const twice = await consent(token, {
      consents: [
        { purpose: 'terms', granted: true },
        { purpose: 'terms', granted: false },
      ],
    });
    expect(twice.statusCode).toBe(422);
    expect(body(twice).errors[0]).toMatchObject({ field: 'consents.1.purpose', code: 'duplicate' });
    await db.delete(s.legalDocuments).where(eq(s.legalDocuments.type, 'privacy'));
    const missing = await consent(token, { consents: ALL });
    expect(missing.statusCode).toBe(422);
    expect(body(missing).errors[0]).toMatchObject({ field: 'consents.1.purpose', code: 'no_document' });
    for (const payload of [
      { consents: [] },
      {},
      { consents: [{ purpose: 'newsletter', granted: true }] },
      { consents: [{ purpose: 'terms' }] },
    ]) {
      expect((await consent(token, payload)).statusCode, JSON.stringify(payload)).toBe(422);
    }
    expect(await db.select().from(s.consentRecords)).toEqual([]);
  });

  it('refuses consent on a session that is expired or paid with INVALID_TRANSITION', async () => {
    const { db, token } = await opened();
    clock.advance(31 * MINUTE);
    const expired = await consent(token, { consents: ALL });
    expect(expired.statusCode).toBe(409);
    expect(body(expired).code).toBe('INVALID_TRANSITION');
    clock.set('2026-11-07T12:00:00.000Z');
    await db.update(s.checkoutSessions).set({ status: 'paid' });
    expect((await consent(token, { consents: ALL })).statusCode).toBe(409);
    expect(await db.select().from(s.consentRecords)).toEqual([]);
  });

  it('answers 404 for a token that opens nothing, and one session cannot consent for another', async () => {
    const { db, world, token } = await opened();
    expect((await consent('AAAAAAAAAAAAAAAAAAAAAA', { consents: ALL })).statusCode).toBe(404);
    const other = body(await open(valid(world, { email: 'other@mail.example' })));
    await consent(other.token, { consents: ALL });
    const rows = await db.select().from(s.consentRecords);
    expect(new Set(rows.map((row) => row.checkoutSessionId)).size).toBe(1);
    expect(body(await show(token)).consent.granted).toEqual([]);
  });

  describe('marketing for the signed-in account holder (feature 14b)', () => {
    const MARKETING = [...ALL, { purpose: 'marketing', granted: true }];
    const purposesOf = (res: { json: () => unknown }) =>
      (body(res).records as Array<{ purpose: string }>).map((record) => record.purpose);

    /** A checkout opened by a signed-in customer, and the client that holds that customer's cookies. */
    async function openedByAccount() {
      const { db } = await testDb();
      const world = await storefrontWorld(db);
      const { customer, client } = await signedInCustomer({ marketingOptIn: false });
      const session = body(await client.call('POST', OPEN_URL, valid(world, { email: customer.email })));
      return { db, world, customer, client, token: session.token as string };
    }
    const consentsUrl = (token: string) => `${OPEN_URL}/${token}/consents`;

    it('records marketing for the account holder with the CSRF header, sets marketing_opt_in, and a withdrawal sets it back', async () => {
      const { db, customer, client, token } = await openedByAccount();
      const res = await client.call('POST', consentsUrl(token), { consents: MARKETING });
      expect(res.statusCode).toBe(201);
      expect(purposesOf(res)).toEqual(['terms', 'privacy', 'withdrawal_waiver', 'marketing']);
      expect((await customerRow(customer.id)).marketingOptIn).toBe(true);
      const [record] = await db.select().from(s.consentRecords).where(eq(s.consentRecords.purpose, 'marketing'));
      expect(record).toMatchObject({ subjectId: customer.id, granted: true, legalDocumentId: null });

      clock.advance(MINUTE);
      const withdrawn = await client.call('POST', consentsUrl(token), {
        consents: [{ purpose: 'marketing', granted: false }],
      });
      expect(withdrawn.statusCode).toBe(201);
      const updated = await customerRow(customer.id);
      expect(updated.marketingOptIn).toBe(false);
      expect(updated.updatedAt.toISOString()).toBe('2026-11-07T12:01:00.000Z');
      expect(await db.select().from(s.consentRecords).where(eq(s.consentRecords.purpose, 'marketing'))).toHaveLength(2);
    });

    it('keeps the guest rule for a request without the session: the token alone never changes the account', async () => {
      const { db, customer, token } = await openedByAccount();
      const res = await consent(token, { consents: MARKETING });
      expect(res.statusCode).toBe(201);
      expect(purposesOf(res)).toEqual(['terms', 'privacy', 'withdrawal_waiver']);
      expect((await customerRow(customer.id)).marketingOptIn).toBe(false);
      expect(await db.select().from(s.consentRecords).where(eq(s.consentRecords.purpose, 'marketing'))).toHaveLength(0);
    });

    it("keeps the guest rule for another signed-in customer: only the checkout's own customer may choose", async () => {
      const { db, customer, token } = await openedByAccount();
      const { customer: stranger, client: strangerClient } = await signedInCustomer({ marketingOptIn: false });
      const res = await strangerClient.call('POST', consentsUrl(token), { consents: MARKETING });
      expect(res.statusCode).toBe(201);
      expect(purposesOf(res)).toEqual(['terms', 'privacy', 'withdrawal_waiver']);
      expect((await customerRow(customer.id)).marketingOptIn).toBe(false);
      expect((await customerRow(stranger.id)).marketingOptIn).toBe(false);
      expect(await db.select().from(s.consentRecords).where(eq(s.consentRecords.purpose, 'marketing'))).toHaveLength(0);
    });

    it('answers CSRF_FAILED for a customer session without its CSRF header and writes nothing', async () => {
      const { db, customer, client, token } = await openedByAccount();
      for (const csrf of [false, 'not-the-token']) {
        const res = await client.call('POST', consentsUrl(token), { consents: MARKETING }, { csrf });
        expect(res.statusCode, String(csrf)).toBe(403);
        expect(body(res).code).toBe('CSRF_FAILED');
      }
      expect(await db.select().from(s.consentRecords)).toHaveLength(0);
      expect((await customerRow(customer.id)).marketingOptIn).toBe(false);
    });
  });

  it('does not need the anti-bot token: the capability token in the path is the credential', async () => {
    const { token } = await opened();
    expect((await consent(token, { consents: ALL })).statusCode).toBe(201);
  });
});

// Integration tests of the admin account privacy actions (feature 18, decision 064; POST /admin/clients/:id/block, GET
// /admin/clients/:id/privacy, GET /admin/clients/:id/export, POST /admin/clients/:id/anonymize; scenario b2c-account, RESOLUTIONS b2c-4, b2c-5
// and b2c-8, MISMATCHES B48, B49, B50): what a block adds and an unblock removes for every rank, the privacy read, the origin
// check (decision 045) and content of the export, and everything anonymizing cuts and keeps, the guest row of a proven email included.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, mock } from 'bun:test';
import { and, eq, inArray } from 'drizzle-orm';
import { EncryptionService } from '@src/infra/crypto';
import { schema as s } from '@src/infra/db';
import { CHECKOUT_IMEI_AAD } from '@src/modules/customers';
import { MerchantAccounts } from '@src/modules/money';
import { AccountErasureHooks } from '@src/modules/customers/application/customer-erasure-hooks';
import { accountRow, ensureMerchantGroup, ensureRetailGroup, makeAccount } from '../../support/accounts';
import { openAccountSession } from '../../support/account-sessions';
import { type AdminApi, adminWith } from '../../support/admin-api';
import { type TestApp, createTestApp } from '../../support/app';
import { clearIdentityCaches } from '../../support/auth';
import { insertInvoiceRow } from '../../support/billing';
import { TestClock } from '../../support/clock';
import { fundCustomer } from '../../support/customer-wallet';
import { auditOfCustomer, insertStoreCurrencies, insertTaxRates } from '../../support/customers';
import { closeTestDb, resetDb, testDb } from '../../support/db';
import { fundWallet } from '../../support/money';
import { type OrdersWorld, insertOrderRow, ordersWorld } from '../../support/orders';
import { freshClientIp } from '../../support/pipeline-routes';
import { blocklistRows, insertBlock, insertHeldOrder } from '../../support/risk';
import { CONSOLE_ORIGIN } from '../../support/staff-console';
import { insertSupportMessage, insertSupportTicket } from '../../support/support';
import { insertFileRow } from '../../support/support-accounts';
import {
  STORE_ORIGIN,
  StoreClient,
  captureCustomerLinks,
  clearStoreRateLimits,
  customerRow,
  makeCustomer,
} from '../../support/store';

const clock = new TestClock('2026-11-08T09:00:00.000Z');
let t: TestApp;
let world: OrdersWorld;
let staff: AdminApi;

/** The ids the erasure hook was called with, and the id it must fail for (one hook for the whole file: hooks cannot be removed). */
const hookCalls: number[] = [];
let hookFailsFor: number | undefined;

beforeAll(async () => {
  t = await createTestApp({ clock, env: { CONSOLE_ORIGINS: CONSOLE_ORIGIN, SHOP_ORIGINS: STORE_ORIGIN } });
  t.app.get(AccountErasureHooks).add({
    eraseAccount(_tx, accountId) {
      hookCalls.push(accountId);
      return accountId === hookFailsFor ? Promise.reject(new Error('the support module failed')) : Promise.resolve();
    },
  });
});
beforeEach(async () => {
  clock.set('2026-11-08T09:00:00.000Z');
  await resetDb();
  await clearIdentityCaches(t);
  await clearStoreRateLimits(t);
  captureCustomerLinks(t);
  hookCalls.length = 0;
  hookFailsFor = undefined;
  world = await ordersWorld((await testDb()).db);
  staff = await adminWith(t, ['clients:read', 'clients:block', 'customers:privacy'], { name: 'Rami K.' });
});
afterEach(() => mock.restore());
afterAll(async () => {
  await resetDb();
  await clearIdentityCaches(t);
  await t.close();
  await closeTestDb();
});

const IMEI_ORDER = '353890113898412';
const IMEI_SESSION = '354607111076240';
const IMEI_PORTAL = '356938035643809';
const PROVEN = new Date('2026-10-01T00:00:00.000Z');

/** A signed-in retail account with a paid shop order (IMEI on the order and the checkout) and a card fingerprint. */
async function buyer(options: { fingerprint?: string; name?: string; email?: string; proven?: boolean } = {}) {
  const { db } = world;
  const customer = await makeCustomer(t, {
    name: options.name ?? 'Daniel Whitmore',
    phone: '+441234',
    internalNotes: 'Likes email.',
    marketingOptIn: true,
    ...(options.email === undefined ? {} : { email: options.email }),
    ...(options.proven === true ? { emailVerifiedAt: PROVEN } : {}),
  });
  const order = await insertHeldOrder(world, {
    customerId: customer.id,
    imei: IMEI_ORDER,
    dispatchState: 'pending',
    ...(options.fingerprint === undefined ? {} : { cardFingerprint: options.fingerprint }),
    sessionImeiEnc: t.app.get(EncryptionService).encrypt(IMEI_SESSION, CHECKOUT_IMEI_AAD),
  });
  const store = new StoreClient(t);
  expect((await store.login(customer.email)).statusCode).toBe(200);
  return { customer, order, store, db };
}

/** A guest row with the account's email and one paid shop order, one consent, one ticket and one file of its own. */
async function guestOf(account: { id: number; email: string }, imei = '352099001761481') {
  const { db } = world;
  const guest = await makeCustomer(t, { guest: true, email: account.email, name: 'Dan W.' });
  const order = await insertHeldOrder(world, { customerId: guest.id, imei, dispatchState: 'pending' });
  await db
    .insert(s.consentRecords)
    .values({ subjectType: 'account', subjectId: guest.id, purpose: 'terms', granted: true, ip: '203.0.113.77' });
  const ticket = await insertSupportTicket(db, { requesterId: guest.id, subject: 'Guest question' });
  const file = await insertFileRow(db, 'account', guest.id, { filename: 'guest-receipt.pdf' });
  return { guest, order, ticket, file, db };
}

describe('POST /admin/clients/:id/block', () => {
  it('blocks a retail account: status, notes, sessions, and the email, cards and shop IMEIs on the blocklist linked to the account', async () => {
    const { customer, order, store, db } = await buyer({ fingerprint: 'fp_card_1' });
    const res = await staff.post(`/admin/clients/${customer.id}/block`, {
      blocked: true,
      reason: 'Chargeback or dispute',
    });
    expect(res.status).toBe(204);
    expect(await customerRow(customer.id)).toMatchObject({
      status: 'blocked',
      internalNotes: 'Likes email.\nBlocked: Chargeback or dispute',
    });
    expect((await store.me()).statusCode).toBe(401);
    const entries = await blocklistRows(db);
    expect(entries.map((entry) => entry.kind).sort()).toEqual(['card', 'email', 'imei', 'imei']);
    for (const entry of entries) {
      expect(entry).toMatchObject({
        source: 'manual',
        reason: 'Chargeback or dispute',
        createdBy: staff.staffId,
        accountId: customer.id,
      });
    }
    expect(entries.find((entry) => entry.kind === 'email')!.display).toBe(
      `${customer.email.slice(0, 2)}****@example.com`,
    );
    expect(
      entries
        .filter((entry) => entry.kind === 'imei')
        .map((entry) => entry.display)
        .sort(),
    ).toEqual(['35 389011 389841 2', '35 460711 107624 0']);
    const [audit] = await auditOfCustomer(db, customer.id);
    expect(audit).toMatchObject({
      action: 'blocked account',
      entityType: 'account',
      entityLabel: 'Daniel Whitmore',
      before: { status: 'active' },
      after: { status: 'blocked', reason: 'Chargeback or dispute', blocklisted: 4 },
    });
    // The block does not touch the order.
    expect(order.orderId).toBeGreaterThan(0);
  });

  it('adds the value of a field of type imei of a shop order too, never that of another field (decision 073)', async () => {
    const { customer, order, db } = await buyer();
    const [row] = await db
      .select({ serviceId: s.orders.serviceId })
      .from(s.orders)
      .where(eq(s.orders.id, order.orderId));
    await db.insert(s.serviceFields).values({
      serviceId: row!.serviceId,
      key: 'device',
      label: 'Device',
      supplierKey: 'Device',
      fieldType: 'imei',
      sort: 1,
    });
    await db
      .update(s.orders)
      .set({ inputs: { device: '4901 5420-3237518', note: '356938035643809' } })
      .where(eq(s.orders.id, order.orderId));
    const res = await staff.post(`/admin/clients/${customer.id}/block`, {
      blocked: true,
      reason: 'Chargeback or dispute',
    });
    expect(res.status).toBe(204);
    const imeis = (await blocklistRows(db))
      .filter((entry) => entry.kind === 'imei')
      .map((entry) => entry.display)
      .sort();
    expect(imeis).toEqual(['35 389011 389841 2', '35 460711 107624 0', '49 015420 323751 8']);
  });

  it('adds each line of a field of type imei_bulk and of a main input that is such a list (decision 076)', async () => {
    const { customer, order, db } = await buyer();
    const [row] = await db
      .select({ serviceId: s.orders.serviceId })
      .from(s.orders)
      .where(eq(s.orders.id, order.orderId));
    await db.insert(s.serviceFields).values({
      serviceId: row!.serviceId,
      key: 'devices',
      label: 'Devices',
      supplierKey: 'Devices',
      fieldType: 'imei_bulk',
      sort: 1,
    });
    await db
      .update(s.orders)
      .set({
        imei: '352905112490861\n359254101036747',
        inputs: { devices: '490154203237518\n867412052327342', note: '356938035643809' },
      })
      .where(eq(s.orders.id, order.orderId));
    const res = await staff.post(`/admin/clients/${customer.id}/block`, {
      blocked: true,
      reason: 'Chargeback or dispute',
    });
    expect(res.status).toBe(204);
    const imeis = (await blocklistRows(db))
      .filter((entry) => entry.kind === 'imei')
      .map((entry) => entry.display)
      .sort();
    expect(imeis).toEqual([
      '35 290511 249086 1',
      '35 460711 107624 0',
      '35 925410 103674 7',
      '49 015420 323751 8',
      '86 741205 232734 2',
    ]);
  });

  it('blocks a merchant rank: its email, and none of the IMEIs of its portal orders (a merchant orders for other people)', async () => {
    const { db } = world;
    const merchant = await makeAccount(t, { rank: 'merchant', internalNotes: '' });
    await insertOrderRow(db, {
      accountId: merchant.id,
      serviceId: world.auto.serviceId,
      source: 'portal',
      imei: IMEI_PORTAL,
    });
    const session = await openAccountSession(t, merchant.id);
    const me = () => t.app.inject({ method: 'GET', url: '/client/auth/me', headers: session.headers });
    expect((await me()).statusCode).toBe(200);
    await db.insert(s.apiKeys).values({
      clientId: merchant.id,
      name: 'Portal key',
      prefix: 'gsm_abcd',
      keyHash: crypto.randomUUID(),
      rateLimitPerMin: 60,
    });

    const res = await staff.post(`/admin/clients/${merchant.id}/block`, {
      blocked: true,
      reason: 'Card testing or fraud',
    });
    expect(res.status).toBe(204);
    expect(await accountRow(merchant.id)).toMatchObject({ status: 'blocked' });
    const entries = await blocklistRows(db);
    expect(entries.map((entry) => entry.kind)).toEqual(['email']);
    expect(entries[0]).toMatchObject({ accountId: merchant.id, source: 'manual' });
    // The session ends (the access effects of the status change). A block keeps the API keys, refused while the account is blocked: only a
    // rank change out of the merchant kind and an anonymization revoke them.
    expect((await me()).statusCode).toBe(401);
    const keys = await db.select().from(s.apiKeys).where(eq(s.apiKeys.clientId, merchant.id));
    expect(keys.map((key) => key.revokedAt)).toEqual([null]);
    expect((await auditOfCustomer(db, merchant.id))[0]).toMatchObject({
      action: 'blocked account',
      entityType: 'account',
    });
  });

  it('adds the shop IMEIs of a retail account but not those of an order it placed through the portal as a merchant', async () => {
    const { customer, db } = await buyer({ fingerprint: 'fp_card_1' });
    await insertOrderRow(db, {
      accountId: customer.id,
      serviceId: world.auto.serviceId,
      source: 'portal',
      imei: IMEI_PORTAL,
    });
    await staff.post(`/admin/clients/${customer.id}/block`, { blocked: true, reason: 'Other' });
    const imeis = (await blocklistRows(db)).filter((entry) => entry.kind === 'imei').map((entry) => entry.display);
    expect(imeis).toHaveLength(2);
    expect(imeis).not.toContain('35 693803 564380 9');
  });

  it('keeps an entry that already exists as it is, unlinked, and adds the rest', async () => {
    const { customer, db } = await buyer({ fingerprint: 'fp_card_1' });
    await insertBlock(t, db, 'email', customer.email, { source: 'chargeback', display: 'old' });
    await insertBlock(t, db, 'imei', IMEI_ORDER, { createdBy: staff.staffId, display: 'old' });
    await staff.post(`/admin/clients/${customer.id}/block`, { blocked: true, reason: 'Abuse of refunds' });
    const entries = await blocklistRows(db);
    expect(entries).toHaveLength(4);
    const email = entries.find((entry) => entry.kind === 'email')!;
    expect(email).toMatchObject({ source: 'chargeback', accountId: null, display: 'old' });
    expect(
      entries
        .filter((entry) => entry.accountId === customer.id)
        .map((entry) => entry.kind)
        .sort(),
    ).toEqual(['card', 'imei']);
    const [audit] = await auditOfCustomer(db, customer.id);
    expect(audit!.after).toMatchObject({ blocklisted: 2 });
  });

  it('blocks a guest with no orders by email alone, and a suspended account (the suspension is kept under the block)', async () => {
    const { db } = world;
    const guest = await makeCustomer(t, { guest: true });
    await staff.post(`/admin/clients/${guest.id}/block`, { blocked: true, reason: 'Other' });
    expect((await blocklistRows(db)).map((entry) => entry.kind)).toEqual(['email']);
    const suspendedAt = new Date('2026-11-01T08:00:00.000Z');
    const paused = await makeCustomer(t, {
      status: 'suspended',
      suspendedReason: 'Account may be compromised',
      suspendedAt,
    });
    await staff.post(`/admin/clients/${paused.id}/block`, { blocked: true, reason: 'Card testing or fraud' });
    expect(await customerRow(paused.id)).toMatchObject({
      status: 'blocked',
      suspendedAt,
      suspendedReason: 'Account may be compromised',
    });
  });

  it('never lifts a suspension: unblocking a merchant that was suspended before the block returns it to that suspension (decision 046)', async () => {
    const { db } = world;
    // A role with clients:block and without clients:security, which may not lift a suspension.
    const blocker = await adminWith(t, ['clients:read', 'clients:block']);
    const suspender = await adminWith(t, ['clients:read', 'clients:update', 'clients:security']);
    const merchant = await makeAccount(t, { rank: 'merchant' });
    expect(
      (await suspender.patch(`/admin/clients/${merchant.id}`, { status: 'suspended', reason: 'Unpaid debt' })).status,
    ).toBe(200);
    const suspended = await accountRow(merchant.id);
    expect((await blocker.post(`/admin/clients/${merchant.id}/block`, { blocked: true, reason: 'Other' })).status).toBe(
      204,
    );
    expect((await blocker.post(`/admin/clients/${merchant.id}/block`, { blocked: false })).status).toBe(204);
    expect(await accountRow(merchant.id)).toMatchObject({
      status: 'suspended',
      suspendedAt: suspended.suspendedAt,
      suspendedReason: 'Unpaid debt',
      suspendedBy: suspender.staffId,
    });
    expect((await auditOfCustomer(db, merchant.id)).at(-1)).toMatchObject({
      action: 'unblocked account',
      before: { status: 'blocked' },
      after: { status: 'suspended' },
    });
    // Still suspended: the session sign-in answers the suspension, and only clients:security reactivates it.
    expect((await blocker.patch(`/admin/clients/${merchant.id}`, { status: 'active' })).status).toBe(403);
    expect((await suspender.patch(`/admin/clients/${merchant.id}`, { status: 'active' })).status).toBe(200);
  });

  it('unblocks: active, and deletes only the manual entries this block added', async () => {
    const { customer, db } = await buyer({ fingerprint: 'fp_card_1' });
    const other = await insertBlock(t, db, 'domain', 'evil.example', { createdBy: staff.staffId });
    const chargeback = await insertBlock(t, db, 'card', 'fp_other', { source: 'chargeback' });
    const refunded = await insertBlock(t, db, 'imei', IMEI_SESSION, { createdBy: staff.staffId });
    await staff.post(`/admin/clients/${customer.id}/block`, { blocked: true, reason: 'Other' });
    expect((await blocklistRows(db)).filter((entry) => entry.accountId === customer.id)).toHaveLength(3);
    const res = await staff.post(`/admin/clients/${customer.id}/block`, { blocked: false });
    expect(res.status).toBe(204);
    expect(await customerRow(customer.id)).toMatchObject({ status: 'active' });
    expect((await blocklistRows(db)).map((entry) => entry.id).sort()).toEqual(
      [other.id, chargeback.id, refunded.id].sort(),
    );
    const audits = await auditOfCustomer(db, customer.id);
    expect(audits.at(-1)).toMatchObject({
      action: 'unblocked account',
      before: { status: 'blocked' },
      after: { status: 'active', removed: 3 },
    });
    // The account can sign in again.
    expect((await new StoreClient(t).login(customer.email)).statusCode).toBe(200);
  });

  it('takes an optional reason when lifting', async () => {
    const customer = await makeCustomer(t, { status: 'blocked' });
    expect(
      (await staff.post(`/admin/clients/${customer.id}/block`, { blocked: false, reason: 'Resolved with the bank' }))
        .status,
    ).toBe(204);
    expect(await customerRow(customer.id)).toMatchObject({ status: 'active' });
    expect((await auditOfCustomer((await testDb()).db, customer.id))[0]!.after).toMatchObject({
      reason: 'Resolved with the bank',
    });
  });

  it('refuses: 409 ALREADY_BLOCKED, 409 NOT_BLOCKED, 409 ANONYMIZED, 404, and 422 on reason (missing, not one of the four, too long)', async () => {
    const customer = await makeCustomer(t);
    expect((await staff.post(`/admin/clients/${customer.id}/block`, { blocked: false })).body.code).toBe('NOT_BLOCKED');
    for (const body of [
      { blocked: true },
      { blocked: true, reason: '  ' },
      { blocked: true, reason: 'I do not like him' },
      { blocked: true, reason: 'x'.repeat(301) },
    ]) {
      const res = await staff.post(`/admin/clients/${customer.id}/block`, body);
      expect(res.status).toBe(422);
      expect(res.body.errors[0].field).toBe('reason');
    }
    expect((await customerRow(customer.id)).status).toBe('active');
    expect((await staff.post(`/admin/clients/${customer.id}/block`, { blocked: true, reason: 'Other' })).status).toBe(
      204,
    );
    const again = await staff.post(`/admin/clients/${customer.id}/block`, { blocked: true, reason: 'Other' });
    expect(again.status).toBe(409);
    expect(again.body.code).toBe('ALREADY_BLOCKED');
    const gone = await makeCustomer(t, { status: 'anonymized', anonymizedAt: clock.now() });
    expect((await staff.post(`/admin/clients/${gone.id}/block`, { blocked: true, reason: 'Other' })).body.code).toBe(
      'ANONYMIZED',
    );
    expect((await staff.post(`/admin/clients/${gone.id}/block`, { blocked: false })).body.code).toBe('ANONYMIZED');
    expect((await staff.post('/admin/clients/999999/block', { blocked: true, reason: 'Other' })).status).toBe(404);
    expect((await staff.post(`/admin/clients/${customer.id}/block`, {})).status).toBe(422);
  });

  it('lets two blocks at once make one block', async () => {
    const customer = await makeCustomer(t);
    const body = { blocked: true, reason: 'Other' };
    const [a, b] = await Promise.all([
      staff.post(`/admin/clients/${customer.id}/block`, body),
      staff.post(`/admin/clients/${customer.id}/block`, body),
    ]);
    expect([a.status, b.status].sort()).toEqual([204, 409]);
    expect(await blocklistRows((await testDb()).db)).toHaveLength(1);
  });

  it('needs clients:block and the CSRF token', async () => {
    const customer = await makeCustomer(t);
    const reader = await adminWith(t, ['clients:read', 'clients:update', 'customers:privacy']);
    expect((await reader.post(`/admin/clients/${customer.id}/block`, { blocked: true, reason: 'Other' })).status).toBe(
      403,
    );
    expect(
      (await staff.withoutCsrf('POST', `/admin/clients/${customer.id}/block`, { blocked: true, reason: 'Other' }))
        .status,
    ).toBe(403);
    expect((await customerRow(customer.id)).status).toBe('active');
  });
});

describe('GET /admin/clients/:id/privacy', () => {
  it('reads the marketing choice, the consents of the latest shop order with their documents, and the risk signals', async () => {
    const { customer, order, db } = await buyer();
    await db.insert(s.consentRecords).values([
      {
        subjectType: 'account',
        subjectId: customer.id,
        purpose: 'terms',
        granted: true,
        ip: '203.0.113.25',
        orderId: order.orderId,
      },
      {
        subjectType: 'account',
        subjectId: customer.id,
        purpose: 'withdrawal_waiver',
        granted: true,
        ip: '203.0.113.25',
        orderId: order.orderId,
      },
    ]);
    const res = await staff.get(`/admin/clients/${customer.id}/privacy`);
    expect(res.status).toBe(200);
    expect(res.body.marketingOptIn).toBe(true);
    expect(res.body.latestConsents.orderId).toBe(order.orderId);
    expect(res.body.latestConsents.records.map((record: { purpose: string }) => record.purpose)).toEqual([
      'terms',
      'withdrawal_waiver',
    ]);
    expect(res.body.latestConsents.records[0]).toMatchObject({ ip: '203.0.113.25', at: expect.any(String) });
    expect(res.body.risk.highestScore).toBe(62);
    expect(res.body.risk.signals).toEqual([
      { text: 'Disposable email domain', orderId: order.orderId },
      { text: 'IP country differs from card country', orderId: order.orderId },
    ]);
  });

  it('answers the consents of the latest shop order, never those of a portal order of a merchant rank', async () => {
    const { db } = world;
    const merchant = await makeAccount(t, { rank: 'merchant' });
    const portal = await insertOrderRow(db, {
      accountId: merchant.id,
      serviceId: world.auto.serviceId,
      source: 'portal',
    });
    await db.insert(s.consentRecords).values({
      subjectType: 'account',
      subjectId: merchant.id,
      purpose: 'terms',
      granted: true,
      ip: '203.0.113.9',
      orderId: portal.id,
    });
    const res = await staff.get(`/admin/clients/${merchant.id}/privacy`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      marketingOptIn: false,
      latestConsents: null,
      risk: { highestScore: null, signals: [] },
    });
  });

  it('answers 404 for an unknown account, 401 without a session, and needs clients:read', async () => {
    expect((await staff.get('/admin/clients/999999/privacy')).status).toBe(404);
    const customer = await makeCustomer(t);
    expect((await staff.anonymous('GET', `/admin/clients/${customer.id}/privacy`)).status).toBe(401);
    const other = await adminWith(t, ['customers:privacy', 'clients:block']);
    expect((await other.get(`/admin/clients/${customer.id}/privacy`)).status).toBe(403);
  });
});

describe('GET /admin/clients/:id/export', () => {
  const download = (id: number, headers: Record<string, string>) =>
    t.app.inject({
      method: 'GET',
      url: `/admin/clients/${id}/export`,
      headers: { ...staff.session.headers, ...headers },
      remoteAddress: '127.0.0.1',
    });

  it('answers a JSON file with everything held about the account, the IMEIs decrypted and no card data', async () => {
    const { customer, order, db } = await buyer({ fingerprint: 'fp_secret_card' });
    await db.update(s.checkoutSessions).set({ ipCountry: 'DE' }).where(eq(s.checkoutSessions.id, order.sessionId));
    await db
      .insert(s.consentRecords)
      .values({ subjectType: 'account', subjectId: customer.id, purpose: 'terms', granted: true, ip: '203.0.113.25' });
    const [ticket] = await db
      .insert(s.supportTickets)
      .values({ number: 'T-1001', subject: 'Where is my unlock?', requesterType: 'account', requesterId: customer.id })
      .returning();
    await db.insert(s.ticketMessages).values([
      { ticketId: ticket!.id, authorType: 'account', authorId: customer.id, body: 'It is late.' },
      {
        ticketId: ticket!.id,
        authorType: 'staff',
        authorId: staff.staffId,
        body: 'Customer is rude (internal)',
        isInternal: true,
      },
      { ticketId: ticket!.id, authorType: 'staff', authorId: staff.staffId, body: 'We are on it.' },
    ]);
    await db
      .insert(s.dataRequests)
      .values({ accountId: customer.id, kind: 'export', dueAt: new Date('2026-12-08T09:00:00.000Z') });
    const res = await download(customer.id, { 'sec-fetch-site': 'same-origin' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('application/json');
    expect(res.headers['content-disposition']).toContain(`filename="account-${customer.id}.json"`);
    expect(res.headers['cache-control']).toBe('no-store');
    const file = res.json();
    expect(file.profile).toMatchObject({
      id: customer.id,
      email: customer.email,
      name: 'Daniel Whitmore',
      phone: '+441234',
      country: 'GB',
      rank: { kind: 'retail' },
    });
    expect(file.orders).toEqual([
      expect.objectContaining({
        id: order.orderId,
        imei: IMEI_ORDER,
        service: 'AT&T USA Premier Unlock',
        status: 'pending',
        totalPrice: '12.4900',
      }),
    ]);
    expect(file.checkoutSessions[0]).toMatchObject({
      imei: IMEI_SESSION,
      ip: '203.0.113.25',
      ipCountry: 'DE',
      userAgent: 'Mozilla/5.0',
    });
    // Format 4 (decision 064): the rank, the files and the guest and merchant parts; no list of IMEI checks since format 3.
    expect(file.format).toBe(4);
    expect(file).not.toHaveProperty('imeiChecks');
    expect(file).not.toHaveProperty('merchant');
    expect(file).not.toHaveProperty('ordersPlacedAsGuest');
    expect(file.payments[0]).toMatchObject({ amount: '14.9900', method: 'card', status: 'captured' });
    expect(file.consents[0]).toMatchObject({ purpose: 'terms', granted: true });
    expect(file.supportTickets[0].messages.map((message: { body: string }) => message.body)).toEqual([
      'It is late.',
      'We are on it.',
    ]);
    expect(file.dataRequests[0]).toMatchObject({ kind: 'export', status: 'completed' });
    const text = res.body;
    for (const secret of ['fp_secret_card', 'passwordHash', 'rude']) expect(text).not.toContain(secret);
  });

  it('exports a merchant rank with its rank, company, username, wallet, API keys (never a hash) and invoices', async () => {
    const { db } = world;
    const merchant = await makeAccount(t, {
      rank: 'merchant',
      company: 'Acme Unlocks',
      address: '1 High Street',
      taxId: 'GB123456',
    });
    const [wallet] = await db
      .insert(s.ledgerAccounts)
      .values({
        kind: 'client_wallet',
        ownerType: 'account',
        ownerId: merchant.id,
        currency: 'USD',
        balance: '120.0000',
        overdraftLimit: '50.0000',
      })
      .returning();
    await db
      .insert(s.ledgerAccounts)
      .values({ kind: 'client_hold', ownerType: 'account', ownerId: merchant.id, currency: 'USD', balance: '10.0000' });
    expect(wallet!.id).toBeGreaterThan(0);
    await db.insert(s.apiKeys).values({
      clientId: merchant.id,
      name: 'Portal key',
      prefix: 'gsm_abcd',
      keyHash: 'hash-that-must-never-leave-the-server',
      rateLimitPerMin: 60,
    });
    const res = await download(merchant.id, { 'sec-fetch-site': 'same-origin' });
    expect(res.statusCode).toBe(200);
    const file = res.json();
    expect(file.profile).toMatchObject({
      id: merchant.id,
      rank: { kind: 'merchant' },
      username: merchant.row.username,
      company: 'Acme Unlocks',
      address: '1 High Street',
      taxId: 'GB123456',
    });
    expect(file.merchant.wallet).toMatchObject({
      currency: 'USD',
      balance: '120.0000',
      reserved: '10.0000',
      creditLimit: '50.0000',
    });
    expect(file.merchant.apiKeys).toEqual([expect.objectContaining({ label: 'Portal key', prefix: 'gsm_abcd' })]);
    // Neither a key hash nor any hash field is in the file.
    expect(res.body).not.toContain('hash-that-must-never-leave-the-server');
    expect(res.body.toLowerCase()).not.toContain('keyhash');
    expect(file).not.toHaveProperty('wallet');
  });

  it('keeps the store balance history of an account that was retail and is a merchant now, beside its merchant wallet', async () => {
    const { db } = world;
    const account = await makeAccount(t, { rank: 'merchant' });
    await new MerchantAccounts().open(db, {
      clientId: account.id,
      currency: 'USD',
      creditLimit: '0.0000',
      overdraftAllowed: false,
    });
    // The store balance it had as a retail account.
    await fundCustomer(db, account.id, '25.00', clock.now());
    const res = await download(account.id, { 'sec-fetch-site': 'same-origin' });
    expect(res.statusCode).toBe(200);
    const file = res.json();
    expect(file.profile.rank).toMatchObject({ kind: 'merchant' });
    expect(file.wallet).toMatchObject({ currency: 'USD', balance: '25.0000' });
    expect(file.wallet.entries).toEqual([expect.objectContaining({ amount: '25.0000', balanceAfter: '25.0000' })]);
    expect(file.merchant.wallet).toMatchObject({ currency: 'USD', balance: '0.0000', statement: [] });
  });

  it('keeps the merchant wallet history of an account that was a merchant and is retail now, never a key hash', async () => {
    const { db } = world;
    const account = await makeAccount(t, { rank: 'retail' });
    // The merchant wallet, a deposit and an API key it had as a merchant.
    await new MerchantAccounts().open(db, {
      clientId: account.id,
      currency: 'USD',
      creditLimit: '0.0000',
      overdraftAllowed: false,
    });
    await fundWallet(db, account.id, '40');
    await db.insert(s.apiKeys).values({
      clientId: account.id,
      name: 'Old portal key',
      prefix: 'gsm_old1',
      keyHash: 'old-hash-that-must-never-leave-the-server',
      rateLimitPerMin: 60,
      revokedAt: clock.now(),
    });
    const res = await download(account.id, { 'sec-fetch-site': 'same-origin' });
    expect(res.statusCode).toBe(200);
    const file = res.json();
    expect(file.profile.rank).toMatchObject({ kind: 'retail' });
    expect(file.merchant.wallet).toMatchObject({ currency: 'USD', balance: '40.0000' });
    expect(file.merchant.wallet.statement).toEqual([
      expect.objectContaining({ amount: '40.0000', balanceAfter: '40.0000' }),
    ]);
    expect(file.merchant.apiKeys).toEqual([expect.objectContaining({ label: 'Old portal key', prefix: 'gsm_old1' })]);
    // The wallet of today's rank is there too, empty.
    expect(file.wallet).toMatchObject({ currency: 'USD', balance: '0.0000', entries: [] });
    expect(res.body).not.toContain('old-hash-that-must-never-leave-the-server');
    expect(res.body.toLowerCase()).not.toContain('keyhash');
  });

  it('lists the API keys and merchant invoices of an account that held a merchant rank, whatever its merchant wallet holds', async () => {
    const { db } = world;
    const account = await makeAccount(t, { rank: 'retail' });
    // A merchant wallet with no lines, a revoked key and an unpaid merchant invoice from its time as a merchant.
    await new MerchantAccounts().open(db, {
      clientId: account.id,
      currency: 'USD',
      creditLimit: '0.0000',
      overdraftAllowed: false,
    });
    await db.insert(s.apiKeys).values({
      clientId: account.id,
      name: 'Old portal key',
      prefix: 'gsm_old2',
      keyHash: 'unused-hash-that-must-never-leave-the-server',
      rateLimitPerMin: 60,
      revokedAt: clock.now(),
    });
    const invoice = await insertInvoiceRow(db, account.id, { amount: '75.0000' });
    const res = await download(account.id, { 'sec-fetch-site': 'same-origin' });
    expect(res.statusCode).toBe(200);
    const file = res.json();
    expect(file.profile.rank).toMatchObject({ kind: 'retail' });
    expect(file.merchant.wallet).toMatchObject({ currency: 'USD', balance: '0.0000', statement: [] });
    expect(file.merchant.apiKeys).toEqual([expect.objectContaining({ label: 'Old portal key', prefix: 'gsm_old2' })]);
    expect(file.merchant.invoices).toEqual([
      expect.objectContaining({ number: invoice.number, kind: 'topup', status: 'open', amount: '75.0000' }),
    ]);
    expect(res.body).not.toContain('unused-hash-that-must-never-leave-the-server');
    expect(res.body.toLowerCase()).not.toContain('keyhash');
    expect(res.body).not.toContain('walletKind');
  });

  it('leaves an unused wallet of the other rank kind out', async () => {
    const { db } = world;
    const retail = await makeAccount(t, { rank: 'retail' });
    // A merchant wallet with no entries: nothing to tell.
    await new MerchantAccounts().open(db, {
      clientId: retail.id,
      currency: 'USD',
      creditLimit: '0.0000',
      overdraftAllowed: false,
    });
    const file = (await download(retail.id, { 'sec-fetch-site': 'same-origin' })).json();
    expect(file).not.toHaveProperty('merchant');
    expect(file.wallet).toMatchObject({ entries: [] });
  });

  it('includes the guest row of a proven email in its own section: its orders, checkouts, consents, tickets and files', async () => {
    const { customer } = await buyer({ proven: true });
    const { guest, order, ticket, file: upload } = await guestOf(customer);
    const res = await download(customer.id, { 'sec-fetch-site': 'same-origin' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    const section = body.ordersPlacedAsGuest;
    expect(section.email).toBe(customer.email);
    expect(section.orders.map((row: { id: number }) => row.id)).toEqual([order.orderId]);
    expect(section.checkoutSessions).toHaveLength(1);
    expect(section.consents.map((row: { purpose: string }) => row.purpose)).toEqual(['terms']);
    expect(section.supportTickets.map((row: { subject: string }) => row.subject)).toEqual([ticket.subject]);
    expect(section.files.map((row: { id: number }) => row.id)).toEqual([upload.id]);
    // The account's own orders stay in the main section, and the guest row's do not leak into it.
    expect(body.orders.map((row: { id: number }) => row.id)).not.toContain(order.orderId);
    expect(guest.id).not.toBe(customer.id);
    // The file never says where an upload is stored.
    expect(res.body).not.toContain('files/');
  });

  it('leaves the guest row out when the email is not proven, and for a merchant rank', async () => {
    const unproven = await buyer({ name: 'Unproven One' });
    await guestOf(unproven.customer);
    const res = await download(unproven.customer.id, { 'sec-fetch-site': 'same-origin' });
    expect(res.json()).not.toHaveProperty('ordersPlacedAsGuest');
    const merchant = await makeAccount(t, { rank: 'merchant', emailVerifiedAt: PROVEN });
    await makeCustomer(t, { guest: true, email: merchant.email });
    const merchantRes = await download(merchant.id, { 'sec-fetch-site': 'same-origin' });
    expect(merchantRes.json()).not.toHaveProperty('ordersPlacedAsGuest');
  });

  it('leaves out a ticket whose address is not confirmed, and lists it once the address is confirmed (decision 053)', async () => {
    const { customer, db } = await buyer();
    await insertSupportTicket(db, { requesterId: customer.id, number: 'T-2001', subject: 'Confirmed one' });
    const typed = await insertSupportTicket(db, {
      requesterId: customer.id,
      number: 'T-2002',
      subject: 'Typed on the form',
      requesterProvenAt: null,
    });
    await insertSupportMessage(db, typed.id, {
      authorType: 'account',
      authorId: customer.id,
      body: 'Words typed by somebody.',
    });
    const read = async () => {
      const res = await download(customer.id, { 'sec-fetch-site': 'same-origin' });
      expect(res.statusCode).toBe(200);
      return {
        subjects: res.json().supportTickets.map((ticket: { subject: string }) => ticket.subject),
        text: res.body,
      };
    };
    const before = await read();
    expect(before.subjects).toEqual(['Confirmed one']);
    expect(before.text).not.toContain('Words typed by somebody.');
    await db.update(s.supportTickets).set({ requesterProvenAt: clock.now() }).where(eq(s.supportTickets.id, typed.id));
    const after = await read();
    expect(after.subjects).toEqual(['Confirmed one', 'Typed on the form']);
    expect(after.text).toContain('Words typed by somebody.');
  });

  it('leaves out what staff keep to protect the shop: the notes, the reason of a suspension and the blocklist entries', async () => {
    const { customer, db } = await buyer({ fingerprint: 'fp_secret_card' });
    // The account is blocked: the block writes a note and blocklist entries linked to the account, and a reason is set.
    expect(
      (await staff.post(`/admin/clients/${customer.id}/block`, { blocked: true, reason: 'Chargeback or dispute' }))
        .status,
    ).toBe(204);
    await db
      .update(s.clients)
      .set({ suspendedReason: 'Account may be compromised' })
      .where(eq(s.clients.id, customer.id));
    const before = await customerRow(customer.id);
    expect(before).toMatchObject({ suspendedReason: 'Account may be compromised' });
    expect(before.internalNotes).toContain('Likes email.');
    const res = await download(customer.id, { 'sec-fetch-site': 'same-origin' });
    expect(res.statusCode).toBe(200);
    const file = res.json();
    // What the account gave and did stays.
    expect(file.profile).toMatchObject({
      id: customer.id,
      email: customer.email,
      name: 'Daniel Whitmore',
      phone: '+441234',
    });
    expect(file.orders).toHaveLength(1);
    // What staff think of it goes.
    for (const key of ['internalNotes', 'suspendedReason']) expect(file.profile, key).not.toHaveProperty(key);
    expect(Object.keys(file)).not.toContain('blocklist');
    for (const text of [
      'Likes email.',
      'Chargeback or dispute',
      'Account may be compromised',
      'riskLevel',
      'blocklist',
    ]) {
      expect(res.body, text).not.toContain(text);
    }
  });

  it('closes the account’s open export request, completed by the caller, and audits it', async () => {
    const customer = await makeCustomer(t, { name: 'Omar Haddad' });
    const { db } = world;
    const [open] = await db
      .insert(s.dataRequests)
      .values({
        accountId: customer.id,
        kind: 'export',
        status: 'in_progress',
        dueAt: new Date('2026-12-08T09:00:00.000Z'),
      })
      .returning();
    const [erasure] = await db
      .insert(s.dataRequests)
      .values({ accountId: customer.id, kind: 'erasure', dueAt: new Date('2026-12-08T09:00:00.000Z') })
      .returning();
    expect((await download(customer.id, { 'sec-fetch-site': 'same-origin' })).statusCode).toBe(200);
    const rows = await db.select().from(s.dataRequests).orderBy(s.dataRequests.id);
    expect(rows.find((row) => row.id === open!.id)).toMatchObject({ status: 'completed', handledBy: staff.staffId });
    expect(rows.find((row) => row.id === open!.id)!.completedAt?.toISOString()).toBe('2026-11-08T09:00:00.000Z');
    expect(rows.find((row) => row.id === erasure!.id)!.status).toBe('open');
    expect((await auditOfCustomer(db, customer.id))[0]).toMatchObject({
      action: 'exported data of',
      entityType: 'account',
      entityLabel: 'Omar Haddad',
      after: { request: 'exported' },
    });
    // With no request waiting, the export still runs and is audited.
    expect((await download(customer.id, { 'sec-fetch-site': 'same-origin' })).statusCode).toBe(200);
    expect(await auditOfCustomer(db, customer.id)).toHaveLength(2);
  });

  it('works for an anonymized account', async () => {
    const customer = await makeCustomer(t, {
      status: 'anonymized',
      anonymizedAt: clock.now(),
      name: 'Deleted account',
    });
    const res = await download(customer.id, { 'sec-fetch-site': 'same-origin' });
    expect(res.statusCode).toBe(200);
    expect(res.json().profile).toMatchObject({ status: 'anonymized', name: 'Deleted account' });
  });

  it('only answers a request started by the console itself (decision 045): Sec-Fetch-Site same-origin or a console Origin', async () => {
    const customer = await makeCustomer(t);
    const refused = async (headers: Record<string, string>) => {
      const res = await download(customer.id, headers);
      expect(res.statusCode).toBe(403);
      expect(res.json().code).toBe('CSRF_FAILED');
    };
    await refused({});
    await refused({ 'sec-fetch-site': 'cross-site' });
    await refused({ 'sec-fetch-site': 'none' });
    // Every host of the registrable domain is same-site: that alone no longer starts an export.
    await refused({ 'sec-fetch-site': 'same-site' });
    await refused({ origin: 'https://evil.example' });
    // The shop's origin is not the console's.
    await refused({ origin: STORE_ORIGIN });
    expect((await download(customer.id, { 'sec-fetch-site': 'same-origin' })).statusCode).toBe(200);
    // A client without Sec-Fetch-Site (old browser, a script) must send the console's Origin.
    expect((await download(customer.id, { origin: CONSOLE_ORIGIN })).statusCode).toBe(200);
    expect((await download(customer.id, { 'sec-fetch-site': 'same-site', origin: CONSOLE_ORIGIN })).statusCode).toBe(
      200,
    );
    expect((await download(customer.id, { 'sec-fetch-site': 'cross-site', origin: CONSOLE_ORIGIN })).statusCode).toBe(
      200,
    );
    // Nothing was audited by the refused attempts.
    expect(await auditOfCustomer((await testDb()).db, customer.id)).toHaveLength(4);
  });

  it('answers 404 for an unknown account, 401 without a session, and needs customers:privacy', async () => {
    expect((await download(999999, { 'sec-fetch-site': 'same-origin' })).statusCode).toBe(404);
    const customer = await makeCustomer(t);
    const anonymous = await t.app.inject({
      method: 'GET',
      url: `/admin/clients/${customer.id}/export`,
      headers: { 'sec-fetch-site': 'same-origin' },
    });
    expect(anonymous.statusCode).toBe(401);
    const other = await adminWith(t, ['clients:read']);
    const res = await t.app.inject({
      method: 'GET',
      url: `/admin/clients/${customer.id}/export`,
      headers: { ...other.session.headers, 'sec-fetch-site': 'same-origin' },
    });
    expect(res.statusCode).toBe(403);
  });
});

describe('POST /admin/clients/:id/anonymize', () => {
  it('anonymizes the account and closes it: name, email, phone, notes, marketing, password, sessions and links', async () => {
    const { customer, store, db } = await buyer();
    // A password link that is still open.
    await db.insert(s.authTokens).values({
      purpose: 'reset',
      subjectType: 'account',
      subjectId: customer.id,
      tokenHash: crypto.randomUUID(),
      expiresAt: new Date('2026-11-08T10:00:00.000Z'),
    });
    const res = await staff.post(`/admin/clients/${customer.id}/anonymize`);
    expect(res.status).toBe(204);
    expect(await customerRow(customer.id)).toMatchObject({
      status: 'anonymized',
      name: 'Deleted account',
      email: `deleted-account-${customer.id}@redacted.invalid`,
      emailVerifiedAt: null,
      phone: '',
      internalNotes: '',
      marketingOptIn: false,
      hasAccount: false,
      passwordHash: null,
      totpSecretEnc: null,
      twofaEnabled: false,
    });
    expect((await customerRow(customer.id)).anonymizedAt?.toISOString()).toBe('2026-11-08T09:00:00.000Z');
    expect((await store.me()).statusCode).toBe(401);
    expect((await new StoreClient(t).login(customer.email)).statusCode).toBeGreaterThanOrEqual(400);
    const tokens = await db
      .select()
      .from(s.authTokens)
      .where(and(eq(s.authTokens.subjectType, 'account'), eq(s.authTokens.subjectId, customer.id)));
    expect(tokens.length).toBeGreaterThan(0);
    expect(tokens.every((token) => token.usedAt !== null)).toBe(true);
  });

  it('writes the new address pattern and succeeds while an older row holds the old pattern with the same number', async () => {
    const { customer } = await buyer();
    // A former customer anonymized before decision 064 under this very number kept the old address.
    await makeAccount({
      rank: 'retail',
      guest: true,
      email: `deleted-${customer.id}@redacted.invalid`,
      status: 'anonymized',
      anonymizedAt: new Date('2026-09-01T00:00:00.000Z'),
    });
    expect((await staff.post(`/admin/clients/${customer.id}/anonymize`)).status).toBe(204);
    expect((await customerRow(customer.id)).email).toBe(`deleted-account-${customer.id}@redacted.invalid`);
  });

  it('erases an account that held a merchant rank: after the rank change to retail, its Dhru username goes with the login', async () => {
    const { db } = world;
    const owner = await adminWith(t, ['*'], { name: 'Owner One' });
    const retailId = await ensureRetailGroup(db);
    const merchant = await makeAccount(t, { rank: 'merchant' });
    expect(merchant.row.username).not.toBeNull();
    const moved = await owner.post(
      `/admin/clients/${merchant.id}/rank`,
      { groupId: retailId },
      { 'idempotency-key': `k-${crypto.randomUUID()}` },
    );
    expect(moved.status, JSON.stringify(moved.body)).toBe(200);
    // The rank change keeps the username: the erasure is what removes it.
    expect((await accountRow(merchant.id)).username).toBe(merchant.row.username);
    const res = await staff.post(`/admin/clients/${merchant.id}/anonymize`);
    expect(res.status, JSON.stringify(res.body)).toBe(204);
    expect(await accountRow(merchant.id)).toMatchObject({
      status: 'anonymized',
      hasAccount: false,
      username: null,
      passwordHash: null,
      email: `deleted-account-${merchant.id}@redacted.invalid`,
    });
  });

  it('refuses a merchant rank with 409 and the words of the rank change, and changes nothing', async () => {
    const merchant = await makeAccount(t, { rank: 'merchant', internalNotes: 'Keep.' });
    const before = await accountRow(merchant.id);
    const res = await staff.post(`/admin/clients/${merchant.id}/anonymize`);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('CONFLICT');
    expect(res.body.detail).toBe('Move the account to the retail rank first.');
    expect(await accountRow(merchant.id)).toEqual(before);
    expect(await auditOfCustomer((await testDb()).db, merchant.id)).toEqual([]);
  });

  it('cuts every stored IMEI to the TAC, on the orders and the checkout sessions, and keeps payments and amounts', async () => {
    const { customer, order, db } = await buyer({ fingerprint: 'fp_card_1' });
    await db
      .update(s.orders)
      .set({ inputs: { imei: IMEI_ORDER, note: 'keep me' } })
      .where(eq(s.orders.id, order.orderId));
    await db.update(s.checkoutSessions).set({ ipCountry: 'DE' }).where(eq(s.checkoutSessions.id, order.sessionId));
    const ledgerBefore = await db.select().from(s.ledgerEntries);
    await staff.post(`/admin/clients/${customer.id}/anonymize`);
    const [stored] = await db.select().from(s.orders).where(eq(s.orders.id, order.orderId));
    expect(stored).toMatchObject({
      imei: '35389011•••••••',
      totalPrice: '12.4900',
      taxAmount: '2.5000',
      status: 'pending',
    });
    expect(stored!.inputs).toEqual({ imei: '35389011•••••••', note: 'keep me' });
    const [session] = await db.select().from(s.checkoutSessions).where(eq(s.checkoutSessions.id, order.sessionId));
    expect(session).toMatchObject({
      imeiEnc: null,
      email: `deleted-account-${customer.id}@redacted.invalid`,
      ip: null,
      // The visitor's country is read from the address, so it goes with it (decision 050).
      ipCountry: null,
      userAgent: '',
      grossAmount: '14.9900',
      currency: 'USD',
    });
    // Payments, ledger entries and amounts stay for accounting.
    const [payment] = await db.select().from(s.payments).where(eq(s.payments.accountId, customer.id));
    expect(payment).toMatchObject({ amount: '14.9900', status: 'captured', cardFingerprint: 'fp_card_1' });
    expect(await db.select().from(s.ledgerEntries)).toEqual(ledgerBefore);
  });

  it('erases an order main input that is not an IMEI', async () => {
    const { customer, order, db } = await buyer();
    await db.update(s.orders).set({ imei: 'SN-ABC123' }).where(eq(s.orders.id, order.orderId));
    await staff.post(`/admin/clients/${customer.id}/anonymize`);
    expect((await db.select().from(s.orders).where(eq(s.orders.id, order.orderId)))[0]!.imei).toBeNull();
  });

  it('completes the erasure request and leaves an export request alone, with the staff member as the handler', async () => {
    const { customer, db } = await buyer();
    const due = new Date('2026-12-08T09:00:00.000Z');
    await db.insert(s.dataRequests).values([
      { accountId: customer.id, kind: 'erasure', dueAt: due },
      { accountId: customer.id, kind: 'erasure', status: 'in_progress', dueAt: due },
      { accountId: customer.id, kind: 'erasure', status: 'rejected', dueAt: due },
      { accountId: customer.id, kind: 'export', dueAt: due },
    ]);
    await staff.post(`/admin/clients/${customer.id}/anonymize`);
    const rows = await db.select().from(s.dataRequests).orderBy(s.dataRequests.id);
    expect(rows.map((row) => row.status)).toEqual(['completed', 'completed', 'rejected', 'open']);
    expect(rows[0]).toMatchObject({ handledBy: staff.staffId });
    expect(rows[0]!.completedAt?.toISOString()).toBe('2026-11-08T09:00:00.000Z');
    expect(rows[2]!.handledBy).toBeNull();
  });

  it('audits by number, never by the old name, and the old name is nowhere in the audit rows it writes', async () => {
    const { customer, db } = await buyer({ name: 'Daniel Whitmore' });
    await staff.post(`/admin/clients/${customer.id}/anonymize`);
    const [audit] = await auditOfCustomer(db, customer.id);
    expect(audit).toMatchObject({
      action: 'anonymised account',
      entityType: 'account',
      entityLabel: `account ${customer.id}`,
      before: { status: 'active' },
      after: { status: 'anonymized', name: 'Deleted account', imei: 'removed (TAC kept)' },
    });
    expect(JSON.stringify(audit)).not.toContain('Whitmore');
  });

  it('runs the erasure hooks of other modules in the same transaction, and rolls everything back when one fails', async () => {
    const { customer, db } = await buyer();
    hookFailsFor = customer.id;
    expect((await staff.post(`/admin/clients/${customer.id}/anonymize`)).status).toBe(500);
    expect(await customerRow(customer.id)).toMatchObject({ status: 'active', name: 'Daniel Whitmore' });
    expect((await customerRow(customer.id)).passwordHash).not.toBeNull();
    expect((await db.select().from(s.orders).where(eq(s.orders.accountId, customer.id)))[0]!.imei).toBe(IMEI_ORDER);
    expect(await auditOfCustomer(db, customer.id)).toEqual([]);
    // The retry runs the hook again and succeeds.
    hookFailsFor = undefined;
    expect((await staff.post(`/admin/clients/${customer.id}/anonymize`)).status).toBe(204);
    expect(hookCalls).toEqual([customer.id, customer.id]);
  });

  it('clears the ticket page links of the account (the support module registers the hook): the old token answers 404, other tickets keep theirs', async () => {
    const { customer, db } = await buyer();
    const bystander = await buyer({ name: 'Bystander One' });
    const mine = await insertSupportTicket(db, { requesterId: customer.id });
    const others = await insertSupportTicket(db, { requesterId: bystander.customer.id });
    const read = (token: string) =>
      t.app.inject({ method: 'GET', url: `/store/v1/tickets/${token}`, remoteAddress: freshClientIp() });
    expect((await read(mine.token!)).statusCode).toBe(200);
    expect((await staff.post(`/admin/clients/${customer.id}/anonymize`)).status).toBe(204);
    expect((await read(mine.token!)).statusCode).toBe(404);
    const tickets = await db.select().from(s.supportTickets).orderBy(s.supportTickets.id);
    // The thread stays for the books; only the link goes, and the inbox order does not move.
    expect(tickets.find((ticket) => ticket.id === mine.id)).toMatchObject({
      token: null,
      // Decision 054: every stored form of the link goes.
      tokenHash: null,
      tokenEnc: null,
      subject: mine.subject,
      updatedAt: mine.updatedAt,
    });
    expect(tickets.find((ticket) => ticket.id === others.id)!.token).toBe(others.token);
    expect((await read(others.token!)).statusCode).toBe(200);
  });

  it('covers a ticket whose address was never confirmed as it covers the others: its link goes and its attachments are deleted (decision 053)', async () => {
    const { customer, db } = await buyer();
    const proven = await insertSupportTicket(db, { requesterId: customer.id });
    const typed = await insertSupportTicket(db, { requesterId: customer.id, requesterProvenAt: null });
    const provenFile = await insertFileRow(db, 'account', customer.id);
    const typedFile = await insertFileRow(db, 'account', customer.id);
    await insertSupportMessage(db, proven.id, {
      authorType: 'account',
      authorId: customer.id,
      fileIds: [provenFile.id],
    });
    await insertSupportMessage(db, typed.id, { authorType: 'account', authorId: customer.id, fileIds: [typedFile.id] });
    const read = (token: string) =>
      t.app.inject({ method: 'GET', url: `/store/v1/tickets/${token}`, remoteAddress: freshClientIp() });
    // The link of the typed-address ticket opens the thread (and so confirms the address): take the ticket back to unconfirmed to prove
    // that the anonymization reaches it in that state.
    expect((await read(typed.token!)).statusCode).toBe(200);
    await db.update(s.supportTickets).set({ requesterProvenAt: null }).where(eq(s.supportTickets.id, typed.id));
    expect((await staff.post(`/admin/clients/${customer.id}/anonymize`)).status).toBe(204);
    const tickets = await db.select().from(s.supportTickets).orderBy(s.supportTickets.id);
    for (const ticket of [proven, typed]) {
      expect(
        tickets.find((row) => row.id === ticket.id),
        String(ticket.id),
      ).toMatchObject({ token: null, tokenHash: null, tokenEnc: null });
    }
    expect(tickets.find((row) => row.id === typed.id)!.requesterProvenAt).toBeNull();
    expect((await read(typed.token!)).statusCode).toBe(404);
    expect(
      await db
        .select()
        .from(s.files)
        .where(inArray(s.files.id, [provenFile.id, typedFile.id])),
    ).toEqual([]);
    const messages = await db
      .select()
      .from(s.ticketMessages)
      .where(inArray(s.ticketMessages.ticketId, [proven.id, typed.id]));
    expect(messages.length).toBeGreaterThanOrEqual(2);
    expect(messages.every((message) => message.fileIds.length === 0)).toBe(true);
  });

  it('refuses: 409 ANONYMIZED the second time, 404, 401, 403 and a missing CSRF token; another account is untouched', async () => {
    const { customer } = await buyer();
    const bystander = await buyer({ name: 'Bystander One' });
    expect((await staff.post(`/admin/clients/${customer.id}/anonymize`)).status).toBe(204);
    const again = await staff.post(`/admin/clients/${customer.id}/anonymize`);
    expect(again.status).toBe(409);
    expect(again.body.code).toBe('ANONYMIZED');
    expect((await staff.post('/admin/clients/999999/anonymize')).status).toBe(404);
    expect((await staff.anonymous('POST', `/admin/clients/${bystander.customer.id}/anonymize`)).status).toBe(401);
    const other = await adminWith(t, ['clients:block']);
    expect((await other.post(`/admin/clients/${bystander.customer.id}/anonymize`)).status).toBe(403);
    expect((await staff.withoutCsrf('POST', `/admin/clients/${bystander.customer.id}/anonymize`)).status).toBe(403);
    expect(await customerRow(bystander.customer.id)).toMatchObject({ status: 'active', name: 'Bystander One' });
    expect((await bystander.store.me()).statusCode).toBe(200);
  });

  it('erases the guest row of a proven email in the same transaction, with the same steps', async () => {
    const { customer } = await buyer({ proven: true });
    const { guest, order, db } = await guestOf(customer);
    const bystander = await buyer({ name: 'Bystander One' });
    expect((await staff.post(`/admin/clients/${customer.id}/anonymize`)).status).toBe(204);
    // The account and the guest row are both anonymized, each with its own address; the guest row keeps its id.
    expect(await customerRow(customer.id)).toMatchObject({
      status: 'anonymized',
      email: `deleted-account-${customer.id}@redacted.invalid`,
    });
    expect(await customerRow(guest.id)).toMatchObject({
      id: guest.id,
      status: 'anonymized',
      name: 'Deleted account',
      email: `deleted-account-${guest.id}@redacted.invalid`,
      hasAccount: false,
    });
    // The guest row's order loses its device number and keeps its amounts; its hooks ran, and each row has its audit entry.
    const [stored] = await db.select().from(s.orders).where(eq(s.orders.id, order.orderId));
    expect(stored).toMatchObject({ imei: '35209900•••••••', totalPrice: '12.4900' });
    expect(hookCalls).toEqual([customer.id, guest.id]);
    expect((await auditOfCustomer(db, customer.id))[0]).toMatchObject({ action: 'anonymised account' });
    expect((await auditOfCustomer(db, guest.id))[0]).toMatchObject({
      action: 'anonymised account',
      entityLabel: `account ${guest.id}`,
      after: { erasedWith: customer.id },
    });
    // Another person's rows are untouched.
    expect(await customerRow(bystander.customer.id)).toMatchObject({ status: 'active' });
  });

  it('rolls both rows back when a hook fails on the guest row', async () => {
    const { customer } = await buyer({ proven: true });
    const { guest, order, db } = await guestOf(customer);
    hookFailsFor = guest.id;
    expect((await staff.post(`/admin/clients/${customer.id}/anonymize`)).status).toBe(500);
    expect(await customerRow(customer.id)).toMatchObject({ status: 'active', name: 'Daniel Whitmore' });
    expect(await customerRow(guest.id)).toMatchObject({ status: 'active', name: 'Dan W.' });
    expect((await db.select().from(s.orders).where(eq(s.orders.id, order.orderId)))[0]!.imei).toBe('352099001761481');
    expect(await auditOfCustomer(db, customer.id)).toEqual([]);
    expect(await auditOfCustomer(db, guest.id)).toEqual([]);
  });

  it('refuses the whole erasure with 409 and its reason while the guest row has an open checkout or a pending payment', async () => {
    const { customer, db } = await buyer({ proven: true });
    const { guest, order } = await guestOf(customer);
    await db.update(s.payments).set({ status: 'pending' }).where(eq(s.payments.id, order.paymentId));
    const pending = await staff.post(`/admin/clients/${customer.id}/anonymize`);
    expect(pending.status).toBe(409);
    expect(pending.body.code).toBe('CONFLICT');
    expect(pending.body.detail).toContain('payment still pending');
    await db.update(s.payments).set({ status: 'captured' }).where(eq(s.payments.id, order.paymentId));

    await db.insert(s.checkoutSessions).values({
      token: crypto.randomUUID(),
      accountId: guest.id,
      email: guest.email,
      serviceId: world.auto.serviceId,
      currency: 'USD',
      netAmount: '12.4900',
      taxAmount: '2.5000',
      grossAmount: '14.9900',
      taxCountry: 'GB',
      status: 'open',
      expiresAt: new Date('2099-01-01T00:00:00.000Z'),
    });
    const open = await staff.post(`/admin/clients/${customer.id}/anonymize`);
    expect(open.status).toBe(409);
    expect(open.body.detail).toContain('open checkout');
    // Nothing was written: both rows are as they were, and no hook ran.
    expect(await customerRow(customer.id)).toMatchObject({ status: 'active', name: 'Daniel Whitmore' });
    expect(await customerRow(guest.id)).toMatchObject({ status: 'active', name: 'Dan W.' });
    expect(hookCalls).toEqual([]);
  });

  it('leaves the guest row alone when the email is not proven', async () => {
    const { customer } = await buyer({ name: 'Unproven One' });
    const { guest, order, db } = await guestOf(customer);
    expect((await staff.post(`/admin/clients/${customer.id}/anonymize`)).status).toBe(204);
    expect(await customerRow(guest.id)).toMatchObject({ status: 'active', name: 'Dan W.', email: customer.email });
    expect((await db.select().from(s.orders).where(eq(s.orders.id, order.orderId)))[0]!.imei).toBe('352099001761481');
    expect(hookCalls).toEqual([customer.id]);
  });
});

describe('the blocklist check of the staff create of an account (AccountCreateGuards)', () => {
  it('refuses a blocked email with 422 on email, for a retail and for a merchant rank, and creates nothing', async () => {
    const { db } = world;
    await insertStoreCurrencies(db);
    await insertTaxRates(db, ['GB']);
    const owner = await adminWith(t, ['*']);
    const merchantGroupId = await ensureMerchantGroup(db);
    // A create without a rank takes the retail rank, which the reset removed.
    await ensureRetailGroup(db);
    await insertBlock(t, db, 'email', 'blocked.person@example.com');
    const before = (await db.select({ id: s.clients.id }).from(s.clients)).length;
    for (const extra of [{}, { groupId: merchantGroupId }]) {
      const res = await owner.post('/admin/clients', {
        name: 'Blocked Person',
        email: 'Blocked.Person@Example.com',
        country: 'GB',
        password: { mode: 'reset_link' },
        ...extra,
      });
      expect(res.status, JSON.stringify(extra)).toBe(422);
      expect(res.body.errors).toEqual([expect.objectContaining({ field: 'email', code: 'blocked' })]);
    }
    expect((await db.select({ id: s.clients.id }).from(s.clients)).length).toBe(before);
    // An address that is not blocked is created.
    const fine = await owner.post('/admin/clients', {
      name: 'Fine Person',
      email: 'fine.person@example.com',
      country: 'GB',
      password: { mode: 'reset_link' },
    });
    expect(fine.status).toBe(201);
  });
});

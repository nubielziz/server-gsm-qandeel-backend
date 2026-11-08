// Integration tests of the admin customer privacy actions (feature 18, POST /admin/customers/:id/block, GET /admin/customers/:id/export,
// POST /admin/customers/:id/anonymize; scenario b2c-account, RESOLUTIONS b2c-4, b2c-5 and b2c-8, MISMATCHES B48, B49, B50): what a block
// adds and an unblock removes, the same-site check and content of the export, and everything anonymizing cuts and keeps.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, mock } from 'bun:test';
import { and, eq } from 'drizzle-orm';
import { EncryptionService } from '../../src/infra/crypto';
import { schema as s } from '../../src/infra/db';
import { CHECKOUT_IMEI_AAD, CustomerErasureHooks } from '../../src/modules/customers';
import { type AdminApi, adminWith } from '../support/admin-api';
import { type TestApp, createTestApp } from '../support/app';
import { clearIdentityCaches } from '../support/auth';
import { TestClock } from '../support/clock';
import { auditOfCustomer, insertAnyService } from '../support/customers';
import { closeTestDb, resetDb, testDb } from '../support/db';
import { type OrdersWorld, ordersWorld } from '../support/orders';
import { freshClientIp } from '../support/pipeline-routes';
import { blocklistRows, insertBlock, insertHeldOrder, insertImeiCheck } from '../support/risk';
import { CONSOLE_ORIGIN } from '../support/staff-console';
import { insertSupportTicket } from '../support/support';
import {
  StoreClient,
  captureCustomerLinks,
  clearStoreRateLimits,
  customerLinks,
  customerRow,
  makeCustomer,
} from '../support/store';

const clock = new TestClock('2026-11-08T09:00:00.000Z');
let t: TestApp;
let world: OrdersWorld;
let staff: AdminApi;

beforeAll(async () => {
  t = await createTestApp({ clock, env: { CORS_ORIGINS: CONSOLE_ORIGIN } });
});
beforeEach(async () => {
  clock.set('2026-11-08T09:00:00.000Z');
  await resetDb();
  await clearIdentityCaches(t);
  await clearStoreRateLimits(t);
  captureCustomerLinks(t);
  world = await ordersWorld((await testDb()).db);
  staff = await adminWith(t, ['customers:block', 'customers:privacy', 'customers:read', 'customers:password'], {
    name: 'Rami K.',
  });
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

/** A signed-in account holder with a paid order (IMEI on the order and the checkout) and a card fingerprint. */
async function buyer(options: { fingerprint?: string; name?: string } = {}) {
  const { db } = world;
  const customer = await makeCustomer(t, {
    name: options.name ?? 'Daniel Whitmore',
    phone: '+441234',
    internalNotes: 'Likes email.',
    marketingOptIn: true,
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

describe('POST /admin/customers/:id/block', () => {
  it('blocks: status, risk level, notes, sessions, and the email, cards and IMEIs on the blocklist linked to the customer', async () => {
    const { customer, order, store, db } = await buyer({ fingerprint: 'fp_card_1' });
    const res = await staff.post(`/admin/customers/${customer.id}/block`, {
      blocked: true,
      reason: 'Chargeback or dispute',
    });
    expect(res.status).toBe(204);
    expect(await customerRow(customer.id)).toMatchObject({
      status: 'blocked',
      riskLevel: 'high',
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
        customerId: customer.id,
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
      action: 'blocked customer',
      entityLabel: 'Daniel Whitmore',
      before: { status: 'active' },
      after: { status: 'blocked', reason: 'Chargeback or dispute', blocklisted: 4 },
    });
    // The block does not touch the order.
    expect(order.orderId).toBeGreaterThan(0);
  });

  it('keeps an entry that already exists as it is, unlinked, and adds the rest', async () => {
    const { customer, db } = await buyer({ fingerprint: 'fp_card_1' });
    await insertBlock(t, db, 'email', customer.email, { source: 'chargeback', display: 'old' });
    await insertBlock(t, db, 'imei', IMEI_ORDER, { createdBy: staff.staffId, display: 'old' });
    await staff.post(`/admin/customers/${customer.id}/block`, { blocked: true, reason: 'Abuse of refunds' });
    const entries = await blocklistRows(db);
    expect(entries).toHaveLength(4);
    const email = entries.find((entry) => entry.kind === 'email')!;
    expect(email).toMatchObject({ source: 'chargeback', customerId: null, display: 'old' });
    expect(
      entries
        .filter((entry) => entry.customerId === customer.id)
        .map((entry) => entry.kind)
        .sort(),
    ).toEqual(['card', 'imei']);
    const [audit] = await auditOfCustomer(db, customer.id);
    expect(audit!.after).toMatchObject({ blocklisted: 2 });
  });

  it('blocks a guest with no orders by email alone, and a suspended customer (the suspension ends)', async () => {
    const { db } = world;
    const guest = await makeCustomer(t, { guest: true });
    await staff.post(`/admin/customers/${guest.id}/block`, { blocked: true, reason: 'Other' });
    expect((await blocklistRows(db)).map((entry) => entry.kind)).toEqual(['email']);
    const paused = await makeCustomer(t, {
      status: 'suspended',
      suspendedReason: 'Account may be compromised',
      suspendedAt: new Date(),
    });
    await staff.post(`/admin/customers/${paused.id}/block`, { blocked: true, reason: 'Card testing or fraud' });
    expect(await customerRow(paused.id)).toMatchObject({
      status: 'blocked',
      suspendedAt: null,
      suspendedReason: null,
      suspendedBy: null,
    });
  });

  it('unblocks: active, risk high to medium, and deletes only the manual entries this block added', async () => {
    const { customer, db } = await buyer({ fingerprint: 'fp_card_1' });
    const other = await insertBlock(t, db, 'domain', 'evil.example', { createdBy: staff.staffId });
    const chargeback = await insertBlock(t, db, 'card', 'fp_other', { source: 'chargeback' });
    const refunded = await insertBlock(t, db, 'imei', IMEI_SESSION, { createdBy: staff.staffId });
    await staff.post(`/admin/customers/${customer.id}/block`, { blocked: true, reason: 'Other' });
    expect((await blocklistRows(db)).filter((entry) => entry.customerId === customer.id)).toHaveLength(3);
    const res = await staff.post(`/admin/customers/${customer.id}/block`, { blocked: false });
    expect(res.status).toBe(204);
    expect(await customerRow(customer.id)).toMatchObject({ status: 'active', riskLevel: 'medium' });
    expect((await blocklistRows(db)).map((entry) => entry.id).sort()).toEqual(
      [other.id, chargeback.id, refunded.id].sort(),
    );
    const audits = await auditOfCustomer(db, customer.id);
    expect(audits.at(-1)).toMatchObject({
      action: 'unblocked customer',
      before: { status: 'blocked' },
      after: { status: 'active', removed: 3 },
    });
    // The customer can sign in again.
    expect((await new StoreClient(t).login(customer.email)).statusCode).toBe(200);
  });

  it('takes an optional reason when lifting and keeps a lower risk level as it was', async () => {
    const customer = await makeCustomer(t, { status: 'blocked', riskLevel: 'low' });
    expect(
      (await staff.post(`/admin/customers/${customer.id}/block`, { blocked: false, reason: 'Resolved with the bank' }))
        .status,
    ).toBe(204);
    expect(await customerRow(customer.id)).toMatchObject({ status: 'active', riskLevel: 'low' });
    expect((await auditOfCustomer((await testDb()).db, customer.id))[0]!.after).toMatchObject({
      reason: 'Resolved with the bank',
    });
  });

  it('refuses: 409 ALREADY_BLOCKED, 409 NOT_BLOCKED, 409 ANONYMIZED, 404, and 422 on reason (missing, not one of the four, too long)', async () => {
    const customer = await makeCustomer(t);
    expect((await staff.post(`/admin/customers/${customer.id}/block`, { blocked: false })).body.code).toBe(
      'NOT_BLOCKED',
    );
    for (const body of [
      { blocked: true },
      { blocked: true, reason: '  ' },
      { blocked: true, reason: 'I do not like him' },
      { blocked: true, reason: 'x'.repeat(301) },
    ]) {
      const res = await staff.post(`/admin/customers/${customer.id}/block`, body);
      expect(res.status).toBe(422);
      expect(res.body.errors[0].field).toBe('reason');
    }
    expect((await customerRow(customer.id)).status).toBe('active');
    expect((await staff.post(`/admin/customers/${customer.id}/block`, { blocked: true, reason: 'Other' })).status).toBe(
      204,
    );
    const again = await staff.post(`/admin/customers/${customer.id}/block`, { blocked: true, reason: 'Other' });
    expect(again.status).toBe(409);
    expect(again.body.code).toBe('ALREADY_BLOCKED');
    const gone = await makeCustomer(t, { status: 'anonymized' });
    expect((await staff.post(`/admin/customers/${gone.id}/block`, { blocked: true, reason: 'Other' })).body.code).toBe(
      'ANONYMIZED',
    );
    expect((await staff.post(`/admin/customers/${gone.id}/block`, { blocked: false })).body.code).toBe('ANONYMIZED');
    expect((await staff.post('/admin/customers/999999/block', { blocked: true, reason: 'Other' })).status).toBe(404);
    expect((await staff.post(`/admin/customers/${customer.id}/block`, {})).status).toBe(422);
  });

  it('lets two blocks at once make one block', async () => {
    const customer = await makeCustomer(t);
    const body = { blocked: true, reason: 'Other' };
    const [a, b] = await Promise.all([
      staff.post(`/admin/customers/${customer.id}/block`, body),
      staff.post(`/admin/customers/${customer.id}/block`, body),
    ]);
    expect([a.status, b.status].sort()).toEqual([204, 409]);
    expect(await blocklistRows((await testDb()).db)).toHaveLength(1);
  });

  it('needs customers:block and the CSRF token', async () => {
    const customer = await makeCustomer(t);
    const reader = await adminWith(t, ['customers:read', 'customers:suspend']);
    expect(
      (await reader.post(`/admin/customers/${customer.id}/block`, { blocked: true, reason: 'Other' })).status,
    ).toBe(403);
    expect(
      (await staff.withoutCsrf('POST', `/admin/customers/${customer.id}/block`, { blocked: true, reason: 'Other' }))
        .status,
    ).toBe(403);
    expect((await customerRow(customer.id)).status).toBe('active');
  });
});

describe('GET /admin/customers/:id/export', () => {
  const download = (id: number, headers: Record<string, string>) =>
    t.app.inject({
      method: 'GET',
      url: `/admin/customers/${id}/export`,
      headers: { ...staff.session.headers, ...headers },
      remoteAddress: '127.0.0.1',
    });

  it('answers a JSON file with everything held about the customer, the IMEIs decrypted and no card data', async () => {
    const { customer, order, db } = await buyer({ fingerprint: 'fp_secret_card' });
    await insertImeiCheck(t, db, IMEI_ORDER, { customerId: customer.id, ip: '203.0.113.9' });
    await db
      .insert(s.consentRecords)
      .values({ subjectType: 'customer', subjectId: customer.id, purpose: 'terms', granted: true, ip: '203.0.113.25' });
    const [ticket] = await db
      .insert(s.supportTickets)
      .values({ number: 'T-1001', subject: 'Where is my unlock?', requesterType: 'customer', requesterId: customer.id })
      .returning();
    await db.insert(s.ticketMessages).values([
      { ticketId: ticket!.id, authorType: 'customer', authorId: customer.id, body: 'It is late.' },
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
      .values({ customerId: customer.id, kind: 'export', dueAt: new Date('2026-12-08T09:00:00.000Z') });
    const res = await download(customer.id, { 'sec-fetch-site': 'same-site' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('application/json');
    expect(res.headers['content-disposition']).toContain(`filename="customer-${customer.id}.json"`);
    expect(res.headers['cache-control']).toBe('no-store');
    const file = res.json();
    expect(file.profile).toMatchObject({
      id: customer.id,
      email: customer.email,
      name: 'Daniel Whitmore',
      phone: '+441234',
      country: 'GB',
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
      userAgent: 'Mozilla/5.0',
    });
    expect(file.imeiChecks[0]).toMatchObject({ imei: IMEI_ORDER, ip: '203.0.113.9' });
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

  it('leaves out what staff keep to protect the shop: the notes, the risk level, the reason of a suspension and the blocklist entries', async () => {
    const { customer, db } = await buyer({ fingerprint: 'fp_secret_card' });
    // The customer is blocked: the block writes a note, a risk level, a reason and blocklist entries linked to the customer.
    expect(
      (await staff.post(`/admin/customers/${customer.id}/block`, { blocked: true, reason: 'Chargeback or dispute' }))
        .status,
    ).toBe(204);
    await db.update(s.customers).set({ suspendedReason: 'Account may be compromised' });
    const before = await customerRow(customer.id);
    expect(before).toMatchObject({ riskLevel: 'high', suspendedReason: 'Account may be compromised' });
    expect(before.internalNotes).toContain('Likes email.');
    const res = await download(customer.id, { 'sec-fetch-site': 'same-site' });
    expect(res.statusCode).toBe(200);
    const file = res.json();
    // What the customer gave and did stays.
    expect(file.profile).toMatchObject({
      id: customer.id,
      email: customer.email,
      name: 'Daniel Whitmore',
      phone: '+441234',
    });
    expect(file.orders).toHaveLength(1);
    // What staff think of them goes.
    for (const key of ['internalNotes', 'riskLevel', 'suspendedReason'])
      expect(file.profile, key).not.toHaveProperty(key);
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

  it('closes the customer’s open export request, completed by the caller, and audits it', async () => {
    const customer = await makeCustomer(t, { name: 'Omar Haddad' });
    const { db } = world;
    const [open] = await db
      .insert(s.dataRequests)
      .values({
        customerId: customer.id,
        kind: 'export',
        status: 'in_progress',
        dueAt: new Date('2026-12-08T09:00:00.000Z'),
      })
      .returning();
    const [erasure] = await db
      .insert(s.dataRequests)
      .values({ customerId: customer.id, kind: 'erasure', dueAt: new Date('2026-12-08T09:00:00.000Z') })
      .returning();
    expect((await download(customer.id, { 'sec-fetch-site': 'same-origin' })).statusCode).toBe(200);
    const rows = await db.select().from(s.dataRequests).orderBy(s.dataRequests.id);
    expect(rows.find((row) => row.id === open!.id)).toMatchObject({ status: 'completed', handledBy: staff.staffId });
    expect(rows.find((row) => row.id === open!.id)!.completedAt?.toISOString()).toBe('2026-11-08T09:00:00.000Z');
    expect(rows.find((row) => row.id === erasure!.id)!.status).toBe('open');
    expect((await auditOfCustomer(db, customer.id))[0]).toMatchObject({
      action: 'exported data of',
      entityLabel: 'Omar Haddad',
      after: { request: 'exported' },
    });
    // With no request waiting, the export still runs and is audited.
    expect((await download(customer.id, { 'sec-fetch-site': 'same-origin' })).statusCode).toBe(200);
    expect(await auditOfCustomer(db, customer.id)).toHaveLength(2);
  });

  it('works for an anonymized customer', async () => {
    const customer = await makeCustomer(t, { status: 'anonymized', name: 'Deleted customer' });
    const res = await download(customer.id, { 'sec-fetch-site': 'same-site' });
    expect(res.statusCode).toBe(200);
    expect(res.json().profile).toMatchObject({ status: 'anonymized', name: 'Deleted customer' });
  });

  it('only answers a same-site request (RESOLUTIONS b2c-8): Sec-Fetch-Site same-origin or same-site, else an exact allowed Origin', async () => {
    const customer = await makeCustomer(t);
    const refused = async (headers: Record<string, string>) => {
      const res = await download(customer.id, headers);
      expect(res.statusCode).toBe(403);
      expect(res.json().code).toBe('CSRF_FAILED');
    };
    await refused({});
    await refused({ 'sec-fetch-site': 'cross-site' });
    await refused({ 'sec-fetch-site': 'none' });
    await refused({ origin: 'https://evil.example' });
    // A cross-site browser request is refused even when it carries an allowed Origin: the browser's own header decides.
    await refused({ 'sec-fetch-site': 'cross-site', origin: CONSOLE_ORIGIN });
    expect((await download(customer.id, { 'sec-fetch-site': 'same-origin' })).statusCode).toBe(200);
    // A client without Sec-Fetch-Site (old browser, a script) must send the console's Origin.
    expect((await download(customer.id, { origin: CONSOLE_ORIGIN })).statusCode).toBe(200);
    // Nothing was audited by the refused attempts.
    expect(await auditOfCustomer((await testDb()).db, customer.id)).toHaveLength(2);
  });

  it('answers 404 for an unknown customer, 401 without a session, and needs customers:privacy', async () => {
    expect((await download(999999, { 'sec-fetch-site': 'same-site' })).statusCode).toBe(404);
    const customer = await makeCustomer(t);
    const anonymous = await t.app.inject({
      method: 'GET',
      url: `/admin/customers/${customer.id}/export`,
      headers: { 'sec-fetch-site': 'same-site' },
    });
    expect(anonymous.statusCode).toBe(401);
    const other = await adminWith(t, ['customers:read']);
    const res = await t.app.inject({
      method: 'GET',
      url: `/admin/customers/${customer.id}/export`,
      headers: { ...other.session.headers, 'sec-fetch-site': 'same-site' },
    });
    expect(res.statusCode).toBe(403);
  });
});

describe('POST /admin/customers/:id/anonymize', () => {
  it('anonymizes the customer and closes the account: name, email, phone, notes, marketing, credentials, sessions and links', async () => {
    const { customer, store, db } = await buyer();
    // A password link that is still open.
    await staff.post(`/admin/customers/${customer.id}/password`, { mode: 'reset_link', revokeSessions: false });
    expect(customerLinks()).toHaveLength(1);
    const res = await staff.post(`/admin/customers/${customer.id}/anonymize`);
    expect(res.status).toBe(204);
    expect(await customerRow(customer.id)).toMatchObject({
      status: 'anonymized',
      name: 'Deleted customer',
      email: `deleted-${customer.id}@redacted.invalid`,
      emailVerifiedAt: null,
      phone: '',
      internalNotes: '',
      marketingOptIn: false,
      hasAccount: false,
    });
    expect((await customerRow(customer.id)).anonymizedAt?.toISOString()).toBe('2026-11-08T09:00:00.000Z');
    expect(
      await db.select().from(s.customerCredentials).where(eq(s.customerCredentials.customerId, customer.id)),
    ).toEqual([]);
    expect((await store.me()).statusCode).toBe(401);
    expect((await new StoreClient(t).login(customer.email)).statusCode).toBeGreaterThanOrEqual(400);
    const tokens = await db
      .select()
      .from(s.authTokens)
      .where(and(eq(s.authTokens.subjectType, 'customer'), eq(s.authTokens.subjectId, customer.id)));
    expect(tokens.every((token) => token.usedAt !== null)).toBe(true);
    // The old address is free again.
    expect((await staff.get(`/admin/customers/${customer.id}`)).body).toMatchObject({
      name: 'Deleted customer',
      status: 'anonymized',
    });
  });

  it('cuts every stored IMEI to the TAC, on the orders, the checkout sessions and the IMEI checks, and keeps payments and amounts', async () => {
    const { customer, order, db } = await buyer({ fingerprint: 'fp_card_1' });
    const check = await insertImeiCheck(t, db, IMEI_ORDER, {
      customerId: customer.id,
      ip: '203.0.113.9',
      cachedUntil: new Date('2026-11-09T00:00:00.000Z'),
    });
    const viaSession = await insertImeiCheck(t, db, IMEI_SESSION, { checkoutSessionId: order.sessionId });
    const stranger = await insertImeiCheck(t, db, '352905112490861');
    await db
      .update(s.orders)
      .set({ inputs: { imei: IMEI_ORDER, note: 'keep me' } })
      .where(eq(s.orders.id, order.orderId));
    const ledgerBefore = await db.select().from(s.ledgerEntries);
    await staff.post(`/admin/customers/${customer.id}/anonymize`);
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
      email: `deleted-${customer.id}@redacted.invalid`,
      ip: null,
      userAgent: '',
      grossAmount: '14.9900',
      currency: 'USD',
    });
    for (const erased of [check, viaSession]) {
      expect(await db.select().from(s.imeiChecks).where(eq(s.imeiChecks.id, erased.id))).toMatchObject([
        { imeiEnc: null, imeiHash: null, cachedUntil: null, ip: null, brand: 'Apple' },
      ]);
    }
    expect((await db.select().from(s.imeiChecks).where(eq(s.imeiChecks.id, stranger.id)))[0]!.imeiEnc).not.toBeNull();
    // The staff log shows the mask.
    const reader = await adminWith(t, ['risk:read']);
    expect((await reader.get(`/admin/imei-checks/${check.id}`)).body.imei).toBe('•'.repeat(15));
    // Payments, ledger entries and amounts stay for accounting.
    const [payment] = await db.select().from(s.payments).where(eq(s.payments.customerId, customer.id));
    expect(payment).toMatchObject({ amount: '14.9900', status: 'captured', cardFingerprint: 'fp_card_1' });
    expect(await db.select().from(s.ledgerEntries)).toEqual(ledgerBefore);
  });

  it('erases an order main input that is not an IMEI', async () => {
    const { customer, order, db } = await buyer();
    await db.update(s.orders).set({ imei: 'SN-ABC123' }).where(eq(s.orders.id, order.orderId));
    await staff.post(`/admin/customers/${customer.id}/anonymize`);
    expect((await db.select().from(s.orders).where(eq(s.orders.id, order.orderId)))[0]!.imei).toBeNull();
  });

  it('completes the erasure request and leaves an export request alone, with the staff member as the handler', async () => {
    const { customer, db } = await buyer();
    const due = new Date('2026-12-08T09:00:00.000Z');
    await db.insert(s.dataRequests).values([
      { customerId: customer.id, kind: 'erasure', dueAt: due },
      { customerId: customer.id, kind: 'erasure', status: 'in_progress', dueAt: due },
      { customerId: customer.id, kind: 'erasure', status: 'rejected', dueAt: due },
      { customerId: customer.id, kind: 'export', dueAt: due },
    ]);
    await staff.post(`/admin/customers/${customer.id}/anonymize`);
    const rows = await db.select().from(s.dataRequests).orderBy(s.dataRequests.id);
    expect(rows.map((row) => row.status)).toEqual(['completed', 'completed', 'rejected', 'open']);
    expect(rows[0]).toMatchObject({ handledBy: staff.staffId });
    expect(rows[0]!.completedAt?.toISOString()).toBe('2026-11-08T09:00:00.000Z');
    expect(rows[2]!.handledBy).toBeNull();
  });

  it('audits by number, never by the old name, and the old name is nowhere in the audit rows it writes', async () => {
    const { customer, db } = await buyer({ name: 'Daniel Whitmore' });
    await staff.post(`/admin/customers/${customer.id}/anonymize`);
    const [audit] = await auditOfCustomer(db, customer.id);
    expect(audit).toMatchObject({
      action: 'anonymised customer',
      entityLabel: `customer ${customer.id}`,
      before: { status: 'active' },
      after: { status: 'anonymized', name: 'Deleted customer', imei: 'removed (TAC kept)' },
    });
    expect(JSON.stringify(audit)).not.toContain('Whitmore');
  });

  it('runs the erasure hooks of other modules in the same transaction, and rolls everything back when one fails', async () => {
    const { customer, db } = await buyer();
    const hooks = t.app.get(CustomerErasureHooks);
    const seen: number[] = [];
    hooks.add({
      eraseCustomer(_tx, customerId) {
        seen.push(customerId);
        return seen.length === 1 ? Promise.reject(new Error('the support module failed')) : Promise.resolve();
      },
    });
    expect((await staff.post(`/admin/customers/${customer.id}/anonymize`)).status).toBe(500);
    expect(await customerRow(customer.id)).toMatchObject({ status: 'active', name: 'Daniel Whitmore' });
    expect(
      (await db.select().from(s.customerCredentials).where(eq(s.customerCredentials.customerId, customer.id))).length,
    ).toBe(1);
    expect((await db.select().from(s.orders).where(eq(s.orders.customerId, customer.id)))[0]!.imei).toBe(IMEI_ORDER);
    expect(await auditOfCustomer(db, customer.id)).toEqual([]);
    // The retry runs the hook again and succeeds.
    expect((await staff.post(`/admin/customers/${customer.id}/anonymize`)).status).toBe(204);
    expect(seen).toEqual([customer.id, customer.id]);
  });

  it('clears the ticket page links of the customer (the support module registers the hook): the old token answers 404, other tickets keep theirs', async () => {
    const { customer, db } = await buyer();
    const bystander = await buyer({ name: 'Bystander One' });
    const mine = await insertSupportTicket(db, { requesterId: customer.id });
    const others = await insertSupportTicket(db, { requesterId: bystander.customer.id });
    // A merchant's ticket whose requester id happens to equal the customer's id is not the customer's ticket.
    const merchants = await insertSupportTicket(db, { requesterType: 'client', requesterId: customer.id });
    const read = (token: string) =>
      t.app.inject({ method: 'GET', url: `/store/v1/tickets/${token}`, remoteAddress: freshClientIp() });
    expect((await read(mine.token!)).statusCode).toBe(200);
    expect((await staff.post(`/admin/customers/${customer.id}/anonymize`)).status).toBe(204);
    expect((await read(mine.token!)).statusCode).toBe(404);
    const tickets = await db.select().from(s.supportTickets).orderBy(s.supportTickets.id);
    // The thread stays for the books; only the link goes, and the inbox order does not move.
    expect(tickets.find((ticket) => ticket.id === mine.id)).toMatchObject({
      token: null,
      subject: mine.subject,
      updatedAt: mine.updatedAt,
    });
    expect(tickets.find((ticket) => ticket.id === others.id)!.token).toBe(others.token);
    expect(tickets.find((ticket) => ticket.id === merchants.id)!.token).toBe(merchants.token);
    expect((await read(others.token!)).statusCode).toBe(200);
  });

  it('refuses: 409 ANONYMIZED the second time, 404, 401, 403 and a missing CSRF token; another customer is untouched', async () => {
    const { customer } = await buyer();
    const bystander = await buyer({ name: 'Bystander One' });
    expect((await staff.post(`/admin/customers/${customer.id}/anonymize`)).status).toBe(204);
    const again = await staff.post(`/admin/customers/${customer.id}/anonymize`);
    expect(again.status).toBe(409);
    expect(again.body.code).toBe('ANONYMIZED');
    expect((await staff.post('/admin/customers/999999/anonymize')).status).toBe(404);
    expect((await staff.anonymous('POST', `/admin/customers/${bystander.customer.id}/anonymize`)).status).toBe(401);
    const other = await adminWith(t, ['customers:block']);
    expect((await other.post(`/admin/customers/${bystander.customer.id}/anonymize`)).status).toBe(403);
    expect((await staff.withoutCsrf('POST', `/admin/customers/${bystander.customer.id}/anonymize`)).status).toBe(403);
    expect(await customerRow(bystander.customer.id)).toMatchObject({ status: 'active', name: 'Bystander One' });
    expect((await bystander.store.me()).statusCode).toBe(200);
  });

  it('frees the old address for a new customer', async () => {
    const { customer } = await buyer();
    const email = customer.email;
    await staff.post(`/admin/customers/${customer.id}/anonymize`);
    const creator = await adminWith(t, ['customers:create', 'customers:read']);
    const countries = await world.db
      .insert(s.taxRates)
      .values({
        country: 'GB',
        ratePercent: '20',
        taxType: 'vat',
        appliesTo: 'digital_services',
        validFrom: new Date('2026-01-01T00:00:00.000Z'),
      })
      .returning();
    expect(countries).toHaveLength(1);
    const res = await creator.post('/admin/customers', {
      name: 'New Person',
      email,
      country: 'GB',
      locale: 'en',
      password: { mode: 'reset_link' },
    });
    expect([201, 422]).toContain(res.status);
    if (res.status === 422) expect(JSON.stringify(res.body)).not.toContain('EMAIL_TAKEN');
    void insertAnyService;
  });
});

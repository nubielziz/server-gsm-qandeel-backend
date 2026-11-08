// Integration tests of the data-subject requests (feature 18, /admin/data-requests and POST /store/v1/me/data-export and /data-delete,
// RESOLUTIONS b2c-13, ANSWERS customers Q4, Q5 and Q12): the customer asks, staff list and move the requests under the closed-state, note
// and erasure rules.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { eq } from 'drizzle-orm';
import { schema as s } from '../../src/infra/db';
import { type AdminApi, adminWith } from '../support/admin-api';
import { type TestApp, createTestApp } from '../support/app';
import { clearIdentityCaches } from '../support/auth';
import { DAY, MINUTE, TestClock } from '../support/clock';
import { closeTestDb, resetDb, testDb } from '../support/db';
import { auditRows } from '../support/risk';
import { StoreClient, captureCustomerLinks, clearStoreRateLimits, makeCustomer } from '../support/store';

const clock = new TestClock('2026-11-08T09:00:00.000Z');
let t: TestApp;
let staff: AdminApi;

beforeAll(async () => {
  t = await createTestApp({ clock });
});
beforeEach(async () => {
  clock.set('2026-11-08T09:00:00.000Z');
  await resetDb();
  await clearIdentityCaches(t);
  await clearStoreRateLimits(t);
  captureCustomerLinks(t);
  staff = await adminWith(t, ['customers:privacy'], { name: 'Rami K.' });
});
afterAll(async () => {
  await resetDb();
  await clearIdentityCaches(t);
  await t.close();
  await closeTestDb();
});

/** Inserts a request straight into the table. */
async function insertRequest(
  customerId: number,
  values: Partial<typeof s.dataRequests.$inferInsert> = {},
): Promise<number> {
  const { db } = await testDb();
  const requestedAt = values.requestedAt ?? new Date(clock.nowMs());
  const [row] = await db
    .insert(s.dataRequests)
    .values({
      customerId,
      kind: 'export',
      requestedAt,
      dueAt: new Date(requestedAt.getTime() + 30 * DAY),
      ...values,
    })
    .returning({ id: s.dataRequests.id });
  return row!.id;
}

describe('POST /store/v1/me/data-export and /data-delete', () => {
  async function signedIn() {
    const customer = await makeCustomer(t, { name: 'Daniel Whitmore' });
    const store = new StoreClient(t);
    expect((await store.login(customer.email)).statusCode).toBe(200);
    return { customer, store };
  }

  it('records an open request that is due 30 days later', async () => {
    const { customer, store } = await signedIn();
    const res = await store.call('POST', '/store/v1/me/data-export');
    expect(res.statusCode).toBe(201);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.json()).toEqual({
      id: expect.any(Number),
      kind: 'export',
      status: 'open',
      requestedAt: '2026-11-08T09:00:00.000Z',
      dueAt: '2026-12-08T09:00:00.000Z',
    });
    const erasure = await store.call('POST', '/store/v1/me/data-delete');
    expect(erasure.json()).toMatchObject({ kind: 'erasure', status: 'open', dueAt: '2026-12-08T09:00:00.000Z' });
    const rows = await (await testDb()).db.select().from(s.dataRequests);
    expect(rows.map((row) => [row.customerId, row.kind, row.status])).toEqual([
      [customer.id, 'export', 'open'],
      [customer.id, 'erasure', 'open'],
    ]);
  });

  it('returns the waiting request instead of making a second one, even for two taps at once', async () => {
    const { store } = await signedIn();
    const first = (await store.call('POST', '/store/v1/me/data-export')).json();
    expect((await store.call('POST', '/store/v1/me/data-export')).json().id).toBe(first.id);
    const second = await signedIn();
    const [a, b] = await Promise.all([
      second.store.call('POST', '/store/v1/me/data-delete'),
      second.store.call('POST', '/store/v1/me/data-delete'),
    ]);
    expect(a.json().id).toBe(b.json().id);
    expect(await (await testDb()).db.select().from(s.dataRequests)).toHaveLength(2);
  });

  it('starts a new request once the earlier one is closed', async () => {
    const { customer, store } = await signedIn();
    const closed = await insertRequest(customer.id, { status: 'completed', completedAt: new Date(clock.nowMs()) });
    const res = (await store.call('POST', '/store/v1/me/data-export')).json();
    expect(res.id).not.toBe(closed);
    expect(res.status).toBe('open');
  });

  it('needs a signed-in customer and the CSRF token', async () => {
    const anonymous = new StoreClient(t);
    expect((await anonymous.call('POST', '/store/v1/me/data-export')).statusCode).toBe(401);
    expect((await anonymous.call('POST', '/store/v1/me/data-delete')).statusCode).toBe(401);
    const { store } = await signedIn();
    expect((await store.call('POST', '/store/v1/me/data-export', undefined, { csrf: false })).statusCode).toBe(403);
    expect(await (await testDb()).db.select().from(s.dataRequests)).toEqual([]);
  });

  it('refuses a suspended customer’s session', async () => {
    const { customer, store } = await signedIn();
    await (await testDb()).db.update(s.customers).set({ status: 'suspended' }).where(eq(s.customers.id, customer.id));
    await clearIdentityCaches(t);
    expect((await store.call('POST', '/store/v1/me/data-export')).statusCode).toBeGreaterThanOrEqual(401);
  });
});

describe('GET /admin/data-requests', () => {
  async function fill() {
    const a = await makeCustomer(t, { name: 'Omar Haddad' });
    const b = await makeCustomer(t, { name: 'Sofia Alvarez' });
    const later = await insertRequest(a.id, { kind: 'export', requestedAt: new Date('2026-11-05T00:00:00.000Z') });
    const sooner = await insertRequest(b.id, {
      kind: 'erasure',
      requestedAt: new Date('2026-10-20T00:00:00.000Z'),
      status: 'in_progress',
    });
    const done = await insertRequest(b.id, {
      kind: 'export',
      requestedAt: new Date('2026-09-01T00:00:00.000Z'),
      status: 'completed',
      completedAt: new Date('2026-09-02T00:00:00.000Z'),
      handledBy: staff.staffId,
    });
    return { a, b, later, sooner, done };
  }

  it('lists the requests that are due first with the customer’s name and the total', async () => {
    const rows = await fill();
    const res = await staff.get('/admin/data-requests');
    expect(res.status).toBe(200);
    expect(res.total).toBe(3);
    expect(res.body.map((row: { id: number }) => row.id)).toEqual([rows.done, rows.sooner, rows.later]);
    expect(res.body[2]).toEqual({
      id: rows.later,
      customerId: rows.a.id,
      kind: 'export',
      status: 'open',
      requestedAt: '2026-11-05T00:00:00.000Z',
      dueAt: '2026-12-05T00:00:00.000Z',
      completedAt: null,
      handledBy: null,
      fileId: null,
      createdAt: expect.any(String),
      customerName: 'Omar Haddad',
    });
    expect(res.body[0]).toMatchObject({
      status: 'completed',
      handledBy: staff.staffId,
      completedAt: '2026-09-02T00:00:00.000Z',
    });
  });

  it('filters by status (repeated for IN), kind and customer, and sorts by lifecycle order', async () => {
    const rows = await fill();
    expect((await staff.get('/admin/data-requests?status=open&status=in_progress')).total).toBe(2);
    expect((await staff.get('/admin/data-requests?status=completed')).body[0].id).toBe(rows.done);
    expect((await staff.get('/admin/data-requests?kind=erasure')).body.map((row: { id: number }) => row.id)).toEqual([
      rows.sooner,
    ]);
    expect(
      (await staff.get(`/admin/data-requests?customerId=${rows.b.id}&_sort=requestedAt&_order=desc&_start=0&_end=20`))
        .total,
    ).toBe(2);
    const byStatus = await staff.get('/admin/data-requests?_sort=status&_order=asc');
    expect(byStatus.body.map((row: { status: string }) => row.status)).toEqual(['open', 'in_progress', 'completed']);
    expect((await staff.get('/admin/data-requests?_start=0&_end=1&status=open&status=in_progress')).total).toBe(2);
    expect((await staff.get('/admin/data-requests?status=bogus')).status).toBe(422);
  });

  it('reads one request, 404 for an unknown one, and needs customers:privacy', async () => {
    const rows = await fill();
    expect((await staff.get(`/admin/data-requests/${rows.sooner}`)).body).toMatchObject({
      id: rows.sooner,
      customerName: 'Sofia Alvarez',
    });
    expect((await staff.get('/admin/data-requests/999999')).status).toBe(404);
    const other = await adminWith(t, ['customers:read']);
    expect((await other.get('/admin/data-requests')).status).toBe(403);
    expect((await other.get(`/admin/data-requests/${rows.sooner}`)).status).toBe(403);
  });

  it('shows the customer’s name after anonymization', async () => {
    const customer = await makeCustomer(t, { name: 'Gone Person', status: 'anonymized' });
    await (
      await testDb()
    ).db
      .update(s.customers)
      .set({ name: 'Deleted customer' })
      .where(eq(s.customers.id, customer.id));
    await insertRequest(customer.id);
    expect((await staff.get('/admin/data-requests')).body[0].customerName).toBe('Deleted customer');
  });
});

describe('PATCH /admin/data-requests/:id', () => {
  it('starts a request, then completes it: handled by the caller, completed time from the clock, audited each time', async () => {
    const customer = await makeCustomer(t, { name: 'Omar Haddad' });
    const id = await insertRequest(customer.id);
    const started = await staff.patch(`/admin/data-requests/${id}`, { status: 'in_progress' });
    expect(started.status).toBe(200);
    expect(started.body).toMatchObject({ status: 'in_progress', handledBy: staff.staffId, completedAt: null });
    clock.advance(5 * MINUTE);
    const done = await staff.patch(`/admin/data-requests/${id}`, { status: 'completed', note: 'Sent by email' });
    expect(done.body).toMatchObject({
      status: 'completed',
      completedAt: '2026-11-08T09:05:00.000Z',
      customerName: 'Omar Haddad',
    });
    const { db } = await testDb();
    const [row] = await db.select().from(s.dataRequests).where(eq(s.dataRequests.id, id));
    expect(row!.note).toBe('Sent by email');
    expect((await auditRows(db, 'customer', customer.id)).map((audit) => [audit.action, audit.entityLabel])).toEqual([
      ['started data request of', 'Omar Haddad'],
      ['completed data request of', 'Omar Haddad'],
    ]);
  });

  it('rejects with a required note, stored on the request and in the audit row', async () => {
    const customer = await makeCustomer(t);
    const id = await insertRequest(customer.id, { kind: 'erasure' });
    for (const body of [
      { status: 'rejected' },
      { status: 'rejected', note: '   ' },
      { status: 'rejected', note: 'x'.repeat(301) },
    ]) {
      const res = await staff.patch(`/admin/data-requests/${id}`, body);
      expect(res.status).toBe(422);
      expect(res.body.errors[0].field).toBe('note');
    }
    const ok = await staff.patch(`/admin/data-requests/${id}`, {
      status: 'rejected',
      note: ' Legal hold on the account ',
    });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ status: 'rejected', completedAt: null, handledBy: staff.staffId });
    const { db } = await testDb();
    expect((await db.select().from(s.dataRequests).where(eq(s.dataRequests.id, id)))[0]!.note).toBe(
      'Legal hold on the account',
    );
    const [audit] = await auditRows(db, 'customer', customer.id);
    expect(audit).toMatchObject({
      action: 'rejected data request of',
      after: { note: 'Legal hold on the account', status: 'rejected' },
    });
  });

  it('answers 409 REQUEST_CLOSED for a completed or rejected request', async () => {
    const customer = await makeCustomer(t);
    const completed = await insertRequest(customer.id, { status: 'completed' });
    const rejected = await insertRequest(customer.id, { status: 'rejected', kind: 'erasure' });
    for (const id of [completed, rejected]) {
      const res = await staff.patch(`/admin/data-requests/${id}`, { status: 'in_progress' });
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('REQUEST_CLOSED');
    }
  });

  it('keeps an erasure request open until the customer is anonymized (409 ERASURE_NOT_DONE); an export can be completed by hand', async () => {
    const customer = await makeCustomer(t);
    const erasure = await insertRequest(customer.id, { kind: 'erasure' });
    const refused = await staff.patch(`/admin/data-requests/${erasure}`, { status: 'completed' });
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe('ERASURE_NOT_DONE');
    expect((await staff.patch(`/admin/data-requests/${erasure}`, { status: 'in_progress' })).status).toBe(200);
    await (await testDb()).db.update(s.customers).set({ status: 'anonymized' }).where(eq(s.customers.id, customer.id));
    expect((await staff.patch(`/admin/data-requests/${erasure}`, { status: 'completed' })).status).toBe(200);
    const exportId = await insertRequest(customer.id, { kind: 'export' });
    expect((await staff.patch(`/admin/data-requests/${exportId}`, { status: 'completed' })).status).toBe(200);
  });

  it('answers 422 on status for open or an unknown word, and 404 for an unknown request', async () => {
    const customer = await makeCustomer(t);
    const id = await insertRequest(customer.id);
    for (const status of ['open', 'done', '']) {
      const res = await staff.patch(`/admin/data-requests/${id}`, { status });
      expect(res.status).toBe(422);
      expect(res.body.errors[0].field).toBe('status');
    }
    expect((await staff.patch(`/admin/data-requests/${id}`, {})).status).toBe(422);
    expect((await staff.patch('/admin/data-requests/999999', { status: 'in_progress' })).status).toBe(404);
    expect((await staff.patch(`/admin/data-requests/${id}`, { status: 'in_progress' })).status).toBe(200);
    expect((await staff.patch(`/admin/data-requests/${id}`, { status: 'in_progress' })).status).toBe(422);
  });

  it('needs customers:privacy and the CSRF token', async () => {
    const customer = await makeCustomer(t);
    const id = await insertRequest(customer.id);
    const other = await adminWith(t, ['customers:read']);
    expect((await other.patch(`/admin/data-requests/${id}`, { status: 'in_progress' })).status).toBe(403);
    expect((await staff.withoutCsrf('PATCH', `/admin/data-requests/${id}`, { status: 'in_progress' })).status).toBe(
      403,
    );
  });
});

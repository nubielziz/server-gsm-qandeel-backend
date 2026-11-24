// Integration tests of the data-subject requests of the one account type (decision 064): the two privacy
// routes serve every rank (export for any account, erasure only for the retail rank, with the sentence of decision 064 and nothing stored
// for a merchant rank), the staff list names the account of a request whatever its rank and filters by `accountId` (`customerId` is a
// 422), a request closes by account id, and a request written for an account keeps the retired customer column empty.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { eq } from 'drizzle-orm';
import { DbService, schema as s } from '@src/infra/db';
import { DataRequestService } from '@src/modules/risk';
import { MERCHANT_ERASURE_MESSAGE } from '@src/modules/risk/domain/data-requests';
import { ensureRetailGroup, makeAccount } from '../../support/accounts';
import { openAccountSession } from '../../support/account-sessions';
import { type AdminApi, adminWith } from '../../support/admin-api';
import { type TestApp, createTestApp } from '../../support/app';
import { clearIdentityCaches } from '../../support/auth';
import { DAY, TestClock } from '../../support/clock';
import { closeTestDb, resetDb, testDb } from '../../support/db';
import { STORE_ORIGIN, StoreClient, clearStoreRateLimits } from '../../support/store';

const clock = new TestClock('2026-11-08T09:00:00.000Z');
let t: TestApp;
let staff: AdminApi;

beforeAll(async () => {
  t = await createTestApp({ clock, env: { SHOP_ORIGINS: STORE_ORIGIN } });
});
beforeEach(async () => {
  clock.set('2026-11-08T09:00:00.000Z');
  await resetDb();
  await clearIdentityCaches(t);
  await clearStoreRateLimits(t);
  staff = await adminWith(t, ['customers:privacy'], { name: 'Rami K.' });
});
afterAll(async () => {
  await resetDb();
  await clearIdentityCaches(t);
  await t.close();
  await closeTestDb();
});

/** A browser that holds an active session of the account, whatever its rank: the one session cookie serves both URL families. */
async function browserOf(accountId: number): Promise<StoreClient> {
  const session = await openAccountSession(t, accountId);
  const store = new StoreClient(t);
  store.setSessionToken(session.token);
  store.csrf = session.csrf;
  return store;
}

/** Inserts a request straight into the table. */
async function insertRequest(
  accountId: number,
  values: Partial<typeof s.dataRequests.$inferInsert> = {},
): Promise<number> {
  const { db } = await testDb();
  const requestedAt = values.requestedAt ?? new Date(clock.nowMs());
  const [row] = await db
    .insert(s.dataRequests)
    .values({ accountId, kind: 'export', requestedAt, dueAt: new Date(requestedAt.getTime() + 30 * DAY), ...values })
    .returning({ id: s.dataRequests.id });
  return row!.id;
}

const requestsOf = async () => (await testDb()).db.select().from(s.dataRequests).orderBy(s.dataRequests.id);

describe('POST /store/v1/me/data-export', () => {
  it('records an export request for an account of the retail rank under its account number', async () => {
    const account = await makeAccount(t, { rank: 'retail', name: 'Daniel Whitmore' });
    const store = await browserOf(account.id);
    const res = await store.call('POST', '/store/v1/me/data-export');
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ kind: 'export', status: 'open', dueAt: '2026-12-08T09:00:00.000Z' });
    expect((await requestsOf()).map((row) => [row.accountId, row.kind, row.retiredCustomerId])).toEqual([
      [account.id, 'export', null],
    ]);
  });

  it('records one for an account of a merchant rank too (export for every account), and answers the waiting one again', async () => {
    const merchant = await makeAccount(t, { rank: 'merchant', name: 'Mira Trading' });
    const store = await browserOf(merchant.id);
    const first = await store.call('POST', '/store/v1/me/data-export');
    expect(first.statusCode).toBe(201);
    expect(first.json()).toMatchObject({ kind: 'export', status: 'open' });
    const again = await store.call('POST', '/store/v1/me/data-export');
    expect(again.json().id).toBe(first.json().id);
    expect((await requestsOf()).map((row) => [row.accountId, row.kind])).toEqual([[merchant.id, 'export']]);
  });

  it('makes one request for two taps at once on an account of a merchant rank (the account row serialises them)', async () => {
    const merchant = await makeAccount(t, { rank: 'merchant' });
    const store = await browserOf(merchant.id);
    const [a, b] = await Promise.all([
      store.call('POST', '/store/v1/me/data-export'),
      store.call('POST', '/store/v1/me/data-export'),
    ]);
    expect(a.json().id).toBe(b.json().id);
    expect(await requestsOf()).toHaveLength(1);
  });
});

describe('POST /store/v1/me/data-delete', () => {
  it('records an erasure request for the retail rank', async () => {
    const account = await makeAccount(t, { rank: 'retail' });
    const store = await browserOf(account.id);
    const res = await store.call('POST', '/store/v1/me/data-delete');
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ kind: 'erasure', status: 'open' });
    expect((await requestsOf()).map((row) => [row.accountId, row.kind])).toEqual([[account.id, 'erasure']]);
  });

  it('answers a merchant rank 409 CONFLICT with the words of decision 064 and stores nothing', async () => {
    const merchant = await makeAccount(t, { rank: 'merchant' });
    const store = await browserOf(merchant.id);
    for (let tap = 0; tap < 2; tap += 1) {
      const res = await store.call('POST', '/store/v1/me/data-delete');
      expect(res.statusCode).toBe(409);
      expect(res.json()).toMatchObject({ code: 'CONFLICT', detail: MERCHANT_ERASURE_MESSAGE });
    }
    expect(MERCHANT_ERASURE_MESSAGE).toBe(
      'This account has a merchant rank. Ask us to move it to the retail rank first; then you can ask for erasure.',
    );
    expect(await requestsOf()).toEqual([]);
    // The refusal is not a sign-out: the same session still asks for its copy.
    expect((await store.call('POST', '/store/v1/me/data-export')).statusCode).toBe(201);
  });

  it('reads the rank under the account row lock: after staff moved the account to the retail rank it can ask', async () => {
    const merchant = await makeAccount(t, { rank: 'merchant' });
    const store = await browserOf(merchant.id);
    expect((await store.call('POST', '/store/v1/me/data-delete')).statusCode).toBe(409);
    const { db } = await testDb();
    await db
      .update(s.clients)
      .set({ groupId: await ensureRetailGroup(db) })
      .where(eq(s.clients.id, merchant.id));
    await clearIdentityCaches(t);
    // The real rank change also ends the sessions; here the same session meets the new rank, read under the account row lock.
    expect((await store.call('POST', '/store/v1/me/data-delete')).statusCode).toBe(201);
    expect((await requestsOf()).map((row) => [row.accountId, row.kind])).toEqual([[merchant.id, 'erasure']]);
  });
});

describe('GET /admin/data-requests names an account of any rank', () => {
  it('lists the requests of a merchant rank and a retail account with accountId and accountName, and no customer keys', async () => {
    const merchant = await makeAccount(t, { rank: 'merchant', name: 'Mira Trading' });
    const retail = await makeAccount(t, { rank: 'retail', name: 'Omar Haddad' });
    const forMerchant = await insertRequest(merchant.id, { requestedAt: new Date('2026-11-01T00:00:00.000Z') });
    const forRetail = await insertRequest(retail.id, {
      kind: 'erasure',
      requestedAt: new Date('2026-11-02T00:00:00.000Z'),
    });
    const res = await staff.get('/admin/data-requests');
    expect(res.status).toBe(200);
    expect(res.total).toBe(2);
    expect(res.body).toMatchObject([
      { id: forMerchant, accountId: merchant.id, accountName: 'Mira Trading', kind: 'export' },
      { id: forRetail, accountId: retail.id, accountName: 'Omar Haddad', kind: 'erasure' },
    ]);
    for (const row of res.body as Record<string, unknown>[]) {
      expect(row).not.toHaveProperty('customerId');
      expect(row).not.toHaveProperty('customerName');
    }
    expect((await staff.get(`/admin/data-requests/${forMerchant}`)).body).toMatchObject({
      accountId: merchant.id,
      accountName: 'Mira Trading',
    });
  });

  it('filters by accountId and answers 422 for the retired customerId filter', async () => {
    const a = await makeAccount(t, { rank: 'retail' });
    const b = await makeAccount(t, { rank: 'merchant' });
    const mine = await insertRequest(a.id);
    await insertRequest(b.id);
    await insertRequest(b.id, { kind: 'erasure' });
    const filtered = await staff.get(`/admin/data-requests?accountId=${a.id}`);
    expect(filtered.body.map((row: { id: number }) => row.id)).toEqual([mine]);
    expect((await staff.get(`/admin/data-requests?accountId=${b.id}`)).total).toBe(2);
    const retired = await staff.get(`/admin/data-requests?customerId=${a.id}`);
    expect(retired.status).toBe(422);
    expect(JSON.stringify(retired.body)).toContain('customerId');
  });

  it('ignores the retired customer column: a row that only has it is not a request of any account', async () => {
    const account = await makeAccount(t, { rank: 'retail' });
    await insertRequest(account.id);
    const rows = await requestsOf();
    expect(rows[0]!.retiredCustomerId).toBeNull();
    expect((await staff.get(`/admin/data-requests?accountId=${account.id}`)).total).toBe(1);
  });
});

describe('DataRequestService.completePending', () => {
  it('closes the waiting requests of one kind of one account, by account id, and leaves the others', async () => {
    const account = await makeAccount(t, { rank: 'retail' });
    const other = await makeAccount(t, { rank: 'retail' });
    const open = await insertRequest(account.id, { kind: 'export' });
    const started = await insertRequest(account.id, { kind: 'export', status: 'in_progress' });
    const erasure = await insertRequest(account.id, { kind: 'erasure' });
    const theirs = await insertRequest(other.id, { kind: 'export' });
    const service = t.app.get(DataRequestService);
    const closed = await t.app
      .get(DbService)
      .runInTransaction(({ tx }) => service.completePending(tx, account.id, 'export', staff.staffId));
    expect([...closed].sort((x, y) => x - y)).toEqual([open, started]);
    const rows = new Map((await requestsOf()).map((row) => [row.id, row]));
    expect(rows.get(open)).toMatchObject({
      status: 'completed',
      handledBy: staff.staffId,
      completedAt: new Date(clock.nowMs()),
    });
    expect(rows.get(erasure)!.status).toBe('open');
    expect(rows.get(theirs)!.status).toBe('open');
  });
});

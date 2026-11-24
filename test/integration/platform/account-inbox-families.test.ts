// Integration tests of the inbox and the live stream of an account on the two URL families (decision 064): the inbox owner is the account,
// `/client/notifications` serves the merchant ranks and `/store/v1/me/notifications` the retail rank, and the other rank is refused with
// 403 RANK_NOT_ALLOWED (a code that never signs anyone out).
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { schema as s } from '@src/infra/db';
import { type TestApp, createTestApp } from '../../support/app';
import { openAccountSession } from '../../support/account-sessions';
import { makeAccount } from '../../support/accounts';
import { clearIdentityCaches } from '../../support/auth';
import { TestClock } from '../../support/clock';
import { closeTestDb, resetDb, testDb } from '../../support/db';
import { STORE_ORIGIN } from '../../support/store';

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
});

/** Inserts an unread event item for an account, owned by the one recipient type `account`. */
async function addItem(accountId: number): Promise<number> {
  const { db } = await testDb();
  const [row] = await db
    .insert(s.notificationInbox)
    .values({
      recipientType: 'account',
      recipientId: accountId,
      event: 'order.completed',
      category: 'order',
      variables: { orderId: '4021', service: 'Vodafone UK iPhone Unlock' },
    })
    .returning({ id: s.notificationInbox.id });
  return row!.id;
}

/** Calls a route as the account with the session cookie of the one account type. */
async function call(accountId: number, method: 'GET' | 'POST', url: string, payload?: unknown) {
  const session = await openAccountSession(t, accountId);
  return t.app.inject({
    method,
    url,
    headers: method === 'GET' ? session.headers : session.mutationHeaders,
    ...(payload === undefined ? {} : { payload: payload as never }),
  });
}

describe('the inbox of an account', () => {
  it('lists, counts and marks read on the family of its rank', async () => {
    const merchant = await makeAccount(t, { rank: 'merchant' });
    const retail = await makeAccount(t, { rank: 'retail' });
    const merchantItem = await addItem(merchant.id);
    const retailItem = await addItem(retail.id);

    const merchantList = await call(merchant.id, 'GET', '/client/notifications');
    expect(merchantList.statusCode).toBe(200);
    expect(merchantList.json<Array<{ id: number }>>().map((item) => item.id)).toEqual([merchantItem]);
    const retailList = await call(retail.id, 'GET', '/store/v1/me/notifications');
    expect(retailList.statusCode).toBe(200);
    expect(retailList.json<Array<{ id: number }>>().map((item) => item.id)).toEqual([retailItem]);

    expect((await call(merchant.id, 'GET', '/client/notifications/unread-count')).json()).toEqual({ unread: 1 });
    expect((await call(retail.id, 'GET', '/store/v1/me/notifications/unread-count')).json()).toEqual({ unread: 1 });

    expect((await call(retail.id, 'POST', `/store/v1/me/notifications/${retailItem}/read`)).statusCode).toBe(204);
    expect((await call(retail.id, 'GET', '/store/v1/me/notifications/unread-count')).json()).toEqual({ unread: 0 });
    expect((await call(merchant.id, 'GET', '/client/notifications/unread-count')).json()).toEqual({ unread: 1 });
  });

  it("never lets an account read or mark another account's item, even with the same family", async () => {
    const mine = await makeAccount(t, { rank: 'retail' });
    const other = await makeAccount(t, { rank: 'retail' });
    const theirs = await addItem(other.id);
    expect((await call(mine.id, 'GET', '/store/v1/me/notifications')).json()).toEqual([]);
    expect((await call(mine.id, 'POST', `/store/v1/me/notifications/${theirs}/read`)).statusCode).toBe(404);
  });

  it('refuses the other rank on each family with 403 RANK_NOT_ALLOWED', async () => {
    const merchant = await makeAccount(t, { rank: 'merchant' });
    const retail = await makeAccount(t, { rank: 'retail' });
    const retailOnClient = await call(retail.id, 'GET', '/client/notifications');
    expect(retailOnClient.statusCode).toBe(403);
    expect(retailOnClient.json<{ code: string }>().code).toBe('RANK_NOT_ALLOWED');
    const merchantOnStore = await call(merchant.id, 'GET', '/store/v1/me/notifications');
    expect(merchantOnStore.statusCode).toBe(403);
    expect(merchantOnStore.json<{ code: string }>().code).toBe('RANK_NOT_ALLOWED');
    expect((await call(retail.id, 'GET', '/client/notifications/unread-count')).statusCode).toBe(403);
    expect((await call(merchant.id, 'POST', '/store/v1/me/notifications/read-all', {})).statusCode).toBe(403);
  });

  it('answers 401 without a session on both families', async () => {
    expect((await t.app.inject({ method: 'GET', url: '/client/notifications' })).statusCode).toBe(401);
    expect((await t.app.inject({ method: 'GET', url: '/store/v1/me/notifications' })).statusCode).toBe(401);
  });
});

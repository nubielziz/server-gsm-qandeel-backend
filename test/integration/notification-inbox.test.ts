// Integration tests of the inbox routes on the three surfaces (feature 23, plan section 10.4): the staff console, the merchant portal and
// the storefront account list, count and mark the signed-in person's own items; isolation by (type, id), the unread cap, paging, filters,
// languages, cancelled campaigns and the guards of each surface (session, CSRF, a pending and a suspended merchant).
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { eq } from 'drizzle-orm';
import { schema as s } from '../../src/infra/db';
import { type AdminApi, adminWith } from '../support/admin-api';
import { type TestApp, createTestApp } from '../support/app';
import { clearIdentityCaches, insertMerchant, openSession } from '../support/auth';
import { createDraft } from '../support/campaigns';
import { TestClock } from '../support/clock';
import { closeTestDb, resetDb, testDb } from '../support/db';
import { type MerchantSession, merchantSession } from '../support/notifications';
import { STORE_ORIGIN, makeCustomer } from '../support/store';

const clock = new TestClock('2026-11-10T09:00:00.000Z');
let t: TestApp;

beforeAll(async () => {
  t = await createTestApp({ clock });
});
beforeEach(async () => {
  clock.set('2026-11-10T09:00:00.000Z');
  await resetDb();
  await clearIdentityCaches(t);
});
afterAll(async () => {
  await resetDb();
  await clearIdentityCaches(t);
  await t.close();
  await closeTestDb();
});

type Type = 'staff' | 'client' | 'customer';
type Item = typeof s.notificationInbox.$inferInsert;

/** Inserts an event item (or any item) straight into the table. */
async function addItem(type: Type, id: number, values: Partial<Item> = {}): Promise<number> {
  const { db } = await testDb();
  const [row] = await db
    .insert(s.notificationInbox)
    .values({
      recipientType: type,
      recipientId: id,
      event: 'order.completed',
      category: 'order',
      variables: { orderId: '4021', service: 'Vodafone UK iPhone Unlock' },
      ...values,
    })
    .returning({ id: s.notificationInbox.id });
  return row!.id;
}

/** A customer with an account and a signed-in session, speaking to the storefront's routes. */
async function customerClient(overrides: Parameters<typeof makeCustomer>[1] = {}) {
  const customer = await makeCustomer(t, overrides);
  const session = await openSession(t, { type: 'customer', id: customer.id });
  const call = async (method: 'GET' | 'POST', url: string, payload?: unknown, withSession = true, csrf = true) => {
    const headers: Record<string, string> = { origin: STORE_ORIGIN };
    if (withSession) Object.assign(headers, csrf ? session.mutationHeaders : session.headers);
    if (method === 'GET' && withSession) Object.assign(headers, session.headers);
    const res = await t.app.inject({
      method,
      url,
      headers,
      ...(payload === undefined ? {} : { payload: payload as never }),
    });
    return {
      status: res.statusCode,
      body: res.body === '' ? undefined : JSON.parse(res.body),
      total: Number(res.headers['x-total-count'] ?? Number.NaN),
    };
  };
  return { id: customer.id, call };
}

async function merchant(overrides: Partial<typeof s.clients.$inferInsert> = {}): Promise<MerchantSession> {
  const { db } = await testDb();
  return merchantSession(t, await insertMerchant(db, overrides));
}

describe('who may call', () => {
  it('answers 401 UNAUTHORIZED to a caller without a session on every surface', async () => {
    const staff = await adminWith(t, []);
    for (const url of ['/admin/inbox', '/admin/inbox/unread-count']) {
      const res = await staff.anonymous('GET', url);
      expect(res.status, url).toBe(401);
      expect(res.body.code).toBe('UNAUTHORIZED');
    }
    const customer = await customerClient();
    for (const url of ['/store/v1/me/notifications', '/store/v1/me/notifications/unread-count']) {
      const res = await customer.call('GET', url, undefined, false);
      expect(res.status, url).toBe(401);
    }
    const cookieless = await t.app.inject({ method: 'GET', url: '/client/notifications' });
    expect(cookieless.statusCode).toBe(401);
  });

  it('needs the CSRF token on every POST', async () => {
    const staff = await adminWith(t, []);
    expect((await staff.withoutCsrf('POST', '/admin/inbox/read-all', {})).body.code).toBe('CSRF_FAILED');
    expect((await staff.withoutCsrf('POST', '/admin/inbox/1/read')).body.code).toBe('CSRF_FAILED');
    const m = await merchant();
    const forged = await m.withoutCsrf('POST', '/client/notifications/read-all', {});
    expect(forged.status).toBe(403);
    expect(forged.body.code).toBe('CSRF_FAILED');
    const customer = await customerClient();
    const noCsrf = await customer.call('POST', '/store/v1/me/notifications/read-all', {}, true, false);
    expect(noCsrf.status).toBe(403);
    expect(noCsrf.body.code).toBe('CSRF_FAILED');
  });

  it('lets a merchant who waits for approval read its inbox and refuses a suspended one', async () => {
    const pending = await merchant({ status: 'pending' });
    const { db } = await testDb();
    await db.insert(s.notificationInbox).values({
      recipientType: 'client',
      recipientId: pending.clientId,
      event: 'wallet.low_balance',
      category: 'wallet',
      variables: { available: '3.00', currency: 'GBP', threshold: '10.00' },
    });
    const list = await pending.call('GET', '/client/notifications');
    expect(list.status).toBe(200);
    expect(list.body).toHaveLength(1);
    const suspended = await merchant({ status: 'suspended' });
    const refused = await suspended.call('GET', '/client/notifications');
    expect(refused.status).toBe(403);
    expect(refused.body.code).toBe('ACCOUNT_SUSPENDED');
  });
});

describe('GET /admin/inbox, /client/notifications, /store/v1/me/notifications', () => {
  it('shows each person only their own items, even when another type has the same numeric id', async () => {
    const staff = await adminWith(t, []);
    const m = await merchant();
    const customer = await customerClient();
    const mine = await addItem('staff', staff.staffId, {
      event: 'broadcast.test',
      category: 'announcement',
      variables: { title: 'T', body: 'B' },
    });
    // Tables count from 1 each, so the three people below usually share one numeric id: only the type keeps their items apart.
    await addItem('staff', staff.staffId + 1000, { event: 'broadcast.test', category: 'announcement' });
    const merchantItem = await addItem('client', m.clientId, {
      event: 'wallet.low_balance',
      category: 'wallet',
      variables: { available: '3.00', currency: 'GBP', threshold: '10.00' },
    });
    const customerItem = await addItem('customer', customer.id);

    const staffList = await staff.get('/admin/inbox');
    expect(staffList.status).toBe(200);
    expect(staffList.body.map((item: { id: number }) => item.id)).toEqual([mine]);
    expect(staffList.total).toBe(1);

    const merchantList = await m.call('GET', '/client/notifications');
    expect(merchantList.body.map((item: { id: number }) => item.id)).toEqual([merchantItem]);
    expect(merchantList.body[0]).toMatchObject({
      category: 'wallet',
      title: 'Low wallet balance',
      link: '/merchant/wallet',
      locale: 'en',
      readAt: null,
      campaignId: null,
      event: 'wallet.low_balance',
    });
    expect(merchantList.body[0].body).toBe('Your available balance is 3.00 GBP, below your alert of 10.00 GBP.');

    const customerList = await customer.call('GET', '/store/v1/me/notifications');
    expect(customerList.body.map((item: { id: number }) => item.id)).toEqual([customerItem]);
    expect(customerList.body[0]).toMatchObject({
      title: 'Order 4021 completed',
      body: 'Your order for Vodafone UK iPhone Unlock is complete.',
      link: '/account/orders',
    });
  });

  it('pages newest first with the exact total, and filters by unread and category', async () => {
    const staff = await adminWith(t, []);
    const ids: number[] = [];
    for (let n = 0; n < 5; n += 1) {
      clock.advance(1000);
      ids.push(
        await addItem('staff', staff.staffId, {
          event: 'broadcast.test',
          category: 'announcement',
          variables: { title: `Item ${n}`, body: 'b' },
          createdAt: clock.now(),
        }),
      );
    }
    const { db } = await testDb();
    await db.update(s.notificationInbox).set({ readAt: clock.now() }).where(eq(s.notificationInbox.id, ids[0]!));

    const page = await staff.get('/admin/inbox?_start=0&_end=2');
    expect(page.body.map((item: { id: number }) => item.id)).toEqual([ids[4], ids[3]]);
    expect(page.total).toBe(5);
    const next = await staff.get('/admin/inbox?_start=2&_end=4');
    expect(next.body.map((item: { id: number }) => item.id)).toEqual([ids[2], ids[1]]);
    const oldest = await staff.get('/admin/inbox?_sort=createdAt&_order=asc&_start=0&_end=1');
    expect(oldest.body[0].id).toBe(ids[0]);

    const unread = await staff.get('/admin/inbox?unread=true');
    expect(unread.total).toBe(4);
    expect(unread.body.every((item: { readAt: string | null }) => item.readAt === null)).toBe(true);
    const read = await staff.get('/admin/inbox?unread=false');
    expect(read.body.map((item: { id: number }) => item.id)).toEqual([ids[0]]);
    expect((await staff.get('/admin/inbox?category=order')).total).toBe(0);
    expect((await staff.get('/admin/inbox?category=announcement')).total).toBe(5);
    expect((await staff.get('/admin/inbox?category=nonsense')).status).toBe(422);
    expect((await staff.get('/admin/inbox?_start=0&_end=101')).status).toBe(422);
    expect((await staff.get('/admin/inbox?unread=maybe')).status).toBe(422);
  });

  it('renders a campaign item in the reader’s language: the saved one for a customer, the asked one first, English as the fallback', async () => {
    const owner = await adminWith(t, ['*']);
    const draft = await createDraft(owner);
    const english = await createDraft(owner, {
      name: 'English only',
      content: { en: { title: 'Hello {{name}}', body: 'Only in English.' } },
      link: { customer: '/account/orders' },
    });
    const arabic = await customerClient({ locale: 'ar', name: 'Dana' });
    const guestOfEnglish = await customerClient({ locale: 'en', name: 'Dan' });
    await addItem('customer', arabic.id, {
      event: null,
      campaignId: draft.id,
      category: 'announcement',
      variables: {},
    });
    await addItem('customer', arabic.id, {
      event: null,
      campaignId: english.id,
      category: 'announcement',
      variables: {},
    });
    await addItem('customer', guestOfEnglish.id, {
      event: null,
      campaignId: draft.id,
      category: 'announcement',
      variables: {},
    });

    const saved = await arabic.call('GET', '/store/v1/me/notifications?_sort=id&_order=asc');
    expect(saved.body[0]).toMatchObject({
      title: 'صيانة لـ Dana',
      locale: 'ar',
      link: '/account/orders',
      campaignId: draft.id,
    });
    // Arabic reader, English-only campaign: English text, and `locale` says so.
    expect(saved.body[1]).toMatchObject({ title: 'Hello Dana', body: 'Only in English.', locale: 'en' });

    const asked = await arabic.call('GET', '/store/v1/me/notifications?locale=en&_sort=id&_order=asc');
    expect(asked.body[0]).toMatchObject({ title: 'Maintenance for Dana', locale: 'en' });
    const other = await guestOfEnglish.call('GET', '/store/v1/me/notifications?locale=ar');
    expect(other.body[0]).toMatchObject({ title: 'صيانة لـ Dan', locale: 'ar' });
    expect((await guestOfEnglish.call('GET', '/store/v1/me/notifications?locale=fr')).status).toBe(422);
    // The Arabic event text, too.
    await addItem('customer', arabic.id);
    const events = await arabic.call('GET', '/store/v1/me/notifications?category=order');
    expect(events.body[0]).toMatchObject({ title: 'تم تنفيذ طلبك 4021', locale: 'ar' });
  });

  it('hides the items of a cancelled campaign from the list and the count, and shows them again never', async () => {
    const owner = await adminWith(t, ['*']);
    const draft = await createDraft(owner, { channels: ['in_app'] });
    const m = await merchant();
    await addItem('client', m.clientId, { event: null, campaignId: draft.id, category: 'announcement', variables: {} });
    await addItem('client', m.clientId, { event: 'wallet.low_balance', category: 'wallet' });
    expect((await m.call('GET', '/client/notifications')).body).toHaveLength(2);
    expect((await m.call('GET', '/client/notifications/unread-count')).body).toEqual({ unread: 2 });
    const { db } = await testDb();
    await db
      .update(s.notificationCampaigns)
      .set({ status: 'cancelled', cancelledAt: clock.now(), cancelledBy: owner.staffId })
      .where(eq(s.notificationCampaigns.id, draft.id));
    const after = await m.call('GET', '/client/notifications');
    expect(after.body).toHaveLength(1);
    expect(after.body[0].event).toBe('wallet.low_balance');
    expect((await m.call('GET', '/client/notifications/unread-count')).body).toEqual({ unread: 1 });
  });

  it('falls back to a plain title for an event item whose text is no longer registered', async () => {
    const staff = await adminWith(t, []);
    await addItem('staff', staff.staffId, { event: 'removed.event', category: 'alert', variables: {} });
    const res = await staff.get('/admin/inbox');
    expect(res.body[0]).toMatchObject({ title: 'Notification', body: '', link: null, category: 'alert' });
  });
});

describe('unread count', () => {
  it('counts the unread items and stops at 100', async () => {
    const staff = await adminWith(t, []);
    expect((await staff.get('/admin/inbox/unread-count')).body).toEqual({ unread: 0 });
    const { db } = await testDb();
    await db.insert(s.notificationInbox).values(
      Array.from({ length: 105 }, (_, n) => ({
        recipientType: 'staff' as const,
        recipientId: staff.staffId,
        event: 'broadcast.test',
        category: 'announcement' as const,
        variables: { title: `n${n}`, body: 'b' },
        readAt: n < 2 ? clock.now() : null,
      })),
    );
    expect((await staff.get('/admin/inbox/unread-count')).body).toEqual({ unread: 100 });
    await db.delete(s.notificationInbox).where(eq(s.notificationInbox.recipientId, staff.staffId));
    await addItem('staff', staff.staffId, { event: 'broadcast.test', category: 'announcement' });
    await addItem('staff', staff.staffId, { event: 'broadcast.test', category: 'announcement', readAt: clock.now() });
    expect((await staff.get('/admin/inbox/unread-count')).body).toEqual({ unread: 1 });
  });
});

describe('POST .../:id/read', () => {
  it('marks one item read, again with 204, and answers 404 for another person’s item on every surface', async () => {
    const staff = await adminWith(t, []);
    const m = await merchant();
    const customer = await customerClient();
    const staffItem = await addItem('staff', staff.staffId, { event: 'broadcast.test', category: 'announcement' });
    const merchantItem = await addItem('client', m.clientId, { event: 'wallet.low_balance', category: 'wallet' });
    const customerItem = await addItem('customer', customer.id);
    const { db } = await testDb();
    const readAt = async (id: number) =>
      (await db.select().from(s.notificationInbox).where(eq(s.notificationInbox.id, id)))[0]!.readAt;

    expect((await staff.post(`/admin/inbox/${staffItem}/read`)).status).toBe(204);
    const first = await readAt(staffItem);
    expect(first).toEqual(clock.now());
    clock.advance(60_000);
    expect((await staff.post(`/admin/inbox/${staffItem}/read`)).status).toBe(204);
    expect(await readAt(staffItem)).toEqual(first);

    expect((await m.call('POST', `/client/notifications/${merchantItem}/read`)).status).toBe(204);
    expect((await customer.call('POST', `/store/v1/me/notifications/${customerItem}/read`)).status).toBe(204);

    // Another person's id, another type's id and an id that does not exist are all 404 and change nothing.
    const foreign = [
      await staff.post(`/admin/inbox/${merchantItem}/read`),
      await staff.post('/admin/inbox/99999/read'),
      await m.call('POST', `/client/notifications/${customerItem}/read`),
      await customer.call('POST', `/store/v1/me/notifications/${staffItem}/read`),
    ];
    for (const res of foreign) {
      expect(res.status).toBe(404);
      expect(res.body.code).toBe('NOT_FOUND');
    }
    const untouched = await addItem('customer', customer.id);
    expect((await m.call('POST', `/client/notifications/${untouched}/read`)).status).toBe(404);
    expect(await readAt(untouched)).toBeNull();
    expect((await staff.post('/admin/inbox/abc/read')).status).toBe(422);
  });
});

describe('POST .../read-all', () => {
  it('marks every unread item of the caller, and only the caller’s', async () => {
    const m = await merchant();
    const other = await merchant();
    for (let n = 0; n < 3; n += 1)
      await addItem('client', m.clientId, { event: 'wallet.low_balance', category: 'wallet' });
    await addItem('client', other.clientId, { event: 'wallet.low_balance', category: 'wallet' });
    const res = await m.call('POST', '/client/notifications/read-all', {});
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ updated: 3 });
    expect((await m.call('GET', '/client/notifications/unread-count')).body).toEqual({ unread: 0 });
    expect((await other.call('GET', '/client/notifications/unread-count')).body).toEqual({ unread: 1 });
    expect((await m.call('POST', '/client/notifications/read-all', {})).body).toEqual({ updated: 0 });
  });

  it('stops at upToId, so an item that arrived during the click stays unread; accepts no body', async () => {
    const staff: AdminApi = await adminWith(t, []);
    const first = await addItem('staff', staff.staffId, { event: 'broadcast.test', category: 'announcement' });
    const second = await addItem('staff', staff.staffId, { event: 'broadcast.test', category: 'announcement' });
    const late = await addItem('staff', staff.staffId, { event: 'broadcast.test', category: 'announcement' });
    const res = await staff.post('/admin/inbox/read-all', { upToId: second });
    expect(res.body).toEqual({ updated: 2 });
    const unread = await staff.get('/admin/inbox?unread=true');
    expect(unread.body.map((item: { id: number }) => item.id)).toEqual([late]);
    expect(first).toBeLessThan(second);
    expect((await staff.post('/admin/inbox/read-all')).body).toEqual({ updated: 1 });
    expect((await staff.post('/admin/inbox/read-all', { upToId: 0 })).status).toBe(422);
    expect((await staff.post('/admin/inbox/read-all', { who: 'me' })).status).toBe(422);
  });

  it('is not audited for a staff member: no admin write', async () => {
    const staff = await adminWith(t, []);
    await addItem('staff', staff.staffId, { event: 'broadcast.test', category: 'announcement' });
    await staff.post('/admin/inbox/read-all', {});
    const { db } = await testDb();
    expect(await db.select().from(s.auditLogs)).toHaveLength(0);
  });
});

// Integration tests of the one list of accounts (decision 064): GET /admin/clients and GET /admin/clients/:id over merchants, retail
// accounts and guests, through HTTP on the real application. Written for the GitHub run: the application boots only once the whole account
// model is wired, and the order figures and the wallet balance come from fragments the orders and money modules register with AccountListSql.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { schema as s } from '@src/infra/db';
import { MerchantAccounts } from '@src/modules/money';
import { ensureRetailGroup, makeAccount } from '../../support/accounts';
import { adminWith } from '../../support/admin-api';
import { type TestApp, createTestApp } from '../../support/app';
import { clearIdentityCaches } from '../../support/auth';
import { insertCategory, insertService } from '../../support/catalog';
import { TestClock } from '../../support/clock';
import { fundCustomer } from '../../support/customer-wallet';
import { closeTestDb, resetDb, testDb } from '../../support/db';
import { insertUsd } from '../../support/fixtures';
import { fundWallet } from '../../support/money';
import { insertOrderRow } from '../../support/orders';

const clock = new TestClock();
let t: TestApp;

beforeAll(async () => {
  t = await createTestApp({ clock });
});
beforeEach(async () => {
  clock.reset();
  await resetDb();
  await clearIdentityCaches(t);
});
afterAll(async () => {
  await resetDb();
  await clearIdentityCaches(t);
  await t.close();
  await closeTestDb();
});

const ids = (body: Array<{ id: number }>) => body.map((row) => row.id);

/** A staff member who holds only `clients:read`: no wallet, no stats, no sort by balance. */
const reader = () => adminWith(t, ['clients:read'], { name: 'Rami K.' });
/** A staff member who also holds `wallet:read`. */
const finance = () => adminWith(t, ['clients:read', 'wallet:read'], { name: 'Rami K.' });

/**
 * Two merchants, two retail accounts and a guest:
 * - Alpha (merchant rank Gold, active, a password, 3 orders: two portal and one shop order, one of them rejected, wallet 100),
 * - Bravo (merchant rank Basic, suspended, no password, 1 portal order, wallet 40),
 * - Charlie (retail, active, invited: no password yet, 2 shop orders, store balance 70),
 * - Delta (retail, blocked, a password, no orders),
 * - Echo (a guest: no login, no orders).
 * The ranks are made so that their ids and their sort numbers disagree: Gold is made first but sorts after Basic.
 */
async function world(staffId: number) {
  const { db } = await testDb();
  await insertUsd(db);
  const [gold] = await db
    .insert(s.clientGroups)
    .values({ name: 'Gold', kind: 'b2b', sort: 1, discountPercent: '8', overdraftAllowed: true })
    .returning({ id: s.clientGroups.id });
  const [basic] = await db
    .insert(s.clientGroups)
    .values({ name: 'Basic', kind: 'b2b', sort: 0, isDefault: true })
    .returning({ id: s.clientGroups.id });
  const retail = await ensureRetailGroup(db);
  const alpha = await makeAccount(t, {
    rank: 'merchant',
    groupId: gold!.id,
    name: 'Alpha Mobile',
    company: 'Alpha Trading',
    username: 'alpha',
    country: 'JO',
    createdBy: staffId,
    createdAt: new Date('2026-01-10T09:00:00.000Z'),
  });
  const bravo = await makeAccount(t, {
    rank: 'merchant',
    groupId: basic!.id,
    name: 'Bravo Unlock',
    username: 'bravo',
    country: 'AE',
    password: null,
    status: 'suspended',
    suspendedAt: new Date('2026-03-01T10:00:00.000Z'),
    suspendedReason: 'Chargebacks',
    suspendedBy: staffId,
    createdAt: new Date('2026-02-10T09:00:00.000Z'),
  });
  const charlie = await makeAccount(t, {
    rank: 'retail',
    name: 'Charlie Retail',
    country: 'GB',
    password: null,
    createdAt: new Date('2026-03-10T09:00:00.000Z'),
  });
  const delta = await makeAccount(t, {
    rank: 'retail',
    name: 'Delta Retail',
    country: 'GB',
    status: 'blocked',
    createdAt: new Date('2026-04-10T09:00:00.000Z'),
  });
  const echo = await makeAccount(t, {
    rank: 'retail',
    guest: true,
    name: 'Echo Guest',
    country: 'GB',
    createdAt: new Date('2026-05-10T09:00:00.000Z'),
  });

  const serviceId = await insertService(db, await insertCategory(db));
  const order = (
    accountId: number,
    source: 'portal' | 'store',
    at: string,
    status: 'pending' | 'rejected' = 'pending',
  ) => insertOrderRow(db, { serviceId, accountId, source, status, createdAt: new Date(at) });
  await order(alpha.id, 'portal', '2026-11-01T08:00:00.000Z');
  await order(alpha.id, 'portal', '2026-10-01T08:00:00.000Z');
  await order(alpha.id, 'store', '2026-11-02T08:00:00.000Z', 'rejected');
  await order(bravo.id, 'portal', '2026-11-05T08:00:00.000Z');
  await order(charlie.id, 'store', '2026-11-03T08:00:00.000Z');
  await order(charlie.id, 'store', '2026-09-03T08:00:00.000Z');

  const accounts = new MerchantAccounts();
  for (const merchant of [alpha, bravo]) {
    await accounts.open(db, { clientId: merchant.id, currency: 'USD', creditLimit: '0.0000', overdraftAllowed: false });
  }
  await fundWallet(db, alpha.id, '100');
  await fundWallet(db, bravo.id, '40');
  await fundCustomer(db, charlie.id, '70');

  return { gold: gold!.id, basic: basic!.id, retail, alpha, bravo, charlie, delta, echo };
}

describe('GET /admin/clients', () => {
  it('lists every account of every rank when no rankKind is sent, guests included, with the exact total', async () => {
    const api = await reader();
    const w = await world(api.staffId);
    const res = await api.get('/admin/clients');
    expect(res.status).toBe(200);
    // Name order is the default: Alpha, Bravo, Charlie, Delta, Echo.
    expect(ids(res.body)).toEqual([w.alpha.id, w.bravo.id, w.charlie.id, w.delta.id, w.echo.id]);
    expect(res.total).toBe(5);
  });

  it('filters by rank kind: retail is the retail rank (guests too), merchant every other, both is everyone', async () => {
    const api = await reader();
    const w = await world(api.staffId);
    expect(ids((await api.get('/admin/clients?rankKind=retail')).body)).toEqual([w.charlie.id, w.delta.id, w.echo.id]);
    expect(ids((await api.get('/admin/clients?rankKind=merchant')).body)).toEqual([w.alpha.id, w.bravo.id]);
    const both = await api.get('/admin/clients?rankKind=retail&rankKind=merchant');
    expect(ids(both.body)).toHaveLength(5);
    expect(both.total).toBe(5);
    expect((await api.get('/admin/clients?rankKind=guest')).status).toBe(422);
  });

  it('filters by whether the account has a login', async () => {
    const api = await reader();
    const w = await world(api.staffId);
    const guests = await api.get('/admin/clients?hasAccount=false');
    expect(ids(guests.body)).toEqual([w.echo.id]);
    expect(guests.total).toBe(1);
    expect(ids((await api.get('/admin/clients?hasAccount=true')).body)).toHaveLength(4);
  });

  it('filters by status: a repeated key is IN, status_ne is NOT IN', async () => {
    const api = await reader();
    const w = await world(api.staffId);
    expect(ids((await api.get('/admin/clients?status=suspended&status=blocked')).body)).toEqual([
      w.bravo.id,
      w.delta.id,
    ]);
    expect(ids((await api.get('/admin/clients?status_ne=active')).body)).toEqual([w.bravo.id, w.delta.id]);
    expect(ids((await api.get('/admin/clients?status=active')).body)).toEqual([w.alpha.id, w.charlie.id, w.echo.id]);
    expect((await api.get('/admin/clients?status=pending')).status).toBe(422);
  });

  it('filters by rank id and by country', async () => {
    const api = await reader();
    const w = await world(api.staffId);
    expect(ids((await api.get(`/admin/clients?rankId=${w.gold}`)).body)).toEqual([w.alpha.id]);
    expect(ids((await api.get(`/admin/clients?rankId=${w.retail}`)).body)).toEqual([
      w.charlie.id,
      w.delta.id,
      w.echo.id,
    ]);
    expect(ids((await api.get('/admin/clients?country=GB')).body)).toEqual([w.charlie.id, w.delta.id, w.echo.id]);
  });

  it('filters the invitations that wait: a login, no password yet and an active status', async () => {
    const api = await reader();
    const w = await world(api.staffId);
    // Bravo has no password either, but it is suspended; Echo is a guest.
    expect(ids((await api.get('/admin/clients?invitationPending=true')).body)).toEqual([w.charlie.id]);
    expect(ids((await api.get('/admin/clients?invitationPending=false')).body)).toEqual([
      w.alpha.id,
      w.bravo.id,
      w.delta.id,
      w.echo.id,
    ]);
    const rows = (await api.get('/admin/clients')).body as Array<{ id: number; invitationPending: boolean }>;
    expect(rows.filter((row) => row.invitationPending).map((row) => row.id)).toEqual([w.charlie.id]);
  });

  it('searches name, email, company and username, and no other column', async () => {
    const api = await reader();
    const w = await world(api.staffId);
    expect(ids((await api.get('/admin/clients?q=alpha')).body)).toEqual([w.alpha.id]);
    expect(ids((await api.get('/admin/clients?q=trading')).body)).toEqual([w.alpha.id]);
    expect(ids((await api.get('/admin/clients?q=bravo')).body)).toEqual([w.bravo.id]);
    expect(ids((await api.get(`/admin/clients?q=${encodeURIComponent(w.charlie.email)}`)).body)).toEqual([
      w.charlie.id,
    ]);
    // The country is a filter, not a search field: Alpha is in JO, and nothing else says JO.
    expect(ids((await api.get('/admin/clients?q=JO')).body)).toEqual([]);
  });

  it('sorts by the number of orders of the account, counting both doors and every status', async () => {
    const api = await reader();
    const w = await world(api.staffId);
    const res = await api.get('/admin/clients?_sort=ordersCount&_order=desc');
    expect(ids(res.body).slice(0, 3)).toEqual([w.alpha.id, w.charlie.id, w.bravo.id]);
    const counts = Object.fromEntries(
      (res.body as Array<{ id: number; ordersCount: number }>).map((r) => [r.id, r.ordersCount]),
    );
    expect(counts).toEqual({ [w.alpha.id]: 3, [w.charlie.id]: 2, [w.bravo.id]: 1, [w.delta.id]: 0, [w.echo.id]: 0 });
  });

  it('sorts by the date of the last order, accounts that never ordered last in either direction', async () => {
    const api = await reader();
    const w = await world(api.staffId);
    const down = await api.get('/admin/clients?_sort=lastOrderAt&_order=desc');
    expect(ids(down.body).slice(0, 3)).toEqual([w.bravo.id, w.charlie.id, w.alpha.id]);
    const up = await api.get('/admin/clients?_sort=lastOrderAt&_order=asc');
    expect(ids(up.body).slice(0, 3)).toEqual([w.alpha.id, w.charlie.id, w.bravo.id]);
    const last = (up.body as Array<{ id: number; lastOrderAt: string | null }>).slice(3);
    expect(last.map((row) => row.lastOrderAt)).toEqual([null, null]);
  });

  it('sorts by rank in the order of the ranks, not of their ids', async () => {
    const api = await reader();
    const w = await world(api.staffId);
    // Basic (sort 0), Gold (sort 1), then the retail rank (sort 4); ties by id.
    expect(ids((await api.get('/admin/clients?_sort=rank')).body)).toEqual([
      w.bravo.id,
      w.alpha.id,
      w.charlie.id,
      w.delta.id,
      w.echo.id,
    ]);
    expect(ids((await api.get('/admin/clients?_sort=rank&_order=desc')).body)).toEqual([
      w.echo.id,
      w.delta.id,
      w.charlie.id,
      w.alpha.id,
      w.bravo.id,
    ]);
  });

  it('sorts by status, country, id and creation time', async () => {
    const api = await reader();
    const w = await world(api.staffId);
    expect(ids((await api.get('/admin/clients?_sort=createdAt&_order=desc')).body)).toEqual([
      w.echo.id,
      w.delta.id,
      w.charlie.id,
      w.bravo.id,
      w.alpha.id,
    ]);
    expect(ids((await api.get('/admin/clients?_sort=country')).body)[0]).toBe(w.bravo.id);
    expect(ids((await api.get('/admin/clients?_sort=id&_order=desc')).body)[0]).toBe(w.echo.id);
    expect(ids((await api.get('/admin/clients?_sort=status')).body)[0]).toBe(w.alpha.id);
  });

  it('refuses the sort by balance without wallet:read, and orders by the wallet of each kind with it', async () => {
    const w = await world((await reader()).staffId);
    const denied = await (await reader()).get('/admin/clients?_sort=balance');
    expect(denied.status).toBe(403);
    const api = await finance();
    const res = await api.get('/admin/clients?_sort=balance&_order=desc');
    expect(res.status).toBe(200);
    // The merchant wallet of Alpha (100), the store wallet of Charlie (70), the merchant wallet of Bravo (40); no wallet last.
    expect(ids(res.body).slice(0, 3)).toEqual([w.alpha.id, w.charlie.id, w.bravo.id]);
  });

  it('pages the list and keeps the total of the whole list', async () => {
    const api = await reader();
    const w = await world(api.staffId);
    const page = await api.get('/admin/clients?_start=1&_end=3');
    expect(ids(page.body)).toEqual([w.bravo.id, w.charlie.id]);
    expect(page.total).toBe(5);
  });

  it('sends the wallet and the 30-day figures only to a caller who holds wallet:read, and no wallet for a guest', async () => {
    const world0 = await world((await reader()).staffId);
    const without = (await (await reader()).get('/admin/clients')).body as Array<Record<string, unknown>>;
    for (const row of without) {
      expect(row).not.toHaveProperty('wallet');
      expect(row).not.toHaveProperty('stats');
    }
    const withFinance = (await (await finance()).get('/admin/clients')).body as Array<
      Record<string, unknown> & { id: number }
    >;
    const byId = new Map(withFinance.map((row) => [row.id, row]));
    expect(byId.get(world0.alpha.id)?.wallet).toEqual({
      kind: 'merchant',
      balance: '100.0000',
      reserved: '0.0000',
      creditLimit: '0.0000',
      available: '100.0000',
      frozen: false,
    });
    expect(byId.get(world0.charlie.id)?.wallet).toMatchObject({ kind: 'store', balance: '70.0000', frozen: false });
    expect(byId.get(world0.echo.id)).not.toHaveProperty('wallet');
    for (const row of withFinance) expect(row.stats).toMatchObject({ orders: expect.any(Number) });
  });

  it('answers the row of the wire: the rank, the login facts, the order figures, the suspension and who made it', async () => {
    const api = await reader();
    const w = await world(api.staffId);
    const rows = new Map(((await api.get('/admin/clients')).body as Array<{ id: number }>).map((row) => [row.id, row]));
    expect(rows.get(w.alpha.id)).toMatchObject({
      name: 'Alpha Mobile',
      company: 'Alpha Trading',
      username: 'alpha',
      country: 'JO',
      status: 'active',
      rank: { id: w.gold, name: 'Gold', kind: 'merchant', discountPercent: '8.0000', creditAllowed: true },
      hasAccount: true,
      invitationPending: false,
      createdBy: { id: api.staffId, name: 'Rami K.' },
      suspension: null,
      anonymizedAt: null,
      ordersCount: 3,
      lastOrderAt: '2026-11-02T08:00:00.000Z',
      security: { hasPassword: true, activeSessions: 0, linkSentAt: null },
    });
    expect(rows.get(w.bravo.id)).toMatchObject({
      status: 'suspended',
      suspension: { at: '2026-03-01T10:00:00.000Z', reason: 'Chargebacks', by: { id: api.staffId, name: 'Rami K.' } },
      security: { hasPassword: false },
    });
    expect(rows.get(w.charlie.id)).toMatchObject({
      username: null,
      rank: { id: w.retail, kind: 'retail', creditAllowed: false },
      invitationPending: true,
      createdBy: null,
    });
    expect(rows.get(w.echo.id)).toMatchObject({ hasAccount: false, username: null, security: null });
    for (const row of rows.values()) {
      expect(row).not.toHaveProperty('groupId');
      expect(row).not.toHaveProperty('group');
      expect(JSON.stringify(row)).not.toMatch(/passwordHash|totp|notificationPrefs/i);
    }
  });

  it('refuses a request with no permission and a parameter the list does not have', async () => {
    const api = await reader();
    await world(api.staffId);
    const none = await adminWith(t, ['orders:read']);
    expect((await none.get('/admin/clients')).status).toBe(403);
    expect((await api.anonymous('GET', '/admin/clients')).status).toBe(401);
    expect((await api.get('/admin/clients?groupId=1')).status).toBe(422);
  });
});

describe('GET /admin/clients/:id', () => {
  it('shows any account: a merchant, a retail account, a guest, a suspended and a blocked one', async () => {
    const api = await reader();
    const w = await world(api.staffId);
    for (const account of [w.alpha, w.bravo, w.charlie, w.delta, w.echo]) {
      const res = await api.get(`/admin/clients/${account.id}`);
      expect(res.status, String(account.id)).toBe(200);
      expect(res.body).toMatchObject({ id: account.id, email: account.email });
    }
    const listed = ((await api.get('/admin/clients')).body as Array<{ id: number }>).find(
      (row) => row.id === w.bravo.id,
    );
    expect((await api.get(`/admin/clients/${w.bravo.id}`)).body).toEqual(listed);
  });

  it('answers 404 for an id nobody has and does not mistake the counts for an id', async () => {
    const api = await reader();
    await world(api.staffId);
    expect((await api.get('/admin/clients/999999')).status).toBe(404);
    const counts = await api.get('/admin/clients/counts');
    expect(counts.status).toBe(200);
    expect(counts.body).toMatchObject({ all: 5 });
  });

  it('sends the wallet to a caller with wallet:read and none to a caller without it', async () => {
    const w = await world((await reader()).staffId);
    const plain = await (await reader()).get(`/admin/clients/${w.alpha.id}`);
    expect(plain.body).not.toHaveProperty('wallet');
    const rich = await (await finance()).get(`/admin/clients/${w.alpha.id}`);
    expect(rich.body.wallet).toMatchObject({ kind: 'merchant', balance: '100.0000' });
  });
});

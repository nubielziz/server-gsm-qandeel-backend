// Integration tests of refunds after a rank change (decision 064): a refund always credits the account's live wallet or goes
// back through the gateway, under the key it always had, and is never refused because the rank changed. A balance-paid shop order of an account that
// holds a merchant rank now is refunded to its merchant wallet and the store balance stays as it was; what is left to refund counts the lines of
// both wallets (`ledgerPartsOf`) and the payments report counts them too (`fundingOf`); a completed order of a merchant door refunded after the
// account became a retail account credits the store balance under `reverse:<settlement>`; a reopen of it is refused (409 `RANK_CHANGED`). The rank
// change route is the money module's own: these tests write the rank row the use case would write (the account's `group_id`).
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { and, eq, sql } from 'drizzle-orm';
import { type Database, schema as s } from '@src/infra/db';
import { type AdminApi, adminWith } from '../../support/admin-api';
import { ensureMerchantGroup, ensureRetailGroup } from '../../support/accounts';
import { type TestApp, createTestApp } from '../../support/app';
import { clearIdentityCaches } from '../../support/auth';
import { json } from '../../support/b2c';
import { TestClock } from '../../support/clock';
import {
  customerWalletRow,
  fundCustomer,
  insertWalletTemplates,
  openSignedInCheckout,
  payFromBalance,
  walletSettings,
} from '../../support/customer-wallet';
import { closeTestDb, resetDb, testDb } from '../../support/db';
import { ledgerTotals } from '../../support/money';
import { notificationRows, seedDefaultTemplates } from '../../support/notifications';
import {
  IMEIS,
  type OrdersWorld,
  eventsOf,
  ledgerOf,
  orderRow,
  ordersWorld,
  portalFor,
  json as orderJson,
  systemBalance,
} from '../../support/orders';
import { freshClientIp } from '../../support/pipeline-routes';
import { type StorefrontWorld, storefrontWorld } from '../../support/storefront';
import { STORE_ORIGIN, StoreClient, clearStoreRateLimits, makeCustomer } from '../../support/store';

const clock = new TestClock('2026-11-10T12:00:00.000Z');
let t: TestApp;
let db: Database;
let staff: AdminApi;

beforeAll(async () => {
  ({ db } = await testDb());
  t = await createTestApp({ clock, env: { SHOP_ORIGINS: STORE_ORIGIN } });
});
afterAll(async () => {
  await resetDb();
  await t.close();
  await closeTestDb();
});
beforeEach(async () => {
  clock.set('2026-11-10T12:00:00.000Z');
  await resetDb();
  await clearIdentityCaches(t);
  await clearStoreRateLimits(t);
  staff = await adminWith(t, ['refunds:*', 'orders:*', 'reports:*'], { name: 'Layla Haddad' });
});

/**
 * Gives an account the rank of a kind, as the rank change would write it: the account's `group_id` (a merchant rank also needs its username).
 *
 * @param accountId the account
 * @param kind the rank kind it holds from now on
 */
async function crossTo(accountId: number, kind: 'merchant' | 'retail'): Promise<void> {
  const groupId = kind === 'merchant' ? await ensureMerchantGroup(db) : await ensureRetailGroup(db);
  await db
    .update(s.clients)
    .set({ groupId, ...(kind === 'merchant' ? { username: `crossed-${accountId}` } : {}) })
    .where(eq(s.clients.id, accountId));
  await clearIdentityCaches(t);
}

/** The ledger account of an account's wallet of a kind, or `undefined` when it was never opened. */
async function walletOfKind(accountId: number, kind: 'client_wallet' | 'customer_wallet') {
  const [row] = await db
    .select()
    .from(s.ledgerAccounts)
    .where(
      and(
        eq(s.ledgerAccounts.kind, kind),
        eq(s.ledgerAccounts.ownerType, 'account'),
        eq(s.ledgerAccounts.ownerId, accountId),
      ),
    );
  return row;
}

/** The lines of one journal by its key: account kind, owner and signed amount (debit above zero), sorted by kind. */
async function journal(key: string): Promise<Array<{ account: string; owner: string | null; amount: string }>> {
  const result = await db.execute<{ account: string; owner: string | null; amount: string }>(
    sql`select a.kind as account, case when a.owner_id is null then null else a.owner_type || ':' || a.owner_id end as owner, e.amount::text as amount
        from ledger_entries e join ledger_accounts a on a.id = e.account_id
        join ledger_transactions x on x.id = e.transaction_id
        where x.idempotency_key = ${key} order by a.kind`,
  );
  return result.rows;
}

const mailsOf = async (event: string) => (await notificationRows(db)).filter((row) => row.event === event);
const paymentStatus = async (id: number) =>
  (await db.select().from(s.payments).where(eq(s.payments.id, id)))[0]!.status;

describe('a balance-paid shop order refunded after the account crossed to the merchant rank', () => {
  let world: StorefrontWorld;

  beforeEach(async () => {
    world = await storefrontWorld(db);
    await walletSettings(t, db);
    await seedDefaultTemplates(db);
    await insertWalletTemplates(db);
  });

  /** An order of the iCloud check (net 3.99 + VAT 0.80 = 4.79 USD, 3.84 GBP) paid from a balance of 50, delivered when asked. */
  async function balanceOrder(options: { deliver?: boolean } = {}) {
    const customer = await makeCustomer(t, { name: 'Daniel Rivera' });
    const client = new StoreClient(t, freshClientIp());
    expect((await client.login(customer.email)).statusCode).toBe(200);
    await fundCustomer(db, customer.id, '50');
    const { token } = await openSignedInCheckout(client, world, customer.email);
    const res = await payFromBalance(client, token);
    expect(res.statusCode).toBe(201);
    const body = json(res);
    if (options.deliver) {
      expect((await staff.post(`/admin/orders/${body.order.id}/reply`, { code: 'Clean' })).status).toBe(204);
    }
    return { accountId: customer.id, orderId: body.order.id as number, paymentId: body.payment.id as number };
  }

  /** The buyer's refund request for part of the payment (the request route belongs to the support feature). */
  async function request(paid: { accountId: number; orderId: number; paymentId: number }, amount: string) {
    const [row] = await db
      .insert(s.refunds)
      .values({
        paymentId: paid.paymentId,
        orderId: paid.orderId,
        accountId: paid.accountId,
        amount,
        currency: 'GBP',
        reason: 'The result was wrong',
        method: 'original',
        status: 'requested',
        requestedByType: 'account',
        requestedById: paid.accountId,
        createdAt: clock.now(),
        updatedAt: clock.now(),
      })
      .returning();
    return row!;
  }

  it('credits the merchant wallet, never the store balance; the second part cannot exceed what is left, and the report ties to the books', async () => {
    const paid = await balanceOrder({ deliver: true });
    expect((await customerWalletRow(db, paid.accountId))!.balance).toBe('45.2100');
    await crossTo(paid.accountId, 'merchant');

    const first = await request(paid, '0.8000');
    const one = await staff.post(`/admin/refunds/${first.id}/approve`, { amount: '1.00' });
    expect(one.status).toBe(200);
    // The same conversion as a card: 1.00 USD is 0.80 GBP, which is 0.9977 USD again; it went to the wallet of the rank held now.
    expect(one.body).toMatchObject({
      status: 'completed',
      amount: '0.9977',
      partial: true,
      payment: { method: 'balance' },
    });
    const lines = await journal(`refund:${first.id}`);
    expect(lines.map((line) => line.account)).toEqual(['client_wallet', 'revenue', 'vat_payable']);
    expect(lines.find((line) => line.account === 'client_wallet')).toEqual({
      account: 'client_wallet',
      owner: `account:${paid.accountId}`,
      amount: '-0.9977',
    });
    expect((await walletOfKind(paid.accountId, 'client_wallet'))!.balance).toBe('0.9977');
    // The timeline says which wallet took it.
    expect((await eventsOf(db, paid.orderId)).at(-1)!.data).toMatchObject({
      message: expect.stringMatching(/returned to the merchant wallet$/),
    });
    // The store balance stays as the payment left it: the inactive wallet is never credited.
    expect((await customerWalletRow(db, paid.accountId))!.balance).toBe('45.2100');
    expect(await paymentStatus(paid.paymentId)).toBe('partial_refund');

    // What went back on the merchant wallet line counts as refunded: the second part may take only what is left.
    const second = await request(paid, '4.0000');
    const refused = await staff.post(`/admin/refunds/${second.id}/approve`, { amount: '4.00' });
    expect(refused.status).toBe(422);
    expect(refused.body.errors[0]).toMatchObject({
      field: 'amount',
      message: 'Enter an amount between $0.01 and $3.7923.',
    });
    expect((await staff.post(`/admin/refunds/${second.id}/approve`, { amount: '3.7923' })).status).toBe(200);
    expect(await paymentStatus(paid.paymentId)).toBe('refunded');
    expect((await walletOfKind(paid.accountId, 'client_wallet'))!.balance).toBe('4.7900');
    expect((await customerWalletRow(db, paid.accountId))!.balance).toBe('45.2100');
    expect(await systemBalance(db, 'revenue')).toBe('0.0000');
    expect(await systemBalance(db, 'vat_payable')).toBe('0.0000');
    expect((await ledgerTotals(db)).sum).toBe('0.0000');
    // Nothing is left to refund, whichever wallet took the money.
    const more = await request(paid, '0.0100');
    expect((await staff.post(`/admin/refunds/${more.id}/approve`, {})).status).toBe(422);

    // The payments report reads both wallets' lines (fundingOf): its refunded amount is exactly what the two journals returned, not a conversion.
    const report = await staff.get('/admin/reports/payments');
    expect(report.status).toBe(200);
    expect(report.body.totals).toMatchObject({ refundedCount: 2, refundedAmount: '4.7900' });
    // The merchant-wallet refund writes no store-balance mail: that text would be wrong for it.
    expect(await mailsOf('wallet.order_refunded')).toHaveLength(0);
  });

  it('an account that stayed retail still gets the store balance and its mail', async () => {
    const paid = await balanceOrder({ deliver: true });
    const refund = await request(paid, '3.8400');
    expect((await staff.post(`/admin/refunds/${refund.id}/approve`, {})).status).toBe(200);
    expect((await journal(`refund:${refund.id}`)).find((line) => line.account === 'customer_wallet')).toEqual({
      account: 'customer_wallet',
      owner: `account:${paid.accountId}`,
      amount: '-4.7900',
    });
    expect((await customerWalletRow(db, paid.accountId))!.balance).toBe('50.0000');
    expect(await walletOfKind(paid.accountId, 'client_wallet')).toBeUndefined();
    expect(await mailsOf('wallet.order_refunded')).toHaveLength(1);
  });

  it('a decided refund stays as it was after the crossing: a second approval is refused and posts nothing', async () => {
    const paid = await balanceOrder({ deliver: true });
    const refund = await request(paid, '3.8400');
    expect((await staff.post(`/admin/refunds/${refund.id}/approve`, {})).status).toBe(200);
    const before = await journal(`refund:${refund.id}`);
    await crossTo(paid.accountId, 'merchant');
    // The refund is decided; a second approval is refused and nothing moves, whichever rank the account holds now.
    expect((await staff.post(`/admin/refunds/${refund.id}/approve`, {})).status).toBe(409);
    expect(await journal(`refund:${refund.id}`)).toEqual(before);
    expect(await walletOfKind(paid.accountId, 'client_wallet')).toBeUndefined();
    expect((await ledgerTotals(db)).sum).toBe('0.0000');
  });
});

describe('a completed order of a merchant door after the account crossed to the retail rank', () => {
  let world: OrdersWorld;

  beforeEach(async () => {
    world = await ordersWorld(db);
  });

  /** Places an order through the portal and completes it by a staff reply: the revenue is recognised, the settlement is the one to reverse. */
  async function completed(): Promise<number> {
    const res = await (
      await portalFor(t, world.merchant.id)
    ).post('/client/orders', {
      serviceId: world.auto.serviceId,
      imei: IMEIS[0],
    });
    expect(res.statusCode).toBe(201);
    const id = orderJson(res).orders[0].id as number;
    expect((await staff.post(`/admin/orders/${id}/reply`, { code: 'Done' })).status).toBe(204);
    return id;
  }

  it('a staff refund credits the store balance under reverse:<settlement>, and a second refund is refused', async () => {
    const id = await completed();
    const [settle] = await db
      .select({ id: s.ledgerTransactions.id })
      .from(s.ledgerTransactions)
      .where(eq(s.ledgerTransactions.idempotencyKey, `order:${id}:settle`));
    await crossTo(world.merchant.id, 'retail');

    const res = await staff.post(`/admin/orders/${id}/refund`, { reason: 'The merchant was charged twice' });
    expect(res.status).toBe(204);
    const key = `reverse:${settle!.id}`;
    expect((await ledgerOf(db, id)).at(-1)).toEqual({ kind: 'refund', key });
    const lines = await journal(key);
    expect(lines).toEqual([
      { account: 'customer_wallet', owner: `account:${world.merchant.id}`, amount: '-17.2800' },
      { account: 'revenue', owner: null, amount: '17.2800' },
    ]);
    expect((await customerWalletRow(db, world.merchant.id))!.balance).toBe('17.2800');
    expect(await orderRow(db, id)).toMatchObject({ status: 'rejected' });
    expect((await ledgerTotals(db)).sum).toBe('0.0000');
    // The one guard against a second refund is the key and the order's final status.
    const again = await staff.post(`/admin/orders/${id}/refund`, { reason: 'x' });
    expect(again.status).toBe(409);
    expect(again.body).toMatchObject({ code: 'ORDER_NOT_COMPLETED' });
    expect((await journal(key)).length).toBe(2);
  });

  it('a reopen is refused with 409 RANK_CHANGED, and nothing changes', async () => {
    const id = await completed();
    const before = await ledgerOf(db, id);
    await crossTo(world.merchant.id, 'retail');

    const res = await staff.post(`/admin/orders/${id}/reopen`, { reason: 'The code did not work' });
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ code: 'RANK_CHANGED', detail: 'Refund the order instead.' });
    expect(await orderRow(db, id)).toMatchObject({ status: 'completed' });
    expect(await ledgerOf(db, id)).toEqual(before);
    expect((await eventsOf(db, id)).at(-1)!.type).not.toBe('reopened');
  });

  it('while the account still holds the merchant rank the refund credits the merchant wallet, as before', async () => {
    const id = await completed();
    expect((await staff.post(`/admin/orders/${id}/refund`, { reason: 'The merchant was charged twice' })).status).toBe(
      204,
    );
    expect((await walletOfKind(world.merchant.id, 'client_wallet'))!.balance).toBe('100.0000');
    expect(await walletOfKind(world.merchant.id, 'customer_wallet')).toBeUndefined();
  });
});

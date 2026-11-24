// Integration tests of refunds and the erasure of their account (decision 064). Lock order: a refund approval takes the buyer's account row
// first, before the order, as the erasure does (the account row, then the account's shop orders), so the two never wait for each other in a
// cycle. After the erasure: nobody can sign in to the account any more, so no refund may credit its wallet (any write on an anonymized
// account is 409 ANONYMIZED): the approval of a refund of a balance payment and a staff refund of a completed order of a merchant door are
// refused, and nothing moves.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { and, eq, sql } from 'drizzle-orm';
import { type Database, type Transaction, schema as s } from '@src/infra/db';
import { type AdminApi, adminWith } from '../../support/admin-api';
import { ensureRetailGroup } from '../../support/accounts';
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
import { seedDefaultTemplates } from '../../support/notifications';
import {
  IMEIS,
  type OrdersWorld,
  ledgerOf,
  orderRow,
  ordersWorld,
  portalFor,
  json as orderJson,
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
  staff = await adminWith(t, ['refunds:*', 'orders:*', 'customers:privacy', 'clients:read'], { name: 'Layla Haddad' });
});

/** The lines of one journal by its key. */
async function journal(key: string): Promise<Array<{ account: string; amount: string }>> {
  const result = await db.execute<{ account: string; amount: string }>(
    sql`select a.kind as account, e.amount::text as amount
        from ledger_entries e join ledger_accounts a on a.id = e.account_id
        join ledger_transactions x on x.id = e.transaction_id
        where x.idempotency_key = ${key} order by a.kind`,
  );
  return result.rows;
}

const refundRow = async (id: number) => (await db.select().from(s.refunds).where(eq(s.refunds.id, id)))[0]!;

/** Waits until a transaction of the test database waits for a lock. */
async function untilALockWaits(): Promise<void> {
  for (let round = 0; round < 150; round++) {
    const result = await db.execute<{ n: number }>(sql`select count(*)::int as n from pg_locks where not granted`);
    if ((result.rows[0]?.n ?? 0) > 0) return;
    await Bun.sleep(20);
  }
  throw new Error('No transaction waited for a lock.');
}

describe('a refund of a balance-paid shop order and the erasure of its account', () => {
  let world: StorefrontWorld;

  beforeEach(async () => {
    world = await storefrontWorld(db);
    await walletSettings(t, db);
    await seedDefaultTemplates(db);
    await insertWalletTemplates(db);
  });

  /** An order of the iCloud check (4.79 USD with VAT) paid from the balance and delivered; the balance is funded with `funds`. */
  async function deliveredBalanceOrder(funds: string) {
    const customer = await makeCustomer(t, { name: 'Daniel Rivera' });
    const client = new StoreClient(t, freshClientIp());
    expect((await client.login(customer.email)).statusCode).toBe(200);
    await fundCustomer(db, customer.id, funds);
    const { token } = await openSignedInCheckout(client, world, customer.email);
    const res = await payFromBalance(client, token);
    expect(res.statusCode).toBe(201);
    const body = json(res);
    expect((await staff.post(`/admin/orders/${body.order.id}/reply`, { code: 'Clean' })).status).toBe(204);
    return { accountId: customer.id, orderId: body.order.id as number, paymentId: body.payment.id as number };
  }

  /** A refund request for the payment, as the buyer or staff open one (the request route belongs to the support feature). */
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

  it('an approval waits for the account row before it takes the order, so an erasure holding the row can lock the orders and nothing deadlocks', async () => {
    const paid = await deliveredBalanceOrder('50');
    const refund = await request(paid, '3.8400');
    let locked!: () => void;
    const hasLock = new Promise<void>((resolve) => (locked = resolve));
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    // The erasure's order: the account row FOR UPDATE, then the account's shop orders FOR UPDATE (it erases their IMEIs).
    const erasure = db.transaction(async (tx: Transaction) => {
      await tx.execute(sql`set local lock_timeout = '5s'`);
      await tx.execute(sql`select id from clients where id = ${paid.accountId} for update`);
      locked();
      await gate;
      await tx.execute(sql`select id from orders where account_id = ${paid.accountId} and source = 'store' for update`);
    });
    await hasLock;
    const approval = staff.post(`/admin/refunds/${refund.id}/approve`, {});
    try {
      await untilALockWaits();
    } finally {
      release();
    }
    const held = await erasure.then(
      () => 'committed',
      (error: unknown) => error,
    );
    const res = await approval;
    expect(held).toBe('committed');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: 'completed' });
    expect((await customerWalletRow(db, paid.accountId))!.balance).toBe('50.0000');
  });

  it('after the erasure, the approval of a refund to the balance is 409 ANONYMIZED: the request still waits and nothing moves', async () => {
    // Funded with the price exactly: the balance is zero after the payment, so the erasure is allowed.
    const paid = await deliveredBalanceOrder('4.79');
    expect((await customerWalletRow(db, paid.accountId))!.balance).toBe('0.0000');
    expect((await staff.post(`/admin/clients/${paid.accountId}/anonymize`)).status).toBe(204);
    const refund = await request(paid, '3.8400');

    const res = await staff.post(`/admin/refunds/${refund.id}/approve`, {});
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({
      code: 'ANONYMIZED',
      detail:
        'This account was erased, so nothing can go back to its wallet. Pay the money back another way, then decline the refund.',
    });
    expect(await refundRow(refund.id)).toMatchObject({ status: 'requested', ledgerTxId: null, approvedBy: null });
    expect(await journal(`refund:${refund.id}`)).toEqual([]);
    expect((await customerWalletRow(db, paid.accountId))!.balance).toBe('0.0000');
    expect((await ledgerTotals(db)).sum).toBe('0.0000');
    // Staff decline it once they paid the money back another way.
    const declined = await staff.post(`/admin/refunds/${refund.id}/decline`, { reason: 'Paid back by bank transfer.' });
    expect(declined.status).toBe(200);
    expect(declined.body).toMatchObject({ status: 'rejected' });
  });
});

describe('a completed order of a merchant door after the account was lowered to the retail rank and erased', () => {
  let world: OrdersWorld;

  beforeEach(async () => {
    world = await ordersWorld(db);
  });

  /**
   * Gives the account the retail rank and the erased state, as the rank change and the anonymize use case write them (the account row;
   * the balances are not the point here).
   */
  async function lowerAndErase(accountId: number): Promise<void> {
    await db
      .update(s.clients)
      .set({
        groupId: await ensureRetailGroup(db),
        status: 'anonymized',
        anonymizedAt: clock.now(),
        name: 'Deleted account',
        email: `deleted-account-${accountId}@redacted.invalid`,
        hasAccount: false,
        username: null,
        passwordHash: null,
        totpSecretEnc: null,
        twofaEnabled: false,
      })
      .where(eq(s.clients.id, accountId));
    await clearIdentityCaches(t);
  }

  it('a staff refund is 409 ANONYMIZED: the order stays completed and no wallet is credited', async () => {
    const placed = await (
      await portalFor(t, world.merchant.id)
    ).post('/client/orders', {
      serviceId: world.auto.serviceId,
      imei: IMEIS[0],
    });
    expect(placed.statusCode).toBe(201);
    const id = orderJson(placed).orders[0].id as number;
    expect((await staff.post(`/admin/orders/${id}/reply`, { code: 'Done' })).status).toBe(204);
    const before = await ledgerOf(db, id);
    await lowerAndErase(world.merchant.id);

    const res = await staff.post(`/admin/orders/${id}/refund`, { reason: 'The merchant was charged twice' });
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({
      code: 'ANONYMIZED',
      detail: 'This account was erased, so no money can move on its wallet. Pay a refund back another way.',
    });
    expect(await orderRow(db, id)).toMatchObject({ status: 'completed' });
    expect(await ledgerOf(db, id)).toEqual(before);
    const [store] = await db
      .select()
      .from(s.ledgerAccounts)
      .where(
        and(
          eq(s.ledgerAccounts.kind, 'customer_wallet'),
          eq(s.ledgerAccounts.ownerType, 'account'),
          eq(s.ledgerAccounts.ownerId, world.merchant.id),
        ),
      );
    expect(store?.balance ?? '0.0000').toBe('0.0000');
    expect((await ledgerTotals(db)).sum).toBe('0.0000');
  });
});

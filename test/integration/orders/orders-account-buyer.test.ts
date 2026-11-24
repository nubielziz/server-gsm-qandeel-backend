// Integration tests of the order engine under one account type (decision 064): the
// buyer of every order is an account (`account_id`) and the door (`source`) decides the money path, never the rank the account has today.
// Placement from a wallet locks the account row first and refuses a retail rank, an account that may not act and a frozen merchant wallet
// before it writes anything; a refund credits the wallet that is live now and a reopen after a crossing is refused (409 RANK_CHANGED); the
// `live_order` blocker of the rank change sees every order in flight. Real Postgres and Redis.
import { afterAll, beforeAll, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { and, eq } from 'drizzle-orm';
import { Money } from '@src/common/money';
import { DbService, type Database, schema as s } from '@src/infra/db';
import { AccountDirectory } from '@src/modules/identity';
import { AccountWallets, RankChangeGuards, b2cPay, postTransaction } from '@src/modules/money';
import {
  OrderPlacement,
  OrderTransitions,
  rewriteCustomerOrderInputs,
  type TransitionRequest,
} from '@src/modules/orders';
import { LiveOrdersGuard } from '@src/modules/orders/application/live-orders-guard';
import { ensureMerchantGroup, ensureRetailGroup, makeAccount } from '../../support/accounts';
import { type TestApp, createTestApp } from '../../support/app';
import { clearIdentityCaches } from '../../support/auth';
import { rejectionOf } from '../../support/rejection';
import { TestClock } from '../../support/clock';
import { closeTestDb, resetDb, testDb } from '../../support/db';
import { seedDefaultTemplates } from '../../support/notifications';
import { accountFigures, ledgerTotals } from '../../support/money';
import {
  IMEIS,
  type OrdersWorld,
  eventsOf,
  insertOrderRow,
  ledgerOf,
  orderRow,
  ordersWorld,
  outboxOf,
  systemBalance,
  walletOf,
} from '../../support/orders';

const clock = new TestClock('2026-11-24T12:00:00.000Z');
let t: TestApp;
let db: Database;
let world: OrdersWorld;
let dbService: DbService;
let placement: OrderPlacement;
let transitions: OrderTransitions;
let directory: AccountDirectory;

beforeAll(async () => {
  ({ db } = await testDb());
  t = await createTestApp({ clock });
  dbService = t.app.get(DbService);
  placement = t.app.get(OrderPlacement);
  transitions = t.app.get(OrderTransitions);
  directory = t.app.get(AccountDirectory);
});
afterAll(async () => {
  await resetDb();
  await t.close();
  await closeTestDb();
});
beforeEach(async () => {
  clock.set('2026-11-24T12:00:00.000Z');
  await resetDb();
  await clearIdentityCaches(t);
  world = await ordersWorld(db);
  await seedDefaultTemplates(db);
});

/** Places one IMEI order of the automatic service from a wallet, the way the portal and Dhru do. */
function place(accountId: number, serviceId = world.auto.serviceId, imei: string = IMEIS[0]) {
  return dbService.runInTransaction(({ tx }) =>
    placement.place(tx, {
      accountId,
      source: 'portal',
      serviceId,
      items: [{ imei, inputs: {}, imeiField: 'imei' }],
      actor: { type: 'account', id: accountId },
    }),
  );
}

type Request = Parameters<OrderTransitions['apply']>[1];

/** Applies one action to one order in its own transaction; staff act unless the request names another actor. */
function apply(request: Omit<Request, 'actor'> & { actor?: TransitionRequest['actor'] }) {
  return dbService.runInTransaction(({ tx }) => transitions.apply(tx, { actor: { type: 'staff', id: 1 }, ...request }));
}

/** Places an order and delivers it, so it is completed with its revenue booked. */
async function completedOrder(accountId = world.merchant.id): Promise<number> {
  const [placed] = await place(accountId);
  await apply({ orderId: placed!.id, action: { kind: 'reply' }, code: 'Unlocked' });
  return placed!.id;
}

/** Moves an account to the one retail rank, as a rank change would (the route itself is the money module's). */
async function crossToRetail(accountId: number): Promise<void> {
  await db
    .update(s.clients)
    .set({ groupId: await ensureRetailGroup(db) })
    .where(eq(s.clients.id, accountId));
}

/** The counts that must not move when a placement is refused. */
async function footprint() {
  return {
    orders: (await db.select().from(s.orders)).length,
    events: (await db.select().from(s.orderEvents)).length,
    outbox: (await db.select().from(s.outboxEvents)).length,
    ledger: await ledgerTotals(db),
  };
}

describe('placement from a wallet', () => {
  it('writes the buyer account and the merchant column, holds the price and records the account as the actor', async () => {
    const [order] = await place(world.merchant.id);
    const row = await orderRow(db, order!.id);
    expect(row).toMatchObject({
      accountId: world.merchant.id,
      legacyClientId: world.merchant.id,
      retiredCustomerId: null,
      source: 'portal',
      status: 'pending',
    });
    // The rank the account held when it ordered is kept with the price, for support.
    expect(row.pricingSnapshot).toMatchObject({ rankId: expect.any(Number) });
    expect((await eventsOf(db, row.id)).map((event) => [event.type, event.actorType])).toEqual([
      ['created', 'account'],
      ['hold', 'system'],
    ]);
    expect(await ledgerOf(db, row.id)).toEqual([{ kind: 'order_hold', key: `order:${row.id}:hold` }]);
    expect(await walletOf(db, world.merchant.id)).toEqual({ wallet: '82.7200', hold: '17.2800' });
    const [hold] = await db
      .select()
      .from(s.ledgerTransactions)
      .where(eq(s.ledgerTransactions.idempotencyKey, `order:${row.id}:hold`));
    expect(hold).toMatchObject({ createdByType: 'account', createdById: world.merchant.id });
  });

  it('refuses an account of the retail rank with 403 RANK_NOT_ALLOWED and writes nothing', async () => {
    const shopper = await makeAccount({ rank: 'retail', db });
    const before = await footprint();
    expect(await rejectionOf(place(shopper.id))).toMatchObject({ code: 'RANK_NOT_ALLOWED', status: 403 });
    expect(await footprint()).toEqual(before);
  });

  it('refuses an account that may not act (suspended, blocked, anonymized) with 403 ACCOUNT_SUSPENDED and writes nothing', async () => {
    const before = await footprint();
    for (const status of ['suspended', 'blocked', 'anonymized'] as const) {
      // An anonymized row carries the time it was anonymized (clients_anonymized_check), the other two none.
      await db
        .update(s.clients)
        .set({ status, anonymizedAt: status === 'anonymized' ? new Date() : null })
        .where(eq(s.clients.id, world.merchant.id));
      expect(await rejectionOf(place(world.merchant.id)), status).toMatchObject({
        code: 'ACCOUNT_SUSPENDED',
        status: 403,
      });
    }
    expect(await footprint()).toEqual(before);
  });

  it('refuses a frozen merchant wallet with 409 WALLET_FROZEN through AccountWallets.assertNotFrozen, after the account row lock and before the hold', async () => {
    const wallets = t.app.get(AccountWallets);
    const asked = spyOn(wallets, 'assertNotFrozen');
    await db
      .update(s.ledgerAccounts)
      .set({ frozenAt: new Date(), frozenReason: 'Chargeback of a top-up' })
      .where(
        and(
          eq(s.ledgerAccounts.kind, 'client_wallet'),
          eq(s.ledgerAccounts.ownerType, 'account'),
          eq(s.ledgerAccounts.ownerId, world.merchant.id),
        ),
      );
    const before = await footprint();
    expect(await rejectionOf(place(world.merchant.id))).toMatchObject({ code: 'WALLET_FROZEN', status: 409 });
    expect(asked).toHaveBeenCalledTimes(1);
    expect(asked.mock.calls[0]![1]).toBe(world.merchant.id);
    expect(await footprint()).toEqual(before);
    // Lifting the freeze lets the next order through.
    await db
      .update(s.ledgerAccounts)
      .set({ frozenAt: null, frozenReason: '' })
      .where(and(eq(s.ledgerAccounts.kind, 'client_wallet'), eq(s.ledgerAccounts.ownerId, world.merchant.id)));
    expect(await place(world.merchant.id)).toHaveLength(1);
    asked.mockRestore();
  });

  it('refuses an account that does not exist with 401 UNAUTHORIZED', async () => {
    expect(await rejectionOf(place(987_654))).toMatchObject({ code: 'UNAUTHORIZED' });
  });

  it('waits for a rank change that holds the account row, then refuses the retail rank it left behind', async () => {
    const retailRank = await ensureRetailGroup(db);
    let release!: () => void;
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    let locked!: () => void;
    const lockedFirst = new Promise<void>((resolve) => {
      locked = resolve;
    });
    const crossing = dbService.runInTransaction(async ({ tx }) => {
      await directory.lockForUpdate(tx, world.merchant.id);
      await tx.update(s.clients).set({ groupId: retailRank }).where(eq(s.clients.id, world.merchant.id));
      locked();
      await hold;
    });
    await lockedFirst;
    let settled = false;
    const placing = place(world.merchant.id).then(
      () => {
        settled = true;
        return undefined;
      },
      (error: unknown) => {
        settled = true;
        return error;
      },
    );
    await sleep(250);
    expect(settled).toBe(false);
    release();
    await crossing;
    expect(await placing).toMatchObject({ code: 'RANK_NOT_ALLOWED' });
    expect(await db.select().from(s.orders)).toHaveLength(0);
  });
});

describe('a shop order: the door decides, never the rank', () => {
  /** A shop order that was paid first: it sits in the manual queue and its money is in customer funds. */
  async function paidShopOrder(accountId: number): Promise<number> {
    const order = await insertOrderRow(db, {
      accountId,
      serviceId: world.manual.serviceId,
      source: 'store',
      status: 'pending',
      dispatchState: 'manual',
      unitPrice: '12.0000',
      totalPrice: '12.0000',
    });
    await db.transaction((tx) =>
      postTransaction(
        tx,
        {
          ...b2cPay({ net: Money.of('12'), vat: Money.zero() }),
          refId: order.id,
          idempotencyKey: `test:pay:${order.id}`,
          currency: 'USD',
          createdBy: { type: 'system', id: null },
        },
        new Date(),
      ),
    );
    return order.id;
  }

  it('settles through customer funds with no hold, and its status change names the account and the door, not a merchant', async () => {
    const buyer = await makeAccount({ rank: 'retail', db });
    const id = await paidShopOrder(buyer.id);
    expect(await orderRow(db, id)).toMatchObject({ accountId: buyer.id, legacyClientId: null, source: 'store' });
    await apply({ orderId: id, action: { kind: 'reply' }, code: 'Unlocked' });
    expect((await ledgerOf(db, id)).map((entry) => entry.key)).toEqual([`test:pay:${id}`, `order:${id}:settle`]);
    expect(await systemBalance(db, 'customer_funds')).toBe('0.0000');
    expect(await systemBalance(db, 'revenue')).toBe('12.0000');
    expect(await walletOf(db, buyer.id)).toEqual({ wallet: '0.0000', hold: '0.0000' });
    const [event] = await outboxOf(db, 'order.status_changed', id);
    // The outbox adds its bookkeeping key `meta` (the request id; empty outside a request) to every payload.
    expect(event!.payload).toEqual({
      orderId: id,
      accountId: buyer.id,
      source: 'store',
      fromStatus: 'pending',
      toStatus: 'completed',
      meta: {},
    });
    expect(event!.payload).not.toHaveProperty('clientId');
  });

  it('still settles through customer funds when its account holds a merchant rank by the time it is delivered', async () => {
    const buyer = await makeAccount({ rank: 'retail', db });
    const id = await paidShopOrder(buyer.id);
    await db
      .update(s.clients)
      .set({ groupId: await ensureMerchantGroup(db) })
      .where(eq(s.clients.id, buyer.id));
    await apply({ orderId: id, action: { kind: 'reply' }, code: 'Unlocked' });
    expect((await ledgerOf(db, id)).map((entry) => entry.key)).toEqual([`test:pay:${id}`, `order:${id}:settle`]);
    expect(await systemBalance(db, 'customer_funds')).toBe('0.0000');
    expect(await accountFigures(db, 'client_hold', { type: 'account', id: buyer.id })).toBeUndefined();
  });

  it('is invisible to the portal that acts for the same account: a cancel of it is 404 and nothing moves', async () => {
    const buyer = await makeAccount({ rank: 'retail', db });
    const id = await paidShopOrder(buyer.id);
    const before = await ledgerOf(db, id);
    const refusal = await rejectionOf(
      apply({
        orderId: id,
        action: { kind: 'cancel' },
        actor: { type: 'account', id: buyer.id },
        onlyClientId: buyer.id,
      }),
    );
    expect(refusal).toMatchObject({ code: 'NOT_FOUND' });
    expect(await ledgerOf(db, id)).toEqual(before);
    expect((await orderRow(db, id)).status).toBe('pending');
  });

  it('writes the status change of an order held from a wallet with the same keys, the door portal', async () => {
    const [placed] = await place(world.merchant.id);
    await apply({ orderId: placed!.id, action: { kind: 'reply' }, code: 'Unlocked' });
    const [event] = await outboxOf(db, 'order.status_changed', placed!.id);
    expect(event!.payload).toEqual({
      orderId: placed!.id,
      accountId: world.merchant.id,
      source: 'portal',
      fromStatus: 'pending',
      toStatus: 'completed',
      meta: {},
    });
  });
});

describe('after the account changed rank', () => {
  it('credits a staff refund of a completed portal order to the store balance under reverse:<settlement>, once', async () => {
    const id = await completedOrder();
    const [settlement] = await db
      .select()
      .from(s.ledgerTransactions)
      .where(eq(s.ledgerTransactions.idempotencyKey, `order:${id}:settle`));
    await crossToRetail(world.merchant.id);
    const merchantWallet = await walletOf(db, world.merchant.id);

    await apply({ orderId: id, action: { kind: 'refund' }, reason: 'Wrong service' });

    expect((await ledgerOf(db, id)).map((entry) => entry.key)).toContain(`reverse:${settlement!.id}`);
    expect(await accountFigures(db, 'customer_wallet', { type: 'account', id: world.merchant.id })).toMatchObject({
      balance: '17.2800',
    });
    // Nothing lands on the wallet the account no longer uses.
    expect(await walletOf(db, world.merchant.id)).toEqual(merchantWallet);
    expect(await orderRow(db, id)).toMatchObject({ status: 'rejected' });
    // A second refund is refused and posts nothing.
    expect(await rejectionOf(apply({ orderId: id, action: { kind: 'refund' }, reason: 'Again' }))).toMatchObject({
      code: 'ORDER_NOT_COMPLETED',
    });
    expect(await accountFigures(db, 'customer_wallet', { type: 'account', id: world.merchant.id })).toMatchObject({
      balance: '17.2800',
    });
  });

  it('credits the same refund to the merchant wallet while the account still holds a merchant rank', async () => {
    const id = await completedOrder();
    await apply({ orderId: id, action: { kind: 'refund' }, reason: 'Wrong service' });
    expect(await walletOf(db, world.merchant.id)).toEqual({ wallet: '100.0000', hold: '0.0000' });
    expect(await accountFigures(db, 'customer_wallet', { type: 'account', id: world.merchant.id })).toBeUndefined();
  });

  it('refuses a reopen with 409 RANK_CHANGED ("Refund the order instead."), posts nothing and leaves the order completed', async () => {
    const id = await completedOrder();
    await crossToRetail(world.merchant.id);
    const before = await ledgerOf(db, id);
    const events = (await eventsOf(db, id)).length;
    expect(await rejectionOf(apply({ orderId: id, action: { kind: 'reopen' }, reason: 'Check again' }))).toMatchObject({
      code: 'RANK_CHANGED',
      status: 409,
      detail: 'Refund the order instead.',
    });
    expect(await orderRow(db, id)).toMatchObject({ status: 'completed' });
    expect(await ledgerOf(db, id)).toEqual(before);
    expect((await eventsOf(db, id)).length).toBe(events);
  });

  it('reopens while the account still holds a merchant rank: the revenue goes back to the hold', async () => {
    const id = await completedOrder();
    await apply({ orderId: id, action: { kind: 'reopen' }, reason: 'Check again' });
    expect(await orderRow(db, id)).toMatchObject({ status: 'processing' });
    expect(await walletOf(db, world.merchant.id)).toEqual({ wallet: '82.7200', hold: '17.2800' });
  });

  it('credits the refund of a verification request to the live wallet too', async () => {
    const id = await completedOrder();
    await apply({
      orderId: id,
      action: { kind: 'requestVerification' },
      actor: { type: 'account', id: world.merchant.id },
      onlyClientId: world.merchant.id,
    });
    await crossToRetail(world.merchant.id);
    await apply({ orderId: id, action: { kind: 'verification', decision: 'refund' } });
    expect(await accountFigures(db, 'customer_wallet', { type: 'account', id: world.merchant.id })).toMatchObject({
      balance: '17.2800',
    });
    expect(await orderRow(db, id)).toMatchObject({ status: 'rejected', verificationStatus: 'refunded' });
  });
});

describe('the account row lock of a money move (decision 064)', () => {
  /** Holds the account row FOR UPDATE, as a rank change does, until the returned function is called. */
  async function holdingRankChange(accountId: number) {
    let release!: () => void;
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    let locked!: () => void;
    const lockedFirst = new Promise<void>((resolve) => {
      locked = resolve;
    });
    const running = dbService.runInTransaction(async ({ tx }) => {
      await directory.lockForUpdate(tx, accountId);
      locked();
      await hold;
    });
    await lockedFirst;
    return async () => {
      release();
      await running;
    };
  }

  it('makes a delivery wait for a rank change in flight, while a move that posts no money does not wait', async () => {
    const [auto] = await place(world.merchant.id);
    const [manual] = await place(world.merchant.id, world.manual.serviceId, IMEIS[1]);
    const finish = await holdingRankChange(world.merchant.id);

    // Accepting a manual order posts nothing: it takes no account lock and goes straight through.
    await apply({ orderId: manual!.id, action: { kind: 'accept' } });
    expect(await orderRow(db, manual!.id)).toMatchObject({ status: 'processing', dispatchState: 'operator' });

    // Delivering an order posts the settlement: it waits for the rank change.
    let delivered = false;
    const replying = apply({ orderId: auto!.id, action: { kind: 'reply' }, code: 'Unlocked' }).then(() => {
      delivered = true;
    });
    await sleep(250);
    expect(delivered).toBe(false);
    await finish();
    await replying;
    expect(delivered).toBe(true);
    expect(await orderRow(db, auto!.id)).toMatchObject({ status: 'completed' });
  });
});

describe('the live_order blocker of the rank change', () => {
  const guard = () => new LiveOrdersGuard(new RankChangeGuards());
  const blockers = (accountId: number) => dbService.runInTransaction(({ tx }) => guard().blockersOf(tx, accountId));
  const orderIn = (accountId: number, values: Partial<typeof s.orders.$inferInsert>) =>
    insertOrderRow(db, { accountId, serviceId: world.auto.serviceId, ...values });

  it('names an order that is pending or processing, whatever its dispatch state', async () => {
    expect(await blockers(world.merchant.id)).toEqual([]);
    for (const status of ['pending', 'processing'] as const) {
      const order = await orderIn(world.merchant.id, { status, dispatchState: 'sent' });
      expect(await blockers(world.merchant.id), status).toEqual(['live_order']);
      await db.update(s.orders).set({ status: 'rejected', dispatchState: 'done' }).where(eq(s.orders.id, order.id));
      expect(await blockers(world.merchant.id), `${status} then rejected`).toEqual([]);
    }
  });

  it('names a completed order with a verification request still open, and no other completed or closed order', async () => {
    const completed = await orderIn(world.merchant.id, { status: 'completed', dispatchState: 'done' });
    expect(await blockers(world.merchant.id)).toEqual([]);
    for (const verificationStatus of ['accepted', 'refunded'] as const) {
      await db.update(s.orders).set({ verificationStatus }).where(eq(s.orders.id, completed.id));
      expect(await blockers(world.merchant.id), verificationStatus).toEqual([]);
    }
    await db.update(s.orders).set({ verificationStatus: 'requested' }).where(eq(s.orders.id, completed.id));
    expect(await blockers(world.merchant.id)).toEqual(['live_order']);
  });

  it('counts an order of any door, a shop order included', async () => {
    const shopper = await makeAccount({ rank: 'retail', db });
    await orderIn(shopper.id, { source: 'store', status: 'pending', dispatchState: 'manual' });
    expect(await blockers(shopper.id)).toEqual(['live_order']);
  });

  it('ignores the orders of a guest row that shares the address of the account: they belong to another account', async () => {
    const [merchantRow] = await db
      .select({ email: s.clients.email })
      .from(s.clients)
      .where(eq(s.clients.id, world.merchant.id));
    // A shop checkout typed with the merchant's address made a guest row of its own: a login row and a guest row may share an email.
    const guest = await makeAccount({ rank: 'retail', guest: true, email: merchantRow!.email, db });
    await orderIn(guest.id, { source: 'store', status: 'pending', dispatchState: 'manual' });
    expect(await blockers(world.merchant.id)).toEqual([]);
    expect(await blockers(guest.id)).toEqual(['live_order']);
  });

  it('is registered with the rank change when the application starts', () => {
    expect(t.app.get(RankChangeGuards).names()).toContain('live_order');
  });
});

describe('the erasure of the device numbers of an account', () => {
  it('rewrites the stored inputs of the shop orders of that account only', async () => {
    const shopper = await makeAccount({ rank: 'retail', db });
    const mine = await insertOrderRow(db, {
      accountId: shopper.id,
      serviceId: world.manual.serviceId,
      source: 'store',
      imei: IMEIS[0],
      inputs: { note: 'x' },
    });
    const held = await insertOrderRow(db, {
      accountId: shopper.id,
      serviceId: world.manual.serviceId,
      imei: IMEIS[1],
    });
    const other = await insertOrderRow(db, {
      accountId: world.other.id,
      serviceId: world.manual.serviceId,
      imei: IMEIS[2],
    });
    const rewrite = () =>
      dbService.runInTransaction(({ tx }) =>
        rewriteCustomerOrderInputs(tx, shopper.id, new Date(), (order) => ({
          imei: null,
          inputs: { ...order.inputs, note: '' },
        })),
      );
    expect(await rewrite()).toBe(1);
    expect(await orderRow(db, mine.id)).toMatchObject({ imei: null, inputs: { note: '' } });
    // An order the account held from a wallet (the device numbers of its own buyers) and another account's order are left as they are.
    expect(await orderRow(db, held.id)).toMatchObject({ imei: IMEIS[1] });
    expect(await orderRow(db, other.id)).toMatchObject({ imei: IMEIS[2] });
    // A second pass finds nothing to change.
    expect(await rewrite()).toBe(0);
  });
});

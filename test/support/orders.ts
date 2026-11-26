// Helpers for the order engine tests (feature 5): a world with merchants, funded wallets and services, a client for the portal's order
// routes, and direct inserts of orders in a given state for the read and action tests. The buyer of an order is an account
// (`orders.account_id`); the door is `orders.source`.
import { and, eq, sql } from 'drizzle-orm';
import type { LightMyRequestResponse } from 'fastify';
import { type Database, type DbExecutor, schema as s } from '@src/infra/db';
import type { Order, OrderEvent } from '@src/modules/orders';
import type { TestApp } from './app';
import { openSession } from './auth';
import { insertCategory, insertService, insertSupplierLink } from './catalog';
import { insertUsd } from './fixtures';
import { fundWallet, insertWalletMerchant } from './money';

/** A valid IMEI (Luhn) and a few more, so tests never trip the format check. */
export const IMEIS = [
  '352905112490861',
  '354607111076240',
  '353890113898412',
  '359254101036747',
  '867412052327342',
] as const;

/**
 * What a merchant has settled, read from the ledger: the `order_settle` debits on its USD hold account, minus the settlements that a
 * reversal cancelled (a transaction with the key `reverse:<settlement id>`, decision 024). The tests of the reopen and the B2B refund read it to
 * see that a reversal takes the settlement back.
 *
 * @param db the test database
 * @param clientId the merchant
 * @returns a 4-decimal USD figure (`'0.0000'` when nothing is settled)
 */
export async function settledOf(db: Database, clientId: number): Promise<string> {
  const result = await db.execute<{ settled: string | null }>(sql`
    select coalesce(sum(entry.amount), 0)::numeric(18,4)::text as settled
    from ${s.ledgerEntries} entry
    join ${s.ledgerTransactions} tx on tx.id = entry.transaction_id
    join ${s.ledgerAccounts} hold on hold.id = entry.account_id
    where hold.kind = 'client_hold' and hold.owner_type = 'account' and hold.currency = 'USD' and hold.owner_id = ${clientId}
      and tx.kind = 'order_settle' and entry.amount > 0
      and not exists (select 1 from ${s.ledgerTransactions} reversal where reversal.idempotency_key = 'reverse:' || tx.id::text)`);
  return result.rows[0]?.settled ?? '0.0000';
}

/** The wallet figures of a merchant-rank account as the ledger holds them (the merchant wallet and its hold). */
export async function walletOf(db: Database, clientId: number): Promise<{ wallet: string; hold: string }> {
  const rows = await db
    .select({ kind: s.ledgerAccounts.kind, balance: s.ledgerAccounts.balance })
    .from(s.ledgerAccounts)
    .where(and(eq(s.ledgerAccounts.ownerType, 'account'), eq(s.ledgerAccounts.ownerId, clientId)));
  return {
    wallet: rows.find((row) => row.kind === 'client_wallet')?.balance ?? '0.0000',
    hold: rows.find((row) => row.kind === 'client_hold')?.balance ?? '0.0000',
  };
}

/** The balance of a system account (`revenue`, `cogs`, ...). */
export async function systemBalance(db: Database, kind: string): Promise<string> {
  const [row] = await db
    .select({ balance: s.ledgerAccounts.balance })
    .from(s.ledgerAccounts)
    .where(and(eq(s.ledgerAccounts.kind, kind as never), sql`${s.ledgerAccounts.ownerType} is null`));
  return row?.balance ?? '0.0000';
}

/** The ledger transactions about an order, oldest first: kind and idempotency key. */
export async function ledgerOf(db: Database, orderId: number): Promise<Array<{ kind: string; key: string }>> {
  const rows = await db
    .select({ kind: s.ledgerTransactions.kind, key: s.ledgerTransactions.idempotencyKey })
    .from(s.ledgerTransactions)
    .where(and(eq(s.ledgerTransactions.refType, 'order'), eq(s.ledgerTransactions.refId, orderId)))
    .orderBy(s.ledgerTransactions.id);
  return rows;
}

/** One order row, read back. */
export async function orderRow(db: Database, id: number): Promise<Order> {
  const [row] = await db.select().from(s.orders).where(eq(s.orders.id, id));
  return row!;
}

/** The timeline of an order, oldest first. */
export async function eventsOf(db: Database, orderId: number): Promise<OrderEvent[]> {
  return db.select().from(s.orderEvents).where(eq(s.orderEvents.orderId, orderId)).orderBy(s.orderEvents.id);
}

/** The outbox rows of an event type about an order. */
export async function outboxOf(db: Database, type: string, orderId: number) {
  return db
    .select()
    .from(s.outboxEvents)
    .where(and(eq(s.outboxEvents.type, type), eq(s.outboxEvents.aggregateId, orderId)))
    .orderBy(s.outboxEvents.id);
}

/** The audit rows about an order, oldest first. */
export async function auditOf(db: Database, orderId: number) {
  return db
    .select()
    .from(s.auditLogs)
    .where(and(eq(s.auditLogs.entityType, 'order'), eq(s.auditLogs.entityId, orderId)))
    .orderBy(s.auditLogs.id);
}

/** What `ordersWorld` builds. */
export interface OrdersWorld {
  readonly db: Database;
  /** The merchant with a funded wallet (100 USD), in a group with no discount. */
  readonly merchant: { id: number; name: string };
  /** Another merchant, to prove isolation. */
  readonly other: { id: number; name: string };
  /** An automatic IMEI service with an active supplier link (price 17.28, cost 13.50). */
  readonly auto: { serviceId: number; categoryId: number; supplierId: number };
  /** A manual IMEI service (price 5.00, cost 3.00). */
  readonly manual: { serviceId: number };
  /** A server service with a required `username` field (price 8.00). */
  readonly server: { serviceId: number };
}

/**
 * Builds the usual world of the order tests: USD, two merchants (one funded with 100 USD), an automatic IMEI service with a
 * supplier link, a manual IMEI service and a server service that asks for a username.
 *
 * @returns the world
 */
export async function ordersWorld(db: Database): Promise<OrdersWorld> {
  await insertUsd(db);
  const merchant = await insertWalletMerchant(db, { name: 'Cairo GSM Lab' });
  const other = await insertWalletMerchant(db, { name: 'Erbil Mobile Parts' });
  await fundWallet(db, merchant.id, '100');
  await fundWallet(db, other.id, '100');
  const imeiCategory = await insertCategory(db, { name: 'Carrier unlock' });
  const autoId = await insertService(db, imeiCategory, {
    name: 'AT&T USA Premier Unlock',
    code: 'IMEI-ATT-USA',
    cost: '13.5000',
    effectiveCost: '13.5000',
    basePrice: '17.2800',
    minProfit: '0.8100',
    slaMinutes: 60,
  });
  const link = await insertSupplierLink(db, autoId);
  const manualId = await insertService(db, imeiCategory, {
    name: 'Manual unlock',
    code: 'IMEI-MANUAL',
    fulfillment: 'manual',
    cost: '3.0000',
    effectiveCost: '3.0000',
    basePrice: '5.0000',
    minProfit: '0.5000',
    slaMinutes: 120,
  });
  const serverCategory = await insertCategory(db, { name: 'Server credits', type: 'server' });
  const serverId = await insertService(db, serverCategory, {
    type: 'server',
    name: 'Server credits x10',
    code: 'SRV-X10',
    cost: '6.0000',
    effectiveCost: '6.0000',
    basePrice: '8.0000',
    minProfit: '0.5000',
    slaMinutes: 30,
  });
  await db.insert(s.serviceFields).values({
    serviceId: serverId,
    key: 'username',
    label: 'Username',
    supplierKey: 'username',
    required: true,
    sort: 1,
  });
  return {
    db,
    merchant,
    other,
    auto: { serviceId: autoId, categoryId: imeiCategory, supplierId: link.supplierId },
    manual: { serviceId: manualId },
    server: { serviceId: serverId },
  };
}

/**
 * Gives an IMEI service the field a new or imported IMEI service gets by default (decisions 071 and 073): key `imei`, Name and label
 * `IMEI`, type `imei` (15 digits, Luhn), required, the main input, first.
 *
 * @param db the test database
 * @param serviceId the service
 * @param values columns to override
 */
export async function addImeiField(
  db: Database,
  serviceId: number,
  values: Partial<typeof s.serviceFields.$inferInsert> = {},
): Promise<void> {
  await db.insert(s.serviceFields).values({
    serviceId,
    key: 'imei',
    label: 'IMEI',
    supplierKey: 'IMEI',
    fieldType: 'imei',
    required: true,
    isMainInput: true,
    sort: 0,
    ...values,
  });
}

/** A merchant portal session with helpers for the order routes (cookie, CSRF token, no Origin: the guards judge the session). */
export async function portalFor(t: TestApp, clientId: number) {
  const session = await openSession(t, { type: 'account', id: clientId });
  const get = (url: string) => t.app.inject({ method: 'GET', url, headers: session.headers });
  const post = (url: string, payload: unknown = {}) =>
    t.app.inject({ method: 'POST', url, headers: session.mutationHeaders, payload: payload as never });
  return { session, get, post };
}

/** The JSON body of a response, typed loosely for assertions. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- test bodies are untyped JSON: the default keeps assertions short
export const json = (res: LightMyRequestResponse): any => res.json();

/** What {@link insertOrderRow} takes: the order's columns, and the buyer under any of three names. */
export type OrderRowValues = Omit<Partial<typeof s.orders.$inferInsert>, 'clientId' | 'customerId'> &
  Pick<typeof s.orders.$inferInsert, 'serviceId'> & {
    /** The buyer, an account id. `clientId` and `customerId` are the same thing under the names the old helper took. */
    readonly clientId?: number;
    readonly customerId?: number;
  };

/**
 * Inserts an order that still names an old customer number, the way a migrated row stands.
 *
 * Why: the old customer tables are frozen (decision 064), so a new row cannot name an old customer through the foreign key. A test that
 * proves the old number is never read as the buyer writes the old customer and the order with the row triggers and the foreign keys off
 * (the test database's role is a superuser), in one transaction.
 *
 * Side effects: inserts one `customers` row with the given id and one `orders` row.
 *
 * @param db the test database
 * @param oldCustomerId the number of the old customer the order names (also the id of the row made for it)
 * @param values the order columns (`accountId`, `serviceId`, ...); `retiredCustomerId` is set here
 * @returns the stored order
 */
export async function insertMigratedOrderRow(
  db: Database,
  oldCustomerId: number,
  values: OrderRowValues,
): Promise<Order> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`set local session_replication_role = replica`);
    await tx.execute(
      sql`insert into customers (id, email, name, has_account) overriding system value
          values (${oldCustomerId}, ${`old-customer-${oldCustomerId}@mail.example`}, 'Old Customer', true)`,
    );
    return insertOrderRow(tx, { ...values, retiredCustomerId: oldCustomerId });
  });
}

/**
 * Inserts an order straight into the table, in the given state, for tests of the reads and the actions that do not need the
 * placement path. A hold is posted for hold-and-settle orders by the caller when the test needs money to move.
 *
 * Why: the buyer column is `account_id`; the door is `source`. A hold-and-settle order (any door but `store`) also writes
 * `client_id` (the same account) during the expand release, and a storefront order leaves it empty (`orders_door_check`).
 *
 * @param db the test database, or a transaction of it
 * @param values the order columns (`accountId`, `serviceId`, prices, state, ...); `clientId` and `customerId` are accepted as names of `accountId`
 * @returns the stored row
 * @throws {Error} when no buyer is given
 */
export async function insertOrderRow(db: DbExecutor, values: OrderRowValues): Promise<Order> {
  const { clientId, customerId, ...columns } = values;
  const buyer = columns.accountId ?? clientId ?? customerId;
  if (buyer === undefined) throw new Error('An order needs a buyer: pass accountId.');
  const source = columns.source ?? 'portal';
  const [row] = await db
    .insert(s.orders)
    .values({
      type: 'imei',
      source,
      imei: IMEIS[0],
      unitPrice: '10.0000',
      totalPrice: '10.0000',
      currency: 'USD',
      accountId: buyer,
      ...(source === 'store' ? {} : { legacyClientId: buyer }),
      ...columns,
    })
    .returning();
  return row!;
}

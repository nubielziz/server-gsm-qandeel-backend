// Helpers for the order engine tests (feature 5): a world with merchants, funded wallets and services, a client for the portal's order
// routes, and direct inserts of orders in a given state for the read and action tests.
import { and, eq, sql } from 'drizzle-orm';
import type { LightMyRequestResponse } from 'fastify';
import { type Database, schema as s } from '../../src/infra/db';
import type { Order, OrderEvent } from '../../src/modules/orders';
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

/** The wallet figures of a merchant as the ledger holds them. */
export async function walletOf(db: Database, clientId: number): Promise<{ wallet: string; hold: string }> {
  const rows = await db
    .select({ kind: s.ledgerAccounts.kind, balance: s.ledgerAccounts.balance })
    .from(s.ledgerAccounts)
    .where(and(eq(s.ledgerAccounts.ownerType, 'client'), eq(s.ledgerAccounts.ownerId, clientId)));
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

/** A merchant portal session with helpers for the order routes (cookie, CSRF token, no Origin: the guards judge the session). */
export async function portalFor(t: TestApp, clientId: number) {
  const session = await openSession(t, { type: 'client', id: clientId });
  const get = (url: string) => t.app.inject({ method: 'GET', url, headers: session.headers });
  const post = (url: string, payload: unknown = {}) =>
    t.app.inject({ method: 'POST', url, headers: session.mutationHeaders, payload: payload as never });
  return { session, get, post };
}

/** The JSON body of a response, typed loosely for assertions. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- test bodies are untyped JSON: the default keeps assertions short
export const json = (res: LightMyRequestResponse): any => res.json();

/**
 * Inserts an order straight into the table, in the given state, for tests of the reads and the actions that do not need the
 * placement path. A hold is posted for B2B orders by the caller when the test needs money to move.
 *
 * @param db the test database
 * @param values the order columns (`clientId`, `serviceId`, prices, state, ...)
 * @returns the stored row
 */
export async function insertOrderRow(
  db: Database,
  values: Partial<typeof s.orders.$inferInsert> & Pick<typeof s.orders.$inferInsert, 'serviceId'>,
): Promise<Order> {
  const [row] = await db
    .insert(s.orders)
    .values({
      type: 'imei',
      source: 'portal',
      imei: IMEIS[0],
      unitPrice: '10.0000',
      totalPrice: '10.0000',
      currency: 'USD',
      ...values,
    })
    .returning();
  return row!;
}

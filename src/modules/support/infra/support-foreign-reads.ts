// Lookups into tables other modules own, kept in this one file: who a ticket belongs to (a customer or a merchant), the storefront order a
// ticket is about, whether an order is the caller's own (the account routes of feature 28), and the staff member a ticket is assigned to. Reads only: the guest customer a first-time visitor becomes is made by the
// customers module's `CustomerDirectory`.
//
// DEVIATION to resolve when those modules export a reader: decision 016 wants these reads through the owning module's public service.
// Identity and orders export no directory of merchants, staff or orders by token yet, so this file reads `customers`, `clients`,
// `staff_users` and `orders` with plain selects, like the order read model's and catalog's foreign-read files. Replace the bodies with
// calls to their services; nothing outside this file names a foreign table (the ticket queries join the handles exported here).
import { and, eq, isNotNull } from 'drizzle-orm';
import { type DbExecutor, schema as s } from '../../../infra/db';

/** The table handles the ticket queries join, so no other file of this module names a foreign table. */
export const foreignTables = {
  customers: s.customers,
  clients: s.clients,
  staff: s.staffUsers,
} as const;

/** The name a ticket shows for a requester that is anonymized or gone (ANSWERS support Q1). */
export const DELETED_CUSTOMER_NAME = 'Deleted customer';

/** A storefront order a ticket can be about. */
export interface OrderRef {
  readonly id: number;
  readonly customerId: number;
  /** The stored lookup hash of the tracking token (decision 054), for the constant-time comparison; null for an order placed before. */
  readonly tokenHash: string | null;
  /** The tracking token as issued (an order placed before decision 054, until the seal pass ran), for the same comparison. */
  readonly token: string | null;
}

/**
 * Finds the storefront order a tracking token names.
 *
 * Why: a ticket opened from the order page carries the order's tracking token (the visitor's proof that the order is theirs); the ticket
 * is linked to the order and belongs to the order's customer. A merchant order has no token and no customer, so it never matches.
 * Decision 054: the lookup is by the keyed hash; an order placed before is found by its plain token until the seal pass ran.
 *
 * @param db the database or a transaction
 * @param lookup the hash of the presented token (`CapabilityTokenVault.hashOf('tracking', …)`) and the token itself
 * @returns the order id, its customer and the stored form of its token, or `undefined`
 */
export async function findOrderByTrackingToken(
  db: DbExecutor,
  lookup: { readonly hash: string; readonly token: string },
): Promise<OrderRef | undefined> {
  const columns = {
    id: s.orders.id,
    customerId: s.orders.customerId,
    tokenHash: s.orders.publicTokenHash,
    token: s.orders.publicToken,
  };
  const [sealed] = await db
    .select(columns)
    .from(s.orders)
    .where(and(eq(s.orders.publicTokenHash, lookup.hash), isNotNull(s.orders.customerId)))
    .limit(1);
  // Orders placed before decision 054 keep the token as issued until the seal pass ran.
  const [row] = sealed
    ? [sealed]
    : await db
        .select(columns)
        .from(s.orders)
        .where(and(eq(s.orders.publicToken, lookup.token), isNotNull(s.orders.customerId)))
        .limit(1);
  return row?.customerId == null ? undefined : { ...row, customerId: row.customerId };
}

/** The person or company a ticket belongs to, as a reply and a notification need them. */
export interface RequesterRecord {
  readonly name: string;
  /** The address to write to; `null` when the requester is anonymized or gone. */
  readonly email: string | null;
  /** A merchant's linked Telegram chat; `null` for a customer. */
  readonly telegramChatId: string | null;
  /** False for a customer that was anonymized or deleted: nothing may be sent to them. */
  readonly reachable: boolean;
}

/**
 * Reads the requester of a ticket.
 *
 * @param db the database or a transaction
 * @param type `customer` or `client` (a merchant)
 * @param id the id in that table
 * @returns the requester, or `undefined` when the row is gone
 */
export async function findRequester(
  db: DbExecutor,
  type: 'customer' | 'client',
  id: number,
): Promise<RequesterRecord | undefined> {
  if (type === 'customer') {
    const [row] = await db
      .select({ name: s.customers.name, email: s.customers.email, status: s.customers.status })
      .from(s.customers)
      .where(eq(s.customers.id, id))
      .limit(1);
    if (!row) return undefined;
    const gone = row.status === 'anonymized';
    return {
      name: gone ? DELETED_CUSTOMER_NAME : row.name,
      email: gone ? null : row.email,
      telegramChatId: null,
      reachable: !gone,
    };
  }
  const [row] = await db
    .select({ name: s.clients.name, email: s.clients.email, telegramChatId: s.clients.telegramChatId })
    .from(s.clients)
    .where(eq(s.clients.id, id))
    .limit(1);
  return row && { name: row.name, email: row.email, telegramChatId: row.telegramChatId, reachable: true };
}

/** A staff member as a ticket names them. */
export interface StaffRecord {
  readonly id: number;
  readonly name: string;
}

/**
 * Finds a staff member who can be given a ticket: signed up and not suspended.
 *
 * @param db the database or a transaction
 * @param id the staff id
 * @returns the member, or `undefined` for an unknown, invited or suspended account
 */
export async function findAssignableStaff(db: DbExecutor, id: number): Promise<StaffRecord | undefined> {
  const [row] = await db
    .select({ id: s.staffUsers.id, name: s.staffUsers.name })
    .from(s.staffUsers)
    .where(and(eq(s.staffUsers.id, id), eq(s.staffUsers.status, 'active')))
    .limit(1);
  return row;
}

/**
 * Reads a staff member's name.
 *
 * @param db the database or a transaction
 * @param id the staff id
 * @returns the name, or `undefined` when there is no such member
 */
export async function findStaffName(db: DbExecutor, id: number): Promise<string | undefined> {
  const [row] = await db.select({ name: s.staffUsers.name }).from(s.staffUsers).where(eq(s.staffUsers.id, id)).limit(1);
  return row?.name;
}

/**
 * Tells whether an order belongs to a signed-in customer or a merchant.
 *
 * Why: feature 28 (plan § 3.2, routes 7 and 9): a ticket opened from an account may name an order, and only one of the caller's own: a
 * storefront order of the customer (`orders.customer_id`), a portal or API order of the merchant (`orders.client_id`). Anything else,
 * an unknown id included, reads the same, so ids cannot be probed.
 *
 * @param db the database or a transaction
 * @param owner the caller: a customer or a merchant
 * @param orderId the order the ticket would be about
 * @returns true when the order exists and is the owner's
 */
export async function orderBelongsTo(
  db: DbExecutor,
  owner: { readonly type: 'customer' | 'client'; readonly id: number },
  orderId: number,
): Promise<boolean> {
  const [row] = await db
    .select({ id: s.orders.id })
    .from(s.orders)
    .where(
      and(eq(s.orders.id, orderId), eq(owner.type === 'customer' ? s.orders.customerId : s.orders.clientId, owner.id)),
    )
    .limit(1);
  return row !== undefined;
}

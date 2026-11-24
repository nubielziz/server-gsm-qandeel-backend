// Lookups into tables other modules own, kept in this one file: who a ticket belongs to (an account, of any rank), the storefront order a
// ticket is about, whether an order is the caller's own (the account routes of feature 28), and the staff member a ticket is assigned to.
// Reads only: the guest row a first-time visitor becomes is made by the identity module's `AccountDirectory` (decision 064).
//
// DEVIATION to resolve when those modules export a reader: decision 016 wants these reads through the owning module's public service.
// Identity and orders export no directory of staff or orders by token yet, so this file reads `clients`, `staff_users` and `orders` with
// plain selects, like the order read model's and catalog's foreign-read files. Replace the bodies with calls to their services; nothing
// outside this file names a foreign table (the ticket queries join the handles exported here). The rank of an account is never read here:
// the id of the retail rank comes from the catalog's `RankGroupReads` and the rank kind of one account from identity's `AccountDirectory`.
import { and, eq, sql } from 'drizzle-orm';
import { type DbExecutor, schema as s } from '../../../infra/db';
import { prepaidOrderSql } from '../../orders';

/** The table handles the ticket queries join, so no other file of this module names a foreign table. */
export const foreignTables = {
  accounts: s.clients,
  staff: s.staffUsers,
} as const;

/** The name a ticket shows for a requester that is anonymized or gone (ANSWERS support Q1). */
export const DELETED_CUSTOMER_NAME = 'Deleted customer';

/** A storefront order a ticket can be about. */
export interface OrderRef {
  readonly id: number;
  /** The account the order belongs to (a guest row or a login account). */
  readonly accountId: number;
  /** The stored lookup hash of the tracking token (decision 054), for the constant-time comparison; null for an order placed before. */
  readonly tokenHash: string | null;
  /** The tracking token as issued (an order placed before decision 054, until the seal pass ran), for the same comparison. */
  readonly token: string | null;
}

/**
 * Finds the storefront order a tracking token names.
 *
 * Why: a ticket opened from the order page carries the order's tracking token (the visitor's proof that the order is theirs); the ticket
 * is linked to the order and belongs to the order's account. Only an order of the shop door has a tracking token: a portal or API order
 * never matches (the door is `orders.source`, never a null buyer column, decision 064). Decision 054: the lookup is by the keyed hash; an
 * order placed before is found by its plain token until the seal pass ran.
 *
 * @param db the database or a transaction
 * @param lookup the hash of the presented token (`CapabilityTokenVault.hashOf('tracking', …)`) and the token itself
 * @returns the order id, its account and the stored form of its token, or `undefined`
 */
export async function findOrderByTrackingToken(
  db: DbExecutor,
  lookup: { readonly hash: string; readonly token: string },
): Promise<OrderRef | undefined> {
  const columns = {
    id: s.orders.id,
    accountId: s.orders.accountId,
    tokenHash: s.orders.publicTokenHash,
    token: s.orders.publicToken,
  };
  const shopDoor = prepaidOrderSql(sql`${s.orders.source}`);
  const [sealed] = await db
    .select(columns)
    .from(s.orders)
    .where(and(eq(s.orders.publicTokenHash, lookup.hash), shopDoor))
    .limit(1);
  // Orders placed before decision 054 keep the token as issued until the seal pass ran.
  const [row] = sealed
    ? [sealed]
    : await db
        .select(columns)
        .from(s.orders)
        .where(and(eq(s.orders.publicToken, lookup.token), shopDoor))
        .limit(1);
  return row;
}

/** The person or company a ticket belongs to, as a reply and a notification need them. */
export interface RequesterRecord {
  readonly name: string;
  /** The address to write to; `null` when the requester is anonymized or gone. */
  readonly email: string | null;
  /** False for an account that was anonymized: nothing may be sent to it. */
  readonly reachable: boolean;
}

/**
 * Reads the requester of a ticket.
 *
 * @param db the database or a transaction
 * @param id the account id
 * @returns the requester, or `undefined` when the row is gone
 */
export async function findRequester(db: DbExecutor, id: number): Promise<RequesterRecord | undefined> {
  const [row] = await db
    .select({ name: s.clients.name, email: s.clients.email, status: s.clients.status })
    .from(s.clients)
    .where(eq(s.clients.id, id))
    .limit(1);
  if (!row) return undefined;
  const gone = row.status === 'anonymized';
  return {
    name: gone ? DELETED_CUSTOMER_NAME : row.name,
    email: gone ? null : row.email,
    reachable: !gone,
  };
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
 * Tells whether an order belongs to a signed-in account.
 *
 * Why: feature 28 (plan § 3.2, routes 7 and 9) and decision 064: a ticket opened from an account may name an order, and only one of the
 * caller's own, whatever its door and whatever the rank is today: `orders.account_id` is the one buyer column. This is an authorization
 * check: an account whose id equals an old customer number must not reach that customer's orders , and the column holds the new
 * id, so it cannot. Anything else, an unknown id included, reads the same, so ids cannot be probed.
 *
 * @param db the database or a transaction
 * @param owner the caller, an account
 * @param orderId the order the ticket would be about
 * @returns true when the order exists and is the account's
 */
export async function orderBelongsTo(
  db: DbExecutor,
  owner: { readonly id: number },
  orderId: number,
): Promise<boolean> {
  const [row] = await db
    .select({ id: s.orders.id })
    .from(s.orders)
    .where(and(eq(s.orders.id, orderId), eq(s.orders.accountId, owner.id)))
    .limit(1);
  return row !== undefined;
}

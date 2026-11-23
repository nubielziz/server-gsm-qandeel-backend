// Drizzle queries on checkout_sessions and the guest rows of customers for the storefront checkout (feature 14a). Only the customers
// module touches these tables.
import { and, asc, eq, gt, isNotNull, isNull, sql } from 'drizzle-orm';
import type { SealedCapabilityToken, UnsealedCapabilityToken } from '../../../infra/crypto';
import type { DbExecutor } from '../../../infra/db';
import {
  type CheckoutSession,
  type Customer,
  type NewCheckoutSession,
  type NewCustomer,
  checkoutSessions,
  customers,
} from '../db/schema';

/**
 * Keeps a guest's marketing choice in step with the consent a checkout recorded.
 *
 * Why: the console's customer list shows `marketing_opt_in`; a guest's only way to choose is the checkout, so the column follows
 * the latest checkout record. An account holder's column is never touched here (`has_account = false` in the filter): only the
 * signed-in account page changes it.
 *
 * @param db the caller's transaction
 * @param id the customer id
 * @param granted the recorded answer
 * @param now the injected clock's time for `updated_at`
 */
export async function setGuestMarketingOptIn(db: DbExecutor, id: number, granted: boolean, now: Date): Promise<void> {
  await db
    .update(customers)
    .set({ marketingOptIn: granted, updatedAt: now })
    .where(and(eq(customers.id, id), eq(customers.hasAccount, false)));
}

/**
 * Inserts a guest customer unless the email already belongs to someone.
 *
 * Why: two checkouts with the same new email at once must end with one customer; `ON CONFLICT DO NOTHING` on the unique
 * `lower(email)` index lets the loser read the winner's row instead of failing.
 *
 * @param db the caller's transaction
 * @param values the guest row
 * @returns the new row, or `undefined` when the email was already taken
 */
export async function insertGuestCustomer(db: DbExecutor, values: NewCustomer): Promise<Customer | undefined> {
  const [row] = await db.insert(customers).values(values).onConflictDoNothing().returning();
  return row;
}

/**
 * Inserts a checkout session.
 *
 * @param db the database or a transaction
 * @param values the row
 * @returns the stored row
 */
export async function insertCheckoutSession(db: DbExecutor, values: NewCheckoutSession): Promise<CheckoutSession> {
  const [row] = await db.insert(checkoutSessions).values(values).returning();
  return row!;
}

/**
 * Finds a checkout session by id.
 *
 * @param db the database or a transaction
 * @param id the session id
 * @returns the session, or `undefined`
 */
export async function findCheckoutSession(db: DbExecutor, id: number): Promise<CheckoutSession | undefined> {
  const [row] = await db.select().from(checkoutSessions).where(eq(checkoutSessions.id, id)).limit(1);
  return row;
}

/** How the checkout behind an order was opened. */
export interface OrderCheckout {
  readonly customerId: number | null;
  /** The address the checkout was opened with. */
  readonly email: string;
  /** True when the signed-in account opened it itself. */
  readonly openedSignedIn: boolean;
}

/**
 * Finds the checkout session that created an order.
 *
 * Why: whether the order's tracking link speaks for the account, and whom its receipt names, depend on how the checkout was opened.
 *
 * @param db the database or a transaction
 * @param orderId the order
 * @returns the session's customer, address and sign-in mark, or `undefined` for an order without a checkout
 */
export async function findSessionOfOrder(db: DbExecutor, orderId: number): Promise<OrderCheckout | undefined> {
  const [row] = await db
    .select({
      customerId: checkoutSessions.customerId,
      email: checkoutSessions.email,
      openedSignedIn: checkoutSessions.openedSignedIn,
    })
    .from(checkoutSessions)
    .where(eq(checkoutSessions.orderId, orderId))
    .limit(1);
  return row;
}

/**
 * Finds a checkout session by id and locks its row until the caller's transaction ends.
 *
 * Why: two consent posts for one session at once must not both read the same latest records and write the same proof twice, and
 * the session must stay open between the status check and the insert.
 *
 * @param db the caller's transaction
 * @param id the session id
 * @returns the session, or `undefined`
 */
export async function lockCheckoutSession(db: DbExecutor, id: number): Promise<CheckoutSession | undefined> {
  const [row] = await db.select().from(checkoutSessions).where(eq(checkoutSessions.id, id)).limit(1).for('update');
  return row;
}

/**
 * Finds the session a presented token names, with the stored form to compare.
 *
 * Why: the capability guard looks the token up by a unique index before any handler runs; it gets the stored form back so the
 * resolver can compare it in constant time. Decision 054: the lookup is by the keyed hash; a row written before is found by its
 * plain token until the seal pass ran.
 *
 * @param db the database or a transaction
 * @param lookup the hash of the presented token (`CapabilityTokenVault.hashOf('checkout', …)`) and the token itself
 * @returns the session id and its customer, with its stored hash or plain token, or `undefined`
 */
export async function findSessionByToken(
  db: DbExecutor,
  lookup: { readonly hash: string; readonly token: string },
): Promise<{ id: number; customerId: number | null; tokenHash: string | null; token: string | null } | undefined> {
  const columns = {
    id: checkoutSessions.id,
    customerId: checkoutSessions.customerId,
    tokenHash: checkoutSessions.tokenHash,
    token: checkoutSessions.token,
  };
  const [sealed] = await db
    .select(columns)
    .from(checkoutSessions)
    .where(eq(checkoutSessions.tokenHash, lookup.hash))
    .limit(1);
  if (sealed) return sealed;
  // Rows written before decision 054 keep the token as issued until the seal pass ran.
  const [plain] = await db
    .select(columns)
    .from(checkoutSessions)
    .where(eq(checkoutSessions.token, lookup.token))
    .limit(1);
  return plain;
}

/**
 * The sessions that still keep their token as issued, by id.
 *
 * Why: decision 054: the one-off seal pass walks them a page at a time.
 *
 * @param db the database
 * @param afterId the last id of the previous page (0 to start)
 * @param limit the page size
 * @returns the id and plain token of each row
 */
export async function findUnsealedSessions(
  db: DbExecutor,
  afterId: number,
  limit: number,
): Promise<UnsealedCapabilityToken[]> {
  const rows = await db
    .select({ id: checkoutSessions.id, token: checkoutSessions.token })
    .from(checkoutSessions)
    .where(and(isNotNull(checkoutSessions.token), isNull(checkoutSessions.tokenHash), gt(checkoutSessions.id, afterId)))
    .orderBy(asc(checkoutSessions.id))
    .limit(limit);
  return rows.flatMap((row) => (row.token === null ? [] : [{ id: row.id, token: row.token }]));
}

/**
 * Stores a session's token as its hash and encrypted copy and empties the plain column.
 *
 * Why: decision 054: the seal pass converts each row in one guarded statement, so a row that changed since it was read is left alone
 * and a repeat finds nothing to do.
 *
 * @param db the database
 * @param row the row as read (id and plain token)
 * @param sealed the token's stored forms
 * @returns true when the row was converted
 */
export async function sealSessionToken(
  db: DbExecutor,
  row: UnsealedCapabilityToken,
  sealed: SealedCapabilityToken,
): Promise<boolean> {
  const changed = await db
    .update(checkoutSessions)
    // Sealing is not a change of the session: updated_at keeps its value (as clearTicketTokensOfCustomer does).
    .set({ tokenHash: sealed.hash, tokenEnc: sealed.enc, token: null, updatedAt: sql`${checkoutSessions.updatedAt}` })
    .where(
      and(eq(checkoutSessions.id, row.id), eq(checkoutSessions.token, row.token), isNull(checkoutSessions.tokenHash)),
    )
    .returning({ id: checkoutSessions.id });
  return changed.length === 1;
}

/**
 * Links a session to a customer.
 *
 * @param db the caller's transaction
 * @param id the session id
 * @param customerId the customer
 * @param now the injected clock's time for `updated_at`
 */
export async function setSessionCustomer(db: DbExecutor, id: number, customerId: number, now: Date): Promise<void> {
  await db.update(checkoutSessions).set({ customerId, updatedAt: now }).where(eq(checkoutSessions.id, id));
}

/**
 * Marks a checkout session paid and links the order it created.
 *
 * Why: scenario b2c-paid step 7: in the capture's transaction the session becomes `paid` with its `order_id`; an expired session that was
 * paid late is `paid` too (the buyer paid the locked price).
 *
 * Side effects: updates the `checkout_sessions` row.
 *
 * @param db the capture's transaction (the session row is locked)
 * @param id the session
 * @param orderId the order the payment created
 * @param now the clock's time
 */
export async function markSessionPaid(db: DbExecutor, id: number, orderId: number, now: Date): Promise<void> {
  await db.update(checkoutSessions).set({ status: 'paid', orderId, updatedAt: now }).where(eq(checkoutSessions.id, id));
}

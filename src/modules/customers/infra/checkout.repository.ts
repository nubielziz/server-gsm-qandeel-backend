// Drizzle queries on checkout_sessions and the guest rows of customers for the storefront checkout (feature 14a). Only the customers
// module touches these tables.
import { and, eq } from 'drizzle-orm';
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
 * Finds the id and token of the session a token names.
 *
 * Why: the capability guard looks the token up by the unique index before any handler runs; it gets the stored token back so
 * the resolver can compare it in constant time.
 *
 * @param db the database or a transaction
 * @param token the token the visitor sent
 * @returns the session id and stored token, or `undefined`
 */
export async function findSessionByToken(
  db: DbExecutor,
  token: string,
): Promise<{ id: number; token: string } | undefined> {
  const [row] = await db
    .select({ id: checkoutSessions.id, token: checkoutSessions.token })
    .from(checkoutSessions)
    .where(eq(checkoutSessions.token, token))
    .limit(1);
  return row;
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

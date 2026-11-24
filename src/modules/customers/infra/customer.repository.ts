// Drizzle queries on the account row `clients` for the customers module: one account by id (optionally locked), the write of the privacy
// routes and the store's marketing choice. The retail account and the guest row are rows of the same table (decision 064); the function
// names keep the word "customer" (the buyer of the shop) and take an account id of any rank.
//
// DEVIATION to resolve when the identity module exports a writer for these columns (decision 016): `clients` belongs to identity, which
// exports reads and locks (`AccountDirectory`) but not the writes of a block, an erasure or a marketing choice, so this file writes the
// row with a plain update, like the other foreign-read files of this module. No email is compared here: an address is found only by
// `AccountDirectory`.
import { eq } from 'drizzle-orm';
import { type DbExecutor, schema as s } from '../../../infra/db';

/** An account row (any rank, a guest included). */
export type AccountRow = typeof s.clients.$inferSelect;

/** The columns an update may set. */
export type AccountRowChanges = Partial<typeof s.clients.$inferInsert>;

/**
 * Finds an account by id, optionally locking the row for the rest of the transaction.
 *
 * Why: a block, an erasure and a marketing choice read the row, check the status and write; the lock keeps two staff members from
 * blocking and erasing the same account at once. The account row is the first lock of every path of an account (decision 064).
 *
 * @param db the database or a transaction
 * @param id the account id
 * @param lock lock the row `FOR UPDATE`
 * @returns the account, or `undefined`
 */
export async function findCustomerById(db: DbExecutor, id: number, lock = false): Promise<AccountRow | undefined> {
  const query = db.select().from(s.clients).where(eq(s.clients.id, id)).limit(1);
  const [row] = await (lock ? query.for('update') : query);
  return row;
}

/**
 * Updates an account row.
 *
 * Side effects: updates the `clients` row.
 *
 * @param db the transaction
 * @param id the account id
 * @param values the changed columns
 * @returns the stored row
 */
export async function updateCustomerRow(db: DbExecutor, id: number, values: AccountRowChanges): Promise<AccountRow> {
  const [row] = await db.update(s.clients).set(values).where(eq(s.clients.id, id)).returning();
  if (!row) throw new Error(`Account ${id} vanished during its update.`);
  return row;
}

/**
 * Sets an account's marketing choice.
 *
 * Why: a signed-in account holder who answers the marketing consent at checkout is choosing for their own account, so the column the
 * console shows follows the answer, as `PATCH /store/v1/me` does. (A guest's checkout answer goes through `setGuestMarketingOptIn`,
 * which never touches an account holder.)
 *
 * Side effects: updates the `clients` row.
 *
 * @param db the caller's transaction
 * @param id the account id
 * @param granted the recorded answer
 * @param now the injected clock's time for `updated_at`
 */
export async function setMarketingOptIn(db: DbExecutor, id: number, granted: boolean, now: Date): Promise<void> {
  await db.update(s.clients).set({ marketingOptIn: granted, updatedAt: now }).where(eq(s.clients.id, id));
}

/** The checkout session of an order: whose it is, the address it was opened with and whether the account itself opened it signed in. */
export interface OrderCheckout {
  readonly accountId: number | null;
  readonly email: string;
  readonly openedSignedIn: boolean;
}

/**
 * Finds the checkout session an order came from.
 *
 * Why: the tracking link and the receipt of a shop order say who holds the order only when the account itself opened the checkout signed
 * in (`CustomerDirectory`). The session is a row of this module's own table.
 *
 * @param db the database or a transaction
 * @param orderId the order
 * @returns the session's account, address and sign-in mark, or `undefined` for an order without a checkout
 */
export async function findCheckoutOfOrder(db: DbExecutor, orderId: number): Promise<OrderCheckout | undefined> {
  const [row] = await db
    .select({
      accountId: s.checkoutSessions.accountId,
      email: s.checkoutSessions.email,
      openedSignedIn: s.checkoutSessions.openedSignedIn,
    })
    .from(s.checkoutSessions)
    .where(eq(s.checkoutSessions.orderId, orderId))
    .limit(1);
  return row;
}

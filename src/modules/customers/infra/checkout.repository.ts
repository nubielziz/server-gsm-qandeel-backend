// Drizzle queries on checkout_sessions and the one guest-only write of a marketing choice, for the storefront checkout (feature 14a, decision 064).
// Only the customers module touches `checkout_sessions`. The guest row of an email is made by identity's `AccountDirectory`, never here.
//
// DEVIATION to resolve when the identity module exports a writer for the marketing choice of a guest row (decision 016): `clients` belongs
// to identity, which exports reads and locks but not this write, so `setGuestMarketingOptIn` updates the row with a plain statement, like the
// other foreign-read files of this module (`customer.repository.ts`).
import { and, asc, eq, gt, isNotNull, isNull, sql } from 'drizzle-orm';
import type { SealedCapabilityToken, UnsealedCapabilityToken } from '../../../infra/crypto';
import { type DbExecutor, schema as s } from '../../../infra/db';
import { type CheckoutSession, type NewCheckoutSession, checkoutSessions } from '../db/schema';

/**
 * Keeps a guest row's marketing choice in step with the consent a checkout recorded.
 *
 * Why: the console's account list shows `marketing_opt_in`; a guest's only way to choose is the checkout, so the column follows the latest
 * checkout record. A row with a login is never touched here (`has_account = false` in the filter, which also covers a guest row that turned
 * into an account a moment ago): only the signed-in account page, or the account holder's own consent at checkout, changes it.
 *
 * Side effects: updates the `clients` row of a guest.
 *
 * @param db the caller's transaction
 * @param id the guest row's id
 * @param granted the recorded answer
 * @param now the injected clock's time for `updated_at`
 */
export async function setGuestMarketingOptIn(db: DbExecutor, id: number, granted: boolean, now: Date): Promise<void> {
  await db
    .update(s.clients)
    .set({ marketingOptIn: granted, updatedAt: now })
    .where(and(eq(s.clients.id, id), eq(s.clients.hasAccount, false)));
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
 * Finds the session a presented token names, with the stored form to compare.
 *
 * Why: the capability guard looks the token up by a unique index before any handler runs; it gets the stored form back so the
 * resolver can compare it in constant time. Decision 054: the lookup is by the keyed hash; a row written before is found by its
 * plain token until the seal pass ran.
 *
 * @param db the database or a transaction
 * @param lookup the hash of the presented token (`CapabilityTokenVault.hashOf('checkout', …)`) and the token itself
 * @returns the session id and its account, with its stored hash or plain token, or `undefined`
 */
export async function findSessionByToken(
  db: DbExecutor,
  lookup: { readonly hash: string; readonly token: string },
): Promise<{ id: number; accountId: number | null; tokenHash: string | null; token: string | null } | undefined> {
  const columns = {
    id: checkoutSessions.id,
    accountId: checkoutSessions.accountId,
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

/**
 * Tells whether an account has a checkout it opened while signed in that is neither paid nor expired.
 *
 * Why: the `open_checkout` blocker of the rank change (decision 064): such a session may be paid from the store balance, so the account
 * cannot cross to the merchant kind while it lives. Judged on the injected clock like `effectiveStatus`: an open session past its
 * `expires_at` is expired. A guest checkout never counts (it was not opened signed in).
 *
 * @param db the rank change's transaction, after the account row is locked
 * @param accountId the account
 * @param now the injected clock's time
 * @returns true when such a session exists
 */
export async function hasOpenSignedInCheckout(db: DbExecutor, accountId: number, now: Date): Promise<boolean> {
  const [row] = await db
    .select({ id: checkoutSessions.id })
    .from(checkoutSessions)
    .where(
      and(
        eq(checkoutSessions.accountId, accountId),
        eq(checkoutSessions.openedSignedIn, true),
        eq(checkoutSessions.status, 'open'),
        gt(checkoutSessions.expiresAt, now),
      ),
    )
    .limit(1);
  return row !== undefined;
}

/** The columns of a session the guest claim needs to judge it. */
export type SessionLife = Pick<CheckoutSession, 'id' | 'status' | 'expiresAt'>;

/**
 * Locks every checkout session of an account row without waiting.
 *
 * Why: the guest claim (decision 064) must never queue behind a capture or a consent post that holds a session; `FOR UPDATE NOWAIT`
 * raises the lock error (SQLSTATE 55P03) at once and the claim answers `busy`.
 *
 * Side effects: row locks until the claim's transaction ends.
 *
 * @param db the claim's transaction
 * @param accountId the guest row
 * @returns the status and expiry of each session of the row, by id
 * @throws the lock error (55P03) when another transaction holds one of the rows
 */
export async function lockSessionsOfAccountNoWait(db: DbExecutor, accountId: number): Promise<SessionLife[]> {
  return db
    .select({ id: checkoutSessions.id, status: checkoutSessions.status, expiresAt: checkoutSessions.expiresAt })
    .from(checkoutSessions)
    .where(eq(checkoutSessions.accountId, accountId))
    .orderBy(asc(checkoutSessions.id))
    .for('update', { noWait: true });
}

/**
 * Moves the checkout sessions of one account row to another.
 *
 * Why: the guest claim: the paid and expired checkouts of a guest row belong to the account that proved the mailbox. The email of each
 * session stays as it was typed.
 *
 * Side effects: updates `checkout_sessions.account_id` and `updated_at`.
 *
 * @param db the claim's transaction (the rows are locked by {@link lockSessionsOfAccountNoWait})
 * @param guestId the guest row that owns them now
 * @param accountId the account that takes them
 * @param now the injected clock's time for `updated_at`
 * @returns how many sessions moved
 */
export async function moveSessionsToAccount(
  db: DbExecutor,
  guestId: number,
  accountId: number,
  now: Date,
): Promise<number> {
  const moved = await db
    .update(checkoutSessions)
    .set({ accountId, updatedAt: now })
    .where(eq(checkoutSessions.accountId, guestId))
    .returning({ id: checkoutSessions.id });
  return moved.length;
}
